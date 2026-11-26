package core

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

func testNotificationIndexDirectory(t *testing.T) string {
	t.Helper()
	base := t.TempDir()
	t.Setenv("ARC_STATE_DIR", base)
	directory := filepath.Join(base, "notifications")
	t.Cleanup(func() { closeNotificationOwner(physicalPath(filepath.Join(directory, "tasks"))) })
	return directory
}

func TestNotificationIndexRetainsPendingAcrossOwnerPublication(t *testing.T) {
	// Recurring bug class: persistence a restarted index lost pending delivery or revisited dormant history.
	directory := testNotificationIndexDirectory(t)
	ctx := context.Background()
	dir := physicalPath(filepath.Join(directory, "tasks"))
	dormant := newNotificationBinding("older", "turn", "/fixture", "source", time.Now())
	dormant["observation"] = object{"state": "completed", "reconciliation": "reconciled"}
	pending := newNotificationBinding("active", "turn", "/fixture", "source", time.Now())
	pending["deliveries"] = []any{object{"key": "terminal", "eventId": "pending-event", "status": "pending"}}
	for _, row := range []object{dormant, pending} {
		if err := persistNotificationBinding(row); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err := openNotificationOwner(ctx, &service{}); err != nil {
			t.Fatal(err)
		}
		got, err := pendingNotificationBindings()
		if err != nil || len(got) != 1 || got[0]["threadId"] != "active" {
			t.Fatalf("pending index = %v, %v", got, err)
		}
		active, err := activeNotificationBindings()
		if err != nil || len(active) != 1 || active[0]["threadId"] != "active" {
			t.Fatalf("observation index = %v, %v", active, err)
		}
		wakeNotificationThread("older")
		active, err = activeNotificationBindings()
		if err != nil || len(active) != 2 {
			t.Fatalf("woken observation index = %v, %v", active, err)
		}
		closeNotificationOwner(dir)
	}
}

func TestNotificationIndexRepairsInterruptedWritePerKey(t *testing.T) {
	// Recurring bug class: persistence a crash before projection publication stranded one canonical notification record.
	directory := testNotificationIndexDirectory(t)
	ctx := context.Background()
	dir := physicalPath(filepath.Join(directory, "tasks"))
	b := newNotificationBinding("task", "turn", "/fixture", "source", time.Now())
	if err := persistNotificationBinding(b); err != nil {
		t.Fatal(err)
	}
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	closeNotificationOwner(dir)
	path := notificationBindingPathIn(directory, "task", "turn")
	b["deliveries"] = []any{object{"eventId": "after-crash", "key": "terminal", "status": "pending"}}
	if err := indexMark(path); err != nil {
		t.Fatal(err)
	}
	if err := save(path, b); err != nil {
		t.Fatal(err)
	}
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	got, err := pendingNotificationBindings()
	if err != nil || len(got) != 1 || find(got[0]["deliveries"], "eventId", "after-crash") == nil {
		t.Fatalf("repair after restart = %v, %v", got, err)
	}
}

func TestNotificationIndexKeepsDormantHistoryOutOfPendingWork(t *testing.T) {
	// Recurring bug class: lifecycle observation and delivery work scaled with completed historical scopes.
	testNotificationIndexDirectory(t)
	ctx := context.Background()
	for i := range 48 {
		b := newNotificationBinding("task", "turn-"+strconv.Itoa(i), "/fixture", "source", time.Now())
		b["observation"] = object{"state": "completed", "reconciliation": "reconciled"}
		if err := persistNotificationBinding(b); err != nil {
			t.Fatal(err)
		}
	}
	b := newNotificationBinding("new", "turn", "/fixture", "source", time.Now())
	b["deliveries"] = []any{object{"key": "terminal", "status": "pending"}}
	if err := persistNotificationBinding(b); err != nil {
		t.Fatal(err)
	}
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		rows, err := activeNotificationBindings()
		if err != nil || len(rows) != 1 || rows[0]["threadId"] != "new" {
			t.Fatalf("observation scope = %v, %v", rows, err)
		}
		rows, err = pendingNotificationBindings()
		if err != nil || len(rows) != 1 || rows[0]["threadId"] != "new" {
			t.Fatalf("delivery scope = %v, %v", rows, err)
		}
	}
}

func TestNotificationBindingKeepsObservationTimeUntilEvidenceChanges(t *testing.T) {
	// Recurring bug class: persistence a metadata-only binding update must not replace the durable native observation timestamp.
	testNotificationIndexDirectory(t)
	b := newNotificationBinding("task", "turn", "/fixture", "source", time.Now())
	const original, updated = "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"
	b["observation"] = object{"state": "completed", "reason": "native-terminal", "observedAt": original}
	if err := persistNotificationBinding(b); err != nil {
		t.Fatal(err)
	}
	b["threadTitle"] = "Updated fixture title"
	obj(b["observation"])["observedAt"] = updated
	if err := persistNotificationBinding(b); err != nil {
		t.Fatal(err)
	}
	stored, err := readNotificationBinding("task", "turn")
	if err != nil || field(stored["observation"], "observedAt") != original || stored["threadTitle"] != b["threadTitle"] {
		t.Fatalf("metadata-only binding update = %v, %v", stored, err)
	}
	obj(b["observation"])["observedAt"], obj(b["observation"])["reconciliation"] = updated, "pending-after-restart"
	if err := persistNotificationBinding(b); err != nil {
		t.Fatal(err)
	}
	stored, err = readNotificationBinding("task", "turn")
	if err != nil || wire(stored["observation"]) != wire(b["observation"]) {
		t.Fatalf("changed binding evidence = %v, %v", stored, err)
	}
}

func TestNotificationWarmObservationCostDependsOnActiveWork(t *testing.T) {
	// Recurring bug class: persistence retained completed history must not add reads or parses to native observation work.
	previous, watch := observeNotificationTurn, notificationObservationEvidence
	t.Cleanup(func() { observeNotificationTurn, notificationObservationEvidence = previous, watch })
	notificationObservationEvidence = func(context.Context, *service, object) (string, string) { return "", "fixture-writer" }
	observeNotificationTurn = func(_ context.Context, _ *service, b object) (object, error) {
		return object{"state": "running", "recordedStatus": "inProgress", "runtimeStatus": "active",
			"threadId": b["threadId"], "turnId": b["turnId"], "observedAt": "2026-01-01T00:00:00Z"}, nil
	}
	var baseline uint64
	for _, sample := range []struct{ history, active int }{{4, 1}, {40, 1}, {40, 3}, {40, 0}} {
		t.Run(fmt.Sprintf("%d-retained-%d-active", sample.history, sample.active), func(t *testing.T) {
			testNotificationIndexDirectory(t)
			costs := new(runtimeCostSet)
			ctx := context.WithValue(t.Context(), runtimeCostKey{}, runtimeCostContext{set: costs})
			at := time.Now()
			for n := range sample.history + sample.active {
				b := newNotificationBinding(fmt.Sprintf("thread-%d", n), "turn", "/fixture", "source", at)
				if n < sample.history {
					b["scopeEnd"], b["observation"] = "scope-ended", object{"state": "completed", "reconciliation": "reconciled"}
				}
				if err := persistNotificationBinding(b); err != nil {
					t.Fatal(err)
				}
			}
			s := &service{}
			if err := openNotificationOwner(ctx, s); err != nil {
				t.Fatal(err)
			}
			if seeded := costs.counter("notificationSeed").rows.Load(); seeded != uint64(sample.history+sample.active) {
				t.Fatalf("seeded %d rows", seeded)
			}
			if err := recoverNotificationObservations(ctx, s, false); err != nil {
				t.Fatal(err)
			}
			cost := costs.counter("notificationObserver")
			visited, parsed, reads, changed := cost.rows.Load(), cost.parsed.Load(), cost.read.Load(), cost.changed.Load()
			if err := recoverNotificationObservations(ctx, s, false); err != nil {
				t.Fatal(err)
			}
			rows := cost.rows.Load() - visited
			if cost.parsed.Load() != parsed || cost.read.Load() != reads || cost.changed.Load() != changed {
				t.Fatalf("warm observation parsed %d bytes, read %d bytes, changed %d records", cost.parsed.Load()-parsed, cost.read.Load()-reads, cost.changed.Load()-changed)
			}
			if sample.history == 4 {
				baseline = rows
			}
			if baseline == 0 || rows != baseline*uint64(sample.active) {
				t.Fatalf("warm work = %d rows, expected %d per active binding", rows, baseline)
			}
			sample := runtimeObservationSnapshot()["lastPass"]
			if uintOr(field(sample, "ownershipDiscoveries"), ^uint64(0)) != uintOr(field(sample, "bindingsScanned"), 0) {
				t.Fatalf("owner discovery work was not attributed: %v", sample)
			}
		})
	}
}

func TestNotificationIndexAdoptsMixedPartitionsWithoutCanonicalSeedReads(t *testing.T) {
	// Recurring bug class: persistence restart must adopt pending, resume, and dormant partitions without reopening retained payloads.
	directory := testNotificationIndexDirectory(t)
	owner := physicalPath(filepath.Join(directory, "tasks"))
	costs := new(runtimeCostSet)
	ctx := context.WithValue(t.Context(), runtimeCostKey{}, runtimeCostContext{set: costs})
	restoreClock := notificationClock
	t.Cleanup(func() { notificationClock = restoreClock })
	at := time.Unix(100, 0)
	notificationClock = func() time.Time { return at }
	seed := func(thread, turn, state string) object {
		b := newNotificationBinding(thread, turn, "/fixture", "source", at)
		b["observation"] = object{"state": state, "reconciliation": "reconciled"}
		return b
	}
	write := func(b object) {
		t.Helper()
		if err := persistNotificationBinding(b); err != nil {
			t.Fatal(err)
		}
	}
	for n := range 40 {
		b := seed(fmt.Sprintf("historical-%d", n), "turn", "completed")
		b["scopeEnd"] = "ended"
		b["deliveries"] = []any{object{"key": "terminal", "status": "delivered", "finalResponse": strings.Repeat("x", 8192)}}
		write(b)
	}
	resume := seed("resume", "latest", "cancelled")
	resume["continuationUntil"] = 1000
	older := clone(resume)
	older["createdAt"], older["turnId"] = 99, "older"
	write(older)
	resume["deliveries"] = []any{object{"key": "terminal", "status": "pending", "taskState": "cancelled", "finalResponse": "Pending payload"}}
	write(resume)
	parked := seed("parked", "turn", "completed")
	parked["deliveries"] = []any{object{"key": "terminal", "status": "pending", "taskState": "completed"}}
	write(parked)
	dormant := seed("parked", "dormant", "unconfirmed")
	dormant["observation"] = object{"state": "unconfirmed", "reconciliation": "unavailable-after-restart", "reconciliationAttempts": 3}
	write(dormant)
	s := &service{}
	open := func() {
		t.Helper()
		if err := openNotificationOwner(ctx, s); err != nil {
			t.Fatal(err)
		}
	}
	partition := func() object {
		t.Helper()
		index := obj(notificationDiagnostics()["activityIndex"])
		return selectFields(index, "retained", "observing", "reconciliationDue", "reconciliationExhausted", "dormant", "pendingBindings",
			"deliveryDue", "retentionDue", "latestScopes", "latestResumable")
	}
	schedule := func() {
		t.Helper()
		if err := persistNotificationSchedule(ctx, resume, 200); err != nil {
			t.Fatal(err)
		}
		if err := persistNotificationSchedule(ctx, parked, 0); err != nil {
			t.Fatal(err)
		}
	}
	open()
	schedule()
	initial := partition()
	if uintOr(initial["pendingBindings"], 0) != 2 || uintOr(initial["latestResumable"], 0) != 1 ||
		uintOr(initial["observing"], 1) != 0 || uintOr(initial["reconciliationExhausted"], 0) != 1 {
		t.Fatalf("cold partitions = %v", initial)
	}
	seedBytes := costs.counter("notificationSeed").parsed.Load()
	adopt := costs.counter("notificationAdopt")
	startRows, startBytes := adopt.rows.Load(), adopt.parsed.Load()
	closeNotificationOwner(owner)
	open()
	if seedBytes == 0 || costs.counter("notificationSeed").parsed.Load() != seedBytes ||
		adopt.rows.Load()-startRows != 44 || adopt.parsed.Load()-startBytes >= seedBytes ||
		costs.counter("indexRepair").rows.Load() != 0 || wire(partition()) != wire(initial) {
		t.Fatalf("adopted partitions = %v, cost = %v", partition(), costs.snapshot())
	}
	restart, err := notificationIndexedBindings("restart", nil)
	if err != nil || len(restart) != 2 || !slices.ContainsFunc(restart, func(v object) bool { return v["turnId"] == "latest" }) {
		t.Fatalf("restart recovery = %v, %v", restart, err)
	}
	at = time.Unix(199, 0)
	if due, err := notificationIndexedBindings("delivery-due", nil); err != nil || len(due) != 0 {
		t.Fatalf("early delivery set = %v, %v", due, err)
	}
	at = time.Unix(200, 0)
	if due, err := notificationIndexedBindings("delivery-due", nil); err != nil || len(due) != 1 || due[0]["turnId"] != "latest" ||
		field(arr(due[0]["deliveries"])[0], "finalResponse") != "Pending payload" {
		t.Fatalf("adopted due delivery = %v, %v", due, err)
	}
	wakeNotificationBinding("parked", "dormant")
	if active, err := activeNotificationBindings(); err != nil || len(active) != 1 || active[0]["turnId"] != "dormant" {
		t.Fatalf("selected wake = %v, %v", active, err)
	}
	closeNotificationOwner(owner)
	if err := indexInvalidate(ctx, owner); err != nil {
		t.Fatal(err)
	}
	open()
	at = time.Unix(100, 0)
	schedule()
	if rebuilt := partition(); wire(rebuilt) != wire(initial) {
		t.Fatalf("mixed rebuild = %v, want %v", rebuilt, initial)
	}
	closeNotificationOwner(owner)
	open()
	dormant["observation"] = object{"state": "unconfirmed", "reconciliation": "pending-after-restart", "reconciliationAttempts": 1}
	resume["scopeEnd"], older["scopeEnd"] = "ended", "ended"
	for _, binding := range []object{dormant, resume, older} {
		write(binding)
	}
	changed := partition()
	if uintOr(changed["reconciliationDue"], 0) != 1 || uintOr(changed["reconciliationExhausted"], 1) != 0 ||
		uintOr(changed["latestResumable"], 1) != 0 {
		t.Fatalf("native evidence did not update recovery partitions: %v", changed)
	}
	closeNotificationOwner(owner)
	open()
	if restored := partition(); wire(restored) != wire(changed) {
		t.Fatalf("restart changed recovery evidence: %v / %v", changed, restored)
	}
}
