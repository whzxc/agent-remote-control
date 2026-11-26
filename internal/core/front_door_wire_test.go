package core

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

type localWireTarget struct{}

func (localWireTarget) management(_ context.Context, route, method string, _ object) (any, error) {
	if route == "preferences" && method == "GET" {
		return preferenceDefaults(), nil
	}
	return nil, errors.New("UNKNOWN_ROUTE")
}
func (localWireTarget) mcp(context.Context, string, object) (object, error) {
	return nil, errors.New("unexpected MCP request")
}

func TestLocalFrontDoorRetainsAuthenticationAndReplyWire(t *testing.T) {
	// Contract: the shared Rust wire golden fixes local management authentication, status, headers and result bytes.
	server := httptest.NewUnstartedServer(localHandler(localWireTarget{}, 0, "private-fixture-token"))
	port := server.Listener.Addr().(*net.TCPAddr).Port
	server.Config.Handler = localHandler(localWireTarget{}, port, "private-fixture-token")
	server.Start()
	defer server.Close()
	golden := resource("front_door_wire.json")
	for _, row := range []struct{ name, auth, origin string }{
		{"local_denied", "", ""},
		{"local_allowed", "Bearer private-fixture-token", ""},
		{"local_origin", "Bearer private-fixture-token", "https://fixture.invalid"},
	} {
		req, err := http.NewRequest("GET", server.URL+"/api/preferences", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = "127.0.0.1:" + strconv.Itoa(port)
		if row.auth != "" {
			req.Header.Set("Authorization", row.auth)
		}
		if row.origin != "" {
			req.Header.Set("Origin", row.origin)
		}
		req.Header.Set("X-ARC-Source-Id", "forged")
		reply, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reply.Body)
		_ = reply.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		headers := object{}
		for _, key := range []string{"content-type", "cache-control", "www-authenticate", "allow", "referrer-policy", "x-content-type-options"} {
			if value := reply.Header.Get(key); value != "" {
				headers[key] = value
			}
		}
		got := object{"status": reply.StatusCode, "headers": headers, "body": string(data)}
		if wire(got) != wire(golden[row.name]) {
			t.Fatalf("wire %s = %v, want %v", row.name, got, golden[row.name])
		}
	}
}
