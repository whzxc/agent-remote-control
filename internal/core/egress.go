package core

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
)

func operation(name string) object { return find(catalog()["ops"], "name", name) }

func via(spec object) string {
	if field(spec["annotations"], "readOnlyHint") == true {
		return "query"
	}
	return "act"
}

func opTools(spec object) any {
	if tools, exists := spec["tools"]; exists {
		return tools
	}
	return via(spec)
}

func example(spec object) object {
	tool := via(spec)
	if spec["name"] == "device" {
		tool = "query"
	}
	return object{"tool": tool, "arguments": object{"op": spec["name"], "args": spec["example"]}}
}

func signature(op object) string {
	schema := obj(op["inputSchema"])
	properties := obj(schema["properties"])
	required := arr(schema["required"])
	names := []string{}
	if provided := arr(op["guideParameters"]); provided != nil {
		for _, name := range provided {
			names = append(names, str(name))
		}
	} else {
		names = keys(properties)
	}
	for _, need := range required {
		if !slices.Contains(names, str(need)) {
			names = append(names, str(need))
		}
	}
	params := make([]string, 0, len(names))
	for _, name := range names {
		param := name
		if !slices.Contains(required, any(name)) {
			param += "?"
		}
		property := obj(properties[name])
		choices := []string{}
		for _, choice := range arr(property["enum"]) {
			if s, ok := choice.(string); ok {
				choices = append(choices, s)
			} else {
				choices = append(choices, wire(choice))
			}
		}
		if enum := strings.Join(choices, "|"); len(choices) > 0 && len(enum) <= 80 {
			param += ":" + enum
		} else if uintOr(property["minLength"], 0) == 1 {
			param += "(≥1 char)"
		} else if name == "timeoutMs" && isWaitOp(text(op, "name")) && property["maximum"] != nil {
			param += "≤" + wire(property["maximum"])
		}
		params = append(params, param)
	}
	variants := arr(schema["oneOf"])
	if variants == nil {
		variants = arr(schema["anyOf"])
	}
	branches := []string{}
	for _, branch := range variants {
		if required := arr(field(branch, "required")); required != nil {
			names := []string{}
			for _, name := range required {
				names = append(names, str(name))
			}
			branches = append(branches, strings.Join(names, "+"))
		}
	}
	result := text(op, "name") + "(" + strings.Join(params, ", ") + ")"
	if variants := strings.Join(branches, " | "); variants != "" {
		result += " [" + variants + "]"
	}
	return result
}

func retryContract(op object) object {
	if via(op) == "query" {
		return object{"mode": "read-only"}
	}
	switch text(op, "name") {
	case "device_transfer":
		return object{"mode": "receipt", "key": "requestId", "instruction": "Reissuing the same requestId reads its receipt without writing. Use device_transfer action:resume with the original requestId to explicitly continue from the receiver verified offset; action:cancel removes its temporary file. Never automatically retry a failed write."}
	case "device":
		return object{"mode": "receipt", "key": "requestId", "appliesTo": "act", "query": object{"mode": "read-only"}, "instruction": "Use query for member reads. Retain an act requestId. After an uncertain outcome read the member receipt through act device; never resend a sent write."}
	case "receipt":
		return object{"mode": "original-receipt", "key": "requestId", "instruction": "Read the original requestId. Do not replay approval or rejection blindly."}
	case "codex_create", "codex_send", "codex_resume", "codex_archive", "codex_release", "codex_review", "notice_post",
		"notice_update", "notice_close", "blocker_open", "blocker_clear", "coordination_session", "message_send",
		"ax_report", "ax_candidate", "ax_triage", "codex_interrupt", "codex_respond", "codex_call", "agent_create", "agent_send",
		"agent_review", "agent_archive", "agent_interrupt", "agent_respond", "command", "fs", "process", "mcp", "codex_thread", "edit", "write", "git_write":
		return object{"mode": "receipt", "key": "requestId", "callerGenerated": false, "serverGeneratedWhenOmitted": true,
			"instruction": "requestId is optional. Retain the returned receipt requestId and reuse it with identical arguments. For retry safety before receiving a response, supply a UUID on the first attempt. After timeout, read the original receipt; if its generated ID was lost, inspect task/resource state instead of blindly replaying. unconfirmed is not permission to submit again."}
	default:
		return object{"mode": "read-back", "automaticRetry": false,
			"instruction": "No ARC receipt replay protection. Read current state or the upstream result before retrying a side effect. An outer act requestId does not add replay protection."}
	}
}

func eventGuide() object {
	filter := object{"type": "string", "minLength": 1}
	taskSchema := object{"type": "object", "properties": object{"threadId": filter, "taskId": filter}, "additionalProperties": false}
	return object{
		"event": "notification",
		"inputSchema": object{"type": "object", "properties": object{"op": object{"type": "string"}, "args": object{"type": "object"}},
			"required": []string{"op", "args"}, "additionalProperties": false},
		"ops": []object{{"op": "task_status",
			"description": "Task completed, failed (including interrupted tasks), stalled, or needs execution input/approval; only tasks dispatched through this source. Lifecycle and ownership events remain inbox-only. Empty args watches all such tasks; both filters must match when supplied.",
			"inputSchema": taskSchema, "example": object{"name": "notification", "arguments": object{"op": "task_status", "args": object{}}}}},
	}
}

var arcVersion = sync.OnceValue(func() string { return protocolHash(catalog()) })

func protocolHash(current object) string {
	ops := []object{}
	for _, row := range arr(current["ops"]) {
		op := obj(row)
		ops = append(ops, object{"op": op["name"], "via": opTools(op), "description": op["description"],
			"inputSchema": op["inputSchema"], "signature": signature(op), "example": example(op)})
	}
	slices.SortFunc(ops, func(a, b object) int { return strings.Compare(text(a, "op"), text(b, "op")) })
	return hash([]byte(wire(object{"tools": current["tools"], "instructions": current["instructions"], "guides": current["guides"], "ops": ops, "events": eventGuide()})))[:12]
}

func aliases(name string) (alias, canonical string) {
	switch name {
	case "git", "git_write":
		return "action", "operation"
	case "read":
		return "limit", "lineCount"
	}
	return "", ""
}

func isWaitOp(name string) bool {
	switch name {
	case "codex_wait", "agent_wait", "inbox_wait":
		return true
	}
	return false
}

func sourceSpec(op, origin object) object {
	name := text(op, "name")
	alias, canonical := aliases(name)
	if alias == "" && !isWaitOp(name) {
		return op
	}
	op = clone(op)
	schema := obj(op["inputSchema"])
	props := obj(schema["properties"])
	if alias != "" {
		delete(props, alias)
		if name == "git" || name == "git_write" {
			delete(schema, "anyOf")
			schema["required"] = append(arr(schema["required"]), canonical)
		}
	}
	if isWaitOp(name) {
		limit, capped := uintValue(sourcePreset(text(origin, "controlSource"))["waitTimeoutMs"])
		if !capped {
			limit = 1800000
		}
		timeout := obj(props["timeoutMs"])
		timeout["description"] = fmt.Sprintf("Wait up to %dms per call. On timeout follow next.args with the same IDs and expectedHash. Transport heartbeats do not extend the client deadline.", limit)
		op["description"] = strings.ReplaceAll(text(op, "description"), "Claude waits are capped at 170000 milliseconds and return waitLimit when exceeded. ", "")
		if capped {
			timeout["maximum"] = limit
			if uintOr(field(op["example"], "timeoutMs"), 0) > limit {
				obj(op["example"])["timeoutMs"] = limit
			}
		}
	}
	return op
}

func egressGuide(source requestSource, args object, ops []object) object {
	var result object
	if name, ok := args["op"].(string); ok {
		spec := sourceSpec(operation(name), source.origin)
		result = object{"op": name, "via": opTools(spec), "description": spec["description"], "inputSchema": spec["inputSchema"], "signature": signature(spec), "example": example(spec), "retry": retryContract(spec)}
	} else {
		scoped := make([]object, 0, len(ops))
		for _, op := range ops {
			scoped = append(scoped, sourceSpec(op, source.origin))
		}
		result = renderGuide(source.origin, args, scoped, effectiveProfile(source.origin, source.profile, source.local),
			guideFeatures{maintainer: readPreferences()["maintainer-mode"] == "on", context: contextProviderConfigured(), hub: readPreferences()["mcp-services"] == "on"})
	}
	return finishGuide(source.origin, args, result)
}

func finishGuide(origin, args, result object) object {
	result["cliPath"] = cliExecutable()
	if origin["controlTransport"] == "cli" {
		result["sourceId"] = origin["sourceId"]
	}
	digest := hash([]byte(wire(result)))
	if args["knownGuideHash"] == digest {
		return object{"guideHash": digest, "unchanged": true, "cliPath": result["cliPath"]}
	}
	result["guideHash"] = digest
	return result
}

var validators sync.Map

func validator(scope, name string, schema any) (*jsonschema.Schema, error) {
	key := scope + ":" + name
	if cached, ok := validators.Load(key); ok {
		return cached.(*jsonschema.Schema), nil
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft7)
	// Rust jsonschema treats uuid as an unknown format in Draft 7. Patterns
	// and the operation's own identity checks still enforce required UUIDs.
	if draft := text(schema, "$schema"); draft == "" || strings.Contains(draft, "draft-07") {
		compiler.RegisterFormat(&jsonschema.Format{Name: "uuid", Validate: func(any) error { return nil }})
	}
	address := "https://arc.invalid/" + url.PathEscape(scope) + "/" + url.PathEscape(name)
	if err := compiler.AddResource(address, schema); err != nil {
		return nil, err
	}
	result, err := compiler.Compile(address)
	if err != nil {
		return nil, err
	}
	cached, _ := validators.LoadOrStore(key, result)
	return cached.(*jsonschema.Schema), nil
}

func invalidArguments(op, field, message string) object {
	args := object{}
	var sig any
	if op != "" {
		args["op"] = op
	}
	if spec := operation(op); spec != nil {
		sig = signature(spec)
	}
	return object{"code": "INVALID_ARGUMENTS", "op": op, "field": field, "message": message, "signature": sig,
		"guide": object{"tool": "query", "arguments": object{"op": "guide", "args": args}}}
}

func distance(a, b string) int {
	right := []rune(b)
	row := make([]int, len(right)+1)
	for i := range row {
		row[i] = i
	}
	for i, left := range []rune(a) {
		diagonal := row[0]
		row[0] = i + 1
		for j, ch := range right {
			old := row[j+1]
			substitution := diagonal
			if left != ch {
				substitution++
			}
			row[j+1] = min(old+1, row[j]+1, substitution)
			diagonal = old
		}
	}
	return row[len(right)]
}

func unknownOp(name string, ops []object) object {
	candidates := make([]string, 0, len(ops))
	for _, op := range ops {
		candidates = append(candidates, text(op, "name"))
	}
	slices.SortFunc(candidates, func(a, b string) int {
		if delta := distance(name, a) - distance(name, b); delta != 0 {
			return delta
		}
		return strings.Compare(a, b)
	})
	return object{"code": "UNKNOWN_OP", "op": name, "message": "Call query guide with view:full for the enabled op index, then query({op: \"guide\", args: {op: \"<name>\"}}) for its schema (also works with a cached guide schema).", "candidates": candidates[:min(3, len(candidates))]}
}

func validationError(op string, schema any, err *jsonschema.ValidationError) object {
	fieldPath := ""
	for _, part := range err.InstanceLocation {
		fieldPath += "/" + strings.ReplaceAll(strings.ReplaceAll(part, "~", "~0"), "/", "~1")
	}
	message := "Value does not satisfy this field's schema; see guide."
	switch k := err.ErrorKind.(type) {
	case *kind.Required:
		fieldPath += "/" + k.Missing[0]
		message = "Required field is missing."
	case *kind.AdditionalProperties:
		names := slices.Clone(k.Properties)
		slices.Sort(names)
		name := names[0]
		fieldPath += "/" + name
		message = "Unknown field; see guide for supported parameters."
		properties := obj(field(schema, "properties"))
		if _, fragment, ok := strings.Cut(err.SchemaURL, "#"); ok {
			parent := strings.TrimSuffix(fragment, "/additionalProperties")
			if parent != "" {
				var node any = schema
				for _, segment := range strings.Split(strings.TrimPrefix(parent, "/"), "/") {
					node = field(node, strings.ReplaceAll(strings.ReplaceAll(segment, "~1", "/"), "~0", "~"))
				}
				if nested := obj(field(node, "properties")); nested != nil {
					properties = nested
				}
			}
		}
		best := 4
		for _, key := range keys(properties) {
			if d := distance(name, key); d < best {
				best = d
				message = "Unknown field; did you mean " + key + "?"
			}
		}
		if name == "order" && op == "codex_items" {
			message = "Unknown field; did you mean latest?"
		}
	case *kind.Type:
		expected := wire(k.Want[0])
		if len(k.Want) > 1 {
			expected = wire(k.Want)
		}
		received := k.Got
		if received == "integer" {
			received = "number"
		}
		message = fmt.Sprintf("value is not of type %s; received JSON type %s.", expected, received)
	case *kind.Enum:
		message = "Expected one of " + wire(k.Want) + "."
	case *kind.Const:
		message = "Expected " + wire(k.Want) + "."
	case *kind.MinLength:
		message = fmt.Sprintf("Must contain at least %d characters.", k.Want)
	case *kind.MaxLength:
		message = fmt.Sprintf("Must contain at most %d characters.", k.Want)
	case *kind.MinItems:
		message = fmt.Sprintf("Must contain at least %d items.", k.Want)
	case *kind.MaxItems:
		message = fmt.Sprintf("Must contain at most %d items.", k.Want)
	case *kind.Maximum:
		limit, _ := k.Want.Float64()
		message = fmt.Sprintf("Must be at most %g.", limit)
	case *kind.Minimum:
		limit, _ := k.Want.Float64()
		message = fmt.Sprintf("Must be at least %g.", limit)
	case *kind.ExclusiveMaximum:
		limit, _ := k.Want.Float64()
		message = fmt.Sprintf("Must be less than %g.", limit)
	case *kind.ExclusiveMinimum:
		limit, _ := k.Want.Float64()
		message = fmt.Sprintf("Must be greater than %g.", limit)
	case *kind.Format:
		message = "Expected " + k.Want + " format."
	case *kind.Pattern:
		message = "Value does not match the required format."
	case *kind.Not:
		message = "Conflicting parameters; use one form from guide."
	case *kind.OneOf:
		if len(k.Subschemas) > 1 {
			message = "Conflicting parameters; use one form from guide."
		} else {
			message = "Parameters do not match a supported form; see guide."
		}
	case *kind.AnyOf:
		message = "Parameters do not match a supported form; see guide."
	default:
		if len(err.Causes) > 0 {
			return validationError(op, schema, err.Causes[0])
		}
	}
	if fieldPath == "" {
		fieldPath = "/"
	}
	return invalidArguments(op, fieldPath, message)
}

func checkSchema(scope, name, op string, schema, args any) object {
	validator, err := validator(scope, name, schema)
	if err == nil {
		if err = validator.Validate(args); err == nil {
			return nil
		}
	}
	if detail, ok := err.(*jsonschema.ValidationError); ok {
		return validationError(op, schema, detail)
	}
	return object{"code": "CONTROL_ERROR", "message": err.Error(), "rpcError": nil}
}

func normalizeArgs(name string, args object) object {
	alias, canonical := aliases(name)
	if value, found := args[alias]; alias != "" && found {
		if other, exists := args[canonical]; exists && wire(value) != wire(other) {
			return invalidArguments(name, "/"+alias, "Must equal "+canonical+" when both are supplied.")
		}
		delete(args, alias)
		args[canonical] = value
	}
	if name == "search" && uintOr(args["limit"], 0) > 50 {
		args["limit"] = 50
	}
	return nil
}

func egressTool(value object, failed bool) object {
	if reason := outcomeError(value); reason != nil {
		value["error"], failed = reason, true
	}
	if failed {
		compactOutcomeError(value)
	}
	value["arcVersion"] = arcVersion()
	return object{"content": []any{object{"type": "text", "text": wire(value)}}, "isError": failed}
}

func errorNext(op string, failure object) object {
	if next := obj(failure["next"]); next != nil {
		delete(failure, "next")
		return next
	}
	args := object{}
	if failure["code"] == "INVALID_ARGUMENTS" {
		if name, ok := failure["op"].(string); ok {
			op = name
		}
		if op != "" {
			args["op"] = op
		}
		return object{"via": "query", "op": "guide", "args": args, "hint": fmt.Sprintf("%s: %s", text(failure, "field"), text(failure, "message"))}
	}
	if operation(op) != nil {
		args["op"] = op
	}
	return object{"via": "query", "op": "guide", "args": args, "hint": "Read the current operation contract, correct the reported cause, then retry only when its outcome is known."}
}

func egressFailure(op string, failure object) object {
	failure = maps.Clone(failure)
	return egressTool(object{"error": failure, "next": errorNext(op, failure)}, true)
}

func dispatchReceipt(value object) bool {
	switch text(value, "operation") {
	case "create", "send", "agent_create", "agent_send":
		return true
	}
	return false
}

func publicReceipt(value object) object {
	if _, ok := value["requestId"].(string); !ok {
		return value
	}
	if _, ok := value["state"].(string); !ok {
		return value
	}
	value = projectReceipt(maps.Clone(value), true, time.Now().UnixMilli())
	out := selectFields(value, "requestId", "coordination", "replayed", "createdAt", "updatedAt", "dispatchMode",
		"message", "queueId", "state", "submissionState", "executionState", "phaseAgeMs", "progressStalled",
		"progress", "operation", "threadId", "turnId", "taskId", "agent", "error", "notification",
		"notificationError", "executionOwner", "submissionStage", "failureStage", "cleanup", "next")
	for key, data := range out {
		if data == nil {
			delete(out, key)
		}
	}
	if recovery := obj(value["desktopRecovery"]); recovery != nil {
		out["desktopRecovery"] = object{"state": recovery["state"], "decisionId": recovery["decisionId"],
			"reason": recovery["reason"], "transport": recovery["transport"], "backend": recovery["backend"],
			"targetPid": field(recovery["target"], "pid")}
	}
	if by, ok := value["answeredBy"]; ok {
		out["answeredBy"] = by
	} else if by, ok := obj(value["approval"])["answeredBy"]; ok {
		out["answeredBy"] = by
	}
	if origin := obj(value["origin"]); origin != nil {
		fields := object{}
		for _, key := range []string{"ingressId", "sourceId", "accountId", "sourceLabel", "controlSource", "authType", "deviceId"} {
			if text, ok := origin[key].(string); ok {
				fields[key] = text
			}
		}
		if peer, ok := origin["peerOrigin"]; ok {
			fields["peerOrigin"] = peer
		}
		out["origin"] = fields
	}
	out["stateScope"] = "operation"
	if dispatch := obj(field(value["task"], "dispatch")); dispatch != nil {
		out["dispatch"] = dispatch
	}
	result, hasResult := value["result"]
	for _, key := range []string{"threadId", "turnId", "taskId"} {
		if item := field(result, key); out[key] == nil && item != nil {
			out[key] = item
		}
	}
	for _, key := range []string{"thread", "turn"} {
		if item, ok := field(field(result, key), "id").(string); out[key+"Id"] == nil && ok {
			out[key+"Id"] = item
		}
	}
	name, args := text(value, "operation"), obj(value["arguments"])
	switch {
	case (name == "create" || name == "agent_create") && args != nil && strings.TrimSpace(text(args, "title")) == "":
		hint := object{"code": "TITLE_FROM_PROMPT", "message": "No non-blank title was supplied. The task title falls back to the first non-empty prompt line, truncated to 120 characters. Pass title next time: a short human-readable task title shown in task lists and notifications."}
		if name == "create" {
			thread, ok := out["threadId"].(string)
			if !ok {
				thread = "<created threadId>"
			}
			hint["rename"] = object{"via": "act", "op": "codex_thread", "args": object{"action": "name/set", "params": object{"threadId": thread, "name": "<short task title>"}}}
		}
		out["titleHint"] = hint
	case name == "native" && slices.Contains([]string{"thread/start", "thread/fork"}, text(args, "method")):
		out["titleHint"] = object{"code": "NATIVE_THREAD_TITLE", "message": "This native operation uses native thread metadata without an ARC title argument. Set a short human-readable name of at most 120 characters with codex_thread action:name/set and params:{threadId:<returned threadId>,name:<title>}. Prefer codex_create with title for prompt dispatch."}
	}
	if fields := obj(result); fields != nil {
		fields = maps.Clone(fields)
		for _, key := range []string{"threadId", "turnId", "taskId"} {
			if out[key] != nil {
				delete(fields, key)
			}
		}
		for _, key := range []string{"arguments", "params", "prompt", "input", "digest", "origin", "backendSession", "resolved", "task", "thread", "turn", "native"} {
			delete(fields, key)
		}
		if name == "create" || name == "send" || name == "interrupt" || strings.HasPrefix(name, "agent_") && name != "agent_archive" {
			fields = selectFields(fields, "threadId", "turnId", "taskId", "sessionId", "desktop", "desktopUrl",
				"submitted", "accepted", "responseSent", "status", "output", "outputTruncated", "error", "stopReason",
				"dispatch", "review", "promptSubmitted", "configurationError", "configurationState", "sessionConfirmation", "turnEvidence")
		}
		if len(fields) != 0 {
			out["result"] = fields
		}
	} else if hasResult {
		out["result"] = result
	}
	if !dispatchReceipt(out) {
		delete(out, "notification")
		delete(out, "notificationError")
	}
	return out
}

func interruptedTurn(value object) bool {
	return value["state"] == "cancelled" && value["stateScope"] != "operation" && value["operation"] == nil &&
		(value["stateScope"] == "turn" || value["recordedStatus"] == "interrupted" || value["recordedStatus"] == "cancelled")
}

func outcomeError(value object) object {
	for depth := 0; depth < 8 && value != nil; depth++ {
		state := text(value, "state")
		failed := slices.Contains([]string{"failed", "rejected", "not-executed", "cancelled", "unconfirmed", "rolled-back"}, state)
		if failed && !interruptedTurn(value) || value["ok"] == false {
			reason := value["error"]
			if reason == nil {
				reason = field(value["result"], "error")
			}
			var failure object
			switch reason := reason.(type) {
			case object:
				failure = maps.Clone(reason)
			case string:
				failure = object{"message": reason}
			case nil:
				message, ok := value["reason"].(string)
				if !ok {
					message = "Operation outcome: " + state
				}
				failure = object{"message": message}
			default:
				failure = object{"message": wire(reason)}
			}
			if _, ok := failure["code"].(string); !ok {
				failure["code"] = "OPERATION_FAILED"
				if state == "unconfirmed" {
					failure["code"] = "OPERATION_UNCONFIRMED"
				}
			}
			if state != "" {
				failure["outcome"] = state
			}
			if code, err := strconv.ParseInt(wire(value["exitCode"]), 10, 64); err == nil && code != 0 {
				failure["exitCode"] = value["exitCode"]
			}
			return failure
		}
		if result, ok := value["result"]; ok {
			value = obj(result)
		} else {
			value = obj(value["lastResult"])
		}
	}
	return nil
}

func stripOutcomeDuplicate(value object, code string, depth int) {
	if depth == 0 || value == nil {
		return
	}
	if code != "" && text(value["error"], "code") == code {
		delete(value, "error")
	}
	for _, key := range []string{"result", "lastResult"} {
		stripOutcomeDuplicate(obj(value[key]), code, depth-1)
	}
}

func compactOutcomeError(value object) {
	failure := outcomeError(value)
	if failure == nil {
		failure = maps.Clone(obj(value["error"]))
	}
	if failure == nil {
		return
	}
	if value["next"] == nil && obj(failure["next"]) != nil {
		value["next"] = failure["next"]
	}
	delete(failure, "next")
	if rpc := obj(failure["rpcError"]); rpc != nil {
		if message, ok := rpc["message"].(string); ok {
			failure["message"] = message
			delete(rpc, "message")
		}
	}
	for _, key := range []string{"result", "lastResult"} {
		stripOutcomeDuplicate(obj(value[key]), text(failure, "code"), 8)
	}
	value["error"] = failure
}

func receiptNext(value, args object) {
	nextControl(value, text(value, "operation"), args, false)
}

var controlRevisitMinutes func(object) any

func nextControl(value object, name string, args object, push bool) {
	requestID, receipt := value["requestId"].(string)
	state := text(value, "state")
	agent := strings.HasPrefix(name, "agent_") || strings.HasPrefix(text(value, "operation"), "agent_")
	read := func(hint string) object {
		return object{"via": "act", "op": "receipt", "args": object{"requestId": requestID, "action": "read"}, "hint": hint}
	}
	selected := func(key string) any {
		if v, ok := value[key].(string); ok {
			return v
		}
		if v, ok := args[key].(string); ok {
			return v
		}
		return nil
	}
	thread, task, turn := selected("threadId"), selected("taskId"), selected("turnId")
	waitName, readName := "codex_wait", "codex_read"
	waitArgs, readArgs := object{"threadId": thread, "turnId": turn}, object{"threadId": thread}
	if agent {
		waitName, readName = "agent_wait", "agent_read"
		waitArgs, readArgs = object{"agent": selected("agent"), "taskId": task, "turnId": turn}, object{"agent": selected("agent"), "taskId": task}
	}
	maps.DeleteFunc(waitArgs, func(_ string, value any) bool { return value == nil })
	waitArgs["until"], waitArgs["timeoutMs"] = "terminal", 30000
	existing := obj(value["next"])
	explicitOp, hasExplicitOp := existing["op"]
	_, explicitHint := existing["hint"].(string)
	errorCode, message := text(value["error"], "code"), text(value["error"], "message")
	var next object
	switch {
	case receipt && state == "unconfirmed":
		next = read("Submission is unconfirmed. Read this original receipt with the same requestId. Do not resubmit the operation.")
	case hasExplicitOp && (explicitOp == nil && explicitHint || str(explicitOp) != ""):
		next = maps.Clone(existing)
	case (errorCode == "DESKTOP_REQUEST_TIMEOUT" || message == "DESKTOP_REQUEST_TIMEOUT: thread-owner-discovery") && thread != nil:
		next = object{"via": "query", "op": "codex_owner", "args": object{"threadId": thread},
			"hint": "Inspect this exact thread owner before retrying. Unheld threads can be read from persisted native state; do not reclaim a held writer."}
	case receipt && state == "executing":
		next = read("The operation is executing. Read the original receipt for its outcome.")
		next["retryAfterMs"] = 1000
	case errorCode == "INVALID_ARGUMENTS":
		next = errorNext(name, maps.Clone(obj(value["error"])))
	case name == "command" && message == "RPC_TIMEOUT: command/exec":
		next = object{"via": "query", "op": "guide", "args": object{"op": "process"},
			"hint": "command owns its child process tree until exit or timeout. For work that must outlive this call, use act process action:spawn with params:{command:[...],cwd:<absolute directory>,processHandle:<unique handle>,timeoutMs:null}. It lasts only for the native backend session; inspect codex_events and stop it with process action:kill."}
	case receipt && state == "awaiting-approval":
		if text(value["desktopRecovery"], "state") == "waiting-for-local" {
			next = read("A local decision is required in ARC before Codex Desktop can be prepared. Read this same receipt after the user makes a local choice.")
		} else {
			next = read("Inspect the original request, then decide according to user intent.")
		}
	case state == "interaction-required":
		if agent {
			next = object{"via": "query", "op": "agent_pending", "args": object{"agent": selected("agent"), "taskId": task},
				"hint": "Read the pending interaction, then use act agent_respond with the user's decision."}
		} else {
			next = object{"via": "query", "op": "codex_pending", "args": object{},
				"hint": "Read the pending interaction, then use act codex_respond; if none is exposed, use Codex Desktop."}
		}
	case (name == "codex_wait" || name == "agent_wait") && state == "timeout":
		if digest, ok := value["snapshotHash"].(string); ok {
			waitArgs["expectedHash"] = digest
		}
		for _, key := range []string{"until", "timeoutMs"} {
			if v, ok := args[key]; ok {
				waitArgs[key] = v
			}
		}
		next = object{"via": "query", "op": waitName, "args": waitArgs, "hint": "Continue waiting with the same task and turn."}
	case receipt && state == "reserved":
		next = read("Read this original receipt until submission resolves. A threadId alone does not mean a turn was submitted. If progressStalled is true, inspect CLI logs/doctor and the owning app; do not redispatch or generate a new requestId.")
		next["retryAfterMs"] = 1000
	case receipt && state == "completed" && turn != nil && (dispatchReceipt(value) || dispatchMetricOp(name)):
		if push {
			next = object{"hint": "You may end this turn and wait for an [ARC] notification; use guide for the review workflow."}
		} else {
			next = object{"via": "query", "op": waitName, "args": waitArgs, "hint": "No verified push or duration estimate; schedule a revisit. Use brief waits only; do not redispatch."}
			if controlRevisitMinutes != nil {
				if minutes := controlRevisitMinutes(value); minutes != nil {
					next["revisitAfterMinutes"] = minutes
					next["hint"] = "No verified push; schedule a revisit using revisitAfterMinutes. Use brief waits only; do not redispatch."
				}
			}
		}
	case obj(field(value["error"], "next")) != nil:
		next = maps.Clone(obj(field(value["error"], "next")))
	case state == "running" && (thread != nil || task != nil):
		next = object{"via": "query", "op": waitName, "args": waitArgs, "hint": "Wait on the same turn; do not submit another task."}
	case interruptedTurn(value) && (agent && task != nil || !agent && thread != nil):
		next = object{"via": "query", "op": readName, "args": readArgs, "hint": "Read the interrupted turn's recorded output before deciding whether to resume."}
	case state == "unconfirmed" && (thread != nil || task != nil):
		if !agent {
			readArgs["statusOnly"] = true
		}
		next = object{"via": "query", "op": readName, "args": readArgs,
			"hint": "Runtime ownership or progress is unknown. Inspect the owning session and this original task. Do not redispatch; notLoaded does not prove no native writer exists."}
	case receipt && slices.Contains([]string{"failed", "rejected", "cancelled", "not-executed", "unconfirmed"}, state):
		next = read("Inspect the surfaced failure and original receipt. Resolve its cause before a new authorized attempt; an unconfirmed effect must be reconciled without replay.")
	case obj(value["error"]) != nil || value["ok"] == false:
		next = errorNext(name, maps.Clone(obj(value["error"])))
	default:
		return
	}
	if receipt {
		delete(next, "hash")
		digest := hash([]byte(wire(next)))
		if args["knownNextHash"] == digest && outcomeError(value) == nil && obj(value["error"]) == nil {
			next = object{"hash": digest, "unchanged": true}
		} else {
			next["hash"] = digest
		}
	}
	value["next"] = next
}

type ownedErrorClassifier struct {
	code       func(string) string
	projection func(string, string, object) object
}

var ownedErrorClassifiers []ownedErrorClassifier

func registerOwnedErrorClassifier(code func(string) string, projection func(string, string, object) object) {
	ownedErrorClassifiers = append(ownedErrorClassifiers, ownedErrorClassifier{code, projection})
}

func controlFailure(err error) object {
	message := err.Error()
	var value object
	parsed := decodeObject([]byte(message), &value) == nil
	for _, classifier := range ownedErrorClassifiers {
		if code := classifier.code(message); code != "" && classifier.projection != nil {
			return classifier.projection(code, message, value)
		}
	}
	if parsed {
		code := text(value, "code")
		if strings.HasPrefix(code, "DEVICE_") || slices.Contains([]string{
			PortPending, "REQUEST_ID_CONFLICT", "PERMISSION_REQUIRED", "SUBMISSION_UNCONFIRMED", "PROJECT_NOT_FOUND",
			"PROJECT_AMBIGUOUS", "INVALID_ARGUMENTS", "INVALID_OUTPUT_OFFSET", "DIGEST_CURSOR_EXPIRED", "DIGEST_SCOPE_CHANGED",
			"OUTPUT_EXPIRED", "DISPATCH_POLICY_CONFLICT", "UNKNOWN_OP", "OP_UNAVAILABLE", "WRONG_TOOL",
			"NOTIFICATION_TARGET_NOT_BOUND_TO_SOURCE", "INVALID_CLAUDE_SESSION", "ACCOUNT_SELECTION_REQUIRED", "ACCOUNT_ROUTE_CHANGED",
			"HANDSHAKE_INVALID_OR_EXPIRED", "DESKTOP_STEER_UNAVAILABLE", "TASK_ARCHIVED", "ARCHIVE_ACTIVE_TURN", "ARCHIVE_WRITER_BUSY",
			"THREAD_WRITER_BUSY", "WRITER_RELEASE_REQUIRES_OWNER", "WRITER_ACTIVE", "RESUME_TURN_ADVANCED", "RESUME_SOURCE_MISMATCH",
			"RESUME_BINDING_MISSING", "DESKTOP_HANDOFF_UNAVAILABLE", "DESKTOP_IPC_ENDPOINT_MISSING", "DESKTOP_IPC_CONNECT_FAILED",
			"DESKTOP_SNAPSHOT_VERSION_UNSUPPORTED", "DESKTOP_SNAPSHOT_INVALID", "STALE_INTERACTION", "ACCEPTANCE_FAULT_UNAVAILABLE",
			"ACCEPTANCE_SELF_TEST_REQUIRED",
		}, code) {
			return value
		}
	}
	if strings.Contains(message, "already has an active writer") {
		return object{"code": "THREAD_WRITER_BUSY", "retryable": false,
			"message": "Codex rejected the operation because another native session owns this thread. ARC runtimeStatus=notLoaded only describes ARC observation, not global writer ownership.",
			"next": object{"via": "query", "op": "guide", "args": object{"op": "codex_owner"},
				"hint": "Read the original receipt and thread status. Continue in the owning ChatGPT/Codex session, or explicitly close that session before retrying this same thread. Do not delete writer locks, auto-retry, or create a replacement thread."}}
	}
	if message == "DESKTOP_SNAPSHOT_TIMEOUT" {
		return object{"code": message, "message": "Codex Desktop did not deliver a thread snapshot in time. Open this thread in Codex Desktop and inspect it before retrying."}
	}
	var rpc any
	if raw, ok := strings.CutPrefix(message, "RPC_REJECTED:"); ok && unmarshalJSON([]byte(raw), &rpc) == nil {
		return object{"code": "NATIVE_RPC_ERROR", "message": message, "rpcError": rpc}
	}
	code := managementErrorCode(message)
	if code == "OP_UNAVAILABLE" || strings.HasPrefix(code, "DEVICE_") {
		return object{"code": code, "message": message, "next": object{"via": "query", "op": "guide", "args": object{}}}
	}
	for _, nativeCode := range []string{PortPending, "REQUEST_ID_CONFLICT", "INVALID_REQUEST_ID", "SUBMISSION_UNCONFIRMED", "INDEX_NOT_READY"} {
		if message == nativeCode || strings.HasPrefix(message, nativeCode+":") {
			return object{"code": nativeCode, "message": message}
		}
	}
	return object{"code": "CONTROL_ERROR", "message": message, "rpcError": nil}
}

func stripControlSource(name string, value object) {
	strip := func(fields object) {
		if fields == nil {
			return
		}
		origin := fields["origin"]
		delete(fields, "origin")
		if _, present := fields["agentAccountId"].(string); present && origin != nil {
			data := object{}
			for _, key := range []string{"sourceId", "accountId"} {
				if v, ok := field(origin, key).(string); ok {
					data[key] = v
				}
			}
			fields["origin"] = data
		}
	}
	_, receipt := value["requestId"].(string)
	if receipt && value["state"] != nil || slices.Contains([]string{"codex_read", "codex_tasks", "agent_read", "agent_tasks"}, name) {
		strip(value)
	}
	for _, key := range map[string][]string{"codex_read": {"turns", "dispatches"}, "codex_tasks": {"tasks"}, "agent_read": {"dispatches"}, "agent_tasks": {"tasks"}}[name] {
		for _, item := range arr(value[key]) {
			strip(obj(item))
		}
	}
}

func egressToolValue(wrapper any) (any, error) {
	for _, block := range arr(field(wrapper, "content")) {
		if field(block, "type") == "text" {
			var result any
			if err := unmarshalJSON([]byte(text(block, "text")), &result); err != nil {
				return nil, fmt.Errorf("Invalid ARC tool result JSON: %w", err)
			}
			return result, nil
		}
	}
	return nil, errors.New("Invalid ARC tool result: expected JSON text content")
}

func stripNotificationInternal(value object) {
	var stripAt func(any, []string)
	stripAt = func(value any, path []string) {
		if len(path) == 0 {
			maps.DeleteFunc(obj(value), func(key string, _ any) bool { return strings.HasPrefix(key, "_") })
			return
		}
		if path[0] == "*" {
			for _, row := range arr(value) {
				stripAt(row, path[1:])
			}
		} else {
			stripAt(field(value, path[0]), path[1:])
		}
	}
	stripAt(value, nil)
	for _, path := range []string{"dispatches.*", "dispatches.*.terminal", "dispatches.*.coordinationPending",
		"dispatches.*.coordinationPending.*", "terminal", "coordinationPending", "coordinationPending.*", "task", "runtime",
		"runtime.ownership", "subscriptions.*", "deliveries.*", "deliveries.*.timing", "targets.*", "targets.*.pending.*",
		"targets.*.pending.*.timing", "targets.*.recentBatches.*", "threads.*", "threads.*.turns.*",
		"unboundPending.*", "unboundPending.*.timing", "mostWokenThreads.*", "summary", "summary.hidden"} {
		stripAt(value, strings.Split(path, "."))
	}
}

var validateDispatchCaller func(any) any

func dispatchSummary(value object) object {
	summary := object{}
	if validateDispatchCaller != nil {
		if caller := validateDispatchCaller(value["caller"]); caller != nil {
			summary["caller"] = caller
		}
	}
	for _, key := range []string{"trigger", "agentAccountId"} {
		if name, ok := value[key].(string); ok {
			summary[key] = name
		}
	}
	known := func(value any) bool { return str(value) != "" && str(value) != "unknown" }
	for _, key := range []string{"model", "effort", "serviceTier"} {
		for _, raw := range []any{field(value["turnEvidence"], key), field(value["effectiveConfiguration"], key), value[key], field(value["options"], key)} {
			if known(raw) {
				summary[key] = raw
				break
			}
		}
	}
	if key := value["threadServiceTier"]; summary["serviceTier"] == nil && known(key) {
		summary["serviceTier"] = key
	}
	if summary["effort"] == nil {
		for _, name := range []string{"thinkingLevel", "reasoning_effort"} {
			if effort := field(value["options"], name); known(effort) {
				summary["effort"] = effort
				break
			}
		}
	}
	source := object{}
	for _, pair := range [][2]string{{"id", "sourceId"}, {"accountId", "accountId"}, {"label", "sourceLabel"}, {"kind", "controlSource"}, {"deviceId", "deviceId"}} {
		if raw := field(value["origin"], pair[1]); known(raw) {
			source[pair[0]] = raw
		}
	}
	if len(source) != 0 {
		summary["controlSource"] = source
	}
	if len(summary) == 0 {
		return nil
	}
	return summary
}

func runeExcerpt(value string, maxLength int) string {
	for index := range value {
		if maxLength == 0 {
			return value[:index]
		}
		maxLength--
	}
	return value
}

func interactionPreview(request object) object {
	params, exists := request["params"]
	if !exists {
		params = request
	}
	raw := arr(field(params, "questions"))
	rows := []object{}
	for _, entry := range raw[:min(len(raw), 6)] {
		options := []object{}
		if list := arr(field(entry, "options")); list != nil {
			for _, option := range list[:min(len(list), 8)] {
				label := metricString(option, text(option, "label"))
				options = append(options, object{"label": runeExcerpt(label, 120), "description": runeExcerpt(text(option, "description"), 160)})
			}
		}
		rows = append(rows, object{"id": field(entry, "id"), "question": runeExcerpt(text(entry, "question"), 480), "options": options})
	}
	if len(rows) == 0 {
		for _, name := range []string{"question", "prompt", "message", "summary"} {
			if prompt := text(params, name); prompt != "" {
				options := arr(field(params, "options"))
				if options == nil {
					options = []any{}
				}
				rows = append(rows, object{"question": runeExcerpt(prompt, 480), "options": options[:min(len(options), 8)]})
				break
			}
		}
	}
	questions := make([]string, 0, len(rows))
	for _, row := range rows {
		questions = append(questions, text(row, "question"))
	}
	count := len(rows)
	if raw != nil {
		count = len(raw)
	}
	response, hasResponse := request["responseId"]
	if !hasResponse {
		response = request["id"]
	}
	return object{"questions": rows, "summary": strings.Join(questions, "; "), "questionCount": count,
		"responseId": response, "turnId": field(params, "turnId"), "backendSession": request["backendSession"], "routing": request["routing"]}
}

var readRecordedInteractions func(context.Context, *service, string) ([]any, error)

func controlInteractionHistory(ctx context.Context, request operationRequest) (any, error) {
	if readRecordedInteractions == nil {
		return nil, errors.New(PortPending)
	}
	thread := text(request.args, "threadId")
	entries, err := readRecordedInteractions(ctx, request.service, thread)
	if err != nil {
		return nil, err
	}
	rows := []object{}
	for _, entry := range entries {
		if field(entry, "type") != "interaction" || obj(field(entry, "response")) == nil {
			continue
		}
		row := interactionPreview(obj(field(entry, "interaction")))
		row["id"], row["turnId"], row["response"], row["status"] = field(entry, "id"), field(entry, "turnId"), field(entry, "response"), "answered"
		rows = append(rows, row)
	}
	slices.Reverse(rows)
	total := uint64(len(rows))
	start := min(uintOr(request.args["offset"], 0), total)
	end := min(start+min(uintOr(request.args["limit"], 20), 100), total)
	var next any
	if end < total {
		next = end
	}
	return object{"threadId": thread, "interactions": rows[start:end], "total": total, "nextOffset": next}, nil
}

func panelState(panel any) any {
	if obj(panel) == nil {
		return panel
	}
	p := obj(panel)
	result := selectFields(p, "agent", "id", "following", "atLatest", "expanded", "state", "turnId")
	result["queueCount"], result["disclosureCount"] = len(arr(p["queue"])), len(arr(p["disclosures"]))
	if timeline := obj(p["timeline"]); timeline != nil {
		summary := selectFields(timeline, "status", "cursor", "snapshotHash", "coverage")
		summary["entryCount"] = len(arr(timeline["entries"]))
		result["timeline"] = summary
		for _, name := range []string{"dispatchBackend", "handback"} {
			if value, ok := obj(timeline["ownership"])[name]; ok {
				result[name] = value
			}
		}
	}
	return result
}

func init() {
	registerOperation("codex_interactions", controlInteractionHistory, nil)
}
