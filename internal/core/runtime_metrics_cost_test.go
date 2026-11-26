package core

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeTimelineRollout(t *testing.T, home, text string) string {
	t.Helper()
	path := filepath.Join(home, "sessions", "rollout.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return physicalPath(path)
}

func TestTimelineRoutesAttributeCompleteRolloutLines(t *testing.T) {
	// Contract: runtime_metrics attributes complete native timeline records to taskRead regardless of the management route.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	old := fixtureNativeCodexInputs
	fixtureNativeCodexInputs = func() (string, string, error) { return "unused", home, nil }
	t.Cleanup(func() { fixtureNativeCodexInputs = old })
	const thread = "01a00000-0000-7000-8000-000000000001"
	const rollout = `{"type":"session_meta","payload":{"id":"` + thread + `"}}` + "\n"
	s := &service{}
	s.codex.activity.known = map[string]string{thread: writeTimelineRollout(t, home, rollout+"{not yet complete")}
	projectCatalogs.Store(s, &projectCatalogCache{readAt: time.Now()})
	t.Cleanup(func() { projectCatalogs.Delete(s) })
	ctx := context.WithValue(t.Context(), runtimeCostKey{}, runtimeCostContext{set: new(runtimeCostSet)})
	for i, request := range []struct{ method, route string }{
		{http.MethodPost, "agents/conversations/timeline"}, {http.MethodGet, "agents/timeline/" + thread},
	} {
		if _, err := s.managementRequest(ctx, request.route, request.method, object{"id": thread, "agent": "codex"}); err != nil {
			t.Fatalf("%s: %v", request.route, err)
		}
		metrics, err := s.managementRequest(ctx, "runtime/metrics", http.MethodGet, nil)
		cost := field(field(metrics, "cost"), "taskRead")
		passes := uint64(i + 1)
		if err != nil || field(cost, "passes") != passes || field(cost, "rowsVisited") != passes ||
			field(cost, "bytesRead") != passes*uint64(len(rollout)) || field(cost, "bytesParsed") != field(cost, "bytesRead") {
			t.Fatalf("timeline cost for %s = %v, %v", request.route, cost, err)
		}
	}
}

func TestRuntimeCostsAttributeNestedCacheReadsOnce(t *testing.T) {
	// Contract: runtime_metrics attributes shared reads to the innermost owner and keeps content private.
	costs := new(runtimeCostSet)
	ctx := context.WithValue(t.Context(), runtimeCostKey{}, runtimeCostContext{set: costs})
	path := filepath.Join(t.TempDir(), "record.json")
	data := []byte(`{"fixtureSecret":"private-task-content"}`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		outer := withRuntimeCost(ctx, "taskRecords", "poll")
		outer = withRuntimeCost(outer, "taskRecords", "poll")
		inner := withRuntimeCost(outer, "receiptProjection", "poll")
		if _, err := cachedJSONInContext(inner, path); err != nil {
			t.Fatal(err)
		}
	}
	value, err := runtimeMetrics(ctx, operationRequest{})
	if err != nil {
		t.Fatal(err)
	}
	projection := obj(field(field(value, "cost"), "receiptProjection"))
	baseline := obj(field(field(value, "cost"), "taskRecords"))
	want := object{"rowsVisited": 2, "bytesRead": len(data), "bytesParsed": len(data), "cacheMisses": 1, "cacheHits": 1}
	for item, expected := range want {
		if wire(projection[item]) != wire(expected) {
			t.Errorf("%s = %v, want %v", item, projection[item], expected)
		}
	}
	if baseline["passes"] != uint64(2) || baseline["bytesRead"] != uint64(0) {
		t.Fatalf("enclosing owner cost = %v", baseline)
	}
	if body := wire(value); strings.Contains(body, path) || strings.Contains(body, "private-task-content") {
		t.Fatal("metrics contain private evidence")
	}
}

func TestRuntimeCostContextPropagatesThroughConcurrentWork(t *testing.T) {
	// Recurring bug class: concurrency attribution must stay with the inherited owner when scopes overlap.
	costs := new(runtimeCostSet)
	ctx := context.WithValue(t.Context(), runtimeCostKey{}, runtimeCostContext{set: costs})
	parent := withRuntimeCost(ctx, "browserGuard", "poll")
	done := make(chan int, 2)
	for _, name := range []string{"environmentRead", "coordinationRead"} {
		go func() {
			contents := make([]byte, 64*1024)
			child := withRuntimeCost(parent, name, "event")
			currentRuntimeCost(child).read.Add(uint64(len(contents)))
			done <- len(contents)
		}()
	}
	for range 2 {
		if n := <-done; n != 65536 {
			t.Fatalf("length = %d", n)
		}
	}
	snapshot := costs.snapshot()
	for _, name := range []string{"environmentRead", "coordinationRead"} {
		if field(snapshot[name], "bytesRead") != uint64(65536) || field(snapshot[name], "passes") != uint64(1) {
			t.Fatalf("%s = %v", name, snapshot[name])
		}
	}
	if field(snapshot["browserGuard"], "bytesRead") != uint64(0) {
		t.Fatal("parent inherited a nested owner's bytes")
	}
}

func TestRuntimeCostsAttributeNotificationOwnerWorkByPartition(t *testing.T) {
	// Contract: notification observer and delivery scans publish separate size and visit counts in runtime_metrics.
	costs := new(runtimeCostSet)
	ctx := context.WithValue(t.Context(), runtimeCostKey{}, runtimeCostContext{set: costs})
	recordRuntimeWork(ctx, runtimeWorkCost{Owner: "notification", Reason: "active", Rows: 2, ScanSet: 2})
	recordRuntimeWork(ctx, runtimeWorkCost{Owner: "notification", Reason: "delivery-due", Rows: 1, ScanSet: 1})
	recordRuntimeWork(ctx, runtimeWorkCost{Owner: "notification", Reason: "thread", Rows: 10, ScanSet: 10})
	value, err := runtimeMetrics(ctx, operationRequest{})
	if err != nil {
		t.Fatal(err)
	}
	for owner, rows := range map[string]uint64{"notificationObserver": 2, "notificationDelivery": 1} {
		cost := field(field(value, "cost"), owner)
		if field(cost, "passes") != uint64(1) || field(cost, "rowsVisited") != rows || field(cost, "scanSetSize") != rows {
			t.Fatalf("%s cost = %v", owner, cost)
		}
	}
}
