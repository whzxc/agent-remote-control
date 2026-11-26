package core

import (
	"context"
	"testing"
	"time"
)

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
