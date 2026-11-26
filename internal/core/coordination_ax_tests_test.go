package core

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	blocking, err := store.mutate("ax_report", object{"requestId": id(), "severity": "blocking", "symptom": "Alpha import example", "expected": "Preserve evidence"}, local, nil, 1000)
	if err != nil {
		t.Fatal(err)
	}
	first := obj(blocking["entry"])
	second := testAXReport(t, store, local, "Beta command failure", 1001)
	key := text(second, "id")
	value, err := store.mutate("ax_triage", object{"requestId": id(), "id": key[:12], "expectedRevision": second["revision"], "action": "wontfix", "reason": "Retained decision"}, local, nil, 1002)
	if err != nil || field(value["entry"], "resolution") != "wontfix" {
		t.Fatalf("short ID = %v, %v", value, err)
	}
	page, err := store.list(object{"limit": 1}, local, "authority", 1003)
	if err != nil || page["triageDue"] != true {
		t.Fatalf("triage page = %v, %v", page, err)
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
	filtered, err := store.list(object{"severity": "blocking", "state": "open"}, local, "authority", 1005)
	if err != nil || len(filtered["entries"].([]object)) != 1 || filtered["entries"].([]object)[0]["id"] != first["id"] {
		t.Fatalf("blocking filter = %v, %v", filtered, err)
	}
	future, err := store.list(object{"since": "2099-01-01T00:00:00Z"}, local, "authority", 1005)
	if err != nil || len(future["entries"].([]object)) != 0 {
		t.Fatalf("future filter = %v, %v", future, err)
	}
	testAXReport(t, store, local, "Changed AX snapshot", 1006)
	if _, err := store.list(object{"limit": 1, "cursor": cursor}, local, "authority", 1006); err == nil || !strings.HasPrefix(err.Error(), "AX_CURSOR_EXPIRED") {
		t.Fatalf("changed snapshot accepted old cursor: %v", err)
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
	closed, err := store.list(object{"state": "closed"}, object{"type": "local-authority"}, "fixture", at)
	if err != nil || len(closed["entries"].([]object)) != 0 {
		t.Fatalf("retained exported terminal = %v, %v", closed, err)
	}
	open := imported["entries"].([]object)[1]
	retained, err := store.list(object{"id": open["id"]}, object{"type": "local-authority"}, "fixture", at)
	if err != nil || len(retained["entries"].([]object)) != 1 || retained["entries"].([]object)[0]["status"] != "open" {
		t.Fatalf("open import was pruned: %v, %v", retained, err)
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
	stale := object{"requestId": id(), "id": first["id"], "expectedRevision": first["revision"], "action": "wontfix", "reason": "Stale decision"}
	if _, err := store.mutate("ax_triage", stale, owner, nil, 1006); err == nil || !strings.HasPrefix(err.Error(), "AX_REVISION_CONFLICT:") {
		t.Fatalf("stale merge target revision = %v", err)
	}
	stale["requestId"], stale["expectedRevision"], stale["action"], stale["mergedInto"] = id(), merged["revision"], "merged", entry["id"]
	if _, err := store.mutate("ax_triage", stale, owner, nil, 1006); err == nil || !strings.HasPrefix(err.Error(), "AX_MERGE_CYCLE:") {
		t.Fatalf("reverse merge = %v", err)
	}
	delete(args, "receiptIds")
	args["requestId"] = id()
	recurrence, err := store.mutate("ax_report", args, owner, nil, 1007)
	if err != nil || field(recurrence["entry"], "id") != first["id"] || uintOr(field(recurrence["entry"], "occurrenceCount"), 0) != 3 {
		t.Fatalf("redirected recurrence = %v, %v", recurrence, err)
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
	for _, op := range []string{"ax_report", "ax_list", "ax_candidate", "ax_triage"} {
		spec := operation(op)
		mode, tool := "receipt", "act"
		if op == "ax_list" {
			mode, tool = "read-only", "query"
		}
		if via(spec) != tool || retryContract(spec)["mode"] != mode {
			t.Fatalf("%s contract = %s, %v", op, via(spec), retryContract(spec))
		}
		if err := axValidate(op, obj(spec["example"])); err != nil {
			t.Fatalf("%s example = %v", op, err)
		}
		for _, fieldName := range []string{"source", "arcVersion"} {
			args := clone(obj(spec["example"]))
			args[fieldName] = "caller-supplied"
			denied := callLocalCoordination(t, s, op, args)
			if field(denied["error"], "code") != "INVALID_ARGUMENTS" || field(denied["error"], "field") != "/"+fieldName {
				t.Fatalf("%s accepted caller %s: %v", op, fieldName, denied)
			}
		}
	}
	report := object{"symptom": "Fixture AX idea", "expected": "Store an observation"}
	if denied := callLocalCoordination(t, s, "ax_report", report); field(denied["error"], "code") != "INVALID_ARGUMENTS" {
		t.Fatalf("friction without severity = %v", denied)
	}
	report["kind"] = "idea"
	if result := callLocalCoordination(t, s, "ax_report", report); field(result["entry"], "kind") != "idea" {
		t.Fatalf("idea without severity = %v", result)
	}

}

func TestAXCandidateAcrossSourcesConfirmsWithShortIDAndKeepsOccurrences(t *testing.T) {
	// Recurring bug class: retry-replay independent source evidence and repeated observations share one candidate across builds.
	dir := t.TempDir()
	store, err := openAXStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	one := &coordinationPrincipal{Type: "source", SourceID: "one"}
	two := &coordinationPrincipal{Type: "source", SourceID: "two"}
	observe := func(observation, build string, principal *coordinationPrincipal, at int64) object {
		t.Helper()
		result, err := store.candidate("receipt-stalled", observation, principal, nil, build, at)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	first := obj(observe("first", "build-a", one, 1000)["entry"])
	second := obj(observe("second", "build-b", two, 1001)["entry"])
	key := text(first, "id")
	if second["id"] != key || uintOr(second["occurrenceCount"], 0) != 2 {
		t.Fatalf("cross-source candidate = %v", second)
	}
	args := object{"id": key[:11], "requestId": id(), "expectedRevision": second["revision"], "action": "confirm", "reason": "Checked observation"}
	if _, err := store.mutate("ax_candidate", args, axActor(coordinationReader{principal: *two}), nil, 1002); err == nil || !strings.HasPrefix(err.Error(), "AX_FORBIDDEN:") {
		t.Fatalf("foreign confirmation = %v", err)
	}
	confirmed, err := store.mutate("ax_candidate", args, axActor(coordinationReader{principal: *one}), nil, 1003)
	if err != nil || field(confirmed["entry"], "status") != "open" || field(confirmed["entry"], "id") != key {
		t.Fatalf("short candidate confirmation = %v, %v", confirmed, err)
	}
	third := obj(observe("third", "build-c", one, 1004)["entry"])
	if third["id"] != key || uintOr(third["occurrenceCount"], 0) != 3 {
		t.Fatalf("confirmed occurrence = %v", third)
	}
	store, err = openAXStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if again := observe("third", "build-d", one, 700000); again["coalesced"] != true || again["id"] != key {
		t.Fatalf("restart repeated observation = %v", again)
	}
	local := object{"type": "local-authority"}
	other := testAXReport(t, store, local, "Other short ID fixture", 700001)
	args["id"], args["requestId"] = "ax-", id()
	_, err = store.mutate("ax_candidate", args, local, nil, 700002)
	if err == nil || !strings.Contains(err.Error(), key) || !strings.Contains(err.Error(), text(other, "id")) {
		t.Fatalf("ambiguous write recovery = %v", err)
	}
}

func TestAXImportedQueueKeepsReportedFixAndLocalRecovery(t *testing.T) {
	// Contract: importing a report preserves its provisional evidence and exposes executable local authority recovery.
	state := t.TempDir()
	t.Setenv("ARC_STATE_DIR", state)
	directory := filepath.Join(state, "coordination", "ax")
	store, err := openAXStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	const input = "# Fixture queue\nPolicy:\n- Skip policy\n## Backlog ideas\n- Add a compact summary\n## AX frictions\n- Sample did not persist; reported fixed\n## Follow-ups\n- Review the timeout"
	at := time.Now().UnixMilli()
	if result, err := store.importQueue("", at); err != nil || result["imported"] != 0 {
		t.Fatalf("empty import = %v, %v", result, err)
	}
	if result, err := store.importQueue(input, at); err != nil || result["imported"] != 3 {
		t.Fatalf("first import = %v, %v", result, err)
	}
	store, err = openAXStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := store.importQueue(input, at)
	if err != nil || replay["imported"] != 0 || replay["unchanged"] != 3 {
		t.Fatalf("replayed import = %v, %v", replay, err)
	}
	var fixed object
	for _, row := range replay["entries"].([]object) {
		if strings.Contains(text(row, "symptom"), "reported fixed") {
			fixed = row
		}
		if row["firstSeenAt"] != nil || row["arcVersion"] != nil || row["kind"] == "idea" && uintOr(row["occurrenceCount"], 99) != 0 {
			t.Fatalf("import fabricated observation evidence: %v", row)
		}
	}
	if fixed["status"] != "open" || !strings.Contains(wire(fixed["evidence"]), "reported fixed") {
		t.Fatalf("reported fix = %v", fixed)
	}
	if result, err := store.importQueue(input+"\n- Additional follow-up\nPolicy:\n- Skip policy", at+1); err != nil || result["imported"] != 1 {
		t.Fatalf("incremental import = %v, %v", result, err)
	}
	candidate, err := store.candidate("receipt-stalled", "fresh-stall", nil, nil, "new-build", at+2)
	if err != nil || field(candidate["entry"], "status") != "candidate" || field(candidate["entry"], "id") == fixed["id"] {
		t.Fatalf("unrelated candidate = %v, %v", candidate, err)
	}
	args := object{"id": fixed["id"], "expectedRevision": fixed["revision"], "action": "wontfix", "reason": "Local fixture decision", "requestId": id()}
	_, err = store.mutate("ax_triage", args, object{"type": "source", "sourceId": "peer"}, nil, at+3)
	if err == nil || !strings.HasPrefix(err.Error(), "AX_FORBIDDEN:") {
		t.Fatalf("remote import decision = %v", err)
	}
	next := obj(axFailure(err, "ax_triage", args)["next"])
	if next["command"] != "arc cli control ax_triage --stdin" {
		t.Fatalf("denied recovery = %v", next)
	}
	s := &service{metadata: object{"instance": id()}}
	if result := callLocalCoordination(t, s, "ax_triage", obj(next["stdin"])); field(result["entry"], "status") != "closed" {
		t.Fatalf("local recovery = %v", result)
	}
	page := callLocalCoordination(t, s, "events", object{"kinds": []any{"ax.created", "ax.changed"}})
	for _, kind := range []string{"ax.created", "ax.changed"} {
		if find(page["events"], "kind", kind) == nil {
			t.Fatalf("missing AX journal event %s: %v", kind, page)
		}
	}
}

func TestAXLegacyHistoryRecoveryReadsLocalDecision(t *testing.T) {
	// Recurring bug class: persistence history distinguishes missing legacy reasons from restricted owner details.
	state := t.TempDir()
	t.Setenv("ARC_STATE_DIR", state)
	store, err := openAXStore(filepath.Join(state, "coordination", "ax"))
	if err != nil {
		t.Fatal(err)
	}
	owner := object{"type": "source", "sourceId": "owner"}
	at := time.Now().UnixMilli()
	row := testAXReport(t, store, owner, "Legacy decision fixture", at)
	args := object{"id": row["id"], "expectedRevision": row["revision"], "action": "wontfix", "reason": "Fixture decision", "requestId": id()}
	closed, err := store.mutate("ax_triage", args, owner, nil, at+1)
	if err != nil {
		t.Fatal(err)
	}
	args["action"], args["expectedRevision"], args["requestId"] = "reopen", field(closed["entry"], "revision"), id()
	delete(args, "reason")
	if _, err := store.mutate("ax_triage", args, owner, nil, at+2); err != nil {
		t.Fatal(err)
	}
	visible, err := store.list(object{"id": row["id"]}, object{"type": "source", "sourceId": "foreign"}, "foreign", at+3)
	if err != nil {
		t.Fatal(err)
	}
	history := visible["entries"].([]object)[0]["history"].([]object)
	next := obj(field(history[len(history)-1]["evidenceUnavailable"], "next"))
	if next["command"] != "arc cli control ax_list --stdin" || history[len(history)-1]["detail"] != nil {
		t.Fatalf("restricted history = %v", history)
	}
	s := &service{metadata: object{"instance": id()}}
	local := callLocalCoordination(t, s, "ax_list", obj(next["stdin"]))
	entries := arr(local["entries"])
	if len(entries) != 1 {
		t.Fatalf("local recovery = %v", local)
	}
	historyRows := arr(field(entries[0], "history"))
	if len(historyRows) != 3 || field(field(historyRows[1], "detail"), "reason") != "Fixture decision" ||
		field(historyRows[1], "reasonUnavailable") != nil || text(historyRows[2], "reasonUnavailable") == "" {
		t.Fatalf("local history = %v", historyRows)
	}
}

func TestAXReceiptObserverReplayAfterConfirmationKeepsOneOccurrence(t *testing.T) {
	// Contract: a replayed receipt-stall transition cannot add occurrences to a confirmed AX entry.
	state := t.TempDir()
	t.Setenv("ARC_STATE_DIR", state)
	at := time.Now().UnixMilli()
	row := object{"requestId": "stalled-receipt", "state": "reserved", "operation": "command", "backendSession": "current",
		"updatedAt": coordinationTimestamp(at - 30000), "origin": object{"sourceId": "one", "accountId": "account-one"}}
	buildup := coordinationReceiptObserver{waiting: map[string]bool{}, failed: map[string]bool{}, invalid: map[string]bool{}}
	if !buildup.observe(filepath.Join(state, "receipt"), row, "current", "host:fixture", at) {
		t.Fatal("stalled receipt was rejected")
	}
	var revision any
	for pass := range 2 {
		// A fresh checkpoint replays the persisted owner descriptor through the downstream projection.
		projectStalledReceipt(t, state, filepath.Join(t.TempDir(), "checkpoint.json"), row)
		store, err := openAXStore(filepath.Join(state, "coordination", "ax"))
		if err != nil {
			t.Fatal(err)
		}
		local := object{"type": "local-authority"}
		page, err := store.list(object{}, local, "fixture", at+int64(pass)*660000)
		if err != nil {
			t.Fatal(err)
		}
		rows := page["entries"].([]object)
		if len(rows) != 1 || uintOr(rows[0]["occurrenceCount"], 0) != 1 {
			t.Fatalf("receipt-stall replay = %v", page)
		}
		if pass == 0 {
			args := object{"id": rows[0]["id"], "expectedRevision": rows[0]["revision"], "requestId": id(), "action": "confirm", "reason": "Checked receipt"}
			confirmed, err := store.mutate("ax_candidate", args, local, nil, at+1)
			if err != nil {
				t.Fatal(err)
			}
			revision = field(confirmed["entry"], "revision")
		} else if rows[0]["status"] != "open" || rows[0]["revision"] != revision {
			t.Fatalf("confirmed candidate advanced after replay: %v", rows[0])
		}
	}
}

func TestAXRejectedVerificationOffersRunnableReadback(t *testing.T) {
	// Recurring bug class: retry-replay rejected fix or documentation verification retains the same actionable recovery across reopen.
	for _, action := range []string{"fix", "document"} {
		t.Run(action, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("ARC_STATE_DIR", dir)
			path := filepath.Join(dir, "coordination", "ax")
			store, err := openAXStore(path)
			if err != nil {
				t.Fatal(err)
			}
			local := object{"type": "local-authority"}
			s := &service{metadata: object{"instance": id()}}
			at := time.Now().UnixMilli()
			entry := testAXReport(t, store, local, "Verification follow-up", at)
			change := "commit"
			if action == "document" {
				change = "document"
			}
			args := object{"id": entry["id"], "requestId": id(), "expectedRevision": entry["revision"], "action": action, "reason": "Verify decision"}
			missing, err := store.mutate("ax_triage", args, local, nil, at+1)
			if err != nil || field(missing["entry"], "status") != "triaged" ||
				wire(field(missing["verification"], "reasons")) != wire([]object{{"code": "missing-change", "field": change}, {"code": "no-evidence"}}) {
				t.Fatalf("missing verification = %v, %v", missing, err)
			}
			args["requestId"], args["expectedRevision"], args[change] = id(), field(missing["entry"], "revision"), "change-reference"
			args["evidenceIds"] = []any{"unavailable", "unfinished", "unsupported"}
			facts := []object{{"id": "unavailable", "availability": "unavailable"},
				{"id": "unfinished", "availability": "available", "state": "running", "operation": "command"},
				{"id": "unsupported", "availability": "available", "state": "completed", "operation": "ax_triage"}}
			rejected, err := store.mutate("ax_triage", args, local, facts, at+2)
			if err != nil || field(rejected["entry"], "status") != "triaged" {
				t.Fatalf("rejected verification = %v, %v", rejected, err)
			}
			reasons := field(rejected["verification"], "reasons").([]object)
			if len(reasons) != 3 || reasons[0]["reason"] != "unavailable" || reasons[1]["reason"] != "not-completed" || reasons[2]["reason"] != "unsupported-operation" {
				t.Fatalf("rejection reasons = %v", reasons)
			}
			store, err = openAXStore(path)
			if err != nil {
				t.Fatal(err)
			}
			replay, err := store.mutate("ax_triage", args, local, nil, at+3)
			if err != nil || wire(replay["verification"]) != wire(rejected["verification"]) || wire(replay["next"]) != wire(rejected["next"]) {
				t.Fatalf("replayed rejection = %v, %v", replay, err)
			}
			next := obj(replay["next"])
			fresh := callLocalCoordination(t, s, text(next, "op"), obj(next["args"]))
			rows := arr(fresh["entries"])
			if len(rows) != 1 || field(rows[0], "id") != entry["id"] {
				t.Fatalf("verification recovery = %v", fresh)
			}
			args["requestId"], args["expectedRevision"], args["evidenceIds"] = id(), field(rows[0], "revision"), []any{"completed"}
			closed, err := store.mutate("ax_triage", args, local, []object{{"id": "completed", "availability": "available", "state": "completed", "operation": "command"}}, at+4)
			if err != nil || field(closed["entry"], "status") != "closed" || field(closed["entry"], "resolution") != action || closed["verification"] != nil {
				t.Fatalf("accepted verification = %v, %v", closed, err)
			}
		})
	}
}
