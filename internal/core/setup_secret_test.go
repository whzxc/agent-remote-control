package core

import (
	"strings"
	"testing"
)

func TestSetupClipboardCredentialShapes(t *testing.T) {
	// Algorithmic core: Parse supported clipboard credentials and keep rejected input out of errors.
	key := "sk-" + strings.Repeat("a", 40)
	token := "eyJ" + strings.Repeat("a", 80)
	short := strings.Repeat("a", 24)
	for _, tc := range []struct{ field, input, want string }{
		{"apiKey", "OPENAI_API_KEY=" + key, key},
		{"cloudflareToken", "cloudflared service install " + token, token},
		{"ngrokAuthtoken", "ngrok config add-authtoken " + short, short},
		{"pinggyToken", "ssh " + short + "@a.pinggy.io", short},
		{"localxposeAccessToken", `{"token":"` + short + `"}`, short},
	} {
		if got, err := extractSetupSecret(tc.field, tc.input); err != nil || got != tc.want {
			t.Fatalf("%s: unexpected clipboard result: %v", tc.field, err)
		}
		for _, bad := range []string{"123456789", "sk-short", "eyJshort", "unrelated clipboard note"} {
			if _, err := extractSetupSecret(tc.field, bad); err == nil || strings.Contains(err.Error(), bad) {
				t.Fatalf("%s: credential was accepted or exposed", tc.field)
			}
		}
	}
	for _, field := range []string{"apiKey", "cloudflareToken"} {
		if _, err := extractSetupSecret(field, strings.Repeat("a", 80)); err == nil {
			t.Fatalf("%s: missing credential prefix was accepted", field)
		}
	}
}
