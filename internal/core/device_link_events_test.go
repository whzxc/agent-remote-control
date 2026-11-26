package core

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestPeerEventCursorReportsOverflowWithoutReplaying(t *testing.T) {
	// Contract: a stale cursor or epoch reports a gap and results obey the peer frame and batch limits.
	queue := &deviceEventQueue{}
	const source = "paired-source"
	read := func(args object) object {
		t.Helper()
		reply, err := queue.read(t.Context(), source, args)
		if err != nil {
			t.Fatal(err)
		}
		return reply
	}
	epoch := read(object{})["epoch"]
	for i := range 266 {
		queue.publish(source, object{"eventId": fmt.Sprintf("fixture-%d", i), "payload": strings.Repeat("x", 65_400)})
	}
	gap := read(object{"cursor": 0, "epoch": epoch})
	if gap["gap"] != true || uintOr(gap["cursor"], 0) != 266 || len(gap["events"].([]object)) != 0 {
		t.Fatalf("stale peer cursor %v", gap)
	}
	batch := read(object{"cursor": 10, "epoch": epoch})
	if batch["gap"] != false || uintOr(batch["cursor"], 0) != 70 || len(batch["events"].([]object)) != 60 ||
		len(wire(object{"ok": true, "result": egressTool(batch, false)})) >= 4*1024*1024 {
		t.Fatal("peer event batch exceeded its wire or cursor limits")
	}
	fresh := read(object{"cursor": 10, "epoch": "stale-epoch"})
	if fresh["gap"] != true || len(fresh["events"].([]object)) != 0 {
		t.Fatalf("old peer epoch %v", fresh)
	}
}

func TestPeerEventLongPollWakesAndBoundsWait(t *testing.T) {
	// Contract: a peer event wakes a cursor long poll, and waits beyond 15 seconds fail before admission.
	queue := &deviceEventQueue{}
	const source = "paired-source"
	baseline, err := queue.read(t.Context(), source, object{})
	if err != nil {
		t.Fatal(err)
	}
	type result struct {
		value object
		err   error
	}
	waiting := make(chan result, 1)
	go func() {
		value, err := queue.read(t.Context(), source, object{"epoch": baseline["epoch"], "cursor": baseline["cursor"], "waitMs": 15_000})
		waiting <- result{value, err}
	}()
	queue.publish(source, object{"kind": "needs-input", "threadId": "fixture-task", "turnId": "fixture-turn"})
	select {
	case result := <-waiting:
		if result.err != nil {
			t.Fatal(result.err)
		}
		events := result.value["events"].([]object)
		if len(events) != 1 || field(events[0]["event"], "kind") != "needs-input" {
			t.Fatalf("long-poll result %v", result.value)
		}
	case <-time.After(time.Second):
		t.Fatal("peer event did not wake the long poll")
	}
	if _, err := queue.read(t.Context(), source, object{"waitMs": 15_001}); err == nil || !strings.HasPrefix(err.Error(), "INVALID_ARGUMENT:") {
		t.Fatalf("oversized wait: %v", err)
	}
}
