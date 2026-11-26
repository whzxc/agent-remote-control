package core

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
		if _, err := cachedJSONWithRuntimeCost(path, currentRuntimeCost(inner)); err != nil {
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
