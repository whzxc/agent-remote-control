package core

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCodexActivityKeepsTerminalQuestionsAvailableForLateAnswers(t *testing.T) {
	// Recurring bug class: lifecycle terminal async requests do not restart a finished activity card.
	for _, status := range []string{"completed", "failed", "cancelled", "interrupted"} {
		const at = "2026-01-01T00:00:00Z"
		events := &nativeEvents{taskTimelines: map[string]*taskTimeline{"thread": {}}}
		timeline := events.taskTimelines["thread"]
		timeline.codex("turn/started", object{"turn": object{"id": "old"}}, at)
		timeline.codex("turn/completed", object{"turn": object{"id": "old", "status": status}}, at)
		events.pending = map[string]object{
			"old": {"id": "old", "method": "request_user_input_async", "params": object{"threadId": "thread", "turnId": "old"}},
		}
		if active, pending := nativeCodexLiveActivity(events), events.pendingInteractions(); len(active) != 0 || len(pending) != 1 || pending[0]["stale"] != true {
			t.Fatalf("%s active=%s pending=%s", status, wire(active), wire(pending))
		}
		timeline.loseObservation()
		if nativeCodexLiveActivity(events)["thread"] != nil {
			t.Fatalf("%s regained activity after observation loss", status)
		}
		timeline.codex("turn/started", object{"turn": object{"id": "new"}}, at)
		if nativeCodexLiveActivity(events)["thread"]["turnId"] != "new" {
			t.Fatalf("%s later native turn is missing", status)
		}
		timeline.loseObservation()
		events.pending["new"] = object{"id": "new", "params": object{"threadId": "thread", "turnId": "new"}}
		if len(nativeCodexLiveActivity(events)) != 1 || len(events.pendingInteractions()) != 2 {
			t.Fatalf("%s live interaction or late answer was lost", status)
		}
	}
}

func writeActivityRollout(t *testing.T, path string, records ...object) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, record := range records {
		if _, err := f.WriteString(wire(record) + "\n"); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCodexActivitySampleSurvivesConcurrentRolloutGrowth(t *testing.T) {
	// Recurring bug class: concurrency appended terminal evidence cannot erase a turn from a captured prefix.
	const thread = "c4f8f023-d41b-4baa-9fb5-077366c01403"
	const at = "2026-01-01T00:00:00Z"
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "sessions")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "rollout.jsonl")
	writeActivityRollout(t, path,
		object{"type": "session_meta", "timestamp": at, "payload": object{"id": thread}},
		object{"type": "event_msg", "timestamp": at, "payload": object{"type": "task_started", "turn_id": "current"}})
	first, err := readStamp(path)
	if err != nil {
		t.Fatal(err)
	}
	writeActivityRollout(t, path, object{"type": "event_msg", "timestamp": at, "payload": object{"type": "task_complete", "turn_id": "current"}})
	state, err := sampleCodexActivityFile(context.Background(), home, path, first, codexActivityFile{})
	if err != nil || state.row["turnId"] != "current" {
		t.Fatalf("captured prefix = %s, %v", wire(state.row), err)
	}
	last, err := readStamp(path)
	if err != nil {
		t.Fatal(err)
	}
	state, err = sampleCodexActivityFile(context.Background(), home, path, last, state)
	if err != nil || state.row != nil {
		t.Fatalf("terminal sample = %s, %v", wire(state.row), err)
	}
}

func TestCodexActivitySamplesRetainSilentTurnsAndUpdateNativeTitles(t *testing.T) {
	// Recurring bug class: lifecycle a quiet rollout stays active until native terminal evidence.
	const thread = "c4f8f023-d41b-4baa-9fb5-077366c01403"
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "sessions")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	nowAt := time.Now()
	at := nowAt.Format(time.RFC3339Nano)
	rollout, index := filepath.Join(dir, "rollout.jsonl"), filepath.Join(home, "session_index.jsonl")
	writeActivityRollout(t, rollout,
		object{"type": "session_meta", "timestamp": at, "payload": object{"id": thread}},
		object{"type": "event_msg", "timestamp": at, "payload": object{"type": "task_started", "turn_id": "first"}})
	writeActivityRollout(t, index, object{"id": thread, "thread_name": "Initial"})
	monitor := &codexActivityMonitor{}
	t.Cleanup(monitor.close)
	ctx := context.Background()
	for _, observed := range []time.Time{nowAt, nowAt.Add(10 * time.Minute)} {
		if rows := monitor.sample(ctx, home, observed); len(rows) != 1 || rows[0]["title"] != "Initial" || rows[0]["turnId"] != "first" {
			t.Fatalf("active snapshot = %s", wire(rows))
		}
	}
	writeActivityRollout(t, index, object{"id": thread, "thread_name": "Renamed"})
	if rows := monitor.sample(ctx, home, nowAt.Add(11*time.Minute)); len(rows) != 1 || rows[0]["title"] != "Renamed" {
		t.Fatalf("renamed activity = %s", wire(rows))
	}
	writeActivityRollout(t, rollout, object{"type": "event_msg", "timestamp": at, "payload": object{"type": "task_complete", "turn_id": "first"}})
	if rows := monitor.sample(ctx, home, nowAt.Add(12*time.Minute)); len(rows) != 0 {
		t.Fatalf("terminal activity = %s", wire(rows))
	}
}

func TestCodexConversationFindsExactTurnSettingsBeyondTail(t *testing.T) {
	// Recurring bug class: persistence large native output can hide the selected turn's dispatch settings from a bounded list preview.
	const at = "2026-01-01T00:00:00Z"
	path := filepath.Join(t.TempDir(), "activity.jsonl")
	writeActivityRollout(t, path,
		object{"type": "turn_context", "timestamp": at, "payload": object{"turn_id": "sample", "model": "recorded-model", "effort": "high", "service_tier": "priority"}},
		object{"type": "response_item", "timestamp": at, "payload": object{"type": "function_call_output", "output": strings.Repeat("x", 180<<10)}},
		object{"type": "event_msg", "timestamp": at, "payload": object{"type": "task_complete", "turn_id": "sample", "duration_ms": 9000}})
	read := func() object {
		t.Helper()
		reader, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		defer reader.Close()
		stat, err := reader.Stat()
		if err != nil {
			t.Fatal(err)
		}
		row, err := codexConversationClock(context.Background(), reader, stat.Size())
		if err != nil {
			t.Fatal(err)
		}
		return row
	}
	row := read()
	if row["turnId"] != "sample" || uintOr(row["turnDurationMs"], 0) != 9000 || row["turnCount"] != nil ||
		wire(row["dispatchSummary"]) != wire(object{"model": "recorded-model", "effort": "high", "serviceTier": "priority"}) {
		t.Fatal(wire(row))
	}
	writeActivityRollout(t, path, object{"type": "event_msg", "timestamp": at, "payload": object{"type": "task_started", "turn_id": "next"}})
	if row := read(); row["turnId"] != "next" || row["dispatchSummary"] != nil {
		t.Fatalf("older settings appeared on a different turn: %s", wire(row))
	}
}
