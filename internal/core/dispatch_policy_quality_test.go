package core

import (
	"strconv"
	"testing"
	"time"
)

func TestDispatchQualityStructuredCountsAndLegacyPrefix(t *testing.T) {
	// Algorithmic core: only explicit structured counts and the legacy anchored prefix establish review findings.
	cases := []struct {
		record            object
		legacy            bool
		by                string
		defects, advisory any
	}{
		{object{"note": "found-by: ci; defects: 2; advisory: 1; examples"}, true, "automation", uint64(2), uint64(1)},
		{object{"note": "Observed found-by: ci; defects: 2; advisory: 1"}, true, "unknown", nil, nil},
		{object{"foundBy": "reviewer", "defectClasses": object{"lifecycle": 1, "persistence": 2}, "advisory": 0}, false, "reviewer", uint64(3), 0},
		{object{"verdict": "pass"}, false, "unknown", 0, nil},
	}
	for _, c := range cases {
		normalizeDispatchReview(c.record, c.legacy)
		if c.record["foundBy"] != c.by || c.record["defects"] != c.defects || c.record["advisory"] != c.advisory {
			t.Fatalf("quality observation = %v", c.record)
		}
	}
}

func TestDispatchDefectClassCountsRequireValidSum(t *testing.T) {
	// Contract: malformed defect class totals return the review schema's owned field error.
	args := object{"defects": 3, "defectClasses": object{"lifecycle": 1, "persistence": 2.0}}
	if err := validateDispatchDefectClasses("codex_review", args); err != nil {
		t.Fatal(err)
	}
	for _, classes := range []object{{"lifecycle": 2}, {"lifecycle": ^uint64(0), "concurrency": 1}} {
		args["defectClasses"] = classes
		err := validateDispatchDefectClasses("codex_review", args)
		if err == nil || controlFailure(err)["field"] != "/defectClasses" {
			t.Fatalf("review conflict = %v", err)
		}
	}
}

func TestDispatchQualitySeparatesNativeAndReviewerEvidence(t *testing.T) {
	// Contract: outcome, gate coverage, and later user or external reviews retain their separate counters.
	at := time.Now()
	mk := func(turn string) object {
		return object{"threadId": "thread", "turnId": turn, "submittedAt": at.Format(time.RFC3339Nano), "dispatchMode": "new-turn"}
	}
	passed := mk("passed")
	passed["terminal"] = object{"state": "completed"}
	passed["review"] = object{"qualityVersion": 1, "verdict": "pass", "foundBy": "acceptance", "defects": 0, "advisory": 0}
	passed["reviewObservations"] = []any{object{"qualityVersion": 1, "verdict": "rework", "foundBy": "user", "defects": 2, "advisory": 0}}
	external := mk("external")
	external["dispatchOrigin"] = "external"
	external["review"] = object{"qualityVersion": 1, "reviewedAt": at.Format(time.RFC3339Nano), "verdict": "rework", "defects": 1}
	unreviewed := mk("unreviewed")
	unreviewed["terminal"] = object{"state": "completed"}
	running := mk("running")
	result := dispatchQualityHistory([]object{passed, external, unreviewed, running}, "codex", at.Add(-time.Hour))
	for _, c := range []struct {
		group, key string
		count      uint64
	}{
		{"laterUserFindings", "defects", 2}, {"externalReviews", "reviews", 1}, {"unreviewedCompletions", "count", 1}, {"stillRunning", "unconfirmed", 1},
		{"reviewCoverage", "reviewed", 1}, {"reviewCoverage", "unreviewed", 2},
	} {
		if actual := uintOr(field(result[c.group], c.key), 99); actual != c.count {
			t.Fatalf("%s.%s = %d; result %v", c.group, c.key, actual, result)
		}
	}
}

func TestDispatchQualityHistoryReportsUnknownAndOverflow(t *testing.T) {
	// Algorithmic core: exceeding the retained review window bounds coverage without treating unknown evidence as exact.
	at := time.Now()
	rows := make([]object, dispatchHistoryLimit+1)
	for i := range rows {
		rows[i] = object{"threadId": "thread", "turnId": strconv.Itoa(i), "submittedAt": at.Format(time.RFC3339Nano), "dispatchMode": "new-turn"}
	}
	result := dispatchQualityHistory(rows, "codex", at.Add(-time.Hour))
	if result["coverage"] != "bounded" || uintOr(field(result["reviewCoverage"], "unreviewed"), 0) != dispatchHistoryLimit {
		t.Fatalf("bounded quality = %v", result)
	}
	delete(rows[0], "submittedAt")
	result = dispatchQualityHistory(rows[:1], "codex", at.Add(-time.Hour))
	if result["coverage"] != "unknown" || uintOr(result["historyUnknownRows"], 0) != 1 {
		t.Fatalf("unknown quality = %v", result)
	}
}

func TestDispatchQualityLegacyReviewDoesNotChangeWithRepeatedReads(t *testing.T) {
	// Recurring bug class: persistence a legacy review was repeatedly imported and changed on read.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	thread, request := id(), id()
	err := recordDispatch(object{"agent": "codex", "threadId": thread, "turnId": "turn", "requestId": request, "dispatchMode": "new-turn",
		"task": object{"dispatch": object{"review": object{"verdict": "pass", "note": "found-by: ci; defects: 0; advisory: 1"}}}})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		rows, err := dispatchReviews(thread)
		if err != nil || len(rows) != 1 {
			t.Fatalf("reviews = %v, %v", rows, err)
		}
		review := field(rows[0], "review")
		if field(review, "foundBy") != "automation" || uintOr(field(review, "qualityVersion"), 0) != 1 || uintOr(field(review, "advisory"), 0) != 1 {
			t.Fatalf("legacy review = %v", review)
		}
	}
}
