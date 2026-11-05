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
            super::process(
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
        next.terminal = false;
        next.deliveries.clear();
        next.observation = Value::Null;
        persist(&dir.0, &next).unwrap();
        super::process(
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
        super::process(
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
        super::process(
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
        let status = governance::status_in(&dir.0, &b.source_id, &json!({"all":true}), 131, &json!({})).unwrap();
        let deliveries = status["deliveries"].as_array().unwrap();
        assert!(!deliveries.is_empty());
        assert!(deliveries.iter().all(|d| d["state"] == "inbox-only"));
        let inbox = inbox_in(&dir.0, &b.source_id, &[], false, None).unwrap();
        assert_eq!(inbox["events"][0]["ownership"], handoff);
        assert_eq!(inbox["events"][0]["next"]["op"], "codex_owner");
    }
}
