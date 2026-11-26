package core

import (
	"context"
	"strings"
	"testing"
)

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

func TestCoordinationDeliveryRevalidatesBeforeTransport(t *testing.T) {
	// Contract: pending coordination sends respect current credential, verification, and delivery preferences.
	ctx, _, _, sent := notificationDeliveryFixture(t)
	const source = "source"
	authority := object{"state": "active", "credential": "initial", "ingressId": "fixture"}
	notificationSourceAuthority = func(context.Context, string) (object, error) { return authority, nil }
	state, err := readNotificationState()
	if err != nil {
		t.Fatal(err)
	}
	target := findNotificationTarget(state, source, "claude-session", notificationTestTarget)
	target["accountId"], target["tokens"] = "fixture-profile", 4
	write := func() {
		t.Helper()
		if err := saveNotificationState(state); err != nil {
			t.Fatal(err)
		}
	}
	write()
	initial, err := verifiedNotificationCoordinationTarget(ctx, source, "https://claude.ai/code/"+notificationTestTarget)
	if err != nil || initial.Route == nil {
		t.Fatalf("verified route = %v, %v", initial, err)
	}
	deliver := func(want string, calls int) {
		t.Helper()
		got, err := deliverNotificationCoordination(ctx, *initial.Route, 2, id())
		if err != nil || got.State != want || len(*sent) != calls {
			t.Fatalf("delivery = %v, %v with %d sends, want %s and %d", got, err, len(*sent), want, calls)
		}
	}
	authority["credential"] = "replacement"
	deliver("cancelled", 0)
	authority["credential"], authority["state"] = "initial", "revoked"
	deliver("cancelled", 0)
	authority["state"] = "active"
	notificationReachability(target)["state"] = "failed"
	write()
	deliver("cancelled", 0)
	notificationReachability(target)["state"] = "verified"
	state["subscriptions"] = []any{object{"id": "muted", "sourceId": source,
		"channel": "claude-session", "target": notificationTestTarget, "muted": true}}
	write()
	deliver("pending", 0)
	state["subscriptions"] = []any{}
	write()
	if _, err := updateNotificationSettings(object{"notificationsEnabled": false}); err != nil {
		t.Fatal(err)
	}
	deliver("pending", 0)
	if _, err := updateNotificationSettings(object{"notificationsEnabled": true}); err != nil {
		t.Fatal(err)
	}
	deliver("delivered", 1)
	if !strings.Contains((*sent)[0], "mail") {
		t.Fatalf("coordination doorbell = %q", (*sent)[0])
	}
}

func TestCoordinationRegistrationAndFallbackRespectCurrentVerifiedOwner(t *testing.T) {
	// Recurring bug class: security an unbound or stale explicit route cannot redirect to a foreign or ambiguous destination.
	ctx, _, _, _ := notificationDeliveryFixture(t)
	const source = "source"
	state, err := readNotificationState()
	if err != nil {
		t.Fatal(err)
	}
	target := findNotificationTarget(state, source, "claude-session", notificationTestTarget)
	target["accountId"] = "fixture-profile"
	write := func() {
		t.Helper()
		if err := saveNotificationState(state); err != nil {
			t.Fatal(err)
		}
	}
	write()
	raw := "https://claude.ai/code/" + notificationTestTarget
	initial, err := verifiedNotificationCoordinationTarget(ctx, source, raw)
	if err != nil || initial.Route == nil {
		t.Fatalf("owner registration = %v, %v", initial, err)
	}
	for _, input := range []struct{ owner, target, reason string }{
		{"foreign", raw, "no-verified-target"},
		{source, "invalid", "invalid-claude-session"},
	} {
		outcome, err := verifiedNotificationCoordinationTarget(ctx, input.owner, input.target)
		if err != nil || outcome.Route != nil || outcome.State != input.reason {
			t.Fatalf("registration check = %v, %v", outcome, err)
		}
	}
	effective := func(explicit *notificationCoordinationRoute, reason string, proactive bool) {
		t.Helper()
		outcome, err := effectiveNotificationCoordinationRoute(ctx, source, explicit)
		if err != nil || outcome.State != reason || (outcome.Route != nil) != proactive {
			t.Fatalf("effective route = %v, %v, want %s", outcome, err, reason)
		}
	}
	effective(initial.Route, "explicit-route", true)
	notificationReachability(target)["state"] = "unverified"
	write()
	if outcome, err := verifiedNotificationCoordinationTarget(ctx, source, raw); err != nil || outcome.Route != nil || outcome.State != "no-verified-target" {
		t.Fatalf("unverified registration = %v, %v", outcome, err)
	}
	effective(initial.Route, "route-target-unverified", false)
	effective(nil, "no-verified-target", false)
	notificationReachability(target)["state"] = "verified"
	write()
	effective(nil, "resolved", true)
	other := clone(target)
	other["target"] = "session_020000000000000000000001"
	state["targets"] = append(arr(state["targets"]), other)
	write()
	effective(initial.Route, "explicit-route", true)
	effective(nil, "ambiguous-verified-targets", false)
}
