package core

import (
	"cmp"
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

func listNativeAgentStates(agent string, includeArchived bool) ([]object, error) {
	dir := filepath.Join(root(), "agents", "tasks")
	entries, err := cachedEntries(dir)
	if errors.Is(err, os.ErrNotExist) {
		return []object{}, nil
	}
	if err != nil {
		return nil, err
	}
	rows := []object{}
	for _, entry := range entries {
		if !entry.kind.IsRegular() || filepath.Ext(entry.path) != ".json" {
			continue
		}
		value, err := cachedLoad(entry.path)
		if err != nil {
			continue
		}
		task := obj(value)
		if task == nil || task["archived"] == true && !includeArchived || agent != "" && task["agent"] != agent {
			continue
		}
		rows = append(rows, task)
	}
	slices.SortStableFunc(rows, func(a, b object) int {
		return cmp.Or(cmp.Compare(text(b, "updatedAt"), text(a, "updatedAt")), cmp.Compare(text(a, "taskId"), text(b, "taskId")))
	})
	return rows, nil
}

func nativeAgentReadAllowed(ctx context.Context, agent, task string) bool {
	return ctx.Value(&peerControlKey) == nil || peerCanReadTask != nil && peerCanReadTask(ctx, agent, task)
}

func readNativeAgentOperation(ctx context.Context, r operationRequest) (any, error) {
	ctx = withRuntimeCost(ctx, "taskRead", "poll")
	agent, taskID := text(r.args, "agent"), text(r.args, "taskId")
	if !nativeAgentReadAllowed(ctx, agent, taskID) {
		return nil, errors.New("TASK_NOT_FOUND")
	}
	task, err := r.service.nativeAgentTask(agent, taskID)
	if err != nil {
		return nil, err
	}
	out := clone(task)
	for _, key := range []string{"taskHost", "processSession", "tracking", "_turnLifecycle", "coordinationPending", "pendingInteractions", "nativeSession", "agentapiBinary"} {
		delete(out, key)
	}
	if output, settled := agentSettledOutput(task); settled {
		out["finalResponse"] = output
	}
	records, err := dispatchRecords(taskID)
	if err != nil {
		return nil, err
	}
	out["dispatches"] = records
	if wantsTaskSummary(r.name, r.args) {
		if err := addAgentTaskSummaryEvidence(out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func listNativeAgentOperation(ctx context.Context, r operationRequest) (any, error) {
	agent := text(r.args, "agent")
	tasks, err := listNativeAgentStates(agent, r.args["archived"] == true)
	if err != nil {
		return nil, err
	}
	rows := []object{}
	for _, task := range tasks {
		if !nativeAgentReadAllowed(ctx, text(task, "agent"), text(task, "taskId")) {
			continue
		}
		row := selectFields(task, "taskId", "turnId", "agent", "sessionId", "title", "cwd", "status", "processState", "updatedAt", "createdAt", "archived")
		row["runtimeStatus"] = agentTurnRuntime(task)
		rows = append(rows, row)
	}
	return object{"tasks": rows[:min(len(rows), int(min(uintOr(r.args["limit"], 100), 200)))], "observedAt": now()}, nil
}

func nativeAgentTimeline(ctx context.Context, s *service, args object) (object, error) {
	ctx = withRuntimeCost(ctx, "taskRead", "poll")
	taskID := str(dispatchFirstString(args["id"], args["taskId"]))
	if uuid.Validate(taskID) != nil {
		return nil, errors.New("INVALID_SESSION_ID")
	}
	agent := text(args, "agent")
	if !nativeAgentReadAllowed(ctx, agent, taskID) {
		return nil, errors.New("TASK_NOT_FOUND")
	}
	task, err := s.nativeAgentTask(agent, taskID)
	if agent == "antigravity" && ctx.Value(&peerControlKey) == nil {
		session := ""
		if err != nil {
			session = taskID
		} else if task["runtimeSource"] == antigravityDesktopProtocol && task["archived"] != true {
			session = text(task, "sessionId")
		}
		if session != "" {
			if native, readErr := nativeAntigravityTimeline(ctx, session); readErr == nil {
				return native, nil
			}
		}
	}
	if err != nil {
		if err.Error() == "TASK_NOT_FOUND" && ctx.Value(&peerControlKey) == nil {
			for _, external := range nativeAgentConversationFiles(ctx, agent) {
				if external.row["id"] == taskID {
					return nativeAgentTranscriptTimeline(ctx, external)
				}
			}
		}
		return nil, err
	}
	var timeline taskTimeline
	if tracking := obj(task["tracking"]); tracking != nil {
		if err := unmarshalJSON([]byte(wire(tracking)), &timeline); err != nil {
			return nil, err
		}
	}
	out := timeline.response(taskID, uintOr(args["after"], 0))
	out["status"] = task["status"]
	out["srcConversation"], err = taskSRCReference(text(task, "agent"), taskID)
	return out, err
}

type nativeCodexConversationCursor struct {
	Cursor   *string `json:"cursor"`
	Consumed int     `json:"consumed"`
}

type nativeConversationCursor struct {
	Codex *nativeCodexConversationCursor `json:"codex"`
	Local []any                          `json:"local"`
}

func nativeConversationTime(row object, key string) time.Time {
	value, _ := time.Parse(time.RFC3339Nano, text(row, key))
	return value
}

func nativeConversationKey(row object, key string) []any {
	at := nativeConversationTime(row, key)
	var pair any
	if !at.IsZero() {
		pair = []any{at.Unix(), at.Nanosecond()}
	}
	return []any{pair, row["agent"], row["id"]}
}

func compareNativeConversationKeys(a, b []any) int {
	timestamp := func(value any) time.Time {
		if parts := arr(value); len(parts) == 2 {
			seconds, first := strconv.ParseInt(wire(parts[0]), 10, 64)
			nanos, second := strconv.ParseInt(wire(parts[1]), 10, 64)
			if first == nil && second == nil {
				return time.Unix(seconds, nanos)
			}
		}
		return time.Time{}
	}
	return cmp.Or(timestamp(b[0]).Compare(timestamp(a[0])), cmp.Compare(str(a[1]), str(b[1])), cmp.Compare(str(a[2]), str(b[2])))
}

func codexConversationTimestamp(value any) any {
	if seconds, err := strconv.ParseInt(wire(value), 10, 64); err == nil {
		return time.Unix(seconds, 0).UTC().Format(time.RFC3339)
	}
	return value
}

func readNativeCodexConversations(ctx context.Context, s *service, body object, projects []any, sortKey string, limit uint64, cursor any, timeout time.Duration) ([]object, *string, error) {
	params := object{"archived": false, "limit": limit, "sortKey": sortKey, "sortDirection": "desc"}
	if cursor != nil {
		params["cursor"] = cursor
	}
	subagents := body["includeSubagents"] == true
	if subagents {
		params["sourceKinds"] = []string{"cli", "vscode", "exec", "appServer", "subAgentThreadSpawn"}
	}
	raw, err := requestCodexNative(ctx, s, "thread/list", params, timeout)
	if err != nil {
		return nil, nil, err
	}
	data := arr(field(raw, "data"))
	if data == nil {
		return nil, nil, errors.New("NATIVE_CONVERSATIONS_MISSING")
	}
	rows := []object{}
	_, home, _ := codexInputs()
	for _, thread := range data {
		nativeID := text(thread, "id")
		if nativeID == "" || !nativeAgentReadAllowed(ctx, "codex", nativeID) {
			continue
		}
		title := str(dispatchFirstString(nativeCodexTitle(thread), field(thread, "preview")))
		row := object{"id": nativeID, "agent": "codex", "title": runeExcerpt(title, 240), "project": field(thread, "cwd"),
			"projectName": localProjectName(projects, text(thread, "cwd"), text(thread, "projectId")), "preview": runeExcerpt(text(thread, "preview"), 240),
			"createdAt": codexConversationTimestamp(field(thread, "createdAt")), "updatedAt": codexConversationTimestamp(field(thread, "updatedAt")),
			"source": "codex-thread", "status": "unknown", "turnId": nil, "turnStartedAt": nil, "turnEndedAt": nil, "turnDurationMs": nil,
			"dispatchSummary": nil, "turnCount": nil, "metadataPartial": nil,
			"runtimeStatus": dispatchFirstString(field(thread, "status"), field(field(thread, "status"), "type"))}
		if parent := text(field(field(field(thread, "source"), "subAgent"), "thread_spawn"), "parent_thread_id"); parent != "" {
			row["parentSessionId"], row["relationKind"] = parent, "subagent"
		}
		if home != "" {
			for key, value := range codexConversationClockForThread(ctx, home, thread) {
				if value != nil {
					row[key] = value
				}
			}
		}
		rows = append(rows, row)
	}
	return rows, optionalProjectString(field(raw, "nextCursor")), nil
}

func listNativeConversations(ctx context.Context, s *service, body object) (object, error) {
	ctx = withRuntimeCost(ctx, "agentTaskRecords", "poll")
	agent := text(body, "agent")
	if _, known := nativeAgentDriverByID(agent); agent != "" && !known {
		return nil, errors.New("UNKNOWN_AGENT: read agents.list for registered IDs")
	}
	fieldName, sortKey := "createdAt", "created_at"
	if body["sort"] == "updated" {
		fieldName, sortKey = "updatedAt", "updated_at"
	}
	limit := max(1, min(uintOr(body["limit"], 20), 50))
	projectCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	projects, _ := cachedNativeProjects(projectCtx, s)
	cancel()
	if agent == "codex" && body["agents"] == nil {
		data, next, err := readNativeCodexConversations(ctx, s, body, projects, sortKey, limit, body["cursor"], time.Minute)
		return object{"data": data, "nextCursor": next, "scope": "native-unarchived"}, err
	}
	disabled, err := disabledNativeAgents()
	if err != nil {
		return nil, err
	}
	selected := arr(body["agents"])
	drivers, err := agentRegistry()
	if err != nil {
		return nil, err
	}
	included := map[string]bool{}
	for _, driver := range drivers {
		id := driver.id
		enabled := !slices.Contains(disabled, any(id))
		included[id] = selected != nil && enabled && slices.Contains(selected, any(id)) ||
			selected == nil && (agent == id || agent == "" && enabled)
	}
	for _, id := range selected {
		if _, known := included[str(id)]; !known {
			return nil, errors.New("UNKNOWN_AGENT: read agents.list for registered IDs")
		}
	}
	var cursor nativeConversationCursor
	if value, supplied := body["cursor"].(string); supplied {
		if unmarshalJSON([]byte(value), &cursor) != nil || cursor.Local != nil && len(cursor.Local) != 3 ||
			cursor.Codex != nil && cursor.Codex.Consumed < 0 {
			return nil, errors.New("INVALID_CONVERSATION_CURSOR")
		}
	} else if included["codex"] {
		cursor.Codex = &nativeCodexConversationCursor{}
	}
	states, err := listNativeAgentStates("", true)
	if err != nil {
		return nil, err
	}
	rows := []object{}
	nativeSessions := map[string]bool{}
	for _, task := range states {
		taskID, owner := text(task, "taskId"), text(task, "agent")
		if !included[owner] || !nativeAgentReadAllowed(ctx, owner, taskID) {
			continue
		}
		if session := text(task, "sessionId"); session != "" {
			nativeSessions[owner+"\x00"+session] = true
		}
		if task["archived"] == true {
			continue
		}
		row := selectFields(task, "agent", "title", "cwd", "createdAt", "updatedAt", "status", "turnId", "sessionId")
		row["id"], row["taskId"], row["source"], row["project"] = taskID, taskID, "arc-task", task["cwd"]
		rows = append(rows, row)
	}
	if ctx.Value(&peerControlKey) == nil {
		var native []object
		if included["antigravity"] {
			native = listNativeAntigravity(ctx)
		}
		for _, agent := range []string{"claude", "pi"} {
			if !included[agent] {
				continue
			}
			for _, file := range nativeAgentConversationFiles(ctx, agent) {
				native = append(native, file.row)
			}
		}
		local := map[string]object{}
		for _, row := range rows {
			if session := text(row, "sessionId"); session != "" {
				key := text(row, "agent") + "\x00" + session
				row["nativeSessionId"] = session
				if local[key] == nil {
					local[key] = row
				}
			}
		}
		for _, row := range native {
			agent := text(row, "agent")
			key := agent + "\x00" + text(row, "id")
			if task := local[key]; task != nil {
				for _, field := range []string{"updatedAt", "preview", "messageCount", "metadataPartial", "relationKind", "parentSessionId"} {
					if value, found := row[field]; found {
						task[field] = value
					}
				}
				if agent == "antigravity" {
					for _, field := range []string{"title", "project", "turnCount", "turnStartedAt", "turnEndedAt", "turnDurationMs", "agentName", "nativeStatus", "dispatchSummary"} {
						if value := row[field]; value != nil && value != "" {
							task[field] = value
						}
					}
				}
			} else if !nativeSessions[key] {
				rows = append(rows, row)
			}
		}
	}
	filter := strings.TrimSpace(strings.ToLower(text(body, "search")))
	rows = slices.DeleteFunc(rows, func(row object) bool {
		return body["includeSubagents"] != true && row["relationKind"] == "subagent" ||
			cursor.Local != nil && compareNativeConversationKeys(nativeConversationKey(row, fieldName), cursor.Local) <= 0 ||
			filter != "" && !strings.Contains(strings.ToLower(text(row, "title")+" "+text(row, "project")), filter)
	})
	slices.SortStableFunc(rows, func(a, b object) int {
		return compareNativeConversationKeys(nativeConversationKey(a, fieldName), nativeConversationKey(b, fieldName))
	})
	var upstream []object
	var upstreamNext *string
	if cursor.Codex != nil && included["codex"] {
		var err error
		var upstreamCursor any
		if cursor.Codex.Cursor != nil {
			upstreamCursor = *cursor.Codex.Cursor
		}
		upstream, upstreamNext, err = readNativeCodexConversations(ctx, s, body, projects, sortKey, 50, upstreamCursor, 3*time.Second)
		if err != nil {
			upstream, upstreamNext = nil, nil
		}
		slices.SortStableFunc(upstream, func(a, b object) int {
			return nativeConversationTime(b, fieldName).Compare(nativeConversationTime(a, fieldName))
		})
		upstream = upstream[min(len(upstream), cursor.Codex.Consumed):]
	}
	page, next := mergeNativeConversationPage(rows, upstream, upstreamNext, &cursor, limit, fieldName)
	for _, row := range page {
		if row["agent"] != "codex" {
			row["projectName"] = localProjectName(projects, text(row, "project"), "")
		}
	}
	scope := "arc-tasks"
	if agent == "" {
		scope = "native-and-arc-tasks"
	} else {
		for id, enabled := range included {
			if enabled && capabilitiesForAgent(id).NativeConversations {
				scope = "native-and-arc-tasks"
			}
		}
	}
	return object{"data": page, "nextCursor": next, "scope": scope}, nil
}

func mergeNativeConversationPage(rows, upstream []object, upstreamNext *string, cursor *nativeConversationCursor, limit uint64, fieldName string) ([]object, any) {
	page := make([]object, 0, limit)
	for uint64(len(page)) < limit {
		switch {
		case len(upstream) > 0 && (len(rows) == 0 || !nativeConversationTime(upstream[0], fieldName).Before(nativeConversationTime(rows[0], fieldName))):
			page, upstream = append(page, upstream[0]), upstream[1:]
			cursor.Codex.Consumed++
		case len(rows) != 0 && (len(upstream) != 0 || upstreamNext == nil):
			row := rows[0]
			page, rows = append(page, row), rows[1:]
			cursor.Local = nativeConversationKey(row, fieldName)
		default:
			goto finished
		}
	}
finished:
	if len(upstream) == 0 {
		cursor.Codex = nil
		if upstreamNext != nil {
			cursor.Codex = &nativeCodexConversationCursor{Cursor: upstreamNext}
		}
	}
	if cursor.Codex != nil || len(rows) > 0 {
		return page, wire(*cursor)
	}
	return page, nil
}

func nativeAgentContext(ctx context.Context, s *service, agent, taskID string) (contextTaskEvidence, error) {
	var facts contextTaskEvidence
	if !nativeAgentReadAllowed(ctx, agent, taskID) {
		return facts, errors.New("TASK_NOT_FOUND")
	}
	if agent == "codex" {
		args := object{"agent": "codex", "id": taskID}
		timeline, err := nativeCodexConversationTimeline(ctx, s, args)
		if err != nil {
			return facts, err
		}
		facts.Task = object{"taskId": taskID, "agent": "codex", "turnId": timeline["turnId"], "status": timeline["status"],
			"cwd": field(timeline["info"], "project"), "runtimeSource": field(timeline["ownership"], "owner")}
		facts.Evidence, facts.ExecutionEvidence = decodedTaskList(timeline["entries"]), timeline["executionEvidence"]
		facts.ObservedEvents = uintOr(field(timeline["coverage"], "observedEvents"), 0)
		facts.Partial = field(timeline["coverage"], "state") == "partial"
		return facts, nil
	}
	task, err := s.nativeAgentTask(agent, taskID)
	if err != nil {
		return facts, err
	}
	facts.Task = task
	facts.RedactedOutput = redactTaskOutput(text(task, "output"))
	var timeline taskTimeline
	if err := unmarshalJSON([]byte(wire(task["tracking"])), &timeline); err == nil {
		facts.Evidence = timeline.evidence(optionalProjectString(task["turnId"]))
		facts.ExecutionEvidence, facts.ObservedEvents, facts.Partial = timeline.executionEvidence(), timeline.ObservedEvents, timeline.Partial
	}
	return facts, nil
}

func init() {
	readContextTask = nativeAgentContext
	registerRoute(http.MethodPost, "agents/conversations", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		return listNativeConversations(ctx, s, body)
	})
}
