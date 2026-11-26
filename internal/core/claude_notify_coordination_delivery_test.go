package core

import "testing"

func TestNotificationCoordinationKeepsVerifiedRouteAndSharedBudget(t *testing.T) {
	// Algorithmic core: tied verified targets remain ambiguous and explicit routes share the guarded budget.
	source := "source"
	authority := object{"state": "active", "credential": "fixture", "ingressId": "connector"}
	first := object{"sourceId": source, "channel": "claude-session", "target": "one", "accountId": "account",
		"reachability": object{"state": "verified", "verifiedAt": 100}, "tokens": 2, "refilledAt": 100}
	second := clone(first)
	second["target"] = "two"
	state := object{"targets": []any{first, second}}
	initial := resolveNotificationCoordination(state, source, authority, "", nil)
	if initial.Route != nil || initial.State != "ambiguous-verified-targets" {
		t.Fatalf("tied route = %v", initial)
	}
	target := resolveNotificationCoordination(state, source, authority, "one", nil)
	if target.Route == nil || target.State != "resolved" {
		t.Fatalf("explicit target = %v", target)
	}
	if got := notificationCoordinationAdmission(state, *target.Route, authority, nil, 100); got != "pending" {
		t.Fatalf("reserved budget = %s", got)
	}
	first["tokens"] = 3
	if got := notificationCoordinationAdmission(state, *target.Route, authority, nil, 100); got != "ready" {
		t.Fatalf("available budget = %s", got)
	}
	first["accountId"] = "different"
	if got := notificationCoordinationAdmission(state, *target.Route, authority, nil, 100); got != "cancelled" {
		t.Fatalf("changed route admitted as %s", got)
	}
}
