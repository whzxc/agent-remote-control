package core

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

type managementHandler func(context.Context, *service, object, []string) (any, error)

type registeredRoute struct {
	pattern *regexp.Regexp
	handle  managementHandler
}

var staticRoutes = make(map[string]managementHandler)
var patternedRoutes = make(map[string][]registeredRoute)
var registeredPatterns = make(map[string]bool)
var catalogContributions []func(object)
var serviceStartup []func(context.Context, *service) error

func registerRoute(method, route string, handler managementHandler) {
	key := method + " " + route
	if handler == nil || staticRoutes[key] != nil {
		panic(fmt.Sprintf("Invalid or duplicate management route %s", key))
	}
	staticRoutes[key] = handler
}

func registerRoutePattern(method, pattern string, handler managementHandler) {
	key := method + " " + pattern
	if handler == nil || registeredPatterns[key] {
		panic(fmt.Sprintf("Invalid or duplicate management route pattern %s", key))
	}
	registeredPatterns[key] = true
	patternedRoutes[method] = append(patternedRoutes[method], registeredRoute{
		pattern: regexp.MustCompile("^(?:" + pattern + ")$"),
		handle:  handler,
	})
}

func resolveRoute(method, route string) (managementHandler, []string) {
	if handler := staticRoutes[method+" "+route]; handler != nil {
		return handler, nil
	}
	for _, entry := range patternedRoutes[method] {
		if matches := entry.pattern.FindStringSubmatch(route); matches != nil {
			return entry.handle, matches[1:]
		}
	}
	return nil, nil
}

func registerManagementCatalog(contribute func(object)) {
	catalogContributions = append(catalogContributions, contribute)
}

func registerServiceStartup(start func(context.Context, *service) error) {
	serviceStartup = append(serviceStartup, start)
}

func scopedManagementRoute(route string) bool {
	return strings.HasPrefix(route, "runtime/")
}
