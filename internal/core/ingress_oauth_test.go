//go:build arcfixture

package core

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestExternalOAuthRevocationWire(t *testing.T) {
	// Contract: external HTTPS OAuth registration, approval, token exchange and revoked-session wire.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	secret, err := ensureFrontDoorSecret()
	if err != nil {
		t.Fatal(err)
	}
	core := newInProcess(&service{fixtureIngress: fixtureIngressSource})
	ipc, err := listenPrivate(ctx, "core", secret, core, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ipc.Close()
	closeGateway, err := startFixtureIngressGateway(ctx, secret, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer closeGateway()
	const resource = "https://oauth-wire.example/mcp"
	const callback = "http://127.0.0.1:43210/callback"
	gateway := func(method, route string, body object) any {
		t.Helper()
		result, err := gatewayRequest(ctx, route, method, body)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	row := gateway(http.MethodPost, "ingress", object{
		"id": "oauthwire", "name": "OAuth wire fixture", "controlSource": "custom", "transport": "https", "auth": "oauth",
		"toolPolicy": "all", "config": object{"httpsProvider": "custom", "httpsUrl": resource},
	})
	gateway(http.MethodPost, "ingress/oauthwire/start", object{})
	base := "http://127.0.0.1:" + wire(field(field(row, "config"), "httpsPort"))
	client := &http.Client{Transport: &http.Transport{}, CheckRedirect: relayNoRedirect, Timeout: time.Second}
	defer client.CloseIdleConnections()
	call := func(method, path, content, body, bearer string, want int) (http.Header, []byte) {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, method, base+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Content-Type", content)
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
			req.Header.Set("Mcp-Session-Id", "cached-session")
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		data, err := io.ReadAll(res.Body)
		if err != nil || res.StatusCode != want {
			t.Fatalf("%s %s returned %d: %s (%v)", method, path, res.StatusCode, data, err)
		}
		return res.Header, data
	}
	queryFromRedirect := func(headers http.Header) url.Values {
		t.Helper()
		location, err := url.Parse(headers.Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		return location.Query()
	}

	_, registration := call(http.MethodPost, "/oauth/register", "application/json", wire(object{
		"client_name": "Wire fixture", "redirect_uris": []string{callback}, "token_endpoint_auth_method": "none",
	}), "", http.StatusCreated)
	var registered object
	if err := decodeObject(registration, &registered); err != nil || text(registered, "client_id") == "" {
		t.Fatalf("missing registered client: %v", err)
	}
	verifier := strings.Repeat("v", 43)
	challenge := sha256.Sum256([]byte(verifier))
	params := url.Values{
		"client_id": {text(registered, "client_id")}, "redirect_uri": {callback}, "response_type": {"code"},
		"resource": {resource}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"},
	}
	headers, _ := call(http.MethodGet, "/oauth/authorize?"+params.Encode(), "", "", "", http.StatusSeeOther)
	requestID := queryFromRedirect(headers).Get("request")
	snapshot := gateway(http.MethodGet, "ingress/oauthwire/oauth", nil)
	source := find(field(snapshot, "pending"), "id", requestID)
	sourceID := text(source, "sourceId")
	if requestID == "" || sourceID == "" {
		t.Fatal("missing pending consent or source")
	}
	gateway(http.MethodPost, "source/"+sourceID+"/claim", object{"sourceId": "new"})
	headers, _ = call(http.MethodGet, "/oauth/continue?request="+url.QueryEscape(requestID), "", "", "", http.StatusSeeOther)
	params.Set("grant_type", "authorization_code")
	params.Set("code", queryFromRedirect(headers).Get("code"))
	params.Set("code_verifier", verifier)
	_, reply := call(http.MethodPost, "/oauth/token", "application/x-www-form-urlencoded", params.Encode(), "", http.StatusOK)
	var tokens object
	if err := decodeObject(reply, &tokens); err != nil || tokens["token_type"] != "Bearer" || text(tokens, "access_token") == "" {
		t.Fatalf("missing bearer token: %v", err)
	}

	ping := `{"jsonrpc":"2.0","id":12,"method":"ping"}`
	token := text(tokens, "access_token")
	_, reply = call(http.MethodPost, "/mcp", "application/json", ping, token, http.StatusOK)
	if string(reply) != `{"id":12,"jsonrpc":"2.0","result":{"resultType":"complete"}}` {
		t.Fatalf("OAuth MCP response %s", reply)
	}
	gateway(http.MethodPost, "source/"+sourceID+"/disconnect", nil)
	headers, reply = call(http.MethodPost, "/mcp", "application/json", ping, token, http.StatusUnauthorized)
	if string(reply) != `{"error":"unauthorized"}` || headers.Get("Cache-Control") != "no-store" ||
		headers.Get("Content-Type") != "application/json" ||
		headers.Get("WWW-Authenticate") != `Bearer resource_metadata="https://oauth-wire.example/.well-known/oauth-protected-resource/mcp", scope="mcp"` {
		t.Fatalf("revoked grant wire %v %s", headers, reply)
	}
}
