package core

import "fmt"

func (t *taskTimeline) antigravity(event string, msg any, at string) {
	if event == "step_update" {
		update := field(msg, "step_update")
		state := text(update, "state")
		if field(update, "step_type") == "agent_response" {
			id := fmt.Sprintf("%s:antigravity:step:%s", t.Turn, wire(field(update, "step_index")))
			if delta, ok := field(update, "text_delta").(string); ok {
				t.delta(id, "text", delta, at)
			}
			if _, row := t.existing(id); row != nil && (state == "DONE" || state == "ERROR") {
				delete(t.buffers, id)
				status := "completed"
				if state == "ERROR" {
					status = "failed"
				}
				t.put(t.entry(id, "text", status), at)
			}
		}
		if state == "ERROR" {
			t.failure(update, at)
		}
		return
	}
	result := field(msg, "result")
	if response := text(result, "response"); response != "" {
		id := t.Turn + ":antigravity:result"
		for index := len(t.Entries) - 1; index >= 0; index-- {
			row := t.Entries[index]
			if row["turnId"] == t.Turn && row["type"] == "text" {
				id = text(row, "id")
				break
			}
		}
		body, truncated := cutTaskText(redactTaskOutput(response), taskMaxText)
		delete(t.buffers, id)
		row := t.entry(id, "text", "completed")
		row["text"], row["truncated"], row["phase"] = body, truncated, "final_answer"
		t.put(row, at)
	}
	actions := arr(field(result, "denied_actions"))
	t.Partial = t.Partial || len(actions) > taskMaxEntries
	for index, action := range actions[:min(taskMaxEntries, len(actions))] {
		id := fmt.Sprintf("%s:antigravity:denied:%d", t.Turn, index)
		row := t.entry(id, "error", "failed")
		row["text"] = "Permission denied: " + text(summarizeTaskValue(action), "text")
		t.put(row, at)
	}
}
