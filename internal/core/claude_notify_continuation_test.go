package core

import (
	"strings"
	"testing"
)

func TestNativeContinuationRequiresCompleteProvenance(t *testing.T) {
	// Algorithmic core: resume provenance uses exact scoped native history and rejects user messages or malformed NDJSON.
	thread := object{"id": "thread", "cwd": "/fixture"}
	next := object{"id": "next", "status": "inProgress", "items": []any{}}
	history := func(trigger string, user any) string {
		rows := []any{
			object{"type": "session_meta", "payload": object{"id": "thread"}},
			object{"type": "event_msg", "payload": object{"type": "task_started", "turn_id": "previous", "started_at": 1}},
			object{"type": "event_msg", "payload": object{"type": "turn_aborted", "turn_id": "previous", "completed_at": 2}},
			object{"type": "response_item", "payload": object{"role": "user", "content": []any{object{"type": "input_text", "text": user}}}},
			object{"type": "event_msg", "payload": object{"type": "task_started", "turn_id": "next", "started_at": 100000, "turn_attribution": object{"turn_trigger": trigger}}},
			object{"type": "turn_context", "payload": object{"turn_id": "next", "cwd": "/fixture", "model": "fixture", "effort": "high", "service_tier": nil}},
		}
		var lines []string
		for _, r := range rows {
			lines = append(lines, wire(r))
		}
		return strings.Join(lines, "\n")
	}
	const env = "<environment_context>\nfixture\n</environment_context>"
	proven, err := notificationContinuationEvidence(thread, "previous", next, history("resume_interrupted_task", env))
	if err != nil || field(proven["retry"], "turnId") != "next" {
		t.Fatalf("native resume evidence = %v, %v", proven, err)
	}
	for _, c := range []struct{ trigger, input, reason string }{
		{"resume_interrupted_task", env + "\nnew request", "new-user-content"},
		{"native_other", env, "unknown-native-trigger"},
		{"capacity_retry_automatic", env, "outside-continuation-window"},
	} {
		decision, err := notificationContinuationEvidence(thread, "previous", next, history(c.trigger, c.input))
		if err != nil || decision["excluded"] != true || decision["reason"] != c.reason {
			t.Fatalf("provenance = %v, %v", decision, err)
		}
	}
	if _, err := notificationContinuationEvidence(thread, "previous", next, history("resume_interrupted_task", env)+"\n{"); err == nil {
		t.Fatal("malformed history was accepted")
	}
}
