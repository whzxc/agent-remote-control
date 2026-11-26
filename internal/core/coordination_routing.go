package core

import "context"

type coordinationRoute struct {
	SourceID   string  `json:"sourceId"`
	RouteID    string  `json:"routeId"`
	Generation string  `json:"generation"`
	BindingID  *string `json:"bindingId"`
}

func (r coordinationRoute) sameDestination(other coordinationRoute) bool {
	return r.SourceID == other.SourceID && r.RouteID == other.RouteID && r.Generation == other.Generation
}

type coordinationRouteOutcome struct {
	route *coordinationRoute
	state string
}

// Notification governance verifies private destinations and owns transport.
var coordinationVerifiedTarget func(context.Context, string, string) (coordinationRouteOutcome, error)
var coordinationEffectiveRoute func(context.Context, string, *coordinationRoute) (coordinationRouteOutcome, error)
var coordinationImportRoutes func() error

func selectCoordinationRoute(sessions []bulletinSession, session string) coordinationRouteOutcome {
	if session != "" {
		for _, current := range sessions {
			if current.ID != session {
				continue
			}
			if current.RouteFailure != nil {
				return coordinationRouteOutcome{state: *current.RouteFailure}
			}
			if current.Route != nil {
				return coordinationRouteOutcome{current.Route, "explicit-route"}
			}
			return coordinationRouteOutcome{state: "fallback"}
		}
		return coordinationRouteOutcome{state: "session-closed"}
	}
	var selected *coordinationRoute
	failure := ""
	for _, current := range sessions {
		if failure == "" && current.RouteFailure != nil {
			failure = *current.RouteFailure
		}
		if current.Route != nil {
			if selected != nil && !selected.sameDestination(*current.Route) {
				return coordinationRouteOutcome{state: "ambiguous-session-routes"}
			}
			selected = current.Route
		}
	}
	if failure != "" {
		if selected != nil {
			failure = "ambiguous-session-routes"
		}
		return coordinationRouteOutcome{state: failure}
	}
	if selected != nil {
		return coordinationRouteOutcome{selected, "explicit-route"}
	}
	return coordinationRouteOutcome{state: "fallback"}
}

func coordinationSessionRoutes(source string) ([]bulletinSession, error) {
	return withBulletinStore(func(store *bulletinStore) ([]bulletinSession, error) {
		var rows []bulletinSession
		for _, session := range store.state.Sessions {
			if session.State == "active" && session.Owner.Type == "source" && session.Owner.SourceID == source {
				rows = append(rows, *session)
			}
		}
		return rows, nil
	})
}

func resolveCoordinationRoute(ctx context.Context, source, session string) (coordinationRouteOutcome, error) {
	if coordinationImportRoutes != nil {
		if err := coordinationImportRoutes(); err != nil {
			return coordinationRouteOutcome{}, err
		}
	}
	sessions, err := coordinationSessionRoutes(source)
	if err != nil {
		return coordinationRouteOutcome{}, err
	}
	selected := selectCoordinationRoute(sessions, session)
	if selected.state == "fallback" || selected.route != nil {
		if coordinationEffectiveRoute != nil {
			return coordinationEffectiveRoute(ctx, source, selected.route)
		}
		if selected.route != nil {
			return coordinationRouteOutcome{state: "route-target-unverified"}, nil
		}
		return coordinationRouteOutcome{state: "no-verified-target"}, nil
	}
	return selected, nil
}

func coordinationRoutingDescription(outcome coordinationRouteOutcome, source, session string) object {
	mode := "pull-only"
	if outcome.route != nil {
		mode = "proactive"
	}
	next := object{"via": "act", "op": "coordination_session", "args": object{"action": "register", "target": "<your verified Claude session ID or URL>"}, "actor": "recipient",
		"hint": "The recipient must bind and verify its own conversation target with notify_control and notification_ack, then register coordination_session with action:register and target, or use message_route with its existing sessionId and target. Keep the session open for push.", "sourceId": source}
	if outcome.state == "notice-no-resource-overlap" || outcome.state == "notice-board-unavailable" {
		next = object{"via": "query", "op": "messages", "args": object{}, "actor": "recipient", "sourceId": source,
			"hint": "This notice remains pullable. Proactive notice delivery requires an overlapping resource in the recipient's active notice or uncleared blocker on the board."}
	} else if session != "" && outcome.state != "session-closed" {
		next["op"], next["args"] = "message_route", object{"sessionId": session, "target": "<your verified Claude session ID or URL>"}
	} else if outcome.state == "ambiguous-session-routes" {
		next = object{"via": "query", "op": "board", "args": object{"includeSessions": true}, "actor": "sender", "sourceId": source,
			"hint": "The sender must use message_send.toSessionId for the recipient's intended active session. Ask the recipient which conversation to use; ARC never chooses among distinct explicit conversation routes."}
	}
	return object{"deliveryMode": mode, "reason": outcome.state, "next": next}
}

func projectCoordinationSession(session object, outcome coordinationRouteOutcome) {
	mode := "pull-only"
	if outcome.route != nil {
		mode = "proactive"
	}
	session["deliveryCapability"] = mode
	session["routing"] = object{"deliveryMode": mode, "reason": outcome.state}
}

func coordinationSessionProjection(ctx context.Context, session object) error {
	var owner coordinationPrincipal
	_ = decodeCoordinationRecord([]byte(wire(session["owner"])), &owner)
	outcome := coordinationRouteOutcome{state: "source-required"}
	if owner.SourceID != "" {
		outcome.state = "session-closed"
		if session["state"] == "active" {
			var err error
			outcome, err = resolveCoordinationRoute(ctx, owner.SourceID, text(session, "id"))
			if err != nil {
				return err
			}
		}
	}
	projectCoordinationSession(session, outcome)
	return nil
}

func coordinationRoutingStatus(ctx context.Context, source string) (object, error) {
	outcome, err := resolveCoordinationRoute(ctx, source, "")
	if err != nil {
		return nil, err
	}
	result := coordinationRoutingDescription(outcome, source, "")
	sessions, err := coordinationSessionRoutes(source)
	if err != nil {
		return nil, err
	}
	rows := []object{}
	for _, session := range sessions {
		outcome, err := resolveCoordinationRoute(ctx, source, session.ID)
		if err != nil {
			return nil, err
		}
		row := coordinationRoutingDescription(outcome, source, session.ID)
		row["sessionId"], row["deliveryCapability"] = session.ID, row["deliveryMode"]
		rows = append(rows, row)
	}
	result["sessions"] = rows
	return result, nil
}

func init() {
	registerOperationProjection("whoami", func(ctx context.Context, request operationRequest, result object) error {
		source := text(result, "sourceId")
		if source == "" || request.source.local {
			return nil
		}
		routing, err := coordinationRoutingStatus(ctx, source)
		if err != nil {
			return err
		}
		result["coordinationDelivery"] = routing
		return nil
	})
}
