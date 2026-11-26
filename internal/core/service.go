package core

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

type service struct {
	metadata       object
	fixtureIngress func(string) (requestSource, error)
	runtime        *runtimeState
	source         requestSource
	hub            hubPool
	jobs           controlJobs
	cleanup        []func()
	desktop        func(context.Context, string, string, object) (any, error)
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

func (s *service) management(ctx context.Context, route, method string, body object) (any, error) {
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
	return dispatchMCP(ctx, s, source, request)
}

func init() {
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
	registerRoute("GET", "capabilities", func(_ context.Context, _ *service, _ object, _ []string) (any, error) {
		return managementCatalog(), nil
	})
	registerRoute("GET", "network", func(_ context.Context, _ *service, _ object, _ []string) (any, error) {
		if value, err := load(filepath.Join(root(), "app/preferences.json")); err == nil {
			return value, nil
		}
		return object{"proxyMode": "system", "proxyUrl": ""}, nil
	})
	registerRoute("POST", "state/wait", func(ctx context.Context, s *service, args object, _ []string) (any, error) {
		return s.waitState(ctx, args)
	})
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
	items, err := s.ingressStatuses(ctx)
	if err != nil {
		return nil, err
	}
	logs := recentLogs(nil)
	core := object{"pid": s.metadata["pid"], "desktop": object{"state": "unknown"}, "appServer": object{"state": "unknown"},
		"chatgpt": object{}, "resources": coreResourceStatus(), "logs": logs, "version": buildVersion,
		"backendSession": s.metadata["instance"], "activeTurns": 0, "liveProcesses": 0, "uncertain": false, "draining": false,
		"account": object{"state": "unknown", "observedAt": nil}, "lastInbound": nil, "schemaDiscovered": "unknown",
		"operationVerified": "business-delivery-not-assessed", "activeWrites": controlJobCount(s), "pendingInteractions": 0,
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
	result := object{"config": object{"configured": false}, "version": buildVersion, "platform": platformName(), "cliPath": cliExecutable(),
		"connection": object{"running": false, "mcpUrl": ""}, "tunnel": object{"state": "stopped", "error": ""},
		"connector": object{"state": state}, "preferences": readPreferences(), "logs": logs, "core": core,
		"frontDoor": frontDoorStatus(text(s.metadata, "build")), "ingresses": items,
		"ingressSummary": object{"running": running, "ready": ready, "total": len(items)}}
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
