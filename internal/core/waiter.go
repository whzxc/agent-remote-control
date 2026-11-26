package core

import (
	"cmp"
	"context"
	"errors"
	"maps"
	"slices"
	"strings"
	"time"
)

type nativeWaitSource struct {
	observe           func(context.Context) (object, error)
	alive             func() bool
	classify          func(object, **string) object
	wake              func() <-chan struct{}
	deadlineIsTimeout bool
}

func waitInitialResult(args object) object {
	return object{"threadId": args["threadId"], "turnId": args["turnId"], "recordedStatus": nil, "runtimeStatus": "unknown",
		"interaction": []any{}, "finalResponse": nil}
}

func waitResponseText(value object) string {
	if response, ok := value["finalResponse"].(string); ok {
		return response
	}
	return text(value["finalResponse"], "text")
}

func waitTextHash(value object) string {
	if digest, present := field(value["finalResponse"], "textHash").(string); present {
		return digest
	}
	return hash([]byte(waitResponseText(value)))
}

func waitSnapshotHash(value object) string {
	snapshot := object{}
	for _, key := range []string{"turnId", "recordedStatus", "runtimeStatus", "interaction", "finalResponse", "error", "externalUserInputs"} {
		snapshot[key] = value[key]
	}
	return hash([]byte(wire(snapshot))) + ":" + waitTextHash(value)
}

func compactNativeWaitResponse(value, args object) {
	expected, supplied := args["expectedHash"].(string)
	state, _ := parseTurnWaitState(text(value, "state"))
	if !supplied || state.keepsResponse() {
		return
	}
	_, digest, separated := strings.Cut(expected, ":")
	if value["snapshotHash"] == expected || separated && digest == waitTextHash(value) {
		value["finalResponseUnchanged"] = true
		switch response := value["finalResponse"].(type) {
		case object:
			delete(response, "text")
		case string:
			delete(value, "finalResponse")
		}
	}
}

func finishNativeWait(value object, state turnWaitState, reason string, started time.Time, baseline *string) object {
	digest := waitSnapshotHash(value)
	value["state"], value["reason"] = string(state), reason
	value["changed"], value["snapshotHash"], value["textHash"] = baseline != nil && *baseline != digest, digest, waitTextHash(value)
	if _, present := value["observedAt"]; !present {
		value["observedAt"] = nil
	}
	value["returnedAt"], value["elapsedMs"] = now(), time.Since(started).Milliseconds()
	return value
}

func runNativeWait(ctx, shutdown context.Context, source nativeWaitSource, args object, started time.Time) (object, error) {
	deadline := started.Add(time.Duration(uintOr(args["timeoutMs"], 30000)) * time.Millisecond)
	last, baseline, selected := waitInitialResult(args), optionalProjectString(args["expectedHash"]), optionalProjectString(args["turnId"])
	finish := func(state turnWaitState, reason string) (object, error) {
		return finishNativeWait(last, state, reason, started, baseline), nil
	}
	expired := func() (object, error) {
		if last["state"] == "unconfirmed" {
			return finish(waitUnconfirmed, text(last, "reason"))
		}
		return finish(waitTimeout, "deadline")
	}
	reason := "poll"
	for {
		switch {
		case !source.alive():
			return finish(waitUnconfirmed, "connection-closed")
		case shutdown.Err() != nil:
			return finish(waitUnconfirmed, "connector-shutdown")
		case ctx.Err() != nil:
			return nil, ctx.Err()
		case !time.Now().Before(deadline):
			return expired()
		}
		read, cancel := context.WithDeadline(ctx, minTime(deadline, time.Now().Add(10*time.Second)))
		stop := context.AfterFunc(shutdown, cancel)
		recordRuntimeWork(read, runtimeWorkCost{Owner: "scopedWait", Reason: reason, Rows: 1, ScanSet: 1})
		observation, err := source.observe(read)
		readErr := read.Err()
		stop()
		cancel()
		switch {
		case shutdown.Err() != nil:
			return finish(waitUnconfirmed, "connector-shutdown")
		case ctx.Err() != nil:
			return nil, ctx.Err()
		case errors.Is(readErr, context.DeadlineExceeded):
			if !time.Now().Before(deadline) && (source.deadlineIsTimeout || last["observedAt"] != nil) {
				return expired()
			}
			err = errors.New("native-read-timeout")
		}
		if !source.alive() {
			return finish(waitUnconfirmed, "connection-closed")
		}
		if err == nil {
			last = source.classify(observation, &selected)
			if baseline == nil {
				digest := waitSnapshotHash(last)
				baseline = &digest
			}
			state, _ := parseTurnWaitState(text(last, "state"))
			if state != waitRunning {
				return finish(state, text(last, "reason"))
			}
		} else {
			switch message := err.Error(); message {
			case "native-read-timeout", "DESKTOP_SNAPSHOT_TIMEOUT", "RPC_TIMEOUT: thread/read", "RPC_TIMEOUT: thread/turns/list":
				last["state"], last["reason"] = "unconfirmed", message
			default:
				return finish(waitUnconfirmed, message)
			}
		}
		// Capture the change channel after each read so a refresh cannot trigger itself.
		wake := source.wake()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-shutdown.Done():
			return finish(waitUnconfirmed, "connector-shutdown")
		case <-time.After(time.Until(minTime(deadline, time.Now().Add(2*time.Second)))):
			reason = "timer"
		case <-wake:
			reason = "event"
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-shutdown.Done():
				return finish(waitUnconfirmed, "connector-shutdown")
			case <-time.After(time.Until(minTime(deadline, time.Now().Add(250*time.Millisecond)))):
			}
		}
	}
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func nativeWaitCondition(result, args object) {
	state, _ := parseTurnWaitState(text(result, "state"))
	var met bool
	switch args["until"] {
	case "terminal":
		met = state.terminal()
	case "interaction-required":
		met = state == waitInteraction
	default:
		met = state.keepsResponse()
	}
	result["conditionMet"] = met
}

func classifyCodexObservation(observation object, selected **string) (object, turnTransition) {
	thread := obj(observation["thread"])
	turns := arr(thread["turns"])
	if *selected == nil {
		for _, item := range slices.Backward(turns) {
			if field(item, "status") == "inProgress" {
				*selected = optionalProjectString(field(item, "id"))
				break
			}
		}
		if *selected == nil && len(turns) != 0 {
			*selected = optionalProjectString(field(turns[len(turns)-1], "id"))
		}
	}
	var turn any
	var id any
	if *selected != nil {
		id = **selected
		for _, item := range turns {
			if field(item, "id") == id {
				turn = item
				break
			}
		}
	}
	status := thread["status"]
	runtime, present := field(status, "type").(string)
	if !present {
		runtime = "unknown"
	}
	latest := len(turns) > 0 && field(turns[len(turns)-1], "id") == id
	interactions := []any{}
	for _, row := range decodedTaskList(observation["pending"]) {
		params := field(row, "params")
		if field(params, "threadId") != thread["id"] || !(field(params, "turnId") == id || field(params, "turnId") == nil && latest) {
			continue
		}
		request := maps.Clone(obj(row))
		if request["responseId"] == nil {
			request["responseId"] = wire(request["id"])
		}
		request["questionSummary"] = interactionPreview(request)
		interactions = append(interactions, request)
	}
	slices.SortStableFunc(interactions, func(a, b any) int { return cmp.Compare(text(a, "responseId"), text(b, "responseId")) })
	var flags any
	if latest {
		flags = field(status, "activeFlags")
	}
	blocked := slices.Contains(arr(flags), any("waitingOnApproval")) || slices.Contains(arr(flags), any("waitingOnUserInput"))
	key := turnKey{"codex", text(thread, "id"), str(id)}
	var recorded *string
	if turn != nil {
		value := text(turn, "status")
		recorded = &value
	}
	lifecycle := (turnTransition{key: key}).advance(codexOwnerEvidence(key, recorded, runtime, blocked || len(interactions) > 0, 0))
	for _, item := range turns {
		if field(item, "id") == id && field(item, "_terminalUnconfirmed") != true {
			sequence, sequenced := uintValue(field(item, "nativeSequence"))
			lifecycle = lifecycle.advance(codexTerminalEvidence(key, text(item, "status"), sequence, sequenced))
		}
	}
	state, reason := lifecycle.wait()
	var message any
	for _, item := range slices.Backward(arr(field(turn, "items"))) {
		itemID := text(item, "id")
		if field(item, "type") == "agentMessage" && (state.keepsResponse() || field(item, "status") == "completed" ||
			field(field(turn, "completedItemIds"), itemID) == true || field(field(turn, "agentMessageCompletedAtMsById"), itemID) != nil) {
			message = nativeItemExcerpt(obj(item), 0, 6000)
			break
		}
	}
	var count any = len(interactions)
	var action any
	if blocked && len(interactions) == 0 {
		count = nil
		action = "Inspect Codex Desktop for the pending interaction; this owner exposes no callback ID to Agent Remote Control"
	} else if len(interactions) != 0 {
		action = "Use codex_respond with id=responseId and backendSession; do not resend the task"
	}
	progress := progressFromCodexTurn(turn, count)
	previews := make([]any, 0, min(len(interactions), 5))
	for _, request := range interactions[:cap(previews)] {
		previews = append(previews, field(request, "questionSummary"))
	}
	progress["pendingInteractions"] = previews
	external := []any{}
	for _, input := range arr(observation["externalUserInputs"]) {
		if field(input, "turnId") == id || field(input, "answeredTurnId") != nil && field(input, "answeredTurnId") == id {
			external = append(external, input)
		}
	}
	return object{"state": string(state), "reason": reason, "title": thread["name"], "threadId": thread["id"], "turnId": id,
		"recordedStatus": field(turn, "status"), "runtimeStatus": runtime, "runtimeSource": thread["runtimeSource"],
		"archived": codexNativeSummary(thread)["archived"], "externalUserInputs": external, "finalResponse": message, "error": field(turn, "error"),
		"interaction": interactions, "activeFlags": flags, "interactionAction": action, "progress": progress, "observedAt": now()}, lifecycle
}

func reconcileNativeInterruption(thread object, selected *string, history string) {
	if selected == nil {
		return
	}
	key := turnKey{"codex", text(thread, "id"), *selected}
	evidence, _ := codexRolloutTerminal(key, history)
	for _, row := range arr(thread["turns"]) {
		turn := obj(row)
		if turn["id"] != *selected {
			continue
		}
		switch turn["status"] {
		case "completed":
			if evidence.terminal.outcome != turnCompleted {
				continue
			}
		case "interrupted", "cancelled":
		default:
			continue
		}
		if evidence.terminal.outcome == 0 {
			turn["_terminalUnconfirmed"] = true
		} else {
			turn["status"] = pushTurnOutcome(evidence.terminal.outcome)
			turn["nativeSequence"] = evidence.terminal.sequence
		}
	}
}
