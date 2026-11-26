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
	if caller := validatedDispatchCaller(object{"agent": "unconfirmed", "conversationId": "session"}); caller != nil {
		t.Fatalf("unconfirmed caller was admitted: %v", caller)
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
	for _, agent := range []string{"codex", "pi"} {
		thread, turn := id(), id()
		args := object{"requestId": id(), "purpose": "self-test"}
		task := object{"agent": agent, "taskId": thread, "turnId": turn,
			"dispatch": object{"model": "fixture-model", "submittedAt": "2026-01-01T00:00:00Z"}}
		receipt := object{"requestId": args["requestId"], "threadId": thread, "turnId": turn, "dispatchMode": "new-turn",
			"origin": origin, "caller": caller, "arguments": args, "task": task}
		var err error
		if agent == "codex" {
			err = recordDispatch(receipt)
		} else {
			err = recordAgentDispatch(context.WithValue(ctx, &localControlCallerKey, caller), task, args, "agent_create")
		}
		if err != nil {
			t.Fatal(err)
		}
		rows, err := readDispatchRecords(thread)
		if err != nil || len(rows) != 1 || rows[0]["purpose"] != "self-test" ||
			wire(rows[0]["caller"]) != wire(caller) || wire(rows[0]["origin"]) != wire(origin) {
			t.Fatalf("%s dispatch record = %s, %v", agent, wire(rows), err)
		}
		timeline := new(taskTimeline)
		timeline.agent("arc/user", object{"turnId": turn, "text": "Fixture dispatch"}, "2026-01-01T00:00:00Z")
		history, activity := timeline.response(thread, 0), timeline.session(thread, nil, "arc-task", nil)
		summaries, _ := history["turnDispatchSummaries"].(map[string]object)
		for _, summary := range []any{history["dispatchSummary"], summaries[turn], activity["dispatchSummary"]} {
			if wire(field(summary, "caller")) != wire(caller) || field(field(summary, "controlSource"), "kind") != "local-cli" {
				t.Fatalf("%s projected dispatch summary = %s", agent, wire(summary))
			}
		}
		for _, invalid := range []any{nil, object{"agent": "unknown", "conversationId": "fixture"}} {
			next := id()
			receipt["requestId"], receipt["turnId"], receipt["caller"] = id(), next, invalid
			if err := recordDispatch(receipt); err != nil {
				t.Fatal(err)
			}
			if summary := taskTrackingSummaries(thread, nil)[next]; summary == nil || summary["caller"] != nil {
				t.Fatalf("caller was inherited on a new turn: %s", wire(summary))
			}
		}
	}
	remote := dispatchSummary(object{"origin": object{"sourceId": "remote-source", "controlSource": "claude"}})
	if field(remote["controlSource"], "id") != "remote-source" || remote["caller"] != nil {
		t.Fatalf("remote attribution = %s", wire(remote))
	}
}
