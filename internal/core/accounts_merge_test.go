package core

import (
	"slices"
	"testing"
)

func TestConfirmedAccountMergeIsReplayStable(t *testing.T) {
	// Algorithmic core: Explicit merge retains all memberships, aliases and historical account IDs across replay.
	row := func(id, provider, key string, sources, profiles []any) object {
		return object{"id": id, "provider": provider, "identityKey": key, "sources": sources, "agentProfiles": profiles}
	}
	rows := []any{
		row("target", "xai", "xai:id:example", []any{}, []any{object{"agent": "grok", "profileId": "grok-home", "default": true}}),
		row("source-one", "xai", "xai:unidentified:source-one", []any{"source-one"}, []any{}),
		row("source-two", "xai", "xai:unidentified:source-two", []any{"source-two"}, []any{}),
		row("cursor", "cursor", "cursor:id:example", []any{}, []any{object{"agent": "cursor", "profileId": "cursor-home", "default": true}}),
	}
	snapshot := object{"providers": []any{object{"providerId": "grok", "agentId": "grok", "state": "ready", "windows": []any{object{"id": "weekly", "poolId": "main", "label": "weekly", "usedPercent": 20}}, "rawUsage": object{"config": object{"isUnifiedBillingUser": true}}}}}
	args := object{"into": "target", "ids": []any{"source-one", "source-two", "cursor"}, "quotaProviderId": "grok"}
	const at = "2026-01-01T00:00:00Z"
	account, err := mergeProviderAccounts(rows, args, snapshot, at)
	if err != nil || len(arr(account["sources"])) != 2 || len(accountProfiles(account)) != 2 || len(arr(account["mergedAccountIds"])) != 3 ||
		!slices.Contains(arr(account["identityAliases"]), any("cursor:id:example")) || account["identityKey"] != "xai:id:example" {
		t.Fatalf("unexpected merged account: %v %v", account, err)
	}
	for _, old := range arr(args["ids"]) {
		if field(find(rows, "id", str(old)), "mergedInto") != "target" {
			t.Errorf("lost history for %s", old)
		}
	}
	before := wire(rows)
	if _, err := mergeProviderAccounts(rows, args, snapshot, at); err != nil || wire(rows) != before {
		t.Fatalf("replay changed account ownership: %v", err)
	}
}
