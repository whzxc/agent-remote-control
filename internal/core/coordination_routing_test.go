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
