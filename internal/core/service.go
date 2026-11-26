package core

import (
	"context"
	"errors"
	"slices"
)

type service struct {
	metadata       object
	fixtureIngress func(string) (requestSource, error)
	runtime        *runtimeState
	source         requestSource
	hub            hubPool
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
	if s.desktop != nil && desktopRoute(route) {
		return s.desktop(ctx, route, method, body)
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
	registerRoute("GET", "status", func(_ context.Context, s *service, _ object, _ []string) (any, error) {
		return s.status(), nil
	})
}

func (s *service) status() object {
	return object{"version": buildVersion, "platform": platformName(), "cliPath": cliExecutable(), "preferences": readPreferences()}
}
