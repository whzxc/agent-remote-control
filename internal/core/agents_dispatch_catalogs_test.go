package core

import "testing"

func TestAgentCatalogMetadataDoesNotInferFromIDsOrBrands(t *testing.T) {
	// Algorithmic core: catalog metadata inference policy.
	for _, model := range []string{"vendor/model-128k", `["profile","gpt-model"]`, " GPT-6-Astra "} {
		for _, agent := range []string{"claude", "cursor", "grok", "dsh"} {
			row := nativeACPModel(object{"value": model}, "value", nil, agent)
			if row["model"] != model || row["displayName"] != nil || row["provider"] != nil || row["contextWindow"] != nil {
				t.Fatalf("%s opaque model projection: %s", agent, wire(row))
			}
			name := "Claude GPT · Provider 128k"
			named := nativeACPModel(object{"value": model, "name": name}, "value", nil, agent)
			if named["displayName"] != name || named["provider"] != nil || named["contextWindow"] != nil {
				t.Fatalf("%s native display metadata: %s", agent, wire(named))
			}
		}
	}
}

func TestAgentCatalogPreservesNonemptySnapshot(t *testing.T) {
	// Recurring bug class: persistence empty observation cannot erase a durable catalog.
	populated := nativeAgentCatalogSnapshot(object{"models": []any{object{"model": "opaque"}}, "observedAt": "2026-01-01T00:00:00Z"})
	empty := nativeAgentCatalogSnapshot(object{"models": []any{}, "observedAt": "2026-01-02T00:00:00Z"})
	if nativeAgentCatalogChanged(populated, empty) || !nativeAgentCatalogChanged(nil, empty) {
		t.Fatal("empty observation replaced a known catalog or failed to establish the first snapshot")
	}
	populated["observedAt"] = "2026-01-03T00:00:00Z"
	if !nativeAgentCatalogChanged(empty, populated) {
		t.Fatal("new nonempty catalog failed to replace an empty snapshot")
	}
}

func TestAgentCatalogIgnoresTimestampOnlyRewrites(t *testing.T) {
	// Recurring bug class: persistence unchanged catalog observations deduplicate.
	previous := object{"models": []any{object{"model": "opaque", "displayName": "Native"}}, "observedAt": "2026-01-01T00:00:00Z"}
	next := clone(previous)
	next["observedAt"] = "2026-01-02T00:00:00Z"
	if nativeAgentCatalogChanged(previous, next) {
		t.Fatal("observation time alone changed persisted catalog")
	}
	obj(arr(next["models"])[0])["contextWindow"] = 131072
	if !nativeAgentCatalogChanged(previous, next) {
		t.Fatal("new context metadata was ignored")
	}
	next["observedAt"] = previous["observedAt"]
	if !nativeAgentCatalogChanged(previous, next) {
		t.Fatal("changed metadata at the same observation time was ignored")
	}
	next["observedAt"] = "2025-12-31T00:00:00Z"
	if nativeAgentCatalogChanged(previous, next) {
		t.Fatal("older metadata replaced a current catalog")
	}
}
