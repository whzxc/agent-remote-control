package core

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestTaskBubbleReadAndAcknowledgeUseDesktopSnapshot(t *testing.T) {
	// Contract: task bubble operations use the renderer's model and keep the requested Agent/task identity.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	unread := true
	target := &service{desktop: func(_ context.Context, route, method string, body object) (any, error) {
		bubble := obj(body["taskBubble"])
		if route != "app/snapshot" || method != http.MethodPost || body["modelOnly"] != true {
			return nil, fmt.Errorf("unexpected renderer request %s %s %v", method, route, body)
		}
		if bubble["id"] == "task" && bubble["agent"] == "codex" && bubble["action"] == "mark-read" {
			unread = false
		}
		return object{"model": object{"taskBubbles": []any{
			object{"id": "task", "agent": "pi", "unread": true},
			object{"id": "task", "agent": "codex", "unread": unread},
		}}}, nil
	}}
	source := requestSource{local: true, policy: "all"}
	request := object{"agent": "codex", "id": "task"}
	for _, step := range []struct {
		op     string
		unread bool
	}{{"task_bubble", true}, {"task_mark_read", false}, {"task_bubble", false}} {
		reply := localControl(t.Context(), target, source, object{"op": step.op, "args": request})
		value, err := egressToolValue(reply)
		if err != nil || reply["isError"] == true || field(value, "agent") != "codex" || field(value, "id") != "task" ||
			field(value, "unread") != step.unread {
			t.Fatalf("%s = %s, %v", step.op, wire(value), err)
		}
	}
	reply := localControl(t.Context(), target, source, object{"op": "task_bubble", "args": object{"agent": "codex", "id": "missing"}})
	value, err := egressToolValue(reply)
	if err != nil || reply["isError"] != true || !strings.Contains(text(field(value, "error"), "message"), "TASK_BUBBLE_NOT_FOUND") {
		t.Fatalf("missing task bubble = %s, %v", wire(value), err)
	}
}

func TestAntigravityNativeConversationShowsWALSummaryAndTurnEvidence(t *testing.T) {
	// Contract: native Antigravity metadata and read-only timelines expose clean prompts and explicit turn evidence.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	const session = "11111111-1111-4111-8111-111111111111"
	const parent = "22222222-2222-4222-8222-222222222222"
	root := filepath.Join(home, ".gemini", "antigravity")
	log := filepath.Join(root, "brain", session, antigravityTranscript)
	if err := os.MkdirAll(filepath.Dir(log), 0700); err != nil {
		t.Fatal(err)
	}
	steps := []string{
		`{"type":"USER_INPUT","step_index":0,"content":"<USER_REQUEST>Find the result</USER_REQUEST><ADDITIONAL_METADATA>Local time</ADDITIONAL_METADATA>","created_at":"2026-01-01T00:00:00Z"}`,
		`{"type":"PLANNER_RESPONSE","step_index":1,"content":"Searching","model":"gemini-4-neon-high","thinking":"Check sources","tool_calls":[{"id":"read","name":"Read"}],"created_at":"2026-01-01T00:00:01Z"}`,
		`{"type":"PLANNER_RESPONSE","step_index":2,"content":"First result","model":"gemini-4-neon-xhigh","created_at":"2026-01-01T00:00:02Z"}`,
		`{"type":"USER_INPUT","step_index":3,"content":"<CONTEXT_SUMMARY>Old context</CONTEXT_SUMMARY> Continue <GRILL_ME>Instructions</GRILL_ME>","created_at":"2026-01-01T00:00:04Z"}`,
		`{"type":"PLANNER_RESPONSE","step_index":4,"content":"Second result","model":"gemini-preview","created_at":"2026-01-01T00:00:07Z"}`,
	}
	if err := os.WriteFile(log, []byte(strings.Join(steps, "\n")+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(root, "conversation_summaries.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`PRAGMA journal_mode=WAL;
		CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, preview TEXT, workspace_uris TEXT,
		parent_conversation_id TEXT, agent_name TEXT, status TEXT, last_modified_time TEXT);
		PRAGMA wal_checkpoint(TRUNCATE);`); err != nil {
		t.Fatal(err)
	}
	project := filepath.ToSlash(filepath.Join(home, "Fixture Project"))
	if !strings.HasPrefix(project, "/") {
		project = "/" + project
	}
	projectURI := (&url.URL{Scheme: "file", Path: project}).String()
	if _, err := db.Exec("INSERT INTO conversation_summaries VALUES (?, '', '', ?, ?, 'Researcher', 'DONE', '')",
		session, wire([]string{"https://example.test", projectURI}), parent); err != nil {
		t.Fatal(err)
	}
	rows := listNativeAntigravity(t.Context())
	if len(rows) != 1 {
		t.Fatalf("native rows = %s", wire(rows))
	}
	row := rows[0]
	if row["title"] != "Researcher" || row["preview"] != "Find the result" || row["status"] != "completed" ||
		row["relationKind"] != "subagent" || row["parentSessionId"] != parent || row["turnDurationMs"] != int64(3000) ||
		row["agentName"] != "Researcher" || row["project"] != filepath.Join(home, "Fixture Project") ||
		uintOr(row["turnCount"], 0) != 2 || wire(row["dispatchSummary"]) != `{"model":"gemini-preview"}` {
		t.Fatalf("native conversation = %s", wire(row))
	}
	if _, err := db.Exec("UPDATE conversation_summaries SET title = 'Native title'"); err != nil {
		t.Fatal(err)
	}
	if updated := listNativeAntigravity(t.Context()); len(updated) != 1 || updated[0]["title"] != "Native title" {
		t.Fatalf("updated WAL projection = %s", wire(updated))
	}
	history, err := nativeAntigravityTimeline(t.Context(), session)
	if err != nil {
		t.Fatal(err)
	}
	var result object
	if err := decodeObject([]byte(wire(history)), &result); err != nil {
		t.Fatal(err)
	}
	history = result
	var prompts, answers []string
	for _, item := range decodedTaskList(history["entries"]) {
		if field(item, "role") == "user" {
			prompts = append(prompts, text(item, "text"))
		}
		if field(item, "phase") == "final_answer" {
			answers = append(answers, text(item, "text"))
		}
	}
	if !reflect.DeepEqual(prompts, []string{"Find the result", "Continue"}) || history["readOnly"] != true ||
		wire(history["dispatchSummary"]) != wire(row["dispatchSummary"]) ||
		wire(field(history["turnDispatchSummaries"], "0")) != `{"effort":"xhigh","model":"gemini-4-neon"}` ||
		uintOr(field(field(history["turnTimings"], "0"), "durationMs"), 0) != 2000 ||
		uintOr(field(field(history["turnTimings"], "3"), "durationMs"), 0) != 3000 ||
		uintOr(history["turnCount"], 0) != 2 || !reflect.DeepEqual(answers, []string{"First result", "Second result"}) {
		t.Fatalf("native timeline = %s", wire(history))
	}
}

func TestAntigravityNativeTimelinePreservesIdlessArgsToolCalls(t *testing.T) {
	// Recurring bug class: persistence native Antigravity tool_calls omit id and store JSON-quoted PascalCase values under args, which dropped every tool row and poisoned partial.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	const session = "33333333-3333-4333-8333-333333333333"
	log := filepath.Join(home, ".gemini", "antigravity-cli", "brain", session, antigravityTranscript)
	if err := os.MkdirAll(filepath.Dir(log), 0700); err != nil {
		t.Fatal(err)
	}
	steps := []string{
		`{"type":"USER_INPUT","step_index":0,"status":"DONE","content":"<USER_REQUEST>Build and verify</USER_REQUEST>","created_at":"2026-01-01T00:00:00Z"}`,
		`{"type":"PLANNER_RESPONSE","step_index":1,"status":"DONE","thinking":"Check files and build","tool_calls":[{"name":"read_file","args":{"Path":"\"/repo/ui/App.tsx\""}},{"name":"edit_file","args":{"Path":"\"/repo/ui/App.tsx\"","Target":"\"old\"","Replacement":"\"new\""}},{"name":"run_command","args":{"CommandLine":"\"npm test\"","Cwd":"\"/repo\""}},{"name":"finish","args":{"action":"\"rename\"","title":"\"Done\""}}],"created_at":"2026-01-01T00:00:01Z"}`,
		`{"type":"PLANNER_RESPONSE","step_index":2,"status":"DONE","content":"All checks passed.","created_at":"2026-01-01T00:00:02Z"}`,
	}
	if err := os.WriteFile(log, []byte(strings.Join(steps, "\n")+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	history, err := nativeAntigravityTimeline(t.Context(), session)
	if err != nil {
		t.Fatal(err)
	}
	var decoded object
	if err := decodeObject([]byte(wire(history)), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["partial"] == true {
		t.Fatalf("expected non-partial timeline, got %s", wire(decoded))
	}
	var readEntry, editEntry, cmdEntry, finishEntry object
	for _, raw := range decodedTaskList(decoded["entries"]) {
		entry := obj(raw)
		switch text(entry, "title") {
		case "read_file":
			readEntry = entry
		case "edit_file":
			editEntry = entry
		case "run_command":
			cmdEntry = entry
		case "finish":
			finishEntry = entry
		}
	}
	if readEntry["type"] != "file" || readEntry["operation"] != "read" || readEntry["path"] != "/repo/ui/App.tsx" || readEntry["status"] != "completed" {
		t.Fatalf("read_file entry = %s", wire(readEntry))
	}
	if editEntry["type"] != "file" || editEntry["operation"] != "edit" || editEntry["path"] != "/repo/ui/App.tsx" || len(decodedTaskList(editEntry["edits"])) != 1 {
		t.Fatalf("edit_file entry = %s", wire(editEntry))
	}
	if cmdEntry["type"] != "command" || cmdEntry["command"] != "npm test" || cmdEntry["cwd"] != "/repo" || cmdEntry["status"] != "completed" {
		t.Fatalf("run_command entry = %s", wire(cmdEntry))
	}
	if finishEntry["type"] != "tool" || finishEntry["status"] != "completed" {
		t.Fatalf("finish entry = %s", wire(finishEntry))
	}
}

func TestNativePiHistoryUsesMostRecentLeafAncestry(t *testing.T) {
	// Algorithmic core: replay only the latest Pi v3 branch while retaining tool and compaction evidence.
	const session = "11111111-1111-4111-8111-111111111111"
	records := []object{
		{"type": "session", "id": session, "version": 3, "cwd": "/fixture", "timestamp": "2026-01-01T00:00:00Z"},
		{"type": "message", "id": "user", "timestamp": "2026-01-01T00:00:01Z", "message": object{"role": "user", "content": "Question"}},
		{"type": "message", "id": "old", "parentId": "user", "timestamp": "2026-01-01T00:00:02Z",
			"message": object{"role": "assistant", "content": []any{object{"type": "text", "text": "Abandoned branch"}}}},
		{"type": "message", "id": "new", "parentId": "user", "timestamp": "2026-01-01T00:00:03Z",
			"message": object{"role": "assistant", "content": []any{
				object{"type": "text", "text": "Selected branch"},
				object{"type": "toolCall", "id": "edit", "name": "edit", "arguments": object{"path": "config.json", "oldText": "false", "newText": "true"}},
				object{"type": "text", "text": "Checking"},
			}}},
		{"type": "message", "id": "result", "parentId": "new", "timestamp": "2026-01-01T00:00:04Z",
			"message": object{"role": "toolResult", "toolCallId": "edit", "toolName": "edit", "content": []any{object{"type": "text", "text": "Updated"}}}},
		{"type": "compaction", "id": "compact", "parentId": "result", "timestamp": "2026-01-01T00:00:05Z", "tokensBefore": 10000},
		{"type": "session_info", "id": "name", "parentId": "compact", "name": "Native Pi title"},
	}
	row := deriveNativeAgentConversation("pi", "session.jsonl", records, nil, true, time.Unix(0, 0))
	if row["id"] != session || row["title"] != "Native Pi title" || row["messageCount"] != 4 {
		t.Fatalf("Pi conversation = %s", wire(row))
	}
	history := nativePiTimeline(session, records, false)
	if history["readOnly"] != true || history["status"] != nil || history["path"] != nil {
		t.Fatalf("Pi history asserted live ownership: %s", wire(history))
	}
	entries := decodedTaskList(history["entries"])
	var types []string
	for _, entry := range entries {
		types = append(types, text(entry, "type"))
	}
	if !reflect.DeepEqual(types, []string{"user", "text", "file", "text", "notice"}) ||
		text(entries[1], "text") != "Selected branch" || field(entries[2], "status") != "completed" ||
		uintOr(field(field(entries[4], "notice"), "tokensBefore"), 0) != 10000 {
		t.Fatalf("Pi branch = %s", wire(entries))
	}
	edits := decodedTaskList(field(entries[2], "edits"))
	if len(edits) != 1 || field(field(edits[0], "newText"), "text") != "true" {
		t.Fatalf("Pi edit = %s", wire(edits))
	}
}

func TestNativeClaudeMetadataUsesOnlyLatestExplicitOutcome(t *testing.T) {
	// Recurring bug class: lifecycle an old completion cannot settle a newer Claude turn.
	const session = "11111111-1111-4111-8111-111111111111"
	newUser := object{"type": "user", "timestamp": "2026-01-01T00:00:00Z", "message": object{"role": "user", "content": "Review project"}}
	completed := object{"type": "assistant", "uuid": "reply", "timestamp": "2026-01-01T00:00:01Z",
		"message": object{"role": "assistant", "stop_reason": "end_turn", "content": []any{object{"type": "text", "text": "Done"}}}}
	updated := time.Unix(0, 0)
	if row := deriveNativeAgentConversation("claude", session+".jsonl", []object{newUser, completed}, nil, true, updated); row["status"] != "completed" {
		t.Fatalf("completion missing from list row: %s", wire(row))
	}
	if row := deriveNativeAgentConversation("claude", session+".jsonl", []object{completed}, []object{newUser}, false, updated); row["status"] != nil {
		t.Fatalf("old completion settled a new prompt: %s", wire(row))
	}
	pending := clone(completed)
	obj(pending["message"])["stop_reason"] = "tool_use"
	if row := deriveNativeAgentConversation("claude", session+".jsonl", []object{newUser, pending}, nil, true, updated); row["status"] != nil {
		t.Fatalf("native tool work appeared completed: %s", wire(row))
	}
}

func TestNativeClaudeSidechainsStayOutOfTopLevelList(t *testing.T) {
	// Contract: Claude JSONL sidechain session schema.
	const session = "11111111-1111-4111-8111-111111111111"
	main := object{"type": "user", "message": object{"role": "user", "content": "Top level"}}
	side := object{"isSidechain": true, "message": object{"role": "user", "content": "Child task"}}
	at := time.Unix(0, 0)
	for _, fixture := range []struct {
		name       string
		head, tail []object
	}{
		{"agent-" + session + ".jsonl", []object{main}, nil},
		{filepath.Join("subagents", session+".jsonl"), []object{main}, nil},
		{session + ".jsonl", []object{side}, nil},
		{session + ".jsonl", nil, []object{side}},
	} {
		if row := deriveNativeAgentConversation("claude", fixture.name, fixture.head, fixture.tail, false, at); row != nil {
			t.Fatalf("sidechain appeared as %s", wire(row))
		}
	}
	row := deriveNativeAgentConversation("claude", session+".jsonl", []object{main}, []object{side}, false, at)
	if row["id"] != session || row["title"] != "Top level" {
		t.Fatalf("sidechain displaced main metadata: %s", wire(row))
	}
}

func TestNativeConversationMetadataRefreshesChangedFiles(t *testing.T) {
	// Recurring bug class: persistence native transcript metadata follows replacement and deletion.
	const session = "11111111-1111-4111-8111-111111111111"
	costs := new(runtimeCostSet)
	ctx := context.WithValue(t.Context(), runtimeCostKey{}, runtimeCostContext{set: costs, owner: "taskRead"})
	path := filepath.Join(t.TempDir(), session+".jsonl")
	write := func(title string) {
		t.Helper()
		record := object{"type": "user", "message": object{"role": "user", "content": title}}
		if err := os.WriteFile(path, []byte(wire(record)+"\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("Before")
	if row := scanNativeAgentConversation(ctx, "claude", path); row["title"] != "Before" {
		t.Fatalf("initial metadata = %s", wire(row))
	}
	cost := costs.counter("taskRead")
	parsed, hits := cost.parsed.Load(), cost.hits.Load()
	if row := scanNativeAgentConversation(ctx, "claude", path); row["title"] != "Before" ||
		parsed == 0 || cost.parsed.Load() != parsed || cost.hits.Load() != hits+1 {
		t.Fatalf("unchanged transcript was not served from parsed metadata: %s", wire(row))
	}
	write("After a longer edit")
	if row := scanNativeAgentConversation(ctx, "claude", path); row["title"] != "After a longer edit" {
		t.Fatalf("stale metadata = %s", wire(row))
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if row := scanNativeAgentConversation(ctx, "claude", path); row != nil {
		t.Fatalf("removed transcript returned %s", wire(row))
	}
}

func TestBoundedConversationSamplesKeepHeadAndTail(t *testing.T) {
	// Algorithmic core: bounded native transcript parser.
	const session = "11111111-1111-4111-8111-111111111111"
	path := filepath.Join(t.TempDir(), session+".jsonl")
	records := []object{
		{"type": "user", "message": object{"role": "user", "content": "First prompt"}},
		{"padding": strings.Repeat("x", 300<<10)},
		{"message": object{"role": "assistant", "content": "Last reply"}},
	}
	var payload strings.Builder
	for _, record := range records {
		payload.WriteString(wire(record))
		payload.WriteByte('\n')
	}
	if err := os.WriteFile(path, []byte(payload.String()), 0600); err != nil {
		t.Fatal(err)
	}
	row := scanNativeAgentConversation(context.Background(), "claude", path)
	if row["title"] != "First prompt" || row["preview"] != "Last reply" || row["metadataPartial"] != true || row["messageCount"] != nil || row["path"] != nil {
		t.Fatalf("bounded projection = %s", wire(row))
	}
}

func TestConversationPageRetainsUnconsumedNativeRows(t *testing.T) {
	// Contract: merged conversation pagination with native and local cursors.
	newer := object{"agent": "codex", "id": "newer", "updatedAt": "2026-01-03T00:00:00Z"}
	older := object{"agent": "codex", "id": "older", "updatedAt": "2026-01-01T00:00:00Z"}
	middle := object{"agent": "antigravity", "id": "middle", "updatedAt": "2026-01-02T00:00:00+00:00"}
	upstreamNext := "older-codex"
	cursor := nativeConversationCursor{Codex: &nativeCodexConversationCursor{}}
	advance := func(page []object, next any, want string) {
		t.Helper()
		if len(page) != 1 || page[0]["id"] != want || next == nil {
			t.Fatalf("page=%s next=%v, wanted %s and a cursor", wire(page), next, want)
		}
		cursor = nativeConversationCursor{}
		if err := unmarshalJSON([]byte(str(next)), &cursor); err != nil {
			t.Fatal(err)
		}
	}
	page, next := mergeNativeConversationPage([]object{middle}, []object{newer}, &upstreamNext, &cursor, 2, "updatedAt")
	advance(page, next, "newer")
	if cursor.Codex == nil || cursor.Codex.Cursor == nil || *cursor.Codex.Cursor != upstreamNext {
		t.Fatalf("lost upstream cursor: %s", next)
	}
	page, next = mergeNativeConversationPage([]object{middle}, []object{older}, nil, &cursor, 1, "updatedAt")
	advance(page, next, "middle")
	page, next = mergeNativeConversationPage(nil, []object{older}, nil, &cursor, 1, "updatedAt")
	if len(page) != 1 || page[0]["id"] != "older" || next != nil {
		t.Fatalf("final page=%s next=%v", wire(page), next)
	}
}
