package core

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func TestBrowserFrontDoorWire(t *testing.T) {
	// Contract: Browser authority preserves the shared Rust read-only response bytes and cookie authentication.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	access, err := browserAccess(t.Context(), &service{}, false)
	if err != nil {
		t.Fatal(err)
	}
	key := text(access, "key")
	ingress := browserIngress{id: "wire", publicURL: "https://browser.example/mcp", connected: true,
		core: newInProcess(localWireTarget{}), assets: fstest.MapFS{"browser.html": {Data: []byte("<title>ARC</title>")}}}

	send := func(method, uri, auth, cookie, validator string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "https://browser.example"+uri, nil)
		if auth != "" {
			req.Header.Set("Authorization", "Bearer "+auth)
		}
		if cookie != "" {
			req.Header.Set("Cookie", cookie)
		}
		if validator != "" {
			req.Header.Set("If-None-Match", validator)
		}
		reply := httptest.NewRecorder()
		serveBrowser(reply, req, ingress)
		return reply
	}
	golden := resource("front_door_wire.json")
	const preferences = "/view-api/preferences"
	allowed := send("GET", preferences, key, "", "")
	for _, row := range []struct {
		name  string
		reply *httptest.ResponseRecorder
	}{
		{"browser_denied", send("GET", preferences, "", "", "")},
		{"browser_allowed", allowed},
		{"browser_write", send("POST", "/view-api/ingress/stop-all", key, "", "")},
	} {
		headers := object{}
		for _, key := range []string{"content-type", "cache-control", "referrer-policy", "x-content-type-options"} {
			if value := row.reply.Header().Get(key); value != "" {
				headers[key] = value
			}
		}
		got := object{"status": row.reply.Code, "headers": headers, "body": row.reply.Body.String()}
		if wire(got) != wire(golden[row.name]) {
			t.Fatalf("wire %s = %v, want %v", row.name, got, golden[row.name])
		}
	}
	unchanged := send("GET", preferences, key, "", `"different", W/`+allowed.Header().Get("ETag"))
	if unchanged.Code != http.StatusNotModified || unchanged.Body.Len() != 0 {
		t.Fatalf("conditional read = %d, %s", unchanged.Code, unchanged.Body)
	}
	page := send("GET", "/?key="+key, "", "", "")
	cookie, _, _ := strings.Cut(page.Header().Get("Set-Cookie"), ";")
	if page.Code != http.StatusOK || !strings.HasSuffix(page.Header().Get("Set-Cookie"), "; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict") {
		t.Fatalf("browser page = %d, %v", page.Code, page.Header())
	}
	reply := send("GET", preferences, "", cookie, "")
	if reply.Code != http.StatusOK || reply.Body.String() != allowed.Body.String() {
		t.Fatalf("cookie read = %d, %s", reply.Code, reply.Body)
	}

	ctx, cancel := context.WithTimeout(t.Context(), 6*time.Second)
	defer cancel()
	token, err := ensureFrontDoorSecret()
	if err != nil {
		t.Fatal(err)
	}
	private, err := listenPrivate(ctx, "core", token, ingress.core, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer private.Close()
	bridge := &gatewayBridge{}
	local := httptest.NewUnstartedServer(nil)
	port := local.Listener.Addr().(*net.TCPAddr).Port
	local.Config.Handler = localHandler(bridge, port, token)
	local.Start()
	defer local.Close()
	public := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		serveBrowser(w, req, ingress)
	}))
	defer public.Close()
	openEvents := func(server *httptest.Server, route, host, bearer string) *http.Response {
		t.Helper()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+route, nil)
		if err != nil {
			t.Fatal(err)
		}
		if host != "" {
			request.Host = host
		}
		request.Header.Set("Authorization", "Bearer "+bearer)
		reply, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		if reply.StatusCode != http.StatusOK || reply.Header.Get("Content-Type") != "text/event-stream" {
			reply.Body.Close()
			t.Fatalf("%s events = %d, %v", route, reply.StatusCode, reply.Header)
		}
		return reply
	}
	browserEvents := openEvents(public, "/view-api/subscriptions/events", "browser.example", key)
	defer browserEvents.Body.Close()
	localEvents := openEvents(local, "/api/subscriptions/events", "", token)
	defer localEvents.Body.Close()
	browserBody, localBody := bufio.NewReader(browserEvents.Body), bufio.NewReader(localEvents.Body)
	wantFrame := snapshotMessage(object{"accounts": []any{}})
	for _, stream := range []*bufio.Reader{browserBody, localBody} {
		frame := make([]byte, len(wantFrame))
		if _, err := io.ReadFull(stream, frame); err != nil || string(frame) != wantFrame {
			t.Fatalf("subscription snapshot = %q, %v", frame, err)
		}
	}
	ended := make(chan error, 1)
	go func() { _, err := browserBody.ReadByte(); ended <- err }()
	select {
	case err := <-ended:
		t.Fatalf("unchanged browser subscription sent an early frame or closed: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	if _, err := browserAccess(ctx, &service{}, true); err != nil {
		t.Fatal(err)
	}
	if reply := send("GET", preferences, "", cookie, ""); reply.Code != http.StatusUnauthorized {
		t.Fatalf("rotated cookie read = %d", reply.Code)
	}
	select {
	case err := <-ended:
		if err != io.EOF {
			t.Fatalf("rotated key did not close the browser stream: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("rotated key left the browser stream open")
	}
}
