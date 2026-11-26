package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

func TestAgentStdoutDiagnosticsKeepBoundedRedactedEvidence(t *testing.T) {
	// Recurring bug class: security subprocess diagnostics stay bounded and redact sensitive output.
	var diagnostics object
	for range 100 {
		diagnostics = recordAgentStdoutDiagnostic(diagnostics, []byte(strings.Repeat("credential password=fixture-secret 界\n", 100)))
	}
	if uintOr(diagnostics["skippedLines"], 0) != 100 || diagnostics["truncated"] != true || len(wire(diagnostics)) > 4096 {
		t.Fatalf("diagnostic bounds failed: %s", wire(diagnostics))
	}
	exit := agentExitDiagnostic("PROCESS_EXIT_UNCONFIRMED", diagnostics)
	if strings.Contains(exit, "fixture-secret") || !strings.Contains(exit, "credential") {
		t.Fatalf("exit diagnostic exposed or lost evidence: %q", exit)
	}
	read := agentStdoutReadError(&fixtureStdoutError{}).Error()
	if !strings.HasPrefix(read, "AGENT_STDOUT_READ_FAILED:") || strings.Contains(read, "fixture-secret") {
		t.Fatalf("unexpected stdout error: %q", read)
	}
}

type fixtureStdoutError struct{}

func (*fixtureStdoutError) Error() string { return "broken pipe password=fixture-secret" }

func isolateAgentProcessState(t *testing.T) {
	t.Helper()
	t.Setenv("ARC_STATE_DIR", t.TempDir())
}

func TestDetachedAgentJournalRebuildsPermissionAndTerminalReceipt(t *testing.T) {
	// Recurring bug class: lifecycle replay after Core exit retains permission state and can settle the original receipt.
	isolateAgentProcessState(t)
	const turn = "turn"
	taskID, requestID := id(), id()
	pid := os.Getpid()
	start := platform.ProcessStart(pid)
	if start == "" {
		t.Skip("Process identity is unavailable")
	}
	journal := filepath.Join(t.TempDir(), "journal.jsonl")
	writeActivityRollout(t, journal, object{"kind": "stdout", "offset": 1, "frame": wire(object{"id": "approval",
		"method": "session/request_permission", "params": object{"options": []any{object{"optionId": "allow", "kind": "allow_once"}}}})})
	index := object{"hostPid": pid, "hostStart": start, "hostProtocol": taskHostProtocol + 1, "journalPath": journal,
		"ackedOffset": 0, "requestId": requestID, "promptId": "prompt", "promptSequence": 1}
	task := object{"taskId": taskID, "agent": "dsh", "status": "running", "turnId": turn, "output": "", "taskHost": index}
	driver := nativeAgentDriver{id: "dsh", protocol: "acp-v1"}
	first := newNativeAgentProcess(driver, task)
	first.host = newTaskHostClient(index)
	first.activePrompt = "prompt"
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Second)
	defer cancel()
	attached, stop := context.WithCancel(ctx)
	defer stop()
	go first.runHosted(attached)
	defer func() { stop(); <-first.done }()
	for {
		changed := first.signal()
		task = first.snapshot()
		if task["status"] == "waiting-permission" {
			break
		}
		select {
		case <-changed:
		case <-first.done:
			t.Fatalf("journal reader exited: %s", wire(task))
		case <-ctx.Done():
			t.Fatalf("permission was not restored: %s", wire(task))
		}
	}
	if first := arr(task["pendingInteractions"]); len(first) != 1 || field(first[0], "id") != "approval" {
		t.Fatalf("replayed interactions = %s", wire(first))
	}
	if err := first.frame(ctx, object{"id": "prompt", "method": "session/prompt"}); err == nil || !strings.HasPrefix(err.Error(), "TASK_HOST_DRAIN_ONLY:") {
		t.Fatalf("unknown host protocol admitted a write: %v", err)
	}
	stop()
	<-first.done

	writeActivityRollout(t, journal,
		object{"kind": "write", "offset": 2, "frame": object{"sequence": 1, "value": object{"id": "approval", "result": object{"outcome": "selected"}}}},
		object{"kind": "stdout", "offset": 3, "frame": wire(object{"method": "session/update", "params": object{"update": object{
			"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "finished"}}}})},
		object{"kind": "stdout", "offset": 4, "frame": wire(object{"id": "prompt", "result": object{"stopReason": "end_turn"}})})
	if err := save(filepath.Join(filepath.Dir(journal), "exit.json"), object{"exitCode": 0, "receivedSequence": 1, "nextOffset": 5}); err != nil {
		t.Fatal(err)
	}
	if err := agentReceiptStore().reserve(ctx, object{"requestId": requestID, "taskId": taskID, "agent": "dsh", "turnId": turn,
		"operation": "agent_send", "backendSession": "previous-core", "state": "unconfirmed", "updatedAt": now()}); err != nil {
		t.Fatal(err)
	}
	index = obj(task["taskHost"])
	index["hostPid"], index["hostProtocol"] = 0, taskHostProtocol
	recovered := newNativeAgentProcess(driver, task)
	recovered.host, recovered.activePrompt, recovered.attachmentSession = newTaskHostClient(index), "prompt", "replacement-core"
	for _, interaction := range arr(task["pendingInteractions"]) {
		recovered.pending[wire(field(interaction, "id"))] = obj(interaction)
	}
	recovered.runHosted(ctx)
	state := recovered.snapshot()
	if state["status"] != "completed" || state["output"] != "finished" || len(arr(state["pendingInteractions"])) != 0 ||
		uintOr(field(state["taskHost"], "ackedOffset"), 0) != 4 || uintOr(state["exitCode"], 100) != 0 {
		t.Fatalf("recovered task = %s", wire(state))
	}
	receipt, err := agentReceiptStore().read(requestID, "replacement-core")
	if err != nil || receipt["state"] != "completed" || field(receipt["result"], "output") != "finished" {
		t.Fatalf("recovered receipt = %s, %v", wire(receipt), err)
	}
}

func TestAgentStdoutKeepsReadingPastNoiseAndRetainsAbnormalExit(t *testing.T) {
	// Contract: Agent stdout JSON-lines protocol tolerates startup noise and retains explicit process failure evidence.
	isolateAgentProcessState(t)
	taskID := id()
	process := newNativeAgentProcess(nativeAgentDriver{id: "dsh", protocol: "acp-v1"},
		object{"taskId": taskID, "agent": "dsh", "turnId": "turn", "status": "running"})
	for _, frame := range []string{
		"startup password=fixture-secret",
		"[fixture] catalog",
		wire(object{"method": "session/update", "params": object{"update": object{"sessionUpdate": "agent_message_chunk",
			"content": object{"type": "text", "text": "after-noise"}}}}),
	} {
		process.mu.Lock()
		err := process.checkpointStdoutLocked([]byte(frame))
		process.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
	}
	if state := process.snapshot(); state["output"] != "after-noise" || uintOr(field(state["stdoutDiagnostics"], "skippedLines"), 0) != 2 {
		t.Fatalf("stdout checkpoint = %s", wire(state))
	}
	process.exited(errors.New("fixture process exited 7"))
	state, err := (&service{}).nativeAgentTask("dsh", taskID)
	if err != nil || field(state, "status") != "unknown" || field(state, "output") != "after-noise" ||
		!strings.Contains(text(state, "error"), "startup") || strings.Contains(wire(state), "fixture-secret") {
		t.Fatalf("exit checkpoint = %s, %v", wire(state), err)
	}
}

func TestAgentContentDeltasKeepJournalProgressWithTheSavedSnapshot(t *testing.T) {
	// Recurring bug class: persistence a structural checkpoint commits the buffered Agent output and journal offset together.
	isolateAgentProcessState(t)
	taskID := id()
	disk := &service{}
	process := newNativeAgentProcess(nativeAgentDriver{id: "dsh", protocol: "acp-v1"},
		object{"taskId": taskID, "agent": "dsh", "turnId": "turn", "status": "running", "taskHost": object{"ackedOffset": 0}})
	defer process.flushStreamCheckpoint()
	if err := process.checkpoint(func(object) {}); err != nil {
		t.Fatal(err)
	}

	process.mu.Lock()
	obj(process.task["taskHost"])["ackedOffset"] = 1
	deltaErr := process.checkpointStdoutLocked([]byte(wire(object{"method": "session/update", "params": object{"update": object{
		"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "streamed"},
	}}})))
	previous, readErr := disk.nativeAgentTask("dsh", taskID)
	obj(process.task["taskHost"])["ackedOffset"] = 2
	structuralErr := process.checkpointStdoutLocked([]byte(wire(object{"method": "session/request_permission", "id": "permission"})))
	process.mu.Unlock()
	if deltaErr != nil || readErr != nil || structuralErr != nil {
		t.Fatalf("checkpoints: delta=%v read=%v structural=%v", deltaErr, readErr, structuralErr)
	}
	if uintOr(field(previous["taskHost"], "ackedOffset"), 3) != 0 {
		t.Fatalf("streamed offset advanced separately from its checkpoint: %s", wire(previous))
	}
	current, err := disk.nativeAgentTask("dsh", taskID)
	if err != nil || current["output"] != "streamed" || current["status"] != "waiting-permission" ||
		uintOr(field(current["taskHost"], "ackedOffset"), 0) != 2 {
		t.Fatalf("structural checkpoint = %s, %v", wire(current), err)
	}
}

func TestPiChoiceUsesNativeSubtypeAndKeepsInvalidChoicesPending(t *testing.T) {
	// Contract: Pi extension UI uses type for the request frame and method for the response value.
	isolateAgentProcessState(t)
	process := newNativeAgentProcess(nativeAgentDriver{id: "pi", protocol: "pi-rpc"},
		object{"taskId": id(), "agent": "pi", "turnId": "turn", "processSession": "owner", "status": "running"})
	var output agentTestOutput
	process.input = &output
	request := object{"type": "extension_ui_request", "method": "select", "id": "choice", "options": []any{"allow", "cancel"}}
	if err := process.checkpoint(func(object) { process.consumeLocked(request) }); err != nil {
		t.Fatal(err)
	}
	rows, err := nativeAgentInteractions(process.snapshot())
	if err != nil || len(rows) != 1 || field(rows[0], "backendSession") != "owner" || field(rows[0], "interactionId") != "choice" {
		t.Fatalf("pending choices = %s, %v", wire(rows), err)
	}
	if err := respondNativeAgentInteraction(t.Context(), process, obj(rows[0]), object{"value": "missing"}); err == nil || err.Error() != "INVALID_OPTION" || output.Len() != 0 {
		t.Fatalf("invalid choice wrote %q and returned %v", output.String(), err)
	}
	if err := respondNativeAgentInteraction(t.Context(), process, obj(rows[0]), object{"value": "allow"}); err != nil {
		t.Fatal(err)
	}
	var sent object
	if err := decodeObject([]byte(output.String()), &sent); err != nil || sent["type"] != "extension_ui_response" || sent["id"] != "choice" || sent["value"] != "allow" {
		t.Fatalf("native response = %q, %v", output.String(), err)
	}
	if state := process.snapshot(); len(decodedTaskList(state["pendingInteractions"])) != 0 || state["status"] != "running" {
		t.Fatalf("answered choice = %s", wire(state))
	}
}

type agentTestOutput struct{ strings.Builder }

func (*agentTestOutput) Close() error { return nil }
