package core

import "testing"

func TestReclaimChildOwnerAndProcessIdentity(t *testing.T) {
	// Recurring bug class: lifecycle startup reclaims stranded children while preserving processes with reused PIDs.
	record := object{"pid": 3, "processStart": "child", "owner": object{"pid": 2, "processStart": "core"}}
	for _, tc := range []struct {
		child, owner string
		reclaim      bool
	}{
		{"child", "", true}, {"child", "reused-core", true}, {"child", "core", false}, {"reused-child", "", false}, {"", "", false},
	} {
		if got := reclaimableChild(record, tc.child, tc.owner); got != tc.reclaim {
			t.Errorf("%q/%q: got reclaim=%v, want %v", tc.child, tc.owner, got, tc.reclaim)
		}
	}
}
