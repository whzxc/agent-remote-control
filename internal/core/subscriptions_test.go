package core

import (
	"testing"
	"time"
)

func TestClaudeSubscriptionFallsBackToEligibleProfile(t *testing.T) {
	// Contract: Missing native quota uses a signed-in profile and preserves its observed source.
	for _, code := range []string{"credentials-missing", "no-limits-reported"} {
		const observed = "2026-01-01T00:00:00.000Z"
		result, failure := resolveClaudeSubscription(subscriptionReading{}, subscriptionError(code), func() (subscriptionResolved, *subscriptionFailure, bool) {
			window, _ := newQuotaWindow("weekly", "subscription", "seven_day", 32, nil)
			reading, _ := subscriptionReadingFrom([]quotaWindow{window}, object{})
			return subscriptionResolved{reading, "claude-profile", observed}, nil, true
		})
		quota := profileSubscriptionQuota(result.reading, failure, result.observed)
		window := arr(quota["windows"])
		if failure != nil || result.source != "claude-profile" || quota["state"] != "ready" || quota["source"] != result.source ||
			len(window) != 1 || wire(field(window[0], "usedPercent")) != "32.0" || quota["observedAt"] != observed {
			t.Fatalf("unexpected fallback quota: %v", quota)
		}
	}
}

func TestOldSubscriptionWindowsExpireOnProviderErrors(t *testing.T) {
	// Recurring bug class: persistence Expired allowance windows without a reset time disappear during prolonged provider errors.
	at := time.Now()
	observed := subscriptionTimestamp(at.Add(-23 * time.Hour))
	window, _ := newQuotaWindow("weekly", "subscription", "seven_day", 23, nil)
	view := subscriptionProviderSnapshot{ProviderID: "claude-code", State: "stale", ObservedAt: &observed,
		Windows: []quotaWindow{window}, DisplayWindowID: &window.ID, Error: subscriptionError("request-failed")}
	if expireSubscriptionView(&view, at) || len(view.Windows) != 1 {
		t.Fatal("a recent reading expired")
	}
	if !expireSubscriptionView(&view, at.Add(time.Hour)) || len(view.Windows) != 0 || view.DisplayWindowID != nil || view.State != "unavailable" ||
		view.Error.Code != "request-failed" {
		t.Fatalf("unexpected expired provider: %v", view)
	}
	if subscriptionProviderInterval("antigravity", 3) != 10*time.Minute || subscriptionProviderInterval("antigravity", 15) != 15*time.Minute ||
		subscriptionProviderInterval("codex", 3) != 3*time.Minute {
		t.Fatal("provider refresh interval changed")
	}
}
