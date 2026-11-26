package core

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
