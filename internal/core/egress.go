package core

import (
	"fmt"
	"maps"
	"net/url"
	"slices"
	"strings"
	"sync"

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

var arcVersion = sync.OnceValue(func() string {
	current := catalog()
	ops := []object{}
	for _, row := range arr(current["ops"]) {
		op := obj(row)
		ops = append(ops, object{"op": op["name"], "via": opTools(op), "description": op["description"],
			"inputSchema": op["inputSchema"], "signature": signature(op), "example": example(op)})
	}
	slices.SortFunc(ops, func(a, b object) int { return strings.Compare(text(a, "op"), text(b, "op")) })
	return hash([]byte(wire(object{"tools": current["tools"], "instructions": current["instructions"], "guides": current["guides"], "ops": ops, "events": eventGuide()})))[:12]
})

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
	result["cliPath"] = cliExecutable()
	if source.local {
		result["sourceId"] = source.origin["sourceId"]
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
	compiler.AssertFormat()
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
