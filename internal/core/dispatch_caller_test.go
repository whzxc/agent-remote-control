package core

import (
	"context"
	"testing"
)

func TestLocalDispatchPreservesSingleCallingAgent(t *testing.T) {
	// Recurring bug class: persistence CLI dispatch attribution was lost at the local request boundary.
	for _, profile := range agentProfiles {
		if profile.callerEnv == "" {
			continue
		}
		t.Setenv(profile.callerEnv, "")
		caller := dispatchCallerFromEnvironment(func(key string) string {
			if key == profile.callerEnv {
				return "session"
			}
			return ""
		})
		if caller["agent"] != profile.id || caller["conversationId"] != "session" {
			t.Fatalf("%s caller = %v", profile.id, caller)
		}
	}
	for _, unresolved := range []string{"", "  ", "unknown", "ambiguous"} {
		if caller := dispatchCallerFromEnvironment(func(string) string { return unresolved }); caller != nil {
			t.Fatalf("ambiguous or absent caller = %v", caller)
		}
	}
	t.Setenv("ANTIGRAVITY_CONVERSATION_ID", "fixture-antigravity-conversation")
	args := object{"prompt": "Fixture dispatch", "notify": nil}
	for _, operation := range []string{"codex_create", "codex_send", "agent_create", "agent_send", "codex_read"} {
		body := cliDispatchRequest(operation, args)
		if wire(body["args"]) != wire(args) || body["origin"] != nil {
			t.Fatalf("%s request shape = %v", operation, body)
		}
		if operation == "codex_read" {
			if body["caller"] != nil {
				t.Fatalf("read included a caller: %v", body["caller"])
			}
		} else if text(body["caller"], "agent") != "antigravity" || text(body["caller"], "conversationId") != "fixture-antigravity-conversation" {
			t.Fatalf("%s caller = %v", operation, body["caller"])
		}
	}
}

func TestReceiptDispatchSummaryCarriesValidatedCaller(t *testing.T) {
	// Contract: durable dispatch receipts project caller independently from the authenticated control source.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	origin := object{"sourceId": "local-cli", "controlSource": "local-cli", "authType": "local", "caller": object{"agent": "pi", "conversationId": "irrelevant"}}
	caller := object{"agent": "antigravity", "conversationId": "fixture"}
	ctx := withOrigin(t.Context(), origin)
	service := &service{metadata: object{"instance": id()}}
	defer service.close()
	for _, argument := range []any{caller, nil, object{"agent": "unknown", "conversationId": "fixture"}} {
		request := id()
		call := context.WithValue(ctx, &localControlCallerKey, validatedDispatchCaller(argument))
		receipt, err := runControlMutation(call, operationRequest{service: service}, "send", object{"requestId": request, "waitMs": 5000},
			func(context.Context, object) (any, error) { return object{"threadId": "fixture"}, nil })
		if err != nil || receipt["state"] != "completed" {
			t.Fatalf("dispatch receipt = %v, %v", receipt, err)
		}
		durable, err := coreReceiptStore().read(request, text(service.metadata, "instance"))
		if err != nil {
			t.Fatal(err)
		}
		summary := dispatchSummary(durable)
		if field(summary["controlSource"], "kind") != "local-cli" ||
			wire(summary["caller"]) != wire(validatedDispatchCaller(argument)) {
			t.Fatalf("dispatch attribution = %v", summary)
		}
	}
}
