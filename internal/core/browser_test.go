package core

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
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
	if _, err := browserAccess(t.Context(), &service{}, true); err != nil {
		t.Fatal(err)
	}
	if reply := send("GET", preferences, "", cookie, ""); reply.Code != http.StatusUnauthorized {
		t.Fatalf("rotated cookie read = %d", reply.Code)
	}
}
