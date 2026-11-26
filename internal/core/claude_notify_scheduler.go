package core

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// The source owner determines revocation and native registration. Delivery
// never treats an unavailable authority lookup as a positive authorization.
var notificationSourceAuthority func(context.Context, string) (object, error)

var notificationTransportMu sync.Mutex
var notificationSchedulerWake = make(chan struct{}, 1)

func wakeNotificationScheduler() {
	select {
	case notificationSchedulerWake <- struct{}{}:
	default:
	}
}

func notificationSourceActive(ctx context.Context, source string) bool {
	if source == "" || notificationSourceAuthority == nil {
		return false
	}
	authority, err := notificationSourceAuthority(ctx, source)
	return err == nil && authority != nil && authority["state"] != "revoked" && authority["connectionRemoved"] != true
}

func notificationNextDelivery(state object, bindings []object, settings object, now, routingAt int64, active func(string) bool) int64 {
	next := int64(0)
	for _, b := range bindings {
		source := text(b, "sourceId")
		if !active(source) {
			continue
		}
		for _, item := range arr(b["deliveries"]) {
			d := obj(item)
			if (d["status"] != "pending" && d["status"] != "sending") || text(d, "target") == "" || !notificationAdmits(b, d) {
				continue
			}
			at := int64(0)
			routing := text(field(d["interaction"], "routing"), "state")
			reason := text(d["timing"], "queueReason")
			rule := notificationThread(state, source, text(b, "threadId"), now, false)
			sub := find(state["subscriptions"], "id", text(d, "subscription"))
			target := findNotificationTarget(state, source, text(d, "channel"), text(d, "target"))
			switch {
			case routing == "deferred":
				at = routingAt
			case routing == "paused" || routing == "not-routable" || settings["notificationsEnabled"] == false || target["breaker"] == true:
			case reason == "muted" && notificationThreadMode(rule, now) == "mute":
				at = int64(uintOr(rule["until"], 0))
			case reason == "digest-wait" && notificationThreadMode(rule, now) == "digest":
				at = int64(min(uintOr(rule["digestAt"], 0)+3600, uintOr(rule["until"], 1<<63-1)))
			case reason == "subscription-muted" && sub != nil && notificationSubscriptionMuted(sub, now):
				at = int64(uintOr(sub["until"], 0))
			case reason == "token-wait":
				if target != nil {
					at = now + 1
					if uintOr(target["tokens"], 0) == 0 {
						at = int64(uintOr(target["refilledAt"], 0) + notificationRefillSeconds(settings))
					}
				}
			default:
				at = max(now+1, int64(uintOr(d["nextAttemptAt"], 0)))
			}
			if at != 0 && (next == 0 || max(at, now+1) < next) {
				next = max(at, now+1)
			}
		}
	}
	return next
}

func notificationDeliveryBackoff(failures uint64) int64 {
	return int64(min(10<<min(max(failures, 1)-1, 5), 300))
}

func notifyQueue(d object, reason string) {
	dispatchSetSection(d, "timing")["queueReason"] = reason
}

type notificationDeliveryItem struct{ binding, delivery object }

type notificationDeliveryBatch struct {
	id, source, channel, target string
	items                       []notificationDeliveryItem
}

type notificationDeliveryAlert struct {
	source, channel, target, body string
}

type notificationDeliveryOutcome struct {
	status, reason string
	retry, remove  bool
}

func prepareNotificationDeliveries(ctx context.Context, settings object, now int64) ([]notificationDeliveryBatch, []notificationDeliveryAlert, error) {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	state, err := readNotificationState()
	if err != nil {
		return nil, nil, err
	}
	rows, err := notificationIndexedBindingsInContext(ctx, "delivery-due", func(b object) bool {
		return find(b["deliveries"], "status", "pending") != nil || find(b["deliveries"], "status", "sending") != nil
	})
	if err != nil {
		return nil, nil, err
	}
	recheck := make(map[string]bool)
	for _, b := range rows {
		source := text(b, "sourceId")
		if _, exists := recheck[source]; !exists {
			recheck[source] = notificationSourceActive(ctx, source)
		}
	}
	syncNotificationSubscriptions(state, rows)
	state["subscriptions"] = slices.DeleteFunc(arr(state["subscriptions"]), func(row any) bool {
		sub := obj(row)
		if w := obj(sub["webhook"]); w != nil && uintOr(w["rotateUntil"], 0) <= uint64(now) {
			w["previousSecret"] = nil
		}
		return !notificationSubscriptionActive(sub, now*1000)
	})
	current := make(map[[3]string][]notificationDeliveryItem)
	keys := [][3]string{}
	for _, b := range rows {
		source := text(b, "sourceId")
		if !recheck[source] {
			continue
		}
		rule := notificationThread(state, source, text(b, "threadId"), now, false)
		applyNotificationRebind(b, rule)
		routeNotificationSubscriptions(state, b, now)
		for _, item := range arr(b["deliveries"]) {
			d := obj(item)
			if d["status"] == "sending" {
				d["status"] = "pending"
			}
			if d["status"] != "pending" {
				continue
			}
			if b["peerController"] != nil || !notificationWakes(d) {
				d["status"] = "inbox-only"
				continue
			}
			if notificationKind(d) == "interrupted" {
				superseded, err := resolveInterruptedNotification(b, d)
				if err != nil {
					return nil, nil, err
				}
				if superseded {
					continue
				}
			}
			if interaction := obj(d["interaction"]); interaction != nil {
				if err := observeNotificationRouting(notificationAgent(b), text(b, "threadId"), interaction); err != nil {
					return nil, nil, err
				}
				if slices.Contains([]string{"deferred", "paused", "not-routable"}, text(interaction["routing"], "state")) {
					continue
				}
			}
			channel, target := text(d, "channel"), text(d, "target")
			t := findNotificationTarget(state, source, channel, target)
			sub := find(state["subscriptions"], "id", text(d, "subscription"))
			reason := ""
			mode := notificationThreadMode(rule, now)
			switch {
			case !notificationAdmits(b, d):
				reason = "native-outcome-unconfirmed"
				if field(b["observation"], "conflict") != nil {
					reason = "terminal-conflict"
				}
			case settings["notificationsEnabled"] == false:
				reason = "disabled"
			case target == "":
				reason = "unbound"
			case sub != nil && notificationSubscriptionMuted(sub, now):
				reason = "subscription-muted"
			case text(d, "subscription") != "" && sub == nil:
				d["status"], d["error"], reason = "failed", "subscription-ended", "subscription-ended"
			case t["breaker"] == true:
				reason = "breaker"
			case mode == "mute":
				reason = "muted"
			case mode == "digest" && d["digest"] != true && uintOr(rule["digestAt"], 0)+3600 > uint64(now):
				reason = "digest-wait"
			case int64(uintOr(d["nextAttemptAt"], 0)) > now:
				reason = "retry-backoff"
				if text(d["timing"], "queueReason") == "batch-window" {
					reason = "batch-window"
				}
			}
			if reason != "" {
				notifyQueue(d, reason)
				continue
			}
			key := [3]string{source, channel, target}
			if len(current[key]) == 0 {
				keys = append(keys, key)
			}
			current[key] = append(current[key], notificationDeliveryItem{b, d})
		}
	}
	var batches []notificationDeliveryBatch
	var alerts []notificationDeliveryAlert
	waiting := map[[3]string]bool{}
	for _, key := range keys {
		source, channel, target := key[0], key[1], key[2]
		t := notificationTarget(state, settings, source, channel, target, now)
		eligible := current[key]
		last, first := int64(0), int64(1<<63-1)
		launch := channel == "mcp-events"
		for _, item := range eligible {
			d := item.delivery
			at := int64(uintOr(d["createdAt"], 0))
			last, first = max(last, at), min(first, at)
			rule := notificationThread(state, source, text(item.binding, "threadId"), now, false)
			launch = launch || d["tokenCharged"] == true || d["taskState"] == "interaction-required" ||
				text(d["timing"], "queueReason") == "token-wait" || notificationThreadMode(rule, now) == "digest"
		}
		batchAt := min(last+2, first+30)
		launch = launch || now >= batchAt
		tokens := uintOr(t["tokens"], 0)
		starved := false
		batch := notificationDeliveryBatch{id: id(), source: source, channel: channel, target: target}
		for _, item := range eligible {
			d := item.delivery
			switch {
			case !launch:
				d["nextAttemptAt"] = batchAt
				notifyQueue(d, "batch-window")
			case tokens == 0 && d["tokenCharged"] != true:
				starved = true
				notifyQueue(d, "token-wait")
			case channel == "mcp-events" && len(batch.items) > 0:
			default:
				batch.items = append(batch.items, item)
			}
		}
		waiting[key] = starved
		if len(batch.items) == 0 {
			continue
		}
		charged := slices.ContainsFunc(batch.items, func(i notificationDeliveryItem) bool { return i.delivery["tokenCharged"] != true })
		if charged {
			notificationCharge(t, settings, now)
		}
		kinds, threadSet := map[string]int{}, map[string]bool{}
		var threads []string
		for _, item := range batch.items {
			b, d := item.binding, item.delivery
			thread := text(b, "threadId")
			kinds[notificationKind(d)]++
			if !threadSet[thread] {
				threadSet[thread] = true
				threads = append(threads, thread)
			}
			rule := notificationThread(state, source, thread, now, false)
			d["digest"] = notificationThreadMode(rule, now) == "digest"
			if prior := text(d, "batch"); prior != "" {
				attempts := slices.DeleteFunc(arr(d["attempts"]), func(r any) bool {
					row := arr(r)
					return len(row) < 2 || uintOr(row[1], 0)+3600 <= uint64(now)
				})
				d["attempts"] = append(attempts, []any{prior, d["attemptedAt"]})
			}
			d["status"], d["nextAttemptAt"], d["error"], d["tokenCharged"], d["batch"], d["attemptedAt"] = "sending", 0, nil, true, batch.id, now
		}
		slices.Sort(threads)
		t["batches"] = append(arr(t["batches"]), object{"id": batch.id, "at": now, "kinds": kinds, "threads": threads, "status": "sending", "charged": charged})
		batches = append(batches, batch)
	}
	for _, raw := range arr(state["targets"]) {
		t := obj(raw)
		source, channel, target := text(t, "sourceId"), text(t, "channel"), text(t, "target")
		active, known := recheck[source]
		if !known {
			active = notificationSourceActive(ctx, source)
			recheck[source] = active
		}
		if !active {
			continue
		}
		notificationRefill(t, settings, now)
		expireNotificationReachability(notificationReachability(t), now)
		if settings["notificationsEnabled"] == false {
			continue
		}
		if _, scanned := waiting[[3]string{source, channel, target}]; !scanned && t["emptySince"] != nil && uintOr(t["tokens"], 0) == 0 {
			waiting[[3]string{source, channel, target}] = hasNotificationPendingTarget(source, channel, target)
		}
		reason := notificationTargetAnomaly(t, settings, now, waiting[[3]string{source, channel, target}])
		if reason != "" {
			threads := map[string]bool{}
			count := 0
			for _, b := range rows {
				if b["sourceId"] != source {
					continue
				}
				if b["channel"] == channel && b["target"] == target {
					threads[text(b, "threadId")] = true
				}
				for _, d := range arr(b["deliveries"]) {
					if field(d, "channel") == channel && field(d, "target") == target && field(d, "status") == "pending" {
						count++
					}
				}
			}
			names := make([]string, 0, len(threads))
			for thread := range threads {
				names = append(names, thread)
			}
			slices.Sort(names)
			alerts = append(alerts, notificationDeliveryAlert{source, channel, target,
				fmt.Sprintf("ARC notification target %s. Reason: %s. Pending deliveries: %d. Threads: %s. Read ARC notify_status.", target, reason, count, strings.Join(names, ", "))})
		}
	}
	if err := saveNotificationState(state); err != nil {
		return nil, nil, err
	}
	for _, b := range rows {
		if err := persistNotificationBinding(b); err != nil {
			return nil, nil, err
		}
	}
	return batches, alerts, nil
}

func notificationBatchMessage(items []notificationDeliveryItem) string {
	labels := make([]string, 0, len(items))
	for _, r := range items {
		labels = append(labels, notificationGlyph(r.delivery))
	}
	body := notificationDoorbell(labels)
	seen := map[string]bool{}
	for _, r := range items {
		thread := text(r.binding, "threadId")
		if seen[thread] {
			continue
		}
		seen[thread] = true
		event := notificationEvent(r.binding, r.delivery)
		title := strings.Join(strings.Fields(text(event, "title")), " ")
		task := str(dispatchFirstString(field(r.binding["device"], "taskId"), thread))
		body += "\n" + title + " · " + task
	}
	return body
}

func notificationWebhookOutcome(ctx context.Context, s *service, sub object, item notificationDeliveryItem) notificationDeliveryOutcome {
	if sub == nil {
		return notificationDeliveryOutcome{status: "failed", reason: "subscription-ended"}
	}
	webhook := obj(sub["webhook"])
	if webhook == nil {
		return notificationDeliveryOutcome{status: "failed", reason: "missing_webhook"}
	}
	principal := text(webhook, "principal")
	source := requestSource{origin: object{"sourceId": text(sub, "sourceId"), "eventPrincipal": principal}}
	current, access := notificationEventAuthorize(ctx, s, source, principal)
	if access == notificationEventSourceUnavailable {
		return notificationDeliveryOutcome{status: "failed", reason: "access_revoked"}
	}
	if access == notificationEventPrincipalRevoked || !notificationSubscriptionActive(sub, notificationClock().UnixMilli()) {
		return notificationDeliveryOutcome{status: "failed", reason: "access_revoked", remove: true}
	}
	if access == notificationEventDisconnected {
		return notificationDeliveryOutcome{status: "failed", reason: "ingress_disconnected", retry: true}
	}
	event := notificationEvent(item.binding, item.delivery)
	data := notificationEventPayload(text(sub, "op"), event)
	if !policyAllows(current.policy, text(data["query"], "op")) {
		return notificationDeliveryOutcome{status: "failed", reason: "access_revoked"}
	}
	d := item.delivery
	at := time.Unix(int64(uintOr(d["createdAt"], 0)), 0)
	body := object{"eventId": d["eventId"], "name": notificationEventName, "timestamp": notificationISO(at), "data": data, "cursor": nil}
	status, _, err := postNotificationWebhook(ctx, sub, text(d, "eventId"), []byte(wire(body)))
	switch {
	case err != nil:
		reason := err.Error()
		retry := slices.Contains([]string{"timeout", "connection_failed", "dns_failed", "response_failed"}, reason)
		return notificationDeliveryOutcome{status: "failed", reason: reason, retry: retry}
	case status >= 200 && status < 300:
		return notificationDeliveryOutcome{status: "callback-accepted"}
	default:
		return notificationDeliveryOutcome{status: "failed", reason: fmt.Sprintf("http_%d", status), remove: status == 410, retry: status != 413 && (status == 408 || status == 429 || status >= 500)}
	}
}

func settleNotificationBatch(ctx context.Context, batch notificationDeliveryBatch, outcome notificationDeliveryOutcome, start time.Time, cancelReason string) error {
	now := notificationClock()
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	state, err := readNotificationState()
	if err != nil {
		return err
	}
	t := findNotificationTarget(state, batch.source, batch.channel, batch.target)
	if record := find(t["batches"], "id", batch.id); record != nil {
		record["status"] = outcome.status
	}
	if outcome.remove && len(batch.items) > 0 {
		removeNotificationSubscription(state, text(batch.items[0].delivery, "subscription"))
	}
	for _, item := range batch.items {
		b, err := loadNotificationBindingInContext(ctx, notificationBindingPath(text(item.binding, "threadId"), text(item.binding, "turnId")))
		if err != nil {
			return err
		}
		for _, value := range arr(b["deliveries"]) {
			d := obj(value)
			if d["batch"] != batch.id || d["status"] != "sending" || d["eventId"] != item.delivery["eventId"] || d["subscription"] != item.delivery["subscription"] {
				continue
			}
			timing := dispatchSetSection(d, "timing")
			rule := notificationThread(state, batch.source, text(b, "threadId"), now.Unix(), true)
			switch {
			case cancelReason != "":
				d["status"] = "pending"
				notifyQueue(d, cancelReason)
			case outcome.status == "failed":
				failures := uintOr(d["failures"], 0) + 1
				d["failures"], d["status"], d["error"], d["nextAttemptAt"] = failures, "failed", outcome.reason, 0
				if outcome.retry && failures < 6 {
					d["status"], d["nextAttemptAt"] = "pending", now.Unix()+notificationDeliveryBackoff(failures)
					notifyQueue(d, "retry-backoff")
				}
				timing["finishedAt"], timing["sendMs"] = now.UnixMilli(), max(now.Sub(start).Milliseconds(), 0)
			default:
				d["status"], d["nextAttemptAt"] = outcome.status, 0
				if d["digest"] == true && outcome.status == "delivered" {
					d["status"], rule["digestAt"] = "digested", now.Unix()
				}
				rule["lastDeliveredAt"] = now.Unix()
				timing["finishedAt"], timing["sendMs"] = now.UnixMilli(), max(now.Sub(start).Milliseconds(), 0)
			}
			applyNotificationRebind(b, rule)
			if err := persistNotificationBinding(b); err != nil {
				return err
			}
		}
	}
	return saveNotificationState(state)
}

func sendNotificationBatch(ctx context.Context, s *service, batch notificationDeliveryBatch) error {
	start := notificationClock()
	var sub object
	var profile, reason string
	err := func() error {
		notificationEventOperation.Lock()
		defer notificationEventOperation.Unlock()
		state, err := readNotificationState()
		if err != nil {
			return err
		}
		settings, err := notificationSettings()
		if err != nil {
			return err
		}
		t := findNotificationTarget(state, batch.source, batch.channel, batch.target)
		profile = text(t, "accountId")
		if t["breaker"] == true {
			reason = "breaker"
			return nil
		}
		if settings["notificationsEnabled"] == false {
			reason = "disabled"
			return nil
		}
		for _, item := range batch.items {
			b, err := loadNotificationBindingInContext(ctx, notificationBindingPath(text(item.binding, "threadId"), text(item.binding, "turnId")))
			if err != nil {
				return err
			}
			var d object
			for _, raw := range arr(b["deliveries"]) {
				row := obj(raw)
				if row["batch"] == batch.id && row["status"] == "sending" && row["eventId"] == item.delivery["eventId"] && row["subscription"] == item.delivery["subscription"] {
					d = row
					break
				}
			}
			sub = find(state["subscriptions"], "id", text(d, "subscription"))
			if d != nil && notificationKind(d) == "interrupted" {
				superseded, err := resolveInterruptedNotification(b, d)
				if err != nil {
					return err
				}
				if superseded {
					reason = "superseded"
					if err := persistNotificationBinding(b); err != nil {
						return err
					}
					return nil
				}
			}
			mode := notificationThreadMode(notificationThread(state, batch.source, text(b, "threadId"), start.Unix(), false), start.Unix())
			if b == nil || d == nil || !notificationAdmits(b, d) || sub == nil || !notificationSubscriptionActive(sub, start.UnixMilli()) || notificationSubscriptionMuted(sub, start.Unix()) ||
				mode == "mute" || mode == "digest" && d["digest"] != true || batch.channel != "mcp-events" && (b["target"] != batch.target || b["channel"] != batch.channel) {
				reason = "control-changed"
				if field(b["observation"], "conflict") != nil {
					reason = "terminal-conflict"
				}
				return nil
			}
		}
		for _, item := range batch.items {
			b, err := loadNotificationBindingInContext(ctx, notificationBindingPath(text(item.binding, "threadId"), text(item.binding, "turnId")))
			if err != nil {
				return err
			}
			for _, raw := range arr(b["deliveries"]) {
				d := obj(raw)
				if d["batch"] != batch.id || d["status"] != "sending" || d["eventId"] != item.delivery["eventId"] {
					continue
				}
				timing := dispatchSetSection(d, "timing")
				queued := uintOr(timing["queuedAt"], uintOr(d["createdAt"], 0)*1000)
				timing["queuedAt"], timing["startedAt"], timing["finishedAt"], timing["sendMs"], timing["queueMs"] = queued, start.UnixMilli(), nil, nil, max(start.UnixMilli()-int64(queued), 0)
			}
			if err := persistNotificationBinding(b); err != nil {
				return err
			}
		}
		return nil
	}()
	if err != nil {
		return err
	}
	if reason != "" {
		return settleNotificationBatch(ctx, batch, notificationDeliveryOutcome{status: "cancelled"}, start, reason)
	}
	outcome := notificationDeliveryOutcome{status: "failed", reason: "access_revoked"}
	if notificationSourceActive(ctx, batch.source) {
		if batch.channel == "mcp-events" {
			outcome = notificationWebhookOutcome(ctx, s, sub, batch.items[0])
		} else if err := notificationSessionSend(ctx, batch.channel, profile, batch.target, notificationBatchMessage(batch.items)); err != nil {
			outcome = notificationDeliveryOutcome{status: "failed", reason: "delivery-failed-or-unconfirmed", retry: true}
		} else {
			outcome = notificationDeliveryOutcome{status: "delivered"}
		}
	}
	return settleNotificationBatch(ctx, batch, outcome, start, "")
}

func flushNotifications(ctx context.Context, s *service) error {
	if notificationSourceAuthority == nil {
		return nil
	}
	notificationTransportMu.Lock()
	defer notificationTransportMu.Unlock()
	ctx = withRuntimeCost(ctx, "notificationDelivery", "poll")
	defer beginRuntimeWork("notificationDelivery")()
	settings, err := notificationSettings()
	if err != nil {
		return err
	}
	batches, alerts, err := prepareNotificationDeliveries(ctx, settings, notificationClock().Unix())
	if err != nil {
		return err
	}
	for _, alert := range alerts {
		if _, err := s.managementRequest(ctx, "permissions/notify", http.MethodPost,
			object{"title": "ARC 通知需要处理", "body": alert.body}); err != nil {
			recordLog("WARN", "Notification escalation failed: "+err.Error(), nil)
			notificationEventOperation.Lock()
			state, readErr := readNotificationState()
			if readErr == nil {
				if target := findNotificationTarget(state, alert.source, alert.channel, alert.target); target != nil {
					target["escalationError"] = err.Error()
					readErr = saveNotificationState(state)
				}
			}
			notificationEventOperation.Unlock()
			if readErr != nil {
				return readErr
			}
		}
	}
	for _, batch := range batches {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := sendNotificationBatch(ctx, s, batch); err != nil {
			return err
		}
	}
	return nil
}

func deferredNotificationDeadline(b object, routing any, env appEnvironment, real int64) int64 {
	var deadline int64
	due := func(at int64) {
		if deadline == 0 || at < deadline {
			deadline = at
		}
	}
	if at, ok := taskInt(field(routing, "deferUntil")); ok {
		if converted, ok := env.realDeadline(at, real); ok {
			due(converted)
		}
	}
	if env.ExpiresAt != nil {
		due(*env.ExpiresAt)
	}
	if env.Presence == nil {
		if notificationPresent.agent == notificationAgent(b) && notificationPresent.task == b["threadId"] {
			due(notificationPresent.at + 6000)
		} else {
			due(real)
		}
	} else if *env.Presence == "absent" {
		due(real)
	}
	if deadline == 0 {
		return 0
	}
	return saturatingClockAdd(deadline, 999) / 1000
}

func nextNotificationSchedulerWake(ctx context.Context) (int64, error) {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	rows, err := pendingNotificationBindings()
	if err != nil {
		return 0, err
	}
	state, err := readNotificationState()
	if err != nil {
		return 0, err
	}
	settings, err := notificationSettings()
	if err != nil {
		return 0, err
	}
	now := notificationClock().Unix()
	appEnvLock.Lock()
	environment, err := loadAppEnvironment(root(), now*1000)
	appEnvLock.Unlock()
	if err != nil {
		return 0, err
	}
	seen := map[string]bool{}
	valid := map[string]bool{}
	var earliest int64
	for _, b := range rows {
		routingAt := int64(0)
		for _, delivery := range arr(b["deliveries"]) {
			routing := field(field(delivery, "interaction"), "routing")
			if text(routing, "state") == "deferred" {
				at := deferredNotificationDeadline(b, routing, environment, now*1000)
				if at != 0 && (routingAt == 0 || at < routingAt) {
					routingAt = at
				}
			}
		}
		at := notificationNextDelivery(state, []object{b}, settings, now, routingAt, func(source string) bool {
			if !seen[source] {
				valid[source] = notificationSourceActive(ctx, source)
				seen[source] = true
			}
			return valid[source]
		})
		if err := persistNotificationSchedule(ctx, b, at); err != nil {
			return 0, err
		}
		if at != 0 && (earliest == 0 || at < earliest) {
			earliest = at
		}
	}
	if maintenance := notificationMaintenanceDeadline(ctx, state, settings, now); maintenance != 0 && (earliest == 0 || maintenance < earliest) {
		earliest = maintenance
	}
	return earliest, nil
}

func runNotificationScheduler(ctx context.Context, s *service) {
	watch := newFileChanges()
	defer watch.close()
	for _, relative := range []string{"task-settings.json", "app-env.json", "sources.json", "accounts/index.json", "notifications/subscriptions/state.json", "notifications/tasks/.index-watch", "notifications/request-routing/.index-watch"} {
		watch.add(filepath.Join(root(), relative))
	}
	reason := "startup"
	for ctx.Err() == nil {
		_, _ = watch.drain()
		work := withRuntimeCost(ctx, "notificationDelivery", reason)
		var delay time.Duration
		if err := flushNotifications(work, s); err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			recordLog("WARN", "Notification delivery: "+err.Error(), nil)
			delay = time.Second
		} else if next, err := nextNotificationSchedulerWake(ctx); err != nil {
			recordLog("WARN", "Notification deadline: "+err.Error(), nil)
			delay = time.Second
		} else if next != 0 {
			delay = max(time.Until(time.Unix(next, 0)), time.Millisecond)
		}
		var timer *time.Timer
		var deadline <-chan time.Time
		if delay != 0 {
			timer = time.NewTimer(delay)
			deadline = timer.C
		}
		select {
		case <-ctx.Done():
		case <-notificationSchedulerWake:
			reason = "event"
			invalidateNotificationScheduling()
		case <-watch.wake:
			reason = "dirty"
			paths, failed := watch.drain()
			if len(paths) != 0 || failed {
				invalidateNotificationScheduling()
			}
		case <-deadline:
			reason = "deadline"
		}
		if timer != nil {
			timer.Stop()
		}
	}
}

func hasNotificationPendingTarget(source, channel, target string) bool {
	notificationIndexes.Lock()
	defer notificationIndexes.Unlock()
	index := notificationIndexes.owners[physicalPath(notificationOwnerPath())]
	if index == nil {
		return false
	}
	for path := range index.pending {
		row := index.projections[path]
		if row["sourceId"] != source {
			continue
		}
		if slices.ContainsFunc(arr(row["deliveries"]), func(d any) bool {
			status := field(d, "status")
			return field(d, "channel") == channel && field(d, "target") == target && (status == "pending" || status == "sending")
		}) {
			return true
		}
	}
	return false
}

func notificationTargetAnomaly(target, settings object, now int64, waiting bool) string {
	if uintOr(target["tokens"], 0) == 0 && waiting {
		if target["emptySince"] == nil {
			target["emptySince"] = now
		}
	} else {
		target["emptySince"] = nil
	}
	if target["breaker"] != true && target["emptySince"] == nil {
		target["escalated"], target["escalationError"] = false, nil
	}
	if target["escalated"] == true {
		return ""
	}
	reason := ""
	if target["breaker"] == true {
		reason = "breaker"
	} else if empty, ok := uintValue(target["emptySince"]); ok && empty+notificationEscalationSeconds(settings) <= uint64(now) {
		reason = "token-wait"
	}
	if reason != "" {
		target["escalated"] = true
	}
	return reason
}

func notificationEscalationSeconds(settings object) uint64 {
	return min(max(uintOr(settings["notificationEscalationSeconds"], 900), 1), 86400)
}

func notificationMaintenanceDeadline(ctx context.Context, state, settings object, now int64) int64 {
	var deadline int64
	due := func(at uint64) {
		if at == 0 {
			return
		}
		t := max(int64(at), now+1)
		if deadline == 0 || t < deadline {
			deadline = t
		}
	}
	for _, raw := range arr(state["subscriptions"]) {
		sub := obj(raw)
		due((uintOr(sub["expiresAt"], 0) + 999) / 1000)
		if w := obj(sub["webhook"]); w["previousSecret"] != nil {
			due(uintOr(w["rotateUntil"], 0))
		}
	}
	active := map[string]bool{}
	seen := map[string]bool{}
	for _, item := range arr(state["targets"]) {
		t := obj(item)
		source := text(t, "sourceId")
		if !seen[source] {
			active[source] = notificationSourceActive(ctx, source)
			seen[source] = true
		}
		if !active[source] {
			continue
		}
		if empty, ok := uintValue(t["emptySince"]); ok && settings["notificationsEnabled"] != false && t["escalated"] != true {
			due(empty + notificationEscalationSeconds(settings))
		}
		if uintOr(t["tokens"], 0) < notificationCapacity(settings) {
			due(uintOr(t["refilledAt"], 0) + notificationRefillSeconds(settings))
		}
		for _, batch := range arr(t["batches"]) {
			due(uintOr(field(batch, "at"), 0) + 3600)
		}
		if text(t["reachability"], "challengeHash") != "" {
			due(uintOr(field(t["reachability"], "expiresAt"), 0))
		}
	}
	return deadline
}

func resolveInterruptedNotification(b, d object) (bool, error) {
	if field(b["successor"], "inherited") == true {
		related, err := notificationBindingsForThread(text(b, "threadId"))
		if err != nil {
			return false, err
		}
		next := notificationContinuationNotice(b, nil, related)
		if next != nil && (next["state"] != "unknown" || d["continuation"] == nil) {
			d["continuation"] = next
		}
	}
	if b["scopeEnd"] == nil && (d["continuation"] == nil || field(d["continuation"], "state") == "unknown") {
		return false, nil
	}
	d["status"] = "resolved"
	notifyQueue(d, "superseded")
	if err := refreshNotificationInbox(text(b, "sourceId"), b); err != nil {
		return false, err
	}
	return true, nil
}
