package core

import (
	"context"
	"errors"
	"slices"
	"strings"
)

type notificationCoordinationRoute struct {
	SourceID   string  `json:"sourceId"`
	RouteID    string  `json:"routeId"`
	Generation string  `json:"generation"`
	BindingID  *string `json:"bindingId"`
}

func (r notificationCoordinationRoute) sameDestination(other notificationCoordinationRoute) bool {
	return r.SourceID == other.SourceID && r.RouteID == other.RouteID && r.Generation == other.Generation
}

type notificationCoordinationOutcome struct {
	Route *notificationCoordinationRoute
	State string
}

func notificationCoordinationRouteID(source, target string) string {
	return hash([]byte(wire([]string{"claude-session", source, target})))
}

func notificationCoordinationAuthority(ctx context.Context, source string) (object, error) {
	a, err := notificationSourceAuthority(ctx, source)
	if err != nil {
		return nil, err
	}
	if a == nil || a["state"] == "revoked" || a["connectionRemoved"] == true {
		return nil, errors.New("SOURCE_REVOKED")
	}
	return a, nil
}

func notificationCoordinationRoutes(state object, source string, authority object) []notificationCoordinationRoute {
	var result []notificationCoordinationRoute
	for _, item := range arr(state["targets"]) {
		target := obj(item)
		if target["sourceId"] != source || target["channel"] != "claude-session" || text(target, "target") == "" ||
			field(target["reachability"], "state") != "verified" || target["accountId"] == nil {
			continue
		}
		generation := hash([]byte(wire([]any{target["accountId"], target["reachability"], authority["credential"], authority["ingressId"]})))
		result = append(result, notificationCoordinationRoute{
			SourceID: source, RouteID: notificationCoordinationRouteID(source, text(target, "target")), Generation: generation,
		})
	}
	return result
}

func notificationCoordinationDestination(state object, route notificationCoordinationRoute) object {
	for _, row := range arr(state["targets"]) {
		if field(row, "sourceId") == route.SourceID && field(row, "channel") == "claude-session" &&
			notificationCoordinationRouteID(route.SourceID, text(row, "target")) == route.RouteID {
			return obj(row)
		}
	}
	return nil
}

func resolveNotificationCoordination(state object, source string, authority object, target string, explicit *notificationCoordinationRoute) notificationCoordinationOutcome {
	routes := notificationCoordinationRoutes(state, source, authority)
	if explicit != nil {
		if slices.ContainsFunc(routes, explicit.sameDestination) {
			return notificationCoordinationOutcome{explicit, "explicit-route"}
		}
		return notificationCoordinationOutcome{State: "route-target-unverified"}
	}
	if target != "" {
		id := notificationCoordinationRouteID(source, target)
		routes = slices.DeleteFunc(routes, func(r notificationCoordinationRoute) bool { return r.RouteID != id })
	} else {
		at := func(r notificationCoordinationRoute) uint64 {
			return uintOr(field(field(notificationCoordinationDestination(state, r), "reachability"), "verifiedAt"), 0)
		}
		var newest uint64
		for _, r := range routes {
			newest = max(newest, at(r))
		}
		routes = slices.DeleteFunc(routes, func(r notificationCoordinationRoute) bool { return at(r) != newest })
	}
	switch len(routes) {
	case 0:
		return notificationCoordinationOutcome{State: "no-verified-target"}
	case 1:
		return notificationCoordinationOutcome{&routes[0], "resolved"}
	default:
		return notificationCoordinationOutcome{State: "ambiguous-verified-targets"}
	}
}

func effectiveNotificationCoordinationRoute(ctx context.Context, source string, explicit *notificationCoordinationRoute) (notificationCoordinationOutcome, error) {
	a, err := notificationCoordinationAuthority(ctx, source)
	if err != nil {
		return notificationCoordinationOutcome{}, err
	}
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	state, err := readNotificationState()
	return resolveNotificationCoordination(state, source, a, "", explicit), err
}

func verifiedNotificationCoordinationTarget(ctx context.Context, source, raw string) (notificationCoordinationOutcome, error) {
	a, err := notificationCoordinationAuthority(ctx, source)
	if err != nil {
		return notificationCoordinationOutcome{}, err
	}
	target, err := notificationSessionID(raw)
	if err != nil {
		return notificationCoordinationOutcome{State: "invalid-claude-session"}, nil
	}
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	state, err := readNotificationState()
	return resolveNotificationCoordination(state, source, a, target, nil), err
}

func notificationCoordinationRouting(proactive bool, reason string) object {
	mode := "pull-only"
	if proactive {
		mode = "proactive"
	}
	return object{"deliveryMode": mode, "reason": reason,
		"next": object{"via": "act", "op": "coordination_session", "args": object{"action": "register", "target": "<your verified Claude session ID or URL>"},
			"actor": "recipient", "hint": "The recipient must bind and verify its own conversation target with notify_control and notification_ack, then register coordination_session with action:register and target, or use message_route with its existing sessionId and target. Keep the session open for push."}}
}

func notificationCoordinationAdmission(state object, route notificationCoordinationRoute, a object, settings object, now int64) string {
	if a["state"] == "revoked" || a["connectionRemoved"] == true ||
		!slices.ContainsFunc(notificationCoordinationRoutes(state, route.SourceID, a), route.sameDestination) {
		return "cancelled"
	}
	if settings["notificationsEnabled"] == false || slices.ContainsFunc(arr(state["subscriptions"]), func(s any) bool {
		return field(s, "sourceId") == route.SourceID && notificationCoordinationRouteID(route.SourceID, text(s, "target")) == route.RouteID &&
			notificationSubscriptionMuted(obj(s), now)
	}) {
		return "pending"
	}
	t := notificationCoordinationDestination(state, route)
	notificationRefill(t, settings, now)
	if t["breaker"] == true || uintOr(t["tokens"], 0) <= 2 {
		return "pending"
	}
	count := 0
	for _, row := range arr(t["batches"]) {
		if strings.HasPrefix(text(row, "id"), "coordination-") && int64(uintOr(field(row, "at"), 0)) > now-60 {
			count++
		}
	}
	if count >= 3 {
		return "pending"
	}
	return "ready"
}

func deliverNotificationCoordination(ctx context.Context, route notificationCoordinationRoute, count int, batchID string) (notificationCoordinationOutcome, error) {
	batch := "coordination-" + batchID
	source := route.SourceID
	a, err := notificationCoordinationAuthority(ctx, source)
	if err != nil {
		return notificationCoordinationOutcome{State: "cancelled"}, nil
	}
	at := notificationClock().Unix()
	var target, profile string
	state, err := func() (string, error) {
		notificationEventOperation.Lock()
		defer notificationEventOperation.Unlock()
		settings, err := notificationSettings()
		if err != nil {
			return "", err
		}
		state, err := readNotificationState()
		if err != nil {
			return "", err
		}
		if status := notificationCoordinationAdmission(state, route, a, settings, at); status != "ready" {
			return status, nil
		}
		t := notificationCoordinationDestination(state, route)
		target, profile = text(t, "target"), text(t, "accountId")
		bindings, err := selectNotificationBindings(func(b object) bool { return b["sourceId"] == source && b["target"] == target })
		if err != nil {
			return "", err
		}
		if slices.ContainsFunc(bindings, func(b object) bool {
			return notificationThreadMode(notificationThread(state, source, text(b, "threadId"), at, false), at) != "normal"
		}) {
			return "pending", nil
		}
		if old := find(t["batches"], "id", batch); slices.Contains([]string{"sending", "delivered", "unconfirmed"}, text(old, "status")) {
			return "unconfirmed", nil
		}
		notificationCharge(t, settings, at)
		t["batches"] = append(arr(t["batches"]), object{"id": batch, "at": at, "kinds": object{"coordination": count},
			"threads": []any{}, "status": "sending", "charged": true})
		return "ready", saveNotificationState(state)
	}()
	if err != nil || state != "ready" {
		return notificationCoordinationOutcome{State: state}, err
	}
	current, err := effectiveNotificationCoordinationRoute(ctx, source, &route)
	if err != nil || current.Route == nil {
		return notificationCoordinationOutcome{State: "cancelled"}, nil
	}
	labels := make([]string, max(count, 0))
	for i := range labels {
		labels[i] = "✉ mail"
	}
	status := "delivered"
	if err := notificationSessionSend(ctx, "claude-session", profile, target, notificationDoorbell(labels)); err != nil {
		status = "unconfirmed"
	}
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	settings, err := readNotificationState()
	if err != nil {
		return notificationCoordinationOutcome{}, err
	}
	if b := find(findNotificationTarget(settings, source, "claude-session", target)["batches"], "id", batch); b != nil {
		b["status"] = status
	}
	return notificationCoordinationOutcome{State: status}, saveNotificationState(settings)
}
