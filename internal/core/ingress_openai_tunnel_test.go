package core

import "testing"

func TestTunnelControlPlaneHealthRequiresAnAuthenticatedPoll(t *testing.T) {
	// Algorithmic core: only a successful control-plane poll authenticates Tunnel Client and HTTP rejections take precedence.
	if state := openAITunnelHealth(object{"status": "ok", "details": object{}})["state"]; state != "unknown" {
		t.Fatalf("readiness without an authenticated poll: %s", state)
	}
	details := object{"last_success": "2026-10-17T00:00:00Z"}
	if state := openAITunnelHealth(object{"status": "ok", "details": details})["state"]; state != "authenticated" {
		t.Fatalf("successful poll did not authenticate: %s", state)
	}
	for _, code := range []int{401, 403, 500} {
		details["http_status"] = code
		want := "rejected"
		if code == 500 {
			want = "unknown"
		}
		if state := openAITunnelHealth(object{"status": "degraded", "details": details})["state"]; state != want {
			t.Fatalf("HTTP %d: got %s, want %s", code, state, want)
		}
	}
	if openAITunnelRejectedLog("controlplane client: unexpected status 403") != 403 ||
		openAITunnelRejectedLog("MCP endpoint: unexpected status 401") != 0 {
		t.Fatal("log authentication ignored the error owner")
	}
}
