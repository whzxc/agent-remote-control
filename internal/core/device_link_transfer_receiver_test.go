package core

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestPublishedTransferRepairsACompletionCheckpointFailure(t *testing.T) {
	// Recurring bug class: persistence if publication succeeds before a checkpoint failure, the same receiver can finish without overwriting its destination.
	dir := t.TempDir()
	request := id()
	target := filepath.Join(dir, "target")
	data := []byte("verified fixture")
	sum := hash(data)
	store := &deviceReceiverStore{}
	defer store.close()
	if _, err := store.begin(t.Context(), dir, request, object{
		"path": target, "total": len(data), "expectedSha256": sum,
	}); err != nil {
		t.Fatal(err)
	}
	receiver, err := store.get(t.Context(), dir, request)
	if err != nil {
		t.Fatal(err)
	}
	if err := receiver.receive(t.Context(), bytes.NewReader(data), 0, uint64(len(data)), func() string { return sum }); err != nil {
		t.Fatal(err)
	}
	manifest := receiver.manifest
	receiver.manifest = filepath.Join(target, "manifest.json")
	if _, err := receiver.commit(); err == nil {
		t.Fatal("completion unexpectedly persisted under a file")
	}
	if got, err := os.ReadFile(target); err != nil || !bytes.Equal(got, data) {
		t.Fatalf("verified bytes were not published before the checkpoint failure: %v", err)
	}
	receiver.manifest = manifest
	result, err := receiver.commit()
	if err != nil || result["state"] != "completed" || result["sha256"] != sum {
		t.Fatalf("publication recovery %v: %v", result, err)
	}
	got, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("publication recovery changed the verified bytes: %v", err)
	}
}
