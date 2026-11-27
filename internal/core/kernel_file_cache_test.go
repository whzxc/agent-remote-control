package core

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func saveKernelRow(t *testing.T, path string, value object) {
	t.Helper()
	if err := save(path, value); err != nil {
		t.Fatal(err)
	}
}

func decodeKernelRow(data []byte) (object, error) {
	var row object
	err := unmarshalJSON(data, &row)
	return row, err
}

func readKernelRow(t *testing.T, cache *fileCache[object], path string) object {
	t.Helper()
	row, err := cache.read(path, decodeKernelRow)
	if err != nil {
		t.Fatal(err)
	}
	return row
}

func TestCacheEvictionPreservesHotAndInFlightValues(t *testing.T) {
	// Recurring bug class: lifecycle cache eviction under the source-byte ceiling invalidated hot values and active readers.
	dir := t.TempDir()
	for _, name := range []string{"a", "b", "c"} {
		data := append([]byte(wire(object{"value": name})), bytes.Repeat([]byte(" "), 12<<20)...)
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	a, b, c := filepath.Join(dir, "a"), filepath.Join(dir, "b"), filepath.Join(dir, "c")
	var cache fileCache[object]
	activeA := readKernelRow(t, &cache, a)
	activeB := readKernelRow(t, &cache, b)
	readKernelRow(t, &cache, a)
	readKernelRow(t, &cache, c)
	before := cache.io
	if row := readKernelRow(t, &cache, a); row["value"] != "a" || before != cache.io || cache.size > 32<<20 {
		t.Fatalf("hot value or cache bound lost: %v, %d bytes", row, cache.size)
	}
	saveKernelRow(t, a, object{"value": "updated"})
	if row := readKernelRow(t, &cache, a); row["value"] != "updated" || activeA["value"] != "a" || activeB["value"] != "b" {
		t.Fatalf("active snapshot or replacement lost: %v %v %v", row, activeA, activeB)
	}
	before = cache.io
	if row := readKernelRow(t, &cache, b); row["value"] != "b" || cache.io.fileOpens != before.fileOpens+1 ||
		activeA["value"] != "a" || activeB["value"] != "b" {
		t.Fatalf("evicted value did not reload alongside the active snapshots: %v, %v, %v", row, activeA, activeB)
	}
}

func TestCachePollingOpensOnlyChangedFiles(t *testing.T) {
	// Recurring bug class: persistence unchanged receipt and notification polls reopened retained records after every write.
	for _, count := range []int{24, 458, 3077} {
		dir := t.TempDir()
		for sequence := range count {
			path := filepath.Join(dir, fmt.Sprintf("%d.json", sequence))
			if err := os.WriteFile(path, []byte(wire(object{"sequence": sequence})), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		var cache fileCache[object]
		poll := func() uint64 {
			rows, err := cache.entries(dir)
			if err != nil {
				t.Fatal(err)
			}
			var sum uint64
			for _, row := range rows {
				sum += uintOr(readKernelRow(t, &cache, row.path)["sequence"], 0)
			}
			return sum
		}
		want := uint64(count * (count - 1) / 2)
		if got := poll(); got != want {
			t.Fatalf("sum = %d, want %d", got, want)
		}
		baseline := cache.io
		for range 3 {
			if got := poll(); got != want || cache.io != baseline {
				t.Fatalf("unchanged history caused IO: %d %+v", got, cache.io)
			}
		}
		path := filepath.Join(dir, "0.json")
		before, _ := readStamp(dir)
		saveKernelRow(t, path, object{"sequence": count})
		cache.changed(path, before)
		if got := poll(); got != want+uint64(count) || cache.io.fileOpens != baseline.fileOpens+1 || cache.io.directoryReads != baseline.directoryReads {
			t.Fatalf("changed history caused excess IO: %d %+v", got, cache.io)
		}
		before, _ = readStamp(dir)
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		cache.changed(path, before)
		if got := poll(); got != want {
			t.Fatalf("deletion sum = %d, want %d", got, want)
		}
	}
}

func TestCacheProjectionChecksAllDependenciesBeforePublishing(t *testing.T) {
	// Recurring bug class: concurrency receipt, runtime and owner changes left stale task projections resident.
	paths := []string{"receipts", "runtime", "owners"}
	dir := t.TempDir()
	for i, path := range paths {
		paths[i] = filepath.Join(dir, path)
		if err := os.Mkdir(paths[i], 0o700); err != nil {
			t.Fatal(err)
		}
	}
	var projection fileProjection[string]
	for _, path := range paths {
		before, err := projectionStamps(paths)
		if err != nil {
			t.Fatal(err)
		}
		if err := projection.set(paths, before, "completed"); err != nil {
			t.Fatal(err)
		}
		if value, ok := projection.get(before); !ok || value != "completed" {
			t.Fatalf("unchanged snapshot unavailable: %q", value)
		}
		saveKernelRow(t, filepath.Join(path, "record.json"), object{"state": "running"})
		after, err := projectionStamps(paths)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := projection.get(after); ok {
			t.Fatalf("snapshot survived change to %s", path)
		}
		if err := projection.set(paths, before, "completed"); err != nil {
			t.Fatal(err)
		}
		if _, ok := projection.get(after); ok {
			t.Fatalf("racing update published stale data for %s", path)
		}
	}
}

func TestCacheDiscoversExternalWritesAndDeletion(t *testing.T) {
	// Recurring bug class: persistence external creation, replacement, corruption and deletion were hidden by retained snapshots.
	dir := t.TempDir()
	path := filepath.Join(dir, "record.json")
	var cache fileCache[object]
	entries, err := cache.entries(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("initial listing = %v, %v", entries, err)
	}
	for _, state := range []string{"before", "after", "repaired"} {
		saveKernelRow(t, path, object{"state": state})
		entries, err := cache.entries(dir)
		if err != nil || len(entries) != 1 || readKernelRow(t, &cache, path)["state"] != state {
			t.Fatalf("listing after %s = %v, %v", state, entries, err)
		}
		if state == "after" {
			if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := cache.read(path, decodeKernelRow); err == nil {
				t.Fatal("corrupt external write returned cached data")
			}
		}
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.read(path, decodeKernelRow); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted file read returned %v", err)
	}
	if entries, err := cache.entries(dir); err != nil || len(entries) != 0 {
		t.Fatalf("listing after deletion = %v, %v", entries, err)
	}
}

func TestCollectionRetriesUnpublishedChanges(t *testing.T) {
	// Recurring bug class: retry-replay a failed refresh lost changed keys already loaded or still waiting to be loaded.
	dir := t.TempDir()
	for sequence := range 3 {
		saveKernelRow(t, filepath.Join(dir, fmt.Sprintf("%d.json", sequence)), object{"id": sequence})
	}
	collection := newFileCollection[any](dir)
	defer collection.close()
	if _, err := collection.refresh(func(path string) (any, error) {
		if filepath.Base(path) == "1.json" {
			return nil, errors.New("unavailable")
		}
		return cachedJSON(path)
	}); err == nil {
		t.Fatal("refresh discarded a read error")
	}
	changed, err := collection.refresh(cachedJSON)
	if err != nil || len(changed) != 3 || len(collection.rows) != 3 {
		t.Fatalf("recovery = %v, %v, %v", changed, collection.rows, err)
	}
	for sequence := range 3 {
		path := filepath.Join(dir, fmt.Sprintf("%d.json", sequence))
		if row := collection.rows[physicalPath(path)]; wire(row) != wire(object{"id": sequence}) {
			t.Errorf("recovered row %d = %v", sequence, row)
		}
	}
	changed, err = collection.refresh(cachedJSON)
	if err != nil || len(changed) != 0 {
		t.Fatalf("unchanged refresh = %v, %v", changed, err)
	}
}

func TestCacheDirectoryEvictionPreservesHotEntries(t *testing.T) {
	// Recurring bug class: lifecycle directory cache eviction wiped all cached directories when the working set exceeded the cap.
	rootDir := t.TempDir()
	dirs := make([]string, 3)
	for i := range dirs {
		dirs[i] = filepath.Join(rootDir, fmt.Sprintf("dir-%d", i))
		if err := os.Mkdir(dirs[i], 0o700); err != nil {
			t.Fatal(err)
		}
	}
	cache := fileCache[object]{dirLimit: 2}
	if _, err := cache.entries(dirs[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.entries(dirs[1]); err != nil {
		t.Fatal(err)
	}
	// Touch dirs[0] so dirs[1] becomes the least recently used entry.
	if _, err := cache.entries(dirs[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.entries(dirs[2]); err != nil {
		t.Fatal(err)
	}
	before := cache.io.directoryReads
	if _, err := cache.entries(dirs[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.entries(dirs[2]); err != nil {
		t.Fatal(err)
	}
	if cache.io.directoryReads != before {
		t.Fatalf("hot directories re-read after eviction: before=%d after=%d", before, cache.io.directoryReads)
	}
	if _, err := cache.entries(dirs[1]); err != nil {
		t.Fatal(err)
	}
	if cache.io.directoryReads != before+1 {
		t.Fatalf("evicted directory read count = %d, want %d", cache.io.directoryReads, before+1)
	}
}
