package core

import (
	"strings"
	"testing"
	"time"
)

func TestDurationAndAbsoluteLogBoundaries(t *testing.T) {
	// Recurring bug class: persistence retained log queries accept relative duration and absolute cursors.
	now := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	for input, millis := range map[string]int64{"2m": 120000, "1ms": 1, "3s": 3000, "1h": 3600000, "1d": 86400000, "0s": 0, "2026-01-02T01:00:00+01:00": 0} {
		got, err := parseLogSince(input, now)
		if err != nil || now.Sub(got).Milliseconds() != millis {
			t.Errorf("since %q: %s (%v), want %d ms", input, got, err, millis)
		}
	}
	for _, input := range []string{"2", "-2m", "1.5h", "m", "99999999999999999999d"} {
		if _, err := parseLogSince(input, now); err == nil || !strings.HasPrefix(err.Error(), "INVALID_ARGUMENT:") {
			t.Errorf("since %q: %v", input, err)
		}
	}
}
