package core

import (
	"context"
	"errors"
	"fmt"
)

func codexStaleInteraction(thread string) error {
	args := object{}
	if thread != "" {
		args["threadId"] = thread
	}
	return dispatchObjectError(object{"code": "STALE_INTERACTION",
		"message": "The original interaction is no longer exposed by its owner. Read the current native interactions and answer the exact current request; do not replay a previous approval.",
		"next":    object{"via": "query", "op": "codex_pending", "args": args}})
}

func respondCodexMutation(ctx context.Context, r operationRequest, row object) (object, error) {
	args := obj(row["arguments"])
	key, session, thread := text(args, "id"), text(args, "backendSession"), text(args, "threadId")
	var resolved object
	if args["respondToken"] != nil {
		var err error
		resolved, err = resolveRespondToken(ctx, args)
		if err != nil {
			return nil, err
		}
		key = text(resolved, "responseId")
		if key == "" {
			key = wire(resolved["id"])
		}
		session, thread = text(resolved, "backendSession"), text(resolved["params"], "threadId")
	}
	var identity any
	if unmarshalJSON([]byte(key), &identity) == nil {
		row := arr(identity)
		if len(row) >= 2 && row[0] == "desktop" {
			thread = str(row[1])
			if d, err := r.service.nativeDesktop(ctx); err == nil {
				if session != d.session && text(resolved, "owner") != "desktop" {
					known, err := recoverableNotificationResponse(ctx, key, session)
					if err != nil {
						return nil, err
					}
					if !known {
						return nil, codexStaleInteraction(thread)
					}
				}
				if owner, err := d.owner(ctx, thread); err == nil {
					if _, err := d.refreshInteractions(ctx, thread, owner); err != nil {
						return nil, err
					}
				}
			}
		}
	}
	unlock := lockReceipt("interaction:" + key)
	defer unlock()
	s := r.service
	s.events.Lock()
	pending := clone(s.events.pending[key])
	s.events.Unlock()
	if pending == nil || session != text(pending, "backendSession") && pending["owner"] != "desktop" {
		return nil, codexStaleInteraction(thread)
	}
	if resolved != nil {
		if connection := text(resolved, "connection"); connection != "" && connection != pending["connection"] {
			return nil, codexStaleInteraction(thread)
		}
		if field(pending["params"], "threadId") != field(resolved["params"], "threadId") ||
			field(pending["params"], "turnId") != field(resolved["params"], "turnId") {
			return nil, errors.New("RESPOND_TOKEN_SCOPE_MISMATCH")
		}
	}
	thread = text(pending["params"], "threadId")
	unlockThread := lockReceipt("codex-thread:" + thread)
	defer unlockThread()
	_, result := args["result"]
	_, failure := args["error"]
	if result == failure {
		return nil, errors.New("provide exactly one of result/error")
	}
	if pending["owner"] == "desktop" {
		if failure {
			return nil, errors.New("Desktop responses require result; use the native decline/cancel response")
		}
		return respondDesktopMutation(ctx, r.service, row, args, pending, thread, key)
	}
	rpc := s.interactionRPC(session, text(pending, "connection"))
	if rpc == nil {
		return nil, codexStaleInteraction(thread)
	}
	row["threadId"], row["turnId"] = thread, field(pending["params"], "turnId")
	if err := codexMutationCheckpoint(ctx, row, "responding"); err != nil {
		return nil, err
	}
	if err := noteExternalResponse(thread, pending, nil); err != nil {
		return nil, err
	}
	response := object{"id": pending["id"]}
	if result {
		response["result"] = args["result"]
	} else {
		response["error"] = args["error"]
	}
	if err := rpc.write(ctx, response); err != nil {
		return nil, fmt.Errorf("SUBMISSION_UNCONFIRMED: %w", err)
	}
	if err := recordInteractionAnswer(ctx, pending, args); err != nil {
		return nil, fmt.Errorf("SUBMISSION_UNCONFIRMED: response sent; answer persistence failed: %w", err)
	}
	s.events.Lock()
	if field(s.events.pending[key], "connection") == rpc.connection {
		delete(s.events.pending, key)
		s.events.signal()
	}
	s.events.Unlock()
	if err := consumeRespondToken(ctx, args); err != nil {
		return nil, fmt.Errorf("SUBMISSION_UNCONFIRMED: response sent; token persistence failed: %w", err)
	}
	return object{"responseSent": true, "backendSession": session, "id": key}, nil
}

func respondDesktopMutation(ctx context.Context, s *service, receipt, args, pending object, thread, key string) (object, error) {
	d, err := s.nativeDesktop(ctx)
	if err != nil {
		return nil, err
	}
	receipt["threadId"], receipt["turnId"] = thread, field(pending["params"], "turnId")
	if err := codexMutationCheckpoint(ctx, receipt, "responding"); err != nil {
		return nil, err
	}
	if err := noteExternalResponse(thread, pending, nil); err != nil {
		return nil, err
	}
	value, err := d.respond(ctx, thread, key, args["result"])
	if err != nil {
		if persistErr := noteExternalResponse(thread, pending, err); persistErr != nil {
			return nil, persistErr
		}
		return nil, err
	}
	if err := recordInteractionAnswer(ctx, pending, args); err != nil {
		return nil, fmt.Errorf("SUBMISSION_UNCONFIRMED: response sent; answer persistence failed: %w", err)
	}
	if err := consumeRespondToken(ctx, args); err != nil {
		return nil, fmt.Errorf("SUBMISSION_UNCONFIRMED: response sent; token persistence failed: %w", err)
	}
	return value, nil
}

func init() {
	nativeEventObserved = append(nativeEventObserved, func(events *nativeEvents, _ string, method string, params any, _ string) {
		if events.durable || method != "turn/completed" {
			return
		}
		thread, turn := text(params, "threadId"), text(field(params, "turn"), "id")
		if thread == "" || turn == "" || events.taskTimelines[thread] != nil {
			return
		}
		for _, request := range events.pending {
			if field(request["params"], "threadId") == thread && field(request["params"], "turnId") == turn {
				events.taskTrackingTimeline(thread)
				return
			}
		}
	})
	readThreadPending = func(ctx context.Context, s *service, thread string) error {
		_, err := readCodexMetadata(ctx, s, thread)
		return err
	}
	authorizeNativeInteraction = func(ctx context.Context, request object) error {
		if err := notificationRoutingObserve("codex", text(request["params"], "threadId"), request); err != nil {
			return err
		}
		return issueRespondToken(text(currentOrigin(ctx), "sourceId"), request)
	}
	registerOperation("codex_respond", codexWriteOperation("respond", respondCodexMutation), nil)
}
