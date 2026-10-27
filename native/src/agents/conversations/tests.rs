use super::*;
use std::time::SystemTime;

const SESSION: &str = "00000000-0000-4000-8000-000000000001";
const OTHER: &str = "00000000-0000-4000-8000-000000000002";
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
fn native_title_ignores_envelopes_and_tool_results() {
    // Regression: native titles used injected reminders, slash commands and attachment placeholders instead of the user request.
    let prompt = "Explain the parser";
    let records = vec![
        user("<system-reminder>context</system-reminder><local-command-caveat>ignore</local-command-caveat><command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>"),
        json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"not a prompt"}]}}),
        user("[Image #1] [Attached file: example.txt]"),
        user(&format!("<system-reminder>secret context</system-reminder> {prompt} <file name=\"x\">attachment body</file>")),
    ];
    assert_eq!(row(&records, &[])["title"], prompt);
    let mixed = json!({"message":{"role":"user","content":[{"type":"image","source":{}},{"type":"text","text":prompt},{"type":"tool_result","content":"ignored"}]}});
    assert_eq!(row(&[mixed], &[])["title"], prompt);
    assert_eq!(
        row(&[user("<command-name>/clear</command-name>")], &[])["title"],
        Value::Null
    );
}

#[test]
fn native_titles_prefer_explicit_names_and_preserve_unicode_bounds() {
    // Regression: summaries displaced the first real prompt and activity titles ignored native custom names.
    let custom = "Saved name";
    let summary = "Earlier summary";
    let head = vec![
        user("First prompt"),
        json!({"type":"summary","summary":summary}),
    ];
    let tail = vec![
        json!({"type":"custom-title","customTitle":custom}),
        json!({"message":{"role":"assistant","content":[{"type":"text","text":"Latest reply"}]}}),
    ];
    let derived = row(&head, &tail);
    assert_eq!(derived["title"], custom);
    assert_eq!(derived["preview"], "Latest reply");
    assert_eq!(row(&head, &[])["title"], "First prompt");
    assert_eq!(
        row(&[json!({"type":"summary","summary":summary})], &[])["title"],
        summary
    );
    let input = "λ".repeat(100);
    assert_eq!(
        row(&[user(&input)], &[])["title"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        80
    );
    assert!(input.starts_with(row(&[user(&input)], &[])["title"].as_str().unwrap()));
}

#[test]
fn sidechains_never_become_top_level_rows() {
    // Regression: agent files and isSidechain records appeared as top-level Claude sessions.
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
    // Regression: repeated conversation listings reparsed unchanged native transcripts and retained deleted sessions.
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
    // Regression: large transcripts required a full parse to display metadata and message counts implied complete coverage.
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
fn merge_keeps_task_identity_native_metadata_and_deterministic_order() {
    // Property: merging a task with its native session yields one row with task identity and native metadata, independent of input order.
    let native = row(&[user("Native title")], &[]);
    let task = json!({"id":OTHER,"agent":"claude","nativeSessionId":SESSION,"source":"arc-task","title":"Task title","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","status":"completed"});
    let sessions = vec![native.clone()];
    let merged = merge(vec![task.clone()], &sessions);
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0]["id"], task["id"]);
    assert_eq!(merged[0]["title"], task["title"]);
    assert_eq!(merged[0]["source"], task["source"]);
    assert_eq!(merged[0]["updatedAt"], native["updatedAt"]);
    assert_eq!(merged[0]["messageCount"], native["messageCount"]);
    assert!(merged[0].get("path").is_none());
    let independent = json!({"id":SESSION,"agent":"pi","nativeSessionId":SESSION,"source":"arc-task","createdAt":"2026-01-02T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z"});
    assert_eq!(
        merge(vec![task.clone(), independent.clone()], &sessions),
        merge(vec![independent, task], &sessions)
    );
}

#[test]
fn pi_v3_metadata_and_branch_history_stay_read_only() {
    // Regression: Pi native sessions were absent from conversation pages and external branch history could mix sibling messages.
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
    // Regression: Pi history discarded compaction and reordered tool calls after all text blocks in a message.
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
fn native_conversation_titles_and_pi_requests_exclude_harness_inputs() {
    // Property: native titles and Pi requests exclude harness inputs while preserving human text and branch ancestry.
    let records = [
        json!({"type":"user","origin":{"kind":"task-notification"},"message":{"role":"user","content":"Background task finished"}}),
        json!({"type":"user","isCompactSummary":true,"message":{"role":"user","content":"Continuation summary"}}),
        user("Actual request"),
    ];
    assert_eq!(row(&records, &[])["title"], "Actual request");
    assert_eq!(row(&records[..2], &[])["title"], Value::Null);
    let literal = "<bash-input>Explain the wrapper</bash-input>";
    assert_eq!(
        row(
            &[
                json!({"type":"user","origin":{"kind":"human"},"message":{"role":"user","content":literal}})
            ],
            &[]
        )["title"],
        literal
    );
    let timeline = native::pi_timeline(
        SESSION,
        &[
            json!({"type":"message","id":"human","parentId":null,"timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"Actual request"}}),
            json!({"type":"message","id":"injected","parentId":"human","timestamp":"2026-01-01T00:00:01Z","isMeta":true,"message":{"role":"user","content":"Hook output"}}),
            json!({"type":"message","id":"answer","parentId":"injected","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"Actual answer"}]}}),
        ],
        false,
    );
    let requests: Vec<_> = timeline["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["type"] == "user")
        .collect();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["text"], "Actual request");
}
