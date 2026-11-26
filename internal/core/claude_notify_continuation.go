package core

import (
	"math"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
)

const notificationContinuationWindow = 10 * 60

func notificationEnvironmentUpdate(payload object) bool {
	rows := arr(payload["content"])
	if len(rows) != 1 || field(rows[0], "type") != "input_text" {
		return false
	}
	text := strings.TrimSpace(text(rows[0], "text"))
	return strings.HasPrefix(text, "<environment_context>\n") &&
		strings.HasSuffix(text, "\n</environment_context>") && strings.Count(text, "</environment_context>") == 1
}

// A supplies the canonical native rollout text. A partial or invalid history
// cannot establish provenance.
func notificationContinuationEvidence(thread object, previous string, next object, history string) (object, error) {
	if next == nil {
		return nil, nil
	}
	hasUser := func(value any) bool { return field(value, "type") == "userMessage" }
	items := arr(next["items"])
	if slices.ContainsFunc(items, hasUser) {
		return object{"excluded": true, "reason": "new-user-content", "successorTurnId": next["id"]}, nil
	}
	var active string
	matched, hasInput := false, false
	var ended *int64
	var successor, config object
	for line := range strings.SplitSeq(strings.TrimSuffix(history, "\n"), "\n") {
		var event object
		if err := decodeObject([]byte(line), &event); err != nil {
			return nil, err
		}
		p := obj(event["payload"])
		if event["type"] == "session_meta" {
			matched = text(p, "id") != "" && p["id"] == thread["id"]
		}
		if !matched {
			continue
		}
		if event["type"] == "event_msg" && p["type"] == "task_started" {
			if successor != nil {
				break
			}
			if active == previous && p["turn_id"] != previous {
				successor = p
			}
			active = text(p, "turn_id")
		}
		if event["type"] == "event_msg" && p["turn_id"] == previous && (p["type"] == "task_complete" || p["type"] == "turn_aborted") {
			if seconds, ok := uintValue(p["completed_at"]); ok {
				unix := int64(seconds)
				ended = &unix
			} else if at, err := time.Parse(time.RFC3339Nano, text(event, "timestamp")); err == nil {
				unix := at.Unix()
				ended = &unix
			}
		}
		if ended == nil {
			continue
		}
		if event["type"] == "response_item" && p["role"] == "user" && !notificationEnvironmentUpdate(p) ||
			event["type"] == "event_msg" && p["type"] == "user_message" {
			hasInput = true
		}
		if event["type"] == "turn_context" && p["turn_id"] == successor["turn_id"] && p["cwd"] == thread["cwd"] {
			_, model := p["model"].(string)
			_, effort := p["effort"].(string)
			_, tier := p["service_tier"]
			if model && effort && tier {
				config = object{"model": p["model"], "effort": p["effort"], "serviceTier": p["service_tier"], "source": "native-persisted-turn-context"}
			}
		}
	}
	if ended == nil {
		return nil, nil
	}
	deadline := *ended + notificationContinuationWindow
	result := object{"until": deadline, "successorTurnId": next["id"], "reason": "continuation-evidence-incomplete"}
	if hasInput {
		result["excluded"], result["reason"] = true, "new-user-content"
		return result, nil
	}
	trigger := text(successor["turn_attribution"], "turn_trigger")
	started, ok := uintValue(successor["started_at"])
	valid := trigger == "capacity_retry_automatic" || trigger == "capacity_retry_manual" || trigger == "resume_interrupted_task"
	within := ok && int64(started) >= *ended && (trigger == "resume_interrupted_task" || int64(started) <= deadline)
	switch {
	case valid && within && next["id"] == successor["turn_id"] && items != nil && config != nil:
		result["reason"] = "native-continuation"
		state := "unknown"
		if mergeNotificationLifecycle != nil {
			live := "unconfirmed"
			if next["status"] == "inProgress" {
				live = "running"
			}
			_, observed, _, _ := mergeNotificationLifecycle("codex", text(thread, "id"), text(next, "id"), nil,
				object{"recordedStatus": next["status"], "state": live})
			state = notificationContinuationState(observed)
		}
		result["retry"] = object{"turnId": next["id"], "trigger": trigger, "startedAt": started, "configuration": config, "state": state}
	case !valid:
		result["excluded"], result["reason"] = true, "unknown-native-trigger"
	case ok && !within:
		result["excluded"], result["reason"] = true, "outside-continuation-window"
	}
	return result, nil
}

func notificationContinuationState(state string) string {
	switch state {
	case "running", "completed", "failed", "interrupted":
		return state
	case "cancelled":
		return "interrupted"
	case "interaction-required":
		return "needs-input"
	default:
		return "unknown"
	}
}

func notificationContinuationNotice(bind, observed object, all []object) object {
	if field(bind["successor"], "inherited") != true {
		return nil
	}
	turn, ok := field(bind["successor"], "turnId").(string)
	if !ok {
		return nil
	}
	state := "unknown"
	retry := obj(field(observed["nativeContinuation"], "retry"))
	for i := 0; i <= len(all); i++ {
		if retry["turnId"] == turn {
			state = notificationContinuationState(text(retry, "state"))
		}
		pos := slices.IndexFunc(all, func(row object) bool {
			return row["threadId"] == bind["threadId"] && row["turnId"] == turn && row["sourceId"] == bind["sourceId"]
		})
		if pos < 0 {
			break
		}
		next := all[pos]
		if native := notificationContinuationState(text(next["observation"], "state")); native != "unknown" || retry["turnId"] != turn {
			state = native
		}
		successor, ok := field(next["successor"], "turnId").(string)
		if !ok || successor == turn || field(next["successor"], "inherited") != true {
			break
		}
		turn, state = successor, "unknown"
	}
	return object{"turnId": turn, "state": state}
}

func notificationScopeStarted(bind object) uint64 {
	if at := uintOr(bind["scopeStartedAt"], 0); at != 0 {
		return at
	}
	return uintOr(bind["createdAt"], 0) * 1000
}

func endNotificationBoundScope(bind object, reason string) error {
	all, err := notificationBindings()
	if err != nil {
		return err
	}
	for _, row := range all {
		if row["threadId"] == bind["threadId"] && row["sourceId"] == bind["sourceId"] && notificationScopeStarted(row) == notificationScopeStarted(bind) {
			row["scopeEnd"] = reason
			if err := persistNotificationBinding(row); err != nil {
				return err
			}
		}
	}
	bind["scopeEnd"] = reason
	return nil
}

func adoptNotificationContinuation(b, observation object) error {
	if obj(observation["conflict"]) != nil {
		return nil
	}
	if observation["archived"] == true {
		if err := endNotificationBoundScope(b, "thread-archived"); err != nil {
			return err
		}
	}
	if b["scopeEnd"] != nil || notificationAgent(b) != "codex" || b["continuationBound"] == true {
		return nil
	}
	thread, turn := text(b, "threadId"), text(b, "turnId")
	state, next := text(observation, "state"), text(observation, "nextTurnId")
	if next != "" {
		if _, valid := uuid.Parse(thread); valid == nil {
			rows, err := dispatchRecords(thread)
			if err != nil {
				return err
			}
			if slices.ContainsFunc(rows, func(row object) bool { return row["turnId"] == next && row["dispatchSource"] != "native-retry" }) {
				return nil
			}
		}
		if state == "completed" {
			b["successor"] = object{"turnId": next, "inherited": false, "reason": "predecessor-completed"}
			return endNotificationBoundScope(b, "unrelated-native-turn")
		}
	}
	if state != "failed" && state != "interrupted" && state != "cancelled" {
		return nil
	}
	provenance := obj(observation["nativeContinuation"])
	if provenance["excluded"] == true {
		b["successor"] = object{"turnId": observation["nextTurnId"], "inherited": false, "reason": provenance["reason"]}
		b["continuationBound"] = true
		return endNotificationBoundScope(b, "unrelated-native-content")
	}
	retry := obj(provenance["retry"])
	if next != "" && retry == nil {
		b["successor"] = object{"turnId": next, "inherited": false, "reason": "pending-native-provenance"}
	}
	until := uintOr(provenance["until"], uintOr(b["continuationUntil"], 0))
	if state != "failed" {
		until = math.MaxInt64
	} else if until == 0 {
		until = uint64(notificationClock().Unix() + notificationContinuationWindow)
	}
	b["continuationUntil"] = until
	next = text(retry, "turnId")
	if next == "" {
		return nil
	}
	owns, err := recordDispatchNativeRetry(thread, turn, retry)
	if err != nil {
		return err
	}
	b["continuationBound"] = true
	b["successor"] = object{"turnId": next, "inherited": false, "reason": "independent-dispatch"}
	if !owns {
		return nil
	}
	successor, err := readNotificationBinding(thread, next)
	if err != nil {
		return err
	}
	if successor == nil {
		successor = clone(b)
		successor["turnId"], successor["scopeStartedAt"], successor["createdAt"] = next, notificationScopeStarted(b), notificationClock().Unix()
		for _, key := range []string{"successor", "observation", "lifecycle"} {
			delete(successor, key)
		}
		successor["waiting"], successor["deliveries"] = []any{}, []any{}
		successor["explicit"], successor["continuationBound"], successor["continuationUntil"] = false, false, 0
		successor["retry"] = object{"status": "skipped", "reason": "native-retry-owned"}
		dispatchSetSection(successor, "causedBy")["retryOf"] = turn
	}
	inherits := successor["explicit"] != true && successor["sourceId"] == b["sourceId"]
	if inherits {
		successor["target"], successor["channel"] = b["target"], b["channel"]
		for _, item := range arr(successor["deliveries"]) {
			d := obj(item)
			if d["status"] == "pending" && text(d, "target") == "" {
				d["target"], d["channel"] = text(b, "target"), b["channel"]
			}
		}
		if err := persistNotificationBinding(successor); err != nil {
			return err
		}
	}
	b["successor"] = object{"turnId": next, "inherited": inherits, "reason": "native-continuation"}
	return nil
}
