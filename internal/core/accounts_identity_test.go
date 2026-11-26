package core

import "testing"

func TestSourceProductCorrectionPreservesProvisionalAccount(t *testing.T) {
	// Recurring bug class: persistence Source product corrections preserve provisional IDs and labels while updating their provider namespace.
	rows := []any{}
	source := object{"id": "source-one", "platform": "openai"}
	id := observeSourceAccount(&rows, source)
	obj(rows[0])["alias"] = "Custom alias"
	other := observeSourceAccount(&rows, object{"id": "source-two", "platform": "openai"})
	before := wire(find(rows, "id", other))
	source["platform"] = "anthropic"
	got := observeSourceAccount(&rows, source)
	row := find(rows, "id", id)
	if got != id || row["provider"] != "anthropic" || row["identityKey"] != "anthropic:unidentified:source-one" ||
		row["alias"] != "Custom alias" || wire(row["sources"]) != `["source-one"]` || wire(find(rows, "id", other)) != before {
		t.Fatalf("unexpected corrected source account: %v", row)
	}
}

func TestSourceProductCorrectionPreservesConfirmedProvider(t *testing.T) {
	// Algorithmic core: Product defaults cannot replace an authorized provider identity.
	rows := []any{}
	source := object{"id": "confirmed-source", "platform": "openai", "authorizationFacts": object{"accountId": "provider-account"}}
	id := observeSourceAccount(&rows, source)
	source["platform"], source["authorizationFacts"] = "anthropic", nil
	got := observeSourceAccount(&rows, source)
	row := find(rows, "id", id)
	if got != id || row["provider"] != "openai" || row["identityKey"] != "openai:id:provider-account" || !ownsAccountSource(row, "confirmed-source") {
		t.Fatalf("unexpected confirmed source account: %v", row)
	}
}

func TestConflictingHandshakeRetainsAuthorization(t *testing.T) {
	// Algorithmic core: Authorization wins when a confirmed handshake disagrees with the source's provider identity.
	rows := []any{
		object{"id": "source-account", "identityKey": "anthropic:id:one", "sources": []any{"source"}, "agentProfiles": []any{}, "sourceIdentities": object{"source": object{"state": "resolved", "authorization": object{"kind": "authorization", "identityKey": "anthropic:id:one"}}}},
		object{"id": "profile-account", "identityKey": "anthropic:id:two", "sources": []any{}, "agentProfiles": []any{object{"agent": "claude", "profileId": "profile"}}},
	}
	evidence := object{"kind": "claude-session-handshake", "sourceId": "source", "profileId": "profile", "accountId": "profile-account", "identityKey": "anthropic:id:two", "confirmedAt": "2026-01-01T00:00:00Z"}
	result, err := linkAccountSourceIdentity(rows, "source", evidence)
	if err != nil || result["state"] != "conflict" || result["accountId"] != "source-account" || wire(result["evidence"]) != wire(evidence) ||
		text(result["authorization"], "identityKey") != "anthropic:id:one" || !ownsAccountSource(rows[0], "source") || ownsAccountSource(rows[1], "source") {
		t.Fatalf("unexpected conflicting resolution: %v %v", result, err)
	}
}

func TestHandshakeLinksUniqueVerifiedProfile(t *testing.T) {
	// Algorithmic core: Provisional sources move only after evidence proves the current Claude profile identity.
	rows := []any{
		object{"id": "unknown", "identityKey": "other:unidentified:source", "sources": []any{"source"}, "agentProfiles": []any{}},
		object{"id": "owner", "identityKey": "anthropic:id:example", "sources": []any{}, "agentProfiles": []any{object{"agent": "claude", "profileId": "profile"}}},
	}
	evidence := object{"kind": "claude-session-handshake", "sourceId": "source", "profileId": "wrong", "accountId": "owner", "identityKey": "anthropic:id:example", "confirmedAt": "2026-01-01T00:00:00Z"}
	result, err := linkAccountSourceIdentity(rows, "source", evidence)
	if err != nil || result["state"] != "conflict" {
		t.Fatalf("unexpected stale profile resolution: %v %v", result, err)
	}
	evidence["profileId"] = "profile"
	result, err = linkAccountSourceIdentity(rows, "source", evidence)
	if err != nil || result["state"] != "resolved" || result["accountId"] != "owner" ||
		field(result["evidence"], "confirmedAt") != evidence["confirmedAt"] || field(rows[0], "mergedInto") != "owner" || !ownsAccountSource(rows[1], "source") {
		t.Fatalf("unexpected linked identity: %v %v", result, err)
	}
}
