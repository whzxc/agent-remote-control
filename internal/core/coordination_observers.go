package core

import (
	"context"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

const maxCoordinationPending = 4096

var coordinationCoverage struct {
	sync.Mutex
	rows map[string]object
}

func coordinationGap(key, state string) {
	coordinationCoverage.Lock()
	defer coordinationCoverage.Unlock()
	if coordinationCoverage.rows == nil {
		coordinationCoverage.rows = map[string]object{}
	}
	previous := coordinationCoverage.rows[key]
	if previous == nil && len(coordinationCoverage.rows) >= 256 {
		return
	}
	at := now()
	last := previous["lastGap"]
	if state != "observed" {
		last = object{"state": state, "observedAt": at}
	}
	coordinationCoverage.rows[key] = object{"state": state, "observedAt": at, "lastGap": last, "headState": previous["headState"]}
}

func coordinationHeadState(key, state string) {
	coordinationCoverage.Lock()
	defer coordinationCoverage.Unlock()
	if coordinationCoverage.rows == nil {
		coordinationCoverage.rows = map[string]object{}
	}
	row := coordinationCoverage.rows[key]
	if row == nil {
		if len(coordinationCoverage.rows) >= 256 {
			return
		}
		row = object{}
		coordinationCoverage.rows[key] = row
	}
	row["headState"] = state
}

func coordinationCoverageSnapshot() any {
	coordinationCoverage.Lock()
	defer coordinationCoverage.Unlock()
	result := object{}
	size := 64
	for _, key := range slices.Sorted(maps.Keys(coordinationCoverage.rows)) {
		row := coordinationCoverage.rows[key]
		size += len(key) + len(wire(row)) + 8
		if size > coordinationCoverageBytes {
			result["truncated"] = true
			break
		}
		result[key] = clone(row)
	}
	return result
}

var coordinationObserverQueue struct {
	sync.Mutex
	paths map[string]bool
	wake  chan struct{}
}

func markCoordinationOwner(path string) {
	queue := &coordinationObserverQueue
	queue.Lock()
	defer queue.Unlock()
	if queue.paths == nil {
		queue.paths = map[string]bool{}
	}
	if len(queue.paths) < maxCoordinationPending {
		queue.paths[path] = true
	} else {
		coordinationGap("owners", "pending-capacity")
	}
	if queue.wake != nil {
		select {
		case queue.wake <- struct{}{}:
		default:
		}
	}
}

var coordinationStorage struct {
	sync.Mutex
	root  string
	files map[string]int64
	bytes int64
	full  bool
}

func coordinationDurable(path string, value any) error {
	data := []byte(wire(value))
	base := filepath.Join(root(), "coordination")
	bounded := belowPath(path, base) && !belowPath(path, filepath.Join(base, "events"))
	if !bounded {
		return coordinationAtomicBytes(path, data)
	}
	store := &coordinationStorage
	store.Lock()
	defer store.Unlock()
	if store.root != base {
		store.root, store.files, store.bytes, store.full = base, map[string]int64{}, 0, false
		for _, dir := range []string{"observations", "checkpoints", "tooling", "ref-watch", ""} {
			file, err := os.Open(filepath.Join(base, dir))
			if err != nil {
				continue
			}
			items, _ := file.ReadDir(8193)
			_ = file.Close()
			for _, item := range items {
				name := filepath.Join(base, dir, item.Name())
				if name == filepath.Join(base, "state.json") || filepath.Ext(name) != ".json" || !item.Type().IsRegular() {
					continue
				}
				if len(store.files) >= 8192 {
					store.full = true
					break
				}
				info, err := item.Info()
				if err != nil {
					return errors.New("COORDINATION_STORAGE: observer inventory unavailable")
				}
				store.bytes += info.Size()
				store.files[name] = info.Size()
			}
		}
	}
	total := store.bytes - store.files[path] + int64(len(data))
	_, known := store.files[path]
	if store.full || !known && len(store.files) >= 8192 || total > 16*1024*1024 || len(data) > 128*1024 {
		coordinationGap("storage", "observer-capacity")
		return errors.New("COORDINATION_CAPACITY: preserve producer checkpoints for local archive/recovery")
	}
	if err := coordinationAtomicBytes(path, data); err != nil {
		return err
	}
	store.bytes, store.files[path] = total, int64(len(data))
	return nil
}

var coordinationHostResource struct {
	sync.Mutex
	root, key string
}

func coordinationHost() (string, error) {
	cached := &coordinationHostResource
	cached.Lock()
	defer cached.Unlock()
	if cached.root == root() && cached.key != "" {
		return cached.key, nil
	}
	path := filepath.Join(root(), "coordination/host.json")
	value, err := load(path)
	if errors.Is(err, os.ErrNotExist) {
		value = object{"id": id()}
		err = coordinationDurable(path, value)
	}
	if err != nil {
		return "", err
	}
	key, err := coordinationResource("host:" + text(value, "id"))
	if err == nil {
		cached.root, cached.key = root(), key
	}
	return key, err
}

func coordinationReceiptOrigin(origin object) (*coordinationPrincipal, error) {
	if origin != nil && text(origin, "sourceId") == "" && !(origin["authType"] == "local" && (origin["ingressId"] == "local-cli" || origin["ingressId"] == "local-ui")) {
		return nil, nil
	}
	return coordinationPrincipalFromOrigin(origin)
}

func coordinationBaseEvent(row object, key, kind string, resources []string) (coordinationEventInput, error) {
	input := newCoordinationEvent(hash([]byte(key)), kind, resources)
	var err error
	origin := obj(row["origin"])
	switch kind {
	case "dispatch.accepted":
		input.Origin, _ = coordinationPrincipalFromOrigin(origin)
	case "receipt.stalled", "receipt.unconfirmed":
		input.Origin, err = coordinationReceiptOrigin(origin)
	default:
		input.Origin, err = coordinationPrincipalFromOrigin(origin)
	}
	if err != nil {
		return input, err
	}
	thread := text(row, "threadId")
	if _, ok := row["threadId"].(string); !ok {
		thread = text(row, "taskId")
	}
	if coordinationIdentifier(thread) {
		turn := axOptional(row["turnId"])
		if turn != nil && !coordinationIdentifier(*turn) {
			turn = nil
		}
		input.ThreadRefs = append(input.ThreadRefs, coordinationThreadRef{thread, turn})
	}
	return input, nil
}

func coordinationEventEvidence(input *coordinationEventInput, kind, id string) {
	if coordinationIdentifier(id) {
		input.EvidenceRefs = append(input.EvidenceRefs, coordinationEvidenceRef{kind, id})
	}
}

func coordinationOwnerInputs(owner string, row object, resources []string) ([]coordinationEventInput, error) {
	request := text(row, "requestId")
	events := []coordinationEventInput{}
	appendEvent := func(key, kind, status, evidence string) (*coordinationEventInput, error) {
		input, err := coordinationBaseEvent(row, key, kind, resources)
		if err != nil {
			return nil, err
		}
		input.Status = &status
		coordinationEventEvidence(&input, evidence, request)
		events = append(events, input)
		return &events[len(events)-1], nil
	}
	switch owner {
	case "dispatch":
		if row["dispatchMode"] != "steered" && row["dispatchSource"] != "native-retry" &&
			(row["agent"] == nil || row["agent"] == "codex" || row["submissionObserved"] == true || row["submission"] == "accepted") {
			event, err := appendEvent("dispatch:"+request, "dispatch.accepted", "submitted", "request")
			if err != nil {
				return nil, err
			}
			var association *coordinationDispatchAssociation
			_ = unmarshalJSON([]byte(wire(field(row["coordination"], "association"))), &association)
			if association != nil {
				event.Resources = association.Resources
				if len(event.Resources) == 0 {
					event.Resources = []string{"unattributed:dispatch"}
				}
			} else {
				event.Resources = resources[:1]
			}
			event.OccurredAt = axOptional(row["acceptedAt"])
			event.Observation = &coordinationObservation{DispatchAssociation: association, Model: axOptional(row["model"]), Effort: axOptional(row["effort"])}
		}
		if prior, ok := row["retryOf"].(string); ok {
			event, err := appendEvent("successor:"+request, "turn.successor", "submitted", "request")
			if err != nil {
				return nil, err
			}
			event.ThreadRefs = append([]coordinationThreadRef{{text(row, "threadId"), &prior}}, event.ThreadRefs...)
		}
		if status := coordinationTerminalStatus(row["terminal"], text(row["terminal"], "state")); status != "" {
			thread, turn := text(row, "threadId"), text(row, "turnId")
			event, err := appendEvent("terminal:"+thread+":"+turn, "turn.terminal", status, "")
			if err != nil {
				return nil, err
			}
			event.EvidenceRefs = []coordinationEvidenceRef{}
			event.OccurredAt = axOptional(field(row["terminal"], "endedAt"))
			if coordinationGitTerminal != nil {
				coordinationGitTerminal(thread, turn)
			}
		}
	case "receipt":
		state := readReceiptState(text(row, "state"), true)
		if row["operation"] == "resume" && state == receiptCompleted && text(row, "turnId") != "" {
			event, err := appendEvent("successor:"+request, "turn.successor", "submitted", "receipt")
			if err != nil {
				return nil, err
			}
			prior := text(row["arguments"], "turnId")
			event.ThreadRefs = append([]coordinationThreadRef{{text(row, "threadId"), &prior}}, event.ThreadRefs...)
		}
		if state == receiptUnconfirmed {
			if _, err := appendEvent("unconfirmed:"+request, "receipt.unconfirmed", "unconfirmed", "receipt"); err != nil {
				return nil, err
			}
		}
	case "agent":
		if status := coordinationTerminalStatus(row, text(row, "status")); status != "" && text(row, "turnId") != "" {
			thread, turn := text(row, "taskId"), text(row, "turnId")
			if status == "interrupted" {
				status = "cancelled"
			}
			event, err := appendEvent("terminal:"+thread+":"+turn, "turn.terminal", status, "")
			if err != nil {
				return nil, err
			}
			event.EvidenceRefs = []coordinationEvidenceRef{}
			if coordinationGitTerminal != nil {
				coordinationGitTerminal(thread, turn)
			}
		}
	}
	return events, nil
}

func coordinationOwnerEvents(owner string, row object) ([]coordinationEventInput, error) {
	host, err := coordinationHost()
	if err != nil {
		return nil, err
	}
	resources := []string{host, "app:installed"}
	if project := text(row, "projectId"); coordinationIdentifier(project) {
		resources = append(resources, "project:"+project+"/main")
	}
	return coordinationOwnerInputs(owner, row, resources)
}

func coordinationCaptureOwner(path string, row object, owner string) error {
	previous, _ := cachedLoad(path)
	pending := slices.Clone(arr(field(previous, "coordinationPending")))
	if pending == nil {
		pending = []any{}
	}
	if inputs, err := coordinationOwnerEvents(owner, row); err == nil {
		for _, input := range inputs {
			if slices.ContainsFunc(pending, func(value any) bool { return field(value, "transitionId") == input.TransitionID }) {
				continue
			}
			if len(pending) < 128 {
				var value object
				_ = decodeObject([]byte(wire(input)), &value)
				pending = append(pending, value)
			} else {
				coordinationGap("owners", "descriptor-capacity")
			}
		}
	} else {
		coordinationGap("owners", "invalid-metadata")
	}
	row["coordinationPending"] = pending
	return nil
}

func coordinationPersist(input coordinationEventInput) (string, error) {
	if !coordinationIdentifier(input.TransitionID) {
		return "", invalidCoordinationIdentifier()
	}
	path := filepath.Join(root(), "coordination/observations", input.TransitionID+".json")
	coordinationObservationWrite.Lock()
	defer coordinationObservationWrite.Unlock()
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		if err := coordinationDurable(path, object{"coordinationPending": []coordinationEventInput{input}}); err != nil {
			return "", err
		}
		markCoordinationOwner(path)
	} else if err != nil {
		return "", err
	}
	return path, nil
}

var coordinationObservationWrite sync.Mutex

func coordinationCheckpoint(path string) string {
	return filepath.Join(root(), "coordination/checkpoints", hash([]byte(path))+".json")
}

func coordinationProject(ctx context.Context, path string, row object) error {
	return coordinationProjectAt(ctx, path, coordinationCheckpoint(path), row)
}

func coordinationProjectAt(ctx context.Context, path, checkpoint string, row object) error {
	cost := currentRuntimeCost(ctx)
	if len(arr(row["coordinationPending"])) == 0 {
		return nil
	}
	defer lockIndex(checkpoint)()
	payload, err := cachedLoad(checkpoint)
	done := obj(payload)
	if errors.Is(err, os.ErrNotExist) {
		done = object{}
	} else if err != nil {
		return err
	}
	if done == nil {
		return errors.New("COORDINATION_STORAGE: invalid owner checkpoint")
	}
	for _, descriptor := range arr(row["coordinationPending"]) {
		if cost != nil {
			cost.rows.Add(1)
		}
		var input coordinationEventInput
		if err := decodeCoordinationRecord([]byte(wire(descriptor)), &input); err != nil {
			return errors.New("COORDINATION_STORAGE: invalid owner descriptor")
		}
		if done[input.TransitionID] != nil {
			continue
		}
		if input.Kind == "turn.terminal" && obj(row["_turnLifecycle"]) != nil &&
			coordinationTerminalStatus(row["_turnLifecycle"], "") != strPtr(input.Status) {
			continue
		}
		var result any
		if (input.Kind == "turn.terminal" || input.Kind == "receipt.unconfirmed") && filepath.Dir(path) != filepath.Join(root(), "coordination/observations") {
			derived, err := coordinationPersist(input)
			if err != nil {
				return err
			}
			data, err := cachedLoad(derived)
			if err != nil {
				return err
			}
			if err := coordinationProject(ctx, derived, obj(data)); err != nil {
				return err
			}
			checkpoint, err := cachedJSON(coordinationCheckpoint(derived))
			if err != nil {
				return err
			}
			result = field(checkpoint, input.TransitionID)
		} else {
			result, err = emitCoordinationEvent(input)
			if err != nil {
				return err
			}
		}
		if result == nil {
			continue
		}
		done[input.TransitionID] = result
		if err := coordinationDurable(checkpoint, done); err != nil {
			return err
		}
		if cost != nil {
			cost.changed.Add(1)
		}
	}
	return nil
}

func coordinationDiscover(dir string, depth int, paths map[string]bool, cost *runtimeCost) {
	if len(paths) >= maxCoordinationPending {
		coordinationGap("replay", "discovery-capacity")
		return
	}
	file, err := os.Open(dir)
	if err != nil {
		return
	}
	defer file.Close()
	entries, _ := file.ReadDir(maxCoordinationPending)
	for _, entry := range entries {
		cost.rows.Add(1)
		if len(paths) >= maxCoordinationPending {
			coordinationGap("replay", "discovery-capacity")
			return
		}
		path := filepath.Join(dir, entry.Name())
		if entry.IsDir() && depth > 0 {
			coordinationDiscover(path, depth-1, paths, cost)
		} else if entry.Type().IsRegular() && filepath.Ext(path) == ".json" {
			paths[path] = true
		}
	}
}

type coordinationReceiptObserver struct {
	waiting, failed, invalid     map[string]bool
	invalidCapped, pendingCapped bool
}

func (observer *coordinationReceiptObserver) observe(path string, row object, session, host string, ms int64) bool {
	request := text(row, "requestId")
	raw := text(row, "state")
	state := readReceiptState(raw, row["backendSession"] == session)
	active := state == receiptReserved || state == receiptExecuting || state == receiptAwaitingApproval || state == receiptUnconfirmed
	updated := text(row, "updatedAt")
	if updated == "" {
		updated = text(row, "createdAt")
	}
	at, timeErr := time.Parse(time.RFC3339Nano, updated)
	_, originErr := coordinationReceiptOrigin(obj(row["origin"]))
	invalid := !coordinationIdentifier(request) || raw == "" || text(row, "operation") == "" || originErr != nil || active && timeErr != nil
	if invalid {
		delete(observer.waiting, path)
		delete(observer.failed, path)
		if len(observer.invalid) < maxCoordinationPending {
			observer.invalid[path] = true
		} else if !observer.invalid[path] {
			observer.invalidCapped = true
		}
		return false
	}
	delete(observer.invalid, path)
	failed := false
	var events []coordinationEventInput
	if state == receiptUnconfirmed && readReceiptState(raw, true) != receiptUnconfirmed {
		value := projectReceipt(clone(row), false, ms)
		events, _ = coordinationOwnerInputs("receipt", value, []string{host})
	}
	stalled := state == receiptReserved && ms-at.UnixMilli() >= 30000
	if stalled {
		input, err := coordinationBaseEvent(row, "stalled:"+request+":"+updated, "receipt.stalled", []string{host})
		if err == nil {
			coordinationEventEvidence(&input, "receipt", request)
			events = append(events, input)
		}
	}
	for _, input := range events {
		if _, err := coordinationPersist(input); err != nil {
			failed = true
		}
	}
	if failed {
		if len(observer.failed) < maxCoordinationPending {
			observer.failed[path] = true
		}
	} else {
		delete(observer.failed, path)
	}
	if failed || state == receiptReserved && !stalled {
		if len(observer.waiting) < maxCoordinationPending {
			observer.waiting[path] = true
		} else {
			observer.pendingCapped = true
		}
	} else {
		delete(observer.waiting, path)
	}
	return true
}
func (observer *coordinationReceiptObserver) report() {
	state := "observed"
	if len(observer.failed) > 0 {
		state = "persistence-failed"
	} else if observer.pendingCapped {
		state = "pending-capacity"
	}
	coordinationCoverage.Lock()
	defer coordinationCoverage.Unlock()
	if coordinationCoverage.rows == nil {
		coordinationCoverage.rows = map[string]object{}
	}
	coordinationCoverage.rows["receipts"] = object{"state": state, "observedAt": now(), "skippedInvalidRecords": len(observer.invalid), "invalidCountCapped": observer.invalidCapped}
}

var coordinationGitTerminal func(string, string)
var coordinationGitPoll func(context.Context) error
var coordinationGitActive func() bool
var coordinationAgentSession func(*service) string
var coordinationNativeDesktopTurns func(any) []object
var coordinationCaptureTerminalChanges func(context.Context, string, string)
var coordinationWorkersReady func(context.Context, *service) error

func coordinationObserveNativeTerminal(method string, params any) {
	thread := text(params, "threadId")
	if thread == "" {
		thread = text(params, "conversationId")
	}
	if !coordinationIdentifier(thread) {
		return
	}
	var turns []object
	switch {
	case method == "turn/completed":
		turns = []object{obj(field(params, "turn"))}
	case method == "desktop/thread-stream-state-changed" && field(field(params, "change"), "type") == "snapshot" && coordinationNativeDesktopTurns != nil:
		turns = coordinationNativeDesktopTurns(field(field(params, "change"), "conversationState"))
	default:
		return
	}
	if len(turns) > 128 {
		coordinationGap("terminal", "snapshot-turn-capacity")
		turns = turns[len(turns)-128:]
	}
	host, err := coordinationHost()
	if err != nil {
		return
	}
	for _, turn := range turns {
		turnID, status := text(turn, "id"), coordinationTerminalStatus(turn, text(turn, "status"))
		if !coordinationIdentifier(turnID) || status == "" {
			continue
		}
		input := newCoordinationEvent(hash([]byte("terminal:"+thread+":"+turnID)), "turn.terminal", []string{host, "app:installed"})
		input.Status, input.Origin = &status, &coordinationPrincipal{Type: "arc"}
		input.ThreadRefs = append(input.ThreadRefs, coordinationThreadRef{thread, &turnID})
		if coordinationGitTerminal != nil {
			coordinationGitTerminal(thread, turnID)
		}
		if coordinationCaptureTerminalChanges != nil {
			coordinationCaptureTerminalChanges(context.Background(), thread, turnID)
		}
		if _, err := coordinationPersist(input); err != nil {
			coordinationGap("terminal", "persistence-failed")
		}
	}
}

func startCoordinationWorker(ctx context.Context, service *service, name string, dependencies []string, work func(context.Context) (time.Time, error)) error {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	service.cleanup = append(service.cleanup, func() { cancel(); <-done })
	go func() {
		defer close(done)
		watcher := newFileChanges()
		defer watcher.close()
		paths := make([]string, 0, len(dependencies))
		for _, path := range dependencies {
			path = filepath.Join(root(), path)
			paths = append(paths, path)
			watcher.add(path)
		}
		reason := "startup"
		var last []*fileStamp
		var next time.Time
		for ctx.Err() == nil {
			pass := withRuntimeCost(ctx, name, reason)
			cost := currentRuntimeCost(pass)
			_, failed := watcher.drain()
			stamps, err := projectionStamps(paths)
			if err == nil && last != nil && slices.EqualFunc(stamps, last, stampSame) && (next.IsZero() || time.Now().Before(next)) && !failed {
				cost.hits.Add(1)
			} else if err == nil {
				last = nil
				next, err = work(pass)
				if after, readErr := projectionStamps(paths); err == nil && readErr == nil && slices.EqualFunc(stamps, after, stampSame) {
					last = after
				}
			}
			if err != nil || failed {
				next = time.Now().Add(5 * time.Second)
				if name == "coordinationMessages" {
					coordinationGap("messages", "projection-or-delivery-unavailable")
				}
			}
			if name == "coordinationMessages" {
				state := "observed"
				if failed {
					state = "watch-unavailable"
				}
				coordinationGap("messages-watch", state)
			}
			var timer *time.Timer
			var deadline <-chan time.Time
			if !next.IsZero() {
				timer = time.NewTimer(max(time.Second, time.Until(next)))
				deadline = timer.C
			}
			select {
			case <-ctx.Done():
			case <-watcher.wake:
				reason = "dirty"
			case <-deadline:
				reason = "deadline"
			}
			if timer != nil {
				timer.Stop()
			}
		}
	}()
	return nil
}

func startCoordinationObservers(parent context.Context, service *service) error {
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	queue := &coordinationObserverQueue
	queue.Lock()
	queue.wake = make(chan struct{}, 1)
	wake := queue.wake
	queue.Unlock()
	service.cleanup = append(service.cleanup, func() { cancel(); <-done })
	go func() {
		defer close(done)
		if coordinationWorkersReady != nil && coordinationWorkersReady(ctx, service) != nil {
			return
		}
		receiptPath, agentPath := coreReceiptStore().base, agentReceiptStore().base
		for indexAvailable(ctx, receiptPath) != nil || indexAvailable(ctx, agentPath) != nil {
			select {
			case <-ctx.Done():
				return
			case <-time.After(50 * time.Millisecond):
			}
		}
		pending := map[string]bool{}
		cost := currentRuntimeCost(withRuntimeCost(ctx, "coordinationObservers", "startup"))
		for _, entry := range []struct {
			path  string
			depth int
		}{{"dispatches", 1}, {"agents/requests", 0}, {"agents/tasks", 0}, {"coordination/observations", 0}, {"coordination/tooling", 0}, {"", 0}} {
			coordinationDiscover(filepath.Join(root(), entry.path), entry.depth, pending, cost)
		}
		host, err := coordinationHost()
		if err == nil {
			input := newCoordinationEvent(id(), "app.restarted", []string{host})
			input.Origin, input.Status = &coordinationPrincipal{Type: "arc"}, new("running")
			coordinationEventEvidence(&input, "core-instance", text(service.metadata, "instance"))
			if _, err := coordinationPersist(input); err != nil {
				coordinationGap("restart", "persistence-failed")
			}
		}
		observer := coordinationReceiptObserver{waiting: map[string]bool{}, failed: map[string]bool{}, invalid: map[string]bool{}}
		reason := "startup"
		var gitAt, slowAt time.Time
		for ctx.Err() == nil {
			pass := withRuntimeCost(ctx, "coordinationObservers", reason)
			cost := currentRuntimeCost(pass)
			queue.Lock()
			maps.Copy(pending, queue.paths)
			clear(queue.paths)
			queue.Unlock()
			if time.Since(slowAt) >= 5*time.Second {
				for path := range observer.waiting {
					cost.rows.Add(1)
					pending[path] = true
				}
				if err := bulletinTick(pass, service); err != nil {
					coordinationGap("bulletin", "projection-or-activity-unavailable")
				}
				slowAt = time.Now()
			}
			batch := slices.Sorted(maps.Keys(pending))
			clear(pending)
			cost.scanSet.Store(uint64(len(batch)))
			for _, path := range batch {
				if ctx.Err() != nil {
					return
				}
				cost.rows.Add(1)
				row, err := cachedJSONWithRuntimeCost(path, cost)
				if err != nil {
					if !errors.Is(err, os.ErrNotExist) && len(pending) < maxCoordinationPending {
						pending[path] = true
						coordinationGap("projection", "owner-read-unavailable")
					}
					continue
				}
				dir := filepath.Dir(path)
				if (dir == receiptPath || dir == agentPath) && isReceiptPath(path) || field(row, "requestId") != nil && field(row, "operation") != nil {
					session := text(service.metadata, "instance")
					if dir == agentPath && coordinationAgentSession != nil {
						session = coordinationAgentSession(service)
					}
					if host != "" && !observer.observe(path, obj(row), session, host, time.Now().UnixMilli()) {
						continue
					}
				}
				if err := coordinationProject(pass, path, obj(row)); err != nil && len(pending) < maxCoordinationPending {
					pending[path] = true
					coordinationGap("projection", "pending-retry")
				}
			}
			observer.report()
			gitDelay := 30 * time.Second
			if coordinationGitActive != nil && coordinationGitActive() {
				gitDelay = 5 * time.Second
			}
			if coordinationGitPoll != nil && time.Since(gitAt) >= gitDelay {
				_ = coordinationGitPoll(withRuntimeCost(pass, "coordinationGit", "timer"))
				gitAt = time.Now()
			}
			timer := time.NewTimer(5 * time.Second)
			select {
			case <-ctx.Done():
			case <-timer.C:
				reason = "timer"
			case <-wake:
				reason = "dirty"
			}
			timer.Stop()
		}
	}()
	return nil
}

func init() {
	coordinationObserverCoverage = coordinationCoverageSnapshot
	onReceiptSaved = append(onReceiptSaved, markCoordinationOwner)
	onReceiptCheckpoint = append(onReceiptCheckpoint, func(path string, row object) error { return coordinationCaptureOwner(path, row, "receipt") })
	observeReceiptUnconfirmed = append(observeReceiptUnconfirmed, func(row object) {
		if events, err := coordinationOwnerEvents("receipt", row); err == nil {
			for _, event := range events {
				if _, err := coordinationPersist(event); err != nil {
					coordinationGap("receipts", "persistence-failed")
				}
			}
		}
	})
	nativeTerminalObserved = append(nativeTerminalObserved, coordinationObserveNativeTerminal)
	registerServiceStartup(startCoordinationObservers)
}
