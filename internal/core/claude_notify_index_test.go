package core

import (
	"context"
	"testing"
	"time"
)

func TestNotificationIndexRetainsPendingAcrossOwnerPublication(t *testing.T) {
	// Recurring bug class: persistence a restarted index lost pending delivery or revisited dormant history.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := context.Background()
	dir := physicalPath(notificationOwnerPath())
	t.Cleanup(func() { closeNotificationOwner(dir) })
	dormant := newNotificationBinding("older", "turn", "/fixture", "source", time.Now())
	dormant["observation"] = object{"state": "completed", "reconciliation": "reconciled"}
	pending := newNotificationBinding("active", "turn", "/fixture", "source", time.Now())
	pending["deliveries"] = []any{object{"key": "terminal", "eventId": "pending-event", "status": "pending"}}
	for _, row := range []object{dormant, pending} {
		if err := persistNotificationBinding(row); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err := openNotificationOwner(ctx, &service{}); err != nil {
			t.Fatal(err)
		}
		got, err := pendingNotificationBindings()
		if err != nil || len(got) != 1 || got[0]["threadId"] != "active" {
			t.Fatalf("pending index = %v, %v", got, err)
		}
		active, err := activeNotificationBindings()
		if err != nil || len(active) != 1 || active[0]["threadId"] != "active" {
			t.Fatalf("observation index = %v, %v", active, err)
		}
		wakeNotificationThread("older")
		active, err = activeNotificationBindings()
		if err != nil || len(active) != 2 {
			t.Fatalf("woken observation index = %v, %v", active, err)
		}
		closeNotificationOwner(dir)
	}
}
