package core

import (
	"context"
	"os"
	"strings"
)

func dispatchCallerFromEnvironment(read func(string) string) object {
	var caller object
	for _, profile := range agentProfiles {
		if profile.callerEnv == "" {
			continue
		}
		conversation := read(profile.callerEnv)
		if strings.TrimSpace(conversation) == "" || conversation == "unknown" {
			continue
		}
		if caller != nil {
			return nil
		}
		caller = object{"agent": profile.id, "conversationId": conversation}
	}
	return caller
}

func validatedDispatchCaller(value any) any {
	agent, conversation := text(value, "agent"), text(value, "conversationId")
	if strings.TrimSpace(conversation) == "" || conversation == "unknown" || knownAgentProfile(agent).callerEnv == "" {
		return nil
	}
	return object{"agent": agent, "conversationId": conversation}
}

func attachDispatchCaller(ctx context.Context, row object) {
	if caller := obj(ctx.Value(&localControlCallerKey)); caller != nil {
		row["caller"] = caller
	}
}

func cliDispatchRequest(op string, args object) object {
	body := object{"op": op, "args": args}
	switch op {
	case "codex_create", "codex_send", "agent_create", "agent_send":
		if caller := dispatchCallerFromEnvironment(os.Getenv); caller != nil {
			body["caller"] = caller
		}
	}
	return body
}

func init() {
	validateDispatchCaller = validatedDispatchCaller
}
