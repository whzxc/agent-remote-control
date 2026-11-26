package core

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

type sourceIndex struct {
	mu                 sync.Mutex
	path               string
	current, persisted object
	lastSeenWrites     map[string]time.Time
}

var sourceStore sourceIndex

func sourceIndexPath() string { return filepath.Join(root(), "sources.json") }

func (cache *sourceIndex) initialize(path string, reconcile bool) error {
	if cache.path == path && !reconcile {
		return nil
	}
	raw, err := load(path)
	if errors.Is(err, os.ErrNotExist) {
		raw, err = object{"version": 0, "sources": []any{}}, nil
	}
	if err != nil {
		return err
	}
	store := obj(raw)
	if arr(store["sources"]) == nil {
		return errors.New("Invalid source store")
	}
	if reconcile {
		store, err = prepareLegacySourceState(path, store)
		if err != nil {
			return err
		}
	}
	previous := clone(store)
	now := time.Now()
	writes := map[string]time.Time{}
	for _, value := range arr(store["sources"]) {
		row := obj(value)
		if row["lastSeenAt"] != nil {
			writes[text(row, "id")] = now
		}
		if !reconcile {
			continue
		}
		delete(row, "pendingSwitch")
		if field(row["credential"], "type") != "oauth-grant" || row["state"] == "revoked" || row["connectionRemoved"] == true {
			continue
		}
		ingress := text(row, "ingressId")
		if err := validateIngressID(ingress); err != nil {
			return err
		}
		oauth, err := load(filepath.Join(filepath.Dir(path), "ingresses", ingress, "oauth.json"))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if find(field(oauth, "grants"), "id", text(row["credential"], "grantId")) == nil {
			row["state"] = "revoked"
		} else {
			row["state"] = "disconnected"
		}
	}
	if !reflect.DeepEqual(previous, store) {
		if err := save(path, store); err != nil {
			return err
		}
	}
	cache.path, cache.current, cache.persisted, cache.lastSeenWrites = path, store, clone(store), writes
	return nil
}

func listSourceAuthority() ([]any, error) {
	sourceStore.mu.Lock()
	defer sourceStore.mu.Unlock()
	if err := sourceStore.initialize(sourceIndexPath(), false); err != nil {
		return nil, err
	}
	return arr(clone(sourceStore.current)["sources"]), nil
}

func readSourceAuthority(id string) (object, error) {
	rows, err := listSourceAuthority()
	if err != nil {
		return nil, err
	}
	return sourceFromRows(rows, id)
}

func sourceFromRows(rows []any, id string) (object, error) {
	if row := find(rows, "id", id); row != nil {
		return row, nil
	}
	return nil, errors.New("SOURCE_NOT_FOUND")
}

func changeSources[T any](activity bool, modify func(*[]any) (T, error)) (T, error) {
	sourceStore.mu.Lock()
	defer sourceStore.mu.Unlock()
	var empty T
	path := sourceIndexPath()
	if err := sourceStore.initialize(path, false); err != nil {
		return empty, err
	}
	current := clone(sourceStore.current)
	rows := arr(current["sources"])
	result, err := modify(&rows)
	if err != nil {
		return empty, err
	}
	current["sources"] = rows
	if !activity && reflect.DeepEqual(current, sourceStore.current) {
		return result, nil
	}
	disk := clone(current)
	at := time.Now()
	seenChanges := []string{}
	for _, value := range arr(disk["sources"]) {
		row := obj(value)
		id := text(row, "id")
		prior := find(sourceStore.persisted["sources"], "id", id)["lastSeenAt"]
		if reflect.DeepEqual(prior, row["lastSeenAt"]) {
			continue
		}
		if last, ok := sourceStore.lastSeenWrites[id]; ok && at.Sub(last) < time.Minute {
			row["lastSeenAt"] = prior
		} else {
			seenChanges = append(seenChanges, id)
		}
	}
	if !reflect.DeepEqual(disk, sourceStore.persisted) {
		if err := save(path, disk); err != nil {
			return empty, err
		}
	}
	for _, id := range seenChanges {
		sourceStore.lastSeenWrites[id] = time.Now()
	}
	sourceStore.current, sourceStore.persisted = current, disk
	return result, nil
}

func requireControlSource(source any) error {
	if isBuiltinLocalSource(source) {
		return errors.New("LOCAL_SOURCE_PROTECTED: Built-in Local CLI and panel authority cannot be disconnected, revoked or moved.")
	}
	return nil
}

func repairBuiltinSource(source object, transport string) bool {
	if transport != "local" || !isBuiltinLocalSource(source) || source["state"] != "revoked" && source["connectionRemoved"] != true {
		return false
	}
	source["state"] = "connected"
	for _, key := range []string{"connectionRemoved", "connectionName", "pendingSwitch"} {
		delete(source, key)
	}
	return true
}

func revokeControlSource(source object) error {
	if err := requireControlSource(source); err != nil {
		return err
	}
	source["state"] = "revoked"
	delete(source, "pendingSwitch")
	return nil
}

func sourceProduct(id string) string {
	if find(sourcePresets(), "id", id) != nil {
		return id
	}
	return "custom"
}

func matchSourceProduct(name string) string {
	name = lowerProviderText(name)
	if strings.Contains(name, "antigravity") {
		return "gemini"
	}
	for _, preset := range slices.Backward(sourcePresets()) {
		if slices.Contains([]string{"custom", "local-cli"}, text(preset, "id")) {
			continue
		}
		for _, key := range []string{"id", "displayName"} {
			if word := lowerProviderText(text(preset, key)); word != "" && strings.Contains(name, word) {
				return text(preset, "id")
			}
		}
	}
	for _, preset := range sourcePresets() {
		platform := text(preset, "platform")
		if platform != "custom" && platform != "local" && strings.Contains(name, platform) {
			return text(preset, "id")
		}
	}
	return "custom"
}

func oauthSourceProduct(entry object, name string) string {
	inferred := matchSourceProduct(name)
	if inferred != "custom" || entry["transport"] == "relay" {
		return inferred
	}
	return sourceProduct(text(entry, "controlSource"))
}

func newControlSource(rows []any, entry, credential object, product string, connected any) object {
	product = sourceProduct(product)
	names := make([]string, 0, len(rows))
	for _, row := range rows {
		names = append(names, text(row, "label"))
	}
	return object{"id": id(), "ingressId": entry["id"], "credential": credential, "product": product,
		"platform": sourcePreset(product)["platform"], "label": sourceDefaultName(product, names), "createdAt": now(),
		"connectedAt": connected, "lastSeenAt": nil, "state": "disconnected", "capabilityProfileOffer": true}
}

func sourceSwitchLive(source any) bool {
	at, ok := uintValue(field(field(source, "pendingSwitch"), "expiresAt"))
	return ok && at > uint64(time.Now().Unix())
}

func moveSourceConnection(source object, ingress, credential any) {
	if field(source["credential"], "type") != "oauth-grant" {
		source["retiredIngressIds"] = append(arr(source["retiredIngressIds"]), source["ingressId"])
	}
	source["ingressId"], source["credential"] = ingress, credential
	for _, key := range []string{"connectionRemoved", "connectionName", "pendingSwitch"} {
		delete(source, key)
	}
}

func ensureIngressSource(entry object, observed bool) (object, error) {
	repaired := false
	source, err := changeSources(false, func(rows *[]any) (object, error) {
		for _, value := range *rows {
			row := obj(value)
			if row["ingressId"] == entry["id"] && field(row["credential"], "type") != "oauth-grant" {
				repaired = repairBuiltinSource(row, text(entry, "transport"))
				return clone(row), nil
			}
		}
		for _, value := range *rows {
			row := obj(value)
			if slices.Contains(arr(row["retiredIngressIds"]), entry["id"]) {
				if !observed {
					return clone(row), nil
				}
				return nil, errors.New("CONNECTION_RETIRED: the source changed connection; remove this connection and create a new one")
			}
		}
		kind := "ingress"
		if entry["transport"] == "local" {
			kind = "local"
		}
		credential := object{"type": kind}
		for _, value := range *rows {
			row := obj(value)
			if sourceSwitchLive(row) && field(row["pendingSwitch"], "ingressId") == entry["id"] {
				if !observed {
					return clone(row), nil
				}
				moveSourceConnection(row, entry["id"], credential)
				row["state"] = "connected"
				return clone(row), nil
			}
		}
		row := newControlSource(*rows, entry, credential, text(entry, "controlSource"), nil)
		*rows = append(*rows, row)
		return clone(row), nil
	})
	if repaired && err == nil {
		recordLog("info", "Restored built-in local source "+text(source, "id")+" to connected", source["ingressId"])
	}
	return source, err
}

func ensureLocalSource() (object, error) {
	return ensureIngressSource(object{"id": "local-cli", "transport": "local", "controlSource": "local-cli"}, false)
}

func sourceAuthorizationError(source object) error {
	reason := "credentials or connection superseded"
	if source["connectionRemoved"] == true {
		reason = "connection removed"
	} else if source["state"] == "revoked" {
		reason = "authorization revoked"
	}
	recovery := "Open ARC Remote link. For a revoked source, add and authorize a new control source. For a removed connection, select the disconnected source and Change connection, then authorize it. Retry from the restored connection."
	if isBuiltinLocalSource(source) {
		recovery = "Restart the upgraded ARC app and retry the local command; built-in local authority repairs automatically."
	}
	return fmt.Errorf("SOURCE_REVOKED: Source %s on ingress %s is not authorized (%s). %s", wire(source["id"]), wire(source["ingressId"]), reason, recovery)
}

func checkSourceAnchor(source object, ingress string, credential any) error {
	if source["state"] == "revoked" || source["connectionRemoved"] == true || source["ingressId"] != ingress || !reflect.DeepEqual(source["credential"], credential) {
		return sourceAuthorizationError(source)
	}
	return nil
}

func touchControlSource(source object, auth string) (object, error) {
	row, err := changeSources(true, func(rows *[]any) (object, error) {
		row, err := sourceFromRows(*rows, text(source, "id"))
		if err != nil {
			return nil, err
		}
		if err := checkSourceAnchor(row, text(source, "ingressId"), source["credential"]); err != nil {
			return nil, err
		}
		at := time.Now().Unix()
		row["lastSeenAt"], row["state"] = at, "connected"
		if row["connectedAt"] == nil {
			row["connectedAt"] = at
		}
		return clone(row), nil
	})
	if err != nil {
		return nil, err
	}
	if err := projectSourceAccounts([]any{row}); err != nil {
		return nil, err
	}
	origin := object{"ingressId": row["ingressId"], "sourceId": row["id"], "accountId": row["accountId"], "controlSource": row["product"], "authType": auth, "sourceLabel": row["label"]}
	if field(row["credential"], "type") == "peer" {
		origin["deviceId"] = field(row["credential"], "deviceId")
	}
	return origin, nil
}

func sourceSwitchMatches(row, pending object) bool {
	return sourceSwitchLive(row) && row["state"] != "revoked" && field(row["pendingSwitch"], "ingressId") == pending["ingressId"] &&
		field(row["pendingSwitch"], "requestId") == field(pending["credential"], "grantId")
}

func beginControlSourceSwitch(id string, entry object) (object, error) {
	return changeSources(false, func(rows *[]any) (object, error) {
		source, err := sourceFromRows(*rows, id)
		if err != nil {
			return nil, err
		}
		if err := requireControlSource(source); err != nil {
			return nil, err
		}
		if _, pending := source["switchSourceId"].(string); source["state"] == "revoked" || pending {
			return nil, errors.New("SOURCE_NOT_SWITCHABLE: select a connected or disconnected source")
		}
		if source["ingressId"] == entry["id"] {
			return nil, errors.New("SAME_CONNECTION: select another connection")
		}
		if entry["transport"] == "local" || entry["transport"] == "openai-tunnel" && source["product"] != "chatgpt" ||
			!slices.Contains(arr(sourcePreset(text(source, "product"))["supportedAuth"]), entry["auth"]) {
			return nil, errors.New("INCOMPATIBLE_CONNECTION: select a connection supported by this product")
		}
		for _, row := range *rows {
			if sourceSwitchLive(row) && (field(row, "id") == id || field(field(row, "pendingSwitch"), "ingressId") == entry["id"]) {
				return nil, errors.New("SWITCH_PENDING: cancel the existing switch first")
			}
		}
		if entry["auth"] != "oauth" {
			for _, row := range *rows {
				if field(row, "ingressId") == entry["id"] || slices.Contains(arr(field(row, "retiredIngressIds")), entry["id"]) {
					return nil, errors.New("CONNECTION_OCCUPIED: non-OAuth connections carry exactly one source; select another connection")
				}
			}
		}
		source["pendingSwitch"] = object{"ingressId": entry["id"], "expiresAt": time.Now().Unix() + 300}
		return clone(source), nil
	})
}

func clearOrRevokeControlSource(id string, revoke bool) (object, error) {
	return changeSources(false, func(rows *[]any) (object, error) {
		source, err := sourceFromRows(*rows, id)
		if err != nil {
			return nil, err
		}
		if revoke {
			if err := revokeControlSource(source); err != nil {
				return nil, err
			}
		} else {
			delete(source, "pendingSwitch")
		}
		return clone(source), nil
	})
}

func removeSourceConnection(entry object, pending []any) (any, error) {
	if entry["id"] == "local-cli" && entry["transport"] == "local" {
		return nil, errors.New("LOCAL_SOURCE_PROTECTED: Built-in local authority cannot be removed.")
	}
	return changeSources(false, func(rows *[]any) (any, error) {
		for _, value := range *rows {
			row := obj(value)
			current := row["ingressId"] == entry["id"]
			if current {
				if err := requireControlSource(row); err != nil {
					return nil, err
				}
			}
			if current || field(row["pendingSwitch"], "ingressId") == entry["id"] {
				delete(row, "pendingSwitch")
			}
			if current && row["state"] != "revoked" {
				if slices.Contains(pending, field(row["credential"], "grantId")) {
					row["state"] = "revoked"
				} else {
					row["state"], row["connectionRemoved"], row["connectionName"] = "disconnected", true, entry["name"]
				}
			}
		}
		return nil, nil
	})
}

func sourceForGrantIn(rows []any, ingress, grant string) object {
	index := slices.IndexFunc(rows, func(row any) bool {
		return field(row, "ingressId") == ingress && field(field(row, "credential"), "grantId") == grant
	})
	if index < 0 {
		return nil
	}
	return obj(rows[index])
}

func sourceGrantActive(rows []any, ingress, grant string) bool {
	row := sourceForGrantIn(rows, ingress, grant)
	return row != nil && row["state"] != "revoked" && row["connectionRemoved"] != true
}

func pendingSourceGrant(entry object, grant, client, name string) (object, error) {
	return changeSources(false, func(rows *[]any) (object, error) {
		if row := sourceForGrantIn(*rows, text(entry, "id"), grant); row != nil {
			return clone(row), nil
		}
		product := oauthSourceProduct(entry, name)
		var expected object
		for _, value := range *rows {
			row := obj(value)
			pending := obj(row["pendingSwitch"])
			if sourceSwitchLive(row) && pending["ingressId"] == entry["id"] && pending["requestId"] == nil {
				pending["requestId"], expected = grant, row
				break
			}
		}
		row := newControlSource(*rows, entry, object{"type": "oauth-grant", "grantId": grant, "clientId": client}, product, nil)
		if expected != nil {
			row["switchSourceId"], row["product"], row["platform"] = expected["id"], expected["product"], expected["platform"]
		}
		*rows = append(*rows, row)
		return clone(row), nil
	})
}

func sourceClaimCandidates(rows []any, pending object, grants []any) []any {
	result := []any{}
	for _, value := range rows {
		row := obj(value)
		_, switching := row["switchSourceId"].(string)
		if row["id"] != pending["id"] && !switching && row["ingressId"] == pending["ingressId"] && row["product"] == pending["product"] &&
			field(row["credential"], "type") == "oauth-grant" && (row["state"] == "revoked" || row["connectedAt"] != nil || slices.Contains(grants, field(row["credential"], "grantId"))) {
			result = append(result, row)
		}
	}
	return result
}

func validateSourceClaim(rows []any, pending object, target string, grants []any) error {
	if expected, ok := pending["switchSourceId"].(string); ok {
		source, err := sourceFromRows(rows, expected)
		if err != nil {
			return err
		}
		if target == expected && sourceSwitchMatches(source, pending) && pending["state"] != "revoked" {
			return nil
		}
		return errors.New("INVALID_SWITCH_CLAIM: this request can only claim its expected source; restart source switch if canceled or expired")
	}
	if target == "new" || find(sourceClaimCandidates(rows, pending, grants), "id", target) != nil {
		return nil
	}
	return errors.New("INVALID_SOURCE_CLAIM: select new or an existing source of the same product on this connection")
}

func connectSourceGrant(ingress, grant, target string, grants []any) (any, error) {
	rows, err := listSourceAuthority()
	if err != nil {
		return nil, err
	}
	pending := sourceForGrantIn(rows, ingress, grant)
	if pending == nil {
		return nil, errors.New("SOURCE_NOT_FOUND")
	}
	if err := validateSourceClaim(rows, pending, target, grants); err != nil {
		return nil, err
	}
	return changeSources(false, func(rows *[]any) (any, error) {
		current, err := sourceFromRows(*rows, text(pending, "id"))
		if err != nil {
			return nil, err
		}
		changed := errors.New("SOURCE_CHANGED: retry consent")
		if !reflect.DeepEqual(current["credential"], pending["credential"]) || current["product"] != pending["product"] || current["state"] == "revoked" {
			return nil, changed
		}
		chosen := target
		if target == "new" {
			chosen = text(pending, "id")
		}
		row, err := sourceFromRows(*rows, chosen)
		if err != nil {
			return nil, err
		}
		switching := pending["switchSourceId"] == target
		if switching {
			if !sourceSwitchMatches(row, pending) {
				return nil, errors.New("SWITCH_CHANGED: restart source switch")
			}
		} else if row["product"] != pending["product"] || row["ingressId"] != pending["ingressId"] || field(row["credential"], "type") != "oauth-grant" {
			return nil, changed
		}
		var replaced any
		if target != "new" && row["ingressId"] == pending["ingressId"] {
			replaced = text(row["credential"], "grantId")
		}
		if switching {
			moveSourceConnection(row, pending["ingressId"], pending["credential"])
		} else {
			row["credential"] = pending["credential"]
		}
		if row["connectedAt"] == nil {
			row["connectedAt"] = time.Now().Unix()
		}
		row["state"] = "connected"
		if target != "new" {
			*rows = slices.DeleteFunc(*rows, func(value any) bool { return field(value, "id") == pending["id"] })
		}
		return replaced, nil
	})
}

func revokeSourceGrants(ingress string, grants []any) (any, error) {
	if len(grants) == 0 {
		return nil, nil
	}
	return changeSources(false, func(rows *[]any) (any, error) {
		for _, value := range *rows {
			row := obj(value)
			if field(row["pendingSwitch"], "ingressId") == ingress && slices.Contains(grants, field(row["pendingSwitch"], "requestId")) {
				delete(row, "pendingSwitch")
			}
			if row["ingressId"] == ingress && row["connectionRemoved"] != true && slices.Contains(grants, field(row["credential"], "grantId")) {
				if err := revokeControlSource(row); err != nil {
					return nil, err
				}
			}
		}
		return nil, nil
	})
}

func setSourceConnectionState(ingress string, connected bool) (any, error) {
	state := "disconnected"
	if connected {
		state = "connected"
	}
	return changeSources(false, func(rows *[]any) (any, error) {
		for _, value := range *rows {
			row := obj(value)
			if row["ingressId"] == ingress && row["state"] != "revoked" && row["connectionRemoved"] != true &&
				(field(row["credential"], "type") != "oauth-grant" || row["connectedAt"] != nil) {
				row["state"] = state
			}
		}
		return nil, nil
	})
}

func updateControlSource(id string, body object) (object, error) {
	if body == nil {
		return nil, errors.New("Expected label, product, and/or capabilityProfile")
	}
	for key := range body {
		if !slices.Contains([]string{"label", "product", "capabilityProfile"}, key) {
			return nil, errors.New("Expected label, product, and/or capabilityProfile")
		}
	}
	var product object
	if value, ok := body["product"]; ok {
		product = find(sourcePresets(), "id", str(value))
		if product == nil {
			return nil, errors.New("UNKNOWN_PRODUCT: read ingress presets")
		}
	}
	if label, ok := body["label"]; ok && !validAccountAlias(label) {
		return nil, errors.New("Invalid source label")
	}
	return changeSources(false, func(rows *[]any) (object, error) {
		row, err := sourceFromRows(*rows, id)
		if err != nil {
			return nil, err
		}
		if profile, ok := body["capabilityProfile"]; ok {
			if err := validateProfile(profile, isBuiltinLocalSource(row)); err != nil {
				return nil, err
			}
			row["capabilityProfile"] = profile
			delete(row, "capabilityProfileOffer")
		}
		if product != nil {
			row["product"], row["platform"] = product["id"], product["platform"]
		}
		if label, ok := body["label"]; ok {
			row["label"] = label
		}
		return clone(row), nil
	})
}

type cachedSourceAccount struct{ input, account, resolution any }

var sourceAccountProjection struct {
	sync.Mutex
	path  string
	stamp *fileStamp
	rows  map[string]cachedSourceAccount
}

func projectSourceAccounts(sources []any) error {
	var external []object
	for _, value := range sources {
		row := obj(value)
		if isBuiltinLocalSource(row) {
			row["accountId"], row["identityResolution"] = nil, object{"state": "not-applicable"}
		} else {
			external = append(external, row)
		}
	}
	if len(external) == 0 {
		return nil
	}
	cache := &sourceAccountProjection
	cache.Lock()
	defer cache.Unlock()
	accountsWriter.Lock()
	defer accountsWriter.Unlock()
	path := accountIndexPath()
	stamp, err := readStamp(path)
	if err != nil {
		return err
	}
	if cache.path != path || !stampSame(cache.stamp, stamp) {
		cache.path, cache.stamp, cache.rows = path, stamp, map[string]cachedSourceAccount{}
	}
	input := func(s object) any { return []any{s["platform"], s["authorizationFacts"]} }
	if !slices.ContainsFunc(external, func(row object) bool { return !reflect.DeepEqual(input(row), cache.rows[text(row, "id")].input) }) {
		for _, row := range external {
			cached := cache.rows[text(row, "id")]
			row["accountId"], row["identityResolution"] = cached.account, clone(obj(cached.resolution))
		}
		return nil
	}
	_, err = changeAccountsLocked(func(rows *[]any) (any, error) {
		for _, row := range external {
			id := observeSourceAccount(rows, row)
			account := find(*rows, "id", id)
			resolution := obj(field(account["sourceIdentities"], text(row, "id")))
			if resolution == nil || !liveAccount(account) {
				resolution = object{"state": "unresolved"}
			}
			row["accountId"], row["identityResolution"] = id, clone(resolution)
		}
		return nil, nil
	})
	if err != nil {
		return err
	}
	after, err := readStamp(path)
	if err != nil {
		return err
	}
	if !stampSame(cache.stamp, after) {
		cache.stamp, cache.rows = after, map[string]cachedSourceAccount{}
	}
	for _, row := range external {
		cache.rows[text(row, "id")] = cachedSourceAccount{input(row), row["accountId"], clone(obj(row["identityResolution"]))}
	}
	return nil
}

func decorateSourceRecords(rows []any) error {
	if err := projectSourceAccounts(rows); err != nil {
		return err
	}
	for _, value := range rows {
		row := obj(value)
		if row["capabilityProfileOffer"] == true {
			row["capabilityProfileOffer"] = profileOffer(text(row, "product"), isBuiltinLocalSource(row))
		}
		if !sourceSwitchLive(row) {
			delete(row, "pendingSwitch")
		}
	}
	return nil
}

func getControlSource(id string) (object, error) {
	row, err := readSourceAuthority(id)
	if err != nil {
		return nil, err
	}
	return row, decorateSourceRecords([]any{row})
}

func listControlSources() ([]any, error) {
	rows, err := listSourceAuthority()
	if err != nil {
		return nil, err
	}
	if err := decorateSourceRecords(rows); err != nil {
		return nil, err
	}
	return slices.DeleteFunc(rows, isBuiltinLocalSource), nil
}

func sourceOrigin(ctx context.Context, panel bool) (requestSource, error) {
	row, err := ensureLocalSource()
	if err != nil {
		return requestSource{}, err
	}
	origin, err := touchControlSource(row, "local")
	if err != nil {
		return requestSource{}, err
	}
	if panel {
		origin["controlSource"], origin["sourceLabel"], origin["ingressId"] = "ARC", "ARC", "local-ui"
	}
	origin["controlTransport"] = "cli"
	return requestSource{local: true, origin: origin, profile: row, policy: "all"}, nil
}

func sourceIngressRecord(ingress string) (object, error) {
	if err := validateIngressID(ingress); err != nil {
		return nil, err
	}
	raw, err := load(filepath.Join(root(), "ingresses", ingress, "config.json"))
	if err != nil {
		return nil, err
	}
	entry := obj(raw)
	if entry["id"] != ingress {
		return nil, errors.New("ingress id mismatch")
	}
	return entry, nil
}

func authenticatedSourceRequest(ctx context.Context, service *service, ingress string, principal object, header *string) (requestSource, error) {
	entry, err := sourceIngressRecord(ingress)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) && ingress == "default" && service != nil &&
			principal["type"] == "ingress" && principal["ingressId"] == ingress && header == nil {
			return service.source, nil
		}
		return requestSource{}, err
	}
	if entry["enabled"] != true {
		return requestSource{}, errors.New("Connection closed")
	}
	auth := text(entry, "auth")
	var row object
	var eventPrincipal any
	switch principal["type"] {
	case "oauth-grant":
		if auth != "oauth" {
			return requestSource{}, errors.New(contextMismatch)
		}
		rows, err := listSourceAuthority()
		if err != nil {
			return requestSource{}, err
		}
		grant := text(principal, "grantId")
		row = sourceForGrantIn(rows, ingress, grant)
		if row == nil {
			return requestSource{}, errors.New("SOURCE_NOT_FOUND")
		}
		eventPrincipal = grant
	case "ingress":
		if principal["ingressId"] != ingress {
			return requestSource{}, errors.New(contextMismatch)
		}
		if auth == "oauth" {
			return requestSource{}, errors.New("OAuth principal required")
		}
		row, err = ensureIngressSource(entry, true)
		if err != nil {
			return requestSource{}, err
		}
		if full, err := loadIngressEntry(ingress); err == nil {
			eventPrincipal = hash([]byte(wire([]any{ingress, full["auth"], full["bearerToken"], field(full["config"], "tunnelId"), field(full["config"], "apiKey")})))
		}
	default:
		return requestSource{}, errors.New(contextMismatch)
	}
	origin, err := touchControlSource(row, auth)
	if err != nil {
		return requestSource{}, err
	}
	if eventPrincipal != nil {
		origin["eventPrincipal"] = eventPrincipal
	}
	return requestSource{origin: origin, profile: row, policy: entry["toolPolicy"]}, nil
}

func decorateSourceLabels(value any, rows []any) {
	labels := map[string]object{}
	for _, row := range rows {
		if id, ok := field(row, "id").(string); ok {
			labels[id] = obj(row)
		}
	}
	var visit func(any)
	visit = func(value any) {
		switch value := value.(type) {
		case object:
			if by := obj(value["answeredBy"]); by["kind"] == "source" {
				if source := labels[text(by, "sourceId")]; source != nil {
					by["label"], by["brand"] = source["label"], source["platform"]
				}
			}
			if _, isOrigin := value["authType"]; isOrigin {
				if source := labels[text(value, "sourceId")]; source != nil {
					value["sourceLabel"] = source["label"]
					if field(source["credential"], "type") == "peer" {
						value["deviceId"] = field(source["credential"], "deviceId")
					}
				}
			}
			for key, nested := range value {
				if !slices.Contains([]string{"arguments", "args", "input", "output", "metadata", "items", "finalResponse", "externalUserInputs"}, key) {
					visit(nested)
				}
			}
		case []any:
			for _, row := range value {
				visit(row)
			}
		}
	}
	visit(value)
}

func sourceAuthorityOperation(op string, body object) (any, error) {
	ingress, grant := text(body, "ingress"), text(body, "grant")
	id, grants := text(body, "id"), arr(body["grants"])
	switch op {
	case "get":
		return getControlSource(id)
	case "control_sources":
		return listControlSources()
	case "ensure_ingress":
		return ensureIngressSource(obj(body["entry"]), false)
	case "begin_switch":
		return beginControlSourceSwitch(text(body, "source_id"), obj(body["entry"]))
	case "cancel_switch":
		return clearOrRevokeControlSource(text(body, "source_id"), false)
	case "disconnect":
		return clearOrRevokeControlSource(id, true)
	case "update":
		return updateControlSource(id, obj(body["body"]))
	case "pending":
		return pendingSourceGrant(obj(body["entry"]), grant, text(body, "client"), text(body, "name"))
	case "connect":
		return connectSourceGrant(ingress, grant, text(body, "target"), grants)
	case "connection_state":
		connected, ok := body["connected"].(bool)
		if !ok {
			return nil, errors.New("invalid authority argument")
		}
		return setSourceConnectionState(ingress, connected)
	case "remove_connection":
		return removeSourceConnection(obj(body["entry"]), arr(body["pending"]))
	case "revoke_grants":
		return revokeSourceGrants(ingress, grants)
	}
	rows, err := listSourceAuthority()
	if err != nil {
		return nil, err
	}
	switch op {
	case "candidates":
		if err := decorateSourceRecords(rows); err != nil {
			return nil, err
		}
		return sourceClaimCandidates(rows, obj(body["source"]), grants), nil
	case "validate_claim":
		return nil, validateSourceClaim(rows, obj(body["pending"]), text(body, "target"), grants)
	case "for_grant":
		row := sourceForGrantIn(rows, ingress, grant)
		if row == nil {
			return nil, errors.New("SOURCE_NOT_FOUND")
		}
		return row, decorateSourceRecords([]any{row})
	case "grant_active":
		return sourceGrantActive(rows, ingress, grant), nil
	case "active_grants":
		active := []any{}
		for _, grant := range grants {
			if sourceGrantActive(rows, ingress, str(grant)) {
				active = append(active, grant)
			}
		}
		return active, nil
	case "ingress_retired":
		return slices.ContainsFunc(rows, func(row any) bool { return slices.Contains(arr(field(row, "retiredIngressIds")), any(ingress)) }), nil
	}
	return nil, errors.New("FRONT_DOOR_AUTHORITY_OPERATION: Use a matching front-door protocol.")
}

var manageSourceOAuth func(context.Context, *gatewayOwner, string, string, object) (any, error)

func gatewaySourceManagement(ctx context.Context, g *gatewayOwner, method, id, action string, body object) (any, error) {
	call := func(op string, value object) (any, error) { return requestSourceAuthority(ctx, g.bridge, op, value) }
	raw, err := call("get", object{"id": id})
	if err != nil {
		return nil, err
	}
	source := obj(raw)
	if method == http.MethodPut && action == "" {
		return call("update", object{"id": id, "body": body})
	}
	if action == "disconnect" {
		if err := requireControlSource(source); err != nil {
			return nil, err
		}
		switch field(source["credential"], "type") {
		case "oauth-grant":
			if _, err := manageSourceOAuth(ctx, g, text(source, "ingressId"), "revoke", object{"grantId": field(source["credential"], "grantId")}); err != nil {
				return nil, err
			}
		case "local":
			if _, err := g.management(ctx, "ingress/"+text(source, "ingressId")+"/stop", http.MethodPost, nil); err != nil {
				return nil, err
			}
		}
		return call("disconnect", object{"id": id})
	}
	if err := requireControlSource(source); err != nil {
		return nil, err
	}
	switch action {
	case "claim":
		target, ok := body["sourceId"].(string)
		if !ok {
			return nil, errors.New("sourceId must be new or an existing source ID")
		}
		_, err := manageSourceOAuth(ctx, g, text(source, "ingressId"), "decision", object{"requestId": field(source["credential"], "grantId"), "approved": true, "sourceId": target})
		return object{"approved": true, "sourceId": target}, err
	case "switch":
		if method == http.MethodDelete {
			pending := source["pendingSwitch"]
			if request, ok := field(pending, "requestId").(string); ok {
				if _, err := manageSourceOAuth(ctx, g, text(pending, "ingressId"), "revoke", object{"grantId": request}); err != nil {
					return nil, err
				}
			}
			return call("cancel_switch", object{"source_id": id})
		}
		entry, err := loadIngressEntry(text(body, "ingressId"))
		if err != nil {
			return nil, err
		}
		return call("begin_switch", object{"source_id": id, "entry": entry})
	}
	return nil, errors.New("UNKNOWN_ROUTE")
}

func init() {
	registerIndexPreparation(10, migrateLegacySourceHistory)
	registerIndexPreparation(30, completeLegacySourceMigration)
	registerSourceAuthority("peer_connect", func(_ context.Context, body object) (any, error) {
		return connectPeerSource(text(body, "deviceId"), text(body, "publicKey"), text(body, "name"))
	})
	registerSourceAuthority("peer_revoke", func(_ context.Context, body object) (any, error) {
		return revokePeerSource(text(body, "deviceId"))
	})
	registerServiceStartup(func(context.Context, *service) error {
		sourceStore.mu.Lock()
		defer sourceStore.mu.Unlock()
		return sourceStore.initialize(sourceIndexPath(), true)
	})
	for _, op := range []string{"get", "control_sources", "ensure_ingress", "begin_switch", "cancel_switch", "disconnect", "update", "pending", "connect", "connection_state",
		"remove_connection", "revoke_grants", "candidates", "validate_claim", "for_grant", "grant_active", "active_grants", "ingress_retired"} {
		registerSourceAuthority(op, func(_ context.Context, body object) (any, error) { return sourceAuthorityOperation(op, body) })
	}
	localSourceOrigin = func(ctx context.Context) (requestSource, error) { return sourceOrigin(ctx, false) }
	panelControlSource = func(ctx context.Context) (requestSource, error) { return sourceOrigin(ctx, true) }
	authenticateIngressPrincipal = authenticatedSourceRequest
	resolveAuthenticatedMCP = func(_ context.Context, _ *service, ingress, id string) (requestSource, error) {
		source, err := readSourceAuthority(id)
		if err != nil {
			return requestSource{}, err
		}
		entry, err := sourceIngressRecord(ingress)
		if err != nil {
			return requestSource{}, err
		}
		return requestSource{profile: source, policy: entry["toolPolicy"]}, nil
	}
	validateMCPCredential = func(_ context.Context, ingress, id string, credential any) error {
		source, err := readSourceAuthority(id)
		if err != nil {
			return err
		}
		return checkSourceAnchor(source, ingress, credential)
	}
	managementSourceProjection = func(value object) {
		if source, err := listSourceAuthority(); err == nil {
			decorateSourceLabels(value, source)
		}
		if accounts, err := readAccounts(); err == nil {
			decorateAccountLabels(value, accounts)
		}
	}
	decorateControlSource = func(_ context.Context, value object) {
		managementSourceProjection(value)
	}

	registerRoute(http.MethodGet, "source", func(context.Context, *service, object, []string) (any, error) {
		rows, err := listControlSources()
		return object{"sources": rows}, err
	})
	for _, route := range []struct{ method, pattern string }{
		{http.MethodPut, "source/([^/]+)"}, {http.MethodPost, "source/([^/]+)/(disconnect|claim|switch)"}, {http.MethodDelete, "source/([^/]+)/(switch)"},
	} {
		registerGatewayRoute(route.method, route.pattern, func(ctx context.Context, g *gatewayOwner, body object, params []string) (any, error) {
			action := ""
			if len(params) > 1 {
				action = params[1]
			}
			return gatewaySourceManagement(ctx, g, route.method, params[0], action, body)
		})
		registerRoutePattern(route.method, route.pattern, func(ctx context.Context, s *service, body object, params []string) (any, error) {
			source, err := getControlSource(params[0])
			if err != nil {
				return nil, err
			}
			if len(params) == 1 {
				return updateControlSource(params[0], body)
			}
			if err := requireControlSource(source); err != nil {
				return nil, err
			}
			if s.fixtureIngress != nil && params[1] == "disconnect" && field(source["credential"], "type") == "ingress" {
				return clearOrRevokeControlSource(params[0], true)
			}
			return gatewayRequest(ctx, "source/"+strings.Join(params, "/"), route.method, body)
		})
	}
}

const sourceMigrationVersion = 2

func legacySourceMigrationLabel(source object) string {
	date := "unknown date"
	if at, ok := uintValue(source["connectedAt"]); ok && at <= 8210266876799 {
		date = time.Unix(int64(at), 0).UTC().Format("2006-01-02")
	}
	return text(sourcePreset(text(source, "product")), "displayName") + " " + date
}

func disambiguateLegacySources(rows []any) {
	ingressCounts := map[string]int{}
	for _, row := range rows {
		ingressCounts[text(row, "ingressId")]++
	}
	generated := make([]bool, len(rows))
	labels := map[[2]string]bool{}
	for i, raw := range rows {
		source := obj(raw)
		ingress, label := text(source, "ingressId"), text(source, "label")
		generated[i] = ingressCounts[ingress] > 1 && label == legacySourceMigrationLabel(source)
		if !generated[i] {
			labels[[2]string{ingress, label}] = true
		}
	}
	for i, raw := range rows {
		if !generated[i] {
			continue
		}
		source := obj(raw)
		ingress, base := text(source, "ingressId"), legacySourceMigrationLabel(source)
		label := base
		for n := 2; labels[[2]string{ingress, label}]; n++ {
			label = fmt.Sprintf("%s %d", base, n)
		}
		source["label"] = label
		labels[[2]string{ingress, label}] = true
	}
}

func loadSourceOptional(path string, fallback any) (any, error) {
	value, err := load(path)
	if errors.Is(err, os.ErrNotExist) {
		return fallback, nil
	}
	return value, err
}

func prepareLegacySourceState(path string, store object) (object, error) {
	if uintOr(store["version"], 0) == sourceMigrationVersion {
		return store, nil
	}
	stateRoot := filepath.Dir(path)
	pref, err := loadSourceOptional(filepath.Join(stateRoot, "ui-preferences.json"), object{})
	if err != nil {
		return nil, err
	}
	labels := field(field(pref, "values"), "arc.approved-source-labels")
	if raw, ok := labels.(string); ok {
		var decoded any
		if err := canonjson.Unmarshal([]byte(raw), &decoded); err != nil {
			return nil, err
		}
		labels = decoded
	}
	rows := arr(store["sources"])
	if rows == nil {
		return nil, errors.New("Invalid source store")
	}
	if len(rows) == 0 {
		raw, err := loadSourceOptional(filepath.Join(stateRoot, "ingresses/index.json"), []any{})
		if err != nil {
			return nil, err
		}
		ids := arr(raw)
		if ids == nil {
			return nil, errors.New("Invalid ingress index")
		}
		for _, value := range ids {
			ingress, ok := value.(string)
			if !ok || !ingressIdentifier.MatchString(ingress) {
				return nil, errors.New("Invalid ingress ID")
			}
			dir := filepath.Join(stateRoot, "ingresses", ingress)
			raw, err := load(filepath.Join(dir, "config.json"))
			if err != nil {
				return nil, err
			}
			entry := obj(raw)
			start := len(rows)
			if entry["auth"] == "oauth" {
				oauth, err := loadSourceOptional(filepath.Join(dir, "oauth.json"), object{})
				if err != nil {
					return nil, err
				}
				for _, grant := range arr(field(oauth, "grants")) {
					id, client := text(grant, "id"), text(grant, "client")
					product, ok := field(labels, id).(string)
					if ok {
						product = sourceProduct(product)
					} else {
						product = oauthSourceProduct(entry, text(field(field(oauth, "clients"), client), "name"))
					}
					source := newControlSource(rows, entry, object{"type": "oauth-grant", "grantId": id, "clientId": client}, product, field(grant, "connected_at"))
					source["label"] = legacySourceMigrationLabel(source)
					rows = append(rows, source)
				}
			} else {
				typ := "ingress"
				if entry["transport"] == "local" {
					typ = "local"
				}
				rows = append(rows, newControlSource(rows, entry, object{"type": typ}, text(entry, "controlSource"), nil))
			}
			if len(rows) == start+1 {
				obj(rows[start])["label"] = entry["name"]
			}
		}
		rows = append(rows, newControlSource(rows, object{"id": "local-cli"}, object{"type": "local"}, "local-cli", nil))
		for _, value := range rows {
			delete(obj(value), "capabilityProfileOffer")
		}
		store["sources"] = rows
		if err := save(path, store); err != nil {
			return nil, err
		}
	}
	before := wire(store)
	disambiguateLegacySources(rows)
	if wire(store) != before {
		if err := save(path, store); err != nil {
			return nil, err
		}
	}
	return store, nil
}

func stableSourceByIngress(rows []any, id string) object {
	var selected object
	for _, row := range rows {
		if field(row, "ingressId") != id {
			continue
		}
		if selected != nil {
			return nil
		}
		selected = obj(row)
	}
	return selected
}

func readLegacySourceRecord(path string) (any, error) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var value any
	if canonjson.Unmarshal(bytes, &value) != nil {
		recordLog("WARN", "Ignored malformed legacy source-scoped record", nil)
		return nil, nil
	}
	return value, nil
}

func migrateLegacySourceAttribution(value any, rows []any) {
	switch value := value.(type) {
	case object:
		old, present := value["ingress"]
		delete(value, "ingress")
		ingress, ok := old.(string)
		if !ok {
			ingress = text(value, "ingressId")
		}
		_, hasIngress := value["ingressId"]
		_, auth := value["authType"]
		if _, resolved := value["sourceId"]; !resolved && (present || hasIngress || auth) {
			value["ingressId"], value["sourceId"] = ingress, ""
			if source := stableSourceByIngress(rows, ingress); ingress != "" && source != nil {
				value["sourceId"] = source["id"]
				if _, product := value["controlSource"]; product {
					value["controlSource"], value["sourceLabel"] = source["product"], source["label"]
				}
			}
		}
		for key, nested := range value {
			if slices.Contains([]string{"arguments", "args", "prompt", "input", "output", "result", "request", "finalResponse", "externalUserInputs", "metadata"}, key) {
				continue
			}
			migrateLegacySourceAttribution(nested, rows)
			if origin := obj(nested); key == "origin" && origin != nil {
				if _, ok := origin["sourceId"].(string); !ok {
					origin["sourceId"] = ""
				}
			}
		}
	case []any:
		for _, nested := range value {
			migrateLegacySourceAttribution(nested, rows)
		}
	}
}

func moveLegacySourceRecord(path, target string, value any) error {
	if _, err := os.Stat(target); errors.Is(err, os.ErrNotExist) {
		if err := save(target, value); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	return os.Remove(path)
}

func migrateLegacySourceRecord(path string, rows []any) error {
	value, err := readLegacySourceRecord(path)
	if err != nil || value == nil {
		return err
	}
	before := wire(value)
	migrateLegacySourceAttribution(value, rows)
	row := obj(value)
	parent := filepath.Dir(path)
	owner := filepath.Base(parent)
	if owner == "notifications" || strings.HasSuffix(filepath.ToSlash(parent), "/notifications/tasks") || owner == "respond-tokens" {
		if _, ok := row["sourceId"].(string); row != nil && !ok {
			row["sourceId"] = ""
		}
	}
	if owner == "respond-tokens" {
		source := text(row, "sourceId")
		if source == "" {
			return os.Remove(path)
		}
		request := row["request"]
		session := field(request, "backendSession")
		if field(request, "owner") == "desktop" {
			session = nil
		}
		digest := hash([]byte(wire([]any{source, field(request, "owner"), field(request, "id"), session})))
		if target := filepath.Join(parent, digest+".json"); target != path {
			return moveLegacySourceRecord(path, target, value)
		}
	}
	if owner == "send-queue" && row != nil {
		origin := obj(row["origin"])
		if origin == nil {
			origin = object{}
			row["origin"] = origin
		}
		if _, ok := origin["sourceId"].(string); !ok {
			origin["sourceId"] = ""
		}
		if text(origin, "sourceId") == "" && slices.Contains([]string{"queued", "blocked", "dispatching"}, text(row, "state")) {
			row["state"], row["reason"] = "failed", "source-unattributed"
		}
	}
	if owner == "inboxes" {
		for _, source := range rows {
			ingress := text(source, "ingressId")
			previous := hash([]byte(ingress)) + ".json"
			if filepath.Base(path) == previous && stableSourceByIngress(rows, ingress) != nil {
				target := filepath.Join(parent, hash([]byte(text(source, "id")))+".json")
				if target != path {
					return moveLegacySourceRecord(path, target, value)
				}
			}
		}
	}
	if wire(value) != before {
		return save(path, value)
	}
	return nil
}

func migrateLegacySourceDirectory(ctx context.Context, dir string, sources []any) error {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.Name() == ".activity-index" {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			if err := migrateLegacySourceDirectory(ctx, path, sources); err != nil {
				return err
			}
		} else if entry.Type().IsRegular() && filepath.Ext(path) == ".json" {
			if err := migrateLegacySourceRecord(path, sources); err != nil {
				return err
			}
		}
	}
	return nil
}

func migrateLegacyDispatchOrigins(ctx context.Context, stateRoot string) error {
	dir := filepath.Join(stateRoot, "dispatches")
	folders, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, folder := range folders {
		if !folder.IsDir() {
			continue
		}
		base := filepath.Join(dir, folder.Name())
		entries, err := os.ReadDir(base)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			if !entry.Type().IsRegular() || filepath.Ext(entry.Name()) != ".json" {
				continue
			}
			path := filepath.Join(base, entry.Name())
			value, err := readLegacySourceRecord(path)
			if err != nil {
				return err
			}
			row := obj(value)
			if row == nil || obj(row["origin"]) != nil {
				continue
			}
			id := text(row, "requestId")
			if _, err := uuid.Parse(id); err != nil {
				continue
			}
			for _, location := range []string{"", "agents/requests"} {
				receipt, err := load(filepath.Join(stateRoot, location, id+".json"))
				if errors.Is(err, os.ErrNotExist) {
					continue
				}
				if err != nil {
					return err
				}
				row["origin"] = field(receipt, "origin")
				if err := save(path, row); err != nil {
					return err
				}
				break
			}
		}
	}
	return nil
}

type legacySourceTask struct {
	path string
	row  object
}

func migrateLegacyNotificationKeys(ctx context.Context, stateRoot string) error {
	dir := filepath.Join(stateRoot, "notifications")
	path := filepath.Join(dir, "subscriptions/state.json")
	raw, err := load(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	state := obj(raw)
	if state == nil {
		return errors.New("Invalid notification state")
	}
	taskDir := filepath.Join(dir, "tasks")
	entries, err := os.ReadDir(taskDir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	tasks := []legacySourceTask{}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !entry.Type().IsRegular() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(taskDir, entry.Name())
		value, err := readLegacySourceRecord(path)
		if err != nil {
			return err
		}
		if row := obj(value); row != nil {
			tasks = append(tasks, legacySourceTask{path, row})
		}
	}
	ids := map[string]string{}
	subID := func(value ...any) string { return "sub_" + hash([]byte(wire(value))) }
	for _, value := range arr(state["subscriptions"]) {
		sub := obj(value)
		source := text(sub, "sourceId")
		if source == "" {
			continue
		}
		old := text(sub, "id")
		var current, legacy string
		if sub["channel"] == "claude-session" {
			for _, task := range tasks {
				row := task.row
				if row["sourceId"] == sub["sourceId"] && row["turnId"] == sub["turn"] &&
					(field(sub["args"], "threadId") == row["threadId"] || field(sub["args"], "taskId") == row["threadId"]) {
					current = subID("claude-session", row["sourceId"], row["agent"], row["threadId"], row["turnId"])
					legacy = subID("claude-session", row["ingressId"], row["agent"], row["threadId"], row["turnId"])
					break
				}
			}
		} else {
			hook := sub["webhook"]
			action := object{"op": sub["op"], "args": sub["args"]}
			current = subID(sub["sourceId"], field(hook, "principal"), "notification", action, field(hook, "url"))
			legacy = subID(sub["ingressId"], field(hook, "principal"), "notification", action, field(hook, "url"))
		}
		if current == "" {
			continue
		}
		ids[old], ids[legacy] = current, current
		if sub["target"] == old {
			sub["target"] = current
		}
		sub["id"] = current
	}
	for _, key := range []string{"subscriptions", "targets", "threads"} {
		if rows := arr(state[key]); rows != nil {
			state[key] = slices.DeleteFunc(rows, func(row any) bool { return text(row, "sourceId") == "" })
		}
	}
	for _, value := range arr(state["targets"]) {
		if target, ok := ids[text(value, "target")]; ok {
			obj(value)["target"] = target
		}
	}
	if err := save(path, state); err != nil {
		return err
	}
	for _, task := range tasks {
		if err := ctx.Err(); err != nil {
			return err
		}
		for _, value := range arr(task.row["deliveries"]) {
			for _, key := range []string{"subscription", "target"} {
				if id, ok := ids[text(value, key)]; ok {
					obj(value)[key] = id
				}
			}
		}
		if err := save(task.path, task.row); err != nil {
			return err
		}
	}
	return nil
}

func sourceStateVersion() (uint64, []any, error) {
	sourceStore.mu.Lock()
	defer sourceStore.mu.Unlock()
	if err := sourceStore.initialize(sourceIndexPath(), false); err != nil {
		return 0, nil, err
	}
	store := clone(sourceStore.current)
	return uintOr(store["version"], 0), arr(store["sources"]), nil
}

func migrateLegacySourceHistory(ctx context.Context, _ *service) error {
	version, rows, err := sourceStateVersion()
	if err != nil || version == sourceMigrationVersion {
		return err
	}
	stateRoot := root()
	for _, name := range []string{"", "agents/requests", "notifications/tasks"} {
		if err := indexInvalidate(ctx, filepath.Join(stateRoot, name)); err != nil {
			return err
		}
	}
	for _, base := range []string{"notifications", "respond-tokens", "send-queue", "dispatches", "agents/requests", "agents/tasks"} {
		if err := migrateLegacySourceDirectory(ctx, filepath.Join(stateRoot, base), rows); err != nil {
			return err
		}
	}
	entries, err := os.ReadDir(stateRoot)
	if err != nil {
		return err
	}
	receipts := []string{}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := entry.Name()
		if !entry.Type().IsRegular() || filepath.Ext(name) != ".json" {
			continue
		}
		if _, err := uuid.Parse(strings.TrimSuffix(name, ".json")); err == nil {
			receipts = append(receipts, filepath.Join(stateRoot, name))
		}
	}
	chunk := max((len(receipts)+3)/4, 256)
	workers, cancel := context.WithCancel(ctx)
	defer cancel()
	var group sync.WaitGroup
	var failure error
	var failOnce sync.Once
	for start := 0; start < len(receipts); start += chunk {
		files := receipts[start:min(start+chunk, len(receipts))]
		group.Go(func() {
			for _, path := range files {
				if workers.Err() != nil {
					return
				}
				if err := migrateLegacySourceRecord(path, rows); err != nil {
					failOnce.Do(func() { failure = err; cancel() })
					return
				}
			}
		})
	}
	group.Wait()
	if failure != nil {
		return failure
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := migrateLegacyNotificationKeys(ctx, stateRoot); err != nil {
		return err
	}
	if err := migrateLegacyDispatchOrigins(ctx, stateRoot); err != nil {
		return err
	}
	prefPath := filepath.Join(stateRoot, "ui-preferences.json")
	pref, err := loadSourceOptional(prefPath, object{})
	if err != nil {
		return err
	}
	prefs := obj(field(pref, "values"))
	if _, exists := prefs["arc.approved-source-labels"]; exists {
		delete(prefs, "arc.approved-source-labels")
		return save(prefPath, pref)
	}
	return nil
}

// Segment C registers notification-state conversion between source phases 10 and 30.
var sourceNotificationMigrationReady func() bool

func completeLegacySourceMigration(_ context.Context, _ *service) error {
	sourceStore.mu.Lock()
	defer sourceStore.mu.Unlock()
	if uintOr(sourceStore.current["version"], 0) == sourceMigrationVersion {
		return nil
	}
	_, notificationErr := os.Stat(filepath.Join(root(), "notifications/subscriptions/state.json"))
	if notificationErr == nil && (sourceNotificationMigrationReady == nil || !sourceNotificationMigrationReady()) {
		// Keep the preceding conversion replayable while the notification owner is pending.
		return nil
	}
	if notificationErr != nil && !errors.Is(notificationErr, os.ErrNotExist) {
		return notificationErr
	}
	disk := clone(sourceStore.persisted)
	disk["version"] = sourceMigrationVersion
	if err := save(sourceIndexPath(), disk); err != nil {
		return err
	}
	sourceStore.current["version"], sourceStore.persisted = sourceMigrationVersion, disk
	return nil
}

func connectPeerSource(device, key, name string) (object, error) {
	return changeSources(false, func(rows *[]any) (object, error) {
		for _, value := range *rows {
			if field(field(value, "credential"), "type") == "peer" {
				obj(value)["state"] = "revoked"
			}
		}
		peer := object{"id": id(), "ingressId": "peer:" + device, "credential": object{"type": "peer", "deviceId": device, "publicKey": key},
			"product": "custom", "platform": "custom", "label": name, "createdAt": now(), "connectedAt": time.Now().Unix(), "state": "connected"}
		*rows = append(*rows, peer)
		return clone(peer), nil
	})
}

func revokePeerSource(device string) (object, error) {
	return changeSources(false, func(rows *[]any) (object, error) {
		for _, value := range *rows {
			credential := field(value, "credential")
			if field(credential, "type") == "peer" && field(credential, "deviceId") == device {
				obj(value)["state"] = "revoked"
			}
		}
		return object{"ok": true}, nil
	})
}

func pairedSourceAuthority(device, publicKey string) (object, error) {
	rows, err := listSourceAuthority()
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		credential := field(row, "credential")
		if field(credential, "type") == "peer" && field(credential, "deviceId") == device && field(credential, "publicKey") == publicKey && field(row, "state") != "revoked" {
			return obj(row), nil
		}
	}
	return nil, errors.New("DEVICE_UNPAIRED: Approve a fresh member-local device offer; read cli guide.")
}

func confirmControlSourceAccount(source string, evidence object) (object, error) {
	row, err := getControlSource(source)
	if err != nil {
		return nil, err
	}
	if isBuiltinLocalSource(row) {
		return object{"state": "not-applicable"}, nil
	}
	return changeAccounts(func(rows *[]any) (object, error) { return linkAccountSourceIdentity(*rows, source, evidence) })
}

func coordinationSourceAuthorities() ([]any, error) {
	return listSourceAuthority()
}

func revokedCoordinationSources() ([]string, error) {
	rows, err := listSourceAuthority()
	if err != nil {
		return nil, err
	}
	result := []string{}
	for _, row := range rows {
		if !isBuiltinLocalSource(row) && (field(row, "state") == "revoked" || field(row, "connectionRemoved") == true) {
			result = append(result, text(row, "id"))
		}
	}
	return result, nil
}

var sourceDispatchRecords func(string) ([]any, error)

func taskSourceOrigin(thread string, turn *string) any {
	if sourceDispatchRecords == nil {
		return nil
	}
	rows, err := sourceDispatchRecords(thread)
	if err != nil {
		return nil
	}
	for _, row := range slices.Backward(rows) {
		if turn == nil || field(row, "turnId") == *turn {
			origin := clone(obj(field(row, "origin")))
			if sources, err := listSourceAuthority(); err == nil {
				decorateSourceLabels(origin, sources)
			}
			return origin
		}
	}
	return nil
}
