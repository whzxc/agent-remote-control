package core

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
)

func TestOAuthAuthorityOutageKeepsStoredGrant(t *testing.T) {
	// Recurring bug class: persistence Front-door replacement must preserve existing OAuth grants while Core authority is unavailable.
	const resource = "https://fixture.example/mcp"
	oauth := &ingressOAuth{stored: oauthStored{Resource: resource, Grants: []oauthGrant{{
		ID: "grant", Client: "client", Resource: resource, Access: hash([]byte("synthetic-token")), AccessExpires: 1 << 62,
	}}}}
	if principal := oauth.authenticateTransport("Bearer synthetic-token", resource); principal["grantId"] != "grant" {
		t.Fatalf("unexpected transport principal: %v", principal)
	}
	if oauth.authenticateTransport("Bearer synthetic-token", "https://other.example/mcp") != nil {
		t.Fatal("token was accepted for a different resource")
	}
	failure := errors.New("FRONT_DOOR_CORE_UNAVAILABLE")
	if err := oauth.applyAuthoritySnapshot(nil, failure); !errors.Is(err, failure) || oauth.status("grant", resource)["status"] != "completed" {
		t.Fatalf("authority outage changed the grant: %v", err)
	}
}

func TestOAuthConsentAndRefreshReplay(t *testing.T) {
	// Contract: OAuth code exchange enforces PKCE and a rotated refresh token replay revokes the source grant.
	ingress := t.TempDir()
	const resource = "https://fixture.example/mcp"
	const callback = "http://localhost:12345/callback"
	if err := save(filepath.Join(ingress, "config.json"), object{"id": "test-oauth", "auth": "oauth", "transport": "https", "controlSource": "claude"}); err != nil {
		t.Fatal(err)
	}
	oauth, err := newIngressOAuth(ingress, nil)
	if err != nil {
		t.Fatal(err)
	}
	active := map[string]bool{}
	oauth.authority = func(_ context.Context, op string, body object) (any, error) {
		switch op {
		case "pending":
			active[text(body, "grant")] = false
		case "connect":
			active[text(body, "grant")] = true
		case "revoke_grants":
			for _, grant := range arr(body["grants"]) {
				delete(active, str(grant))
			}
		case "active_grants":
			result := []any{}
			for _, grant := range arr(body["grants"]) {
				if active[str(grant)] {
					result = append(result, grant)
				}
			}
			return result, nil
		case "grant_active":
			return active[text(body, "grant")], nil
		case "for_grant":
			return object{"product": "claude"}, nil
		case "candidates":
			return []any{}, nil
		}
		return nil, nil
	}
	ctx := t.Context()
	handler := func(path, method, content, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequestWithContext(ctx, method, path, strings.NewReader(body))
		if content != "" {
			req.Header.Set("Content-Type", content)
		}
		reply := httptest.NewRecorder()
		oauth.writeHTTP(reply, req, resource, oauthHTTPContext{})
		return reply
	}
	registered := handler("/oauth/register", "POST", "application/json", wire(object{"client_name": "Claude", "redirect_uris": []string{callback}, "token_endpoint_auth_method": "none"}))
	var client object
	if registered.Code != 201 || decodeObject(registered.Body.Bytes(), &client) != nil || text(client, "client_id") == "" {
		t.Fatalf("registration failed: %d %s", registered.Code, registered.Body)
	}
	verifier := strings.Repeat("a", 43)
	challenge := sha256.Sum256([]byte(verifier))
	query := url.Values{"client_id": {text(client, "client_id")}, "redirect_uri": {callback}, "response_type": {"code"},
		"resource": {resource}, "state": {"fixture"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}}
	start := handler("/oauth/authorize?"+query.Encode(), "GET", "", "")
	redirect, err := url.Parse(start.Header().Get("Location"))
	if start.Code != 303 || err != nil || redirect.Query().Get("request") == "" {
		t.Fatalf("authorization failed: %d %v", start.Code, err)
	}
	request := redirect.Query().Get("request")
	if err := oauth.decide(ctx, request, true, nil); err != nil {
		t.Fatal(err)
	}
	reply := handler("/oauth/continue?request="+request, "GET", "", "")
	redirect, err = url.Parse(reply.Header().Get("Location"))
	if reply.Code != 303 || err != nil || redirect.Query().Get("state") != "fixture" || redirect.Query().Get("iss") != "https://fixture.example" {
		t.Fatalf("unexpected continuation: %d %v", reply.Code, err)
	}
	query = url.Values{"grant_type": {"authorization_code"}, "client_id": {text(client, "client_id")}, "resource": {resource},
		"redirect_uri": {callback}, "code": {redirect.Query().Get("code")}, "code_verifier": {strings.Repeat("z", 43)}}
	exchange := func() *httptest.ResponseRecorder {
		return handler("/oauth/token", "POST", "application/x-www-form-urlencoded", query.Encode())
	}
	if invalid := exchange(); invalid.Code != 400 || !strings.Contains(invalid.Body.String(), "invalid_grant") {
		t.Fatalf("incorrect verifier moved the grant: %d", invalid.Code)
	}
	query.Set("code_verifier", verifier)
	success := exchange()
	var tokens object
	if success.Code != 200 || decodeObject(success.Body.Bytes(), &tokens) != nil || oauth.authenticate(ctx, "Bearer "+text(tokens, "access_token"), resource) == nil {
		t.Fatalf("valid exchange did not admit the grant: %d", success.Code)
	}
	query = url.Values{"grant_type": {"refresh_token"}, "client_id": {text(client, "client_id")}, "resource": {resource}, "refresh_token": {text(tokens, "refresh_token")}}
	rotated := exchange()
	var next object
	if rotated.Code != 200 || decodeObject(rotated.Body.Bytes(), &next) != nil || text(next, "refresh_token") == text(tokens, "refresh_token") {
		t.Fatalf("refresh token did not rotate: %d", rotated.Code)
	}
	if replay := exchange(); replay.Code != 400 || !strings.Contains(replay.Body.String(), "invalid_grant") || oauth.authenticate(ctx, "Bearer "+text(next, "access_token"), resource) != nil {
		t.Fatalf("replayed refresh token did not revoke source access: %d", replay.Code)
	}
}
