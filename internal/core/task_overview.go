package core

import (
	"cmp"
	"context"
	"errors"
	"maps"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
)

var taskRecordNavigation func(agent, task string) object
var peerCanReadTask func(context.Context, string, string) bool
var taskListRetryStatus func(thread, turn string) object
var taskListQueueCounts func(context.Context, *service) (map[string]object, error)
var taskListReviews func(thread string) ([]object, error)
var taskListOrigin func(thread string) any
var taskListSourceReference func(agent, thread string) any

func listTaskRecords(codex, agents []object) []object {
	rows := make([]object, 0, len(codex)+len(agents))
	for _, batch := range [][]object{codex, agents} {
		for _, record := range batch {
			row := clone(record)
			agent, provided := row["agent"].(string)
			if !provided {
				agent = "codex"
			}
			task, provided := row["taskId"].(string)
			if !provided {
				task = receiptThread(row)
			}
			if taskRecordNavigation != nil {
				if link := taskRecordNavigation(agent, task); link != nil {
					row["open"] = link
				}
			}
			stripNotificationInternal(row)
			rows = append(rows, row)
		}
	}
	slices.SortStableFunc(rows, func(a, b object) int {
		return cmp.Or(cmp.Compare(text(b, "createdAt"), text(a, "createdAt")),
			cmp.Compare(text(a, "requestId"), text(b, "requestId")))
	})
	return rows
}

type taskFeed struct {
	codex, agents []object
	sources       string
	accounts      []any
	desktop       bool
	revision      string
	records       []object
	previous      string
	delta         object
}

func sameDisplayRows[T any](a, b []T) bool {
	return len(a) == len(b) && (len(a) == 0 || &a[0] == &b[0])
}

func (f *taskFeed) read(ctx context.Context, codex, agents []object, sourceLabels, accountLabels []any, desktop bool, revision string) object {
	cost := runtimeWorkCost{Owner: "task-feed", Reason: "poll", ScanSet: len(codex) + len(agents)}
	if f.records == nil || !sameDisplayRows(f.codex, codex) || !sameDisplayRows(f.agents, agents) ||
		f.sources != wire(sourceLabels) || !sameDisplayRows(f.accounts, accountLabels) || f.desktop != desktop {
		cost.Rows = len(codex) + len(agents)
		next := listTaskRecords(codex, agents)
		labelRows := decodedTaskList(next)
		decorateSourceLabels(labelRows, sourceLabels)
		decorateAccountLabels(labelRows, accountLabels)
		if wire(next) != wire(f.records) {
			old := make(map[string]object, len(f.records))
			for _, row := range f.records {
				old[text(row, "requestId")] = row
			}
			changed := []object{}
			for _, row := range next {
				request := text(row, "requestId")
				if before, present := old[request]; !present || wire(before) != wire(row) {
					changed = append(changed, row)
				}
				delete(old, request)
			}
			removed := append([]string{}, slices.Sorted(maps.Keys(old))...)
			f.previous, f.revision, f.records = f.revision, id(), next
			f.delta = nil
			if f.previous != "" && len(changed)+len(removed) <= 256 {
				f.delta = object{"revision": f.revision, "records": changed, "removed": removed}
			}
		}
		f.codex, f.agents, f.desktop = codex, agents, desktop
		f.sources, f.accounts = wire(sourceLabels), accountLabels
	}
	recordRuntimeWork(ctx, cost)
	if revision == f.revision {
		return object{"revision": f.revision}
	}
	if revision == f.previous && f.delta != nil {
		return f.delta
	}
	return object{"revision": f.revision, "records": f.records}
}

func displayTaskRecord(row object) object {
	result := selectFields(row, "requestId", "agent", "agentAccountId", "taskId", "threadId", "turnId", "origin", "state", "createdAt",
		"updatedAt", "approval", "executionOwner", "submissionStage", "open", "error")
	if recovery := obj(row["desktopRecovery"]); recovery != nil {
		fields := selectFields(recovery, "state", "decisionId", "reason", "backend")
		switch target := field(recovery["target"], "pid"); target.(type) {
		case nil, string, bool, object, []any:
		default:
			fields["target"] = object{"pid": target}
		}
		result["desktopRecovery"] = fields
	}
	if runtime := obj(row["runtime"]); runtime != nil {
		fields := selectFields(runtime, "runtimeStatus", "title", "project", "observedAt", "stale", "archived")
		if ownership := obj(runtime["ownership"]); ownership != nil {
			fields["ownership"] = selectFields(ownership, "owner", "currentOwner", "state", "observedAt")
		}
		result["runtime"] = fields
	}
	task := obj(row["task"])
	details := selectFields(task, "origin", "agentAccountId", "detailsRecorded", "kind", "title", "project", "directory", "threadId", "model", "effort")
	prompt := text(task, "prompt")
	first, _, multiple := strings.Cut(prompt, "\n")
	if multiple {
		first = strings.TrimSuffix(first, "\r")
	}
	preview := runeExcerpt(first, 256)
	details["promptTruncated"], details["prompt"] = preview != prompt, preview
	result["task"] = details
	return result
}

func decodedTaskList(value any) []any {
	switch rows := value.(type) {
	case []object:
		result := make([]any, len(rows))
		for index, row := range rows {
			result[index] = row
		}
		return result
	default:
		return arr(value)
	}
}

func listCodexTasks(ctx context.Context, request operationRequest) (any, error) {
	args, service := request.args, request.service
	full := args["view"] == "full"
	enrich, supplied := args["enrich"].(bool)
	if !supplied {
		enrich = args["archived"] != true
	}
	params := maps.Clone(args)
	for _, key := range []string{"project", "view", "enrich"} {
		delete(params, key)
	}
	params["sortKey"], params["sortDirection"] = "updated_at", "desc"
	if _, found := params["limit"]; !found {
		params["limit"] = 20
	}
	if project, supplied := args["project"].(string); supplied {
		resolved, err := resolveProjectRoot(ctx, service, project, nil, false, nil)
		if err != nil {
			return nil, err
		}
		params["cwd"] = []any{resolved["root"]}
	}
	var page any
	cursor, supplied := args["cursor"].(string)
	if args["archived"] == true && !enrich && (!supplied || strings.HasPrefix(cursor, archiveIndexPrefix)) {
		_, home, err := codexInputs()
		if err != nil {
			return nil, err
		}
		indexed, err := listCodexArchive(ctx, home, params)
		if err != nil {
			return nil, err
		}
		if indexed != nil {
			page = indexed
		}
	}
	if page == nil {
		native, err := requestCodexNative(ctx, service, "thread/list", params, time.Minute)
		if err != nil {
			return nil, err
		}
		page = native
	}
	rows := decodedTaskList(field(page, "data"))
	if rows == nil {
		return nil, errors.New("NATIVE_TASKS_MISSING")
	}
	if ctx.Value(&peerControlKey) != nil {
		if peerCanReadTask == nil {
			return nil, errors.New(PortPending)
		}
		rows = slices.DeleteFunc(slices.Clone(rows), func(row any) bool { return !peerCanReadTask(ctx, "codex", text(row, "id")) })
	}
	recordRuntimeWork(ctx, runtimeWorkCost{Owner: "task-list", Reason: "poll", ScanSet: len(rows), Rows: len(rows)})
	tasks := make([]object, len(rows))
	if !enrich {
		for index, row := range rows {
			task := object{"threadId": field(row, "id"), "title": field(row, "name"), "project": field(row, "cwd"), "updatedAt": field(row, "updatedAt")}
			if full {
				task = codexNativeSummary(row)
			}
			task["archived"], task["runtimeStatus"], task["runtimeSource"], task["enriched"] = args["archived"], nil, "not-requested", false
			task["status"] = "not-observed"
			if args["archived"] == true {
				task["status"] = "archived"
			}
			tasks[index] = task
		}
		metadata, supplied := field(page, "metadataSource").(string)
		if !supplied {
			metadata = "native-app-server"
		}
		return object{"tasks": tasks, "nextCursor": field(page, "nextCursor"), "enriched": false, "metadataSource": metadata, "observedAt": now()}, nil
	}
	queues := map[string]object{}
	if taskListQueueCounts != nil {
		counts, err := taskListQueueCounts(ctx, service)
		if err != nil {
			return nil, err
		}
		queues = counts
	}
	observe, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	concurrent := make(chan struct{}, 32)
	var done sync.WaitGroup
	for index, row := range rows {
		done.Go(func() {
			thread := text(row, "id")
			metadata, turn, reason := collectCodexListEvidence(observe, service, thread, row, concurrent)
			interacting := slices.ContainsFunc(service.events.pendingInteractions(), func(r object) bool {
				return field(r["params"], "threadId") == thread
			})
			var retry object
			if taskListRetryStatus != nil {
				retry = taskListRetryStatus(thread, text(turn, "id"))
			}
			tasks[index] = compactCodexListEntry(row, metadata, turn, interacting, retry, queues[thread], reason, full)
		})
	}
	done.Wait()
	view := "compact"
	if full {
		view = "full"
	}
	return object{"observedAt": now(), "view": view, "tasks": tasks, "nextCursor": field(page, "nextCursor")}, nil
}

func collectCodexListEvidence(ctx context.Context, service *service, thread string, row any, slots chan struct{}) (any, any, string) {
	turnArgs := object{"threadId": thread, "limit": 1, "sortDirection": "desc", "itemsView": "notLoaded"}
	var recorded any
	if connection, err := service.codexUtility(ctx); err == nil {
		result, err := connection.call(ctx, "thread/turns/list", turnArgs, 3*time.Second)
		if turns := arr(field(result, "data")); err == nil && len(turns) > 0 {
			recorded = turns[0]
		}
	}
	const timeout = "live-status-timeout (8s page budget)"
	select {
	case slots <- struct{}{}:
		defer func() { <-slots }()
	case <-ctx.Done():
		return row, recorded, timeout
	}
	metadata, err := requestCodexNative(ctx, service, "thread/read", object{"threadId": thread, "includeTurns": false}, 5*time.Second)
	if err == nil {
		var result any
		result, err = requestCodexNative(ctx, service, "thread/turns/list", turnArgs, 5*time.Second)
		if err == nil {
			turns := arr(field(result, "data"))
			switch {
			case turns == nil:
				return row, recorded, "NATIVE_TURNS_MISSING"
			case field(field(metadata, "thread"), "id") != field(row, "id"):
				return row, recorded, "native-thread-id-mismatch"
			case len(turns) == 0:
				return field(metadata, "thread"), nil, ""
			default:
				return field(metadata, "thread"), turns[0], ""
			}
		}
	}
	if ctx.Err() != nil {
		return row, recorded, timeout
	}
	return row, recorded, err.Error()
}

func compactCodexListEntry(row, metadata, turn any, pending bool, retry, queue object, failure string, full bool) object {
	nativeStatus := field(metadata, "status")
	runtime := text(nativeStatus, "type")
	if failure != "" {
		runtime = "unknown"
	}
	flags := arr(field(nativeStatus, "activeFlags"))
	waiting := pending || slices.Contains(flags, any("waitingOnApproval")) || slices.Contains(flags, any("waitingOnUserInput"))
	retrying := retry["status"] == "scheduled" || retry["status"] == "submitting"
	key := turnKey{"codex", text(row, "id"), text(turn, "id")}
	var recorded *string
	if status, supplied := field(turn, "status").(string); supplied {
		recorded = &status
	}
	lifecycle := (turnTransition{key: key}).advance(codexOwnerEvidence(key, recorded, runtime, waiting, 0)).
		advance(codexTerminalEvidence(key, text(turn, "status"), 0, false))
	state, evidence := lifecycle.wait()
	status, reason := string(state), ""
	switch {
	case state == waitInteraction:
		status = "needs-input"
	case state == waitRunning && retrying:
		status = "retrying"
	case state == waitUnconfirmed && turn == nil && runtime == "idle" && failure == "":
		status = "idle"
		if uintOr(queue["pending"], 0) > 0 {
			status = "queued"
		}
	case state == waitUnconfirmed:
		reason = evidence
		if failure != "" {
			reason = failure
		}
	}
	model := func(value any) string {
		if name := text(value, "model"); name != "unknown" {
			return name
		}
		return ""
	}
	var modelName any
	modelSource := "not-reported-by-owner"
	if found := model(turn); found != "" {
		modelName, modelSource = found, "latest-turn"
	} else if found := model(metadata); found != "" {
		modelName, modelSource = found, "thread-settings"
	}
	title := field(metadata, "name")
	if str(title) == "" {
		title = field(row, "name")
	}
	out := object{}
	if full {
		out = codexNativeSummary(metadata)
	}
	thread := text(row, "id")
	out["title"], out["threadId"], out["project"], out["status"] = title, field(row, "id"), field(metadata, "cwd"), status
	out["runtimeStatus"], out["model"], out["modelSource"] = runtime, modelName, modelSource
	out["origin"], out["srcConversation"], out["currentTurn"] = nil, nil, nil
	if taskListOrigin != nil {
		out["origin"] = taskListOrigin(thread)
	}
	if taskListSourceReference != nil {
		out["srcConversation"] = taskListSourceReference("codex", thread)
	}
	updated, supplied := obj(metadata)["updatedAt"]
	if !supplied {
		updated = field(row, "updatedAt")
	}
	out["updatedAt"] = updated
	if turn != nil {
		source := "native-owner"
		if failure != "" || runtime == "notLoaded" {
			source = "persisted-history"
		}
		out["currentTurn"] = object{"turnId": field(turn, "id"), "status": field(turn, "status"), "source": source}
	}
	if reason != "" {
		out["statusReason"] = reason
	}
	if uintOr(queue["pending"], 0) > 0 {
		out["queue"] = queue
	}
	if retrying {
		out["retry"] = retry
	}
	if full {
		out["preview"] = field(row, "preview")
		for _, history := range []struct {
			name string
			read func(string) ([]object, error)
		}{{"reviews", taskListReviews}, {"dispatches", readNativeDispatchHistory}} {
			var value any = object{"unavailable": PortPending}
			if history.read != nil {
				if data, err := history.read(thread); err == nil {
					value = data
				} else {
					value = object{"unavailable": err.Error()}
				}
			}
			out[history.name] = value
		}
	}
	return out
}

func init() {
	registerOperation("codex_tasks", listCodexTasks, nil)
	registerRoute(http.MethodGet, "tasks", func(ctx context.Context, s *service, _ object, _ []string) (any, error) {
		codex, agents, err := s.taskDisplayRecords(ctx)
		if err != nil {
			return nil, err
		}
		return object{"records": listTaskRecords(codex, agents)}, nil
	})
	registerRoute(http.MethodPost, "tasks/snapshot", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		if _, _, _, err := managementResolve("tasks.snapshot", object{"body": body}); err != nil {
			return nil, err
		}
		codex, agents, err := s.taskDisplayRecords(ctx)
		if err != nil {
			return nil, err
		}
		authority, _ := listSourceAuthority()
		sources := make([]any, 0, len(authority))
		for _, row := range authority {
			sources = append(sources, selectFields(row, "id", "label", "platform"))
		}
		accounts, _ := readAccounts()
		desktop := fixtureNativeCodexInputs == nil && findDesktopCodexBinary != nil && findDesktopCodexBinary() != ""
		s.taskRecords.mu.Lock()
		defer s.taskRecords.mu.Unlock()
		return s.taskRecords.feed.read(ctx, codex, agents, sources, accounts, desktop, text(body, "revision")), nil
	})
}
