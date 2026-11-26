package core

import (
	"context"
	"errors"
	"maps"
	"slices"
	"time"
)

func readCodexMetadata(ctx context.Context, s *service, thread string) (object, error) {
	value, err := requestCodexNative(ctx, s, "thread/read", object{"threadId": thread, "includeTurns": false}, time.Minute)
	return obj(field(value, "thread")), err
}

func readCodexControl(ctx context.Context, r operationRequest) (any, error) {
	args, s := r.args, r.service
	id := text(args, "threadId")
	thread, err := readCodexMetadata(ctx, s, id)
	if err != nil {
		return nil, err
	}
	if thread["id"] != id {
		return nil, errors.New("native-thread-id-mismatch")
	}
	deadline := time.Now().Add(time.Duration(min(uintOr(args["waitMs"], 0), 10000)) * time.Millisecond)
	for field(thread["status"], "type") == "active" && time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
		thread, err = readCodexMetadata(ctx, s, id)
		if err != nil {
			return nil, err
		}
	}
	external := false
	if _, home, err := codexInputs(); err == nil && probeWriter(home, id)["state"] == "held" {
		external = s.nativeWriterOwnership(ctx, home, id)["owner"] == "external"
	}
	project := func(result object) object {
		if external {
			result["readObservation"] = object{"source": "native-app-server", "degraded": true, "staleness": "unknown", "reason": "external-writer-held", "observedAt": now()}
		}
		return result
	}

	statusOnly, summary, full, review := args["statusOnly"] == true, args["view"] == "summary", args["view"] == "full", args["view"] == "review"
	params := maps.Clone(args)
	if full && params["limit"] == nil {
		params["limit"] = 2
	}
	page, err := readCodexTurnPage(ctx, s, params)
	if err != nil {
		return nil, err
	}
	raw := arr(page["data"])
	turns := slices.Clone(raw)
	slices.Reverse(turns)
	if turns == nil {
		turns = []any{}
	}
	thread["turns"] = turns
	selected := optionalProjectString(args["turnId"])
	if selected == nil && len(raw) > 0 {
		selected = optionalProjectString(field(raw[0], "id"))
	}
	if _, home, err := codexInputs(); err == nil && selected != nil {
		if row := find(raw, "id", *selected); row != nil && (field(row, "status") == "interrupted" || field(row, "status") == "cancelled") {
			history, _ := readNativeHistory(home, thread)
			reconcileNativeInterruption(thread, selected, history)
		}
	}
	pending := s.events.pendingInteractions()
	status, lifecycle := classifyCodexObservation(object{"thread": thread, "pending": pending}, &selected)
	applyCodexProgress(ctx, &s.events, status, thread)
	if nativeTurnConflict(lifecycle) != nil {
		status["_turnLifecycle"] = lifecycle.checkpoint()
		if err := handleNotificationObservation(ctx, s, id, text(status, "turnId"), status); err != nil {
			recordLog("WARN", "Notification conflict: "+err.Error(), nil)
		}
		delete(status, "_turnLifecycle")
	}
	if statusOnly || summary {
		if summary {
			if turn := find(raw, "id", text(status, "turnId")); turn != nil {
				if err := addCodexTaskSummaryEvidence(ctx, id, status, turn); err != nil {
					return nil, err
				}
			}
			if usage := readNativeTurnDispatchField(id, text(status, "turnId"), "usage"); usage != nil {
				status["usage"] = usage
			}
		} else if args["turnId"] == nil {
			status["turns"], status["stateScope"] = nil, "turn"
			if progress := obj(status["progress"]); progress != nil {
				enrichNativeReviewProgress(ctx, id, progress)
			}
		}
		return project(status), nil
	}
	if review {
		rows := make([]any, 0, len(raw))
		for _, turn := range raw {
			rows = append(rows, nativeControlReviewTurn(ctx, id, turn))
		}
		return project(object{"threadId": id, "turns": rows, "nextCursor": page["nextCursor"]}), nil
	}

	result := object{"threadId": id, "title": thread["name"], "runtimeStatus": field(thread["status"], "type"), "observedAt": now()}
	if full {
		result = summarizeControlThread(thread)
	} else if len(arr(field(thread["status"], "activeFlags"))) != 0 {
		result["activeFlags"] = field(thread["status"], "activeFlags")
	}
	src, err := taskSRCReference("codex", id)
	if err != nil {
		return nil, err
	}
	result["origin"] = taskSourceOrigin(id, nil)
	result["srcConversation"], result["nextCursor"], result["stateScope"] = src, page["nextCursor"], "turn"
	for _, key := range []string{"state", "reason", "turnId", "recordedStatus", "progressStalled", "progress", "next"} {
		result[key] = status[key]
	}
	if err := observeExternalInputs(id, turns, nil); err != nil {
		return nil, err
	}
	inputs, err := externalUserInputs(id, nil)
	if err != nil {
		return nil, err
	}
	result["externalUserInputs"] = slices.DeleteFunc(inputs, func(row any) bool {
		return !slices.ContainsFunc(turns, func(turn any) bool {
			return field(row, "turnId") == field(turn, "id") || field(row, "answeredTurnId") == field(turn, "id")
		})
	})
	rows := make([]any, 0, len(raw))
	for _, turn := range raw {
		row, shortened, err := nativeControlReadTurn(id, turn, full, args["includeItemKeys"] == true)
		if err != nil {
			return nil, err
		}
		if shortened && !full {
			result["readMore"] = "Use codex_items with threadId, turnId and view:full for complete items and text pagination."
		}
		rows = append(rows, row)
	}
	result["turns"] = rows
	if args["includeImages"] == true {
		var items []any
		for _, turn := range raw {
			turnItems := arr(field(turn, "items"))
			tail := turnItems[max(0, len(turnItems)-15):]
			for _, item := range slices.Backward(tail) {
				items = append(items, item)
			}
		}
		attachNativeImages(result, nativeImagesFromItems(items, id, text(thread, "cwd"), args))
	}
	if full {
		reviews, err := dispatchReviews(id)
		if err != nil {
			result["reviews"] = object{"unavailable": err.Error()}
		} else {
			result["reviews"] = reviews
		}
	}
	return project(result), nil
}

func readNativeTurnDispatchField(thread, turn, key string) any {
	rows, _ := dispatchRecords(thread)
	for _, row := range slices.Backward(rows) {
		if row["turnId"] == turn && row[key] != nil {
			return row[key]
		}
	}
	return nil
}

func nativeControlReviewTurn(ctx context.Context, thread string, turn any) object {
	items := arr(field(turn, "items"))
	checks := []any{}
	for _, item := range items {
		if field(item, "type") == "commandExecution" {
			if cmd := reviewCommand(item); cmd != "" {
				checks = append(checks, object{"command": cmd, "exitCode": field(item, "exitCode"), "summary": reviewCheckSummary(item)})
			}
		}
	}
	var message any
	for _, item := range slices.Backward(items) {
		if field(item, "type") == "agentMessage" && field(item, "phase") != "commentary" {
			message = field(item, "text")
			break
		}
	}
	id := text(turn, "id")
	out := object{"turnId": id, "recordedStatus": field(turn, "status"), "finalResponse": message, "checks": checks}
	evidence := reviewNativeChangeEvidence(ctx, thread, turn)
	for _, key := range []string{"files", "changeEvidence", "attribution", "reason", "next"} {
		if value, found := evidence[key]; found {
			out[key] = value
		}
	}
	for _, key := range []string{"usage", "pack"} {
		if value := dispatchTurnFact(thread, id, key); value != nil {
			out[key] = value
		}
	}
	return out
}

func nativeControlReadTurn(thread string, turn any, full, includeKeys bool) (object, bool, error) {
	id := text(turn, "id")
	items := []any{}
	shortened := false
	for _, item := range arr(field(turn, "items")) {
		var projected object
		if full {
			projected = nativeItemExcerpt(obj(item), 0, 600)
		} else {
			projected = compactNativeItem(obj(item), 600)
			if projected == nil {
				continue
			}
			if includeKeys && projected["truncated"] != true {
				projected["itemKey"] = nativeItemKey(thread, id, item)
			}
			shortened = shortened || projected["truncated"] == true
		}
		items = append(items, projected)
	}
	first := max(0, len(items)-15)
	inputs, err := externalUserInputs(thread, &id)
	if err != nil {
		return nil, false, err
	}
	row := object{"origin": taskSourceOrigin(thread, &id), "turnId": id, "recordedStatus": field(turn, "status"), "items": items[first:], "externalUserInputs": inputs}
	if first > 0 {
		row["itemsTruncated"] = true
	}
	if err := field(turn, "error"); err != nil {
		row["error"] = err
	}
	if full {
		row["effectiveConfiguration"] = object{"source": "unavailable", "model": "unknown", "effort": "unknown"}
	}
	retry, err := notificationRetryStatus(thread, id)
	if err != nil {
		return nil, false, err
	}
	if retry != nil {
		row["retry"] = retry
	}
	if usage := readNativeTurnDispatchField(thread, id, "usage"); usage != nil {
		row["usage"] = usage
	}
	return row, shortened || first > 0, nil
}

func readCodexItems(ctx context.Context, r operationRequest) (any, error) {
	args := r.args
	full, latest := args["view"] == "full", args["latest"] == true
	if !full && (uintOr(args["offset"], 0) > 0 || args["expectedHash"] != nil) {
		return nil, dispatchObjectError(invalidArguments("codex_items", "/view", "Use view:full for offset/expectedHash text pagination."))
	}
	if full && arr(args["knownItemKeys"]) != nil {
		return nil, dispatchObjectError(invalidArguments("codex_items", "/knownItemKeys", "Use compact view to omit known compact items; full view retains all metadata."))
	}
	params := maps.Clone(args)
	params["sortDirection"] = "asc"
	if latest {
		params["sortDirection"] = "desc"
		if args["turnId"] == nil {
			if args["cursor"] != nil {
				return nil, errors.New("LATEST_CURSOR_REQUIRES_TURN_ID: continue with the returned turnId, cursor and latest=true")
			}
			page, err := requestCodexNative(ctx, r.service, "thread/turns/list", object{"threadId": args["threadId"], "limit": 1, "sortDirection": "desc", "itemsView": "notLoaded"}, time.Minute)
			if err != nil {
				return nil, err
			}
			turns := arr(field(page, "data"))
			if turns == nil {
				return nil, errors.New("INVALID_TURN_LIST")
			}
			if len(turns) == 0 {
				return object{"threadId": args["threadId"], "turnId": nil, "items": []any{}, "nextCursor": nil, "observedAt": now()}, nil
			}
			if params["turnId"] = text(turns[0], "id"); params["turnId"] == "" {
				return nil, errors.New("INVALID_TURN_ID")
			}
		}
	}
	for _, key := range []string{"offset", "length", "expectedHash", "includeImages", "maxImages", "latest", "view", "knownItemKeys", "includeItemKeys"} {
		delete(params, key)
	}
	page, err := requestCodexNative(ctx, r.service, "thread/items/list", params, time.Minute)
	if err != nil {
		return nil, err
	}
	items := []any{}
	omitted, truncated := 0, false
	known := arr(args["knownItemKeys"])
	length := uintOr(args["length"], 6000)
	for _, row := range arr(field(page, "data")) {
		item, turn := field(row, "item"), field(row, "turnId")
		var projection object
		if full {
			projection = nativeItemExcerpt(obj(item), uintOr(args["offset"], 0), length)
		} else {
			var key string
			if len(known) > 0 || args["includeItemKeys"] == true {
				key = nativeItemKey(text(args, "threadId"), str(turn), item)
				if slices.Contains(known, any(key)) {
					omitted++
					continue
				}
			}
			projection = compactNativeItem(obj(item), int(length))
			if projection == nil {
				continue
			}
			if args["includeItemKeys"] == true && projection["truncated"] != true {
				projection["itemKey"] = key
			}
			truncated = truncated || projection["truncated"] == true
		}
		projection["turnId"] = turn
		items = append(items, projection)
	}
	if expected, ok := args["expectedHash"].(string); ok && (len(items) == 0 || field(items[0], "textHash") != expected) {
		return nil, errors.New("CONTENT_CHANGED")
	}
	result := object{"threadId": args["threadId"], "items": items, "nextCursor": field(page, "nextCursor"), "observedAt": now()}
	if omitted > 0 {
		result["omittedKnownItems"] = omitted
	}
	if latest {
		result["turnId"] = params["turnId"]
	}
	if truncated {
		result["readMore"] = "Repeat this page with view:full for textHash/offset/nextOffset pagination."
	}
	if err := attachCodexItemImages(ctx, r, result, page, latest); err != nil {
		return nil, err
	}
	return result, nil
}

func init() {
	registerOperation("codex_read", readCodexControl, nil)
	registerOperation("codex_items", readCodexItems, nil)
}
