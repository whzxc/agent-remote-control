package core

import (
	"context"
	"errors"
	"slices"
	"time"
)

func waitNativeAgentOperation(ctx context.Context, r operationRequest) (any, error) {
	agent, taskID := text(r.args, "agent"), text(r.args, "taskId")
	started := time.Now()
	if !nativeAgentReadAllowed(ctx, agent, taskID) {
		return nil, errors.New("TASK_NOT_FOUND")
	}
	ctx = withRuntimeCost(ctx, "taskRead", "poll")
	task, err := r.service.nativeAgentTask(agent, taskID)
	if err != nil {
		return nil, err
	}
	if err := agentMutationArchived(task); err != nil {
		return nil, err
	}
	pinnedSession := text(task, "processSession")
	selected := optionalProjectString(r.args["turnId"])
	source := nativeWaitSource{
		alive:             func() bool { return true },
		deadlineIsTimeout: true,
		wake: func() <-chan struct{} {
			if p := r.service.agents.process(taskID); p != nil {
				return p.signal()
			}
			return nil
		},
		observe: func(_ context.Context) (object, error) {
			task, err := r.service.nativeAgentTask(agent, taskID)
			if err != nil {
				return nil, err
			}
			interactions, err := nativeAgentInteractions(task)
			task["interaction"] = interactions
			return task, err
		},
		classify: func(task object, _ **string) object {
			if selected == nil {
				selected = optionalProjectString(task["turnId"])
			}
			result := agentTurnObservation(task)
			if selected != nil && result["turnId"] != *selected {
				result["state"], result["reason"] = "unconfirmed", "turn-not-found"
				result["turnId"], result["finalResponse"] = *selected, nil
			}
			if pinnedSession != "" && text(task, "processSession") != pinnedSession {
				result["state"], result["reason"] = "unconfirmed", "runtime-owner-changed"
				result["finalResponse"] = nil
			}
			if result["reason"] != "turn-not-found" && result["reason"] != "runtime-owner-changed" {
				result["finalResponse"] = nativeAgentWaitResponse(task, str(result["state"]))
				projectAgentWaitInteractions(task, result)
			}
			result["runtimeStatus"], result["outputTruncated"], result["observedAt"] = agentTurnRuntime(task), task["outputTruncated"], now()
			result["runtimeSource"], result["sessionId"], result["processSession"] = task["runtimeSource"], task["sessionId"], task["processSession"]
			result["contextUsage"], result["stopReason"] = task["contextUsage"], task["stopReason"]
			delete(result, "_turnLifecycle")
			return result
		},
	}
	shutdown := r.service.codex.shutdown
	if shutdown == nil {
		shutdown = context.Background()
	}
	result, err := runNativeWait(ctx, shutdown, source, r.args, started)
	if err != nil {
		return nil, err
	}
	result["agent"], result["taskId"] = agent, taskID
	delete(result, "threadId")
	nativeWaitCondition(result, r.args)
	if wantsTaskSummary(r.name, r.args) {
		if err := addAgentTaskSummaryEvidence(result); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func nativeAgentWaitResponse(task object, state string) any {
	if turnWaitState(state).keepsResponse() || task["agent"] == "pi" && field(task["lastMessage"], "role") == "assistant" {
		return task["output"]
	}
	return nil
}

func observeNativeAgentNotification(_ context.Context, s *service, binding object) (object, error) {
	agent, taskID, turn := notificationAgent(binding), text(binding, "threadId"), text(binding, "turnId")
	task, err := s.nativeAgentTask(agent, taskID)
	if err != nil {
		return nil, err
	}
	if task["turnId"] == turn {
		value := agentTurnObservation(task)
		value["observedAt"] = now()
		value["finalResponse"] = nativeAgentWaitResponse(task, str(value["state"]))
		interactions, err := nativeAgentInteractions(task)
		if err != nil {
			return nil, err
		}
		task["interaction"] = interactions
		projectAgentWaitInteractions(task, value)
		return value, nil
	}
	checkpoint := field(field(task["tracking"], "turnLifecycles"), turn)
	transition, ok := restoreTurnTransition(checkpoint)
	if !ok || transition.key != (turnKey{agent, taskID, turn}) {
		return nil, errors.New("TURN_NOT_FOUND")
	}
	state, reason := transition.wait()
	if !slices.Contains([]turnWaitState{waitCompleted, waitFailed, waitCancelled}, state) {
		return nil, errors.New("NATIVE_TURN_UNCONFIRMED")
	}
	return object{"agent": agent, "taskId": taskID, "turnId": turn, "state": string(state), "reason": reason,
		"_turnLifecycle": checkpoint, "observedAt": now()}, nil
}

func nativeAgentInteractions(task object) ([]any, error) {
	rows := []any{}
	for _, row := range decodedTaskList(task["pendingInteractions"]) {
		request := clone(obj(row))
		if request == nil || request["turnId"] != task["turnId"] {
			continue
		}
		request["interactionId"], request["backendSession"] = request["id"], task["processSession"]
		if err := notificationRoutingObserve(text(task, "agent"), text(task, "taskId"), request); err != nil {
			return nil, err
		}
		rows = append(rows, request)
	}
	return rows, nil
}

func projectAgentWaitInteractions(task, result object) {
	rows := arr(task["interaction"])
	previews := make([]object, 0, min(len(rows), 5))
	for _, row := range rows[:min(len(rows), 5)] {
		previews = append(previews, interactionPreview(obj(row)))
	}
	result["interaction"], result["progress"] = rows, object{"pendingInteractions": previews}
	result["interactionAction"] = nil
	if result["state"] == "interaction-required" {
		result["interactionAction"] = "Use agent_pending or agent_respond with agent, taskId, interactionId and a new requestId; do not resend the task"
	}
}
