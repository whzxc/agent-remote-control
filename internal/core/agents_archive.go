package core

import (
	"context"
	"errors"
)

func nativeArchiveBusy(args object, pending bool) error {
	op := "agent_read"
	message := "The task has an active or unconfirmed turn/dispatch. Wait for completion or use agent_interrupt explicitly, then read the task before archiving."
	if pending {
		op = "agent_pending"
		message = "The task has a pending interaction. Use agent_pending, then agent_respond with the user's decision before archiving."
	}
	return dispatchObjectError(object{"code": "ARCHIVE_ACTIVE_TURN", "message": message,
		"next": object{"via": "query", "op": op, "args": selectFields(args, "agent", "taskId")}})
}

func archiveNativeAgentTask(ctx context.Context, r operationRequest, row object) (any, error) {
	args := obj(row["arguments"])
	taskID, agent := text(args, "taskId"), text(args, "agent")
	unlock := lockReceipt("agent-task:" + taskID)
	defer unlock()
	task, err := r.service.nativeAgentTask(agent, taskID)
	if err != nil {
		return nil, err
	}
	result := func(already bool) object {
		return object{"taskId": taskID, "agent": agent, "archived": true, "alreadyArchived": already}
	}
	if task["archived"] == true {
		return result(true), nil
	}
	p := r.service.agents.process(taskID)
	if p != nil {
		p.mu.Lock()
		pending := len(p.pending) != 0
		p.mu.Unlock()
		if pending {
			return nil, nativeArchiveBusy(args, true)
		}
		if !p.dispatch.TryLock() {
			return nil, nativeArchiveBusy(args, false)
		}
		defer p.dispatch.Unlock()
		task = p.snapshot()
	}
	if !agentTurnReady(task) {
		return nil, nativeArchiveBusy(args, task["status"] == "waiting-permission")
	}
	if err := agentReceiptCheckpoint(ctx, row, "archiving"); err != nil {
		return nil, err
	}
	if p != nil {
		if err := p.close(ctx); err != nil {
			return nil, err
		}
		task = p.snapshot()
	}
	task["archived"], task["processState"] = true, "stopped"
	if task["archivedAt"] == nil {
		task["archivedAt"] = now()
	}
	task["updatedAt"] = now()
	if err := saveNativeAgentTask(task); err != nil {
		return nil, err
	}
	r.service.agents.publish(taskID, nil)
	if err := endNotificationScope(taskID, "task-archived"); err != nil {
		return nil, err
	}
	return result(false), nil
}

func reviewNativeAgentTask(ctx context.Context, r operationRequest, row object) (any, error) {
	args := obj(row["arguments"])
	task, err := r.service.nativeAgentTask(text(args, "agent"), text(args, "taskId"))
	if err != nil {
		return nil, err
	}
	if task == nil {
		return nil, errors.New("TASK_NOT_FOUND")
	}
	if err := agentReceiptCheckpoint(ctx, row, "submitting"); err != nil {
		return nil, err
	}
	return reviewAgentDispatch(ctx, args, task)
}
