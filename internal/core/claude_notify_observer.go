package core

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"
)

// A reads the exact turn and supplies native checkpoint, interaction and
// reconciliation evidence without starting or resuming a writer.
var observeNotificationTurn func(context.Context, *service, object) (object, error)
var notificationObservePeer func(string, object)

func notificationObservationReusable(b object) bool {
	observed := obj(b["observation"])
	final := notificationTerminal(text(observed, "state")) && observed["reconciliation"] == "reconciled"
	if !final && observed["reconciliation"] != "unavailable-after-restart" || len(arr(b["waiting"])) != 0 {
		return false
	}
	if slices.Contains([]string{"scheduled", "submitting"}, text(b["retry"], "status")) {
		return false
	}
	return !slices.ContainsFunc(arr(b["deliveries"]), func(row any) bool {
		d := obj(row)
		return obj(d["interaction"]) != nil && field(d["interaction"], "resolved") != true && (d["status"] == "pending" || d["status"] == "sending")
	})
}

func handleNotificationObservation(ctx context.Context, s *service, thread, turn string, observation object) error {
	if mergeNotificationLifecycle == nil {
		return nil
	}
	notificationEventOperation.Lock()
	b, err := readNotificationBinding(thread, turn)
	if err != nil || b == nil || !notificationObservationMatches(b, observation) {
		notificationEventOperation.Unlock()
		return err
	}
	checkpoint, state, reason, conflict := mergeNotificationLifecycle(notificationAgent(b), thread, turn, b["lifecycle"], observation)
	observation = clone(observation)
	observation["state"], observation["reason"], observation["conflict"] = state, reason, conflict
	if checkpoint != nil {
		b["lifecycle"] = checkpoint
	}
	notificationEventOperation.Unlock()

	if state == "failed" && s != nil {
		wait, err := handleNotificationRetry(ctx, s, b, observation)
		if wait || err != nil {
			return err
		}
	}
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	b, err = readNotificationBinding(thread, turn)
	if err != nil || b == nil {
		return err
	}
	checkpoint, state, reason, conflict = mergeNotificationLifecycle(notificationAgent(b), thread, turn, b["lifecycle"], observation)
	observation["state"], observation["reason"], observation["conflict"] = state, reason, conflict
	if checkpoint != nil {
		b["lifecycle"] = checkpoint
	}
	return projectNotificationObservation(b, observation)
}

func projectNotificationObservation(b, observed object) error {
	old := obj(b["observation"])
	state := text(observed, "state")
	diag := object{"state": state, "reason": observed["reason"], "runtimeSource": observed["runtimeSource"], "runtimeStatus": observed["runtimeStatus"],
		"recordedStatus": observed["recordedStatus"], "conflict": observed["conflict"], "observedAt": observed["observedAt"],
		"progressStalled": observed["progressStalled"], "progress": nil, "reconciliation": "reconciled"}
	if state == "unconfirmed" {
		attempts := min(uintOr(old["reconciliationAttempts"], 0)+1, 3)
		diag["observedAt"], diag["reconciliationAttempts"], diag["lastError"] = old["observedAt"], attempts, observed["reason"]
		diag["reconciliation"] = "pending-after-restart"
		if attempts == 3 {
			diag["reconciliation"] = "unavailable-after-restart"
		}
	}
	if observed["progressStalled"] == true {
		progress := obj(observed["progress"])
		diag["progress"] = object{"progressStalled": true, "reason": progress["reason"], "evidence": progress["evidence"], "next": progress["next"]}
	}
	if title := text(observed, "title"); strings.TrimSpace(title) != "" {
		b["threadTitle"] = title
	}
	b["observation"] = diag
	deliveries := arr(b["deliveries"])
	if !notificationObservationChanged(old, diag) {
		diag["observedAt"] = old["observedAt"]
	}
	interaction := arr(observed["interaction"])
	waiting := []any{}
	for _, item := range interaction {
		if field(item, "resolved") != true && field(item, "id") != nil {
			waiting = append(waiting, wire(field(item, "id")))
		}
	}
	if state != "unconfirmed" {
		b["waiting"] = waiting
		for _, item := range deliveries {
			d := obj(item)
			if prior := obj(d["interaction"]); prior != nil && prior["resolved"] != true {
				current := slices.IndexFunc(interaction, func(row any) bool {
					return wire(field(row, "id")) == wire(prior["id"]) && field(row, "resolved") != true
				})
				if current < 0 {
					prior["resolved"] = true
					if d["status"] == "pending" {
						d["status"] = "resolved"
					}
				} else if d["status"] == "pending" {
					d["interaction"] = clone(obj(interaction[current]))
				}
			}
			if d["taskState"] == "interaction-required" && d["interaction"] == nil && d["status"] == "pending" && state != "interaction-required" {
				d["status"] = "resolved"
			}
			if strings.HasPrefix(text(d, "key"), "progress-stalled") && (d["status"] == "pending" || d["status"] == "delivered") &&
				(observed["progressStalled"] != true || field(field(d["progress"], "evidence"), "lastActivityAt") != field(field(observed["progress"], "evidence"), "lastActivityAt")) {
				d["status"] = "resolved"
			}
		}
	}
	type transition struct {
		key, label, taskState string
		interaction           object
	}
	var events []transition
	if observed["conflict"] == nil {
		if notificationTerminal(state) {
			label := state
			if state == "cancelled" {
				label = "interrupted"
			}
			prior := find(deliveries, "key", "terminal")
			if prior == nil && b["scopeEnd"] == nil && !notificationEmptyCompletion(b, observed) {
				events = append(events, transition{"terminal", label, state, nil})
			} else if prior != nil && (prior["status"] == "pending" || prior["status"] == "sending") {
				prior["state"], prior["taskState"] = label, state
				if state == "completed" && observed["finalResponse"] != nil {
					prior["finalResponse"] = observed["finalResponse"]
				}
			}
		} else if state == "interaction-required" {
			for _, item := range interaction {
				if row := obj(item); row != nil && row["resolved"] != true && row["id"] != nil {
					label := "waiting for input"
					if strings.Contains(text(row, "method"), "Approval") {
						label = "waiting for approval"
					}
					events = append(events, transition{"request:" + wire(row["id"]), label, state, row})
				}
			}
			if len(events) == 0 {
				events = append(events, transition{"request:unidentified", "waiting for input", state, nil})
			}
		} else if state == "running" && observed["progressStalled"] == true && b["scopeEnd"] == nil {
			events = append(events, transition{"progress-stalled:" + text(field(observed["progress"], "evidence"), "lastActivityAt"), "stalled", state, nil})
		}
	}
	start := len(deliveries)
	at := notificationClock()
	for _, e := range events {
		if find(deliveries, "key", e.key) != nil {
			continue
		}
		d := object{"subscription": "", "channel": b["channel"], "key": e.key, "target": text(b, "target"),
			"eventId":   hash([]byte(wire([]any{b["agent"], b["threadId"], b["turnId"], e.key}))),
			"createdAt": at.Unix(), "batch": "", "attemptedAt": 0, "attempts": []any{}, "error": nil,
			"state": e.label, "taskState": e.taskState, "status": "pending", "timing": newNotificationTiming(at.UnixMilli()),
			"tokenCharged": false, "failures": 0, "nextAttemptAt": 0, "digest": false}
		if b["peerController"] != nil {
			d["status"] = "inbox-only"
		}
		for _, k := range []string{"externalUserInputs", "changes", "dispatches", "continuation", "reconciliation"} {
			if observed[k] != nil {
				d[k] = observed[k]
			}
		}
		if e.interaction != nil {
			d["interaction"] = clone(e.interaction)
		}
		if state == "completed" && observed["finalResponse"] != nil {
			d["finalResponse"] = observed["finalResponse"]
		} else if observed["error"] != nil && notificationTerminal(state) {
			d["taskError"] = observed["error"]
		}
		if diag["progress"] != nil {
			d["progress"] = diag["progress"]
		}
		deliveries = append(deliveries, d)
	}
	b["deliveries"] = deliveries
	source := text(b, "sourceId")
	for _, item := range deliveries {
		if d := obj(item); obj(d["interaction"]) != nil {
			if err := observeNotificationRouting(notificationAgent(b), text(b, "threadId"), obj(d["interaction"])); err != nil {
				return err
			}
		}
	}
	if controller := text(b, "peerController"); controller != "" {
		if err := persistNotificationBinding(b); err != nil {
			return err
		}
		if notificationObservePeer != nil {
			for _, item := range deliveries[start:] {
				d := obj(item)
				event := notificationEvent(b, d)
				event["state"] = d["state"]
				notificationObservePeer(controller, event)
			}
		}
		return nil
	}
	for _, item := range deliveries[start:] {
		if err := appendNotificationInbox(source, notificationEvent(b, obj(item))); err != nil {
			return err
		}
	}
	if err := refreshNotificationInbox(source, b); err != nil {
		return err
	}
	if err := persistNotificationBinding(b); err != nil {
		return err
	}
	if len(deliveries) > start {
		notificationSignal()
	}
	return nil
}

func refreshNotificationInbox(source string, bind object) error {
	if source == "" {
		return nil
	}
	rows, err := readNotificationInbox(source)
	if err != nil {
		return err
	}
	before := wire(rows)
	for index, row := range rows {
		if d := find(bind["deliveries"], "eventId", text(row, "eventId")); d != nil {
			event := notificationEvent(bind, d)
			for _, k := range []string{"read", "readAt", "attached", "attachedHash"} {
				if value := field(row, k); value != nil {
					event[k] = value
				}
			}
			rows[index] = event
		}
	}
	if wire(rows) != before {
		return save(notificationInboxPath(source), rows)
	}
	return nil
}

func notificationObservationChanged(a, b object) bool {
	previous, next := clone(a), clone(b)
	delete(previous, "observedAt")
	delete(next, "observedAt")
	return wire(previous) != wire(next)
}

func notificationEmptyCompletion(bind, observed object) bool {
	if observed["state"] != "completed" || notificationAgent(bind) != "codex" {
		return false
	}
	if text := str(dispatchFirstString(observed["finalResponse"], field(observed["finalResponse"], "text"))); strings.TrimSpace(text) != "" {
		return false
	}
	return bind["continuationBound"] == true || slices.ContainsFunc(arr(bind["deliveries"]), func(d any) bool {
		return field(field(d, "interaction"), "method") == "request_user_input_async"
	})
}

func recoverNotificationObservations(ctx context.Context, s *service) error {
	if observeNotificationTurn == nil || mergeNotificationLifecycle == nil {
		return nil
	}
	notificationEventOperation.Lock()
	rows, err := notificationBindings()
	notificationEventOperation.Unlock()
	if err != nil {
		return err
	}
	for _, b := range rows {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if notificationObservationReusable(b) || b["scopeEnd"] != nil || b["device"] != nil {
			continue
		}
		observing, cancel := context.WithTimeout(ctx, 10*time.Second)
		observation, err := observeNotificationTurn(observing, s, b)
		cancel()
		if err != nil {
			observation = object{"state": "unconfirmed", "reason": err.Error()}
		}
		if err := handleNotificationObservation(ctx, s, text(b, "threadId"), text(b, "turnId"), observation); err != nil && err.Error() != PortPending {
			recordLog("WARN", fmt.Sprintf("Notification observer: %s", err), nil)
		}
	}
	return nil
}
