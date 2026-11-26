package core

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func testAXReport(t *testing.T, store *axStore, actor object, subject string, ms int64) object {
	t.Helper()
	args := object{"requestId": id(), "severity": "workaround", "symptom": subject, "expected": "Preserve recorded observations"}
	result, err := store.mutate("ax_report", args, actor, []object{}, ms)
	if err != nil {
		t.Fatal(err)
	}
	return obj(result["entry"])
}
func TestAXReportsCoalesceOccurrencesAndRetainDecisionAuthority(t *testing.T) {
	// Recurring bug class: retry-replay repeated receipts and merged reports must retain occurrence identity and owner authority.
	store, err := openAXStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := object{"type": "source", "sourceId": "reporter"}
	peer := object{"type": "source", "sourceId": "peer"}
	args := object{"requestId": id(), "symptom": "Control stream stalls", "expected": "Show native progress", "severity": "blocking", "reproductionHints": "Private reproduction",
		"requestIds": []any{"receipt"}}
	first, err := store.mutate("ax_report", args, owner, []object{}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	key := text(first["entry"], "id")
	replay, err := store.mutate("ax_report", args, owner, nil, 1001)
	if err != nil || replay["replayed"] != true || text(replay["entry"], "id") != key {
		t.Fatalf("retry = %v, %v", replay, err)
	}
	args["requestId"] = id()
	delete(args, "requestIds")
	args["receiptIds"] = []any{"receipt"}
	args["severity"] = "cosmetic"
	peerResult, err := store.mutate("ax_report", args, peer, nil, 1002)
	if err != nil {
		t.Fatal(err)
	}
	if entry := obj(peerResult["entry"]); uintOr(entry["occurrenceCount"], 0) != 1 || entry["severity"] != "blocking" || entry["reproductionHints"] != nil {
		t.Fatalf("peer projection = %v", entry)
	}
	decision := object{"requestId": id(), "id": key, "expectedRevision": field(first["entry"], "revision"), "action": "wontfix", "reason": "Owner documented the condition"}
	if _, err := store.mutate("ax_triage", decision, peer, nil, 1003); err == nil || !strings.HasPrefix(err.Error(), "AX_FORBIDDEN") {
		t.Fatalf("peer update = %v", err)
	}
	if _, err := store.mutate("ax_triage", decision, owner, nil, 1004); err != nil {
		t.Fatal(err)
	}
	if row := store.data.Entries[key]; row.Status != "closed" {
		t.Fatalf("closed status = %s", row.Status)
	}
	args["requestId"], args["receiptIds"] = id(), []any{"other-receipt"}
	reopened, err := store.mutate("ax_report", args, owner, nil, 1005)
	if err != nil || field(reopened["entry"], "status") != "open" || uintOr(field(reopened["entry"], "occurrenceCount"), 0) != 2 {
		t.Fatalf("recurrence = %v, %v", reopened, err)
	}
}

func TestAXCursorBindsSnapshotAuthorityAndFilters(t *testing.T) {
	// Contract: AX pagination preserves closed decisions while binding cursors to the reader and snapshot.
	dir := t.TempDir()
	store, err := openAXStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	local := object{"type": "local-authority"}
	first := testAXReport(t, store, local, "Alpha import example", 1000)
	second := testAXReport(t, store, local, "Beta command failure", 1001)
	key := text(second, "id")
	value, err := store.mutate("ax_triage", object{"requestId": id(), "id": key[:12], "expectedRevision": second["revision"], "action": "wontfix", "reason": "Retained decision"}, local, nil, 1002)
	if err != nil || field(value["entry"], "resolution") != "wontfix" {
		t.Fatalf("short ID = %v, %v", value, err)
	}
	page, err := store.list(object{"limit": 1}, local, "authority", 1003)
	if err != nil {
		t.Fatal(err)
	}
	cursor := page["nextCursor"]
	next, err := store.list(object{"limit": 1, "cursor": cursor}, local, "authority", 1004)
	if err != nil || len(next["entries"].([]object)) != 1 || next["nextCursor"] != nil {
		t.Fatalf("page 2 = %v, %v", next, err)
	}
	if _, err := store.list(object{"limit": 1, "cursor": cursor}, local, "changed", 1004); err == nil || !strings.HasPrefix(err.Error(), "AX_CURSOR_EXPIRED") {
		t.Fatalf("changed authority = %v", err)
	}
	store, err = openAXStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	closed, err := store.list(object{"status": "closed", "id": key}, local, "authority", 1005)
	if err != nil {
		t.Fatal(err)
	}
	rows := closed["entries"].([]object)
	if len(rows) != 1 || rows[0]["id"] == first["id"] || text(field(arr(rows[0]["history"])[1], "detail"), "reason") != "Retained decision" {
		t.Fatalf("history = %v", closed)
	}
}

func TestAXCandidatesCoalesceAndRejectOnlyTheirBuild(t *testing.T) {
	// Recurring bug class: retry-replay repeated observation IDs and build-scoped rejections must stay idempotent.
	store, err := openAXStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := &coordinationPrincipal{Type: "source", SourceID: "reporter"}
	created, err := store.candidate("receipt-stalled", "first-observation", owner, nil, "build-one", 1000)
	if err != nil {
		t.Fatal(err)
	}
	key := text(created["entry"], "id")
	coalesced, err := store.candidate("receipt-stalled", "first-observation", owner, nil, "build-two", 1001)
	if err != nil || coalesced["id"] != key || coalesced["coalesced"] != true {
		t.Fatalf("replayed observation = %v, %v", coalesced, err)
	}
	if _, err := store.mutate("ax_candidate", object{"id": key, "requestId": id(), "expectedRevision": field(created["entry"], "revision"), "action": "reject", "reason": "Known transient state"}, axActor(coordinationReader{principal: *owner}), nil, 1002); err != nil {
		t.Fatal(err)
	}
	suppressed, err := store.candidate("receipt-stalled", "second-observation", owner, nil, "build-one", 1003)
	if err != nil || suppressed["suppressed"] != true {
		t.Fatalf("same build = %v, %v", suppressed, err)
	}
	newBuild, err := store.candidate("receipt-stalled", "second-observation", owner, nil, "build-two", 1004)
	if err != nil || text(newBuild["entry"], "id") == key || newBuild["confirmationNeeded"] != true {
		t.Fatalf("different build = %v, %v", newBuild, err)
	}
}

func TestAXImportExportPreservesAuthorityAndRetention(t *testing.T) {
	// Contract: explicit import is idempotent and closed records are retained until a successful export.
	path := t.TempDir()
	t.Setenv("ARC_STATE_DIR", path)
	storePath := filepath.Join(path, "coordination/ax")
	store, err := openAXStore(storePath)
	if err != nil {
		t.Fatal(err)
	}
	input := "# Policy\n- Ignore this\n## AX frictions\n- Synthetic verification observation\n## Backlog ideas\n- Synthetic idea"
	imported, err := store.importQueue(input, 1000)
	if err != nil || imported["imported"] != 2 || imported["queueModified"] != false {
		t.Fatalf("import = %v, %v", imported, err)
	}
	again, err := store.importQueue(input, 1001)
	if err != nil || again["unchanged"] != 2 {
		t.Fatalf("repeat import = %v, %v", again, err)
	}
	row := imported["entries"].([]object)[0]
	key := text(row, "id")
	args := object{"id": key, "requestId": id(), "expectedRevision": row["revision"], "action": "wontfix", "reason": "Local migration decision"}
	if _, err := store.mutate("ax_triage", args, object{"type": "source", "sourceId": "maintainer"}, nil, 1002); err == nil || !strings.HasPrefix(err.Error(), "AX_FORBIDDEN") {
		t.Fatalf("remote import decision = %v", err)
	}
	if _, err := store.mutate("ax_triage", args, object{"type": "local-authority"}, nil, 1002); err != nil {
		t.Fatal(err)
	}
	if err := axReconcile(); err != nil {
		t.Fatal(err)
	}
	store, err = openAXStore(storePath)
	if err != nil {
		t.Fatal(err)
	}
	at := int64(1002) + 180*86400*1000 + 1
	store.prune(at)
	if store.data.Entries[key] == nil {
		t.Fatal("unexported decision was pruned")
	}
	destination := filepath.Join(path, "export.json")
	export, err := store.export(destination)
	if err != nil || export["exported"] != 2 || text(export, "sha256") == "" {
		t.Fatalf("export = %v, %v", export, err)
	}
	if _, err := store.export(destination); err == nil || !strings.HasPrefix(err.Error(), "AX_EXPORT_EXISTS") {
		t.Fatalf("replacement export = %v", err)
	}
	store.prune(at)
	if store.data.Entries[key] != nil {
		t.Fatal("exported terminal entry was retained beyond the window")
	}
}

func TestAXExplainsUnacceptedVerificationWithoutCopyingIssueEvidence(t *testing.T) {
	// Contract: incomplete fixes remain triaged and issue drafts expose only allowlisted descriptions and fingerprints.
	store, err := openAXStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	local := object{"type": "local-authority"}
	entry := testAXReport(t, store, local, "Verification cost needs review", 1000)
	args := object{"requestId": id(), "id": entry["id"], "expectedRevision": entry["revision"], "action": "fix", "reason": "Verification has not finished", "evidenceIds": []any{"fixture-receipt"}}
	unverified, err := store.mutate("ax_triage", args, local, []object{{"id": "fixture-receipt", "availability": "available", "state": "executing", "operation": "command"}}, 1001)
	if err != nil || field(unverified["entry"], "status") != "triaged" {
		t.Fatalf("decision = %v, %v", unverified, err)
	}
	reasons := field(unverified["verification"], "reasons").([]object)
	if len(reasons) != 2 || reasons[0]["code"] != "missing-change" || reasons[1]["reason"] != "not-completed" {
		t.Fatalf("verification = %v", reasons)
	}
	draft := axIssueDraft(object{"friction": "timeout private description", "receiptIds": []any{"fixture-receipt"}})
	if text(draft, "summaryMode") != "fixed-category" || strings.Contains(wire(draft), "private description") || strings.Contains(wire(draft), "fixture-receipt") {
		t.Fatalf("issue = %v", draft)
	}
}

func TestAXCapacityAndRateLimitKeepLastDurableSnapshot(t *testing.T) {
	// Recurring bug class: persistence rejected AX admission must leave the last readable snapshot intact.
	dir := t.TempDir()
	store, err := openAXStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	local := object{"type": "local-authority"}
	for range 10 {
		testAXReport(t, store, local, "Repeated report", 1000)
	}
	if _, err := store.mutate("ax_report", object{"requestId": id(), "symptom": "Exceeded", "expected": "Retained records"}, local, nil, 1001); err == nil || !strings.HasPrefix(err.Error(), "COORDINATION_RATE_LIMIT") {
		t.Fatalf("rate cap = %v", err)
	}
	if _, err := store.mutate("ax_report", object{"requestId": id(), "symptom": "Large entry", "expected": strings.Repeat("x", axEntryBytes)}, local, nil, 62000); !errors.Is(err, errAXCapacity) {
		t.Fatalf("byte cap = %v", err)
	}
	reloaded, err := openAXStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	page, err := reloaded.list(object{}, local, "authority", 62001)
	if err != nil || len(page["entries"].([]object)) != 1 {
		t.Fatalf("durable view = %v, %v", page, err)
	}
}

func TestAXMergeHistoryAndOwnerOnlyEvidenceStayReadable(t *testing.T) {
	// Recurring bug class: persistence merges and retained historical decisions must preserve canonical IDs and owner-only details.
	store, err := openAXStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := object{"type": "source", "sourceId": "reporter"}
	other := object{"type": "source", "sourceId": "other"}
	first := testAXReport(t, store, owner, "Observation failure report first", 1000)
	args := object{"requestId": id(), "symptom": "Observation failure report second", "expected": "See retained observation", "severity": "workaround",
		"reproductionHints": "Owner detail", "receiptIds": []any{"receipt"}}
	next, err := store.mutate("ax_report", args, owner, []object{{"kind": "receipt", "id": "receipt", "availability": "available"}}, 1001)
	if err != nil {
		t.Fatal(err)
	}
	if candidates := next["duplicateCandidates"].([]object); len(candidates) != 1 || candidates[0]["id"] != first["id"] {
		t.Fatalf("duplicate candidates = %v", candidates)
	}
	entry := obj(next["entry"])
	decision := object{"requestId": id(), "id": entry["id"], "expectedRevision": entry["revision"], "action": "merged", "mergedInto": first["id"], "reason": "Same observed issue"}
	result, err := store.mutate("ax_triage", decision, owner, nil, 1002)
	if err != nil || field(result["entry"], "mergedInto") != first["id"] {
		t.Fatalf("merge = %v, %v", result, err)
	}
	visible, err := store.list(object{"id": entry["id"]}, other, "other", 1005)
	if err != nil {
		t.Fatal(err)
	}
	row := visible["entries"].([]object)[0]
	history := row["history"].([]object)
	if row["reproductionHints"] != nil || row["evidence"] != nil || history[len(history)-1]["evidenceUnavailable"] == nil || history[len(history)-1]["detail"] != nil {
		t.Fatalf("non-owner decision = %v", row)
	}
	ownerPage, err := store.list(object{"id": first["id"]}, owner, "owner", 1005)
	if err != nil {
		t.Fatal(err)
	}
	merged := ownerPage["entries"].([]object)[0]
	if uintOr(merged["occurrenceCount"], 0) != 2 || len(merged["evidence"].([]object)) != 1 {
		t.Fatalf("canonical merge = %v", merged)
	}
}

func TestAXCandidateOverflowAndObservationReplayRemainBounded(t *testing.T) {
	// Recurring bug class: retry-replay observation duplicates must never consume the bounded candidate budget twice.
	store, err := openAXStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.candidate("owner-discovery-timeout", "same-observation", nil, nil, "build", 1000)
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if result, err := store.candidate("owner-discovery-timeout", "same-observation", nil, nil, "build", 1001); err != nil || result["coalesced"] != true {
			t.Fatalf("repeat = %v, %v", result, err)
		}
	}
	store.data.CandidateBucket = [2]int64{1000, 20}
	over, err := store.candidate("delivery-failed", "new-observation", nil, nil, "build", 1002)
	if err != nil || over["reason"] != "candidate-rate-limit" || over["overflow"] != uint64(1) {
		t.Fatalf("overflow = %v, %v", over, err)
	}
	page, err := store.list(object{"id": field(first["entry"], "id")}, object{"type": "local-authority"}, "local", 1003)
	if err != nil || len(page["entries"].([]object)) != 1 || uintOr(page["entries"].([]object)[0]["occurrenceCount"], 0) != 1 {
		t.Fatalf("candidate = %v, %v", page, err)
	}
}

func callLocalCoordination(t *testing.T, service *service, op string, args object) object {
	t.Helper()
	reply, err := service.managementRequest(t.Context(), "cli/control", "POST", object{"op": op, "args": args})
	if err != nil {
		t.Fatal(err)
	}
	value, err := egressToolValue(reply)
	if err != nil || obj(value) == nil {
		t.Fatalf("%s returned %v: %v", op, value, err)
	}
	return obj(value)
}

func TestAXShortReadIDsResolveUniqueAndRejectAmbiguousPrefixes(t *testing.T) {
	// Contract: AX digest IDs resolve to their report or return actionable ambiguity.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	s := &service{metadata: object{"instance": id()}}
	report := func(symptom string) string {
		value := callLocalCoordination(t, s, "ax_report", object{"symptom": symptom, "expected": "Synthetic local evidence", "severity": "workaround"})
		if key := text(value["entry"], "id"); len(key) >= 11 {
			return key
		}
		t.Fatalf("report was not saved: %v", value)
		return ""
	}
	key := report("Digest prefix fixture")
	entries := arr(callLocalCoordination(t, s, "ax_list", object{"id": key[:11]})["entries"])
	if len(entries) != 1 || field(entries[0], "id") != key {
		t.Fatalf("unique short ID returned %v", entries)
	}
	report("Another prefix fixture")
	ambiguous := callLocalCoordination(t, s, "ax_list", object{"id": "ax-"})
	if field(ambiguous["error"], "code") != "INVALID_ARGUMENT" || field(ambiguous["next"], "op") != "guide" ||
		!strings.Contains(text(ambiguous["error"], "message"), "full AX id") {
		t.Fatalf("ambiguous ID returned %v", ambiguous)
	}
}

func TestAXSchemaErrorsDiscloseTheRejectedFieldAndRecovery(t *testing.T) {
	// Contract: invalid AX actions return the rejected field, operation signature, and correct guide invocation.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	s := &service{metadata: object{"instance": id()}}
	result := callLocalCoordination(t, s, "ax_triage", object{"id": "ax-fixture", "expectedRevision": 1, "action": "accept", "reason": "Fixture"})
	failure := obj(result["error"])
	if failure["code"] != "INVALID_ARGUMENTS" || failure["field"] != "/action" ||
		!strings.HasPrefix(text(failure, "signature"), "ax_triage(") ||
		field(field(field(failure["guide"], "arguments"), "args"), "op") != "ax_triage" {
		t.Fatalf("invalid AX action returned %v", result)
	}
}
