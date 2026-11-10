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
        target: "session_010000000000000000000001".into(),
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
    assert!(index::delivery_due(&dir.0, 199).unwrap().is_empty());
    assert_eq!(
        index::delivery_due(&dir.0, 200).unwrap()[0].turn_id,
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

fn restart(dir: &Path) {
    index::forget(dir);
    *BINDINGS.lock().unwrap() = file_cache::Cache::default();
    index::initialize(dir).unwrap();
}
#[tokio::test]
async fn persisted_restart_keeps_delivery_resume_and_dormant_reactivation_without_seed_reads() {
    // Regression: D2b reconstructed retained binding payloads at every restart instead of adopting derived scopes and deadlines.
    let control = control::Control::new(PathBuf::new());
    for history in [4, 40] {
        let dir = Sandbox::new();
        for n in 0..history {
            let mut b = fixture(&dir.0, &format!("history-{n}"), "completed");
            b.scope_end = Some("scope-ended".into());
            b.deliveries.push(Delivery {
                key: "terminal".into(),
                state: "completed".into(),
                status: "delivered".into(),
                final_response: json!("x".repeat(8192)),
                ..Default::default()
            });
            persist(&dir.0, &b).unwrap();
        }
        let mut pending = fixture(&dir.0, "resume", "cancelled");
        pending.continuation_until = i64::MAX;
        let mut older = pending.clone();
        older.turn_id = "previous-interrupted".into();
        older.created_at -= 1;
        persist(&dir.0, &older).unwrap();
        pending.deliveries.push(Delivery {
            target: "session_010000000000000000000001".into(),
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
        pending.deliveries[0].final_response = json!("pending-payload");
        persist(&dir.0, &pending).unwrap();
        let mut parked = fixture(&dir.0, "parked", "completed");
        parked.deliveries.push(Delivery {
            key: "terminal".into(),
            state: "completed".into(),
            task_state: "completed".into(),
            status: "pending".into(),
            timing: DeliveryTiming {
                queue_reason: Some("unbound".into()),
                ..Default::default()
            },
            ..Default::default()
        });
        persist(&dir.0, &parked).unwrap();
        let mut dormant = fixture(&dir.0, "dormant", "running");
        for _ in 0..observer::RECONCILIATION_ATTEMPTS {
            dormant.observation = observer::unavailable(&mut dormant, "unavailable");
        }
        persist(&dir.0, &dormant).unwrap();
        let before = metrics(&control).await;
        index::initialize(&dir.0).unwrap();
        let cold = metrics(&control).await;
        index::schedule_deliveries(
            &dir.0,
            &[Arc::new(pending.clone()), Arc::new(parked.clone())],
            &json!({}),
            100,
        )
        .unwrap();
        restart(&dir.0);
        let adopted = metrics(&control).await;
        assert_eq!(delta(&cold, &adopted, "notificationSeed", "bytesParsed"), 0);
        assert_eq!(
            delta(&cold, &adopted, "notificationAdopt", "rowsVisited"),
            history + 4
        );
        assert_eq!(delta(&cold, &adopted, "indexRepair", "rowsVisited"), 0);
        assert!(
            delta(&cold, &adopted, "notificationAdopt", "bytesParsed")
                < delta(&before, &cold, "notificationSeed", "bytesParsed")
        );
        let recovering = cost::sync(Owner::NotificationObserver, Reason::Startup, || {
            index::restart_due(&dir.0)
        })
        .unwrap();
        assert_eq!(recovering.len(), 2);
        assert!(recovering
            .iter()
            .any(|(b, _, _)| b.turn_id == pending.turn_id));
        assert!(recovering
            .iter()
            .any(|(b, _, _)| b.turn_id == parked.turn_id));
        assert_eq!(index::next_delivery(&dir.0).unwrap(), Some(200));
        assert!(index::delivery_due(&dir.0, 199).unwrap().is_empty());
        let due = index::delivery_due(&dir.0, 200).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].turn_id, pending.turn_id);
        assert_eq!(
            due[0].deliveries[0].final_response,
            json!("pending-payload")
        );
        assert!(
            index::observation_due(&dir.0, chrono::Utc::now().timestamp() + 10)
                .unwrap()
                .is_empty()
        );
        let status = governance::status_in(
            &dir.0,
            &pending.source_id,
            &json!({"threadId":pending.thread_id,"all":false}),
            201,
            &json!({}),
        )
        .unwrap();
        assert_eq!(status["threads"][0]["turns"][0]["turnId"], pending.turn_id);
        index::read_key(&dir.0, &dormant.thread_id, &dormant.turn_id).unwrap();
        let due = index::observation_due(&dir.0, chrono::Utc::now().timestamp() + 10).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].0.turn_id, dormant.turn_id);
        println!("notification restart history={history} rebuildBytes={} adoptBytes={} seedBytes=0 pending=1 parked=1 dormantWake=1",delta(&before,&cold,"notificationSeed","bytesParsed"),delta(&cold,&adopted,"notificationAdopt","bytesParsed"));
    }
}
#[tokio::test]
async fn interrupted_binding_write_repairs_one_key_and_invalid_indexes_rebuild_once() {
    // Regression: a canonical binding written before an interrupted derived update must be repaired before restart observation.
    let dir = Sandbox::new();
    let control = control::Control::new(PathBuf::new());
    for n in 0..40 {
        fixture(&dir.0, &format!("history-{n}"), "completed");
    }
    let mut active = fixture(&dir.0, "active", "running");
    index::initialize(&dir.0).unwrap();
    tests::fixture_state(&mut active, "completed");
    active.scope_end = Some("scope-ended".into());
    crate::kernel::derived_index::interrupt(
        &path_in(&dir.0, &active.thread_id, &active.turn_id),
        &serde_json::to_vec(&active).unwrap(),
    )
    .unwrap();
    let before = metrics(&control).await;
    restart(&dir.0);
    let repaired = metrics(&control).await;
    assert_eq!(delta(&before, &repaired, "indexRepair", "rowsVisited"), 1);
    assert_eq!(
        delta(&before, &repaired, "notificationSeed", "bytesParsed"),
        0
    );
    assert!(
        index::observation_due(&dir.0, chrono::Utc::now().timestamp() + 10)
            .unwrap()
            .is_empty()
    );
    restart(&dir.0);
    assert_eq!(
        delta(
            &repaired,
            &metrics(&control).await,
            "indexRepair",
            "rowsVisited"
        ),
        0
    );
    for mode in ["missing", "corrupt", "version"] {
        crate::kernel::derived_index::damage(&dir.0.join("tasks"), mode);
        let before = metrics(&control).await;
        restart(&dir.0);
        let rebuilt = metrics(&control).await;
        assert_eq!(
            delta(&before, &rebuilt, "notificationSeed", "rowsVisited"),
            41
        );
        restart(&dir.0);
        assert_eq!(
            delta(
                &rebuilt,
                &metrics(&control).await,
                "notificationSeed",
                "rowsVisited"
            ),
            0
        );
        assert!(
            index::observation_due(&dir.0, chrono::Utc::now().timestamp() + 10)
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn adopted_and_rebuilt_partitions_agree_for_mixed_canonical_states() {
    // Property: adopting unchanged canonical metadata preserves every activity/deadline partition after the same scheduling inputs.
    let dir = Sandbox::new();
    for n in 0..24 {
        let state = ["completed", "cancelled", "running", "unconfirmed"][n % 4];
        let mut b = fixture(&dir.0, &format!("mixed-{n}"), state);
        b.thread_id = format!("scope-{}", n / 4);
        b.created_at = 100 + n as i64;
        if n % 3 == 0 {
            b.scope_end = Some("scope-ended".into());
        }
        if n % 5 == 0 {
            b.observation["reconciliation"] = json!("unavailable-after-restart");
        }
        if n % 7 == 0 {
            b.source_id.clear();
        }
        if n % 2 == 1 {
            b.deliveries.push(Delivery {
                key: "terminal".into(),
                state: state.into(),
                task_state: state.into(),
                status: "pending".into(),
                target: if n % 3 == 1 {
                    "target".into()
                } else {
                    String::new()
                },
                ..Default::default()
            });
        }
        persist(&dir.0, &b).unwrap();
    }
    let snapshot = || {
        index::initialize(&dir.0).unwrap();
        let pending = index::all(&dir.0).unwrap();
        index::schedule_deliveries(&dir.0, &pending, &json!({}), 100).unwrap();
        index::partitions(&dir.0).unwrap()
    };
    let rebuilt = snapshot();
    index::forget(&dir.0);
    let adopted = snapshot();
    assert_eq!(adopted, rebuilt);
    crate::kernel::derived_index::damage(&dir.0.join("tasks"), "missing");
    index::forget(&dir.0);
    assert_eq!(snapshot(), adopted);
}

#[tokio::test]
async fn observation_timestamp_and_owned_writes_do_not_reenter_the_owner() {
    // Regression: reconciliation writes woke notification delivery through its recursive index-directory watch about 108 times in 31 seconds.
    let dir = Sandbox::new();
    let mut b = fixture(&dir.0, "owned", "running");
    index::initialize(&dir.0).unwrap();
    let wake = index::file_wake(&dir.0).unwrap();
    let path = path_in(&dir.0, &b.thread_id, &b.turn_id);
    while tokio::time::timeout(Duration::from_millis(1), wake.notified())
        .await
        .is_ok()
    {}
    while tokio::time::timeout(Duration::from_millis(1), index::WAKE.notified())
        .await
        .is_ok()
    {}
    while tokio::time::timeout(Duration::from_millis(1), index::DELIVERY_WAKE.notified())
        .await
        .is_ok()
    {}
    let before = file_cache::Stamp::read(&path).unwrap();
    b.observation["observedAt"] = json!("later");
    cost::sync(Owner::NotificationObserver, Reason::Deadline, || {
        persist(&dir.0, &b)
    })
    .unwrap();
    assert_eq!(file_cache::Stamp::read(&path).unwrap(), before);
    b.observation["reconciliation"] = json!("unavailable-after-restart");
    cost::sync(Owner::NotificationObserver, Reason::Deadline, || {
        persist(&dir.0, &b)
    })
    .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), wake.notified())
            .await
            .is_err()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(10), index::WAKE.notified())
            .await
            .is_err()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(10), index::DELIVERY_WAKE.notified())
            .await
            .is_err()
    );
    assert!(
        index::observation_due(&dir.0, chrono::Utc::now().timestamp() + 10)
            .unwrap()
            .is_empty()
    );
    b.observation["reconciliation"] = json!("pending-after-restart");
    std::fs::write(&path, serde_json::to_vec(&b).unwrap()).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(1), wake.notified())
            .await
            .is_ok()
    );
    assert_eq!(
        index::observation_due(&dir.0, chrono::Utc::now().timestamp() + 10)
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scale_rebuild_is_batched_and_never_gates_lease_or_query_readiness() {
    // Regression: 1076 notification records took 40 seconds to migrate before readiness and exceeded the supervisor's 30-second timeout.
    let dir = Sandbox::new();
    let root_receipts = dir.0.join("root");
    std::fs::create_dir_all(&root_receipts).unwrap();
    let receipts = crate::kernel::receipts::ReceiptStore::fixture(root_receipts.clone());
    let receipt = json!({"requestId":uuid::Uuid::nil().to_string(),"state":"completed","backendSession":"fixture","result":{"payload":"x".repeat(6000)}});
    for _ in 0..9000 {
        let mut row = receipt.clone();
        row["requestId"] = json!(id());
        std::fs::write(
            root_receipts.join(format!("{}.json", string(&row, "requestId"))),
            row.to_string(),
        )
        .unwrap();
    }
    std::fs::create_dir_all(dir.0.join("tasks")).unwrap();
    for n in 0..1100 {
        let mut b: Binding = serde_json::from_value(json!({"threadId":format!("scale-{n}"),"turnId":"turn","sourceId":"fixture-source","target":null,"project":"fixture","createdAt":100,"waiting":[],"deliveries":[],"observation":{"state":"completed","recordedStatus":"completed","reconciliation":"reconciled"}})).unwrap();
        tests::fixture_state(&mut b, "completed");
        b.scope_end = Some("scope-ended".into());
        std::fs::write(
            path_in(&dir.0, &b.thread_id, &b.turn_id),
            serde_json::to_vec(&b).unwrap(),
        )
        .unwrap();
    }
    let (release, blocked) = std::sync::mpsc::channel();
    let work_dir = dir.0.clone();
    let job = crate::kernel::derived_index::background(
        vec![root_receipts.clone(), dir.0.join("tasks")],
        move || {
            blocked.recv().unwrap();
            let start = std::time::Instant::now();
            receipts.seed()?;
            index::initialize(&work_dir)?;
            let elapsed = start.elapsed();
            println!("scale migration: 9000 root receipts + 1100 bindings in {elapsed:?}");
            assert!(
                elapsed < Duration::from_secs(12),
                "migration exceeded fixture bound: {elapsed:?}"
            );
            Ok(())
        },
    );
    let start = std::time::Instant::now();
    let leases = crate::runtime::State::default();
    leases
        .request(
            "runtime/lease",
            json!({"id":id(),"kind":"desktop","pid":std::process::id()}),
        )
        .unwrap();
    assert_eq!(leases.clients().as_array().unwrap().len(), 1);
    let guide = crate::egress::guide(&json!({}), &json!({}), "en", &[]);
    assert!(!guide.is_null());
    let control = control::Control::new(PathBuf::new());
    assert!(control.tool("runtime_metrics", json!({})).await.is_ok());
    let pending = index::initialize(&dir.0);
    assert!(pending.unwrap_err().starts_with("INDEX_NOT_READY"));
    let ready_time = start.elapsed();
    release.send(()).unwrap();
    job.await.unwrap().unwrap();
    assert!(ready_time < Duration::from_secs(1));
    println!("lease/guide/query readiness while rebuild blocked: {ready_time:?}");
    assert_eq!(index::partitions(&dir.0).unwrap()["rows"], 1100);
}

#[test]
fn recovery_partition_changes_require_new_canonical_evidence() {
    // Regression: installed restart counters changed during reconciliation and must distinguish owner transitions from index adoption drift.
    let dir = Sandbox::new();
    let mut interrupted = fixture(&dir.0, "latest", "cancelled");
    let mut exhausted = fixture(&dir.0, "reconciling", "unconfirmed");
    exhausted.observation["reconciliationAttempts"] = json!(2);
    exhausted.observation["reconciliation"] = json!("pending-after-restart");
    persist(&dir.0, &exhausted).unwrap();
    index::initialize(&dir.0).unwrap();
    let before = index::partitions(&dir.0).unwrap();
    restart(&dir.0);
    assert_eq!(index::partitions(&dir.0).unwrap(), before);
    exhausted.observation = observer::unavailable(&mut exhausted, "unavailable");
    persist(&dir.0, &exhausted).unwrap();
    interrupted.scope_end = Some("scope-ended".into());
    persist(&dir.0, &interrupted).unwrap();
    let after = index::partitions(&dir.0).unwrap();
    assert_eq!(
        after["exhausted"].as_array().unwrap().len(),
        before["exhausted"].as_array().unwrap().len() + 1
    );
    assert_eq!(
        after["resumable"].as_array().unwrap().len() + 1,
        before["resumable"].as_array().unwrap().len()
    );
    restart(&dir.0);
    assert_eq!(index::partitions(&dir.0).unwrap(), after);
}
