package core

import (
	"context"
	"errors"
	"slices"
	"sync/atomic"
)

var activeNativeAgentHost atomic.Pointer[nativeAgentHost]

func liveNativeAgentTurns(threads []string) []coordinationLiveTurn {
	host := activeNativeAgentHost.Load()
	if host == nil {
		return nil
	}
	result := []coordinationLiveTurn{}
	for _, thread := range threads {
		p := host.process(thread)
		if p == nil {
			continue
		}
		task := p.snapshot()
		turn := text(task, "turnId")
		if turn == "" {
			continue
		}
		select {
		case <-p.done:
			observeAgentLoss(task)
		default:
		}
		result = append(result, coordinationLiveTurn{thread, turn, text(task, "status"), obj(task["_turnLifecycle"])})
	}
	return result
}

func nativeAgentEvents(ctx context.Context, r operationRequest) (any, error) {
	agent, taskID := text(r.args, "agent"), text(r.args, "taskId")
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
	p := r.service.agents.process(taskID)
	if p == nil {
		return nil, errors.New("AGENT_PROCESS_CLOSED")
	}
	session := text(task, "processSession")
	result := p.events.feed(session, r.args)
	delete(result, "retention")
	delete(result, "historyOp")
	p.events.Lock()
	var issue any
	if p.events.storageError != nil {
		issue = p.events.storageError.Error()
	}
	p.events.Unlock()
	result["persistedOutput"] = object{"outputId": taskID, "format": "JSONL", "error": issue}
	recordRuntimeWork(ctx, runtimeWorkCost{Owner: "taskRead", Reason: "poll", Rows: len(decodedTaskList(result["events"]))})
	return result, nil
}

func nativeAgentCapabilities(ctx context.Context, r operationRequest) (any, error) {
	agent, taskID := text(r.args, "agent"), text(r.args, "taskId")
	driver, registered := nativeAgentDriverByID(agent)
	if !registered {
		return nil, errors.New("UNKNOWN_AGENT")
	}
	if err := ensureNativeAgentEnabled(agent); err != nil {
		return nil, err
	}
	if taskID != "" {
		task, err := r.service.nativeAgentTask(agent, taskID)
		if err != nil {
			return nil, err
		}
		if err := agentMutationArchived(task); err != nil {
			return nil, err
		}
		if task["runtimeSource"] == antigravityDesktopProtocol {
			return object{"protocol": antigravityDesktopProtocol, "resume": true, "cancel": false, "streaming": false, "completionEvent": nil}, nil
		}
		if p := r.service.agents.process(taskID); p == nil {
			return nil, errors.New("AGENT_PROCESS_CLOSED")
		}
		return task["capabilities"], nil
	}
	discovery := driver.discover(ctx)
	var issue any
	if discovery.err != nil {
		issue = discovery.err.Error()
	}
	protocol := driver.protocol
	if agent == "antigravity" && antigravityAgentAPI(discovery.binary) {
		protocol = antigravityDesktopProtocol
	}
	return object{"agent": agent, "protocol": protocol, "installed": discovery.binary != "", "available": discovery.err == nil,
		"discoveryError": issue, "descriptor": driver.descriptor(), "negotiated": false, "capabilities": nil,
		"nextAction": "agent_create then agent_capabilities(taskId)"}, nil
}

func init() {
	registerOperation("agents", func(ctx context.Context, r operationRequest) (any, error) {
		inventory, err := nativeAgentInventory(ctx, r.service, false)
		if err != nil {
			return nil, err
		}
		if rows, ok := inventory["agents"].([]object); ok {
			inventory["agents"] = slices.DeleteFunc(rows, func(row object) bool { return row["agent"] == "codex" })
		}
		delete(inventory, "defaultAgent")
		return inventory, nil
	}, nil)
	registerOperation("agent_capabilities", nativeAgentCapabilities, nil)
	registerOperation("agent_events", nativeAgentEvents, nil)
	coordinationAgentSession = func(s *service) string { return text(s.metadata, "instance") }
	taskTrackingAgentTurns = liveNativeAgentTurns
	registerServiceStartup(func(_ context.Context, s *service) error {
		activeNativeAgentHost.Store(&s.agents)
		s.cleanup = append(s.cleanup, func() { activeNativeAgentHost.CompareAndSwap(&s.agents, nil) })
		return nil
	})
}
