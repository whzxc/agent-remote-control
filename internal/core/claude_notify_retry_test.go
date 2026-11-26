package core

import "testing"

func TestOnlyProvenCapacityFailureRetriesWithoutTools(t *testing.T) {
	// Algorithmic core: Codex capacity retry admits only confirmed overloads without tool effects.
	turn := object{"status": "failed", "error": object{"codexErrorInfo": "serverOverloaded"}, "items": []any{object{"type": "userMessage"}, object{"type": "reasoning"}}}
	if !safeNotificationRetry(turn) {
		t.Fatal("confirmed capacity failure was ineligible")
	}
	for _, items := range []any{nil, []any{object{"type": "commandExecution", "status": "completed"}}} {
		turn["items"] = items
		if safeNotificationRetry(turn) {
			t.Fatalf("unsafe retry with items %v", items)
		}
	}
	for i, want := range []int64{30, 60, 120} {
		if got := notificationRetryBackoff(nil, uint64(i+1)); got != want {
			t.Fatalf("attempt %d: %d", i+1, got)
		}
	}
	if got := notificationRetryBackoff(object{"codexRetryInitialSeconds": 5}, 3); got != 20 {
		t.Fatalf("configured delay = %d", got)
	}
}
