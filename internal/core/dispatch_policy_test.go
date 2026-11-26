package core

import (
	"strings"
	"testing"
	"time"
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

func TestDispatchLocalReviewUndoRequiresExactPass(t *testing.T) {
	// Contract: local review undo requires the persisted ARC pass receipt.
	local := object{"review": object{"requestId": "request", "verdict": "pass", "reviewer": object{"controlSource": "ARC"}}}
	if !dispatchLocalReviewMatches([]object{local}, "request") || dispatchLocalReviewMatches(nil, "request") ||
		dispatchLocalReviewMatches([]object{local}, "different") {
		t.Fatal("local review identity did not constrain undo")
	}
	other := clone(local)
	obj(field(other["review"], "reviewer"))["controlSource"] = "external"
	if dispatchLocalReviewMatches([]object{local, other}, "request") {
		t.Fatal("external verdict was eligible for undo")
	}
	obj(local["review"])["verdict"] = "rework"
	if dispatchLocalReviewMatches([]object{local}, "request") {
		t.Fatal("rework verdict was eligible for undo")
	}
}

func TestDispatchReviewConfigurationUsesNativeEvidenceInOrder(t *testing.T) {
	// Algorithmic core: turn-level metadata supplies each known field independently.
	config := dispatchReviewConfiguration(object{"model": "turn-model", "effort": "high", "serviceTier": "unknown"},
		object{"model": "thread-model", "effort": "low", "serviceTier": "priority"})
	if config["model"] != "turn-model" || config["effort"] != "high" || config["serviceTier"] != "priority" {
		t.Fatalf("configuration = %v", config)
	}
	config = dispatchReviewConfiguration(object{})
	if config["model"] != nil || config["effort"] != nil || config["serviceTier"] != nil {
		t.Fatalf("missing configuration = %v", config)
	}
}

func TestDispatchHistoryUsesAuthoritativeOutcomeAndPreservesPackCoverage(t *testing.T) {
	// Contract: dispatch history keeps native outcomes separate from external reviews and self-tests.
	at := time.Now()
	prev := dispatchLifecycleOutcome
	t.Cleanup(func() { dispatchLifecycleOutcome = prev })
	dispatchLifecycleOutcome = func(row object) string {
		if observed := text(row["_turnLifecycle"], "outcome"); observed != "" {
			return observed
		}
		return text(row["terminal"], "state")
	}
	row := object{"agent": "codex", "threadId": "thread", "turnId": "arc", "dispatchMode": "new-turn", "submittedAt": at.Format(time.RFC3339Nano),
		"model": "model", "effort": "high", "serviceTier": "priority", "options": object{}, "review": object{"verdict": "pass"},
		"terminal": object{"state": "failed", "observedDurationMs": 60000}, "_turnLifecycle": object{"outcome": "completed"}, "pack": object{"name": "class"}}
	external := clone(row)
	external["turnId"], external["dispatchOrigin"] = "external", "external"
	external["review"] = object{"verdict": "rework", "reviewedAt": at.Format(time.RFC3339Nano)}
	selfTest := clone(row)
	selfTest["turnId"], selfTest["purpose"] = "self", "self-test"
	rows := []object{row, external, selfTest}
	history := summarizeDispatchHistory(rows, "codex", false, at.Add(-time.Hour))
	groups := arr(history["groups"])
	if len(groups) != 1 {
		t.Fatalf("configuration groups = %v", groups)
	}
	g := obj(groups[0])
	if uintOr(g["dispatches"], 0) != 1 || uintOr(g["pass"], 0) != 1 || uintOr(g["failed"], 1) != 0 ||
		uintOr(g["durationSamples"], 0) != 1 || uintOr(field(g["external"], "rework"), 0) != 1 {
		t.Fatalf("group = %v", g)
	}
	if line := summarizeDispatchPacks(rows, at.Add(-time.Hour))["class"]; line != "n1 med1.0m pass1 rework0 unrev0" {
		t.Fatalf("pack history = %s", line)
	}
}

func TestReconciledDispatchTimingUsesNativeActivityInsteadOfDowntime(t *testing.T) {
	// Algorithmic core: restart reconciliation uses actual terminal or last activity time for duration.
	row := object{"submittedAt": "2026-01-01T00:00:00Z"}
	native := dispatchTerminalSnapshot(row, "completed", object{"endedAt": "2026-01-01T00:01:00Z"}, "2026-01-01T00:02:00Z", true)
	if native["timeBasis"] != "native-terminal" || uintOr(native["observedDurationMs"], 0) != 60000 {
		t.Fatalf("native terminal = %v", native)
	}
	last := dispatchTerminalSnapshot(row, "completed", nil, "2026-01-01T00:02:00Z", true)
	if last["timeBasis"] != "last-observed-activity" || uintOr(last["observedDurationMs"], 0) != 120000 {
		t.Fatalf("last activity = %v", last)
	}
	unknown := dispatchTerminalSnapshot(row, "completed", nil, "", true)
	if unknown["timeBasis"] != "unknown" || unknown["observedDurationMs"] != nil {
		t.Fatalf("unknown timing = %v", unknown)
	}
}
