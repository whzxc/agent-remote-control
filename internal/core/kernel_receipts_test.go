package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testReceiptSession = "fixture-session"

func testReceiptStore(t *testing.T) receiptStore {
	t.Helper()
	store := receiptStore{base: t.TempDir()}
	t.Cleanup(func() { closeReceiptIndex(store.base) })
	return store
}

func reserveTestReceipt(t *testing.T, store receiptStore, row object) object {
	t.Helper()
	if row["requestId"] == nil {
		row["requestId"] = id()
	}
	row["backendSession"] = testReceiptSession
	if err := store.reserve(context.Background(), row); err != nil {
		t.Fatal(err)
	}
	return row
}

func assertProjectedReceipt(t *testing.T, store receiptStore, request, session, state string) object {
	t.Helper()
	result, err := store.projected(context.Background(), request, session)
	if err != nil || result["state"] != state || result["requestId"] != request {
		t.Fatalf("projected %s = %v, %v", request, result, err)
	}
	return result
}

func TestReceiptTimeoutReturnsExecutionProgress(t *testing.T) {
	// Recurring bug class: lifecycle wait timeouts returned pending snapshots after execution already started.
	store := testReceiptStore(t)
	ctx := context.Background()
	for _, op := range []string{"command", "create", "send", "agent_create", "agent_send", "write", "fs", "notice_post", "ax_report", "message_send"} {
		row := reserveTestReceipt(t, store, object{"state": "reserved", "operation": op, "createdAt": "2000-01-01T00:00:00Z"})
		request := text(row, "requestId")
		owner, err := store.begin(ctx, row)
		if err != nil {
			t.Fatal(err)
		}
		defer owner.close()
		waited, err := store.wait(ctx, request, testReceiptSession, 0, make(chan receiptExecutionResult))
		if err != nil {
			t.Fatal(err)
		}
		read, err := store.read(request, testReceiptSession)
		if err != nil {
			t.Fatal(err)
		}
		for _, value := range []object{waited, read} {
			public := publicReceipt(value)
			receiptNext(public, object{})
			args := field(public["next"], "args")
			if public["state"] != "executing" || public["submissionState"] != "submitted" || public["executionState"] != "executing" ||
				public["progressStalled"] != false || field(args, "requestId") != request || field(args, "action") != "read" ||
				strings.Contains(text(public["next"], "hint"), "stalled") {
				t.Fatalf("%s progress = %v", op, public)
			}
		}
		assertProjectedReceipt(t, store, request, testReceiptSession, "executing")
	}
}

func TestReceiptRetainsUnconfirmedOriginalAcrossOwnerLoss(t *testing.T) {
	// Recurring bug class: retry-replay interrupted submission lost the original request or let caller retries resubmit it.
	ctx := context.Background()
	store := testReceiptStore(t)
	row := reserveTestReceipt(t, store, object{"state": "reserved", "operation": "agent_send", "taskId": "fixture-task",
		"digest": "fixture-digest", "origin": currentOrigin(ctx)})
	request := text(row, "requestId")
	restarted, err := store.read(request, "new-session")
	if err != nil || restarted["state"] != "unconfirmed" || restarted["requestId"] != request {
		t.Fatalf("after restart = %v, %v", restarted, err)
	}
	owner, err := store.begin(ctx, row)
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan receiptExecutionResult)
	close(results)
	lost, err := store.wait(ctx, request, testReceiptSession, 10*time.Second, results)
	if err != nil {
		t.Fatal(err)
	}
	owner.close()
	public := publicReceipt(lost)
	receiptNext(public, object{})
	args := field(public["next"], "args")
	if public["state"] != "unconfirmed" || public["submissionState"] != "unconfirmed" || public["progressStalled"] != false ||
		field(public["next"], "op") != "receipt" || field(args, "action") != "read" || field(args, "requestId") != request {
		t.Fatalf("loss receipt = %v", public)
	}
	replay, err := store.replay(ctx, request, "fixture-digest", "new-session")
	if err != nil || replay["state"] != "unconfirmed" || replay["requestId"] != request || replay["replayed"] != true {
		t.Fatalf("original receipt replay = %v, %v", replay, err)
	}
	if _, err := store.begin(ctx, replay); err == nil {
		t.Fatal("unconfirmed original was resubmitted")
	}
	assertProjectedReceipt(t, store, request, testReceiptSession, "unconfirmed")
	replay["state"] = string(advanceReceipt(receiptUnconfirmed, receiptComplete, ""))
	if err := store.checkpoint(ctx, replay); err != nil {
		t.Fatal(err)
	}
	assertProjectedReceipt(t, store, request, "new-session", "completed")
}

func TestSettledReceiptPreservesOutcomeAfterRestart(t *testing.T) {
	// Recurring bug class: persistence ownership changes discarded settled operation results and errors.
	store := testReceiptStore(t)
	for _, state := range []string{"completed", "failed"} {
		row := reserveTestReceipt(t, store, object{"state": state, "operation": "create", "result": object{"threadId": "fixture"},
			"error": object{"message": "failure"}, "origin": object{"sourceId": "controller"}})
		read, err := store.read(text(row, "requestId"), "next-session")
		if err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"requestId", "state", "operation", "result", "error", "origin"} {
			if wire(read[key]) != wire(row[key]) {
				t.Fatalf("%s %s lost after owner restart: %v", state, key, read)
			}
		}
		if read["submissionState"] != "submitted" || read["executionState"] != state || read["progressStalled"] != false {
			t.Fatalf("settled state = %v", read)
		}
		assertProjectedReceipt(t, store, text(row, "requestId"), "next-session", state)
	}
}

func TestReceiptAndTaskPollsRefreshOnlyChangedRows(t *testing.T) {
	// Recurring bug class: persistence retained receipts were reprojected on unchanged polls or one changed row.
	ctx := context.Background()
	for _, history := range []int{4, 40} {
		store := testReceiptStore(t)
		for range history {
			reserveTestReceipt(t, store, object{"state": "completed"})
		}
		active := reserveTestReceipt(t, store, object{"state": "executing"})
		request := text(active, "requestId")
		var projection taskProjection
		defer projection.close()
		visits := 0
		poll := func() []object {
			rows, err := projection.update(ctx, store, testReceiptSession, func(object) []string { return nil }, func(row object) (object, error) {
				visits++
				return row, nil
			}, func(row object) object { return row })
			if err != nil || len(rows) != history+1 {
				t.Fatalf("projection contains %d rows: %v", len(rows), err)
			}
			return rows
		}
		poll()
		poll()
		if visits != history+1 {
			t.Fatalf("idle projected %d rows", visits-history-1)
		}
		active["state"] = "completed"
		if err := store.checkpoint(ctx, active); err != nil {
			t.Fatal(err)
		}
		for _, row := range poll() {
			if row["requestId"] == request && row["state"] != "completed" {
				t.Fatalf("changed row = %v", row)
			}
		}
		if visits != history+2 {
			t.Fatalf("checkpoint reprojected %d rows", visits-history-1)
		}
		closeReceiptIndex(store.base)
		assertProjectedReceipt(t, store, request, "next-session", "completed")
	}
}

func TestReceiptIndexRestartAdoptsAndRepairsInterruptedKey(t *testing.T) {
	// Recurring bug class: persistence restart rebuilt receipt history and lost a checkpoint interrupted after the canonical write.
	ctx := context.Background()
	store := testReceiptStore(t)
	for range 40 {
		reserveTestReceipt(t, store, object{"state": "completed", "result": object{"payload": strings.Repeat("x", 8192)}})
	}
	row := reserveTestReceipt(t, store, object{"state": "executing"})
	if err := seedReceiptIndex(ctx, store.base); err != nil {
		t.Fatal(err)
	}
	before, err := indexCurrent(store.base)
	if err != nil || before.Count != 41 {
		t.Fatalf("published manifest = %v, %v", before, err)
	}
	closeReceiptIndex(store.base)
	request := text(row, "requestId")
	path, _ := store.path(request)
	row["state"] = "completed"
	if err := indexMark(path); err != nil {
		t.Fatal(err)
	}
	saveKernelRow(t, path, row)
	assertProjectedReceipt(t, store, request, "next-session", "completed")
	after, err := indexCurrent(store.base)
	if err != nil || before != after {
		t.Fatalf("repair did not adopt prior generation: %v, %v", after, err)
	}
	if _, err := os.Stat(indexDirty(path)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("repair marker remained: %v", err)
	}
	closeReceiptIndex(store.base)
	assertProjectedReceipt(t, store, request, "next-session", "completed")
}

func TestReceiptIndexRebuildsInvalidOrInterruptedGeneration(t *testing.T) {
	// Recurring bug class: persistence missing, corrupt or incompatible indexes were adopted before a complete canonical rebuild.
	ctx := context.Background()
	store := testReceiptStore(t)
	row := reserveTestReceipt(t, store, object{"state": "reserved"})
	request := text(row, "requestId")
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := seedReceiptIndex(cancelled, store.base); err == nil {
		t.Fatal("cancelled rebuild was published")
	}
	assertProjectedReceipt(t, store, request, "new-session", "unconfirmed")
	for _, mode := range []string{"missing", "corrupt", "version"} {
		closeReceiptIndex(store.base)
		previous, err := indexCurrent(store.base)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(indexDirectory(store.base), "current.json")
		switch mode {
		case "missing":
			err = os.Remove(path)
		case "corrupt":
			err = os.WriteFile(path, []byte("{"), 0o600)
		case "version":
			previous.Version--
			err = indexWrite(path, previous)
		}
		if err != nil {
			t.Fatal(err)
		}
		assertProjectedReceipt(t, store, request, "new-session", "unconfirmed")
		rebuilt, err := indexCurrent(store.base)
		if err != nil || rebuilt.Count != 1 || rebuilt.Generation == previous.Generation {
			t.Fatalf("%s rebuild = %v, %v", mode, rebuilt, err)
		}
		closeReceiptIndex(store.base)
		assertProjectedReceipt(t, store, request, "new-session", "unconfirmed")
		adopted, err := indexCurrent(store.base)
		if err != nil || adopted != rebuilt {
			t.Fatalf("%s adoption = %v, %v", mode, adopted, err)
		}
	}
}

func TestReceiptIndexRebuildsChangedSourceAttribution(t *testing.T) {
	// Recurring bug class: persistence interrupted source migration left stale attribution in the receipt projection.
	ctx := context.Background()
	store := testReceiptStore(t)
	row := reserveTestReceipt(t, store, object{"state": "completed", "origin": object{"sourceId": "unmigrated"}})
	request := text(row, "requestId")
	first := assertProjectedReceipt(t, store, request, testReceiptSession, "completed")
	if field(first["origin"], "sourceId") != "unmigrated" {
		t.Fatal(first)
	}
	if err := indexInvalidate(ctx, store.base); err != nil {
		t.Fatal(err)
	}
	closeReceiptIndex(store.base)
	path, _ := store.path(request)
	row["origin"] = object{"sourceId": "migrated-source", "ingressId": "fixture-ingress"}
	saveKernelRow(t, path, row)
	result := assertProjectedReceipt(t, store, request, testReceiptSession, "completed")
	if wire(result["origin"]) != wire(row["origin"]) {
		t.Fatalf("rebuild kept stale origin: %v", result["origin"])
	}
}

func TestOversizedReceiptRetainsSmallProjection(t *testing.T) {
	// Recurring bug class: persistence oversized receipt payloads evicted their visible projections on every poll.
	ctx := context.Background()
	store := testReceiptStore(t)
	row := reserveTestReceipt(t, store, object{"state": "completed", "operation": "create",
		"result": object{"threadId": "fixture-thread", "payload": strings.Repeat("x", 33<<20)}})
	request := text(row, "requestId")
	for range 3 {
		result := assertProjectedReceipt(t, store, request, testReceiptSession, "completed")
		if field(result["result"], "threadId") != "fixture-thread" || field(result["result"], "payload") != nil {
			t.Fatal("projection lost the thread or retained its opaque payload")
		}
	}
	row["result"] = object{"threadId": "changed-thread"}
	if err := store.checkpoint(ctx, row); err != nil {
		t.Fatal(err)
	}
	result := assertProjectedReceipt(t, store, request, testReceiptSession, "completed")
	if field(result["result"], "threadId") != "changed-thread" {
		t.Fatalf("updated result = %v", result)
	}
}

func TestTaskDependencyChangeRefreshesOnlyItsReceipt(t *testing.T) {
	// Recurring bug class: persistence an updated runtime snapshot triggered reprojecting unrelated receipt history.
	ctx := context.Background()
	store := testReceiptStore(t)
	for range 40 {
		reserveTestReceipt(t, store, object{"state": "completed"})
	}
	row := reserveTestReceipt(t, store, object{"state": "executing"})
	request := text(row, "requestId")
	path := filepath.Join(t.TempDir(), "runtime.json")
	saveKernelRow(t, path, object{"state": "running"})
	var projection taskProjection
	defer projection.close()
	visits := 0
	poll := func() []object {
		rows, err := projection.update(ctx, store, testReceiptSession, func(row object) []string {
			if row["requestId"] == request {
				return []string{path}
			}
			return nil
		}, func(row object) (object, error) {
			visits++
			if row["requestId"] == request {
				result, err := cachedLoad(path)
				row["runtime"] = result
				return row, err
			}
			return row, nil
		}, func(row object) object { return row })
		if err != nil || len(rows) != 41 {
			t.Fatalf("projection contains %d rows: %v", len(rows), err)
		}
		return rows
	}
	poll()
	saveKernelRow(t, path, object{"state": "completed"})
	for _, row := range poll() {
		if row["requestId"] == request && field(row["runtime"], "state") != "completed" {
			t.Fatalf("runtime state = %v", row)
		}
	}
	if visits != 42 {
		t.Fatalf("changed snapshot reprojected %d rows", visits-41)
	}
}

func TestReceiptIndexUpdatePreservesNeighborsInShard(t *testing.T) {
	// Recurring bug class: persistence replacing or deleting a receipt in a grouped shard removed its neighbors.
	ctx := context.Background()
	store := testReceiptStore(t)
	first := reserveTestReceipt(t, store, object{"requestId": "aa000000-0000-4000-8000-000000000001", "state": "completed"})
	second := reserveTestReceipt(t, store, object{"requestId": "aa000000-0000-4000-8000-000000000002", "state": "completed"})
	if err := seedReceiptIndex(ctx, store.base); err != nil {
		t.Fatal(err)
	}
	first["state"] = "failed"
	if err := store.checkpoint(ctx, first); err != nil {
		t.Fatal(err)
	}
	closeReceiptIndex(store.base)
	assertProjectedReceipt(t, store, text(first, "requestId"), testReceiptSession, "failed")
	assertProjectedReceipt(t, store, text(second, "requestId"), testReceiptSession, "completed")
	path, _ := store.path(text(first, "requestId"))
	if err := indexChange(ctx, path, func() (any, error) { return nil, os.Remove(path) }); err != nil {
		t.Fatal(err)
	}
	closeReceiptIndex(store.base)
	assertProjectedReceipt(t, store, text(second, "requestId"), testReceiptSession, "completed")
}
