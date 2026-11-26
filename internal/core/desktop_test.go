package core

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func desktopFixture(t *testing.T, size int) *nativeDesktopIPC {
	t.Helper()
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	client, server := net.Pipe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer server.Close()
		for {
			var header [4]byte
			if _, err := io.ReadFull(server, header[:]); err != nil {
				return
			}
			frame := make([]byte, binary.LittleEndian.Uint32(header[:]))
			if _, err := io.ReadFull(server, frame); err != nil {
				return
			}
			var request object
			if decodeObject(frame, &request) != nil {
				return
			}
			thread := field(request["params"], "conversationId")
			var response object
			switch request["method"] {
			case "initialize":
				response = object{"type": "response", "requestId": request["requestId"], "resultType": "success", "result": object{"clientId": "fixture"}}
			case "thread-owner-discovery":
				response = object{"type": "response", "requestId": request["requestId"], "resultType": "success", "handledByClientId": "fixture-owner"}
			case "thread-stream-following-changed":
				state := object{"id": thread, "turnHistory": object{"history": object{"isComplete": true}}, "fixture": strings.Repeat("x", size)}
				response = object{"type": "broadcast", "method": "thread-stream-state-changed", "version": 11, "sourceClientId": "fixture-owner",
					"params": object{"hostId": "local", "conversationId": thread,
						"change": object{"type": "snapshot", "revision": 1, "conversationState": state}}}
			default:
				continue
			}
			data := []byte(wire(response))
			binary.LittleEndian.PutUint32(header[:], uint32(len(data)))
			if _, err := server.Write(header[:]); err != nil {
				return
			}
			if _, err := server.Write(data); err != nil {
				return
			}
		}
	}()
	d, err := initializeDesktopIPC(t.Context(), client, "fixture", &nativeEvents{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		d.close()
		<-done
	})
	return d
}

func TestDesktopCancelledReadsReleasePendingRequests(t *testing.T) {
	// Recurring bug class: lifecycle cancellation releases Desktop pending request storage and retains the connection.
	synctest.Test(t, func(t *testing.T) {
		d := desktopFixture(t, 0)
		for range 32 {
			ctx, cancel := context.WithTimeout(t.Context(), 2*time.Millisecond)
			_, err := d.request(ctx, "fixture-unanswered-read", object{}, "")
			cancel()
			if err == nil {
				t.Fatal("fixture read unexpectedly received a response")
			}
		}
		if uintOr(d.diagnostics()["pendingRequests"], 99) != 0 {
			t.Fatal(wire(d.diagnostics()))
		}
		if owner, err := d.owner(t.Context(), "after-cancellation"); err != nil || owner != "fixture-owner" {
			t.Fatalf("owner %q %v", owner, err)
		}
	})
}

func TestDesktopSnapshotBudgetAndIdleExpiry(t *testing.T) {
	// Recurring bug class: lifecycle Desktop snapshots stay bounded and expire without rereading old threads.
	synctest.Test(t, func(t *testing.T) {
		d := desktopFixture(t, 512*1024)
		retained, err := d.read(t.Context(), "retained-reader", true)
		if err != nil {
			t.Fatal(err)
		}
		for i := range 80 {
			id := "fixture-" + strconv.Itoa(i)
			if value, err := d.read(t.Context(), id, true); err != nil || value["id"] != id {
				t.Fatalf("snapshot %s: %v", id, err)
			}
		}
		report := obj(d.diagnostics()["snapshots"])
		if uintOr(report["entries"], 99) > 64 || uintOr(report["wireBytes"], 0) > 32*1024*1024 || uintOr(report["evictions"], 0) == 0 {
			t.Fatal(wire(report))
		}
		if value, err := d.read(t.Context(), "fixture-0", true); err != nil || value["id"] != "fixture-0" {
			t.Fatalf("reopen: %v", err)
		}
		time.Sleep(4100 * time.Millisecond)
		if uintOr(field(d.diagnostics()["snapshots"], "entries"), 99) != 0 || retained["id"] != "retained-reader" || len(text(retained, "fixture")) != 512*1024 {
			t.Fatal("idle expiry changed an immutable reader or retained a stale cache entry")
		}
	})
}

func TestDesktopOnlyDefiniteMissingOwnerAllowsLoadingFallback(t *testing.T) {
	// Algorithmic core: only a definite missing owner admits fallback without a confirmed writer.
	for _, message := range []string{"DESKTOP_REJECTED:\"no-client-found\"", "DESKTOP_OWNER_NOT_FOUND"} {
		if !desktopMissingOwner(errors.New(message)) {
			t.Fatal(message)
		}
	}
	for _, message := range []string{"SUBMISSION_UNCONFIRMED: no-client-found", "DESKTOP_DISCONNECTED",
		"DESKTOP_REQUEST_TIMEOUT: thread-follower-start-turn", "DESKTOP_REJECTED: permission denied"} {
		if desktopMissingOwner(errors.New(message)) {
			t.Fatal(message)
		}
	}
}
