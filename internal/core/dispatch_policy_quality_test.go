package core

import (
	"context"
	"os"
	"path/filepath"
	"slices"
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
	waiting := mk("waiting")
	for _, item := range []struct {
		row   object
		state turnOwnerState
	}{{running, turnActive}, {waiting, turnAwaitingInteraction}} {
		key := turnKey{"codex", "thread", text(item.row, "turnId")}
		item.row["_turnLifecycle"] = (turnTransition{key: key}).advance(turnEvidence{key: key, owner: turnOwner{1, item.state}}).checkpoint()
	}
	result := dispatchQualityHistory([]object{passed, external, unreviewed, running, waiting, mk("unconfirmed")}, "codex", at.Add(-time.Hour))
	if uintOr(result["executionUnknown"], 99) != 1 {
		t.Fatalf("confirmed live turn marked unknown: %v", result)
	}
	for _, c := range []struct {
		group, key string
		count      uint64
	}{
		{"laterUserFindings", "defects", 2}, {"externalReviews", "reviews", 1}, {"unreviewedCompletions", "count", 1}, {"stillRunning", "unconfirmed", 1},
		{"stillRunning", "count", 3}, {"reviewCoverage", "reviewed", 1}, {"reviewCoverage", "unreviewed", 4},
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
	directory := t.TempDir()
	for name, note := range map[string]string{"structured": "found-by: controller; defects: 2; advisory: 1", "prose": "Tests passed"} {
		saveKernelRow(t, filepath.Join(directory, name+".json"), object{
			"turnId": name, "review": object{"verdict": "pass", "note": note},
		})
	}
	costs := new(runtimeCostSet)
	ctx := withRuntimeCost(context.WithValue(t.Context(), runtimeCostKey{}, runtimeCostContext{set: costs}), "taskRead", "poll")
	read := func() []object {
		t.Helper()
		rows, err := readDispatchRowsInContext(ctx, directory)
		if err != nil || len(rows) != 2 {
			t.Fatalf("legacy records = %v, %v", rows, err)
		}
		return rows
	}
	initial := read()
	if costs.counter("taskRead").changed.Load() != 2 {
		t.Fatal("legacy import did not normalize exactly two records")
	}
	stamps := map[string]*fileStamp{}
	for _, row := range initial {
		name := text(row, "turnId")
		path := filepath.Join(directory, name+".json")
		persisted, err := load(path)
		if err != nil || wire(persisted) != wire(row) {
			t.Fatalf("normalization for %s was not persisted: %v, %v", name, persisted, err)
		}
		stamps[path], err = readStamp(path)
		if err != nil {
			t.Fatal(err)
		}
		review := row["review"]
		if uintOr(field(review, "qualityVersion"), 0) != 1 ||
			name == "structured" && (field(review, "foundBy") != "controller" || uintOr(field(review, "defects"), 0) != 2) ||
			name == "prose" && (field(review, "foundBy") != "unknown" || field(review, "defects") != nil) {
			t.Fatalf("legacy review = %v", review)
		}
	}
	read()
	parsed := costs.counter("taskRead").parsed.Load()
	for range 3 {
		if rows := read(); wire(rows) != wire(initial) {
			t.Fatalf("legacy rows changed: %v", rows)
		}
	}
	if cost := costs.counter("taskRead"); cost.changed.Load() != 2 || cost.parsed.Load() != parsed {
		t.Fatalf("warm reads changed %d records and parsed %d bytes total", cost.changed.Load(), cost.parsed.Load())
	}
	for path, stamp := range stamps {
		current, err := readStamp(path)
		if err != nil || !stampSame(stamp, current) {
			t.Fatalf("warm read replaced %s: %v", path, err)
		}
	}
}

func TestDispatchQualityLegacyTurnsAndReviewsKeepObservableCounts(t *testing.T) {
	// Contract: the dispatch quality view preserves unknown legacy triggers and defect counts.
	at := time.Now().UTC()
	row := func(turn string) object {
		return object{"agent": "codex", "threadId": "thread", "turnId": turn, "dispatchMode": "new-turn", "submittedAt": at.Format(time.RFC3339Nano)}
	}
	first, second, steer, retry, external := row("first"), row("second"), row("second"), row("retry"), row("external")
	steer["dispatchMode"], retry["dispatchSource"], external["dispatchOrigin"] = "steered", "native-retry", "external"
	second["review"] = object{"verdict": "rework", "qualityVersion": 1, "defects": 2, "foundBy": "user"}
	external["review"] = object{"verdict": "rework", "reviewedAt": at.Format(time.RFC3339Nano), "note": "Legacy note"}
	quality := summarizeDispatchHistory([]object{first, second, steer, retry, external}, "codex", false, at.Add(-30*24*time.Hour))["quality"]
	if wire(field(quality, "followUpTurnsByTrigger")) != wire(object{"counts": object{"unknown": 1}, "coverage": "unknown"}) ||
		wire(field(quality, "defectsByClass")) != wire(object{"counts": object{"unclassified": 2}, "unknownCounts": 1, "coverage": "unknown"}) {
		t.Fatalf("legacy quality attribution = %v", quality)
	}
}

func TestDispatchQualityDiskWindowKeepsNewestRowsAtCapacity(t *testing.T) {
	// Recurring bug class: persistence retained out-of-window files cannot displace recent quality rows or reopen on warm reads.
	base := t.TempDir()
	t.Setenv("ARC_STATE_DIR", base)
	at := time.Now().UTC()
	cutoff, old := at.Add(-30*24*time.Hour), at.Add(-60*24*time.Hour)
	first, last := filepath.Join(base, "dispatches", "old-thread"), filepath.Join(base, "dispatches", "new-thread")
	seed := func(folder, turn string, at time.Time) {
		t.Helper()
		timestamp := at.Format(time.RFC3339Nano)
		saveKernelRow(t, filepath.Join(folder, turn+".json"), object{"agent": "codex", "threadId": "thread", "turnId": turn,
			"dispatchMode": "new-turn", "submittedAt": timestamp, "terminal": object{"state": "completed", "endedAt": timestamp}})
	}
	for n := range dispatchHistoryLimit + 1 {
		turn := "old-" + strconv.Itoa(n)
		seed(first, turn, old)
		if err := os.Chtimes(filepath.Join(first, turn+".json"), old, old); err != nil {
			t.Fatal(err)
		}
	}
	seed(first, "recent-old-thread", at.Add(-29*24*time.Hour))
	seed(last, "newest-thread", at)
	seed(last, "updated-old", old)
	saveKernelRow(t, filepath.Join(base, "reviews", "old-thread", "external.json"), object{"agent": "codex", "threadId": "thread", "turnId": "external",
		"submittedAt": old.Format(time.RFC3339Nano), "dispatchOrigin": "external", "review": object{"verdict": "pass",
			"reviewedAt": at.Format(time.RFC3339Nano), "foundBy": "controller", "defects": 0, "advisory": 0, "qualityVersion": 1}})
	read := func() []object {
		t.Helper()
		rows, err := dispatchHistoryRows(t.Context(), cutoff)
		if err != nil {
			t.Fatal(err)
		}
		return rows
	}
	opens := uintOr(cacheDiagnostics()["fileOpens"], 0)
	selected := read()
	view := summarizeDispatchHistory(selected, "codex", false, cutoff)
	if len(selected) != 3 || view["coverage"] != "exact" || uintOr(cacheDiagnostics()["fileOpens"], 0)-opens != 4 ||
		uintOr(field(field(view["quality"], "reviewCoverage"), "unreviewed"), 0) != 2 ||
		uintOr(field(field(view["quality"], "externalReviews"), "reviews"), 0) != 1 {
		t.Fatalf("initial selected rows = %d, view = %v", len(selected), view)
	}
	for n := range dispatchHistoryLimit - 3 {
		seed(last, "current-"+strconv.Itoa(n), at.Add(-time.Duration(n+1)*time.Minute))
	}
	if rows := read(); len(rows) != dispatchHistoryLimit || summarizeDispatchHistory(rows, "codex", false, cutoff)["coverage"] != "exact" {
		t.Fatalf("exact capacity retained %d rows", len(rows))
	}
	seed(last, "latest", at.Add(time.Second))
	bounded := read()
	if len(bounded) != dispatchHistoryLimit+1 || bounded[0]["turnId"] != "latest" ||
		!slices.ContainsFunc(bounded[:dispatchHistoryLimit], func(v object) bool { return v["turnId"] == "newest-thread" }) ||
		slices.ContainsFunc(bounded[:dispatchHistoryLimit], func(v object) bool { return v["turnId"] == "recent-old-thread" }) ||
		summarizeDispatchHistory(bounded, "codex", false, cutoff)["coverage"] != "bounded" {
		t.Fatal("overflow did not keep the newest quality window")
	}
	warm := cacheDiagnostics()
	if rows := read(); wire(rows) != wire(bounded) || cacheDiagnostics()["fileOpens"] != warm["fileOpens"] ||
		cacheDiagnostics()["directoryReads"] != warm["directoryReads"] {
		t.Fatal("unchanged window triggered a file or directory reread")
	}
}

func TestDispatchHistoryPollsOpenOnlyChangedTurns(t *testing.T) {
	// Recurring bug class: persistence polling a dispatch view must reuse unchanged history and see externally replaced turns.
	directory := t.TempDir()
	for _, key := range []string{"before", "after"} {
		saveKernelRow(t, filepath.Join(directory, key+".json"), object{"turnId": key, "state": "completed"})
	}
	poll := func() []object {
		t.Helper()
		rows, err := readDispatchRows(directory)
		if err != nil || len(rows) != 2 {
			t.Fatalf("dispatch history = %v, %v", rows, err)
		}
		return rows
	}
	poll()
	initial := cacheDiagnostics()
	poll()
	warm := cacheDiagnostics()
	if warm["fileOpens"] != initial["fileOpens"] || warm["directoryReads"] != initial["directoryReads"] {
		t.Fatal("unchanged dispatch history reopened files or directories")
	}
	saveKernelRow(t, filepath.Join(directory, "before.json"), object{"turnId": "before", "state": "failed"})
	result := poll()
	if !slices.ContainsFunc(result, func(row object) bool { return row["turnId"] == "before" && row["state"] == "failed" }) {
		t.Fatalf("dispatch replacement was not visible: %v", result)
	}
	after := cacheDiagnostics()
	if uintOr(after["fileOpens"], 0) != uintOr(warm["fileOpens"], 0)+1 || after["directoryReads"] != warm["directoryReads"] {
		t.Fatal("one changed turn reopened unrelated history")
	}
}
