package core

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
)

func notificationFirstDelivery(t *testing.T, thread, turn string) object {
	t.Helper()
	row, err := readNotificationBinding(thread, turn)
	if err != nil {
		t.Fatal(err)
	}
	deliveries := arr(row["deliveries"])
	if len(deliveries) == 0 {
		t.Fatalf("no delivery for %s", thread)
	}
	return obj(deliveries[0])
}

func TestNotificationHistoricalSubscriptionsKeepScopeAndPreferences(t *testing.T) {
	// Recurring bug class: persistence reconciliation of retained bindings must preserve subscription settings and scope identity.
	state := object{}
	at := time.Now()
	bindings := make([]object, 1500)
	for index := range bindings {
		binding := newNotificationBinding(fmt.Sprintf("task-%d", index), "turn", "/fixture", fmt.Sprintf("source-%d", index%2), at)
		binding["target"] = notificationTestTarget
		bindings[index] = binding
	}
	syncNotificationSubscriptions(state, bindings)
	original := obj(arr(state["subscriptions"])[0])
	original["muted"], original["until"], original["expiresAt"] = true, 999, 999000
	created, key := original["createdAt"], text(original, "id")
	bindings[0]["target"], bindings[1]["target"], bindings[2]["sourceId"] = "session_020000000000000000000001", nil, ""
	syncNotificationSubscriptions(state, bindings)
	rows := arr(state["subscriptions"])
	saved := find(rows, "id", key)
	if len(rows) != 1498 || saved["target"] != bindings[0]["target"] || saved["muted"] != true ||
		saved["until"] != 999 || saved["expiresAt"] != 999000 || saved["createdAt"] != created {
		t.Fatalf("retained subscriptions = %d, preserved row = %v", len(rows), saved)
	}
	byThread := map[string]object{}
	for _, binding := range bindings {
		byThread[text(binding, "threadId")] = binding
	}
	for _, row := range rows {
		binding := byThread[text(field(row, "args"), "threadId")]
		if field(row, "sourceId") != binding["sourceId"] || field(row, "turn") != binding["turnId"] || field(row, "target") != binding["target"] {
			t.Fatalf("subscription scope drifted: %v vs %v", row, binding)
		}
	}
}

func TestNotificationEmptyAsyncCompletionAndChangesStayOutOfTransport(t *testing.T) {
	// Contract: only meaningful completion wakes the source and the transport contains no task output or change evidence.
	ctx, _, flush, sent := notificationDeliveryFixture(t)
	thread, turn := boundNotificationFixture(t, ctx)
	input := object{"state": "interaction-required", "recordedStatus": "inProgress", "runtimeStatus": "active",
		"activeFlags": []any{"waitingOnUserInput"},
		"interaction": []any{object{"id": "question", "method": "request_user_input_async", "params": object{"question": "Fixture question"}}}}
	if err := handleNotificationObservation(ctx, nil, thread, turn, input); err != nil {
		t.Fatal(err)
	}
	if err := handleNotificationObservation(ctx, nil, thread, turn,
		object{"state": "completed", "recordedStatus": "completed", "finalResponse": object{"text": "  "}, "interaction": []any{}}); err != nil {
		t.Fatal(err)
	}
	empty, err := readNotificationBinding(thread, turn)
	if err != nil || field(empty["observation"], "state") != "completed" || len(arr(empty["deliveries"])) != 1 {
		t.Fatalf("empty async completion = %v, %v", empty, err)
	}
	thread, turn = boundNotificationFixture(t, ctx)
	changes := object{"summary": object{"files": 2, "added": 4}, "commits": []any{object{"sha": "fixture-commit", "title": "Fixture change"}}}
	payload := object{"state": "completed", "recordedStatus": "completed", "finalResponse": object{"text": "Fixture private final text"}, "changes": changes}
	if err := handleNotificationObservation(ctx, nil, thread, turn, payload); err != nil {
		t.Fatal(err)
	}
	flush()
	delivery := notificationFirstDelivery(t, thread, turn)
	if delivery["status"] != "delivered" || wire(delivery["changes"]) != wire(changes) ||
		field(delivery["finalResponse"], "text") != "Fixture private final text" || len(*sent) == 0 {
		t.Fatalf("private pull evidence or delivery missing: %v", delivery)
	}
	for _, body := range *sent {
		if strings.Contains(body, "Fixture private final text") || strings.Contains(body, "fixture-commit") {
			t.Fatalf("wake copied private content: %s", body)
		}
	}
}

func TestNotificationQuietWindowCoalescesOrdinaryTransport(t *testing.T) {
	// Recurring bug class: concurrency nearby completion observations use one quiet-window batch.
	ctx, _, _, _ := notificationDeliveryFixture(t)
	at := notificationClock()
	notificationClock = func() time.Time { return at }
	enqueue := func() (string, string) {
		thread, turn := boundNotificationFixture(t, ctx)
		observeSelectedNotification(t, ctx, thread, turn, "completed", "idle", "")
		return thread, turn
	}
	flush := func(seconds int) {
		t.Helper()
		at = at.Add(time.Duration(seconds) * time.Second)
		if err := flushNotifications(ctx, &service{}); err != nil {
			t.Fatal(err)
		}
	}
	single, singleTurn := enqueue()
	flush(1)
	if d := notificationFirstDelivery(t, single, singleTurn); d["status"] != "pending" {
		t.Fatalf("completion escaped its quiet window: %v", d)
	}
	flush(1)
	if notificationFirstDelivery(t, single, singleTurn)["status"] != "delivered" {
		t.Fatal("single completion missed its quiet deadline")
	}
	at = at.Add(8 * time.Second)
	first, firstTurn := enqueue()
	at = at.Add(time.Second)
	second, secondTurn := enqueue()
	flush(1)
	for _, pair := range [][2]string{{first, firstTurn}, {second, secondTurn}} {
		if d := notificationFirstDelivery(t, pair[0], pair[1]); d["status"] != "pending" {
			t.Fatalf("burst escaped its quiet window: %v", d)
		}
	}
	flush(1)
	a, b := notificationFirstDelivery(t, first, firstTurn), notificationFirstDelivery(t, second, secondTurn)
	if a["status"] != "delivered" || b["status"] != "delivered" || text(a, "batch") == "" || a["batch"] != b["batch"] {
		t.Fatalf("ordinary burst split: %v / %v", a, b)
	}
}

func TestNotificationRetriesReuseVerifiedRouteAndTokenCredit(t *testing.T) {
	// Recurring bug class: retry-replay transient transport failure cannot revoke a verified route, replace its event, or charge it again.
	ctx, source, _, _ := notificationDeliveryFixture(t)
	at := notificationClock()
	notificationClock = func() time.Time { return at }
	if _, err := updateNotificationSettings(object{"notificationBucketCapacity": 1, "notificationRefillSeconds": 60}); err != nil {
		t.Fatal(err)
	}
	state, err := readNotificationState()
	if err != nil {
		t.Fatal(err)
	}
	target := findNotificationTarget(state, "source", "claude-session", notificationTestTarget)
	target["accountId"], target["tokens"], target["refilledAt"] = "fixture-profile", 1, at.Unix()
	notificationReachability(target)["verifiedAt"] = 42
	if err := saveNotificationState(state); err != nil {
		t.Fatal(err)
	}
	thread, turn := boundNotificationFixture(t, ctx)
	observeSelectedNotification(t, ctx, thread, turn, "completed", "idle", "")
	event := notificationFirstDelivery(t, thread, turn)["eventId"]
	sends := 0
	notificationSessionSend = func(_ context.Context, channel, profile, target, body string) error {
		if channel != "claude-session" || profile != "fixture-profile" || target != notificationTestTarget || strings.Contains(body, str(event)) {
			t.Fatalf("retry transport route = %s %s %s %q", channel, profile, target, body)
		}
		sends++
		if sends <= 2 {
			return errors.New("fixture temporary outage")
		}
		return nil
	}
	check := func(advance int, sent, next int, status string) {
		t.Helper()
		at = at.Add(time.Duration(advance) * time.Second)
		if err := flushNotifications(ctx, &service{}); err != nil {
			t.Fatal(err)
		}
		delivery := notificationFirstDelivery(t, thread, turn)
		if delivery["eventId"] != event || delivery["status"] != status || int(uintOr(delivery["nextAttemptAt"], 0)) != next || sends != sent {
			t.Fatalf("expected %d sends, got %d with delivery %v", sent, sends, delivery)
		}
	}
	first := int(at.Unix() + 2)
	check(2, 1, first+10, "pending")
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	defer closeNotificationOwner(physicalPath(notificationOwnerPath()))
	status, err := notificationStatus(ctx, operationRequest{source: source, args: object{"all": true}})
	if err != nil {
		t.Fatal(err)
	}
	public := clone(obj(status))
	delivery := find(public["deliveries"], "eventId", str(event))
	if field(arr(public["targets"])[0], "reachability") != "verified" || text(delivery, "error") == "" {
		t.Fatalf("temporary outage lost route or error: %v", public)
	}
	check(9, 1, first+10, "pending")
	check(1, 2, first+30, "pending")
	check(19, 2, first+30, "pending")
	check(1, 3, 0, "delivered")
	after, err := readNotificationState()
	found := findNotificationTarget(after, "source", "claude-session", notificationTestTarget)
	if err != nil || uintOr(found["tokens"], 99) != 0 || found["accountId"] != "fixture-profile" ||
		field(found["reachability"], "state") != "verified" || uintOr(field(found["reachability"], "verifiedAt"), 0) != 42 {
		t.Fatalf("persisted retry destination = %v, %v", found, err)
	}
}

func TestNotificationStatusExplainsRestartAndExcludedSuccessor(t *testing.T) {
	// Recurring bug class: lifecycle missing deliveries must explain native restart and exclusions with executable readback.
	ctx, source, _, _ := notificationDeliveryFixture(t)
	thread, turn := boundNotificationFixture(t, ctx)
	read := func(reason string) object {
		t.Helper()
		status, err := notificationStatus(ctx, operationRequest{source: source, args: object{"threadId": thread}})
		threads := arr(field(clone(obj(status)), "threads"))
		if err != nil || len(threads) != 1 {
			t.Fatalf("thread status = %v, %v", status, err)
		}
		diagnosis := obj(field(threads[0], "diagnosis"))
		if !slices.Contains(arr(diagnosis["reasons"]), any(reason)) {
			t.Fatalf("%s missing in %v", reason, diagnosis)
		}
		return diagnosis
	}
	pending := read("pending-observation")
	binding, err := readNotificationBinding(thread, turn)
	if err != nil {
		t.Fatal(err)
	}
	binding["observation"] = object{"reconciliation": "pending-after-restart", "lastError": "native-observer-unavailable"}
	if err := persistNotificationBinding(binding); err != nil {
		t.Fatal(err)
	}
	read("pending-after-restart")
	const next = "new-user-turn"
	observation := object{"state": "cancelled", "recordedStatus": "interrupted", "nextTurnId": next,
		"nativeContinuation": object{"excluded": true, "reason": "new-user-content"}}
	if err := handleNotificationObservation(ctx, nil, thread, turn, observation); err != nil {
		t.Fatal(err)
	}
	details := read("successor-not-inherited")
	if field(details["successor"], "turnId") != next || field(details["successor"], "inherited") != false ||
		field(details["scope"], "active") != false {
		t.Fatalf("excluded successor left active scope: %v", details)
	}
	for _, value := range []object{pending, details} {
		next := obj(value["next"])
		op := text(next, "op")
		if failure := checkSchema("op", op, op, operation(op)["inputSchema"], obj(next["args"])); failure != nil {
			t.Fatalf("diagnosis recovery args = %v", failure)
		}
	}
}

func TestNotificationInheritedPushRetainsSourceScopedBreakerAcrossReload(t *testing.T) {
	// Recurring bug class: security an inherited verified route must ignore a different source's breaker for the same destination.
	ctx, _, _, _ := notificationDeliveryFixture(t)
	previous := notificationTransportAvailable
	t.Cleanup(func() { notificationTransportAvailable = previous })
	notificationTransportAvailable = func(channel string) bool { return channel == "claude-session" }
	thread, _ := boundNotificationFixture(t, ctx)
	turn := id()
	if err := bindNotification(ctx, object{}, thread, turn, "/fixture", object{"op": "codex_send"}); err != nil {
		t.Fatal(err)
	}
	state, err := readNotificationState()
	if err != nil {
		t.Fatal(err)
	}
	other := notificationTarget(state, object{}, "other", "claude-session", notificationTestTarget, notificationClock().Unix())
	other["breaker"] = true
	if err := saveNotificationState(state); err != nil {
		t.Fatal(err)
	}
	owner := physicalPath(notificationOwnerPath())
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	closeNotificationOwner(owner)
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	defer closeNotificationOwner(owner)
	binding, err := readNotification(ctx, thread, turn, "")
	if err != nil || binding["target"] != notificationTestTarget || !notificationPushAvailable(binding) {
		t.Fatalf("same-source inherited push = %v, %v", binding, err)
	}
	state, err = readNotificationState()
	if err != nil {
		t.Fatal(err)
	}
	findNotificationTarget(state, "source", "claude-session", notificationTestTarget)["breaker"] = true
	if err := saveNotificationState(state); err != nil {
		t.Fatal(err)
	}
	if notificationPushAvailable(binding) {
		t.Fatal("owner breaker did not suspend push")
	}
}

func TestNotificationBucketRefillBatchesPendingKindsAcrossRestart(t *testing.T) {
	// Recurring bug class: persistence retained token wait must batch a request and completion without replacing their event IDs.
	ctx, _, _, _ := notificationDeliveryFixture(t)
	at := notificationClock()
	notificationClock = func() time.Time { return at }
	if _, err := updateNotificationSettings(object{"notificationBucketCapacity": 1, "notificationRefillSeconds": 60}); err != nil {
		t.Fatal(err)
	}
	previous := notificationTransportAvailable
	t.Cleanup(func() { notificationTransportAvailable = previous })
	notificationTransportAvailable = func(string) bool { return true }
	enq := func(request string) (string, string) {
		t.Helper()
		thread, turn := boundNotificationFixture(t, ctx)
		input := object{"state": "interaction-required", "recordedStatus": "inProgress", "runtimeStatus": "active",
			"activeFlags": []any{"waitingOnApproval"}, "interaction": []any{object{"id": request, "method": "item/commandExecution/requestApproval"}}}
		if err := handleNotificationObservation(ctx, nil, thread, turn, input); err != nil {
			t.Fatal(err)
		}
		return thread, turn
	}
	flush := func(seconds int) {
		t.Helper()
		at = at.Add(time.Duration(seconds) * time.Second)
		if err := flushNotifications(ctx, &service{}); err != nil {
			t.Fatal(err)
		}
	}
	first, firstTurn := enq("first")
	flush(0)
	if notificationFirstDelivery(t, first, firstTurn)["status"] != "delivered" {
		t.Fatal("first request did not spend the available token")
	}
	at = at.Add(time.Second)
	approval, approvalTurn := enq("second")
	complete, completeTurn := boundNotificationFixture(t, ctx)
	observeSelectedNotification(t, ctx, complete, completeTurn, "completed", "idle", "")
	initialApproval := notificationFirstDelivery(t, approval, approvalTurn)
	initialComplete := notificationFirstDelivery(t, complete, completeTurn)
	flush(0)
	at = at.Add(time.Second)
	flush(1)
	if d := notificationFirstDelivery(t, approval, approvalTurn); d["status"] != "pending" || field(d["timing"], "queueReason") != "token-wait" {
		t.Fatalf("approval token wait = %v", d)
	}
	owner := physicalPath(notificationOwnerPath())
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	closeNotificationOwner(owner)
	if err := openNotificationOwner(ctx, &service{}); err != nil {
		t.Fatal(err)
	}
	defer closeNotificationOwner(owner)
	flush(56)
	if notificationFirstDelivery(t, approval, approvalTurn)["status"] != "pending" ||
		notificationFirstDelivery(t, complete, completeTurn)["status"] != "pending" {
		t.Fatal("queued deliveries spent a token before its refill")
	}
	flush(1)
	a, b := notificationFirstDelivery(t, approval, approvalTurn), notificationFirstDelivery(t, complete, completeTurn)
	if a["status"] != "delivered" || b["status"] != "delivered" || a["eventId"] != initialApproval["eventId"] ||
		b["eventId"] != initialComplete["eventId"] || text(a, "batch") == "" || a["batch"] != b["batch"] {
		t.Fatalf("refilled delivery batch = %v / %v", a, b)
	}
	state, err := readNotificationState()
	if err != nil {
		t.Fatal(err)
	}
	batch := find(findNotificationTarget(state, "source", "claude-session", notificationTestTarget)["batches"], "id", text(a, "batch"))
	if uintOr(field(batch["kinds"], "needs-input"), 0) != 1 || uintOr(field(batch["kinds"], "completed"), 0) != 1 {
		t.Fatalf("refill batch kinds = %v", batch)
	}
}

func TestNotificationAttentionRetiresOnlySupersededSourceRoute(t *testing.T) {
	// Recurring bug class: lifecycle attention drops a failure only when the same source and channel has newer verified evidence.
	ctx, source, _, _ := notificationDeliveryFixture(t)
	thread, _ := boundNotificationFixture(t, ctx)
	state, err := readNotificationState()
	if err != nil {
		t.Fatal(err)
	}
	old := findNotificationTarget(state, "source", "claude-session", notificationTestTarget)
	reach := notificationReachability(old)
	reach["state"], reach["reason"], reach["failedAt"] = "failed", "delivery-failed", 2000
	write := func() {
		t.Helper()
		if err := saveNotificationState(state); err != nil {
			t.Fatal(err)
		}
	}
	write()
	read := func(count int) []any {
		t.Helper()
		view, err := notificationCoordinationAttention()
		rows := arr(clone(view)["problems"])
		if err != nil || len(rows) != count {
			t.Fatalf("attention wanted %d problems: %v, %v", count, view, err)
		}
		return rows
	}
	row := read(1)[0]
	args := obj(field(field(row, "next"), "args"))
	if field(row, "target") != notificationTestTarget || field(row, "threadId") != thread ||
		wire(args) != wire(object{"target": notificationTestTarget, "threadId": thread, "all": false}) {
		t.Fatalf("exact repair action = %v", row)
	}
	details, err := notificationStatus(ctx, operationRequest{source: source, args: args})
	if err != nil || find(clone(obj(details))["threads"], "threadId", thread) == nil {
		t.Fatalf("repair action did not select its thread = %v, %v", details, err)
	}
	const replacement = "session_020000000000000000000001"
	newer := notificationTarget(state, object{}, "other", "claude-session", replacement, notificationClock().Unix())
	notificationReachability(newer)["state"], notificationReachability(newer)["verifiedAt"] = "verified", 5000
	write()
	read(1)
	newer["sourceId"], newer["channel"] = "source", "mcp-events"
	write()
	read(1)
	newer["channel"] = "claude-session"
	write()
	read(0)
	history, err := notificationStatus(ctx, operationRequest{source: source, args: object{"target": notificationTestTarget, "all": false}})
	if err != nil {
		t.Fatal(err)
	}
	oldTarget := find(clone(obj(history))["targets"], "target", notificationTestTarget)
	if oldTarget["reachability"] != "failed" || oldTarget["supersededBy"] != replacement {
		t.Fatalf("historical target = %v", oldTarget)
	}
	reach["failedAt"] = 6000
	write()
	read(1)
}
