package core

import (
	"testing"
	"time"
)

func TestNativeClaudeQuotaWindowsAndResets(t *testing.T) {
	// Recurring bug class: lifecycle Native Claude usage retains reported quota windows across its own login renewal.
	now := time.Date(2025, 12, 31, 23, 0, 0, 0, time.UTC)
	reading, failure := parseClaudeUsage("Current session: 13% used · resets 1am (UTC)\nCurrent week (all models): 4% used · resets Jan 3, 2pm (UTC)\nCurrent week (Sonnet): 9% used", now)
	resetIs := func(r *string, want string) bool { return r != nil && *r == want }
	if failure != nil || len(reading.windows) != 3 {
		t.Fatalf("unexpected usage response: %v %v", reading, failure)
	}
	w := reading.windows
	if w[0].UsedPercent != 13 || !resetIs(w[0].ResetsAt, "2026-01-01T01:00:00+00:00") ||
		!resetIs(w[1].ResetsAt, "2026-01-03T14:00:00+00:00") || !resetIs(w[2].Scope, "Sonnet") || w[2].ResetsAt != nil {
		t.Fatalf("unexpected usage windows: %v", w)
	}
	reading, failure = parseClaudeUsage("Current session: 13% used · resets 1:30AM (UTC)", now)
	if failure != nil || len(reading.windows) != 1 || !resetIs(reading.windows[0].ResetsAt, "2026-01-01T01:30:00+00:00") {
		t.Fatalf("minute precision was lost: %v %v", reading, failure)
	}
}

func TestNativeClaudeQuotaNoticeRemainsUnknown(t *testing.T) {
	// Recurring bug class: lifecycle A successful usage command can return a notice without any quota measurements.
	_, failure := parseClaudeUsage("You are currently using your subscription to power your Claude Code usage.", time.Now())
	if failure == nil || failure.Code != "no-limits-reported" {
		t.Fatalf("unexpected usage error: %v", failure)
	}
}
