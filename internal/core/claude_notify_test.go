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
