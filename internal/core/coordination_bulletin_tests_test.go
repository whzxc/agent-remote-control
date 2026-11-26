package core

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func fixtureBulletin(t *testing.T) (*bulletinStore, bulletinClock, coordinationReader) {
	t.Helper()
	store, err := openBulletinStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	return store, bulletinClock{utc: 1000, elapsed: 1000, certain: true}, coordinationReader{coordinationPrincipal{Type: "local-authority"}, "authority"}
}
func writeBulletin(t *testing.T, store *bulletinStore, op string, args object, reader coordinationReader, clock bulletinClock) object {
	t.Helper()
	if args["requestId"] == nil {
		args["requestId"] = id()
	}
	result, err := store.mutate(op, args, reader, []bulletinLink{}, nil, clock)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestBulletinRetainsOwnerRevisionReplayAndClearance(t *testing.T) {
	// Contract: bulletin admits exactly one record per request and retains revisioned notices, blockers and evidence.
	store, clock, local := fixtureBulletin(t)
	noticeArgs := object{"resources": []any{"app:installed"}, "intent": "Inspect installed fixture", "requestId": id()}
	notice := writeBulletin(t, store, "notice_post", noticeArgs, local, clock)
	replayed := writeBulletin(t, store, "notice_post", noticeArgs, local, clock)
	key := text(notice["notice"], "id")
	if text(replayed["notice"], "id") != key {
		t.Fatalf("replayed notice = %v", replayed)
	}
	noticeArgs["intent"] = "Changed at retry"
	if _, err := store.mutate("notice_post", noticeArgs, local, nil, nil, clock); err == nil || !strings.HasPrefix(err.Error(), "REQUEST_ID_CONFLICT") {
		t.Fatalf("changed retry = %v", err)
	}
	updated := writeBulletin(t, store, "notice_update", object{"id": key, "expectedRevision": 1, "intent": "Read native evidence"}, local, clock)
	if uintOr(field(updated["notice"], "revision"), 0) != 2 {
		t.Fatalf("revision = %v", updated)
	}
	peer := coordinationReader{coordinationPrincipal{Type: "source", SourceID: "peer"}, "peer"}
	if _, err := store.mutate("notice_update", object{"id": key, "requestId": id(), "expectedRevision": 2, "intent": "Peer mutation"}, peer, nil, nil, clock); err == nil || !strings.HasPrefix(err.Error(), "COORDINATION_OWNER_REQUIRED") {
		t.Fatalf("peer mutation = %v", err)
	}
	if _, err := store.mutate("notice_update", object{"id": key, "requestId": id(), "expectedRevision": 1, "intent": "Old revision"}, local, nil, nil, clock); err == nil || !strings.HasPrefix(err.Error(), "COORDINATION_REVISION_CONFLICT") {
		t.Fatalf("stale revision = %v", err)
	}
	blocker := writeBulletin(t, store, "blocker_open", object{"resources": []any{"app:installed"}, "causeCode": "inspection", "summary": "Synthetic blocker"}, local, clock)
	if conflicts := blocker["conflicts"].([]object); len(conflicts) != 1 || conflicts[0]["noticeId"] != key {
		t.Fatalf("advisory = %v", conflicts)
	}
	blockerID := text(blocker["blocker"], "id")
	cleared := writeBulletin(t, store, "blocker_clear", object{"id": blockerID, "expectedRevision": 1, "reason": "Verified recovery", "evidenceIds": []any{"receipt"}, "suggestedNextStep": "inspect"}, local, clock)
	if field(cleared["recoverySelection"], "automaticResume") != false {
		t.Fatalf("recovery = %v", cleared)
	}
	writeBulletin(t, store, "notice_close", object{"id": key, "reason": "Completed synthetic scope"}, local, clock)
	reopened, err := openBulletinStore(store.path)
	if err != nil {
		t.Fatal(err)
	}
	live, err := reopened.board(object{"view": "full"}, local, clock)
	if err != nil || len(live["notices"].([]object))+len(live["blockers"].([]object)) != 0 {
		t.Fatalf("live board = %v, %v", live, err)
	}
	history, err := reopened.board(object{"view": "full", "id": blockerID}, local, clock)
	if err != nil {
		t.Fatal(err)
	}
	row := history["blockers"].([]object)[0]
	if row["state"] != "cleared" || strPtrValue(row["reason"]) != "Verified recovery" || !slices.Equal(row["evidenceIds"].([]string), []string{"receipt"}) {
		t.Fatalf("history = %v", row)
	}
}

func TestBulletinReadAttachesOwnerScopedAttentionAndCursors(t *testing.T) {
	// Contract: the board presents only reader-owned edit affordances and validates snapshot-scoped paging.
	store, clock, local := fixtureBulletin(t)
	peer := coordinationReader{coordinationPrincipal{Type: "source", SourceID: "peer"}, "peer"}
	writeBulletin(t, store, "blocker_open", object{"resources": []any{"app:installed"}, "causeCode": "inspection", "summary": "Peer blocker"}, peer, clock)
	writeBulletin(t, store, "notice_post", object{"resources": []any{"app:installed"}, "intent": "Local notice"}, local, clock)
	page, err := store.board(object{"limit": 1, "view": "full"}, local, clock)
	if err != nil || page["nextCursor"] == nil || page["notices"].([]object)[0]["mine"] != true {
		t.Fatalf("first page = %v, %v", page, err)
	}
	if _, err := store.board(object{"limit": 1, "view": "full", "cursor": page["nextCursor"]}, peer, clock); !errors.Is(err, errBulletinCursor) {
		t.Fatalf("authority changed = %v", err)
	}
	next, err := store.board(object{"limit": 1, "view": "full", "cursor": page["nextCursor"]}, local, clock)
	if err != nil || next["nextCursor"] != nil || next["blockers"].([]object)[0]["mine"] != nil {
		t.Fatalf("second page = %v, %v", next, err)
	}
	if attention := store.attention(peer); len(attention) != 1 || attention[0]["ownerSourceId"] != "peer" {
		t.Fatalf("peer attention = %v", attention)
	}
	if attention := store.attention(coordinationReader{principal: coordinationPrincipal{Type: "source", SourceID: "other"}}); len(attention) != 0 {
		t.Fatalf("unrelated attention = %v", attention)
	}
	problems := object{"problems": []any{object{"id": "one", "sourceId": "peer", "target": "fixture", "reason": "needs-binding", "next": object{"op": "message_route"}}, object{"id": "two", "sourceId": "other"}}}
	items := bulletinNotificationItems(problems, peer)
	if len(items) != 1 || items[0]["ownerSourceId"] != "peer" || field(items[0]["next"], "op") != "message_route" {
		t.Fatalf("notification attention = %v", items)
	}
}

func TestBulletinInactivityRevocationAndClockDiscontinuity(t *testing.T) {
	// Recurring bug class: lifecycle retained ownership, clock gaps and lagging leases cannot fabricate activity or change terminal advice.
	store, clock, _ := fixtureBulletin(t)
	peer := coordinationReader{coordinationPrincipal{Type: "source", SourceID: "peer"}, "peer"}
	for _, spec := range []struct {
		name, key string
		args      object
	}{
		{"notice_post", "notice", object{"intent": "Peer work"}},
		{"blocker_open", "blocker", object{"causeCode": "verification", "summary": "Peer condition"}},
	} {
		spec.args["resources"] = []any{"app:installed"}
		writeBulletin(t, store, spec.name, spec.args, peer, clock)
	}
	cost := new(runtimeCost)
	gap := bulletinClock{utc: 1000 + bulletinInactiveMS, elapsed: 1000 + bulletinInactiveMS, certain: false}
	if err := store.maintain(gap, nil, cost); err != nil {
		t.Fatal(err)
	}
	if row := store.state.Notices[0].project(gap, false); row["state"] != "active" || row["activityCoverage"] != "clock-uncertain" {
		t.Fatalf("clock gap = %v", row)
	}
	stale := gap
	stale.certain = true
	if err := store.maintain(stale, nil, cost); err != nil {
		t.Fatal(err)
	}
	if store.state.Notices[0].State != "withdrawn" || store.state.Blockers[0].State != "stale" {
		t.Fatal("inactive records were not projected")
	}
	if err := store.maintain(stale, []string{"peer"}, cost); err != nil {
		t.Fatal(err)
	}
	if store.state.Blockers[0].State != "uncertain" {
		t.Fatalf("revoked blocker = %v", store.state.Blockers[0])
	}
}

func TestBulletinAdmissionUsesCanonicalResourcesAndReadbackOnly(t *testing.T) {
	// Contract: dispatch advisory uses unique registered repository identity and refreshes only current conflict metadata.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	registry := object{"projects": []any{object{"id": "registered", "name": "project label", "roots": []any{object{"path": "/repo", "commonDir": "/repo/.git"}}}}, "observedAt": now()}
	baseline := object{"root": "/repo", "commonDir": "/repo/.git", "ref": "refs/heads/wt/lane"}
	got := coordinationAssociateDispatch(baseline, registry)
	if !slices.Equal(got["resources"].([]string), []string{"lane:registered/lane"}) {
		t.Fatalf("lane association = %v", got)
	}
	if resolved, err := canonicalCoordinationResource("lane:project label/lane", registry); err != nil || resolved != "lane:registered/lane" {
		t.Fatalf("canon = %s, %v", resolved, err)
	}
	obj(arr(registry["projects"])[0])["id"] = "new-id"
	registry["projects"] = append(arr(registry["projects"]), object{"id": "second", "roots": []any{object{"path": "/repo"}}})
	if got := coordinationAssociateDispatch(baseline, registry); got["project"] != "ambiguous" || len(got["resources"].([]string)) != 0 {
		t.Fatalf("uncertain project = %v", got)
	}
	receipt := object{"requestId": "held-dispatch", "coordination": object{"association": object{"resources": []any{"app:installed"}}, "admissionBoardRevision": object{"revision": 1}}}
	refreshCoordinationDispatchAdvisory(t.Context(), receipt)
	if field(receipt["coordination"], "freshness") != "refreshed" || uintOr(field(field(receipt["coordination"], "admissionBoardRevision"), "revision"), 0) != 1 || receipt["requestId"] != "held-dispatch" {
		t.Fatalf("replay = %v", receipt)
	}
}

func TestBulletinSessionRouteBindingSurvivesRestartAndUnbind(t *testing.T) {
	// Recurring bug class: persistence the current session route generation survives replay and changes only on rebind.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	principal := coordinationPrincipal{Type: "source", SourceID: "peer"}
	route := &coordinationRoute{SourceID: "peer", RouteID: "target", Generation: "generation"}
	clock := currentBulletinClock()
	session, err := withBulletinStore(func(store *bulletinStore) (object, error) {
		args := object{"action": "register", "requestId": id()}
		reader := coordinationReader{principal: principal}
		value, err := store.mutate("coordination_session", args, reader, []bulletinLink{}, &coordinationRouteOutcome{route, "resolved"}, clock)
		return obj(value["session"]), err
	})
	if err != nil {
		t.Fatal(err)
	}
	key := text(session, "id")
	initial, err := coordinationSessionRoutes("peer")
	if err != nil || len(initial) != 1 || initial[0].Route.BindingID == nil {
		t.Fatalf("registration = %v, %v", initial, err)
	}
	if err := bindCoordinationRoute("peer", key, route); err != nil {
		t.Fatal(err)
	}
	current, err := coordinationSessionRoutes("peer")
	if err != nil || !sameCoordinationRoute(current[0].Route, initial[0].Route) {
		t.Fatalf("same route changed = %v, %v", current, err)
	}
	if err := bindCoordinationRoute("peer", key, nil); err != nil {
		t.Fatal(err)
	}
	if err := bindCoordinationRoute("peer", key, route); err != nil {
		t.Fatal(err)
	}
	reopened, err := openBulletinStore(filepath.Join(root(), "coordination/state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if sameCoordinationRoute(reopened.state.Sessions[0].Route, initial[0].Route) {
		t.Fatal("rebind reused the old destination generation")
	}
}

func TestBulletinDispatchSuccessorIsOwnerScopedAndIdempotent(t *testing.T) {
	// Recurring bug class: lifecycle dispatch replay and a late predecessor cannot reopen a successor's settled work scope.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	reader := coordinationPrincipal{Type: "source", SourceID: "owner"}
	accepted := newCoordinationEvent("accepted", "dispatch.accepted", []string{"app:installed"})
	accepted.Origin = &reader
	accepted.Observation = &coordinationObservation{DispatchAssociation: &coordinationDispatchAssociation{Resources: []string{"app:installed"}}}
	accepted.ThreadRefs = []coordinationThreadRef{{"thread", new("first")}}
	accepted.EvidenceRefs = []coordinationEvidenceRef{{"request", "dispatch"}}
	for range 2 {
		if err := bulletinFromDispatch(accepted); err != nil {
			t.Fatal(err)
		}
	}
	successor := newCoordinationEvent("successor", "turn.successor", []string{"app:installed"})
	successor.ThreadRefs = []coordinationThreadRef{{"thread", new("first")}, {"thread", new("next")}}
	successor.Origin = &coordinationPrincipal{Type: "source", SourceID: "other"}
	if err := bulletinFromTurn(successor); err != nil {
		t.Fatal(err)
	}
	successor.Origin = &reader
	if err := bulletinFromTurn(successor); err != nil {
		t.Fatal(err)
	}
	terminal := newCoordinationEvent("late", "turn.terminal", []string{"app:installed"})
	terminal.ThreadRefs, terminal.Status = []coordinationThreadRef{{"thread", new("first")}}, new("completed")
	if err := bulletinFromTurn(terminal); err != nil {
		t.Fatal(err)
	}
	store, err := openBulletinStore(filepath.Join(root(), "coordination/state.json"))
	if err != nil {
		t.Fatal(err)
	}
	rows := store.state.Notices
	if len(rows) != 1 || strPtr(rows[0].ThreadLinks[0].ObservedTurnID) != "next" || rows[0].ThreadLinks[0].ScopeState == "completed" {
		t.Fatalf("successor = %v", rows)
	}
}

func TestBulletinToolingValidationBoundsAndVerifiedGitCommit(t *testing.T) {
	// Contract: tooling warnings and fixing commits use uniquely registered resources and checked local evidence.
	state := t.TempDir()
	t.Setenv("ARC_STATE_DIR", state)
	repo := t.TempDir()
	registry := object{"projects": []any{object{"id": "project", "name": "Example", "roots": []any{object{"path": repo}}}}}
	if err := coordinationAtomicBytes(filepath.Join(state, "coordination/projects.json"), []byte(wire(registry))); err != nil {
		t.Fatal(err)
	}
	keys, err := coordinationRepositoryResources(repo)
	if err != nil || !slices.Equal(keys, []string{"project:project/main"}) {
		t.Fatalf("registered repo = %v, %v", keys, err)
	}
	if got := laneCoordinationError("worker", registry); !strings.Contains(got.Error(), "Example: lane:project/worker") {
		t.Fatalf("lane hint = %v", got)
	}
	if _, err := coordinationResource("service:server/worker"); err == nil || !strings.Contains(err.Error(), "use host:server") {
		t.Fatalf("host hint = %v", err)
	}
	old := coordinationLocalGit
	t.Cleanup(func() { coordinationLocalGit = old })
	coordinationLocalGit = func(_ context.Context, path string, args ...string) (string, error) {
		if physicalPath(path) == physicalPath(repo) && len(args) == 3 && args[2] == strings.Repeat("a", 40) {
			return "commit\n", nil
		}
		return "", os.ErrNotExist
	}
	fix := object{"fixingCommit": object{"projectId": "project", "oid": strings.Repeat("a", 40)}}
	if err := bulletinVerifyFix(t.Context(), fix); err != nil {
		t.Fatal(err)
	}
	obj(fix["fixingCommit"])["oid"] = strings.Repeat("b", 40)
	if err := bulletinVerifyFix(t.Context(), fix); err == nil || !strings.HasPrefix(err.Error(), "COORDINATION_FIX_UNVERIFIED") {
		t.Fatalf("missing commit = %v", err)
	}
}

func TestBulletinLegacyPreAdmissionCleanupRemovesOnlyUnacceptedRecords(t *testing.T) {
	// Recurring bug class: persistence startup drops pre-admission hints only after consulting the dispatch owner.
	store, clock, reader := fixtureBulletin(t)
	admission := func(thread, request string) (bool, error) {
		if request == "unavailable" {
			return false, errors.New("owner unavailable")
		}
		return thread == "known" && request == "accepted", nil
	}
	for _, key := range []string{"rejected", "accepted", "unavailable"} {
		input := newCoordinationEvent(key, "dispatch.accepted", []string{"app:installed"})
		input.EvidenceRefs = append(input.EvidenceRefs, coordinationEvidenceRef{"request", key})
		input.ThreadRefs = append(input.ThreadRefs, coordinationThreadRef{"known", new("turn")})
		input.Observation = &coordinationObservation{DispatchAssociation: &coordinationDispatchAssociation{Resources: []string{"app:installed"}}}
		if err := store.dispatchNotice(input, clock); err != nil {
			t.Fatal(err)
		}
	}
	store.state.DispatchAdmissionCleanupComplete = false
	if err := store.save(clock); err != nil {
		t.Fatal(err)
	}
	store, err := openBulletinStore(store.path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.cleanupDispatchAdmissions(clock, admission, &runtimeCost{}); err != nil {
		t.Fatal(err)
	}
	oldRow := object{"requestId": "rejected", "threadId": "known", "turnId": "turn", "dispatchMode": "new-turn"}
	events, err := coordinationOwnerInputs("dispatch", oldRow, []string{"host:fixture"})
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if err := store.dispatchNotice(event, clock); err != nil {
			t.Fatal(err)
		}
	}
	after, err := store.board(object{"view": "full"}, reader, clock)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, row := range after["notices"].([]object) {
		ids = append(ids, text(row, "dispatchId"))
	}
	slices.Sort(ids)
	if !slices.Equal(ids, []string{"accepted", "unavailable"}) {
		t.Fatalf("notices after migration and old dispatch replay = %v", ids)
	}
}

func TestBulletinLiveObservationCostIgnoresClosedHistory(t *testing.T) {
	// Recurring bug class: lifecycle observer cost stays bounded when closed Bulletin history grows.
	for _, history := range []int{4, 240} {
		store, clock, reader := fixtureBulletin(t)
		closed := writeBulletin(t, store, "notice_post", object{"resources": []any{"app:installed"}, "intent": "Older work"}, reader, clock)
		writeBulletin(t, store, "notice_close", object{"id": field(closed["notice"], "id")}, reader, clock)
		for i := 1; i < history; i++ {
			row := *store.state.Notices[0]
			row.ID = fmt.Sprintf("closed-%d", i)
			store.state.Notices = append(store.state.Notices, &row)
		}
		links := []bulletinLink{{ThreadID: "linked-thread", ObservedTurnID: new("turn"), ScopeState: "running", Terminals: map[string]any{}}}
		active, err := store.mutate("notice_post", object{"requestId": id(), "intent": "Current work", "resources": []any{"app:installed"}}, reader, links, nil, clock)
		if err != nil {
			t.Fatal(err)
		}
		cost := new(runtimeCost)
		if threads := store.linkedThreads(cost); !slices.Equal(threads, []string{"linked-thread"}) {
			t.Fatalf("linked threads with %d closed notices = %v", history, threads)
		}
		if err := store.maintain(clock, nil, cost); err != nil {
			t.Fatal(err)
		}
		if cost.rows.Load() != 2 || cost.read.Load() != 0 {
			t.Fatalf("active scan cost with %d closed notices = %d rows, %d bytes", history, cost.rows.Load(), cost.read.Load())
		}
		conflicts := store.conflicts([]string{"app:installed"}, "", "", clock)
		if len(conflicts) != 1 || conflicts[0]["id"] != field(active["notice"], "id") {
			t.Fatalf("active conflicts with %d closed notices = %v", history, conflicts)
		}
	}
}
