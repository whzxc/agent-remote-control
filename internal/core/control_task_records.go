package core

import (
	"context"
	"errors"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type nativeTaskRecords struct {
	mu               sync.Mutex
	codex            taskProjection
	agent            taskProjection
	feed             taskFeed
	indexReady       sync.Once
	indexReadySignal chan struct{}
}

func receiptThread(row object) string {
	result := row["result"]
	for _, value := range []any{row["threadId"], field(row["task"], "threadId"), field(result, "threadId"),
		field(field(result, "thread"), "id"), field(field(field(result, "resolved"), "thread"), "id")} {
		if thread, present := value.(string); present {
			return thread
		}
	}
	return ""
}

func codexRuntimePath(thread string) string {
	if uuid.Validate(thread) != nil {
		return ""
	}
	return filepath.Join(root(), "tasks", thread+".json")
}

func codexTaskDependencies(receipt object) []string {
	thread := receiptThread(receipt)
	if path := codexRuntimePath(thread); path != "" {
		return []string{path, filepath.Join(root(), "execution", thread+".json")}
	}
	return nil
}

func projectCodexTask(receipt object) (object, error) {
	operation := text(receipt, "operation")
	if operation == "review" {
		return nil, nil
	}
	row := maps.Clone(receipt)
	if obj(row["task"]) == nil {
		thread := receiptThread(row)
		if _, supplied := row["threadId"].(string); thread == "" && !supplied &&
			!slices.Contains([]string{"create", "send", "interrupt"}, operation) {
			return nil, nil
		}
		result := row["result"]
		resolved := field(result, "resolved")
		metadata, found := obj(resolved)["thread"]
		if !found {
			metadata = field(result, "thread")
		}
		directory, found := obj(metadata)["cwd"]
		if !found {
			directory = field(resolved, "cwd")
		}
		var threadID any
		if thread != "" {
			threadID = thread
		}
		row["task"] = object{"kind": operation, "title": field(metadata, "name"), "prompt": "", "project": nil, "directory": directory,
			"threadId": threadID, "model": field(row["requested"], "model"), "effort": field(row["requested"], "effort"), "detailsRecorded": false}
		row["threadId"] = threadID
	}
	if _, present := row["createdAt"].(string); !present {
		row["createdAt"] = row["updatedAt"]
	}
	if obj(row["approval"]) == nil {
		row["approval"] = object{"decision": "unrecorded", "source": "cloud", "at": row["createdAt"]}
	}
	thread, present := row["threadId"].(string)
	if !present {
		thread = text(row["task"], "threadId")
	}
	if path := codexRuntimePath(thread); path != "" {
		runtime, err := cachedLoad(path)
		if err == nil {
			if runtime := maps.Clone(obj(runtime)); runtime != nil {
				runtime["stale"] = true
				row["runtime"] = runtime
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	if present {
		owner := "desktop"
		if operatingSystem == "linux" {
			if thread != "" {
				owner = "connector"
			}
		} else {
			record, err := codexExecutionRecord(thread)
			if err != nil {
				return nil, err
			}
			if record["owner"] == "connector" {
				owner = "connector"
			}
		}
		row["executionOwner"] = owner
	}
	row["error"] = field(row["result"], "error")
	delete(row, "arguments")
	delete(row, "result")
	return row, nil
}

func nativeAgentTaskPath(task string) (string, error) {
	if uuid.Validate(task) != nil {
		return "", errors.New("INVALID_TASK_ID")
	}
	return filepath.Join(root(), "agents/tasks", task+".json"), nil
}

func projectAgentTask(receipt object, session string) (object, error) {
	kind := "create"
	switch receipt["operation"] {
	case "agent_create":
	case "agent_send":
		kind = "send"
	default:
		return nil, nil
	}
	var task object
	if path, err := nativeAgentTaskPath(text(receipt, "taskId")); err == nil {
		stored, err := cachedLoad(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		task = obj(stored)
	}
	if task["archived"] == true {
		return nil, nil
	}
	args := obj(receipt["arguments"])
	approval := text(args, "approval")
	switch {
	case receipt["state"] == "awaiting-approval":
		approval = "pending"
	case receipt["approval"] == "approve":
		approval = "approved"
	case receipt["approval"] == "reject", receipt["approval"] == "bypass":
		approval = text(receipt, "approval")
	case approval == "":
		approval = "automatic"
	}
	title, found := task["title"]
	if !found {
		title = args["title"]
	}
	cwd, found := task["cwd"]
	if !found {
		cwd = args["cwd"]
	}
	failure, found := receipt["error"]
	if !found {
		failure = field(receipt["result"], "error")
	}
	runtime := agentTurnRuntime(task)
	out := object{}
	for _, key := range []string{"agentAccountId", "requestId", "agent", "taskId", "turnId", "origin", "state", "createdAt", "updatedAt"} {
		out[key] = receipt[key]
	}
	out["approval"] = object{"decision": approval, "source": "cloud", "answeredBy": receipt["answeredBy"], "at": receipt["createdAt"]}
	out["task"] = object{"agentAccountId": receipt["agentAccountId"], "kind": kind, "origin": receipt["origin"], "title": title,
		"prompt": text(args, "prompt"), "input": []any{}, "directory": cwd, "model": args["model"], "settings": object{}}
	out["runtime"] = object{"runtimeStatus": runtime, "title": task["title"], "observedAt": task["updatedAt"],
		"stale": receipt["backendSession"] != session && (runtime == "active" || runtime == "waiting")}
	out["error"] = failure
	return out, nil
}

var waitFixtureTaskIndex func(context.Context, *service) error

func (s *service) readCodexTaskRecords(ctx context.Context) ([]object, error) {
	if waitFixtureTaskIndex != nil {
		if err := waitFixtureTaskIndex(ctx, s); err != nil {
			return nil, err
		}
	}
	state := &s.taskRecords
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.updateCodex(ctx, text(s.metadata, "instance"))
}

func (t *nativeTaskRecords) updateCodex(ctx context.Context, session string) ([]object, error) {
	rows, err := t.codex.update(ctx, coreReceiptStore(), session, codexTaskDependencies, projectCodexTask, displayTaskRecord)
	recordRuntimeWork(ctx, runtimeWorkCost{Owner: "task-records", Reason: "poll", ScanSet: len(rows)})
	return rows, err
}

func (s *service) taskDisplayRecords(ctx context.Context) ([]object, []object, error) {
	if waitFixtureTaskIndex != nil {
		if err := waitFixtureTaskIndex(ctx, s); err != nil {
			return nil, nil, err
		}
	}
	state := &s.taskRecords
	state.mu.Lock()
	defer state.mu.Unlock()
	session := text(s.metadata, "instance")
	if _, err := state.updateCodex(ctx, session); err != nil {
		return nil, nil, err
	}
	rows, err := state.agent.update(ctx, agentReceiptStore(), session, func(row object) []string {
		if path, err := nativeAgentTaskPath(text(row, "taskId")); err == nil {
			return []string{path}
		}
		return nil
	}, func(row object) (object, error) { return projectAgentTask(row, session) }, displayTaskRecord)
	recordRuntimeWork(ctx, runtimeWorkCost{Owner: "agent-task-records", Reason: "poll", ScanSet: len(rows)})
	return state.codex.display, state.agent.display, err
}

func nativeCodexTitle(thread any) any {
	for _, value := range []any{field(thread, "agentNickname"),
		field(field(field(field(thread, "source"), "subAgent"), "thread_spawn"), "agent_nickname"), field(thread, "name")} {
		if title := strings.TrimSpace(str(value)); title != "" {
			return title
		}
	}
	return nil
}

func codexNativeSummary(thread any) object {
	status := field(thread, "status")
	state, found := field(status, "type").(string)
	source := field(thread, "runtimeSource")
	if !found || state == "notLoaded" {
		state, source = "unknown", "persisted-history-only"
	}
	var archived any
	parts := strings.FieldsFunc(text(thread, "path"), func(c rune) bool { return c == '/' || c == '\\' })
	for _, part := range slices.Backward(parts) {
		if part == "sessions" || part == "archived_sessions" {
			archived = part == "archived_sessions"
			break
		}
	}
	configuration := object{"scope": "thread-defaults", "source": "thread/read-or-list", "turnEffective": "unknown"}
	for _, pair := range [][2]string{{"model", "model"}, {"effort", "reasoningEffort"}, {"modelProvider", "modelProvider"}} {
		v, exists := obj(thread)[pair[1]]
		if !exists {
			v = "unknown"
		}
		configuration[pair[0]] = v
	}

	send, change := "requires-native-ownership-check", "requires-idle"
	switch state {
	case "idle":
		send, change = "new-turn", "new-turn-and-subsequent"
	case "active":
		send = "steer"
	}
	flags, found := obj(status)["activeFlags"]
	if !found {
		flags = []any{}
	}
	summary := object{"archived": archived, "threadId": field(thread, "id"), "project": field(thread, "cwd"), "title": nativeCodexTitle(thread),
		"preview": field(thread, "preview"), "cwd": field(thread, "cwd"), "runtimeStatus": state, "runtimeSource": source,
		"configuration": configuration, "actions": object{"read": true, "send": send, "interrupt": "native-ownership-check", "configurationChange": change},
		"activeFlags": flags, "updatedAt": field(thread, "updatedAt"), "observedAt": now(), "businessDelivery": "not-assessed"}
	if operatingSystem != "linux" && field(thread, "runtimeSource") != "connector-app-server" {
		summary["desktopUrl"] = "codex://threads/" + text(thread, "id")
	}
	return summary
}

func observeCodexTaskRuntime(ctx context.Context, s *service, thread string) (any, error) {
	owner, err := nativeCodexOwner(ctx, operationRequest{args: object{"threadId": thread}, service: s})
	if err != nil {
		return nil, err
	}
	params := object{"threadId": thread, "includeTurns": false}
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	live, err := requestCodexNative(wait, s, "thread/read", params, 5*time.Second)
	cancel()
	var snapshot object
	path := codexRuntimePath(thread)
	if err == nil {
		snapshot = codexNativeSummary(field(live, "thread"))
	} else {
		connection, err := s.codexUtility(ctx)
		if err != nil {
			return nil, err
		}
		value, err := connection.call(ctx, "thread/read", params, 5*time.Second)
		if err != nil {
			return nil, err
		}
		state := maps.Clone(obj(field(value, "thread")))
		if state == nil {
			state = object{}
		}
		state["status"] = object{"type": "notLoaded"}
		snapshot = codexNativeSummary(state)
		if previous, err := cachedLoad(path); path != "" && err == nil {
			snapshot["runtimeStatus"], snapshot["observedAt"] = field(previous, "runtimeStatus"), field(previous, "observedAt")
		}
		snapshot["stale"] = true
	}
	if path != "" {
		if snapshot["archived"] == nil {
			if previous, err := cachedLoad(path); err == nil {
				snapshot["archived"] = field(previous, "archived")
			}
		}
		snapshot["ownership"] = owner
		if err := save(path, snapshot); err != nil {
			return nil, err
		}
	}
	snapshot["ownership"] = owner
	return snapshot, nil
}

func init() {
	readStatusTaskRecords = func(ctx context.Context, service *service) ([]object, error) {
		return service.readCodexTaskRecords(ctx)
	}
	registerRoutePattern(http.MethodGet, "tasks/runtime/([A-Za-z0-9-]+)", func(ctx context.Context, s *service, _ object, params []string) (any, error) {
		return observeCodexTaskRuntime(ctx, s, params[0])
	})
	registerServiceStartup(func(_ context.Context, service *service) error {
		service.cleanup = append(service.cleanup, func() {
			service.taskRecords.mu.Lock()
			defer service.taskRecords.mu.Unlock()
			service.taskRecords.codex.close()
			service.taskRecords.agent.close()
		})
		return nil
	})
}
