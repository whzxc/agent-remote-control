package core

import "testing"

func TestControlCatalogOperationsResolveToRegisteredHandlers(t *testing.T) {
	// Contract: every published control operation is implemented in the dispatcher, including inline guide discovery.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	for _, spec := range guideSpecs() {
		name := text(spec, "name")
		if name == "guide" {
			reply, err := egressToolValue(localControl(t.Context(), &service{}, requestSource{local: true, policy: "all"}, object{"op": name}))
			if err != nil || field(reply, "arcVersion") == nil {
				t.Fatalf("inline guide failed to resolve: %v, %v", reply, err)
			}
			continue
		}
		if registeredOperations[name].handle == nil && fallbackOperations[name] == nil {
			t.Errorf("catalog operation %s has no handler", name)
		}
	}
	for _, method := range []string{"events/list", "events/subscribe", "events/unsubscribe"} {
		if registeredMCPMethods[method] == nil {
			t.Errorf("advertised MCP event method %s has no handler", method)
		}
	}
}

func TestCodexTaskListStatusUsesNativeEvidence(t *testing.T) {
	// Recurring bug class: lifecycle compact lists retain the selected terminal turn without reporting the idle thread as active.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	thread := object{"id": id(), "name": "Title", "cwd": "/project", "preview": "large prompt", "status": object{"type": "idle"}, "model": "m"}
	turn := object{"id": id(), "status": "completed"}
	record := object{"threadId": thread["id"], "turnId": turn["id"], "requestId": id(),
		"task": object{"dispatch": object{"review": object{"verdict": "pass"}}}}
	if err := recordDispatch(record); err != nil {
		t.Fatal(err)
	}
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
	reviews := decodedTaskList(full["reviews"])
	dispatches := decodedTaskList(full["dispatches"])
	if len(reviews) != 1 || field(reviews[0], "turnId") != turn["id"] || field(field(reviews[0], "review"), "verdict") != "pass" ||
		len(dispatches) != 1 || field(dispatches[0], "requestId") != record["requestId"] {
		t.Fatalf("full native task history = %s", wire(full))
	}
}
