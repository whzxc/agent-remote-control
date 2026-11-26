//go:build arcfixture

package core

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestPublicIngressRetainsBearerAndMCPWire(t *testing.T) {
	// Contract: external MCP rejects absent credentials and uses the installed ingress authority and wire envelope.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	token, err := ensureFrontDoorSecret()
	if err != nil {
		t.Fatal(err)
	}
	core := newInProcess(&service{fixtureIngress: fixtureIngressSource})
	ipc, err := listenPrivate(ctx, "core", token, core, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ipc.Close()
	closeGateway, err := startFixtureIngressGateway(ctx, token, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer closeGateway()
	bearer := strings.Repeat("a", 40)
	row, err := gatewayRequest(ctx, "ingress", http.MethodPost, object{
		"id": "wire", "name": "Wire fixture", "transport": "https", "auth": "bearer", "bearerToken": bearer,
		"controlSource": "custom", "toolPolicy": "all",
		"config": object{"httpsProvider": "custom", "httpsUrl": "https://wire.example/mcp"},
	})
	if err != nil {
		t.Fatal(err)
	}
	port := field(field(row, "config"), "httpsPort")
	if _, err := gatewayRequest(ctx, "ingress/wire/start", http.MethodPost, object{}); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: &http.Transport{}, Timeout: time.Second}
	defer client.CloseIdleConnections()
	golden := resource("front_door_wire.json")
	for _, example := range []struct{ key, method, auth string }{
		{"mcp_denied", http.MethodPost, ""},
		{"mcp_allowed", http.MethodPost, "Bearer " + bearer},
		{"mcp_method", http.MethodGet, "Bearer " + bearer},
	} {
		req, err := http.NewRequestWithContext(ctx, example.method, "http://127.0.0.1:"+wire(port)+"/mcp",
			strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"ping"}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-ARC-Ingress-Id", "forged")
		req.Header.Set("X-ARC-Source-Id", "forged")
		if example.auth != "" {
			req.Header.Set("Authorization", example.auth)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		headers := object{}
		for _, name := range []string{"allow", "cache-control", "content-type", "www-authenticate"} {
			if value := res.Header.Get(name); value != "" {
				headers[name] = value
			}
		}
		got := object{"status": res.StatusCode, "headers": headers, "body": string(body)}
		if wire(got) != wire(golden[example.key]) {
			t.Fatalf("%s: got %v, want %v", example.key, got, golden[example.key])
		}
	}
}
