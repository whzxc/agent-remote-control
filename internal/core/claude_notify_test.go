package core

import (
	"context"
	"net/http"
	"testing"
)

func TestNotificationSessionForms(t *testing.T) {
	// Contract: Claude cloud and Antigravity target formats.
	claude := "session_010000000000000000000018"
	anti := "550e8400-e29b-41d4-a716-446655440000"
	for raw, want := range map[string]string{claude: claude, "https://claude.ai/code/" + claude + "/?x=1#y": claude,
		"conversation://" + anti: "antigravity_" + anti} {
		if got, err := notificationSessionID(raw); err != nil || got != want {
			t.Fatalf("normalized %q = %q, %v", raw, got, err)
		}
	}
	if _, err := notificationSessionID(anti); err == nil || controlFailure(err)["code"] != "INVALID_CLAUDE_SESSION" {
		t.Fatalf("local UUID accepted: %v", err)
	}
}

func TestTaskSettingsManagementReadback(t *testing.T) {
	// Contract: fixture and production management share the task-settings method, validation and durable defaults.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	service := &service{}
	ctx := context.Background()
	if _, err := service.managementRequest(ctx, "task-settings", http.MethodPut, object{"autoOpenCodex": false, "notificationBucketCapacity": 4}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.managementRequest(ctx, "task-settings", http.MethodPut, object{"notificationWakeLimit": 0}); err == nil {
		t.Fatal("retired setting accepted")
	}
	result, err := service.managementRequest(ctx, "task-settings", http.MethodGet, object{})
	if err != nil || field(result, "autoOpenCodex") != false || uintOr(field(result, "notificationBucketCapacity"), 0) != 4 ||
		uintOr(field(result, "notificationRefillSeconds"), 0) != 60 {
		t.Fatalf("task settings = %v, %v", result, err)
	}
}

func TestNotificationInboxPollAndAckPreserveSourceScope(t *testing.T) {
	// Recurring bug class: security polling or acknowledging a Claude inbox crossed source or session boundaries.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := context.Background()
	const target = "session_010000000000000000000018"
	const otherTarget = "session_010000000000000000000019"
	for _, seed := range []struct{ source, target, event string }{{"one", target, "first"}, {"one", otherTarget, "hidden"}, {"two", target, "foreign"}} {
		if err := appendNotificationInbox(seed.source, object{"eventId": seed.event, "target": seed.target, "channel": "claude-session", "kind": "needs-input"}); err != nil {
			t.Fatal(err)
		}
	}
	owner := requestSource{origin: object{"sourceId": "one", "controlSource": "claude"}}
	request := operationRequest{source: owner, args: object{"target": target, "timeoutMs": 0}}
	for range 2 {
		value, err := notificationInboxWait(ctx, request)
		rows := arr(field(value, "events"))
		if err != nil || len(rows) != 1 || field(rows[0], "eventId") != "first" {
			t.Fatalf("inbox = %v, %v", value, err)
		}
	}
	value, err := notificationAcknowledge(ctx, operationRequest{source: owner, args: object{"eventIds": []any{"first", "foreign"}}})
	if err != nil || uintOr(field(value, "markedRead"), 0) != 1 || wire(field(value, "notFoundEventIds")) != `["foreign"]` {
		t.Fatalf("ack = %v, %v", value, err)
	}
	value, err = notificationInboxWait(ctx, request)
	if err != nil || field(value, "state") != "timeout" {
		t.Fatalf("acknowledged inbox = %v, %v", value, err)
	}
}

func TestNotificationRetentionPreservesOpenAndUnfinishedBindings(t *testing.T) {
	// Algorithmic core: seven-day retirement preserves open scopes and unfinished sends.
	b := object{"createdAt": 100, "observation": object{"state": "completed"}}
	after := int64(100 + 7*24*60*60 + 1)
	if expiredNotificationBinding(b, after, false) {
		t.Fatal("open scope was retired")
	}
	b["scopeEnd"] = "thread-archived"
	if !expiredNotificationBinding(b, after, false) || expiredNotificationBinding(b, after-1, false) {
		t.Fatal("retention boundary changed")
	}
	b["deliveries"] = []any{object{"status": "sending"}}
	if expiredNotificationBinding(b, after, false) {
		t.Fatal("unfinished delivery was retired")
	}
}

func TestNotificationBucketAndEscalationRespectRealRefill(t *testing.T) {
	// Algorithmic core: a full idle bucket pays one full refill interval and escalates at most once per anomaly.
	settings := object{"notificationBucketCapacity": 1, "notificationRefillSeconds": 60, "notificationEscalationSeconds": 5}
	state := object{}
	target := notificationTarget(state, settings, "source", "claude-session", "target", 100)
	notificationCharge(target, settings, 1000)
	notificationRefill(target, settings, 1059)
	if target["tokens"] != uint64(0) {
		t.Fatal("idle history refilled the first spent token")
	}
	if reason := notificationTargetAnomaly(target, settings, 1059, true); reason != "" {
		t.Fatalf("early escalation = %s", reason)
	}
	if reason := notificationTargetAnomaly(target, settings, 1064, true); reason != "token-wait" {
		t.Fatalf("starvation escalation = %s", reason)
	}
	if reason := notificationTargetAnomaly(target, settings, 1065, true); reason != "" {
		t.Fatalf("duplicate escalation = %s", reason)
	}
	notificationRefill(target, settings, 1065)
	notificationTargetAnomaly(target, settings, 1065, false)
	target["breaker"] = true
	if reason := notificationTargetAnomaly(target, settings, 1066, false); reason != "breaker" {
		t.Fatalf("rearmed breaker escalation = %s", reason)
	}
}
