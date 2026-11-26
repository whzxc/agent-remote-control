package core

import (
	"context"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func testNotificationIndexDirectory(t *testing.T) string {
	t.Helper()
	base := t.TempDir()
	t.Setenv("ARC_STATE_DIR", base)
	directory := filepath.Join(base, "notifications")
	t.Cleanup(func() { closeNotificationOwner(physicalPath(filepath.Join(directory, "tasks"))) })
	return directory
}

func TestNotificationIndexRetainsPendingAcrossOwnerPublication(t *testing.T) {
	// Recurring bug class: persistence a restarted index lost pending delivery or revisited dormant history.
	directory := testNotificationIndexDirectory(t)
	ctx := context.Background()
	dir := physicalPath(filepath.Join(directory, "tasks"))
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

func TestNotificationIndexRepairsInterruptedWritePerKey(t *testing.T) {
	// Recurring bug class: persistence a crash before projection publication stranded one canonical notification record.
	directory := testNotificationIndexDirectory(t)
	ctx := context.Background()
	dir := physicalPath(filepath.Join(directory, "tasks"))
	b := newNotificationBinding("task", "turn", "/fixture", "source", time.Now())
	if err := persistNotificationBinding(b); err != nil {
		t.Fatal(err)
	}
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	closeNotificationOwner(dir)
	path := notificationBindingPathIn(directory, "task", "turn")
	b["deliveries"] = []any{object{"eventId": "after-crash", "key": "terminal", "status": "pending"}}
	if err := indexMark(path); err != nil {
		t.Fatal(err)
	}
	if err := save(path, b); err != nil {
		t.Fatal(err)
	}
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	got, err := pendingNotificationBindings()
	if err != nil || len(got) != 1 || find(got[0]["deliveries"], "eventId", "after-crash") == nil {
		t.Fatalf("repair after restart = %v, %v", got, err)
	}
}

func TestNotificationIndexKeepsDormantHistoryOutOfPendingWork(t *testing.T) {
	// Recurring bug class: lifecycle observation and delivery work scaled with completed historical scopes.
	testNotificationIndexDirectory(t)
	ctx := context.Background()
	for i := range 48 {
		b := newNotificationBinding("task", "turn-"+strconv.Itoa(i), "/fixture", "source", time.Now())
		b["observation"] = object{"state": "completed", "reconciliation": "reconciled"}
		if err := persistNotificationBinding(b); err != nil {
			t.Fatal(err)
		}
	}
	b := newNotificationBinding("new", "turn", "/fixture", "source", time.Now())
	b["deliveries"] = []any{object{"key": "terminal", "status": "pending"}}
	if err := persistNotificationBinding(b); err != nil {
		t.Fatal(err)
	}
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		rows, err := activeNotificationBindings()
		if err != nil || len(rows) != 1 || rows[0]["threadId"] != "new" {
			t.Fatalf("observation scope = %v, %v", rows, err)
		}
		rows, err = pendingNotificationBindings()
		if err != nil || len(rows) != 1 || rows[0]["threadId"] != "new" {
			t.Fatalf("delivery scope = %v, %v", rows, err)
		}
	}
}
