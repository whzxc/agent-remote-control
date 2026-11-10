#[tokio::test]
async fn ax_late_restart_interruption_after_resumed_completion_is_superseded() {
    // Regression: AX-01 T1 interruption was delivered after resumed T2 and the whole thread completed.
    for pending in [false, true] {
        let dir = Sandbox::new();
        let mut old = fixture(&dir.0);
        old.thread_id = id();
        old.turn_id = id();
        let next_id = id();
        persist(&dir.0, &old).unwrap();
        crate::dispatch_policy::record(&json!({"requestId":old.turn_id,"threadId":old.thread_id,
            "turnId":old.turn_id,"dispatchMode":"new-turn","origin":{"sourceId":old.source_id},
            "task":{"dispatch":{"model":"model","effort":"high"}}}))
        .unwrap();
        if pending {
            process_observation(
                &dir.0,
                &Mutex::new(()),
                &mut old,
                &json!({"state":"cancelled"}),
            )
            .await
            .unwrap();
            old.deliveries[0].status = "sending".into();
            persist(&dir.0, &old).unwrap();
        }
        let mut next = old.clone();
        next.turn_id = next_id.clone();
        next.explicit = false;
        next.lifecycle = Value::Null;
        next.deliveries.clear();
        next.observation = Value::Null;
        persist(&dir.0, &next).unwrap();
        process_observation(
            &dir.0,
            &Mutex::new(()),
            &mut next,
            &json!({"state":"completed","finalResponse":"Done"}),
        )
        .await
        .unwrap();
        let history = [
            json!({"type":"session_meta","payload":{"id":old.thread_id}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":old.turn_id}}),
            json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":old.turn_id,"completed_at":1000}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":next_id,"started_at":1010,"turn_attribution":{"turn_trigger":"resume_interrupted_task"}}}),
            json!({"type":"turn_context","payload":{"turn_id":next_id,"cwd":"/project","model":"model","effort":"high","service_tier":null}}),
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":next_id,"completed_at":1020}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        let proof = continuation::evidence_from_history(
            &json!({"id":old.thread_id,"cwd":"/project"}),
            &old.turn_id,
            &json!({"id":next_id,"status":"completed","items":[]}),
            &history,
        )
        .unwrap();
        super::recover(&dir.0, &mut old).unwrap();
        process_observation(
            &dir.0,
            &Mutex::new(()),
            &mut old,
            &json!({"state":"cancelled","nextTurnId":next_id,"nativeContinuation":proof}),
        )
        .await
        .unwrap();
        let inbox = inbox_in(&dir.0, "claude", &[], false, None).unwrap();
        let event = inbox["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["turnId"] == old.turn_id && e["kind"] == "interrupted")
            .unwrap();
        assert_eq!(
            event["continuation"],
            json!({"turnId":next_id,"state":"completed"})
        );
        assert_eq!(event["summary"], GLYPHS[4]);
        assert_eq!(event["next"]["op"], "codex_read");
        for obsolete in ["resume", "retry"] {
            assert!(!string(event, "summary").contains(obsolete));
            assert!(!event["next"].to_string().contains(obsolete));
        }
        flush(
            &Fake::success(),
            &dir.0,
            &Mutex::new(()),
            i64::MAX,
            0,
            &json!({}),
        )
        .await
        .unwrap();
        let restored = binding(&dir.0, &old.thread_id, &old.turn_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            notification(Some(restored))["deliveries"][0]["state"],
            "resolved"
        );
    }
}

#[test]
fn ax_same_origin_push_uses_effective_binding_and_source_scoped_breaker() {
    // Regression: AX-02 omitted notify hid an inherited verified route and another source's breaker disabled it.
    let notification = json!({"sourceId":"owner","channel":"claude-session","target":"session_010000000000000000000001","reachability":"verified"});
    let mut state = State::default();
    state
        .target(
            "other",
            Channel::ClaudeSession,
            string(&notification, "target"),
            0,
            &json!({}),
        )
        .breaker = true;
    let available = effective_push(&notification, &json!({}), &state, true);
    assert!(available);
    let mut receipt = json!({"operation":"send","state":"completed","threadId":"thread","turnId":"turn","notification":notification});
    crate::egress::next(&mut receipt, "codex_send", &json!({}), available);
    assert!(receipt["next"]["op"].is_null());
    state
        .target(
            "owner",
            Channel::ClaudeSession,
            string(&notification, "target"),
            0,
            &json!({}),
        )
        .breaker = true;
    assert!(!effective_push(&notification, &json!({}), &state, true));
    assert!(!effective_push(
        &notification,
        &json!({"notificationsEnabled":false}),
        &State::default(),
        true
    ));
}

#[tokio::test]
async fn ax_first_observed_terminal_reaches_delivery_or_bounded_failure() {
    // Regression: AX-03 a first bound turn must deliver even when completion precedes its first observation, or expose bounded failure.
    for fail in [false, true] {
        let dir = Sandbox::new();
        let b = enqueue(
            &dir.0,
            "first",
            json!({"state":"completed","finalResponse":"PRIVATE_AGENT_OUTPUT"}),
            100,
        )
        .await;
        let fake = if fail {
            Fake::new(Err("transport unavailable".into()))
        } else {
            Fake::success()
        };
        for at in [100, 200, 400, 800, 1600, 3200] {
            flush(&fake, &dir.0, &Mutex::new(()), at, 0, &json!({}))
                .await
                .unwrap();
        }
        let status =
            governance::status_in(&dir.0, &b.source_id, &json!({"all":true}), 3200, &json!({}))
                .unwrap();
        let delivery = &status["deliveries"][0];
        assert_eq!(delivery["kind"], "completed");
        assert_eq!(delivery["state"], if fail { "failed" } else { "delivered" });
        if fail {
            assert!(delivery["error"].is_string());
        }
        for sent in fake.calls.lock().unwrap().iter() {
            assert!(sent[1].starts_with(RECEIPT_HEADER));
            assert!(!sent[1].contains("PRIVATE_AGENT_OUTPUT"));
        }
    }
}

#[tokio::test]
async fn ax_transient_delivery_failure_preserves_verified_route_across_reload() {
    // Regression: ax-364f9a4b replacement-time transport failures silently revoked an acknowledged notification route.
    let dir = Sandbox::new();
    let b = enqueue(&dir.0, "first", json!({"state":"completed"}), 100).await;
    let mut state = State::load(&dir.0).unwrap();
    state.targets[0].account_id = Some("fixture-profile".into());
    state.targets[0].reachability.verified_at = 42;
    state.save(&dir.0).unwrap();
    flush(
        &Fake::new(Err("temporary outage".into())),
        &dir.0,
        &Mutex::new(()),
        100,
        0,
        &json!({}),
    )
    .await
    .unwrap();
    let state = State::load(&dir.0).unwrap();
    assert_eq!(
        state.targets[0].account_id.as_deref(),
        Some("fixture-profile")
    );
    assert_eq!(state.targets[0].reachability.verified_at, 42);
    let failed =
        governance::status_in(&dir.0, &b.source_id, &json!({"all":true}), 101, &json!({})).unwrap();
    assert_eq!(failed["targets"][0]["reachability"], "verified");
    assert!(failed["deliveries"][0]["error"].is_string());
    flush(
        &Fake::success(),
        &dir.0,
        &Mutex::new(()),
        200,
        0,
        &json!({}),
    )
    .await
    .unwrap();
    assert_eq!(delivery_status(&dir.0, "first"), "delivered");
    assert_eq!(
        governance::status_in(&dir.0, &b.source_id, &json!({"all":true}), 201, &json!({})).unwrap()
            ["targets"][0]["reachability"],
        "verified"
    );
}

#[tokio::test]
async fn ax_acquisition_retains_history_without_waking_any_source() {
    // Regression: bfbcc64 ownership handoffs must retain history without waking either their initiating or another source.
    for own in [true, false] {
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let handoff = json!({"eventId":"acquired","from":"unheld","to":"connector","observedAt":now(),"causedBySourceId":if own {&b.source_id} else {"other"}});
        process_observation(
            &dir.0,
            &Mutex::new(()),
            &mut b,
            &json!({"state":"unconfirmed","handoffs":[handoff]}),
        )
        .await
        .unwrap();
        flush(
            &Fake::success(),
            &dir.0,
            &Mutex::new(()),
            chrono::Utc::now().timestamp() + 40,
            0,
            &json!({}),
        )
        .await
        .unwrap();
        let status =
            governance::status_in(&dir.0, &b.source_id, &json!({"all":true}), 131, &json!({}))
                .unwrap();
        let deliveries = status["deliveries"].as_array().unwrap();
        assert!(!deliveries.is_empty());
        assert!(deliveries.iter().all(|d| d["state"] == "inbox-only"));
        let inbox = inbox_in(&dir.0, &b.source_id, &[], false, None).unwrap();
        assert_eq!(inbox["events"][0]["ownership"], handoff);
        assert_eq!(inbox["events"][0]["next"]["op"], "codex_owner");
    }
}

fn selected_native(b: &Binding, status: &str, runtime: &str) -> Value {
    let (mut observed, turn) = crate::waiter::classify_with_lifecycle(
        &json!({"thread":{"id":b.thread_id,"status":{"type":runtime},"turns":[
            {"id":b.turn_id,"status":status,"items":[{"id":"answer","type":"agentMessage","text":"Finished; commit fixture123"}]}
        ]}}),
        &mut Some(b.turn_id.clone()),
    );
    observed["_turnLifecycle"] = turn_adapter::checkpoint(&turn);
    observed
}

#[tokio::test]
async fn ax_halted_snapshot_uses_the_bound_turns_native_completion() {
    // Regression: ax-1dda0f9e halted wake without inbox event
    let dir = Sandbox::new();
    let mut b = fixture(&dir.0);
    let history = [
        json!({"type":"session_meta","payload":{"id":b.thread_id}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":b.turn_id}}),
        // Tool output and a different turn's native interruption cannot end this turn.
        json!({"type":"response_item","payload":{"type":"function_call_output","output":json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":b.turn_id}}).to_string()}}),
        json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"isolated-turn"}}),
        json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":b.turn_id}}),
    ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
    // The stale snapshot arrives both before and after a normal completion read.
    for status in ["interrupted", "completed", "interrupted"] {
        let mut snapshot = json!({"thread":{"id":b.thread_id,"status":{"type":"active"},"turns":[
            {"id":b.turn_id,"status":status,"items":[]}
        ]}});
        crate::waiter::reconcile_interruption(&mut snapshot, &b.turn_id, Some(&history));
        let (mut observed, lifecycle) =
            crate::waiter::classify_with_lifecycle(&snapshot, &mut Some(b.turn_id.clone()));
        observed["_turnLifecycle"] = turn_adapter::checkpoint(&lifecycle);
        super::process(&dir.0, &Mutex::new(()), &mut b, &observed)
            .await
            .unwrap();
    }
    let at = chrono::Utc::now().timestamp() + 60;
    let fake = Fake::success();
    flush(&fake, &dir.0, &Mutex::new(()), at, 0, &json!({}))
        .await
        .unwrap();
    let status = governance::status_in(
        &dir.0,
        &b.source_id,
        &json!({"target":b.target}),
        at,
        &json!({}),
    )
    .unwrap();
    let deliveries = status["deliveries"].as_array().unwrap();
    assert!(!deliveries.is_empty());
    assert!(deliveries.iter().all(|d| d["kind"] == "completed"
        && d["state"] == "delivered"
        && d["threadId"] == b.thread_id
        && d["turnId"] == b.turn_id));
    let inbox = inbox_select(
        &dir.0,
        &b.source_id,
        &[],
        true,
        b.target.as_deref(),
        Some(&json!({})),
    )
    .unwrap();
    assert_eq!(inbox["events"][0]["eventId"], deliveries[0]["eventId"]);
    assert_eq!(inbox["events"][0]["kind"], "completed");
    assert_eq!(inbox["events"][0]["summary"], GLYPHS[5]);
    assert!(fake
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|call| call[1].contains(GLYPHS[5]) && !call[1].contains(GLYPHS[3])));
}

#[tokio::test]
async fn ax_unconfirmed_interruption_waits_for_its_own_native_terminal() {
    // Regression: ax-1dda0f9e halted wake without inbox event
    let dir = Sandbox::new();
    let mut b = fixture(&dir.0);
    let records = [
        json!({"type":"session_meta","payload":{"id":b.thread_id}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":b.turn_id}}),
        json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"other-turn"}}),
    ];
    let mut history = records
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    for native in [None, Some(history.as_str())] {
        let mut snapshot = json!({"thread":{"id":b.thread_id,"status":{"type":"notLoaded"},"turns":[{"id":b.turn_id,"status":"interrupted"}]}});
        crate::waiter::reconcile_interruption(&mut snapshot, &b.turn_id, native);
        let (mut observed, lifecycle) =
            crate::waiter::classify_with_lifecycle(&snapshot, &mut Some(b.turn_id.clone()));
        observed["_turnLifecycle"] = turn_adapter::checkpoint(&lifecycle);
        super::process(&dir.0, &Mutex::new(()), &mut b, &observed)
            .await
            .unwrap();
    }
    let at = chrono::Utc::now().timestamp() + 60;
    flush(&Fake::success(), &dir.0, &Mutex::new(()), at, 0, &json!({}))
        .await
        .unwrap();
    let status =
        governance::status_in(&dir.0, &b.source_id, &json!({"all":true}), at, &json!({})).unwrap();
    assert!(status["deliveries"].as_array().unwrap().is_empty());
    history.push_str(&format!(
        "\n{}",
        json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":b.turn_id}})
    ));
    let mut snapshot = json!({"thread":{"id":b.thread_id,"status":{"type":"notLoaded"},"turns":[{"id":b.turn_id,"status":"interrupted"}]}});
    crate::waiter::reconcile_interruption(&mut snapshot, &b.turn_id, Some(&history));
    let (mut observed, lifecycle) =
        crate::waiter::classify_with_lifecycle(&snapshot, &mut Some(b.turn_id.clone()));
    observed["_turnLifecycle"] = turn_adapter::checkpoint(&lifecycle);
    super::process(&dir.0, &Mutex::new(()), &mut b, &observed)
        .await
        .unwrap();
    flush(&Fake::success(), &dir.0, &Mutex::new(()), at, 0, &json!({}))
        .await
        .unwrap();
    let inbox = inbox_select(
        &dir.0,
        &b.source_id,
        &[],
        true,
        b.target.as_deref(),
        Some(&json!({})),
    )
    .unwrap();
    assert_eq!(inbox["events"][0]["kind"], "interrupted");
    assert_eq!(inbox["events"][0]["threadId"], b.thread_id);
    assert_eq!(inbox["events"][0]["turnId"], b.turn_id);
}

#[tokio::test]
async fn ax_sent_terminal_remains_readable_after_a_later_native_conflict() {
    // Regression: ax-1dda0f9e halted wake without inbox event
    let dir = Sandbox::new();
    let mut b = fixture(&dir.0);
    let interrupted = selected_native(&b, "interrupted", "active");
    super::process(&dir.0, &Mutex::new(()), &mut b, &interrupted)
        .await
        .unwrap();
    let at = chrono::Utc::now().timestamp() + 60;
    flush(&Fake::success(), &dir.0, &Mutex::new(()), at, 0, &json!({}))
        .await
        .unwrap();
    let completed = selected_native(&b, "completed", "active");
    super::process(&dir.0, &Mutex::new(()), &mut b, &completed)
        .await
        .unwrap();
    let status = governance::status_in(
        &dir.0,
        &b.source_id,
        &json!({"target":b.target}),
        at,
        &json!({}),
    )
    .unwrap();
    let delivery = &status["deliveries"][0];
    assert_eq!(delivery["kind"], "interrupted");
    assert_eq!(delivery["state"], "delivered");
    let inbox = inbox_select(
        &dir.0,
        &b.source_id,
        &[],
        true,
        b.target.as_deref(),
        Some(&json!({})),
    )
    .unwrap();
    assert_eq!(inbox["events"][0]["eventId"], delivery["eventId"]);
    assert_eq!(inbox["events"][0]["kind"], delivery["kind"]);
    assert_eq!(inbox["events"][0]["summary"], GLYPHS[3]);
    assert_eq!(inbox["events"][0]["threadId"], b.thread_id);
    assert_eq!(inbox["events"][0]["turnId"], b.turn_id);
}

#[tokio::test]
async fn ax_delayed_loss_and_stale_projection_push_agree_with_selected_native_completion() {
    // Regression: ax-0d9fb1f7 and ax-27840e50 pushed interrupted/halted while the selected native turn was completed.
    for order in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let completed = selected_native(&b, "completed", "unknown");
        let evidence = [
            completed.clone(),
            json!({"threadId":b.thread_id,"turnId":b.turn_id,"state":"cancelled","reason":"connection-closed"}),
            selected_native(&b, "inProgress", "active"),
        ];
        for index in order {
            super::process(&dir.0, &Mutex::new(()), &mut b, &evidence[index])
                .await
                .unwrap();
        }
        let fake = Fake::success();
        flush(
            &fake,
            &dir.0,
            &Mutex::new(()),
            chrono::Utc::now().timestamp() + 60,
            0,
            &json!({}),
        )
        .await
        .unwrap();
        let status = governance::status_in(
            &dir.0,
            "claude",
            &json!({"all":true}),
            chrono::Utc::now().timestamp() + 60,
            &json!({}),
        )
        .unwrap();
        assert_eq!(
            status["threads"][0]["diagnosis"]["observation"]["state"],
            completed["state"]
        );
        assert!(status["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d["kind"] == "completed" && d["state"] == "delivered"));
        let inbox = inbox_in(&dir.0, "claude", &[], false, None).unwrap();
        let event = &inbox["events"][0];
        assert_eq!(event["kind"], completed["state"]);
        assert_eq!(event["turnId"], b.turn_id);
        assert_eq!(event["finalResponse"], completed["finalResponse"]);
    }
}

#[tokio::test]
async fn ax_conflicting_native_outcomes_hold_delivery_and_explain_notify_status_after_restart() {
    // Regression: the terminal latch hid contradictory native completion and retained a pending interrupted push.
    for statuses in [["interrupted", "completed"], ["completed", "interrupted"]] {
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        for status in statuses {
            let observed = selected_native(&b, status, "idle");
            super::process(&dir.0, &Mutex::new(()), &mut b, &observed)
                .await
                .unwrap();
        }
        b = binding(&dir.0, &b.thread_id, &b.turn_id).unwrap().unwrap();
        b.observation = observer::unavailable(&mut b, "owner-lost-after-restart");
        persist(&dir.0, &b).unwrap();
        flush(
            &Fake::success(),
            &dir.0,
            &Mutex::new(()),
            chrono::Utc::now().timestamp() + 60,
            0,
            &json!({}),
        )
        .await
        .unwrap();
        let status = governance::status_in(
            &dir.0,
            "claude",
            &json!({"all":true}),
            chrono::Utc::now().timestamp() + 60,
            &json!({}),
        )
        .unwrap();
        let diagnosis = &status["threads"][0]["diagnosis"];
        assert_eq!(diagnosis["observation"]["state"], "unconfirmed");
        assert!(diagnosis["reasons"]
            .as_array()
            .unwrap()
            .contains(&json!("terminal-conflict")));
        assert_eq!(diagnosis["observation"]["conflict"]["turnId"], b.turn_id);
        let records = diagnosis["observation"]["conflict"]["records"]
            .as_array()
            .unwrap();
        assert!(records.iter().any(|r| r["status"] == "completed"));
        assert!(records.iter().any(|r| r["status"] == "interrupted"));
        assert!(status["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d["state"] == "pending" && d["timing"]["queueReason"] == "terminal-conflict"));
    }
}

#[tokio::test]
async fn owner_loss_and_interrupt_intent_emit_no_terminal_notification() {
    // Regression: synthesized cancelled state after owner loss or interrupt intent was accepted as native interruption.
    let dir = Sandbox::new();
    let mut b = fixture(&dir.0);
    let running = selected_native(&b, "inProgress", "active");
    super::process(&dir.0, &Mutex::new(()), &mut b, &running)
        .await
        .unwrap();
    for state in ["unconfirmed", "cancelling", "cancelled"] {
        let observed = json!({"threadId":b.thread_id,"turnId":b.turn_id,"state":state});
        super::process(&dir.0, &Mutex::new(()), &mut b, &observed)
            .await
            .unwrap();
    }
    b.observation = observer::unavailable(&mut b, "connection-closed");
    persist(&dir.0, &b).unwrap();
    flush(
        &Fake::success(),
        &dir.0,
        &Mutex::new(()),
        chrono::Utc::now().timestamp() + 60,
        0,
        &json!({}),
    )
    .await
    .unwrap();
    let status = governance::status_in(
        &dir.0,
        "claude",
        &json!({"all":true}),
        chrono::Utc::now().timestamp() + 60,
        &json!({}),
    )
    .unwrap();
    assert_eq!(
        status["threads"][0]["diagnosis"]["observation"]["state"],
        "unconfirmed"
    );
    assert_eq!(status["deliveries"], json!([]));
}

#[tokio::test]
async fn late_predecessor_cannot_replace_successor_lifecycle_or_payload() {
    // Regression: a late predecessor observation must not relabel the completed successor or overwrite its final response.
    let dir = Sandbox::new();
    let old = fixture(&dir.0);
    let predecessor = selected_native(&old, "interrupted", "idle");
    let mut next = old.clone();
    next.turn_id = "successor".into();
    next.lifecycle = Value::Null;
    persist(&dir.0, &next).unwrap();
    let completed = selected_native(&next, "completed", "idle");
    super::process(&dir.0, &Mutex::new(()), &mut next, &completed)
        .await
        .unwrap();
    super::process(&dir.0, &Mutex::new(()), &mut next, &predecessor)
        .await
        .unwrap();
    flush(
        &Fake::success(),
        &dir.0,
        &Mutex::new(()),
        chrono::Utc::now().timestamp() + 60,
        0,
        &json!({}),
    )
    .await
    .unwrap();
    let inbox = inbox_in(&dir.0, "claude", &[], false, None).unwrap();
    let event = inbox["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["turnId"] == "successor")
        .unwrap();
    assert_eq!(event["kind"], "completed");
    assert_eq!(event["finalResponse"], completed["finalResponse"]);
    let mut linked = old.clone();
    linked.successor = json!({"turnId":"successor","inherited":true});
    assert_eq!(
        continuation::notice(&linked, &predecessor, &[next])["state"],
        "completed"
    );
}

#[test]
fn notify_guide_defines_every_emittable_doorbell_label() {
    // Regression: ax-27840e50 received halted but guide topic:notify did not define that label.
    let guide = crate::control_profiles::guide(&json!({}), &json!({"topic":"notify"}), &[]);
    for label in GLYPHS {
        assert!(
            string(&guide, "content").contains(label),
            "missing label: {label}"
        );
    }
    assert!(string(&guide, "content").contains("◎ ping"));
}

#[tokio::test]
async fn conflict_arriving_after_reservation_blocks_the_next_transport() {
    // Regression: a reserved terminal push could retain an obsolete outcome while another destination was sending.
    struct DuringSend {
        directory: PathBuf,
    }
    impl Executor for DuringSend {
        async fn send(&self, _source: &str, args: Vec<String>) -> Result<Vec<u8>> {
            let target = args.windows(2).find(|pair| pair[0] == "--cloud").unwrap()[1].clone();
            for mut b in records(&self.directory)?
                .into_iter()
                .filter(|b| b.target.as_deref() != Some(&target) && b.terminal())
            {
                let contradictory = selected_native(&b, "interrupted", "idle");
                super::process(&self.directory, &Mutex::new(()), &mut b, &contradictory).await?;
            }
            Ok(json!({"ok":true,"session_id":target})
                .to_string()
                .into_bytes())
        }
        async fn escalate(&self, _body: String) -> Result<()> {
            Ok(())
        }
    }
    let dir = Sandbox::new();
    for index in 1..=2 {
        let mut b = fixture(&dir.0);
        b.thread_id = format!("reserved-{index}");
        b.target = Some(format!("session_{index:024}"));
        verified_fixture_target(&dir.0, &b);
        persist(&dir.0, &b).unwrap();
        let completed = selected_native(&b, "completed", "idle");
        super::process(&dir.0, &Mutex::new(()), &mut b, &completed)
            .await
            .unwrap();
    }
    let at = chrono::Utc::now().timestamp() + 60;
    flush(
        &DuringSend {
            directory: dir.0.clone(),
        },
        &dir.0,
        &Mutex::new(()),
        at,
        0,
        &json!({}),
    )
    .await
    .unwrap();
    let status =
        governance::status_in(&dir.0, "claude", &json!({"all":true}), at, &json!({})).unwrap();
    let deliveries = status["deliveries"].as_array().unwrap();
    assert!(deliveries
        .iter()
        .any(|d| d["state"] == "delivered" && d["kind"] == "completed"));
    assert!(deliveries
        .iter()
        .any(|d| d["state"] == "pending" && d["timing"]["queueReason"] == "terminal-conflict"));
    assert!(status["threads"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["diagnosis"]["reasons"]
            .as_array()
            .unwrap()
            .contains(&json!("terminal-conflict"))));
}

#[tokio::test]
async fn ordered_native_reconciliation_releases_a_conflicted_delivery() {
    // Regression: notification projection must not erase native sequence ordering when reconciling a held terminal push.
    use crate::turn_lifecycle::{advance, Transition};
    let dir = Sandbox::new();
    let mut b = fixture(&dir.0);
    for (status, sequence) in [("interrupted", 4), ("completed", 4), ("completed", 5)] {
        let turn = advance(
            &Transition::new(b.key()),
            &turn_adapter::codex_terminal(b.key(), status, Some(sequence)).unwrap(),
        );
        let mut observed = selected_native(&b, status, "idle");
        observed["_turnLifecycle"] = turn_adapter::checkpoint(&turn);
        super::process(&dir.0, &Mutex::new(()), &mut b, &observed)
            .await
            .unwrap();
        if status == "completed" && sequence == 4 {
            let result = governance::status_in(
                &dir.0,
                "claude",
                &json!({"threadId":b.thread_id}),
                100,
                &json!({}),
            )
            .unwrap();
            assert!(result["threads"][0]["diagnosis"]["reasons"]
                .as_array()
                .unwrap()
                .contains(&json!("terminal-conflict")));
            assert_eq!(
                result["threads"][0]["diagnosis"]["next"]["args"]["turnId"],
                b.turn_id
            );
        }
    }
    let at = chrono::Utc::now().timestamp() + 60;
    flush(&Fake::success(), &dir.0, &Mutex::new(()), at, 0, &json!({}))
        .await
        .unwrap();
    let status =
        governance::status_in(&dir.0, "claude", &json!({"all":true}), at, &json!({})).unwrap();
    assert_eq!(
        status["threads"][0]["diagnosis"]["observation"]["state"],
        "completed"
    );
    assert!(status["threads"][0]["diagnosis"]["observation"]["conflict"].is_null());
    assert!(status["deliveries"]
        .as_array()
        .unwrap()
        .iter()
        .all(|d| d["state"] == "delivered" && d["kind"] == "completed"));
    let inbox = inbox_in(&dir.0, "claude", &[], false, None).unwrap();
    assert_eq!(inbox["events"][0]["kind"], "completed");
}

#[tokio::test]
async fn selected_summary_read_retains_its_turn_acknowledgement_scope() {
    // Regression: codex_read summary results have no turns array and were skipped by notification read tracking.
    let control = control::Control::new(PathBuf::new());
    let thread = id();
    let turn = id();
    let value = json!({"threadId":thread,"turnId":turn,"state":"completed","recordedStatus":"completed","finalResponse":{"text":"Finished"}});
    let reads = read_turns(
        &control,
        "codex_read",
        &json!({"threadId":thread,"turnId":turn,"view":"summary"}),
        &value,
    )
    .await
    .unwrap();
    assert_eq!(reads, vec![(thread, turn)]);
}
