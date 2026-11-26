package core

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestNotificationObserverWritesWakeOnlyForExternalEvidence(t *testing.T) {
	// Recurring bug class: concurrency observer-owned writes woke their own derived index and reobserved unchanged bindings.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := withOrigin(t.Context(), object{"sourceId": "source"})
	thread, turn := id(), id()
	if err := bindNotification(ctx, object{"agent": "pi"}, thread, turn, "/fixture", nil); err != nil {
		t.Fatal(err)
	}
	path := notificationBindingPath(thread, turn)
	owner := physicalPath(filepath.Dir(path))
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	defer closeNotificationOwner(owner)
	index, err := notificationStatusIndex()
	if err != nil {
		t.Fatal(err)
	}
	wake := index.collection.watch.wake
	select {
	case <-wake:
	default:
	}
	read := observeNotificationTurn
	t.Cleanup(func() { observeNotificationTurn = read })
	observation := object{"state": "running", "observedAt": "earlier", "reason": "fixture-running"}
	observeNotificationTurn = func(context.Context, *service, object) (object, error) { return clone(observation), nil }
	observe := func() {
		t.Helper()
		if err := recoverNotificationObservations(ctx, &service{}); err != nil {
			t.Fatal(err)
		}
	}
	observe()
	stamp, err := readStamp(path)
	if err != nil || stamp == nil {
		t.Fatalf("persisted observation = %v, %v", stamp, err)
	}
	observation["observedAt"] = "later"
	observe()
	if current, err := readStamp(path); err != nil || !stampSame(current, stamp) {
		t.Fatalf("timestamp-only sample rewrote the binding: %v, %v", current, err)
	}
	observation = object{"state": "completed", "recordedStatus": "completed", "observedAt": "terminal"}
	observe()
	select {
	case <-wake:
		t.Fatal("observer-owned updates woke the file collection")
	case <-time.After(100 * time.Millisecond):
	}
	if rows, err := activeNotificationBindings(); err != nil || len(rows) != 0 {
		t.Fatalf("settled observer work = %v, %v", rows, err)
	}
	binding, err := readNotificationBinding(thread, turn)
	if err != nil {
		t.Fatal(err)
	}
	binding["observation"] = object{"state": "running", "reconciliation": "pending-after-restart"}
	if err := saveBytes(path, []byte(wire(binding))); err != nil {
		t.Fatal(err)
	}
	select {
	case <-wake:
	case <-time.After(time.Second):
		t.Fatal("external evidence did not wake the file collection")
	}
	if rows, err := activeNotificationBindings(); err != nil || len(rows) != 1 || rows[0]["threadId"] != thread {
		t.Fatalf("external observer work = %v, %v", rows, err)
	}
}

func TestNotificationAndInternalReceiptsLeaveBoardMaintenanceIdle(t *testing.T) {
	// Recurring bug class: lifecycle internal receipt and observer reads must preserve admission without maintaining the Board.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := withOrigin(t.Context(), object{"sourceId": "source"})
	store := testReceiptStore(t)
	receipt := reserveTestReceipt(t, store, object{"operation": "send", "state": "completed",
		"coordination": object{"freshness": "admission", "association": object{"resources": []any{"lane:fixture/worker"}}}})
	request := text(receipt, "requestId")
	thread := id()
	if err := bindNotification(ctx, object{"agent": "pi"}, thread, id(), "/fixture", nil); err != nil {
		t.Fatal(err)
	}
	read := observeNotificationTurn
	t.Cleanup(func() { observeNotificationTurn = read })
	observeNotificationTurn = func(context.Context, *service, object) (object, error) {
		return object{"state": "running", "recordedStatus": "inProgress"}, nil
	}
	before := runtimeCosts.counter("bulletinMaintenance").passes.Load()
	for range 3 {
		raw, err := store.read(request, testReceiptSession)
		if err != nil || field(raw["coordination"], "freshness") != "admission" {
			t.Fatalf("internal receipt = %v, %v", raw, err)
		}
		projected := assertProjectedReceipt(t, store, request, testReceiptSession, "completed")
		if field(projected["coordination"], "freshness") != "admission" {
			t.Fatalf("projected receipt = %v", projected)
		}
		if err := recoverNotificationObservations(ctx, &service{}); err != nil {
			t.Fatal(err)
		}
	}
	refreshCoordinationDispatchAdvisory(ctx, object{"requestId": "unrelated", "state": "completed"})
	if got := runtimeCosts.counter("bulletinMaintenance").passes.Load(); got != before {
		t.Fatalf("internal reads scheduled %d Board maintenance passes", got-before)
	}
}

func TestNotificationObservationReusesSettledNativeEvidence(t *testing.T) {
	// Recurring bug class: lifecycle settled observations repeatedly hydrated unchanged native histories.
	b := object{"observation": object{"state": "completed", "reconciliation": "reconciled"}}
	if !notificationObservationReusable(b) {
		t.Fatal("settled observation requires another read")
	}
	obj(b["observation"])["state"] = "cancelled"
	if !notificationObservationReusable(b) {
		t.Fatal("settled interruption requires another read")
	}
	b["retry"] = object{"status": "scheduled"}
	if notificationObservationReusable(b) {
		t.Fatal("scheduled retry was parked")
	}
	delete(b, "retry")
	b["deliveries"] = []any{object{"status": "pending", "interaction": object{"id": "question"}}}
	if notificationObservationReusable(b) {
		t.Fatal("pending request was parked")
	}
}

func TestDormantNativeEvidenceWakesOnlyAffectedNotification(t *testing.T) {
	// Recurring bug class: lifecycle new persisted native evidence failed to reactivate the affected dormant binding.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := context.Background()
	dir := physicalPath(notificationOwnerPath())
	t.Cleanup(func() { closeNotificationOwner(dir) })
	affected := newNotificationBinding("affected", "turn", "/fixture", "source", time.Now())
	unrelated := newNotificationBinding("unrelated", "turn", "/fixture", "source", time.Now())
	for _, b := range []object{affected, unrelated} {
		b["observation"] = object{"state": "unconfirmed", "reconciliation": "unavailable-after-restart"}
		if err := persistNotificationBinding(b); err != nil {
			t.Fatal(err)
		}
	}
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	evidence := captureNotificationEvidence(ctx, &service{}, affected)
	finishNotificationEvidence(ctx, &service{}, affected, evidence)
	if rows, err := activeNotificationBindings(); err != nil || len(rows) != 0 {
		t.Fatalf("idle bindings = %v, %v", rows, err)
	}
	for path := range evidence.paths {
		wakeNotificationEvidence(path)
	}
	if rows, err := activeNotificationBindings(); err != nil || len(rows) != 1 || rows[0]["threadId"] != "affected" {
		t.Fatalf("reactivated bindings = %v, %v", rows, err)
	}
}
