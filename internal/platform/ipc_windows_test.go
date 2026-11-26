package platform

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func occupiedPipe(t *testing.T) (string, *uint16) {
	t.Helper()
	path := IPCPath("", fmt.Sprintf("test-%d-%d", os.Getpid(), time.Now().UnixNano()), "front-door")
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	server, err := windows.CreateNamedPipe(name, windows.PIPE_ACCESS_DUPLEX, windows.PIPE_TYPE_BYTE, 2, 4096, 4096, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { windows.CloseHandle(server) })
	client, err := DialIPC(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	return path, name
}

func TestWindowsIPCRetriesBusyPipe(t *testing.T) {
	// Recurring bug class: concurrency a client must survive the gap before a busy pipe can accept again.
	path, name := occupiedPipe(t)
	type replacement struct {
		handle windows.Handle
		err    error
	}
	replenished := make(chan replacement, 1)
	go func() {
		time.Sleep(30 * time.Millisecond)
		handle, err := windows.CreateNamedPipe(name, windows.PIPE_ACCESS_DUPLEX, windows.PIPE_TYPE_BYTE, 2, 4096, 4096, 0, nil)
		replenished <- replacement{handle, err}
	}()
	conn, err := DialIPC(t.Context(), path)
	next := <-replenished
	if next.err != nil {
		t.Fatal(next.err)
	}
	defer windows.CloseHandle(next.handle)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte{42}); err != nil {
		t.Fatal(err)
	}
	var buf [1]byte
	var read uint32
	if err := windows.ReadFile(next.handle, buf[:], &read, nil); err != nil || read != 1 || buf[0] != 42 {
		t.Fatalf("reopened pipe read %v: %v", buf, err)
	}
}

func TestWindowsIPCOpenBudgetPreservesBusyError(t *testing.T) {
	// Recurring bug class: lifecycle exhausting the pipe-open budget retains the reason instead of triggering owner recovery.
	path, _ := occupiedPipe(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	started := time.Now()
	conn, err := DialIPC(ctx, path)
	if conn != nil {
		conn.Close()
	}
	if elapsed := time.Since(started); !errors.Is(err, windows.ERROR_PIPE_BUSY) || elapsed < 200*time.Millisecond || elapsed > time.Second {
		t.Fatalf("busy pipe returned %v after %v", err, elapsed)
	}
}

func TestWindowsIPCMissingPipe(t *testing.T) {
	// Recurring bug class: lifecycle an absent pipe must let the caller enter owner recovery without the busy retry.
	path := IPCPath("", fmt.Sprintf("missing-%d-%d", os.Getpid(), time.Now().UnixNano()), "front-door")
	started := time.Now()
	conn, err := DialIPC(t.Context(), path)
	if conn != nil {
		conn.Close()
	}
	if elapsed := time.Since(started); !errors.Is(err, os.ErrNotExist) || elapsed >= 200*time.Millisecond {
		t.Fatalf("absent pipe returned %v after %v", err, elapsed)
	}
}
