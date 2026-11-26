package core

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestCoordinationJournalReplaysAfterRestart(t *testing.T) {
	// Contract: event IDs, transition replays, and signed cursors survive a Core restart.
	path := t.TempDir()
	journal, err := openCoordinationJournal(path, 1000)
	if err != nil {
		t.Fatal(err)
	}
	input := newCoordinationEvent("synthetic-first", "lane.created", []string{"lane:example/worker"})
	first, err := journal.emit(input, 1000)
	if err != nil {
		t.Fatal(err)
	}
	reader := coordinationReader{coordinationPrincipal{Type: "source", SourceID: "reader"}, "authority"}
	page, err := journal.query(reader, coordinationQuery{Resource: new("lane:worker")}, 1100)
	if err != nil {
		t.Fatal(err)
	}
	journal, err = openCoordinationJournal(path, 1200)
	if err != nil {
		t.Fatal(err)
	}
	dupe, err := journal.emit(input, 1300)
	if err != nil || dupe["eventId"] != first["eventId"] || dupe["sequence"] != first["sequence"] || dupe["duplicate"] != true {
		t.Fatalf("replay = %v, %v", dupe, err)
	}
	input.Resources = []string{"lane:other/worker"}
	if _, err := journal.emit(input, 1400); err == nil || !strings.HasPrefix(err.Error(), "COORDINATION_TRANSITION_CONFLICT") {
		t.Fatalf("changed replay = %v", err)
	}
	second, err := journal.emit(newCoordinationEvent("synthetic-second", "lane.landed", []string{"lane:example/worker"}), 1500)
	if err != nil {
		t.Fatal(err)
	}
	next, err := journal.query(reader, coordinationQuery{Since: new(text(page, "nextCursor")), Resource: new("lane:worker")}, 1600)
	if err != nil {
		t.Fatal(err)
	}
	events := next["events"].([]object)
	if len(events) != 1 || events[0]["eventId"] != second["eventId"] {
		t.Fatalf("resume = %v", next)
	}
	changed, err := journal.query(reader, coordinationQuery{Since: new(text(page, "nextCursor")), Resource: new("app:installed")}, 1600)
	if err != nil || field(changed["error"], "code") != "CURSOR_SCOPE_CHANGED" {
		t.Fatalf("wrong scope = %v, %v", changed, err)
	}
}

func TestCoordinationJournalRecoversTornAppendWithoutSequenceReuse(t *testing.T) {
	// Recurring bug class: persistence a torn tail must be quarantined before a later sequence can publish.
	dir := t.TempDir()
	journal, err := openCoordinationJournal(dir, 1000)
	if err != nil {
		t.Fatal(err)
	}
	one := newCoordinationEvent("one", "app.replace", []string{"app:installed"})
	if _, err := journal.emit(one, 1000); err != nil {
		t.Fatal(err)
	}
	journal.manifest.Next++
	if err := journal.persist(); err != nil {
		t.Fatal(err)
	}
	tail, err := os.OpenFile(journal.segmentPath(1), os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tail.WriteString(`{"sequence":2`)
	if err = errors.Join(err, tail.Close()); err != nil {
		t.Fatal(err)
	}
	journal, err = openCoordinationJournal(dir, 1200)
	if err != nil {
		t.Fatal(err)
	}
	second, err := journal.emit(newCoordinationEvent("two", "app.replace", []string{"app:installed"}), 1300)
	if err != nil || second["sequence"] != uint64(3) {
		t.Fatalf("next append = %v, %v", second, err)
	}
	if journal.coverage()["state"] != "partial" {
		t.Fatal("journal did not expose its gap")
	}
	corrupt := filepath.Join(t.TempDir(), "events")
	if err := os.Mkdir(corrupt, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(corrupt, "00000000000000000001.jsonl"), []byte("torn"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := openCoordinationJournal(corrupt, 1400); !errors.Is(err, errCoordinationJournalCorrupt) {
		t.Fatalf("missing manifest = %v", err)
	}
}

func TestCoordinationEventPagesKeepSnapshotAndResetExpiredFilters(t *testing.T) {
	// Contract: event paging remains stable during appends and expires obsolete scope or retention cursors.
	journal, err := openCoordinationJournal(t.TempDir(), 1000)
	if err != nil {
		t.Fatal(err)
	}
	reader := coordinationReader{coordinationPrincipal{Type: "source", SourceID: "reader"}, "authority"}
	resource := "lane:project/lane"
	filter := coordinationQuery{Resource: &resource, Kinds: []string{"lane.created"}, Limit: new(1)}
	empty, err := journal.query(reader, filter, 1000)
	if err != nil {
		t.Fatal(err)
	}
	filter.Since = new(text(empty, "nextCursor"))
	for index := range 3 {
		kind := "lane.created"
		if index == 1 {
			kind = "lane.removed"
		}
		if _, err := journal.emit(newCoordinationEvent(fmt.Sprintf("event-%d", index), kind, []string{resource}), 1100); err != nil {
			t.Fatal(err)
		}
	}
	first, err := journal.query(reader, filter, 1200)
	if err != nil || first["hasMore"] != true {
		t.Fatalf("first page = %v, %v", first, err)
	}
	filter.Since = new(text(first, "nextCursor"))
	if _, err := journal.emit(newCoordinationEvent("late", "lane.created", []string{resource}), 1300); err != nil {
		t.Fatal(err)
	}
	next, err := journal.query(reader, filter, 1400)
	if err != nil || next["hasMore"] != false || next["events"].([]object)[0]["sequence"] != uint64(3) {
		t.Fatalf("snapshot page = %v, %v", next, err)
	}
	filter.Since = new(text(next, "nextCursor"))
	last, err := journal.query(reader, filter, 1500)
	if err != nil || last["events"].([]object)[0]["sequence"] != uint64(4) {
		t.Fatalf("after snapshot = %v, %v", last, err)
	}
	filter.Resource = new("lane:lane")
	filter.Since = new(text(first, "nextCursor"))
	expired, err := journal.query(reader, filter, coordinationRetentionMS+1500)
	if err != nil || field(expired["error"], "code") != "CURSOR_EXPIRED" || field(field(expired["next"], "args"), "resource") != resource {
		t.Fatalf("retained shorthand = %v, %v", expired, err)
	}
}

func TestCoordinationEventMetadataRejectsInvalidAndOversizedBeforeAppend(t *testing.T) {
	// Contract: only allowlisted metadata is admitted, and invalid events do not consume an event sequence.
	journal, err := openCoordinationJournal(t.TempDir(), 1000)
	if err != nil {
		t.Fatal(err)
	}
	for _, sample := range []coordinationEventInput{
		newCoordinationEvent("bad", "unsupported", []string{"app:installed"}),
		newCoordinationEvent("bad", "lane.created", []string{"lane:unqualified"}),
		newCoordinationEvent("bad", "lane.created", []string{"service:example"}),
	} {
		if _, err := journal.emit(sample, 1100); err == nil {
			t.Fatalf("invalid input accepted: %v", sample)
		}
	}
	large := newCoordinationEvent("large", "receipt.unconfirmed", []string{"app:installed"})
	for i := range 16 {
		large.EvidenceRefs = append(large.EvidenceRefs, coordinationEvidenceRef{"receipt", strings.Repeat("x", 120) + fmt.Sprint(i)})
	}
	if _, err := journal.emit(large, 1100); err == nil || !strings.HasPrefix(err.Error(), "COORDINATION_CAPACITY") {
		t.Fatalf("oversized event = %v", err)
	}
	small, err := journal.emit(newCoordinationEvent("valid", "app.restarted", []string{"app:installed"}), 1100)
	if err != nil || small["sequence"] != uint64(1) {
		t.Fatalf("after rejected payload = %v, %v", small, err)
	}
	if _, err := resolveCoordinationResource("lane:same", []string{"lane:a/same", "lane:b/same"}); err == nil || !strings.HasPrefix(err.Error(), "RESOURCE_AMBIGUOUS") {
		t.Fatalf("ambiguous lane = %v", err)
	}
}

func TestCoordinationReadAndEmissionBudgetsKeepOriginalRetryScope(t *testing.T) {
	// Algorithmic core: reader and append budgets bound independent workloads while preserving replay.
	journal, err := openCoordinationJournal(t.TempDir(), 1000)
	if err != nil {
		t.Fatal(err)
	}
	input := newCoordinationEvent("test-1", "app.replace", []string{"app:installed"})
	first, err := journal.emit(input, 1000)
	if err != nil {
		t.Fatal(err)
	}
	for index := range 99 {
		row := newCoordinationEvent(fmt.Sprintf("fixture-%d", index), "app.replace", []string{"app:installed"})
		if _, err := journal.emit(row, 1000); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := journal.emit(newCoordinationEvent("blocked", "app.replace", []string{"app:installed"}), 1000); err == nil || !strings.HasPrefix(err.Error(), "COORDINATION_RATE_LIMIT") {
		t.Fatalf("emission budget = %v", err)
	}
	replay, err := journal.emit(input, 1000)
	if err != nil || replay["eventId"] != first["eventId"] || replay["duplicate"] != true {
		t.Fatalf("bounded retry = %v, %v", replay, err)
	}
	reader := coordinationReader{coordinationPrincipal{Type: "source", SourceID: "reader"}, "authority"}
	for range 10 {
		if _, err := journal.query(reader, coordinationQuery{}, 1000); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := journal.query(reader, coordinationQuery{}, 1000); err == nil || !strings.HasPrefix(err.Error(), "COORDINATION_RATE_LIMIT") {
		t.Fatalf("pull budget = %v", err)
	}
	reader.principal.SourceID = "another-reader"
	if result, err := journal.query(reader, coordinationQuery{}, 1000); err != nil || field(result["coverage"], "state") != "partial" {
		t.Fatalf("independent scope = %v, %v", result, err)
	}
}

func TestCoordinationReadbackProjectionRetainsCheckpointAfterJournalPrune(t *testing.T) {
	// Recurring bug class: retry-replay owner descriptors already durably projected must remain deduplicated after feed retention.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	path := filepath.Join(root(), "coordination/tooling/sample.json")
	input := newCoordinationEvent("sample", "lane.created", []string{"lane:project/fixture"})
	row := clone(object{"coordinationPending": []coordinationEventInput{input}})
	if err := coordinationDurable(path, row); err != nil {
		t.Fatal(err)
	}
	if err := coordinationProject(t.Context(), path, row); err != nil {
		t.Fatal(err)
	}
	_, err := withCoordinationJournal(func(journal *coordinationJournal) (struct{}, error) {
		return struct{}{}, journal.prune(time.Now().UnixMilli()+coordinationRetentionMS, 0)
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := coordinationProject(t.Context(), path, row); err != nil {
		t.Fatal(err)
	}
	coverage, err := withCoordinationJournal(func(journal *coordinationJournal) (object, error) { return journal.coverage(), nil })
	if err != nil || coverage["retainedEvents"] != 0 || coverage["retainedAfterSequence"] != uint64(1) {
		t.Fatalf("owner replay duplicated retained event: %v, %v", coverage, err)
	}
}

func TestCoordinationReceiptObservationDistinguishesOwnerLossFromStall(t *testing.T) {
	// Contract: receipt owner loss and stalled submission are metadata events, separate from native terminal outcomes.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	path := filepath.Join(t.TempDir(), "receipt.json")
	observer := coordinationReceiptObserver{waiting: map[string]bool{}, failed: map[string]bool{}, invalid: map[string]bool{}}
	row := object{"requestId": "fixture", "operation": "command", "state": "executing", "backendSession": "live", "createdAt": coordinationTimestamp(1000), "origin": object{"sourceLabel": "Human-readable only"}}
	if !observer.observe(path, row, "live", "host:fixture", 40000) || observer.waiting[path] {
		t.Fatal("active command treated as a stalled submission")
	}
	row["state"] = "reserved"
	if !observer.observe(path, row, "live", "host:fixture", 20000) || !observer.waiting[path] {
		t.Fatal("reserved receipt not scheduled")
	}
	if !observer.observe(path, row, "live", "host:fixture", 40000) || observer.waiting[path] {
		t.Fatal("known stall retained age poll")
	}
	lost := projectReceipt(clone(row), false, 40000)
	events, err := coordinationOwnerInputs("receipt", lost, []string{"host:fixture"})
	if err != nil || len(events) != 1 || events[0].Kind != "receipt.unconfirmed" || events[0].Origin != nil {
		t.Fatalf("lost receipt = %v, %v", events, err)
	}
	row["createdAt"] = "invalid time"
	if observer.observe(path, row, "live", "host:fixture", 40000) || observer.waiting[path] {
		t.Fatal("malformed receipt retained age poll")
	}
}

func TestCoordinationGitWatchesRefsWithoutReopeningUnchangedFiles(t *testing.T) {
	// Recurring bug class: lifecycle idle Git observation reuses watched files while detected movements retain metadata.
	dir := t.TempDir()
	lane := filepath.Join(dir, "refs", "heads", "wt")
	if err := os.MkdirAll(lane, 0o700); err != nil {
		t.Fatal(err)
	}
	main := filepath.Join(dir, "refs", "heads", "main")
	sha := strings.Repeat("a", 40)
	if err := os.WriteFile(main, []byte(sha+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cost := new(runtimeCost)
	reader := &coordinationRefReader{}
	first, err := reader.refs(dir, cost)
	if err != nil || first["refs/heads/main"] != sha {
		t.Fatalf("initial ref = %v, %v", first, err)
	}
	initialBytes := cost.read.Load()
	if _, err := reader.refs(dir, cost); err != nil || cost.read.Load() != initialBytes {
		t.Fatalf("idle ref reads = %d, %v", cost.read.Load()-initialBytes, err)
	}
	worker := filepath.Join(lane, "review")
	newOID := strings.Repeat("b", 40)
	if err := os.WriteFile(worker, []byte(newOID+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	moved, err := reader.refs(dir, cost)
	if err != nil || moved["refs/heads/wt/review"] != newOID {
		t.Fatalf("created lane = %v, %v", moved, err)
	}
	if err := os.Remove(worker); err != nil {
		t.Fatal(err)
	}
	deleted, err := reader.refs(dir, cost)
	if err != nil || deleted["refs/heads/wt/review"] != "" {
		t.Fatalf("removed lane = %v, %v", deleted, err)
	}
	stamp := "2026-01-01T00:00:00Z"
	rows := []object{{"ref": "refs/heads/main", "commonDir": dir, "head": sha, "threadId": "thread", "capturedAt": stamp}}
	if result := correlateCoordinationRef(rows, dir, "refs/heads/main", &sha, stamp, true); result.Confidence != "correlated" {
		t.Fatalf("attribution = %v", result)
	}
	rows = append(rows, clone(rows[0]))
	if result := correlateCoordinationRef(rows, dir, "refs/heads/main", &sha, stamp, true); result.Confidence != "ambiguous" {
		t.Fatalf("ambiguous attribution = %v", result)
	}
	if result := correlateCoordinationRef(rows, dir, "refs/heads/main", &sha, stamp, false); result.Confidence != "unknown" {
		t.Fatalf("without ancestry = %v", result)
	}
}

func TestCoordinationDispatchAndTerminalObservationsStayMetadataOnly(t *testing.T) {
	// Contract: dispatch admission requires observed transport and native terminal projection records only metadata.
	row := object{"requestId": "fixture", "agent": "pi", "threadId": "thread", "turnId": "turn", "model": "native-model", "origin": object{"sourceId": "owner"},
		"title": "Private title", "prompt": "Private prompt", "terminal": object{"state": "unknown"}}
	events, err := coordinationOwnerInputs("dispatch", row, []string{"host:fixture", "app:installed"})
	if err != nil || len(events) != 0 {
		t.Fatalf("deferred dispatch = %v, %v", events, err)
	}
	row["submissionObserved"] = true
	for _, status := range []string{"completed", "failed", "cancelled", "interrupted", "unconfirmed"} {
		obj(row["terminal"])["state"] = status
		events, err := coordinationOwnerInputs("dispatch", row, []string{"host:fixture", "app:installed"})
		if err != nil || events[0].Kind != "dispatch.accepted" || strings.Contains(wire(events), "Private") {
			t.Fatalf("projection = %v, %v", events, err)
		}
		if status == "unconfirmed" {
			if len(events) != 1 {
				t.Fatalf("owner loss generated a native terminal: %v", events)
			}
		} else if len(events) != 2 || events[1].Kind != "turn.terminal" || strPtr(events[1].Status) != status {
			t.Fatalf("state %s = %v", status, events)
		}
	}
}

func TestCoordinationSourceAuthorityUsesCredentialRevision(t *testing.T) {
	// Recurring bug class: security revoked sources and changed credentials cannot keep using existing event cursors.
	saved := readCoordinationSource
	t.Cleanup(func() { readCoordinationSource = saved })
	source := object{"id": "owner", "ingressId": "connection", "credential": object{"type": "bearer", "generation": 1}}
	readCoordinationSource = func(context.Context, object) (object, error) { return clone(source), nil }
	ctx := withOrigin(t.Context(), object{"sourceId": "owner", "ingressId": "connection", "accountId": "initial"})
	first, err := coordinationReadAuthority(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	ctx = withOrigin(t.Context(), object{"sourceId": "owner", "ingressId": "connection", "accountId": "changed"})
	second, err := coordinationReadAuthority(ctx, false)
	if err != nil || first.revision != second.revision || wire(first.identity()) != wire(second.identity()) {
		t.Fatalf("account reconciliation changed authority: %v, %v", second, err)
	}
	obj(source["credential"])["generation"] = 2
	rotated, err := coordinationReadAuthority(ctx, false)
	if err != nil || rotated.revision == first.revision {
		t.Fatalf("credential revision = %v, %v", rotated, err)
	}
	source["state"] = "revoked"
	if _, err := coordinationReadAuthority(ctx, false); err == nil || !strings.HasPrefix(err.Error(), "SOURCE_REVOKED") {
		t.Fatalf("revoked source = %v", err)
	}
}

func TestCoordinationFailedSegmentOpenDoesNotReuseReservedSequence(t *testing.T) {
	// Recurring bug class: persistence an append failing after reservation must leave a visible sequence gap.
	journal, err := openCoordinationJournal(t.TempDir(), 1000)
	if err != nil {
		t.Fatal(err)
	}
	fault := journal.segmentPath(1)
	if err := os.Mkdir(fault, 0o700); err != nil {
		t.Fatal(err)
	}
	event := newCoordinationEvent("retry", "app.restarted", []string{"app:installed"})
	if _, err := journal.emit(event, 1000); !errors.Is(err, errCoordinationJournalIO) {
		t.Fatalf("failed append = %v", err)
	}
	if err := os.Remove(fault); err != nil {
		t.Fatal(err)
	}
	journal, err = openCoordinationJournal(journal.dir, 1200)
	if err != nil {
		t.Fatal(err)
	}
	retried, err := journal.emit(event, 1300)
	if err != nil || retried["sequence"] != uint64(2) || journal.coverage()["state"] != "partial" {
		t.Fatalf("durable retry = %v, %v", retried, err)
	}
}

func writeJournalRetentionFixture(t *testing.T, dir string, count int, wide bool) {
	t.Helper()
	manifest := coordinationManifest{Epoch: id(), CursorKey: id(), Next: uint64(count + 1), Segments: []uint64{}}
	first := uint64(1)
	var segment []byte
	write := func() {
		t.Helper()
		manifest.Segments = append(manifest.Segments, first)
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("%020d.jsonl", first)), segment, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for index := 1; index <= count; index++ {
		input := newCoordinationEvent(fmt.Sprintf("fixture-%d", index), "app.restarted", []string{"app:installed"})
		if wide {
			for range 10 {
				input.EvidenceRefs = append(input.EvidenceRefs, coordinationEvidenceRef{"receipt", strings.Repeat("x", 105)})
			}
		}
		line := []byte(wire(coordinationRecord{uint64(index), 1000, input}) + "\n")
		if len(segment)+len(line) > coordinationSegmentBytes {
			write()
			first, segment = uint64(index), nil
		}
		segment = append(segment, line...)
	}
	write()
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(wire(manifest)), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestCoordinationRetentionCapsEventCountBytesAndWirePages(t *testing.T) {
	// Contract: retention keeps the journal restartable under count and disk budgets and bounds each wire page.
	for _, sample := range []struct {
		count int
		wide  bool
	}{{coordinationStoreEvents, false}, {8000, true}} {
		dir := t.TempDir()
		writeJournalRetentionFixture(t, dir, sample.count, sample.wide)
		journal, err := openCoordinationJournal(dir, 1000)
		if err != nil {
			t.Fatal(err)
		}
		prior := journal.manifest.Floor
		input := newCoordinationEvent("incoming", "app.restarted", []string{"app:installed"})
		if !sample.wide {
			if _, err := journal.emit(input, 1100); err != nil {
				t.Fatal(err)
			}
			if journal.manifest.Floor <= prior || len(journal.records) > coordinationStoreEvents {
				t.Fatalf("retained count = %v", journal.coverage())
			}
		} else {
			if err := journal.prune(1000, coordinationStoreBytes-coordinationReservedBytes-journal.bytes+1); err != nil {
				t.Fatal(err)
			}
			if journal.manifest.Floor <= prior || journal.bytes > coordinationStoreBytes-coordinationReservedBytes {
				t.Fatalf("retained bytes = %v", journal.coverage())
			}
		}
		reopened, err := openCoordinationJournal(dir, 1200)
		if err != nil {
			t.Fatal(err)
		}
		page, err := reopened.query(coordinationReader{coordinationPrincipal{Type: "local-authority"}, "local"}, coordinationQuery{Limit: new(200)}, 1200)
		if err != nil || len(wire(page)) > coordinationPageBytes || len(page["events"].([]object)) == 0 {
			t.Fatalf("bounded page = %d bytes, %v", len(wire(page)), err)
		}
	}
}

func TestGitObserverRecoversRegistryAndPublishesOnlyObservedRefChanges(t *testing.T) {
	// Recurring bug class: lifecycle a missing catalog or unreachable root must not fabricate Git movements or prevent recovery.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	repo := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		command := exec.CommandContext(t.Context(), "git", append([]string{"-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"}, args...)...)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s: %v", args, output, err)
		}
		return strings.TrimSpace(string(output))
	}
	git("init", "--quiet", "-b", "main")
	git("commit", "--quiet", "--allow-empty", "-m", "base")
	base := git("rev-parse", "HEAD")
	ctx := withRuntimeCost(t.Context(), "coordinationGit", "startup")
	if err := pollCoordinationGit(ctx); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing project registry returned %v", err)
	}
	poll := func() {
		t.Helper()
		if err := pollCoordinationGit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	const project = "observer-fixture"
	observeCoordinationProjects([]object{{"id": project, "name": project, "roots": []any{
		object{"path": repo}, object{"path": filepath.Join(repo, "unreachable")},
	}}})
	poll()
	next := func() string {
		git("commit", "--quiet", "--allow-empty", "-m", "next")
		return git("rev-parse", "HEAD")
	}()
	poll()
	git("branch", "wt/check")
	poll()
	git("update-ref", "refs/heads/wt/check", base)
	poll()
	git("branch", "-D", "wt/check")
	poll()
	s := &service{metadata: object{"instance": id()}}
	result := callLocalCoordination(t, s, "events", object{"kinds": []any{"git.ref-moved"}})
	events := arr(result["events"])
	want := []struct {
		movement, resource string
		old, newOID        any
	}{
		{"moved", "project:" + project + "/main", base, next},
		{"created", "lane:" + project + "/check", nil, next},
		{"non-fast-forward", "lane:" + project + "/check", next, base},
		{"deleted", "lane:" + project + "/check", base, nil},
	}
	if len(events) != len(want) {
		t.Fatalf("project observation emitted %d ref changes: %v", len(events), result)
	}
	for _, w := range want {
		if !slices.ContainsFunc(events, func(row any) bool {
			observation := field(row, "observation")
			return slices.Contains(arr(field(row, "resources")), any(w.resource)) && field(observation, "movement") == w.movement &&
				field(observation, "oldOid") == w.old && field(observation, "newOid") == w.newOID
		}) {
			t.Fatalf("missing %s observation on %s: %v", w.movement, w.resource, events)
		}
	}
	observers := obj(field(result["coverage"], "observers"))
	if field(observers[project+"-1"], "state") != "unreachable-or-ref-capacity" {
		t.Fatalf("unreachable root had no coverage gap: %v", observers)
	}
}

func TestCoordinationSuccessorEventsRetainOrderedTurnEvidence(t *testing.T) {
	// Contract: resumed and automatically retried turns expose ordered predecessor and successor references in Events.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	thread := id()
	for _, owner := range []string{"receipt", "dispatch"} {
		row := object{"requestId": id(), "threadId": thread, "turnId": owner + "-new"}
		if owner == "receipt" {
			row["operation"], row["state"], row["arguments"] = "resume", "completed", object{"turnId": "receipt-old"}
		} else {
			row["dispatchSource"], row["retryOf"] = "native-retry", "dispatch-old"
		}
		inputs, err := coordinationOwnerInputs(owner, row, []string{"app:installed"})
		if err != nil || len(inputs) != 1 {
			t.Fatalf("%s projected %v, %v", owner, inputs, err)
		}
		if _, err := emitCoordinationEvent(inputs[0]); err != nil {
			t.Fatal(err)
		}
	}
	s := &service{metadata: object{"instance": id()}}
	events := arr(callLocalCoordination(t, s, "events", object{"kinds": []any{"turn.successor"}})["events"])
	if len(events) != 2 {
		t.Fatalf("successor events = %v", events)
	}
	for _, owner := range []string{"receipt", "dispatch"} {
		if !slices.ContainsFunc(events, func(row any) bool {
			refs := arr(field(row, "threadRefs"))
			return len(refs) == 2 && field(refs[0], "threadId") == thread && field(refs[1], "threadId") == thread &&
				field(refs[0], "turnId") == owner+"-old" && field(refs[1], "turnId") == owner+"-new"
		}) {
			t.Fatalf("missing ordered %s successor references: %v", owner, events)
		}
	}
}
