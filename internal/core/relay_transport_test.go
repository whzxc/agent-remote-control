//go:build arcfixture

package core

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
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

func TestRelayForwardPreservesSSEFlowCreditAndHTTPHeaders(t *testing.T) {
	// Contract: relay frames preserve the local HTTP wire and forward each SSE chunk only after credit.
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Second)
	defer cancel()
	nextEvent, firstWritten := make(chan struct{}), make(chan struct{})
	payload := []byte{0, 1, 254, 255}
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, err := io.ReadAll(r.Body)
		if err != nil || !bytes.Equal(got, payload) || r.ContentLength != int64(len(payload)) ||
			r.RequestURI != "/oauth/token?x=%2F" || r.Method != http.MethodPost || r.Host == "invalid.example" ||
			r.Header.Get("Authorization") != "Bearer fixture" || r.Header.Get("X-Test") != "exact" {
			http.Error(w, "unexpected request wire", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Add("Set-Cookie", "one=1")
		w.Header().Add("Set-Cookie", "two=2")
		_, _ = io.WriteString(w, "data: one\n\n")
		_ = http.NewResponseController(w).Flush()
		close(firstWritten)
		select {
		case <-nextEvent:
			_, _ = io.WriteString(w, "data: two\n\n")
		case <-ctx.Done():
		}
	}))
	defer local.Close()
	body, credit, out := make(chan []byte, 1), make(chan struct{}, 1), make(chan object, 8)
	body <- payload
	close(body)
	done := make(chan error, 1)
	go func() {
		done <- relayForward(ctx, local.Client(), local.URL, object{
			"id": "request", "method": "POST", "path": "/oauth/token?x=%2F",
			"headers": []any{[]any{"Authorization", "Bearer fixture"}, []any{"Host", "invalid.example"},
				[]any{"Content-Length", "4"}, []any{"X-Test", "exact"}},
		}, body, credit, out)
		close(done)
	}()
	defer func() { cancel(); <-done }()
	read := func(kind string) object {
		t.Helper()
		select {
		case frame := <-out:
			if frame["type"] != kind {
				t.Fatalf("expected %s, got %v", kind, frame)
			}
			return frame
		case <-ctx.Done():
			t.Fatalf("relay never sent %s", kind)
			return nil
		}
	}
	if frame := read("request-credit"); frame["id"] != "request" {
		t.Fatalf("request credit = %v", frame)
	}
	head := read("response")
	var cookies []string
	for _, pair := range head["headers"].([][2]string) {
		if pair[0] == "set-cookie" {
			cookies = append(cookies, pair[1])
		}
	}
	if head["status"] != http.StatusOK || !reflect.DeepEqual(cookies, []string{"one=1", "two=2"}) {
		t.Fatalf("SSE response headers = %v", head)
	}
	select {
	case <-firstWritten:
	case <-ctx.Done():
		t.Fatal("local SSE response did not start")
	}
	select {
	case frame := <-out:
		t.Fatalf("relay forwarded an SSE chunk without credit: %v", frame)
	case <-time.After(30 * time.Millisecond):
	}
	for _, name := range []string{"one", "two"} {
		credit <- struct{}{}
		frame := read("response-chunk")
		if data, err := base64.StdEncoding.DecodeString(text(frame, "data")); err != nil || string(data) != "data: "+name+"\n\n" {
			t.Fatalf("SSE %s frame = %q, %v", name, data, err)
		}
		if name == "one" {
			close(nextEvent)
		}
	}
	read("response-end")
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRelayWaitsForTheExpectedDeploymentVersion(t *testing.T) {
	// Recurring bug class: retry-replay deployment readiness must survive route propagation and stale Worker versions.
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	var requests atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/challenge" || requests.Add(1) == 1 {
			http.NotFound(w, r)
			return
		}
		version := "prior-build"
		if requests.Load() >= 3 {
			version = buildVersion
		}
		_, _ = io.WriteString(w, wire(object{"challenge": "fixture", "version": version}))
	}))
	defer worker.Close()
	if err := relayWaitDeployed(ctx, worker.Client(), worker.URL); err != nil {
		t.Fatal(err)
	}
	if requests.Load() < 3 {
		t.Fatal("relay reported readiness before the current worker version appeared")
	}
}

func TestRelayCancelClosesTheForwardedRequest(t *testing.T) {
	// Recurring bug class: lifecycle a Worker cancel must stop the corresponding local HTTP request.
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Second)
	defer cancel()
	started, stopped := make(chan struct{}), make(chan struct{})
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(stopped)
	}))
	defer local.Close()
	peerSockets := make(chan *websocket.Conn, 1)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if peer, err := websocket.Accept(w, r, nil); err == nil {
			peerSockets <- peer
		}
	}))
	defer worker.Close()
	socket, err := relayUpgrade(ctx, worker.Client(), worker.URL, "fixture", object{})
	if err != nil {
		t.Fatal(err)
	}
	peer := <-peerSockets
	defer peer.CloseNow()
	done := make(chan error, 1)
	go func() { done <- relayRun(ctx, socket, local.URL) }()
	defer func() { cancel(); <-done }()
	send := func(frame object) {
		t.Helper()
		if err := peer.Write(ctx, websocket.MessageText, []byte(wire(frame))); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := peer.Read(ctx); err != nil {
		t.Fatal(err)
	}
	send(object{"type": "request", "id": "cancelled", "method": "POST", "path": "/mcp", "headers": []any{}})
	send(object{"type": "request-end", "id": "cancelled"})
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("local request did not start")
	}
	send(object{"type": "cancel", "id": "cancelled"})
	select {
	case <-stopped:
	case <-ctx.Done():
		t.Fatal("local request survived Worker cancellation")
	}
}

func TestRelayWebsocketUsesHTTPProxy(t *testing.T) {
	// Contract: a Relay WebSocket upgrade follows the system-mode Relay proxy.
	peerSockets := make(chan *websocket.Conn, 1)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Host != "relay.invalid" || r.URL.Path != "/connect/example" {
			http.Error(w, "unexpected proxy request", http.StatusBadRequest)
			return
		}
		if peer, err := websocket.Accept(w, r, nil); err == nil {
			peerSockets <- peer
		}
	}))
	defer proxy.Close()
	t.Setenv("https_proxy", proxy.URL)
	t.Setenv("http_proxy", proxy.URL)
	t.Setenv("NO_PROXY", "")
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	httpClient, err := relayHTTPClient(ctx, object{"proxyMode": "system"})
	if err != nil {
		t.Fatal(err)
	}
	defer httpClient.CloseIdleConnections()
	client, err := relayUpgrade(ctx, httpClient, "http://relay.invalid", "example", object{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseNow()
	peer := <-peerSockets
	defer peer.CloseNow()
	if err := peer.Write(ctx, websocket.MessageText, []byte("proxied")); err != nil {
		t.Fatal(err)
	}
	if _, message, err := client.Read(ctx); err != nil || string(message) != "proxied" {
		t.Fatalf("proxied connection delivered %q: %v", message, err)
	}
}
