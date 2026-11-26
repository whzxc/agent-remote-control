package core

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestDispatchReviewsPreserveARCAndExternalProvenance(t *testing.T) {
	// Contract: ARC reviews retain the original dispatch receipt and external reviews expose native configuration.
	args := object{"verdict": "rework", "note": "Check failed", "requestId": "review-request"}
	origin := object{"sourceId": "source-id", "controlSource": "claude", "sessionId": "session", "target": "target"}
	arc := dispatchReviewRecord(args, origin, object{"requestId": "dispatch-request"}, nil, "timestamp")
	if arc["verdict"] != args["verdict"] || arc["note"] != args["note"] || arc["requestId"] != args["requestId"] ||
		arc["reviewedAt"] != "timestamp" || arc["dispatchOrigin"] != "arc" || arc["dispatchRequestId"] != "dispatch-request" ||
		wire(arc["reviewer"]) != wire(origin) {
		t.Fatalf("ARC review = %v", arc)
	}
	external := dispatchReviewRecord(args, origin, nil, object{"model": "model", "effort": "high"}, "timestamp")
	if external["dispatchOrigin"] != "external" || external["dispatchRequestId"] != nil || external["model"] != "model" ||
		external["effort"] != "high" || external["serviceTier"] != nil {
		t.Fatalf("external review = %v", external)
	}
}

func TestDispatchReviewsRequireNativeTerminalTurns(t *testing.T) {
	// Recurring bug class: lifecycle a review could select a running or missing turn or borrow a newer turn's configuration.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	core := &service{metadata: object{"instance": id()}}
	transport := nativeControlRequest
	t.Cleanup(func() { nativeControlRequest = transport })
	defer core.close()
	turns := []any{object{"id": "running", "status": "inProgress"}, object{"id": "done", "status": "completed"}}
	nativeControlRequest = func(_ context.Context, _ *service, method string, _ any, _ time.Duration) (any, error) {
		switch method {
		case "thread/turns/list":
			return object{"data": turns}, nil
		case "thread/read":
			return object{"thread": object{"model": "native-model"}}, nil
		default:
			return nil, fmt.Errorf("unexpected native method: %s", method)
		}
	}
	for _, example := range []struct {
		requested any
		selection string
		failure   string
	}{
		{nil, "done", ""}, {"missing", "", "REVIEW_TERMINAL_TURN_NOT_FOUND"},
		{"running", "", "REVIEW_REQUIRES_TERMINAL_TURN"},
	} {
		args := object{"threadId": id(), "verdict": "pass"}
		if example.requested != nil {
			args["turnId"] = example.requested
		}
		value, err := dispatchCodexReview(t.Context(), operationRequest{name: "codex_review", args: args, service: core})
		if err != nil {
			t.Fatal(err)
		}
		receipt := obj(value)
		if example.failure == "" {
			if receipt["state"] != "completed" || field(receipt["result"], "turnId") != example.selection {
				t.Fatalf("selected receipt = %v", receipt)
			}
		} else if receipt["state"] != "failed" || !strings.Contains(text(outcomeError(receipt), "message"), example.failure) {
			t.Fatalf("rejected review = %v", receipt)
		}
	}
	task := id()
	snapshot := object{"agent": "example", "turnId": "latest", "status": "completed", "model": "model", "options": object{"effort": "high"},
		"tracking": object{"turnStatuses": object{"older": "completed"}, "turnTimings": object{"older": object{"endedAt": "2026-01-01T00:00:00Z"}}}}
	for _, turn := range []string{"latest", "older"} {
		result, err := reviewAgentDispatch(t.Context(), object{"agent": "example", "taskId": task, "turnId": turn, "verdict": "pass"}, snapshot)
		review := obj(result["review"])
		if err != nil || review["dispatchOrigin"] != "external" ||
			turn == "latest" && (review["model"] != "model" || review["effort"] != "high") ||
			turn == "older" && review["model"] != nil {
			t.Fatalf("review for %s = %v, %v", turn, result, err)
		}
	}
	snapshot["status"] = "running"
	for turn, want := range map[string]string{"latest": "REVIEW_REQUIRES_TERMINAL_TURN", "missing": "REVIEW_TERMINAL_TURN_NOT_FOUND"} {
		_, err := reviewAgentDispatch(t.Context(), object{"agent": "example", "taskId": id(), "turnId": turn, "verdict": "pass"}, snapshot)
		if err == nil || err.Error() != want {
			t.Fatalf("review for %s = %v", turn, err)
		}
	}
}

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
	row := object{"agent": "codex", "threadId": "thread", "turnId": "arc", "dispatchMode": "new-turn", "submittedAt": at.Format(time.RFC3339Nano),
		"model": "model", "effort": "high", "serviceTier": "priority", "options": object{}, "review": object{"verdict": "pass"},
		"terminal": object{"state": "failed", "observedDurationMs": 60000}, "pack": object{"name": "class"}}
	row["_turnLifecycle"] = turnSnapshot(turnKey{"codex", "thread", "arc"}, "completed", nil).checkpoint()
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
	unreviewed := clone(row)
	unreviewed["agent"], unreviewed["submission"] = "pi", "accepted"
	unreviewed["_turnLifecycle"] = turnSnapshot(turnKey{"pi", "thread", "arc"}, "completed", nil).checkpoint()
	delete(unreviewed, "review")
	history = summarizeDispatchHistory([]object{unreviewed}, "pi", false, at.Add(-time.Hour))
	groups = arr(history["groups"])
	if len(groups) != 1 || uintOr(field(groups[0], "failed"), 1) != 0 || uintOr(field(groups[0], "interrupted"), 1) != 0 ||
		uintOr(field(groups[0], "durationSamples"), 0) != 1 ||
		uintOr(field(field(field(history, "quality"), "unreviewedCompletions"), "count"), 0) != 1 {
		t.Fatalf("unreviewed completion history = %v", history)
	}
	if line := summarizeDispatchPacks([]object{unreviewed}, at.Add(-time.Hour))["class"]; strings.Contains(line, "fail") {
		t.Fatalf("pack counted the stale failure: %s", line)
	}
}

func TestDispatchHistoryDeduplicatesExternalReviewsWithoutCountingDurations(t *testing.T) {
	// Contract: external reviews contribute once to the configuration group and never to ARC duration samples.
	at := time.Now()
	stamp := at.Format(time.RFC3339Nano)
	arc := object{"agent": "codex", "threadId": "thread", "turnId": "arc", "dispatchMode": "new-turn", "submittedAt": stamp,
		"model": "model", "effort": "high", "serviceTier": "priority", "options": object{}, "review": object{"verdict": "pass"},
		"terminal": object{"state": "completed", "observedDurationMs": 60000}}
	external := clone(arc)
	external["turnId"], external["dispatchOrigin"] = "external", "external"
	external["review"] = object{"verdict": "rework", "reviewedAt": stamp}
	external["terminal"] = object{"state": "failed", "observedDurationMs": 1}
	unknown, other := clone(external), clone(external)
	unknown["turnId"], unknown["effort"] = "unknown", nil
	other["turnId"], other["model"] = "other", "another-model"
	rows := []object{arc, external, clone(external), unknown, other}
	cutoff := at.Add(-time.Hour)
	groups := arr(summarizeDispatchHistory(rows, "codex", false, cutoff)["groups"])
	if len(groups) != 2 {
		t.Fatalf("external configuration groups = %v", groups)
	}
	group := find(groups, "model", "model")
	if uintOr(group["dispatches"], 0) != 1 || uintOr(group["pass"], 0) != 1 || uintOr(group["failed"], 1) != 0 ||
		uintOr(group["unreviewed"], 1) != 0 || uintOr(group["rework"], 1) != 0 ||
		group["medianObservedDurationMs"] != float64(60000) || uintOr(group["durationSamples"], 0) != 1 ||
		wire(group["external"]) != wire(object{"reviews": 1, "pass": 0, "rework": 1}) {
		t.Fatalf("external reviews altered the primary group: %v", group)
	}
	compact := arr(summarizeDispatchHistory(rows, "codex", true, cutoff)["groups"])
	group = find(compact, "model", "other")
	if uintOr(field(group["external"], "reviews"), 0) != 2 || uintOr(group["durationSamples"], 0) != 1 {
		t.Fatalf("compact external reviews = %v", compact)
	}
	arc["purpose"] = "self-test"
	if got := arr(summarizeDispatchHistory([]object{arc}, "codex", false, cutoff)["groups"]); len(got) != 0 {
		t.Fatalf("self-test polluted history: %v", got)
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
