package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

func newRuntimeTestState() *runtimeState {
	return &runtimeState{leases: make(map[string]lease), stop: func() {}}
}

func enrollRuntimeTestClient(t *testing.T, runtime *runtimeState, id, kind string, pid int) {
	t.Helper()
	if _, err := runtime.request("runtime/lease", object{"id": id, "kind": kind, "pid": pid}); err != nil {
		t.Fatal(err)
	}
}

func TestLiveDesktopKeepsLeaseWhenHeartbeatIsDelayed(t *testing.T) {
	// Recurring bug class: lifecycle delayed Desktop heartbeats let a Core exit after the CLI lease was released.
	state := newRuntimeTestState()
	desktop, cli, pid := id(), id(), os.Getpid()
	enrollRuntimeTestClient(t, state, desktop, "desktop", pid)
	enrollRuntimeTestClient(t, state, cli, "cli", pid)
	entry := state.leases[desktop]
	entry.seen = time.Now().Add(-10 * time.Second)
	state.leases[desktop] = entry
	if _, err := state.request("runtime/release", object{"id": cli}); err != nil {
		t.Fatal(err)
	}
	clients := state.clients()
	if len(clients) != 1 || clients[0]["id"] != desktop || clients[0]["kind"] != "desktop" || uintOr(clients[0]["pid"], 0) != uint64(pid) {
		t.Fatalf("leases = %v", clients)
	}
}

func TestProcessIdentityCanBeReadRepeatedly(t *testing.T) {
	// Recurring bug class: lifecycle repeated identity reads rehashed the native executable during idle polling.
	id, err := processBuildID()
	if err != nil || len(id) != 64 {
		t.Fatalf("process identity = %q, %v", id, err)
	}
	for range 1024 {
		if next, err := processBuildID(); err != nil || next != id {
			t.Fatalf("cached process identity = %q, %v", next, err)
		}
	}
}

func TestBuildIDStreamsAndObservesReplacedBytes(t *testing.T) {
	// Recurring bug class: lifecycle cached installation checks missed changed bytes at the same executable path.
	path := filepath.Join(t.TempDir(), "arc")
	for _, size := range []int{0, 3, 65536, 65537, 1024*1024 + 13} {
		data := make([]byte, size)
		for i := range data {
			data[i] = byte(i % 251)
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		if digest, err := buildID(path); err != nil || digest != hash(data) {
			t.Fatalf("streaming build identity for %d bytes = %q, %v", size, digest, err)
		}
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := buildID(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("identity for removed image = %v", err)
	}
}

func TestUninstallProofDoesNotGrantOrdinaryCLIShutdown(t *testing.T) {
	// Recurring bug class: security uninstall required its process-bound proof because a regular CLI lease cannot shut down Core.
	runtime := newRuntimeTestState()
	cli := id()
	enrollRuntimeTestClient(t, runtime, cli, "cli", 2)
	if _, err := runtime.request("runtime/shutdown", object{"id": cli}); err == nil {
		t.Fatal("CLI lease stopped Core")
	}
	token := id()
	proof := object{"token": token, "pid": os.Getpid(), "processStart": platform.ProcessStart(os.Getpid())}
	if _, err := runtime.uninstall("wrong", proof); err == nil {
		t.Fatal("incorrect uninstall proof stopped Core")
	}
	if result, err := runtime.uninstall(token, proof); err != nil || result["closing"] != true {
		t.Fatalf("process-bound uninstall = %v, %v", result, err)
	}
	if _, err := runtime.request("runtime/lease", object{"id": cli, "kind": "cli", "pid": 2}); err == nil {
		t.Fatal("shutting-down runtime took a new lease")
	}
}

func TestDesktopShutdownClosesLaunchesWithOtherClientsAttached(t *testing.T) {
	// Recurring bug class: lifecycle a remaining CLI lease allowed native execution after Desktop accepted shutdown.
	runtime := newRuntimeTestState()
	desktop, cli := id(), id()
	enrollRuntimeTestClient(t, runtime, desktop, "desktop", 1)
	enrollRuntimeTestClient(t, runtime, cli, "cli", 2)
	if _, err := runtime.request("runtime/shutdown", object{"id": cli}); err == nil {
		t.Fatal("CLI lease accepted shutdown")
	}
	if result, err := runtime.request("runtime/shutdown", object{"id": desktop}); err != nil || result["closing"] != true {
		t.Fatalf("Desktop shutdown = %v, %v", result, err)
	}
	if result, err := attachRPC(context.Background(), "", "", "", &runtime.launches, rpcObserver{}); err == nil || !strings.HasPrefix(err.Error(), "CORE_SHUTTING_DOWN:") {
		t.Fatalf("new RPC after shutdown = %v, %v", result, err)
	}
}

func TestRestartHandoffRejectsNewLeasesAfterIdleShutdown(t *testing.T) {
	// Recurring bug class: lifecycle a replacement Desktop acquired a lease on an owner already tearing down.
	runtime := newRuntimeTestState()
	owner := id()
	enrollRuntimeTestClient(t, runtime, owner, "desktop", 1)
	if runtime.closeIfIdle() {
		t.Fatal("Core closed while Desktop retained its lease")
	}
	if _, err := runtime.request("runtime/release", object{"id": owner}); err != nil || !runtime.closeIfIdle() {
		t.Fatalf("Core did not close after the last lease: %v", err)
	}
	if _, err := runtime.request("runtime/lease", object{"id": id(), "kind": "desktop", "pid": 2}); err == nil || err.Error() != "core shutting down" || len(runtime.clients()) != 0 {
		t.Fatalf("tearing-down runtime accepted an entrant: %v", err)
	}
}
