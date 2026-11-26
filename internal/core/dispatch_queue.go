package core

import (
	"cmp"
	"context"
	"errors"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type nativeDispatchQueue struct {
	sync.Mutex
	files  *fileCollection[object]
	active map[string]object
}

func queuePath(queueID string) (string, error) {
	if uuid.Validate(queueID) != nil {
		return "", errors.New("INVALID_QUEUE_ID")
	}
	return filepath.Join(root(), "send-queue", queueID+".json"), nil
}

func (q *nativeDispatchQueue) refresh() error {
	if q.files == nil {
		q.files = newFileCollection[object](filepath.Join(root(), "send-queue"))
	}
	if q.active == nil {
		q.active = map[string]object{}
	}
	dirty, err := q.files.refresh(func(path string) (object, error) {
		value, err := cachedLoad(path)
		if err != nil && strings.HasPrefix(err.Error(), "INVALID_JSON:") {
			return nil, nil
		}
		return obj(value), err
	})
	if err != nil {
		return err
	}
	for _, path := range dirty {
		if row := q.files.rows[path]; validCodexQueueRow(row) && dispatchQueueRunnable(row) {
			q.active[path] = row
		} else {
			delete(q.active, path)
		}
	}
	return nil
}

func validCodexQueueRow(row object) bool {
	return uuid.Validate(text(row, "queueId")) == nil && text(row, "threadId") != "" && obj(row["args"]) != nil
}

func sortedCodexQueueRows(source map[string]object) []object {
	rows := []object{}
	for _, path := range slices.Sorted(maps.Keys(source)) {
		if row := source[path]; validCodexQueueRow(row) {
			rows = append(rows, clone(row))
		}
	}
	slices.SortStableFunc(rows, func(a, b object) int { return cmp.Compare(uintOr(a["sequence"], 0), uintOr(b["sequence"], 0)) })
	return rows
}

func (q *nativeDispatchQueue) records() ([]object, error) {
	if err := q.refresh(); err != nil {
		return nil, err
	}
	return sortedCodexQueueRows(q.files.rows), nil
}

func (q *nativeDispatchQueue) save(row object) error {
	path, err := queuePath(text(row, "queueId"))
	if err != nil {
		return err
	}
	if old, err := cachedLoad(path); err == nil && wire(old) == wire(row) {
		return nil
	}
	return save(path, row)
}

func dispatchQueueVisible(row, origin object) bool {
	return origin["authType"] == "local" ||
		text(row["origin"], "sourceId") != "" && field(row["origin"], "sourceId") == origin["sourceId"]
}

func dispatchQueuePublic(row object) object {
	data := selectFields(row, "queueId", "threadId", "state", "createdAt", "turnId", "dispatchRequestId", "reason", "error", "origin")
	args := obj(row["args"])
	data["trigger"], data["text"], data["preview"] = dispatchSendTrigger(args), args["prompt"], runeExcerpt(text(args, "prompt"), 120)
	return data
}

func enqueueCodexDispatch(s *service, args, receipt object) (object, error) {
	if text(receipt["origin"], "sourceId") == "" {
		return nil, errors.New("SOURCE_REQUIRED: enqueue through an authenticated control source or tasks.control")
	}
	q := &s.codex.queue
	q.Lock()
	defer q.Unlock()
	target, err := queuePath(text(receipt, "requestId"))
	if err != nil {
		return nil, err
	}
	stored, _ := cachedLoad(target)
	row := obj(stored)
	if row == nil {
		records, err := q.records()
		if err != nil {
			return nil, err
		}
		sequence := uint64(1)
		if len(records) != 0 {
			sequence = uintOr(records[len(records)-1]["sequence"], 0) + 1
		}
		row = object{"queueId": receipt["requestId"], "threadId": args["threadId"], "args": args, "origin": receipt["origin"],
			"state": "queued", "sequence": sequence, "createdAt": now(), "dispatchRequestId": id()}
		if caller := validatedDispatchCaller(receipt["caller"]); caller != nil {
			row["caller"] = caller
		}
		if err := q.save(row); err != nil {
			return nil, err
		}
	}
	receipt["threadId"], receipt["queueId"], receipt["dispatchMode"] = row["threadId"], row["queueId"], "queued"
	return object{"accepted": true, "queueId": row["queueId"], "status": row["state"]}, nil
}

func dispatchQueueRunnable(row object) bool {
	return slices.Contains([]string{"queued", "blocked", "dispatching", "steering"}, text(row, "state"))
}

func readCodexQueue(ctx context.Context, r operationRequest) (any, error) {
	q := &r.service.codex.queue
	q.Lock()
	defer q.Unlock()
	rows, err := q.records()
	if err != nil {
		return nil, err
	}
	filtered := []object{}
	for _, row := range slices.Backward(rows) {
		if dispatchQueueVisible(row, currentOrigin(ctx)) && (r.args["threadId"] == nil || row["threadId"] == r.args["threadId"]) &&
			(r.args["queueId"] == nil || row["queueId"] == r.args["queueId"]) {
			filtered = append(filtered, dispatchQueuePublic(row))
		}
	}
	return object{"items": filtered[:min(len(filtered), 100)], "total": len(filtered), "order": "FIFO per thread; display newest first"}, nil
}

func nativeDispatchQueueCounts(ctx context.Context, s *service) (map[string]object, error) {
	q := &s.codex.queue
	q.Lock()
	defer q.Unlock()
	if err := q.refresh(); err != nil {
		return nil, err
	}
	result := map[string]object{}
	for _, row := range q.active {
		if dispatchQueueVisible(row, currentOrigin(ctx)) {
			thread := text(row, "threadId")
			entry := result[thread]
			if entry == nil {
				entry = object{"pending": 0, "blocked": 0}
				result[thread] = entry
			}
			entry["pending"] = uintOr(entry["pending"], 0) + 1
			if row["state"] == "blocked" {
				entry["blocked"] = uintOr(entry["blocked"], 0) + 1
			}
		}
	}
	return result, nil
}

type dispatchQueueAdmission uint8

const (
	dispatchQueueReady dispatchQueueAdmission = iota
	dispatchQueueWait
	dispatchQueueBlock
	dispatchQueueUnconfirmed
)

func nativeQueueAdmission(row object, turn *turnTransition, waiting, retry bool) (dispatchQueueAdmission, string) {
	if waiting {
		return dispatchQueueWait, "waiting-input"
	}
	if turn != nil {
		if state, _ := turn.wait(); state == waitRunning || state == waitInteraction {
			return dispatchQueueWait, "active-turn"
		}
	}
	if retry {
		return dispatchQueueWait, "automatic-retry"
	}
	if turn == nil {
		return dispatchQueueReady, ""
	}
	if terminal, ok := turn.terminal(); ok {
		if terminal.outcome == turnCompleted || row["allowFailedTurn"] == turn.key.turn {
			return dispatchQueueReady, ""
		}
		return dispatchQueueBlock, "previous-turn-failed-or-interrupted"
	}
	return dispatchQueueUnconfirmed, ""
}

func queueCodexTransition(thread string, state, turn object) *turnTransition {
	if turn == nil {
		return nil
	}
	selected := codexTurnSnapshots(thread, arr(state["turns"]), text(turn, "id"))
	if verdict, _ := selected.wait(); verdict == waitRunning && field(state["status"], "type") != "active" {
		selected = (turnTransition{key: selected.key}).advance(turnEvidence{key: selected.key, owner: turnOwner{0, turnUnavailable}})
	}
	return &selected
}

func controlCodexQueue(ctx context.Context, r operationRequest) (any, error) {
	thread, action, queueID := text(r.args, "threadId"), text(r.args, "action"), text(r.args, "queueId")
	if action == "promote" && queueID == "" {
		return nil, errors.New("QUEUE_ID_REQUIRED: promote requires one queueId")
	}
	s := r.service
	unlock := lockReceipt("codex-thread:" + thread)
	changed, promoted, err := changeCodexQueue(ctx, s, thread, action, queueID)
	unlock()
	if err != nil {
		return nil, err
	}
	if promoted != nil {
		if err := dispatchQueuedCodex(ctx, s, promoted); err != nil {
			return nil, err
		}
		path, _ := queuePath(text(promoted, "queueId"))
		value, err := cachedLoad(path)
		if err != nil {
			return nil, err
		}
		changed = []object{dispatchQueuePublic(obj(value))}
	}
	count := 0
	for _, row := range changed {
		state := text(row, "state")
		if action == "cancel" && state == "cancelled" || action == "resume" && state == "queued" ||
			action == "promote" && (state == "steering" || state == "steered") {
			count++
		}
	}
	return object{"changed": count, "items": changed}, nil
}

func changeCodexQueue(ctx context.Context, s *service, thread, action, queueID string) ([]object, object, error) {
	q := &s.codex.queue
	q.Lock()
	defer q.Unlock()
	rows, err := q.records()
	if err != nil {
		return nil, nil, err
	}
	changed := []object{}
	var promoted object
	for _, row := range rows {
		if row["threadId"] != thread || queueID != "" && row["queueId"] != queueID || !dispatchQueueVisible(row, currentOrigin(ctx)) ||
			row["state"] != "queued" && row["state"] != "blocked" {
			continue
		}
		switch action {
		case "cancel":
			row["state"] = "cancelled"
		case "resume", "promote":
			if text(row["origin"], "sourceId") == "" {
				return nil, nil, errors.New("QUEUE_SOURCE_MISSING: cancel this orphan through local codex_queue_control; submit a new message explicitly")
			}
			if action == "resume" {
				row["allowFailedTurn"], row["state"] = row["blockedTurn"], "queued"
			} else {
				state, latest, err := codexMutationHead(ctx, s, thread)
				if err != nil {
					return nil, nil, err
				}
				lifecycle := queueCodexTransition(thread, state, latest)
				if lifecycle == nil || lifecycle.owner.state != turnActive {
					return nil, nil, errors.New("NO_ACTIVE_TURN: keep the message queued or resume it after an interrupted turn")
				}
				if nativeThreadHasInteraction(s, thread) {
					return nil, nil, errors.New("INTERACTION_REQUIRED: answer the pending native request before steering")
				}
				if state["runtimeSource"] == "codex-desktop-owner" {
					d, err := s.nativeDesktop(ctx)
					if err != nil {
						return nil, nil, err
					}
					snapshot, err := d.read(ctx, thread, true)
					if err != nil {
						return nil, nil, err
					}
					args := maps.Clone(obj(row["args"]))
					args["threadId"], args["expectedTurnId"] = thread, latest["id"]
					if _, err := desktopSteerParams(snapshot, args); err != nil {
						return nil, nil, err
					}
				}
				row["expectedActiveTurn"], row["state"] = latest["id"], "steering"
				promoted = row
			}
			row["reason"] = nil
		default:
			return nil, nil, errors.New("INVALID_QUEUE_ACTION")
		}
		if err := q.save(row); err != nil {
			return nil, nil, err
		}
		changed = append(changed, dispatchQueuePublic(row))
	}
	return changed, promoted, nil
}

func reconcileQueuedCodex(ctx context.Context, s *service, row object) error {
	if row["state"] == "dispatching" || row["state"] == "steering" {
		return dispatchQueuedCodex(ctx, s, row)
	}
	thread := text(row, "threadId")
	unlock := lockReceipt("codex-thread:" + thread)
	row, admit, err := admitQueuedCodex(ctx, s, row)
	unlock()
	if err != nil || !admit {
		return err
	}
	return dispatchQueuedCodex(ctx, s, row)
}

func admitQueuedCodex(ctx context.Context, s *service, row object) (object, bool, error) {
	path, err := queuePath(text(row, "queueId"))
	if err != nil {
		return nil, false, err
	}
	q := &s.codex.queue
	q.Lock()
	value, err := cachedLoad(path)
	q.Unlock()
	if err != nil {
		return nil, false, err
	}
	row = obj(value)
	if row["state"] != "queued" && row["state"] != "blocked" {
		return nil, false, nil
	}
	thread := text(row, "threadId")
	metadata, latest, err := codexMutationHead(ctx, s, thread)
	if err != nil {
		return nil, false, err
	}
	retry, err := notificationRetryPending(thread, text(latest, "id"))
	if err != nil {
		return nil, false, err
	}
	admission, reason := nativeQueueAdmission(row, queueCodexTransition(thread, metadata, latest), nativeThreadHasInteraction(s, thread), retry)
	q.Lock()
	defer q.Unlock()
	switch admission {
	case dispatchQueueWait:
		row["state"], row["reason"] = "queued", reason
	case dispatchQueueBlock:
		row["state"], row["reason"], row["blockedTurn"] = "blocked", reason, latest["id"]
	case dispatchQueueUnconfirmed:
		return nil, false, nil
	case dispatchQueueReady:
		row["state"], row["expectedPreviousTurn"] = "dispatching", latest["id"]
	}
	return row, admission == dispatchQueueReady, q.save(row)
}

func dispatchQueuedCodex(ctx context.Context, s *service, row object) error {
	args := clone(obj(row["args"]))
	delete(args, "sendMode")
	args["requestId"], args["waitMs"], args["approval"] = row["dispatchRequestId"], 0, "approved"
	steering := row["state"] == "steering"
	if steering {
		args["sendMode"], args["_expectedActiveTurn"] = "steer", row["expectedActiveTurn"]
	} else {
		args["_newTurn"], args["_expectedPreviousTurn"] = true, row["expectedPreviousTurn"]
	}
	ctx = withOrigin(ctx, obj(row["origin"]))
	if caller := validatedDispatchCaller(row["caller"]); caller != nil {
		ctx = context.WithValue(ctx, &localControlCallerKey, caller)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	request := operationRequest{name: "codex_send", args: args, service: s}
	value, err := codexWriteOperation("send", sendCodexMutation)(ctx, request)
	result := obj(value)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	q := &s.codex.queue
	q.Lock()
	defer q.Unlock()
	if err != nil {
		row["state"], row["error"] = "failed", controlFailure(err)
		if strings.HasPrefix(err.Error(), "SUBMISSION_UNCONFIRMED:") {
			row["state"] = "unconfirmed"
		}
	} else {
		switch result["state"] {
		case "reserved", "executing", "awaiting-approval":
			return nil
		case "completed":
			row["state"] = "sent"
			if steering {
				row["state"] = "steered"
			}
		case "unconfirmed":
			row["state"] = "unconfirmed"
		default:
			row["state"] = "failed"
		}
		row["turnId"], row["reason"] = result["turnId"], result["state"]
		row["error"] = result["error"]
		if row["error"] == nil {
			row["error"] = field(result["result"], "error")
		}
	}
	return q.save(row)
}

func runCodexQueue(ctx context.Context, s *service) {
	q := &s.codex.queue
	if s.indexStartupDone != nil {
		select {
		case <-s.indexStartupDone:
		case <-ctx.Done():
			return
		}
	}
	reason := "startup"
	for ctx.Err() == nil {
		bounded := withRuntimeCost(ctx, "dispatchQueue", reason)
		q.Lock()
		err := q.refresh()
		active := sortedCodexQueueRows(q.active)
		wake, repair := q.files.watch.wake, q.files.repairNeeded
		q.Unlock()
		if err != nil {
			recordLog("WARN", "Send queue: "+err.Error(), nil)
		}
		active = slices.DeleteFunc(active, func(row object) bool {
			return text(row["origin"], "sourceId") == ""
		})
		if cost := currentRuntimeCost(bounded); cost != nil {
			cost.rows.Add(uint64(len(active)))
			cost.scanSet.Add(uint64(len(active)))
		}
		slices.SortStableFunc(active, func(a, b object) int {
			priority := func(row object) int {
				if row["state"] == "dispatching" || row["state"] == "steering" {
					return 0
				}
				return 1
			}
			return cmp.Compare(priority(a), priority(b))
		})
		seen := map[string]bool{}
		var work sync.WaitGroup
		limit := make(chan struct{}, 8)
		for _, row := range active {
			thread := text(row, "threadId")
			if seen[thread] || ctx.Err() != nil {
				continue
			}
			seen[thread] = true
			limit <- struct{}{}
			work.Go(func() {
				defer func() { <-limit }()
				if err := reconcileQueuedCodex(bounded, s, row); err != nil && ctx.Err() == nil {
					recordLog("WARN", "Queued send: "+err.Error(), nil)
				}
			})
		}
		work.Wait()
		var tick <-chan time.Time
		if len(active) != 0 || repair {
			tick = time.After(time.Second)
		}
		select {
		case <-ctx.Done():
			return
		case <-wake:
			reason = "dirty"
		case <-tick:
			reason = "deadline"
		}
	}
}

func init() {
	registerOperation("codex_queue", readCodexQueue, nil)
	registerOperation("codex_queue_control", controlCodexQueue, nil)
	taskListQueueCounts = nativeDispatchQueueCounts
	registerServiceStartup(func(parent context.Context, s *service) error {
		ctx, cancel := context.WithCancel(parent)
		done := make(chan struct{})
		go func() {
			defer close(done)
			runCodexQueue(ctx, s)
		}()
		s.cleanup = append(s.cleanup, func() {
			cancel()
			<-done
			s.codex.queue.Lock()
			defer s.codex.queue.Unlock()
			if collection := s.codex.queue.files; collection != nil {
				collection.close()
			}
		})
		return nil
	})
}
