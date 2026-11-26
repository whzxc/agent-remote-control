package core

import (
	"strings"
	"testing"
)

func TestTrackedAntigravityResultCompletesTheStreamedAnswer(t *testing.T) {
	// Contract: a native result replaces the streamed answer in place and retains sanitized permission evidence.
	at := "2026-02-01T00:00:00.000Z"
	timeline := trackedTestTimeline()
	timeline.Turn = "turn"
	timeline.antigravity("step_update", object{"step_update": object{"step_type": "agent_response", "step_index": 1, "text_delta": "Draft", "state": "RUNNING"}}, at)
	result := object{"response": "Final answer", "denied_actions": []any{object{"path": "fixture", "apiKey": "private-fixture-value"}}}
	timeline.antigravity("result", object{"result": result}, at)
	rows := timeline.response("fixture", 0)["entries"].([]object)
	if len(rows) != 2 || rows[0]["text"] != "Final answer" || rows[0]["phase"] != "final_answer" || rows[0]["status"] != "completed" {
		t.Fatalf("result entries = %v", rows)
	}
	if rows[1]["type"] != "error" || !strings.Contains(text(rows[1], "text"), "Permission denied") || strings.Contains(wire(rows), "private-fixture-value") {
		t.Fatalf("permission evidence = %v", rows[1])
	}
}
