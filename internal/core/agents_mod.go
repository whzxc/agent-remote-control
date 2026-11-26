package core

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"
)

type nativeAgentHost struct {
	sync.Mutex
	running  map[string]*nativeAgentProcess
	launches launches
}

func (host *nativeAgentHost) process(task string) *nativeAgentProcess {
	host.Lock()
	defer host.Unlock()
	return host.running[task]
}

func (host *nativeAgentHost) publish(task string, p *nativeAgentProcess) {
	host.Lock()
	defer host.Unlock()
	if host.running == nil {
		host.running = map[string]*nativeAgentProcess{}
	}
	if p == nil {
		delete(host.running, task)
	} else {
		host.running[task] = p
	}
}

func (host *nativeAgentHost) processes() []*nativeAgentProcess {
	host.Lock()
	defer host.Unlock()
	return slices.Collect(maps.Values(host.running))
}

func (host *nativeAgentHost) close() {
	host.launches.close()
	var retained []object
	for _, process := range host.processes() {
		state := process.snapshot()
		if process.host != nil && process.host.alive() &&
			(agentTurnActive(state) || state["status"] == "unknown" || field(state["taskHost"], "unconfirmedWrite") != nil) {
			retained = append(retained, process.host.index)
			process.cancel()
			<-process.done
			continue
		}
		_ = process.close(context.Background())
	}
	stopUnattachedTaskHosts(context.Background(), retained)
}

func (s *service) nativeAgentTask(agent, taskID string) (object, error) {
	if process := s.agents.process(taskID); process != nil {
		state := process.snapshot()
		if agent != "" && state["agent"] != agent {
			return nil, errors.New("TASK_AGENT_MISMATCH")
		}
		return state, nil
	}
	path, err := nativeAgentTaskPath(taskID)
	if err != nil {
		return nil, err
	}
	value, err := cachedLoad(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("TASK_NOT_FOUND")
	}
	if err != nil {
		return nil, err
	}
	task := obj(value)
	if task == nil || task["taskId"] != taskID || agent != "" && task["agent"] != agent {
		return nil, errors.New("TASK_AGENT_MISMATCH")
	}
	return task, nil
}

func reloadNativeAgentHosts(ctx context.Context, s *service) error {
	for _, index := range taskHostIndexes() {
		client := newTaskHostClient(index)
		taskID := text(index, "taskId")
		if !client.alive() && client.exit() == nil || s.agents.process(taskID) != nil {
			continue
		}
		task, err := s.nativeAgentTask(text(index, "agent"), taskID)
		if err != nil || task["archived"] == true || task["processSession"] != index["processSession"] {
			continue
		}
		driver, ok := nativeAgentDriverByID(text(task, "agent"))
		if !ok {
			continue
		}
		checkpoint := obj(task["taskHost"])
		merged := clone(index)
		if checkpoint != nil && uintOr(checkpoint["hostPid"], 0) == uintOr(index["hostPid"], 0) && checkpoint["hostStart"] == index["hostStart"] {
			maps.Copy(merged, checkpoint)
		}
		task["taskHost"] = merged
		p := newNativeAgentProcess(driver, task)
		p.host = newTaskHostClient(merged)
		p.activePrompt = text(merged, "promptId")
		for _, interaction := range arr(task["pendingInteractions"]) {
			p.pending[wire(field(interaction, "id"))] = obj(interaction)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		run, cancel := context.WithCancel(context.Background())
		p.cancel = cancel
		s.agents.publish(taskID, p)
		go p.runHosted(run)
	}
	return nil
}

func (s *service) startNativeAgent(ctx context.Context, driver nativeAgentDriver, task object, resume bool) (*nativeAgentProcess, error) {
	key := text(task, "taskId")
	task["processSession"], task["processState"] = id(), "starting"
	delete(task, "taskHost")
	command, err := nativeAgentLaunchCommand(ctx, driver, task, resume)
	if err != nil {
		return nil, err
	}
	if err := saveNativeAgentTask(task); err != nil {
		return nil, err
	}
	p := newNativeAgentProcess(driver, task)
	if err := p.launch(ctx, command, &s.agents.launches); err != nil {
		task["processState"], task["error"] = "exited", err.Error()
		_ = saveNativeAgentTask(task)
		return nil, err
	}
	s.agents.publish(key, p)
	if err := p.initialize(ctx, resume); err != nil {
		_ = p.close(context.WithoutCancel(ctx))
		return nil, err
	}
	return p, nil
}

var nativeAgentPreferences sync.Mutex

func disabledNativeAgents() ([]any, error) {
	value, err := cachedLoad(filepath.Join(root(), "agents", "disabled.json"))
	if errors.Is(err, os.ErrNotExist) {
		return []any{}, nil
	}
	if err != nil {
		return nil, err
	}
	return arr(value), nil
}

func nativeAgentEnabled(agent string) (bool, error) {
	disabled, err := disabledNativeAgents()
	return !slices.Contains(disabled, any(agent)), err
}

func ensureNativeAgentEnabled(agent string) error {
	enabled, err := nativeAgentEnabled(agent)
	if err == nil && !enabled {
		err = errors.New("AGENT_DISABLED")
	}
	return err
}

func updateNativeAgentEnabled(body object) (object, error) {
	nativeAgentPreferences.Lock()
	defer nativeAgentPreferences.Unlock()
	agent := text(body, "agent")
	if _, exists := nativeAgentDriverByID(agent); !exists {
		return nil, errors.New("UNKNOWN_AGENT")
	}
	enabled, present := body["enabled"].(bool)
	if !present {
		return nil, errors.New("enabled boolean required")
	}
	disabled, err := disabledNativeAgents()
	if err != nil {
		return nil, err
	}
	disabled = slices.DeleteFunc(disabled, func(value any) bool { return value == agent })
	if !enabled {
		disabled = append(disabled, agent)
	}
	if err := save(filepath.Join(root(), "agents", "disabled.json"), disabled); err != nil {
		return nil, err
	}
	return object{"agent": agent, "enabled": enabled}, nil
}

func nativeAgentInventory(ctx context.Context, s *service, optionsOnly bool) (object, error) {
	disabled, err := disabledNativeAgents()
	if err != nil {
		return nil, err
	}
	rows := make([]object, len(nativeAgentDrivers))
	var ready sync.WaitGroup
	for i, driver := range nativeAgentDrivers {
		ready.Go(func() {
			found := nativeAgentDiscovery{}
			if driver.id == "codex" {
				binary, _, err := codexInputs()
				if !optionsOnly && err == nil {
					found.binary = binary
				}
				found.err = err
			} else if !optionsOnly {
				found = driver.discover(ctx)
			}
			protocol := driver.protocol
			if driver.id == "antigravity" && antigravityAgentAPI(found.binary) {
				protocol = antigravityDesktopProtocol
			}
			enabled := !slices.Contains(disabled, any(driver.id))
			installed := found.binary != ""
			row := object{"agent": driver.id, "id": driver.id, "name": driver.name, "displayName": driver.name, "protocol": protocol,
				"installed": installed, "enabled": enabled, "available": installed && enabled && found.err == nil,
				"version": dispatchFirstString(found.version), "capabilities": capabilitiesForAgent(driver.id)}
			if found.err != nil {
				row["discoveryError"] = found.err.Error()
			}
			rows[i] = row
		})
	}
	ready.Wait()
	return object{"agents": rows, "observedAt": now()}, nil
}

func nativeAgentPolicyFacts(ctx context.Context, s *service, args object) ([]object, error) {
	stock, err := nativeAgentInventory(ctx, s, false)
	if err != nil {
		return nil, err
	}
	var task object
	if id := text(args, "taskId"); id != "" {
		task, err = s.nativeAgentTask(text(args, "agent"), id)
		if err != nil {
			return nil, err
		}
	}
	result := []object{}
	for _, availability := range stock["agents"].([]object) {
		agent := text(availability, "agent")
		if selected := text(args, "agent"); selected != "" && agent != selected {
			continue
		}
		if args["all"] != true && args["agent"] == nil && availability["available"] != true {
			continue
		}
		row := object{"agent": agent, "availability": availability, "capabilities": object{}}
		if agent == "antigravity" {
			row["capabilities"] = nativeAntigravityFacts(task, "launch-flags")
		}
		result = append(result, row)
	}
	return result, nil
}

func runAgentMutation(ctx context.Context, r operationRequest, perform func(context.Context, operationRequest, object) (any, error)) (any, error) {
	args := clone(r.args)
	if slices.Contains([]string{"agent_create", "agent_send"}, r.name) {
		if err := normalizeNotification(args); err != nil {
			return nil, err
		}
	}
	if args["requestId"] == nil {
		args["requestId"] = id()
	}
	request, session := text(args, "requestId"), text(r.service.metadata, "instance")
	store := agentReceiptStore()
	unlock := lockReceipt(request)
	defer func() {
		if unlock != nil {
			unlock()
		}
	}()
	payload := maps.Clone(args)
	delete(payload, "waitMs")
	digest := hash([]byte(wire(object{"name": r.name, "args": payload})))
	if replay, err := store.replay(ctx, request, digest, session); err != nil || replay != nil {
		return replay, err
	}
	if slices.Contains([]string{"agent_create", "agent_send"}, r.name) {
		if err := applyDispatchPack(args, text(args, "agent"), r.name); err != nil {
			return nil, err
		}
	}
	origin, at := currentOrigin(ctx), now()
	row := object{"origin": origin, "requestId": request, "backendSession": session, "digest": digest, "operation": r.name,
		"agent": args["agent"], "arguments": args, "state": "reserved", "createdAt": at, "updatedAt": at}
	if args["taskId"] != nil {
		row["taskId"] = args["taskId"]
	}
	attachDispatchCaller(ctx, row)
	lifetime := r.service.jobs.begin()
	if lifetime == nil {
		return nil, errors.New("CORE_SHUTTING_DOWN: retry after Core restarts")
	}
	if err := store.reserve(ctx, row); err != nil {
		r.service.jobs.finish()
		return nil, err
	}
	unlock()
	unlock = nil
	wait := min(uintOr(args["waitMs"], 25000), 120000)
	return launchControlMutation(ctx, r.service, store, row, lifetime, wait, func(ctx context.Context, row object) (any, error) {
		return perform(ctx, r, row)
	})
}

func agentReceiptCheckpoint(ctx context.Context, row object, stage string) error {
	row["submissionStage"] = stage
	return agentReceiptStore().checkpoint(ctx, row)
}

func agentMutationArchived(task object) error {
	if task["archived"] == true {
		return dispatchObjectError(object{"code": "TASK_ARCHIVED",
			"message": "This task is archived. Use agent_read for retained evidence or agent_create for new work.",
			"next":    object{"via": "query", "op": "agent_read", "args": selectFields(task, "agent", "taskId")}})
	}
	return nil
}

func nativeAgentPrompt(ctx context.Context, r operationRequest, process *nativeAgentProcess, row object, configured object) (object, error) {
	process.dispatch.Lock()
	defer process.dispatch.Unlock()
	task := process.snapshot()
	if err := agentMutationArchived(task); err != nil {
		return nil, err
	}
	if agentTurnActive(task) {
		return nil, errors.New("AGENT_TURN_ACTIVE")
	}
	if task["status"] == "unknown" {
		return nil, errors.New("AGENT_TURN_UNCONFIRMED")
	}
	args := obj(row["arguments"])
	taskID := text(task, "taskId")
	turn := id()
	promptID := id()
	observed := make(chan struct{})
	prompt := text(args, "prompt")
	baseline := captureNativeChangeBaseline(ctx, text(task, "cwd"))
	admission := coordinationDispatchAdvisory(ctx, currentOrigin(ctx), baseline)
	var sourceRef any
	if args["srcConversation"] != nil || currentOrigin(ctx)["accountId"] != nil {
		src, err := captureSRCReference(ctx, r.service, args)
		if err != nil {
			return nil, err
		}
		sourceRef = src
	}
	args["srcConversation"] = sourceRef
	dispatch := object{"reason": args["reason"], "model": configured["model"], "options": configured["options"], "submittedAt": now()}
	if r.name == "agent_send" {
		dispatch["trigger"] = dispatchSendTrigger(args)
	}
	if pack := dispatchPackRecord(args); pack != nil {
		dispatch["pack"] = pack
	}
	row["taskId"], row["turnId"], row["coordination"] = taskID, turn, admission
	if body := obj(row["task"]); body != nil {
		body["dispatch"] = dispatch
	}
	if err := agentReceiptCheckpoint(ctx, row, "submitting"); err != nil {
		return nil, err
	}
	process.mu.Lock()
	process.task["turnId"], process.task["output"], process.task["outputTruncated"], process.task["error"] = turn, "", false, nil
	process.task["deniedActions"], process.task["toolErrors"] = []any{}, []any{}
	process.task["origin"], process.task["dispatch"], process.task["coordination"] = currentOrigin(ctx), dispatch, admission
	delete(process.task, "_turnLifecycle")
	process.task["status"] = "running"
	delete(process.task, "lastMessage")
	observeAgentOwner(process.task, "running")
	process.activePrompt, process.settled = promptID, observed
	if process.host != nil {
		host := dispatchSetSection(process.task, "taskHost")
		host["requestId"], host["promptId"] = row["requestId"], promptID
	}
	process.events.observe(taskID, "arc/user", object{"turnId": turn, "text": prompt})
	err := process.persistLocked()
	task = clone(process.task)
	process.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if err := recordAgentDispatch(ctx, task, args, r.name); err != nil {
		return nil, err
	}
	if err := recordNativeChangeBaseline(taskID, turn, baseline); err != nil {
		recordLog("WARN", err.Error(), nil)
	}
	frame := object{"jsonrpc": "2.0", "id": promptID, "method": "session/prompt",
		"params": object{"sessionId": task["sessionId"], "prompt": []any{object{"type": "text", "text": prompt}}}}
	switch process.driver.id {
	case "pi":
		frame = object{"id": promptID, "type": "prompt", "message": prompt}
	case "antigravity":
		frame = object{"event": "user", "message": object{"content": prompt}}
	}
	if err := process.frame(ctx, frame); err != nil {
		_ = process.checkpoint(observeAgentLoss)
		return nil, fmt.Errorf("SUBMISSION_UNCONFIRMED: %w", err)
	}
	if err := recordAgentDispatchSubmission(task); err != nil {
		recordLog("WARN", "Agent submission: "+err.Error(), nil)
	}
	recordNotificationBindingFailure(row, bindNotification(ctx, args, taskID, turn, text(task, "cwd"),
		object{"op": r.name, "at": row["createdAt"], "requestId": row["requestId"]}))
	select {
	case <-observed:
	case <-process.done:
	case <-ctx.Done():
		return nil, fmt.Errorf("SUBMISSION_UNCONFIRMED: %w", ctx.Err())
	}
	task = process.snapshot()
	if !agentTurnTerminal(task) {
		return nil, errors.New("SUBMISSION_UNCONFIRMED: Agent exited without a native turn outcome")
	}
	captureTerminalNativeChanges(ctx, taskID, turn)
	if err := recordAgentDispatchObservation(ctx, task, "accepted"); err != nil {
		recordLog("WARN", "Agent dispatch: "+err.Error(), nil)
	}
	observation := agentTurnObservation(task)
	if err := handleNotificationObservation(ctx, r.service, taskID, turn, observation); err != nil && err.Error() != PortPending {
		recordLog("WARN", "Agent notification: "+err.Error(), nil)
	}
	return object{"taskId": taskID, "turnId": turn, "sessionId": task["sessionId"], "status": task["status"], "dispatch": dispatch,
		"promptSubmitted": true, "submitted": true}, nil
}

func agentDispatchConfiguration(agent string, args, inherited object) (object, error) {
	policy, err := dispatchAgentPolicy(agent)
	if err != nil {
		return nil, err
	}
	withPack := maps.Clone(args)
	defaults := field(args["pack"], "defaults")
	if withPack["model"] == nil && field(defaults, "model") != nil {
		withPack["model"] = field(defaults, "model")
	}
	if options := obj(field(defaults, "options")); options != nil {
		options = maps.Clone(options)
		maps.Copy(options, obj(withPack["options"]))
		withPack["options"] = options
	}
	if agent == "antigravity" {
		return nativeAntigravityConfiguration(withPack, policy, inherited)
	}
	model := dispatchFirstString(withPack["model"], inherited["model"], policy["model"])
	options := maps.Clone(obj(policy["options"]))
	if inherited != nil {
		options = maps.Clone(obj(inherited["options"]))
	}
	if options == nil {
		options = object{}
	}
	maps.Copy(options, obj(withPack["options"]))
	if err := checkDispatchAgentPolicy(policy, options, model); err != nil {
		return nil, err
	}
	return object{"model": model, "options": options}, nil
}

func createNativeAgentTask(ctx context.Context, r operationRequest, row object) (any, error) {
	args := obj(row["arguments"])
	agent := text(args, "agent")
	driver, known := nativeAgentDriverByID(agent)
	if !known || agent == "codex" {
		return nil, errors.New("UNKNOWN_AGENT")
	}
	if err := ensureNativeAgentEnabled(agent); err != nil {
		return nil, err
	}
	cwd, err := resolveNativeAgentCWD(ctx, r.service, args)
	if err != nil {
		return nil, err
	}
	configured, err := agentDispatchConfiguration(agent, args, nil)
	if err != nil {
		return nil, err
	}
	taskID := id()
	row["taskId"] = taskID
	if err := agentReceiptCheckpoint(ctx, row, "launching"); err != nil {
		return nil, err
	}
	task := object{"agent": agent, "taskId": taskID, "cwd": cwd, "title": dispatchTitle(args),
		"createdAt": now(), "status": "idle", "turnId": nil, "approval": args["approval"], "agentAccountId": args["agentAccountId"],
		"output": "", "configured": configured, "origin": row["origin"]}
	if agent == "antigravity" {
		binary := driver.discover(ctx).binary
		if antigravityAgentAPI(binary) {
			return submitAntigravityDesktop(ctx, r, row, task, binary)
		}
	}
	p, err := r.service.startNativeAgent(ctx, driver, task, false)
	if err != nil {
		return nil, err
	}
	if text(args, "prompt") == "" {
		state := p.snapshot()
		return object{"taskId": taskID, "sessionId": state["sessionId"], "submitted": false, "status": state["status"]}, nil
	}
	return nativeAgentPrompt(ctx, r, p, row, configured)
}

func sendNativeAgentTask(ctx context.Context, r operationRequest, row object) (any, error) {
	args := obj(row["arguments"])
	agent, taskID := text(args, "agent"), text(args, "taskId")
	if err := ensureNativeAgentEnabled(agent); err != nil {
		return nil, err
	}
	guard := lockReceipt("agent-task:" + taskID)
	state, err := r.service.nativeAgentTask(agent, taskID)
	if err != nil {
		guard()
		return nil, err
	}
	if err := agentMutationArchived(state); err != nil {
		guard()
		return nil, err
	}
	configured, err := agentDispatchConfiguration(agent, args, obj(state["configured"]))
	if err != nil {
		guard()
		row["result"] = object{"promptSubmitted": false, "configurationError": err.Error(), "configurationState": "rejected"}
		return nil, err
	}
	if state["runtimeSource"] == antigravityDesktopProtocol {
		defer guard()
		driver, _ := nativeAgentDriverByID(agent)
		binary := driver.discover(ctx).binary
		if !antigravityAgentAPI(binary) {
			binary = antigravityAgentAPIBinary()
		}
		if binary == "" {
			return nil, errors.New("AGENT_NOT_INSTALLED")
		}
		state["configured"] = configured
		return submitAntigravityDesktop(ctx, r, row, state, binary)
	}
	p := r.service.agents.process(taskID)
	if p != nil {
		select {
		case <-p.done:
			p = nil
		default:
		}
	}
	if p == nil {
		if state["status"] == "unknown" || agentTurnActive(state) {
			guard()
			return nil, errors.New("AGENT_TURN_UNCONFIRMED")
		}
		driver, ok := nativeAgentDriverByID(agent)
		if !ok {
			guard()
			return nil, errors.New("UNKNOWN_AGENT")
		}
		state["configured"] = configured
		p, err = r.service.startNativeAgent(ctx, driver, state, true)
	}
	guard()
	if err != nil {
		return nil, err
	}
	if agent == "antigravity" && wire(configured) != wire(p.snapshot()["configured"]) {
		err := errors.New("UNSUPPORTED_DISPATCH_CONFIGURATION: Antigravity launch flags cannot change within a live session")
		row["result"] = object{"promptSubmitted": false, "configurationError": err.Error(), "configurationState": "rejected"}
		return nil, err
	}
	return nativeAgentPrompt(ctx, r, p, row, configured)
}

func interruptNativeAgentTask(ctx context.Context, r operationRequest, row object) (any, error) {
	task := text(row, "taskId")
	if state, err := r.service.nativeAgentTask(text(row, "agent"), task); err == nil && state["runtimeSource"] == antigravityDesktopProtocol {
		return nil, errors.New("ANTIGRAVITY_AGENTAPI_OPERATION_UNSUPPORTED: interrupt this conversation in Desktop")
	}
	p := r.service.agents.process(task)
	if p == nil || p.driver.id != row["agent"] {
		return nil, errors.New("AGENT_PROCESS_CLOSED")
	}
	state := p.snapshot()
	if !agentTurnActive(state) {
		return nil, errors.New("NO_ACTIVE_TURN")
	}
	if err := agentReceiptCheckpoint(ctx, row, "interrupting"); err != nil {
		return nil, err
	}
	if err := p.interrupt(ctx); err != nil {
		return nil, err
	}
	return object{"taskId": task, "turnId": state["turnId"], "accepted": true}, nil
}

func nativeAgentPending(_ context.Context, r operationRequest) (any, error) {
	task, agent := text(r.args, "taskId"), text(r.args, "agent")
	p := r.service.agents.process(task)
	requests := []object{}
	if p != nil && p.driver.id == agent {
		p.mu.Lock()
		defer p.mu.Unlock()
		for _, key := range keysObjectMap(p.pending) {
			requests = append(requests, clone(p.pending[key]))
		}
	}
	return object{"taskId": task, "agent": agent, "requests": requests}, nil
}

func keysObjectMap(rows map[string]object) []string { return slices.Sorted(maps.Keys(rows)) }

func respondNativeAgentTask(ctx context.Context, r operationRequest, row object) (any, error) {
	args := obj(row["arguments"])
	taskID, agent := text(args, "taskId"), text(args, "agent")
	p := r.service.agents.process(taskID)
	if p == nil || p.driver.id != agent {
		return nil, errors.New("AGENT_PROCESS_CLOSED")
	}
	key := wire(args["interactionId"])
	guard := lockReceipt("agent-interaction:" + taskID + ":" + key)
	defer guard()
	p.mu.Lock()
	item := clone(p.pending[key])
	p.mu.Unlock()
	if item == nil {
		return nil, errors.New("STALE_INTERACTION")
	}
	if err := agentReceiptCheckpoint(ctx, row, "responding"); err != nil {
		return nil, err
	}
	selected := text(args, "optionId")
	response := object{"id": item["id"], "jsonrpc": "2.0"}
	if p.driver.id == "pi" {
		response = object{"id": item["id"], "type": "extension_ui_response"}
		for _, key := range []string{"value", "confirmed"} {
			if supplied, ok := args[key]; ok {
				response[key] = supplied
			}
		}
	} else {
		decision := object{"outcome": "cancelled"}
		if selected != "" {
			options := arr(field(item["params"], "options"))
			if !slices.ContainsFunc(options, func(v any) bool { return field(v, "optionId") == selected }) {
				return nil, errors.New("INVALID_PERMISSION_OPTION")
			}
			decision["outcome"], decision["optionId"] = "selected", selected
		}
		response["result"] = object{"outcome": decision}
	}
	if err := p.frame(ctx, response); err != nil {
		return nil, fmt.Errorf("SUBMISSION_UNCONFIRMED: %w", err)
	}
	p.mu.Lock()
	delete(p.pending, key)
	if len(p.pending) == 0 && p.task["status"] == "waiting-permission" {
		observeAgentOwner(p.task, "running")
	}
	p.events.observe(taskID, "arc/interaction-resolved", object{"id": item["id"], "turnId": item["turnId"]})
	err := p.persistLocked()
	p.mu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("SUBMISSION_UNCONFIRMED: %w", err)
	}
	return object{"taskId": taskID, "turnId": item["turnId"], "responseSent": true}, nil
}

func init() {
	registerServiceStartup(func(_ context.Context, s *service) error {
		s.cleanup = append(s.cleanup, s.agents.close)
		return nil
	})
	registerAfterIndexStartup(15, reloadNativeAgentHosts)
	for name, perform := range map[string]func(context.Context, operationRequest, object) (any, error){
		"agent_create": createNativeAgentTask, "agent_send": sendNativeAgentTask, "agent_interrupt": interruptNativeAgentTask,
		"agent_respond": respondNativeAgentTask, "agent_archive": archiveNativeAgentTask, "agent_review": reviewNativeAgentTask,
	} {
		registerOperation(name, func(ctx context.Context, r operationRequest) (any, error) {
			return runAgentMutation(ctx, r, perform)
		}, nil)
	}
	registerOperation("agent_pending", nativeAgentPending, nil)
	registerOperation("agent_read", readNativeAgentOperation, nil)
	registerOperation("agent_wait", waitNativeAgentOperation, nil)
	registerOperation("agent_tasks", listNativeAgentOperation, nil)
	registerRoute(http.MethodGet, "agents", func(ctx context.Context, s *service, _ object, _ []string) (any, error) {
		return nativeAgentInventory(ctx, s, false)
	})
	registerRoute(http.MethodPut, "agents", func(_ context.Context, _ *service, body object, _ []string) (any, error) {
		return updateNativeAgentEnabled(body)
	})
	dispatchRegisteredAgent = func(_ *service, agent string) bool {
		_, ok := nativeAgentDriverByID(agent)
		return ok
	}
	dispatchAgentFacts = nativeAgentPolicyFacts
	subscriptionAgentInventory = func(ctx context.Context, s *service, optionsOnly bool) (any, error) {
		return nativeAgentInventory(ctx, s, optionsOnly)
	}
}
