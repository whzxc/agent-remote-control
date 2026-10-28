use super::*;

const AT: &str = "2026-01-01T00:00:00Z";
const LATER: &str = "2026-01-01T00:00:01Z";
fn acp(t: &mut Timeline, update: Value) {
    t.agent("session/update", &json!({"params":{"update":update}}), AT);
}
fn types(t: &Timeline) -> Vec<&str> {
    t.entries.iter().map(|row| string(row, "type")).collect()
}

#[test]
fn session_identity_survives_missing_or_stale_metadata() {
    // Regression: active timelines exposed id:null before metadata loaded and lost the owning task in reply arguments.
    let id = "00000000-0000-4000-8000-000000000001";
    let mut timeline = Timeline::default();
    timeline.codex("turn/started", &json!({"turn":{"id":"turn"}}), AT);
    for info in [
        Value::Null,
        json!({}),
        json!({"id":"stale","taskId":"stale","agent":"example"}),
    ] {
        let row = timeline.session(id, &info, "codex-thread", None);
        assert_eq!(row["id"], id);
        assert_eq!(row["turnId"], "turn");
        if let Some(open) = row.get("open") {
            assert_eq!(open["taskId"], id);
        }
        let pending = json!({"kind":"question","respond":{"op":"agent_respond","args":{"interactionId":"question"}}});
        let row = timeline.session(id, &info, "arc-task", Some(pending));
        assert_eq!(row["id"], id);
        assert_eq!(row["interaction"]["respond"]["args"]["taskId"], id);
        assert_eq!(
            row["interaction"]["respond"]["args"]["interactionId"],
            "question"
        );
    }
    timeline.info = json!({"id":"stale"});
    assert_eq!(timeline.transcript_session(id, "claude")["id"], id);
}

#[test]
fn claude_thinking_only_tail_preserves_activity_without_role_or_uuid() {
    // Regression: b9ed45b3 dropped thinking-only Claude records without message.role or uuid, leaving activity headlines empty.
    let now = std::time::SystemTime::from(
        chrono::DateTime::parse_from_rfc3339(AT)
            .unwrap()
            .with_timezone(&chrono::Utc),
    );
    for with_role in [false, true] {
        for with_uuid in [false, true] {
            let mut record = json!({"type":"assistant","sessionId":"fixture","cwd":"/workspace","timestamp":AT,
                "message":{"stop_reason":null,"content":[{"type":"thinking","thinking":"Review example"}]}});
            if with_role {
                record["message"]["role"] = json!("assistant");
            }
            if with_uuid {
                record["uuid"] = json!("thinking-record");
            }
            let mut timeline = Timeline::default();
            timeline.backfill_claude(std::slice::from_ref(&record));
            let row = timeline.transcript_session("fixture", "claude");
            assert_eq!(row["source"], "transcript");
            assert_eq!(row["phase"], "thinking");
            assert_eq!(row["headline"], "Review example");
            assert_eq!(row["timeline"], true);
            assert_eq!(row["recentSteps"], json!(["thinking"]));
            assert!(row["turnStartedAt"].is_null());
            assert_eq!(row["turnCount"], 0);
            assert!(timeline.transcript_active(now, now + std::time::Duration::from_secs(90)));
            assert!(timeline.transcript_active(now, now + std::time::Duration::from_secs(3600)));
            assert_eq!(types(&timeline), ["thinking"]);
            let entry_id = timeline.entries[0]["id"].clone();
            let mut reread = Timeline::default();
            reread.backfill_claude(&[record]);
            assert_eq!(reread.entries[0]["id"], entry_id);
        }
    }
}

#[test]
fn live_acp_and_claude_backfill_have_equivalent_entry_order() {
    // Property: equivalent native conversations preserve entry types and order across live and history paths.
    let mut live = Timeline::default();
    live.agent("arc/user", &json!({"turnId":"u","text":"Read config"}), AT);
    for text in ["Check ", "settings"] {
        acp(
            &mut live,
            json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":text}}),
        );
    }
    acp(
        &mut live,
        json!({"sessionUpdate":"tool_call","toolCallId":"read","title":"Read","rawInput":{"file_path":"config.json"}}),
    );
    acp(
        &mut live,
        json!({"sessionUpdate":"tool_call_update","toolCallId":"read","status":"completed","rawOutput":"enabled"}),
    );
    for text in ["All ", "done"] {
        acp(
            &mut live,
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}),
        );
    }
    live.finish("completed", AT);
    let records = vec![
        json!({"uuid":"u","timestamp":AT,"message":{"role":"user","content":"Read config"}}),
        json!({"uuid":"a","timestamp":AT,"message":{"role":"assistant","content":[{"type":"thinking","thinking":"Check settings"},{"type":"tool_use","id":"read","name":"Read","input":{"file_path":"config.json"}}],"stop_reason":"tool_use"}}),
        json!({"uuid":"r","timestamp":AT,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"read","content":"enabled"}]}}),
        json!({"uuid":"f","timestamp":AT,"message":{"role":"assistant","content":[{"type":"text","text":"All done"}],"stop_reason":"end_turn"}}),
    ];
    let mut history = Timeline::default();
    history.backfill_claude(&records);
    assert_eq!(types(&live), types(&history));
    for field in ["phase", "headline", "recentSteps", "turnStartedAt"] {
        assert_eq!(
            live.session("fixture", &json!({"id":"fixture"}), "arc-task", None)[field],
            history.transcript_session("fixture", "claude")[field]
        );
    }
    assert_eq!(live.entries[2]["path"], history.entries[2]["path"]);
}

#[test]
fn claude_sidechains_and_compaction_do_not_replace_the_main_turn() {
    // Regression: Claude sidechain prompts and compact boundaries polluted the main conversation projection.
    let mut timeline = Timeline::default();
    timeline.backfill_claude(&[
        json!({"uuid":"u","timestamp":AT,"message":{"role":"user","content":"Main task"}}),
        json!({"uuid":"a","timestamp":AT,"message":{"role":"assistant","content":[{"type":"tool_use","id":"task","name":"Task","input":{"description":"Inspect files","prompt":"Read sources"}}]}}),
        json!({"uuid":"child","timestamp":AT,"isSidechain":true,"message":{"role":"user","content":"Child task"}}),
        json!({"uuid":"child2","timestamp":AT,"isSidechain":true,"message":{"role":"assistant","content":"Child reply","stop_reason":"end_turn"}}),
        json!({"uuid":"compact","timestamp":AT,"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":180000}}),
    ]);
    assert_eq!(types(&timeline), ["user", "tool", "notice"]);
    assert_eq!(timeline.turn, "u");
    assert_eq!(timeline.omitted_sidechain_records, 2);
    assert_eq!(
        timeline.response("fixture", 0)["coverage"]["omittedSidechainRecords"],
        2
    );
    assert_eq!(timeline.entries[2]["notice"]["tokensBefore"], 180000);
    assert_eq!(
        timeline.transcript_session("fixture", "claude")["phase"],
        "tool"
    );
    assert_ne!(timeline.status, "completed");
}

#[test]
fn tool_inputs_share_native_command_paths_and_edit_excerpts() {
    // Property: ACP, Claude and Pi tool inputs expose identical normalized fields while retaining native input excerpts.
    for (name, input, kind) in [
        ("Bash", json!({"command":"printf ready"}), "command"),
        ("Read", json!({"file_path":"src/a.rs"}), "file"),
        (
            "Write",
            json!({"file_path":"src/a.rs","content":"new"}),
            "file",
        ),
        (
            "Edit",
            json!({"file_path":"src/a.rs","old_string":"old","new_string":"new"}),
            "file",
        ),
        (
            "MultiEdit",
            json!({"file_path":"src/a.rs","edits":[{"old_string":"a","new_string":"b"},{"old_string":"c","new_string":"d"}]}),
            "file",
        ),
        ("Grep", json!({"path":"src","pattern":"name"}), "file"),
        ("Glob", json!({"path":"src","pattern":"*.rs"}), "file"),
        (
            "Task",
            json!({"description":"Inspect","prompt":"Read sources"}),
            "tool",
        ),
    ] {
        let mut acp_live = Timeline::default();
        acp(
            &mut acp_live,
            json!({"sessionUpdate":"tool_call","toolCallId":"call","title":name,"rawInput":input}),
        );
        let mut claude = Timeline::default();
        claude.backfill_claude(&[json!({"uuid":"a","timestamp":AT,"message":{"role":"assistant","content":[{"type":"tool_use","id":"call","name":name,"input":input}]}})]);
        let mut pi = Timeline::default();
        pi.agent(
            "tool_execution_start",
            &json!({"toolCallId":"call","toolName":name,"args":input}),
            AT,
        );
        assert_eq!(acp_live.entries[0]["type"], kind);
        for field in ["command", "path", "paths", "edits", "input", "operation"] {
            assert_eq!(acp_live.entries[0][field], claude.entries[0][field]);
            assert_eq!(acp_live.entries[0][field], pi.entries[0][field]);
        }
    }
    let mut t = Timeline::default();
    t.agent("tool_execution_start", &json!({"toolCallId":"pi-edit","toolName":"edit","args":{"path":"src/a.rs","oldText":"old","newText":"new"}}), AT);
    assert_eq!(t.entries[0]["edits"][0]["oldText"]["text"], "old");
    acp(
        &mut t,
        json!({"sessionUpdate":"tool_call","toolCallId":"acp-paths","kind":"edit","locations":[{"path":"a"},{"path":"b"}],"rawInput":{"cmd":"printf ready"}}),
    );
    assert_eq!(t.entries[1]["paths"], json!(["a", "b"]));
    assert_eq!(t.entries[1]["command"], "printf ready");
}

#[test]
fn codex_rollout_and_items_use_the_same_normalization() {
    // Property: Codex rollout calls and app-server items expose the same tool fields and lifecycle facts.
    let mut rollout = Timeline::default();
    rollout.backfill_codex_records(&[
        json!({"timestamp":AT,"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}),
        json!({"timestamp":AT,"type":"response_item","payload":{"type":"function_call","call_id":"call","name":"exec_command","arguments":"{\"cmd\":\"printf ready\",\"workdir\":\"src\"}"}}),
    ]);
    let mut history = Timeline::default();
    history.backfill_codex(&json!({"turns":[{"id":"turn","status":"inProgress","items":[{"id":"call","type":"dynamicToolCall","tool":"exec_command","arguments":{"cmd":"printf ready","workdir":"src"}}]}]}), 0, 0, AT);
    for field in ["type", "command", "cwd", "input"] {
        assert_eq!(rollout.entries[0][field], history.entries[0][field]);
    }
    history.codex_item(&json!({"id":"patch","type":"fileChange","changes":[{"path":"a","kind":{"type":"update"},"diff":"@@ -1 +1 @@\n-old\n+new"},{"path":"b","kind":{"type":"add"}}]}), "completed", AT);
    assert_eq!(history.entries[1]["paths"], json!(["a", "b"]));
    assert_eq!(history.entries[1]["changes"][0]["added"], 1);
    assert_eq!(history.entries[1]["changes"][0]["removed"], 1);
    let phase =
        history.session("fixture", &json!({"id":"fixture"}), "arc-task", None)["phase"].clone();
    for (method, params) in [
        (
            "error",
            json!({"willRetry":true,"error":{"message":"stream interrupted"}}),
        ),
        (
            "item/started",
            json!({"item":{"id":"compact","type":"contextCompaction"}}),
        ),
        (
            "item/completed",
            json!({"item":{"id":"compact","type":"contextCompaction"}}),
        ),
        (
            "warning",
            json!({"message":"Optional integration unavailable"}),
        ),
    ] {
        history.codex(method, &params, AT);
    }
    assert_eq!(history.status, "inProgress");
    assert_eq!(
        history.session("fixture", &json!({"id":"fixture"}), "arc-task", None)["phase"],
        phase
    );
    assert_eq!(
        history
            .entries
            .iter()
            .filter(|r| r["type"] == "notice")
            .count(),
        3
    );
}

#[test]
fn pi_retry_attempts_do_not_end_the_turn() {
    // Regression: a retryable Pi message_end error permanently failed the Timeline before a successful retry settled.
    let mut t = Timeline::default();
    t.agent(
        "arc/user",
        &json!({"turnId":"turn","text":"Run checks"}),
        AT,
    );
    t.agent(
        "message_end",
        &json!({"message":{"role":"assistant","stopReason":"error","errorMessage":"temporary"}}),
        AT,
    );
    for (method, value) in [
        (
            "auto_retry_start",
            json!({"attempt":1,"maxAttempts":3,"errorMessage":"temporary"}),
        ),
        ("auto_retry_end", json!({"attempt":1,"success":true})),
        ("auto_compaction_start", json!({"reason":"threshold"})),
        (
            "auto_compaction_end",
            json!({"result":{"tokensBefore":1000},"aborted":false}),
        ),
    ] {
        t.agent(method, &value, AT);
        assert_eq!(t.turn_status("turn"), Some("running"));
    }
    t.agent("message_end", &json!({"message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"Recovered"}]}}), AT);
    t.agent("agent_settled", &json!({}), AT);
    assert_eq!(t.turn_status("turn"), Some("completed"));
    assert!(!types(&t).contains(&"error"));
    assert_eq!(t.entries[1]["notice"]["maxAttempts"], 3);
}

#[test]
fn acp_notices_patch_compaction_without_changing_turn_state() {
    // Property: notice severity and compaction outcomes never change turn state or the current activity.
    let mut t = Timeline::default();
    t.agent(
        "arc/user",
        &json!({"turnId":"turn","text":"Run checks"}),
        AT,
    );
    acp(
        &mut t,
        json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Inspecting"}}),
    );
    acp(
        &mut t,
        json!({"sessionUpdate":"notice","severity":"error","title":"Unavailable","description":"Continuing"}),
    );
    acp(
        &mut t,
        json!({"sessionUpdate":"compaction_update","compactionId":"c","status":"in_progress"}),
    );
    acp(
        &mut t,
        json!({"sessionUpdate":"compaction_summary_chunk","compactionId":"c","content":{"type":"text","text":"Keep facts"}}),
    );
    acp(
        &mut t,
        json!({"sessionUpdate":"compaction_update","compactionId":"c","status":"failed","error":"Temporary failure"}),
    );
    assert_eq!(t.turn_status("turn"), Some("running"));
    assert_eq!(t.entries.len(), 4);
    assert_eq!(t.entries[3]["summary"]["text"], "Keep facts");
    assert_eq!(t.entries[3]["notice"]["nativeStatus"], "failed");
    assert_eq!(
        t.session("fixture", &json!({"id":"fixture"}), "arc-task", None)["phase"],
        "thinking"
    );
    acp(
        &mut t,
        json!({"sessionUpdate":"compaction_update","compactionId":"c","status":"completed","summary":null,"error":null}),
    );
    assert!(t.entries[3]["summary"].is_null());
    assert!(t.entries[3]["error"].is_null());
}

#[test]
fn transcript_activity_preserves_expiry_and_filters_injected_content() {
    // Property: bounded transcript projections retain native expiry evidence and exclude injected user content from turn starts.
    let now = std::time::SystemTime::from(
        chrono::DateTime::parse_from_rfc3339(AT)
            .unwrap()
            .with_timezone(&chrono::Utc),
    );
    for agent in ["claude", "codex"] {
        let mut t = Timeline::default();
        let text = "First sentence. Actual update.\n<image_resize_notice>Injected</image_resize_notice>\n</image_resize_notice>";
        let records = if agent == "claude" {
            vec![
                json!({"uuid":"user","timestamp":AT,"message":{"role":"user","content":"Read example"}}),
                json!({"uuid":"meta","timestamp":AT,"message":{"role":"user","content":"<environment_context>Injected</environment_context>"}}),
                json!({"uuid":"answer","timestamp":AT,"message":{"role":"assistant","content":[{"type":"text","text":text},{"type":"thinking","thinking":""}]}}),
            ]
        } else {
            vec![
                json!({"timestamp":AT,"type":"event_msg","payload":{"type":"task_started","turn_id":"user"}}),
                json!({"timestamp":AT,"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"Read example"}]}}),
                json!({"timestamp":AT,"type":"response_item","payload":{"type":"message","role":"developer","content":[{"text":"Injected"}]}}),
                json!({"timestamp":AT,"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":text}]}}),
                json!({"timestamp":AT,"type":"response_item","payload":{"type":"reasoning","summary":[]}}),
            ]
        };
        t.backfill_transcript(agent, &records);
        let row = t.transcript_session("fixture", agent);
        assert_eq!(row["phase"], "thinking");
        assert_eq!(row["headline"], "");
        assert_eq!(row["fallbackHeadline"], "Actual update.");
        assert_eq!(row["turnId"], "user");
        assert!(t.transcript_active(now, now + std::time::Duration::from_secs(90)));
        assert!(t.transcript_active(now, now + std::time::Duration::from_secs(3600)));
    }
}

#[test]
fn claude_harness_notifications_and_compaction_never_start_requests_or_summaries() {
    // Regression: background task-notification fields and local-command Compacted output appeared as user requests and task summaries.
    let injected = [
        json!({"isMeta":true,"message":{"role":"user","content":"Private hook context"}}),
        json!({"isCompactSummary":true,"message":{"role":"user","content":"A plain continuation summary"}}),
        json!({"origin":{"kind":"task-notification"},"promptSource":"system","turnOrigin":"task_notification","message":{"role":"user","content":"Background task finished without wrapper tags"}}),
        json!({"message":{"role":"user","content":"<task-notification><task-id>job</task-id><tool-use-id>tool</tool-use-id><output-file>/tmp/job.output</output-file></task-notification>Read the output file."}}),
        json!({"message":{"role":"user","content":"<local-command-stdout>Compacted </local-command-stdout>"}}),
        json!({"message":{"role":"user","content":"<system-reminder>Context</system-reminder><command-name>/compact</command-name><command-message>compact</command-message><command-args/>"}}),
        json!({"message":{"role":"user","content":"<bash-input>pwd</bash-input><bash-stdout>/tmp</bash-stdout>"}}),
    ];
    for (index, mut injected) in injected.into_iter().enumerate() {
        injected["uuid"] = json!(format!("injected-{index}"));
        injected["timestamp"] = json!(LATER);
        let mut timeline = Timeline::default();
        timeline.backfill_claude(&[
            json!({"uuid":"human","timestamp":AT,"message":{"role":"user","content":"Review the parser"}}),
            injected,
        ]);
        let response = timeline.response("session", 0);
        let requests: Vec<_> = response["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["type"] == "user")
            .collect();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["text"], "Review the parser");
        assert_eq!(timeline.transcript_turn_start(), Some(("human", AT)));
        let session = timeline.transcript_session("session", "claude");
        assert_eq!(session["title"], "Review the parser");
        assert_eq!(session["fallbackHeadline"], "Review the parser");
    }
}

#[test]
fn transcript_metadata_preserves_human_markup_and_user_role_tool_results() {
    // Property: explicit human provenance and user-role tool results survive transcript projection.
    let literal = "<bash-input>Explain this protocol</bash-input>";
    let mut timeline = Timeline::default();
    timeline.backfill_claude(&[
        json!({"uuid":"human","timestamp":AT,"origin":{"kind":"human"},"promptSource":"sdk","turnOrigin":"human","message":{"role":"user","content":literal}}),
        json!({"uuid":"tool","timestamp":AT,"message":{"role":"assistant","content":[{"type":"tool_use","id":"read","name":"Read","input":{"file_path":"example.txt"}}]}}),
        json!({"uuid":"result","timestamp":LATER,"origin":{"kind":"tool"},"message":{"role":"user","content":[{"type":"text","text":"Injected tool context"},{"type":"tool_result","tool_use_id":"read","content":"Retained result"}]}}),
    ]);
    let response = timeline.response("session", 0);
    let entries = response["entries"].as_array().unwrap();
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry["type"] == "user")
            .count(),
        1
    );
    assert_eq!(entries[0]["text"], literal);
    assert_eq!(
        entries.iter().find(|entry| entry["id"] == "read").unwrap()["output"]["text"],
        "Retained result"
    );
}

#[test]
fn codex_transcripts_exclude_harness_user_messages() {
    // Property: Codex transcript requests exclude harness metadata and notifications regardless of their user role.
    let mut timeline = Timeline::default();
    timeline.backfill_codex_records(&[
        json!({"type":"event_msg","timestamp":AT,"payload":{"type":"task_started","turn_id":"human"}}),
        json!({"type":"response_item","timestamp":AT,"payload":{"id":"human","type":"message","role":"user","content":[{"text":"Review changes"}]}}),
        json!({"type":"response_item","timestamp":LATER,"payload":{"id":"injected","type":"message","role":"user","source":"system","content":[{"text":"Internal context"}]}}),
        json!({"type":"response_item","timestamp":LATER,"payload":{"id":"notification","type":"message","role":"user","content":[{"text":"<subagent_notification>Agent finished</subagent_notification>"}]}}),
    ]);
    let response = timeline.response("session", 0);
    let requests: Vec<_> = response["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["type"] == "user")
        .collect();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["text"], "Review changes");
    assert_eq!(timeline.prompt_headline(), "Review changes");
}

#[test]
fn claude_fork_reminders_never_become_requests_or_summaries() {
    // Regression: forked Claude sessions exposed a system-reminder-only harness notice as their first user request.
    let reminder = "<system-reminder>\n## The user forked this session from another session.\n</system-reminder>";
    for provenance in [
        json!({}),
        json!({"origin":{"kind":"human"},"turnOrigin":"human"}),
    ] {
        for prefix in [
            reminder.to_owned(),
            "<system-reminder>\n## The user forked this session from another session.".into(),
        ] {
            let mut fork = provenance.clone();
            fork["uuid"] = json!("fork");
            fork["timestamp"] = json!(AT);
            fork["message"] = json!({"role":"user","content":prefix});
            let mut request = provenance.clone();
            request["uuid"] = json!("human");
            request["timestamp"] = json!(LATER);
            request["message"] = json!({"role":"user","content":format!("{reminder}\n{reminder}\nReview the parser")});
            let mut timeline = Timeline::default();
            timeline.backfill_claude(&[fork, request]);
            let response = timeline.response("session", 0);
            let requests: Vec<_> = response["entries"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry["type"] == "user")
                .collect();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0]["text"], "Review the parser");
            assert_eq!(timeline.transcript_turn_start(), Some(("human", LATER)));
            let session = timeline.transcript_session("session", "claude");
            assert_eq!(session["title"], "Review the parser");
            assert_eq!(session["fallbackHeadline"], "Review the parser");
        }
    }
}
