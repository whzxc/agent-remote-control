package core

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

const agentOutputLimit = 256 << 10

type nativeAgentProcess struct {
	mu, writeMu, dispatch sync.Mutex
	driver                nativeAgentDriver
	task                  object
	events                nativeEvents
	host                  *taskHostClient
	child                 *exec.Cmd
	input                 io.WriteCloser
	cancel                context.CancelFunc
	done, changed         chan struct{}
	calls                 map[string]chan rpcResult
	pending               map[string]object
	activePrompt          string
	attachmentSession     string
	settled               chan struct{}
}

var useFixtureAgentTransport bool

func saveNativeAgentTask(task object) error {
	path, err := nativeAgentTaskPath(text(task, "taskId"))
	if err != nil {
		return err
	}
	return saveCoordinationOwner(path, task, "agent")
}

func agentOutputTail(output string) (string, bool) {
	if len(output) <= agentOutputLimit {
		return output, false
	}
	data := output[len(output)-agentOutputLimit:]
	for len(data) != 0 && !utf8.RuneStart(data[0]) {
		data = data[1:]
	}
	return data, true
}

func recordAgentStdoutDiagnostic(prior object, data []byte) object {
	line := redactTaskOutput(decodeCommandOutput(data))
	end := min(1024, len(line))
	for end < len(line) && !utf8.RuneStart(line[end]) {
		end--
	}
	lines := append(arr(prior["lines"]), line[:end])
	count := uintOr(prior["skippedLines"], 0)
	if count != ^uint64(0) {
		count++
	}
	result := object{"lines": lines, "skippedLines": count, "truncated": prior["truncated"] == true || end < len(line)}
	for len(lines) > 32 || len(wire(result)) > 4096 {
		lines = lines[1:]
		result["lines"], result["truncated"] = lines, true
	}
	return result
}

func agentStdoutReadError(err error) error {
	if err.Error() == "FRAME_TOO_LARGE" {
		return errors.New("AGENT_STDOUT_FRAME_TOO_LARGE: A stdout line exceeded 32 MiB. Configure the Agent to split protocol output into smaller messages, then reconcile the task before resuming.")
	}
	return fmt.Errorf("AGENT_STDOUT_READ_FAILED: %s. Inspect the Agent process and logs, then reconcile the task before resuming.", redactTaskOutput(err.Error()))
}

func agentExitDiagnostic(reason string, diagnostics object) string {
	if uintOr(diagnostics["skippedLines"], 0) == 0 {
		return reason
	}
	return reason + " Recent non-JSON stdout (redacted, bounded): " + wire(diagnostics)
}

func (p *nativeAgentProcess) appendOutput(value string, replace bool) {
	if !replace {
		value = text(p.task, "output") + value
	}
	output, truncated := agentOutputTail(value)
	p.task["output"] = output
	p.task["outputTruncated"] = truncated || !replace && p.task["outputTruncated"] == true
}

func (p *nativeAgentProcess) persistLocked() error {
	p.task["updatedAt"] = now()
	interactions := make([]object, 0, len(p.pending))
	for _, key := range keysObjectMap(p.pending) {
		interactions = append(interactions, p.pending[key])
	}
	p.task["pendingInteractions"] = interactions
	p.events.Lock()
	if timeline := p.events.taskTimelines[text(p.task, "taskId")]; timeline != nil {
		var tracking object
		_ = decodeObject([]byte(wire(timeline)), &tracking)
		p.task["tracking"] = tracking
	}
	p.events.Unlock()
	close(p.changed)
	p.changed = make(chan struct{})
	if err := saveNativeAgentTask(p.task); err != nil {
		return err
	}
	status := text(p.task, "status")
	if status == "waiting-permission" || status == "unknown" || notificationTerminal(status) {
		wakeNotificationThread(text(p.task, "taskId"))
	}
	return nil
}

func (p *nativeAgentProcess) checkpoint(edit func(object)) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	edit(p.task)
	return p.persistLocked()
}

func (p *nativeAgentProcess) snapshot() object {
	p.mu.Lock()
	defer p.mu.Unlock()
	return clone(p.task)
}

func (p *nativeAgentProcess) signal() <-chan struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.changed
}

func (p *nativeAgentProcess) frame(ctx context.Context, frame object) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if p.host != nil {
		return p.host.write(ctx, frame, p.checkpoint)
	}
	if p.input == nil {
		return errors.New("AGENT_PROCESS_CLOSED")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	input := p.input
	stop := context.AfterFunc(ctx, func() { _ = input.Close() })
	defer stop()
	return outputLine(input, wire(frame))
}

func (p *nativeAgentProcess) request(ctx context.Context, method string, params object, timeout time.Duration) (object, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	key := id()
	response := make(chan rpcResult, 1)
	p.mu.Lock()
	p.calls[wire(key)] = response
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		delete(p.calls, wire(key))
		p.mu.Unlock()
	}()
	frame := object{"jsonrpc": "2.0", "id": key, "method": method, "params": params}
	if p.driver.id == "pi" {
		frame = object{"id": key, "type": method}
		for key, value := range params {
			frame[key] = value
		}
	}
	if err := p.frame(ctx, frame); err != nil {
		return nil, err
	}
	select {
	case reply := <-response:
		return obj(reply.value), reply.err
	case <-ctx.Done():
		return nil, fmt.Errorf("AGENT_REQUEST_TIMEOUT: %s", method)
	case <-p.done:
		return nil, errors.New("AGENT_PROCESS_CLOSED")
	}
}

func (p *nativeAgentProcess) settle(evidence turnEvidence, detail any) {
	if evidence.terminal.outcome == 0 {
		return
	}
	applyAgentTurn(p.task, evidence)
	p.task["error"] = detail
	p.events.observe(text(p.task, "taskId"), "arc/settled", object{"status": p.task["status"], "error": detail, "turnId": p.task["turnId"]})
	clear(p.pending)
	p.activePrompt = ""
	if p.settled != nil {
		close(p.settled)
		p.settled = nil
	}
}

func (p *nativeAgentProcess) consumeLocked(frame object) {
	if frame == nil {
		return
	}
	id := frame["id"]
	method := str(dispatchFirstString(frame["method"], frame["event"], frame["type"]))
	if result := p.calls[wire(id)]; result != nil && frame["method"] == nil {
		delete(p.calls, wire(id))
		value := frame["result"]
		var err error
		if frame["error"] != nil {
			err = errors.New("AGENT_RPC_REJECTED:" + wire(frame["error"]))
		} else if p.driver.id == "pi" {
			value = frame["data"]
			if frame["success"] != true {
				err = errors.New("AGENT_RPC_REJECTED:" + wire(frame))
			}
		}
		result <- rpcResult{value: value, err: err}
		return
	}
	task := p.task
	if id != nil && id == p.activePrompt && (method == "" || frame["type"] == "response") {
		if p.host != nil {
			dispatchSetSection(task, "taskHost")["promptResponded"] = true
		}
	}
	taskID := text(task, "taskId")
	key := agentTurnKey(task)
	terminal := turnEvidence{}
	var failure any
	switch {
	case p.driver.id == "antigravity":
		switch method {
		case "init":
			if native := text(frame, "conversation_id"); native != "" {
				task["sessionId"] = native
			}
			task["nativeSession"] = frame["init"]
		case "step_update":
			step := obj(frame["step_update"])
			if step["step_type"] == "agent_response" {
				p.appendOutput(text(step, "text_delta"), false)
			}
			if step["state"] == "ERROR" {
				task["toolErrors"] = append(arr(task["toolErrors"]), step)
			}
		case "result":
			result := obj(frame["result"])
			if native := text(result, "conversation_id"); native != "" {
				task["sessionId"] = native
			}
			if response := text(result, "response"); response != "" {
				p.appendOutput(response, true)
			}
			if denied := arr(result["denied_actions"]); denied != nil {
				task["deniedActions"] = denied
			}
			terminal = antigravityResultTurn(key, result)
			if terminal.terminal.outcome == turnFailed {
				failure = result["error"]
			}
			task["stopReason"] = result["finished_reason"]
		}
	case method == "session/update":
		update := field(frame["params"], "update")
		if field(update, "sessionUpdate") == "agent_message_chunk" && field(field(update, "content"), "type") == "text" {
			p.appendOutput(text(field(update, "content"), "text"), false)
		}
		if field(frame["params"], "sessionId") == task["sessionId"] {
			switch field(update, "sessionUpdate") {
			case "config_option_update":
				if _, ok := field(update, "configOptions").([]any); ok {
					dispatchSetSection(task, "metadata")["configOptions"] = field(update, "configOptions")
					task["configurationObservedAt"] = now()
				}
			case "current_mode_update":
				if mode := field(update, "currentModeId"); mode != nil {
					dispatchSetSection(dispatchSetSection(task, "metadata"), "modes")["currentModeId"] = mode
					task["configurationObservedAt"] = now()
				}
			case "usage_update":
				task["contextUsage"] = object{"kind": "context-occupancy", "source": "acp-usage-update", "used": field(update, "used"), "size": field(update, "size"), "observedAt": now()}
			}
		}
	case method == "session/request_permission" || method == "extension_ui_request":
		if method == "session/request_permission" {
			p.events.Lock()
			if timeline := p.events.taskTimelines[taskID]; timeline != nil {
				timeline.enrichPermission(frame)
			}
			p.events.Unlock()
		}
		if id != nil && !agentTurnTerminal(task) {
			request := clone(frame)
			request["turnId"] = task["turnId"]
			p.pending[wire(id)] = request
			observeAgentOwner(task, "waiting-permission")
		}
	case p.driver.id == "pi":
		if method == "message_end" {
			message := obj(frame["message"])
			if message["role"] == "assistant" {
				task["lastMessage"] = message
			}
		}
		if method == "message_update" && field(frame["assistantMessageEvent"], "type") == "text_delta" {
			p.appendOutput(text(frame["assistantMessageEvent"], "delta"), false)
		}
		if method == "agent_settled" {
			terminal = piSettledTurn(key, text(task["lastMessage"], "stopReason"))
			failure = field(task["lastMessage"], "errorMessage")
		} else if id == p.activePrompt {
			terminal = piPromptTurn(key, frame)
			failure = frame["error"]
		}
	case id != nil && id == p.activePrompt:
		terminal = acpResponseTurn(key, frame)
		failure, task["stopReason"] = frame["error"], field(frame["result"], "stopReason")
	}
	if method != "" {
		p.events.observe(taskID, method, frame)
	}
	if terminal.terminal.outcome != 0 {
		p.settle(terminal, failure)
	}
}

func (p *nativeAgentProcess) consumeStdoutLocked(data []byte) {
	data = bytes.TrimSpace(data)
	if len(data) == 0 {
		return
	}
	var frame object
	if decodeObject(data, &frame) == nil && frame != nil {
		p.consumeLocked(frame)
		return
	}
	p.task["stdoutDiagnostics"] = recordAgentStdoutDiagnostic(obj(p.task["stdoutDiagnostics"]), data)
}

func (p *nativeAgentProcess) exited(issue error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if agentTurnActive(p.task) {
		observeAgentLoss(p.task)
		p.events.observe(text(p.task, "taskId"), "arc/settled", object{"status": "unknown", "turnId": p.task["turnId"]})
	}
	p.task["processState"] = "exited"
	if p.task["error"] == nil && p.task["status"] == "unknown" {
		reason := "PROCESS_EXIT_UNCONFIRMED"
		if issue != nil {
			reason = redactTaskOutput(issue.Error())
		}
		p.task["error"] = agentExitDiagnostic(reason, obj(p.task["stdoutDiagnostics"]))
		p.events.observe(text(p.task, "taskId"), "error", object{"message": p.task["error"]})
	}
	if err := p.persistLocked(); err != nil {
		recordLog("WARN", "Agent task exit persistence: "+err.Error(), nil)
	}
	if p.settled != nil {
		close(p.settled)
		p.settled = nil
	}
}

func (p *nativeAgentProcess) runDirect(reader *os.File) {
	defer close(p.done)
	defer reader.Close()
	var issue error
	frames := bufio.NewReader(reader)
	for {
		data, err := readProtocolLine(frames, taskHostMaxFrame)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				issue = agentStdoutReadError(err)
				platform.SignalTree(p.child.Process.Pid, true)
			}
			break
		}
		if err := p.checkpoint(func(object) { p.consumeStdoutLocked(data) }); err != nil {
			recordLog("WARN", "Agent task persistence: "+err.Error(), nil)
		}
	}
	if err := p.child.Wait(); issue == nil {
		issue = err
	}
	p.exited(issue)
}

func (p *nativeAgentProcess) runHosted(ctx context.Context) {
	defer close(p.done)
	var reader taskHostJournalReader
	index := p.host.index
	path := text(index, "journalPath")
	after := uintOr(field(p.snapshot()["taskHost"], "ackedOffset"), 0)
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		active := p.host.alive()
		rows, err := reader.read(ctx, path, after)
		if err != nil {
			if ctx.Err() == nil {
				p.exited(err)
			}
			return
		}
		recoverReceipt := false
		for _, row := range rows {
			after = uintOr(row["offset"], after)
			if err := p.checkpoint(func(task object) {
				state := dispatchSetSection(task, "taskHost")
				state["ackedOffset"] = after
				switch row["kind"] {
				case "stdout":
					p.consumeStdoutLocked([]byte(text(row, "frame")))
					recoverReceipt = recoverReceipt || state["promptResponded"] == true || agentTurnTerminal(task)
				case "write":
					sequence := field(row["frame"], "sequence")
					state["receivedSequence"] = max(uintOr(state["receivedSequence"], 0), uintOr(sequence, 0))
					if field(state["unconfirmedWrite"], "sequence") == sequence {
						delete(state, "unconfirmedWrite")
					}
					value := field(row["frame"], "value")
					if field(value, "method") == "session/prompt" || field(value, "type") == "prompt" {
						if valueID := text(value, "id"); valueID != "" {
							state["promptId"], state["promptSequence"], state["promptResponded"] = valueID, sequence, false
							p.activePrompt = valueID
						}
						dispatchSetSection(task, "dispatch")["submission"] = "accepted"
					}
					if requestID := field(value, "id"); requestID != nil && (field(value, "result") != nil || field(value, "error") != nil || field(value, "type") == "extension_ui_response") {
						delete(p.pending, wire(requestID))
						if len(p.pending) == 0 && task["status"] == "waiting-permission" {
							observeAgentOwner(task, "running")
						}
					}
				}
			}); err != nil {
				recordLog("WARN", "Agent journal checkpoint: "+err.Error(), nil)
				return
			}
		}
		if recoverReceipt && p.attachmentSession != "" {
			p.recoverHostedReceipt(ctx)
		}
		if !active {
			var issue error
			exit := p.host.exit()
			if exit == nil {
				issue = errors.New("TASK_HOST_LOST: no exit record; reconcile the task before resuming")
			} else {
				if detail := text(exit, "error"); detail != "" {
					issue = errors.New(detail)
				}
				_ = p.checkpoint(func(task object) { task["exitCode"] = exit["exitCode"] })
			}
			p.exited(issue)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (p *nativeAgentProcess) recoverHostedReceipt(ctx context.Context) {
	task := p.snapshot()
	host := obj(task["taskHost"])
	request := text(host, "requestId")
	prompt, known := uintValue(host["promptSequence"])
	if request == "" || !known || prompt == 0 || prompt > uintOr(host["receivedSequence"], 0) ||
		!agentTurnTerminal(task) && (p.driver.id != "pi" || host["promptResponded"] != true) {
		return
	}
	store := agentReceiptStore()
	path, err := store.path(request)
	if err != nil {
		return
	}
	unlock := lockReceipt(request)
	defer unlock()
	value, err := cachedLoadInContext(ctx, path)
	if err != nil {
		return
	}
	row := obj(value)
	if row["backendSession"] == p.attachmentSession || row["taskId"] != task["taskId"] ||
		row["agent"] != task["agent"] || row["turnId"] != task["turnId"] {
		return
	}
	switch row["state"] {
	case "reserved", "executing", "unconfirmed":
		row["state"], row["result"], row["error"] = "completed", task, nil
		if err := store.checkpoint(ctx, row); err != nil {
			recordLog("WARN", "Agent receipt recovery: "+err.Error(), nil)
		}
	}
}

func newNativeAgentProcess(driver nativeAgentDriver, task object) *nativeAgentProcess {
	p := &nativeAgentProcess{driver: driver, task: clone(task), events: nativeEvents{durable: true},
		done: make(chan struct{}), changed: make(chan struct{}), calls: map[string]chan rpcResult{}, pending: map[string]object{}}
	taskID := text(task, "taskId")
	if saved := obj(task["tracking"]); saved != nil {
		var tracking taskTimeline
		if unmarshalJSON([]byte(wire(saved)), &tracking) == nil {
			p.events.taskTimelines = map[string]*taskTimeline{taskID: &tracking}
		}
	}
	timeline := p.events.taskTrackingTimeline(taskID)
	timeline.Info = object{"id": taskID, "agent": task["agent"], "title": task["title"], "project": task["cwd"], "startedAt": task["createdAt"]}
	return p
}

func (p *nativeAgentProcess) launch(ctx context.Context, command *exec.Cmd, gate *launches) error {
	if !useFixtureAgentTransport {
		host, err := launchTaskHost(ctx, command, p.task, gate)
		if err == nil {
			p.host = host
			run, cancel := context.WithCancel(context.Background())
			p.cancel = cancel
			if err := p.checkpoint(func(state object) { state["taskHost"] = host.index }); err != nil {
				cancel()
				_ = host.close(context.Background())
				return err
			}
			go p.runHosted(run)
			return nil
		}
		if ctx.Err() != nil || err.Error() == "CORE_SHUTTING_DOWN" {
			return err
		}
		recordLog("WARN", "Detached task host unavailable; using Core-owned Agent transport: "+err.Error(), nil)
	}
	command.Stderr = nil
	platform.ConfigureCommand(command)
	platform.OwnChild(command)
	input, err := command.StdinPipe()
	if err != nil {
		return err
	}
	reader, stdout, err := os.Pipe()
	if err != nil {
		input.Close()
		return err
	}
	defer stdout.Close()
	command.Stdout = stdout
	if err := gate.run(func() error { return startOwnedChild(command) }); err != nil {
		reader.Close()
		input.Close()
		return err
	}
	p.child, p.input = command, input
	go p.runDirect(reader)
	return nil
}

func (p *nativeAgentProcess) initialize(ctx context.Context, resume bool) error {
	base := p.snapshot()
	var metadata object
	var capabilities any
	var serverNames []any
	switch p.driver.id {
	case "antigravity":
		metadata = nativeAntigravityFacts(base, "launch-flags")
		capabilities = object{"protocol": "antigravity-stream-json", "resume": true, "cancel": true,
			"streaming": true, "permissions": "headless-auto-deny", "completionEvent": "result"}
	case "pi":
		state, err := p.request(ctx, "get_state", object{}, 15*time.Second)
		if err != nil {
			return err
		}
		metadata = state
		capabilities = object{"protocol": "pi-rpc", "resume": true, "cancel": true,
			"streaming": true, "permissions": "extension-ui-only", "completionEvent": "agent_settled"}
	default:
		client := object{"session": object{"notices": object{}, "compaction": object{}}}
		if p.driver.id == "cursor" {
			client["_meta"] = object{"parameterizedModelPicker": true}
		}
		init, err := p.request(ctx, "initialize", object{"protocolVersion": 1, "clientCapabilities": client,
			"clientInfo": object{"name": "agent-remote-control", "version": buildVersion}}, 15*time.Second)
		if err != nil {
			return err
		}
		if uintOr(init["protocolVersion"], 0) != 1 {
			return errors.New("ACP_VERSION_UNSUPPORTED")
		}
		capabilities = init
		if p.driver.id == "cursor" && find(arr(init["authMethods"]), "id", "cursor_login") != nil {
			if _, err := p.request(ctx, "authenticate", object{"methodId": "cursor_login"}, 15*time.Second); err != nil {
				return err
			}
		}
		servers, err := nativeACPServers(p.driver.id)
		if err != nil {
			return err
		}
		serverNames = []any{}
		for _, server := range servers {
			serverNames = append(serverNames, server["name"])
		}
		params := object{"cwd": base["cwd"], "mcpServers": servers}
		method := "session/new"
		if resume {
			if field(init["agentCapabilities"], "loadSession") != true {
				return errors.New("RESUME_UNSUPPORTED")
			}
			method = "session/load"
			params["sessionId"] = base["sessionId"]
		}
		metadata, err = p.request(ctx, method, params, time.Minute)
		if err != nil {
			return err
		}
		init["session"] = metadata
		if !resume && text(metadata, "sessionId") == "" {
			return errors.New("MISSING_SESSION_ID")
		}
	}
	if err := p.checkpoint(func(task object) {
		task["metadata"], task["capabilities"], task["configurationObservedAt"] = metadata, capabilities, now()
		if session := text(metadata, "sessionId"); session != "" {
			task["sessionId"] = session
		}
		if serverNames != nil {
			task["mcpServers"] = serverNames
		}
		if !resume {
			task["status"] = "idle"
		}
		task["processState"] = "running"
	}); err != nil {
		return err
	}
	state := p.snapshot()
	if p.driver.id != "pi" {
		if _, err := nativeAgentSessionFacts(ctx, state, p); err != nil {
			recordLog("WARN", "Agent catalog: "+err.Error(), nil)
		}
	}
	return nil
}

func (p *nativeAgentProcess) close(ctx context.Context) error {
	if p.host != nil {
		_ = p.host.close(ctx)
	} else {
		p.writeMu.Lock()
		if p.input != nil {
			_ = p.input.Close()
			p.input = nil
		}
		p.writeMu.Unlock()
	}
	select {
	case <-p.done:
		return nil
	case <-time.After(2 * time.Second):
	case <-ctx.Done():
	}
	if p.host != nil {
		stopTaskHostIndex(context.WithoutCancel(ctx), p.host)
	} else if p.child != nil && p.child.Process != nil {
		platform.SignalTree(p.child.Process.Pid, true)
	}
	select {
	case <-p.done:
		return nil
	case <-time.After(3 * time.Second):
		return errors.New("AGENT_OUTPUT_DRAIN_FAILED")
	}
}

func (p *nativeAgentProcess) interrupt(ctx context.Context) error {
	select {
	case <-p.done:
		return errors.New("AGENT_PROCESS_CLOSED")
	default:
	}
	switch p.driver.id {
	case "pi":
		_, err := p.request(ctx, "abort", object{}, 5*time.Second)
		return err
	case "antigravity":
		if p.host != nil {
			return p.host.signal(ctx, false)
		}
		signalTaskHostAgent(p.child.Process.Pid, false)
		return nil
	default:
		return p.frame(ctx, object{"jsonrpc": "2.0", "method": "session/cancel", "params": object{"sessionId": p.snapshot()["sessionId"]}})
	}
}

func agentSettledOutput(task object) (string, bool) {
	if agentTurnTerminal(task) {
		return strings.TrimPrefix(text(task, "output"), "\ufeff"), true
	}
	return "", false
}
