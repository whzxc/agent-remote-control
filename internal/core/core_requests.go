package core

import (
	"context"
	"errors"
	"maps"
	"slices"
	"strings"
	"sync"

	"github.com/google/uuid"
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
		if operationAvailable(s, text(spec, "name")) {
			ops = append(ops, spec)
		}
	}
	return ops
}

var localSourceOrigin func(context.Context) (requestSource, error)
var remoteDeviceControl func(context.Context, *service, requestSource, string, object, any) (object, error)
var authorizeReviewDefects func(string, object) error
var decorateControlSource func(context.Context, object)
var controlPushAvailable func(any) bool
var decorateControlResult []func(context.Context, operationRequest, object)
var localControlCallerKey struct{}

type mcpMethod func(context.Context, *service, requestSource, object) (object, error)

var registeredMCPMethods = make(map[string]mcpMethod)

func registerMCPMethod(name string, handler mcpMethod) {
	if handler == nil || registeredMCPMethods[name] != nil {
		panic("Invalid or duplicate MCP protocol method " + name)
	}
	registeredMCPMethods[name] = handler
}

func callTool(ctx context.Context, service *service, source requestSource, tool string, envelope any, rpcID any) object {
	metric := beginControlMetric(source, tool, envelope)
	response := callToolInner(ctx, service, source, tool, envelope, rpcID)
	if rpcID != nil && nameNotForwarded(envelope) {
		response["resultType"] = "complete"
	}
	metric.finish(ctx, response)
	return response
}

func nameNotForwarded(envelope any) bool {
	return text(envelope, "op") != "device" && text(field(envelope, "args"), "device") == ""
}

func callToolInner(ctx context.Context, service *service, source requestSource, tool string, envelope any, rpcID any) object {
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
	ctx = withOrigin(ctx, source.origin)
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
			if !operationAvailable(source, requested) {
				return egressFailure(name, opUnavailable(requested))
			}
		}
		return egressTool(egressGuide(source, args, source.enabledOps()), false)
	}
	op := operation(name)
	if op == nil {
		return egressFailure(name, unknownOp(name, source.enabledOps()))
	}
	if !operationAvailable(source, name) {
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
	if authorizeReviewDefects != nil && (name == "codex_review" || name == "agent_review") {
		if err := authorizeReviewDefects(name, args); err != nil {
			return egressFailure(name, controlFailure(err))
		}
	}
	if name == "device" || text(args, "device") != "" {
		if remoteDeviceControl == nil {
			return egressFailure(name, controlFailure(errors.New(PortPending)))
		}
		forward := args
		if name != "device" {
			payload := maps.Clone(args)
			delete(payload, "device")
			forward = object{"device": args["device"], "op": name, "args": payload}
		}
		result, err := remoteDeviceControl(ctx, service, source, tool, forward, field(envelope, "requestId"))
		if err != nil {
			return egressFailure(name, controlFailure(err))
		}
		return result
	}
	continuation := false
	if _, present := args["digestCursor"].(string); present && digestSupported(name, args) {
		page, follow, err := resumeDigest(name, args, source.origin, rpcID)
		if err != nil {
			return egressFailure(name, controlFailure(err))
		}
		if page != nil {
			return egressTool(page, false)
		}
		args, continuation = follow, true
	}
	var waitLimit object
	if isWaitOp(name) {
		waitLimit = limitWait(source.origin, args)
	}
	request := operationRequest{name, args, source, service, rpcID}
	result, err := executeOperation(ctx, request)
	if err != nil {
		value := object{"error": controlFailure(err)}
		nextControl(value, name, args, false)
		return egressTool(value, true)
	}
	value := obj(result)
	if value == nil {
		value = object{"value": result}
	} else {
		value = clone(value)
	}
	if slices.Contains([]string{"codex_read", "codex_wait", "agent_read", "agent_wait"}, name) && value["state"] != nil && value["operation"] == nil {
		value["stateScope"] = "turn"
	}
	value = publicReceipt(value)
	if args["includeOrigin"] != true {
		stripControlSource(name, value)
	}
	if reason := outcomeError(value); reason != nil {
		value["error"] = reason
	}
	if decorateControlSource != nil {
		decorateControlSource(ctx, value)
	}
	for _, decorate := range decorateControlResult {
		decorate(ctx, request, value)
	}
	push := controlPushAvailable != nil && controlPushAvailable(value["notification"])
	nextControl(value, name, args, push)
	compactOutcomeError(value)
	failed := value["error"] != nil
	if waitLimit != nil {
		value["waitLimit"] = waitLimit
	}
	if !failed && digestSupported(name, args) && !digestDetail(name, args) {
		explicit := args["view"] == "digest"
		automatic := args["view"] == nil && args["digestCursor"] == nil
		if !explicit && !continuation && automatic && digestShown(value, rpcID) > 12*1024 {
			value["arcVersion"] = arcVersion()
			explicit = true
		}
		if explicit || continuation {
			page, err := showDigest(name, args, value, source.origin, rpcID)
			if err != nil {
				return egressFailure(name, controlFailure(err))
			}
			return egressTool(page, false)
		}
		if automatic {
			return egressTool(value, false)
		}
	}
	if name != "control_output" {
		limit := 12 * 1024
		if args["view"] == "full" {
			limit = 64 * 1024
		}
		projected, err := pageOutput(value, limit)
		if err != nil {
			return egressFailure(name, controlFailure(err))
		}
		if failed && field(projected, "outputId") != nil {
			for _, key := range []string{"requestId", "state", "error", "threadId", "turnId"} {
				if v, ok := value[key]; ok {
					obj(projected)[key] = v
				}
			}
		}
		value = obj(projected)
	}
	return egressTool(value, failed)
}

func opUnavailable(name string) object {
	return object{"code": "OP_UNAVAILABLE", "op": name, "message": "This op is disabled by the ingress policy or unavailable on this device. Call guide for enabled ops."}
}

func localControl(ctx context.Context, service *service, source requestSource, body object) object {
	name := text(body, "op")
	args, exists := body["args"]
	if !exists {
		args = object{}
	}
	inner := name
	if name == "device" {
		inner = text(args, "op")
	}
	tool := "query"
	if spec := operation(inner); spec != nil && inner != "guide" {
		tool = via(spec)
	}
	var deviceRequestID any
	if fields := maps.Clone(obj(args)); fields != nil {
		if dispatchMetricOp(name) {
			if _, exists := fields["purpose"]; !exists {
				fields["purpose"] = "self-test"
			}
			if _, exists := fields["notify"]; !exists {
				fields["notify"] = nil
			}
		}
		if name == "device" {
			deviceRequestID = fields["requestId"]
			delete(fields, "requestId")
		}
		args = fields
	}
	envelope := object{"op": name, "args": args}
	if tool == "act" {
		if requestID, exists := body["requestId"]; exists {
			envelope["requestId"] = requestID
		} else if deviceRequestID != nil {
			envelope["requestId"] = deviceRequestID
		}
	}
	if validateDispatchCaller != nil {
		if caller := validateDispatchCaller(body["caller"]); caller != nil {
			ctx = context.WithValue(ctx, &localControlCallerKey, caller)
		}
	}
	return callTool(ctx, service, source, tool, envelope, nil)
}

func dispatchMCP(ctx context.Context, service *service, source requestSource, request object) (object, error) {
	if request["jsonrpc"] != "2.0" {
		return nil, errors.New("invalid jsonrpc")
	}
	id, hasID := request["id"]
	method := text(request, "method")
	waitKey := text(source.origin, "sourceId") + "\x00" + wire(id)
	if method == "notifications/cancelled" {
		service.waits.cancel(text(source.origin, "sourceId") + "\x00" + wire(field(request["params"], "requestId")))
		return nil, nil
	}
	if !hasID {
		return nil, nil
	}
	var result object
	var failure object
	params := obj(request["params"])
	server := object{"name": "arc", "version": buildVersion}
	switch method {
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
		if isMCPWait(request) {
			wait, done, err := service.waits.register(ctx, waitKey)
			if err != nil {
				failure = mcpMethodFailure(err)
				break
			}
			defer done()
			result = callTool(wait, service, source, text(params, "name"), payload, id)
			if wait.Err() != nil && ctx.Err() == nil {
				result = cancelledControlWait(payload)
			}
		} else {
			result = callTool(ctx, service, source, text(params, "name"), payload, id)
		}
	case "notifications/initialized":
		return nil, nil
	default:
		if handler := registeredMCPMethods[method]; handler != nil {
			var err error
			result, err = handler(ctx, service, source, params)
			if err != nil {
				failure = mcpMethodFailure(err)
			}
		} else if slices.Contains([]string{"events/list", "events/subscribe", "events/unsubscribe"}, method) {
			failure = mcpMethodFailure(errors.New(PortPending))
		} else {
			failure = object{"code": -32601, "message": "method not found", "data": object{"arcVersion": arcVersion()}}
		}
	}
	response := object{"jsonrpc": "2.0", "id": id}
	if failure != nil {
		response["error"] = failure
	} else {
		if result == nil {
			result = object{}
		}
		if result["resultType"] == nil {
			result["resultType"] = "complete"
		}
		response["result"] = result
	}
	return response, nil
}

func mcpMethodFailure(err error) object {
	var failure object
	if decodeObject([]byte(err.Error()), &failure) == nil && failure["code"] != nil && failure["message"] != nil {
		return failure
	}
	data := object{"arcVersion": arcVersion()}
	if err.Error() == PortPending {
		data["code"] = PortPending
	}
	return object{"code": -32603, "message": err.Error(), "data": data}
}

func cancelledControlWait(payload any) object {
	name, args := text(payload, "op"), field(payload, "args")
	result := object{"state": "unconfirmed", "reason": "wait-cancelled", "threadId": field(args, "threadId"), "turnId": field(args, "turnId"),
		"runtimeStatus": "unknown", "recordedStatus": nil, "finalResponse": nil, "interaction": []any{}, "changed": false,
		"conditionMet": false, "observedAt": nil, "returnedAt": now(), "elapsedMs": 0}
	switch name {
	case "inbox_wait":
		result = object{"state": "unconfirmed", "reason": "wait-cancelled", "events": []any{}, "unread": 0}
	case "agent_wait":
		result["agent"], result["taskId"] = field(args, "agent"), field(args, "taskId")
	}
	return egressTool(result, false)
}

func init() {
	registerRoute("POST", "cli/control", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		source := requestSource{local: true, origin: object{"controlTransport": "cli", "sourceId": "local-cli"}, policy: "all"}
		if localSourceOrigin != nil {
			loaded, err := localSourceOrigin(ctx)
			if err != nil {
				return nil, err
			}
			source = loaded
			source.origin = maps.Clone(source.origin)
			source.origin["controlTransport"] = "cli"
		}
		return localControl(ctx, s, source, body), nil
	})
	registerOperationFallback("connector_verify", func(ctx context.Context, request operationRequest) (any, error) {
		if !request.source.local {
			return nil, errors.New(PortPending)
		}
		return object{"received": true, "code": request.args["code"], "origin": currentOrigin(ctx)}, nil
	})
}

type waitCalls struct {
	mu    sync.Mutex
	calls map[string]context.CancelFunc
}

func (w *waitCalls) register(parent context.Context, key string) (context.Context, func(), error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, exists := w.calls[key]; exists {
		return nil, nil, errors.New("duplicate active wait request id")
	}
	if w.calls == nil {
		w.calls = make(map[string]context.CancelFunc)
	}
	ctx, cancel := context.WithCancel(parent)
	w.calls[key] = cancel
	return ctx, func() {
		w.mu.Lock()
		delete(w.calls, key)
		w.mu.Unlock()
		cancel()
	}, nil
}

func (w *waitCalls) cancel(key string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if cancel := w.calls[key]; cancel != nil {
		cancel()
	}
}

func browserRouteAllowed(route, method string) bool {
	switch method {
	case "GET":
		if slices.Contains([]string{"status", "source", "agents", "agents/activity", "subscriptions", "tasks", "preferences", "accounts",
			"events", "subscriptions/events", "agents/activity/events", "relay/list", "relay/progress", "updates/history"}, route) {
			return true
		}
		for _, prefix := range []string{"accounts/", "agents/timeline/", "tasks/runtime/"} {
			if id, ok := strings.CutPrefix(route, prefix); ok {
				_, err := uuid.Parse(id)
				return err == nil
			}
		}
	case "POST":
		return slices.Contains([]string{"agents/conversations", "agents/conversations/timeline", "coordination/board", "coordination/events",
			"coordination/ax_list", "agents/dispatch-catalog", "agents/dispatch-defaults/read", "agents/resources",
			"tasks/reviews", "tasks/control", "tasks/request-routing"}, route)
	}
	return false
}

func authorizeBrowserRoute(route, method string, body object) error {
	if !browserRouteAllowed(route, method) || route == "tasks/control" && body["op"] != "codex_queue" ||
		route == "tasks/request-routing" && body["action"] != "read" || route == "agents/resources" && body["action"] != "image" {
		return errors.New("FRONT_DOOR_BROWSER_FORBIDDEN")
	}
	if method == "POST" {
		for _, spec := range arr(managementCatalog()["operations"]) {
			if field(spec, "route") == route && field(spec, "method") == "POST" {
				if _, _, _, err := managementResolve(text(spec, "name"), object{"body": body}); err != nil {
					return errors.New("FRONT_DOOR_BROWSER_INVALID")
				}
				return nil
			}
		}
		return errors.New("FRONT_DOOR_BROWSER_FORBIDDEN")
	}
	return nil
}
