package core

import (
	"context"
	"errors"
	"slices"
	"time"
)

const notificationRetryPrompt = "ARC automatic recovery: the previous turn ended because model capacity was temporarily unavailable. Continue from the interruption in the same task history. Check existing results, files, commits, and external operations first. Skip completed steps. Do not repeat side effects that succeeded or have uncertain outcomes. Do not redo the original task. If a step's completion is uncertain, report the uncertainty first."

// A submits through the ordinary Codex mutation receipt path.
var submitNotificationRetry func(context.Context, *service, object) (object, error)

func safeNotificationRetry(turn object) bool {
	items, ok := turn["items"].([]any)
	return turn["status"] == "failed" && field(turn["error"], "codexErrorInfo") == "serverOverloaded" && ok &&
		!slices.ContainsFunc(items, func(item any) bool {
			return !slices.Contains([]string{"userMessage", "agentMessage", "reasoning"}, text(item, "type"))
		})
}

func notificationRetryBackoff(settings object, attempt uint64) int64 {
	seconds := min(max(uintOr(settings["codexRetryInitialSeconds"], 30), 1), 3600)
	return int64(min(seconds<<(min(max(attempt, 1)-1, 10)), 3600))
}

func updateNotificationRetry(b, retry object, settled bool) error {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	current, err := readNotificationBinding(text(b, "threadId"), text(b, "turnId"))
	if err != nil {
		return err
	}
	if current == nil {
		return errors.New("RETRY_BINDING_MISSING")
	}
	// A late observation cannot replace another retry's durable receipt.
	previous := field(b["retry"], "requestId")
	if field(current["retry"], "requestId") != previous {
		return errors.New("RETRY_BINDING_CHANGED")
	}
	current["retry"] = retry
	if settled {
		current["continuationBound"], current["waiting"] = true, []any{}
	}
	if err := persistNotificationBinding(current); err != nil {
		return err
	}
	b["retry"] = retry
	notificationSignal()
	return nil
}

func handleNotificationRetry(ctx context.Context, s *service, b, observed object) (bool, error) {
	if notificationAgent(b) != "codex" || observed["state"] != "failed" || field(observed["error"], "codexErrorInfo") != "serverOverloaded" {
		return false, nil
	}
	retry := clone(obj(b["retry"]))
	if retry == nil {
		retry = object{}
	}
	status := text(retry, "status")
	if status == "continued" {
		return true, nil
	}
	if _, successor := observed["nextTurnId"].(string); successor && status != "submitting" {
		retry["status"] = "superseded"
		return false, updateNotificationRetry(b, retry, false)
	}
	if slices.Contains([]string{"exhausted", "skipped", "stopped", "superseded"}, status) {
		return false, nil
	}
	settings, err := notificationSettings()
	if err != nil {
		return false, err
	}
	maxAttempts := min(uintOr(settings["codexRetryMaxAttempts"], 3), 10)
	if status == "scheduled" && uintOr(retry["nextAttempt"], 0) > maxAttempts {
		retry["status"], retry["reason"] = "stopped", "retry-budget-disabled-or-reduced"
		return false, updateNotificationRetry(b, retry, false)
	}
	if status != "submitting" && status != "scheduled" {
		attempts := uintOr(retry["attempts"], 0)
		if attempts >= maxAttempts {
			retry["status"] = "exhausted"
			return false, updateNotificationRetry(b, retry, false)
		}
		if _, model := retry["model"].(string); !model {
			retry["status"], retry["reason"] = "skipped", "model-not-confirmed"
			return false, updateNotificationRetry(b, retry, false)
		}
		if nativeControlRequest == nil || submitNotificationRetry == nil {
			return false, errors.New(PortPending)
		}
		page, err := nativeControlRequest(ctx, s, "thread/turns/list", object{"threadId": b["threadId"], "limit": 1, "sortDirection": "desc", "itemsView": "full"}, 10*time.Second)
		if err != nil {
			return false, err
		}
		items := arr(field(page, "data"))
		if len(items) == 0 {
			return false, errors.New("RETRY_HISTORY_UNAVAILABLE")
		}
		turn := obj(items[0])
		if turn["id"] != b["turnId"] {
			retry["status"] = "superseded"
			return false, updateNotificationRetry(b, retry, false)
		}
		if !safeNotificationRetry(turn) {
			retry["status"], retry["reason"] = "skipped", "tool-activity-or-incomplete-history"
			return false, updateNotificationRetry(b, retry, false)
		}
		retry["nextAttempt"], retry["requestId"], retry["status"] = attempts+1, id(), "scheduled"
		retry["notBefore"] = notificationClock().Unix() + notificationRetryBackoff(settings, attempts+1)
		return true, updateNotificationRetry(b, retry, false)
	}
	if uintOr(retry["notBefore"], 1<<63-1) > uint64(notificationClock().Unix()) {
		return true, nil
	}
	if submitNotificationRetry == nil {
		return true, errors.New(PortPending)
	}
	retry["status"] = "submitting"
	if err := updateNotificationRetry(b, retry, false); err != nil {
		return true, err
	}
	args := object{"threadId": b["threadId"], "prompt": notificationRetryPrompt, "model": retry["model"], "turn": clone(obj(retry["turn"])),
		"requestId": retry["requestId"], "waitMs": 0, "approval": "approved", "_newTurn": true, "_expectedPreviousTurn": b["turnId"],
		"_retryAttempt": retry["nextAttempt"], "notify": nil}
	if b["target"] != nil {
		args["notify"] = object{"channel": b["channel"], "target": b["target"]}
	}
	dispatchSetSection(args, "turn")["model"] = retry["model"]
	origin := obj(retry["origin"])
	if origin == nil {
		origin = object{"sourceId": b["sourceId"]}
	}
	receipt, err := submitNotificationRetry(withOrigin(ctx, origin), s, args)
	if err == nil && receipt["state"] == "completed" && text(receipt, "turnId") != "" {
		retry["status"], retry["successorTurnId"] = "continued", receipt["turnId"]
		return true, updateNotificationRetry(b, retry, true)
	}
	if err == nil && slices.Contains([]string{"reserved", "pending", "executing", "queued", "submitting", "submitted"}, text(receipt, "state")) {
		return true, nil
	}
	retry["status"], retry["attempts"], retry["reason"] = "stopped", retry["nextAttempt"], wire(field(receipt["result"], "error"))
	if err != nil {
		retry["reason"] = err.Error()
	}
	return false, updateNotificationRetry(b, retry, false)
}
