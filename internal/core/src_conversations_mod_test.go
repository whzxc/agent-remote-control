package core

import "testing"

func TestSourceConversationCorrelationRequiresFreshOpenChat(t *testing.T) {
	// Algorithmic core: late, future, closed or non-Chat observations cannot attribute a dispatch.
	chat := srcURLReference("https://claude.ai/chat/550e8400-e29b-41d4-a716-446655440000")
	if correlatedSRC(chat, true, 1000, 400, 1000) == nil {
		t.Fatal("fresh open chat did not correlate")
	}
	for _, check := range []struct {
		open         bool
		seen, active int64
	}{{false, 1000, 1000}, {true, 997, 1000}, {true, 1000, 399}, {true, 1001, 1000}, {true, 1000, 1001}} {
		if got := correlatedSRC(chat, check.open, check.seen, check.active, 1000); got != nil {
			t.Fatalf("stale or closed chat correlated: %v", got)
		}
	}
	for _, invalid := range []object{nil, srcFixtureTarget()} {
		if got := correlatedSRC(invalid, true, 1000, 1000, 1000); got != nil {
			t.Fatalf("non-Chat reference correlated: %v", got)
		}
	}
}
