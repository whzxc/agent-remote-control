package core

import (
	"strings"
	"testing"
)

func TestDispatchPolicyPreservesLatestExplicitFields(t *testing.T) {
	// Algorithmic core: omitted model and effort inherit their independent last explicit choices.
	rows := []object{
		{"model": "chosen", "effort": "high", "source": object{"model": "explicit", "effort": "explicit"}},
		{"model": "default", "effort": "low", "source": object{"model": "policy-default", "effort": "policy-default"}},
		{"effort": "medium", "source": object{"effort": "explicit"}},
	}
	if got := inheritedDispatchConfiguration(nil, rows); got["model"] != "chosen" || got["effort"] != "medium" {
		t.Fatalf("inherited configuration = %v", got)
	}
	state := object{"latestThreadSettings": object{"model": "desktop", "effort": "low"}}
	if got := inheritedDispatchConfiguration(state, rows); got["model"] != "desktop" || got["effort"] != "low" {
		t.Fatalf("native configuration = %v", got)
	}
}

func TestDispatchPolicyPackValidationAndBlock(t *testing.T) {
	// Algorithmic core: pack validation and canonical content hash protect the prompt bundle contract.
	for _, invalid := range []struct {
		name string
		pack dispatchPack
	}{{"Bad Name", dispatchPack{Summary: "Summary"}}, {"valid", dispatchPack{}},
		{"valid", dispatchPack{Summary: "Summary", Prompt: strings.Repeat("x", 4001)}}} {
		if err := validateDispatchPack(invalid.name, invalid.pack); err == nil {
			t.Fatalf("accepted invalid pack %s", invalid.name)
		}
	}
	if _, err := decodeDispatchPack(object{"summary": "Summary", "mode": "bypass"}); err == nil {
		t.Fatal("accepted unsupported pack field")
	}
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	p := dispatchPack{Summary: "Résumé <&>", Prompt: "Line one\nLine two"}
	result, err := dispatchPackUpdate(object{"name": "valid-name", "pack": p, "expectedPackHash": nil})
	if err != nil {
		t.Fatal(err)
	}
	want := hash([]byte(`{"summary":"Résumé <&>","prompt":"Line one\nLine two","review":""}`))[:12]
	if result["packHash"] != want {
		t.Fatalf("pack hash = %v, want %s", result["packHash"], want)
	}
	args := object{"pack": "valid-name", "prompt": "Task"}
	if err := applyDispatchPack(args, "codex", "codex_create"); err != nil {
		t.Fatal(err)
	}
	if got := text(args, "prompt"); got != "Task\n\n<arc-pack name=\"valid-name\" hash=\""+want+"\">\nLine one\nLine two\n</arc-pack>" {
		t.Fatalf("dispatch prompt = %q", got)
	}
}

func TestDispatchCodexCatalogUsesNativeMetadata(t *testing.T) {
	// Contract: dispatch catalog model display fields and explicit provider identity.
	row := dispatchCodexModel(object{"model": "opaque-id", "displayName": "Native model", "provider": object{"id": "native", "name": "Native provider"},
		"contextWindow": 200000, "serviceTiers": []any{object{"id": "priority"}}, "supportedReasoningEfforts": []any{object{"reasoningEffort": "high"}}})
	if row["model"] != "opaque-id" || row["displayName"] != "Native model" || field(row["provider"], "id") != "native" || row["contextWindow"] != 200000 ||
		wire(row["efforts"]) != `["high"]` || field(arr(row["serviceTiers"])[0], "id") != "priority" {
		t.Fatalf("native model = %v", row)
	}
	absent := dispatchCodexModel(object{"model": "openai/gpt-128k"})
	if absent["provider"] != nil || absent["displayName"] != nil || absent["contextWindow"] != nil {
		t.Fatalf("metadata inferred from model ID = %v", absent)
	}
}
