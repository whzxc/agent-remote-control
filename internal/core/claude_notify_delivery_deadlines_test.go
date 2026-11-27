package core

import (
	"context"
	"testing"
	"time"
)

func TestNotificationSettlementKeepsSentHistoryAcrossRebind(t *testing.T) {
	// Recurring bug class: concurrency a control change during transport rewrote the sent destination or dropped its selected wake.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := withOrigin(context.Background(), object{"sourceId": "source"})
	const first = "session_010000000000000000000018"
	const second = "session_010000000000000000000019"
	args := object{"notify": object{"channel": "claude-session", "target": first}}
	if err := bindNotification(ctx, args, "thread", "turn", "/fixture", nil); err != nil {
		t.Fatal(err)
	}
	b, err := readNotificationBinding("thread", "turn")
	if err != nil {
		t.Fatal(err)
	}
	at := time.Now()
	d := object{"eventId": "stable-event", "key": "terminal", "taskState": "completed", "status": "sending", "target": first, "channel": "claude-session",
		"batch": "reserved", "subscription": "sub", "tokenCharged": true, "createdAt": at.Unix(), "timing": newNotificationTiming(at.UnixMilli())}
	b["deliveries"] = []any{d}
	if err := persistNotificationBinding(b); err != nil {
		t.Fatal(err)
	}
	request := operationRequest{source: requestSource{origin: object{"sourceId": "source"}}, args: object{"action": "rebind", "target": second, "threadId": "thread"}}
	if _, err := notificationControl(ctx, request); err != nil {
		t.Fatal(err)
	}
	batch := notificationDeliveryBatch{id: "reserved", source: "source", channel: "claude-session", target: first, items: []notificationDeliveryItem{{b, d}}}
	if err := settleNotificationBatch(ctx, batch, notificationDeliveryOutcome{status: "delivered"}, at, ""); err != nil {
		t.Fatal(err)
	}
	got, err := readNotification(ctx, "thread", "turn", "")
	if err != nil || got["target"] != second || len(arr(got["deliveries"])) != 0 {
		t.Fatalf("new binding = %v, %v", got, err)
	}
	full, err := notificationStatus(ctx, operationRequest{source: request.source, args: object{"all": true}})
	if err != nil {
		t.Fatal(err)
	}
	delivery := find(field(full, "deliveries"), "eventId", "stable-event")
	if delivery["target"] != first || delivery["state"] != "delivered" {
		t.Fatalf("sent history = %v", delivery)
	}
}

func TestNotificationDeliveryParkedDeadlineAndDueKeySurviveRestart(t *testing.T) {
	// Recurring bug class: persistence a stored parked delivery spun or a pending retry woke before its deadline.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := context.Background()
	dir := physicalPath(notificationOwnerPath())
	t.Cleanup(func() { closeNotificationOwner(dir) })
	restore := notificationClock
	t.Cleanup(func() { notificationClock = restore })
	at := int64(100)
	notificationClock = func() time.Time { return time.Unix(at, 0) }
	parked := newNotificationBinding("parked", "turn", "/fixture", "source", notificationClock())
	due := newNotificationBinding("due", "turn", "/fixture", "source", notificationClock())
	for _, b := range []object{parked, due} {
		b["deliveries"] = []any{object{"eventId": b["threadId"], "key": "terminal", "status": "pending"}}
		if err := persistNotificationBinding(b); err != nil {
			t.Fatal(err)
		}
	}
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	for i, b := range []object{parked, due} {
		deadline := []int64{0, 120}[i]
		if err := persistNotificationSchedule(ctx, b, deadline); err != nil {
			t.Fatal(err)
		}
	}
	closeNotificationOwner(dir)
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	nowRows, err := notificationIndexedBindings("delivery-due", nil)
	if err != nil || len(nowRows) != 0 {
		t.Fatalf("early work = %v, %v", nowRows, err)
	}
	at = 120
	nowRows, err = notificationIndexedBindings("delivery-due", nil)
	if err != nil || len(nowRows) != 1 || nowRows[0]["threadId"] != "due" {
		t.Fatalf("due work = %v, %v", nowRows, err)
	}
}

func TestInterruptedNotificationRetainsEventAndTokenCredit(t *testing.T) {
	// Recurring bug class: retry-replay an uncertain send must reuse its event ID and prior token charge after restart.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := t.Context()
	directory := physicalPath(notificationOwnerPath())
	const event = "fixture-interrupted-event"
	at := time.Now()
	binding := newNotificationBinding("thread", "turn", "/fixture", "source", at)
	binding["deliveries"] = []any{object{
		"eventId": event, "key": "request:17", "status": "sending", "attemptedAt": at.Unix(), "tokenCharged": true,
	}}
	if err := persistNotificationBinding(binding); err != nil {
		t.Fatal(err)
	}
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	closeNotificationOwner(directory)
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	defer closeNotificationOwner(directory)
	for range 2 {
		if err := recoverNotificationDeliveries(); err != nil {
			t.Fatal(err)
		}
	}
	row, err := readNotificationBinding("thread", "turn")
	if err != nil {
		t.Fatal(err)
	}
	deliveries := arr(row["deliveries"])
	if len(deliveries) != 1 {
		t.Fatalf("restart duplicated the event: %v", deliveries)
	}
	delivery := obj(deliveries[0])
	if delivery["eventId"] != event || delivery["key"] != "request:17" || delivery["status"] != "pending" ||
		delivery["tokenCharged"] != true || uintOr(delivery["failures"], 0) != 1 ||
		uintOr(delivery["nextAttemptAt"], 0) <= uint64(at.Unix()) {
		t.Fatalf("retry abandoned the original event, token, or backoff: %v", delivery)
	}
}

func TestNotificationControlDuringTransportPreservesNextWake(t *testing.T) {
	// Recurring bug class: concurrency a control change during an in-flight send must preserve its independently selected wake.
	ctx, source, _, _ := notificationDeliveryFixture(t)
	at := notificationClock()
	notificationClock = func() time.Time { return at }
	first, firstTurn := boundNotificationFixture(t, ctx)
	second, secondTurn := boundNotificationFixture(t, ctx)
	observeSelectedNotification(t, ctx, first, firstTurn, "completed", "idle", "")
	observeSelectedNotification(t, ctx, second, secondTurn, "completed", "idle", "")
	change := func(action string) error {
		_, err := notificationControl(ctx, operationRequest{source: source, args: object{"action": action, "threadId": second}})
		return err
	}
	if err := change("mute"); err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	sends := 0
	notificationSessionSend = func(context.Context, string, string, string, string) error {
		sends++
		if sends == 1 {
			close(entered)
			<-release
		}
		return nil
	}
	at = at.Add(10 * time.Second)
	done := make(chan error, 1)
	go func() { done <- flushNotifications(ctx, &service{}) }()
	select {
	case <-entered:
	case err := <-done:
		t.Fatalf("delivery did not reach transport: %v", err)
	case <-time.After(5 * time.Second):
		close(release)
		<-done
		t.Fatal("delivery did not enter the sender")
	}
	metrics, metricsErr := runtimeMetrics(ctx, operationRequest{})
	deliver := uintOr(field(find(field(metrics, "work"), "name", "notificationDelivery"), "inFlight"), 0)
	if deliver == 0 {
		var decoded object
		if err := unmarshalJSON([]byte(wire(metrics)), &decoded); err == nil {
			deliver = uintOr(field(find(decoded["work"], "name", "notificationDelivery"), "inFlight"), 0)
		}
	}
	changeErr := change("unmute")
	close(release)
	flushErr := <-done
	if metricsErr != nil || deliver != 1 || changeErr != nil || flushErr != nil {
		t.Fatalf("delivery in flight = %d, metrics %v, unmute %v, flush %v", deliver, metricsErr, changeErr, flushErr)
	}
	read := func(thread, turn string) string {
		t.Helper()
		row, err := readNotificationBinding(thread, turn)
		if err != nil {
			t.Fatal(err)
		}
		return text(arr(row["deliveries"])[0], "status")
	}
	if read(first, firstTurn) != "delivered" || read(second, secondTurn) != "pending" || sends != 1 {
		t.Fatal("first flush lost the original delivery or sent another selection")
	}
	next, err := nextNotificationSchedulerWake(ctx)
	if err != nil || next != at.Unix()+1 {
		t.Fatalf("unmuted deadline = %d, %v", next, err)
	}
	at = at.Add(time.Second)
	if err := flushNotifications(ctx, &service{}); err != nil || read(second, secondTurn) != "delivered" || sends != 2 {
		t.Fatalf("second delivery did not run on selected wake: %v with %d sends", err, sends)
	}
}

func TestNotificationSchedulingInvalidationSkipsUnchangedIndexWrites(t *testing.T) {
	// Recurring bug class: persistence scheduler invalidation re-read derived index shards for unchanged pending bindings.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := context.Background()
	dir := physicalPath(notificationOwnerPath())
	t.Cleanup(func() { closeNotificationOwner(dir) })
	b := newNotificationBinding("stable", "turn", "/fixture", "source", time.Unix(100, 0))
	b["deliveries"] = []any{object{"eventId": "ev", "key": "terminal", "status": "pending"}}
	if err := persistNotificationBinding(b); err != nil {
		t.Fatal(err)
	}
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	if err := persistNotificationSchedule(ctx, b, 200); err != nil {
		t.Fatal(err)
	}
	costs := new(runtimeCostSet)
	measured := context.WithValue(ctx, runtimeCostKey{}, runtimeCostContext{set: costs, owner: "indexUpdate"})
	cost := costs.counter("indexUpdate")
	invalidateNotificationScheduling()
	if err := persistNotificationSchedule(measured, b, 200); err != nil {
		t.Fatal(err)
	}
	if cost.read.Load() != 0 || cost.changed.Load() != 0 {
		t.Fatalf("unchanged schedule after invalidation triggered disk IO: read=%d changed=%d", cost.read.Load(), cost.changed.Load())
	}
	if err := persistNotificationSchedule(measured, b, 300); err != nil {
		t.Fatal(err)
	}
	if cost.changed.Load() == 0 {
		t.Fatal("changed schedule did not persist to derived index")
	}
}
