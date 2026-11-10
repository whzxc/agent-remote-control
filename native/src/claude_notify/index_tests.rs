use super::*;
use crate::runtime_metrics::cost::{self, Owner, Reason};
struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("arc-activity-index-{}", id())))
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        index::forget(&self.0);
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn fixture(dir: &Path, name: &str, state: &str) -> Binding {
    let mut b: Binding = serde_json::from_value(json!({"threadId":format!("thread-{name}"),"turnId":name,"sourceId":"fixture-source","target":null,"project":"fixture","createdAt":chrono::Utc::now().timestamp(),"waiting":[],"deliveries":[],"observation":{"state":state,"recordedStatus":state,"reconciliation":"reconciled"}})).unwrap();
    tests::fixture_state(&mut b, state);
    persist(dir, &b).unwrap();
    b
}
async fn pass(dir: &Path, at: i64) -> Result<()> {
    cost::scope(Owner::NotificationObserver, Reason::Deadline, async {
        for (original, changed, superseded) in index::observation_due(dir, at)? {
            if original.source_id.is_empty() && !changed { continue; }
            let Some(mut b) = binding(dir, &original.thread_id, &original.turn_id)? else { continue };
            if remove_expired(dir, &b, at, superseded)? { continue; }
            if changed && observer::exhausted(&b) {
                b.observation["reconciliationAttempts"] = json!(0);
                b.observation["reconciliation"] = json!("pending-after-restart");
                persist(dir, &b)?;
            }
            let observation = json!({"threadId":b.thread_id,"turnId":b.turn_id,"state":"running","recordedStatus":"inProgress"});
            process(dir, &Mutex::new(()), &mut b, &observation).await?;
            index::finish(dir, &b.thread_id, &b.turn_id, None)?;
        }
        Ok(())
    }).await
}
async fn metrics(control: &Arc<control::Control>) -> Value {
    control.tool("runtime_metrics", json!({})).await.unwrap()
}
fn delta(before: &Value, after: &Value, owner: &str, key: &str) -> u64 {
    after["cost"][owner][key].as_u64().unwrap() - before["cost"][owner][key].as_u64().unwrap()
}
#[tokio::test]
async fn retained_history_has_flat_observation_cost_and_active_work_scales() {
    // Regression: ax-090844fd one active binding visited 10 then 82 history-map rows as completed history grew from 4 to 40.
    let control = control::Control::new(PathBuf::new());
    let mut totals = Vec::new();
    for (history, active) in [(4, 1), (40, 1), (40, 3), (40, 0)] {
        let dir = Sandbox::new();
        for n in 0..history {
            let mut b = fixture(&dir.0, &format!("completed-{n}"), "completed");
            b.scope_end = Some("scope-ended".into());
            persist(&dir.0, &b).unwrap();
        }
        for n in 0..active {
            fixture(&dir.0, &format!("active-{n}"), "running");
        }
        let cold = metrics(&control).await;
        index::all(&dir.0).unwrap();
        let seeded = metrics(&control).await;
        assert!(delta(&cold, &seeded, "notificationSeed", "rowsVisited") >= history + active);
        let at = chrono::Utc::now().timestamp() + 10;
        pass(&dir.0, at).await.unwrap();
        let before = metrics(&control).await;
        pass(&dir.0, at).await.unwrap();
        let after = metrics(&control).await;
        let rows = delta(&before, &after, "notificationObserver", "rowsVisited");
        assert_eq!(
            delta(&before, &after, "notificationObserver", "bytesParsed"),
            0
        );
        assert_eq!(
            delta(&before, &after, "notificationObserver", "bytesRead"),
            0
        );
        assert_eq!(
            delta(&before, &after, "notificationObserver", "recordsChanged"),
            0
        );
        totals.push(rows);
        println!("activity-index history={history} active={active} rowsVisited={rows} bytesParsed=0 seedRows={}", delta(&cold, &seeded, "notificationSeed", "rowsVisited"));
        let status = governance::status_in(
            &dir.0,
            "fixture-source",
            &json!({"all":true}),
            at,
            &json!({}),
        )
        .unwrap();
        assert!(status.is_object());
    }
    assert!(totals[0] > 0);
    assert_eq!(totals[0], totals[1]);
    assert_eq!(totals[2], totals[1] * 3);
    assert_eq!(totals[3], 0);
}
#[tokio::test]
async fn dormant_evidence_and_explicit_reads_reactivate_only_the_selected_scope() {
    // Regression: exhausted notification reconciliation must remain idle until a selected read, native change, file change or successor arrives.
    let dir = Sandbox::new();
    let mut b = fixture(&dir.0, "dormant", "running");
    for _ in 0..observer::RECONCILIATION_ATTEMPTS {
        b.observation = observer::unavailable(&mut b, "unavailable");
    }
    persist(&dir.0, &b).unwrap();
    index::all(&dir.0).unwrap();
    let at = chrono::Utc::now().timestamp() + 10;
    assert!(index::observation_due(&dir.0, at).unwrap().is_empty());
    let status = governance::status_in(
        &dir.0,
        &b.source_id,
        &json!({"threadId":b.thread_id}),
        at,
        &json!({}),
    )
    .unwrap();
    assert!(status["threads"][0]["diagnosis"]["reasons"]
        .as_array()
        .unwrap()
        .contains(&json!("unavailable-after-restart")));
    index::read_key(&dir.0, &b.thread_id, &b.turn_id).unwrap();
    pass(&dir.0, at).await.unwrap();
    assert_eq!(
        binding(&dir.0, &b.thread_id, &b.turn_id)
            .unwrap()
            .unwrap()
            .observation["state"],
        "running"
    );
    persist(&dir.0, &b).unwrap();
    native_changed("unrelated");
    assert!(index::observation_due(&dir.0, at).unwrap().is_empty());
    native_changed(&b.thread_id);
    pass(&dir.0, at).await.unwrap();
    assert_eq!(
        binding(&dir.0, &b.thread_id, &b.turn_id)
            .unwrap()
            .unwrap()
            .observation["state"],
        "running"
    );
    persist(&dir.0, &b).unwrap();
    let native = dir.0.join("native-history.jsonl");
    save_bytes(&native, b"before").unwrap();
    let watch = observer::TerminalWatch::from_path(&b, Some(native.clone()));
    index::finish(&dir.0, &b.thread_id, &b.turn_id, Some(&watch)).unwrap();
    save_bytes(&native, b"native-change").unwrap();
    pass(&dir.0, at).await.unwrap();
    assert_eq!(
        binding(&dir.0, &b.thread_id, &b.turn_id)
            .unwrap()
            .unwrap()
            .observation["state"],
        "running"
    );
    persist(&dir.0, &b).unwrap();
    let mut next = b.clone();
    next.turn_id = "successor".into();
    next.created_at += 1;
    tests::fixture_state(&mut next, "running");
    next.observation = json!({"state":"running"});
    persist(&dir.0, &next).unwrap();
    pass(&dir.0, at).await.unwrap();
    assert_eq!(
        binding(&dir.0, &b.thread_id, &b.turn_id)
            .unwrap()
            .unwrap()
            .observation["state"],
        "running"
    );
    let unassigned = Sandbox::new();
    let mut legacy = fixture(&unassigned.0, "legacy", "unconfirmed");
    legacy.source_id.clear();
    persist(&unassigned.0, &legacy).unwrap();
    index::all(&unassigned.0).unwrap();
    let control = control::Control::new(PathBuf::new());
    let before = metrics(&control).await;
    pass(&unassigned.0, at).await.unwrap();
    assert_eq!(
        delta(
            &before,
            &metrics(&control).await,
            "notificationObserver",
            "rowsVisited"
        ),
        0
    );
    index::read_key(&unassigned.0, &legacy.thread_id, &legacy.turn_id).unwrap();
    pass(&unassigned.0, at).await.unwrap();
    assert_eq!(
        binding(&unassigned.0, &legacy.thread_id, &legacy.turn_id)
            .unwrap()
            .unwrap()
            .observation["state"],
        "running"
    );
    let before = metrics(&control).await;
    pass(&unassigned.0, at).await.unwrap();
    assert_eq!(
        delta(
            &before,
            &metrics(&control).await,
            "notificationObserver",
            "rowsVisited"
        ),
        0
    );
}
#[tokio::test]
async fn restart_seed_preserves_pending_delivery_and_latest_interrupted_scope() {
    // Regression: retiring quiet observation must preserve pending delivery clocks and the latest interrupted resume scope across restart.
    let dir = Sandbox::new();
    let mut b = fixture(&dir.0, "interrupted", "cancelled");
    b.created_at -= RETENTION_SECONDS * 2;
    b.continuation_until = i64::MAX;
    b.deliveries.push(Delivery {
        key: "terminal".into(),
        state: "interrupted".into(),
        task_state: "cancelled".into(),
        status: "pending".into(),
        next_attempt_at: 200,
        timing: DeliveryTiming {
            queue_reason: Some("retry-backoff".into()),
            ..Default::default()
        },
        ..Default::default()
    });
    persist(&dir.0, &b).unwrap();
    index::all(&dir.0).unwrap();
    index::schedule_deliveries(&dir.0, &[Arc::new(b.clone())], &json!({}), 100).unwrap();
    assert!(index::delivery_due(&dir.0, 200).unwrap().is_empty());
    assert_eq!(
        index::delivery_due(&dir.0, 201).unwrap()[0].turn_id,
        b.turn_id
    );
    assert!(
        index::observation_due(&dir.0, chrono::Utc::now().timestamp())
            .unwrap()
            .is_empty()
    );
    index::forget(&dir.0);
    let restored = index::delivery_due(&dir.0, 201).unwrap();
    assert_eq!(restored[0].turn_id, b.turn_id);
    let status = governance::status_in(
        &dir.0,
        &b.source_id,
        &json!({"threadId":b.thread_id}),
        201,
        &json!({}),
    )
    .unwrap();
    assert_eq!(status["threads"][0]["turns"][0]["turnId"], b.turn_id);
    assert!(!remove_expired(&dir.0, &b, chrono::Utc::now().timestamp(), false).unwrap());
    b.deliveries.clear();
    persist(&dir.0, &b).unwrap();
    assert!(
        index::observation_due(&dir.0, chrono::Utc::now().timestamp())
            .unwrap()
            .is_empty()
    );
    let mut next = b.clone();
    next.turn_id = "newer".into();
    next.created_at += 1;
    tests::fixture_state(&mut next, "completed");
    persist(&dir.0, &next).unwrap();
    assert!(remove_expired(
        &dir.0,
        &b,
        chrono::Utc::now().timestamp(),
        index::is_superseded(&dir.0, &b).unwrap()
    )
    .unwrap());
    assert_eq!(
        governance::status_in(
            &dir.0,
            &b.source_id,
            &json!({"threadId":b.thread_id}),
            201,
            &json!({})
        )
        .unwrap()["threads"][0]["turns"][0]["turnId"],
        next.turn_id
    );
}
