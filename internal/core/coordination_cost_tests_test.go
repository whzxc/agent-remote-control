package core

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoordinationRetainedOwnersAvoidIdleReceiptAndMessageParsing(t *testing.T) {
	// Recurring bug class: persistence retained owners must not traverse or parse unchanged canonical history on each idle read.
	directory := t.TempDir()
	t.Setenv("ARC_STATE_DIR", directory)
	ctx := t.Context()
	costs := new(runtimeCostSet)
	ctx = context.WithValue(ctx, runtimeCostKey{}, runtimeCostContext{set: costs})
	store := receiptStore{base: directory}
	agent := receiptStore{base: filepath.Join(directory, "agents/requests")}
	t.Cleanup(func() { closeReceiptIndex(store.base); closeReceiptIndex(agent.base) })
	for _, owner := range []receiptStore{store, agent} {
		for range 48 {
			key := id()
			path, err := owner.path(key)
			if err != nil {
				t.Fatal(err)
			}
			row := object{"requestId": key, "state": "completed", "operation": "command", "backendSession": "backend",
				"result": object{"output": "Unrelated fixture output"}}
			saveKernelRow(t, path, row)
		}
		if err := seedReceiptIndex(ctx, owner.base); err != nil {
			t.Fatal(err)
		}
		closeReceiptIndex(owner.base)
	}
	restartCosts := new(runtimeCostSet)
	restart := context.WithValue(ctx, runtimeCostKey{}, runtimeCostContext{set: restartCosts})
	restart = withReceiptAdoptionPass(restart)
	for _, owner := range []receiptStore{store, agent} {
		if err := seedReceiptIndex(restart, owner.base); err != nil {
			t.Fatal(err)
		}
	}
	adopt := restartCosts.snapshot()["receiptAdopt"]
	if field(adopt, "passes") != uint64(1) || field(adopt, "rowsVisited") != uint64(96) {
		t.Fatalf("receipt adoption = %v", adopt)
	}
	var revision *uint64
	for range 3 {
		next, _, updates, err := receiptProjectionUpdates(restart, store.base, revision)
		if err != nil {
			t.Fatal(err)
		}
		if revision != nil && len(updates) != 0 {
			t.Fatalf("unchanged receipt projection = %d rows", len(updates))
		}
		revision = &next
	}
	projection := restartCosts.snapshot()["receiptProjection"]
	if field(projection, "bytesParsed") != uint64(0) || wire(restartCosts.snapshot()["receiptAdopt"]) != wire(adopt) {
		t.Fatalf("idle projection = %v, adoption = %v", projection, restartCosts.snapshot()["receiptAdopt"])
	}
	mail, err := openCoordinationMessageStore(filepath.Join(directory, "coordination/messages/state.json"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 32 {
		sendCoordinationMail(t, mail, "one", "two", "notice", int64(1000+i), object{"summary": fmt.Sprintf("Fixture notice %d", i)})
	}
	readStatuses := readIngressStatuses
	t.Cleanup(func() { readIngressStatuses = readStatuses })
	readIngressStatuses = func(context.Context, *service) ([]object, error) {
		return []object{{"id": "fixture-ingress", "state": "ready", "running": true}}, nil
	}
	service := &service{metadata: object{"instance": "fixture"}}
	queueContext := withOrigin(restart, object{"sourceId": "source"})
	var queuePath string
	var fixtureQueue object
	for n := range 44 {
		queueID := id()
		path := filepath.Join(directory, "send-queue", queueID+".json")
		row := object{"queueId": queueID, "threadId": fmt.Sprintf("thread-%d", n), "sequence": n,
			"state": "completed", "origin": object{"sourceId": "source"}, "args": object{"prompt": strings.Repeat("q", 2000)}}
		if n == 0 {
			queuePath, fixtureQueue = path, row
		}
		saveKernelRow(t, path, row)
	}
	t.Cleanup(func() {
		if files := service.codex.queue.files; files != nil {
			files.close()
		}
	})
	git := filepath.Join(directory, "synthetic-repository", ".git")
	packed := strings.Repeat("1", 40) + " refs/heads/main\n"
	var refs strings.Builder
	refs.WriteString(packed)
	for n := range 3000 {
		fmt.Fprintf(&refs, "%s refs/tags/fixture-%d\n", strings.Repeat("2", 40), n)
	}
	if err := saveBytes(filepath.Join(git, "packed-refs"), []byte(refs.String())); err != nil {
		t.Fatal(err)
	}
	descriptors := make([]string, 36)
	for n := range descriptors {
		input := newCoordinationEvent(fmt.Sprintf("fixture-restart-%d", n), "app.restarted", []string{"app:installed"})
		path, err := coordinationPersist(input)
		if err != nil {
			t.Fatal(err)
		}
		descriptors[n] = path
	}
	reader := &coordinationRefReader{}
	observe := func() {
		t.Helper()
		observer := withRuntimeCost(restart, "coordinationObservers", "timer")
		for _, path := range descriptors {
			value, err := cachedJSONInContext(observer, path)
			if err != nil {
				t.Fatal(err)
			}
			if err := coordinationProject(observer, path, obj(value)); err != nil {
				t.Fatal(err)
			}
		}
		_, err := withCoordinationMessages(withRuntimeCost(restart, "coordinationMessages", "timer"), func(store *coordinationMessageStore, cost *runtimeCost) (int64, error) {
			return store.nextBackgroundAt(1040, cost), nil
		})
		if err != nil {
			t.Fatal(err)
		}
		gitCost := currentRuntimeCost(withRuntimeCost(restart, "coordinationGit", "timer"))
		if refs, err := reader.refs(git, gitCost); err != nil || len(refs) != 1 {
			t.Fatalf("fixture refs = %v, %v", refs, err)
		}
		queue, err := nativeDispatchQueueCounts(withRuntimeCost(queueContext, "dispatchQueue", "timer"), service)
		if err != nil || len(queue) != 0 {
			t.Fatalf("idle queue = %v, %v", queue, err)
		}
		if status, err := service.status(restart); err != nil || field(status["core"], "backendSession") != "fixture" || len(status["ingresses"].([]object)) != 1 {
			t.Fatalf("idle status = %v, %v", status, err)
		}
		next, _, pending, err := receiptProjectionUpdates(restart, store.base, revision)
		if err != nil || len(pending) != 0 {
			t.Fatalf("idle receipt projection = %v, %v", pending, err)
		}
		revision = &next
	}
	observe()
	warm, opens := restartCosts.snapshot(), cacheDiagnostics()["fileOpens"]
	for range 3 {
		observe()
	}
	after := restartCosts.snapshot()
	for _, owner := range []string{"coordinationObservers", "coordinationMessages", "coordinationGit", "dispatchQueue", "status", "receiptProjection"} {
		if field(after[owner], "bytesParsed") != field(warm[owner], "bytesParsed") {
			t.Fatalf("%s parsed unchanged canonical records: %v / %v", owner, warm[owner], after[owner])
		}
	}
	for _, owner := range []string{"coordinationMessages", "dispatchQueue", "receiptProjection"} {
		if field(after[owner], "rowsVisited") != field(warm[owner], "rowsVisited") {
			t.Fatalf("%s revisited unchanged rows: %v / %v", owner, warm[owner], after[owner])
		}
	}
	if cacheDiagnostics()["fileOpens"] != opens {
		t.Fatal("combined warm pass reopened canonical payloads")
	}
	fixtureQueue["state"] = "queued"
	saveKernelRow(t, queuePath, fixtureQueue)
	queue, err := nativeDispatchQueueCounts(queueContext, service)
	if err != nil || len(queue) != 1 || uintOr(queue["thread-0"]["pending"], 0) != 1 {
		t.Fatalf("changed queue = %v, %v", queue, err)
	}
}
