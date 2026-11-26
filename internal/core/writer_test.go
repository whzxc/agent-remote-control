package core

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

func TestNativeWriterProbeDetectsExternalLocks(t *testing.T) {
	// Recurring bug class: concurrency writer diagnosis detects held native locks without waiting for Desktop.
	path := filepath.Join(t.TempDir(), "thread.lock")
	if state := probeWriterPath(path)["state"]; state != "unheld" {
		t.Fatalf("absent writer: %v", state)
	}
	// LockFileEx requires an exclusive-capable handle; the read-only probe uses
	// shared access on Windows to detect the actual exclusive writer.
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	locked, err := platform.TryLock(file)
	if err != nil || !locked {
		t.Fatalf("acquire writer lock: %v", err)
	}
	if state := probeWriterPath(path)["state"]; state != "held" {
		t.Fatalf("held writer: %v", state)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if state := probeWriterPath(path)["state"]; state != "unheld" {
		t.Fatalf("released writer: %v", state)
	}
}
