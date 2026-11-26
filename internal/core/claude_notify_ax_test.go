package core

import (
	"context"
	"strings"
	"testing"
	"time"
)

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
