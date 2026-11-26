package core

import (
	"strings"
	"testing"
)

func trackedTestTimeline() *taskTimeline {
	return &taskTimeline{Info: object{"id": "fixture", "agent": "codex", "project": "/synthetic/project"}}
}

func TestTrackedTerminalHistorySurvivesLateWritesAndRestart(t *testing.T) {
	// Recurring bug class: lifecycle late native items and a running snapshot cannot reopen a recorded terminal turn.
	at := "2026-02-01T00:00:00.000Z"
	for _, terminal := range []string{"completed", "failed", "cancelled"} {
		timeline := trackedTestTimeline()
		timeline.codex("turn/started", object{"turn": object{"id": "turn"}}, at)
		timeline.codex("item/started", object{"turnId": "turn", "item": object{"id": "command", "type": "commandExecution"}}, at)
		baseline, observed := timeline.Revision, timeline.ObservedEvents
		timeline.codex("item/commandExecution/outputDelta", object{"turnId": "turn", "itemId": "command", "delta": "native output"}, at)
		history := object{"id": "fixture", "turns": []any{object{"id": "turn", "status": terminal, "items": []any{
			object{"id": "command", "type": "commandExecution", "aggregatedOutput": "stale output"}, object{"id": "historical", "type": "agentMessage", "text": "Retained response"},
		}}}}
		timeline.backfillCodex(history, nil, nil, baseline, observed, at)
		timeline.codex("turn/started", object{"turn": object{"id": "turn"}}, at)
		timeline.codex("item/started", object{"turnId": "turn", "item": object{"id": "late", "type": "commandExecution", "command": "true"}}, at)
		var restored taskTimeline
		if err := unmarshalJSON([]byte(wire(timeline)), &restored); err != nil {
			t.Fatal(err)
		}
		restored.loseObservation()
		if restored.turnStatus("turn") != terminal {
			t.Fatalf("restored terminal = %s", restored.turnStatus("turn"))
		}
		_, late := restored.existing("late")
		if late["status"] != "unknown" {
			t.Fatalf("late tool = %v", late)
		}
		_, command := restored.existing("command")
		if field(command["output"], "text") != "native output" {
			t.Fatalf("in-flight output = %v", command)
		}
		_, historical := restored.existing("historical")
		if historical["startedAt"] != nil || historical["endedAt"] != nil {
			t.Fatalf("history fabricated observation times: %v", historical)
		}
	}
}

func TestTrackedInteractionsStayWithTheirNativeTurnAndBackend(t *testing.T) {
	// Recurring bug class: lifecycle late input and reused native request IDs must stay scoped to their original turns.
	at := "2026-02-01T00:00:00.000Z"
	timeline := trackedTestTimeline()
	timeline.codex("turn/started", object{"turn": object{"id": "first"}}, at)
	timeline.finish("completed", at)
	timeline.codex("turn/started", object{"turn": object{"id": "second"}}, at)
	old := object{"id": 7, "method": "item/tool/requestUserInput", "params": object{"turnId": "first", "question": "Pick a value"}}
	timeline.syncInteractions([]object{old}, at)
	if _, row := timeline.existing("interaction:7"); row != nil {
		t.Fatal("closed turn restored to pending input")
	}
	active := clone(old)
	obj(active["params"])["turnId"] = "second"
	active["next"] = object{"op": "codex_respond", "args": object{"requestId": "response-token"}}
	timeline.syncInteractions([]object{active}, at)
	response := object{"resolvedAt": at, "answeredBy": object{"kind": "source", "sourceId": "fixture-reader"}}
	timeline.answered(active, response)
	for _, session := range []string{"backend-one", "backend-two"} {
		old["backendSession"] = session
		timeline.answered(old, response)
	}
	if len(timeline.Entries) != 3 {
		t.Fatalf("answer identities collapsed: %v", timeline.Entries)
	}
	for _, row := range timeline.Entries {
		if row["status"] != "completed" || field(field(row["response"], "answeredBy"), "sourceId") != "fixture-reader" {
			t.Fatalf("response attribution = %v", row)
		}
		if row["turnId"] == "second" && field(field(row["interaction"], "respond"), "op") != "codex_respond" {
			t.Fatalf("reply handle = %v", row)
		}
	}
}

func TestTrackedApprovalRestoresRunningCommandPhase(t *testing.T) {
	// Recurring bug class: lifecycle completed approval and late file updates must preserve the in-flight command phase.
	timeline := trackedTestTimeline()
	at := "2026-02-01T00:00:00.000Z"
	timeline.codex("turn/started", object{"turn": object{"id": "turn"}}, at)
	timeline.codexItem(object{"id": "command", "type": "commandExecution", "command": "printf synthetic"}, "running", at)
	req := object{"id": "approval", "method": "commandApproval", "params": object{"turnId": "turn", "itemId": "command"}}
	timeline.syncInteractions([]object{req}, at)
	if state := timeline.session("fixture", timeline.Info, "codex-thread", nil); state["phase"] != "interaction" {
		t.Fatalf("phase = %v", state)
	}
	timeline.resolve("approval", at)
	timeline.codexItem(object{"id": "file", "type": "fileChange", "changes": []any{object{"path": "file.go", "kind": object{"type": "add"}}}}, "completed", at)
	state := timeline.session("fixture", timeline.Info, "codex-thread", nil)
	if state["phase"] != "command" || state["phaseSince"] != at || state["headline"] != "printf synthetic" {
		t.Fatalf("phase = %v", state)
	}
}

func TestTrackedToolsPreferNativeExitCode(t *testing.T) {
	// Algorithmic core: only explicit exit markers or typed output evidence can determine a command exit code.
	for _, sample := range []struct {
		raw   any
		text  string
		want  int64
		found bool
	}{
		{nil, "build succeeded", 0, false},
		{nil, "prefix Exit code: 3", 0, false},
		{nil, "Process exited with code 3\nExit code: -2", -2, true},
		{object{"details": object{"exit_code": 4}}, "Exit code: 0", 4, true},
	} {
		code, ok := taskExitCode(sample.raw, sample.text)
		if ok != sample.found || code != sample.want {
			t.Fatalf("exit code for %q = %d, %v", sample.text, code, ok)
		}
	}
	timeline := trackedTestTimeline()
	timeline.tool(object{"toolCallId": "command", "title": "bash", "rawOutput": object{"exitCode": 8}}, "start")
	timeline.tool(object{"toolCallId": "command", "content": "Exit code: 0"}, "end")
	_, row := timeline.existing("command")
	if uintOr(row["exitCode"], 0) != 8 || row["exitCodeSource"] != "rawOutput" {
		t.Fatalf("command = %v", row)
	}
}

func TestTrackedOutputRedactsBeforeSummarizingAndAcrossEvents(t *testing.T) {
	// Recurring bug class: security secrets split across native chunks or a summary boundary cannot survive projection.
	timeline := trackedTestTimeline()
	prefix := strings.Repeat("x", 1002)
	timeline.tool(object{"toolCallId": "cmd", "title": "bash", "rawOutput": prefix + " Bearer synthetictestcredential"}, "start")
	timeline.delta("text", "text", "prefix Bearer synthetic", "start")
	timeline.delta("text", "text", "testcredential suffix", "end")
	wire := wire(timeline.response("fixture", 0))
	if strings.Contains(wire, "synthetictestcredential") || strings.Contains(wire, "Bearer synthetic") || !strings.Contains(wire, "[REDACTED]") {
		t.Fatalf("unredacted timeline = %s", wire)
	}
	if _, ok := taskExitCode(nil, "Exit code: 2 extra"); ok {
		t.Fatal("inexact output accepted as exit evidence")
	}
}

func TestTrackedWindowAndSharedEventEvictionExposePartialCoverage(t *testing.T) {
	// Recurring bug class: persistence a bounded or evicted observation marks only affected timelines partial.
	timeline := trackedTestTimeline()
	large := strings.Repeat("a", taskMaxText+64)
	timeline.delta("large", "text", large, "start")
	if timeline.executionEvidence() != "partial" {
		t.Fatal("text truncation retained complete coverage")
	}
	var restored taskTimeline
	if err := unmarshalJSON([]byte(wire(timeline)), &restored); err != nil {
		t.Fatal(err)
	}
	if field(restored.response("fixture", 0)["coverage"], "truncated") != true {
		t.Fatal("truncation lost across persistence")
	}
	events := &nativeEvents{}
	first, second := events.taskTrackingTimeline("first"), events.taskTrackingTimeline("second")
	second.HistoryLoaded = true
	events.observe("backend", "item/started", object{"threadId": "first", "turnId": "turn", "item": object{"id": "item", "type": "agentMessage", "text": "first"}})
	events.observe("backend", "item/started", object{"threadId": "second", "turnId": "turn", "item": object{"id": "item", "type": "agentMessage", "text": "second"}})
	for range taskMaxEntries {
		events.observe("backend", "synthetic/topic", object{})
	}
	if !first.Partial || second.Partial {
		t.Fatalf("eviction coverage = %v/%v", first.Partial, second.Partial)
	}
}

func TestTrackedPiACPAndNativeItemsKeepStableRows(t *testing.T) {
	// Contract: native stream and final record projections use the same item identities and preserve typed responses.
	timeline := trackedTestTimeline()
	timeline.agent("arc/user", object{"turnId": "turn", "text": "Inspect fixture"}, "start")
	timeline.agent("message_update", object{"assistantMessageEvent": object{"type": "text_delta", "delta": "streamed", "contentIndex": 0}}, "step")
	timeline.agent("message_end", object{"message": object{"role": "assistant", "content": []any{object{"type": "text", "text": "final"}}}}, "step")
	timeline.agent("tool_execution_start", object{"toolCallId": "read", "toolName": "read", "args": object{"path": "fixture.go"}}, "step")
	timeline.agent("tool_execution_end", object{"toolCallId": "read", "result": object{"content": []any{object{"text": "file contents"}}}}, "step")
	timeline.agent("session/update", object{"params": object{"update": object{"sessionUpdate": "agent_thought_chunk", "content": object{"text": "ACP thought"}}}}, "step")
	timeline.agent("agent_settled", object{}, "end")
	_, message := timeline.existing("turn:pi:0:0")
	_, read := timeline.existing("read")
	if timeline.Status != "completed" || message["text"] != "final" || read["type"] != "file" || field(read["output"], "text") != "file contents" {
		t.Fatalf("native rows = %v", timeline.response("fixture", 0))
	}
	base := timeline.Revision
	timeline.codexItem(object{"id": "file", "type": "fileChange", "changes": []any{object{"path": "fixture.go", "kind": object{"type": "update"}, "diff": "@@ -1 +1 @@\n-old\n+new\n"}}}, "completed", "end")
	result := timeline.response("fixture", base)
	if len(result["entries"].([]object)) != 1 || len(timeline.evidence(new("turn"))) != 2 {
		t.Fatalf("typed evidence = %v", result)
	}
}
