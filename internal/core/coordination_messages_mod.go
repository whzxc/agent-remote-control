package core

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

var coordinationMessagesResident struct {
	sync.Mutex
	stamp *fileStamp
	store *coordinationMessageStore
}

// Segment C verifies target syntax and delivers only a count after outbox reservation.
var coordinationValidateTarget func(string) error
var deliverCoordinationBatch func(context.Context, coordinationRoute, int, string) (string, error)

func withCoordinationMessages[T any](ctx context.Context, work func(*coordinationMessageStore, *runtimeCost) (T, error)) (T, error) {
	var zero T
	coordinationMessagesResident.Lock()
	defer coordinationMessagesResident.Unlock()
	cost := currentRuntimeCost(ctx)
	path := filepath.Join(root(), "coordination/messages/state.json")
	stamp, err := readStamp(path)
	if err != nil {
		return zero, err
	}
	store := coordinationMessagesResident.store
	if store == nil || store.path != path || !stampSame(stamp, coordinationMessagesResident.stamp) {
		coordinationMessagesResident.store = nil
		store, err = openCoordinationMessageStore(path, cost)
		if err != nil {
			return zero, err
		}
		coordinationMessagesResident.store = store
		coordinationMessagesResident.stamp, err = readStamp(path)
		if err != nil {
			coordinationMessagesResident.store = nil
			return zero, err
		}
	}
	if err := store.migrateRoutes(cost); err != nil {
		coordinationMessagesResident.store = nil
		return zero, err
	}
	result, err := work(store, cost)
	if err == nil {
		coordinationMessagesResident.stamp, err = readStamp(path)
		if err != nil {
			coordinationMessagesResident.store = nil
		}
	}
	if err != nil && (strings.HasPrefix(err.Error(), "COORDINATION_STORAGE") || strings.HasPrefix(err.Error(), "COORDINATION_CORRUPT")) {
		coordinationMessagesResident.store = nil
	}
	return result, err
}

func coordinationMessageResources(args object) ([]string, error) {
	keys := []string{}
	for _, raw := range coordinationResourceStrings(args["resources"]) {
		key, err := coordinationResource(raw)
		if err != nil {
			return nil, err
		}
		if coordinationLaneShorthand(key) != "" {
			return nil, errors.New("INVALID_ARGUMENT: use qualified lane resource keys")
		}
		keys = append(keys, key)
	}
	return axSet(keys), nil
}

func validateCoordinationMessage(op string, args object) error {
	if invalid := checkSchema("op", op, op, operation(op)["inputSchema"], args); invalid != nil {
		return errors.New(wire(invalid))
	}
	if target, ok := args["target"].(string); op == "message_route" && ok && coordinationValidateTarget != nil {
		if err := coordinationValidateTarget(target); err != nil {
			return errors.New("INVALID_ARGUMENT: message_route requires a complete registered Claude cloud-session ID or URL")
		}
	}
	for _, field := range []string{"toSourceId", "sessionId", "toSessionId", "negotiationId", "inReplyTo"} {
		if value, ok := args[field].(string); ok && !coordinationIdentifier(value) {
			return invalidCoordinationIdentifier()
		}
	}
	for _, value := range axStrings(args["relatedIds"]) {
		if !coordinationIdentifier(value) {
			return invalidCoordinationIdentifier()
		}
	}
	if summary, ok := args["summary"].(string); ok && (strings.TrimSpace(summary) == "" || utf8.RuneCountInString(summary) > 240 || strings.ContainsFunc(summary, unicode.IsControl)) {
		return errors.New("INVALID_ARGUMENT: summary must be single-line metadata of 1 to 240 characters, never prompt content")
	}
	keys, err := coordinationMessageResources(args)
	if err != nil {
		return err
	}
	for _, condition := range arr(args["conditions"]) {
		key, err := coordinationResource(text(condition, "resource"))
		if err != nil {
			return err
		}
		if !slices.Contains(keys, key) {
			return errors.New("INVALID_ARGUMENT: condition must reference a message resource")
		}
	}
	return nil
}

func coordinationMessageFailure(err error, op string) object {
	message := err.Error()
	code, _, _ := strings.Cut(message, ":")
	next := object{"op": nil, "hint": "Inspect local ARC source authorization, message capacity and delivery diagnostics; retain the original requestId. No task was dispatched."}
	switch code {
	case "INVALID_ARGUMENT":
		next = object{"via": "query", "op": "guide", "args": object{"op": op}, "hint": "Use the current metadata-only message schema"}
	case "MESSAGES_CURSOR_EXPIRED", "NEGOTIATION_NOT_FOUND", "NEGOTIATION_EXPIRED", "NEGOTIATION_RESOLVED":
		next = object{"via": "query", "op": "messages", "args": object{}, "hint": "Read messages again; retain the original requestId for retries"}
	case "NEGOTIATION_LIMIT":
		next = object{"op": nil, "hint": "Stop automatic replies on both sides. Ask the user to inspect and mediate through local messages management; a new negotiation or session cannot bypass this hold."}
	}
	return object{"state": "failed", "error": object{"code": code, "message": message}, "next": next}
}

func authorizeCoordinationRecipient(ctx context.Context, source string) error {
	value, err := readCoordinationSource(ctx, object{"sourceId": source})
	if err != nil {
		return err
	}
	if value["state"] == "revoked" || value["connectionRemoved"] == true || (value["ingressId"] == "local-cli" && field(value["credential"], "type") == "local") {
		return errors.New("SOURCE_REVOKED: select an authorized control source")
	}
	return nil
}

func coordinationCheckSession(source, session string) error {
	if session == "" {
		return nil
	}
	sessions, err := coordinationSessionRoutes(source)
	if err != nil {
		return err
	}
	if !slices.ContainsFunc(sessions, func(row bulletinSession) bool { return row.ID == session }) {
		return errors.New("SESSION_NOT_FOUND: select an active logical session owned by that source")
	}
	return nil
}

func (store *coordinationMessageStore) migrateRoutes(cost *runtimeCost) error {
	if len(store.data.Routes) == 0 {
		return nil
	}
	clock := currentBulletinClock()
	_, err := withBulletinStore(func(board *bulletinStore) (struct{}, error) {
		for _, session := range board.state.Sessions {
			if session.State != "active" || session.Owner.Type != "source" || session.Route != nil || session.RouteFailure != nil {
				continue
			}
			if route, ok := store.data.Routes[session.Owner.SourceID+":"+session.ID]; ok {
				session.Route = &route
			}
		}
		board.state.Revision++
		return struct{}{}, board.save(clock)
	})
	if err != nil {
		return err
	}
	clear(store.data.Routes)
	return store.save(cost)
}

func bindCoordinationRoute(source, session string, route *coordinationRoute) error {
	_, err := withBulletinStore(func(store *bulletinStore) (struct{}, error) {
		for _, row := range store.state.Sessions {
			if row.ID != session || row.State != "active" || row.Owner.Type != "source" || row.Owner.SourceID != source {
				continue
			}
			if route != nil {
				destination := *route
				if row.Route != nil && row.Route.sameDestination(destination) && row.Route.BindingID != nil {
					destination.BindingID = row.Route.BindingID
				} else {
					destination.BindingID = new(id())
				}
				route = &destination
			}
			row.Route, row.RouteFailure = route, nil
			store.state.Revision++
			return struct{}{}, store.save(currentBulletinClock())
		}
		return struct{}{}, errors.New("SESSION_NOT_FOUND: select an active logical session owned by this source")
	})
	return err
}

func coordinationMessageDelivery(args object, held []string, outcome coordinationRouteOutcome) coordinationRouteOutcome {
	if args["type"] != "notice" {
		return outcome
	}
	if held == nil {
		return coordinationRouteOutcome{state: "notice-board-unavailable"}
	}
	resources := coordinationResourceStrings(args["resources"])
	if slices.ContainsFunc(held, func(key string) bool { return slices.Contains(resources, key) }) {
		return outcome
	}
	return coordinationRouteOutcome{state: "notice-no-resource-overlap"}
}

func coordinationHeldResources(ctx context.Context, source string) []string {
	if maintainBulletin(ctx) != nil {
		return nil
	}
	values, _ := withBulletinStore(func(store *bulletinStore) ([]string, error) { return store.recipientResources(source), nil })
	return values
}

func reconcileCoordinationMessages(ctx context.Context) error {
	pending, err := withCoordinationMessages(ctx, func(store *coordinationMessageStore, _ *runtimeCost) ([]coordinationEventInput, error) {
		return slices.Clone(store.data.Pending[:min(64, len(store.data.Pending))]), nil
	})
	if err != nil {
		return err
	}
	for _, event := range pending {
		if _, err := emitCoordinationEvent(event); err != nil {
			return err
		}
		_, err := withCoordinationMessages(ctx, func(store *coordinationMessageStore, cost *runtimeCost) (struct{}, error) {
			before := len(store.data.Pending)
			store.data.Pending = slices.DeleteFunc(store.data.Pending, func(input coordinationEventInput) bool { return input.TransitionID == event.TransitionID })
			if len(store.data.Pending) == before {
				return struct{}{}, nil
			}
			return struct{}{}, store.save(cost)
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func refreshCoordinationRecovery(ctx context.Context) error {
	events, err := withCoordinationJournal(func(journal *coordinationJournal) ([]object, error) {
		events, _, err := journal.recoveryEvents()
		return events, err
	})
	if err != nil {
		return err
	}
	_, err = withCoordinationMessages(ctx, func(store *coordinationMessageStore, cost *runtimeCost) (struct{}, error) {
		return struct{}{}, store.refreshRecovery(events, cost)
	})
	return err
}

func callCoordinationMessage(ctx context.Context, request operationRequest) (any, error) {
	request.args = clone(request.args)
	value, err := executeCoordinationMessage(ctx, request)
	if err == nil {
		return value, err
	}
	return coordinationMessageFailure(err, request.name), nil
}

func executeCoordinationMessage(ctx context.Context, request operationRequest) (object, error) {
	op, args := request.name, request.args
	if err := admitCoordinationResources(args); err != nil {
		return nil, err
	}
	if err := validateCoordinationMessage(op, args); err != nil {
		return nil, err
	}
	reader, err := coordinationReadAuthority(ctx, request.source.local)
	if err != nil {
		return nil, err
	}
	actor := reader.principal.SourceID
	if reader.principal.Type == "local-authority" {
		actor = "local-authority"
	}
	if actor == "" {
		return nil, errors.New("SOURCE_REQUIRED: control source required")
	}
	projectionErr := reconcileCoordinationMessages(ctx)
	if op == "messages" {
		if err := refreshCoordinationRecovery(ctx); err != nil {
			return nil, err
		}
		result, err := withCoordinationMessages(ctx, func(store *coordinationMessageStore, cost *runtimeCost) (object, error) {
			return store.list(args, actor, reader.revision, time.Now().Unix(), cost)
		})
		if err != nil {
			return nil, err
		}
		if actor != "local-authority" {
			value, err := coordinationRoutingStatus(ctx, actor)
			if err != nil {
				return nil, err
			}
			result["coordinationDelivery"] = value
		}
		result["projectionPending"] = projectionErr != nil || result["projectionPending"] == true
		return result, nil
	}
	if actor == "local-authority" {
		return nil, errors.New("SOURCE_REQUIRED: local authority mediates through messages management")
	}
	session := text(args, "sessionId")
	if op != "message_route" || args["target"] != nil {
		if err := coordinationCheckSession(actor, session); err != nil {
			return nil, err
		}
	}
	if op == "message_route" {
		var route *coordinationRoute
		if target, ok := args["target"].(string); ok {
			result, err := coordinationVerifiedTarget(ctx, actor, target)
			if err != nil {
				return nil, err
			}
			route = result.route
			if route == nil {
				return nil, errors.New("MESSAGE_ROUTE_UNVERIFIED: bind and verify this source-owned target through notify_control first")
			}
		}
		if err := bindCoordinationRoute(actor, session, route); err != nil {
			return nil, err
		}
		outcome, err := resolveCoordinationRoute(ctx, actor, session)
		if err != nil {
			return nil, err
		}
		routing := coordinationRoutingDescription(outcome, actor, session)
		return object{"sessionId": args["sessionId"], "deliveryMode": routing["deliveryMode"], "deliveryCapability": routing["deliveryMode"], "routing": routing}, nil
	}
	target, targetSession := text(args, "toSourceId"), text(args, "toSessionId")
	if err := authorizeCoordinationRecipient(ctx, target); err != nil {
		return nil, err
	}
	if err := coordinationCheckSession(target, targetSession); err != nil {
		return nil, err
	}
	outcome, err := resolveCoordinationRoute(ctx, target, targetSession)
	if err != nil {
		return nil, err
	}
	if args["type"] == "notice" {
		outcome = coordinationMessageDelivery(args, coordinationHeldResources(ctx, target), outcome)
	}
	if args["requestId"] == nil {
		args["requestId"] = id()
	}
	requestID := text(args, "requestId")
	unlock := lockReceipt(requestID)
	defer unlock()
	digest := hash([]byte(wire([]any{actor, args})))
	backend := text(request.service.metadata, "instance")
	receipts := coreReceiptStore()
	receipt, err := receipts.replay(ctx, requestID, digest, backend)
	if err != nil {
		return nil, err
	}
	if receipt != nil {
		if readReceiptState(text(receipt, "state"), true) == receiptCompleted {
			result := clone(obj(receipt["result"]))
			result["receipt"] = receipt
			return result, nil
		}
		return publicReceipt(receipt), nil
	}
	receipt = object{"requestId": requestID, "origin": currentOrigin(ctx), "backendSession": backend, "digest": digest, "operation": op, "state": "reserved", "createdAt": now()}
	if err := receipts.reserve(ctx, receipt); err != nil {
		return nil, err
	}
	owner, err := receipts.begin(ctx, receipt)
	if err != nil {
		return nil, err
	}
	defer owner.close()
	result, err := withCoordinationMessages(ctx, func(store *coordinationMessageStore, cost *runtimeCost) (object, error) {
		return store.send(args, actor, outcome, time.Now().Unix(), cost)
	})
	if err != nil {
		return nil, err
	}
	result["projectionPending"] = reconcileCoordinationMessages(ctx) != nil
	receipt["state"] = "completed"
	summary := selectFields(result, "stored", "pullable", "hint", "deliveryMode", "routing")
	summary["messageId"], summary["negotiationId"] = field(result["message"], "messageId"), field(result["message"], "negotiationId")
	summary["next"] = object{"via": "query", "op": "messages", "args": object{"direction": "outbox"}}
	receipt["result"] = summary
	if err := receipts.checkpoint(ctx, receipt); err != nil {
		return nil, err
	}
	result["receipt"] = receipt
	return result, nil
}

func localCoordinationMessages(ctx context.Context, method string, body object) (any, error) {
	var value object
	var err error
	if method == "GET" {
		if err := validateCoordinationMessage("messages", body); err != nil {
			return nil, err
		}
		value, err = withCoordinationMessages(ctx, func(store *coordinationMessageStore, cost *runtimeCost) (object, error) {
			return store.list(body, "local-authority", "local", time.Now().Unix(), cost)
		})
	} else {
		reason := text(body, "reason")
		if (body["action"] != "resolve" && body["action"] != "reopen") || strings.TrimSpace(reason) == "" || utf8.RuneCountInString(reason) > 240 {
			return nil, errors.New("INVALID_ARGUMENT: local mediation requires action resolve|reopen, negotiationId, expectedLastMessageId and a reason of 1 to 240 characters")
		}
		value, err = withCoordinationMessages(ctx, func(store *coordinationMessageStore, cost *runtimeCost) (object, error) {
			return store.mediate(body, time.Now().Unix(), cost)
		})
	}
	if err != nil {
		return nil, err
	}
	value["projectionPending"] = reconcileCoordinationMessages(ctx) != nil
	return value, nil
}

func queueCoordinationRecovery(blocker, recipient object) error {
	ctx := context.Background()
	source, session := text(recipient, "sourceId"), text(recipient, "sessionId")
	if err := authorizeCoordinationRecipient(ctx, source); err != nil {
		if strings.HasPrefix(err.Error(), "SOURCE_REVOKED") || err.Error() == "SOURCE_NOT_FOUND" {
			return nil
		}
		return err
	}
	if err := coordinationCheckSession(source, session); err != nil {
		if strings.HasPrefix(err.Error(), "SESSION_NOT_FOUND") {
			return nil
		}
		return err
	}
	_, err := withCoordinationMessages(ctx, func(store *coordinationMessageStore, cost *runtimeCost) (struct{}, error) {
		return struct{}{}, store.recovery(blocker, recipient, time.Now().Unix(), cost)
	})
	return err
}

func sameCoordinationRoute(a, b *coordinationRoute) bool {
	return a == nil && b == nil || a != nil && b != nil && a.sameDestination(*b) && samePointer(a.BindingID, b.BindingID)
}

func restrictCoordinationNotices(ctx context.Context, rows []coordinationMessageRow) ([]coordinationMessageRow, error) {
	if !slices.ContainsFunc(rows, func(row coordinationMessageRow) bool { return row.Envelope["type"] == "notice" }) {
		return rows, nil
	}
	held := coordinationHeldResources(ctx, text(rows[0].Envelope, "toSourceId"))
	return withCoordinationMessages(ctx, func(store *coordinationMessageStore, cost *runtimeCost) ([]coordinationMessageRow, error) {
		kept := []coordinationMessageRow{}
		changed := false
		for _, previous := range rows {
			row := store.message(text(previous.Envelope, "messageId"))
			if row == nil || row.Sequence != previous.Sequence || row.Envelope["deliveryState"] != "pending" {
				continue
			}
			outcome := coordinationMessageDelivery(row.Envelope, held, coordinationRouteOutcome{row.Route, text(row.Envelope, "deliveryReason")})
			if outcome.route != nil {
				kept = append(kept, copyCoordinationMessageRow(row))
			} else {
				row.Route = nil
				row.Envelope["deliveryState"], row.Envelope["deliveryReason"] = "pull-only", outcome.state
				store.event(text(row.Envelope, "messageId")+"-delivery-pull-only", "message.delivery", coordinationResourceStrings(row.Envelope["resources"]))
				changed = true
			}
		}
		if changed {
			return kept, store.save(cost)
		}
		return kept, nil
	})
}

func copyCoordinationMessageRow(row *coordinationMessageRow) coordinationMessageRow {
	copy := *row
	copy.Envelope = clone(row.Envelope)
	copy.RecoveryRefs = slices.Clone(row.RecoveryRefs)
	return copy
}

func coordinationBatchAuthorized(ctx context.Context, route *coordinationRoute, rows []coordinationMessageRow) bool {
	if authorizeCoordinationRecipient(ctx, route.SourceID) != nil {
		return false
	}
	for _, row := range rows {
		source := text(row.Envelope, "fromSourceId")
		session := text(row.Envelope, "toSessionId")
		if row.Route == nil || !row.Route.sameDestination(*route) || authorizeCoordinationRecipient(ctx, source) != nil || coordinationCheckSession(route.SourceID, session) != nil {
			return false
		}
		if session != "" {
			current, err := coordinationSessionRoutes(route.SourceID)
			if err != nil {
				return false
			}
			for _, s := range current {
				if s.ID != session {
					continue
				}
				if s.Route != nil && !sameCoordinationRoute(s.Route, row.Route) || s.Route == nil && row.Route.BindingID != nil {
					return false
				}
				break
			}
		} else if row.Envelope["deliveryReason"] == "explicit-route" {
			outcome, err := resolveCoordinationRoute(ctx, route.SourceID, "")
			if err != nil || !sameCoordinationRoute(outcome.route, row.Route) {
				return false
			}
		}
	}
	return true
}

func flushCoordinationMessages(ctx context.Context) error {
	if err := reconcileCoordinationMessages(ctx); err != nil {
		return err
	}
	if err := refreshCoordinationRecovery(ctx); err != nil {
		return err
	}
	at := time.Now().Unix()
	batches, err := withCoordinationMessages(ctx, func(store *coordinationMessageStore, cost *runtimeCost) ([][]coordinationMessageRow, error) {
		return store.batches(at, cost)
	})
	if err != nil {
		return err
	}
	for _, rows := range batches {
		selected, err := restrictCoordinationNotices(ctx, rows)
		if err != nil {
			return err
		}
		if len(selected) == 0 {
			continue
		}
		route := selected[0].Route
		mark := func(rows []coordinationMessageRow, state string, at int64) error {
			_, err := withCoordinationMessages(ctx, func(store *coordinationMessageStore, cost *runtimeCost) (struct{}, error) {
				return struct{}{}, store.mark(rows, state, at, cost)
			})
			return err
		}
		if !coordinationBatchAuthorized(ctx, route, selected) {
			if err := mark(selected, "cancelled", at); err != nil {
				return err
			}
			continue
		}
		if err := refreshCoordinationRecovery(ctx); err != nil {
			return err
		}
		reserved, err := withCoordinationMessages(ctx, func(store *coordinationMessageStore, cost *runtimeCost) ([]coordinationMessageRow, error) {
			pending := []coordinationMessageRow{}
			for _, previous := range selected {
				row := store.message(text(previous.Envelope, "messageId"))
				if row != nil && row.Sequence == previous.Sequence && row.Route != nil && row.Envelope["deliveryState"] == "pending" {
					pending = append(pending, copyCoordinationMessageRow(row))
				}
			}
			return pending, store.mark(pending, "sending", at, cost)
		})
		if err != nil {
			return err
		}
		if len(reserved) == 0 {
			continue
		}
		state, err := deliverCoordinationBatch(ctx, *route, len(reserved), text(reserved[0].Envelope, "messageId"))
		if err != nil {
			state = "unconfirmed"
		}
		if err := mark(reserved, state, time.Now().Unix()); err != nil {
			return err
		}
	}
	return nil
}

func runCoordinationMessages(ctx context.Context) {
	runCoordinationWorker(ctx, "coordinationMessages", []string{
		"coordination/messages/state.json", "coordination/events/manifest.json", "coordination/state.json", "coordination/projects.json",
		"sources.json", "notifications/subscriptions/state.json", "notifications/tasks",
	}, func(ctx context.Context) (time.Time, error) {
		if err := flushCoordinationMessages(ctx); err != nil {
			return time.Time{}, err
		}
		return withCoordinationMessages(ctx, func(store *coordinationMessageStore, cost *runtimeCost) (time.Time, error) {
			if next := store.nextBackgroundAt(time.Now().Unix(), cost); next != 0 {
				return time.Unix(next, 0), nil
			}
			return time.Time{}, nil
		})
	})
}

func init() {
	coordinationImportRoutes = func() error {
		_, err := withCoordinationMessages(context.Background(), func(*coordinationMessageStore, *runtimeCost) (struct{}, error) { return struct{}{}, nil })
		return err
	}
	coordinationRecoveryMessenger = queueCoordinationRecovery
	for _, op := range []string{"messages", "message_send", "message_route"} {
		registerOperation(op, callCoordinationMessage, nil)
	}
	for _, method := range []string{"GET", "POST"} {
		registerRoute(method, "coordination/messages", func(ctx context.Context, _ *service, body object, _ []string) (any, error) {
			return localCoordinationMessages(ctx, method, body)
		})
	}
}
