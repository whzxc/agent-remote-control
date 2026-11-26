package core

import (
	"context"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/canonjson"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

type accountIndex struct {
	mu    sync.Mutex
	path  string
	stamp *fileStamp
	rows  []any
}

var accountsIndex accountIndex
var accountsWriter sync.Mutex

func accountIndexPath() string { return filepath.Join(root(), "accounts/index.json") }

func (index *accountIndex) read(path string) ([]any, error) {
	index.mu.Lock()
	defer index.mu.Unlock()
	stamp, err := readStamp(path)
	if err != nil {
		return nil, err
	}
	if index.path == path && stampSame(index.stamp, stamp) {
		return index.rows, nil
	}
	rows := []any{}
	size := 0
	if stamp != nil {
		bytes, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		var value any
		if err := canonjson.Unmarshal(bytes, &value); err != nil {
			return nil, err
		}
		var ok bool
		if rows, ok = value.([]any); !ok {
			return nil, errors.New("ACCOUNTS_INVALID: expected an array")
		}
		size = len(bytes)
	}
	old, current := make(map[string]any, len(index.rows)), make(map[string]any, len(rows))
	for _, row := range index.rows {
		old[text(row, "id")] = row
	}
	for _, row := range rows {
		current[text(row, "id")] = row
	}
	changed := 0
	for key, row := range current {
		if !reflect.DeepEqual(old[key], row) {
			changed++
		}
	}
	for key := range old {
		if _, ok := current[key]; !ok {
			changed++
		}
	}
	visited := len(rows)
	if stamp != nil {
		visited++
	}
	recordFileCost(fileCost{Path: path, Rows: visited, BytesRead: size, BytesParsed: size, Changed: changed, CacheMisses: 1})
	recordRuntimeWork(context.Background(), runtimeWorkCost{Owner: "accounts", Reason: "dirty", ScanSet: len(rows)})
	after, err := readStamp(path)
	if err != nil {
		return nil, err
	}
	if stampSame(stamp, after) {
		index.path, index.stamp, index.rows = path, stamp, rows
	}
	return rows, nil
}

func readAccounts() ([]any, error) { return accountsIndex.read(accountIndexPath()) }

func changeAccounts[T any](modify func(*[]any) (T, error)) (T, error) {
	accountsWriter.Lock()
	defer accountsWriter.Unlock()
	return changeAccountsLocked(modify)
}

func changeAccountsLocked[T any](modify func(*[]any) (T, error)) (T, error) {
	var empty T
	original, err := readAccounts()
	if err != nil {
		return empty, err
	}
	rows := make([]any, len(original))
	for i, row := range original {
		rows[i] = clone(obj(row))
	}
	value, err := modify(&rows)
	if err != nil {
		return empty, err
	}
	if !reflect.DeepEqual(rows, original) {
		if err := save(accountIndexPath(), rows); err != nil {
			return empty, err
		}
	}
	return value, nil
}

func lowerProviderText(value string) string { return cases.Lower(language.Und).String(value) }

func accountIdentityKey(provider string, facts any) string {
	if id := strings.TrimSpace(text(facts, "accountId")); id != "" {
		return provider + ":id:" + id
	}
	email := lowerProviderText(strings.TrimSpace(text(facts, "email")))
	if email == "" {
		return ""
	}
	org, ok := field(facts, "orgId").(string)
	if !ok {
		org = text(facts, "orgName")
	}
	org = lowerProviderText(strings.TrimSpace(org))
	return provider + ":email:" + hash([]byte(email+"\n"+org))
}

func confirmAccountReauth(account any, provider string, facts any) error {
	key := accountIdentityKey(provider, facts)
	if liveAccount(account) && key != "" && (strings.Contains(text(account, "identityKey"), ":unidentified:") || accountMatchesIdentity(account, key)) {
		return nil
	}
	return errors.New("ACCOUNT_REAUTH_IDENTITY_MISMATCH: Sign in to the original account or add a separate account")
}

func accountProvider(platform string) string {
	switch platform {
	case "claude", "anthropic":
		return "anthropic"
	case "chatgpt", "codex", "openai":
		return "openai"
	case "dsh", "deepseek":
		return "deepseek"
	case "gemini", "antigravity", "google":
		return "google"
	case "grok", "grok-bot", "xai":
		return "xai"
	case "", "custom":
		return "other"
	default:
		return platform
	}
}

func firstAccountFact(facts any, names ...string) any {
	for _, name := range names {
		if value, ok := obj(facts)[name]; ok {
			return value
		}
	}
	return nil
}

func newProviderAccount(id, provider, key string, facts any) object {
	alias, ok := field(facts, "orgName").(string)
	if !ok {
		alias = "Personal"
	}
	if strings.Contains(key, ":unidentified:") {
		alias = "Unidentified"
	}
	return object{"id": id, "provider": provider, "identityKey": key, "alias": alias,
		"email": field(facts, "email"), "orgName": field(facts, "orgName"), "plan": firstAccountFact(facts, "planType", "subscriptionType", "plan"),
		"createdAt": now(), "observedAt": now(), "sources": []any{}, "agentProfiles": []any{},
		"quota": object{"state": "unavailable", "windows": []any{}}, "notifications": object{"state": "n/a", "sessions": []any{}}}
}

func liveAccount(value any) bool      { return field(value, "removedAt") == nil }
func accountProfiles(value any) []any { return arr(field(value, "agentProfiles")) }
func sameAccountProfile(a, b any) bool {
	return text(a, "agent") == text(b, "agent") && text(a, "profileId") == text(b, "profileId")
}
func ownsAccountProfile(value, profile any) bool {
	return slices.ContainsFunc(accountProfiles(value), func(p any) bool { return sameAccountProfile(p, profile) })
}
func ownsAccountSource(value any, source string) bool {
	return slices.Contains(arr(field(value, "sources")), any(source))
}
func accountIdentities(value object) object {
	identities := obj(value["sourceIdentities"])
	if identities == nil {
		identities = object{}
		value["sourceIdentities"] = identities
	}
	return identities
}

func moveAccountMembership(from, to object, profile object, source string, changed bool) {
	var movedSources, keptSources, movedProfiles, keptProfiles []any
	for _, item := range arr(from["sources"]) {
		if !changed || source != "" && item == source {
			movedSources = append(movedSources, item)
		} else {
			keptSources = append(keptSources, item)
		}
	}
	for _, item := range accountProfiles(from) {
		if !changed || profile != nil && sameAccountProfile(item, profile) {
			movedProfiles = append(movedProfiles, item)
		} else {
			keptProfiles = append(keptProfiles, item)
		}
	}
	from["sources"], from["agentProfiles"] = append([]any{}, keptSources...), append([]any{}, keptProfiles...)
	for _, item := range movedSources {
		if key, ok := item.(string); ok {
			if evidence, ok := obj(from["sourceIdentities"])[key]; ok {
				accountIdentities(to)[key] = evidence
				delete(obj(from["sourceIdentities"]), key)
			}
		}
		if !slices.Contains(arr(to["sources"]), item) {
			to["sources"] = append(arr(to["sources"]), item)
		}
	}
	for _, item := range movedProfiles {
		if !ownsAccountProfile(to, item) {
			to["agentProfiles"] = append(accountProfiles(to), item)
		}
	}
	if len(keptSources) == 0 && len(keptProfiles) == 0 {
		from["removedAt"] = now()
		if !changed {
			from["mergedInto"] = to["id"]
		}
	}
}

func observeAccount(rows *[]any, provider string, facts any, anchor string, profile object, source string) string {
	first := profile != nil && !slices.ContainsFunc(*rows, func(row any) bool {
		return slices.ContainsFunc(accountProfiles(row), func(p any) bool { return text(p, "agent") == text(profile, "agent") })
	})
	owns := func(row any) bool {
		return source != "" && ownsAccountSource(row, source) || profile != nil && ownsAccountProfile(row, profile)
	}
	oldIndex := slices.IndexFunc(*rows, func(row any) bool { return liveAccount(row) && owns(row) })
	var old object
	if oldIndex >= 0 {
		old = obj((*rows)[oldIndex])
	}
	if old == nil {
		tombstone := slices.IndexFunc(*rows, func(row any) bool { return !liveAccount(row) && field(row, "mergedInto") == nil && owns(row) })
		if tombstone >= 0 {
			return text((*rows)[tombstone], "id")
		}
	}

	confirmed := accountIdentityKey(provider, facts)
	key := confirmed
	if key == "" {
		key = text(old, "identityKey")
	}
	if key == "" {
		key = provider + ":unidentified:" + anchor
	}
	changed := old != nil && confirmed != "" && !strings.Contains(text(old, "identityKey"), ":unidentified:") && !accountMatchesIdentity(old, key)
	index := slices.IndexFunc(*rows, func(row any) bool { return liveAccount(row) && accountMatchesIdentity(row, key) })
	if index < 0 && !changed {
		index = oldIndex
	}
	if index < 0 {
		stable := anchor
		if _, err := uuid.Parse(anchor); err != nil || find(*rows, "id", anchor) != nil {
			stable = id()
		}
		row := newProviderAccount(stable, provider, key, facts)
		if source == "" && row["alias"] == "Unidentified" {
			row["alias"] = "Personal"
		}
		index = len(*rows)
		*rows = append(*rows, row)
	}
	row := obj((*rows)[index])
	if old != nil && oldIndex != index {
		moveAccountMembership(old, row, profile, source, changed)
	}
	before := maps.Clone(row)
	if !accountMatchesIdentity(row, key) {
		row["identityKey"] = key
	}
	if row["provider"] == "other" && provider != "other" {
		row["provider"] = provider
	}
	for target, names := range map[string][]string{"email": {"email"}, "orgName": {"orgName"}, "plan": {"planType", "subscriptionType", "plan"}} {
		for _, name := range names {
			if value, ok := field(facts, name).(string); ok {
				row[target] = value
				break
			}
		}
	}
	if row["alias"] == "Unidentified" && confirmed != "" {
		alias, ok := field(facts, "orgName").(string)
		if !ok {
			alias = "Personal"
		}
		row["alias"] = alias
	}
	if source != "" && !ownsAccountSource(row, source) {
		row["sources"] = append(arr(row["sources"]), source)
	}
	if profile != nil {
		list := slices.Clone(accountProfiles(row))
		index := slices.IndexFunc(list, func(previous any) bool { return sameAccountProfile(previous, profile) })
		if index < 0 {
			profile["default"] = first
			list = append(list, profile)
		} else {
			profile["default"] = field(list[index], "default")
			list[index] = profile
		}
		row["agentProfiles"] = list
	}
	if !reflect.DeepEqual(row, before) {
		row["observedAt"] = now()
	}
	return text(row, "id")
}

func accountDefaults(rows []any) {
	seen := make(map[string]bool)
	for _, row := range rows {
		if !liveAccount(row) {
			continue
		}
		for _, profile := range accountProfiles(row) {
			if field(profile, "default") != true {
				continue
			}
			agent := text(profile, "agent")
			if seen[agent] {
				obj(profile)["default"] = false
			}
			seen[agent] = true
		}
	}
}

func isBuiltinLocalSource(source any) bool {
	return field(source, "ingressId") == "local-cli" && field(field(source, "credential"), "type") == "local"
}

func retireLocalAccountMembership(rows, sources []any, at string) {
	local := []any{}
	for _, source := range sources {
		if isBuiltinLocalSource(source) {
			local = append(local, field(source, "id"))
		}
	}
	for _, value := range rows {
		row := obj(value)
		before := arr(row["sources"])
		members := slices.DeleteFunc(slices.Clone(before), func(m any) bool { return slices.Contains(local, m) })
		if len(before) == len(members) {
			continue
		}
		row["sources"] = members
		for _, id := range local {
			delete(obj(row["sourceIdentities"]), str(id))
		}
		if len(members) == 0 && len(accountProfiles(row)) == 0 && liveAccount(row) {
			row["removedAt"] = at
		}
	}
}

func resolveAccountRows(rows []any, reference string) (object, error) {
	canonical, err := canonicalAccount(rows, reference)
	if err != nil {
		return nil, err
	}
	if row := find(rows, "id", canonical); row != nil {
		result := clone(row)
		history := []any{}
		for _, previous := range rows {
			if id := text(previous, "id"); id != canonical {
				if target, _ := canonicalAccount(rows, id); target == canonical {
					history = append(history, id)
				}
			}
		}
		result["mergedAccountIds"] = history
		return result, nil
	}
	var match object
	for _, row := range rows {
		if liveAccount(row) && field(row, "alias") == reference {
			if match != nil {
				return nil, errors.New("ACCOUNT_ALIAS_AMBIGUOUS: Use an account ID from query accounts")
			}
			match = obj(row)
		}
	}
	if match == nil {
		return nil, errors.New("ACCOUNT_NOT_FOUND: Read query accounts and use an account ID")
	}
	return clone(match), nil
}

func resolveAccount(reference string) (object, error) {
	rows, err := readAccounts()
	if err != nil {
		return nil, err
	}
	return resolveAccountRows(rows, reference)
}

func ownerOfAccountProfile(rows []any, profile string) object {
	for _, row := range rows {
		if liveAccount(row) && slices.ContainsFunc(accountProfiles(row), func(p any) bool { return field(p, "profileId") == profile }) {
			return obj(row)
		}
	}
	return nil
}

func selectSignedInClaudeProfile(rows, observations []any) string {
	var selected string
	var preferred bool
	var observed time.Time
	for _, row := range rows {
		if !liveAccount(row) {
			continue
		}
		for _, profile := range accountProfiles(row) {
			if field(profile, "agent") != "claude" || field(profile, "state") != "signed-in" {
				continue
			}
			profileID := text(profile, "profileId")
			if profileID == "" {
				continue
			}
			at, ok := field(find(observations, "profileId", profileID), "observedAt").(string)
			if !ok {
				at = text(row, "observedAt")
			}
			when, _ := time.Parse(time.RFC3339Nano, at)
			isDefault := field(profile, "default") == true
			if selected == "" || isDefault && !preferred || isDefault == preferred && (when.After(observed) || when.Equal(observed) && profileID > selected) {
				selected, preferred, observed = profileID, isDefault, when
			}
		}
	}
	return selected
}

func validAccountAlias(value any) bool {
	alias, ok := value.(string)
	return ok && strings.TrimSpace(alias) != "" && len(alias) <= 120 && !strings.ContainsFunc(alias, unicode.IsControl)
}

func partitionAccountSessions(sessions []any) (active, historical []any) {
	active, historical = []any{}, []any{}
	for _, session := range sessions {
		if strings.TrimSpace(text(session, "target")) != "" && field(session, "registered") != false &&
			!slices.Contains([]string{"failed", "expired", "unavailable", "revoked", "removed"}, text(session, "state")) {
			active = append(active, session)
		} else {
			historical = append(historical, session)
		}
	}
	return active, historical
}

type accountManager struct {
	claude      claudeAccountManager
	refresh     sync.Mutex
	lastRefresh time.Time
}

var serviceAccounts sync.Map
var accountNotificationSessions func(context.Context) ([]any, error)
var accountCoordinationDelivery func(string) (any, error)
var accountSubscriptionSnapshot func(*service) (any, error)
var refreshAccountSubscription func(context.Context, *service, string) error
var refreshAccountClaudeQuota func(context.Context, *service, string, bool) error

func activeAccountManager(s *service) *accountManager {
	if value, ok := serviceAccounts.Load(s); ok {
		return value.(*accountManager)
	}
	manager := &accountManager{claude: claudeAccountManager{lifetime: context.Background()}}
	value, _ := serviceAccounts.LoadOrStore(s, manager)
	return value.(*accountManager)
}

func reconcileAccounts() error {
	observations, err := claudeAccountObservations()
	if err != nil {
		return err
	}
	sources, err := listSourceAuthority()
	if err != nil {
		return err
	}
	_, err = changeAccounts(func(rows *[]any) (struct{}, error) {
		for _, p := range observations {
			facts := field(p, "identity")
			state := "unfinished"
			switch {
			case field(facts, "statusError") != nil:
				state = "invalid"
			case field(facts, "loggedIn") == true:
				state = "signed-in"
			case field(facts, "loggedIn") == false:
				state = "signed-out"
			}
			id := text(p, "profileId")
			observeAccount(rows, "anthropic", facts, id, object{"agent": "claude", "profileId": id, "kind": "cli-profile", "state": state, "default": false}, "")
		}
		retireLocalAccountMembership(*rows, sources, now())
		for _, source := range sources {
			if !isBuiltinLocalSource(source) {
				observeSourceAccount(rows, source)
			}
		}
		accountDefaults(*rows)
		return struct{}{}, nil
	})
	return err
}

func (manager *accountManager) refreshAccounts(ctx context.Context) error {
	manager.refresh.Lock()
	defer manager.refresh.Unlock()
	if err := reconcileAccounts(); err != nil {
		return err
	}
	if !manager.lastRefresh.IsZero() && time.Since(manager.lastRefresh) < 15*time.Second {
		return nil
	}
	observations, err := claudeAccountObservations()
	if err != nil {
		return err
	}
	rows, err := readAccounts()
	if err != nil {
		return err
	}
	for _, observation := range observations {
		id := text(observation, "profileId")
		if ownerOfAccountProfile(rows, id) != nil {
			_, _ = refreshClaudeAccount(ctx, id)
		}
	}
	if err := reconcileAccounts(); err != nil {
		return err
	}
	_, err = changeAccounts(func(rows *[]any) (struct{}, error) {
		at := now()
		for _, value := range *rows {
			row := obj(value)
			if !liveAccount(row) {
				continue
			}
			profiles := accountProfiles(row)
			if len(profiles) == 0 {
				continue
			}
			row["agentProfiles"] = slices.DeleteFunc(profiles, func(profile any) bool { return field(profile, "agent") != "claude" })
			if len(accountProfiles(row)) == 0 && len(arr(row["sources"])) == 0 {
				row["removedAt"] = at
			}
		}
		accountDefaults(*rows)
		return struct{}{}, nil
	})
	if err == nil {
		manager.lastRefresh = time.Now()
	}
	return err
}

func accountsNotifications(ctx context.Context) ([]any, error) {
	if accountNotificationSessions != nil {
		return accountNotificationSessions(ctx)
	}
	_, err := os.Stat(filepath.Join(root(), "notifications/subscriptions/state.json"))
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return []any{}, nil
}

func (manager *accountManager) query(ctx context.Context, args object) (object, error) {
	routes, err := claudeNotificationRoutes()
	if err != nil {
		return nil, err
	}
	notifications, err := accountsNotifications(ctx)
	if err != nil {
		return nil, err
	}
	var login any
	if _, detail := args["id"].(string); !detail {
		profile, err := manager.claude.request(ctx, "profiles", "GET", nil)
		if err != nil {
			return nil, err
		}
		if progress := obj(profile["login"]); progress != nil {
			// A login can complete between the initial read and this projection.
			if progress["state"] == "completed" {
				if err := reconcileAccounts(); err != nil {
					return nil, err
				}
			}
			login = accountLoginProgress(progress)
		}
	}
	snapshot, err := readAccounts()
	if err != nil {
		return nil, err
	}
	owners := object{}
	for _, row := range snapshot {
		id := text(row, "id")
		canonical, err := canonicalAccount(snapshot, id)
		if err != nil {
			return nil, err
		}
		owners[id] = canonical
	}
	for i, value := range notifications {
		row := clone(obj(value))
		if profile, ok := row["accountId"].(string); ok {
			if owner := ownerOfAccountProfile(snapshot, profile); owner != nil {
				row["accountId"] = owner["id"]
			}
		}
		notifications[i] = row
	}
	var detail string
	if ref, ok := args["id"].(string); ok {
		row, err := resolveAccountRows(snapshot, ref)
		if err != nil {
			return nil, err
		}
		detail = text(row, "id")
	}
	rows := []any{}
	for _, value := range snapshot {
		row := clone(obj(value))
		id := text(row, "id")
		if detail != "" && id != detail {
			continue
		}
		if detail == "" {
			if !liveAccount(row) {
				continue
			}
			if agent, ok := args["agent"].(string); ok && !slices.ContainsFunc(accountProfiles(row), func(p any) bool { return field(p, "agent") == agent }) {
				continue
			}
			delete(row, "email")
			delete(row, "orgName")
		}
		history := []any{}
		for _, old := range keys(owners) {
			if old != id && owners[old] == id {
				history = append(history, old)
			}
		}
		row["mergedAccountIds"] = history
		profiles := map[string]bool{}
		for _, profile := range accountProfiles(row) {
			if field(profile, "agent") == "claude" {
				profiles[text(profile, "profileId")] = true
			}
		}
		sessions := []any{}
		for _, session := range notifications {
			account, accountOK := field(session, "accountId").(string)
			source, sourceOK := field(session, "sourceId").(string)
			if accountOK && (owners[account] == id || profiles[account]) || sourceOK && ownsAccountSource(row, source) {
				sessions = append(sessions, session)
			}
		}
		targets := make([]string, 0, len(routes))
		for target := range routes {
			targets = append(targets, target)
		}
		slices.Sort(targets)
		for _, target := range targets {
			if profiles[routes[target]] && find(sessions, "target", target) == nil {
				sessions = append(sessions, object{"target": target, "state": "not-bound"})
			}
		}
		sessions, historical := partitionAccountSessions(sessions)
		state, health := "n/a", "ready"
		switch {
		case !liveAccount(row):
			state, health = "removed", "removed"
			row["displayName"] = "Removed account · " + text(row, "alias")
		case field(row, "provider") == "anthropic" && (len(arr(row["sources"])) > 0 || len(sessions) > 0):
			state = "not-bound"
			if slices.ContainsFunc(sessions, func(s any) bool { return field(s, "verified") == true }) {
				state = "verified"
			}
		case field(row, "provider") == "openai" && len(arr(row["sources"])) > 0:
			state = "mcp-events"
		}
		if health != "removed" && (accountHasIdentityConflict(row) || slices.ContainsFunc(accountProfiles(row), func(p any) bool { return field(p, "state") != "signed-in" })) {
			health = "attention"
		}
		reachable := slices.ContainsFunc(sessions, func(s any) bool { return field(s, "verified") == true || field(s, "reachable") == true })
		row["notifications"] = object{"state": state, "reachable": reachable, "sessions": sessions, "historicalSessions": historical}
		row["health"] = object{"state": health}
		if detail != "" {
			return row, nil
		}
		rows = append(rows, row)
	}
	if detail != "" {
		return nil, errors.New("ACCOUNT_NOT_FOUND")
	}

	return object{"accounts": rows, "login": login}, nil
}

func defaultSignedInClaudeAccount() (string, error) {
	observations, err := claudeAccountObservations()
	if err != nil {
		return "", err
	}
	rows, err := readAccounts()
	if err != nil {
		return "", err
	}
	return selectSignedInClaudeProfile(rows, observations), nil
}

func saveProviderAccountQuota(profile string, quota any) error {
	_, err := changeAccounts(func(rows *[]any) (struct{}, error) {
		if row := ownerOfAccountProfile(*rows, profile); row != nil {
			row["quota"] = quota
		}
		return struct{}{}, nil
	})
	return err
}

func accountClaudeProfile(reference string) (string, error) {
	row, err := resolveAccount(reference)
	if err != nil {
		return "", err
	}
	if !liveAccount(row) {
		return "", errors.New("ACCOUNT_REMOVED: Select an active account")
	}
	if profile := find(accountProfiles(row), "agent", "claude"); profile != nil {
		return text(profile, "profileId"), nil
	}
	return "", errors.New("ACCOUNT_AGENT_MISSING: This account has no Claude profile")
}

func updateProviderAccount(args object) error {
	account, err := resolveAccount(text(args, "id"))
	if err != nil {
		return err
	}
	if !liveAccount(account) {
		return errors.New("ACCOUNT_REMOVED")
	}
	alias, provided := args["alias"]
	if provided && !validAccountAlias(alias) {
		return errors.New("INVALID_ACCOUNT_ALIAS: Use 1 to 120 characters")
	}
	_, err = changeAccounts(func(rows *[]any) (struct{}, error) {
		row := find(*rows, "id", text(account, "id"))
		if row == nil {
			return struct{}{}, errors.New("ACCOUNT_NOT_FOUND")
		}
		if provided {
			row["alias"] = strings.TrimSpace(str(alias))
		}
		return struct{}{}, nil
	})
	return err
}

func removeProviderAccount(args object) (string, error) {
	row, err := resolveAccount(text(args, "id"))
	if err != nil {
		return "", err
	}
	if running := text(args, "running"); running != "finish" && running != "cancel" {
		return "", errors.New("INVALID_RUNNING_POLICY: Use finish or cancel")
	}
	accountID := text(row, "id")
	return changeAccounts(func(rows *[]any) (string, error) {
		account := find(*rows, "id", accountID)
		if account == nil {
			return "", errors.New("ACCOUNT_NOT_FOUND")
		}
		profiles := accountProfiles(account)
		if agent, ok := args["agent"].(string); ok && (len(arr(account["sources"])) != 0 || len(profiles) != 1 || field(profiles[0], "agent") != agent) {
			return "", errors.New("ACCOUNT_PROFILE_NOT_REMOVABLE: This account has another role")
		}
		account["removedAt"] = now()
		for _, profile := range profiles {
			obj(profile)["default"] = false
		}
		accountDefaults(*rows)
		return accountID, nil
	})
}

func accountSourceWhoami(ctx context.Context, manager *accountManager, source object) (object, error) {
	id := source["id"]
	if isBuiltinLocalSource(source) {
		return object{"id": nil, "sourceId": id, "platform": "local", "authority": "local", "identityResolution": object{"state": "not-applicable"},
			"agentProfiles": []any{}, "notifications": object{"state": "n/a", "sessions": []any{}}}, nil
	}
	if err := projectSourceAccounts([]any{source}); err != nil {
		return nil, err
	}
	account, err := manager.query(ctx, object{"id": source["accountId"]})
	if err != nil {
		return nil, err
	}
	coordination, err := accountCoordinationDelivery(str(id))
	if err != nil {
		return nil, err
	}
	result := object{"sourceId": id, "platform": source["platform"], "identityResolution": source["identityResolution"], "coordinationDelivery": coordination}
	for _, key := range []string{"id", "alias", "provider", "email", "orgName", "plan", "agentProfiles", "notifications"} {
		result[key] = account[key]
	}
	return result, nil
}

func (manager *accountManager) operation(ctx context.Context, s *service, name string, args object, source requestSource) (object, error) {
	if err := manager.refreshAccounts(ctx); err != nil {
		return nil, err
	}
	_, detail := args["id"].(string)
	forceQuota := name == "account_refresh_quota"
	if forceQuota || name == "accounts" && detail {
		row, err := resolveAccount(text(args, "id"))
		if err != nil {
			return nil, err
		}
		if liveAccount(row) {
			if provider, ok := row["quotaProviderId"].(string); ok {
				if forceQuota {
					if err := refreshAccountSubscription(ctx, s, provider); err != nil {
						return nil, err
					}
				}
				snapshot, err := accountSubscriptionSnapshot(s)
				if err != nil {
					return nil, err
				}
				if quota := find(field(snapshot, "providers"), "providerId", provider); quota != nil {
					_, err = changeAccounts(func(rows *[]any) (struct{}, error) {
						if current := find(*rows, "id", text(row, "id")); current != nil && liveAccount(current) {
							current["quota"] = sharedAccountQuota(quota)
						}
						return struct{}{}, nil
					})
					if err != nil {
						return nil, err
					}
				}
			} else if profile := find(accountProfiles(row), "agent", "claude"); profile != nil && refreshAccountClaudeQuota != nil {
				if err := refreshAccountClaudeQuota(ctx, s, text(profile, "profileId"), forceQuota); err != nil {
					return nil, err
				}
			}
		}
	}
	switch name {
	case "accounts", "account_refresh_quota":
		return manager.query(ctx, args)
	case "account_browsers":
		return manager.claude.request(ctx, "profiles/browsers", "GET", nil)
	case "account_add", "account_login", "account_reauth":
		return manager.loginOperation(ctx, name, args)
	case "account_update":
		if err := updateProviderAccount(args); err != nil {
			return nil, err
		}
		return manager.query(ctx, object{"id": args["id"]})
	case "account_remove":
		id, err := removeProviderAccount(args)
		if err != nil {
			return nil, err
		}
		return manager.query(ctx, object{"id": id})
	case "account_merge":
		snapshot, err := accountSubscriptionSnapshot(s)
		if err != nil {
			return nil, err
		}
		account, err := changeAccounts(func(rows *[]any) (object, error) { return mergeProviderAccounts(*rows, args, snapshot, now()) })
		if err != nil {
			return nil, err
		}
		return manager.query(ctx, object{"id": account["id"]})
	case "account_notify":
		return accountNotificationAction(ctx, text(args, "id"), args, text(args, "action"))
	case "whoami":
		var value object
		var err error
		if sourceID := text(source.origin, "sourceId"); sourceID != "" {
			value, err = readSourceAuthority(sourceID)
		} else {
			value, err = ensureLocalSource()
		}
		if err != nil {
			return nil, err
		}
		return accountSourceWhoami(ctx, manager, value)
	}
	return nil, errors.New("UNKNOWN_ACCOUNT_OP: Read guide for accounts")
}

func accountNotificationAction(ctx context.Context, id string, input object, action string) (object, error) {
	profile, err := accountClaudeProfile(id)
	if err != nil {
		return nil, err
	}
	row, err := resolveAccount(id)
	if err != nil {
		return nil, err
	}
	var result object
	if action == "bind" {
		result, err = bindClaudeNotificationRoute(text(input, "target"), profile, true)
	} else {
		body := maps.Clone(input)
		if body == nil {
			body = object{}
		}
		body["accountId"] = profile
		if action == "test" {
			if _, ok := body["message"].(string); !ok {
				body["message"] = "ARC notification test"
			}
		}
		result, err = sendAccountNotificationThroughOwner(ctx, body)
	}
	if err == nil {
		result["accountId"] = row["id"]
	}
	return result, err
}

func decorateAccountLabels(value any, rows []any) {
	labels := map[string]object{}
	for _, row := range rows {
		id, ok := field(row, "id").(string)
		if !ok {
			continue
		}
		if canonical, err := canonicalAccount(rows, id); err == nil {
			labels[id] = find(rows, "id", canonical)
		}
	}
	var visit func(any)
	visit = func(value any) {
		switch value := value.(type) {
		case object:
			if account := labels[text(value, "agentAccountId")]; account != nil {
				alias := text(account, "alias")
				removed := !liveAccount(account)
				value["agentAccountAlias"], value["agentAccountRemoved"] = account["alias"], removed
				if removed {
					alias = "Removed account · " + alias
				}
				value["agentAccountLabel"] = alias
			}
			for key, nested := range value {
				if !slices.Contains([]string{"arguments", "args", "input", "output", "metadata", "items", "finalResponse"}, key) {
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

func accountControlOperation(ctx context.Context, request operationRequest) (any, error) {
	return activeAccountManager(request.service).operation(ctx, request.service, request.name, request.args, request.source)
}

func init() {
	registerServiceStartup(func(ctx context.Context, s *service) error {
		manager := &accountManager{claude: claudeAccountManager{lifetime: ctx}}
		serviceAccounts.Store(s, manager)
		s.cleanup = append(s.cleanup, func() {
			manager.claude.stop()
			serviceAccounts.Delete(s)
		})
		return nil
	})
	for _, op := range []string{"accounts", "whoami", "account_update", "account_merge", "account_add", "account_login", "account_reauth", "account_remove", "account_browsers", "account_notify"} {
		registerOperation(op, accountControlOperation, nil)
	}
	management := func(op string) managementHandler {
		return func(ctx context.Context, s *service, body object, _ []string) (any, error) {
			return activeAccountManager(s).operation(ctx, s, op, body, requestSource{origin: currentOrigin(ctx)})
		}
	}
	registerRoute("GET", "accounts", management("accounts"))
	for route, op := range map[string]string{"query": "accounts", "whoami": "whoami", "refresh-quota": "account_refresh_quota",
		"update": "account_update", "merge": "account_merge", "add": "account_add", "login": "account_login", "reauth": "account_reauth", "remove": "account_remove"} {
		registerRoute("POST", "accounts/"+route, management(op))
	}
	registerRoute("GET", "accounts/whoami", management("whoami"))
	registerRoute("GET", "accounts/browsers", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		return activeAccountManager(s).claude.request(ctx, "profiles/browsers", "GET", body)
	})
	registerRoutePattern("GET", "accounts/([^/]+)", func(ctx context.Context, s *service, _ object, params []string) (any, error) {
		return activeAccountManager(s).operation(ctx, s, "accounts", object{"id": params[0]}, requestSource{})
	})
	registerRoute("PUT", "accounts/routes", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		return accountNotificationAction(ctx, text(body, "accountId"), body, "bind")
	})
	registerRoutePattern("POST", "accounts/([^/]+)/(send|test)", func(ctx context.Context, s *service, body object, params []string) (any, error) {
		return accountNotificationAction(ctx, params[0], body, params[1])
	})
}

func notificationProviderAccounts() ([]any, error) {
	rows, err := readAccounts()
	if err != nil {
		return nil, err
	}
	result := []any{}
	for _, row := range rows {
		if liveAccount(row) && find(accountProfiles(row), "agent", "claude") != nil {
			result = append(result, object{"accountId": field(row, "id"), "alias": field(row, "alias"),
				"identity": object{"email": field(row, "email"), "orgName": field(row, "orgName")}})
		}
	}
	return result, nil
}

func liveSourceAccounts() ([]any, error) {
	if _, err := listControlSources(); err != nil {
		return nil, err
	}
	rows, err := readAccounts()
	if err != nil {
		return nil, err
	}
	result := []any{}
	for _, row := range rows {
		if liveAccount(row) && len(arr(field(row, "sources"))) != 0 {
			result = append(result, clone(obj(row)))
		}
	}
	return result, nil
}
