package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

// D resolves the original pinned profile for legacy verified targets.
var notificationLegacyVerifiedAccount func(string) (string, error)

func migrateNotificationState(ctx context.Context, _ *service) error {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	settings, err := notificationSettings()
	if err != nil {
		return err
	}
	dir := notificationDirectory()
	owner := notificationOwnerPath()
	if err := platform.PrivateDir(owner); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var legacyBindings []string
	for _, entry := range entries {
		if !entry.IsDir() && filepath.Ext(entry.Name()) == ".json" {
			legacyBindings = append(legacyBindings, filepath.Join(dir, entry.Name()))
		}
	}
	oldControl, oldEvents := filepath.Join(dir, "control", "state.json"), filepath.Join(dir, "mcp-events", "state.json")
	legacyControls, controlErr := load(oldControl)
	legacyEvents, eventErr := load(oldEvents)
	for _, err := range []error{controlErr, eventErr} {
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if len(legacyBindings) == 0 && controlErr != nil && eventErr != nil {
		return nil
	}
	if err := indexInvalidate(ctx, owner); err != nil {
		return err
	}
	for _, path := range legacyBindings {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		b, err := loadNotificationBinding(path)
		if err != nil {
			return err
		}
		if b == nil {
			continue
		}
		thread, turn := text(b, "threadId"), text(b, "turnId")
		destination := notificationBindingPath(thread, turn)
		if _, err := os.Stat(destination); errors.Is(err, os.ErrNotExist) {
			if err := save(destination, b); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
	}
	state, err := readNotificationState()
	if err != nil {
		return err
	}
	if _, err := os.Stat(notificationStatePath()); errors.Is(err, os.ErrNotExist) && controlErr == nil {
		state = obj(legacyControls)
		if state == nil {
			return errors.New("Invalid notification state")
		}
		for _, key := range []string{"targets", "subscriptions", "threads"} {
			state[key] = slices.DeleteFunc(arr(state[key]), func(row any) bool { return text(row, "sourceId") == "" })
			if arr(state[key]) == nil {
				state[key] = []any{}
			}
		}
	}
	entries, err = os.ReadDir(owner)
	if err != nil {
		return err
	}
	var bindings []object
	byTurn := make(map[[2]string]object)
	for _, entry := range entries {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		b, err := loadNotificationBinding(filepath.Join(owner, entry.Name()))
		if err != nil {
			return err
		}
		if b != nil {
			bindings = append(bindings, b)
			byTurn[[2]string{text(b, "threadId"), text(b, "turnId")}] = b
		}
	}
	for _, row := range arr(field(legacyEvents, "deliveries")) {
		thread, turn := text(row, "thread"), text(field(field(row, "body"), "data"), "turnId")
		b := byTurn[[2]string{thread, turn}]
		eventID, sub := text(field(row, "body"), "eventId"), text(row, "subscription")
		deliveries := arr(b["deliveries"])
		if slices.ContainsFunc(deliveries, func(d any) bool { return field(d, "eventId") == eventID && field(d, "subscription") == sub }) {
			continue
		}
		d := clone(find(deliveries, "eventId", eventID))
		if d == nil {
			continue
		}
		timing := obj(field(row, "timing"))
		if timing == nil {
			recordLog("WARN", "Ignored malformed legacy notification delivery", nil)
			continue
		}
		status := text(row, "status")
		if status == "pending" || status == "sending" {
			status = "subscription-ended"
		}
		attempts := uintOr(field(row, "attempts"), 0)
		if status == "callback-accepted" && attempts != 0 {
			attempts--
		}
		d["subscription"], d["channel"], d["target"], d["status"] = sub, "mcp-events", sub, status
		d["error"], d["tokenCharged"], d["failures"], d["nextAttemptAt"], d["timing"] = field(row, "error"), field(row, "charged") == true, attempts, 0, timing
		b["deliveries"] = append(deliveries, d)
	}
	labels := map[string]string{"完成": "completed", "失败": "failed", "中断": "interrupted", "等待输入": "waiting for input", "等待审批": "waiting for approval"}
	now := notificationClock()
	for _, b := range bindings {
		for i, item := range arr(b["waiting"]) {
			if label := labels[str(item)]; label != "" {
				arr(b["waiting"])[i] = label
			}
		}
		source := text(b, "sourceId")
		for _, item := range arr(b["deliveries"]) {
			d := obj(item)
			if label := labels[text(d, "state")]; label != "" {
				d["state"] = label
			}
			if target := text(d, "target"); source != "" && target != "" && uintOr(d["failures"], 0) > 0 {
				r := notificationReachability(notificationTarget(state, settings, source, text(d, "channel"), target, now.Unix()))
				if r["reason"] == "handshake-required" {
					failNotificationReachability(r, "delivery-failed", now.UnixMilli())
				}
			}
		}
	}
	syncNotificationSubscriptions(state, bindings)
	for _, b := range bindings {
		routeNotificationSubscriptions(state, b, now.Unix())
		if name := text(b, "target"); b["channel"] != "mcp-events" && name != "" {
			notificationTarget(state, settings, text(b, "sourceId"), text(b, "channel"), name, now.Unix())
		}
	}
	for _, raw := range arr(state["targets"]) {
		t := obj(raw)
		if t["channel"] != "claude-session" || t["accountId"] != nil {
			continue
		}
		name := text(t, "target")
		if notificationClaudeLegacyRoute != nil {
			profile, err := notificationClaudeLegacyRoute(name)
			if err != nil {
				return err
			}
			if profile != "" {
				t["accountId"] = profile
			}
		}
		if t["accountId"] == nil && field(t["reachability"], "state") == "verified" && notificationLegacyVerifiedAccount != nil {
			if profile, err := notificationLegacyVerifiedAccount(name); err == nil && profile != "" {
				t["accountId"] = profile
			}
		}
	}
	if err := saveNotificationState(state); err != nil {
		return err
	}
	for _, b := range bindings {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := persistNotificationBinding(b); err != nil {
			return err
		}
	}
	for _, path := range append(legacyBindings, oldControl, oldEvents) {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	for _, path := range []string{filepath.Dir(oldControl), filepath.Dir(oldEvents)} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func recoverNotificationDeliveries() error {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	rows, err := notificationIndexedBindings("recovery", func(b object) bool {
		return slices.ContainsFunc(arr(b["deliveries"]), func(item any) bool { return notificationDeliveryNeedsRecovery(obj(item)) })
	})
	if err != nil {
		return err
	}
	for _, b := range rows {
		for _, raw := range arr(b["deliveries"]) {
			d := obj(raw)
			if notificationDeliveryNeedsRecovery(d) {
				failures := uintOr(d["failures"], 0) + 1
				d["failures"], d["status"], d["nextAttemptAt"] = failures, "pending", notificationClock().Unix()+notificationDeliveryBackoff(failures)
				d["tokenCharged"] = uintOr(d["attemptedAt"], 0) > 0
				d["error"] = "restart-delivery-unconfirmed"
				notifyQueue(d, "retry-backoff")
				if failures >= 6 {
					d["status"] = "failed"
				}

			}
		}
		if err := persistNotificationBinding(b); err != nil {
			return err
		}
	}
	notificationSignal()
	return nil
}

func notificationDeliveryNeedsRecovery(d object) bool {
	return uintOr(d["failures"], 0) < 6 &&
		(d["status"] == "sending" || d["status"] == "failed" && (d["error"] == nil ||
			slices.Contains([]string{"delivery-failed-or-unconfirmed", "wake-limit", "disabled"}, text(d, "error"))))
}
