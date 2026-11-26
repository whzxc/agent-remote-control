package core

import (
	"context"
	"strings"
	"sync/atomic"
)

var runtimeCostOwners = [...]string{
	"indexUpdate", "notificationAdopt", "receiptAdopt", "notificationSeed", "receiptSeed", "indexRepair",
	"notificationObserver", "notificationDelivery", "taskRecords", "agentTaskRecords", "receiptProjection",
	"taskFeed", "taskList", "dispatchQueue", "coordinationObservers", "coordinationGit", "coordinationMessages",
	"runtimeLease", "ingress", "relay", "subscriptions", "mcpSweep", "desktopSnapshots", "agentProcess", "status",
	"activity", "accounts", "taskRead", "coordinationRead", "routingRead", "environmentRead", "relayJobRead",
	"browserGuard", "waitHeartbeat", "scopedWait", "draftExpiry", "bulletinMaintenance",
}
var runtimeCostReasons = [...]string{"startup", "timer", "event", "dirty", "deadline", "poll"}

type runtimeCost struct {
	passes, rows, changed, read, parsed, hits, misses, scanSet atomic.Uint64
	retained, observed, dormant                                atomic.Uint64
	wakes                                                      [len(runtimeCostReasons)]atomic.Uint64
}

type runtimeCostSet [len(runtimeCostOwners)]runtimeCost
type runtimeCostContext struct {
	set   *runtimeCostSet
	owner string
}

type runtimeCostKey struct{}

var runtimeCosts runtimeCostSet

func (costs *runtimeCostSet) counter(owner string) *runtimeCost {
	for i, name := range runtimeCostOwners {
		if name == owner {
			return &costs[i]
		}
	}
	panic("Unknown runtime cost owner " + owner)
}

func (cost *runtimeCost) wake(reason string) {
	for i, name := range runtimeCostReasons {
		if name == reason {
			cost.wakes[i].Add(1)
			return
		}
	}
	panic("Unknown runtime cost reason " + reason)
}

// The context carries attribution into synchronous calls and child goroutines.
// Entering the same owner again leaves the enclosing pass in effect.
func withRuntimeCost(ctx context.Context, owner, reason string) context.Context {
	scope, ok := ctx.Value(runtimeCostKey{}).(runtimeCostContext)
	if !ok {
		scope.set = &runtimeCosts
	}
	if scope.owner == owner {
		return ctx
	}
	cost := scope.set.counter(owner)
	cost.passes.Add(1)
	cost.wake(reason)
	scope.owner = owner
	return context.WithValue(ctx, runtimeCostKey{}, scope)
}

func currentRuntimeCost(ctx context.Context) *runtimeCost {
	scope, ok := ctx.Value(runtimeCostKey{}).(runtimeCostContext)
	if !ok || scope.owner == "" {
		return nil
	}
	return scope.set.counter(scope.owner)
}

func (costs *runtimeCostSet) snapshot() object {
	result := object{}
	for i, owner := range runtimeCostOwners {
		cost := &costs[i]
		wakes := object{}
		for j, reason := range runtimeCostReasons {
			wakes[reason] = cost.wakes[j].Load()
		}
		var bindings any
		if owner == "notificationObserver" {
			bindings = object{"retained": cost.retained.Load(), "observed": cost.observed.Load(), "dormant": cost.dormant.Load()}
		}
		result[owner] = object{
			"passes": cost.passes.Load(), "wakesByReason": wakes,
			"rowsVisited": cost.rows.Load(), "recordsChanged": cost.changed.Load(),
			"bytesRead": cost.read.Load(), "bytesParsed": cost.parsed.Load(),
			"cacheHits": cost.hits.Load(), "cacheMisses": cost.misses.Load(), "scanSetSize": cost.scanSet.Load(),
			"bindings": bindings,
		}
	}
	return result
}

func runtimeReadCost(ctx context.Context, route, method string) context.Context {
	var owner string
	switch route {
	case "tasks/request-routing", "tasks/presence":
		owner = "routingRead"
	case "app/env":
		owner = "environmentRead"
	case "coordination/board", "coordination/events", "coordination/messages", "coordination/ax_list", "coordination/conflicts":
		owner = "coordinationRead"
	default:
		switch {
		case strings.HasPrefix(route, "relay/") && method == "GET":
			owner = "relayJobRead"
		case strings.HasPrefix(route, "tasks/") && (method == "GET" || strings.HasSuffix(route, "timeline")):
			owner = "taskRead"
		}
	}
	return runtimePollCost(ctx, owner)
}

func runtimeOperationCost(ctx context.Context, op string) context.Context {
	var owner string
	switch op {
	case "codex_read", "task_timeline", "task_reviews", "codex_review", "dispatch_policy", "agent_read", "agent_review", "receipt":
		owner = "taskRead"
	case "board", "events", "messages", "ax_list":
		owner = "coordinationRead"
	case "app_env":
		owner = "environmentRead"
	}
	return runtimePollCost(ctx, owner)
}

func runtimePollCost(ctx context.Context, owner string) context.Context {
	if owner == "" {
		return ctx
	}
	ctx = withRuntimeCost(ctx, owner, "poll")
	currentRuntimeCost(ctx).scanSet.Store(1)
	return ctx
}
