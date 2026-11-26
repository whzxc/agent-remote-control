package core

import (
	"errors"
	"slices"
)

func validateNotificationSubscription(args any) (object, error) {
	guide := eventGuide()
	invalid := func(reason string) (object, error) {
		return nil, dispatchObjectError(object{"code": -32602, "message": "Invalid notification subscription",
			"data": object{"reason": reason, "guide": object{"tool": "guide", "arguments": object{"topic": "notify"}}, "contract": guide}})
	}
	if checkSchema("event", notificationEventName, "", guide["inputSchema"], args) != nil {
		return invalid("invalid_arguments")
	}
	if field(args, "op") != "task_status" {
		return invalid("unknown_op")
	}
	filters := field(args, "args")
	if checkSchema("event-op", "task_status", "", field(guide["ops"].([]object)[0], "inputSchema"), filters) != nil {
		return invalid("invalid_op_arguments")
	}
	return object{"op": "task_status", "args": filters}, nil
}

func notificationSubscriptionActive(sub object, nowMS int64) bool {
	expiration, exists := uintValue(sub["expiresAt"])
	return !exists || expiration > uint64(nowMS)
}

func notificationSubscriptionMuted(sub object, now int64) bool {
	until, exists := uintValue(sub["until"])
	return sub["muted"] == true && (!exists || until > uint64(now))
}

func notificationSubscriptionPublic(sub object, now int64) object {
	return object{"id": sub["id"], "channel": sub["channel"], "target": sub["target"], "op": sub["op"],
		"args": sub["args"], "turnId": sub["turn"], "active": notificationSubscriptionActive(sub, now*1000),
		"muted": notificationSubscriptionMuted(sub, now), "until": sub["until"], "createdAt": sub["createdAt"], "expiresAt": sub["expiresAt"]}
}

func notificationSubscriptionMatches(sub, bind object) bool {
	if bind["peerController"] != nil || text(sub, "sourceId") == "" || sub["sourceId"] != bind["sourceId"] || sub["op"] != "task_status" {
		return false
	}
	agent := text(bind, "agent")
	isCodex := agent == "" || agent == "codex"
	if turn, ok := sub["turn"].(string); ok && turn != bind["turnId"] {
		return false
	}
	for _, filter := range []string{"threadId", "taskId"} {
		if value, ok := field(sub["args"], filter).(string); ok && (isCodex != (filter == "threadId") || value != bind["threadId"]) {
			return false
		}
	}
	return true
}

func removeNotificationSubscription(state object, subscription string) {
	state["subscriptions"] = slices.DeleteFunc(arr(state["subscriptions"]), func(row any) bool {
		return field(row, "id") == subscription
	})
}

func finishNotificationSubscriptionDeliveries(subscription string) error {
	bindings, err := notificationBindings()
	if err != nil {
		return err
	}
	for _, bind := range bindings {
		modified := false
		for _, value := range arr(bind["deliveries"]) {
			delivery := obj(value)
			if delivery["subscription"] == subscription && (delivery["status"] == "pending" || delivery["status"] == "sending") {
				delivery["status"] = "unsubscribed"
				dispatchSetSection(delivery, "timing")["finishedAt"] = notificationClock().UnixMilli()
				modified = true
			}
		}
		if modified {
			if err := persistNotificationBinding(bind); err != nil {
				return err
			}
		}
	}
	return nil
}

func editNotificationSubscription(sub, args object, now int64) error {
	switch args["action"] {
	case "mute":
		if mode, ok := args["mode"].(string); ok && mode != "mute" {
			return errors.New("Subscription mute supports mode=mute; use threadId for digest")
		}
		until, err := notificationUntil(args, now)
		if err != nil {
			return err
		}
		sub["muted"], sub["until"] = true, until
	case "unmute":
		sub["muted"], sub["until"] = false, nil
	default:
		return errors.New("Use subscriptionId with mute/unmute; use target for breaker; webhook destinations change only through events/subscribe")
	}
	return nil
}

func syncNotificationSubscriptions(state object, bindings []object) {
	touched := make(map[[2]string]bool)
	derived := make(map[string]object)
	ordered := []string{}
	for _, b := range bindings {
		thread, turn := text(b, "threadId"), text(b, "turnId")
		touched[[2]string{thread, turn}] = true
		if b["peerController"] != nil || text(b, "sourceId") == "" || b["target"] == nil {
			continue
		}
		id := "sub_" + hash([]byte(wire([]any{b["channel"], b["sourceId"], b["agent"], thread, turn})))
		if _, exists := derived[id]; !exists {
			ordered = append(ordered, id)
		}
		derived[id] = b
	}
	rows := slices.DeleteFunc(arr(state["subscriptions"]), func(row any) bool {
		s := obj(row)
		thread := str(dispatchFirstString(field(s["args"], "threadId"), field(s["args"], "taskId")))
		return text(s, "sourceId") == "" || s["channel"] != "mcp-events" && touched[[2]string{thread, text(s, "turn")}] && derived[text(s, "id")] == nil
	})
	byID := make(map[string]object)
	for _, row := range rows {
		id := text(row, "id")
		if byID[id] == nil {
			byID[id] = obj(row)
		}
	}
	for _, id := range ordered {
		b := derived[id]
		if s := byID[id]; s != nil {
			s["target"], s["channel"] = b["target"], b["channel"]
			continue
		}
		filter := "threadId"
		if notificationAgent(b) != "codex" {
			filter = "taskId"
		}
		rows = append(rows, object{"id": id, "sourceId": b["sourceId"], "channel": b["channel"], "target": b["target"],
			"op": "task_status", "args": object{filter: b["threadId"]}, "turn": b["turnId"],
			"createdAt": uintOr(b["createdAt"], 0) * 1000, "expiresAt": nil, "webhook": nil, "muted": false, "until": nil})
	}
	state["subscriptions"] = rows
}

func notificationWakes(d object) bool {
	return slices.Contains([]string{"completed", "failed", "interrupted", "stalled", "needs-input"}, notificationKind(d)) &&
		slices.Contains([]string{"completed", "failed", "cancelled", "interrupted", "interaction-required"}, text(d, "taskState")) ||
		d["state"] == "stalled"
}

func routeNotificationSubscriptions(state, b object, now int64) {
	deliveries := arr(b["deliveries"])
	maxSource := len(deliveries)
	active := make(map[string]bool)
	for _, item := range arr(state["subscriptions"]) {
		sub := obj(item)
		if !notificationSubscriptionActive(sub, now*1000) {
			continue
		}
		active[text(sub, "id")] = true
		if !notificationSubscriptionMatches(sub, b) {
			continue
		}
		for _, item := range deliveries[:maxSource] {
			source := obj(item)
			if !notificationWakes(source) || source["status"] == "resolved" || source["status"] == "inbox-only" || field(source["interaction"], "resolved") == true {
				continue
			}
			queued := uintOr(field(source["timing"], "queuedAt"), uintOr(source["createdAt"], 0)*1000)
			if sub["channel"] == "mcp-events" && queued < uintOr(sub["createdAt"], 0) {
				continue
			}
			if slices.ContainsFunc(deliveries, func(row any) bool {
				return field(row, "subscription") == sub["id"] && field(row, "eventId") == source["eventId"]
			}) {
				continue
			}
			if sub["channel"] != "mcp-events" {
				index := slices.IndexFunc(deliveries, func(row any) bool {
					return field(row, "eventId") == source["eventId"] && field(row, "channel") == sub["channel"]
				})
				if index >= 0 {
					obj(deliveries[index])["subscription"] = sub["id"]
					continue
				}
			}
			d := clone(source)
			d["subscription"], d["channel"], d["target"] = sub["id"], sub["channel"], sub["target"]
			d["status"], d["error"], d["batch"], d["attempts"] = "pending", nil, "", []any{}
			d["attemptedAt"], d["tokenCharged"], d["failures"], d["nextAttemptAt"], d["digest"] = 0, false, 0, 0, false
			d["timing"] = newNotificationTiming(field(source["timing"], "queuedAt"))
			deliveries = append(deliveries, d)
		}
	}
	for _, item := range deliveries {
		d := obj(item)
		if d["channel"] == "mcp-events" && d["status"] == "pending" && !active[text(d, "subscription")] {
			d["status"] = "subscription-ended"
		}
	}
	b["deliveries"] = deliveries
}

func newNotificationTiming(queued any) object {
	return object{"queuedAt": queued, "startedAt": nil, "finishedAt": nil, "queueMs": nil, "sendMs": nil, "queueReason": nil}
}
