package core

import (
	"context"
	"errors"
	"fmt"
)

func notificationDeviceKey(device, task string) string { return "device:" + device + ":" + task }

func notificationDeviceIdentity(value object, depth int) (string, string) {
	if depth > 5 {
		return "", ""
	}
	task := str(dispatchFirstString(value["threadId"], value["taskId"], field(value["thread"], "id"), field(value["task"], "id")))
	turn := str(dispatchFirstString(value["turnId"], field(value["turn"], "id")))
	if task != "" && turn != "" {
		return task, turn
	}
	for _, field := range []string{"result", "receipt"} {
		if nested := obj(value[field]); nested != nil {
			if task, turn := notificationDeviceIdentity(nested, depth+1); task != "" {
				return task, turn
			}
		}
	}
	return "", ""
}

func hasNotificationDeviceBinding(device, task, turn string) (bool, error) {
	b, err := readNotificationBinding(notificationDeviceKey(device, task), turn)
	return b != nil, err
}

func bindNotificationDevice(ctx context.Context, device, name, source, op string, args, result object) (bool, error) {
	task, turn := notificationDeviceIdentity(result, 0)
	if task == "" || turn == "" {
		return false, nil
	}
	thread := notificationDeviceKey(device, task)
	args = clone(args)
	if args == nil {
		args = object{}
	}
	args["_device"] = object{"id": device, "name": name, "taskId": task}
	ctx = withOrigin(ctx, object{"sourceId": source})
	err := bindNotification(ctx, args, thread, turn, "", object{"op": op, "requestId": result["requestId"], "at": now()})
	if err == nil && op == "codex_resume" {
		err = inheritNotificationBinding(ctx, thread, text(args, "previousTurnId"), turn)
	}
	return err == nil, err
}

func inheritNotificationBinding(ctx context.Context, thread, previous, turn string) error {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	source := text(currentOrigin(ctx), "sourceId")
	prior, err := readNotificationBinding(thread, previous)
	if err != nil || prior == nil || prior["sourceId"] != source || prior["scopeEnd"] != nil {
		return err
	}
	b, err := readNotificationBinding(thread, turn)
	if err != nil || b == nil || b["sourceId"] != source || b["explicit"] == true {
		return err
	}
	b["target"], b["channel"], b["title"], b["scopeStartedAt"] = prior["target"], prior["channel"], prior["title"], notificationScopeStarted(prior)
	dispatchSetSection(b, "causedBy")["continuationOf"] = previous
	if err := persistNotificationBinding(b); err != nil {
		return err
	}
	prior["continuationBound"] = true
	prior["successor"] = object{"turnId": turn, "inherited": true, "reason": "same-origin-thread-continuation"}
	return persistNotificationBinding(prior)
}

func readNotificationDeviceRequest(b object) object {
	task := str(dispatchFirstString(field(b["device"], "taskId"), b["threadId"]))
	agent := notificationAgent(b)
	row := object{"taskId": task, "turnId": b["turnId"], "sourceId": b["sourceId"]}
	if agent == "codex" {
		row["op"], row["args"] = "codex_read", object{"threadId": task, "turnId": b["turnId"], "statusOnly": true}
	} else {
		row["op"], row["args"] = "agent_read", object{"agent": agent, "taskId": task, "view": "summary"}
	}
	return row
}

func notificationDeviceBindingOpen(b object, device string) bool {
	return field(b["device"], "id") == device && b["scopeEnd"] == nil && b["continuationBound"] != true &&
		!notificationTerminal(text(b["observation"], "state"))
}

func openNotificationDeviceBindings(device string) ([]any, error) {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	rows, err := notificationIndexedBindings("device:"+device, func(b object) bool {
		return notificationDeviceBindingOpen(b, device)
	})
	if err != nil {
		return nil, err
	}
	result := make([]any, 0, len(rows))
	for _, b := range rows {
		result = append(result, readNotificationDeviceRequest(b))
	}
	return result, nil
}

func markNotificationDeviceUnavailable(device string, only object) error {
	rows := []any{only}
	if only == nil {
		var err error
		rows, err = openNotificationDeviceBindings(device)
		if err != nil {
			return err
		}
	}
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	for _, row := range rows {
		thread, turn := notificationDeviceKey(device, text(row, "taskId")), text(row, "turnId")
		b, err := readNotificationBinding(thread, turn)
		if err != nil {
			return err
		}
		if b == nil || notificationTerminal(text(b["observation"], "state")) {
			continue
		}
		if mergeNotificationLifecycle != nil {
			b["lifecycle"], _, _, _ = mergeNotificationLifecycle(notificationAgent(b), thread, turn, b["lifecycle"], object{"state": "unconfirmed"})
		}
		b["observation"] = object{"state": "unconfirmed", "reason": "member-unavailable", "reconciliation": "pending-after-restart"}
		if err := persistNotificationBinding(b); err != nil {
			return err
		}
	}
	return nil
}

func receiveNotificationDeviceEvent(ctx context.Context, s *service, device, source string, event object) error {
	task, turn := notificationDeviceIdentity(event, 0)
	thread := notificationDeviceKey(device, task)
	notificationEventOperation.Lock()
	b, err := readNotificationBinding(thread, turn)
	if err != nil || b == nil || b["sourceId"] != source {
		notificationEventOperation.Unlock()
		return err
	}
	kind := text(event, "kind")
	if kind == "recovered" || kind == "handoff" {
		defer notificationEventOperation.Unlock()
		if kind == "handoff" {
			return enqueueNotificationHandoffs(b, []any{event["ownership"]})
		}
		eventID := hash([]byte(wire([]any{device, event["eventId"]})))
		if find(b["deliveries"], "eventId", eventID) != nil {
			return nil
		}
		d := object{"key": "recovered:" + eventID, "target": text(b, "target"), "eventId": eventID, "createdAt": notificationClock().Unix(),
			"state": "recovered", "taskState": "recovered", "status": "inbox-only", "recovery": event["recovery"], "channel": "claude-session"}
		if err := appendNotificationInbox(source, notificationEvent(b, d)); err != nil {
			return err
		}
		b["deliveries"] = append(arr(b["deliveries"]), d)
		return persistNotificationBinding(b)
	}
	notificationEventOperation.Unlock()
	state, recorded := "running", "inProgress"
	switch kind {
	case "completed", "failed":
		state, recorded = kind, kind
	case "interrupted":
		state, recorded = "cancelled", kind
	case "needs-input":
		state = "interaction-required"
	}
	observed := object{"threadId": thread, "turnId": turn, "agent": event["agent"], "state": state, "recordedStatus": recorded,
		"title": event["title"], "finalResponse": event["finalResponse"], "error": event["error"], "interaction": []any{},
		"activeFlags": []any{}, "progressStalled": kind == "stalled", "progress": event["progress"], "dispatches": []any{}}
	if obj(event["interaction"]) != nil {
		observed["interaction"] = []any{event["interaction"]}
	} else if kind == "needs-input" {
		flag := "waitingOnUserInput"
		if event["state"] == "waiting for approval" {
			flag = "waitingOnApproval"
		}
		observed["activeFlags"] = []any{flag}
	}
	return handleNotificationObservation(ctx, s, thread, turn, observed)
}

func reconcileNotificationDevice(ctx context.Context, s *service, device, source string, row, value object) error {
	thread, turn := notificationDeviceKey(device, text(row, "taskId")), text(row, "turnId")
	b, err := readNotificationBinding(thread, turn)
	if err != nil || b == nil || b["sourceId"] != source {
		return err
	}
	if exact := find(value["turns"], "turnId", turn); exact != nil {
		value = exact
	}
	if id, ok := value["turnId"].(string); ok && id != turn {
		return nil
	}
	observation := clone(value)
	if observation == nil {
		return errors.New("INVALID_ARGUMENT: member status must be an object")
	}
	delete(observation, "_turnLifecycle")
	observation["threadId"], observation["turnId"], observation["agent"] = thread, turn, notificationAgent(b)
	return handleNotificationObservation(ctx, s, thread, turn, observation)
}

func projectNotificationDevice(bind, event object) {
	device := obj(bind["device"])
	if device == nil {
		return
	}
	task := str(dispatchFirstString(device["taskId"], bind["threadId"]))
	event["device"], event["title"] = device, fmt.Sprintf("%s · %s", text(device, "name"), text(event, "title"))
	agent := notificationAgent(bind)
	op, args := "codex_read", object{"threadId": task, "turnId": bind["turnId"]}
	if agent == "codex" {
		event["threadId"] = task
	} else {
		event["taskId"] = task
		op, args = "agent_read", object{"agent": agent, "taskId": task}
	}
	event["next"] = object{"via": "query", "op": "device", "args": object{"device": device["id"], "op": op, "args": args}}
	if interaction := clone(obj(event["interaction"])); interaction != nil {
		interaction["next"] = event["next"]
		if respond := obj(interaction["respond"]); respond != nil {
			interaction["respond"] = object{"op": "device", "args": object{"device": device["id"], "op": respond["op"], "args": respond["args"]}}
		}
		event["interaction"] = interaction
	}
}

func acknowledgeNotificationDeviceRead(device, source, op string, args, value object) error {
	if !notificationTaskReadOperation(op) || value["state"] == "unconfirmed" {
		return nil
	}
	task := str(dispatchFirstString(args["threadId"], args["taskId"]))
	thread := notificationDeviceKey(device, task)
	rows := arr(value["turns"])
	if rows == nil {
		rows = []any{value}
	}
	reads := map[[2]string]bool{}
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	for _, row := range rows {
		if turn := str(dispatchFirstString(field(row, "turnId"), args["turnId"])); turn != "" {
			b, err := readNotificationBinding(thread, turn)
			if err != nil {
				return err
			}
			if b != nil && b["sourceId"] == source {
				reads[[2]string{thread, turn}] = true
			}
		}
	}
	return acknowledgeNotificationReads(source, reads)
}
