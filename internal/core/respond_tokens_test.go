package core

import (
	"testing"
	"time"
)

func TestRespondTokenSurvivesDesktopReattachment(t *testing.T) {
	// Recurring bug class: security response tokens survive Desktop reattachment while rejecting expiry, scope violations and reuse.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	request := object{"owner": "desktop", "id": "[desktop,thread,turn,question]", "backendSession": "old",
		"params": object{"threadId": "thread", "turnId": "turn"}}
	if err := issueRespondToken("controller", request); err != nil {
		t.Fatal(err)
	}
	token := text(request, "respondToken")
	request["backendSession"] = "new"
	if err := issueRespondToken("controller", request); err != nil || text(request, "respondToken") != token || len(token) != 22 {
		t.Fatalf("Desktop reattachment token = %v, %v", request["respondToken"], err)
	}
	ctx := withOrigin(t.Context(), object{"sourceId": "controller"})
	args := object{"respondToken": token, "threadId": "thread"}
	resolved, err := resolveRespondToken(ctx, args)
	if err != nil || resolved["backendSession"] != "old" {
		t.Fatalf("resolve token = %v, %v", resolved, err)
	}
	if _, err := resolveRespondToken(withOrigin(t.Context(), object{"sourceId": "other"}), args); err == nil || err.Error() != "RESPOND_TOKEN_SCOPE_MISMATCH" {
		t.Fatalf("wrong source resolved token: %v", err)
	}
	if _, err := resolveRespondToken(ctx, object{"respondToken": token, "threadId": "other"}); err == nil || err.Error() != "RESPOND_TOKEN_SCOPE_MISMATCH" {
		t.Fatalf("wrong thread resolved token: %v", err)
	}
	if err := consumeRespondToken(ctx, args); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveRespondToken(ctx, args); err == nil || err.Error() != "RESPOND_TOKEN_EXPIRED_OR_RESOLVED" {
		t.Fatalf("consumed token resolved again: %v", err)
	}
	request["id"] = "expired"
	dir := t.TempDir()
	if err := issueRespondTokenAt(dir, "controller", request, time.Now().Unix()-respondTokenTTL); err != nil {
		t.Fatal(err)
	}
	if _, _, err := resolveRespondTokenAt(dir, "controller", text(request, "respondToken"), nil, time.Now().Unix()); err == nil || err.Error() != "RESPOND_TOKEN_EXPIRED_OR_RESOLVED" {
		t.Fatalf("expired token resolved: %v", err)
	}
}
