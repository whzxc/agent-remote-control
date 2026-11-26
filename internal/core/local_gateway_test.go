package core

import (
	"strings"
	"testing"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

func TestGatewayLoopbackOrigin(t *testing.T) {
	// Contract: Gateway reads resolve only loopback HTTP origins.
	for input, expected := range map[string]string{
		"http://127.0.0.1:3425/backend-api/codex": "http://127.0.0.1:3425",
		"http://localhost:8080/v1":                "http://localhost:8080",
		"https://127.0.0.1:3425":                  "",
		"http://example.com:3425/v1":              "",
		"not-a-url":                               "",
	} {
		if got := gatewayLoopbackOrigin(input); got != expected {
			t.Errorf("%q => %q, want %q", input, got, expected)
		}
	}
}

func TestGatewayOriginFromNativeCodexConfig(t *testing.T) {
	// Contract: A native Codex config selects a gateway only when its base URL targets loopback.
	for input, expected := range map[string]string{
		"model = \"auto/gpt-6.2-sol\"\nopenai_base_url = \"http://127.0.0.1:3425/backend-api/codex\"": "http://127.0.0.1:3425",
		"model = \"gpt-6.2-sol\"":                         "",
		"openai_base_url = \"https://api.openai.com/v1\"": "",
	} {
		if got := codexConfiguredGateway([]byte(input)); got != expected {
			t.Errorf("origin = %q, want %q", got, expected)
		}
	}
}

func TestGatewayQuotaAggregation(t *testing.T) {
	// Algorithmic core: Combine ordinary allowance and credits across accounts without identity disclosure.
	var body object
	if err := canonjson.Unmarshal([]byte(`{"data":[
		{"provider":"codex","plan":"promax","user":"primary@example.com","balance":"38941.48 credits","windows":[{"name":"7 days","used":100,"resetsAt":"2026-11-20T19:18:21Z"},{"name":"Image generation","used":0,"text":true,"lane":"images"}]},
		{"provider":"codex","plan":"prolite","user":"spare1@example.com","windows":[{"name":"7 days","used":3,"resetsAt":"2026-11-23T02:40:10Z"}]},
		{"provider":"codex","plan":"prolite","user":"spare2@example.com","windows":[{"name":"7 days","used":0,"resetsAt":"2026-11-23T10:03:05Z"}]}
	]}`), &body); err != nil {
		t.Fatal(err)
	}
	reading, dispatch := aggregateGatewayQuotas(body, "codex")
	if len(reading.windows) != 1 || reading.windows[0].Label != "weekly" || reading.windows[0].UsedPercent != 34.3 ||
		reading.accountBlocked == nil || *reading.accountBlocked || dispatch["ordinaryUsageAllowed"] != true {
		t.Fatalf("unexpected gateway quota: %v, %v", reading, dispatch)
	}
	pool := arr(dispatch["pools"])[0]
	if field(pool, "accountsTotal") != 3 || field(pool, "accountsWithRoom") != 2 || field(pool, "accountsWithCredits") != 1 ||
		field(field(pool, "primary"), "bestAccountUsedPercent") != 0.0 || strings.Contains(wire(dispatch), "example.com") {
		t.Fatalf("unexpected pool data: %v", dispatch)
	}
}

func TestGatewayTurnUsageAggregation(t *testing.T) {
	// Algorithmic core: Count eligible calls by native session and turn time bounds.
	var body object
	if err := canonjson.Unmarshal([]byte(`{"rows":[
		{"t":"2026-11-19T18:04:05Z","native_session":"thread-1","provider":"codex","served":"gpt-6.2-sol","in":900,"out":50,"cache_read":10000,"reasoning":10,"ms":4000,"cost":0.02,"priced":true,"session_role":"main"},
		{"t":"2026-11-19T18:04:10Z","native_session":"thread-1","provider":"codex","served":"gpt-6.2-sol","in":300,"out":200,"cache_read":20000,"reasoning":40,"ms":6000,"cost":0.03,"priced":true,"session_role":"main"},
		{"t":"2026-11-19T18:04:12Z","native_session":"thread-1","in":1500,"kind":"composer_predictions","session_role":"unknown","cost":0.04,"priced":true},
		{"t":"2026-11-19T18:09:00Z","native_session":"thread-1","in":9999,"session_role":"main"}
	]}`), &body); err != nil {
		t.Fatal(err)
	}
	usage := aggregateGatewayTurnUsage(body, "thread-1", "2026-11-19T18:04:00Z", "2026-11-19T18:04:20Z")
	for key, expected := range map[string]uint64{"calls": 2, "inputTokens": 1200, "outputTokens": 250, "cacheReadTokens": 30000, "reasoningTokens": 50, "durationMs": 10000} {
		if usage[key] != expected {
			t.Errorf("%s = %v, want %d", key, usage[key], expected)
		}
	}
	if usage["costUsd"] != 0.05 || wire(usage["servedModels"]) != `["gpt-6.2-sol"]` {
		t.Fatalf("unexpected usage: %v", usage)
	}
}
