package core

import "testing"

func TestDesktopAsyncQuestionRetainsTerminalTurnUntilNativeReply(t *testing.T) {
	// Recurring bug class: lifecycle unanswered async questions keep their original terminal status and reconcile through the native transcript.
	old := object{"turnId": "old", "status": "completed", "items": []any{object{"id": "message", "type": "agentMessage",
		"questions": []any{object{"title": "Choose", "options": []any{"A", "B"}}}}}}
	next := object{"turnId": "new", "status": "inProgress", "items": []any{}}
	state := object{"id": "thread", "turnHistory": object{"history": object{"entitiesByKey": object{"old": old, "new": next}}}}
	requests := desktopPendingInteractions(state, "session")
	if len(requests) != 1 || requests[0]["owner"] != "desktop" || requests[0]["turnStatus"] != "completed" ||
		requests[0]["canRespond"] != true || field(requests[0]["params"], "turnId") != "old" {
		t.Fatal(wire(requests))
	}
	timeline := new(taskTimeline)
	timeline.codex("turn/started", object{"turn": object{"id": "old"}}, "2026-01-01T00:00:00Z")
	events := nativeEvents{pending: map[string]object{"question": requests[0]}, taskTimelines: map[string]*taskTimeline{"thread": timeline}}
	visible := events.pendingInteractions()
	if len(visible) != 1 || visible[0]["stale"] != true || visible[0]["canRespond"] != true ||
		field(visible[0]["params"], "turnId") != "old" {
		t.Fatal(wire(visible))
	}
	reply := wire([]any{object{"questionItemId": requests[0]["nativeId"], "answer": "A"}})
	next["items"] = []any{object{"type": "userMessage", "content": []any{object{"type": "text",
		"text": externalQuestionOpen + reply + externalQuestionClose}}}}
	if requests := desktopPendingInteractions(state, "session"); len(requests) != 0 {
		t.Fatal(wire(requests))
	}
}
