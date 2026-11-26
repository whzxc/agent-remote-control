package core

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

// The transport routes to the authoritative writer or native persisted reader in A.
var nativeControlRequest func(context.Context, *service, string, any, time.Duration) (any, error)
var prepareControlMutation func(context.Context, operationRequest, object) error
var decideControlReceipt func(context.Context, operationRequest) (any, error)

type controlJobs struct {
	sync.Mutex
	lifetime context.Context
	cancel   context.CancelFunc
	idle     chan struct{}
	active   int
	closing  bool
}

func (j *controlJobs) begin() context.Context {
	j.Lock()
	defer j.Unlock()
	if j.closing {
		return nil
	}
	if j.lifetime == nil {
		j.lifetime, j.cancel = context.WithCancel(context.Background())
	}
	if j.active == 0 {
		j.idle = make(chan struct{})
	}
	j.active++
	return j.lifetime
}

func (j *controlJobs) finish() {
	j.Lock()
	defer j.Unlock()
	j.active--
	if j.active == 0 {
		close(j.idle)
	}
}

func (j *controlJobs) close() {
	j.Lock()
	j.closing = true
	idle := j.idle
	if j.cancel != nil {
		j.cancel()
	}
	j.Unlock()
	if idle != nil {
		ticker := time.NewTimer(drainTimeout)
		defer ticker.Stop()
		select {
		case <-idle:
		case <-ticker.C:
			recordLog("WARN", "Core operation jobs did not drain before shutdown", nil)
		}
	}
}

func controlJobCount(s *service) int {
	s.jobs.Lock()
	defer s.jobs.Unlock()
	return s.jobs.active
}

func runControlMutation(ctx context.Context, request operationRequest, name string, args object, execute func(context.Context, object) (any, error)) (object, error) {
	if waitFixtureTaskIndex != nil {
		if err := waitFixtureTaskIndex(ctx, request.service); err != nil {
			return nil, err
		}
	}
	// The digest covers caller-provided arguments before policy and runtime state are resolved.
	args = maps.Clone(args)
	if args["requestId"] == nil {
		args["requestId"] = id()
	}
	key := text(args, "requestId")
	store := coreReceiptStore()
	if _, err := store.path(key); err != nil {
		return nil, err
	}
	payload := maps.Clone(args)
	delete(payload, "waitMs")
	digest := hash([]byte(wire(object{"operation": name, "args": payload})))
	session := text(request.service.metadata, "instance")
	unlock := lockReceipt(key)
	replay, err := store.replay(ctx, key, digest, session)
	if err != nil || replay != nil {
		unlock()
		return replay, err
	}
	at := now()
	row := object{"origin": currentOrigin(ctx), "requestId": key, "backendSession": session, "digest": digest, "operation": name,
		"arguments": args, "state": "reserved", "createdAt": at, "updatedAt": at}
	attachDispatchCaller(ctx, row)
	if prepareControlMutation != nil {
		if err := prepareControlMutation(ctx, request, row); err != nil {
			unlock()
			return nil, err
		}
	}
	lifetime := request.service.jobs.begin()
	if lifetime == nil {
		unlock()
		return nil, errors.New("CORE_SHUTTING_DOWN: retry after Core restarts")
	}
	if err := store.reserve(ctx, row); err != nil {
		unlock()
		request.service.jobs.finish()
		return nil, err
	}
	if row["state"] != "reserved" {
		unlock()
		request.service.jobs.finish()
		return row, nil
	}
	unlock()
	wait := min(uintOr(args["waitMs"], 25000), 120000)
	switch name {
	case "create":
		wait = min(uintOr(args["waitMs"], 45000), 120000)
	case "command":
		if args["waitMs"] == nil {
			wait = min(uintOr(args["timeoutMs"], 60000), 86400000) + 10000
		}
	}
	return launchControlMutation(ctx, request.service, store, row, lifetime, wait, execute)
}

func launchControlMutation(ctx context.Context, service *service, store receiptStore, row object, lifetime context.Context, wait uint64, execute func(context.Context, object) (any, error)) (object, error) {
	timeout := uintOr(field(row["arguments"], "timeoutMs"), 86400000)
	key, session := text(row, "requestId"), text(row, "backendSession")
	result := make(chan receiptExecutionResult, 1)
	go func() {
		defer service.jobs.finish()
		job, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Duration(min(timeout, 86400000))*time.Millisecond)
		defer cancel()
		defer context.AfterFunc(lifetime, cancel)()
		owner, err := store.begin(job, row)
		if err != nil {
			result <- receiptExecutionResult{err: err}
			return
		}
		defer owner.close()
		value, err := execute(job, row)
		if job.Err() != nil && err != nil {
			err = fmt.Errorf("SUBMISSION_UNCONFIRMED: %w", err)
		}
		if err == nil {
			row["state"], row["result"] = "completed", value
			for _, fieldName := range []string{"threadId", "turnId", "taskId"} {
				if id := field(value, fieldName); id != nil {
					row[fieldName] = id
				}
			}
		} else {
			state := "failed"
			switch {
			case strings.HasPrefix(err.Error(), "SUBMISSION_UNCONFIRMED"):
				state = "unconfirmed"
			case strings.HasPrefix(err.Error(), "RPC_REJECTED"), strings.HasPrefix(err.Error(), "DESKTOP_REJECTED"):
				state = "rejected"
			}
			if row["failureStage"] == nil && row["submissionStage"] != nil {
				row["failureStage"] = row["submissionStage"]
			}
			failure := transportError(err)
			if row["operation"] == "command" || strings.HasPrefix(err.Error(), "RPC_REJECTED:") {
				failure = controlFailure(err)
			}
			row["state"] = state
			dispatchSetSection(row, "result")["error"] = failure
		}
		if err := store.checkpoint(context.WithoutCancel(job), row); err != nil {
			result <- receiptExecutionResult{err: receiptPersistenceError(row, err)}
			return
		}
		result <- receiptExecutionResult{value: row}
	}()
	return store.wait(ctx, key, session, time.Duration(wait)*time.Millisecond, result)
}

func controlNativeDomain(ctx context.Context, request operationRequest) (any, error) {
	if nativeControlRequest == nil {
		return nil, errors.New(PortPending)
	}
	args, spec := request.args, operation(request.name)
	for name, fieldSchema := range obj(field(spec["inputSchema"], "properties")) {
		if value, exists := obj(fieldSchema)["default"]; exists {
			if _, present := args[name]; !present {
				args[name] = value
			}
		}
	}
	mapping := arr(field(field(field(catalog()["domains"], request.name), "actions"), text(args, "action")))
	if len(mapping) < 2 {
		return nil, errors.New("UNKNOWN_ACTION")
	}
	method := str(mapping[0])
	params, exists := args["params"]
	if !exists && method != "account/workspaceMessages/read" {
		params = object{}
	}
	if mapping[1] == true {
		return nativeControlRequest(ctx, request.service, method, params, time.Duration(min(uintOr(args["timeoutMs"], 60000), 86400000))*time.Millisecond)
	}
	nativeArgs := object{"method": method, "params": params, "requestId": args["requestId"],
		"timeoutMs": uintOr(args["timeoutMs"], 86400000), "waitMs": uintOr(args["waitMs"], 25000)}
	if request.name == "command" && args["action"] == "exec" && args["outputBudget"] != nil {
		nativeArgs["outputBudget"] = args["outputBudget"]
	}
	if _, ok := args["project"].(string); ok {
		nativeArgs["project"] = args["project"]
		if root, ok := args["root"]; ok {
			nativeArgs["root"] = root
		}
	}
	return controlNativeWrite(ctx, request, nativeArgs)
}

func controlNativeWrite(ctx context.Context, request operationRequest, args object) (any, error) {
	if nativeControlRequest == nil {
		return nil, errors.New(PortPending)
	}
	args = maps.Clone(args)
	if _, supplied := args["timeoutMs"]; !supplied {
		args["timeoutMs"] = 86400000
	}
	return runControlMutation(ctx, request, "native", args, func(ctx context.Context, row object) (any, error) {
		return executeNativeCodexReceipt(ctx, request.service, request.name, row)
	})
}

func controlSubmissionHistory(ctx context.Context, fresh bool, list func(context.Context, any) (object, error)) ([]any, error) {
	turns := []any{}
	var cursor any
	for !fresh {
		page, err := list(ctx, cursor)
		if err != nil {
			return nil, err
		}
		items := arr(page["data"])
		if items == nil {
			return nil, errors.New("native-turns-missing")
		}
		turns = append(turns, items...)
		next := page["nextCursor"]
		if next == nil {
			break
		}
		if wire(next) == wire(cursor) {
			return nil, errors.New("native-turn-cursor-repeated")
		}
		cursor = next
	}
	slices.Reverse(turns)
	return turns, nil
}

func nativeCleanupResult(err error) (object, error) {
	if err == nil {
		return object{"archived": true}, nil
	}
	if strings.Contains(err.Error(), "is not materialized yet") {
		return object{"archived": false, "reason": "thread-not-materialized"}, nil
	}
	return nil, err
}

const desktopCursorError = "DESKTOP_CURSOR_MISMATCH: cursor belongs to another read; reuse the same op, threadId and selection (turnId/latest for codex_items), or omit cursor to restart pagination"

func desktopControlPage(kind string, args object, data []any) (object, error) {
	binding := object{"kind": kind, "threadId": args["threadId"], "turnId": args["turnId"], "direction": args["sortDirection"]}
	var offset uint64
	if cursor, ok := args["cursor"].(string); ok {
		encoded, ok := strings.CutPrefix(cursor, "desktop:")
		if !ok {
			return nil, errors.New(desktopCursorError)
		}
		bytes, err := base64.RawURLEncoding.DecodeString(encoded)
		if err != nil {
			return nil, err
		}
		var current object
		if err := decodeObject(bytes, &current); err != nil {
			return nil, err
		}
		if wire(current["binding"]) != wire(binding) {
			return nil, errors.New(desktopCursorError)
		}
		offset = uintOr(current["offset"], 0)
	}
	limit := min(max(uintOr(args["limit"], 50), 1), 100)
	start := min(offset, uint64(len(data)))
	end := min(start+limit, uint64(len(data)))
	var next any
	if end < uint64(len(data)) {
		next = "desktop:" + base64.RawURLEncoding.EncodeToString([]byte(wire(object{"binding": binding, "offset": end})))
	}
	page := slices.Clone(data[start:end])
	if page == nil {
		page = []any{}
	}
	return object{"data": page, "nextCursor": next}, nil
}

func receiptPersistenceError(row object, err error) error {
	receipt := publicReceipt(row)
	return errors.New(wire(object{"code": "SUBMISSION_UNCONFIRMED",
		"message":   fmt.Sprintf("Operation returned, but receipt persistence failed: %v. The attached receipt is the observed outcome, not a confirmed durable checkpoint. Do not repeat the operation.", err),
		"requestId": receipt["requestId"], "stage": "receipt-checkpoint", "receipt": receipt,
		"next": object{"via": "act", "op": "receipt", "args": object{"action": "read", "requestId": receipt["requestId"]},
			"hint": "Reconcile the original receipt and observed outcome without resubmitting."}}))
}

func init() {
	registerOperationFallback("codex_pending", pendingControlInteractions)
	for _, name := range slices.Sorted(maps.Keys(obj(catalog()["domains"]))) {
		registerOperationFallback(name, controlNativeDomain)
	}
	registerOperation("codex_query", func(ctx context.Context, r operationRequest) (any, error) {
		if nativeControlRequest == nil {
			return nil, errors.New(PortPending)
		}
		return nativeControlRequest(ctx, r.service, text(r.args, "method"), r.args["params"], time.Minute)
	}, nil)
	registerOperation("codex_call", func(ctx context.Context, r operationRequest) (any, error) {
		return controlNativeWrite(ctx, r, r.args)
	}, nil)
	registerOperation("file_search", func(ctx context.Context, r operationRequest) (any, error) {
		if nativeControlRequest == nil {
			return nil, errors.New(PortPending)
		}
		return nativeControlRequest(ctx, r.service, "fuzzyFileSearch", r.args, time.Minute)
	}, nil)
}

var dispatchTitlePrefix = regexp.MustCompile(`^\s*(?:(?:[#>]+|[-*+]|[0-9]+[.)])\s+)*`)

func dispatchTitle(args object) string {
	if title := strings.Join(strings.Fields(text(args, "title")), " "); title != "" {
		return runeExcerpt(title, 120)
	}
	prompt := text(args, "prompt")
	if strings.TrimSpace(prompt) == "" {
		lines := []string{}
		for _, part := range arr(args["input"]) {
			if text, ok := field(part, "text").(string); ok {
				lines = append(lines, text)
			}
		}
		prompt = strings.Join(lines, "\n")
	}
	for line := range strings.SplitSeq(prompt, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			return runeExcerpt(strings.TrimSpace(dispatchTitlePrefix.ReplaceAllString(line, "")), 120)
		}
	}
	return ""
}

func reconcileActiveConfiguration(dispatch, active, state object, records []object) error {
	turn, exists := active["turnId"]
	if !exists {
		turn = active["id"]
	}
	var started object
	if turn != nil {
		for _, row := range slices.Backward(records) {
			if row["turnId"] == turn && row["dispatchMode"] != "steered" {
				started = row
				break
			}
		}
	}
	provenance := obj(dispatch["source"])
	if provenance == nil {
		provenance = object{}
		dispatch["source"] = provenance
	}
	for _, keys := range [][3]string{{"model", "latestModel", "model"}, {"effort", "latestReasoningEffort", "reasoningEffort"}, {"serviceTier", "serviceTier", "serviceTier"}} {
		fieldName := keys[0]
		resolved := "unknown"
		for _, raw := range []any{active[fieldName], field(state["latestThreadSettings"], fieldName), state[keys[1]], state[keys[2]], started[fieldName]} {
			if value := str(raw); value != "" && value != "unknown" {
				resolved = value
				break
			}
		}
		if resolved != "unknown" && provenance[fieldName] == "explicit" && dispatch[fieldName] != resolved {
			return errors.New("ACTIVE_TURN_CONFIGURATION: cannot change model/effort/serviceTier with steer; wait for completion or use sendMode:queue")
		}
		dispatch[fieldName], provenance[fieldName] = resolved, "active-turn"
	}
	return nil
}

func retryTurnParams(params object) object {
	result := clone(params)
	for _, key := range []string{"input", "threadId", "expectedTurnId"} {
		delete(result, key)
	}
	return result
}

func configuredTurn(args object, cwd string) (object, error) {
	params := selectFields(args, "model", "effort", "serviceTier")
	maps.Copy(params, obj(args["turn"]))
	if obj(params["sandboxPolicy"]) == nil && params["permissions"] == nil {
		if mode, ok := args["mode"].(string); ok {
			switch mode {
			case "danger-full-access":
				params["sandboxPolicy"] = object{"type": "dangerFullAccess"}
			case "read-only":
				params["sandboxPolicy"] = object{"type": "readOnly", "networkAccess": args["networkAccess"] == true}
			default:
				roots := []string{}
				if cwd != "" {
					roots = append(roots, cwd)
				}
				params["sandboxPolicy"] = object{"type": "workspaceWrite", "writableRoots": roots, "networkAccess": args["networkAccess"] == true,
					"excludeTmpdirEnvVar": false, "excludeSlashTmp": false}
			}
		}
	}
	if _, present := args["networkAccess"]; present && params["sandboxPolicy"] == nil {
		return nil, errors.New("networkAccess requires mode or sandboxPolicy")
	}
	return params, nil
}

var readThreadPending func(context.Context, *service, string) error
var authorizeNativeInteraction func(context.Context, object) error

func pendingControlInteractions(ctx context.Context, r operationRequest) (any, error) {
	thread := text(r.args, "threadId")
	if thread != "" {
		if readThreadPending == nil {
			return nil, errors.New(PortPending)
		}
		if err := readThreadPending(ctx, r.service, thread); err != nil {
			return nil, err
		}
	}
	requests := []object{}
	for _, row := range r.service.events.pendingInteractions() {
		if thread != "" && text(row["params"], "threadId") != thread {
			continue
		}
		if row["responseId"] == nil {
			row["responseId"] = wire(row["id"])
		}
		if authorizeNativeInteraction == nil {
			return nil, errors.New(PortPending)
		}
		if err := authorizeNativeInteraction(ctx, row); err != nil {
			return nil, err
		}
		row["questionSummary"] = interactionPreview(row)
		requests = append(requests, row)
	}
	return object{"backendSession": r.service.metadata["instance"], "requests": requests}, nil
}
