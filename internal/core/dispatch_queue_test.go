package core

import (
	"fmt"
	"path/filepath"
	"testing"
)

func TestDispatchQueueRequiresExplicitResumeAfterInterruptedPredecessor(t *testing.T) {
	// Recurring bug class: lifecycle native interruption must gate queue admission even when display status is completed.
	key := turnKey{"codex", "thread", "old"}
	native := turnSnapshot(key, "interrupted", nil)
	turns := []any{object{"id": "old", "status": "completed", "_turnLifecycle": native.checkpoint()}}
	selected := codexTurnSnapshots("thread", turns, "old")
	if disposition, _ := nativeQueueAdmission(object{"expectedPreviousTurn": "old"}, &selected, false, false); disposition != dispatchQueueBlock {
		t.Fatalf("interrupted turn: %v", disposition)
	}
	if disposition, _ := nativeQueueAdmission(object{"allowFailedTurn": "old"}, &selected, false, false); disposition != dispatchQueueReady {
		t.Fatalf("explicit resume: %v", disposition)
	}
}

func TestDispatchQueuePollReadsOnlyChangedMessage(t *testing.T) {
	// Recurring bug class: persistence idle queue refreshes reuse cached canonical rows and read only the dirty message after replacement.
	dir := filepath.Join(t.TempDir(), "send-queue")
	for i := range 24 {
		path := filepath.Join(dir, fmt.Sprintf("%d.json", i))
		if err := save(path, object{"queueId": id(), "threadId": "thread", "args": object{}, "state": "completed", "sequence": i}); err != nil {
			t.Fatal(err)
		}
	}
	queue := nativeDispatchQueue{files: newFileCollection[object](dir)}
	defer func() { queue.files.close() }()
	counters := func() cacheIO {
		readCache.Lock()
		defer readCache.Unlock()
		return readCache.values.io
	}
	if rows, err := queue.records(); err != nil || len(rows) != 24 {
		t.Fatalf("seed: %d %v", len(rows), err)
	}
	warm := counters()
	for range 3 {
		if rows, err := queue.records(); err != nil || len(rows) != 24 {
			t.Fatalf("warm: %d %v", len(rows), err)
		}
	}
	if measured := counters(); measured != warm {
		t.Fatalf("warm queue reread: %+v -> %+v", warm, measured)
	}
	if err := save(filepath.Join(dir, "0.json"), object{"queueId": id(), "threadId": "thread", "args": object{}, "state": "queued", "sequence": 0}); err != nil {
		t.Fatal(err)
	}
	rows, err := queue.records()
	if err != nil || len(rows) != 24 || rows[0]["state"] != "queued" {
		t.Fatalf("dirty row: %v %v", rows, err)
	}
	if measured := counters(); measured.fileOpens != warm.fileOpens+1 || measured.directoryReads != warm.directoryReads {
		t.Fatalf("dirty queue reread: %+v -> %+v", warm, measured)
	}
}

func TestOrphanDispatchQueueRecordsRemainVisibleOnlyToLocalControl(t *testing.T) {
	// Recurring bug class: security orphaned records keep a local recovery path while other sources cannot see them.
	orphan := object{"origin": object{"controlSource": "ARC", "ingressId": "local-ui"}, "state": "queued"}
	if !dispatchQueueVisible(orphan, object{"authType": "local", "sourceId": "local"}) ||
		dispatchQueueVisible(orphan, object{"sourceId": "remote"}) || dispatchQueueVisible(orphan, nil) {
		t.Fatal("orphan visibility crossed the source boundary")
	}
	owned := object{"origin": object{"sourceId": "a"}}
	if !dispatchQueueVisible(owned, object{"sourceId": "a"}) || dispatchQueueVisible(owned, object{"sourceId": "b"}) {
		t.Fatal("owned queue record crossed the source boundary")
	}
}
