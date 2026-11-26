package core

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestNotificationBindingDistinguishesOmittedAndExplicitDestination(t *testing.T) {
	// Contract: an omitted send inherits the exact source's destination, while explicit null closes the scope.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := withOrigin(context.Background(), object{"sourceId": "owner"})
	const target = "session_010000000000000000000018"
	args := object{"notify": object{"channel": "claude-session", "target": target}}
	if err := bindNotification(ctx, args, "thread", "first", "/fixture", object{"op": "codex_create"}); err != nil {
		t.Fatal(err)
	}
	if err := bindNotification(ctx, object{}, "thread", "next", "/fixture", object{"op": "codex_send"}); err != nil {
		t.Fatal(err)
	}
	moved, err := readNotification(ctx, "thread", "next", "")
	if err != nil || moved["target"] != target {
		t.Fatalf("same source continuation = %v, %v", moved, err)
	}
	foreign := withOrigin(context.Background(), object{"sourceId": "foreign"})
	if other, err := readNotification(foreign, "thread", "next", ""); err != nil || other != nil {
		t.Fatalf("foreign read = %v, %v", other, err)
	}
	if err := bindNotification(ctx, object{"notify": nil}, "thread", "quiet", "/fixture", object{"op": "codex_send"}); err != nil {
		t.Fatal(err)
	}
	if quiet, err := readNotification(ctx, "thread", "quiet", ""); err != nil || quiet != nil {
		t.Fatalf("explicit quiet = %v, %v", quiet, err)
	}
	b, err := readNotificationBinding("thread", "next")
	if err != nil || b["scopeEnd"] != "new-unrelated-dispatch" {
		t.Fatalf("retired scope = %v, %v", b, err)
	}
}

func TestLegacyNotificationBindingImportsWithoutReplacingCurrentState(t *testing.T) {
	// Recurring bug class: persistence interrupted notification migration replay replaced an existing durable binding.
	directory := testNotificationIndexDirectory(t)
	ctx := context.Background()
	bind := newNotificationBinding("thread", "turn", "/fixture", "source", time.Now())
	bind["title"] = "Legacy"
	legacy := filepath.Join(directory, "legacy-binding.json")
	if err := save(legacy, bind); err != nil {
		t.Fatal(err)
	}
	if err := migrateNotificationState(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	loaded, err := readNotificationBinding("thread", "turn")
	if err != nil || loaded["title"] != "Legacy" {
		t.Fatalf("legacy binding = %v, %v", loaded, err)
	}
	loaded["title"] = "Current"
	if err := persistNotificationBinding(loaded); err != nil {
		t.Fatal(err)
	}
	if err := save(legacy, bind); err != nil {
		t.Fatal(err)
	}
	if err := migrateNotificationState(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	loaded, err = readNotificationBinding("thread", "turn")
	if err != nil || loaded["title"] != "Current" {
		t.Fatalf("current binding = %v, %v", loaded, err)
	}
}

func TestNotificationVerificationRequiresOneTimeReceivedCode(t *testing.T) {
	// Contract: a send response leaves reachability unverified until the exact target acknowledges its single-use code.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := context.Background()
	target := "antigravity_" + id()
	previous := notificationAntigravitySend
	t.Cleanup(func() { notificationAntigravitySend = previous })
	var received string
	notificationAntigravitySend = func(_ context.Context, sentTarget, body string) error {
		if sentTarget != target {
			return errors.New("unexpected target")
		}
		for _, line := range strings.Split(body, "\n") {
			if code, ok := strings.CutPrefix(line, "◎ ping · "); ok {
				received = code
			}
		}
		return nil
	}
	source := requestSource{origin: object{"sourceId": "scope"}}
	bound, err := notificationControl(ctx, operationRequest{source: source, args: object{"action": "bind", "target": target}})
	if err != nil || field(bound, "bound") != true || field(field(bound, "verification"), "reachability") != "unverified" || received == "" || strings.Contains(wire(bound), received) {
		t.Fatalf("verified before acknowledgement: bound=%v, err=%v", field(bound, "bound"), err)
	}
	ack := operationRequest{source: source, args: object{"target": target, "code": received}}
	foreign := ack
	foreign.source.origin = object{"sourceId": "foreign"}
	if _, err := notificationAcknowledge(ctx, foreign); err == nil {
		t.Fatal("foreign source acknowledged challenge")
	}
	result, err := notificationAcknowledge(ctx, ack)
	if err != nil || field(result, "reachability") != "verified" {
		t.Fatalf("ack = %v, %v", result, err)
	}
	if _, err := notificationAcknowledge(ctx, ack); err == nil || controlFailure(err)["code"] != "HANDSHAKE_INVALID_OR_EXPIRED" {
		t.Fatalf("replayed challenge = %v", err)
	}
}
