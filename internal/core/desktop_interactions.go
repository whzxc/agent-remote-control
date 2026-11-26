package core

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"
)

type desktopRequestRoute struct{ method, field string }

var desktopResponseRoutes = map[string]desktopRequestRoute{
	"item/commandExecution/requestApproval": {"thread-follower-command-approval-decision", "decision"},
	"item/fileChange/requestApproval":       {"thread-follower-file-approval-decision", "decision"},
	"item/permissions/requestApproval":      {"thread-follower-permissions-request-approval-response", "response"},
	"item/tool/requestUserInput":            {"thread-follower-submit-user-input", "response"},
	"mcpServer/elicitation/request":         {"thread-follower-submit-mcp-server-elicitation-response", "response"},
}

func desktopAsyncAnswers(turns []any) map[string]bool {
	answered := map[string]bool{}
	for _, turn := range turns {
		for _, item := range arr(field(turn, "items")) {
			var content any
			switch {
			case field(item, "type") == "userMessage":
				content = field(item, "content")
			case field(item, "type") == "steeringUserMessage" && field(item, "status") == "accepted":
				content = field(item, "input")
			}
			for _, part := range arr(content) {
				body, opened := strings.CutPrefix(strings.TrimSpace(text(part, "text")), externalQuestionOpen)
				body, closed := strings.CutSuffix(body, externalQuestionClose)
				var reply any
				if !opened || !closed || unmarshalJSON([]byte(body), &reply) != nil {
					continue
				}
				items := arr(reply)
				if items == nil {
					items = []any{reply}
				}
				for _, item := range items {
					if id, ok := field(item, "questionItemId").(string); ok {
						answered[id] = true
					}
				}
			}
		}
	}
	return answered
}

func desktopPendingInteractions(state object, session string) []object {
	thread := state["id"]
	entities := obj(field(field(state["turnHistory"], "history"), "entitiesByKey"))
	turns := make([]any, 0, len(entities))
	byID := map[string]object{}
	for _, key := range slices.Sorted(maps.Keys(entities)) {
		turn := entities[key]
		turns = append(turns, turn)
		byID[text(turn, "turnId")] = obj(turn)
	}
	requests := []object{}
	for _, request := range arr(state["requests"]) {
		method := text(request, "method")
		_, routed := desktopResponseRoutes[method]
		tool := text(field(request, "params"), "tool")
		if !routed && method != "item/tool/requestOptionPicker" && method != "item/plan/requestImplementation" &&
			!(method == "item/tool/call" && slices.Contains([]string{"request_user_input", "request_onboarding_input", "request_environment_input", "request_option_picker"}, tool)) {
			continue
		}
		row := clone(obj(request))
		row["nativeId"], row["canRespond"] = row["id"], routed && field(row["params"], "mode") != "openai/userVerification"
		dispatchSetSection(row, "params")["threadId"] = thread
		requests = append(requests, row)
	}
	answered := desktopAsyncAnswers(turns)
	for _, turn := range turns {
		for _, item := range arr(field(turn, "items")) {
			if field(item, "type") != "agentMessage" {
				continue
			}
			for i, question := range arr(field(item, "questions")) {
				questionID := wire([]any{"request_user_input_async", field(item, "id"), i})
				if answered[questionID] {
					continue
				}
				requests = append(requests, object{"nativeId": questionID, "method": "request_user_input_async", "canRespond": true,
					"params": object{"threadId": thread, "turnId": field(turn, "turnId"), "questionItemId": questionID,
						"question": field(question, "title"), "options": field(question, "options")}})
			}
		}
	}
	for _, row := range requests {
		turn := field(row["params"], "turnId")
		if resolved := byID[str(turn)]; resolved != nil {
			row["turnStatus"] = resolved["status"]
		}
		responseID := wire([]any{"desktop", thread, turn, row["method"], row["nativeId"]})
		row["id"], row["responseId"], row["backendSession"], row["owner"] = responseID, responseID, session, "desktop"
		if row["canRespond"] == true {
			hint := "Supply result using this native request's response schema; never invent approval."
			if row["method"] == "request_user_input_async" {
				hint = "Supply result: {answer: <chosen option or free text>}."
			}
			row["next"] = object{"via": "act", "op": "codex_respond", "args": object{"id": responseID, "backendSession": session}, "hint": hint}
		} else {
			row["next"] = object{"hint": "Handle in Codex Desktop. No supported response path."}
		}
	}
	return requests
}

func (d *nativeDesktopIPC) syncInteractions(state object) {
	thread := text(state, "id")
	requests := desktopPendingInteractions(state, d.session)
	if turns, err := nativeDesktopTurns(state); err == nil {
		if err := observeExternalInputs(thread, turns, requests); err != nil {
			recordLog("WARN", err.Error(), nil)
		}
	}
	for _, request := range requests {
		if err := notificationRoutingObserve("codex", thread, request); err != nil {
			recordLog("WARN", err.Error(), nil)
		}
	}
	d.events.Lock()
	defer d.events.Unlock()
	if d.events.pending == nil {
		d.events.pending = map[string]object{}
	}
	maps.DeleteFunc(d.events.pending, func(_ string, row object) bool {
		return row["owner"] == "desktop" && field(row["params"], "threadId") == thread
	})
	for _, row := range requests {
		d.events.pending[text(row, "responseId")] = row
	}
}

func (d *nativeDesktopIPC) refreshInteractions(ctx context.Context, thread, owner string) (object, error) {
	d.mu.Lock()
	d.removeSnapshot(thread)
	d.mu.Unlock()
	state, err := d.readOwned(ctx, thread, true, owner)
	if err == nil {
		d.syncInteractions(state)
	}
	return state, err
}

func (d *nativeDesktopIPC) respond(ctx context.Context, thread, key string, result any) (object, error) {
	owner, err := d.owner(ctx, thread)
	if err != nil {
		return nil, err
	}
	state, err := d.refreshInteractions(ctx, thread, owner)
	if err != nil {
		return nil, err
	}
	requests := desktopPendingInteractions(state, d.session)
	index := slices.IndexFunc(requests, func(row object) bool { return row["id"] == key })
	if index < 0 {
		return nil, codexStaleInteraction(thread)
	}
	request := requests[index]
	if request["canRespond"] != true {
		return nil, errors.New("DESKTOP_RESPONSE_UNSUPPORTED: Handle in Codex Desktop")
	}
	var next any
	if request["method"] == "request_user_input_async" {
		next, err = d.sendAsyncAnswer(ctx, thread, state, request, result)
		if err != nil {
			return nil, err
		}
	} else {
		route, ok := desktopResponseRoutes[text(request, "method")]
		if !ok {
			return nil, errors.New("DESKTOP_RESPONSE_UNSUPPORTED")
		}
		response := result
		if route.field == "decision" {
			response = field(result, "decision")
			if _, decision := response.(string); !decision && obj(response) == nil {
				return nil, errors.New("result.decision required")
			}
		}
		params := object{"conversationId": thread, "requestId": request["nativeId"], route.field: response}
		reply, err := d.request(ctx, route.method, params, owner)
		if err != nil {
			return nil, err
		}
		if field(reply["result"], "ok") != true {
			return nil, errors.New("SUBMISSION_UNCONFIRMED: Desktop did not acknowledge response")
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		state, err := d.refreshInteractions(ctx, thread, owner)
		if err != nil {
			return nil, fmt.Errorf("SUBMISSION_UNCONFIRMED: %w", err)
		}
		if !slices.ContainsFunc(desktopPendingInteractions(state, d.session), func(row object) bool { return row["id"] == key }) {
			return object{"responseSent": true, "resolved": true, "threadId": thread, "id": key, "backendSession": d.session,
				"nextTurnId": next, "answeredTurnId": field(request["params"], "turnId")}, nil
		}
		if time.Now().After(deadline) {
			return nil, errors.New("SUBMISSION_UNCONFIRMED: Desktop still exposes this interaction; read before retrying")
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("SUBMISSION_UNCONFIRMED: %w", ctx.Err())
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (d *nativeDesktopIPC) sendAsyncAnswer(ctx context.Context, thread string, state, request object, result any) (any, error) {
	answer := text(result, "answer")
	if strings.TrimSpace(answer) == "" {
		return nil, errors.New("result.answer must be nonempty text")
	}
	message := externalQuestionOpen + "\n" + wire([]any{object{"questionItemId": request["nativeId"], "question": field(request["params"], "question"),
		"answer": answer}}) + "\n" + externalQuestionClose
	input := []any{object{"type": "text", "text": message}}
	turns, err := nativeDesktopTurns(state)
	if err != nil {
		return nil, err
	}
	var active any
	for _, turn := range slices.Backward(turns) {
		if field(turn, "status") == "inProgress" {
			active = field(turn, "id")
			break
		}
	}
	method := "turn/start"
	args := object{"threadId": thread, "input": input}
	if active != nil {
		method, args["expectedTurnId"] = "turn/steer", active
	}
	token, err := beginExternalInput(thread, turns, input, active)
	if err != nil {
		return nil, err
	}
	native, err := d.mutate(ctx, method, args)
	if persistErr := finishExternalInput(thread, token, native, err); persistErr != nil {
		return nil, fmt.Errorf("SUBMISSION_UNCONFIRMED: input provenance persistence failed: %w", persistErr)
	}
	return field(field(native, "turn"), "id"), err
}
