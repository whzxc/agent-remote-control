package core

import (
	"encoding/json"
	"errors"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func guideSpecs() []object {
	list := []object{}
	for _, row := range arr(catalog()["ops"]) {
		list = append(list, obj(row))
	}
	return list
}

func testGuide(source requestSource, args object) object {
	return egressGuide(source, args, guideSpecs())
}

func TestPublicReceiptPreservesRecordedAnswerAttribution(t *testing.T) {
	// Algorithmic core: public receipt projection preserves explicit attribution and does not infer an answer author.
	for _, author := range []object{{"kind": "source", "sourceId": "controller"}, {"kind": "local-ui"}, {"kind": "unknown"}} {
		for _, source := range []object{{"answeredBy": author}, {"approval": object{"decision": "approved", "answeredBy": author}}} {
			row := object{"requestId": "fixture", "state": "completed"}
			maps.Copy(row, source)
			if value := publicReceipt(row); wire(value["answeredBy"]) != wire(author) {
				t.Fatalf("attribution = %v", value)
			}
		}
	}
	if value := publicReceipt(object{"requestId": "fixture", "state": "completed"}); value["answeredBy"] != nil {
		t.Fatalf("invented attribution: %v", value)
	}
}

func TestReceiptCheckpointFailurePreservesObservedResultAndRecovery(t *testing.T) {
	// Recurring bug class: persistence a failed checkpoint discarded a command's known result and its original receipt pointer.
	for _, result := range []object{{"exitCode": 0, "stdout": "probe"}, {"error": object{"code": "CONTROL_ERROR", "message": "execution failed"}}} {
		request := "00000000-0000-4000-8000-000000000001"
		row := object{"requestId": request, "state": "completed", "result": result, "arguments": object{"cmd": "private input"}}
		failure := controlFailure(receiptPersistenceError(row, errors.New("sync-owner: os error 5")))
		receipt, next := obj(failure["receipt"]), obj(failure["next"])
		if failure["code"] != "SUBMISSION_UNCONFIRMED" || wire(receipt["result"]) != wire(result) ||
			receipt["state"] != row["state"] || receipt["arguments"] != nil || failure["requestId"] != request ||
			next["op"] != "receipt" || field(next["args"], "requestId") != request {
			t.Fatalf("checkpoint failure = %v", failure)
		}
	}
}

func TestCodexDispatchSignaturesExposeAccountAndServiceTier(t *testing.T) {
	// Contract: compact Codex dispatch signatures disclose accepted account and service tier selectors.
	for _, name := range []string{"codex_create", "codex_send"} {
		signature := signature(operation(name))
		if !strings.Contains(signature, "account?") || !strings.Contains(signature, "serviceTier?") {
			t.Fatalf("%s signature = %s", name, signature)
		}
	}
}

func TestImageReadsAreDiscoverableFromDefaultAndReviewGuides(t *testing.T) {
	// Contract: default and review guides expose image reads and the review guide explains the image-size limit.
	for _, product := range []string{"chatgpt", "custom"} {
		source := requestSource{origin: object{"controlSource": product}, profile: object{"product": product}, policy: "all"}
		common, review := testGuide(source, object{}), testGuide(source, object{"topic": "review"})
		for _, guide := range []object{common, review} {
			ops := guide["ops"].([]object)
			if !slices.ContainsFunc(ops, func(spec object) bool { return spec["op"] == "read" }) {
				t.Fatalf("%s guide omitted image reads", product)
			}
		}
		if !strings.Contains(text(review, "content"), "maxEdge") {
			t.Fatalf("%s review guide omits maxEdge", product)
		}
	}
}

func TestDefaultGuideBudgetAndProgressiveSignatures(t *testing.T) {
	// Contract: default guide fits the MCP byte budget and exposes signatures on full and per-operation reads.
	policies := []object{
		{"name": "local-code", "transport": "cli", "hostAccess": "host", "waitMode": "background-cli"},
		{"name": "remote-push", "transport": "mcp", "hostAccess": "unknown", "waitMode": "push"},
		{"name": "remote-polling", "transport": "mcp", "hostAccess": "unknown", "waitMode": "poll"},
	}
	for _, profile := range policies {
		profile["provenance"] = "source-override"
		origin := object{"sourceId": "00000000-0000-4000-8000-000000000001", "controlTransport": profile["transport"], "controlSource": "chatgpt"}
		var scoped []object
		for _, row := range guideSpecs() {
			scoped = append(scoped, sourceSpec(row, origin))
		}
		for flags := range 8 {
			value := finishGuide(origin, object{}, renderGuide(origin, object{}, scoped, profile,
				guideFeatures{maintainer: flags&1 != 0, context: flags&2 != 0, hub: flags&4 != 0}))
			reply := egressTool(clone(value), false)
			reply["resultType"] = "complete"
			bytes := len(wire(object{"jsonrpc": "2.0", "id": 1, "result": reply}))
			entries := value["ops"].([]object)
			if bytes > 4000 || len(entries) != 13 {
				t.Fatalf("%s default guide = %d bytes and %d entries", profile["name"], bytes, len(entries))
			}
			for _, op := range entries {
				name := text(op, "op")
				perOp := testGuide(requestSource{}, object{"op": name})
				if op["signature"] != nil || (op["via"] != "query" && op["via"] != "act") ||
					!strings.HasPrefix(text(perOp, "signature"), name+"(") {
					t.Fatalf("per-operation discovery for %s = %v", name, perOp)
				}
			}
		}
	}
	full := testGuide(requestSource{}, object{"view": "full"})
	for _, op := range full["ops"].([]object) {
		if !strings.HasPrefix(text(op, "signature"), text(op, "op")+"(") {
			t.Fatalf("full guide signature = %v", op)
		}
	}
}

func TestReviewNoteAcceptsEvidenceForSeveralInvariants(t *testing.T) {
	// Contract: review notes accept 4000 characters so callers can retain evidence for multiple invariants.
	for _, name := range []string{"codex_review", "agent_review"} {
		args := object{"threadId": "fixture", "verdict": "pass"}
		if name == "agent_review" {
			args = object{"agent": "pi", "taskId": "fixture", "verdict": "pass"}
		}
		schema := operation(name)["inputSchema"]
		args["note"] = strings.Repeat("x", 4000)
		if failure := checkSchema("op", name, name, schema, args); failure != nil {
			t.Fatalf("%s accepts 4000 characters: %v", name, failure)
		}
		args["note"] = strings.Repeat("x", 4001)
		if failure := checkSchema("op", name, name, schema, args); failure == nil || !strings.Contains(text(failure, "message"), "4000") {
			t.Fatalf("%s rejects 4001 characters: %v", name, failure)
		}
	}
}

func TestCommandValidationLinksToCorrectFieldContract(t *testing.T) {
	// Contract: invalid command timing and output limits produce recoverable schema validation with the relevant field.
	spec := operation("command")
	for _, key := range []string{"outputBudget", "waitMs"} {
		limit := uintOr(field(field(field(spec["inputSchema"], "properties"), key), "maximum"), 0)
		args := object{"cmd": "true", "cwd": "/fixture", key: limit + 1}
		invalid := checkSchema("op", "command", "command", spec["inputSchema"], args)
		value := object{"error": invalid}
		nextControl(value, "command", args, false)
		out, err := egressToolValue(egressTool(value, true))
		next := field(out, "next")
		if err != nil || field(field(out, "error"), "code") != "INVALID_ARGUMENTS" || field(field(out, "error"), "field") != "/"+key ||
			field(next, "via") != "query" || field(next, "op") != "guide" || field(field(next, "args"), "op") != "command" ||
			!strings.Contains(text(next, "hint"), key) || !strings.Contains(text(next, "hint"), strconv.FormatUint(limit, 10)) {
			t.Fatalf("%s validation = %v, %v", key, out, err)
		}
	}
	value := object{"error": controlFailure(errors.New("RPC_REJECTED: command failed"))}
	nextControl(value, "command", nil, false)
	if field(field(value["next"], "args"), "op") != "command" {
		t.Fatal(value)
	}
}

func TestAXTriageGuideNamesAcceptedEvidenceReceipts(t *testing.T) {
	// Contract: AX triage discovery identifies the accepted operation receipts for verification.
	guide := testGuide(requestSource{}, object{"op": "ax_triage"})
	describe := field(field(field(guide["inputSchema"], "properties"), "evidenceIds"), "description")
	for _, op := range []string{"command", "review", "native", "agent_review"} {
		if !strings.Contains(text(guide, "description"), op) || !strings.Contains(str(describe), op) {
			t.Fatalf("AX verification guide omitted %s", op)
		}
	}
}

func TestCoordinationGuidesDiscloseAcceptedResourceForms(t *testing.T) {
	// Contract: clients can discover the supported coordination resource namespaces in every applicable schema.
	for name, key := range map[string]string{"events": "resource", "ax_report": "resources", "ax_list": "resource", "board": "resource",
		"notice_post": "resources", "notice_update": "resources", "blocker_open": "resources", "message_send": "resources"} {
		guide := testGuide(requestSource{}, object{"op": name})
		properties := field(guide["inputSchema"], "properties")
		descriptions := []string{text(field(properties, key), "description")}
		if name == "message_send" {
			condition := field(field(properties, "conditions"), "items")
			descriptions = append(descriptions, text(field(field(condition, "properties"), "resource"), "description"))
		}
		for _, message := range descriptions {
			for _, form := range []string{"app:installed", "project:<id>/main", "lane:<project>/<name>", "host:<id>", "isolated:<id>"} {
				if !strings.Contains(message, form) {
					t.Fatalf("%s resource schema omits %s", name, form)
				}
			}
		}
	}
}

func TestPublicCreationReceiptsExplainTitleFallback(t *testing.T) {
	// Contract: titleless dispatch receipts explain the chosen naming rule without exposing original prompts.
	for _, op := range []string{"create", "agent_create"} {
		for _, title := range []any{nil, "  ", "Review project"} {
			out := publicReceipt(object{"requestId": "r", "state": "completed", "operation": op,
				"arguments": object{"title": title, "prompt": "Private prompt"}, "result": object{"thread": object{"id": "new-thread"}}})
			hint := obj(out["titleHint"])
			if (hint["code"] == "TITLE_FROM_PROMPT") != (title != "Review project") || out["arguments"] != nil {
				t.Fatalf("title fallback for %s = %v", op, out)
			}
			if op == "create" && title != "Review project" {
				rename := hint["rename"]
				if field(rename, "op") != "codex_thread" || text(field(field(rename, "args"), "params"), "threadId") != "new-thread" {
					t.Fatalf("rename = %v", rename)
				}
			}
		}
	}
	for _, method := range []string{"thread/start", "thread/fork", "turn/start"} {
		out := publicReceipt(object{"requestId": "r", "state": "completed", "operation": "native", "arguments": object{"method": method}})
		if (field(out["titleHint"], "code") == "NATIVE_THREAD_TITLE") != (method != "turn/start") {
			t.Fatalf("native title hint for %s = %v", method, out)
		}
	}
	for _, row := range []object{{"requestId": "r", "state": "completed", "operation": "send", "arguments": object{}},
		{"requestId": "r", "state": "held", "operation": "agent_create", "heldForUpdate": true}} {
		if out := publicReceipt(row); out["titleHint"] != nil {
			t.Fatalf("unexpected title hint: %v", out)
		}
	}
}

func TestCoordinationTopicExposesRegistrationAndRouteRepair(t *testing.T) {
	// Contract: coordination registration and route repair are discoverable with current request arguments.
	reliablePush := regexp.MustCompile(`(?i)MUST NOT close[^.]*push`)
	for _, name := range []string{"claude", "chatgpt", "other"} {
		source := requestSource{origin: object{"controlSource": name}}
		topic := testGuide(source, object{"topic": "coordination"})
		for _, op := range []string{"coordination_session", "message_route"} {
			if !slices.ContainsFunc(topic["ops"].([]object), func(record object) bool { return record["op"] == op && record["via"] == "act" }) {
				t.Fatalf("%s coordination guide omits %s", name, op)
			}
		}
		content := text(topic, "content")
		if !strings.Contains(content, `coordination_session({action:"register",target})`) || !reliablePush.MatchString(content) ||
			!strings.Contains(content, "untrusted") {
			t.Fatalf("%s coordination discovery does not explain registration and push", name)
		}
		schema := testGuide(source, object{"op": "coordination_session"})["inputSchema"]
		if text(field(field(schema, "properties"), "target"), "type") != "string" || slices.Contains(arr(field(schema, "required")), "target") {
			t.Fatalf("coordination registration schema = %v", schema)
		}
	}
}

func TestSelfTestArchiveRemainsOptionalInGuides(t *testing.T) {
	// Contract: the archival operation guide and full workflow keep self-test cleanup optional.
	optional := regexp.MustCompile(`(?i)archiv[^.\n]*optional`)
	for _, name := range []string{"claude", "chatgpt", "other"} {
		source := requestSource{origin: object{"controlSource": name}}
		for _, args := range []object{{"op": "codex_archive"}, {"view": "full"}} {
			guide := testGuide(source, args)
			content := metricString(guide["content"], text(guide, "description"))
			if !optional.MatchString(content) {
				t.Fatalf("%s %v omitted optional archive guidance", name, args)
			}
		}
	}
}

func TestInterruptedTurnsSucceedWhileCancelledOperationsFail(t *testing.T) {
	// Contract: interrupted terminal readbacks succeed while cancelled operations retain a public error.
	turn := object{"state": "cancelled", "stateScope": "turn", "recordedStatus": "interrupted", "threadId": "thread", "turnId": "turn"}
	if outcomeError(turn) != nil || egressTool(maps.Clone(turn), false)["isError"] != false {
		t.Fatalf("turn interruption = %v", turn)
	}
	turn["stateScope"], turn["operation"] = "operation", "send"
	if failure := outcomeError(turn); failure["code"] != "OPERATION_FAILED" || egressTool(turn, false)["isError"] != true {
		t.Fatalf("cancelled operation = %v", failure)
	}
}

func TestGeneratedContinuationsMatchOperationSchemas(t *testing.T) {
	// Recurring bug class: retry-replay writer recovery and wait continuations used invalid input fields or null IDs.
	for _, name := range []string{"codex_read", "codex_wait", "codex_send", "agent_read", "agent_wait", "agent_send", "receipt"} {
		for _, state := range []string{"running", "timeout", "unconfirmed", "failed", "rejected", "cancelled", "not-executed", "awaiting-approval", "interaction-required", "completed"} {
			for _, turn := range []any{nil, "turn"} {
				args := object{"agent": "pi", "threadId": "00000000-0000-4000-8000-000000000001", "taskId": "00000000-0000-4000-8000-000000000003", "turnId": turn}
				value := maps.Clone(args)
				value["state"], value["requestId"] = state, "00000000-0000-4000-8000-000000000002"
				nextControl(value, name, args, false)
				next := obj(value["next"])
				if outcomeError(value) != nil && next == nil {
					t.Fatalf("missing %s %s continuation", name, state)
				}
				if op := text(next, "op"); op != "" {
					schema := operation(op)["inputSchema"]
					if invalid := checkSchema("next-regression", op, op, schema, next["args"]); invalid != nil {
						t.Fatalf("%s %s invalid continuation = %v", name, state, invalid)
					}
				}
			}
		}
	}
}

func TestInterfaceRecoveryNamesExactOperation(t *testing.T) {
	// Contract: thread owner discovery, command lifetime, and pending execution each provide the current recovery operation.
	thread := "thread-fixture"
	timeout := controlFailure(errors.New("DESKTOP_REQUEST_TIMEOUT: thread-owner-discovery"))
	for _, value := range []object{{"error": timeout}, {"threadId": thread, "error": timeout}} {
		nextControl(value, "codex_read", object{"threadId": thread}, false)
		if text(value["next"], "op") != "codex_owner" || text(field(value["next"], "args"), "threadId") != thread {
			t.Fatalf("owner recovery = %v", value)
		}
	}
	command := object{"error": controlFailure(errors.New("RPC_TIMEOUT: command/exec"))}
	nextControl(command, "command", nil, false)
	if text(field(command["next"], "args"), "op") != "process" {
		t.Fatalf("command recovery = %v", command)
	}
	running := object{"state": "executing", "requestId": "original-request"}
	nextControl(running, "command", nil, false)
	if text(running["next"], "op") != "receipt" || text(field(running["next"], "args"), "requestId") != "original-request" {
		t.Fatalf("executing recovery = %v", running)
	}
}

func TestWriterRejectionExplainsNativeOwnership(t *testing.T) {
	// Recurring bug class: concurrency native active-writer rejection did not expose a safe owner discovery step.
	for _, message := range []string{`RPC_REJECTED:{"message":"thread already has an active writer"}`,
		`RPC_REJECTED:{"code":-32600,"message":"thread 00000000-0000-4000-8000-000000000001 already has an active writer"}`,
		`THREAD_LOAD_FAILED: desktop=DESKTOP_REJECTED:"no-client-found"; app-server=RPC_REJECTED:{"message":"thread 00000000-0000-4000-8000-000000000001 already has an active writer"}`} {
		error := controlFailure(errors.New(message))
		if error["code"] != "THREAD_WRITER_BUSY" || error["retryable"] != false || field(error["next"], "op") != "guide" || error["nativeError"] != nil {
			t.Fatalf("writer rejection = %v", error)
		}
	}
}

func TestProtocolVersionTracksVisibleContract(t *testing.T) {
	// Algorithmic core: the protocol hash tracks user-visible contracts independently of internal catalog ordering and metadata.
	original := catalog()
	want := protocolHash(original)
	modified := clone(original)
	modified["toolExposure"], modified["domains"] = object{"internal": "changed"}, []any{}
	if protocolHash(modified) != want {
		t.Fatal("internal descriptor changed protocol version")
	}
	slices.Reverse(arr(modified["ops"]))
	if protocolHash(modified) != want {
		t.Fatal("registration order changed protocol version")
	}
	for _, key := range []string{"description", "inputSchema", "guideParameters", "example"} {
		modified = clone(original)
		var value any = "changed"
		switch key {
		case "guideParameters":
			value = []any{"op"}
		case "inputSchema":
			value = object{"type": "object", "properties": object{"new": object{"type": "string"}}}
		}
		obj(arr(modified["ops"])[0])[key] = value
		if protocolHash(modified) == want {
			t.Fatalf("visible %s did not change protocol version", key)
		}
	}
	modified = clone(original)
	obj(field(modified["guides"], "en"))["remote-push"] = json.Number("17")
	if protocolHash(modified) == want {
		t.Fatal("guide content did not change protocol version")
	}
}
