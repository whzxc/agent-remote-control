package core

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSingleMethodSchemaClosure(t *testing.T) {
	// Algorithmic core: a method schema retains recursive definitions and drops unrelated definitions.
	schema := schemaClosure(object{"$ref": "#/definitions/A"}, object{
		"A": object{"properties": object{"b": object{"$ref": "#/definitions/B"}}},
		"B": object{"$ref": "#/definitions/A"}, "Unrelated": object{"type": "string"},
	})
	definitions := obj(schema["definitions"])
	if len(definitions) != 2 || text(definitions["B"], "$ref") != "#/definitions/A" {
		t.Fatalf("wrong definition closure: %v", definitions)
	}
	if got := schemaClosure(object{"type": "null"}, object{"A": object{}}); wire(got) != `{"type":"null"}` {
		t.Fatalf("added unused definitions: %v", got)
	}
}

func TestStartupPruneEvictsOldSnapshotsWithoutTouchingArchives(t *testing.T) {
	// Contract: startup output reclamation honors the shared TTL and quota and leaves unrelated files intact.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	dir := filepath.Join(root(), "outputs")
	create := func(name string, size int64, age time.Duration) string {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := saveBytes(path, nil); err != nil {
			t.Fatal(err)
		}
		if err := os.Truncate(path, size); err != nil {
			t.Fatal(err)
		}
		at := time.Now().Add(-age)
		if err := os.Chtimes(path, at, at); err != nil {
			t.Fatal(err)
		}
		return path
	}
	expired := create(id()+".txt", 12, 2*time.Hour)
	oldest := create(id()+".json", outputQuota/2+1, time.Minute)
	newest := create(id()+".digest", outputQuota/2, time.Second)
	archive := create(id()+".jsonl", outputQuota, 2*time.Hour)
	if err := pruneOutputs(); err != nil {
		t.Fatal(err)
	}
	for _, removed := range []string{expired, oldest} {
		if _, err := os.Stat(removed); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("snapshot %s was not removed: %v", removed, err)
		}
	}
	for _, retained := range []string{newest, archive} {
		if _, err := os.Stat(retained); err != nil {
			t.Fatalf("retained output %s was removed: %v", retained, err)
		}
	}
}
