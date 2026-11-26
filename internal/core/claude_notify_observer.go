package core

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// A reads the exact turn and supplies native checkpoint, interaction and
// reconciliation evidence without starting or resuming a writer.
var observeNotificationTurn func(context.Context, *service, object) (object, error)
var notificationObservePeer func(string, object)
var notificationCompletionChanges func(context.Context, *service, string, string) any
var notificationIssueResponseToken func(string, object) error

// A locates the canonical read-only native history and reports the writer
// observation without acquiring it.
var notificationObservationEvidence func(context.Context, *service, object) (historyPath, writer string)

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
	incoming := clone(observation)
	if incoming == nil {
		incoming = object{}
	}
	_, nativeState, _, _ := mergeNotificationLifecycle(notificationAgent(b), thread, turn, nil, incoming)
	checkpoint, state, reason, conflict := mergeNotificationLifecycle(notificationAgent(b), thread, turn, b["lifecycle"], incoming)
	observation = clone(incoming)
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
	if s != nil && notificationAgent(b) == "codex" && nativeState == "completed" && !notificationTerminal(text(b["observation"], "state")) &&
		!notificationEmptyCompletion(b, observation) && notificationCompletionChanges != nil {
		incoming["changes"] = notificationCompletionChanges(ctx, s, thread, turn)
	}
	if s != nil && notificationAgent(b) == "codex" && notificationTerminal(nativeState) && b["device"] == nil &&
		!notificationTerminal(text(b["observation"], "state")) && mergeDispatchLifecycle != nil {
		at := text(b["observation"], "observedAt")
		reconciled := text(b["observation"], "reconciliation") == "pending-after-restart" || text(b["observation"], "reconciliation") == "unavailable-after-restart"
		if rows, err := completeDispatch(ctx, s, thread, turn, checkpoint, at, reconciled); err == nil && len(rows) != 0 {
			incoming["dispatches"] = rows
		}
	}
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	b, err = readNotificationBinding(thread, turn)
	if err != nil || b == nil {
		return err
	}
	checkpoint, state, reason, conflict = mergeNotificationLifecycle(notificationAgent(b), thread, turn, b["lifecycle"], incoming)
	observation = clone(incoming)
	observation["state"], observation["reason"], observation["conflict"] = state, reason, conflict
	if checkpoint != nil {
		b["lifecycle"] = checkpoint
	}
	nativeTerminal := notificationTerminal(nativeState) && notificationContinuationState(nativeState) == notificationContinuationState(state)
	return projectNotificationObservation(b, observation, nativeTerminal)
}

func projectNotificationObservation(b, observed object, nativeTerminal bool) error {
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
	if err := adoptNotificationContinuation(b, observed); err != nil {
		return err
	}
	b["observation"] = diag
	if field(b["successor"], "inherited") == true {
		rows, err := notificationBindingsForThread(text(b, "threadId"))
		if err != nil {
			return err
		}
		if next := notificationContinuationNotice(b, observed, rows); next != nil {
			observed["continuation"] = next
		}
	}
	deliveries := arr(b["deliveries"])
	if !notificationObservationChanged(old, diag) {
		diag["observedAt"] = old["observedAt"]
	}
	interaction := arr(observed["interaction"])
	if state != "unconfirmed" {
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
	events := notificationTransitions(b, observed, nativeTerminal)
	if notificationTerminal(state) && nativeTerminal {
		if d := find(deliveries, "key", "terminal"); d != nil && (d["status"] == "pending" || d["status"] == "sending") {
			d["state"], d["taskState"] = notificationContinuationState(state), state
			if state == "completed" && observed["finalResponse"] != nil {
				d["finalResponse"] = observed["finalResponse"]
			}
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

type notificationTransition struct {
	key, label, taskState string
	interaction           object
}

func notificationTransitions(b, observed object, nativeTerminal bool) []notificationTransition {
	state := text(observed, "state")
	if observed["conflict"] != nil {
		return nil
	}
	deliveries := arr(b["deliveries"])
	if notificationTerminal(state) {
		b["waiting"] = []any{}
		if !nativeTerminal || find(deliveries, "key", "terminal") != nil || notificationEmptyCompletion(b, observed) {
			return nil
		}
		return []notificationTransition{{"terminal", notificationContinuationState(state), state, nil}}
	}
	if state == "running" {
		b["waiting"] = []any{}
		if observed["progressStalled"] == true {
			key := "progress-stalled:" + text(field(observed["progress"], "evidence"), "lastActivityAt")
			if find(deliveries, "key", key) == nil {
				return []notificationTransition{{key, "stalled", state, nil}}
			}
		}
	}
	if state != "interaction-required" {
		return nil
	}
	previous := arr(b["waiting"])
	waiting := []any{}
	events := []notificationTransition{}
	add := func(label string, interaction object) {
		waiting = append(waiting, label)
		if id := interaction["id"]; id != nil {
			events = append(events, notificationTransition{"request:" + wire(id), label, state, interaction})
		} else if !slices.Contains(previous, any(label)) {
			events = append(events, notificationTransition{fmt.Sprintf("entry:%d:%s", len(deliveries), label), label, state, nil})
		}
	}
	for _, item := range arr(observed["interaction"]) {
		r := obj(item)
		if r == nil || r["resolved"] == true {
			continue
		}
		method := text(r, "method")
		label := "waiting for input"
		if !strings.Contains(method, "requestUserInput") && method != "request_user_input_async" && !strings.Contains(method, "elicitation") && strings.Contains(strings.ToLower(method), "approval") {
			label = "waiting for approval"
		}
		add(label, r)
	}
	for _, item := range [][2]string{{"waitingOnApproval", "waiting for approval"}, {"waitingOnUserInput", "waiting for input"}} {
		if slices.Contains(arr(observed["activeFlags"]), any(item[0])) && !slices.Contains(waiting, any(item[1])) {
			add(item[1], nil)
		}
	}
	b["waiting"] = waiting
	slices.SortStableFunc(events, func(a, b notificationTransition) int {
		return cmp.Or(strings.Compare(a.key, b.key), strings.Compare(a.label, b.label))
	})
	return slices.CompactFunc(events, func(a, b notificationTransition) bool { return a.key == b.key && a.label == b.label })
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
	defer beginRuntimeWork("notificationObserve")()
	pass := beginRuntimeObservation()
	defer pass.finish()
	finishScan := pass.timePhase("scan")
	notificationEventOperation.Lock()
	rows, err := activeNotificationBindings()
	notificationEventOperation.Unlock()
	finishScan()
	if err != nil {
		return err
	}
	pass.add("bindingsScanned", uint64(len(rows)))
	permits := make(chan struct{}, 8)
	var workers sync.WaitGroup
	var failed sync.Once
	var passError error
	recordError := func(err error) { failed.Do(func() { passError = err }) }
	for _, b := range rows {
		if b["scopeEnd"] != nil || b["device"] != nil {
			continue
		}
		select {
		case <-ctx.Done():
			workers.Wait()
			return ctx.Err()
		case permits <- struct{}{}:
		}
		workers.Go(func() {
			defer func() { <-permits }()
			finishHistory := pass.timePhase("history")
			observing, cancel := context.WithTimeout(ctx, 10*time.Second)
			watch := captureNotificationEvidence(observing, s, b)
			if notificationAgent(b) != "codex" {
				pass.add("historyReads", 1)
			}
			observation, err := observeNotificationTurn(observing, s, b)
			cancel()
			finishHistory()
			if ctx.Err() != nil {
				return
			}
			defer pass.timePhase("process")()
			if err != nil {
				observation = object{"state": "unconfirmed", "reason": err.Error()}
				if errors.Is(err, context.DeadlineExceeded) {
					observation["reason"] = "native-observation-timeout"
				}
				if err := recordUnavailableNotification(b, observation); err != nil {
					recordError(err)
				}
			} else {
				if notificationIssueResponseToken != nil {
					for _, item := range arr(observation["interaction"]) {
						if req := obj(item); req != nil {
							if err := notificationIssueResponseToken(text(b, "sourceId"), req); err != nil {
								recordError(err)
								return
							}
						}
					}
				}
				if err := handleNotificationObservation(ctx, s, text(b, "threadId"), text(b, "turnId"), observation); err != nil {
					recordError(err)
				}
			}
			finishNotificationEvidence(ctx, s, b, watch)
		})
	}
	workers.Wait()
	if err := ctx.Err(); err != nil {
		return err
	}
	if passError != nil {
		return passError
	}
	pass.add("completedPasses", 1)
	return nil
}

func recordUnavailableNotification(previous, observation object) error {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	b, err := readNotificationBinding(text(previous, "threadId"), text(previous, "turnId"))
	if err != nil || b == nil {
		return err
	}
	if notificationObservationChanged(obj(previous["observation"]), obj(b["observation"])) {
		return nil
	}
	checkpoint, state, reason, conflict := mergeNotificationLifecycle(notificationAgent(b), text(b, "threadId"), text(b, "turnId"), b["lifecycle"], observation)
	if checkpoint != nil {
		b["lifecycle"] = checkpoint
	}
	diag := dispatchSetSection(b, "observation")
	attempts := min(uintOr(diag["reconciliationAttempts"], 0)+1, 3)
	diag["reconciliation"], diag["reconciliationAttempts"], diag["lastError"] = "pending-after-restart", attempts, observation["reason"]
	if attempts == 3 {
		diag["reconciliation"] = "unavailable-after-restart"
	}
	diag["state"], diag["reason"], diag["conflict"] = state, reason, conflict
	return persistNotificationBinding(b)
}

func prepareNotificationRestart() error {
	if mergeNotificationLifecycle == nil {
		return nil
	}
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	rows, err := activeNotificationBindings()
	if err != nil {
		return err
	}
	for _, b := range rows {
		if b["device"] != nil {
			continue
		}
		thread, turn := text(b, "threadId"), text(b, "turnId")
		checkpoint, state, reason, conflict := mergeNotificationLifecycle(notificationAgent(b), thread, turn, b["lifecycle"], object{"state": "unconfirmed"})
		if checkpoint != nil {
			b["lifecycle"] = checkpoint
		}
		diag := dispatchSetSection(b, "observation")
		diag["state"], diag["reason"], diag["conflict"] = state, reason, conflict
		if diag["reconciliation"] != "unavailable-after-restart" && (!notificationTerminal(state) || b["continuationBound"] != true && b["scopeEnd"] == nil && uintOr(b["continuationUntil"], 0) > 0) {
			diag["reconciliation"] = "pending-after-restart"
		}
		if err := persistNotificationBinding(b); err != nil {
			return err
		}
	}
	return nil
}

type notificationEvidenceWatch struct {
	paths  map[string]*fileStamp
	writer string
}

func captureNotificationEvidence(ctx context.Context, s *service, b object) notificationEvidenceWatch {
	watch := notificationEvidenceWatch{paths: map[string]*fileStamp{}}
	thread := text(b, "threadId")
	add := func(path string) {
		path = physicalPath(path)
		stamp, err := readStamp(path)
		if err == nil {
			watch.paths[path] = stamp
		}
	}
	if notificationAgent(b) == "codex" && routeID.MatchString(thread) && thread != "." && thread != ".." {
		add(filepath.Join(root(), "execution", thread+".json"))
	}
	if notificationObservationEvidence != nil {
		path, writer := notificationObservationEvidence(ctx, s, b)
		watch.writer = writer
		if path != "" {
			add(path)
		}
	}
	return watch
}

func finishNotificationEvidence(ctx context.Context, s *service, b object, watch notificationEvidenceWatch) {
	thread, turn := text(b, "threadId"), text(b, "turnId")
	current, err := readNotificationBinding(thread, turn)
	if err != nil || current == nil {
		return
	}
	dir := physicalPath(notificationOwnerPath())
	key := filepath.Join(dir, filepath.Base(notificationBindingPath(thread, turn)))
	notificationIndexes.Lock()
	index := notificationIndexes.owners[dir]
	if index == nil {
		notificationIndexes.Unlock()
		return
	}
	index.removeEvidence(key)
	for path := range watch.paths {
		keys := index.evidence[path]
		if keys == nil {
			keys = map[string]bool{}
			index.evidence[path] = keys
			index.nativeEvidence.add(path)
		}
		keys[key] = true
	}
	index.evidenceByBinding[key] = watch
	if notificationObservationReusable(current) {
		delete(index.active, key)
	}
	notificationIndexes.Unlock()
	for path, previous := range watch.paths {
		next, err := readStamp(path)
		if err != nil || !stampSame(next, previous) {
			wakeNotificationEvidence(path)
		}
	}
	if notificationObservationEvidence != nil && watch.writer != "" && ctx.Err() == nil {
		_, writer := notificationObservationEvidence(ctx, s, current)
		if writer != watch.writer {
			wakeNotificationThread(thread)
		}
	}
}

func wakeNotificationEvidence(path string) {
	notificationIndexes.Lock()
	defer notificationIndexes.Unlock()
	for _, index := range notificationIndexes.owners {
		for key := range index.evidence[path] {
			index.active[key] = true
		}
	}
}

func (i *notificationIndex) removeEvidence(key string) {
	watch := i.evidenceByBinding[key]
	for path := range watch.paths {
		keys := i.evidence[path]
		delete(keys, key)
		if len(keys) == 0 {
			delete(i.evidence, path)
			i.nativeEvidence.remove(path)
		}
	}
	delete(i.evidenceByBinding, key)
}
