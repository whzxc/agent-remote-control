package core

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestAccountWorkMeasuresRefreshWritesAndColdSourceProjection(t *testing.T) {
	// Contract: runtime_metrics measures refresh transactions and cold source projections while cached projections stay passive.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	s := &service{}
	work := func() object { return runtimeWorkRow(desktopMetrics(t, s), "accounts") }
	before := work()
	manager := &accountManager{}
	if err := manager.refreshAccounts(t.Context()); err != nil {
		t.Fatal(err)
	}
	refreshed := work()
	if refreshed["inFlight"] != uint64(0) || uintOr(refreshed["calls"], 0) <= uintOr(before["calls"], 0) ||
		refreshed["totalWallMs"].(float64) <= before["totalWallMs"].(float64) || refreshed["maxWallMs"].(float64) <= 0 {
		t.Fatalf("account refresh work before = %v, after = %v", before, refreshed)
	}
	if _, err := ensureIngressSource(object{"id": "fixture", "controlSource": "claude"}, true); err != nil {
		t.Fatal(err)
	}
	before = work()
	if _, err := listControlSources(); err != nil {
		t.Fatal(err)
	}
	cold := work()
	if cold["calls"] != uintOr(before["calls"], 0)+1 || cold["inFlight"] != uint64(0) ||
		cold["totalWallMs"].(float64) <= before["totalWallMs"].(float64) {
		t.Fatalf("cold source work before = %v, after = %v", before, cold)
	}
	if _, err := listControlSources(); err != nil {
		t.Fatal(err)
	}
	if warm := work(); !reflect.DeepEqual(warm, cold) {
		t.Fatalf("warm source projection changed work counters: cold = %v, warm = %v", cold, warm)
	}
}

func TestNotificationOperationsRequireAccountReconciliation(t *testing.T) {
	// Recurring bug class: persistence a failed account reconciliation must stop notification reads and leave bindings untouched.
	state := filepath.Dir(testNotificationIndexDirectory(t))
	index := filepath.Join(state, "accounts", "index.json")
	ctx := t.Context()
	source := requestSource{origin: object{"sourceId": "fixture"}}
	const target = "session_010000000000000000000018"
	if err := save(index, object{}); err != nil {
		t.Fatal(err)
	}
	for _, request := range []operationRequest{
		{name: "notify_status", source: source},
		{name: "notify_control", source: source, args: object{"action": "bind", "target": target, "verify": false}},
	} {
		if _, err := executeOperation(ctx, request); err == nil || err.Error() != "ACCOUNTS_INVALID: expected an array" {
			t.Fatalf("%s did not propagate the account error: %v", request.name, err)
		}
	}
	if err := save(index, []any{}); err != nil {
		t.Fatal(err)
	}
	value, err := executeOperation(ctx, operationRequest{name: "notify_status", source: source, args: object{"target": target}})
	if err != nil || find(field(value, "targets"), "target", target) != nil {
		t.Fatalf("failed bind left a registered target: %v, %v", value, err)
	}
}

func TestClaudeQuotaProfileSelection(t *testing.T) {
	// Contract: Claude quota lookup prefers the default signed-in profile and then the most recent observation.
	profile := func(id string, primary bool) object {
		return object{"agent": "claude", "profileId": id, "state": "signed-in", "default": primary}
	}
	first, latest := profile("first", true), profile("latest", false)
	rows := []any{object{"id": "first", "agentProfiles": []any{first}}, object{"id": "latest", "agentProfiles": []any{latest}}}
	observations := []any{object{"profileId": "first", "observedAt": "2026-01-01T00:00:00Z"}, object{"profileId": "latest", "observedAt": "2026-01-02T00:00:00Z"}}
	for _, step := range []struct {
		change func()
		want   string
	}{
		{func() {}, "first"}, {func() { first["default"] = false }, "latest"}, {func() { latest["state"] = "signed-out" }, "first"},
	} {
		step.change()
		if selected := selectSignedInClaudeProfile(rows, observations); selected != step.want {
			t.Errorf("selected %s, want %s", selected, step.want)
		}
	}
}

func TestRetireLegacyLocalMembership(t *testing.T) {
	// Recurring bug class: persistence Keep account history and non-local roles when retiring legacy Local CLI membership.
	sources := []any{object{"id": "local", "ingressId": "local-cli", "credential": object{"type": "local"}}}
	agent := object{"agent": "claude"}
	rows := []any{
		object{"id": "local-only", "sources": []any{"local"}, "agentProfiles": []any{}, "sourceIdentities": object{"local": object{"state": "unresolved"}}},
		object{"id": "shared", "sources": []any{"local", "external"}, "agentProfiles": []any{object{"agent": "codex"}}},
		object{"id": "agent-only", "sources": []any{"local"}, "agentProfiles": []any{agent}},
	}
	retireLocalAccountMembership(rows, sources, "2026-01-01T00:00:00Z")
	if liveAccount(rows[0]) || wire(field(rows[0], "sources")) != "[]" || wire(field(rows[0], "sourceIdentities")) != "{}" ||
		!liveAccount(rows[1]) || wire(field(rows[1], "sources")) != `["external"]` || !liveAccount(rows[2]) ||
		!reflect.DeepEqual(accountProfiles(rows[2]), []any{agent}) {
		t.Fatalf("unexpected remaining roles: %v", rows)
	}
	before := wire(rows)
	retireLocalAccountMembership(rows, sources, "2026-01-02T00:00:00Z")
	if wire(rows) != before {
		t.Fatal("repair changed an already retired membership")
	}
	if err := projectSourceAccounts(sources); err != nil || field(sources[0], "accountId") != nil {
		t.Fatalf("local source acquired an account: %v", err)
	}
}

func TestProviderIdentityFacts(t *testing.T) {
	// Algorithmic core: Coalesce normalized provider facts while keeping unrelated or unresolved accounts distinct.
	if accountIdentityKey("openai", object{"email": " Person@Example.com ", "orgName": " Example Org "}) !=
		accountIdentityKey("openai", object{"email": "person@example.com", "orgName": "example org"}) ||
		accountIdentityKey("openai", object{"accountId": "one"}) == accountIdentityKey("anthropic", object{"accountId": "one"}) ||
		accountIdentityKey("openai", object{"name": "person@example.com"}) != "" {
		t.Fatal("unexpected identity resolution")
	}
}

func TestSourceProfileMergeKeepsSingleDefault(t *testing.T) {
	// Algorithmic core: Accounts with equal upstream identities share roles and a unique default per agent.
	rows := []any{}
	facts := object{"email": "person@example.com"}
	source := observeAccount(&rows, "openai", facts, "source", nil, "source")
	observeAccount(&rows, "openai", facts, "profile", object{"agent": "codex", "profileId": "home", "state": "signed-in"}, "")
	observeAccount(&rows, "openai", nil, "other", object{"agent": "codex", "profileId": "other", "state": "signed-out"}, "")
	accountDefaults(rows)
	if len(rows) != 2 || len(accountProfiles(rows[0])) != 1 || field(accountProfiles(rows[0])[0], "default") != true ||
		field(accountProfiles(rows[1])[0], "default") != false || !ownsAccountSource(find(rows, "id", source), "source") {
		t.Fatalf("unexpected roles: %v", rows)
	}
}

func TestInactiveAccountNotificationRoutes(t *testing.T) {
	// Recurring bug class: lifecycle Failed, unregistered, and unnamed notification routes remain diagnostic history.
	active, historical := partitionAccountSessions([]any{
		object{"target": "", "verified": true}, object{"target": "old", "state": "failed"}, object{"target": "revoked", "registered": false},
		object{"target": "live", "state": "verified", "verified": true}, object{"target": "new", "state": "not-bound"},
	})
	if len(active) != 2 || text(active[0], "target") != "live" || text(active[1], "target") != "new" || len(historical) != 3 || text(historical[1], "state") != "failed" {
		t.Fatalf("unexpected live and historical routes: %v %v", active, historical)
	}
}
