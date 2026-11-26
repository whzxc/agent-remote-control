package core

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
)

var baseManagementCatalog = sync.OnceValue(func() object {
	result := resource("management.json")
	for _, contribute := range catalogContributions {
		contribute(result)
	}
	return result
})

var liveManagementContributions []func(object)

func registerLiveManagementCatalog(contribute func(object)) {
	liveManagementContributions = append(liveManagementContributions, contribute)
}

func managementCatalog() object {
	result := clone(baseManagementCatalog())
	for _, contribute := range liveManagementContributions {
		contribute(result)
	}
	return result
}

var routeID = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)
var routeParam = regexp.MustCompile(`\{(?:id|requestId)\}`)

var managementRoutes = sync.OnceValue(func() map[string][]*regexp.Regexp {
	methods := make(map[string][]*regexp.Regexp)
	for _, value := range arr(baseManagementCatalog()["operations"]) {
		route := text(value, "route")
		segments := routeParam.Split(route, -1)
		for index, segment := range segments {
			segments[index] = regexp.QuoteMeta(segment)
		}
		pattern := regexp.MustCompile("^" + strings.Join(segments, "[^/]+") + "$")
		method := text(value, "method")
		methods[method] = append(methods[method], pattern)
	}
	return methods
})

func knownManagementRoute(method, route string) bool {
	for _, pattern := range managementRoutes()[method] {
		if pattern.MatchString(route) {
			return true
		}
	}
	return false
}

func desktopRoute(route string) bool {
	switch route {
	case "src-containers/status", "src-containers/profiles", "src-containers/open", "src-containers/import",
		"src-containers/clear", "permissions/desktop", "permissions/notify", "appearance", "app", "app/snapshot", "app/quit", "app/restart":
		return true
	}
	return false
}

func managementResolve(name string, args object) (route, method string, body object, err error) {
	spec := find(managementCatalog()["operations"], "name", name)
	if spec == nil {
		if strings.HasPrefix(name, "device.") {
			return "", "", nil, errors.New(deviceUnavailableMessage)
		}
		return "", "", nil, errors.New("UNKNOWN_OPERATION")
	}
	if invalid := checkSchema("management", name, "", spec["inputSchema"], args); invalid != nil {
		return "", "", nil, fmt.Errorf("INVALID_ARGUMENT: read schema for %s", name)
	}
	route, method = text(spec, "route"), text(spec, "method")
	for _, key := range []string{"id", "requestId"} {
		placeholder := "{" + key + "}"
		if strings.Contains(route, placeholder) {
			substitution := text(args, key)
			if !routeID.MatchString(substitution) || substitution == "." || substitution == ".." {
				return "", "", nil, fmt.Errorf("INVALID_ARGUMENT: %s", key)
			}
			route = strings.ReplaceAll(route, placeholder, substitution)
		}
	}
	body = obj(args["body"])
	if body == nil {
		body = object{}
	}
	return route, method, body, nil
}

var startDesktopApp func(context.Context) (any, error)

func managementCall(ctx context.Context, name string, args object) (any, error) {
	route, method, body, err := managementResolve(name, args)
	if err != nil {
		return nil, err
	}
	if name == "logs.query" && body["offline"] == true {
		return queryLogs(body)
	}
	if name == "app.start" {
		if operatingSystem == "linux" {
			return startHeadless(ctx)
		}
		if startDesktopApp != nil {
			return startDesktopApp(ctx)
		}
		return nil, errors.New(PortPending)
	}
	return forwardRequest(ctx, route, method, body)
}

func managementErrorCode(message string) string {
	for _, classifier := range ownedErrorClassifiers {
		if code := classifier.code(message); code != "" {
			return code
		}
	}
	if strings.Contains(message, "Cannot connect to local Core") || strings.Contains(message, "Open Agent Remote Control first") {
		return "APP_UNAVAILABLE"
	}
	var parsed object
	if strings.HasPrefix(message, "{") {
		if err := decodeObject([]byte(message), &parsed); err != nil {
			parsed = nil
		}
	}
	for _, code := range []string{PortPending, "CORE_BUILD_MISMATCH", "DEVICE_OFFLINE", "DEVICE_UNKNOWN", "DEVICE_PAIRING_CYCLE", "DEVICE_TOPOLOGY_UNAVAILABLE",
		"DEVICE_AGENT_UNAVAILABLE", "DEVICE_TASK_NOT_VISIBLE", "DEVICE_CONNECTION_REFUSED", "DEVICE_RESPONSE_LOST", "DEVICE_OUTCOME_UNCERTAIN",
		"DEVICE_BUSY", "OP_UNAVAILABLE", "DEVICE_PROTOCOL_MISMATCH", "DEVICE_PAIRING_INVALID", "DEVICE_TLS_FAILED", "DEVICE_LAN_UNAVAILABLE",
		"DEVICE_TUNNEL_AUTH", "DEVICE_TUNNEL_UNAVAILABLE", "DEVICE_TUNNEL_LIMIT", "DEVICE_LISTEN_FAILED", "DEVICE_CONTROLLER_EXISTS",
		"DEVICE_PAIRING_PENDING", "DEVICE_PAIRING_MISSING", "DEVICE_OFFER_EXPIRED", "DEVICE_PAIRING_SECRET", "DEVICE_PAIRING_DECLINED",
		"DEVICE_PEER_FORBIDDEN", "DEVICE_UNPAIRED", "SOURCE_REVOKED", "SOURCE_REMOVED", "LOCAL_SOURCE_PROTECTED", "INVALID_ARGUMENT",
		"UNKNOWN_OPERATION", "UNKNOWN_TOOL", "REQUEST_ID_CONFLICT", "UNSUPPORTED_OPERATION", "APP_START_TIMEOUT", "NOT_SUPPORTED", "SHIM_EXISTS", "OUTPUT_EXPIRED"} {
		if strings.HasPrefix(message, code) || text(parsed, "code") == code {
			return code
		}
	}
	if message == "UNKNOWN_ROUTE" {
		return "APP_VERSION_MISMATCH"
	}
	return "COMMAND_FAILED"
}

// readDeviceManagementResult restores complete JSON for management readers of paged MCP output.
func readDeviceManagementResult(response any, readOutput func(object) (any, error)) (any, error) {
	decode := func(response any) (any, error) {
		value, err := egressToolValue(response)
		if err == nil && field(response, "isError") == true {
			return nil, errors.New(wire(value))
		}
		return value, err
	}
	value, err := decode(response)
	output, hasOutput := field(value, "outputId").(string)
	if err != nil || !hasOutput || text(value, "nextAction") != "control_output" {
		return value, err
	}
	var complete strings.Builder
	var offset uint64
	for {
		response, err := readOutput(object{"outputId": output, "offset": offset, "length": 65536})
		if err != nil {
			return nil, err
		}
		page, err := decode(response)
		if err != nil {
			return nil, err
		}
		part, ok := field(page, "text").(string)
		if !ok {
			return nil, errors.New("Invalid device output page: expected text")
		}
		complete.WriteString(part)
		next, hasNext := uintValue(field(page, "nextOffset"))
		if !hasNext {
			var result any
			if err := unmarshalJSON([]byte(complete.String()), &result); err != nil {
				return nil, fmt.Errorf("Invalid complete device JSON: %w", err)
			}
			return result, nil
		}
		if next <= offset {
			return nil, errors.New("Invalid device output page: offset did not advance")
		}
		offset = next
	}
}

func platformName() string {
	switch operatingSystem {
	case "windows":
		return "win32"
	default:
		return operatingSystem
	}
}

func desktopForward(ctx context.Context, s *service, route string) (any, error) {
	return s.management(ctx, route, http.MethodGet, object{})
}

func managementStdio(ctx context.Context, input io.Reader, output io.Writer) error {
	return parallelJSONLines(ctx, input, output, 1<<20, false, func(ctx context.Context, _ io.Writer, request object) (any, error) {
		id, hasID := request["id"]
		if !hasID {
			return nil, nil
		}
		reply := object{"jsonrpc": "2.0", "id": id}
		var result any
		switch text(request, "method") {
		case "initialize":
			result = object{"protocolVersion": "2025-03-26", "capabilities": object{"tools": object{}},
				"serverInfo":   object{"name": "arc", "version": buildVersion},
				"instructions": "Local authenticated administration. Discover operation schemas before calls; writes may stop this MCP host. Lifecycle acceptance must be read back after reconnect."}
		case "ping":
			result = object{}
		case "tools/list":
			result = object{"tools": []object{
				{"name": "connector_capabilities", "description": "Discover local management operations and exact input schemas.",
					"inputSchema": object{"type": "object", "properties": object{}, "additionalProperties": false}},
				{"name": "connector_call", "description": "Execute a discovered local management operation; same contract as CLI and UI.",
					"inputSchema": object{"type": "object", "required": []string{"operation"}, "properties": object{"operation": object{"type": "string"}, "arguments": object{"type": "object"}}, "additionalProperties": false}},
			}}
		case "tools/call":
			params := obj(request["params"])
			args := obj(params["arguments"])
			var value any
			var err error
			switch text(params, "name") {
			case "connector_capabilities":
				value = managementCatalog()
			case "connector_call":
				input := obj(args["arguments"])
				if input == nil {
					input = object{}
				}
				value, err = managementCall(ctx, text(args, "operation"), input)
			default:
				err = errors.New("UNKNOWN_TOOL")
			}
			block := object{"type": "text"}
			structured := object{}
			if err != nil {
				block["text"] = err.Error()
				structured["error"] = object{"code": managementErrorCode(err.Error()), "message": err.Error()}
			} else {
				if fields := obj(value); fields != nil {
					if reason := outcomeError(fields); reason != nil {
						fields["error"] = reason
						compactOutcomeError(fields)
						err = errors.New("operation outcome failed")
					}
				}
				block["text"] = wire(value)
				structured["result"] = value
			}
			result = object{"content": []object{block}, "structuredContent": structured, "isError": err != nil}
		default:
			reply["error"] = object{"code": -32601, "message": "method not found"}
			return reply, nil
		}
		reply["result"] = result
		return reply, nil
	})
}

func registerIngressManagementDescriptor(descriptor func() object) {
	registerManagementCatalog(func(value object) {
		current := descriptor()
		value["ingressConfiguration"] = current
		fields := object{}
		for key, field := range obj(current["fields"]) {
			fallback := obj(field)["default"]
			kind := "string"
			if _, ok := fallback.(bool); ok {
				kind = "boolean"
			} else if _, ok := uintValue(fallback); ok {
				kind = "integer"
			}
			schema := object{"type": kind, "default": fallback}
			if max, ok := uintValue(obj(field)["maxBytes"]); ok {
				schema["maxLength"] = max
			}
			if _, ok := obj(field)["savedFlag"].(string); ok {
				schema["writeOnly"] = true
			}
			fields[key] = schema
		}
		for _, op := range arr(value["operations"]) {
			body := field(field(field(op, "inputSchema"), "properties"), "body")
			properties := obj(field(body, "properties"))
			if _, exists := properties["config"]; exists {
				properties["config"] = object{"type": "object", "properties": fields, "additionalProperties": false}
			}
		}
	})
}
