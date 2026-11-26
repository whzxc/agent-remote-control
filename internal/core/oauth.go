package core

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/whzxc/agent-remote-control/desktop/icons"
	"github.com/whzxc/agent-remote-control/internal/canonjson"
	coreAssets "github.com/whzxc/agent-remote-control/shared/core"
	"github.com/whzxc/agent-remote-control/ui"
)

const oauthAccessTTL = 3600
const oauthRegistrationTTL = 30 * 86400

func oauthClock() int64   { return time.Now().Unix() }
func oauthSecret() string { return strings.ReplaceAll(id()+id(), "-", "") }

type oauthClient struct {
	Name       string   `json:"name"`
	Redirects  []string `json:"redirects"`
	Method     string   `json:"method"`
	SecretHash string   `json:"secret_hash"`
	Created    int64    `json:"created"`
}

type oauthGrant struct {
	ID                string   `json:"id"`
	ConnectedAt       *int64   `json:"connected_at"`
	Client            string   `json:"client"`
	Resource          string   `json:"resource"`
	AuthorizationCode string   `json:"authorization_code"`
	Access            string   `json:"access"`
	AccessExpires     int64    `json:"access_expires"`
	Refresh           string   `json:"refresh"`
	UsedRefresh       []string `json:"used_refresh"`
}

type oauthPending struct {
	pairingCode, client, redirect, state, challenge, resource string
	expires                                                   int64
	decision                                                  *bool
	sourceChoice, code, codeHash                              string
}

type oauthStored struct {
	Resource string                 `json:"resource"`
	Clients  map[string]oauthClient `json:"clients"`
	Grants   []oauthGrant           `json:"grants"`
}

type oauthAuthority func(context.Context, string, object) (any, error)

type ingressOAuth struct {
	mu            sync.Mutex
	path          string
	stored        oauthStored
	pending       map[string]*oauthPending
	registrations []int64
	authority     oauthAuthority
}

func newIngressOAuth(dir string, bridge *gatewayBridge) (*ingressOAuth, error) {
	store := &ingressOAuth{
		path: filepath.Join(dir, "oauth.json"), stored: oauthStored{Clients: map[string]oauthClient{}, Grants: []oauthGrant{}}, pending: map[string]*oauthPending{},
		authority: func(ctx context.Context, op string, body object) (any, error) {
			return requestSourceAuthority(ctx, bridge, op, body)
		},
	}
	data, err := os.ReadFile(store.path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	var value oauthStored
	if err := canonjson.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	if value.Clients == nil || value.Grants == nil {
		return nil, errors.New("Invalid OAuth store")
	}
	store.stored = value
	return store, nil
}

func (oauth *ingressOAuth) persist() error {
	// Rust converts Stored to a serde_json::Value before persisting it.
	var value object
	if err := canonjson.Unmarshal([]byte(wire(oauth.stored)), &value); err != nil {
		return err
	}
	return save(oauth.path, value)
}

func (oauth *ingressOAuth) ingressID() string { return filepath.Base(filepath.Dir(oauth.path)) }

func (oauth *ingressOAuth) revokeSources(ctx context.Context, ids []string) error {
	_, err := oauth.authority(ctx, "revoke_grants", object{"ingress": oauth.ingressID(), "grants": oauthIDValues(ids)})
	return err
}

func oauthIDValues(ids []string) []any {
	values := make([]any, len(ids))
	for i, id := range ids {
		values[i] = id
	}
	return values
}

func (oauth *ingressOAuth) grantIDs() []string {
	ids := make([]string, 0, len(oauth.stored.Grants))
	for _, grant := range oauth.stored.Grants {
		ids = append(ids, grant.ID)
	}
	return ids
}

func (oauth *ingressOAuth) pendingIDs() []string {
	result := make([]string, 0, len(oauth.pending))
	for key := range oauth.pending {
		result = append(result, key)
	}
	slices.Sort(result)
	return result
}

func (oauth *ingressOAuth) reset(ctx context.Context) error {
	if err := oauth.revokeSources(ctx, append(oauth.grantIDs(), oauth.pendingIDs()...)); err != nil {
		return err
	}
	oauth.stored.Grants = []oauthGrant{}
	clear(oauth.pending)
	return oauth.persist()
}

func (oauth *ingressOAuth) applyAuthoritySnapshot(active []any, err error) error {
	if err != nil {
		return err
	}
	previous := oauth.stored.Grants
	remaining := slices.DeleteFunc(slices.Clone(previous), func(g oauthGrant) bool { return !slices.Contains(active, any(g.ID)) })
	if len(remaining) == len(previous) {
		return nil
	}
	oauth.stored.Grants = remaining
	if err := oauth.persist(); err != nil {
		oauth.stored.Grants = previous
		return err
	}
	return nil
}

func oauthAuthorityList(value any) []any {
	if list := arr(value); list != nil {
		return list
	}
	if strings, ok := value.([]string); ok {
		return oauthIDValues(strings)
	}
	return nil
}

func (oauth *ingressOAuth) prepare(ctx context.Context, resource string) error {
	if oauth.stored.Resource != resource {
		if err := oauth.reset(ctx); err != nil {
			return err
		}
		oauth.stored.Resource = resource
		if err := oauth.persist(); err != nil {
			return err
		}
	}
	ids := oauth.grantIDs()
	active, err := oauth.authority(ctx, "active_grants", object{"ingress": oauth.ingressID(), "grants": oauthIDValues(ids)})
	if err := oauth.applyAuthoritySnapshot(oauthAuthorityList(active), err); err != nil {
		return err
	}
	now := oauthClock()
	expired := []string{}
	for _, key := range oauth.pendingIDs() {
		if oauth.pending[key].expires <= now && !slices.Contains(ids, key) {
			expired = append(expired, key)
		}
	}
	if err := oauth.revokeSources(ctx, expired); err != nil {
		return err
	}
	for key, pending := range oauth.pending {
		expires := pending.expires
		if pending.decision != nil && *pending.decision {
			expires += 300
		}
		if expires <= now {
			delete(oauth.pending, key)
		}
	}
	for id, client := range oauth.stored.Clients {
		if client.Created+oauthRegistrationTTL <= now && !slices.ContainsFunc(oauth.stored.Grants, func(grant oauthGrant) bool { return grant.Client == id }) {
			delete(oauth.stored.Clients, id)
		}
	}
	oauth.registrations = slices.DeleteFunc(oauth.registrations, func(ts int64) bool { return ts+3600 <= now })
	return nil
}

func (oauth *ingressOAuth) authenticateTransport(header, resource string) object {
	token, ok := strings.CutPrefix(header, "Bearer ")
	if !ok {
		return nil
	}
	digest := hash([]byte(token))
	for _, grant := range oauth.stored.Grants {
		if grant.Resource == resource && grant.AccessExpires > oauthClock() && secureToken(digest, grant.Access) {
			return object{"type": "oauth-grant", "grantId": grant.ID, "clientId": grant.Client}
		}
	}
	return nil
}

func (oauth *ingressOAuth) grantActive(ctx context.Context, id string) bool {
	value, err := oauth.authority(ctx, "grant_active", object{"ingress": oauth.ingressID(), "grant": id})
	return err == nil && value == true
}

func (oauth *ingressOAuth) transportPrincipal(header, resource string) object {
	oauth.mu.Lock()
	defer oauth.mu.Unlock()
	return oauth.authenticateTransport(header, resource)
}

func (oauth *ingressOAuth) authenticate(ctx context.Context, header, resource string) object {
	oauth.mu.Lock()
	defer oauth.mu.Unlock()
	if oauth.prepare(ctx, resource) != nil {
		return nil
	}
	principal := oauth.authenticateTransport(header, resource)
	if principal != nil && oauth.grantActive(ctx, text(principal, "grantId")) {
		return principal
	}
	return nil
}

func (oauth *ingressOAuth) eventPrincipal(ctx context.Context, header string) string {
	oauth.mu.Lock()
	defer oauth.mu.Unlock()
	token, ok := strings.CutPrefix(header, "Bearer ")
	if !ok {
		return ""
	}
	digest := hash([]byte(token))
	for _, grant := range oauth.stored.Grants {
		if grant.AccessExpires > oauthClock() && secureToken(digest, grant.Access) && oauth.grantActive(ctx, grant.ID) {
			return grant.ID
		}
	}
	return ""
}

func (oauth *ingressOAuth) eventGrantActive(ctx context.Context, id, resource string) bool {
	oauth.mu.Lock()
	defer oauth.mu.Unlock()
	for _, grant := range oauth.stored.Grants {
		if grant.ID == id && (resource == "" || grant.Resource == resource) {
			return oauth.grantActive(ctx, id)
		}
	}
	return false
}

type oauthRegistrationError struct{ code, field, detail string }

func (e *oauthRegistrationError) Error() string { return e.code }

func oauthRedirectError(reason string, parsed *url.URL) error {
	summary := "<unavailable>"
	if parsed != nil {
		summary = parsed.Scheme + "://" + oauthHostname(parsed)
		if port := oauthExplicitPort(parsed); port != "" {
			summary += ":" + port
		}
		summary += parsed.EscapedPath()
		var keys []string
		for _, pair := range strings.Split(parsed.RawQuery, "&") {
			if pair != "" {
				key, _, _ := strings.Cut(pair, "=")
				keys = append(keys, key)
			}
		}
		if len(keys) > 0 {
			summary += "?" + strings.Join(keys, "&")
		}
	}
	clean := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, "reason="+reason+" uri="+summary)
	runes := []rune(clean)
	return &oauthRegistrationError{"invalid_redirect_uri", "redirect_uris", string(runes[:min(300, len(runes))])}
}

func oauthHostname(parsed *url.URL) string {
	host := asciiFold(parsed.Hostname())
	if strings.Contains(host, ":") {
		return "[" + host + "]"
	}
	return host
}

func oauthExplicitPort(parsed *url.URL) string {
	port := parsed.Port()
	if port == "443" && parsed.Scheme == "https" || port == "80" && parsed.Scheme == "http" {
		return ""
	}
	return port
}

func parseOAuthRedirect(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme == "" {
		return nil, errors.New("invalid_redirect_uri")
	}
	if parsed.Host != "" {
		host := oauthHostname(parsed)
		if port := oauthExplicitPort(parsed); port != "" {
			host += ":" + port
		}
		parsed.Host = host
		if parsed.Path == "" && (parsed.Scheme == "http" || parsed.Scheme == "https") {
			parsed.Path = "/"
		}
	}
	return parsed, nil
}

func (oauth *ingressOAuth) register(ctx context.Context, body any, resource string) (object, error) {
	if err := oauth.prepare(ctx, resource); err != nil {
		return nil, err
	}
	if len(oauth.stored.Clients) >= 128 || len(oauth.registrations) >= 20 {
		return nil, errors.New("temporarily_unavailable")
	}
	name := strings.TrimSpace(text(body, "client_name"))
	if len(name) > 120 || strings.ContainsFunc(name, unicode.IsControl) {
		return nil, &oauthRegistrationError{"invalid_client_metadata", "client_name", ""}
	}
	values := arr(field(body, "redirect_uris"))
	if len(values) == 0 || len(values) > 8 {
		return nil, oauthRedirectError("count", nil)
	}
	redirects := make([]string, 0, len(values))
	for _, raw := range values {
		text, ok := raw.(string)
		if !ok {
			return nil, oauthRedirectError("not_string", nil)
		}
		parsed, err := parseOAuthRedirect(text)
		if len(text) > 2048 {
			return nil, oauthRedirectError("too_long", parsed)
		}
		if err != nil {
			return nil, oauthRedirectError("parse", nil)
		}
		loopback := slices.Contains([]string{"127.0.0.1", "[::1]", "localhost"}, oauthHostname(parsed))
		reason := ""
		switch {
		case strings.Contains(text, "#"):
			reason = "fragment"
		case parsed.User != nil && (parsed.User.Username() != "" || oauthHasPassword(parsed.User)):
			reason = "userinfo"
		case parsed.Host == "" && parsed.Scheme != "file":
			reason = "no_host"
		case !(parsed.Scheme == "https" || parsed.Scheme == "http" && loopback):
			reason = "scheme"
		}
		if reason != "" {
			return nil, oauthRedirectError(reason, parsed)
		}
		redirects = append(redirects, text)
	}
	for _, option := range []struct{ name, required string }{{"grant_types", "authorization_code"}, {"response_types", "code"}} {
		if field, set := obj(body)[option.name]; set {
			list := arr(field)
			if !slices.Contains(list, any(option.required)) || slices.ContainsFunc(list, func(item any) bool { _, ok := item.(string); return !ok }) {
				return nil, &oauthRegistrationError{"invalid_client_metadata", option.name, ""}
			}
		}
	}
	if raw, set := obj(body)["scope"]; set {
		if scope, ok := raw.(string); !ok || scope != "" && !slices.Contains(strings.Split(scope, " "), "mcp") {
			return nil, &oauthRegistrationError{"invalid_scope", "scope", ""}
		}
	}
	method, ok := field(body, "token_endpoint_auth_method").(string)
	if !ok {
		method = "client_secret_basic"
	}
	if !slices.Contains([]string{"none", "client_secret_post", "client_secret_basic"}, method) {
		return nil, &oauthRegistrationError{"invalid_client_metadata", "token_endpoint_auth_method", ""}
	}
	clientID, secret := oauthSecret(), ""
	if method != "none" {
		secret = oauthSecret()
	}
	if name == "" {
		name = "MCP client"
	}
	oauth.stored.Clients[clientID] = oauthClient{name, redirects, method, hash([]byte(secret)), oauthClock()}
	oauth.registrations = append(oauth.registrations, oauthClock())
	if err := oauth.persist(); err != nil {
		delete(oauth.stored.Clients, clientID)
		oauth.registrations = oauth.registrations[:len(oauth.registrations)-1]
		return nil, err
	}
	result := object{"client_id": clientID, "client_name": name, "redirect_uris": redirects, "client_id_issued_at": oauthClock(),
		"token_endpoint_auth_method": method, "grant_types": []string{"authorization_code", "refresh_token"},
		"response_types": []string{"code"}, "scope": "mcp"}
	if method != "none" {
		result["client_secret"], result["client_secret_expires_at"] = secret, 0
	}
	return result, nil
}

func oauthHasPassword(info *url.Userinfo) bool { _, set := info.Password(); return set }
func oauthASCIIAlphanumeric(c rune) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
}

func (oauth *ingressOAuth) authorize(ctx context.Context, q map[string]string, resource string) (string, error) {
	if err := oauth.prepare(ctx, resource); err != nil {
		return "", err
	}
	client, ok := oauth.stored.Clients[q["client_id"]]
	if !ok {
		return "", errors.New("invalid_client")
	}
	if !slices.Contains(client.Redirects, q["redirect_uri"]) {
		return "", errors.New("invalid_redirect_uri")
	}
	if q["response_type"] != "code" {
		return "", errors.New("unsupported_response_type")
	}
	if q["resource"] != resource {
		return "", errors.New("invalid_target")
	}
	if q["scope"] != "" && q["scope"] != "mcp" {
		return "", errors.New("invalid_scope")
	}
	challenge := q["code_challenge"]
	if q["code_challenge_method"] != "S256" || len(challenge) != 43 || len(q["state"]) > 2048 ||
		strings.ContainsFunc(challenge, func(c rune) bool { return !oauthASCIIAlphanumeric(c) && c != '-' && c != '_' }) {
		return "", errors.New("invalid_request")
	}
	for _, key := range oauth.pendingIDs() {
		p := oauth.pending[key]
		if p.decision == nil && p.expires > oauthClock() && p.client == q["client_id"] && p.redirect == q["redirect_uri"] && p.state == q["state"] && p.challenge == challenge && p.resource == resource {
			return key, nil
		}
	}
	if len(oauth.pending) >= 32 {
		return "", errors.New("temporarily_unavailable")
	}
	key, pairing := oauthSecret(), oauth.pairingCode()
	entry, err := load(filepath.Join(filepath.Dir(oauth.path), "config.json"))
	if err != nil {
		return "", err
	}
	if _, err := oauth.authority(ctx, "pending", object{"entry": entry, "grant": key, "client": q["client_id"], "name": client.Name}); err != nil {
		return "", err
	}
	oauth.pending[key] = &oauthPending{pairingCode: pairing, client: q["client_id"], redirect: q["redirect_uri"], state: q["state"], challenge: challenge, resource: resource, expires: oauthClock() + 300}
	return key, nil
}

func (oauth *ingressOAuth) pairingCode() string {
	const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
	for {
		bytes := newUUID()
		buffer := make([]byte, 4)
		for i, b := range bytes[:4] {
			buffer[i] = alphabet[int(b)%len(alphabet)]
		}
		code := string(buffer)
		exists := false
		for _, pending := range oauth.pending {
			if pending.pairingCode == code {
				exists = true
				break
			}
		}
		if !exists {
			return code
		}
	}
}

func (oauth *ingressOAuth) clientName(id string) any {
	if client, ok := oauth.stored.Clients[id]; ok {
		return client.Name
	}
	return nil
}

func (oauth *ingressOAuth) status(key, resource string) object {
	if p := oauth.pending[key]; p != nil && p.resource == resource {
		status := "pending"
		switch {
		case p.expires <= oauthClock():
			status = "expired"
		case p.decision != nil && *p.decision:
			status = "approved"
		case p.decision != nil:
			status = "denied"
		}
		return object{"id": key, "pairingCode": p.pairingCode, "clientName": oauth.clientName(p.client), "clientId": p.client,
			"redirectUri": p.redirect, "resource": p.resource, "expiresAt": p.expires, "status": status}
	}
	for _, g := range oauth.stored.Grants {
		if g.ID == key && g.Resource == resource {
			return object{"id": key, "status": "completed", "clientName": oauth.clientName(g.Client), "resource": resource}
		}
	}
	return object{"id": key, "status": "expired"}
}

func (oauth *ingressOAuth) snapshot(ctx context.Context) (object, error) {
	pending, grants, clients := []any{}, []any{}, []any{}
	ids := oauthIDValues(oauth.grantIDs())
	for _, key := range oauth.pendingIDs() {
		status := oauth.status(key, oauth.stored.Resource)
		raw, err := oauth.authority(ctx, "for_grant", object{"ingress": oauth.ingressID(), "grant": key})
		if err == nil {
			source := obj(raw)
			status["sourceId"], status["product"], status["switchSourceId"] = source["id"], source["product"], source["switchSourceId"]
			if _, switching := source["switchSourceId"].(string); switching {
				status["sourceCandidates"] = []any{}
			} else {
				candidates, err := oauth.authority(ctx, "candidates", object{"source": source, "grants": ids})
				if err != nil {
					return nil, err
				}
				status["sourceCandidates"] = candidates
			}
		}
		pending = append(pending, status)
	}
	grantRows := slices.DeleteFunc(slices.Clone(oauth.stored.Grants), func(grant oauthGrant) bool { return !oauth.grantActive(ctx, grant.ID) })
	created := func(grant oauthGrant) int64 {
		if grant.ConnectedAt != nil {
			return *grant.ConnectedAt
		}
		if client, ok := oauth.stored.Clients[grant.Client]; ok {
			return client.Created
		}
		return -1 << 63
	}
	slices.SortStableFunc(grantRows, func(a, b oauthGrant) int {
		if created(a) > created(b) {
			return -1
		}
		if created(a) < created(b) {
			return 1
		}
		return 0
	})
	for _, g := range grantRows {
		var registered any
		if client, ok := oauth.stored.Clients[g.Client]; ok {
			registered = client.Created
		}
		grants = append(grants, object{"id": g.ID, "clientName": oauth.clientName(g.Client), "clientId": g.Client, "connectedAt": g.ConnectedAt, "registeredAt": registered})
	}
	clientIDs := make([]string, 0, len(oauth.stored.Clients))
	for id := range oauth.stored.Clients {
		clientIDs = append(clientIDs, id)
	}
	slices.Sort(clientIDs)
	for _, id := range clientIDs {
		c := oauth.stored.Clients[id]
		clients = append(clients, object{"id": id, "name": c.Name, "redirectUris": c.Redirects, "tokenEndpointAuthMethod": c.Method, "createdAt": c.Created})
	}
	return object{"pending": pending, "grants": grants, "clients": clients}, nil
}

func (oauth *ingressOAuth) decide(ctx context.Context, key string, allow bool, requested *string) error {
	raw, err := oauth.authority(ctx, "for_grant", object{"ingress": oauth.ingressID(), "grant": key})
	if err != nil {
		return err
	}
	source := obj(raw)
	p := oauth.pending[key]
	choice := ""
	if allow {
		switch {
		case requested != nil:
			choice = *requested
		case p != nil && p.sourceChoice != "":
			choice = p.sourceChoice
		case source["switchSourceId"] != nil:
			choice = text(source, "switchSourceId")
		default:
			candidates, err := oauth.authority(ctx, "candidates", object{"source": source, "grants": oauthIDValues(oauth.grantIDs())})
			if err != nil {
				return err
			}
			if len(arr(candidates)) != 0 {
				return errors.New("SOURCE_CHOICE_REQUIRED: choose sourceId=new or an existing source ID; use source claim")
			}
			choice = "new"
		}
		if _, err := oauth.authority(ctx, "validate_claim", object{"pending": source, "target": choice, "grants": oauthIDValues(oauth.grantIDs())}); err != nil {
			return err
		}
	}
	if p == nil || p.expires <= oauthClock() {
		return errors.New("Authorization request expired")
	}
	if p.decision != nil {
		if *p.decision == allow && p.sourceChoice == choice {
			return nil
		}
		return errors.New("Authorization request already decided")
	}
	p.sourceChoice, p.decision = choice, &allow
	if !allow {
		return oauth.revokeSources(ctx, []string{key})
	}
	p.code = oauthSecret()
	p.codeHash, p.expires = hash([]byte(p.code)), oauthClock()+60
	return nil
}

func oauthFormEscape(value string) string {
	encoded := url.QueryEscape(value)
	return strings.NewReplacer("%2A", "*", "~", "%7E").Replace(encoded)
}

func (oauth *ingressOAuth) resume(ctx context.Context, key, resource string) (string, error) {
	if err := oauth.prepare(ctx, resource); err != nil {
		return "", err
	}
	p := oauth.pending[key]
	if p == nil {
		return "", errors.New("Authorization request expired; reconnect from your client")
	}
	if p.expires <= oauthClock() {
		return "", errors.New("Authorization request expired")
	}
	if p.decision == nil {
		return "", nil
	}
	target, err := parseOAuthRedirect(p.redirect)
	if err != nil {
		return "", err
	}
	parts := []string{}
	if target.RawQuery != "" {
		parts = append(parts, target.RawQuery)
	}
	if *p.decision {
		if p.code == "" {
			return "", errors.New("Authorization response already delivered; reconnect from your client")
		}
		parts = append(parts, "code="+oauthFormEscape(p.code))
	} else {
		parts = append(parts, "error=access_denied")
	}
	if p.state != "" {
		parts = append(parts, "state="+oauthFormEscape(p.state))
	}
	parts = append(parts, "iss="+oauthFormEscape(oauthIssuer(resource)))
	target.RawQuery = strings.Join(parts, "&")
	return target.String(), nil
}

type oauthBasic struct{ id, secret string }

func (oauth *ingressOAuth) client(q map[string]string, basic *oauthBasic) (string, error) {
	key, supplied := q["client_id"], q["client_secret"]
	failure := errors.New("invalid_client")
	if basic != nil {
		if _, set := q["client_secret"]; set {
			return "", failure
		}
		if provided, set := q["client_id"]; set && provided != basic.id {
			return "", failure
		}
		key, supplied = basic.id, basic.secret
	}
	client, ok := oauth.stored.Clients[key]
	if !ok {
		return "", failure
	}
	valid := false
	switch client.Method {
	case "none":
		valid = basic == nil && supplied == ""
	case "client_secret_basic":
		valid = basic != nil && secureToken(hash([]byte(supplied)), client.SecretHash)
	case "client_secret_post":
		valid = basic == nil && secureToken(hash([]byte(supplied)), client.SecretHash)
	}
	if !valid {
		return "", failure
	}
	return key, nil
}

func (oauth *ingressOAuth) revokeWhere(ctx context.Context, remove func(oauthGrant) bool) error {
	removed := []string{}
	for _, g := range oauth.stored.Grants {
		if remove(g) {
			removed = append(removed, g.ID)
		}
	}
	if err := oauth.revokeSources(ctx, removed); err != nil {
		return err
	}
	oauth.stored.Grants = slices.DeleteFunc(oauth.stored.Grants, remove)
	return oauth.persist()
}

func (oauth *ingressOAuth) exchangeCode(ctx context.Context, q map[string]string, client, resource, access, refresh string) error {
	codeHash := hash([]byte(q["code"]))
	replay := func(g oauthGrant) bool { return g.Client == client && g.AuthorizationCode == codeHash }
	if slices.ContainsFunc(oauth.stored.Grants, replay) {
		if err := oauth.revokeWhere(ctx, replay); err != nil {
			return err
		}
		return errors.New("invalid_grant")
	}
	var key string
	var p *oauthPending
	for _, id := range oauth.pendingIDs() {
		current := oauth.pending[id]
		if current.codeHash == codeHash && current.decision != nil && *current.decision && current.expires > oauthClock() {
			key, p = id, current
			break
		}
	}
	verifier := q["code_verifier"]
	digest := sha256.Sum256([]byte(verifier))
	if p == nil || p.client != client || p.resource != resource || p.redirect != q["redirect_uri"] || len(verifier) < 43 || len(verifier) > 128 ||
		strings.ContainsFunc(verifier, func(c rune) bool { return !oauthASCIIAlphanumeric(c) && !strings.ContainsRune("-._~", c) }) ||
		!secureToken(base64.RawURLEncoding.EncodeToString(digest[:]), p.challenge) {
		return errors.New("invalid_grant")
	}
	if len(oauth.stored.Grants) >= 128 {
		return errors.New("temporarily_unavailable")
	}
	old, err := oauth.authority(ctx, "connect", object{"ingress": oauth.ingressID(), "grant": key, "target": p.sourceChoice, "grants": oauthIDValues(oauth.grantIDs())})
	if err != nil {
		return err
	}
	if replaced, ok := old.(string); ok {
		oauth.stored.Grants = slices.DeleteFunc(oauth.stored.Grants, func(g oauthGrant) bool { return g.ID == replaced })
	}
	delete(oauth.pending, key)
	at := oauthClock()
	oauth.stored.Grants = append(oauth.stored.Grants, oauthGrant{key, &at, client, resource, codeHash, hash([]byte(access)), at + oauthAccessTTL, hash([]byte(refresh)), []string{}})
	return nil
}

func (oauth *ingressOAuth) exchangeRefresh(ctx context.Context, q map[string]string, client, resource, access, refresh string) error {
	digest := hash([]byte(q["refresh_token"]))
	for _, g := range oauth.stored.Grants {
		if g.Client == client && slices.Contains(g.UsedRefresh, digest) {
			if err := oauth.revokeWhere(ctx, func(value oauthGrant) bool { return value.ID == g.ID }); err != nil {
				return err
			}
			return errors.New("invalid_grant")
		}
	}
	for i := range oauth.stored.Grants {
		g := &oauth.stored.Grants[i]
		if g.Client == client && g.Resource == resource && secureToken(g.Refresh, digest) {
			g.UsedRefresh = append(g.UsedRefresh, g.Refresh)
			g.Refresh, g.Access, g.AccessExpires = hash([]byte(refresh)), hash([]byte(access)), oauthClock()+oauthAccessTTL
			return nil
		}
	}
	return errors.New("invalid_grant")
}

func (oauth *ingressOAuth) token(ctx context.Context, q map[string]string, basic *oauthBasic, resource string) (object, error) {
	if err := oauth.prepare(ctx, resource); err != nil {
		return nil, err
	}
	client, err := oauth.client(q, basic)
	if err != nil {
		return nil, err
	}
	if q["resource"] != resource {
		return nil, errors.New("invalid_target")
	}
	if q["scope"] != "" && q["scope"] != "mcp" {
		return nil, errors.New("invalid_scope")
	}
	access, refresh := oauthSecret(), oauthSecret()
	switch q["grant_type"] {
	case "authorization_code":
		err = oauth.exchangeCode(ctx, q, client, resource, access, refresh)
	case "refresh_token":
		err = oauth.exchangeRefresh(ctx, q, client, resource, access, refresh)
	default:
		return nil, errors.New("unsupported_grant_type")
	}
	if err != nil {
		return nil, err
	}
	if err := oauth.persist(); err != nil {
		return nil, err
	}
	expires := int64(oauthAccessTTL)
	for _, g := range oauth.stored.Grants {
		if g.Access == hash([]byte(access)) {
			expires = g.AccessExpires - oauthClock()
			break
		}
	}
	return object{"access_token": access, "token_type": "Bearer", "expires_in": expires, "refresh_token": refresh, "scope": "mcp"}, nil
}

func (oauth *ingressOAuth) removeClient(ctx context.Context, client string) error {
	ids := []string{}
	for _, g := range oauth.stored.Grants {
		if g.Client == client {
			ids = append(ids, g.ID)
		}
	}
	for _, key := range oauth.pendingIDs() {
		if oauth.pending[key].client == client {
			ids = append(ids, key)
		}
	}
	if err := oauth.revokeSources(ctx, ids); err != nil {
		return err
	}
	delete(oauth.stored.Clients, client)
	oauth.stored.Grants = slices.DeleteFunc(oauth.stored.Grants, func(g oauthGrant) bool { return g.Client == client })
	for key, p := range oauth.pending {
		if p.client == client {
			delete(oauth.pending, key)
		}
	}
	return oauth.persist()
}

func (oauth *ingressOAuth) revoke(ctx context.Context, grant string) error {
	if err := oauth.revokeSources(ctx, []string{grant}); err != nil {
		return err
	}
	delete(oauth.pending, grant)
	oauth.stored.Grants = slices.DeleteFunc(oauth.stored.Grants, func(g oauthGrant) bool { return g.ID == grant })
	return oauth.persist()
}

func (oauth *ingressOAuth) revokeToken(ctx context.Context, q map[string]string, basic *oauthBasic, resource string) error {
	if err := oauth.prepare(ctx, resource); err != nil {
		return err
	}
	client, err := oauth.client(q, basic)
	if err != nil {
		return err
	}
	token, ok := q["token"]
	if !ok {
		return errors.New("invalid_request")
	}
	digest := hash([]byte(token))
	return oauth.revokeWhere(ctx, func(g oauthGrant) bool {
		return g.Client == client && (secureToken(g.Refresh, digest) || secureToken(g.Access, digest) || slices.Contains(g.UsedRefresh, digest))
	})
}

func oauthIssuer(resource string) string {
	for strings.HasSuffix(resource, "/mcp") {
		resource = strings.TrimSuffix(resource, "/mcp")
	}
	return resource
}

func oauthParameters(raw string) (map[string]string, error) {
	if len(raw) > 16384 {
		return nil, errors.New("invalid_request")
	}
	raw, _, _ = strings.Cut(raw, "#")
	raw = strings.NewReplacer("\t", "", "\r", "", "\n", "").Replace(raw)
	out := map[string]string{}
	for _, pair := range strings.Split(raw, "&") {
		if pair == "" {
			continue
		}
		key, value, _ := strings.Cut(pair, "=")
		key, value = oauthFormDecode(key), oauthFormDecode(value)
		if _, exists := out[key]; exists {
			return nil, errors.New("invalid_request")
		}
		out[key] = value
	}
	return out, nil
}

func oauthFormDecode(raw string) string {
	var value strings.Builder
	value.Grow(len(raw))
	hex := func(c byte) (byte, bool) {
		switch {
		case c >= '0' && c <= '9':
			return c - '0', true
		case c >= 'A' && c <= 'F':
			return c - 'A' + 10, true
		case c >= 'a' && c <= 'f':
			return c - 'a' + 10, true
		default:
			return 0, false
		}
	}
	for i := 0; i < len(raw); i++ {
		switch raw[i] {
		case '+':
			value.WriteByte(' ')
			continue
		case '%':
			if i+2 < len(raw) {
				a, aOK := hex(raw[i+1])
				b, bOK := hex(raw[i+2])
				if aOK && bOK {
					value.WriteByte(a<<4 | b)
					i += 2
					continue
				}
			}
		}
		value.WriteByte(raw[i])
	}
	return strings.ToValidUTF8(value.String(), "�")
}

func oauthAuthentication(header string, present bool) (*oauthBasic, error) {
	if !present {
		return nil, nil
	}
	invalid := errors.New("invalid_client")
	value, ok := strings.CutPrefix(header, "Basic ")
	if !ok {
		return nil, invalid
	}
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil || !utf8.Valid(data) {
		return nil, invalid
	}
	client, secret, ok := strings.Cut(string(data), ":")
	if !ok {
		return nil, invalid
	}
	decoded, err := oauthParameters("id=" + client + "&secret=" + secret)
	if err != nil {
		return nil, err
	}
	if len(decoded) != 2 {
		return nil, invalid
	}
	return &oauthBasic{decoded["id"], decoded["secret"]}, nil
}

type oauthHTTPReply struct {
	status  int
	headers http.Header
	body    []byte
}

func oauthJSON(status int, value any) oauthHTTPReply {
	return oauthHTTPReply{status, http.Header{"Content-Type": {"application/json"}, "Cache-Control": {"no-store"}, "Pragma": {"no-cache"}}, []byte(wire(value))}
}

func oauthAsset(file, contentType string) oauthHTTPReply {
	var content []byte
	var err error
	switch file {
	case "128x128@2x.png":
		content, err = icons.OAuthAssets.ReadFile(file)
	case "tokens.css", "assets/arc/favicon.ico":
		content, err = ui.OAuthAssets.ReadFile(file)
	default:
		content, err = coreAssets.Files.ReadFile(file)
	}
	if err != nil {
		panic(err)
	}
	headers := http.Header{"Content-Type": {contentType}, "X-Content-Type-Options": {"nosniff"}, "Cache-Control": {"no-cache"}}
	return oauthHTTPReply{200, headers, content}
}

func oauthConsentPage() oauthHTTPReply {
	reply := oauthAsset("oauth-page.html", "text/html; charset=utf-8")
	reply.headers.Set("Cache-Control", "no-store")
	reply.headers.Set("Referrer-Policy", "no-referrer")
	reply.headers.Set("X-Frame-Options", "DENY")
	reply.headers.Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	return reply
}

func oauthRedirect(location string) oauthHTTPReply {
	return oauthHTTPReply{303, http.Header{"Location": {location}, "Cache-Control": {"no-store"}, "Referrer-Policy": {"no-referrer"}}, nil}
}

type oauthHTTPContext struct {
	connectionName any
	observeRequest func(context.Context, string) error
	observeClient  func(string)
	observeFields  func(string, string, any)
	audit          func(string, string)
}

func (observe oauthHTTPContext) request(ctx context.Context) error {
	if observe.observeRequest == nil {
		return nil
	}
	return observe.observeRequest(ctx, "firstOAuthRequestAt")
}

func (oauth *ingressOAuth) writeHTTP(w http.ResponseWriter, r *http.Request, resource string, observe oauthHTTPContext) {
	path := r.URL.Path
	formEndpoint := slices.Contains([]string{"/oauth/register", "/oauth/token", "/oauth/revoke"}, path)
	cors := formEndpoint || strings.HasPrefix(path, "/.well-known/")
	_, hasAuth := r.Header["Authorization"]
	var reply oauthHTTPReply
	var failure error
	if cors && r.Method == http.MethodOptions {
		reply = oauthJSON(204, nil)
	} else {
		reply, failure = oauth.httpRoute(w, r, resource, observe, formEndpoint)
	}
	var auditError string
	if failure != nil {
		code := failure.Error()
		if !slices.Contains([]string{"invalid_request", "invalid_client", "invalid_client_metadata", "invalid_redirect_uri", "unsupported_response_type",
			"invalid_target", "invalid_scope", "temporarily_unavailable", "invalid_grant", "unsupported_grant_type"}, code) {
			code = "server_error"
		}
		auditError = code
		status := 400
		switch {
		case code == "invalid_client" && hasAuth:
			status = 401
		case code == "temporarily_unavailable":
			status = 429
		case code == "server_error":
			status = 500
		}
		reply = oauthJSON(status, object{"error": code})
		if status == 401 {
			reply.headers.Set("WWW-Authenticate", `Basic realm="oauth"`)
		}
	}
	if observe.audit != nil && (formEndpoint || path == "/oauth/authorize") {
		message := fmt.Sprintf("OAuth %s: HTTP %d", path, reply.status)
		if path == "/oauth/register" && reply.status == 400 {
			fieldName, detail := "request", ""
			var metadata *oauthRegistrationError
			if errors.As(failure, &metadata) {
				if metadata.field != "" {
					fieldName = metadata.field
				}
				detail = metadata.detail
			}
			message += " error=" + auditError + " fields=" + fieldName
			if detail != "" {
				message += " detail=" + detail
			}
		}
		level := "INFO"
		if reply.status >= 400 {
			level = "WARN"
		}
		observe.audit(level, message)
	}
	if cors {
		reply.headers.Set("Access-Control-Allow-Origin", "*")
		reply.headers.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		reply.headers.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		reply.headers.Set("Access-Control-Expose-Headers", "WWW-Authenticate")
	}
	for key, values := range reply.headers {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(reply.status)
	if reply.status != http.StatusNoContent {
		_, _ = w.Write(reply.body)
	}
}

func (oauth *ingressOAuth) httpRoute(w http.ResponseWriter, r *http.Request, resource string, observe oauthHTTPContext, formEndpoint bool) (oauthHTTPReply, error) {
	invalid := errors.New("invalid_request")
	if r.Method == http.MethodGet {
		q, err := oauthParameters(r.URL.RawQuery)
		if err != nil {
			return oauthHTTPReply{}, err
		}
		return oauth.httpReadRoute(r.Context(), r.URL.Path, q, resource, observe)
	}
	if r.Method != http.MethodPost {
		return oauthJSON(405, object{"error": "invalid_request"}), nil
	}
	if !formEndpoint {
		return oauthJSON(404, object{"error": "not_found"}), nil
	}
	_, hasAuth := r.Header["Authorization"]
	basic, err := oauthAuthentication(r.Header.Get("Authorization"), hasAuth)
	if err != nil {
		return oauthHTTPReply{}, err
	}
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(10 * time.Second))
	data, err := io.ReadAll(io.LimitReader(r.Body, 16385))
	_ = controller.SetReadDeadline(time.Time{})
	if err != nil || len(data) > 16384 {
		return oauthHTTPReply{}, invalid
	}
	content, _, _ := strings.Cut(r.Header.Get("Content-Type"), ";")
	content = strings.TrimSpace(content)
	ctx := r.Context()
	path := r.URL.Path
	if path == "/oauth/register" {
		if content != "application/json" {
			return oauthHTTPReply{}, &oauthRegistrationError{"invalid_request", "content-type", ""}
		}
		var metadata any
		if canonjson.Unmarshal(data, &metadata) != nil {
			return oauthHTTPReply{}, &oauthRegistrationError{"invalid_request", "body", ""}
		}
		oauth.mu.Lock()
		registered, err := oauth.register(ctx, metadata, resource)
		oauth.mu.Unlock()
		if err == nil && observe.observeClient != nil {
			observe.observeClient(text(registered, "client_id"))
		}
		if observe.observeFields != nil {
			observe.observeFields(path, "body", metadata)
		}
		if err != nil {
			return oauthHTTPReply{}, err
		}
		if err := observe.request(ctx); err != nil {
			return oauthHTTPReply{}, err
		}
		return oauthJSON(201, registered), nil
	}
	if content != "application/x-www-form-urlencoded" || !utf8.Valid(data) {
		return oauthHTTPReply{}, invalid
	}
	q, err := oauthParameters(string(data))
	if err != nil {
		return oauthHTTPReply{}, err
	}
	if observe.observeClient != nil {
		client := q["client_id"]
		if basic != nil {
			client = basic.id
		}
		observe.observeClient(client)
	}
	if observe.observeFields != nil {
		observe.observeFields(path, "body", oauthFieldValues(q))
	}
	oauth.mu.Lock()
	defer oauth.mu.Unlock()
	if path == "/oauth/revoke" {
		if err := oauth.revokeToken(ctx, q, basic, resource); err != nil {
			return oauthHTTPReply{}, err
		}
		return oauthJSON(200, object{}), nil
	}
	token, err := oauth.token(ctx, q, basic, resource)
	if err != nil {
		return oauthHTTPReply{}, err
	}
	return oauthJSON(200, token), nil
}

func oauthFieldValues(q map[string]string) object {
	value := make(object, len(q))
	for key, item := range q {
		value[key] = item
	}
	return value
}

func (oauth *ingressOAuth) httpReadRoute(ctx context.Context, path string, q map[string]string, resource string, observe oauthHTTPContext) (oauthHTTPReply, error) {
	issuer := oauthIssuer(resource)
	if path == "/oauth/authorize" && observe.observeClient != nil {
		observe.observeClient(q["client_id"])
	}
	if observe.observeFields != nil {
		observe.observeFields(path, "query", oauthFieldValues(q))
	}
	switch path {
	case "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp":
		return oauthJSON(200, object{"resource": resource, "authorization_servers": []string{issuer}, "scopes_supported": []string{"mcp"}, "bearer_methods_supported": []string{"header"}}), nil
	case "/.well-known/oauth-authorization-server":
		auth := []string{"none", "client_secret_basic", "client_secret_post"}
		return oauthJSON(200, object{"issuer": issuer, "authorization_endpoint": issuer + "/oauth/authorize", "token_endpoint": issuer + "/oauth/token",
			"registration_endpoint": issuer + "/oauth/register", "revocation_endpoint": issuer + "/oauth/revoke",
			"response_types_supported": []string{"code"}, "grant_types_supported": []string{"authorization_code", "refresh_token"},
			"code_challenge_methods_supported": []string{"S256"}, "token_endpoint_auth_methods_supported": auth,
			"revocation_endpoint_auth_methods_supported": auth, "scopes_supported": []string{"mcp"}, "authorization_response_iss_parameter_supported": true}), nil
	case "/oauth/authorize":
		oauth.mu.Lock()
		key, err := oauth.authorize(ctx, q, resource)
		oauth.mu.Unlock()
		if err != nil {
			return oauthHTTPReply{}, err
		}
		if err := observe.request(ctx); err != nil {
			return oauthHTTPReply{}, err
		}
		return oauthRedirect(issuer + "/oauth/resume?request=" + key), nil
	case "/oauth/resume":
		return oauthConsentPage(), nil
	case "/oauth/page.js":
		return oauthAsset("oauth-page.js", "text/javascript; charset=utf-8"), nil
	case "/oauth/tokens.css":
		return oauthAsset("tokens.css", "text/css; charset=utf-8"), nil
	case "/oauth/logo.png":
		return oauthAsset("128x128@2x.png", "image/png"), nil
	case "/oauth/favicon.ico":
		return oauthAsset("assets/arc/favicon.ico", "image/x-icon"), nil
	case "/oauth/status", "/oauth/continue":
		key, ok := q["request"]
		if !ok {
			return oauthHTTPReply{}, errors.New("invalid_request")
		}
		oauth.mu.Lock()
		defer oauth.mu.Unlock()
		if path == "/oauth/continue" {
			location, err := oauth.resume(ctx, key, resource)
			if err == nil && location != "" {
				return oauthRedirect(location), nil
			}
			return oauthConsentPage(), nil
		}
		if err := oauth.prepare(ctx, resource); err != nil {
			return oauthHTTPReply{}, err
		}
		state := oauth.status(key, resource)
		state["openAppUrl"], state["connectionName"] = "agent-remote-control://oauth?request="+key, observe.connectionName
		return oauthJSON(200, state), nil
	default:
		return oauthJSON(404, object{"error": "not_found"}), nil
	}
}

// Segment E supplies the live ingress owner and its operation exclusion.
var gatewayOAuthIngress func(context.Context, *gatewayOwner, string) (*ingressOAuth, string, func(), error)

func gatewayOAuthManagement(ctx context.Context, owner *gatewayOwner, id, action, method string, body object) (any, error) {
	oauth, resource, release, err := gatewayOAuthIngress(ctx, owner, id)
	if err != nil {
		return nil, err
	}
	if release != nil {
		defer release()
	}
	oauth.mu.Lock()
	defer oauth.mu.Unlock()
	if resource == "" {
		resource = oauth.stored.Resource
	}
	if resource == "" {
		return nil, errors.New("Start this connection before managing OAuth")
	}
	parsed, err := parseOAuthRedirect(resource)
	if err != nil {
		return nil, errors.New("Invalid OAuth resource URL")
	}
	resource = parsed.String()
	switch {
	case method == "GET" && action == "":
		if err := oauth.prepare(ctx, resource); err != nil {
			return nil, err
		}
		return oauth.snapshot(ctx)
	case method == "GET" && strings.HasPrefix(action, "request/"):
		if err := oauth.prepare(ctx, resource); err != nil {
			return nil, err
		}
		if _, err := oauth.snapshot(ctx); err != nil {
			return nil, err
		}
		return oauth.status(strings.TrimPrefix(action, "request/"), resource), nil
	case method == "POST" && action == "decision":
		if err := oauth.prepare(ctx, resource); err != nil {
			return nil, err
		}
		if _, err := oauth.snapshot(ctx); err != nil {
			return nil, err
		}
		allow, ok := body["allow"].(bool)
		if !ok {
			return nil, errors.New("allow must be boolean")
		}
		var choice *string
		if value, ok := body["sourceId"].(string); ok {
			choice = &value
		}
		key := text(body, "id")
		if err := oauth.decide(ctx, key, allow, choice); err != nil {
			return nil, err
		}
		return oauth.status(key, resource), nil
	case method == "POST" && action == "client/remove":
		return object{"removed": true}, oauth.removeClient(ctx, text(body, "id"))
	case method == "POST" && action == "revoke":
		return object{"ok": true}, oauth.revoke(ctx, text(body, "id"))
	case method == "POST" && action == "register":
		return oauth.register(ctx, body, resource)
	}
	return nil, errors.New("UNKNOWN_ROUTE")
}

func init() {
	manageSourceOAuth = func(ctx context.Context, owner *gatewayOwner, id, action string, body object) (any, error) {
		switch action {
		case "revoke":
			return gatewayOAuthManagement(ctx, owner, id, "revoke", "POST", object{"id": body["grantId"]})
		case "decision":
			return gatewayOAuthManagement(ctx, owner, id, "decision", "POST", object{"id": body["requestId"], "allow": body["approved"], "sourceId": body["sourceId"]})
		}
		return nil, errors.New("UNKNOWN_ROUTE")
	}
	for _, route := range []struct{ method, pattern string }{
		{"GET", "ingress/([^/]+)/oauth"},
		{"GET", "ingress/([^/]+)/oauth/(request/[^/]+)"},
		{"POST", "ingress/([^/]+)/oauth/(decision|client/remove|revoke|register)"},
	} {
		registerGatewayRoute(route.method, route.pattern, func(ctx context.Context, owner *gatewayOwner, body object, params []string) (any, error) {
			action := ""
			if len(params) > 1 {
				action = params[1]
			}
			return gatewayOAuthManagement(ctx, owner, params[0], action, route.method, body)
		})
		registerRoutePattern(route.method, route.pattern, func(ctx context.Context, _ *service, body object, params []string) (any, error) {
			path := "ingress/" + params[0] + "/oauth"
			if len(params) > 1 {
				path += "/" + params[1]
			}
			return gatewayRequest(ctx, path, route.method, body)
		})
	}
}
