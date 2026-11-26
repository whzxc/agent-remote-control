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
	if err := settleNotificationBatch(batch, notificationDeliveryOutcome{status: "delivered"}, at, ""); err != nil {
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
