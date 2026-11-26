package core

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

const notificationTestTarget = "session_010000000000000000000001"

func notificationDeliveryFixture(t *testing.T) (context.Context, requestSource, func(), *[]string) {
	t.Helper()
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := withOrigin(t.Context(), object{"sourceId": "source"})
	source := requestSource{origin: currentOrigin(ctx)}
	clock, authority, sender := notificationClock, notificationSourceAuthority, notificationSessionSend
	t.Cleanup(func() {
		notificationClock, notificationSourceAuthority, notificationSessionSend = clock, authority, sender
	})
	at := time.Now()
	notificationClock = func() time.Time { return at }
	notificationSourceAuthority = func(context.Context, string) (object, error) { return object{"state": "active"}, nil }
	var sent []string
	notificationSessionSend = func(_ context.Context, channel, _ string, target, body string) error {
		if channel != "claude-session" || target != notificationTestTarget {
			t.Fatalf("delivery route = %s %s", channel, target)
		}
		sent = append(sent, body)
		return nil
	}
	state, err := readNotificationState()
	if err != nil {
		t.Fatal(err)
	}
	settings, err := notificationSettings()
	if err != nil {
		t.Fatal(err)
	}
	target := notificationTarget(state, settings, "source", "claude-session", notificationTestTarget, at.Unix())
	notificationReachability(target)["state"] = "verified"
	if err := saveNotificationState(state); err != nil {
		t.Fatal(err)
	}
	flush := func() {
		t.Helper()
		at = at.Add(time.Minute)
		if err := flushNotifications(ctx, &service{}); err != nil {
			t.Fatal(err)
		}
	}
	return ctx, source, flush, &sent
}

func boundNotificationFixture(t *testing.T, ctx context.Context) (string, string) {
	t.Helper()
	thread, turn := id(), id()
	args := object{"notify": object{"target": notificationTestTarget, "channel": "claude-session"}}
	if err := bindNotification(ctx, args, thread, turn, "/fixture", nil); err != nil {
		t.Fatal(err)
	}
	return thread, turn
}

func observeSelectedNotification(t *testing.T, ctx context.Context, thread, turn, status, runtime, history string) {
	t.Helper()
	native := object{"id": thread, "status": object{"type": runtime},
		"turns": []any{object{"id": turn, "status": status, "items": []any{
			object{"id": "answer", "type": "agentMessage", "text": "Finished with fixture evidence"},
		}}}}
	selected := &turn
	if status == "interrupted" || history != "" {
		reconcileNativeInterruption(native, selected, history)
	}
	observed, lifecycle := projectCodexObservation(object{"thread": native}, &selected)
	observed["_turnLifecycle"] = lifecycle.checkpoint()
	if err := handleNotificationObservation(ctx, nil, thread, turn, observed); err != nil {
		t.Fatal(err)
	}
}

func TestNotificationFirstTerminalDeliversOrReportsBoundedFailure(t *testing.T) {
	// Recurring bug class: retry-replay a first terminal observation must reach delivery or an explicit exhausted outcome.
	ctx, _, flush, sent := notificationDeliveryFixture(t)
	success := notificationSessionSend
	for _, fail := range []bool{false, true} {
		thread, turn := boundNotificationFixture(t, ctx)
		notificationSessionSend = func(ctx context.Context, channel, profile, target, body string) error {
			if err := success(ctx, channel, profile, target, body); err != nil {
				return err
			}
			if fail {
				return errors.New("fixture transport unavailable")
			}
			return nil
		}
		observeSelectedNotification(t, ctx, thread, turn, "completed", "notLoaded", "")
		for range 20 {
			flush()
		}
		status, err := readNotification(ctx, thread, turn, "")
		rows := arr(status["deliveries"])
		want := "delivered"
		if fail {
			want = "failed"
		}
		if err != nil || len(rows) != 1 || field(rows[0], "kind") != "completed" || field(rows[0], "state") != want ||
			fail && text(rows[0], "error") == "" {
			t.Fatalf("first terminal delivery = %v, %v", status, err)
		}
	}
	for _, body := range *sent {
		if !strings.HasPrefix(body, notificationReceiptHeader) || strings.Contains(body, "Finished with fixture evidence") {
			t.Fatalf("notification transport body = %q", body)
		}
	}
}

func TestNotificationSettlesOnlyFromSelectedNativeRollout(t *testing.T) {
	// Recurring bug class: lifecycle stale interruptions and other turns' rollout events could replace the selected terminal.
	ctx, source, flush, sent := notificationDeliveryFixture(t)
	for _, terminal := range []struct{ record, kind string }{{"task_complete", "completed"}, {"turn_aborted", "interrupted"}} {
		thread, turn := boundNotificationFixture(t, ctx)
		rolloutEvent := func(kind, turn string) string {
			return wire(object{"type": "event_msg", "payload": object{"type": kind, "turn_id": turn}})
		}
		history := strings.Join([]string{
			wire(object{"type": "session_meta", "payload": object{"id": thread}}),
			rolloutEvent("task_started", turn),
			wire(object{"type": "response_item", "payload": object{"type": "function_call_output", "output": rolloutEvent("turn_aborted", turn)}}),
			rolloutEvent("turn_aborted", "other-turn"), "",
		}, "\n")
		for _, evidence := range []string{"", history} {
			observeSelectedNotification(t, ctx, thread, turn, "interrupted", "notLoaded", evidence)
		}
		flush()
		before, err := readNotification(ctx, thread, turn, "")
		if err != nil || len(arr(before["deliveries"])) != 0 {
			t.Fatalf("unconfirmed interruption delivered = %v, %v", before, err)
		}
		history += rolloutEvent(terminal.record, turn) + "\n"
		statuses := []string{"interrupted", "interrupted"}
		if terminal.kind == "completed" {
			statuses = []string{"interrupted", "completed", "interrupted"}
		}
		for _, status := range statuses {
			observeSelectedNotification(t, ctx, thread, turn, status, "notLoaded", history)
		}
		flush()
		delivered, err := readNotification(ctx, thread, turn, "")
		rows := arr(delivered["deliveries"])
		if err != nil || len(rows) != 1 || field(rows[0], "kind") != terminal.kind || field(rows[0], "state") != "delivered" {
			t.Fatalf("selected rollout delivery = %v, %v", delivered, err)
		}
		eventID := text(rows[0], "eventId")
		inbox, err := notificationInboxWait(ctx, operationRequest{source: source, args: object{"timeoutMs": 0, "threadIds": []any{thread}}})
		event := find(field(inbox, "events"), "eventId", eventID)
		if err != nil || event["kind"] != terminal.kind || event["threadId"] != thread || event["turnId"] != turn ||
			!strings.Contains((*sent)[len(*sent)-1], text(event, "summary")) {
			t.Fatalf("selected rollout inbox = %v, %v", inbox, err)
		}
	}
}

func TestNotificationRestartReconcilesTerminalWithoutWriter(t *testing.T) {
	// Recurring bug class: retry-replay restart lost a bound terminal or charged the same event again.
	ctx, source, flush, sent := notificationDeliveryFixture(t)
	for _, kind := range []string{"completed", "failed", "interrupted"} {
		thread, turn := boundNotificationFixture(t, ctx)
		var history string
		if kind == "interrupted" {
			history = wire(object{"type": "session_meta", "payload": object{"id": thread}}) + "\n" +
				wire(object{"type": "event_msg", "payload": object{"type": "turn_aborted", "turn_id": turn}}) + "\n"
		}
		observeSelectedNotification(t, ctx, thread, turn, kind, "notLoaded", history)
		flush()
		status := func() (object, object) {
			t.Helper()
			value, err := notificationStatus(ctx, operationRequest{source: source, args: object{"threadId": thread}})
			if err != nil || len(arr(field(value, "deliveries"))) != 1 || len(arr(field(value, "targets"))) != 1 {
				t.Fatalf("notification status = %v, %v", value, err)
			}
			return obj(arr(field(value, "deliveries"))[0]), obj(arr(field(value, "targets"))[0])
		}
		before, tokens := status()
		count := len(*sent)
		for range 3 {
			owner := physicalPath(notificationOwnerPath())
			if err := openNotificationOwner(ctx, &service{}); err != nil {
				t.Fatal(err)
			}
			err := recoverNotificationDeliveries()
			closeNotificationOwner(owner)
			if err != nil {
				t.Fatal(err)
			}
			observeSelectedNotification(t, ctx, thread, turn, kind, "notLoaded", history)
		}
		after, target := status()
		if before["eventId"] != after["eventId"] || after["state"] != "delivered" || after["kind"] != kind ||
			tokens["tokens"] != target["tokens"] || tokens["breaker"] != target["breaker"] || len(*sent) != count {
			t.Fatalf("replayed terminal = %v (before %v), target = %v", after, before, target)
		}
	}
}

func TestNotificationDelayedNativeLossKeepsSelectedCompletion(t *testing.T) {
	// Recurring bug class: lifecycle arrival order cannot turn a recorded completion into an interrupted push.
	ctx, source, flush, _ := notificationDeliveryFixture(t)
	for _, order := range [][3]string{
		{"completed", "lost", "inProgress"}, {"completed", "inProgress", "lost"},
		{"lost", "completed", "inProgress"}, {"lost", "inProgress", "completed"},
		{"inProgress", "completed", "lost"}, {"inProgress", "lost", "completed"},
	} {
		thread, turn := boundNotificationFixture(t, ctx)
		for _, state := range order {
			if state == "lost" {
				loss := object{"threadId": thread, "turnId": turn, "state": "cancelled", "reason": "connection-closed"}
				if err := handleNotificationObservation(ctx, nil, thread, turn, loss); err != nil {
					t.Fatal(err)
				}
				continue
			}
			observeSelectedNotification(t, ctx, thread, turn, state, "active", "")
		}
		flush()
		status, err := readNotification(ctx, thread, turn, "")
		rows := arr(status["deliveries"])
		if err != nil || len(rows) != 1 || field(rows[0], "kind") != "completed" || field(rows[0], "state") != "delivered" {
			t.Fatalf("delivery for %v = %v, %v", order, status, err)
		}
		inbox, err := notificationInboxWait(ctx, operationRequest{source: source, args: object{"timeoutMs": 0, "threadIds": []any{thread}}})
		event := find(field(inbox, "events"), "eventId", text(rows[0], "eventId"))
		if err != nil || event["kind"] != "completed" || event["turnId"] != turn ||
			!strings.Contains(wire(event["finalResponse"]), "Finished with fixture evidence") {
			t.Fatalf("selected completion for %v = %v, %v", order, inbox, err)
		}
	}
}

func TestNotificationNativeResumeSuppressesPredecessorAndKeepsSuccessor(t *testing.T) {
	// Recurring bug class: lifecycle a restarted predecessor could wake after a proven continuation or overwrite its completion.
	ctx, source, flush, sent := notificationDeliveryFixture(t)
	for _, queued := range []bool{false, true} {
		thread, prior := boundNotificationFixture(t, ctx)
		successor := id()
		row := object{"requestId": prior, "threadId": thread, "turnId": prior, "dispatchMode": "new-turn", "origin": source.origin,
			"task": object{"dispatch": object{"model": "model", "effort": "high"}}}
		if err := recordDispatch(row); err != nil {
			t.Fatal(err)
		}
		predecessor := object{"threadId": thread, "turnId": prior, "state": "cancelled", "recordedStatus": "interrupted"}
		if queued {
			if err := handleNotificationObservation(ctx, nil, thread, prior, predecessor); err != nil {
				t.Fatal(err)
			}
			binding, err := readNotificationBinding(thread, prior)
			if err != nil || len(arr(binding["deliveries"])) != 1 {
				t.Fatalf("queued predecessor = %v, %v", binding, err)
			}
			obj(arr(binding["deliveries"])[0])["status"] = "sending"
			if err := persistNotificationBinding(binding); err != nil {
				t.Fatal(err)
			}
		}
		history := strings.Join([]string{
			wire(object{"type": "session_meta", "payload": object{"id": thread}}),
			wire(object{"type": "event_msg", "payload": object{"type": "task_started", "turn_id": prior}}),
			wire(object{"type": "event_msg", "payload": object{"type": "turn_aborted", "turn_id": prior, "completed_at": 1000}}),
			wire(object{"type": "event_msg", "payload": object{"type": "task_started", "turn_id": successor, "started_at": 1010,
				"turn_attribution": object{"turn_trigger": "resume_interrupted_task"}}}),
			wire(object{"type": "turn_context", "payload": object{"turn_id": successor, "cwd": "/fixture", "model": "model", "effort": "high", "service_tier": nil}}),
		}, "\n")
		if !queued {
			next := newNotificationBinding(thread, successor, "/fixture", "source", notificationClock())
			if err := persistNotificationBinding(next); err != nil {
				t.Fatal(err)
			}
			observeSelectedNotification(t, ctx, thread, successor, "completed", "idle", "")
		}
		status := "completed"
		if queued {
			status = "inProgress"
		}
		proof, err := notificationContinuationEvidence(object{"id": thread, "cwd": "/fixture"}, prior,
			object{"id": successor, "status": status, "items": []any{}}, history)
		if err != nil || proof["reason"] != "native-continuation" {
			t.Fatalf("native resume evidence = %v, %v", proof, err)
		}
		if err := recoverNotificationDeliveries(); err != nil {
			t.Fatal(err)
		}
		predecessor["nextTurnId"], predecessor["nativeContinuation"] = successor, proof
		if err := handleNotificationObservation(ctx, nil, thread, prior, predecessor); err != nil {
			t.Fatal(err)
		}
		if queued {
			observeSelectedNotification(t, ctx, thread, successor, "completed", "idle", "")
		}
		if err := handleNotificationObservation(ctx, nil, thread, successor, predecessor); err != nil {
			t.Fatal(err)
		}
		count := len(*sent)
		flush()
		before, err := readNotification(ctx, thread, prior, "")
		delivery := arr(before["deliveries"])
		if err != nil || len(delivery) != 1 || field(delivery[0], "state") != "resolved" || len(*sent) != count+1 ||
			strings.Contains((*sent)[count], notificationGlyphs[3]) {
			t.Fatalf("predecessor after native resume = %v, %v", before, err)
		}
		inbox, err := notificationInboxWait(ctx, operationRequest{source: source, args: object{"timeoutMs": 0, "threadIds": []any{thread}}})
		rows := arr(field(inbox, "events"))
		moved, completed := find(rows, "turnId", prior), find(rows, "turnId", successor)
		if err != nil || len(rows) != 2 || moved["kind"] != "interrupted" || moved["summary"] != notificationGlyphs[4] ||
			field(moved["next"], "op") != "codex_read" || wire(moved["continuation"]) != wire(object{"turnId": successor, "state": "completed"}) ||
			completed["kind"] != "completed" || !strings.Contains(wire(completed["finalResponse"]), "Finished with fixture evidence") {
			t.Fatalf("resumed native inbox = %v, %v", inbox, err)
		}
	}
}

func TestNotificationReplayKeepsInteractionAndTerminalEventIDs(t *testing.T) {
	// Recurring bug class: retry-replay a restarted observer could duplicate native interactions or drop the later completion.
	ctx, source, flush, sent := notificationDeliveryFixture(t)
	thread, turn := id(), id()
	if err := bindNotification(ctx, object{"notify": object{"target": notificationTestTarget, "channel": "claude-session"}}, thread, turn, "/fixture", nil); err != nil {
		t.Fatal(err)
	}
	apply := func(observation object) {
		t.Helper()
		if err := handleNotificationObservation(ctx, nil, thread, turn, observation); err != nil {
			t.Fatal(err)
		}
		flush()
	}
	interaction := func(request int) object {
		return object{"state": "interaction-required", "interaction": []any{object{"id": request, "method": "item/commandExecution/requestApproval"}}}
	}
	apply(interaction(17))
	index := physicalPath(notificationOwnerPath())
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	defer closeNotificationOwner(index)
	if err := recoverNotificationDeliveries(); err != nil {
		t.Fatal(err)
	}
	apply(interaction(17))
	apply(object{"state": "running"})
	apply(interaction(17))
	apply(interaction(18))
	const output = "private fixture completion"
	for range 2 {
		apply(object{"state": "completed", "recordedStatus": "completed", "finalResponse": output})
	}
	status, err := readNotification(ctx, thread, turn, "")
	deliveries := arr(status["deliveries"])
	if err != nil || len(deliveries) != 3 || field(deliveries[2], "kind") != "completed" || len(*sent) != 3 ||
		strings.Contains(strings.Join(*sent, ""), output) {
		t.Fatalf("replayed deliveries = %v, %v", status, err)
	}
	for _, delivery := range deliveries {
		if field(delivery, "state") != "delivered" {
			t.Fatalf("delivery after replay = %v", delivery)
		}
	}
	inbox, err := notificationInboxWait(ctx, operationRequest{source: source, args: object{"timeoutMs": 0}})
	rows := arr(field(inbox, "events"))
	completion := find(rows, "eventId", text(deliveries[2], "eventId"))
	if err != nil || completion["finalResponse"] != output {
		t.Fatalf("completion inbox = %v, %v", inbox, err)
	}
}

func TestNotificationNativeConflictKeepsHistoryAndReleasesOnOrderedEvidence(t *testing.T) {
	// Recurring bug class: lifecycle contradictory native terminal evidence must wait for ordering without rewriting sent history.
	ctx, source, flush, sent := notificationDeliveryFixture(t)
	for _, history := range []struct {
		first, second string
		sentFirst     bool
	}{
		{"interrupted", "completed", true},
		{"completed", "interrupted", false},
		{"interrupted", "completed", false},
	} {
		thread, turn := id(), id()
		args := object{"notify": object{"target": notificationTestTarget, "channel": "claude-session"}}
		if err := bindNotification(ctx, args, thread, turn, "/fixture", nil); err != nil {
			t.Fatal(err)
		}
		apply := func(state string, sequence int) {
			t.Helper()
			observation := object{"state": state, "recordedStatus": state, "nativeSequence": sequence, "finalResponse": "fixture completion"}
			if err := handleNotificationObservation(ctx, nil, thread, turn, observation); err != nil {
				t.Fatal(err)
			}
		}
		apply(history.first, 4)
		if history.sentFirst {
			flush()
		}
		apply(history.second, 4)
		if err := prepareNotificationRestart(); err != nil {
			t.Fatal(err)
		}
		before := len(*sent)
		flush()
		report, err := notificationStatus(ctx, operationRequest{source: source, args: object{"threadId": thread}})
		threads := arr(field(report, "threads"))
		if err != nil || len(threads) != 1 || len(*sent) != before {
			t.Fatalf("conflict published a new push: %v, %v", report, err)
		}
		diagnosis := field(threads[0], "diagnosis")
		conflict := field(field(diagnosis, "observation"), "conflict")
		records := arr(field(conflict, "records"))
		if field(conflict, "turnId") != turn || find(records, "status", "completed") == nil ||
			find(records, "status", "interrupted") == nil ||
			!slices.Contains(arr(field(diagnosis, "reasons")), any("terminal-conflict")) {
			t.Fatalf("conflict diagnosis = %v", diagnosis)
		}
		status, err := readNotification(ctx, thread, turn, "")
		deliveries := arr(status["deliveries"])
		if err != nil || len(deliveries) != 1 {
			t.Fatalf("conflict delivery = %v, %v", status, err)
		}
		delivery := deliveries[0]
		if history.sentFirst {
			inbox, err := notificationInboxWait(ctx, operationRequest{source: source, args: object{"timeoutMs": 0, "threadIds": []any{thread}}})
			event := find(field(inbox, "events"), "eventId", text(delivery, "eventId"))
			if err != nil || field(delivery, "state") != "delivered" || event["kind"] != "interrupted" ||
				event["threadId"] != thread || event["turnId"] != turn {
				t.Fatalf("sent interruption history = %v, %v, %v", status, inbox, err)
			}
			continue
		}
		if field(delivery, "state") != "pending" || field(field(delivery, "timing"), "queueReason") != "terminal-conflict" {
			t.Fatalf("conflicted delivery not held = %v", delivery)
		}
		apply("completed", 5)
		flush()
		status, err = readNotification(ctx, thread, turn, "")
		done := find(status["deliveries"], "eventId", text(delivery, "eventId"))
		if err != nil || done["kind"] != "completed" || done["state"] != "delivered" {
			t.Fatalf("ordered resolution = %v, %v", status, err)
		}
	}
}

func TestNotificationInboxPreservesNativeInteractionAndCheckpoint(t *testing.T) {
	// Recurring bug class: persistence inbox projection stripped the checkpoint from the canonical delivery.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := withOrigin(t.Context(), object{"sourceId": "source"})
	thread, turn := id(), id()
	b := newNotificationBinding(thread, turn, "/fixture", "source", time.Now())
	if err := persistNotificationBinding(b); err != nil {
		t.Fatal(err)
	}
	request := object{"id": "approval", "method": "item/commandExecution/requestApproval",
		"_meta":  object{"source": "native", "_opaque": true},
		"params": object{"command": "fixture command", "_meta": object{"trace": "native-trace"}}}
	checkpoint := turnSnapshot(turnKey{"codex", thread, turn}, "inProgress", nil).checkpoint()
	observation := object{"state": "interaction-required", "recordedStatus": "inProgress", "interaction": []any{request},
		"dispatches": []any{object{"turnId": turn, "_turnLifecycle": checkpoint,
			"terminal":            object{"state": "completed", "_private": true},
			"coordinationPending": []any{object{"kind": "fixture", "_private": true}}}}}
	if err := handleNotificationObservation(ctx, nil, thread, turn, observation); err != nil {
		t.Fatal(err)
	}
	restored, err := readNotificationBinding(thread, turn)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := restoreTurnTransition(restored["lifecycle"]); !ok {
		t.Fatalf("binding lost its checkpoint: %v", restored["lifecycle"])
	}
	deliveries := arr(restored["deliveries"])
	if len(deliveries) != 1 {
		t.Fatalf("deliveries = %v", deliveries)
	}
	dispatches := arr(field(deliveries[0], "dispatches"))
	if len(dispatches) != 1 || wire(field(dispatches[0], "_turnLifecycle")) != wire(checkpoint) {
		t.Fatalf("delivery lost its checkpoint: %v", dispatches)
	}
	inbox, err := notificationInboxWait(ctx, operationRequest{source: requestSource{origin: currentOrigin(ctx)}, args: object{"timeoutMs": 0}})
	events := arr(field(inbox, "events"))
	if err != nil || len(events) != 1 {
		t.Fatalf("inbox = %v, %v", inbox, err)
	}
	publicDispatches := arr(field(events[0], "dispatches"))
	if len(publicDispatches) != 1 || wire(publicDispatches[0]) != wire(object{"turnId": turn,
		"terminal": object{"state": "completed"}, "coordinationPending": []any{object{"kind": "fixture"}}}) {
		t.Fatalf("public dispatches = %v", publicDispatches)
	}
	interaction := field(events[0], "interaction")
	for _, key := range []string{"_meta", "params"} {
		if wire(field(interaction, key)) != wire(request[key]) {
			t.Fatalf("native interaction %s = %v", key, interaction)
		}
	}
}

func TestNotificationTitleSurvivesLaterSteering(t *testing.T) {
	// Recurring bug class: lifecycle completion labels borrowed a later steering prompt.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := withOrigin(t.Context(), object{"sourceId": "source"})
	var batch []notificationDeliveryItem
	for _, title := range []string{"Stable task title", ""} {
		thread, turn := id(), id()
		b := newNotificationBinding(thread, turn, "/fixture", "source", time.Now())
		b["title"] = "Original dispatch first line"
		if err := persistNotificationBinding(b); err != nil {
			t.Fatal(err)
		}
		observed := object{"state": "completed", "recordedStatus": "completed", "title": title,
			"dispatches": []any{object{"turnId": turn, "title": b["title"]}, object{"turnId": turn, "title": "Later steering instruction"}}}
		if err := handleNotificationObservation(ctx, nil, thread, turn, observed); err != nil {
			t.Fatal(err)
		}
		inbox, err := notificationInboxWait(ctx, operationRequest{source: requestSource{origin: currentOrigin(ctx)}, args: object{"timeoutMs": 0, "threadIds": []any{thread}}})
		events := arr(field(inbox, "events"))
		if title == "" {
			title = "Original dispatch first line"
		}
		if err != nil || len(events) != 1 || field(events[0], "title") != title ||
			strings.Contains(text(events[0], "summary"), "Later steering instruction") {
			t.Fatalf("completion label = %v, %v", inbox, err)
		}
		binding, err := readNotificationBinding(thread, turn)
		if err != nil || len(arr(binding["deliveries"])) != 1 {
			t.Fatalf("retained delivery = %v, %v", binding, err)
		}
		batch = append(batch, notificationDeliveryItem{binding, obj(arr(binding["deliveries"])[0])})
	}
	body := notificationBatchMessage(batch)
	for _, item := range batch {
		if !strings.Contains(body, notificationTaskTitle(item.binding)) || !strings.Contains(body, text(item.binding, "threadId")) {
			t.Fatalf("missing task identity from %q", body)
		}
	}
}

func TestNotificationBindingFailureKeepsAcceptedDispatch(t *testing.T) {
	// Recurring bug class: lifecycle binding failure could turn a successful native submission into a failure.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	thread, turn := id(), id()
	if err := persistNotificationBinding(newNotificationBinding(thread, turn, "/fixture", "other-source", time.Now())); err != nil {
		t.Fatal(err)
	}
	ctx := withOrigin(t.Context(), object{"sourceId": "source"})
	result := object{"submitted": true, "turnId": turn}
	receipt := object{"requestId": id(), "operation": "create", "threadId": thread, "turnId": turn, "state": "completed", "result": clone(result)}
	recordNotificationBindingFailure(receipt, bindNotification(ctx, nil, thread, turn, "/fixture", nil))
	public := publicReceipt(receipt)
	if public["state"] != "completed" || field(public["result"], "submitted") != true ||
		public["turnId"] != turn || public["notification"] != "bind-failed" || outcomeError(public) != nil {
		t.Fatalf("successful dispatch after binding failure = %v", public)
	}
}

func TestNotificationStallKeepsDiagnosticAndResolvesAfterProgress(t *testing.T) {
	// Recurring bug class: lifecycle stalled Codex turns lost their one actionable event or stayed stalled after activity resumed.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := withOrigin(t.Context(), object{"sourceId": "source"})
	thread, turn := id(), id()
	binding := newNotificationBinding(thread, turn, "/fixture", "source", time.Now())
	binding["target"] = "session_010000000000000000000001"
	if err := persistNotificationBinding(binding); err != nil {
		t.Fatal(err)
	}
	diagnostic := object{"progressStalled": true, "reason": "native-progress-stalled",
		"evidence": object{"lastItemAt": nil, "unchangedTokenCounts": 2},
		"next":     object{"via": "act", "op": "codex_interrupt", "args": object{"threadId": thread, "turnId": turn}}}
	for range 2 {
		if err := handleNotificationObservation(ctx, nil, thread, turn, object{
			"state": "running", "progressStalled": true, "progress": diagnostic,
		}); err != nil {
			t.Fatal(err)
		}
	}
	inbox, err := notificationInboxWait(ctx, operationRequest{source: requestSource{origin: currentOrigin(ctx)}, args: object{"timeoutMs": 0}})
	events := arr(field(inbox, "events"))
	if err != nil || len(events) != 1 || field(events[0], "kind") != "stalled" ||
		wire(field(events[0], "progress")) != wire(diagnostic) || wire(field(events[0], "next")) != wire(diagnostic["next"]) {
		t.Fatalf("stalled inbox = %v, %v", inbox, err)
	}
	if err := handleNotificationObservation(ctx, nil, thread, turn, object{"state": "running"}); err != nil {
		t.Fatal(err)
	}
	status, err := readNotification(ctx, thread, turn, "")
	deliveries := arr(status["deliveries"])
	if err != nil || len(deliveries) != 1 || field(deliveries[0], "state") != "resolved" ||
		field(deliveries[0], "eventId") != field(events[0], "eventId") {
		t.Fatalf("resolved stall = %v, %v", status, err)
	}
}

func TestNotificationIdlessWaitingRequiresConfirmedStateTransition(t *testing.T) {
	// Recurring bug class: lifecycle incomplete observations created a duplicate idless interaction.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := withOrigin(t.Context(), object{"sourceId": "source"})
	thread, turn := id(), id()
	if err := bindNotification(ctx, nil, thread, turn, "/fixture", nil); err != nil {
		t.Fatal(err)
	}
	waiting := object{"state": "interaction-required", "activeFlags": []any{"waitingOnUserInput"}}
	apply := func(observation object) {
		t.Helper()
		if err := handleNotificationObservation(ctx, nil, thread, turn, observation); err != nil {
			t.Fatal(err)
		}
	}
	inbox := func() []any {
		t.Helper()
		result, err := notificationInboxWait(ctx, operationRequest{source: requestSource{origin: currentOrigin(ctx)}, args: object{"timeoutMs": 0}})
		if err != nil {
			t.Fatal(err)
		}
		return arr(field(result, "events"))
	}
	apply(waiting)
	apply(object{"state": "unconfirmed"})
	apply(object{"state": "timeout"})
	apply(waiting)
	first := inbox()
	if len(first) != 1 || field(first[0], "kind") != "needs-input" {
		t.Fatalf("idless waiting after unconfirmed reads = %v", first)
	}
	apply(object{"state": "running"})
	apply(waiting)
	second := inbox()
	if len(second) != 2 || field(second[0], "eventId") == field(second[1], "eventId") {
		t.Fatalf("idless waiting after confirmed transition = %v", second)
	}
}

func TestNotificationAdmissionRequiresExactTurnWithoutConflict(t *testing.T) {
	// Recurring bug class: lifecycle late predecessor, owner loss and conflicting records could publish a terminal wake.
	b := object{"threadId": "task", "turnId": "current", "agent": "codex", "observation": object{"state": "unconfirmed"}}
	d := object{"key": "terminal", "taskState": "completed", "state": "completed"}
	if notificationObservationMatches(b, object{"threadId": "task", "turnId": "prior"}) || notificationAdmits(b, d) {
		t.Fatal("predecessor or unconfirmed loss became a terminal wake")
	}
	obj(b["observation"])["state"] = "completed"
	if !notificationAdmits(b, d) {
		t.Fatal("confirmed completion was dropped")
	}
	obj(b["observation"])["conflict"] = object{"records": []any{"failed", "completed"}}
	if notificationAdmits(b, d) {
		t.Fatal("conflicted wake was admitted")
	}
}

func TestNotificationDoorbellContainsOnlyGuideLabels(t *testing.T) {
	// Contract: Claude notification doorbell preserves guide vocabulary and fixed header.
	body := notificationDoorbell([]string{"✓ done", "✗ failed", "✓ done", "fixture private task output"})
	if body != notificationReceiptHeader+"\n✗ failed · ✓ done ×2" {
		t.Fatalf("doorbell = %q", body)
	}
	guide := wire(field(field(catalog()["guides"], "en"), "profile-notify"))
	for _, label := range notificationGlyphs {
		if !strings.Contains(guide, label) {
			t.Fatalf("label %q missing from guide", label)
		}
	}
}

func TestNotificationHandoffPreservesHistoryWithoutPush(t *testing.T) {
	// Recurring bug class: lifecycle an observed writer acquisition emitted repeat wakeups or lost its ownership history.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := withOrigin(context.Background(), object{"sourceId": "source"})
	thread, turn := id(), id()
	if err := bindNotification(ctx, object{}, thread, turn, "/fixture", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := observeNotificationOwnership(thread, object{"state": "unheld"}); err != nil {
		t.Fatal(err)
	}
	token, err := beginNotificationAcquisition(ctx, thread)
	if err != nil || token == "" {
		t.Fatalf("acquisition = %q, %v", token, err)
	}
	for range 2 {
		owner, err := observeNotificationOwnership(thread, object{"state": "held", "owner": "connector"})
		history := arr(owner["history"])
		if err != nil || len(history) != 1 || field(history[0], "causedBySourceId") != "source" {
			t.Fatalf("handoff history = %v, %v", owner, err)
		}
	}
	if err := endNotificationAcquisition(thread, token); err != nil {
		t.Fatal(err)
	}
	result, err := notificationInboxWait(ctx, operationRequest{source: requestSource{origin: currentOrigin(ctx)}, args: object{"timeoutMs": 0}})
	events := arr(field(result, "events"))
	if err != nil || len(events) != 1 || field(events[0], "kind") != "handoff" {
		t.Fatalf("handoff inbox = %v, %v", result, err)
	}
	b, err := readNotificationBinding(thread, turn)
	if err != nil || find(b["deliveries"], "status", "pending") != nil {
		t.Fatalf("handoff became a push = %v, %v", b, err)
	}
}

func TestSelectedNotificationReadAcksOnlyItsTurn(t *testing.T) {
	// Recurring bug class: security a selected-turn read acknowledged another turn or source's inbox event.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := context.Background()
	source := requestSource{origin: object{"sourceId": "source"}}
	for _, turn := range []string{"selected", "other"} {
		if err := appendNotificationInbox("source", object{"eventId": turn, "threadId": "task", "turnId": turn, "kind": "completed"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := appendNotificationInbox("foreign", object{"eventId": "foreign", "threadId": "task", "turnId": "selected", "kind": "completed"}); err != nil {
		t.Fatal(err)
	}
	projectNotificationControlResult(ctx, operationRequest{name: "codex_read", source: source, args: object{"threadId": "task", "turnId": "selected", "view": "summary"}},
		object{"state": "completed", "threadId": "task", "turnId": "selected"})
	visible, err := notificationInboxWait(ctx, operationRequest{source: source, args: object{"timeoutMs": 0}})
	rows := arr(field(visible, "events"))
	if err != nil || len(rows) != 1 || field(rows[0], "eventId") != "other" {
		t.Fatalf("source inbox = %v, %v", visible, err)
	}
	foreign, err := notificationInboxWait(ctx, operationRequest{source: requestSource{origin: object{"sourceId": "foreign"}}, args: object{"timeoutMs": 0}})
	if err != nil || uintOr(field(foreign, "unread"), 0) != 1 {
		t.Fatalf("foreign inbox = %v, %v", foreign, err)
	}
}

func TestConflictingNotificationEvidenceCancelsReservedTransport(t *testing.T) {
	// Recurring bug class: concurrency terminal conflict arriving after reservation admitted stale notification transport.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := withOrigin(context.Background(), object{"sourceId": "source"})
	at := notificationClock()
	const target = "session_010000000000000000000018"
	b := newNotificationBinding("task", "turn", "/fixture", "source", at)
	b["target"] = target
	b["observation"] = object{"state": "completed", "conflict": object{"records": []any{"completed", "failed"}}}
	d := object{"eventId": "event", "key": "terminal", "taskState": "completed", "status": "sending", "target": target, "channel": "claude-session",
		"batch": "reserved", "subscription": "sub", "tokenCharged": true, "createdAt": at.Unix(), "timing": newNotificationTiming(at.UnixMilli())}
	b["deliveries"] = []any{d}
	if err := persistNotificationBinding(b); err != nil {
		t.Fatal(err)
	}
	if err := saveNotificationState(object{"targets": []any{}, "threads": []any{}, "subscriptions": []any{
		object{"id": "sub", "sourceId": "source", "channel": "claude-session", "target": target, "op": "task_status"},
	}}); err != nil {
		t.Fatal(err)
	}
	batch := notificationDeliveryBatch{id: "reserved", source: "source", channel: "claude-session", target: target, items: []notificationDeliveryItem{{b, d}}}
	if err := sendNotificationBatch(ctx, &service{}, batch); err != nil {
		t.Fatal(err)
	}
	current, err := readNotification(ctx, "task", "turn", "")
	got := find(current["deliveries"], "eventId", "event")
	if err != nil || got["state"] != "pending" || field(got["timing"], "queueReason") != "terminal-conflict" {
		t.Fatalf("conflicted delivery = %v, %v", current, err)
	}
}

func TestProvenSuccessorSuppressesInterruptedPredecessorWake(t *testing.T) {
	// Recurring bug class: lifecycle late restart observation attempted a redundant interrupted wake after a completed successor.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	b := newNotificationBinding("task", "old", "/fixture", "source", time.Now())
	b["successor"] = object{"turnId": "new", "inherited": true}
	next := newNotificationBinding("task", "new", "/fixture", "source", time.Now())
	next["observation"] = object{"state": "completed", "reconciliation": "reconciled"}
	if err := persistNotificationBinding(next); err != nil {
		t.Fatal(err)
	}
	d := object{"key": "terminal", "taskState": "cancelled", "state": "interrupted", "status": "pending"}
	resolved, err := resolveInterruptedNotification(b, d)
	if err != nil || !resolved || d["status"] != "resolved" || field(d["continuation"], "turnId") != "new" || field(d["continuation"], "state") != "completed" {
		t.Fatalf("late predecessor = %v, %t, %v", d, resolved, err)
	}
}
