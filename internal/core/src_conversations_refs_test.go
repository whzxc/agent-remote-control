package core

import "testing"

func TestSourceConversationReferencesCanonicalizeIdentity(t *testing.T) {
	// Algorithmic core: canonical website references retain only the allowed origin and conversation identity.
	const chat = "https://claude.ai/chat/550e8400-e29b-41d4-a716-446655440000"
	if got := text(srcURLReference(chat+"?example=discard#discard"), "url"); got != chat {
		t.Fatalf("canonical chat = %s", got)
	}
	for _, raw := range []string{
		"http://claude.ai/new", "https://claude.ai.example/new", "https://user:pass@claude.ai/new",
		"https://claude.ai:444/new", "https://claude.ai/chat/invalid", chat + "?example=discard", chat + "#",
	} {
		if got := srcOpenURL(raw); got != "" {
			t.Fatalf("allowed %q as %q", raw, got)
		}
	}
	if !srcSessionExpired("https://claude.ai/login?example=discard") || srcSessionExpired("https://claude.ai/login-other") {
		t.Fatal("login path recognition expanded beyond exact path segments")
	}
	if got := srcNotifyReference("session_010000000000000000000001"); got["id"] != "cse_010000000000000000000001" ||
		srcNotifyReference("session_incomplete") != nil {
		t.Fatalf("session target has incorrect reference: %v", got)
	}
}
