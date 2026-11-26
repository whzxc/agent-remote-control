package core

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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
	notificationContext, _, flush, _ := notificationDeliveryFixture(t)
	const turn = "turn"
	taskID, requestID := id(), id()
	if err := bindNotification(notificationContext, object{"agent": "dsh",
		"notify": object{"channel": "claude-session", "target": notificationTestTarget}}, taskID, turn, "/fixture", nil); err != nil {
		t.Fatal(err)
	}
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
	disk := &service{}
	observation, err := observeNativeAgentNotification(notificationContext, disk, object{"agent": "dsh", "taskId": taskID, "threadId": taskID, "turnId": turn})
	if err != nil || observation["state"] != "completed" || observation["finalResponse"] != "finished" {
		t.Fatalf("recovered notification observation = %s, %v", wire(observation), err)
	}
	var eventID string
	for range 2 {
		if err := handleNotificationObservation(notificationContext, disk, taskID, turn, observation); err != nil {
			t.Fatal(err)
		}
		flush()
		result, err := readNotification(notificationContext, taskID, turn, "")
		completed := arr(result["deliveries"])
		if err != nil || len(completed) != 1 || field(completed[0], "kind") != "completed" || field(completed[0], "state") != "delivered" {
			t.Fatalf("recovered completion delivery = %s, %v", wire(result), err)
		}
		found := text(completed[0], "eventId")
		if found == "" || eventID != "" && found != eventID {
			t.Fatalf("replayed completion changed identity: %q → %q", eventID, found)
		}
		eventID = found
	}
}

func TestAgentStdoutKeepsReadingPastNoiseAndRetainsAbnormalExit(t *testing.T) {
	// Contract: Agent stdout JSON-lines protocol tolerates startup noise and retains explicit process failure evidence.
	if os.Getenv("ARC_TEST_GO_AGENT_STDOUT_CHILD") == "1" {
		fmt.Fprintln(os.Stdout, "startup password=fixture-secret")
		fmt.Fprintln(os.Stdout, "[fixture] catalog")
		fmt.Fprintln(os.Stdout, `{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"after-noise"}}}}`)
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(7)
	}
	isolateAgentProcessState(t)
	taskID := id()
	process := newNativeAgentProcess(nativeAgentDriver{id: "dsh", protocol: "acp-v1"},
		object{"taskId": taskID, "agent": "dsh", "turnId": "turn", "status": "running"})
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	process.child = exec.CommandContext(ctx, executable, "-test.run=^TestAgentStdoutKeepsReadingPastNoiseAndRetainsAbnormalExit$")
	process.child.Env = append(os.Environ(), "ARC_TEST_GO_AGENT_STDOUT_CHILD=1")
	stdin, err := process.child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	output, childOutput, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	defer childOutput.Close()
	process.child.Stdout = childOutput
	if err := process.child.Start(); err != nil {
		t.Fatal(err)
	}
	_ = childOutput.Close()
	go process.runDirect(output)
	defer func() { cancel(); <-process.done }()
	for {
		change := process.signal()
		if state := process.snapshot(); state["output"] == "after-noise" {
			if state["status"] != "running" || uintOr(field(state["stdoutDiagnostics"], "skippedLines"), 0) != 2 ||
				strings.Contains(wire(state["stdoutDiagnostics"]), "fixture-secret") {
				t.Fatalf("stdout before child exit = %s", wire(state))
			}
			break
		}
		select {
		case <-change:
		case <-ctx.Done():
			t.Fatal("subprocess stdout never advanced past startup noise")
		case <-process.done:
			t.Fatal("subprocess exited before its stdout could be observed")
		}
	}
	_ = stdin.Close()
	select {
	case <-process.done:
	case <-ctx.Done():
		t.Fatal("subprocess did not exit")
	}
	state, err := (&service{}).nativeAgentTask("dsh", taskID)
	entries := decodedTaskList(field(state["tracking"], "entries"))
	if err != nil || field(state, "status") != "unknown" || field(state, "output") != "after-noise" ||
		uintOr(state["exitCode"], 0) != 7 || !strings.Contains(text(state, "error"), "startup") ||
		strings.Contains(wire(state), "fixture-secret") || !slices.ContainsFunc(entries, func(row any) bool { return field(row, "type") == "error" }) {
		t.Fatalf("exit checkpoint = %s, %v", wire(state), err)
	}
}

func TestAgentContentDeltasKeepJournalProgressWithTheSavedSnapshot(t *testing.T) {
	// Recurring bug class: persistence a structural checkpoint commits the buffered Agent output and journal offset together.
	isolateAgentProcessState(t)
	acp := func(update string) object {
		return object{"method": "session/update", "params": object{"update": object{"sessionUpdate": update}}}
	}
	for _, update := range []string{"agent_message_chunk", "agent_thought_chunk"} {
		if !agentContentDelta("dsh", acp(update)) {
			t.Errorf("ACP delta %s needs a structural checkpoint", update)
		}
	}
	for _, update := range []string{"text_delta", "thinking_delta", "toolcall_delta"} {
		if !agentContentDelta("pi", object{"type": "message_update", "assistantMessageEvent": object{"type": update}}) {
			t.Errorf("Pi delta %s needs a structural checkpoint", update)
		}
	}
	for _, update := range []string{"tool_call", "tool_call_update", "plan", "usage_update", "config_option_update", "current_mode_update"} {
		if agentContentDelta("dsh", acp(update)) {
			t.Errorf("ACP structural update %s deferred its checkpoint", update)
		}
	}
	for _, method := range []string{"session/request_permission", "arc/user", "arc/settled", "arc/interaction-resolved", "error"} {
		if agentContentDelta("dsh", object{"method": method}) {
			t.Errorf("ACP structural method %s deferred its checkpoint", method)
		}
	}
	for _, event := range []string{"agent_start", "agent_settled", "message_end", "tool_execution_start", "tool_execution_end", "extension_ui_request", "error"} {
		if agentContentDelta("pi", object{"type": event}) {
			t.Errorf("Pi structural event %s deferred its checkpoint", event)
		}
	}
	for _, state := range []string{"ACTIVE", "DONE"} {
		frame := object{"event": "step_update", "step_update": object{"state": state}}
		if agentContentDelta("antigravity", frame) != (state == "ACTIVE") {
			t.Errorf("Antigravity %s checkpoint classification was wrong", state)
		}
	}
	option := object{"id": "model", "currentValue": "first"}
	configuration := object{"configOptions": []any{option}}
	task := object{"agent": "dsh", "metadata": configuration}
	currentConfig := func() any {
		return nativeAgentCatalogFacts(task, configuration, task["configurationObservedAt"], "acp-session", nil)["currentModel"]
	}
	task["output"], task["configurationObservedAt"] = "streamed", "later"
	if currentConfig() != "first" {
		t.Fatal("text and observation time changed the selected configuration")
	}
	option["currentValue"] = "second"
	if currentConfig() != "second" {
		t.Fatal("selected configuration did not follow the current option")
	}
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
	deltaErr := process.checkpointStdoutLocked(object{"method": "session/update", "params": object{"update": object{
		"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "streamed"},
	}}}, nil)
	previous, readErr := disk.nativeAgentTask("dsh", taskID)
	obj(process.task["taskHost"])["ackedOffset"] = 2
	structuralErr := process.checkpointStdoutLocked(object{"method": "session/request_permission", "id": "permission"}, nil)
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

func TestACPDeclinesUnadvertisedClientCapabilities(t *testing.T) {
	// Contract: an ACP peer gets a native method-not-found response for an unsupported client request.
	process := newNativeAgentProcess(nativeAgentDriver{id: "dsh", protocol: "acp-v1"}, object{"taskId": id()})
	var output agentTestOutput
	process.input = &output
	request := object{"id": "native-call", "method": "fs/read_text_file", "params": object{"path": "/fixture"}}
	if !process.rejectUnimplementedAgentRequest(t.Context(), request) {
		t.Fatal("unadvertised capability request was not handled")
	}
	var reply object
	if err := decodeObject([]byte(output.String()), &reply); err != nil || reply["id"] != "native-call" ||
		field(reply["error"], "code") != json.Number("-32601") || field(reply["error"], "message") != "Client capability not supported" {
		t.Fatalf("native rejection = %q, %v", output.String(), err)
	}
	for _, allowed := range []object{{"method": "session/update"}, {"id": "approval", "method": "session/request_permission"}} {
		if process.rejectUnimplementedAgentRequest(t.Context(), allowed) {
			t.Fatalf("supported or non-request frame was rejected: %s", wire(allowed))
		}
	}
}
