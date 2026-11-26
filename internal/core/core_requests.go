package core

import (
	"errors"
	"slices"
)

type requestSource struct {
	local   bool
	origin  object
	profile object
	policy  any
}

func (s requestSource) enabledOps() []object {
	ops := make([]object, 0, len(arr(catalog()["ops"])))
	for _, row := range arr(catalog()["ops"]) {
		spec := obj(row)
		if policyAllows(s.policy, text(spec, "name")) {
			ops = append(ops, spec)
		}
	}
	return ops
}

func callTool(source requestSource, tool string, envelope any) object {
	name := text(envelope, "op")
	args := obj(field(envelope, "args"))
	if tool == "guide" {
		name, args = "guide", obj(envelope)
	}
	spec := find(catalog()["tools"], "name", tool)
	if spec == nil {
		return egressFailure(name, object{"code": "CONTROL_ERROR", "message": "Unknown tool; call guide, query or act.", "rpcError": nil})
	}
	if topic, ok := field(envelope, "topic").(string); tool == "guide" && ok {
		topics := func(spec object) []any {
			return arr(field(field(field(spec["inputSchema"], "properties"), "topic"), "enum"))
		}
		if !slices.Contains(topics(spec), any(topic)) && slices.Contains(topics(operation("guide")), any(topic)) {
			return egressFailure(name, object{"code": "WRONG_TOOL", "op": "guide", "field": "/topic", "via": "query",
				"message": "The frozen guide tool accepts only its original topics; read this topic through query guide.",
				"next":    object{"via": "query", "op": "guide", "args": object{"topic": topic}, "hint": "Read this topic through query guide with the same topic."}})
		}
	}
	if invalid := checkSchema("tool", tool, "", spec["inputSchema"], envelope); invalid != nil {
		return egressFailure(name, invalid)
	}
	if name == "guide" {
		guide := operation("guide")
		if tool == "act" {
			return egressFailure(name, object{"code": "WRONG_TOOL", "op": "guide", "via": "query", "example": example(guide)})
		}
		if tool == "query" {
			if invalid := checkSchema("op", name, name, guide["inputSchema"], args); invalid != nil {
				return egressFailure(name, invalid)
			}
		}
		if requested, ok := args["op"].(string); ok {
			if operation(requested) == nil {
				return egressFailure(name, unknownOp(requested, source.enabledOps()))
			}
			if !policyAllows(source.policy, requested) {
				return egressFailure(name, opUnavailable(requested))
			}
		}
		return egressTool(egressGuide(source, args, source.enabledOps()), false)
	}
	op := operation(name)
	if op == nil {
		return egressFailure(name, unknownOp(name, source.enabledOps()))
	}
	if !policyAllows(source.policy, name) {
		return egressFailure(name, opUnavailable(name))
	}
	if name != "device" && tool != via(op) {
		return egressFailure(name, object{"code": "WRONG_TOOL", "op": name, "message": "Use the op's assigned tool.", "via": via(op), "example": example(op)})
	}
	if name == "receipt" || retryContract(op)["mode"] == "receipt" {
		if requestID, ok := field(envelope, "requestId").(string); ok && args["requestId"] == nil {
			args["requestId"] = requestID
		}
	}
	if invalid := checkSchema("op", name, name, op["inputSchema"], args); invalid != nil {
		return egressFailure(name, invalid)
	}
	if invalid := normalizeArgs(name, args); invalid != nil {
		return egressFailure(name, invalid)
	}
	switch name {
	case "control_output":
		value, err := readOutput(args)
		if err != nil {
			return egressFailure(name, transportError(err))
		}
		return egressTool(value, false)
	case "receipt":
		// Receipt ownership and durable indexing are still pending.
		return egressFailure(name, pendingFailure())
	default:
		return egressFailure(name, pendingFailure())
	}
}

func opUnavailable(name string) object {
	return object{"code": "OP_UNAVAILABLE", "op": name, "message": "This op is disabled by the ingress policy or unavailable on this device. Call guide for enabled ops."}
}

func localControl(source requestSource, body object) object {
	name := text(body, "op")
	args, exists := body["args"]
	if !exists {
		args = object{}
	}
	tool := "query"
	if spec := operation(name); spec != nil && name != "guide" {
		tool = via(spec)
	}
	return callTool(source, tool, object{"op": name, "args": args})
}

func dispatchMCP(source requestSource, request object) (object, error) {
	if request["jsonrpc"] != "2.0" {
		return nil, errors.New("invalid jsonrpc")
	}
	id, hasID := request["id"]
	if !hasID {
		return nil, nil
	}
	var result object
	var failure object
	params := obj(request["params"])
	server := object{"name": "arc", "version": buildVersion}
	switch text(request, "method") {
	case "server/discover":
		result = object{"cacheScope": "private", "ttlMs": 0, "supportedVersions": []string{"2026-07-28"},
			"capabilities": object{"tools": object{}, "events": object{}}, "serverInfo": server, "instructions": catalog()["instructions"]}
	case "initialize":
		version := text(params, "protocolVersion")
		switch version {
		case "2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28":
		default:
			version = "2025-03-26"
		}
		capabilities := object{"tools": object{}}
		if version == "2026-07-28" {
			capabilities["events"] = object{}
		}
		result = object{"protocolVersion": version, "capabilities": capabilities, "serverInfo": server, "instructions": catalog()["instructions"]}
	case "ping":
		result = object{}
	case "tools/list":
		result = object{"cacheScope": "private", "ttlMs": 0, "tools": catalog()["tools"]}
	case "tools/call":
		payload, exists := params["arguments"]
		if !exists {
			payload = object{}
		}
		result = callTool(source, text(params, "name"), payload)
	case "events/list", "events/subscribe", "events/unsubscribe":
		failure = object{"code": -32603, "message": PortPending, "data": object{"code": PortPending, "arcVersion": arcVersion()}}
	case "notifications/initialized", "notifications/cancelled":
		return nil, nil
	default:
		failure = object{"code": -32601, "message": "method not found", "data": object{"arcVersion": arcVersion()}}
	}
	response := object{"jsonrpc": "2.0", "id": id}
	if failure != nil {
		response["error"] = failure
	} else {
		result["resultType"] = "complete"
		response["result"] = result
	}
	return response, nil
}
