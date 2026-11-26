package core

import "testing"

func TestCodexTaskListStatusUsesNativeEvidence(t *testing.T) {
	// Recurring bug class: lifecycle compact lists retain the selected terminal turn without reporting the idle thread as active.
	thread := object{"id": "t", "name": "Title", "cwd": "/project", "preview": "large prompt", "status": object{"type": "idle"}, "model": "m"}
	turn := object{"id": "turn", "status": "completed"}
	row := compactCodexListEntry(thread, thread, turn, true, object{"status": "scheduled"}, object{"pending": 2}, "", false)
	if row["status"] != "completed" || row["runtimeStatus"] != "idle" || field(row["currentTurn"], "status") != "completed" ||
		field(row["queue"], "pending") != 2 || field(row["retry"], "status") != "scheduled" || row["preview"] != nil {
		t.Fatalf("compact native task = %v", row)
	}
	full := compactCodexListEntry(thread, thread, turn, false, nil, nil, "timeout", true)
	if full["preview"] != "large prompt" || full["status"] != "completed" || full["runtimeStatus"] != "unknown" ||
		field(full["currentTurn"], "source") != "persisted-history" {
		t.Fatalf("full degraded native task = %v", full)
	}
}
