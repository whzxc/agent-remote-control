package core

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

type nativeSchemaCache struct {
	sync.Mutex
	value object
}

type service struct {
	metadata          object
	fixtureIngress    func(string) (requestSource, error)
	runtime           *runtimeState
	source            requestSource
	hub               hubPool
	jobs              controlJobs
	events            nativeEvents
	codex             nativeCodexState
	taskRecords       nativeTaskRecords
	waits             waitCalls
	schemas           nativeSchemaCache
	cleanup           []func()
	indexStartupDone  chan struct{}
	coordinationStart coordinationStartup
	desktop           func(context.Context, string, string, object) (any, error)
}

func (s *service) start(ctx context.Context) error {
	for _, start := range serviceStartup {
		if err := start(ctx, s); err != nil {
			return err
		}
	}
	return nil
}

func (s *service) close() {
	s.jobs.close()
	for _, clean := range slices.Backward(s.cleanup) {
		clean()
	}
	for _, name := range s.hub.names() {
		s.hub.forget(name)
	}
}

var managementSourceProjection func(object)
var validateTaskPanelArgs func(string, object) error
var panelControlSource func(context.Context) (requestSource, error)
var applyPriorDispatchPurpose func(string, object) error
var validateNetworkPreferences func(string, string) error
var applyIngressNetworkPreferences func(context.Context, *service, object) error

func (s *service) management(ctx context.Context, route, method string, body object) (any, error) {
	audit := method != "GET" && !slices.Contains([]string{"cli/control", "runtime/lease", "src-conversations/observe",
		"src-conversations/query", "logs/query", "agents/conversations", "agents/dispatch-catalog", "agents/dispatch-defaults/read",
		"tasks/dispatch-defaults/read", "agents/conversations/timeline", "state/wait", "setup/next", "setup/wait"}, route)
	var ingress any
	if name, ok := strings.CutPrefix(route, "ingress/"); ok {
		ingress, _, _ = strings.Cut(name, "/")
	}
	var operation any
	if audit {
		operation = id()
		if err := appendLog(object{"time": now(), "level": "INFO", "msg": fmt.Sprintf("%s %s: started", method, route),
			"operationId": operation, "ingressId": ingress, "phase": "started"}); err != nil {
			return nil, err
		}
	}
	value, err := s.managementRequest(ctx, route, method, body)
	if err == nil && managementSourceProjection != nil {
		managementSourceProjection(obj(value))
	}
	if audit || route == "runtime/lease" && err != nil {
		outcome, level := "succeeded", "INFO"
		if err != nil {
			outcome, level = "failed", "ERROR"
		}
		if err := appendLog(object{"time": now(), "level": level, "msg": fmt.Sprintf("%s %s: %s", method, route, outcome),
			"operationId": operation, "ingressId": ingress, "phase": outcome}); err != nil {
			fmt.Fprintln(os.Stderr, "Cannot persist operation outcome:", err)
		}
	}
	return value, err
}

func (s *service) managementRequest(ctx context.Context, route, method string, body object) (any, error) {
	ctx = runtimeReadCost(ctx, route, method)
	if handler, params := resolveRoute(method, route); handler != nil {
		return handler(ctx, s, body, params)
	}
	if desktopOperation(route, method) {
		if s.desktop != nil {
			return s.desktop(ctx, route, method, body)
		}
		if s.runtime != nil {
			return s.runtime.desktopRequest(ctx, route, method, body)
		}
	}
	if !knownManagementRoute(method, route) && !scopedManagementRoute(route) {
		return nil, errors.New("UNKNOWN_ROUTE")
	}
	return nil, errors.New(PortPending)
}

func panelTaskOperation(ctx context.Context, service *service, body object, schema string) (any, error) {
	if _, _, _, err := managementResolve(schema, object{"body": body}); err != nil {
		return nil, err
	}
	name := text(body, "op")
	args := clone(obj(body["args"]))
	if args == nil {
		args = object{}
	}
	if name == "codex_send" && args["purpose"] == nil {
		if applyPriorDispatchPurpose == nil {
			return nil, errors.New(PortPending)
		}
		if err := applyPriorDispatchPurpose(text(args, "threadId"), args); err != nil {
			return nil, err
		}
	}
	if (name == "codex_send" || name == "agent_send") && args["purpose"] == "self-test" {
		if _, exists := args["notify"]; !exists {
			args["notify"] = nil
		}
	}
	if panelControlSource == nil {
		return nil, errors.New(PortPending)
	}
	source, err := panelControlSource(ctx)
	if err != nil {
		return nil, err
	}
	policy := clone(defaultPolicy())
	source.policy = policy
	spec := operation(name)
	if spec == nil {
		return nil, errors.New("UNKNOWN_OP")
	}
	if invalid := checkSchema("op", name, name, spec["inputSchema"], args); invalid != nil {
		return nil, errors.New(wire(invalid))
	}
	if validateTaskPanelArgs != nil {
		if err := validateTaskPanelArgs(name, args); err != nil {
			return nil, err
		}
	}
	return executeOperation(withOrigin(ctx, source.origin), operationRequest{name, args, source, service, nil})
}

func (s *service) mcp(ctx context.Context, ingress string, request object) (object, error) {
	source := s.source
	if s.fixtureIngress != nil {
		var err error
		source, err = s.fixtureIngress(ingress)
		if err != nil {
			return nil, err
		}
	} else if ingress != "" && ingress != "default" {
		return nil, errors.New(PortPending)
	}
	return dispatchMCP(withMCPIngress(ctx, ingress), s, source, request)
}

func init() {
	registerRoute("POST", "tasks/control", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		return panelTaskOperation(ctx, s, body, "tasks.control")
	})
	registerRoute("POST", "agents/respond", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		return panelTaskOperation(ctx, s, body, "agents.respond")
	})
	registerRoute("GET", "healthz", func(_ context.Context, s *service, _ object, _ []string) (any, error) {
		return object{"runtime": s.metadata["runtime"], "instance": s.metadata["instance"], "pid": s.metadata["pid"], "owner": "core",
			"version": s.metadata["version"], "build": s.metadata["build"], "frontDoor": frontDoorStatus(text(s.metadata, "build"))}, nil
	})
	registerRoute("GET", "health", func(_ context.Context, s *service, _ object, _ []string) (any, error) {
		return object{"state": "ready", "instance": s.metadata["instance"], "pid": s.metadata["pid"], "version": s.metadata["version"],
			"build": s.metadata["build"], "frontDoor": frontDoorStatus(text(s.metadata, "build"))}, nil
	})
	registerRoute("GET", "status", func(ctx context.Context, s *service, _ object, _ []string) (any, error) {
		return s.status(ctx)
	})
	registerRoute("GET", "core", func(ctx context.Context, s *service, _ object, _ []string) (any, error) {
		status, err := s.status(ctx)
		return status["core"], err
	})
	registerRoute("GET", "capabilities", func(_ context.Context, _ *service, _ object, _ []string) (any, error) {
		return managementCatalog(), nil
	})
	registerRoute("GET", "tool-catalog", func(_ context.Context, _ *service, _ object, _ []string) (any, error) {
		return toolExposureCatalog(), nil
	})
	registerRoute("GET", "network", func(_ context.Context, _ *service, _ object, _ []string) (any, error) {
		if value, err := cachedLoad(filepath.Join(root(), "app/preferences.json")); err == nil {
			return value, nil
		}
		return object{"proxyMode": "system", "proxyUrl": ""}, nil
	})
	registerRoute("PUT", "network", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		mode, modeOK := body["proxyMode"].(string)
		if !modeOK {
			return nil, errors.New("invalid proxy mode")
		}
		address, addressOK := body["proxyUrl"].(string)
		if !addressOK {
			return nil, errors.New("invalid proxy URL")
		}
		if validateNetworkPreferences == nil {
			return nil, errors.New(PortPending)
		}
		if err := validateNetworkPreferences(mode, address); err != nil {
			return nil, err
		}
		if err := save(filepath.Join(root(), "app/preferences.json"), body); err != nil {
			return nil, err
		}
		if applyIngressNetworkPreferences != nil {
			if err := applyIngressNetworkPreferences(ctx, s, body); err != nil {
				return nil, err
			}
		}
		return object{"ok": true}, nil
	})
	registerRoute("POST", "state/wait", func(ctx context.Context, s *service, args object, _ []string) (any, error) {
		return s.waitState(ctx, args)
	})
}

func toolExposureCatalog() object {
	domain := catalog()
	exposure := obj(domain["toolExposure"])
	local := requestSource{local: true, policy: "all"}
	tools := make([]object, 0, len(arr(domain["ops"])))
	for _, spec := range arr(domain["ops"]) {
		name := text(spec, "name")
		item := clone(obj(field(exposure["tools"], name)))
		if item == nil {
			item = object{"group": "native", "presets": []any{}, "requires": []string{"control_output"}}
		}
		item["name"], item["description"], item["via"] = name, field(spec, "description"), via(obj(spec))
		item["available"] = operationFeatureAvailable(local, name)
		tools = append(tools, item)
	}
	return object{"groups": exposure["groups"], "required": exposure["required"], "tools": tools}
}

// Providers can contribute their ordinary status fields during the parallel port.
var statusContributions []func(context.Context, *service, object) error
var readStatusTaskRecords func(context.Context, *service) ([]object, error)

func registerStatusContribution(contribute func(context.Context, *service, object) error) {
	statusContributions = append(statusContributions, contribute)
}

func (s *service) ingressStatuses(ctx context.Context) ([]object, error) {
	if readIngressStatuses == nil {
		return []object{}, nil
	}
	items, err := readIngressStatuses(ctx, s)
	if items == nil && err == nil {
		items = []object{}
	}
	return items, err
}

func (s *service) status(ctx context.Context) (object, error) {
	defer beginRuntimeWork("status")()
	items, err := s.ingressStatuses(ctx)
	if err != nil {
		return nil, err
	}
	recordRuntimeWork(ctx, runtimeWorkCost{Owner: "status", Reason: "poll", Rows: len(items), ScanSet: len(items)})
	logs := recentLogs(nil)
	core := object{"pid": s.metadata["pid"], "desktop": object{"state": "unknown"}, "appServer": object{"state": "unknown"},
		"chatgpt": object{}, "resources": coreResourceStatus(), "logs": logs, "version": buildVersion,
		"backendSession": s.metadata["instance"], "activeTurns": 0, "liveProcesses": 0, "uncertain": false, "draining": false,
		"account": object{"state": "unknown", "observedAt": nil}, "lastInbound": nil, "schemaDiscovered": "unknown",
		"operationVerified": "business-delivery-not-assessed", "activeWrites": controlJobCount(s), "pendingInteractions": s.events.countPending(),
		"toolCount": len(arr(catalog()["tools"])), "opCount": len(arr(catalog()["ops"])), "package": object{"version": buildVersion, "sha": "native"}}
	running, ready := 0, 0
	for _, item := range items {
		if item["running"] == true {
			running++
		}
		if item["state"] == "ready" {
			ready++
		}
	}
	state := "stopped"
	switch {
	case ready > 0:
		state = "ready"
	case running > 0:
		state = "starting"
	}
	core["transport"], core["registered"] = object{"state": state}, running > 0
	config := object{"configured": false}
	if ingressConfigDefaults != nil {
		config = ingressConfigDefaults()
		config["configured"] = false
		if ingressConfigSecrets != nil {
			for _, key := range ingressConfigSecrets() {
				delete(config, key)
			}
		}
	}
	result := object{"config": config, "version": buildVersion, "platform": platformName(), "cliPath": cliExecutable(),
		"connection": object{"running": false, "mcpUrl": ""}, "tunnel": object{"state": "stopped", "error": ""},
		"connector": object{"state": state}, "preferences": readPreferences(), "logs": logs, "core": core,
		"frontDoor": frontDoorStatus(text(s.metadata, "build")), "ingresses": items,
		"taskApprovalEnabled": nil, "autoOpenCodex": nil, "requestRoutingDelaySeconds": nil, "desktopRecovery": nil,
		"ingressSummary": object{"running": running, "ready": ready, "total": len(items)}}
	if expected, err := expectedRemote(); err == nil {
		result["remoteFaults"] = slices.DeleteFunc(expected, func(row object) bool {
			return slices.ContainsFunc(items, func(actual object) bool { return actual["id"] == row["id"] && actual["state"] == "ready" })
		})
	}
	for _, contribute := range statusContributions {
		if err := contribute(ctx, s, result); err != nil {
			return nil, err
		}
	}
	diagnostics := statusDiagnostics(result, items)
	var records []object
	err = errors.New(PortPending)
	if readStatusTaskRecords != nil {
		records, err = readStatusTaskRecords(ctx, s)
	}
	receiptDiagnostics(diagnostics, records, err)
	result["diagnostics"] = diagnostics
	return result, nil
}

func (s *service) waitState(ctx context.Context, args object) (object, error) {
	timeout := time.Duration(min(uintOr(args["timeoutMs"], 30000), 30000)) * time.Millisecond
	deadline := time.Now().Add(timeout)
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		entries, err := s.ingressStatuses(ctx)
		if err != nil {
			return nil, err
		}
		recordRuntimeWork(ctx, runtimeWorkCost{Owner: "scoped-wait", Reason: "poll", Rows: len(entries), ScanSet: len(entries)})
		states := []object{}
		matched := true
		expected, hasExpected := args["state"].(string)
		for _, item := range entries {
			if id, ok := args["ingressId"].(string); ok && item["id"] != id {
				continue
			}
			states = append(states, object{"id": item["id"], "state": item["state"], "running": item["running"], "error": item["error"], "url": item["url"]})
			matched = matched && item["state"] == expected
		}
		slices.SortFunc(states, func(a, b object) int { return strings.Compare(text(a, "id"), text(b, "id")) })
		snapshot := object{"instance": s.metadata["instance"], "ingresses": states, "preferences": readPreferences()}
		cursor := hash([]byte(wire(snapshot)))
		changed := cursor != text(args, "cursor")
		if hasExpected {
			matched = matched && len(states) != 0
		} else {
			matched = changed
		}
		if matched || !time.Now().Before(deadline) {
			return object{"cursor": cursor, "changed": changed, "conditionMet": matched, "timedOut": !matched, "snapshot": snapshot, "observedAt": now()}, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-tick.C:
		}
	}
}
