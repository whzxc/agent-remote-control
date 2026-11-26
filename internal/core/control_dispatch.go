package core

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
)

func codexTaskInput(args object) ([]any, error) {
	raw := args["input"]
	if _, supplied := args["input"]; !supplied {
		raw = []any{object{"type": "text", "text": args["prompt"]}}
	}
	rows := arr(raw)
	if len(rows) == 0 {
		return nil, errors.New("DESKTOP_INPUT_REQUIRED")
	}
	input := make([]any, 0, len(rows))
	for _, row := range rows {
		elements, present := obj(row)["text_elements"]
		if _, ok := field(row, "text").(string); !ok || field(row, "type") != "text" ||
			present && (arr(elements) == nil || len(arr(elements)) != 0) {
			return nil, errors.New("DESKTOP_INPUT_UNSUPPORTED: only plain text is supported")
		}
		input = append(input, object{"type": "text", "text": field(row, "text"), "text_elements": []any{}})
	}
	return input, nil
}

func codexMutationTask(operation string, args object) (object, error) {
	kind := operation
	if operation == "resume" {
		kind = "send"
	}
	params, err := configuredTurn(args, "")
	if err != nil {
		return nil, err
	}
	input := []any{}
	if operation == "create" || operation == "send" {
		input, err = codexTaskInput(args)
		if err != nil {
			return nil, err
		}
	}
	lines := make([]string, 0, len(input))
	for _, row := range input {
		lines = append(lines, text(row, "text"))
	}
	prompt := strings.Join(lines, "\n")
	return object{"kind": kind, "title": dispatchTitle(object{"title": args["title"], "prompt": prompt}),
		"prompt": prompt, "input": input, "project": args["project"], "directory": field(args["thread"], "cwd"),
		"threadId": args["threadId"], "model": dispatchFirstString(params["model"], field(args["thread"], "model")), "effort": params["effort"],
		"settings": selectFields(args, "thread", "turn", "resume", "mode", "networkAccess", "serviceTier")}, nil
}

func prepareCodexMutation(ctx context.Context, r operationRequest, row object) error {
	operation := text(row, "operation")
	if r.name != "codex_"+operation || !slices.Contains([]string{"create", "send", "resume", "interrupt"}, operation) {
		return nil
	}
	args := clone(obj(row["arguments"]))
	var dispatch object
	if operation == "create" || operation == "send" {
		if err := applyDispatchPack(args, "codex", "codex_"+operation); err != nil {
			return err
		}
		var inherited object
		if operation == "send" && args["sendMode"] != "queue" {
			thread := text(args, "threadId")
			state, err := readCodexMetadata(ctx, r.service, thread)
			if err != nil {
				return err
			}
			records, err := dispatchRecords(thread)
			if err != nil {
				return err
			}
			inherited = inheritedDispatchConfiguration(state, records)
		}
		resolvedArgs := args
		deferSelection := operation == "send" && (args["sendMode"] == "queue" || args["sendMode"] == "next")
		if deferSelection {
			resolvedArgs = clone(args)
		}
		var err error
		dispatch, err = resolveDispatchPolicy(resolvedArgs, inherited)
		if err != nil {
			return err
		}
		if deferSelection {
			dispatch = nil
		}
		if operation == "send" && dispatch != nil {
			dispatch["trigger"] = dispatchSendTrigger(args)
		}
		source, err := captureSRCReference(ctx, r.service, args)
		if err != nil {
			return err
		}
		row["srcConversation"] = source
	}
	task, err := codexMutationTask(operation, args)
	if err != nil {
		return err
	}
	task["origin"] = row["origin"]
	if dispatch != nil {
		task["dispatch"] = dispatch
	}
	row["arguments"], row["task"] = args, task
	settings, err := notificationSettings()
	if err != nil {
		return err
	}
	if operation == "create" {
		row["executionOwner"] = "connector"
		if settings["autoOpenCodex"] == true && (fixtureUsesDesktop == nil || fixtureUsesDesktop()) {
			row["executionOwner"] = "desktop"
		}
	}
	decision := "automatic"
	switch args["approval"] {
	case "approved", "bypass":
		decision = str(args["approval"])
	default:
		if settings["enabled"] == true {
			decision = "pending"
			row["state"] = "awaiting-approval"
			row["nextAction"] = "receipt: approve, bypass or reject; user intent overrides the default approval mode"
		}
	}
	approval := object{"decision": decision, "source": "cloud", "at": now()}
	if decision == "approved" || decision == "bypass" {
		approval["answeredBy"] = interactionAnsweredBy(currentOrigin(ctx))
	}
	row["approval"] = approval
	if operation == "create" && row["executionOwner"] == "desktop" && row["state"] == "reserved" {
		prepareDesktopCodexCreate(ctx, r.service, row, settings)
	}
	return nil
}

func codexMutationCheckpoint(ctx context.Context, row object, stage string) error {
	row["submissionStage"] = stage
	return coreReceiptStore().checkpoint(ctx, row)
}

func createBackgroundCodex(ctx context.Context, r operationRequest, row object) (object, error) {
	background := row["executionOwner"] == "connector"
	var desktop *nativeDesktopIPC
	if !background {
		var err error
		desktop, err = r.service.nativeDesktop(ctx)
		if err != nil {
			return nil, err
		}
	}
	args, task := obj(row["arguments"]), obj(row["task"])
	seed := maps.Clone(obj(args["thread"]))
	if seed == nil {
		seed = object{}
	}
	if seed["ephemeral"] == true {
		if background {
			return nil, errors.New("BACKGROUND_TASK_MUST_PERSIST")
		}
		return nil, errors.New("DESKTOP_TASK_MUST_PERSIST")
	}
	seed["ephemeral"] = false
	for _, key := range []string{"model", "serviceTier"} {
		if value, exists := args[key]; exists && seed[key] == nil {
			seed[key] = value
		}
	}
	if args["project"] != nil {
		project, projectID, err := dispatchProject(ctx, r.service, args, nil)
		if err != nil {
			return nil, err
		}
		seed["cwd"] = project["root"]
		if projectID != nil && seed["projectId"] == nil {
			seed["projectId"] = *projectID
		}
	}
	task["directory"] = seed["cwd"]
	var rpc *rpcConnection
	var err error
	if background {
		rpc, err = r.service.codexUtility(ctx)
	} else {
		var binary, home string
		binary, home, err = codexInputs()
		if err == nil {
			err = r.service.codex.launches.run(func() error {
				var issue error
				rpc, issue = startRPC(ctx, binary, home, id(), rpcObserver{})
				return issue
			})
		}
	}
	if err != nil {
		return nil, err
	}
	if !background {
		defer rpc.close()
	}
	if err := codexMutationCheckpoint(ctx, row, "thread-submitting"); err != nil {
		return nil, err
	}
	created, err := rpc.call(ctx, "thread/start", seed, time.Minute)
	if err != nil {
		return nil, err
	}
	thread := text(field(created, "thread"), "id")
	if _, err := uuid.Parse(thread); err != nil {
		return nil, errors.New("SUBMISSION_UNCONFIRMED: Codex returned no thread ID. Read the original receipt before retrying.")
	}
	cwd := text(field(created, "thread"), "cwd")
	binding := object{"owner": row["executionOwner"]}
	if !background {
		binding["transport"] = "ipc"
	}
	if err := save(filepath.Join(root(), "execution", thread+".json"), binding); err != nil {
		return nil, fmt.Errorf("SUBMISSION_UNCONFIRMED: thread accepted; execution record failed: %w", err)
	}
	row["threadId"], task["directory"] = thread, cwd
	if err := codexMutationCheckpoint(ctx, row, "thread-created"); err != nil {
		return nil, err
	}
	cleanup := func(cause error) (object, error) {
		if !strings.HasPrefix(cause.Error(), "SUBMISSION_UNCONFIRMED") && !strings.HasPrefix(cause.Error(), "RPC_TIMEOUT:") && ctx.Err() == nil {
			_, archiveErr := rpc.call(ctx, "thread/archive", object{"threadId": thread}, 10*time.Second)
			switch {
			case nativeWriterRejected(archiveErr):
				owner, _ := nativeCodexOwner(ctx, operationRequest{args: object{"threadId": thread}, service: r.service})
				row["cleanup"] = object{"archived": false, "reason": "writer-busy", "error": archiveErr.Error(), "next": writerReleaseStep(thread, obj(owner))}
			default:
				cleaned, err := nativeCleanupResult(archiveErr)
				if err != nil {
					cleaned = object{"archived": false, "error": err.Error()}
				}
				row["cleanup"] = cleaned
			}
		}
		return nil, cause
	}
	title := text(task, "title")
	if !background && title == "" {
		title = "ARC task"
	}
	if title != "" {
		if _, err := rpc.call(ctx, "thread/name/set", object{"threadId": thread, "name": title}, time.Minute); err != nil {
			return cleanup(err)
		}
	}
	if !background {
		reader, err := r.service.codexUtility(ctx)
		if err != nil {
			return cleanup(err)
		}
		persisted, err := reader.call(ctx, "thread/read", object{"threadId": thread, "includeTurns": false}, time.Minute)
		if err != nil {
			return cleanup(err)
		}
		obj(created)["thread"] = field(persisted, "thread")
		if _, err := rpc.call(ctx, "thread/unsubscribe", object{"threadId": thread}, time.Minute); err != nil {
			return cleanup(err)
		}
	}
	params, err := configuredTurn(args, cwd)
	if err != nil {
		return cleanup(err)
	}
	params["threadId"], params["input"] = thread, task["input"]
	baseline := captureNativeChangeBaseline(ctx, nonemptyTaskText(text(params, "cwd"), cwd))
	row["turnBaseline"], row["coordination"] = baseline, coordinationDispatchAdvisory(ctx, obj(row["origin"]), baseline)
	dispatchSetSection(task, "dispatch")["submittedAt"] = now()
	if err := codexMutationCheckpoint(ctx, row, "turn-submitting"); err != nil {
		return cleanup(err)
	}
	var result any
	if background {
		result, err = rpc.call(ctx, "turn/start", params, codexMutationTimeout(args))
	} else if err = revealNativeDesktopThread(ctx, desktop, thread); err == nil {
		result, err = desktop.mutate(ctx, "turn/start", params)
	}
	if err != nil {
		return cleanup(err)
	}
	turn := text(field(result, "turn"), "id")
	if turn == "" {
		return nil, errors.New("SUBMISSION_UNCONFIRMED: Codex returned no first turn ID. Read the original receipt and thread before retrying.")
	}
	row["turnId"], row["dispatchMode"] = turn, "new-turn"
	if err := finishCodexDispatch(ctx, row, params, cwd); err != nil {
		return nil, err
	}
	response := object{"threadId": thread, "turnId": turn, "resolved": created, "submitted": true, "executionOwner": row["executionOwner"],
		"desktop": object{"state": "not-opened", "sharedBackend": false}}
	if !background {
		response["desktop"] = object{"state": "owner-confirmed", "sharedBackend": false}
		response["desktopUrl"] = "codex://threads/" + thread
	}
	return response, nil
}

func codexMutationTimeout(args object) time.Duration {
	return time.Duration(min(uintOr(args["timeoutMs"], 86400000), 86400000)) * time.Millisecond
}

func finishCodexDispatch(ctx context.Context, receipt, params object, cwd string) error {
	thread, turn := text(receipt, "threadId"), text(receipt, "turnId")
	if err := recordDispatch(receipt); err != nil {
		return err
	}
	retry := maps.Clone(obj(receipt["arguments"]))
	retry["_retryModel"], retry["_retryTurn"] = params["model"], retryTurnParams(params)
	binding := bindNotification(ctx, retry, thread, turn, cwd, object{"op": "codex_" + text(receipt, "operation"), "at": receipt["createdAt"], "requestId": receipt["requestId"]})
	recordNotificationBindingFailure(receipt, binding)
	if err := recordNativeChangeBaseline(thread, turn, obj(receipt["turnBaseline"])); err != nil {
		recordLog("WARN", err.Error(), nil)
	}
	return nil
}

func codexMutationOwner(ctx context.Context, s *service, thread string) error {
	_, home, err := codexInputs()
	if err != nil {
		return err
	}
	owner := s.nativeWriterOwnership(ctx, home, thread)
	if owner["state"] == "held" && owner["owner"] != "connector" && owner["owner"] != "desktop" {
		owner["processes"] = writerProcesses(ctx, home, thread)
		return dispatchObjectError(writerBusy(thread, owner))
	}
	return nil
}

func codexMutationHead(ctx context.Context, s *service, thread string) (object, object, error) {
	state, err := readCodexMetadata(ctx, s, thread)
	if err != nil {
		return nil, nil, err
	}
	page, err := readCodexTurnPage(ctx, s, object{"threadId": thread, "limit": 1})
	if err != nil {
		return nil, nil, err
	}
	turns := arr(page["data"])
	state["turns"] = turns
	if len(turns) > 0 {
		return state, obj(turns[0]), nil
	}
	return state, nil, nil
}

func sendCodexMutation(ctx context.Context, r operationRequest, row object) (object, error) {
	args, task := obj(row["arguments"]), obj(row["task"])
	thread := text(args, "threadId")
	unlock := lockReceipt("codex-thread:" + thread)
	defer unlock()
	row["threadId"] = thread
	if err := codexMutationOwner(ctx, r.service, thread); err != nil {
		return nil, err
	}
	if args["sendMode"] == "queue" {
		return enqueueCodexDispatch(r.service, args, row)
	}
	owner, err := prepareNativeCodexSend(ctx, r.service, thread)
	if err != nil {
		return nil, err
	}
	row["executionOwner"] = owner

	if resume := obj(args["resume"]); resume != nil {
		resume = maps.Clone(resume)
		resume["threadId"] = thread
		if _, err := requestCodexNative(ctx, r.service, "thread/resume", resume, codexMutationTimeout(args)); err != nil {
			return nil, err
		}
	}
	state, latest, err := codexMutationHead(ctx, r.service, thread)
	if err != nil {
		return nil, err
	}
	active := field(state["status"], "type") == "active" && latest["status"] == "inProgress"
	if field(state["status"], "type") == "active" && !active {
		return nil, errors.New("THREAD_STATE_UNCONFIRMED: native runtime is active without a confirmed active turn; read codex_read and keep queued messages pending")
	}
	if active && args["sendMode"] == "next" {
		return enqueueCodexDispatch(r.service, args, row)
	}
	if args["sendMode"] == "steer" && (!active || args["_expectedActiveTurn"] != nil && args["_expectedActiveTurn"] != latest["id"]) {
		return nil, errors.New("NO_ACTIVE_TURN: steering was not submitted; queue the message or send a new turn explicitly")
	}
	if args["_newTurn"] == true && (active || args["_expectedPreviousTurn"] != nil && args["_expectedPreviousTurn"] != latest["id"]) {
		return nil, errors.New("QUEUED_OR_RETRY_THREAD_ADVANCED: no message submitted")
	}
	if task["dispatch"] == nil {
		records, err := dispatchRecords(thread)
		if err != nil {
			return nil, err
		}
		selection, err := resolveDispatchPolicy(args, inheritedDispatchConfiguration(state, records))
		if err != nil {
			return nil, err
		}
		selection["trigger"], task["dispatch"] = dispatchSendTrigger(args), selection
	}
	cwd := text(state, "cwd")
	params, err := configuredTurn(args, cwd)
	if err != nil {
		return nil, err
	}
	params["threadId"], params["input"], task["directory"] = thread, task["input"], cwd
	method := "turn/start"
	if active {
		if nativeThreadHasInteraction(r.service, thread) {
			return nil, errors.New("INTERACTION_REQUIRED: answer the pending native request before steering")
		}
		records, err := dispatchRecords(thread)
		if err != nil {
			return nil, err
		}
		if err := reconcileActiveConfiguration(dispatchSetSection(task, "dispatch"), latest, state, records); err != nil {
			return nil, err
		}
		row["dispatchMode"] = "steered"
		method, params["expectedTurnId"] = "turn/steer", latest["id"]
	} else {
		row["dispatchMode"] = "new-turn"
		baseline := captureNativeChangeBaseline(ctx, nonemptyTaskText(text(params, "cwd"), cwd))
		row["turnBaseline"], row["coordination"] = baseline, coordinationDispatchAdvisory(ctx, obj(row["origin"]), baseline)
		if field(state["status"], "type") == "notLoaded" {
			if _, err := requestCodexNative(ctx, r.service, "thread/resume", object{"threadId": thread, "excludeTurns": true}, time.Minute); err != nil {
				return nil, err
			}
		}
	}
	dispatchSetSection(task, "dispatch")["submittedAt"] = now()
	if err := codexMutationCheckpoint(ctx, row, "submitting"); err != nil {
		return nil, err
	}
	value, err := requestCodexNative(ctx, r.service, method, params, codexMutationTimeout(args))
	if err != nil {
		return nil, err
	}
	turn := str(dispatchFirstString(field(field(value, "turn"), "id"), field(value, "turnId")))
	if turn == "" {
		return nil, errors.New("SUBMISSION_UNCONFIRMED: Codex returned no turn ID. Read the original receipt and thread before retrying.")
	}
	row["turnId"] = turn
	return obj(value), finishCodexDispatch(ctx, row, params, cwd)
}

func resumeCodexMutation(ctx context.Context, r operationRequest, row object) (object, error) {
	args := obj(row["arguments"])
	thread, previous := text(args, "threadId"), text(args, "turnId")
	unlock := lockReceipt("codex-thread:" + thread)
	defer unlock()
	row["threadId"] = thread
	config, err := notificationResumeContext(ctx, thread, previous)
	if err != nil {
		return nil, err
	}
	if err := codexMutationOwner(ctx, r.service, thread); err != nil {
		return nil, err
	}
	state, latest, err := codexMutationHead(ctx, r.service, thread)
	if err != nil {
		return nil, err
	}
	if latest == nil {
		return nil, errors.New("RESUME_TURN_MISSING")
	}
	outcome, terminal := codexTurnSnapshot(thread, latest).terminal()
	if latest["id"] != previous || !terminal || outcome.outcome != turnInterrupted || field(state["status"], "type") == "active" {
		return nil, dispatchObjectError(object{"code": "RESUME_TURN_ADVANCED",
			"message": "Only the latest interrupted turn can resume. No input was submitted.",
			"next":    object{"via": "query", "op": "codex_read", "args": object{"threadId": thread, "statusOnly": true}}})
	}
	if !codexBackground(thread) && (fixtureUsesDesktop == nil || fixtureUsesDesktop()) {
		return nil, errors.New(PortPending)
	}
	if field(state["status"], "type") == "notLoaded" {
		if _, err := requestCodexNative(ctx, r.service, "thread/resume", object{"threadId": thread, "excludeTurns": true}, 10*time.Second); err != nil {
			return nil, err
		}
	}
	owner, err := codexExecutionRecord(thread)
	if err != nil {
		return nil, err
	}
	if owner == nil {
		owner = object{}
	}
	owner["owner"], owner["reason"] = "connector", "explicit-interrupted-resume"
	if err := save(filepath.Join(root(), "execution", thread+".json"), owner); err != nil {
		return nil, err
	}
	baseline := captureNativeChangeBaseline(ctx, text(state, "cwd"))
	row["turnBaseline"], row["coordination"] = baseline, coordinationDispatchAdvisory(ctx, obj(row["origin"]), baseline)
	if err := codexMutationCheckpoint(ctx, row, "submitting"); err != nil {
		return nil, err
	}
	params := object{"threadId": thread, "input": []any{}, "turnTrigger": "resume_interrupted_task", "parentTurnId": previous, "rootTurnId": previous}
	records, err := dispatchRecords(thread)
	if err != nil {
		return nil, err
	}
	inherited := inheritedDispatchConfiguration(state, records)
	for _, key := range []string{"model", "effort"} {
		if value := inherited[key]; value != nil {
			params[key] = value
		}
	}
	value, err := requestCodexNative(ctx, r.service, "turn/start", params, 10*time.Second)
	if err != nil {
		return nil, err
	}
	turn := text(field(value, "turn"), "id")
	if turn == "" {
		return nil, errors.New("RESUME_UNCONFIRMED: read the original receipt and thread before retrying")
	}
	row["turnId"], row["dispatchMode"], row["executionOwner"] = turn, "resumed", "connector"
	obj(row["task"])["dispatch"] = object{"submittedAt": now()}
	if err := recordDispatch(row); err != nil {
		recordLog("WARN", err.Error(), nil)
		coordinationGap("dispatch", "persistence-failed")
	}
	if err := recordNativeChangeBaseline(thread, turn, baseline); err != nil {
		recordLog("WARN", err.Error(), nil)
	}
	wait, _ := outcomeStatusObservation(thread, latest)
	recordNotificationBindingFailure(row, recordNotificationResume(ctx, r.service, thread, previous, turn, config, wait))
	return object{"threadId": thread, "turnId": turn, "resumedFrom": previous, "executionOwner": "connector"}, nil
}

func outcomeStatusObservation(thread string, turn object) (object, turnTransition) {
	lifecycle := codexTurnSnapshot(thread, turn)
	state, reason := lifecycle.wait()
	return object{"state": string(state), "reason": reason, "recordedStatus": turn["status"], "threadId": thread,
		"turnId": turn["id"], "_turnLifecycle": lifecycle.checkpoint()}, lifecycle
}

func interruptCodexMutation(ctx context.Context, r operationRequest, row object) (object, error) {
	args := obj(row["arguments"])
	thread, turn := text(args, "threadId"), text(args, "turnId")
	unlock := lockReceipt("codex-thread:" + thread)
	defer unlock()
	row["threadId"] = thread
	if err := codexMutationOwner(ctx, r.service, thread); err != nil {
		return nil, err
	}
	if turn == "" {
		state, latest, err := codexMutationHead(ctx, r.service, thread)
		if err != nil {
			return nil, err
		}
		if field(state["status"], "type") != "active" {
			return nil, errors.New("NO_ACTIVE_TURN: no active turn is confirmed; read codex_read(statusOnly:true). Supply an explicit turnId only when the owning session confirms it.")
		}
		if latest["status"] != "inProgress" {
			return nil, errors.New("NO_ACTIVE_TURN: latest native turn is not active; read codex_read(statusOnly:true) before interrupting.")
		}
		turn = text(latest, "id")
		if turn == "" {
			return nil, errors.New("NO_ACTIVE_TURN: native owner returned no turn ID")
		}
	}
	row["turnId"] = turn
	if err := codexMutationCheckpoint(ctx, row, "submitting"); err != nil {
		return nil, err
	}
	result, err := requestCodexNative(ctx, r.service, "turn/interrupt", object{"threadId": thread, "turnId": turn}, codexMutationTimeout(args))
	return obj(result), err
}

func codexWriteOperation(name string, perform func(context.Context, operationRequest, object) (object, error)) operationHandler {
	return func(ctx context.Context, r operationRequest) (any, error) {
		args := clone(r.args)
		if name == "create" || name == "send" {
			if err := normalizeNotification(args); err != nil {
				return nil, err
			}
		}
		return runControlMutation(ctx, r, name, args, func(ctx context.Context, row object) (any, error) {
			return perform(ctx, r, row)
		})
	}
}

func init() {
	prepareControlMutation = prepareCodexMutation
	readNativeDispatchHistory = dispatchRecords
	submitNotificationRetry = func(ctx context.Context, s *service, args object) (object, error) {
		request := operationRequest{name: "codex_send", args: args, service: s}
		value, err := codexWriteOperation("send", sendCodexMutation)(ctx, request)
		return obj(value), err
	}
	setupCreateCodex = func(ctx context.Context, s *service, args object) (any, error) {
		return codexWriteOperation("create", createBackgroundCodex)(ctx, operationRequest{name: "codex_create", args: args, service: s})
	}
	setupTaskRecords = func(ctx context.Context, s *service) ([]any, error) {
		rows, err := s.readCodexTaskRecords(ctx)
		return decodedTaskList(rows), err
	}
	setupObserveCodex = func(ctx context.Context, s *service, args object) (any, error) {
		return nativeCodexWait(ctx, operationRequest{name: "codex_wait", args: args, service: s})
	}
	nativeCommandEnvironment = func(ctx context.Context, params object) {
		coordinationCommandEnvironment(params, currentOrigin(ctx))
	}
	registerOperation("codex_create", codexWriteOperation("create", createBackgroundCodex), nil)
	registerOperation("codex_send", codexWriteOperation("send", sendCodexMutation), nil)
	registerOperation("codex_resume", codexWriteOperation("resume", resumeCodexMutation), nil)
	registerOperation("codex_interrupt", codexWriteOperation("interrupt", interruptCodexMutation), nil)
}
