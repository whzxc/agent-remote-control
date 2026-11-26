package core

import (
	"context"
	"testing"
)

func TestMemberNotificationProjectionHasDeviceQualifiedAuthority(t *testing.T) {
	// Recurring bug class: security member event identities and replies crossed device or source boundaries.
	task, turn := "native-task", "native-turn"
	b := object{"threadId": notificationDeviceKey("member", task), "turnId": turn, "agent": "codex",
		"device": object{"id": "member", "name": "Member", "taskId": task}, "sourceId": "source"}
	d := object{"key": "request:req", "taskState": "interaction-required", "interaction": object{"respond": object{"op": "codex_respond", "args": object{"id": "req"}}}}
	event := notificationEvent(b, d)
	if event["threadId"] != task || notificationEventThread(event) != b["threadId"] ||
		field(event["next"], "op") != "device" || field(field(event["next"], "args"), "device") != "member" ||
		field(field(event["interaction"], "respond"), "op") != "device" {
		t.Fatalf("device event = %v", event)
	}
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	if err := bindNotification(withOrigin(context.Background(), object{"sourceId": "source", "controlTransport": "peer"}), object{
		"notify": object{"channel": "claude-session", "target": "session_010000000000000000000018"},
	}, task, turn, "", nil); err != nil {
		t.Fatal(err)
	}
	member, err := readNotificationBinding(task, turn)
	if err != nil || member["target"] != nil || member["peerController"] != "source" {
		t.Fatalf("member binding = %v, %v", member, err)
	}
}
