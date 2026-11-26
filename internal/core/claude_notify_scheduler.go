package core

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
)

// The source owner determines revocation and native registration. Delivery
// never treats an unavailable authority lookup as a positive authorization.
var notificationSourceAuthority func(context.Context, string) (object, error)
var notificationEscalate func(context.Context, *service, string) error

var notificationTransportMu sync.Mutex

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
			switch {
			case routing == "deferred":
				at = routingAt
			case routing == "paused" || routing == "not-routable" || reason == "disabled" || reason == "breaker":
			case reason == "muted":
				at = int64(uintOr(rule["until"], 0))
			case reason == "digest-wait":
				at = int64(min(uintOr(rule["digestAt"], 0)+3600, uintOr(rule["until"], 1<<63-1)))
			case reason == "subscription-muted":
				at = int64(uintOr(field(find(state["subscriptions"], "id", text(d, "subscription")), "until"), 0))
			case reason == "token-wait":
				if target := findNotificationTarget(state, source, text(d, "channel"), text(d, "target")); target != nil {
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

func notifyQueue(d object, reason string) {
	dispatchSetSection(d, "timing")["queueReason"] = reason
}

type notificationDeliveryItem struct{ binding, delivery object }

type notificationDeliveryBatch struct {
	id, source, channel, target string
	items                       []notificationDeliveryItem
}

type notificationDeliveryOutcome struct {
	status, reason string
	retry, remove  bool
}

func prepareNotificationDeliveries(ctx context.Context, settings object, now int64) ([]notificationDeliveryBatch, []string, error) {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	state, err := readNotificationState()
	if err != nil {
		return nil, nil, err
	}
	rows, err := pendingNotificationBindings()
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
			if notificationKind(d) == "interrupted" && b["scopeEnd"] != nil {
				d["status"] = "resolved"
				notifyQueue(d, "superseded")
				continue
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
	var alerts []string
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
		batchAt := min(last+2, first+10)
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
		if starved {
			if t["emptySince"] == nil {
				t["emptySince"] = now
			}
			escalateAfter := min(max(uintOr(settings["notificationEscalationSeconds"], 900), 1), 86400)
			if t["escalated"] != true && uintOr(t["emptySince"], 0)+escalateAfter <= uint64(now) && notificationEscalate != nil {
				t["escalated"] = true
				alerts = append(alerts, fmt.Sprintf("ARC notification target %s. Reason: token-wait. Pending deliveries: %d. Read ARC notify_status.", target, len(eligible)))
			}
		} else {
			t["emptySince"], t["escalated"], t["escalationError"] = nil, false, nil
		}
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

func notificationWebhookOutcome(ctx context.Context, s *service, batch notificationDeliveryBatch, sub object, item notificationDeliveryItem) notificationDeliveryOutcome {
	if sub == nil {
		return notificationDeliveryOutcome{status: "failed", reason: "subscription-ended"}
	}
	if notificationEventAuthorize == nil {
		return notificationDeliveryOutcome{status: "failed", reason: PortPending, retry: true}
	}
	principal := text(sub["webhook"], "principal")
	source := requestSource{origin: object{"sourceId": batch.source, "eventPrincipal": principal}}
	current, authorized := notificationEventAuthorize(ctx, s, source, principal)
	event := notificationEvent(item.binding, item.delivery)
	data := notificationEventPayload(text(sub, "op"), event)
	if !authorized || !policyAllows(current.policy, text(data["query"], "op")) {
		return notificationDeliveryOutcome{status: "failed", reason: "access_revoked", remove: !authorized}
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

func settleNotificationBatch(batch notificationDeliveryBatch, outcome notificationDeliveryOutcome, start time.Time, cancelReason string) error {
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
		b, err := readNotificationBinding(text(item.binding, "threadId"), text(item.binding, "turnId"))
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
					d["status"], d["nextAttemptAt"] = "pending", now.Unix()+int64(min(10<<min(failures-1, 5), 300))
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
			b, err := readNotificationBinding(text(item.binding, "threadId"), text(item.binding, "turnId"))
			if err != nil {
				return err
			}
			d := obj(item.delivery)
			sub = find(state["subscriptions"], "id", text(d, "subscription"))
			mode := notificationThreadMode(notificationThread(state, batch.source, text(b, "threadId"), start.Unix(), false), start.Unix())
			if b == nil || !notificationAdmits(b, d) || sub == nil || !notificationSubscriptionActive(sub, start.UnixMilli()) || notificationSubscriptionMuted(sub, start.Unix()) ||
				mode == "mute" || mode == "digest" && d["digest"] != true || batch.channel != "mcp-events" && (b["target"] != batch.target || b["channel"] != batch.channel) {
				reason = "control-changed"
				return nil
			}
		}
		for _, item := range batch.items {
			b, err := readNotificationBinding(text(item.binding, "threadId"), text(item.binding, "turnId"))
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
		return settleNotificationBatch(batch, notificationDeliveryOutcome{status: "cancelled"}, start, reason)
	}
	outcome := notificationDeliveryOutcome{status: "failed", reason: "access_revoked"}
	if notificationSourceActive(ctx, batch.source) {
		if batch.channel == "mcp-events" {
			outcome = notificationWebhookOutcome(ctx, s, batch, sub, batch.items[0])
		} else if notificationSessionSend == nil {
			outcome = notificationDeliveryOutcome{status: "failed", reason: PortPending, retry: true}
		} else if err := notificationSessionSend(ctx, batch.channel, profile, batch.target, notificationBatchMessage(batch.items)); err != nil {
			outcome = notificationDeliveryOutcome{status: "failed", reason: "delivery-failed-or-unconfirmed", retry: true}
		} else {
			outcome = notificationDeliveryOutcome{status: "delivered"}
		}
	}
	return settleNotificationBatch(batch, outcome, start, "")
}

func flushNotifications(ctx context.Context, s *service) error {
	if notificationSourceAuthority == nil {
		return nil
	}
	notificationTransportMu.Lock()
	defer notificationTransportMu.Unlock()
	settings, err := notificationSettings()
	if err != nil {
		return err
	}
	batches, alerts, err := prepareNotificationDeliveries(ctx, settings, notificationClock().Unix())
	if err != nil {
		return err
	}
	for _, alert := range alerts {
		if err := notificationEscalate(ctx, s, alert); err != nil {
			recordLog("WARN", "Notification escalation failed: "+err.Error(), nil)
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

func runNotificationScheduler(ctx context.Context, s *service) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		notificationEventOperation.Lock()
		changed := notificationChanged
		notificationEventOperation.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-changed:
		case <-tick.C:
		}
		if err := flushNotifications(ctx, s); err != nil && !errors.Is(err, context.Canceled) {
			recordLog("WARN", "Notification delivery: "+err.Error(), nil)
		}
	}
}
