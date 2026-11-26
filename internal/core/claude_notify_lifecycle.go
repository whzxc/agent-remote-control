package core

// A owns the native turn evidence state machine. This adapter carries its
// serialized checkpoint and outcome without inferring completion from liveness.
var mergeNotificationLifecycle func(agent, task, turn string, previous any, observation object) (checkpoint any, state, reason string, conflict any)

func notificationAgent(binding object) string {
	if agent := text(binding, "agent"); agent != "" {
		return agent
	}
	return "codex"
}

func notificationObservationMatches(binding, observation object) bool {
	for _, field := range []struct {
		actual   any
		expected string
	}{
		{dispatchFirstString(observation["threadId"], observation["taskId"]), text(binding, "threadId")},
		{observation["turnId"], text(binding, "turnId")}, {observation["agent"], notificationAgent(binding)},
	} {
		if value, ok := field.actual.(string); ok && value != field.expected {
			return false
		}
	}
	return true
}

func notificationTerminal(state string) bool {
	switch state {
	case "completed", "failed", "cancelled", "interrupted":
		return true
	default:
		return false
	}
}

func notificationAdmits(binding, delivery object) bool {
	observed := obj(binding["observation"])
	if obj(observed["conflict"]) != nil {
		return false
	}
	state := text(observed, "state")
	taskState := text(delivery, "taskState")
	if taskState == "handoff" || taskState == "recovered" {
		return true
	}
	if state == "interrupted" {
		state = "cancelled"
	}
	if taskState == "interrupted" {
		taskState = "cancelled"
	}
	switch {
	case notificationTerminal(state):
		return delivery["key"] == "terminal" && taskState == state
	case state == "interaction-required":
		return taskState == "interaction-required"
	case state == "running":
		return delivery["state"] == "stalled"
	default:
		return false
	}
}
