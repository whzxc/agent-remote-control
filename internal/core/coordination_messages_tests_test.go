package core

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixtureCoordinationMail(t *testing.T) *coordinationMessageStore {
	t.Helper()
	store, err := openCoordinationMessageStore(filepath.Join(t.TempDir(), "state.json"), nil)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func sendCoordinationMail(t *testing.T, store *coordinationMessageStore, from, to, kind string, now int64, add object) object {
	t.Helper()
	args := object{"toSourceId": to, "requestId": id(), "type": kind, "resources": []any{"app:installed"}, "summary": "Synthetic message"}
	for key, value := range add {
		args[key] = value
	}
	result, err := store.send(args, from, coordinationRouteOutcome{state: "no-verified-target"}, now, nil)
	if err != nil {
		t.Fatal(err)
	}
	return obj(result["message"])
}

func TestMessagesRecoverSingletonsFromConsistentEnvelopeEvidence(t *testing.T) {
	// Recurring bug class: persistence legacy singleton negotiations must archive their input and reconstruct only consistent peer evidence.
	for _, mode := range []string{"compatible", "contradictory", "missing"} {
		t.Run(mode, func(t *testing.T) {
			store := fixtureCoordinationMail(t)
			request := sendCoordinationMail(t, store, "one", "two", "request", 1000, nil)
			key := text(request, "negotiationId")
			reply := sendCoordinationMail(t, store, "two", "one", "conditional", 1001, object{"negotiationId": key, "inReplyTo": request["messageId"]})
			n := store.negotiation(key)
			n.Participants = []string{"one"}
			switch mode {
			case "contradictory":
				store.message(text(reply, "messageId")).Envelope["fromSourceId"] = "third"
			case "missing":
				store.data.Messages = []*coordinationMessageRow{}
			}
			legacy := []byte(wire(store.data))
			if err := os.WriteFile(store.path, legacy, 0o600); err != nil {
				t.Fatal(err)
			}
			reloaded, err := openCoordinationMessageStore(store.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			backup, err := os.ReadFile(strings.TrimSuffix(store.path, ".json") + ".before-participant-recovery.json")
			if err != nil || string(backup) != string(legacy) {
				t.Fatalf("migration did not preserve the legacy snapshot")
			}
			result, err := reloaded.list(object{}, "local-authority", "local", 1002, nil)
			if err != nil {
				t.Fatal(err)
			}
			negotiation := arr(result["negotiations"])[0]
			state := text(field(negotiation, "participantRecovery"), "state")
			want := "unresolved"
			if mode == "compatible" {
				want = "reconstructed"
			}
			if state != want || uintOr(field(negotiation, "automaticReplyCount"), 0) != 1 {
				t.Fatalf("legacy negotiation = %v", negotiation)
			}
			secondRestart, err := openCoordinationMessageStore(store.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			retained, err := secondRestart.list(object{}, "local-authority", "local", 1003, nil)
			if err != nil || wire(retained["negotiations"]) != wire(result["negotiations"]) {
				t.Fatalf("restart = %v, %v", retained, err)
			}
		})
	}
}

func TestMessagesRejectConflictingMigrationBackup(t *testing.T) {
	// Recurring bug class: persistence participant recovery cannot overwrite independently retained legacy evidence.
	store := fixtureCoordinationMail(t)
	request := sendCoordinationMail(t, store, "one", "two", "request", 1000, nil)
	store.negotiation(text(request, "negotiationId")).Participants = []string{"one"}
	legacy := []byte(wire(store.data))
	backup := strings.TrimSuffix(store.path, ".json") + ".before-participant-recovery.json"
	if err := os.WriteFile(backup, []byte("older evidence"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.path, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := openCoordinationMessageStore(store.path, nil); err == nil || !strings.HasPrefix(err.Error(), "COORDINATION_STORAGE") {
		t.Fatalf("open = %v", err)
	}
	retained, err := os.ReadFile(store.path)
	if err != nil || string(retained) != string(legacy) {
		t.Fatal("legacy snapshot was altered")
	}
}

func TestMessagesReplyBudgetSurvivesNegotiationAndSessionChanges(t *testing.T) {
	// Recurring bug class: security held negotiations prevent automatic replies or a new exchange until local mediation.
	store := fixtureCoordinationMail(t)
	request := sendCoordinationMail(t, store, "one", "two", "request", 1000, nil)
	key := text(request, "negotiationId")
	last := request
	for i := range 3 {
		from, to := "two", "one"
		if i%2 != 0 {
			from, to = to, from
		}
		last = sendCoordinationMail(t, store, from, to, "conditional", 1001+int64(i), object{"negotiationId": key, "inReplyTo": last["messageId"]})
	}
	if last["escalated"] != true {
		t.Fatalf("third automatic reply = %v", last)
	}
	store, err := openCoordinationMessageStore(store.path, nil)
	if err != nil {
		t.Fatal(err)
	}
	next := object{"toSourceId": "two", "requestId": id(), "type": "request", "negotiationId": "fresh", "resources": []any{"app:installed"}, "summary": "Another exchange"}
	if _, err := store.send(next, "one", coordinationRouteOutcome{state: "no-verified-target"}, 1010, nil); !errors.Is(err, errCoordinationNegotiationLimit) {
		t.Fatalf("bypass = %v", err)
	}
	if _, err := store.mediate(object{"action": "reopen", "negotiationId": key, "expectedLastMessageId": "stale", "reason": "Local evidence"}, 1010, nil); err == nil || !strings.HasPrefix(err.Error(), "NEGOTIATION_CONFLICT") {
		t.Fatalf("stale mediation = %v", err)
	}
	result, err := store.mediate(object{"action": "reopen", "negotiationId": key, "expectedLastMessageId": last["messageId"], "reason": "Local mediation"}, 1010, nil)
	if err != nil || field(result["negotiation"], "state") != "open" || uintOr(field(result["negotiation"], "automaticReplyCount"), 1) != 0 {
		t.Fatalf("mediation = %v, %v", result, err)
	}
}

func TestMessagesRepliesRequireOriginalAddressAndResources(t *testing.T) {
	// Contract: reply addressing and scope stay bound to the retained exchange, including notice-only replies.
	store := fixtureCoordinationMail(t)
	request := sendCoordinationMail(t, store, "one", "two", "request", 1000, nil)
	reply := object{"toSourceId": "one", "requestId": id(), "type": "grant", "negotiationId": request["negotiationId"], "inReplyTo": request["messageId"], "resources": []any{"host:other"}, "summary": "Grant"}
	if _, err := store.send(reply, "two", coordinationRouteOutcome{}, 1001, nil); err == nil || !strings.Contains(err.Error(), "same negotiation and resource set") {
		t.Fatalf("cross-resource reply = %v", err)
	}
	reply["resources"] = []any{"app:installed"}
	if _, err := store.send(reply, "three", coordinationRouteOutcome{}, 1001, nil); err == nil || !strings.Contains(err.Error(), "addressed to you") {
		t.Fatalf("unaddressed reply = %v", err)
	}
	reply["type"] = "notice"
	if _, err := store.send(reply, "two", coordinationRouteOutcome{}, 1001, nil); err == nil || !strings.Contains(err.Error(), "must omit negotiationId") {
		t.Fatalf("bound notice reply = %v", err)
	}
	delete(reply, "negotiationId")
	notice, err := store.send(reply, "two", coordinationRouteOutcome{state: "notice-no-resource-overlap"}, 1001, nil)
	if err != nil || notice["negotiation"] != nil || field(notice["message"], "inReplyTo") != request["messageId"] || store.negotiation(text(request, "negotiationId")).AutomaticReplyCount != 0 {
		t.Fatalf("notice advanced original negotiation: %v, %v", notice, err)
	}
	replayed, err := store.send(reply, "two", coordinationRouteOutcome{}, 1003, nil)
	if err != nil || wire(replayed) != wire(notice) {
		t.Fatalf("replay = %v, %v", replayed, err)
	}
	reply["summary"] = "Different arguments"
	if _, err := store.send(reply, "two", coordinationRouteOutcome{}, 1003, nil); err == nil || !strings.HasPrefix(err.Error(), "REQUEST_ID_CONFLICT") {
		t.Fatalf("reused key = %v", err)
	}
}

func TestMessagesCursorsBindParticipantDirectionAndRetention(t *testing.T) {
	// Recurring bug class: security mail and pagination cursors expose only the authenticated participant's inbox or outbox.
	store := fixtureCoordinationMail(t)
	for range 2 {
		sendCoordinationMail(t, store, "one", "two", "notice", 1000, nil)
	}
	first, err := store.list(object{"limit": 1}, "two", "authority", 1000, nil)
	if err != nil || first["hasMore"] != true || len(arr(first["messages"])) != 1 {
		t.Fatalf("page = %v, %v", first, err)
	}
	cursor := first["nextCursor"]
	for _, reader := range []struct{ actor, revision, direction string }{{"one", "authority", "inbox"}, {"two", "changed", "inbox"}, {"two", "authority", "outbox"}} {
		if _, err := store.list(object{"cursor": cursor, "direction": reader.direction}, reader.actor, reader.revision, 1000, nil); err == nil || !strings.HasPrefix(err.Error(), "MESSAGES_CURSOR_EXPIRED") {
			t.Fatalf("cursor accepted for %+v", reader)
		}
	}
	end, err := store.list(object{"cursor": cursor, "limit": 1}, "two", "authority", 1000, nil)
	if err != nil || len(arr(end["messages"])) != 1 || end["hasMore"] != false || field(arr(end["messages"])[0], "dataOnly") != true {
		t.Fatalf("last page = %v, %v", end, err)
	}
	hidden, err := store.list(object{}, "unrelated", "authority", 1000, nil)
	if err != nil || len(arr(hidden["messages"])) != 0 {
		t.Fatalf("unrelated mailbox = %v, %v", hidden, err)
	}
	if _, err := store.list(object{"cursor": cursor}, "two", "authority", 1000+7*coordinationMessageDay, nil); err == nil || !strings.HasPrefix(err.Error(), "MESSAGES_CURSOR_EXPIRED") {
		t.Fatalf("expired cursor = %v", err)
	}
}

func TestMessagesOnlyMatchingPeerNoticesCanWake(t *testing.T) {
	// Recurring bug class: security a notice without a currently held overlapping resource stays pull-only.
	args := object{"type": "notice", "resources": []any{"app:installed"}}
	route := &coordinationRoute{SourceID: "two", RouteID: "target", Generation: "verified"}
	outcome := coordinationRouteOutcome{route, "explicit-route"}
	choices := []struct {
		held      []string
		state     string
		proactive bool
	}{
		{nil, "notice-board-unavailable", false},
		{[]string{"host:isolated"}, "notice-no-resource-overlap", false},
		{[]string{"app:installed"}, "explicit-route", true},
	}
	for _, choice := range choices {
		got := coordinationMessageDelivery(args, choice.held, outcome)
		if got.state != choice.state || (got.route != nil) != choice.proactive {
			t.Fatalf("held %v: %v", choice.held, got)
		}
	}
	args["type"] = "grant"
	if got := coordinationMessageDelivery(args, nil, outcome); got.route != route {
		t.Fatalf("addressed negotiation = %v", got)
	}
}

func TestMessagesBatchReservationDoesNotReplayUnconfirmedDelivery(t *testing.T) {
	// Recurring bug class: concurrency saved send reservations recover as unconfirmed after owner loss and cannot wake twice.
	store := fixtureCoordinationMail(t)
	route := &coordinationRoute{SourceID: "two", RouteID: "target", Generation: "verified"}
	for i := range 2 {
		_, err := store.send(object{"toSourceId": "two", "requestId": id(), "type": "notice", "resources": []any{"app:installed"}, "summary": "Synthetic message"}, "one", coordinationRouteOutcome{route, "resolved"}, 1000+int64(i)*10, nil)
		if err != nil {
			t.Fatal(err)
		}
	}
	batches, err := store.batches(1030, nil)
	if err != nil || len(batches) != 1 || len(batches[0]) != 2 {
		t.Fatalf("batch = %v, %v", batches, err)
	}
	if err := store.mark(batches[0], "sending", 1030, nil); err != nil {
		t.Fatal(err)
	}
	store, err = openCoordinationMessageStore(store.path, nil)
	if err != nil {
		t.Fatal(err)
	}
	batches, err = store.batches(1091, nil)
	if err != nil || len(batches) != 0 {
		t.Fatalf("replayed delivery = %v, %v", batches, err)
	}
	page, err := store.list(object{}, "two", "authority", 1091, nil)
	if err != nil || len(arr(page["messages"])) != 2 {
		t.Fatalf("retained = %v, %v", page, err)
	}
	for _, row := range arr(page["messages"]) {
		if field(row, "deliveryState") != "unconfirmed" {
			t.Fatalf("delivery = %v", row)
		}
	}
}

func TestMessagesRecoveryRemainsAdvisoryAndSuppressesCompletedSuccessors(t *testing.T) {
	// Contract: recovery mail remains pull-only, deduplicates, pages references, and withdraws obsolete advice.
	store := fixtureCoordinationMail(t)
	blocker := recoveryTestBlocker()
	refs := make([]object, 25)
	for i := range refs {
		refs[i] = object{"threadId": "thread-" + string(rune('a'+i)), "turnId": "turn", "interruptedAt": 2000}
	}
	recipient := object{"sourceId": "two", "sessionId": "session", "threadRefs": refs}
	for range 2 {
		if err := store.recovery(blocker, recipient, 1000, nil); err != nil {
			t.Fatal(err)
		}
	}
	page, err := store.list(object{}, "two", "authority", 1000, nil)
	if err != nil || len(arr(page["messages"])) != 1 {
		t.Fatalf("recovery mail = %v, %v", page, err)
	}
	row := arr(page["messages"])[0]
	if field(row, "automaticResume") != false || field(row, "deliveryState") != "pull-only" {
		t.Fatalf("unsafe advice = %v", row)
	}
	next := obj(field(field(row, "next"), "args"))
	remainder, err := store.list(next, "two", "authority", 1000, nil)
	if err != nil || len(remainder["threadRefs"].([]object)) == 0 {
		t.Fatalf("recovery page = %v, %v", remainder, err)
	}
	var events []object
	for _, ref := range refs {
		event := recoveryTestEvent("turn.terminal", "two", text(ref, "threadId"), "turn", 3000)
		event["status"] = "completed"
		events = append(events, event)
	}
	if err := store.refreshRecovery(events, nil); err != nil {
		t.Fatal(err)
	}
	page, err = store.list(object{}, "two", "authority", 1001, nil)
	if err != nil || field(arr(page["messages"])[0], "deliveryState") != "suppressed" {
		t.Fatalf("obsolete advice = %v, %v", page, err)
	}
}

func TestMessagesCanonicalAdmissionValidatesConditionsAndUnicodeSummary(t *testing.T) {
	// Contract: conditions refer to canonical message resources and the summary bound counts Unicode characters.
	registry := object{"projects": []any{object{"id": "registered", "name": "Example", "roots": []any{}}}}
	key, err := canonicalCoordinationResource("project:Example/main", registry)
	if err != nil {
		t.Fatal(err)
	}
	args := object{"type": "notice", "toSourceId": "recipient", "summary": strings.Repeat("é", 240), "resources": []any{key}}
	if err := validateCoordinationMessage("message_send", args); err != nil {
		t.Fatal(err)
	}
	args["summary"] = strings.Repeat("é", 241)
	if err := validateCoordinationMessage("message_send", args); err == nil {
		t.Fatal("oversized Unicode summary accepted")
	}
	args["summary"] = "Bounded notice"
	args["conditions"] = []any{object{"resource": "host:unrelated", "condition": "Until inspected"}}
	if err := validateCoordinationMessage("message_send", args); err == nil {
		t.Fatal("out-of-scope condition accepted")
	}
}

func TestMessagesLegacyRoutesTransferOnceWithoutOverwritingCurrentBinding(t *testing.T) {
	// Recurring bug class: persistence route migration transfers legacy destinations once and preserves later session edits.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	reader := coordinationReader{principal: coordinationPrincipal{Type: "source", SourceID: "peer"}}
	session, err := withBulletinStore(func(store *bulletinStore) (object, error) {
		return store.mutate("coordination_session", object{"action": "register", "requestId": id()}, reader, []bulletinLink{}, nil, currentBulletinClock())
	})
	if err != nil {
		t.Fatal(err)
	}
	sessionID := text(session["session"], "id")
	store := fixtureCoordinationMail(t)
	store.data.Routes = map[string]coordinationRoute{"peer:" + sessionID: {SourceID: "peer", RouteID: "legacy", Generation: "old", BindingID: new("legacy-binding")}}
	if err := store.migrateRoutes(nil); err != nil {
		t.Fatal(err)
	}
	first, err := coordinationSessionRoutes("peer")
	if err != nil || len(first) != 1 || first[0].Route == nil || strPtr(first[0].Route.BindingID) != "legacy-binding" {
		t.Fatalf("migration = %v, %v", first, err)
	}
	if err := bindCoordinationRoute("peer", sessionID, &coordinationRoute{SourceID: "peer", RouteID: "edited", Generation: "new"}); err != nil {
		t.Fatal(err)
	}
	if err := store.migrateRoutes(nil); err != nil {
		t.Fatal(err)
	}
	second, err := coordinationSessionRoutes("peer")
	if err != nil || len(second) != 1 || second[0].Route == nil || second[0].Route.RouteID != "edited" {
		t.Fatalf("edited route = %v, %v", second, err)
	}
}

func TestMalformedMessagesSnapshotRemainsIntact(t *testing.T) {
	// Recurring bug class: persistence a malformed snapshot must fail closed without replacing retained evidence.
	path := filepath.Join(t.TempDir(), "state.json")
	malformed := []byte(`{"messages":[`)
	if err := os.WriteFile(path, malformed, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := openCoordinationMessageStore(path, nil); !errors.Is(err, errCoordinationMessageCorrupt) {
		t.Fatalf("opening malformed messages = %v", err)
	}
	current, err := os.ReadFile(path)
	if err != nil || string(current) != string(malformed) {
		t.Fatalf("malformed snapshot was lost: %v", err)
	}
}

func TestMessagesUnresolvedLegacyHoldSurvivesNewPeersUntilMediation(t *testing.T) {
	// Recurring bug class: security recovered escalations hold their resources across new negotiations until local mediation.
	store := fixtureCoordinationMail(t)
	request := sendCoordinationMail(t, store, "one", "two", "request", 1000, nil)
	key := text(request, "negotiationId")
	legacy := store.negotiation(key)
	legacy.State = "escalated"
	legacy.Participants = []string{"one"}
	store.data.Messages = []*coordinationMessageRow{}
	if err := os.WriteFile(store.path, []byte(wire(store.data)), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := openCoordinationMessageStore(store.path, nil)
	if err != nil {
		t.Fatal(err)
	}
	next := object{"toSourceId": "three", "requestId": id(), "type": "request", "resources": []any{"app:installed"}, "summary": "Another exchange"}
	if _, err := store.send(next, "one", coordinationRouteOutcome{}, 1010, nil); !errors.Is(err, errCoordinationNegotiationLimit) {
		t.Fatalf("new peer bypassed a held resource: %v", err)
	}
	sendCoordinationMail(t, store, "one", "three", "request", 1011, object{"resources": []any{"host:other"}})
	decision := object{"action": "resolve", "negotiationId": key, "expectedLastMessageId": request["messageId"], "reason": "Local mediation"}
	if result, err := store.mediate(decision, 1012, nil); err != nil || field(result["negotiation"], "state") != "resolved" {
		t.Fatalf("local mediation returned %v: %v", result, err)
	}
	if result, err := store.send(next, "one", coordinationRouteOutcome{}, 1013, nil); err != nil || field(result["message"], "negotiationId") == key {
		t.Fatalf("mediated resource could not be used: %v: %v", result, err)
	}
}
