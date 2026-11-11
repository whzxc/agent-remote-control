use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("arc-device-notify-{}", id())))
    }
    fn seed(&self, task: &str, remote: bool, state: &str, target: bool) -> Binding {
        let thread = if remote {
            key("member", task)
        } else {
            task.into()
        };
        let mut b: Binding = serde_json::from_value(json!({"threadId":thread,"turnId":"turn","sourceId":"origin","agent":"codex","device":if remote {json!({"id":"member","name":"Notebook","taskId":task})}else{Value::Null},"target":if target {json!("session_010000000000000000000001")}else{Value::Null},"project":"Synthetic","createdAt":chrono::Utc::now().timestamp(),"waiting":[],"deliveries":[],"observation":{"state":state}})).unwrap();
        crate::claude_notify::tests::fixture_state(&mut b, state);
        persist(&self.0, &b).unwrap();
        b
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn device_event_work_is_independent_of_retained_binding_count() {
    // Regression: hundreds of retained, pending and unbound notification records must not be hydrated or rewritten for one member event.
    let fixture = Fixture::new();
    for i in 0..640 {
        let mut b = fixture.seed(
            &format!("retained-{i}"),
            i % 2 == 0,
            if i % 3 == 0 { "completed" } else { "running" },
            i % 4 != 0,
        );
        if i % 5 == 0 {
            b.deliveries.push(serde_json::from_value(json!({"key":"terminal","target":b.target.clone().unwrap_or_default(),"eventId":id(),"state":"completed","taskState":"completed","status":"pending"})).unwrap());
            persist(&fixture.0, &b).unwrap();
        }
    }
    let b = fixture.seed("selected", true, "running", true);
    let local = fixture.seed("selected", false, "running", true);
    index::initialize(&fixture.0).unwrap();
    let before = BINDINGS.lock().unwrap().diagnostics();
    let revision = index::diagnostics(&fixture.0)["revision"].as_u64().unwrap();
    let event = json!({"eventId":"native-event","kind":"completed","threadId":"selected","turnId":"turn","agent":"codex","title":"Synthetic result","finalResponse":"done"});
    receive_in(&fixture.0, &Mutex::new(()), "member", "origin", &event)
        .await
        .unwrap();
    let after = BINDINGS.lock().unwrap().diagnostics();
    let result = binding(&fixture.0, &b.thread_id, &b.turn_id)
        .unwrap()
        .unwrap();
    assert_eq!(result.deliveries[0].task_state, "completed");
    assert_eq!(result.source_id, "origin");
    assert_eq!(
        binding(&fixture.0, &local.thread_id, &local.turn_id)
            .unwrap()
            .unwrap()
            .observation["state"],
        "running"
    );
    assert!(
        after["fileOpens"]
            .as_u64()
            .unwrap()
            .saturating_sub(before["fileOpens"].as_u64().unwrap())
            <= 4
    );
    assert_eq!(
        index::diagnostics(&fixture.0)["revision"].as_u64().unwrap() - revision,
        1
    );
    let notice = super::super::event(&result, &result.deliveries[0]);
    assert_eq!(notice["device"]["id"], "member");
    assert_eq!(notice["threadId"], "selected");
    assert_eq!(notice["next"]["op"], "device");
    let revision = index::diagnostics(&fixture.0)["revision"].clone();
    receive_in(&fixture.0, &Mutex::new(()), "member", "origin", &event)
        .await
        .unwrap();
    assert_eq!(index::diagnostics(&fixture.0)["revision"], revision);
    let status = governance::status_in(
        &fixture.0,
        "origin",
        &json!({"view":"full"}),
        chrono::Utc::now().timestamp(),
        &json!({}),
    )
    .unwrap();
    assert!(status["threads"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["device"]["id"] == "member"));
}

#[tokio::test]
async fn member_events_cannot_enter_member_delivery_targets() {
    // Contract: a peer-origin observation queues a structured member event and never creates an inbox or push for a member target.
    let fixture = Fixture::new();
    let mut b = fixture.seed("peer-task", false, "running", true);
    b.peer_controller = Some("synthetic-peer".into());
    persist(&fixture.0, &b).unwrap();
    let baseline =
        crate::device_link::controller::events::read("synthetic-peer", &json!({"cursor":null}))
            .await
            .unwrap();
    let thread = b.thread_id.clone();
    process(&fixture.0,&Mutex::new(()),&mut b,&json!({"threadId":thread,"turnId":"turn","state":"completed","recordedStatus":"completed","finalResponse":"native result"})).await.unwrap();
    let queued = crate::device_link::controller::events::read(
        "synthetic-peer",
        &json!({"cursor":baseline["cursor"],"epoch":baseline["epoch"]}),
    )
    .await
    .unwrap();
    assert_eq!(queued["events"][0]["event"]["kind"], "completed");
    assert!(b.deliveries.iter().all(|d| d.status == "inbox-only"));
    assert!(inbox_in(&fixture.0, "origin", &[], false, None)
        .unwrap()
        .is_null());
}

struct Receiver(std::sync::Mutex<Option<(String, String)>>);
impl Executor for Receiver {
    async fn send(&self, source: &str, args: Vec<String>) -> Result<Vec<u8>> {
        *self.0.lock().unwrap() = Some((source.into(), args[1].clone()));
        Ok(br#"{"ok":true,"session_id":"session_010000000000000000000001"}"#.to_vec())
    }
    async fn escalate(&self, _body: String) -> Result<()> {
        Ok(())
    }
}
#[tokio::test]
async fn all_member_event_kinds_retain_owner_delivery_semantics() {
    // Contract: member event kinds retain task identity and controller routing; task outcomes and stalled/input events push, while handoff/recovered stay inbox-only.
    for kind in [
        "completed",
        "failed",
        "interrupted",
        "stalled",
        "needs-input",
        "handoff",
        "recovered",
    ] {
        let fixture = Fixture::new();
        let b = fixture.seed(kind, true, "running", true);
        let mut state = State::load(&fixture.0).unwrap();
        state
            .target(
                "origin",
                b.channel,
                b.target.as_deref().unwrap(),
                0,
                &json!({}),
            )
            .reachability
            .state = "verified".into();
        state.save(&fixture.0).unwrap();
        let event = json!({"kind":kind,"eventId":kind,"threadId":kind,"turnId":"turn","agent":"codex","title":"Synthetic title","finalResponse":"result",
            "interaction":if kind=="needs-input"{json!({"id":"question","method":"requestUserInput","turnId":"turn"})}else{Value::Null},
            "ownership":{"eventId":"handoff-event","observedAt":now()},"recovery":{"recoveredAt":now(),"affectedTasks":1},
            "progress":{"evidence":{"lastActivityAt":"2026-01-01T00:00:00Z"}}});
        receive_in(&fixture.0, &Mutex::new(()), "member", "origin", &event)
            .await
            .unwrap();
        let receiver = Receiver(Default::default());
        flush(
            &receiver,
            &fixture.0,
            &Mutex::new(()),
            chrono::Utc::now().timestamp() + 60,
            0,
            &json!({"notificationBucketCapacity":100,"requestRoutingDelaySeconds":0}),
        )
        .await
        .unwrap();
        let result = binding(&fixture.0, &b.thread_id, "turn").unwrap().unwrap();
        let delivery = &result.deliveries[0];
        assert_eq!(event_kind(delivery), kind);
        assert_eq!(
            super::super::event(&result, delivery)["next"]["op"],
            "device"
        );
        assert_eq!(
            delivery.status,
            if matches!(kind, "handoff" | "recovered") {
                "inbox-only"
            } else {
                "delivered"
            }
        );
        if let Some((source, text)) = receiver.0.into_inner().unwrap() {
            assert_eq!(source, "origin");
            assert!(text.contains(string(&b.device, "name")));
            assert!(text.contains(kind));
        }
    }
}
