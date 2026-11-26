package core

import "testing"

const srcHandshakeAt = "2026-01-01T12:00:00.000Z"

func observedSRCChat(id, account string, active any) object {
	return object{"accountId": account, "kind": "chat", "id": id, "url": "https://claude.ai/chat/" + id,
		"basis": "observed", "firstSeenAt": srcHandshakeAt, "lastSeenAt": srcHandshakeAt, "lastActiveAt": active}
}

func srcFixtureTarget() object { return srcNotifyReference("session_010000000000000000000001") }

func TestVerifiedSRCChatAccumulatesAccountScopedAliases(t *testing.T) {
	// Recurring bug class: persistence repeated verified sessions keep one canonical active Chat and its aliases.
	original := observedSRCChat("chat-one", "owner", srcHandshakeAt)
	rows := []object{original, observedSRCChat("peer", "other", srcHandshakeAt)}
	for _, suffix := range []string{"010000000000000000000001", "010000000000000000000002"} {
		target := srcNotifyReference("session_" + suffix)
		rows = verifiedSRCReference(rows, map[string]object{}, "owner", target, srcHandshakeAt)
		resolved := resolveSRCReference(rows, "owner", text(target, "id"))
		for _, key := range []string{"id", "kind", "url", "basis"} {
			if resolved[key] != original[key] {
				t.Fatalf("canonical identity %s = %v, want %v", key, resolved[key], original[key])
			}
		}
		if resolveSRCReference(rows, "other", text(target, "id")) != nil {
			t.Fatal("alias leaked across account scope")
		}
	}
	if len(rows) != 2 || len(arr(rows[0]["aliases"])) != 2 {
		t.Fatalf("canonical rows = %v", rows)
	}
	var restored []object
	if err := unmarshalJSON([]byte(wire(rows)), &restored); err != nil {
		t.Fatal(err)
	}
	const later = "2026-01-01T13:00:00Z"
	restored = append(restored, observedSRCChat("newer", "owner", later))
	rows = verifiedSRCReference(restored, map[string]object{}, "owner", srcFixtureTarget(), later)
	if got := resolveSRCReference(rows, "owner", text(srcFixtureTarget(), "id")); got["id"] != original["id"] {
		t.Fatalf("verified alias switched identity after restart: %v", got)
	}
}

func TestVerifiedSRCReferenceNeedsOneRecentSameAccountChat(t *testing.T) {
	// Recurring bug class: security unverified or ambiguous account evidence cannot merge conversation identities.
	for _, rows := range [][]object{
		{},
		{observedSRCChat("one", "owner", srcHandshakeAt), observedSRCChat("two", "owner", srcHandshakeAt)},
		{observedSRCChat("stale", "owner", "2026-01-01T11:49:59Z"), observedSRCChat("inactive", "owner", nil), observedSRCChat("peer", "other", srcHandshakeAt)},
		{observedSRCChat("future", "owner", "2026-01-01T12:00:01Z")},
	} {
		before := wire(rows)
		if got := verifiedSRCReference(rows, map[string]object{}, "owner", srcFixtureTarget(), srcHandshakeAt); wire(got) != before {
			t.Fatalf("ambiguous evidence changed the registry: %v", got)
		}
	}
}

func TestVerifiedSRCAliasMergesOnlyItsOwnTaskBindings(t *testing.T) {
	// Recurring bug class: persistence merging an observed Cowork preserves earlier evidence and exact task bindings.
	cowork := srcFixtureTarget()
	cowork["accountId"], cowork["firstSeenAt"], cowork["lastSeenAt"] = "owner", "2025-12-01T00:00:00Z", srcHandshakeAt
	historical := object{"accountId": "owner", "kind": "cowork", "id": "cse_historical", "firstSeenAt": cowork["firstSeenAt"], "lastActiveAt": nil}
	rows := []object{cowork, observedSRCChat("one", "owner", "2026-01-01T11:50:00Z"), historical}
	bindings := map[string]object{
		"codex:one":   {"accountId": "owner", "kind": "chat", "id": "one", "basis": "correlated"},
		"codex:two":   {"accountId": "owner", "kind": "cowork", "id": cowork["id"], "basis": "notify-target"},
		"agent:three": {"accountId": "owner", "kind": "cowork", "id": cowork["id"], "basis": "manual"},
	}
	result := verifiedSRCReference(rows, bindings, "owner", srcFixtureTarget(), srcHandshakeAt)
	if len(result) != 2 || resolveSRCReference(result, "owner", "one")["firstSeenAt"] != cowork["firstSeenAt"] ||
		wire(resolveSRCReference(result, "owner", "cse_historical")) != wire(historical) {
		t.Fatalf("merged registry = %v", result)
	}
	for key, binding := range bindings {
		if binding["id"] != "one" {
			t.Fatalf("%s stayed bound to the obsolete alias: %v", key, binding)
		}
	}
	if bindings["codex:two"]["basis"] != "notify-target" || bindings["agent:three"]["basis"] != "manual" {
		t.Fatalf("merged task bindings lost provenance: %v", bindings)
	}
}
