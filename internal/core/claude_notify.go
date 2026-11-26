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
	return settings, save(filepath.Join(root(), "task-settings.json"), settings)
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
	return str(dispatchFirstString(event["threadId"], event["taskId"]))
}

func notificationInboxSelect(source object, target string, filters object) (object, error) {
	sourceID := text(source, "sourceId")
	rows, err := readNotificationInbox(sourceID)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	bindings, err := notificationBindings()
	if err != nil {
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
		for _, bind := range bindings {
			if bind["sourceId"] == sourceID && bind["threadId"] == notificationEventThread(event) && bind["turnId"] == event["turnId"] {
				event["target"], event["channel"] = bind["target"], bind["channel"]
				delivery = find(bind["deliveries"], "eventId", text(event, "eventId"))
				break
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
	title := ""
	for _, key := range []string{"threadTitle", "title", "project"} {
		if title = strings.TrimSpace(text(bind, key)); title != "" {
			break
		}
	}
	event := object{"eventId": d["eventId"], "kind": kind, "project": bind["project"], "threadId": threadID, "taskId": taskID, "agent": agent,
		"turnId": bind["turnId"], "title": title, "channel": d["channel"], "target": target, "causedBy": bind["causedBy"], "summary": notificationGlyph(d),
		"progress": d["progress"], "interaction": d["interaction"], "questionSummary": nil, "routing": field(d["interaction"], "routing"),
		"dispatches": d["dispatches"], "externalUserInputs": d["externalUserInputs"], "finalResponse": d["finalResponse"], "error": failure,
		"reconciliation": d["reconciliation"], "continuation": d["continuation"], "recovery": d["recovery"], "ownership": owner, "next": next}
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
		rows, err := notificationBindings()
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
	return (field(value, "channel") == "claude-session" || field(value, "channel") == "antigravity-session") &&
		text(value, "target") != "" && field(value, "reachability") == "verified"
}

func init() { controlPushAvailable = notificationPushAvailable }
