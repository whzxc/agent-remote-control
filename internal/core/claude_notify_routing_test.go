package core

import "testing"

func TestNotificationRoutingPreservesPauseAndHandsOffOnce(t *testing.T) {
	// Algorithmic core: routing preserves the remaining presence countdown and explicit actor.
	entry := object{"session": "session", "routing": initialNotificationRouting(true, true, 1000, 15)}
	if got := field(entry["routing"], "deferUntil"); got != int64(16000) {
		t.Fatalf("initial deadline = %v", got)
	}
	if err := changeNotificationRouting(entry, "pause", "user", 4000); err != nil {
		t.Fatal(err)
	}
	if field(entry["routing"], "pausedBy") != "user" {
		t.Fatalf("paused routing = %v", entry["routing"])
	}
	if err := changeNotificationRouting(entry, "resume", "user", 10000); err != nil {
		t.Fatal(err)
	}
	if got := field(entry["routing"], "deferUntil"); got != int64(22000) {
		t.Fatalf("resumed deadline = %v", got)
	}
	for range 2 {
		if err := changeNotificationRouting(entry, "handoff", "user", 12000); err != nil {
			t.Fatal(err)
		}
		if field(entry["routing"], "reason") != "handoff-now" {
			t.Fatalf("handoff = %v", entry["routing"])
		}
	}
	entry["resolved"] = true
	if err := changeNotificationRouting(entry, "handoff", "user", 13000); err == nil {
		t.Fatal("resolved request was handed off")
	}
}

func TestNotificationRoutingOnlyNewRequestsReceivePresenceDelay(t *testing.T) {
	// Recurring bug class: lifecycle presence and clock changes incorrectly extended already routed requests.
	entry := object{"session": "session", "clockId": "fixture", "routing": initialNotificationRouting(false, true, 1000, 15)}
	advanceNotificationRouting(entry, "session", "fixture", true, true, 2000)
	if field(entry["routing"], "state") != "routed" {
		t.Fatalf("existing route = %v", entry["routing"])
	}
	entry["routing"] = initialNotificationRouting(true, true, 2000, 15)
	advanceNotificationRouting(entry, "session", "new-clock", true, true, 3000)
	if field(entry["routing"], "reason") != "environment-reset" {
		t.Fatalf("reset route = %v", entry["routing"])
	}
	entry["routing"] = initialNotificationRouting(true, true, 2000, 15)
	advanceNotificationRouting(entry, "new-session", "new-clock", true, true, 3000)
	if field(entry["routing"], "reason") != "restart-recovery" {
		t.Fatalf("restarted route = %v", entry["routing"])
	}
	entry["routing"] = initialNotificationRouting(true, true, 2000, 15)
	advanceNotificationRouting(entry, "new-session", "new-clock", false, true, 3000)
	if field(entry["routing"], "reason") != "user-absent" {
		t.Fatalf("absent route = %v", entry["routing"])
	}
}
