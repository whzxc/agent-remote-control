package core

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"
)

type nativeWaitTestRead struct {
	delay time.Duration
	value object
	err   error
}

func runWaitTest(t *testing.T, timeout uint64, reads []nativeWaitTestRead) object {
	t.Helper()
	alive := true
	source := nativeWaitSource{
		alive: func() bool { return alive },
		wake:  func() <-chan struct{} { return nil },
		observe: func(ctx context.Context) (object, error) {
			if len(reads) == 0 {
				<-ctx.Done()
				return nil, ctx.Err()
			}
			read := reads[0]
			reads = reads[1:]
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(read.delay):
				if read.err != nil && read.err.Error() == "DESKTOP_DISCONNECTED" {
					alive = false
				}
				return read.value, read.err
			}
		},
		classify: func(value object, selected **string) object {
			if value["thread"] == nil {
				return clone(value)
			}
			result, _ := classifyCodexObservation(value, selected)
			return result
		},
	}
	args := object{"threadId": "thread", "turnId": "turn", "timeoutMs": timeout, "until": "terminal", "expectedHash": "previous"}
	value, err := runNativeWait(t.Context(), context.Background(), source, args, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	nativeWaitCondition(value, args)
	return value
}

func waitTestObservation(runtime string, flags []any, turns ...any) object {
	return object{"thread": object{"id": "thread", "status": object{"type": runtime, "activeFlags": flags}, "turns": turns}}
}

func TestNativeWaitWireVerdicts(t *testing.T) {
	// Contract: wait results preserve the native state, reason and recorded status wire strings.
	synctest.Test(t, func(t *testing.T) {
		for _, test := range []struct {
			recorded, runtime, state, reason string
			blocked                          bool
		}{
			{"completed", "unknown", "completed", "native-turn-terminal", false},
			{"failed", "notLoaded", "failed", "native-turn-terminal", false},
			{"interrupted", "active", "cancelled", "native-turn-terminal", false},
			{"cancelled", "idle", "cancelled", "native-turn-terminal", false},
			{"inProgress", "unknown", "unconfirmed", "runtime-ownership-unknown", true},
			{"inProgress", "active", "interaction-required", "native-interaction", true},
			{"inProgress", "active", "timeout", "deadline", false},
			{"inProgress", "idle", "unconfirmed", "inconsistent-native-state", false},
			{"", "active", "unconfirmed", "turn-not-found", true},
		} {
			var flags, turns []any
			var recorded any
			if test.blocked {
				flags = []any{"waitingOnApproval"}
			}
			if test.recorded != "" {
				recorded = test.recorded
				turns = []any{object{"id": "turn", "status": test.recorded}}
			}
			observation := waitTestObservation(test.runtime, flags, turns...)
			value := runWaitTest(t, 1000, []nativeWaitTestRead{{value: observation}})
			state, _ := parseTurnWaitState(test.state)
			if value["state"] != test.state || value["reason"] != test.reason || value["recordedStatus"] != recorded ||
				value["runtimeStatus"] != test.runtime || value["conditionMet"] != state.terminal() {
				t.Fatalf("%s / %s: %s", test.recorded, test.runtime, wire(value))
			}
		}
	})
}

func TestNativeWaitConflictingRecordsStayUnconfirmed(t *testing.T) {
	// Recurring bug class: lifecycle contradictory selected native records cannot choose a terminal by arrival order.
	synctest.Test(t, func(t *testing.T) {
		for _, order := range [][2]string{{"completed", "failed"}, {"failed", "completed"}} {
			value := runWaitTest(t, 1000, []nativeWaitTestRead{{value: waitTestObservation("active", nil,
				object{"id": "turn", "status": order[0]}, object{"id": "turn", "status": order[1]},
				object{"id": "other", "status": "interrupted"})}})
			if value["state"] != "unconfirmed" || value["reason"] != "inconsistent-native-state" ||
				value["conditionMet"] != false || value["turnId"] != "turn" {
				t.Fatal(wire(value))
			}
		}
	})
}

func TestNativeWaitResponseCompaction(t *testing.T) {
	// Algorithmic core: text deduplication preserves metadata and terminal bodies.
	for _, body := range []any{"same reply", object{"text": "same reply", "textHash": hash([]byte("same reply")), "itemId": "message", "nextOffset": nil}} {
		initial := object{"turnId": "turn", "runtimeStatus": "active", "finalResponse": body}
		expected := waitSnapshotHash(initial)
		for _, runtime := range []string{"active", "busy"} {
			for _, state := range []turnWaitState{waitTimeout, waitCompleted, waitFailed, waitCancelled, waitInteraction} {
				result := clone(initial)
				result["runtimeStatus"] = runtime
				finishNativeWait(result, state, "deadline", time.Now(), &expected)
				compactNativeWaitResponse(result, object{"expectedHash": expected})
				if result["changed"] != (runtime == "busy") || result["textHash"] != hash([]byte("same reply")) {
					t.Fatal(wire(result))
				}
				if state.keepsResponse() {
					if wire(result["finalResponse"]) != wire(body) || result["finalResponseUnchanged"] != nil {
						t.Fatal(wire(result))
					}
				} else if waitResponseText(result) != "" || result["finalResponseUnchanged"] != true || field(body, "itemId") != field(result["finalResponse"], "itemId") {
					t.Fatal(wire(result))
				}
			}
		}
	}
}

func TestNativeWaitDoesNotMoveInteractionToOlderTurn(t *testing.T) {
	// Algorithmic core: unscoped interactions and owner flags only describe the latest turn.
	value := waitTestObservation("active", []any{"waitingOnApproval"},
		object{"id": "old", "status": "inProgress"}, object{"id": "new", "status": "inProgress"})
	value["pending"] = []any{object{"id": 1, "method": "item/commandExecution/requestApproval", "params": object{"threadId": "thread"}}}
	old, _ := classifyCodexObservation(value, new(new("old")))
	latest, _ := classifyCodexObservation(value, new(new("new")))
	if old["state"] != "running" || len(arr(old["interaction"])) != 0 || latest["state"] != "interaction-required" || len(arr(latest["interaction"])) != 1 {
		t.Fatalf("old %s latest %s", wire(old), wire(latest))
	}
}

func TestNativeWaitReadFailuresAndDeadline(t *testing.T) {
	// Recurring bug class: retry-replay a read failure preserves the last observation and can recover before the wait deadline.
	synctest.Test(t, func(t *testing.T) {
		running := object{"state": "running", "recordedStatus": "inProgress", "observedAt": "last-success", "finalResponse": "partial"}
		final := object{"state": "completed", "finalResponse": "final"}
		for _, message := range []string{"DESKTOP_SNAPSHOT_TIMEOUT", "RPC_TIMEOUT: thread/read", "RPC_TIMEOUT: thread/turns/list"} {
			reads := []nativeWaitTestRead{{value: running}, {err: errors.New(message)}}
			value := runWaitTest(t, 3000, reads)
			if value["state"] != "unconfirmed" || value["reason"] != message || value["observedAt"] != "last-success" || value["recordedStatus"] != "inProgress" {
				t.Fatal(wire(value))
			}
			value = runWaitTest(t, 90000, append(reads, nativeWaitTestRead{value: final}))
			if value["state"] != "completed" || value["conditionMet"] != true || value["finalResponse"] != "final" {
				t.Fatal(wire(value))
			}
		}
		reads := []nativeWaitTestRead{{value: running}}
		for range 10 {
			reads = append(reads, nativeWaitTestRead{delay: 11 * time.Second, value: running})
		}
		value := runWaitTest(t, 300000, append(reads, nativeWaitTestRead{value: final}))
		if value["state"] != "completed" || uintOr(value["elapsedMs"], 0) <= 90000 {
			t.Fatal(wire(value))
		}
		value = runWaitTest(t, 3000, []nativeWaitTestRead{{value: running}, {delay: 9 * time.Second, value: final}})
		if value["state"] != "timeout" || value["reason"] != "deadline" || value["observedAt"] != "last-success" {
			t.Fatal(wire(value))
		}
		value = runWaitTest(t, 3000, []nativeWaitTestRead{{err: errors.New("DESKTOP_DISCONNECTED")}})
		if value["state"] != "unconfirmed" || value["reason"] != "connection-closed" {
			t.Fatal(wire(value))
		}
		value = runWaitTest(t, 3000, []nativeWaitTestRead{{err: errors.New("DESKTOP_SNAPSHOT_TIMEOUT")}, {value: running}})
		if value["state"] != "timeout" || value["reason"] != "deadline" || uintOr(value["elapsedMs"], 0) != 3000 {
			t.Fatal(wire(value))
		}
		value = runWaitTest(t, 15000, []nativeWaitTestRead{{value: running}, {delay: 11 * time.Second, value: final}})
		if value["state"] != "unconfirmed" || value["reason"] != "native-read-timeout" || value["observedAt"] != "last-success" {
			t.Fatal(wire(value))
		}
		value = runWaitTest(t, 1000, nil)
		if value["state"] != "unconfirmed" || value["reason"] != "native-read-timeout" || value["observedAt"] != nil {
			t.Fatal(wire(value))
		}
		for _, state := range []turnWaitState{waitFailed, waitCancelled, waitInteraction, waitUnconfirmed} {
			value = runWaitTest(t, 90000, []nativeWaitTestRead{{value: object{"state": string(state)}}})
			if value["state"] != string(state) || value["conditionMet"] != state.terminal() || uintOr(value["elapsedMs"], 0) >= 100 {
				t.Fatal(wire(value))
			}
		}
	})
}

func TestNativeWaitUsesCompletedMessagesUntilTheTurnSettles(t *testing.T) {
	// Algorithmic core: native completion markers gate streaming text before a terminal or interaction verdict.
	done := object{"id": "done", "type": "agentMessage", "status": "completed", "text": "complete"}
	stream := object{"id": "stream", "type": "agentMessage", "status": "inProgress", "text": "half sentence"}
	turn := object{"id": "turn", "status": "inProgress", "items": []any{done, stream}}
	value := waitTestObservation("active", nil, turn)
	read := func() object {
		result, _ := classifyCodexObservation(value, new(new("turn")))
		return result
	}
	initial := read()
	if waitResponseText(initial) != "complete" {
		t.Fatal(wire(initial))
	}
	stream["text"] = "more streaming"
	if next := read(); waitSnapshotHash(initial) != waitSnapshotHash(next) {
		t.Fatalf("unsettled text changed the public snapshot: %s", wire(next))
	}
	delete(done, "status")
	if result := read(); result["finalResponse"] != nil {
		t.Fatal(wire(result))
	}
	for field, evidence := range map[string]any{"completedItemIds": true, "agentMessageCompletedAtMsById": 1234} {
		turn[field] = object{"done": evidence}
		if result := read(); waitResponseText(result) != "complete" {
			t.Fatal(wire(result))
		}
		delete(turn, field)
	}
	for _, state := range []string{"completed", "failed", "interrupted"} {
		turn["status"] = state
		value = waitTestObservation("idle", nil, turn)
		if result := read(); waitResponseText(result) != stream["text"] {
			t.Fatal(wire(result))
		}
	}
	turn["status"] = "inProgress"
	value = waitTestObservation("active", []any{"waitingOnApproval"}, turn)
	if result := read(); waitResponseText(result) != stream["text"] {
		t.Fatal(wire(result))
	}
}
