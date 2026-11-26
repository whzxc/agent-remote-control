package core

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

type notificationPresence struct {
	agent, task string
	at          int64
}

var notificationRoutingSession = sync.OnceValue(id)
var notificationPresent notificationPresence

// A supplies app_env presence overrides and its synthetic clock generation.
var notificationRoutingEnvironment func(systemPresent bool, real int64) (present bool, now int64, clockID string, err error)

func immediateNotificationRouting(state, reason string) object {
	return object{"state": state, "deferUntil": nil, "pausedBy": nil, "reason": reason}
}

func initialNotificationRouting(present, routable bool, now int64, delay uint64) object {
	switch {
	case !routable:
		return immediateNotificationRouting("not-routable", "no-verified-push-path")
	case present && delay > 0:
		return object{"state": "deferred", "deferUntil": now + int64(delay)*1000, "pausedBy": nil, "reason": "user-present"}
	case present:
		return immediateNotificationRouting("routed", "delay-disabled")
	default:
		return immediateNotificationRouting("routed", "user-absent")
	}
}

func advanceNotificationRouting(entry object, session, clock string, present, routable bool, now int64) {
	r := obj(entry["routing"])
	state := text(r, "state")
	parked := state == "deferred" || state == "paused"
	restartState := "not-routable"
	if routable {
		restartState = "routed"
	}
	switch {
	case parked && text(entry, "clockId") != "" && entry["clockId"] != "system" && entry["clockId"] != clock:
		entry["routing"] = immediateNotificationRouting(restartState, "environment-reset")
	case parked && entry["session"] != session:
		entry["routing"] = immediateNotificationRouting(restartState, "restart-recovery")
	case parked && !routable:
		entry["routing"] = immediateNotificationRouting("not-routable", "no-verified-push-path")
	case state == "not-routable" && routable:
		entry["routing"] = immediateNotificationRouting("routed", "push-path-available")
	case state == "deferred" && (!present || uintOr(r["deferUntil"], ^uint64(0)) <= uint64(now)):
		reason := "user-absent"
		if present {
			reason = "countdown-elapsed"
		}
		entry["routing"] = immediateNotificationRouting("routed", reason)
	}
	entry["session"], entry["clockId"] = session, clock
}

func changeNotificationRouting(entry object, action, actor string, now int64) error {
	if entry["resolved"] == true {
		return errors.New("REQUEST_RESOLVED: read pending requests before routing")
	}
	r := obj(entry["routing"])
	switch action {
	case "read":
	case "handoff":
		if r["state"] == "deferred" || r["state"] == "paused" {
			entry["routing"] = immediateNotificationRouting("routed", "handoff-now")
		}
	case "pause":
		if r["state"] == "deferred" {
			entry["remainingMs"] = max(0, int64(uintOr(r["deferUntil"], uint64(now)))-now)
			entry["routing"] = object{"state": "paused", "deferUntil": nil, "pausedBy": actor, "reason": "explicit-or-dock-interaction"}
		}
	case "resume":
		if r["state"] == "paused" {
			entry["routing"] = object{"state": "deferred", "deferUntil": now + int64(uintOr(entry["remainingMs"], 0)), "pausedBy": nil, "reason": "resumed"}
		}
	default:
		return errors.New("INVALID_ROUTING_ACTION: use read, handoff, pause or resume")
	}
	return nil
}

func notificationRoutingPath(agent, task, request string) string {
	return filepath.Join(notificationDirectory(), "request-routing", hash([]byte(wire([]string{agent, task, request})))+".json")
}

func notificationRoutingBinding(agent, task string, turn any) (object, error) {
	match := func(b object) bool {
		return b != nil && b["threadId"] == task && notificationAgent(b) == agent && b["scopeEnd"] == nil
	}
	if turn, ok := turn.(string); ok {
		b, err := readNotificationBinding(task, turn)
		if !match(b) {
			return nil, err
		}
		return b, err
	}
	if turn != nil {
		return nil, nil
	}
	rows, err := notificationBindings()
	if err != nil {
		return nil, err
	}
	var latest object
	for _, b := range rows {
		if match(b) && (latest == nil || uintOr(b["createdAt"], 0) >= uintOr(latest["createdAt"], 0)) {
			latest = b
		}
	}
	return latest, nil
}

func notificationRoutable(bind, state, settings object, now int64) bool {
	if settings["notificationsEnabled"] == false {
		return false
	}
	syncNotificationSubscriptions(state, []object{bind})
	for _, item := range arr(state["subscriptions"]) {
		sub := obj(item)
		if !notificationSubscriptionMatches(sub, bind) || !notificationSubscriptionActive(sub, now) {
			continue
		}
		if sub["channel"] == "mcp-events" {
			if uintOr(field(sub["webhook"], "verifiedUntil"), 0) > 0 {
				return true
			}
		} else if target := findNotificationTarget(state, text(bind, "sourceId"), text(sub, "channel"), text(sub, "target")); field(target["reachability"], "state") == "verified" {
			return true
		}
	}
	return false
}

func notificationRoutingClock(agent, task string) (bool, int64, string, error) {
	now := notificationClock().UnixMilli()
	present := notificationPresent.agent == agent && notificationPresent.task == task && now-notificationPresent.at < 6000
	if notificationRoutingEnvironment != nil {
		return notificationRoutingEnvironment(present, now)
	}
	return present, now, "system", nil
}

func notificationRoutingObserve(agent, task string, request object) error {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	return observeNotificationRouting(agent, task, request)
}

func observeNotificationRouting(agent, task string, request object) error {
	turn, exists := obj(request["params"])["turnId"]
	if !exists {
		turn = request["turnId"]
	}
	b, err := notificationRoutingBinding(agent, task, turn)
	if err != nil {
		return err
	}
	if b == nil {
		request["routing"] = immediateNotificationRouting("not-routable", "no-source-binding")
		return nil
	}
	requestID, exists := request["responseId"]
	if !exists {
		requestID = request["id"]
	}
	if _, ok := requestID.(string); !ok {
		requestID = wire(requestID)
	}
	path := notificationRoutingPath(agent, task, str(requestID))
	original, err := load(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	entry := obj(original)
	if request["resolved"] == true {
		if entry != nil && entry["turn"] == b["turnId"] && entry["resolved"] != true {
			entry["resolved"] = true
			return save(path, entry)
		}
		return nil
	}
	before := wire(original)
	settings, err := notificationSettings()
	if err != nil {
		return err
	}
	state, err := readNotificationState()
	if err != nil {
		return err
	}
	present, now, clock, err := notificationRoutingClock(agent, task)
	if err != nil {
		return err
	}
	routable := notificationRoutable(b, state, settings, notificationClock().UnixMilli())
	session := notificationRoutingSession()
	if entry == nil || entry["turn"] != b["turnId"] {
		entry = object{"session": session, "sourceId": b["sourceId"], "turn": b["turnId"], "resolved": false,
			"remainingMs": 0, "clockId": clock, "routing": initialNotificationRouting(present, routable, now, uintOr(settings["requestRoutingDelaySeconds"], 15))}
	}
	entry["sourceId"] = b["sourceId"]
	advanceNotificationRouting(entry, session, clock, present, routable, now)
	request["routing"] = entry["routing"]
	if wire(entry) != before {
		return save(path, entry)
	}
	return nil
}

func notificationRoutingControl(ctx context.Context, args object, local bool) (object, error) {
	agent := str(dispatchFirstString(args["agent"], "codex"))
	task := text(args, "taskId")
	path := notificationRoutingPath(agent, task, text(args, "id"))
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	raw, err := load(path)
	if err != nil || obj(raw) == nil {
		return nil, errors.New("REQUEST_ROUTING_NOT_FOUND: read pending requests first")
	}
	entry := obj(raw)
	actor := text(currentOrigin(ctx), "sourceId")
	if local {
		actor = "user"
	} else if actor == "" || actor != entry["sourceId"] {
		return nil, errors.New("REQUEST_SOURCE_MISMATCH: only the task's bound control source may change routing")
	}
	b, err := notificationRoutingBinding(agent, task, entry["turn"])
	if err != nil {
		return nil, err
	}
	if b == nil {
		return nil, errors.New("REQUEST_SOURCE_UNBOUND: read pending requests")
	}
	if b["sourceId"] != entry["sourceId"] {
		return nil, errors.New("REQUEST_SOURCE_MISMATCH: task binding changed")
	}
	settings, err := notificationSettings()
	if err != nil {
		return nil, err
	}
	state, err := readNotificationState()
	if err != nil {
		return nil, err
	}
	present, now, clock, err := notificationRoutingClock(agent, task)
	if err != nil {
		return nil, err
	}
	advanceNotificationRouting(entry, notificationRoutingSession(), clock, present, notificationRoutable(b, state, settings, notificationClock().UnixMilli()), now)
	if err := changeNotificationRouting(entry, str(dispatchFirstString(args["action"], "read")), actor, now); err != nil {
		return nil, err
	}
	if err := save(path, entry); err != nil {
		return nil, err
	}
	notificationSignal()
	return object{"routing": entry["routing"]}, nil
}

func init() {
	registerOperation("request_route", func(ctx context.Context, r operationRequest) (any, error) {
		return notificationRoutingControl(ctx, r.args, false)
	}, nil)
	registerRoute(http.MethodPost, "tasks/request-routing", func(ctx context.Context, _ *service, body object, _ []string) (any, error) {
		if _, _, _, err := managementResolve("tasks.request-routing", object{"body": body}); err != nil {
			return nil, err
		}
		return notificationRoutingControl(ctx, body, true)
	})
	registerRoute(http.MethodPost, "tasks/presence", func(_ context.Context, _ *service, body object, _ []string) (any, error) {
		agent, task := text(body, "agent"), text(body, "taskId")
		if agent == "" || task == "" {
			return nil, errors.New("agent and taskId required")
		}
		notificationEventOperation.Lock()
		defer notificationEventOperation.Unlock()
		present := body["present"] == true
		before := notificationPresent
		if present {
			notificationPresent = notificationPresence{agent, task, notificationClock().UnixMilli()}
		} else if before.agent == agent && before.task == task {
			notificationPresent = notificationPresence{}
		}
		if before.agent != notificationPresent.agent || before.task != notificationPresent.task {
			notificationSignal()
		}
		return object{"present": present}, nil
	})
}
