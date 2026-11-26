package core

import "testing"

func TestNotificationSchedulerParksUnattributedAndHeldRows(t *testing.T) {
	// Recurring bug class: lifecycle unattributed or paused notification rows restarted the idle worker.
	d := object{"status": "pending", "key": "terminal", "taskState": "completed", "target": "target"}
	b := object{"sourceId": "", "observation": object{"state": "completed"}, "deliveries": []any{d}}
	next := func() int64 {
		return notificationNextDelivery(nil, []object{b}, nil, 1000, 0, func(s string) bool { return s != "" })
	}
	for _, row := range []object{
		{"source": "", "target": "target", "routing": nil},
		{"source": "source", "target": "", "routing": nil},
		{"source": "source", "target": "target", "routing": "paused"},
		{"source": "source", "target": "target", "routing": "not-routable"},
	} {
		b["sourceId"], d["target"] = row["source"], row["target"]
		d["interaction"] = object{"routing": object{"state": row["routing"]}}
		if got := next(); got != 0 {
			t.Fatalf("parked row %v scheduled at %d", row, got)
		}
	}
}

func TestNotificationSchedulerUsesStoredDeadlines(t *testing.T) {
	// Algorithmic core: retry and finite mute schedules resume on their respective transitions.
	d := object{"status": "pending", "key": "terminal", "taskState": "completed", "target": "target", "nextAttemptAt": 1300, "timing": object{"queueReason": "retry-backoff"}}
	b := object{"sourceId": "source", "threadId": "thread", "observation": object{"state": "completed"}, "deliveries": []any{d}}
	state := object{"threads": []any{object{"sourceId": "source", "threadId": "thread", "mode": "mute", "until": 1200}}}
	next := func(active bool) int64 {
		return notificationNextDelivery(state, []object{b}, nil, 1000, 0, func(string) bool { return active })
	}
	if got := next(true); got != 1300 {
		t.Fatalf("retry deadline = %d", got)
	}
	obj(d["timing"])["queueReason"] = "muted"
	if got := next(true); got != 1200 {
		t.Fatalf("mute expiry = %d", got)
	}
	if got := next(false); got != 0 {
		t.Fatalf("inactive source scheduled at %d", got)
	}
}
