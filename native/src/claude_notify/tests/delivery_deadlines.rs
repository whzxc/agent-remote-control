use super::*;

#[tokio::test]
async fn control_change_during_transport_keeps_its_selected_wake() {
    // Regression: 21077483 delivery deadline busy loop on unbound pending deliveries
    struct UnmuteDuringSend<'a> {
        dir: &'a Path,
        now: i64,
    }
    impl Executor for UnmuteDuringSend<'_> {
        async fn escalate(&self, _body: String) -> Result<()> {
            Ok(())
        }
        async fn send(&self, _source: &str, _args: Vec<String>) -> Result<Vec<u8>> {
            governance::control_in(
                self.dir,
                "claude",
                &json!({"action":"unmute","threadId":"muted"}),
                self.now,
                &json!({}),
            )
            .unwrap();
            Ok(br#"{"ok":true,"session_id":"session_010000000000000000000001"}"#.to_vec())
        }
    }
    let dir = Sandbox::new();
    let at = chrono::Utc::now().timestamp();
    enqueue(&dir.0, "ready", json!({"state":"completed"}), at - 10).await;
    enqueue(&dir.0, "muted", json!({"state":"completed"}), at - 10).await;
    governance::control_in(
        &dir.0,
        "claude",
        &json!({"action":"mute","threadId":"muted"}),
        at,
        &json!({}),
    )
    .unwrap();
    let mut idle = DeliveryIdle::default();
    let lock = Mutex::new(());
    idle.flush(
        &UnmuteDuringSend {
            dir: &dir.0,
            now: at,
        },
        &dir.0,
        &lock,
        at,
        DeliveryInputs::read(&dir.0, json!({})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(delivery_status(&dir.0, "ready"), "delivered");
    assert_eq!(delivery_status(&dir.0, "muted"), "pending");
    assert!(idle.next_at.is_some_and(|next| next > at && next <= at + 1));
    idle.flush(
        &Fake::success(),
        &dir.0,
        &lock,
        at + 1,
        DeliveryInputs::read(&dir.0, json!({})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(delivery_status(&dir.0, "muted"), "delivered");
}

#[tokio::test]
async fn parked_deliveries_do_not_spin_the_deadline_owner() {
    // Regression: 21077483 delivery deadline busy loop on unbound pending deliveries
    use crate::runtime_metrics::cost::{self, Owner, Reason};
    let dir = Sandbox::new();
    let at = chrono::Utc::now().timestamp();
    let settings = json!({"notificationRefillSeconds":1000,"notificationEscalationSeconds":5});
    let base = enqueue(&dir.0, "ready", json!({"state":"completed"}), at - 10).await;
    for n in 0..256 {
        let mut b = base.clone();
        b.thread_id = format!("parked-{n}");
        b.target = None;
        fixture_state(&mut b, "completed");
        for d in &mut b.deliveries {
            d.target.clear();
            d.subscription.clear();
            d.event_id = format!("event-{n}");
        }
        persist(&dir.0, &b).unwrap();
    }
    enqueue(&dir.0, "ready-next", json!({"state":"completed"}), at - 10).await;
    let mut state = State::load(&dir.0).unwrap();
    let target = state.target(
        "claude",
        Channel::ClaudeSession,
        "session_010000000000000000000002",
        at,
        &settings,
    );
    target.tokens = 0;
    target.empty_since = Some(at - 20);
    state.save(&dir.0).unwrap();
    let control = control::Control::new(PathBuf::new());
    let metrics = || control.tool("runtime_metrics", json!({}));
    let before = metrics().await.unwrap();
    let fake = Fake::success();
    let lock = Mutex::new(());
    let mut idle = DeliveryIdle::default();
    let mut now = at;
    let mut passes = 0;
    while now <= at + 120 && passes < 100 {
        cost::scope(
            Owner::NotificationDelivery,
            Reason::Deadline,
            Box::pin(idle.flush(
                &fake,
                &dir.0,
                &lock,
                now,
                DeliveryInputs::read(&dir.0, settings.clone()).unwrap(),
            )),
        )
        .await
        .unwrap();
        passes += 1;
        now = if idle.inputs.is_none() {
            now + 1
        } else {
            idle.next_at.unwrap_or(at + 121).max(now)
        };
    }
    let after = metrics().await.unwrap();
    let delta = |key: &str| {
        after["cost"]["notificationDelivery"][key].as_u64().unwrap()
            - before["cost"]["notificationDelivery"][key]
                .as_u64()
                .unwrap()
    };
    println!("delivery-deadlines interval=120 unbound=256 passes={} rowsVisited={} cacheMisses={} recordsChanged={}", delta("passes"), delta("rowsVisited"), delta("cacheMisses"), delta("recordsChanged"));
    assert!(
        passes <= 4,
        "deadline owner repeated without a due event: {passes}"
    );
    assert!(delta("rowsVisited") < 3000);
    let status =
        governance::status_in(&dir.0, "claude", &json!({"all":true}), at + 120, &settings).unwrap();
    let deliveries = status["deliveries"].as_array().unwrap();
    assert_eq!(
        deliveries
            .iter()
            .filter(|d| d["state"] == "pending")
            .count(),
        256
    );
    assert_eq!(
        deliveries
            .iter()
            .filter(|d| d["state"] == "delivered" && d["attempts"] == 1)
            .count(),
        2
    );
    let before = metrics().await.unwrap();
    governance::control_in(&dir.0, "claude", &json!({"action":"rebind","threadId":"parked-0","target":"session_010000000000000000000001"}), at + 121, &settings).unwrap();
    cost::scope(
        Owner::NotificationDelivery,
        Reason::Event,
        Box::pin(idle.flush(
            &fake,
            &dir.0,
            &lock,
            at + 121,
            DeliveryInputs::read(&dir.0, settings.clone()).unwrap(),
        )),
    )
    .await
    .unwrap();
    let after = metrics().await.unwrap();
    let rows = after["cost"]["notificationDelivery"]["rowsVisited"]
        .as_u64()
        .unwrap()
        - before["cost"]["notificationDelivery"]["rowsVisited"]
            .as_u64()
            .unwrap();
    println!("delivery-deadlines target-bind rowsVisited={rows}");
    assert!(
        rows < 30,
        "target binding woke unrelated parked rows: {rows}"
    );
    assert_eq!(delivery_status(&dir.0, "parked-0"), "delivered");
    assert_eq!(delivery_status(&dir.0, "parked-1"), "pending");

    // Filesystem events caused by our writes may wake the owner again, without work.
    let before = metrics().await.unwrap();
    for _ in 0..10 {
        cost::scope(
            Owner::NotificationDelivery,
            Reason::Dirty,
            Box::pin(idle.flush(
                &fake,
                &dir.0,
                &lock,
                at + 122,
                DeliveryInputs::read(&dir.0, settings.clone()).unwrap(),
            )),
        )
        .await
        .unwrap();
    }
    let after = metrics().await.unwrap();
    for key in [
        "rowsVisited",
        "bytesParsed",
        "cacheMisses",
        "recordsChanged",
    ] {
        assert_eq!(
            after["cost"]["notificationDelivery"][key], before["cost"]["notificationDelivery"][key],
            "idle {key}"
        );
    }
    println!("delivery-deadlines idle-wakes=10 rowsVisited=0 bytesParsed=0 cacheMisses=0 recordsChanged=0");
}

#[tokio::test]
async fn batch_retry_and_native_admission_wait_for_their_own_events() {
    // Regression: 21077483 delivery deadline busy loop on unbound pending deliveries
    use crate::runtime_metrics::cost::{self, Owner, Reason};
    let dir = Sandbox::new();
    let at = chrono::Utc::now().timestamp();
    let settings = json!({"notificationRefillSeconds":1000});
    let first = enqueue(&dir.0, "first", json!({"state":"completed"}), at - 1).await;
    enqueue(&dir.0, "second", json!({"state":"completed"}), at).await;
    let mut uncertain = first.clone();
    uncertain.thread_id = "unconfirmed".into();
    fixture_state(&mut uncertain, "unconfirmed");
    persist(&dir.0, &uncertain).unwrap();
    let lock = Mutex::new(());
    let mut idle = DeliveryIdle::default();
    let control = control::Control::new(PathBuf::new());
    let metrics = || control.tool("runtime_metrics", json!({}));
    let failed = Fake::new(Err("offline".into()));
    let success = Fake::success();
    for (now, executor) in [(at, &success), (at + 2, &failed), (at + 12, &success)] {
        cost::scope(
            Owner::NotificationDelivery,
            Reason::Deadline,
            Box::pin(idle.flush(
                executor,
                &dir.0,
                &lock,
                now,
                DeliveryInputs::read(&dir.0, settings.clone()).unwrap(),
            )),
        )
        .await
        .unwrap();
        assert!(idle.next_at.is_none_or(|next| next > now));
        let status =
            governance::status_in(&dir.0, "claude", &json!({"all":true}), now, &settings).unwrap();
        for d in status["deliveries"].as_array().unwrap() {
            if d["threadId"] == "unconfirmed" {
                assert_eq!(d["state"], "pending");
                assert_eq!(d["attempts"], 0);
                assert_eq!(d["timing"]["queueReason"], "native-outcome-unconfirmed");
            } else if now == at {
                assert_eq!(d["timing"]["queueReason"], "batch-window");
                assert_eq!(d["nextAttemptAt"], at + 2);
            } else if now == at + 2 {
                assert_eq!(d["timing"]["queueReason"], "retry-backoff");
                assert_eq!(d["nextAttemptAt"], at + 12);
            } else {
                assert_eq!(d["state"], "delivered");
                assert_eq!(d["attempts"], 2);
            }
        }
        let before = metrics().await.unwrap();
        cost::scope(
            Owner::NotificationDelivery,
            Reason::Dirty,
            Box::pin(idle.flush(
                &success,
                &dir.0,
                &lock,
                now + 1,
                DeliveryInputs::read(&dir.0, settings.clone()).unwrap(),
            )),
        )
        .await
        .unwrap();
        let after = metrics().await.unwrap();
        for key in [
            "rowsVisited",
            "bytesParsed",
            "cacheMisses",
            "recordsChanged",
        ] {
            assert_eq!(
                after["cost"]["notificationDelivery"][key],
                before["cost"]["notificationDelivery"][key],
                "idle {key}"
            );
        }
    }
    process_observation(&dir.0, &lock, &mut uncertain, &json!({"state":"completed"}))
        .await
        .unwrap();
    idle.flush(
        &success,
        &dir.0,
        &lock,
        at + 14,
        DeliveryInputs::read(&dir.0, settings.clone()).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(delivery_status(&dir.0, "unconfirmed"), "delivered");
}
