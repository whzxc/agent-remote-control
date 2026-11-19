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
