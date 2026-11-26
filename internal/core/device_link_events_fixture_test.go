//go:build arcfixture

package core

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
)

func TestPeerNotificationFollowsTheSubmittingSourceOverLAN(t *testing.T) {
	// Contract: a member completion reaches only the initiating controller source, and only its device-qualified read acknowledges it.
	const task, turn, source = "fixture-task", "fixture-turn", "fixture-source"
	memberSource := "peer-" + id()
	var mayObserveTerminal atomic.Bool
	var statusProbe atomic.Bool
	prior := mergeNotificationLifecycle
	mergeNotificationLifecycle = func(_, _, _ string, _ any, observation object) (any, string, string, any) {
		return nil, text(observation, "state"), "", nil
	}
	t.Cleanup(func() { mergeNotificationLifecycle = prior })
	controller, device, link := loopbackDeviceController(t, t.TempDir(), func(ctx context.Context, _ string, envelope object) (any, error) {
		body := obj(envelope["body"])
		args := obj(body["args"])
		switch body["op"] {
		case "codex_create", "codex_send":
			if _, exists := args["notify"]; exists {
				return nil, errors.New("controller delivered its upstream notification target to the member")
			}
			if args["title"] == "Lost reply" {
				return nil, errors.New("fixture withheld an accepted write reply")
			}
			ctx = withOrigin(ctx, object{"sourceId": memberSource, "controlTransport": "peer"})
			if err := bindNotification(ctx, args, task, turn, "Fixture task", object{"op": body["op"], "requestId": body["requestId"]}); err != nil {
				return nil, err
			}
		case devicePeerTaskEvents:
			result, err := peerEvents.read(ctx, memberSource, args)
			return egressTool(result, false), err
		case "codex_read":
			if args["statusOnly"] == true {
				statusProbe.Store(true)
				state := "running"
				if mayObserveTerminal.Load() {
					state = "completed"
				}
				return egressTool(object{"threadId": args["threadId"], "turnId": turn, "state": state}, false), nil
			}
		default:
			return nil, errors.New("unexpected fixture request")
		}
		return egressTool(object{"threadId": task, "turnId": turn, "state": "completed", "requestId": body["requestId"]}, false), nil
	})
	ctx := controller.ctx
	baseline, err := controller.peerEventRequest(ctx, link.member, devicePeerTaskEvents, object{})
	if err != nil {
		t.Fatal(err)
	}
	origin := object{"sourceId": source}
	create := object{"device": device, "op": "codex_create", "args": object{"title": "Fixture task",
		"notify": object{"channel": "claude-session", "target": notificationTestTarget}}}
	if _, err := controller.forward(ctx, "act", create, nil, origin); err != nil {
		t.Fatal(err)
	}
	if err := controller.reconcilePeerEvents(ctx, link.member); err != nil || !statusProbe.Load() {
		t.Fatalf("notification did not use its status-only member read: %v", err)
	}
	mayObserveTerminal.Store(true)
	if err := controller.reconcilePeerEvents(ctx, link.member); err != nil {
		t.Fatal(err)
	}
	if err := handleNotificationObservation(ctx, nil, task, turn, object{
		"threadId": task, "turnId": turn, "state": "completed", "recordedStatus": "completed", "finalResponse": "Synthetic completion",
	}); err != nil {
		t.Fatal(err)
	}
	changes, err := controller.peerEventRequest(ctx, link.member, devicePeerTaskEvents, object{"epoch": field(baseline, "epoch"), "cursor": field(baseline, "cursor")})
	events := arr(field(changes, "events"))
	if err != nil || len(events) != 1 {
		t.Fatalf("member peer events %v: %v", changes, err)
	}
	if err := controller.receivePeerEvent(ctx, link.member, obj(field(events[0], "event"))); err != nil {
		t.Fatal(err)
	}
	inbox := func(id string) []any {
		t.Helper()
		rows, err := readNotificationInbox(id)
		if err != nil {
			t.Fatal(err)
		}
		return rows
	}
	rows := inbox(source)
	if len(rows) != 1 || field(field(rows[0], "device"), "id") != device || field(field(rows[0], "next"), "op") != "device" || field(rows[0], "read") == true {
		t.Fatalf("controller inbox %v", rows)
	}
	if rows := inbox(memberSource); len(rows) != 0 {
		t.Fatalf("member kept a duplicate inbox entry %v", rows)
	}
	read := object{"device": device, "op": "codex_read", "args": object{"threadId": task, "turnId": turn}}
	if _, err := controller.forward(ctx, "query", read, nil, object{"sourceId": "other-source"}); err != nil {
		t.Fatal(err)
	}
	if field(inbox(source)[0], "read") == true {
		t.Fatal("a different source acknowledged the device event")
	}
	if _, err := controller.forward(ctx, "query", read, nil, origin); err != nil {
		t.Fatal(err)
	}
	if field(inbox(source)[0], "read") != true {
		t.Fatal("the originating source did not acknowledge its event")
	}
	send := object{"device": device, "op": "codex_send", "args": object{"threadId": task, "prompt": "Continue", "notify": nil}}
	if _, err := controller.forward(ctx, "act", send, nil, origin); err != nil {
		t.Fatalf("explicit null to clear notify was not handled by the controller: %v", err)
	}
	const lostTask = "recovered-task"
	request := id()
	lost := object{"device": device, "op": "codex_create", "args": object{"title": "Lost reply"}}
	if _, err := controller.forward(ctx, "act", lost, request, origin); err == nil || managementErrorCode(err.Error()) != "DEVICE_OUTCOME_UNCERTAIN" {
		t.Fatalf("lost write did not preserve its original receipt: %v", err)
	}
	if b, err := readNotificationBinding(notificationDeviceKey(device, lostTask), turn); err != nil || b != nil {
		t.Fatalf("unidentified dispatch was bound before observing its member event: %v, %v", b, err)
	}
	if err := controller.receivePeerEvent(ctx, link.member, object{
		"threadId": lostTask, "turnId": turn, "kind": "completed", "finalResponse": "Recovered completion",
		"causedBy": object{"requestId": request},
	}); err != nil {
		t.Fatal(err)
	}
	binding, err := readNotificationBinding(notificationDeviceKey(device, lostTask), turn)
	if err != nil || binding["sourceId"] != source || field(binding["causedBy"], "requestId") != request ||
		len(inbox(source)) != 2 || len(inbox("other-source")) != 0 {
		t.Fatalf("member event did not rebind the lost owner: %s, %v", wire(binding), err)
	}
}
