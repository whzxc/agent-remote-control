package core

import "math"

func agentTurnKey(task object) turnKey {
	return turnKey{text(task, "agent"), text(task, "taskId"), text(task, "turnId")}
}

func readAgentTurn(task object) turnTransition {
	return turnSnapshot(agentTurnKey(task), text(task, "status"), task["_turnLifecycle"])
}

func applyAgentTurn(task object, evidence turnEvidence) {
	turn := readAgentTurn(task).advance(evidence)
	task["status"], task["_turnLifecycle"] = turn.projection(), turn.checkpoint()
}

func observeAgentOwner(task object, status string) {
	state := turnActive
	if status == "waiting-permission" {
		state = turnAwaitingInteraction
	}
	applyAgentOwner(task, state)
}

func observeAgentLoss(task object) {
	applyAgentOwner(task, turnUnavailable)
}

func applyAgentOwner(task object, state turnOwnerState) {
	turn := readAgentTurn(task)
	revision := turn.owner.revision
	if revision < math.MaxUint64 {
		revision++
	}
	applyAgentTurn(task, turnEvidence{key: agentTurnKey(task), owner: turnOwner{revision, state}})
}

func agentTurnTerminal(task object) bool {
	_, terminal := readAgentTurn(task).terminal()
	return terminal
}

func agentTurnReady(task object) bool {
	return task["status"] == "idle" || agentTurnTerminal(task)
}

func agentTurnActive(task object) bool {
	state, _ := readAgentTurn(task).wait()
	return state == waitRunning || state == waitInteraction
}

func agentTurnObservation(task object) object {
	turn := readAgentTurn(task)
	state, reason := turn.wait()
	return object{"agent": task["agent"], "taskId": task["taskId"], "turnId": task["turnId"],
		"state": string(state), "reason": reason, "recordedStatus": task["status"], "_turnLifecycle": turn.checkpoint(),
		"title": task["title"], "finalResponse": task["output"], "error": task["error"]}
}

func agentTurnRuntime(task object) string {
	if task["processState"] == "stopped" || task["processState"] == "exited" {
		return "unknown"
	}
	state, _ := readAgentTurn(task).wait()
	switch {
	case state == waitRunning:
		return "active"
	case state == waitInteraction:
		return "waiting"
	case state.terminal(), task["status"] == "idle":
		return "idle"
	default:
		return "unknown"
	}
}
