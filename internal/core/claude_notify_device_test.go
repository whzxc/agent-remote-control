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

func TestMemberEventKindsStayWithinTheControllerBinding(t *testing.T) {
	// Contract: each supported member event preserves its public kind, device task ID and controller source.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	previous := mergeNotificationLifecycle
	t.Cleanup(func() { mergeNotificationLifecycle = previous })
	mergeNotificationLifecycle = func(_, _, _ string, _ any, obs object) (any, string, string, any) {
		if v := text(obs, "state"); v != "" {
			return nil, v, "", nil
		}
		return nil, "unconfirmed", "", nil
	}
	ctx := context.Background()
	for _, kind := range []string{"completed", "failed", "interrupted", "stalled", "needs-input", "handoff", "recovered"} {
		task, turn := "task-"+kind, "turn-"+kind
		receipt := object{"result": object{"threadId": task, "turnId": turn}}
		bound, err := bindNotificationDevice(ctx, "member", "Member", "owner", "codex_create", object{}, receipt)
		if err != nil || !bound {
			t.Fatalf("%s bind = %t, %v", kind, bound, err)
		}
		event := object{"kind": kind, "eventId": "member-" + kind, "threadId": task, "turnId": turn, "agent": "codex",
			"progress": object{"reason": "fixture"}, "interaction": nil,
			"ownership": object{"eventId": "handoff", "from": "connector", "to": "desktop", "observedAt": now()},
			"recovery":  object{"recoveredAt": now(), "affectedTasks": 1}}
		if kind == "needs-input" {
			event["interaction"] = object{"id": "question", "method": "request_user_input_async", "turnId": turn}
		}
		if err := receiveNotificationDeviceEvent(ctx, nil, "member", "foreign", event); err != nil {
			t.Fatal(err)
		}
		if err := receiveNotificationDeviceEvent(ctx, nil, "member", "owner", event); err != nil {
			t.Fatal(err)
		}
		result, err := notificationInboxWait(ctx, operationRequest{source: requestSource{origin: object{"sourceId": "owner"}},
			args: object{"timeoutMs": 0, "threadIds": []any{task}, "eventTypes": []any{kind}}})
		events := arr(field(result, "events"))
		if err != nil || len(events) != 1 || field(events[0], "kind") != kind || field(events[0], "threadId") != task ||
			field(field(events[0], "device"), "id") != "member" {
			t.Fatalf("%s inbox = %v, %v", kind, result, err)
		}
	}
	if rows, err := readNotificationInbox("foreign"); err != nil || len(rows) != 0 {
		t.Fatalf("foreign inbox = %v, %v", rows, err)
	}
}
