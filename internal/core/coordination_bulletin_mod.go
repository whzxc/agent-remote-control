package core

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
)

var bulletinResident struct {
	sync.Mutex
	stamp *fileStamp
	store *bulletinStore
}

var coordinationRevokedSources func() ([]string, error)
var coordinationNotificationAttention func(context.Context) (object, error)
var readCoordinationCodexHead func(context.Context, *service, string) (object, error)
var coordinationLocalGit func(context.Context, string, ...string) (string, error)
var coordinationDispatchAdmission func(thread, request string) (bool, error)
var coordinationGitCommon func(string) (string, error)

func withBulletinStore[T any](work func(*bulletinStore) (T, error)) (T, error) {
	var zero T
	bulletinResident.Lock()
	defer bulletinResident.Unlock()
	path := filepath.Join(root(), "coordination/state.json")
	stamp, err := readStamp(path)
	if err != nil {
		return zero, err
	}
	store := bulletinResident.store
	if store == nil || store.path != path || !stampSame(stamp, bulletinResident.stamp) {
		bulletinResident.store = nil
		store, err = openBulletinStore(path)
		if err != nil {
			return zero, err
		}
		bulletinResident.store, bulletinResident.stamp = store, stamp
	}
	result, err := work(store)
	if err == nil {
		bulletinResident.stamp, err = readStamp(path)
	}
	if err != nil {
		bulletinResident.store = nil
	}
	return result, err
}

func bulletinDigest(op string, args object, reader coordinationReader) string {
	return hash([]byte(wire([]any{op, args, reader.identity()})))
}

func laneCoordinationError(name string, registry any) error {
	examples := []string{}
	for _, project := range arr(field(registry, "projects")) {
		label, ok := field(project, "name").(string)
		if !ok {
			continue
		}
		if resource, err := coordinationResource("lane:" + text(project, "id") + "/" + name); err == nil {
			examples = append(examples, label+": "+resource)
			if len(examples) == 5 {
				break
			}
		}
	}
	if len(examples) == 0 {
		examples = append(examples, "lane:<project>/"+name)
	}
	return fmt.Errorf("INVALID_ARGUMENT: use lane:<project>/<name>; query projects for the registered project ID. Qualified examples: %s", strings.Join(examples, ", "))
}

func admitCoordinationResources(args object) error {
	list := arr(args["resources"])
	needsRegistry := slices.ContainsFunc(list, func(value any) bool {
		resource := str(value)
		return strings.HasPrefix(resource, "project:") || strings.HasPrefix(resource, "lane:")
	})
	if !needsRegistry {
		return nil
	}
	registry, _ := cachedLoad(filepath.Join(root(), "coordination/projects.json"))
	for i, resource := range list {
		key, err := canonicalCoordinationResource(str(resource), registry)
		if err != nil {
			return err
		}
		list[i] = key
	}
	for _, raw := range arr(args["conditions"]) {
		condition := obj(raw)
		key, err := canonicalCoordinationResource(text(condition, "resource"), registry)
		if err != nil {
			return err
		}
		condition["resource"] = key
	}
	return nil
}

func bulletinValidate(op string, args object) error {
	if invalid := checkSchema("op", op, op, operation(op)["inputSchema"], args); invalid != nil {
		return errors.New(wire(invalid))
	}
	for _, key := range []string{"intent", "summary", "reason"} {
		if value, ok := args[key].(string); ok && (strings.TrimSpace(value) == "" || strings.ContainsFunc(value, unicode.IsControl)) {
			return errors.New("INVALID_ARGUMENT: supply a single-line metadata summary, never prompt content")
		}
	}
	for _, key := range []string{"threadIds", "evidenceIds"} {
		for _, value := range axStrings(args[key]) {
			if !coordinationIdentifier(value) {
				return invalidCoordinationIdentifier()
			}
		}
	}
	for _, resource := range axStrings(args["resources"]) {
		if _, err := coordinationResource(resource); err != nil {
			return err
		}
		if lane := coordinationLaneShorthand(resource); lane != "" {
			registry, _ := cachedLoad(filepath.Join(root(), "coordination/projects.json"))
			return laneCoordinationError(lane, registry)
		}
	}
	return nil
}

func bulletinFailure(err error, op string) object {
	message := err.Error()
	code, _, _ := strings.Cut(message, ":")
	next := object{"op": nil, "hint": "Restore source authority or local coordination storage. Preserve state.json and the original receipt; rate-limited writes may retry after one minute."}
	switch {
	case strings.HasPrefix(message, "INVALID_ARGUMENT: use lane:<project>/<name>;"):
		next = object{"via": "query", "op": "projects", "args": object{}, "hint": message}
	case slices.Contains([]string{"COORDINATION_NOT_FOUND", "COORDINATION_REVISION_CONFLICT", "COORDINATION_STATE_CONFLICT", "COORDINATION_CURSOR_EXPIRED"}, code):
		next = object{"via": "query", "op": "board", "args": object{}, "hint": "Read the current board, restart pagination if needed, and retain the original mutation requestId"}
	case slices.Contains([]string{"INVALID_ARGUMENT", "RESOURCE_UNKNOWN", "RESOURCE_AMBIGUOUS"}, code):
		next = object{"via": "query", "op": "guide", "args": object{"op": op}, "hint": "Use the current metadata-only schema"}
	}
	return object{"state": "failed", "error": object{"code": code, "message": message}, "next": next}
}

func reconcileBulletin() error {
	pending, err := withBulletinStore(func(s *bulletinStore) ([]coordinationEventInput, error) {
		return slices.Clone(s.state.Pending[:min(64, len(s.state.Pending))]), nil
	})
	if err != nil {
		return err
	}
	for _, input := range pending {
		if _, err := emitCoordinationEvent(input); err != nil {
			return err
		}
		if input.Kind == "blocker.changed" && strPtr(input.Status) == "cleared" {
			for _, ref := range input.EvidenceRefs {
				if ref.Kind == "blocker" {
					if err := broadcastCoordinationRecovery(ref.ID); err != nil {
						return err
					}
				}
			}
		}
		_, err := withBulletinStore(func(s *bulletinStore) (struct{}, error) {
			s.state.Pending = slices.DeleteFunc(s.state.Pending, func(event coordinationEventInput) bool { return event.TransitionID == input.TransitionID })
			return struct{}{}, s.save(currentBulletinClock())
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func maintainBulletin(ctx context.Context) error {
	ctx = withRuntimeCost(ctx, "bulletinMaintenance", "poll")
	cost := currentRuntimeCost(ctx)
	var revoked []string
	if coordinationRevokedSources != nil {
		var err error
		revoked, err = coordinationRevokedSources()
		if err != nil {
			return err
		}
	}
	_, err := withBulletinStore(func(s *bulletinStore) (struct{}, error) {
		clock := currentBulletinClock()
		if err := s.cleanupDispatchAdmissions(clock, coordinationDispatchAdmission, cost); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, s.maintain(clock, revoked, cost)
	})
	return err
}

func bulletinAuthenticatedActivity(ctx context.Context, reader coordinationReader) error {
	if err := maintainBulletin(ctx); err != nil {
		return err
	}
	_, err := withBulletinStore(func(store *bulletinStore) (struct{}, error) {
		clock := currentBulletinClock()
		if clock.certain {
			for _, rows := range [][]*bulletinRecord{store.liveNotices, store.liveBlockers} {
				for _, row := range rows {
					if sameCoordinationOwner(row.Owner, reader.principal) && clock.elapsed > row.LastActiveAt {
						row.LastActiveAt, row.freshActivity, store.dirty = clock.elapsed, true, true
						store.maintainedAt = 0
					}
				}
			}
			for _, session := range store.state.Sessions {
				if session.State == "active" && sameCoordinationOwner(session.Owner, reader.principal) && clock.elapsed > session.LastActiveAt {
					session.LastActiveAt = clock.elapsed
					store.dirty = true
				}
			}
		}
		return struct{}{}, store.flush(clock)
	})
	return err
}

func bulletinVerifyFix(ctx context.Context, args object) error {
	fix := obj(args["fixingCommit"])
	if fix == nil {
		return nil
	}
	projectID, oid := text(fix, "projectId"), text(fix, "oid")
	if !coordinationIdentifier(projectID) {
		return invalidCoordinationIdentifier()
	}
	if !coordinationOIDPattern.MatchString(oid) {
		return errors.New("INVALID_ARGUMENT: fixingCommit requires a full Git object ID")
	}
	registry, err := cachedLoad(filepath.Join(root(), "coordination/projects.json"))
	if err != nil {
		return err
	}
	project := find(field(registry, "projects"), "id", projectID)
	if project == nil {
		return errors.New("COORDINATION_FIX_UNVERIFIED: refresh projects and select a registered local repository")
	}
	roots := arr(project["roots"])
	if roots == nil {
		return errors.New("COORDINATION_FIX_UNVERIFIED: registered repository unavailable")
	}
	for _, root := range roots[:min(8, len(roots))] {
		if coordinationLocalGit == nil {
			return errors.New(PortPending)
		}
		bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
		value, err := coordinationLocalGit(bounded, text(root, "path"), "cat-file", "-t", oid)
		cancel()
		if err == nil && strings.TrimSpace(value) == "commit" {
			return nil
		}
	}
	return errors.New("COORDINATION_FIX_UNVERIFIED: fixingCommit must exist as a commit in the registered local project; omit it only for an explicitly explained non-code recovery")
}

func bulletinCall(ctx context.Context, request operationRequest) (any, error) {
	request.args = clone(request.args)
	result, err := executeBulletin(ctx, request)
	if err == nil || err.Error() == PortPending {
		return result, err
	}
	return bulletinFailure(err, request.name), nil
}

func executeBulletin(ctx context.Context, request operationRequest) (object, error) {
	op, args := request.name, request.args
	if err := admitCoordinationResources(args); err != nil {
		return nil, err
	}
	if err := bulletinValidate(op, args); err != nil {
		return nil, err
	}
	reader, err := coordinationReadAuthority(ctx, request.source.local)
	if err != nil {
		return nil, err
	}
	if err := maintainBulletin(ctx); err != nil {
		return nil, err
	}
	projectionErr := reconcileBulletin()
	if coordinationImportRoutes != nil {
		if err := coordinationImportRoutes(); err != nil {
			return nil, err
		}
	}
	if op == "board" {
		return bulletinBoard(ctx, args, reader, projectionErr)
	}
	links := []bulletinLink{}
	if len(arr(args["threadIds"])) > 0 {
		links, err = linkedCoordinationThreads(ctx, request.service, args, reader.principal)
		if err != nil {
			return nil, err
		}
	}
	if op == "blocker_clear" {
		if err := bulletinVerifyFix(ctx, args); err != nil {
			return nil, err
		}
	}
	var route *coordinationRouteOutcome
	if target, exists := args["target"].(string); op == "coordination_session" && args["action"] == "register" && exists {
		source := reader.principal.SourceID
		if source == "" {
			return nil, errors.New("SOURCE_REQUIRED: a notification target requires a control source")
		}
		if coordinationVerifiedTarget == nil {
			return nil, errors.New(PortPending)
		}
		resolved, err := coordinationVerifiedTarget(ctx, source, target)
		if err != nil {
			return nil, err
		}
		route = &resolved
	}
	if args["requestId"] == nil {
		args["requestId"] = id()
	}
	requestID := text(args, "requestId")
	unlock := lockReceipt(requestID)
	defer unlock()
	digest := bulletinDigest(op, args, reader)
	session := text(request.service.metadata, "instance")
	receipts := coreReceiptStore()
	receipt, err := receipts.replay(ctx, requestID, digest, session)
	if err != nil {
		return nil, err
	}
	if receipt != nil {
		result := clone(obj(receipt["result"]))
		switch readReceiptState(text(receipt, "state"), true) {
		case receiptCompleted, receiptFailed:
			if result == nil {
				result = object{}
			}
			if err := bulletinSessionResult(ctx, op, args, result); err != nil {
				return nil, err
			}
			receipt["result"] = clone(result)
			result["receipt"] = receipt
			return result, nil
		default:
			result, err = withBulletinStore(func(store *bulletinStore) (object, error) { return store.replay(requestID, digest) })
			if err != nil {
				return nil, err
			}
			if result != nil {
				if err := bulletinSessionResult(ctx, op, args, result); err != nil {
					return nil, err
				}
				receipt["state"], receipt["result"] = "completed", clone(result)
				if err := receipts.checkpoint(ctx, receipt); err != nil {
					return nil, err
				}
				result["receipt"] = receipt
				return result, nil
			}
			age := currentBulletinClock().age(coordinationRecordTime(receipt, "createdAt"))
			if age == nil || *age >= 7*86400 {
				return nil, errors.New("COORDINATION_REPLAY_EXPIRED: the original incomplete receipt exceeds bulletin retention; inspect board and the original receipt before explicitly starting a new work scope")
			}
			return publicReceipt(receipt), nil
		}
	}
	receipt = object{"requestId": requestID, "operation": op, "digest": digest, "origin": currentOrigin(ctx), "backendSession": session, "state": "reserved", "createdAt": now()}
	if err := receipts.reserve(ctx, receipt); err != nil {
		return nil, err
	}
	owner, err := receipts.begin(ctx, receipt)
	if err != nil {
		return nil, err
	}
	defer owner.close()
	result, err := withBulletinStore(func(store *bulletinStore) (object, error) {
		return store.mutate(op, args, reader, links, route, currentBulletinClock())
	})
	if err == nil {
		receipt["state"] = "completed"
	} else {
		code, _, _ := strings.Cut(err.Error(), ":")
		if slices.Contains([]string{"COORDINATION_STORAGE", "COORDINATION_CAPACITY", "COORDINATION_RATE_LIMIT"}, code) {
			return nil, err
		}
		receipt["state"] = "failed"
		result = bulletinFailure(err, op)
	}
	if err := bulletinSessionResult(ctx, op, args, result); err != nil {
		return nil, err
	}
	projectionErr = reconcileBulletin()
	pending, err := withBulletinStore(func(store *bulletinStore) (bool, error) { return len(store.state.Pending) > 0, nil })
	if err != nil {
		return nil, err
	}
	result["projectionPending"] = projectionErr != nil || pending
	if op == "blocker_clear" {
		selection, err := bulletinRecoveryPlan(text(args, "id"))
		if err != nil {
			return nil, err
		}
		if selection != nil {
			result["recoverySelection"] = publicCoordinationRecovery(selection)
		}
	}
	receipt["result"] = clone(result)
	if err := receipts.checkpoint(ctx, receipt); err != nil {
		return nil, err
	}
	result["receipt"] = receipt
	return result, nil
}

func bulletinRecoveryPlan(id string) (object, error) {
	return withBulletinStore(func(store *bulletinStore) (object, error) {
		for _, row := range store.state.Blockers {
			if row.ID == id {
				return clone(row.RecoverySelection), nil
			}
		}
		return nil, nil
	})
}

func bulletinBoard(ctx context.Context, args object, reader coordinationReader, projectionErr error) (object, error) {
	result, err := withBulletinStore(func(store *bulletinStore) (object, error) {
		row, err := store.board(args, reader, currentBulletinClock())
		if err == nil {
			row["projectionPending"] = projectionErr != nil || len(store.state.Pending) > 0
		}
		return row, err
	})
	if err != nil {
		return nil, err
	}
	if sessions, ok := result["sessions"].([]object); ok {
		for _, session := range sessions {
			if err := coordinationSessionProjection(ctx, session); err != nil {
				return nil, err
			}
		}
	}
	result["attention"] = bulletinAttention(ctx, reader)
	if reader.principal.Type == "local-authority" && text(args, "id") != "" {
		plan, err := bulletinRecoveryPlan(text(args, "id"))
		if err != nil {
			return nil, err
		}
		if plan != nil {
			result["localRecoverySelection"] = plan
		}
	}
	return result, nil
}

func bulletinAttention(ctx context.Context, reader coordinationReader) object {
	items := []object{}
	coverage := object{"bulletin": "observed", "ax": "observed", "notifications": "unavailable"}
	if rows, err := withBulletinStore(func(store *bulletinStore) ([]object, error) { return store.attention(reader), nil }); err == nil {
		items = append(items, rows...)
	} else {
		coverage["bulletin"] = "unavailable"
	}
	if rows, err := coordinationAXAttention(reader); err == nil {
		items = append(items, rows...)
	} else {
		coverage["ax"] = "unavailable"
	}
	if coordinationNotificationAttention != nil {
		if value, err := coordinationNotificationAttention(ctx); err == nil {
			coverage["notifications"] = value["coverage"]
			items = append(items, bulletinNotificationItems(value, reader)...)
		}
	}
	for _, item := range items {
		actor := "user"
		if reader.principal.Type == "source" {
			actor = "you"
		} else if _, ok := item["ownerSourceId"].(string); ok {
			actor = "source"
		}
		item["requiredActor"] = actor
	}
	return object{"count": len(items), "items": items, "coverage": coverage}
}

func bulletinNotificationItems(notifications object, reader coordinationReader) []object {
	items := []object{}
	for _, problem := range arr(notifications["problems"]) {
		if reader.principal.Type == "source" && text(problem, "sourceId") != reader.principal.SourceID {
			continue
		}
		if len(items) == 20 {
			break
		}
		summary := text(problem, "target") + ": " + text(problem, "reason")
		if thread, ok := field(problem, "threadId").(string); ok {
			summary += " (thread " + thread + ")"
		}
		item := selectFields(problem, "id", "reason", "channel", "target", "threadId", "threadCount", "next")
		item["kind"], item["ownerSourceId"], item["summary"] = "notification", field(problem, "sourceId"), summary
		items = append(items, item)
	}
	return items
}

func bulletinSessionResult(ctx context.Context, op string, args, result object) error {
	session := obj(result["session"])
	if op != "coordination_session" || session == nil {
		return nil
	}
	if err := coordinationSessionProjection(ctx, session); err != nil {
		return err
	}
	result["deliveryCapability"], result["routing"] = session["deliveryCapability"], session["routing"]
	if args["action"] == "register" {
		switch {
		case args["target"] == nil:
			result["next"] = object{"via": "act", "op": "message_route", "args": object{"sessionId": session["id"], "target": "<your verified Claude session ID or URL>"}, "hint": "Replace target with your verified source-owned conversation target to enable push for this session."}
			result["hint"] = "Attach your verified target with message_route and keep this session open while you want push."
		case session["deliveryCapability"] == "pull-only":
			result["next"] = object{"via": "act", "op": "notify_control", "args": object{"action": "bind", "target": args["target"]}, "sessionId": session["id"], "hint": "Bind and verify this source-owned conversation target, acknowledge the received code with notification_ack, then use message_route with this sessionId and target."}
			result["hint"] = "Keep this session open while you want push."
		default:
			result["next"] = object{"via": "query", "op": "messages", "args": object{}}
			result["hint"] = "Keep this session open while you want push."
		}
	}
	return nil
}

func bulletinWarnings(ctx context.Context, resources []string, source string) object {
	if err := maintainBulletin(ctx); err == nil {
		value, err := withBulletinStore(func(store *bulletinStore) (object, error) {
			return store.advisory(resources, source, currentBulletinClock()), nil
		})
		if err == nil {
			return value
		}
	}
	return object{"conflicts": []object{}, "conflictCoverage": "unknown", "boardRevision": nil, "boardRead": object{"via": "query", "op": "board", "args": object{}}, "observedAt": now()}
}

func coordinationRepositoryResources(repository string) ([]string, error) {
	requested, err := filepath.EvalSymlinks(repository)
	if err != nil {
		return nil, errors.New("COORDINATION_RESOURCE_UNKNOWN: repository unavailable")
	}
	registry, err := cachedLoad(filepath.Join(root(), "coordination/projects.json"))
	if err != nil {
		return nil, err
	}
	var common string
	if coordinationGitCommon != nil {
		common, _ = coordinationGitCommon(requested)
	}
	matches := []string{}
	projects := arr(field(registry, "projects"))
	for _, project := range projects[:min(32, len(projects))] {
		roots := arr(field(project, "roots"))
		for _, root := range roots[:min(8, len(roots))] {
			path := text(root, "path")
			resolved, err := filepath.EvalSymlinks(path)
			same := false
			if common != "" && coordinationGitCommon != nil {
				candidate, _ := coordinationGitCommon(path)
				same = common == candidate
			}
			if same || err == nil && belowPath(requested, resolved) {
				key, err := coordinationResource("project:" + text(project, "id") + "/main")
				if err != nil {
					return nil, err
				}
				matches = append(matches, key)
				break
			}
		}
	}
	matches = axSet(matches)
	if len(matches) != 1 {
		return nil, errors.New("COORDINATION_RESOURCE_UNKNOWN: refresh projects or pull board before shared work")
	}
	return matches, nil
}

func bulletinDesktopCall(ctx context.Context, request operationRequest) (any, error) {
	value, err := bulletinCall(ctx, request)
	board := obj(value)
	if err != nil || request.name != "board" || board["error"] != nil {
		return value, err
	}
	problems := object{"problems": []object{}, "coverage": "unavailable"}
	if coordinationNotificationAttention != nil {
		if result, err := coordinationNotificationAttention(ctx); err == nil {
			problems = result
		}
	}
	board["notificationProblems"], board["notificationCoverage"] = problems["problems"], problems["coverage"]
	resources := []string{}
	for _, kind := range []string{"notices", "blockers"} {
		if rows, ok := board[kind].([]object); ok {
			for _, row := range rows {
				resources = append(resources, coordinationResourceStrings(row["resources"])...)
			}
		}
	}
	warnings := bulletinWarnings(ctx, resources, "")
	conflicts, _ := warnings["conflicts"].([]object)
	var notifications []object
	_ = unmarshalJSON([]byte(wire(board["notificationProblems"])), &notifications)
	for {
		board["conflicts"], board["notificationProblems"] = conflicts, notifications
		if len(wire(board)) <= 128*1024 {
			break
		}
		if len(conflicts) > 0 {
			conflicts = conflicts[:len(conflicts)-1]
			warnings["conflictCoverage"] = "partial"
		} else if len(notifications) > 0 {
			notifications = notifications[:len(notifications)-1]
			board["notificationCoverage"] = "partial"
		} else {
			break
		}
	}
	board["conflictCoverage"] = warnings["conflictCoverage"]
	return board, nil
}

func init() {
	for _, op := range []string{"board", "notice_post", "notice_update", "notice_close", "blocker_open", "blocker_clear", "coordination_session"} {
		registerOperation(op, bulletinCall, nil)
		if op != "coordination_session" {
			registerRoute("POST", "coordination/"+op, coordinationDesktopRequest(op, bulletinDesktopCall))
		}
	}
	registerRoute("POST", "coordination/conflicts", func(ctx context.Context, _ *service, body object, _ []string) (any, error) {
		keys, err := coordinationRepositoryResources(text(body, "repository"))
		if err == nil {
			if lane, ok := body["lane"].(string); ok {
				project := strings.TrimSuffix(strings.TrimPrefix(keys[0], "project:"), "/main")
				var resource string
				resource, err = coordinationResource("lane:" + project + "/" + lane)
				keys = append(keys, resource)
			}
			if instance, ok := body["instance"].(string); ok && err == nil {
				var resource string
				resource, err = coordinationResource("isolated:" + instance)
				keys = append(keys, resource)
			}
		}
		if err != nil {
			return object{"conflicts": []object{}, "conflictCoverage": "unknown"}, nil
		}
		return bulletinWarnings(ctx, keys, coordinationCommandSource(body)), nil
	})
}

func linkedCoordinationThreads(ctx context.Context, service *service, args object, actor coordinationPrincipal) ([]bulletinLink, error) {
	if taskTrackingDispatchRecords == nil {
		return nil, errors.New(PortPending)
	}
	threads := axStrings(args["threadIds"])
	live := taskTimelineLiveTurns(ctx, service, threads)
	clock := currentBulletinClock()
	result := make([]bulletinLink, 0, len(threads))
	for _, thread := range threads {
		records, err := taskTrackingDispatchRecords(thread)
		if err != nil {
			return nil, err
		}
		if len(records) == 0 {
			return nil, errors.New("COORDINATION_THREAD_UNAVAILABLE: link an evidenced thread dispatched by your source")
		}
		record := records[len(records)-1]
		origin, err := coordinationPrincipalFromOrigin(obj(record["origin"]))
		if err != nil {
			return nil, err
		}
		if origin == nil || !sameCoordinationOwner(actor, *origin) {
			return nil, errors.New("COORDINATION_OWNER_REQUIRED: thread links require your own dispatch origin")
		}
		turn := axOptional(record["turnId"])
		status := coordinationTerminalStatus(record, text(record["terminal"], "state"))
		if status == "" && field(record, "_turnLifecycle") != nil {
			status = trackedTurnStatus(record["_turnLifecycle"])
		}
		link := bulletinLink{ThreadID: thread, ObservedTurnID: turn, ScopeState: coordinationScope(status), Terminals: map[string]any{}}
		if session := text(args, "sessionId"); session != "" && origin.SourceID != "" {
			sessions, err := coordinationSessionRoutes(origin.SourceID)
			if err != nil {
				return nil, err
			}
			for _, row := range sessions {
				if row.ID == session && row.Route != nil {
					link.SessionBindingID = row.Route.BindingID
					break
				}
			}
		}
		if turn != nil {
			checkpoint := obj(record["_turnLifecycle"])
			if checkpoint == nil {
				checkpoint = trackedCheckpoint(nonemptyTaskText(text(record, "agent"), "codex"), thread, *turn, status, 0)
			}
			link.Terminals[*turn] = checkpoint
			for _, observed := range live {
				if observed.Thread == thread && observed.Turn == *turn {
					mergeBulletinLink(&link, *turn, observed.Status, observed.Checkpoint)
					if link.ScopeState != "unknown" {
						link.ObservedAt = new(clock.elapsed)
					}
					break
				}
			}
			if link.ObservedAt == nil && text(record, "agent") == "codex" && readCoordinationCodexHead != nil {
				bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
				head, err := readCoordinationCodexHead(bounded, service, thread)
				cancel()
				if err == nil && text(head, "id") == *turn {
					mergeBulletinLink(&link, *turn, text(head, "status"), obj(head["_turnLifecycle"]))
					if link.ScopeState != "unknown" {
						link.ObservedAt = new(clock.elapsed)
					}
				}
			}
		}
		result = append(result, link)
	}
	return result, nil
}
