use super::*;
use std::time::SystemTime;

const SESSION: &str = "00000000-0000-4000-8000-000000000001";
fn row(records: &[Value], tail: &[Value]) -> Value {
    native::derive(
        "claude",
        Path::new(&format!("{SESSION}.jsonl")),
        records,
        tail,
        tail.is_empty(),
        SystemTime::UNIX_EPOCH,
    )
    .unwrap()
}
fn user(text: &str) -> Value {
    json!({"type":"user","message":{"role":"user","content":text}})
}
struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("arc-native-index-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn write(&self, id: &str, records: &[Value]) -> PathBuf {
        let path = self.0.join(format!("{id}.jsonl"));
        std::fs::write(
            &path,
            records.iter().map(|r| format!("{r}\n")).collect::<String>(),
        )
        .unwrap();
        path
    }
    fn scan(&self, index: &mut native::Index) -> Vec<native::Session> {
        index.scan(&[("claude".into(), self.0.clone(), None)])
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[test]
fn sidechains_never_become_top_level_rows() {
    // Contract: Claude JSONL sidechain session schema
    let ordinary = user("Top level");
    for (path, records, tail) in [
        (
            format!("agent-{SESSION}.jsonl"),
            vec![ordinary.clone()],
            vec![],
        ),
        (
            format!("subagents/{SESSION}.jsonl"),
            vec![ordinary.clone()],
            vec![],
        ),
        (
            format!("{SESSION}.jsonl"),
            vec![json!({"isSidechain":true,"message":{"role":"user","content":"Child"}})],
            vec![],
        ),
        (
            format!("{SESSION}.jsonl"),
            vec![],
            vec![json!({"isSidechain":true,"message":{"role":"assistant","content":"Child"}})],
        ),
    ] {
        assert!(native::derive(
            "claude",
            Path::new(&path),
            &records,
            &tail,
            false,
            SystemTime::UNIX_EPOCH
        )
        .is_none());
    }
    assert_eq!(row(&[ordinary.clone()], &[])["id"], SESSION);
    let mixed = row(
        &[ordinary],
        &[json!({"isSidechain":true,"message":{"role":"user","content":"Child task"}})],
    );
    assert_eq!(mixed["title"], "Top level");
    assert_eq!(mixed["id"], SESSION);
}
#[test]
fn unchanged_transcripts_reuse_metadata_and_changed_files_refresh() {
    // Recurring bug class: persistence: transcript index invalidates changed native files
    let sandbox = Sandbox::new();
    let path = sandbox.write(SESSION, &[user("Before")]);
    let mut index = native::Index::default();
    let first = sandbox.scan(&mut index);
    let second = sandbox.scan(&mut index);
    assert!(Arc::ptr_eq(&first[0].row, &second[0].row));
    sandbox.write(SESSION, &[user("After a longer edit")]);
    let changed = sandbox.scan(&mut index);
    assert_eq!(changed[0].row["title"], "After a longer edit");
    assert!(!Arc::ptr_eq(&first[0].row, &changed[0].row));
    std::fs::remove_file(path).unwrap();
    assert!(sandbox.scan(&mut index).is_empty());
}
#[test]
fn bounded_samples_keep_head_title_and_tail_preview_without_exact_counts() {
    // Algorithmic core: bounded native transcript parser
    let sandbox = Sandbox::new();
    let path = sandbox.write(
        SESSION,
        &[
            user("First prompt"),
            json!({"padding":"x".repeat(300 * 1024)}),
            json!({"message":{"role":"assistant","content":"Last reply"}}),
        ],
    );
    let mut index = native::Index::default();
    let sessions = sandbox.scan(&mut index);
    assert_eq!(sessions[0].row["title"], "First prompt");
    assert_eq!(sessions[0].row["preview"], "Last reply");
    assert_eq!(sessions[0].row["metadataPartial"], true);
    assert!(sessions[0].row["messageCount"].is_null());
    assert!(!sessions[0].row.to_string().contains(path.to_str().unwrap()));
}
#[test]
fn pi_v3_metadata_and_branch_history_stay_read_only() {
    // Algorithmic core: Pi branch ancestry parser
    let records = vec![
        json!({"type":"session","version":3,"id":SESSION,"cwd":"/workspace","timestamp":"2026-01-01T00:00:00Z"}),
        json!({"type":"message","id":"user","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"Question"}}),
        json!({"type":"message","id":"old","parentId":"user","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"Abandoned branch"}]}}),
        json!({"type":"message","id":"new","parentId":"user","timestamp":"2026-01-01T00:00:03Z","message":{"role":"assistant","content":[{"type":"text","text":"Selected branch"}]}}),
        json!({"type":"session_info","id":"name","parentId":"new","name":"Native Pi title"}),
    ];
    let row = native::derive(
        "pi",
        Path::new("session.jsonl"),
        &records,
        &[],
        true,
        SystemTime::UNIX_EPOCH,
    )
    .unwrap();
    assert_eq!(row["id"], SESSION);
    assert_eq!(row["title"], "Native Pi title");
    assert_eq!(row["messageCount"], 3);
    let timeline = native::pi_timeline(SESSION, &records, false);
    assert_eq!(timeline["readOnly"], true);
    let text = timeline["entries"].to_string();
    assert!(text.contains("Selected branch"));
    assert!(!text.contains("Abandoned branch"));
    assert!(timeline["status"].is_null());
    assert!(timeline.get("path").is_none());
}
#[test]
fn pi_history_retains_tool_positions_and_compaction_facts() {
    // Algorithmic core: Pi tool and compaction parser
    let records = vec![
        json!({"type":"message","id":"user","parentId":null,"timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"Edit config"}}),
        json!({"type":"message","id":"assistant","parentId":"user","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"Starting"},{"type":"toolCall","id":"edit","name":"edit","arguments":{"path":"config.json","oldText":"false","newText":"true"}},{"type":"text","text":"Checking"}]}}),
        json!({"type":"message","id":"result","parentId":"assistant","timestamp":"2026-01-01T00:00:02Z","message":{"role":"toolResult","toolCallId":"edit","toolName":"edit","content":[{"type":"text","text":"Updated"}]}}),
        json!({"type":"compaction","id":"compact","parentId":"result","timestamp":"2026-01-01T00:00:03Z","tokensBefore":10000}),
    ];
    let timeline = native::pi_timeline(SESSION, &records, false);
    let entries = timeline["entries"].as_array().unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|r| string(r, "type"))
            .collect::<Vec<_>>(),
        ["user", "text", "file", "text", "notice"]
    );
    assert_eq!(entries[2]["edits"][0]["newText"]["text"], "true");
    assert_eq!(entries[2]["status"], "completed");
    assert_eq!(entries[4]["notice"]["tokensBefore"], 10000);
    assert!(timeline["status"].is_null());
}

#[test]
fn claude_list_metadata_confirms_only_the_latest_explicit_outcome() {
    // Recurring bug class: native Claude list rows fetched full detail histories even when their latest record already confirmed completion.
    let completed = json!({"type":"assistant","uuid":"reply","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"Done"}]}});
    assert_eq!(
        row(&[user("Review project"), completed.clone()], &[])["status"],
        "completed"
    );
    assert!(row(&[completed], &[user("Continue")])["status"].is_null());
    let pending = json!({"type":"assistant","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","stop_reason":"tool_use","content":[]}});
    assert!(row(&[user("Inspect")], &[pending])["status"].is_null());
}

#[test]
fn antigravity_projects_wal_summaries_and_transcript_turns() {
    // Contract: Antigravity conversation row and timeline metadata
    use native::antigravity::{timeline, Summaries};
    let sandbox = Sandbox::new();
    let db_path = sandbox.0.join("conversation_summaries.db");
    let db = rusqlite::Connection::open(&db_path).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, preview TEXT, workspace_uris TEXT,
            parent_conversation_id TEXT, agent_name TEXT, status TEXT, last_modified_time TEXT);
        PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    let parent = "00000000-0000-4000-8000-000000000002";
    let workspace_path = sandbox.0.join("Fixture Project");
    let workspace_uri = url::Url::from_file_path(&workspace_path).unwrap();
    db.execute(
        "INSERT INTO conversation_summaries VALUES (?1, '', '', ?2, ?3, 'Researcher', 'DONE', '')",
        rusqlite::params![
            SESSION,
            json!(["https://example.test", workspace_uri.as_str()]).to_string(),
            parent
        ],
    )
    .unwrap();

    let transcript = [
        json!({"type":"USER_INPUT","content":"<USER_REQUEST>Find the result</USER_REQUEST>","step_index":0,"created_at":"2026-01-01T00:00:00Z"}),
        json!({"type":"PLANNER_RESPONSE","model":"gemini-4-neon-high","content":"Searching","thinking":"Check sources","tool_calls":[{"id":"read","name":"Read","arguments":{"path":"fixture.txt"}}],"step_index":1,"created_at":"2026-01-01T00:00:01Z"}),
        json!({"type":"PLANNER_RESPONSE","model":"gemini-4-neon-xhigh","content":"The first result","step_index":2,"created_at":"2026-01-01T00:00:02Z"}),
        json!({"type":"USER_INPUT","content":"","step_index":3,"created_at":"2026-01-01T00:00:04Z"}),
        json!({"type":"PLANNER_RESPONSE","model":"gemini-preview","content":"The second result","step_index":4,"created_at":"2026-01-01T00:00:07Z"}),
    ];
    let brain = sandbox.0.join("brain");
    let logs = brain.join(SESSION).join(".system_generated/logs");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(
        logs.join("transcript.jsonl"),
        transcript
            .iter()
            .map(|row| format!("{row}\n"))
            .collect::<String>(),
    )
    .unwrap();
    let sessions = native::Index::default().scan(&[("antigravity".into(), brain, None)]);
    let mut row = (*sessions[0].row).clone();
    assert_eq!(row["title"], "Find the result");
    assert_eq!(row["dispatchSummary"], json!({"model":"gemini-preview"}));
    assert_eq!(row["turnCount"], 2);
    assert_eq!(row["turnDurationMs"], 3000);
    let mut summaries = Summaries::default();
    summaries.refresh(&db_path);
    summaries.enrich(&mut row);
    assert_eq!(row["title"], "Researcher");
    assert_eq!(row["agentName"], "Researcher");
    assert_eq!(row["status"], "completed");
    assert_eq!(row["project"], json!(workspace_path));
    assert_eq!(row["parentSessionId"], parent);
    assert_eq!(row["relationKind"], "subagent");
    db.execute(
        "UPDATE conversation_summaries SET title = 'Native title'",
        [],
    )
    .unwrap();
    summaries.refresh(&db_path);
    summaries.enrich(&mut row);
    assert_eq!(row["title"], "Native title");

    let history = timeline(SESSION, &transcript, false);
    assert_eq!(history["dispatchSummary"], row["dispatchSummary"]);
    assert_eq!(
        history["turnDispatchSummaries"]["0"],
        json!({"model":"gemini-4-neon","effort":"xhigh"})
    );
    assert_eq!(history["turnTimings"]["0"]["durationMs"], 2000);
    assert_eq!(history["turnTimings"]["3"]["durationMs"], 3000);
    let outcomes: Vec<_> = history["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["phase"] == "final_answer")
        .map(|row| string(row, "text"))
        .collect();
    assert_eq!(outcomes, ["The first result", "The second result"]);
}

#[test]
fn combined_page_keeps_unconsumed_codex_rows_across_cursors() {
    // Contract: merged conversation pagination with native and local cursors
    let row = |agent, id, updated| json!({"agent":agent,"id":id,"updatedAt":updated});
    let newer = row("codex", "newer", "2026-01-03T00:00:00Z");
    let older = row("codex", "older", "2026-01-01T00:00:00Z");
    let middle = row("antigravity", "middle", "2026-01-02T00:00:00+00:00");
    let mut cursor = ConversationCursor {
        codex: Some(CodexCursor::default()),
        local: None,
    };
    let (first, next) = conversation_page(
        vec![middle.clone()],
        Some((vec![newer.clone()], Some("older-codex".into()))),
        &mut cursor,
        2,
        "updatedAt",
    );
    assert_eq!(first, vec![newer]);
    let mut cursor: ConversationCursor = serde_json::from_str(&next.unwrap()).unwrap();
    assert_eq!(
        cursor.codex.as_ref().unwrap().cursor.as_deref(),
        Some("older-codex")
    );
    let (second, next) = conversation_page(
        vec![middle.clone()],
        Some((vec![older.clone()], None)),
        &mut cursor,
        1,
        "updatedAt",
    );
    assert_eq!(second, vec![middle]);
    let mut cursor = serde_json::from_str(&next.unwrap()).unwrap();
    let (third, next) = conversation_page(
        vec![],
        Some((vec![older.clone()], None)),
        &mut cursor,
        1,
        "updatedAt",
    );
    assert_eq!(third, vec![older]);
    assert!(next.is_none());
}
