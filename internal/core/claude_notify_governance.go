package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"time"
)

func notificationStatePath() string {
	return filepath.Join(notificationDirectory(), "subscriptions", "state.json")
}

func readNotificationState() (object, error) {
	value, err := load(notificationStatePath())
	if errors.Is(err, os.ErrNotExist) {
		return object{"targets": []any{}, "subscriptions": []any{}, "threads": []any{}}, nil
	}
	if err != nil {
		return nil, err
	}
	result := obj(value)
	if result == nil {
		return nil, errors.New("Invalid notification state")
	}
	for _, key := range []string{"targets", "subscriptions", "threads"} {
		rows := slices.DeleteFunc(arr(result[key]), func(row any) bool { return text(row, "sourceId") == "" })
		if rows == nil {
			rows = []any{}
		}
		result[key] = rows
	}
	return result, nil
}

func saveNotificationState(state object) error {
	path := notificationStatePath()
	old, err := load(path)
	encoded := wire(state)
	if err == nil && wire(old) == encoded {
		return nil
	}
	return saveBytes(path, []byte(encoded))
}

func notificationUntil(args object, now int64) (any, error) {
	if raw, ok := args["until"].(string); ok {
		t, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			return nil, errors.New("until must be RFC3339")
		}
		if t.Unix() <= now {
			return nil, errors.New("until must be in the future")
		}
		return t.Unix(), nil
	}
	return nil, nil
}

func notificationCapacity(settings object) uint64 {
	return min(max(uintOr(settings["notificationBucketCapacity"], 10), 1), 1000)
}

func notificationRefillSeconds(settings object) uint64 {
	return min(max(uintOr(settings["notificationRefillSeconds"], 60), 1), 86400)
}

func notificationRefill(target, settings object, now int64) {
	capacity := notificationCapacity(settings)
	interval := notificationRefillSeconds(settings)
	tokens := min(uintOr(target["tokens"], capacity), capacity)
	refilledAt := uintOr(target["refilledAt"], uint64(now))
	if tokens < capacity && uint64(now) >= refilledAt {
		ticks := (uint64(now) - refilledAt) / interval
		tokens = min(tokens+ticks, capacity)
		refilledAt += ticks * interval
		if tokens == capacity {
			refilledAt = uint64(now)
		}
	}
	target["tokens"], target["refilledAt"] = tokens, refilledAt
	rows := arr(target["batches"])
	target["batches"] = slices.DeleteFunc(rows, func(row any) bool { return uintOr(field(row, "at"), 0)+3600 <= uint64(now) })
}

func notificationCharge(target, settings object, now int64) {
	tokens := uintOr(target["tokens"], 0)
	if tokens == notificationCapacity(settings) {
		target["refilledAt"] = now
	}
	if tokens > 0 {
		target["tokens"] = tokens - 1
	}
}

func findNotificationTarget(state object, source, channel, name string) object {
	for _, row := range arr(state["targets"]) {
		if field(row, "sourceId") == source && field(row, "channel") == channel && field(row, "target") == name {
			return obj(row)
		}
	}
	return nil
}

func notificationTarget(state, settings object, source, channel, name string, now int64) object {
	target := findNotificationTarget(state, source, channel, name)
	if target == nil {
		target = object{"sourceId": source, "channel": channel, "target": name, "tokens": notificationCapacity(settings),
			"refilledAt": now, "breaker": false, "emptySince": nil, "escalated": false, "escalationError": nil,
			"batches": []any{}, "registered": false, "accountId": nil, "reachability": newNotificationReachability()}
		state["targets"] = append(arr(state["targets"]), target)
	}
	notificationRefill(target, settings, now)
	return target
}

func notificationThread(state object, source, thread string, now int64, create bool) object {
	for _, row := range arr(state["threads"]) {
		if field(row, "sourceId") == source && field(row, "threadId") == thread {
			return obj(row)
		}
	}
	if !create {
		return nil
	}
	rule := object{"threadId": thread, "sourceId": source, "mode": "normal", "until": nil, "digestAt": now,
		"rebind": nil, "lastDeliveredAt": nil, "lastAckAt": nil}
	state["threads"] = append(arr(state["threads"]), rule)
	return rule
}

func notificationThreadMode(rule object, now int64) string {
	if until, ok := uintValue(rule["until"]); ok && until <= uint64(now) {
		return "normal"
	}
	if mode := text(rule, "mode"); mode != "" {
		return mode
	}
	return "normal"
}

func notificationStatus(_ context.Context, r operationRequest) (any, error) {
	source := text(r.source.origin, "sourceId")
	if source == "" {
		return nil, errors.New("SOURCE_REQUIRED")
	}
	settings, err := notificationSettings()
	if err != nil {
		return nil, err
	}
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	state, err := readNotificationState()
	if err != nil {
		return nil, err
	}
	bindings, err := notificationBindings()
	if err != nil {
		return nil, err
	}
	now := notificationClock().Unix()
	targetFilter := text(r.args, "target")
	if target, err := notificationSessionID(targetFilter); err == nil {
		targetFilter = target
	}
	threadFilter := text(r.args, "threadId")
	compact := r.args["all"] == false || (r.args["all"] != true && targetFilter == "" && threadFilter == "")
	bound := make(map[string][]object)
	var matched []object
	for _, b := range bindings {
		if b["sourceId"] != source || threadFilter != "" && b["threadId"] != threadFilter {
			continue
		}
		if targetFilter != "" && b["target"] != targetFilter && find(b["deliveries"], "target", targetFilter) == nil {
			continue
		}
		t := text(b, "threadId")
		bound[t] = append(bound[t], b)
		matched = append(matched, b)
	}
	subscriptions, deliveries, targets, threads, unbound := []any{}, []any{}, []any{}, []any{}, []any{}
	targetKeys := make(map[[2]string]bool)
	totalDeliveries, hiddenRecovered, totalSubscriptions, shownBindings := 0, 0, 0, 0
	ensure := func(channel, target string) {
		if target != "" && (targetFilter == "" || targetFilter == target) {
			notificationTarget(state, settings, source, channel, target, now)
			targetKeys[[2]string{channel, target}] = true
		}
	}
	for _, subAny := range arr(state["subscriptions"]) {
		sub := obj(subAny)
		if sub["sourceId"] != source || targetFilter != "" && sub["target"] != targetFilter && sub["id"] != targetFilter {
			continue
		}
		if filter := str(dispatchFirstString(field(sub["args"], "threadId"), field(sub["args"], "taskId"))); threadFilter != "" && filter != "" && filter != threadFilter {
			continue
		}
		totalSubscriptions++
		ensure(text(sub, "channel"), text(sub, "target"))
		if !compact || notificationSubscriptionMuted(sub, now) || (sub["channel"] == "mcp-events" && notificationSubscriptionActive(sub, now*1000)) {
			subscriptions = append(subscriptions, notificationSubscriptionPublic(sub, now))
		}
	}
	pending := make(map[[2]string][]any)
	for _, thread := range keysOfNotificationThreads(bound) {
		rows := bound[thread]
		latest := rows[0]
		for _, b := range rows {
			if uintOr(b["createdAt"], 0) > uintOr(latest["createdAt"], 0) {
				latest = b
			}
		}
		rule := notificationThread(state, source, thread, now, false)
		mode := notificationThreadMode(rule, now)
		showThread := !compact || targetFilter != "" || threadFilter != "" || mode != "normal"
		turns := []any{}
		for _, b := range rows {
			channel := text(b, "channel")
			ensure(channel, text(b, "target"))
			if !compact || b["turnId"] == latest["turnId"] {
				turns = append(turns, object{"turnId": b["turnId"], "channel": b["channel"], "target": b["target"], "causedBy": b["causedBy"], "diagnosis": notificationTurnDiagnosis(b)})
			}
			for _, item := range arr(b["deliveries"]) {
				d := obj(item)
				if targetFilter != "" && d["target"] != targetFilter && d["subscription"] != targetFilter {
					continue
				}
				totalDeliveries++
				channel, target := text(d, "channel"), text(d, "target")
				ensure(channel, target)
				if compact && d["taskState"] == "recovered" {
					hiddenRecovered++
					continue
				}
				isPending := d["status"] == "pending" || d["status"] == "sending"
				recent := uintOr(d["createdAt"], 0)+3600 > uint64(now) || uintOr(d["attemptedAt"], 0)+3600 > uint64(now)
				if compact && !isPending && (!recent || b["turnId"] != latest["turnId"]) {
					continue
				}
				if isPending || recent {
					showThread = true
				}
				kind := notificationKind(d)
				agent := text(b, "agent")
				var threadID, taskID any
				if agent == "" || agent == "codex" {
					threadID = thread
				} else {
					taskID = thread
				}
				attempts := uintOr(d["failures"], 0)
				if slices.Contains([]string{"sending", "delivered", "digested", "callback-accepted"}, text(d, "status")) {
					attempts++
				}
				deliveries = append(deliveries, object{"subscriptionId": d["subscription"], "channel": channel, "target": target,
					"op": "task_status", "eventId": d["eventId"], "kind": kind, "device": b["device"], "threadId": threadID, "taskId": taskID,
					"turnId": b["turnId"], "state": d["status"], "attempts": attempts, "nextAttemptAt": d["nextAttemptAt"], "error": d["error"], "timing": d["timing"]})
				if isPending {
					line := object{"threadId": thread, "turnId": b["turnId"], "eventId": d["eventId"], "kind": kind, "status": d["status"],
						"createdAt": d["createdAt"], "nextAttemptAt": d["nextAttemptAt"], "timing": d["timing"]}
					if target == "" {
						unbound = append(unbound, object{"threadId": thread, "turnId": b["turnId"], "eventId": d["eventId"], "kind": kind, "timing": d["timing"]})
					} else {
						key := [2]string{channel, target}
						pending[key] = append(pending[key], line)
					}
				}
			}
		}
		if showThread {
			shownBindings += len(turns)
			title := str(dispatchFirstString(latest["threadTitle"], latest["title"]))
			if title == "" {
				title = text(latest, "project")
			}
			threads = append(threads, object{"threadId": thread, "device": latest["device"], "nativeThreadId": field(latest["device"], "taskId"),
				"title": title, "ownership": nil, "diagnosis": notificationTurnDiagnosis(latest), "channel": latest["channel"],
				"target": latest["target"], "mode": mode, "until": rule["until"], "lastDeliveredAt": rule["lastDeliveredAt"], "lastAckAt": rule["lastAckAt"], "turns": turns})
		}
	}
	totalTargets := 0
	for _, item := range arr(state["targets"]) {
		t := obj(item)
		if t["sourceId"] != source || targetFilter != "" && t["target"] != targetFilter {
			continue
		}
		key := [2]string{text(t, "channel"), text(t, "target")}
		if !targetKeys[key] && (t["registered"] != true || threadFilter != "") {
			continue
		}
		totalTargets++
		reach := notificationReachability(t)
		expireNotificationReachability(reach, now)
		rows := pending[key]
		if rows == nil {
			rows = []any{}
		}
		batches := arr(t["batches"])
		if batches == nil {
			batches = []any{}
		}
		if compact && targetFilter == "" && reach["state"] == "verified" && len(rows) == 0 && len(batches) == 0 &&
			t["breaker"] != true && t["emptySince"] == nil && t["escalated"] != true {
			continue
		}
		targets = append(targets, object{"channel": key[0], "target": key[1], "registered": t["registered"], "reachability": reach["state"],
			"reason": reach["reason"], "verificationAttempts": reach["attempts"], "verifiedAt": reach["verifiedAt"],
			"lastVerificationDelivery": reach["deliveryStatus"], "lastVerificationError": reach["lastError"], "tokens": t["tokens"],
			"capacity": notificationCapacity(settings), "refillSeconds": notificationRefillSeconds(settings),
			"breaker": t["breaker"], "pending": rows, "recentBatches": batches, "emptySince": t["emptySince"], "escalated": t["escalated"],
			"escalationError": t["escalationError"], "supersededBy": nil})
	}
	result := object{"at": now, "notificationsEnabled": settings["notificationsEnabled"] != false, "recentWindowSeconds": 3600,
		"subscriptions": subscriptions, "deliveries": deliveries, "targets": targets, "threads": threads, "unboundPending": unbound, "mostWokenThreads": []any{},
		"summary": object{"totalTargets": totalTargets, "totalThreads": len(bound), "totalBindings": len(matched), "totalDeliveries": totalDeliveries, "totalSubscriptions": totalSubscriptions,
			"hidden": object{"targets": totalTargets - len(targets), "threads": len(bound) - len(threads), "bindings": len(matched) - shownBindings,
				"deliveries": totalDeliveries - len(deliveries), "subscriptions": totalSubscriptions - len(subscriptions), "recoveredDeliveries": hiddenRecovered}}}
	stripNotificationInternal(result)
	return result, nil
}

func keysOfNotificationThreads(values map[string][]object) []string {
	result := make([]string, 0, len(values))
	for key := range values {
		result = append(result, key)
	}
	slices.Sort(result)
	return result
}

func notificationControl(ctx context.Context, r operationRequest) (any, error) {
	source := text(r.source.origin, "sourceId")
	if source == "" {
		return nil, errors.New("SOURCE_REQUIRED")
	}
	settings, err := notificationSettings()
	if err != nil {
		return nil, err
	}
	action := text(r.args, "action")
	if action == "bind" || action == "verify" || action == "route" {
		return notificationReachabilityControl(ctx, r, source, settings)
	}
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	state, err := readNotificationState()
	if err != nil {
		return nil, err
	}
	result, err := controlNotificationState(state, settings, source, r.args, notificationClock().Unix())
	if err != nil {
		return nil, err
	}
	notificationSignal()
	return result, saveNotificationState(state)
}

func controlNotificationState(state, settings object, source string, args object, now int64) (object, error) {
	action := text(args, "action")
	if id, ok := args["subscriptionId"].(string); ok {
		sub := find(state["subscriptions"], "id", id)
		if sub["sourceId"] != source {
			return nil, errors.New("NOTIFICATION_SUBSCRIPTION_NOT_OWNED_BY_SOURCE")
		}
		previous := notificationSubscriptionPublic(sub, now)
		if err := editNotificationSubscription(sub, args, now); err != nil {
			return nil, err
		}
		return object{"action": action, "subscription": notificationSubscriptionPublic(sub, now), "previous": previous}, nil
	}
	if action == "breaker" {
		name := text(args, "target")
		if target, err := notificationSessionID(name); err == nil {
			name = target
		}
		channel := notificationTargetChannel(name)
		if sub := find(state["subscriptions"], "target", name); sub["sourceId"] == source {
			channel = text(sub, "channel")
		} else if target := findNotificationTarget(state, source, channel, name); target["registered"] != true {
			return nil, errors.New("NOTIFICATION_TARGET_NOT_BOUND_TO_SOURCE")
		}
		target := notificationTarget(state, settings, source, channel, name, now)
		enabled, valid := args["enabled"].(bool)
		if !valid {
			return nil, errors.New("enabled is required")
		}
		previous := target["breaker"] == true
		target["breaker"] = enabled
		if previous && !enabled {
			target["escalated"], target["escalationError"], target["emptySince"] = false, nil, nil
		}
		return object{"action": action, "target": name, "enabled": enabled, "previous": previous}, nil
	}
	thread := text(args, "threadId")
	bindings, err := notificationBindings()
	if err != nil {
		return nil, err
	}
	bindings = slices.DeleteFunc(bindings, func(b object) bool { return b["sourceId"] != source || b["threadId"] != thread })
	if len(bindings) == 0 {
		return nil, errors.New("NOTIFICATION_THREAD_NOT_BOUND_TO_SOURCE")
	}
	b := bindings[0]
	rule := notificationThread(state, source, thread, now, true)
	previous, previousTarget := clone(rule), b["target"]
	switch action {
	case "mute":
		mode := text(args, "mode")
		if mode == "" {
			mode = "mute"
		}
		if mode != "mute" && mode != "digest" {
			return nil, errors.New("mode must be mute or digest")
		}
		until, err := notificationUntil(args, now)
		if err != nil {
			return nil, err
		}
		if rule["mode"] != mode {
			rule["digestAt"] = now
		}
		rule["mode"], rule["until"] = mode, until
	case "unmute":
		rule["mode"], rule["until"] = "normal", nil
	case "rebind":
		raw, supplied := args["target"]
		name, isString := raw.(string)
		if !supplied || (!isString && raw != nil) {
			return nil, errors.New("target must be a session or null")
		}
		var destination any
		channel := text(b, "channel")
		if isString {
			target, err := notificationSessionID(name)
			if err != nil {
				return nil, err
			}
			destination, channel = target, notificationTargetChannel(target)
		}
		rule["rebind"] = object{"target": destination, "channel": channel}
		if err := saveNotificationState(state); err != nil {
			return nil, err
		}
		for _, row := range bindings {
			applyNotificationRebind(row, rule)
			if err := persistNotificationBinding(row); err != nil {
				return nil, err
			}
		}
	default:
		return nil, errors.New("Unknown notification action")
	}
	return object{"action": action, "threadId": thread, "previous": previous, "previousTarget": previousTarget, "control": rule}, nil
}

func init() {
	registerOperation("notify_status", notificationStatus, nil)
	registerOperation("notify_control", notificationControl, nil)
}
