package core

import "testing"

func TestCursorMergedIncludedUsageWindow(t *testing.T) {
	// Recurring bug class: persistence Merged Cursor allowance retains the reported billing period and reset.
	usage := object{"billingCycleEnd": "1800000000000"}
	quota := object{"totalPercentUsed": 12.5, "autoPercentUsed": 12.5, "apiPercentUsed": 0}
	for _, period := range []struct {
		raw   any
		label string
	}{
		{"INCLUDED_USAGE_PERIOD_WEEKLY", "weekly"}, {2, "weekly"},
		{"INCLUDED_USAGE_PERIOD_MONTHLY", "monthly"}, {1, "monthly"},
	} {
		plan := object{"isMerged": true, "planInfo": object{"includedUsagePeriod": period.raw}}
		windows := parseCursorUsage(quota, usage, plan, "totalSpend")
		if len(windows) != 1 || windows[0].PoolID != "cursorModels" || windows[0].Label != period.label ||
			windows[0].UsedPercent != 12.5 || windows[0].ResetsAt == nil || *windows[0].ResetsAt != "2027-01-15T08:00:00+00:00" {
			t.Fatalf("unexpected %s usage: %v", period.label, windows)
		}
	}
}
