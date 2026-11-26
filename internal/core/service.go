package core

import (
	"context"
	"errors"
	"net/http"
	"strings"
)

type service struct {
	metadata object
	runtime  *runtimeState
	source   requestSource
	desktop  func(context.Context, string, string, object) (any, error)
}

func (s *service) management(ctx context.Context, route, method string, body object) (any, error) {
	switch method + " " + route {
	case "GET healthz":
		return object{"runtime": "go", "instance": s.metadata["instance"], "pid": s.metadata["pid"], "owner": "core",
			"version": s.metadata["version"], "build": s.metadata["build"], "frontDoor": nil}, nil
	case "GET health":
		return object{"state": "ready", "instance": s.metadata["instance"], "pid": s.metadata["pid"], "version": s.metadata["version"],
			"build": s.metadata["build"], "frontDoor": nil}, nil
	case "POST cli/control":
		return localControl(requestSource{local: true, origin: object{"controlTransport": "cli"}, policy: "all"}, body), nil
	case "POST runtime/lease", "POST runtime/release", "POST runtime/shutdown":
		return s.runtime.request(route, body)
	case "GET status":
		return object{"version": buildVersion, "platform": platformName(), "cliPath": cliExecutable(), "preferences": readPreferences()}, nil
	case "GET preferences":
		return readPreferences(), nil
	case "PUT preferences":
		return changePreferences(body, false)
	case "POST preferences/import":
		return changePreferences(body, true)
	case "GET logs", "POST logs/query":
		return queryLogs(body)
	case "POST operations":
		return submitManagementOperation(ctx, s, body)
	}
	if method == http.MethodGet {
		if key, ok := strings.CutPrefix(route, "operations/"); ok {
			return readManagementReceipt(key, text(s.metadata, "instance"))
		}
	}
	if s.desktop != nil && desktopRoute(route) {
		return s.desktop(ctx, route, method, body)
	}
	if !knownManagementRoute(method, route) && !strings.HasPrefix(route, "runtime/") {
		return nil, errors.New("UNKNOWN_ROUTE")
	}
	return nil, errors.New(PortPending)
}

func (s *service) mcp(ctx context.Context, ingress string, request object) (object, error) {
	if ingress != "" && ingress != "default" {
		return nil, errors.New(PortPending)
	}
	return dispatchMCP(s.source, request)
}
