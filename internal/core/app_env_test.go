package core

import (
	"testing"
)

func TestAppEnvironmentOverrideReadback(t *testing.T) {
	// Contract: app_env returns saved overrides and explicit clock provenance.
	args := object{"action": "set", "reducedMotion": true, "colorScheme": "dark", "locale": "zh-CN",
		"windowWidth": 320, "windowHeight": 900, "taskPanelWidth": 320, "presence": "absent", "clock": object{"freeze": true}}
	state, err := changeAppEnvironment(appEnvironment{}, args, 1000)
	if err != nil {
		t.Fatal(err)
	}
	read := state.snapshot(9000)
	for _, key := range []string{"reducedMotion", "colorScheme", "locale", "windowWidth", "windowHeight", "taskPanelWidth", "presence"} {
		if actual := field(read["overrides"], key); wire(actual) != wire(args[key]) {
			t.Fatalf("override %s = %v, want %v", key, actual, args[key])
		}
	}
	if field(read["clock"], "source") != "override" || field(field(read["clock"], "value"), "nowMs") != int64(1000) || state.presence(true) {
		t.Fatalf("frozen absent instance readback = %v", read)
	}
	present, err := changeAppEnvironment(state, object{"action": "set", "presence": "present", "reducedMotion": false}, 2000)
	if err != nil || !present.presence(false) || present.ReducedMotion == nil || *present.ReducedMotion {
		t.Fatalf("present instance readback = %v, %v", present, err)
	}
	follow, err := changeAppEnvironment(present, object{"action": "set", "presence": "follow-system"}, 2000)
	if err != nil || !follow.presence(true) || follow.presence(false) {
		t.Fatalf("system presence readback = %v, %v", follow, err)
	}
}

func TestAppEnvironmentClockAdvanceAndExpiry(t *testing.T) {
	// Contract: clock advances and speed preserve continuity and real-time expiry restores defaults.
	frozen, err := changeAppEnvironment(appEnvironment{}, object{"action": "set", "clock": object{"freeze": true}}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	advanced, err := changeAppEnvironment(frozen, object{"action": "set", "clock": object{"advanceMs": 15000, "speed": 2}}, 2000)
	if err != nil || advanced.clockNow(3000) != 18000 || advanced.clockID() != frozen.clockID() {
		t.Fatalf("advanced clock = %v, %v", advanced.Clock, err)
	}
	for _, action := range []string{"clear", "read"} {
		state, err := changeAppEnvironment(advanced, object{"action": action}, 1_000_000)
		read := state.snapshot(1_000_000)
		if err != nil || read["active"] != false || field(read["clock"], "source") != "system" ||
			state.clockNow(1_000_000) != 1_000_000 || state.WindowWidth != nil {
			t.Fatalf("%s after expiry = %v, %v", action, read, err)
		}
	}
}

func TestAppEnvironmentVirtualDeadlineRounding(t *testing.T) {
	// Algorithmic core: virtual deadlines cannot fire early and a frozen future clock has no real deadline.
	if at, ok := (appEnvironment{}).realDeadline(1400, 1000); !ok || at != 1400 {
		t.Fatalf("system clock deadline = %d, %t", at, ok)
	}
	env := appEnvironment{Clock: &appClock{RealAt: 1000, VirtualAt: 5000, Speed: 2, ID: "clock"}}
	at, ok := env.realDeadline(5003, 1000)
	if !ok || env.clockNow(at) < 5003 || env.clockNow(at-1) >= 5003 {
		t.Fatalf("virtual deadline = %d, %t", at, ok)
	}
	env.Clock.Speed = 0
	if at, ok := env.realDeadline(5003, 1000); ok {
		t.Fatalf("frozen clock unexpectedly reaches deadline at %d", at)
	}
	if at, ok := env.realDeadline(5000, 1000); !ok || at != 1000 {
		t.Fatalf("already reached frozen deadline = %d, %t", at, ok)
	}
}
