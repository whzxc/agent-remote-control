package core

import (
	"strings"
	"testing"
)

func TestTrackedClaudeTranscriptKeepsToolsAndTitle(t *testing.T) {
	// Contract: Claude history keeps native text and tool results while excluding injected transcript records.
	at := "2026-02-01T00:00:00.000Z"
	timeline := trackedTestTimeline()
	records := []any{
		object{"type": "user", "uuid": "meta", "timestamp": at, "isMeta": true, "message": object{"role": "user", "content": "Internal reminder"}},
		object{"type": "user", "uuid": "prompt", "timestamp": at, "message": object{"role": "user", "content": "<system-reminder>internal reminder</system-reminder>Inspect fixture [image #1]"}},
		object{"type": "assistant", "uuid": "tool", "timestamp": at, "message": object{"role": "assistant", "model": "native-model", "stop_reason": "tool_use", "content": []any{object{"type": "tool_use", "id": "command", "name": "Bash", "input": object{"command": "echo synthetic"}}}}},
		object{"type": "user", "uuid": "result", "timestamp": at, "message": object{"role": "user", "content": []any{object{"type": "tool_result", "tool_use_id": "command", "content": "Exit code: 0\nsynthetic"}}}},
		object{"type": "assistant", "uuid": "reply", "timestamp": at, "message": object{"role": "assistant", "stop_reason": "end_turn", "content": "Finished."}},
	}
	timeline.backfillClaude(records)
	if timeline.promptHeadline() != "Inspect fixture" || timeline.Status != "completed" || timeline.transcriptActive() {
		t.Fatalf("transcript = %v", timeline.response("fixture", 0))
	}
	_, command := timeline.existing("command")
	if command["type"] != "command" || command["status"] != "completed" || uintOr(command["exitCode"], 1) != 0 {
		t.Fatalf("command = %v", command)
	}
	if strings.Contains(wire(timeline.response("fixture", 0)), "internal reminder") {
		t.Fatal("harness-only text escaped")
	}
}

func TestTrackedClaudeTranscriptProjectsTimedFileAndFailedCommand(t *testing.T) {
	// Algorithmic core: Claude tool results join native calls and preserve file completion timing.
	const start, end = "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:01.000Z"
	timeline := trackedTestTimeline()
	timeline.backfillClaude([]any{
		object{"uuid": "request", "timestamp": start, "message": object{"role": "user", "content": "Read example"}},
		object{"uuid": "tools", "timestamp": start, "message": object{"role": "assistant", "content": []any{
			object{"type": "thinking", "thinking": "Checking example"},
			object{"type": "tool_use", "id": "read", "name": "Read", "input": object{"file_path": "src/example.go"}},
			object{"type": "tool_use", "id": "command", "name": "Bash", "input": object{"command": "printf example"}},
		}}},
		object{"uuid": "results", "timestamp": end, "message": object{"role": "user", "content": []any{
			object{"type": "tool_result", "tool_use_id": "read", "content": "Example contents"},
			object{"type": "tool_result", "tool_use_id": "command", "content": "Error", "is_error": true},
		}}},
		object{"uuid": "answer", "timestamp": end, "message": object{"role": "assistant", "content": "Done"}},
	})
	rows := timeline.response("fixture", 0)["entries"].([]object)
	if len(rows) != 5 || rows[0]["type"] != "user" || rows[1]["type"] != "thinking" ||
		rows[2]["type"] != "file" || rows[2]["operation"] != "read" || rows[2]["status"] != "completed" ||
		field(rows[2]["output"], "text") != "Example contents" || rows[2]["startedAt"] != start || rows[2]["endedAt"] != end ||
		rows[3]["type"] != "command" || rows[3]["status"] != "failed" || timeline.executionEvidence() == "partial" {
		t.Fatalf("Claude timeline = %v", rows)
	}
}
