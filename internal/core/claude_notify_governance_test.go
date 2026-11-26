package core

import (
	"context"
	"testing"
	"time"
)

func TestNotificationStatusCacheExpiresAndRetainsHistory(t *testing.T) {
	// Recurring bug class: persistence cached status retained expired activity or hid full diagnostic history.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := context.Background()
	const target = "session_010000000000000000000018"
	restore := notificationClock
	t.Cleanup(func() { notificationClock = restore })
	at := int64(100)
	notificationClock = func() time.Time { return time.Unix(at, 0) }
	bind := newNotificationBinding("thread", "turn", "/fixture", "source", notificationClock())
	bind["observation"] = object{"state": "completed", "reconciliation": "reconciled"}
	bind["target"], bind["title"] = target, "Original"
	bind["deliveries"] = []any{object{"key": "terminal", "taskState": "completed", "eventId": "event", "status": "delivered", "channel": "claude-session", "target": target, "createdAt": 100}}
	if err := persistNotificationBinding(bind); err != nil {
		t.Fatal(err)
	}
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeNotificationOwner(physicalPath(notificationOwnerPath())) })
	read := func(args object) object {
		value, err := notificationStatus(ctx, operationRequest{args: args, source: requestSource{origin: object{"sourceId": "source"}}})
		if err != nil {
			t.Fatal(err)
		}
		return obj(value)
	}
	for _, step := range []struct {
		at    int64
		count int
	}{{100, 1}, {101, 1}, {3700, 0}} {
		at = step.at
		value := read(object{})
		if got := len(arr(value["deliveries"])); got != step.count {
			t.Fatalf("at %d: %d deliveries, want %d", at, got, step.count)
		}
	}
	full := object{"all": true}
	if got := read(full); len(arr(got["deliveries"])) != 1 {
		t.Fatalf("full history = %v", got)
	}
	bind["title"] = "Changed"
	if err := persistNotificationBinding(bind); err != nil {
		t.Fatal(err)
	}
	if row := find(read(full)["threads"], "threadId", "thread"); row["title"] != "Changed" {
		t.Fatalf("changed thread = %v", row)
	}
}
