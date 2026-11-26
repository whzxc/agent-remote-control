package core

import (
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

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
	if _, err := db.Exec("INSERT INTO conversation_summaries VALUES (?, '', '', '', ?, 'Researcher', 'DONE', '')", session, parent); err != nil {
		t.Fatal(err)
	}
	rows := listNativeAntigravity(t.Context())
	if len(rows) != 1 {
		t.Fatalf("native rows = %s", wire(rows))
	}
	row := rows[0]
	if row["title"] != "Researcher" || row["preview"] != "Find the result" || row["status"] != "completed" ||
		row["relationKind"] != "subagent" || row["parentSessionId"] != parent || row["turnDurationMs"] != int64(3000) {
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
	var prompts []string
	for _, item := range decodedTaskList(history["entries"]) {
		if field(item, "role") == "user" {
			prompts = append(prompts, text(item, "text"))
		}
	}
	if !reflect.DeepEqual(prompts, []string{"Find the result", "Continue"}) || history["readOnly"] != true ||
		wire(history["dispatchSummary"]) != wire(row["dispatchSummary"]) ||
		field(field(history["turnDispatchSummaries"], "0"), "effort") != "xhigh" {
		t.Fatalf("native timeline = %s", wire(history))
	}
}
