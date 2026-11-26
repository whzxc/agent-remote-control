package core

import (
	"slices"
	"testing"
)

func TestCoordinationRoutesRetainExplicitRecipientChoice(t *testing.T) {
	// Recurring bug class: security source-addressed messages may never guess between distinct verified sessions.
	one := &coordinationRoute{SourceID: "peer", RouteID: "one", Generation: "verified", BindingID: new("first-binding")}
	two := &coordinationRoute{SourceID: "peer", RouteID: "two", Generation: "verified", BindingID: new("second-binding")}
	sessions := []bulletinSession{{ID: "first", Route: one}, {ID: "second", Route: two}}
	for range 2 {
		outcome := selectCoordinationRoute(sessions, "")
		if outcome.route != nil || outcome.state != "ambiguous-session-routes" {
			t.Fatalf("source routing = %v", outcome)
		}
		next := obj(coordinationRoutingDescription(outcome, "peer", "")["next"])
		if next["op"] != "board" || next["actor"] != "sender" {
			t.Fatalf("route recovery = %v", next)
		}
		slices.Reverse(sessions)
	}
	if route := selectCoordinationRoute(sessions, "second"); route.route != two {
		t.Fatalf("explicit route = %v", route)
	}
	if route := selectCoordinationRoute(sessions, "closed"); route.route != nil || route.state != "session-closed" {
		t.Fatalf("closed route = %v", route)
	}
}

func TestCoordinationFailedRegistrationDoesNotUseFallback(t *testing.T) {
	// Recurring bug class: security an unverified explicit destination cannot redirect to another conversation.
	for _, reason := range []string{"invalid-claude-session", "no-verified-target"} {
		sessions := []bulletinSession{{ID: "session", RouteFailure: &reason}}
		for _, address := range []string{"", "session"} {
			outcome := selectCoordinationRoute(sessions, address)
			if outcome.route != nil || outcome.state != reason {
				t.Fatalf("selection for %s = %v", address, outcome)
			}
			session := object{"id": "session"}
			projectCoordinationSession(session, outcome)
			description := coordinationRoutingDescription(outcome, "peer", "session")
			if session["deliveryCapability"] != description["deliveryMode"] || field(session["routing"], "reason") != description["reason"] {
				t.Fatalf("inconsistent routing %v / %v", session, description)
			}
			if field(field(description["next"], "args"), "sessionId") != "session" {
				t.Fatalf("repair = %v", description["next"])
			}
		}
	}
}

func TestCoordinationBoardProjectsVerifiedAndLostSessionRoute(t *testing.T) {
	// Recurring bug class: lifecycle the Board capability and sender repair must agree after verified routing is lost.
	ctx, route, _ := fixtureCoordinationWake(t)
	owner := coordinationReader{principal: coordinationPrincipal{Type: "source", SourceID: "source"}}
	registration, err := withBulletinStore(func(store *bulletinStore) (object, error) {
		return store.mutate("coordination_session", object{"action": "register", "requestId": id()},
			owner, nil, &route, currentBulletinClock())
	})
	if err != nil {
		t.Fatal(err)
	}
	session := obj(registration["session"])
	read := func(mode, reason string) {
		t.Helper()
		if err := coordinationSessionProjection(ctx, session); err != nil {
			t.Fatal(err)
		}
		selected, err := resolveCoordinationRoute(ctx, "source", text(session, "id"))
		if err != nil {
			t.Fatal(err)
		}
		status := coordinationRoutingDescription(selected, "source", text(session, "id"))
		if session["deliveryCapability"] != mode || status["deliveryMode"] != mode ||
			field(session["routing"], "reason") != reason || status["reason"] != reason ||
			field(status["next"], "actor") != "recipient" || field(status["next"], "op") != "message_route" ||
			field(field(status["next"], "args"), "sessionId") != session["id"] {
			t.Fatalf("session projection = %v, sender action = %v", session, status)
		}
	}
	read("proactive", "explicit-route")
	state, err := readNotificationState()
	if err != nil {
		t.Fatal(err)
	}
	notificationReachability(findNotificationTarget(state, "source", "claude-session", notificationTestTarget))["state"] = "unverified"
	if err := saveNotificationState(state); err != nil {
		t.Fatal(err)
	}
	read("pull-only", "route-target-unverified")
}
