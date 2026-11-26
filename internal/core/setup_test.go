package core

import (
	"strings"
	"testing"
)

func setupScenario(goal string) (object, object) {
	state := object{"goal": goal, "startedAt": "2026-10-17T00:00:00.000Z", "choices": object{}}
	data := object{"login": object{"state": "authenticated"}, "permissions": object{"items": []any{
		object{"id": "claude-code", "state": "granted"}, object{"id": "full-disk-access", "state": "granted"},
		object{"id": "command-full-disk-access", "state": "not-applicable"},
	}}, "ingresses": []any{}}
	return state, data
}

func setupScenarioHTTPS() object {
	const endpoint = "https://example.com/mcp"
	return object{"id": "existing", "controlSource": "claude", "transport": "https", "auth": "oauth", "running": true, "state": "ready", "url": endpoint,
		"config":       object{"httpsProvider": "cloudflare", "cloudflareMode": "quick"},
		"verification": object{"lastProbe": object{"passed": true, "url": endpoint}}}
}

func assertSetupStep(t *testing.T, state, data object, expected string) {
	t.Helper()
	if step := deriveSetup(state, data, "en")["step"]; text(step, "id") != expected {
		t.Fatalf("step = %v, want %s", step, expected)
	}
}

func TestClaudeSetupRequiresFreshChallengeAndDelivery(t *testing.T) {
	// Algorithmic core: Claude setup progresses through ingress, consent, a fresh challenge and completed delivery evidence.
	state, data := setupScenario("claude-loop")
	assertSetupStep(t, state, data, "choose-address")
	obj(state["choices"])["choose-address"] = "cf-quick"
	assertSetupStep(t, state, data, "create-ingress")
	ingress := setupScenarioHTTPS()
	data["ingresses"] = []any{ingress}
	if setupSelectedIngress(state, data["ingresses"])["id"] != "existing" {
		t.Fatal("existing ingress was not selected")
	}
	assertSetupStep(t, state, data, "add-connector")
	verification := obj(ingress["verification"])
	verification["firstOAuthRequestAt"] = "2026-10-17T00:01:00.000Z"
	assertSetupStep(t, state, data, "consent")
	data["oauth"] = object{"grants": []any{object{"id": "grant"}}}
	assertSetupStep(t, state, data, "verify-connector")
	verification["challengeVerifiedAt"] = "2026-10-16T23:59:00.000Z"
	assertSetupStep(t, state, data, "verify-connector")
	verification["challengeVerifiedAt"] = "2026-10-17T00:02:00.000Z"
	assertSetupStep(t, state, data, "loop-test")
	data["loop"] = object{"notificationFailed": true}
	result := deriveSetup(state, data, "zh-CN")
	if result["complete"] != false || find(result["findings"], "code", "notification-failed") == nil {
		t.Fatalf("missing delivery diagnosis: %v", result)
	}
	completed := object{"state": "completed", "finalResponse": object{"type": "agentMessage", "text": "ARC_ONBOARDING_OK"}}
	valid := object{"deliveries": []any{object{"kind": "completed", "state": "delivered"}}}
	for _, step := range []struct {
		observed, delivery any
		want               bool
	}{
		{completed, nil, false}, {completed, object{"deliveries": []any{object{"state": "delivered"}}}, false},
		{object{"state": "running"}, valid, false}, {completed, valid, true},
	} {
		if setupLoopEvidence(step.observed, step.delivery, true)["complete"] != step.want {
			t.Fatalf("unexpected delivery result for %v", step)
		}
	}
	data["loop"] = setupLoopEvidence(completed, valid, true)
	if deriveSetup(state, data, "en")["complete"] != true {
		t.Fatal("verified loop remained incomplete")
	}
	ingress["url"] = "https://changed.example/mcp"
	assertSetupStep(t, state, data, "create-ingress")
}

func TestFixedSetupAddressWaitsForSavedCredential(t *testing.T) {
	// Algorithmic core: Fixed addresses require an explicit provider choice and the corresponding saved credential.
	state, data := setupScenario("claude-loop")
	choices := obj(state["choices"])
	choices["choose-address"] = "fixed"
	ingress := setupScenarioHTTPS()
	config := obj(ingress["config"])
	config["cloudflareMode"], ingress["running"] = "named", false
	data["ingresses"] = []any{ingress}
	assertSetupStep(t, state, data, "choose-provider")
	choices["choose-provider"] = "other-provider"
	step := obj(deriveSetup(state, data, "en")["step"])
	if step["kind"] != "secret" || step["openUrl"] != "agent-remote-control://ingress?id=existing&field=cloudflareToken" {
		t.Fatalf("unexpected fixed-address credential step: %v", step)
	}
	config["hasCloudflareToken"] = true
	assertSetupStep(t, state, data, "create-ingress")
	choices["choose-provider"], config["cloudflareAuth"] = "cloudflare", "login"
	assertSetupStep(t, state, data, "cloudflare-login")
	data["cloudflare"] = object{"hasOriginCert": true}
	assertSetupStep(t, state, data, "cloudflare-tunnel")
	config["configured"] = true
	assertSetupStep(t, state, data, "create-ingress")
}

func TestChatGPTSetupSeparatesCredentialMCPAndChallengeEvidence(t *testing.T) {
	// Algorithmic core: ChatGPT setup distinguishes saved credentials, an authenticated connection, MCP, and a successful challenge.
	state, data := setupScenario("chatgpt-chat")
	assertSetupStep(t, state, data, "tunnel-credentials")
	config := object{}
	ingress := object{"id": "default", "controlSource": "chatgpt", "transport": "openai-tunnel", "config": config}
	data["ingresses"] = []any{ingress}
	if field(deriveSetup(state, data, "en")["step"], "kind") != "remote-ui" {
		t.Fatal("tunnel setup did not ask for the tunnel ID first")
	}
	config["tunnelId"] = "tunnel"
	if field(deriveSetup(state, data, "en")["step"], "kind") != "secret" {
		t.Fatal("missing credential did not request the runtime key")
	}
	config["hasApiKey"] = true
	assertSetupStep(t, state, data, "create-ingress")
	ingress["running"], ingress["state"] = true, "ready"
	assertSetupStep(t, state, data, "create-ingress")
	for _, status := range []int{401, 403} {
		ingress["controlPlane"] = object{"state": "rejected", "httpStatus": status}
		result := deriveSetup(state, data, "en")
		if text(result["step"], "id") != "tunnel-credentials" || !strings.Contains(text(result["step"], "explain"), "401/403") ||
			text(result["fallback"], "kind") != "decide" || find(clone(ingressDiagnostics(ingress))["findings"], "code", "RUNTIME_KEY_REJECTED") == nil {
			t.Fatalf("unexpected rejected-credential step: %v", result)
		}
	}
	ingress["controlPlane"] = object{"state": "authenticated"}
	assertSetupStep(t, state, data, "enable-in-chatgpt")
	verification := object{"firstMcpRequestAt": "2026-10-17T00:01:00.000Z"}
	ingress["verification"] = verification
	assertSetupStep(t, state, data, "verify-connector")
	verification["challengeVerifiedAt"] = "2026-10-17T00:02:00.000Z"
	assertSetupStep(t, state, data, "loop-test")
	complete := func(reply string) object { return object{"state": "completed", "finalResponse": object{"text": reply}} }
	if setupLoopEvidence(complete("not the expected reply"), nil, false)["complete"] != false {
		t.Fatal("unverified reply completed the loop")
	}
	data["loop"] = setupLoopEvidence(complete("ARC_ONBOARDING_OK"), nil, false)
	if deriveSetup(state, data, "en")["complete"] != true {
		t.Fatal("confirmed response did not complete the loop")
	}
}

func TestSetupExplicitDecisionsAndLogin(t *testing.T) {
	// Algorithmic core: Setup choices and native login stay explicit independently of other readiness signals.
	state, data := setupScenario("claude-loop")
	assertSetupStep(t, object{"choices": object{}}, data, "choose-goal")
	login := obj(data["login"])
	login["state"] = "unauthenticated"
	assertSetupStep(t, state, data, "codex-ready")
	login["state"] = "authenticated"
	permissions := obj(data["permissions"])
	permissions["items"] = []any{}
	assertSetupStep(t, state, data, "claude-code-ready")
	choices := obj(state["choices"])
	choices["claude-code-ready"] = "skip"
	assertSetupStep(t, state, data, "permissions")
	disk, command := object{"id": "full-disk-access", "state": "granted"}, object{"id": "command-full-disk-access", "state": "missing"}
	permissions["items"] = []any{disk, command}
	assertSetupStep(t, state, data, "permissions")
	command["state"] = "not-applicable"
	assertSetupStep(t, state, data, "choose-address")
	disk["state"], choices["permissions"] = "missing", "skip"
	assertSetupStep(t, state, data, "choose-address")
	start := state["startedAt"]
	if err := chooseSetupGoal(&state, "claude-loop"); err != nil || state["startedAt"] != start {
		t.Fatalf("same goal reset the start time: %v", err)
	}
	if err := chooseSetupGoal(&state, "chatgpt-chat"); err != nil || wire(state["choices"]) != "{}" {
		t.Fatalf("new goal retained old choices: %v", err)
	}
}

func TestChatGPTSetupHTTPSFallback(t *testing.T) {
	// Algorithmic core: ChatGPT fallback uses HTTPS OAuth and completes without requiring Claude notification readiness.
	state, data := setupScenario("chatgpt-chat")
	choices := obj(state["choices"])
	choices["chatgpt-blocked"] = "platform-denied"
	assertSetupStep(t, state, data, "chatgpt-fallback")
	delete(choices, "chatgpt-blocked")
	choices["chatgpt-fallback"] = "https-oauth"
	assertSetupStep(t, state, data, "choose-address")
	choices["choose-address"] = "cf-quick"
	ingress := setupScenarioHTTPS()
	ingress["controlSource"] = "chatgpt"
	data["ingresses"] = []any{ingress}
	result := deriveSetup(state, data, "en")
	if text(result["step"], "id") != "add-connector" || text(result["step"], "openUrl") != "https://chatgpt.com/" ||
		find(result["steps"], "id", "claude-code-ready") != nil {
		t.Fatalf("unexpected fallback: %v", result)
	}
	data["oauth"] = object{"grants": []any{object{"id": "grant"}}}
	assertSetupStep(t, state, data, "verify-connector")
	obj(ingress["verification"])["challengeVerifiedAt"] = "2026-10-17T00:02:00.000Z"
	assertSetupStep(t, state, data, "loop-test")
	data["loop"] = object{"complete": true}
	if deriveSetup(state, data, "en")["complete"] != true {
		t.Fatal("verified loop remained incomplete")
	}
	choices["choose-address"], choices["choose-provider"] = "fixed", "cloudflare"
	assertSetupStep(t, state, data, "cloudflare-login")
	data["cloudflare"] = object{"hasOriginCert": true}
	assertSetupStep(t, state, data, "cloudflare-tunnel")
}
