package core

import (
	"context"
	"fmt"
	"testing"
	"time"
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

func TestMemberNotificationReadsStayFlatAcrossRetainedBindings(t *testing.T) {
	// Recurring bug class: persistence one device event must not hydrate or republish retained bindings.
	testNotificationIndexDirectory(t)
	at := time.Now()
	seed := func(task, device, state string, pending bool) {
		t.Helper()
		thread := task
		if device != "" {
			thread = notificationDeviceKey(device, task)
		}
		row := newNotificationBinding(thread, "turn", "/fixture", "owner", at)
		row["observation"] = object{"state": state, "reconciliation": "reconciled"}
		if device != "" {
			row["device"] = object{"id": device, "taskId": task}
		}
		if pending {
			row["deliveries"] = []any{object{"key": "terminal", "eventId": id(), "status": "pending"}}
		}
		if err := persistNotificationBinding(row); err != nil {
			t.Fatal(err)
		}
	}
	for i := range 640 {
		device, state := "", "running"
		if i%2 == 0 {
			device = "other-device"
		}
		if i%3 == 0 {
			state = "completed"
		}
		seed(fmt.Sprintf("retained-%d", i), device, state, i%5 == 0)
	}
	seed("selected", "member", "running", false)
	seed("selected", "", "running", false)
	if err := openNotificationOwner(t.Context(), &service{}); err != nil {
		t.Fatal(err)
	}
	before := notificationDiagnostics()
	event := object{"kind": "completed", "eventId": "native-event", "threadId": "selected", "turnId": "turn",
		"agent": "codex", "title": "Fixture result", "finalResponse": "done"}
	for _, source := range []string{"foreign", "owner"} {
		if err := receiveNotificationDeviceEvent(t.Context(), nil, "member", source, event); err != nil {
			t.Fatal(err)
		}
	}
	after := notificationDiagnostics()
	revision := func(report object) uint64 { return uintOr(field(report["activityIndex"], "revision"), 0) }
	if opened := uintOr(after["fileOpens"], 0) - uintOr(before["fileOpens"], 0); opened > 4 || revision(after)-revision(before) != 1 {
		t.Fatalf("one member event used %d opens and %d index writes", opened, revision(after)-revision(before))
	}
	if err := receiveNotificationDeviceEvent(t.Context(), nil, "member", "owner", event); err != nil {
		t.Fatal(err)
	}
	if replay := notificationDiagnostics(); revision(replay) != revision(after) {
		t.Fatal("event replay republished the binding")
	}
	rows, err := readNotificationInbox("owner")
	if err != nil || len(rows) != 1 || field(rows[0], "threadId") != "selected" ||
		field(field(rows[0], "device"), "id") != "member" || field(field(rows[0], "next"), "op") != "device" {
		t.Fatalf("owner inbox = %v, %v", rows, err)
	}
	local, err := readNotificationBinding("selected", "turn")
	if err != nil || field(local["observation"], "state") != "running" {
		t.Fatalf("member completion altered local binding: %v, %v", local, err)
	}
	beforeReconnect := notificationDiagnostics()
	open, err := openNotificationDeviceBindings("member")
	if err != nil || len(open) != 0 || notificationDiagnostics()["fileOpens"] != beforeReconnect["fileOpens"] {
		t.Fatalf("member reconnect hydrated unrelated records: %v, %v", open, err)
	}
}
