package core

import (
	"fmt"
	"testing"
	"time"
)

func TestDispatchDecisionKeepsTierConflictsWithKnownHash(t *testing.T) {
	// Recurring bug class: persistence criteria and an incompatible tier override remain visible after cached reads.
	const criteria = "Pass `serviceTier` `default` on every create and send."
	for _, args := range []object{{}, {"view": "full"}, {"knownCriteriaHash": hash([]byte(criteria))}} {
		row := object{"agent": "codex", "policy": object{"criteria": criteria, "serviceTiers": object{"model-a": "priority", "model-b": "default"}}}
		result := presentDispatchDecision(object{"agents": []any{row}}, args)
		conflicts := arr(field(arr(result["agents"])[0], "policyMismatches"))
		if len(conflicts) != 1 || field(conflicts[0], "model") != "model-a" || field(conflicts[0], "criteriaServiceTier") != "default" ||
			field(conflicts[0], "overrideServiceTier") != "priority" || field(conflicts[0], "code") != "CRITERIA_SERVICE_TIER_MISMATCH" {
			t.Fatalf("tier conflicts = %v", conflicts)
		}
	}
}

func TestCompactDispatchHistoryBoundsGroupsWithoutDroppingCounts(t *testing.T) {
	// Algorithmic core: compact grouping preserves total dispatch counts while limiting configurations.
	at := time.Now()
	var records []object
	for model := range 9 {
		for turn := range 10 + model {
			records = append(records, object{"agent": "codex", "threadId": fmt.Sprintf("t%d", model), "turnId": fmt.Sprintf("u%d", turn),
				"model": fmt.Sprintf("m%d", model), "effort": "high", "dispatchMode": "new-turn", "submittedAt": at.Format(time.RFC3339Nano)})
		}
	}
	compact := summarizeDispatchHistory(records, "codex", true, at.Add(-time.Hour))
	groups := arr(compact["groups"])
	var count uint64
	for _, group := range groups {
		count += uintOr(field(group, "dispatches"), 0)
	}
	full := summarizeDispatchHistory(records, "codex", false, at.Add(-time.Hour))
	if len(groups) != 7 || count != uint64(len(records)) || len(arr(full["groups"])) != 9 {
		t.Fatalf("compact groups=%d count=%d, full=%v", len(groups), count, full["groups"])
	}
}

func TestDispatchDecisionPreservesGatewayQuotaAndConstraints(t *testing.T) {
	// Contract: decision quota preserves gateway pool identity, account counts and policy constraints.
	quota := object{"source": "local-gateway", "gateway": "magpie", "ordinaryUsageAllowed": true, "state": "ready",
		"pools": []any{object{"id": "codex", "accountsTotal": 3, "accountsWithRoom": 2, "accountsWithCredits": 1,
			"primary": object{"usedPercent": 34.3, "bestAccountUsedPercent": 0.0, "windowDurationMins": 10080}}}}
	facts := object{"agents": []any{object{"agent": "codex", "quota": quota,
		"availability": object{"installed": true, "enabled": true, "available": true},
		"policy":       object{"criteria": "Use current evidence.", "denyModels": []any{"denied"}}}}}
	got := presentDispatchDecision(clone(facts), object{})
	row := obj(arr(got["agents"])[0])
	pool := obj(arr(row["quota"])[0])
	if row["accounts"] != nil || wire(row["denyModels"]) != `["denied"]` || pool["source"] != "local-gateway" || pool["id"] != "codex/codex" ||
		uintOr(pool["accountsTotal"], 0) != 3 || uintOr(pool["accountsWithRoom"], 0) != 2 || wire(pool["bestAccountUsedPercent"]) != "0.0" {
		t.Fatalf("decision with quota = %v", got)
	}
	full := presentDispatchDecision(clone(facts), object{"view": "full"})
	if field(field(arr(full["agents"])[0], "quota"), "source") != "local-gateway" {
		t.Fatalf("full view quota = %v", full)
	}
}
