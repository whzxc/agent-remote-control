package core

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"sync"
)

var notifySettingsLock sync.Mutex

func notificationSettings() (object, error) {
	notifySettingsLock.Lock()
	defer notifySettingsLock.Unlock()
	return loadNotificationSettings()
}

func loadNotificationSettings() (object, error) {
	path := filepath.Join(root(), "task-settings.json")
	value, err := load(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	settings := obj(value)
	if settings == nil {
		settings = object{}
	}
	old := settings["notificationWakeLimit"]
	_, migrated := settings["notificationWakeLimit"]
	if migrated {
		delete(settings, "notificationWakeLimit")
		if settings["notificationBucketCapacity"] == nil {
			capacity := uintOr(old, 0)
			if capacity == 0 || capacity == 20 {
				capacity = 10
			}
			settings["notificationBucketCapacity"] = min(capacity, 1000)
		}
		if n, ok := uintValue(old); ok && n == 0 {
			settings["notificationsEnabled"] = false
		}
	}
	for key, value := range (object{
		"enabled": false, "autoOpenCodex": operatingSystem != "linux", "desktopRecovery": "prompt",
		"notificationsEnabled": true, "requestRoutingDelaySeconds": 15, "notificationBucketCapacity": 10,
		"notificationRefillSeconds": 60, "notificationEscalationSeconds": 900,
		"codexRetryMaxAttempts": 3, "codexRetryInitialSeconds": 30,
	}) {
		if settings[key] == nil {
			settings[key] = value
		}
	}
	if migrated {
		return settings, save(path, settings)
	}
	return settings, nil
}

func updateNotificationSettings(body object) (object, error) {
	notifySettingsLock.Lock()
	defer notifySettingsLock.Unlock()
	settings, err := loadNotificationSettings()
	if err != nil {
		return nil, err
	}
	for _, key := range []string{"enabled", "autoOpenCodex", "notificationsEnabled"} {
		if value, exists := body[key]; exists {
			if _, ok := value.(bool); !ok {
				return nil, errors.New("invalid task setting")
			}
			settings[key] = value
		}
	}
	if value, exists := body["desktopRecovery"]; exists {
		if operatingSystem != "darwin" || (value != "prompt" && value != "restart" && value != "independent") {
			return nil, errors.New("Invalid macOS Desktop recovery setting")
		}
		settings["desktopRecovery"] = value
	}
	if _, exists := body["notificationWakeLimit"]; exists {
		return nil, errors.New("RETIRED_SETTING: use notificationBucketCapacity and notificationRefillSeconds")
	}
	for _, item := range []struct {
		key      string
		min, max uint64
		message  string
	}{
		{"notificationBucketCapacity", 1, 1000, "invalid notification setting"},
		{"notificationRefillSeconds", 1, 86400, "invalid notification setting"},
		{"notificationEscalationSeconds", 1, 86400, "invalid notification setting"},
		{"requestRoutingDelaySeconds", 0, 300, "invalid retry setting"},
		{"codexRetryMaxAttempts", 0, 10, "invalid retry setting"},
		{"codexRetryInitialSeconds", 1, 3600, "invalid retry setting"},
	} {
		if value, exists := body[item.key]; exists {
			n, valid := uintValue(value)
			if !valid || n < item.min || n > item.max {
				return nil, errors.New(item.message)
			}
			settings[item.key] = n
		}
	}
	if err := save(filepath.Join(root(), "task-settings.json"), settings); err != nil {
		return nil, err
	}
	wakeNotificationScheduler()
	return settings, nil
}

func init() {
	registerRoute(http.MethodGet, "task-settings", func(context.Context, *service, object, []string) (any, error) {
		return notificationSettings()
	})
	registerRoute(http.MethodPut, "task-settings", func(_ context.Context, _ *service, body object, _ []string) (any, error) {
		return updateNotificationSettings(body)
	})
}

var notificationClock = time.Now
var claudeSessionPattern = regexp.MustCompile(`^(session_|cse_)[A-Za-z0-9]{24}$`)
var notificationChanged = make(chan struct{})

func notificationSignal() {
	close(notificationChanged)
	notificationChanged = make(chan struct{})
	wakeNotificationScheduler()
}

func notificationSessionID(raw string) (string, error) {
	target := strings.TrimSpace(raw)
	if session, ok := strings.CutPrefix(target, "antigravity_"); ok {
		if parsed, err := uuid.Parse(session); err == nil {
			return "antigravity_" + parsed.String(), nil
		}
	}
	if session, ok := strings.CutPrefix(target, "conversation://"); ok {
		if parsed, err := uuid.Parse(session); err == nil {
			return "antigravity_" + parsed.String(), nil
		}
	}
	url := strings.TrimPrefix(strings.TrimPrefix(target, "https://"), "http://")
	if session, ok := strings.CutPrefix(url, "claude.ai/code/"); ok {
		if i := strings.IndexAny(session, "?#"); i >= 0 {
			session = session[:i]
		}
		target = strings.TrimRight(session, "/")
	}
	if claudeSessionPattern.MatchString(target) {
		return target, nil
	}
	return "", dispatchObjectError(object{"code": "INVALID_CLAUDE_SESSION",
		"message":  "Invalid cloud-session target. Expected session_ or cse_ followed by exactly 24 ASCII letters/digits, or a claude.ai/code URL containing that ID. A local Claude CLI UUID is not a cloud-session ID.",
		"argument": "target", "expectedFormat": "^(session_|cse_)[A-Za-z0-9]{24}$",
		"next": object{"via": "query", "op": "guide", "args": object{"topic": "notify"}, "hint": "Copy the receiving conversation's complete cloud-session ID from its claude.ai/code URL, then retry notify_control action:bind with that target. This request was rejected before binding or delivery."}})
}

func notificationTargetChannel(target string) string {
	if strings.HasPrefix(target, "antigravity_") {
		return "antigravity-session"
	}
	return "claude-session"
}

func normalizeNotification(args object) error {
	if _, ok := args["notify"]; !ok && args["purpose"] == "self-test" {
		args["notify"] = nil
	}
	notify := obj(args["notify"])
	channel := text(notify, "channel")
	if channel == "claude-session" || channel == "antigravity-session" {
		target, err := notificationSessionID(text(notify, "target"))
		if err != nil {
			return err
		}
		derived := notificationTargetChannel(target)
		if channel == "antigravity-session" && derived != channel {
			return errors.New("INVALID_ANTIGRAVITY_SESSION")
		}
		notify["channel"], notify["target"] = derived, target
	}
	return nil
}

func notificationInboxPath(sourceID string) string {
	return filepath.Join(notificationDirectory(), "inboxes", hash([]byte(sourceID))+".json")
}

func readNotificationInbox(sourceID string) ([]any, error) {
	data, err := load(notificationInboxPath(sourceID))
	if errors.Is(err, os.ErrNotExist) {
		return []any{}, nil
	}
	if err != nil {
		return nil, err
	}
	rows := arr(data)
	if rows == nil {
		return nil, errors.New("INVALID_INBOX")
	}
	return rows, nil
}

func notificationEventThread(event object) string {
	task := str(dispatchFirstString(event["threadId"], event["taskId"]))
	if device := text(event["device"], "id"); device != "" {
		return notificationDeviceKey(device, task)
	}
	return task
}

func notificationInboxSelect(source object, target string, filters object) (object, error) {
	sourceID := text(source, "sourceId")
	rows, err := readNotificationInbox(sourceID)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	state, err := readNotificationState()
	if err != nil {
		return nil, err
	}
	claude := source["controlSource"] == "claude"
	if !claude {
		for _, sub := range arr(state["subscriptions"]) {
			if field(sub, "sourceId") == sourceID && field(sub, "channel") == "mcp-events" &&
				notificationSubscriptionActive(obj(sub), notificationClock().UnixMilli()) &&
				source["eventPrincipal"] != nil && source["eventPrincipal"] == field(field(sub, "webhook"), "principal") {
				return nil, nil
			}
		}
	}
	events, unchanged := []any{}, []any{}
	unread := 0
	changed := false
	for _, row := range rows {
		event := obj(row)
		if event == nil || event["read"] == true {
			continue
		}
		var delivery object
		bind, err := readNotificationBinding(notificationEventThread(event), text(event, "turnId"))
		if err != nil {
			return nil, err
		}
		if bind != nil && bind["sourceId"] == sourceID {
			event["target"], event["channel"] = bind["target"], bind["channel"]
			delivery = find(bind["deliveries"], "eventId", text(event, "eventId"))
			if field(bind["observation"], "conflict") != nil && !slices.ContainsFunc(arr(bind["deliveries"]), func(d any) bool {
				return field(d, "eventId") == event["eventId"] && uintOr(field(d, "attemptedAt"), 0) > 0
			}) {
				continue
			}
			if request := obj(event["interaction"]); request != nil && request["resolved"] != true {
				if err := observeNotificationRouting(notificationAgent(bind), text(bind, "threadId"), request); err != nil {
					return nil, err
				}
				event["routing"], event["questionSummary"] = request["routing"], notificationQuestionPreview(request)
			}
		}
		if claude && (target == "" || event["target"] != target || (event["channel"] != "claude-session" && event["channel"] != "antigravity-session")) {
			continue
		}
		if threads, tasks := arr(filters["threadIds"]), arr(filters["taskIds"]); threads != nil || tasks != nil {
			if !slices.Contains(threads, event["threadId"]) && !slices.Contains(tasks, event["taskId"]) {
				continue
			}
		}
		if kinds := arr(filters["eventTypes"]); kinds != nil && !slices.Contains(kinds, event["kind"]) {
			continue
		}
		incremental := filters == nil && claude && (text(delivery, "target") != "" || event["attached"] == true)
		if incremental && (event["attached"] == true || delivery["status"] == "delivered" || delivery["status"] == "resolved") {
			if event["attached"] != true {
				event["attached"], changed = true, true
			}
			continue
		}
		unread++
		visible := clone(event)
		delete(visible, "attached")
		delete(visible, "attachedHash")
		stripNotificationInternal(visible)
		fingerprint := hash([]byte(wire(visible)))
		if filters == nil && !claude && event["attachedHash"] == fingerprint {
			if len(unchanged) < 5 {
				unchanged = append(unchanged, object{"eventId": event["eventId"], "kind": event["kind"], "threadId": event["threadId"], "taskId": event["taskId"], "turnId": event["turnId"]})
			}
			continue
		}
		if len(events) == 5 {
			continue
		}
		if filters == nil {
			event["attachedHash"], changed = fingerprint, true
		}
		if incremental {
			event["attached"] = true
		}
		if destination := text(visible, "target"); destination != "" {
			notice := "Conversation ownership needs verification. Only the target conversation may handle this."
			if target == destination {
				notice = "bound to this conversation"
			} else if target != "" {
				notice = "bound to another conversation"
			}
			visible["bindingNotice"] = notice
		}
		events = append(events, visible)
	}
	if changed {
		if err := save(notificationInboxPath(sourceID), rows); err != nil {
			return nil, err
		}
	}
	if len(events) == 0 && len(unchanged) == 0 {
		return nil, nil
	}
	return object{"unread": unread, "events": events, "unchangedEvents": unchanged, "next": object{
		"via": "query", "op": "inbox_wait", "args": object{"timeoutMs": 0}, "hint": "Explicit inbox_wait returns complete unread events without acknowledging them."}}, nil
}

func notificationInboxWait(ctx context.Context, r operationRequest) (any, error) {
	source := r.source.origin
	if text(source, "sourceId") == "" {
		return nil, errors.New("SOURCE_REQUIRED")
	}
	var target string
	if raw, ok := r.args["target"].(string); ok {
		var err error
		target, err = notificationSessionID(raw)
		if err != nil {
			return nil, err
		}
	}
	start := time.Now()
	deadline := start.Add(time.Duration(uintOr(r.args["timeoutMs"], 30000)) * time.Millisecond)
	for {
		notificationEventOperation.Lock()
		changed := notificationChanged
		inbox, err := notificationInboxSelect(source, target, r.args)
		notificationEventOperation.Unlock()
		if err != nil {
			return nil, err
		}
		if inbox != nil {
			return object{"state": "events", "events": inbox["events"], "unread": inbox["unread"], "elapsedMs": time.Since(start).Milliseconds()}, nil
		}
		if left := time.Until(deadline); left <= 0 {
			return object{"state": "timeout", "events": []any{}, "unread": 0, "elapsedMs": time.Since(start).Milliseconds(),
				"next": object{"via": "query", "op": "inbox_wait", "args": r.args, "hint": "Continue waiting with the same filters; read a task or use notification_ack after handling its events."}}, nil
		}
		timer := time.NewTimer(min(time.Until(deadline), time.Second))
		select {
		case <-ctx.Done():
			timer.Stop()
			return object{"state": "unconfirmed", "reason": "connector-shutdown", "events": []any{}, "unread": 0}, nil
		case <-changed:
			timer.Stop()
		case <-timer.C:
		}
	}
}

func init() {
	registerOperation("inbox_wait", notificationInboxWait, nil)
}

func notificationKind(d object) string {
	if d["state"] == "stalled" {
		return "stalled"
	}
	state := text(d, "taskState")
	if state == "handoff" || state == "recovered" {
		return state
	}
	if d["key"] == "terminal" {
		switch state {
		case "completed", "failed":
			return state
		case "cancelled", "interrupted":
			return "interrupted"
		}
	}
	return "needs-input"
}

var notificationGlyphs = []string{"? input", "⚑ approve", "✗ failed", "■ halted", "↪ moved", "✓ done", "↔ handoff", "↻ revived", "✉ mail", "! stalled"}

func notificationGlyph(d object) string {
	index := 0
	switch notificationKind(d) {
	case "stalled":
		index = 9
	case "recovered":
		index = 7
	case "handoff":
		index = 6
	case "completed":
		index = 5
	case "interrupted":
		index = 3
		if obj(d["continuation"]) != nil {
			index = 4
		}
	case "failed":
		index = 2
	default:
		if d["state"] == "waiting for approval" {
			index = 1
		}
	}
	return notificationGlyphs[index]
}

func notificationDoorbell(glyphs []string) string {
	counts := make(map[string]int)
	for _, glyph := range glyphs {
		counts[glyph]++
	}
	var labels []string
	for _, glyph := range notificationGlyphs {
		if n := counts[glyph]; n > 0 {
			label := glyph
			if n > 1 {
				label += fmt.Sprintf(" ×%d", n)
			}
			labels = append(labels, label)
		}
	}
	return notificationReceiptHeader + "\n" + strings.Join(labels, " · ")
}

func notificationTaskTitle(bind object) string {
	for _, key := range []string{"threadTitle", "title", "project"} {
		if title := strings.TrimSpace(text(bind, key)); title != "" {
			return title
		}
	}
	return ""
}

func notificationEvent(bind, d object) object {
	kind := notificationKind(d)
	agent, thread := text(bind, "agent"), text(bind, "threadId")
	var threadID, taskID any
	var next object
	if agent == "" || agent == "codex" {
		agent, threadID = "codex", thread
		switch kind {
		case "needs-input":
			next = object{"via": "query", "op": "codex_pending", "args": object{"threadId": thread},
				"hint": "Read the pending interaction before responding. If no request is exposed, handle it in Codex Desktop."}
		default:
			next = object{"via": "query", "op": "codex_read", "args": object{"threadId": thread}, "hint": "Read the result and review its changes."}
		}
	} else {
		taskID = thread
		op, hint := "agent_read", "Read the result and review it against the acceptance criteria."
		if kind == "needs-input" {
			op, hint = "agent_pending", "Read the pending interaction before responding."
		}
		next = object{"via": "query", "op": op, "args": object{"agent": agent, "taskId": thread}, "hint": hint}
	}
	switch kind {
	case "recovered":
		next = object{"via": "query", "op": "notify_status", "args": object{"target": d["target"]},
			"hint": "Inspect affected bindings and reconnect the control-source client if needed."}
	case "stalled":
		next = obj(field(d["progress"], "next"))
	case "handoff":
		next = object{"via": "query", "op": "codex_owner", "args": object{"threadId": thread}, "hint": "Inspect the current writer and observed handoff history before continuing."}
	}
	if action := obj(field(d["interaction"], "next")); action != nil {
		next = action
	}
	var target, failure, owner any
	if name := text(d, "target"); name != "" {
		target = name
	}
	if kind == "handoff" {
		owner = d["taskError"]
	} else {
		failure = d["taskError"]
	}
	title := notificationTaskTitle(bind)
	event := object{"eventId": d["eventId"], "kind": kind, "project": bind["project"], "threadId": threadID, "taskId": taskID, "agent": agent,
		"turnId": bind["turnId"], "title": title, "channel": d["channel"], "target": target, "causedBy": bind["causedBy"], "summary": notificationGlyph(d),
		"progress": d["progress"], "interaction": d["interaction"], "questionSummary": notificationQuestionPreview(obj(d["interaction"])), "routing": field(d["interaction"], "routing"),
		"dispatches": d["dispatches"], "externalUserInputs": d["externalUserInputs"], "finalResponse": d["finalResponse"], "error": failure,
		"reconciliation": d["reconciliation"], "continuation": d["continuation"], "recovery": d["recovery"], "ownership": owner, "next": next}
	projectNotificationDevice(bind, event)
	if dispatches := arr(event["dispatches"]); dispatches != nil {
		rows := make([]any, 0, len(dispatches))
		for _, dispatch := range dispatches {
			rows = append(rows, clone(obj(dispatch)))
		}
		event["dispatches"] = rows
	}
	stripNotificationInternal(event)
	return event
}

func appendNotificationInbox(source string, event object) error {
	if source == "" {
		return nil
	}
	rows, err := readNotificationInbox(source)
	if err != nil {
		return err
	}
	if find(rows, "eventId", text(event, "eventId")) != nil {
		return nil
	}
	rows = append(rows, event)
	if len(rows) > 50 {
		rows = rows[len(rows)-50:]
	}
	if err := save(notificationInboxPath(source), rows); err != nil {
		return err
	}
	notificationSignal()
	return nil
}

func notificationAcknowledge(_ context.Context, request operationRequest) (any, error) {
	source := text(request.source.origin, "sourceId")
	if source == "" {
		return nil, errors.New("SOURCE_REQUIRED")
	}
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	state, err := readNotificationState()
	if err != nil {
		return nil, err
	}
	if _, verify := request.args["code"]; verify {
		return acknowledgeNotificationChallenge(state, source, request.args)
	}
	rows, err := readNotificationInbox(source)
	if err != nil {
		return nil, err
	}
	bindings, err := notificationBindings()
	if err != nil {
		return nil, err
	}
	ids := dispatchPolicyStrings(request.args["eventIds"])
	if request.args["all"] == true {
		ids = nil
		for _, row := range rows {
			if id := text(row, "eventId"); id != "" {
				ids = append(ids, id)
			}
		}
	}
	slices.Sort(ids)
	marked, already := 0, 0
	missing := []string{}
	now := notificationClock().Unix()
	dirtyState := false
	for _, id := range slices.Compact(ids) {
		row := find(rows, "eventId", id)
		var bind, delivery object
		for _, b := range bindings {
			if b["sourceId"] == source {
				if d := find(b["deliveries"], "eventId", id); d != nil {
					bind, delivery = b, d
					break
				}
			}
		}
		if row == nil && delivery == nil {
			missing = append(missing, id)
			continue
		}
		if row["read"] == true || slices.Contains([]string{"delivered", "digested", "resolved"}, text(delivery, "status")) {
			already++
		} else {
			marked++
		}
		if row == nil {
			row = notificationEvent(bind, delivery)
			rows = append(rows, row)
		}
		row["read"], row["readAt"] = true, now
		if bind != nil {
			notificationThread(state, source, text(bind, "threadId"), now, true)["lastAckAt"] = now
			dirtyState = true
		}
	}
	if err := save(notificationInboxPath(source), rows); err != nil {
		return nil, err
	}
	if dirtyState {
		if err := saveNotificationState(state); err != nil {
			return nil, err
		}
	}
	return object{"markedRead": marked, "alreadyRead": already, "notFound": len(missing), "notFoundEventIds": missing}, nil
}

func init() {
	registerOperation("notification_ack", notificationAcknowledge, nil)
	registerStatusContribution(func(_ context.Context, _ *service, value object) error {
		settings, err := notificationSettings()
		if err == nil {
			for _, key := range []string{"autoOpenCodex", "desktopRecovery", "requestRoutingDelaySeconds"} {
				value[key] = settings[key]
			}
			value["taskApprovalEnabled"] = settings["enabled"]
		}
		return err
	})
}

func notificationClaudeArguments(target, body string) []string {
	return []string{"-p", body, "--cloud", target, "--output-format", "json"}
}

func newNotificationBinding(thread, turn, cwd, source string, created time.Time) object {
	project := filepath.Base(filepath.Clean(cwd))
	if project == "." || project == string(filepath.Separator) || project == ".." {
		project = "Untitled"
	}
	return object{"threadId": thread, "turnId": turn, "target": nil, "channel": "claude-session",
		"sourceId": source, "agent": "", "title": "", "threadTitle": "", "explicit": false, "project": project,
		"createdAt": created.Unix(), "waiting": []any{}, "deliveries": []any{}, "continuationBound": false,
		"continuationUntil": 0, "scopeEnd": nil, "scopeStartedAt": created.UnixMilli(), "successor": nil, "observation": nil, "retry": nil}
}

func applyNotificationRebind(bind, rule object) {
	rebind := obj(rule["rebind"])
	if rebind == nil {
		return
	}
	bind["target"], bind["channel"] = rebind["target"], rebind["channel"]
	if rebind["target"] == nil {
		bind["scopeEnd"] = "source-unbound"
	}
	for _, item := range arr(bind["deliveries"]) {
		d := obj(item)
		if d["channel"] == "mcp-events" || !(d["status"] == "pending" ||
			d["status"] == "failed" && (d["error"] == "unbound" || d["error"] == "binding-changed")) {
			continue
		}
		destination, channel := text(rebind, "target"), rebind["channel"]
		if d["target"] != destination || d["channel"] != channel {
			d["tokenCharged"], d["failures"], d["nextAttemptAt"] = false, 0, 0
		}
		d["target"], d["channel"], d["status"], d["error"] = destination, channel, "pending", nil
	}
}

// A calls this at accepted turn publication, with the authenticated origin
// and the same normalized arguments used for the request digest.
func bindNotification(ctx context.Context, args object, thread, turn, cwd string, cause object) error {
	if turn == "" {
		return nil
	}
	origin := currentOrigin(ctx)
	source := text(origin, "sourceId")
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	bind, err := readNotificationBinding(thread, turn)
	if err != nil {
		return err
	}
	created := bind == nil
	if !created {
		switch bind["sourceId"] {
		case "":
			return errors.New("NOTIFICATION_SOURCE_UNATTRIBUTED")
		case source:
		default:
			return errors.New("NOTIFICATION_SOURCE_MISMATCH")
		}
	}
	now := notificationClock()
	if created {
		bind = newNotificationBinding(thread, turn, cwd, source, now)
	}
	if notify, specified := args["notify"]; specified {
		name, requested := field(notify, "target"), field(notify, "channel")
		if bind["target"] != name || bind["channel"] != requested {
			for _, line := range arr(bind["deliveries"]) {
				d := obj(line)
				if d["channel"] != "mcp-events" && d["status"] == "pending" {
					d["status"], d["error"] = "failed", "binding-changed"
				}
			}
		}
		bind["explicit"], bind["target"] = true, name
		if notify != nil {
			bind["channel"] = requested
		}
	}
	if origin["controlTransport"] == "peer" {
		bind["peerController"], bind["target"] = source, nil
	}
	if d, ok := args["_device"]; ok && d != nil {
		bind["device"] = d
	}
	if text(bind, "agent") == "" {
		bind["agent"] = dispatchFirstString(args["agent"], "codex")
	}
	if created {
		bind["title"] = dispatchTitle(args)
		if cause != nil {
			bind["causedBy"] = clone(cause)
		}
		bind["retry"] = object{"model": args["_retryModel"], "turn": args["_retryTurn"], "attempts": uintOr(args["_retryAttempt"], 0), "origin": origin}
	}
	if bind["peerController"] != nil {
		return persistNotificationBinding(bind)
	}
	state, err := readNotificationState()
	if err != nil {
		return err
	}
	var predecessor object
	if created {
		_, explicit := args["notify"]
		op := text(cause, "op")
		rows, err := notificationBindingsForThread(thread)
		if err != nil {
			return err
		}
		if !explicit && (op == "codex_send" || op == "agent_send" && args["_device"] != nil) {
			for _, b := range rows {
				if b["threadId"] == thread && b["turnId"] != turn && b["sourceId"] == source && b["scopeEnd"] == nil && b["continuationBound"] != true &&
					(predecessor == nil || uintOr(b["createdAt"], 0) >= uintOr(predecessor["createdAt"], 0)) {
					predecessor = b
				}
			}
		}
		if predecessor != nil {
			bind["target"], bind["channel"], bind["title"] = predecessor["target"], predecessor["channel"], predecessor["title"]
			bind["scopeStartedAt"] = uintOr(predecessor["scopeStartedAt"], uintOr(predecessor["createdAt"], 0)*1000)
			dispatchSetSection(bind, "causedBy")["continuationOf"] = predecessor["turnId"]
		} else if (op == "codex_create" || op == "codex_send") && uintOr(args["_retryAttempt"], 0) == 0 {
			for _, b := range rows {
				if b["threadId"] == thread && b["turnId"] != turn && b["scopeEnd"] == nil {
					b["scopeEnd"] = "new-unrelated-dispatch"
					if err := persistNotificationBinding(b); err != nil {
						return err
					}
				}
			}
		}
	}
	applyNotificationRebind(bind, notificationThread(state, source, thread, now.Unix(), false))
	if target := text(bind, "target"); target != "" {
		settings, err := notificationSettings()
		if err != nil {
			return err
		}
		notificationTarget(state, settings, source, text(bind, "channel"), target, now.Unix())
		if err := saveNotificationState(state); err != nil {
			return err
		}
	}
	if err := persistNotificationBinding(bind); err != nil {
		return err
	}
	if predecessor != nil {
		predecessor["continuationBound"] = true
		predecessor["successor"] = object{"turnId": turn, "inherited": true, "reason": "same-origin-thread-continuation"}
		if err := persistNotificationBinding(predecessor); err != nil {
			return err
		}
	}
	notificationSignal()
	return nil
}

func readNotification(ctx context.Context, thread, turn, since string) (object, error) {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	bind, err := readNotificationBinding(thread, turn)
	if err != nil || bind == nil {
		return nil, err
	}
	if origin := currentOrigin(ctx); origin != nil && bind["sourceId"] != origin["sourceId"] {
		return nil, nil
	}
	if bind["target"] == nil {
		return nil, nil
	}
	cutoff, _ := time.Parse(time.RFC3339Nano, since)
	deliveries := []any{}
	for _, item := range arr(bind["deliveries"]) {
		d := obj(item)
		if d["channel"] != bind["channel"] || d["target"] != bind["target"] {
			continue
		}
		queued := uintOr(field(d["timing"], "queuedAt"), uintOr(d["createdAt"], 0)*1000)
		if !cutoff.IsZero() && time.UnixMilli(int64(queued)).Before(cutoff) {
			continue
		}
		level := "L2"
		if d["channel"] == "claude-session" {
			level = "L1"
		}
		deliveries = append(deliveries, object{"eventId": d["eventId"], "kind": notificationKind(d), "level": level,
			"state": d["status"], "error": d["error"], "timing": d["timing"]})
	}
	state, err := readNotificationState()
	if err != nil {
		return nil, err
	}
	reach := newNotificationReachability()
	if t := findNotificationTarget(state, text(bind, "sourceId"), text(bind, "channel"), text(bind, "target")); t != nil {
		reach = notificationReachability(t)
	}
	expireNotificationReachability(reach, notificationClock().Unix())
	return object{"sourceId": bind["sourceId"], "channel": bind["channel"], "target": bind["target"], "deliveries": deliveries,
		"reachability": reach["state"], "reason": reach["reason"]}, nil
}

func notificationPushAvailable(value any) bool {
	channel, target := text(value, "channel"), text(value, "target")
	if (channel != "claude-session" && channel != "antigravity-session") || target == "" || field(value, "reachability") != "verified" {
		return false
	}
	settings, err := notificationSettings()
	if err != nil || settings["notificationsEnabled"] == false || notificationTransportAvailable == nil || !notificationTransportAvailable(channel) {
		return false
	}
	state, err := readNotificationState()
	return err == nil && findNotificationTarget(state, text(value, "sourceId"), channel, target)["breaker"] != true
}

func init() { controlPushAvailable = notificationPushAvailable }

// D runs the selected Claude profile. A sends through the local Antigravity API.
var notificationClaudeRun func(context.Context, string, []string) ([]byte, error)
var notificationAntigravitySend func(context.Context, string, string) error
var notificationAccountBind func(context.Context, string, string) error
var notificationTransportAvailable func(string) bool

func notificationSessionNotFound(message string) bool {
	return strings.Contains(strings.ToLower(message), "session not found") || strings.Contains(message, "CLAUDE_SESSION_NOT_FOUND")
}

func deliverNotificationSession(ctx context.Context, channel, profile, target, body string) error {
	settings, err := notificationSettings()
	if err != nil {
		return err
	}
	if settings["notificationsEnabled"] == false {
		return errors.New("NOTIFICATIONS_DISABLED")
	}
	if channel == "antigravity-session" {
		return notificationAntigravitySend(ctx, target, body)
	}
	output, err := notificationClaudeRun(ctx, profile, notificationClaudeArguments(target, body))
	if err != nil {
		if notificationSessionNotFound(err.Error()) || notificationSessionNotFound(string(output)) {
			return errors.New("CLAUDE_SESSION_NOT_FOUND: Session not found")
		}
		return err
	}
	var result object
	if err := decodeObject(output, &result); err != nil {
		if notificationSessionNotFound(string(output)) {
			return errors.New("CLAUDE_SESSION_NOT_FOUND: Session not found")
		}
		return errors.New("CLAUDE_SEND_UNKNOWN")
	}
	if result["ok"] == true {
		if result["session_id"] != target {
			return errors.New("CLAUDE_SESSION_MISMATCH")
		}
		return nil
	}
	for _, key := range []string{"error", "errors", "message"} {
		if notificationSessionNotFound(wire(result[key])) {
			return errors.New("CLAUDE_SESSION_NOT_FOUND: Session not found")
		}
	}
	return fmt.Errorf("CLAUDE_SEND_REJECTED: %s", wire(result["error"]))
}

func deliverAccountNotification(ctx context.Context, args object) (object, error) {
	target, err := notificationSessionID(text(args, "target"))
	if err != nil {
		return nil, err
	}
	accountID, body := text(args, "accountId"), text(args, "message")
	if strings.TrimSpace(body) == "" || utf8.RuneCountInString(body) > 8000 {
		return nil, errors.New("INVALID_NOTIFICATION_MESSAGE: Supply 1 to 8000 characters")
	}
	if err := notificationAccountBind(ctx, target, accountID); err != nil {
		return nil, err
	}
	if err := notificationSessionSend(ctx, notificationTargetChannel(target), accountID, target, body); err != nil {
		return nil, err
	}
	return object{"accountId": accountID, "target": target, "deliveryStatus": "delivered",
		"hint": "Claude CLI accepted the message for this exact session. This does not confirm receiver display or acknowledgement."}, nil
}

func notificationAccountSessions() ([]any, error) {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	state, err := readNotificationState()
	if err != nil {
		return nil, err
	}
	now := notificationClock().Unix()
	sessions := []any{}
	for _, item := range arr(state["targets"]) {
		t := obj(item)
		r := notificationReachability(t)
		expireNotificationReachability(r, now)
		var last any
		if batches := arr(t["batches"]); len(batches) > 0 {
			b := batches[len(batches)-1]
			last = object{"at": field(b, "at"), "status": field(b, "status")}
		}
		sessions = append(sessions, object{"sourceId": t["sourceId"], "accountId": t["accountId"], "channel": t["channel"], "target": t["target"],
			"registered": t["registered"], "state": r["state"], "verified": r["state"] == "verified", "lastDelivery": last, "lastVerificationDelivery": r["deliveryStatus"]})
	}
	for _, raw := range arr(state["subscriptions"]) {
		sub := obj(raw)
		if sub["channel"] != "mcp-events" {
			continue
		}
		reachable := notificationSubscriptionActive(sub, now*1000) && !notificationSubscriptionMuted(sub, now) && uintOr(field(sub["webhook"], "verifiedUntil"), 0) > uint64(now)
		status := "unavailable"
		if reachable {
			status = "reachable"
		}
		sessions = append(sessions, object{"sourceId": sub["sourceId"], "channel": "mcp-events", "target": sub["id"], "state": status, "reachable": reachable, "registered": true})
	}
	return sessions, nil
}

func notificationSourceAccount(source, target string) (string, error) {
	state, err := readNotificationState()
	if err != nil {
		return "", err
	}
	profile := text(findNotificationTarget(state, source, "claude-session", target), "accountId")
	if profile == "" {
		return "", errors.New("ACCOUNT_SELECTION_REQUIRED: Bind this target with notify_control and an accountId")
	}
	return profile, nil
}

func verifiedNotificationConversationTarget(source, target string) (bool, error) {
	state, err := readNotificationState()
	if err != nil {
		return false, err
	}
	destination := findNotificationTarget(state, source, "claude-session", target)
	if destination == nil {
		return false, nil
	}
	r := notificationReachability(destination)
	expireNotificationReachability(r, notificationClock().Unix())
	return r["state"] == "verified", nil
}

func recordNotificationBindingFailure(receipt object, err error) {
	if err != nil {
		recordLog("WARN", "Task dispatched, but notification binding failed: "+err.Error(), nil)
		receipt["notification"], receipt["notificationError"] = "bind-failed", err.Error()
	}
}

func notificationResumeContext(ctx context.Context, thread, turn string) (object, error) {
	fail := func(code, message string) error {
		return dispatchObjectError(object{"code": code, "message": message, "next": object{"via": "query", "op": "codex_read", "args": object{"threadId": thread, "statusOnly": true}}})
	}
	b, err := readNotificationBinding(thread, turn)
	if err != nil {
		return nil, err
	}
	if b == nil {
		return nil, fail("RESUME_BINDING_MISSING", "Resume only a bound ARC dispatch.")
	}
	origin := currentOrigin(ctx)
	if b["scopeEnd"] != nil || origin["authType"] != "local" && origin["sourceId"] != b["sourceId"] {
		return nil, fail("RESUME_SOURCE_MISMATCH", "The thread binding ended or belongs to another source.")
	}
	rows, err := dispatchRecords(thread)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if row["turnId"] == turn {
			return object{"model": row["model"], "effort": row["effort"], "serviceTier": row["serviceTier"], "source": "inherited-dispatch-not-confirmed"}, nil
		}
	}
	return nil, errors.New("RESUME_DISPATCH_MISSING")
}

func notificationQuestionPreview(request object) object {
	params, ok := request["params"]
	if !ok {
		params = request
	}
	questions := arr(field(params, "questions"))
	rows := []any{}
	var summaries []string
	take := func(s string, n int) string {
		r := []rune(s)
		return string(r[:min(n, len(r))])
	}
	for _, q := range questions[:min(6, len(questions))] {
		label := take(text(q, "question"), 480)
		options := arr(field(q, "options"))
		choices := []any{}
		for _, o := range options[:min(8, len(options))] {
			choices = append(choices, object{"label": take(str(dispatchFirstString(o, field(o, "label"))), 120), "description": take(text(o, "description"), 160)})
		}
		rows = append(rows, object{"id": field(q, "id"), "question": label, "options": choices})
		summaries = append(summaries, label)
	}
	if len(rows) == 0 {
		for _, key := range []string{"question", "prompt", "message", "summary"} {
			if prompt := text(params, key); prompt != "" {
				options := arr(field(params, "options"))
				if options == nil {
					options = []any{}
				}
				label := take(prompt, 480)
				rows = append(rows, object{"question": label, "options": options[:min(8, len(options))]})
				summaries = append(summaries, label)
				break
			}
		}
	}
	count := len(questions)
	if questions == nil {
		count = len(rows)
	}
	responseID, exists := request["responseId"]
	if !exists {
		responseID = request["id"]
	}
	return object{"questions": rows, "summary": strings.Join(summaries, "; "), "questionCount": count, "responseId": responseID,
		"turnId": field(params, "turnId"), "backendSession": request["backendSession"], "routing": request["routing"]}
}

func acknowledgeNotificationReads(source string, reads map[[2]string]bool) error {
	if source == "" || len(reads) == 0 {
		return nil
	}
	rows, err := readNotificationInbox(source)
	if err != nil || len(rows) == 0 {
		return err
	}
	state, err := readNotificationState()
	if err != nil {
		return err
	}
	now := notificationClock().Unix()
	dirty, controlChanged := false, false
	for _, raw := range rows {
		row := obj(raw)
		thread, turn := notificationEventThread(row), text(row, "turnId")
		if row["read"] == true || !reads[[2]string{thread, turn}] {
			continue
		}
		b, err := readNotificationBinding(thread, turn)
		if err != nil {
			return err
		}
		if b != nil && b["sourceId"] != source {
			continue
		}
		row["read"], row["readAt"], dirty = true, now, true
		if b != nil {
			notificationThread(state, source, thread, now, true)["lastAckAt"] = now
			controlChanged = true
		}
	}
	if dirty {
		if err := save(notificationInboxPath(source), rows); err != nil {
			return err
		}
	}
	if controlChanged {
		return saveNotificationState(state)
	}
	return nil
}

func notificationTaskReadOperation(op string) bool {
	return slices.Contains([]string{"codex_read", "codex_wait", "codex_items", "codex_changes", "agent_read", "agent_wait"}, op)
}

func projectNotificationControlResult(ctx context.Context, r operationRequest, value object) {
	if value["error"] != nil || outcomeError(value) != nil {
		return
	}
	task := str(dispatchFirstString(value["taskId"], r.args["taskId"], value["threadId"], r.args["threadId"]))
	turn := text(value, "turnId")
	if dispatchReceipt(value) && task != "" && turn != "" && value["notification"] != "bind-failed" {
		since := ""
		if value["operation"] == "send" || value["operation"] == "create" {
			since = text(value, "createdAt")
		}
		delivery, err := readNotification(ctx, task, turn, since)
		if err != nil {
			value["notificationError"] = err.Error()
		} else if delivery != nil {
			value["notification"] = delivery
		} else {
			value["notification"] = nil
		}
	}
	if task != "" && turn != "" {
		if b, err := readNotificationBinding(task, turn); err == nil && b["sourceId"] == r.source.origin["sourceId"] {
			if retry := obj(b["retry"]); retry != nil && text(retry, "status") != "" {
				value["retry"] = object{"status": retry["status"], "reason": retry["reason"], "attempts": retry["attempts"], "nextAttempt": retry["nextAttempt"],
					"notBefore": retry["notBefore"], "successorTurnId": retry["successorTurnId"]}
			}
		}
	}
	source := text(r.source.origin, "sourceId")
	if source == "" {
		return
	}
	reads := map[[2]string]bool{}
	if notificationTaskReadOperation(r.name) {
		rows := []any{value}
		if turns := arr(value["turns"]); r.name == "codex_read" && turns != nil {
			rows = turns
		}
		if items := arr(value["items"]); r.name == "codex_items" && value["turnId"] == nil && r.args["turnId"] == nil {
			rows = items
		}
		for _, item := range rows {
			id := str(dispatchFirstString(field(item, "turnId"), r.args["turnId"]))
			if id == "" || task == "" {
				continue
			}
			wakeNotificationBinding(task, id)
			if value["state"] != "unconfirmed" {
				reads[[2]string{task, id}] = true
			}
			var observed = clone(obj(item))
			if r.name == "agent_read" && observed != nil {
				observed["recordedStatus"] = dispatchFirstString(observed["recordedStatus"], observed["status"])
				observed["finalResponse"] = value["output"]
			}
			if b, err := readNotificationBinding(task, id); err == nil && b != nil && b["sourceId"] == source && observed != nil {
				if observeNotificationTurn != nil && strings.HasPrefix(r.name, "codex_") &&
					(observed["recordedStatus"] == nil || observed["state"] == nil || observed["reason"] == "inconsistent-native-state" || observed["recordedStatus"] == "interrupted") {
					limited, cancel := context.WithTimeout(ctx, 10*time.Second)
					fresh, err := observeNotificationTurn(limited, r.service, b)
					cancel()
					if err == nil {
						observed = fresh
					} else {
						observed = nil
					}
				}
				if observed != nil {
					if observed["title"] == nil {
						observed["title"] = value["title"]
					}
					if err := handleNotificationObservation(ctx, r.service, task, id, observed); err != nil {
						recordLog("WARN", "Inbox read tracking failed: "+err.Error(), nil)
					}
				}
			}
		}
	}
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	if err := acknowledgeNotificationReads(source, reads); err != nil {
		recordLog("WARN", "Inbox read tracking failed: "+err.Error(), nil)
	}
	if r.name == "guide" && (text(value["profile"], "name") == "local-code" ||
		r.args["op"] == nil && r.args["view"] != "full" && (r.args["topic"] == nil || r.args["topic"] == "loop")) {
		return
	}
	if value["view"] == "digest" || r.args["view"] == "digest" || r.args["view"] == "summary" || r.name == "inbox_wait" ||
		r.name == "dispatch_policy" && r.args["view"] != "full" || r.name == "codex_read" && r.args["view"] == "review" {
		return
	}
	target, _ := notificationSessionID(text(r.args["notify"], "target"))
	inbox, err := notificationInboxSelect(r.source.origin, target, nil)
	if err != nil {
		recordLog("WARN", "Inbox unavailable: "+err.Error(), nil)
	}
	if inbox != nil {
		value["arcInbox"] = object{"unread": inbox["unread"], "next": inbox["next"]}
	}
}

func init() {
	notificationSessionSend = deliverNotificationSession
	sendAccountNotification = deliverAccountNotification
	decorateControlResult = append(decorateControlResult, projectNotificationControlResult)
}

func notificationRetryStatus(thread, turn string) (object, error) {
	b, err := readNotificationBinding(thread, turn)
	if err != nil || b == nil {
		return nil, err
	}
	r := obj(b["retry"])
	if r["status"] == nil && uintOr(r["attempts"], 0) == 0 {
		return nil, nil
	}
	return object{"status": r["status"], "attempts": r["attempts"], "nextAttempt": r["nextAttempt"],
		"notBefore": r["notBefore"], "reason": r["reason"], "successorTurnId": r["successorTurnId"]}, nil
}

func notificationRetryPending(thread, turn string) (bool, error) {
	r, err := notificationRetryStatus(thread, turn)
	return r["status"] == "scheduled" || r["status"] == "submitting", err
}

func recoverableNotificationResponse(ctx context.Context, key, backendSession string) (bool, error) {
	source := text(currentOrigin(ctx), "sourceId")
	if source == "" {
		return false, nil
	}
	rows, err := selectNotificationBindings(func(b object) bool { return b["sourceId"] == source })
	if err != nil {
		return false, err
	}
	for _, b := range rows {
		for _, d := range arr(b["deliveries"]) {
			interaction := obj(field(d, "interaction"))
			if interaction["owner"] == "desktop" && interaction["id"] == key && interaction["backendSession"] == backendSession {
				return true, nil
			}
		}
	}
	return false, nil
}

func verifiedNotificationConversationTargets(sources []string) ([]string, error) {
	state, err := readNotificationState()
	if err != nil {
		return nil, err
	}
	now := notificationClock().Unix()
	targets := []string{}
	for _, row := range arr(state["targets"]) {
		t := obj(row)
		r := notificationReachability(t)
		expireNotificationReachability(r, now)
		if t["channel"] == "claude-session" && r["state"] == "verified" && slices.Contains(sources, text(t, "sourceId")) {
			targets = append(targets, text(t, "target"))
		}
	}
	return targets, nil
}

func notificationConversationTargetForSend(source, task string) (any, error) {
	rows, err := selectNotificationBindings(func(b object) bool {
		return b["sourceId"] == source && b["threadId"] == task && b["scopeEnd"] == nil && b["continuationBound"] != true &&
			notificationAgent(b) == "codex" && b["channel"] != "mcp-events"
	})
	if err != nil {
		return nil, err
	}
	var recent object
	for _, b := range rows {
		if recent == nil || uintOr(b["createdAt"], 0) >= uintOr(recent["createdAt"], 0) {
			recent = b
		}
	}
	return recent["target"], nil
}

func notificationCoordinationAttention() (object, error) {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	state, err := readNotificationState()
	if err != nil {
		return nil, err
	}
	bindings, err := notificationBindings()
	if err != nil {
		return nil, err
	}
	rows := arr(state["targets"])
	now := notificationClock().Unix()
	for _, row := range rows {
		expireNotificationReachability(notificationReachability(obj(row)), now)
	}
	problems := []any{}
	for _, row := range rows {
		t := obj(row)
		r := notificationReachability(t)
		if r["state"] != "failed" || supersedingNotificationTarget(t, rows) != nil {
			continue
		}
		threads := map[string]bool{}
		for _, b := range bindings {
			if b["sourceId"] == t["sourceId"] && (b["channel"] == t["channel"] && b["target"] == t["target"] ||
				slices.ContainsFunc(arr(b["deliveries"]), func(d any) bool {
					return field(d, "channel") == t["channel"] && field(d, "target") == t["target"]
				})) {
				threads[text(b, "threadId")] = true
			}
		}
		args := object{"target": t["target"], "all": false}
		if len(threads) == 1 {
			for id := range threads {
				args["threadId"] = id
			}
		}
		problems = append(problems, object{"id": hash([]byte(wire([]any{t["sourceId"], t["channel"], t["target"]}))),
			"sourceId": t["sourceId"], "channel": t["channel"], "target": t["target"], "threadId": args["threadId"],
			"threadCount": len(threads), "reason": r["reason"], "next": object{"via": "query", "op": "notify_status", "args": args}})
	}
	coverage := "observed"
	if len(problems) > 100 {
		coverage = "partial"
	}
	return object{"problems": problems[:min(len(problems), 100)], "coverage": coverage}, nil
}

func recordNotificationResume(ctx context.Context, s *service, thread, previous, next string, configuration, observation object) error {
	if b, err := readNotificationBinding(thread, previous); err != nil {
		return err
	} else if b == nil {
		return errors.New("RESUME_BINDING_MISSING")
	}
	observed := clone(observation)
	if observed == nil {
		observed = object{}
	}
	observed["nextTurnId"] = next
	observed["nativeContinuation"] = object{"retry": object{"turnId": next, "trigger": "resume_interrupted_task",
		"startedAt": notificationClock().Unix(), "configuration": configuration}}
	return handleNotificationObservation(ctx, s, thread, previous, observed)
}

func notificationDiagnostics() object {
	notificationBindingCache.Lock()
	result := notificationBindingCache.values.diagnostics(root())
	notificationBindingCache.Unlock()
	notificationIndexes.Lock()
	defer notificationIndexes.Unlock()
	result["activityIndex"] = nil
	if index := notificationIndexes.owners[physicalPath(notificationOwnerPath())]; index != nil {
		result["activityIndex"] = index.diagnostics()
	}
	return result
}

func (index *notificationIndex) diagnostics() object {
	retention, delivery := 0, 0
	scopes := map[[3]string]object{}
	for path, binding := range index.projections {
		scope := [3]string{text(binding, "sourceId"), notificationAgent(binding), text(binding, "threadId")}
		if current := scopes[scope]; current == nil || uintOr(current["createdAt"], 0) < uintOr(binding["createdAt"], 0) {
			scopes[scope] = binding
		}
		if index.pending[path] && index.deliveryAt[path] != 0 {
			delivery++
		}
	}
	for _, binding := range index.projections {
		scope := [3]string{text(binding, "sourceId"), notificationAgent(binding), text(binding, "threadId")}
		if expiredNotificationBinding(binding, notificationClock().Unix(), uintOr(scopes[scope]["createdAt"], 0) > uintOr(binding["createdAt"], 0)) {
			retention++
		}
	}
	watch := index.collection.watch
	coverage := "watched"
	if watch.failed.Load() {
		coverage = "repairing"
	}
	watch.Lock()
	dirty := len(watch.paths)
	watch.Unlock()
	return object{"retained": len(index.projections), "observing": len(index.active), "reconciliationDue": len(index.reconciling),
		"reconciliationExhausted": len(index.exhausted), "dormant": len(index.projections) - len(index.active), "pendingBindings": len(index.pending),
		"deliveryDue": delivery, "retentionDue": retention, "latestScopes": len(scopes), "latestResumable": len(index.latestResumable()),
		"dirtyKeys": dirty, "watchCoverage": coverage, "revision": index.revision}
}

func syncNotificationConversation(source, target string, handshake bool) error {
	if notificationSourceRows == nil || notificationNotifyConversation == nil {
		return nil
	}
	state, err := readNotificationState()
	if err != nil {
		return err
	}
	bound := findNotificationTarget(state, source, "claude-session", target)
	reach := obj(bound["reachability"])
	if reach["state"] != "verified" {
		return nil
	}
	accounts, err := notificationSourceRows()
	if err != nil {
		return err
	}
	account := slices.IndexFunc(accounts, func(row any) bool {
		return field(row, "provider") == "anthropic" && slices.Contains(arr(field(row, "sources")), any(source))
	})
	if account < 0 {
		return nil
	}
	var confirmed string
	if at, ok := uintValue(reach["verifiedAt"]); handshake && ok {
		confirmed = time.UnixMilli(int64(at)).UTC().Format("2006-01-02T15:04:05.000Z")
	}
	bindings, err := selectNotificationBindings(func(b object) bool {
		return b["sourceId"] == source && b["channel"] != "mcp-events" && b["target"] == target && b["scopeEnd"] == nil && b["continuationBound"] != true
	})
	if err != nil {
		return err
	}
	tasks := make([][2]string, 0, len(bindings))
	for _, b := range bindings {
		tasks = append(tasks, [2]string{notificationAgent(b), text(b, "threadId")})
	}
	return notificationNotifyConversation(text(accounts[account], "id"), target, confirmed, tasks)
}
