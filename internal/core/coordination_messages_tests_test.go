package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
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
			args := object{"toSourceId": "one", "requestId": id(), "type": "conditional", "resources": []any{"app:installed"},
				"summary": "Synthetic message", "negotiationId": key, "inReplyTo": request["messageId"]}
			replied, err := store.send(args, "two", coordinationRouteOutcome{state: "no-verified-target"}, 1001, nil)
			if err != nil {
				t.Fatal(err)
			}
			reply := obj(replied["message"])
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
			if mode == "compatible" {
				replay, err := secondRestart.send(args, "two", coordinationRouteOutcome{state: "no-verified-target"}, 1004, nil)
				if err != nil || field(replay["message"], "messageId") != reply["messageId"] || wire(replay["negotiation"]) != wire(negotiation) {
					t.Fatalf("reconstructed replay = %v, %v", replay, err)
				}
				next := sendCoordinationMail(t, secondRestart, "one", "two", "conditional", 1005, object{"negotiationId": key, "inReplyTo": reply["messageId"]})
				last := sendCoordinationMail(t, secondRestart, "two", "one", "conditional", 1006, object{"negotiationId": key, "inReplyTo": next["messageId"]})
				if last["escalated"] != true {
					t.Fatalf("reconstruction reset the reply budget: %v", last)
				}
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
	var finalArgs object
	for i := range 3 {
		from, to := "two", "one"
		if i%2 != 0 {
			from, to = to, from
		}
		finalArgs = object{"toSourceId": to, "requestId": id(), "type": "conditional", "summary": "Synthetic message",
			"resources": []any{"app:installed"}, "negotiationId": key, "inReplyTo": last["messageId"]}
		result, err := store.send(finalArgs, from, coordinationRouteOutcome{state: "no-verified-target"}, 1001+int64(i), nil)
		if err != nil {
			t.Fatal(err)
		}
		last = obj(result["message"])
	}
	if last["escalated"] != true {
		t.Fatalf("third automatic reply = %v", last)
	}
	store, err := openCoordinationMessageStore(store.path, nil)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := store.send(finalArgs, "two", coordinationRouteOutcome{state: "no-verified-target"}, 1009, nil)
	if err != nil || field(replay["message"], "messageId") != last["messageId"] || uintOr(field(replay["negotiation"], "automaticReplyCount"), 0) != 3 {
		t.Fatalf("replay at cap = %v, %v", replay, err)
	}
	for _, actor := range []string{"one", "two"} {
		inbox, err := store.list(object{}, actor, "fixture", 1009, nil)
		if err != nil {
			t.Fatal(err)
		}
		notices := 0
		for _, row := range arr(inbox["messages"]) {
			if field(row, "localOrigin") == "arc" && field(row, "escalated") == true {
				notices++
			}
		}
		if notices != 1 || field(arr(inbox["negotiations"])[0], "state") != "escalated" {
			t.Fatalf("escalation for %s = %v", actor, inbox)
		}
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

func TestMessagesCurrentPairCursorSurvivesOpenNegotiationRestart(t *testing.T) {
	// Recurring bug class: persistence reopening a current negotiation retains its participants and usable mailbox cursor.
	store := fixtureCoordinationMail(t)
	first := sendCoordinationMail(t, store, "one", "two", "request", 1000, nil)
	page, err := store.list(object{}, "one", "fixture", 1000, nil)
	if err != nil {
		t.Fatal(err)
	}
	store, err = openCoordinationMessageStore(store.path, nil)
	if err != nil {
		t.Fatal(err)
	}
	reply := sendCoordinationMail(t, store, "two", "one", "conditional", 1001,
		object{"negotiationId": first["negotiationId"], "inReplyTo": first["messageId"]})
	result, err := store.list(object{"cursor": page["nextCursor"]}, "one", "fixture", 1002, nil)
	if err != nil {
		t.Fatal(err)
	}
	mail, negotiations := arr(result["messages"]), arr(result["negotiations"])
	if len(mail) != 1 || field(mail[0], "messageId") != reply["messageId"] || len(negotiations) != 1 ||
		wire(field(negotiations[0], "participants")) != wire([]string{"one", "two"}) ||
		field(negotiations[0], "participantRecovery") != nil || uintOr(field(negotiations[0], "automaticReplyCount"), 0) != 1 {
		t.Fatalf("reopened current pair = %v", result)
	}
}

func TestMessagesRequestIDConflictsAcrossSenders(t *testing.T) {
	// Contract: a message request ID is bound to the authenticated sender and exact original arguments.
	store := fixtureCoordinationMail(t)
	args := object{"requestId": id(), "toSourceId": "recipient", "type": "request",
		"resources": []any{"app:installed"}, "summary": "Fixture request"}
	outcome := coordinationRouteOutcome{state: "no-verified-target"}
	first, err := store.send(args, "one", outcome, 1000, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.send(args, "different-sender", outcome, 1001, nil); err == nil || !strings.HasPrefix(err.Error(), "REQUEST_ID_CONFLICT:") {
		t.Fatalf("foreign sender replay = %v", err)
	}
	replay, err := store.send(args, "one", outcome, 1001, nil)
	if err != nil || wire(replay) != wire(first) {
		t.Fatalf("owner replay = %v, %v", replay, err)
	}
}

func TestMessagesMissingRecipientRoutePreservesPullableMail(t *testing.T) {
	// Recurring bug class: lifecycle sender repair guidance must preserve the recipient's stored pull-only mail.
	store := fixtureCoordinationMail(t)
	args := object{"requestId": id(), "toSourceId": "two", "toSessionId": "recipient-session", "type": "request",
		"summary": "Fixture coordination request", "resources": []any{"app:installed"}}
	result, err := store.send(args, "one", coordinationRouteOutcome{state: "no-verified-target"}, 1000, nil)
	if err != nil {
		t.Fatal(err)
	}
	route := result["routing"]
	next := field(route, "next")
	if result["stored"] != true || result["pullable"] != true || result["deliveryMode"] != "pull-only" ||
		field(route, "reason") != "no-verified-target" || field(next, "via") != "act" || field(next, "op") != "message_route" ||
		field(next, "actor") != "recipient" || field(field(next, "args"), "sessionId") != "recipient-session" {
		t.Fatalf("sender repair = %v", result)
	}
	store, err = openCoordinationMessageStore(store.path, nil)
	if err != nil {
		t.Fatal(err)
	}
	inbox, err := store.list(object{}, "two", "fixture", 1001, nil)
	if err != nil {
		t.Fatal(err)
	}
	mail := arr(inbox["messages"])
	if len(mail) != 1 || field(mail[0], "messageId") != field(result["message"], "messageId") || field(mail[0], "deliveryState") != "pull-only" {
		t.Fatalf("recipient pull = %v", inbox)
	}
}

func TestMessagesCallerReadReusesSnapshotAfterBadCursorAndReloadsReplacement(t *testing.T) {
	// Recurring bug class: persistence invalid cursors cannot make subsequent Messages reads reparse retained mail.
	state := t.TempDir()
	t.Setenv("ARC_STATE_DIR", state)
	path := filepath.Join(state, "coordination", "messages", "state.json")
	external, err := openCoordinationMessageStore(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Now().Unix()
	sendCoordinationMail(t, external, "one", "two", "notice", at, nil)
	costs := new(runtimeCostSet)
	ctx := context.WithValue(t.Context(), runtimeCostKey{}, runtimeCostContext{set: costs})
	ctx = withRuntimeCost(ctx, "coordinationRead", "poll")
	s := &service{}
	read := func(args object) (object, error) {
		value, err := s.managementRequest(ctx, "coordination/messages", "GET", args)
		return obj(value), err
	}
	if initial, err := read(object{}); err != nil || len(arr(initial["messages"])) != 1 {
		t.Fatalf("initial mailbox = %v, %v", initial, err)
	}
	parsed := costs.counter("coordinationRead").parsed.Load()
	if parsed == 0 {
		t.Fatal("initial store did not measure parsing")
	}
	if _, err := read(object{"cursor": "stale"}); err == nil || !strings.HasPrefix(err.Error(), "MESSAGES_CURSOR_EXPIRED") {
		t.Fatalf("invalid cursor = %v", err)
	}
	if warm, err := read(object{}); err != nil || len(arr(warm["messages"])) != 1 || costs.counter("coordinationRead").parsed.Load() != parsed {
		t.Fatalf("warm read after cursor error = %v, %v", warm, err)
	}
	external, err = openCoordinationMessageStore(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	added := sendCoordinationMail(t, external, "one", "two", "notice", at+1, object{"summary": "Externally replaced mail"})
	changed, err := read(object{})
	if err != nil || len(arr(changed["messages"])) != 2 || find(changed["messages"], "messageId", text(added, "messageId")) == nil ||
		costs.counter("coordinationRead").parsed.Load() <= parsed {
		t.Fatalf("replacement mailbox = %v, %v", changed, err)
	}
}

func fixtureCoordinationWake(t *testing.T) (context.Context, coordinationRouteOutcome, *[]string) {
	t.Helper()
	ctx, _, _, sent := notificationDeliveryFixture(t)
	saved := readCoordinationSource
	t.Cleanup(func() { readCoordinationSource = saved })
	readCoordinationSource = func(_ context.Context, request object) (object, error) {
		return object{"id": request["sourceId"], "state": "connected"}, nil
	}
	state, err := readNotificationState()
	if err != nil {
		t.Fatal(err)
	}
	target := findNotificationTarget(state, "source", "claude-session", notificationTestTarget)
	target["accountId"], target["tokens"] = "fixture-profile", 10
	if err := saveNotificationState(state); err != nil {
		t.Fatal(err)
	}
	outcome, err := resolveCoordinationRoute(ctx, "source", "")
	if err != nil || outcome.route == nil {
		t.Fatalf("fixture delivery route = %v, %v", outcome, err)
	}
	return ctx, outcome, sent
}

func TestMessagesBurstTransportAndCooldownSurviveRestart(t *testing.T) {
	// Contract: a bounded count-only wake leaves remaining mail queued across the recipient cooldown and restart.
	ctx, route, sent := fixtureCoordinationWake(t)
	reader := coordinationReader{principal: coordinationPrincipal{Type: "source", SourceID: "source"}}
	_, err := withBulletinStore(func(store *bulletinStore) (object, error) {
		return store.mutate("notice_post", object{"requestId": id(), "resources": []any{"app:installed"}, "intent": "Hold fixture resource"},
			reader, nil, nil, currentBulletinClock())
	})
	if err != nil {
		t.Fatal(err)
	}
	at := time.Now().Unix()
	storePath, err := withCoordinationMessages(ctx, func(store *coordinationMessageStore, cost *runtimeCost) (string, error) {
		for range 20 {
			args := object{"requestId": id(), "toSourceId": "source", "type": "notice", "summary": "Private fixture metadata", "resources": []any{"app:installed"}}
			if _, err := store.send(args, "sender", route, at-30, cost); err != nil {
				return "", err
			}
		}
		return store.path, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := flushCoordinationMessages(ctx); err != nil {
		t.Fatal(err)
	}
	if len(*sent) != 1 || strings.Contains((*sent)[0], "Private fixture metadata") || !strings.Contains((*sent)[0], "mail") {
		t.Fatalf("transport wake = %v", *sent)
	}
	reopened, err := openCoordinationMessageStore(storePath, nil)
	if err != nil {
		t.Fatal(err)
	}
	deliveredAt := reopened.data.LastPush[route.route.RouteID]
	inbox, err := reopened.list(object{}, "source", "fixture", deliveredAt, nil)
	if err != nil {
		t.Fatal(err)
	}
	var delivered, pending []string
	for _, row := range arr(inbox["messages"]) {
		switch field(row, "deliveryState") {
		case "delivered":
			delivered = append(delivered, text(row, "messageId"))
		case "pending":
			pending = append(pending, text(row, "messageId"))
		}
	}
	if len(delivered) != 16 || len(pending) != 4 {
		t.Fatalf("burst left %d delivered and %d pending", len(delivered), len(pending))
	}
	if batches, err := reopened.batches(deliveredAt+59, nil); err != nil || len(batches) != 0 {
		t.Fatalf("cooldown admitted an early wake: %v, %v", batches, err)
	}
	batches, err := reopened.batches(deliveredAt+60, nil)
	if err != nil || len(batches) != 1 || len(batches[0]) != 4 ||
		slices.ContainsFunc(batches[0], func(row coordinationMessageRow) bool {
			return !slices.Contains(pending, text(row.Envelope, "messageId"))
		}) {
		t.Fatalf("remaining batch = %v, %v", batches, err)
	}
}

func TestMessagesRechecksRecipientBoardClaimBeforeWake(t *testing.T) {
	// Contract: recipient claim closure downgrades admitted notices while an addressed request remains deliverable.
	ctx, route, sent := fixtureCoordinationWake(t)
	reader := coordinationReader{principal: coordinationPrincipal{Type: "source", SourceID: "source"}}
	post := func(owner coordinationReader, op string, args object) object {
		t.Helper()
		value, err := withBulletinStore(func(store *bulletinStore) (object, error) {
			return store.mutate(op, args, owner, nil, nil, currentBulletinClock())
		})
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	resources := []any{"app:installed"}
	notice := post(reader, "notice_post", object{"requestId": id(), "resources": resources, "intent": "Hold fixture resource"})["notice"]
	blocker := post(reader, "blocker_open", object{"requestId": id(), "resources": resources, "causeCode": "verification", "summary": "Hold resource"})["blocker"]
	post(coordinationReader{principal: coordinationPrincipal{Type: "source", SourceID: "other"}}, "notice_post",
		object{"requestId": id(), "resources": resources, "intent": "Unrelated owner's resource"})
	at := time.Now().Unix() - 31
	requestID, noticeID := id(), id()
	_, err := withCoordinationMessages(ctx, func(store *coordinationMessageStore, cost *runtimeCost) (struct{}, error) {
		for _, item := range []struct{ kind, id string }{{"notice", noticeID}, {"request", requestID}} {
			args := object{"requestId": item.id, "toSourceId": "source", "type": item.kind, "resources": resources, "summary": "Fixture mail"}
			decision := coordinationMessageDelivery(args, []string{"app:installed"}, route)
			if result, err := store.send(args, "sender", decision, at, cost); err != nil || result["deliveryMode"] != "proactive" {
				t.Fatalf("admitted %s = %v, %v", item.kind, result, err)
			}
		}
		return struct{}{}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	post(reader, "notice_close", object{"id": field(notice, "id"), "expectedRevision": field(notice, "revision"), "requestId": id(), "reason": "Work ended"})
	if !slices.Contains(coordinationHeldResources(ctx, "source"), "app:installed") {
		t.Fatal("closing a notice removed an independent blocker claim")
	}
	post(reader, "blocker_clear", object{"id": field(blocker, "id"), "expectedRevision": field(blocker, "revision"), "requestId": id(), "reason": "Evidence confirmed", "evidenceIds": []any{"fixture-receipt"}})
	if err := flushCoordinationMessages(ctx); err != nil {
		t.Fatal(err)
	}
	page, err := withCoordinationMessages(ctx, func(store *coordinationMessageStore, cost *runtimeCost) (object, error) {
		return store.list(object{}, "source", "fixture", time.Now().Unix(), cost)
	})
	if err != nil || len(*sent) != 1 {
		t.Fatalf("send after claim closure = %v, %v", *sent, err)
	}
	request, downgraded := find(page["messages"], "messageId", requestID), find(page["messages"], "messageId", noticeID)
	if request["deliveryState"] != "delivered" || downgraded["deliveryState"] != "pull-only" || downgraded["deliveryReason"] != "notice-no-resource-overlap" {
		t.Fatalf("mail after claim closure = %v", page)
	}
}
