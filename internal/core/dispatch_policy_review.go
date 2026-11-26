package core

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// A projects native turn evidence for codex_review and agent_review. D supplies
// the optional native interval's gateway usage.
var dispatchNativeTurnOutcome func(string, []any, string) (string, any)
var dispatchNativeTurnMetadata func(object, string) (timing, configuration object)
var mergeDispatchLifecycle func(object, any) (state string, checkpoint any)

func dispatchReviewConfiguration(metadata ...object) object {
	configuration := object{"model": nil, "effort": nil, "serviceTier": nil}
	for _, field := range []struct {
		name    string
		aliases []string
	}{
		{"model", []string{"model"}}, {"effort", []string{"effort", "reasoningEffort", "reasoning_effort", "thinkingLevel"}},
		{"serviceTier", []string{"serviceTierForTurn", "serviceTier", "service_tier"}},
	} {
		for _, value := range metadata {
			for _, alias := range field.aliases {
				if v := text(value, alias); v != "" && v != "unknown" {
					configuration[field.name] = v
					break
				}
			}
			if configuration[field.name] != nil {
				break
			}
		}
	}
	return configuration
}

func dispatchTerminalSnapshot(row object, state string, timing object, lastActivity string, reconciled bool) object {
	if !notificationTerminal(state) {
		return nil
	}
	if state == "interrupted" {
		state = "cancelled"
	}
	observed := now()
	var end any
	basis := "unknown"
	switch {
	case text(timing, "endedAt") != "":
		end, basis = timing["endedAt"], "native-terminal"
	case lastActivity != "":
		end, basis = lastActivity, "last-observed-activity"
	case !reconciled:
		end, basis = observed, "observed-terminal"
	}
	start := str(dispatchFirstString(timing["startedAt"], row["submittedAt"]))
	var elapsed any
	if a, err := time.Parse(time.RFC3339Nano, start); err == nil {
		if b, err := time.Parse(time.RFC3339Nano, str(end)); err == nil {
			elapsed = max(b.Sub(a).Milliseconds(), 0)
		}
	}
	return object{"state": state, "observedAt": observed, "endedAt": end, "observedDurationMs": elapsed,
		"reconciledAfterRestart": reconciled, "timeBasis": basis}
}

func recordDispatchOutcome(row object, incoming any, timing object, lastActivity string, reconciled bool) {
	if mergeDispatchLifecycle == nil {
		return
	}
	previous := dispatchOutcome(row)
	state, checkpoint := mergeDispatchLifecycle(row, incoming)
	row["_turnLifecycle"] = checkpoint
	if !notificationTerminal(state) {
		row["terminal"] = nil
	} else if state != previous || obj(row["terminal"]) == nil {
		row["terminal"] = dispatchTerminalSnapshot(row, state, timing, lastActivity, reconciled)
	} else {
		terminal := obj(row["terminal"])
		if state == "interrupted" {
			state = "cancelled"
		}
		terminal["state"] = state
	}
}

func completeDispatch(ctx context.Context, s *service, thread, turn string, incoming any, lastActivity string, reconciled bool) ([]object, error) {
	rows, err := dispatchRecords(thread)
	if err != nil {
		return nil, err
	}
	rows = slices.DeleteFunc(rows, func(row object) bool { return row["turnId"] != turn })
	if len(rows) == 0 {
		return nil, nil
	}
	var timing, config, usage object
	if nativeControlRequest != nil && dispatchNativeTurnMetadata != nil {
		if native, err := nativeControlRequest(ctx, s, "thread/read", object{"threadId": thread, "includeTurns": false}, 5*time.Second); err == nil {
			timing, config = dispatchNativeTurnMetadata(obj(field(native, "thread")), turn)
		}
	}
	if mergeDispatchLifecycle != nil {
		state, _ := mergeDispatchLifecycle(rows[0], incoming)
		if notificationTerminal(state) && slices.ContainsFunc(rows, func(v object) bool { return v["usage"] == nil }) {
			start := str(dispatchFirstString(timing["startedAt"], rows[0]["submittedAt"]))
			end := text(timing, "endedAt")
			if end == "" {
				end = lastActivity
			}
			if end == "" && !reconciled {
				end = now()
			}
			usage = fetchGatewayTurnUsage(ctx, "codex", thread, start, end)
		}
	}
	return updateDispatchTurnRows(thread, turn, "", func(row object) {
		recordDispatchOutcome(row, incoming, timing, lastActivity, reconciled)
		if config != nil {
			row["effectiveConfiguration"] = object{"model": config["model"], "effort": config["effort"], "serviceTier": config["serviceTier"],
				"threadServiceTier": config["threadServiceTier"], "source": config["source"]}
		}
		if row["usage"] == nil && usage != nil {
			row["usage"] = usage
		}
	})
}

func updateDispatchTurnRows(thread, turn, agent string, update func(object)) ([]object, error) {
	dispatchRecordsMu.Lock()
	defer dispatchRecordsMu.Unlock()
	dir, err := dispatchRecordDir(thread)
	if err != nil {
		return nil, err
	}
	rows, err := readDispatchRows(dir)
	if err != nil {
		return nil, err
	}
	rows = slices.DeleteFunc(rows, func(row object) bool {
		return row["turnId"] != turn || agent != "" && row["agent"] != agent
	})
	for _, row := range rows {
		update(row)
		requestID := text(row, "requestId")
		if !routeID.MatchString(requestID) || requestID == "." || requestID == ".." {
			return nil, errors.New("INVALID_REQUEST_ID")
		}
		if err := saveDispatchRecord(filepath.Join(dir, requestID+".json"), row); err != nil {
			return nil, err
		}
	}
	return rows, nil
}

func dispatchReviewRecord(args, origin, dispatch, external object, reviewedAt string) object {
	review := object{"verdict": args["verdict"], "note": args["note"], "reviewedAt": reviewedAt, "requestId": args["requestId"],
		"reviewer":       object{"sourceId": origin["sourceId"], "controlSource": origin["controlSource"], "sessionId": origin["sessionId"], "target": origin["target"]},
		"dispatchOrigin": "arc", "dispatchRequestId": dispatch["requestId"]}
	if dispatch == nil {
		review["dispatchOrigin"] = "external"
		for _, key := range []string{"model", "effort", "serviceTier"} {
			review[key] = external[key]
		}
	}
	for _, key := range []string{"foundBy", "defects", "advisory"} {
		review[key] = args[key]
	}
	if classes, ok := args["defectClasses"]; ok {
		review["defectClasses"] = classes
	}
	normalizeDispatchReview(review, false)
	return review
}

func dispatchExternalReviewPath(thread, turn string) string {
	return filepath.Join(root(), "reviews", thread, hash([]byte(turn))+".json")
}

func dispatchRowsForReview(thread string) ([]object, []object, error) {
	rows, err := readDispatchRecords(thread)
	if err != nil {
		return nil, nil, err
	}
	external, err := readDispatchRows(filepath.Join(root(), "reviews", thread))
	return rows, external, err
}

func dispatchReviews(thread string) ([]any, error) {
	dispatchRecordsMu.Lock()
	defer dispatchRecordsMu.Unlock()
	rows, external, err := dispatchRowsForReview(thread)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	result := []any{}
	for _, row := range append(rows, external...) {
		turn := text(row, "turnId")
		if obj(row["review"]) != nil && !seen[turn] {
			result = append(result, object{"turnId": row["turnId"], "review": row["review"]})
			seen[turn] = true
		}
	}
	return result, nil
}

func dispatchLocalReviewMatches(rows []object, request string) bool {
	return len(rows) != 0 && !slices.ContainsFunc(rows, func(row object) bool {
		review := obj(row["review"])
		return review["requestId"] != request || review["verdict"] != "pass" || field(review["reviewer"], "controlSource") != "ARC"
	})
}

func undoDispatchLocalReview(thread, turn, request string) (object, error) {
	dispatchRecordsMu.Lock()
	defer dispatchRecordsMu.Unlock()
	rows, external, err := dispatchRowsForReview(thread)
	if err != nil {
		return nil, err
	}
	isOtherTurn := func(row object) bool { return row["turnId"] != turn }
	rows = slices.DeleteFunc(rows, isOtherTurn)
	isExternal := len(rows) == 0
	if isExternal {
		rows = slices.DeleteFunc(external, isOtherTurn)
	}
	if !dispatchLocalReviewMatches(rows, request) {
		return nil, errors.New("REVIEW_CHANGED: reload the task before undoing a local pass review")
	}
	dir, _ := dispatchRecordDir(thread)
	for _, row := range rows {
		delete(row, "review")
		if observations := arr(row["reviewObservations"]); observations != nil {
			row["reviewObservations"] = slices.DeleteFunc(slices.Clone(observations), func(obs any) bool { return field(obs, "requestId") == request })
		}
		path := dispatchExternalReviewPath(thread, turn)
		if !isExternal {
			requestID := text(row, "requestId")
			if !routeID.MatchString(requestID) {
				return nil, errors.New("INVALID_REQUEST_ID")
			}
			path = filepath.Join(dir, requestID+".json")
		}
		if err := save(path, row); err != nil {
			return nil, err
		}
	}
	return object{"undone": true, "turnId": turn}, nil
}

func saveDispatchReview(ctx context.Context, thread, turn string, args, external object) (object, error) {
	dispatchRecordsMu.Lock()
	defer dispatchRecordsMu.Unlock()
	dir, err := dispatchRecordDir(thread)
	if err != nil {
		return nil, err
	}
	rows, err := readDispatchRows(dir)
	if err != nil {
		return nil, err
	}
	if v := text(args, "verdict"); v != "pass" && v != "rework" {
		return nil, errors.New("INVALID_REVIEW_VERDICT: use pass or rework")
	}
	rows = slices.DeleteFunc(rows, func(r object) bool { return r["turnId"] != turn })
	var dispatch object
	if len(rows) != 0 {
		dispatch = rows[0]
		for _, row := range rows {
			if row["dispatchMode"] == "new-turn" {
				dispatch = row
				break
			}
		}
	}
	review := dispatchReviewRecord(args, currentOrigin(ctx), dispatch, external, now())
	if dispatch == nil {
		path := dispatchExternalReviewPath(thread, turn)
		row, err := readDispatchRecord(ctx, path)
		if errors.Is(err, os.ErrNotExist) {
			row, err = clone(external), nil
		}
		if err != nil {
			return nil, err
		}
		if row == nil {
			return nil, errors.New("REVIEW_TERMINAL_TURN_NOT_FOUND")
		}
		attachDispatchReview(row, review)
		if err := save(path, row); err != nil {
			return nil, err
		}
	} else {
		for _, row := range rows {
			attachDispatchReview(row, review)
			requestID := text(row, "requestId")
			if !routeID.MatchString(requestID) {
				return nil, errors.New("INVALID_REQUEST_ID")
			}
			if err := save(filepath.Join(dir, requestID+".json"), row); err != nil {
				return nil, err
			}
		}
	}
	return object{"threadId": thread, "turnId": turn, "review": review}, nil
}

func dispatchCodexReview(ctx context.Context, r operationRequest) (any, error) {
	return runControlMutation(ctx, r, "review", r.args, func(ctx context.Context, receipt object) (any, error) {
		args := obj(receipt["arguments"])
		thread := text(args, "threadId")
		if _, err := dispatchRecordDir(thread); err != nil {
			return nil, err
		}
		var cursor any
		for {
			page, err := nativeControlRequest(ctx, r.service, "thread/turns/list", object{"threadId": thread,
				"limit": 20, "sortDirection": "desc", "itemsView": "notLoaded", "cursor": cursor}, 10*time.Second)
			if err != nil {
				return nil, err
			}
			turns, ok := field(page, "data").([]any)
			if !ok {
				return nil, errors.New("NATIVE_TURNS_MISSING")
			}
			for _, item := range turns {
				selected := obj(item)
				turn := text(selected, "id")
				requested, supplied := args["turnId"].(string)
				if supplied && requested != turn {
					continue
				}
				state, checkpoint := dispatchNativeTurnOutcome(thread, turns, turn)
				if !notificationTerminal(state) {
					if supplied {
						return nil, errors.New("REVIEW_REQUIRES_TERMINAL_TURN")
					}
					continue
				}
				rows, err := completeDispatch(ctx, r.service, thread, turn, checkpoint, "", false)
				if err != nil {
					return nil, err
				}
				if len(rows) != 0 {
					return saveDispatchReview(ctx, thread, turn, args, nil)
				}
				metadata, _ := nativeControlRequest(ctx, r.service, "thread/read", object{"threadId": thread, "includeTurns": false}, 10*time.Second)
				native := obj(field(metadata, "thread"))
				var persisted object
				if dispatchNativeTurnMetadata != nil {
					_, persisted = dispatchNativeTurnMetadata(native, turn)
				}
				external := dispatchReviewConfiguration(persisted, selected, native)
				external["agent"], external["threadId"], external["taskId"], external["turnId"] = "codex", thread, thread, turn
				external["dispatchOrigin"], external["options"], external["terminal"], external["_turnLifecycle"] =
					"external", object{}, object{"state": state}, checkpoint
				return saveDispatchReview(ctx, thread, turn, args, external)
			}
			cursor = field(page, "nextCursor")
			if cursor == nil {
				return nil, errors.New("REVIEW_TERMINAL_TURN_NOT_FOUND")
			}
		}
	})
}

func dispatchReviewsOperation(_ context.Context, r operationRequest) (any, error) {
	reviews, err := dispatchReviews(text(r.args, "id"))
	return object{"reviews": reviews}, err
}

func dispatchReviewUndoOperation(_ context.Context, r operationRequest) (any, error) {
	return undoDispatchLocalReview(text(r.args, "id"), text(r.args, "turnId"), text(r.args, "reviewRequestId"))
}

func init() {
	registerOperation("codex_review", dispatchCodexReview, nil)
	registerOperation("task_reviews", dispatchReviewsOperation, nil)
	registerOperation("task_review_undo", dispatchReviewUndoOperation, nil)
	for _, spec := range []struct {
		name, path string
		call       operationHandler
	}{
		{"tasks.reviews", "tasks/reviews", dispatchReviewsOperation},
		{"tasks.reviews.undo", "tasks/reviews/undo", dispatchReviewUndoOperation},
	} {
		registerRoute(http.MethodPost, spec.path, func(ctx context.Context, s *service, args object, _ []string) (any, error) {
			if _, _, _, err := managementResolve(spec.name, object{"body": args}); err != nil {
				return nil, err
			}
			return spec.call(ctx, operationRequest{args: args, service: s})
		})
	}
}

func reviewAgentDispatch(ctx context.Context, args, snapshot object) (object, error) {
	task, agent := text(args, "taskId"), text(args, "agent")
	dispatchRecordsMu.Lock()
	owned, external, err := dispatchRowsForReview(task)
	dispatchRecordsMu.Unlock()
	if err != nil {
		return nil, err
	}
	rows := append(owned, external...)
	latest := text(snapshot, "turnId")
	byTurn := map[string]bool{}
	for _, row := range rows {
		byTurn[text(row, "turnId")] = true
	}
	newRow := func(turn string, metadata ...object) object {
		conf := dispatchReviewConfiguration(metadata...)
		conf["agent"], conf["taskId"], conf["threadId"], conf["turnId"] = snapshot["agent"], task, task, turn
		conf["dispatchOrigin"], conf["options"] = "external", object{}
		return conf
	}
	if latest != "" && !byTurn[latest] {
		row := newRow(latest, obj(snapshot["turnEvidence"]), snapshot, obj(snapshot["options"]), obj(snapshot["metadata"]))
		if options, exists := snapshot["options"]; exists {
			row["options"] = options
		}
		row["observedAt"], row["_turnLifecycle"], row["terminal"] = snapshot["updatedAt"], snapshot["_turnLifecycle"], nil
		rows = append(rows, row)
	}
	tracking := obj(snapshot["tracking"])
	for _, turn := range keys(obj(tracking["turnStatuses"])) {
		if byTurn[turn] || turn == latest {
			continue
		}
		row := newRow(turn, obj(field(tracking["turnDispatchSummaries"], turn)))
		row["observedAt"] = field(field(tracking["turnTimings"], turn), "endedAt")
		row["_turnLifecycle"] = field(tracking["turnLifecycles"], turn)
		row["terminal"] = object{"state": field(tracking["turnStatuses"], turn)}
		rows = append(rows, row)
	}
	requested, supplied := args["turnId"].(string)
	var best object
	var rank string
	for _, row := range rows {
		turn := text(row, "turnId")
		status := field(tracking["turnStatuses"], turn)
		checkpoint := field(tracking["turnLifecycles"], turn)
		if turn == latest {
			status, checkpoint = snapshot["status"], snapshot["_turnLifecycle"]
		}
		incoming := turnSnapshot(turnKey{agent, task, turn}, str(status), checkpoint).checkpoint()
		recordDispatchOutcome(row, incoming, nil, "", true)
		if row["agent"] != agent || supplied && turn != requested || !supplied && !notificationTerminal(dispatchOutcome(row)) {
			continue
		}
		nextRank := str(dispatchFirstString(row["submittedAt"], row["observedAt"]))
		if turn == latest {
			nextRank = "~"
		}
		if best == nil || nextRank >= rank {
			best, rank = row, nextRank
		}
	}
	if best == nil {
		return nil, errors.New("REVIEW_TERMINAL_TURN_NOT_FOUND")
	}
	if !notificationTerminal(dispatchOutcome(best)) {
		return nil, errors.New("REVIEW_REQUIRES_TERMINAL_TURN")
	}
	result, err := saveDispatchReview(ctx, task, text(best, "turnId"), args, best)
	if err == nil {
		delete(result, "threadId")
		result["agent"], result["taskId"] = agent, task
	}
	return result, err
}
