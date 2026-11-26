package core

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
)

func TestCoordinationRetainedOwnersAvoidIdleReceiptAndMessageParsing(t *testing.T) {
	// Recurring bug class: persistence retained owners must not traverse or parse unchanged canonical history on each idle read.
	directory := t.TempDir()
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
			if err := save(path, row); err != nil {
				t.Fatal(err)
			}
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
	cost := new(runtimeCost)
	next := mail.nextBackgroundAt(1040, cost)
	cold := cost.rows.Load()
	for range 3 {
		if got := mail.nextBackgroundAt(1040, cost); got != next {
			t.Fatalf("message deadline changed: %d", got)
		}
	}
	if cost.rows.Load() != cold {
		t.Fatalf("idle message scheduler rescanned %d rows", cost.rows.Load()-cold)
	}
}
