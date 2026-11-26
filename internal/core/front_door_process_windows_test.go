package core

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
	"golang.org/x/sys/windows"
)

func TestWindowsBusyFrontDoorDoesNotEnterOwnerRecovery(t *testing.T) {
	// Recurring bug class: lifecycle exhausting the busy-pipe retry budget must leave the existing owner alone.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	path := ipcEndpoint("front-door")
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateNamedPipe(name, windows.PIPE_ACCESS_DUPLEX, windows.PIPE_TYPE_BYTE, 1, 4096, 4096, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	occupied, err := platform.DialIPC(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	started := time.Now()
	attachment, err := ensureFrontDoor(ctx, "unused-build")
	var open *privateOpenError
	if attachment.info != nil || !errors.As(err, &open) || open.owner != "front-door" ||
		!errors.Is(open.cause, windows.ERROR_PIPE_BUSY) || missingPrivateEndpoint(err) ||
		time.Since(started) < 200*time.Millisecond || ctx.Err() != nil {
		t.Fatalf("busy pipe entered recovery or lost its cause: %+v, %v", attachment, err)
	}
}

func TestWindowsMissingFrontDoorEntersOwnerRecovery(t *testing.T) {
	// Recurring bug class: lifecycle an absent pipe must proceed to the owner bootstrap without a busy wait.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	started := time.Now()
	_, err := readFrontDoorInfo(ctx)
	var open *privateOpenError
	if !errors.As(err, &open) || !errors.Is(open.cause, os.ErrNotExist) || !missingPrivateEndpoint(err) ||
		time.Since(started) >= 200*time.Millisecond {
		t.Fatalf("missing owner discovery did not return promptly: %v", err)
	}
	// The test executable has no installed Core sibling, so recovery stops before staging or starting an owner.
	attachment, err := ensureFrontDoor(ctx, "unused-build")
	if attachment.info != nil || err == nil || err.Error() != "The installation is missing the standalone Core executable." {
		t.Fatalf("missing pipe did not enter the owner bootstrap: %+v, %v", attachment, err)
	}
}
