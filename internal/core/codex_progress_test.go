package core

import (
	"context"
	"testing"
	"time"
)

func progressFixtureAt(seconds int64) int64 { return 1_767_225_600_000 + seconds*1000 }

func progressFixtureRow(at int64, kind string, payload object) string {
	return wire(object{"timestamp": time.UnixMilli(progressFixtureAt(at)).UTC().Format(time.RFC3339), "type": kind, "payload": payload}) + "\n"
}

func progressFixtureStart() string {
	return progressFixtureRow(0, "event_msg", object{"type": "task_started", "turn_id": "turn"})
}

func TestCodexProgressRecognizesMidTurnStalls(t *testing.T) {
	// Recurring bug class: lifecycle inactivity can stall either before the first output or during a native turn without token samples.
	history := progressFixtureStart()
	activity := codexProgressHistory(history, "turn")
	if activity.diagnostic("thread", "turn", progressFixtureAt(179)) != nil {
		t.Fatal("stall was reported before the threshold")
	}
	diagnosis := activity.diagnostic("thread", "turn", progressFixtureAt(180))
	if diagnosis["progressStalled"] != true || uintOr(field(diagnosis["evidence"], "unchangedTokenCounts"), 1) != 0 ||
		field(diagnosis["next"], "op") != "codex_interrupt" {
		t.Fatal(wire(diagnosis))
	}
	history += progressFixtureRow(200, "response_item", object{"id": "message", "type": "message", "role": "assistant", "content": []any{}})
	activity = codexProgressHistory(history, "turn")
	if activity.diagnostic("thread", "turn", progressFixtureAt(379)) != nil ||
		activity.diagnostic("thread", "turn", progressFixtureAt(380))["progressStalled"] != true {
		t.Fatal("mid-turn response did not reset inactivity")
	}

	t.Setenv("ARC_STATE_DIR", t.TempDir())
	t.Setenv("CODEX_HOME", t.TempDir())
	previous := nativeControlRequest
	t.Cleanup(func() { nativeControlRequest = previous })
	started := time.Now().Add(-4 * time.Minute)
	nativeControlRequest = func(_ context.Context, _ *service, method string, args any, _ time.Duration) (any, error) {
		if method != "thread/read" || field(args, "includeTurns") != true || field(args, "threadId") != "thread" {
			return nil, nil
		}
		return object{"thread": object{"id": field(args, "threadId"), "status": object{"type": "active"}, "turns": []any{
			object{"id": "turn", "status": "inProgress", "startedAt": started.UnixMilli()},
		}}}, nil
	}
	service := &service{metadata: object{"instance": "fixture"}}
	defer service.close()
	request := id()
	row := object{"requestId": request, "state": "completed", "operation": "send", "backendSession": "fixture",
		"createdAt": started.UTC().Format(time.RFC3339Nano), "result": object{"threadId": "thread", "turnId": "turn"}}
	if err := coreReceiptStore().reserve(t.Context(), row); err != nil {
		t.Fatal(err)
	}
	got, err := readControlReceipt(t.Context(), operationRequest{service: service, args: object{"requestId": request}})
	public := publicReceipt(obj(got))
	if err != nil || public["state"] != "completed" || public["requestId"] != request ||
		public["progressStalled"] != true || field(public["next"], "op") != "codex_interrupt" ||
		field(field(public["next"], "args"), "turnId") != "turn" {
		t.Fatalf("completed dispatch receipt with a stalled native turn = %s (%v)", wire(public), err)
	}
}

func TestCodexProgressRefreshesFromNativeDeltas(t *testing.T) {
	// Recurring bug class: lifecycle live delta and changed token counts refresh stalled-turn evidence.
	history := progressFixtureStart()
	for _, row := range [][2]int64{{10, 100}, {20, 100}, {100, 101}} {
		history += progressFixtureRow(row[0], "event_msg", object{"type": "token_count", "info": object{"total_token_usage": object{"output_tokens": row[1]}}})
	}
	activity := codexProgressHistory(history, "turn")
	if activity.diagnostic("thread", "turn", progressFixtureAt(279)) != nil ||
		activity.diagnostic("thread", "turn", progressFixtureAt(280))["progressStalled"] != true {
		t.Fatal("token activity did not reset inactivity")
	}
	states := codexProgressStates{}
	states.event("item/agentMessage/delta", object{"threadId": "thread", "turnId": "turn", "delta": "text"}, progressFixtureAt(250))
	activity.merge(states[[2]string{"thread", "turn"}])
	if activity.diagnostic("thread", "turn", progressFixtureAt(429)) != nil ||
		field(activity.diagnostic("thread", "turn", progressFixtureAt(430))["evidence"], "lastActivitySignal") != "streaming-delta" {
		t.Fatal("live delta did not reset inactivity")
	}
}

func TestCodexProgressRepeatedSnapshotsUseLastChange(t *testing.T) {
	// Algorithmic core: unchanged snapshots preserve inactivity, and a changed item resets the clock.
	states := codexProgressStates{}
	item := object{"id": "message", "type": "agentMessage", "text": "first"}
	thread := object{"id": "thread", "turns": []any{object{"id": "turn", "startedAt": progressFixtureAt(0), "status": "inProgress", "items": []any{item}}}}
	states.snapshot(thread, progressFixtureAt(10))
	states.snapshot(thread, progressFixtureAt(180))
	key := [2]string{"thread", "turn"}
	if states[key].diagnostic("thread", "turn", progressFixtureAt(190))["progressStalled"] != true {
		t.Fatal("an unchanged snapshot reset inactivity")
	}
	item["text"] = "more"
	states.snapshot(thread, progressFixtureAt(200))
	if states[key].diagnostic("thread", "turn", progressFixtureAt(379)) != nil ||
		states[key].diagnostic("thread", "turn", progressFixtureAt(380))["progressStalled"] != true {
		t.Fatal("a changed snapshot did not reset inactivity")
	}
}

func TestCodexProgressLongNativeToolSuppressesStallUntilCompletion(t *testing.T) {
	// Recurring bug class: lifecycle long native tools suppress stalls until the exact running tool completes.
	history := progressFixtureStart() + progressFixtureRow(10, "response_item", object{"type": "function_call", "call_id": "build", "name": "exec_command"})
	if codexProgressHistory(history, "turn").diagnostic("thread", "turn", progressFixtureAt(3600)) != nil {
		t.Fatal("a running command was reported as stalled")
	}
	history += progressFixtureRow(3600, "response_item", object{"type": "function_call_output", "call_id": "build", "output": "done"})
	activity := codexProgressHistory(history, "turn")
	if activity.diagnostic("thread", "turn", progressFixtureAt(3779)) != nil ||
		activity.diagnostic("thread", "turn", progressFixtureAt(3780))["progressStalled"] != true {
		t.Fatal("the completed command retained the running-tool exclusion")
	}
	for _, kind := range []string{"commandExecution", "mcpToolCall", "dynamicToolCall"} {
		states := codexProgressStates{}
		params := object{"threadId": "thread", "turnId": "turn", "item": object{"id": "tool", "type": kind}}
		key := [2]string{"thread", "turn"}
		states.event("item/started", params, progressFixtureAt(10))
		if states[key].diagnostic("thread", "turn", progressFixtureAt(3600)) != nil {
			t.Fatal(kind)
		}
		states.event("item/completed", params, progressFixtureAt(3600))
		if states[key].diagnostic("thread", "turn", progressFixtureAt(3779)) != nil ||
			states[key].diagnostic("thread", "turn", progressFixtureAt(3780))["progressStalled"] != true {
			t.Fatal(kind)
		}
	}
}
