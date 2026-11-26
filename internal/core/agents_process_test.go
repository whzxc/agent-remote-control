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
		if err := process.checkpoint(func(object) { process.consumeStdoutLocked([]byte(frame)) }); err != nil {
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
