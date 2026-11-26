//go:build arcfixture

package core

import (
	"bytes"
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func loopbackRelaySocket(t *testing.T, ctx context.Context, local string) *websocket.Conn {
	t.Helper()
	connected := make(chan *websocket.Conn, 1)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := websocket.Accept(w, r, nil)
		if err == nil {
			socket.SetReadLimit(65_536)
			connected <- socket
		}
	}))
	t.Cleanup(worker.Close)
	link, err := relayUpgrade(ctx, worker.Client(), worker.URL, "fixture", object{})
	if err != nil {
		t.Fatal(err)
	}
	wait, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- relayRun(wait, link, local) }()
	t.Cleanup(func() { cancel(); <-done })
	select {
	case peer := <-connected:
		t.Cleanup(func() { _ = peer.CloseNow() })
		if _, raw, err := peer.Read(ctx); err != nil || string(raw) != "ping" {
			t.Fatalf("relay startup heartbeat: %v", err)
		}
		return peer
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		return nil
	}
}

func TestRelayPeerTransferSurvivesSlowContinuousCredit(t *testing.T) {
	// Recurring bug class: lifecycle active multipart relay transfers retain their peer body and response deadlines while credits arrive.
	directory := t.TempDir()
	parent, _, _, link := openDeviceTunnelFixture(t, directory)
	// The raw WebSocket reads and writes in this fixture need a caller deadline.
	ctx, cancel := context.WithTimeout(parent, 25*time.Second)
	t.Cleanup(cancel)
	local, _ := strings.CutSuffix(link.path.tunnelURL, "/arc-peer/3")
	peer := loopbackRelaySocket(t, ctx, local)
	data := bytes.Repeat([]byte{0x2a}, deviceTransferTunnelRange)
	sum := hash(data)
	request := id()
	if _, err := link.control(ctx, object{"action": "begin", "requestId": request, "spec": object{
		"path": filepath.Join(directory, "target"), "total": len(data), "expectedSha256": sum,
	}}); err != nil {
		t.Fatal(err)
	}
	send := func(value object) {
		t.Helper()
		if err := peer.Write(ctx, websocket.MessageText, []byte(wire(value))); err != nil {
			t.Fatal(err)
		}
	}
	read := func(kind string) object {
		t.Helper()
		_, raw, err := peer.Read(ctx)
		var value object
		if err != nil || decodeObject(raw, &value) != nil || kind != "" && value["type"] != kind {
			t.Fatalf("relay expected %s: %s (%v)", kind, raw, err)
		}
		return value
	}
	startRequest := func(id string) {
		send(object{"type": "request", "id": id, "method": http.MethodPost, "path": "/arc-peer/3/transfer/control",
			"headers": []any{[]any{"Authorization", "Bearer " + link.path.token}, []any{"Content-Type", "application/json"}}})
	}
	delay := func() {
		timer := time.NewTimer(2 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			t.Fatal(ctx.Err())
		case <-timer.C:
		}
	}
	startRequest("upload")
	payload := wire(object{"version": deviceProtocolVersion, "action": "put", "requestId": request,
		"offset": 0, "sha256": sum, "data": base64.StdEncoding.EncodeToString(data)})
	for start := 0; start < len(payload); start += 32 * 1024 {
		delay()
		chunk := payload[start:min(start+32*1024, len(payload))]
		send(object{"type": "request-chunk", "id": "upload", "data": base64.StdEncoding.EncodeToString([]byte(chunk))})
		if read("request-credit")["id"] != "upload" {
			t.Fatal("request credit used another ID")
		}
	}
	send(object{"type": "request-end", "id": "upload"})
	if read("response")["id"] != "upload" {
		t.Fatal("relay response used another request ID")
	}
	send(object{"type": "response-credit", "id": "upload"})
	frame := read("response-chunk")
	body, err := base64.StdEncoding.DecodeString(text(frame, "data"))
	var result object
	if err != nil || decodeObject(body, &result) != nil || result["ok"] != true ||
		uintOr(field(result["result"], "offset"), 0) != uint64(len(data)) {
		t.Fatalf("slow upload result %s: %v", body, err)
	}
	read("response-end")
	if completed, err := link.control(ctx, object{"action": "commit", "requestId": request}); err != nil || field(completed, "sha256") != sum {
		t.Fatalf("relay transfer integrity: %v (%v)", completed, err)
	}
	path := filepath.Join(directory, "target")
	stamp, err := link.control(ctx, object{"action": "stat", "path": path})
	if err != nil {
		t.Fatal(err)
	}
	startRequest("download")
	payload = wire(object{"version": deviceProtocolVersion, "action": "get", "path": path, "fingerprint": stamp, "requestId": id(), "offset": 0, "length": len(data)})
	send(object{"type": "request-chunk", "id": "download", "data": base64.StdEncoding.EncodeToString([]byte(payload))})
	read("request-credit")
	send(object{"type": "request-end", "id": "download"})
	read("response")
	var incoming bytes.Buffer
	for {
		delay()
		send(object{"type": "response-credit", "id": "download"})
		frame := read("")
		if frame["id"] != "download" {
			t.Fatalf("download frame used another request ID: %v", frame)
		}
		if frame["type"] == "response-end" {
			break
		}
		if frame["type"] != "response-chunk" {
			t.Fatalf("unexpected download frame: %v", frame)
		}
		chunk, err := base64.StdEncoding.DecodeString(text(frame, "data"))
		if err != nil {
			t.Fatal(err)
		}
		incoming.Write(chunk)
	}
	if err := decodeObject(incoming.Bytes(), &result); err != nil || result["ok"] != true || field(result["result"], "sha256") != sum {
		t.Fatalf("download integrity: %v", err)
	}
	got, err := base64.StdEncoding.DecodeString(text(result["result"], "data"))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("slow download changed the file payload: %v", err)
	}

}
