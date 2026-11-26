package core

import (
	"context"
	"errors"
)

func init() {
	peerCanReadTask = func(ctx context.Context, agent, task string) bool {
		return peerVisibleTask(ctx, agent, task, text(currentOrigin(ctx), "deviceId"))
	}

	deviceCoreAgentAvailable = func(ctx context.Context, _ *service, agent string) bool {
		driver, ok := nativeAgentDriverByID(agent)
		if !ok {
			return false
		}
		enabled, err := nativeAgentEnabled(agent)
		if err != nil || !enabled {
			return false
		}
		if agent == "codex" {
			binary, _, err := codexInputs()
			return err == nil && binary != ""
		}
		found := driver.discover(ctx)
		return found.err == nil && found.binary != ""
	}
	deviceCoreTaskRead = func(ctx context.Context, s *service, source requestSource, op string, args object) (object, error) {
		ctx = context.WithValue(ctx, &peerControlKey, true)
		if op == "task_activity" {
			return readNativeAgentActivity(ctx, s)
		}
		request := operationRequest{name: op, args: args, source: source, service: s}
		var result any
		var err error
		switch op {
		case "codex_tasks":
			result, err = listCodexTasks(ctx, request)
		case "agent_tasks":
			result, err = listNativeAgentOperation(ctx, request)
		default:
			err = errors.New("UNKNOWN_OPERATION")
		}
		return obj(result), err
	}
	notificationTransportAvailable = func(channel string) bool {
		if channel == "antigravity-session" {
			return antigravityAgentAPIBinary() != ""
		}
		return channel == "claude-session" && notificationClaudeRun != nil && findAccountAgent("claude") != ""
	}
}
