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
        let status = lifecycle_status(&dir.0, &b.source_id, 100);
        let deliveries = status["deliveries"].as_array().unwrap();
        assert!(!deliveries.is_empty());
        assert!(deliveries.iter().all(|d| d["state"] == "inbox-only"));
        let inbox = inbox_in(&dir.0, &b.source_id, &[], false, None).unwrap();
        assert_eq!(inbox["events"][0]["ownership"], handoff);
        assert_eq!(inbox["events"][0]["next"]["op"], "codex_owner");
    }
}

#[tokio::test]
async fn ax_lifecycle_outcome_and_late_settling_remain_queryable_without_waking() {
    // Regression: bfbcc64 update lifecycle history must remain inbox-only, including replayed outcomes and late settling without an execution interaction.
    let dir = Sandbox::new();
    let mut b = fixture(&dir.0);
    b.waiting = vec!["waiting for input".into()];
    persist(&dir.0, &b).unwrap();
    let read_inbox =
        || inbox_select(&dir.0, &b.source_id, &[], false, None, Some(&json!({}))).unwrap();
    let at = chrono::Utc::now().timestamp();
    let mut receipt = json!({"id":"ordered","state":"settling","waiting":{"blockingTurns":[{"threadId":b.thread_id,"turnId":b.turn_id,"question":{"id":"pending","body":"PRIVATE_QUESTION"}}]}});
    recovery::update(&dir.0, &Mutex::new(()), &receipt, "settling", at)
        .await
        .unwrap();
    assert_eq!(
        lifecycle_status(&dir.0, &b.source_id, at)["deliveries"][0]["state"],
        "inbox-only"
    );
    let settling = read_inbox();
    let settling_id = settling["events"][0]["eventId"].clone();
    receipt["state"] = json!("succeeded");
    receipt["shutdownRequested"] = json!(true);
    receipt["interruptedTurns"] = json!([{"threadId":b.thread_id,"turnId":b.turn_id,"state":"receipt-returned","resumeReceipt":{"state":"completed","turnId":"successor"}}]);
    recovery::update(&dir.0, &Mutex::new(()), &receipt, "outcome", at + 1)
        .await
        .unwrap();
    let outcome = read_inbox()["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["eventId"] != settling_id)
        .unwrap()
        .clone();
    assert_eq!(outcome["recovery"]["affectedTasks"], 1);
    recovery::update(&dir.0, &Mutex::new(()), &receipt, "settling", at + 2)
        .await
        .unwrap();
    recovery::update(&dir.0, &Mutex::new(()), &receipt, "outcome", at + 1)
        .await
        .unwrap();
    flush(
        &Fake::success(),
        &dir.0,
        &Mutex::new(()),
        at + 40,
        0,
        &json!({}),
    )
    .await
    .unwrap();
    let status = lifecycle_status(&dir.0, &b.source_id, at);
    let deliveries = status["deliveries"].as_array().unwrap();
    assert!(!deliveries.is_empty());
    assert!(deliveries.iter().all(|d| d["state"] == "inbox-only"));
    let inbox = read_inbox();
    let events = inbox["events"].as_array().unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|e| e["eventId"] == outcome["eventId"])
            .collect::<Vec<_>>(),
        vec![&outcome]
    );
    for event in events {
        assert_eq!(event["next"]["op"], "update_status");
        assert!(event["interaction"].is_null());
    }
    recovery::update(
        &dir.0,
        &Mutex::new(()),
        &json!({"id":"no-blockers","waiting":{"blockingTurns":[]}}),
        "settling",
        at + 50,
    )
    .await
    .unwrap();
    assert_eq!(read_inbox()["events"], inbox["events"]);
}

#[tokio::test]
async fn ax_lifecycle_counts_and_routes_only_affected_owners() {
    // Regression: bfbcc64 lifecycle notices must remain inbox-only while AX-15 and AX-21 affected counts stay scoped to each source and target, excluding finished turns.
    let dir = Sandbox::new();
    let mut owner = fixture(&dir.0);
    owner.thread_title = "Affected task".into();
    persist(&dir.0, &owner).unwrap();
    let mut others = Vec::new();
    for (name, source, target, terminal) in [
        (
            "same-source-other-target",
            "claude",
            "session_010000000000000000000002",
            false,
        ),
        (
            "other-source",
            "other",
            "session_010000000000000000000001",
            false,
        ),
        (
            "finished",
            "claude",
            "session_010000000000000000000003",
            true,
        ),
    ] {
        let mut b = owner.clone();
        b.thread_id = name.into();
        b.source_id = source.into();
        b.target = Some(target.into());
        b.terminal = terminal;
        verified_fixture_target(&dir.0, &b);
        persist(&dir.0, &b).unwrap();
        others.push(b);
    }
    let at = chrono::Utc::now().timestamp();
    let receipt = json!({"id":"scoped","state":"succeeded","shutdownRequested":true,"interruptedTurns":[
        {"threadId":owner.thread_id,"turnId":owner.turn_id,"state":"receipt-returned","resumeReceipt":{"state":"completed","turnId":"next"}},
        {"threadId":"finished","turnId":"turn-1","state":"finished-before-shutdown"}
    ]});
    update_phases(&dir.0, &receipt, at).await;
    for b in std::iter::once(&owner).chain(&others) {
        let status = governance::status_in(
            &dir.0,
            &b.source_id,
            &json!({"target":b.target}),
            at + 32,
            &json!({}),
        )
        .unwrap();
        let deliveries = status["deliveries"].as_array().unwrap();
        assert!(!deliveries.is_empty());
        assert!(deliveries.iter().all(|d| d["state"] == "inbox-only"));
        let inbox = inbox_select(
            &dir.0,
            &b.source_id,
            &[],
            true,
            b.target.as_deref(),
            Some(&json!({})),
        )
        .unwrap();
        for event in inbox["events"].as_array().unwrap() {
            assert_eq!(event["threadId"], b.thread_id);
            assert_eq!(event["target"], json!(b.target));
            assert_eq!(event["next"]["op"], "update_status");
        }
        let counts: Vec<_> = inbox["events"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|e| e["recovery"]["affectedTasks"].as_u64())
            .collect();
        if b.thread_id == owner.thread_id {
            assert!(counts.contains(&1));
            assert!(counts.iter().all(|n| *n <= 1));
        } else {
            assert!(counts.iter().all(|n| *n == 0));
        }
    }
}
