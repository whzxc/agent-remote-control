package core

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func desktopMetrics(t *testing.T, s *service) object {
	t.Helper()
	value, err := s.managementRequest(t.Context(), "runtime/metrics", http.MethodGet, nil)
	if err != nil {
		t.Fatal(err)
	}
	return obj(value)
}

func runtimeWorkRow(metrics object, name string) object {
	for _, row := range metrics["work"].([]object) {
		if row["name"] == name {
			return row
		}
	}
	return nil
}

func desktopFixture(t *testing.T, size int, wrap func(net.Conn) net.Conn) *nativeDesktopIPC {
	t.Helper()
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	client, server := net.Pipe()
	if wrap != nil {
		client = wrap(client)
	}
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

type desktopFrameCancellation struct {
	net.Conn
	cancel context.CancelFunc
}

func (c desktopFrameCancellation) Write(data []byte) (int, error) {
	n, err := c.Conn.Write(data)
	if err == nil && n == len(data) && bytes.Contains(data, []byte(`"method":"fixture-cancel-after-write"`)) {
		c.cancel()
		synctest.Wait()
	}
	return n, err
}

func TestDesktopCancelledReadsReleasePendingRequests(t *testing.T) {
	// Recurring bug class: lifecycle cancellation releases Desktop pending request storage and retains the connection.
	synctest.Test(t, func(t *testing.T) {
		completedFrame, cancelFrame := context.WithCancel(t.Context())
		defer cancelFrame()
		d := desktopFixture(t, 0, func(conn net.Conn) net.Conn {
			return desktopFrameCancellation{Conn: conn, cancel: cancelFrame}
		})
		for range 32 {
			ctx, cancel := context.WithTimeout(t.Context(), 2*time.Millisecond)
			_, err := d.request(ctx, "fixture-unanswered-read", object{}, "")
			cancel()
			if err == nil {
				t.Fatal("fixture read unexpectedly received a response")
			}
		}
		if _, err := d.request(completedFrame, "fixture-cancel-after-write", object{}, ""); err == nil {
			t.Fatal("fixture read unexpectedly completed after cancellation")
		}
		if uintOr(d.diagnostics()["pendingRequests"], 99) != 0 {
			t.Fatal(wire(d.diagnostics()))
		}
		if owner, err := d.owner(t.Context(), "after-cancellation"); err != nil || owner != "fixture-owner" {
			t.Fatalf("owner %q %v", owner, err)
		}
		s := &service{}
		s.codex.desktop = d
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		done := make(chan error, 2)
		for range 2 {
			go func() { _, err := d.request(ctx, "fixture-unanswered-read", nil, ""); done <- err }()
		}
		synctest.Wait()
		time.Sleep(25 * time.Millisecond)
		ipc := obj(desktopMetrics(t, s)["desktopIpc"])
		requests := ipc["requests"].([]object)
		if ipc["connected"] != true || ipc["pendingRequests"] != 2 || ipc["owners"] != 1 || len(requests) != 1 ||
			requests[0]["method"] != "fixture-unanswered-read" || requests[0]["count"] != 2 ||
			text(requests[0], "oldestRequestId") == "" || uintOr(requests[0]["oldestAgeMs"], 0) < 25 {
			t.Fatalf("pending Desktop IPC = %v", ipc)
		}
		cancel()
		for range 2 {
			if err := <-done; err == nil {
				t.Fatal("cancelled Desktop read succeeded")
			}
		}
		if pending := field(desktopMetrics(t, s)["desktopIpc"], "pendingRequests"); pending != 0 {
			t.Fatalf("cancelled reads left %v pending requests", pending)
		}
	})
}

func TestDesktopSnapshotBudgetAndIdleExpiry(t *testing.T) {
	// Recurring bug class: lifecycle Desktop snapshots stay bounded and expire without rereading old threads.
	synctest.Test(t, func(t *testing.T) {
		s := &service{}
		d := desktopFixture(t, 512*1024, nil)
		before := field(desktopMetrics(t, s)["cost"], "desktopSnapshots")
		s.codex.desktop = d
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
		after := field(desktopMetrics(t, s)["cost"], "desktopSnapshots")
		next := field(desktopMetrics(t, s)["cost"], "desktopSnapshots")
		wake := func(row any, reason string) uint64 { return uintOr(field(field(row, "wakesByReason"), reason), 0) }
		if wake(after, "timer") <= wake(before, "timer") || wake(after, "poll") <= wake(before, "poll") ||
			field(after, "scanSetSize") != uint64(0) || wake(next, "poll") != wake(after, "poll")+1 {
			t.Fatalf("snapshot cache attribution before = %v, after = %v, next = %v", before, after, next)
		}
	})
}

func TestDesktopFrameWorkMeasuresCompleteIncomingFrames(t *testing.T) {
	// Contract: runtime metrics time complete Desktop IPC frames through handling and exclude incomplete frames.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	s := &service{}
	client, peer := net.Pipe()
	defer peer.Close()
	defer client.Close()
	if err := peer.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	write := func(payload string, size int) error {
		frame := binary.LittleEndian.AppendUint32(nil, uint32(size))
		_, err := peer.Write(append(frame, payload...))
		return err
	}
	readSize := func() (uint32, error) {
		var header [4]byte
		_, err := io.ReadFull(peer, header[:])
		return binary.LittleEndian.Uint32(header[:]), err
	}
	readBody := func(size uint32) (object, error) {
		data := make([]byte, size)
		if _, err := io.ReadFull(peer, data); err != nil {
			return nil, err
		}
		var value object
		err := decodeObject(data, &value)
		return value, err
	}
	handshake := make(chan error, 1)
	go func() {
		size, err := readSize()
		var request object
		if err == nil {
			request, err = readBody(size)
		}
		if err != nil {
			peer.Close()
			handshake <- err
			return
		}
		reply := wire(object{"type": "response", "requestId": request["requestId"], "resultType": "success", "result": object{"clientId": "fixture"}})
		handshake <- write(reply, len(reply))
	}()
	d, err := initializeDesktopIPC(t.Context(), client, "fixture", &s.events)
	if err != nil {
		t.Fatal(err)
	}
	defer d.close()
	if err := <-handshake; err != nil {
		t.Fatal(err)
	}
	s.codex.desktop = d
	const discovery = `{"type":"client-discovery-request","requestId":"frame"}`
	// Consuming the next header on net.Pipe confirms the handshake frame has finished.
	if err := write("", len(discovery)); err != nil {
		t.Fatal(err)
	}
	work := func() object { return runtimeWorkRow(desktopMetrics(t, s), "desktopFrame") }
	before := work()
	if _, err := io.WriteString(peer, discovery); err != nil {
		t.Fatal(err)
	}
	// Read the reply header and leave its body unread so the frame stays in flight.
	size, err := readSize()
	if err != nil {
		t.Fatal(err)
	}
	if active := work(); active["inFlight"] != uint64(1) {
		t.Fatalf("discovery response did not remain in the frame timing scope: %v", active)
	}
	time.Sleep(35 * time.Millisecond)
	if reply, err := readBody(size); err != nil || reply["requestId"] != "frame" {
		t.Fatalf("discovery reply = %v, %v", reply, err)
	}
	if err := write("{", 1); err != nil {
		t.Fatal(err)
	}
	if err := write("{", 2); err != nil {
		t.Fatal(err)
	}
	peer.Close()
	<-d.done
	after := work()
	if after["calls"] != uintOr(before["calls"], 0)+2 || after["inFlight"] != uint64(0) ||
		after["totalWallMs"].(float64)-before["totalWallMs"].(float64) < 25 ||
		after["maxWallMs"].(float64) < 25 || field(desktopMetrics(t, s)["desktopIpc"], "connected") != false {
		t.Fatalf("frame work before = %v, after = %v", before, after)
	}
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

func TestServiceStatusReportsCodexDesktopAndAppServerState(t *testing.T) {
	// Contract: core.desktop and core.appServer report live readiness instead of hardcoded unknown.
	s := &service{}
	d := desktopFixture(t, 16, nil)
	s.codex.desktop = d
	desktop := s.desktopStatus(t.Context())
	if desktop["state"] != "ready" || desktop["transport"] != "ipc" || desktop["supported"] != true {
		t.Fatalf("desktop status = %v", desktop)
	}
	stopped := s.codexAppServerHealth()
	if stopped["state"] != "stopped" {
		t.Fatalf("idle appServer health = %v", stopped)
	}
	rpc := &rpcConnection{startedAt: now(), pid: 42}
	rpc.alive.Store(true)
	s.codex.utility = rpc
	ready := s.codexAppServerHealth()
	if ready["state"] != "ready" || ready["pid"] != 42 {
		t.Fatalf("live appServer health = %v", ready)
	}
}
