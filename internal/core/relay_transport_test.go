//go:build arcfixture

package core

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestRelayControlVerifiesChallengeAndStreamedTunnel(t *testing.T) {
	// Contract: the relay worker authenticates the exact control envelope and uses request and response byte credits.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	data, err := generateRelayIdentity()
	if err != nil {
		t.Fatal(err)
	}
	identity, err := loadRelayIdentity(data)
	if err != nil {
		t.Fatal(err)
	}
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp" || r.Method != http.MethodPost {
			http.Error(w, "wrong ingress", 400)
			return
		}
		b, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "body failed", 400)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(b)
	}))
	defer local.Close()
	connected := make(chan *websocket.Conn, 1)
	const nonce = "fixture-nonce"
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/challenge":
			_, _ = io.WriteString(w, wire(object{"challenge": nonce}))
		case "/control":
			raw, err := io.ReadAll(r.Body)
			var body object
			if err != nil || decodeObject(raw, &body) != nil {
				http.Error(w, "invalid signed envelope", 400)
				return
			}
			signature, err := base64.StdEncoding.DecodeString(text(body, "signature"))
			message := "arc-relay-v1\nhttp://" + r.Host + "\n" + nonce + "\n" + hash([]byte(text(body, "payload")))
			if err != nil || !ed25519.Verify(identity.public(), []byte(message), signature) {
				http.Error(w, "invalid signature", 403)
				return
			}
			_, _ = io.WriteString(w, `{"ok":true}`)
		default:
			socket, err := websocket.Accept(w, r, nil)
			if err == nil {
				connected <- socket
			}
		}
	}))
	defer worker.Close()
	if result, err := relayControl(ctx, worker.Client(), worker.URL, identity, object{"op": "list"}); err != nil || field(result, "ok") != true {
		t.Fatalf("signed control did not reach the worker: %v", err)
	}
	link, err := relayUpgrade(ctx, worker.Client(), worker.URL, identity.id(), object{})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- relayRun(ctx, link, local.URL) }()
	defer func() { cancel(); <-done }()
	peer := <-connected
	defer peer.CloseNow()
	if _, raw, err := peer.Read(ctx); err != nil || string(raw) != "ping" {
		t.Fatalf("worker did not receive the relay heartbeat: %v", err)
	}
	send := func(frame object) {
		t.Helper()
		if err := peer.Write(ctx, websocket.MessageText, []byte(wire(frame))); err != nil {
			t.Fatal(err)
		}
	}
	read := func(kind string) object {
		t.Helper()
		_, raw, err := peer.Read(ctx)
		var frame object
		if err != nil || decodeObject(raw, &frame) != nil || frame["type"] != kind {
			t.Fatalf("expected %s: %v", kind, err)
		}
		return frame
	}
	send(object{"type": "request", "id": "fixture", "method": "POST", "path": "/mcp", "headers": []any{}})
	payload := base64.StdEncoding.EncodeToString([]byte{0, 255, 33})
	send(object{"type": "request-chunk", "id": "fixture", "data": payload})
	if read("request-credit")["id"] != "fixture" {
		t.Fatal("body credit did not identify the request")
	}
	send(object{"type": "request-end", "id": "fixture"})
	if uintOr(read("response")["status"], 0) != 200 {
		t.Fatal("local ingress did not receive the forwarded route")
	}
	send(object{"type": "response-credit", "id": "fixture"})
	if read("response-chunk")["data"] != payload {
		t.Fatal("worker did not receive the original binary bytes")
	}
	read("response-end")
}
