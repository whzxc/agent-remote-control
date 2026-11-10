//! Durable FIFO messages. A reservation is never replayed after uncertain submission.
use crate::kernel::file_cache::{self, load};
use crate::*;
static LOCK: Mutex<()> = Mutex::const_new(());
fn directory() -> PathBuf {
    root().join("send-queue")
}
fn path(id: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(id).map_err(|_| "INVALID_QUEUE_ID")?;
    Ok(directory().join(format!("{id}.json")))
}
fn records() -> Result<Vec<Value>> {
    records_in(&directory())
}
#[derive(Default)]
struct Queues(std::collections::HashMap<PathBuf, Queue>);
struct Queue {
    files: file_cache::Collection<Value>,
    active: std::collections::BTreeMap<(u64, PathBuf), Arc<Value>>,
    ordered: std::collections::BTreeMap<(u64, PathBuf), Arc<Value>>,
    sequences: std::collections::HashMap<PathBuf, u64>,
}
static QUEUES: std::sync::LazyLock<std::sync::Mutex<Queues>> =
    std::sync::LazyLock::new(Default::default);
fn runnable(row: &Value) -> bool {
    matches!(
        string(row, "state"),
        "queued" | "blocked" | "dispatching" | "steering"
    )
}
fn with_queue<T>(dir: &Path, f: impl FnOnce(&Queue) -> T) -> Result<T> {
    use crate::runtime_metrics::cost::{self, Owner, Reason};
    if cost::current() != Some(Owner::DispatchQueue) {
        return cost::sync(Owner::DispatchQueue, Reason::Poll, || {
            with_queue_inner(dir, f)
        });
    }
    with_queue_inner(dir, f)
}
fn with_queue_inner<T>(dir: &Path, f: impl FnOnce(&Queue) -> T) -> Result<T> {
    let mut queues = QUEUES.lock().map_err(|e| e.to_string())?;
    let queue = queues.0.entry(dir.into()).or_insert_with(|| Queue {
        files: file_cache::Collection::new(dir),
        active: Default::default(),
        ordered: Default::default(),
        sequences: Default::default(),
    });
    for path in queue.files.refresh(|path| {
        file_cache::shared_load(path).or_else(|error| {
            if error.starts_with("INVALID_JSON:") {
                Ok(Arc::new(Value::Null))
            } else {
                Err(error)
            }
        })
    })? {
        if let Some(sequence) = queue.sequences.remove(&path) {
            queue.active.remove(&(sequence, path.clone()));
            queue.ordered.remove(&(sequence, path.clone()));
        }
        if let Some(row) = queue.files.rows.get(&path).filter(|row| valid(row)) {
            let sequence = row["sequence"].as_u64().unwrap_or(0);
            queue.sequences.insert(path.clone(), sequence);
            queue.ordered.insert((sequence, path.clone()), row.clone());
            if runnable(row) {
                queue.active.insert((sequence, path), row.clone());
            }
        }
    }
    Ok(f(queue))
}
fn valid(row: &Value) -> bool {
    row.is_object()
        && uuid::Uuid::parse_str(string(row, "queueId")).is_ok()
        && !string(row, "threadId").is_empty()
        && row["args"].is_object()
}
fn records_in(dir: &Path) -> Result<Vec<Value>> {
    with_queue(dir, |queue| {
        queue.ordered.values().map(|row| (**row).clone()).collect()
    })
}
fn scheduled() -> Result<(Vec<Value>, Arc<tokio::sync::Notify>, bool)> {
    with_queue(&directory(), |queue| {
        crate::runtime_metrics::cost::rows(queue.active.len());
        (
            queue
                .active
                .values()
                .filter(|r| !string(&r["origin"], "sourceId").is_empty())
                .map(|r| (**r).clone())
                .collect(),
            queue.files.wake(),
            queue.files.repair_needed,
        )
    })
}
fn visible(row: &Value) -> bool {
    visible_to(row, &crate::kernel::origin::current_origin())
}
pub(crate) fn visible_to(row: &Value, origin: &Value) -> bool {
    // Local authenticated administration can recover orphaned records. Remote
    // sources retain the existing own-source boundary, including for promotion.
    origin["authType"] == "local"
        || (!string(&row["origin"], "sourceId").is_empty()
            && row["origin"]["sourceId"] == origin["sourceId"])
}
fn public(row: &Value) -> Value {
    let mut out = json!({});
    for key in [
        "queueId",
        "threadId",
        "state",
        "createdAt",
        "turnId",
        "dispatchRequestId",
        "reason",
        "error",
        "origin",
    ] {
        if !row[key].is_null() {
            out[key] = row[key].clone();
        }
    }
    out["text"] = row["args"]["prompt"].clone();
    out["preview"] = json!(string(&row["args"], "prompt")
        .chars()
        .take(120)
        .collect::<String>());
    out
}
pub(crate) async fn enqueue(args: &Value, receipt: &mut Value) -> Result<Value> {
    if string(&receipt["origin"], "sourceId").is_empty() {
        return Err(
            "SOURCE_REQUIRED: enqueue through an authenticated control source or tasks.control"
                .into(),
        );
    }
    let _guard = LOCK.lock().await;
    let id = string(receipt, "requestId");
    let target = path(id)?;
    let row = if target.exists() {
        load(&target)?
    } else {
        let sequence = with_queue(&directory(), |queue| {
            queue
                .ordered
                .last_key_value()
                .map_or(0, |((sequence, _), _)| *sequence)
        })? + 1;
        let mut row = json!({"queueId":id,"threadId":args["threadId"],"args":args,"origin":receipt["origin"],"state":"queued","sequence":sequence,"createdAt":now(),"dispatchRequestId":crate::id()});
        if let Some(caller) = crate::dispatch_caller::validated(&receipt["caller"]) {
            row["caller"] = caller;
        }
        save(&target, &row)?;
        row
    };
    receipt["threadId"] = args["threadId"].clone();
    receipt["queueId"] = row["queueId"].clone();
    receipt["dispatchMode"] = json!("queued");
    Ok(json!({"accepted":true,"queueId":row["queueId"],"status":row["state"]}))
}
pub(crate) async fn counts() -> Result<std::collections::HashMap<String, Value>> {
    let _guard = LOCK.lock().await;
    let mut counts = std::collections::HashMap::new();
    for row in with_queue(&directory(), |q| {
        q.active.values().map(|r| (**r).clone()).collect::<Vec<_>>()
    })?
    .into_iter()
    .filter(|r| {
        visible(r)
            && matches!(
                string(r, "state"),
                "queued" | "blocked" | "dispatching" | "steering"
            )
    }) {
        let entry = counts
            .entry(string(&row, "threadId").to_owned())
            .or_insert(json!({"pending":0,"blocked":0}));
        entry["pending"] = json!(entry["pending"].as_u64().unwrap() + 1);
        if row["state"] == "blocked" {
            entry["blocked"] = json!(entry["blocked"].as_u64().unwrap() + 1);
        }
    }
    Ok(counts)
}
pub(crate) async fn query(args: &Value) -> Result<Value> {
    let _guard = LOCK.lock().await;
    let rows = records()?
        .into_iter()
        .filter(|r| {
            visible(r)
                && (args["threadId"].is_null() || args["threadId"] == r["threadId"])
                && (args["queueId"].is_null() || args["queueId"] == r["queueId"])
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"items":rows.iter().rev().take(100).map(public).collect::<Vec<_>>(),"total":rows.len(),"order":"FIFO per thread; display newest first"}),
    )
}
pub(crate) async fn control(control: &Arc<control::Control>, args: &Value) -> Result<Value> {
    let thread = string(args, "threadId");
    if args["action"] == "promote" && !args["queueId"].is_string() {
        return Err("QUEUE_ID_REQUIRED: promote requires one queueId".into());
    }
    let thread_guard = control.thread_lock(thread).await;
    let guard = LOCK.lock().await;
    let mut changed = Vec::new();
    let mut promoted = None;
    for mut row in records()?.into_iter().filter(|r| {
        visible(r)
            && r["threadId"] == thread
            && (args["queueId"].is_null() || args["queueId"] == r["queueId"])
    }) {
        if !matches!(string(&row, "state"), "queued" | "blocked") {
            continue;
        }
        match string(args, "action") {
            "cancel" => row["state"] = json!("cancelled"),
            "resume" | "promote" => {
                if string(&row["origin"], "sourceId").is_empty() {
                    return Err("QUEUE_SOURCE_MISSING: cancel this orphan through local codex_queue_control; submit a new message explicitly".into());
                }
                if args["action"] == "promote" {
                    let latest = control.dispatch_state(thread).await?;
                    let turn = &latest["turns"][0];
                    if turn["status"] != "inProgress" {
                        return Err("NO_ACTIVE_TURN: keep the message queued or resume it after an interrupted turn".into());
                    }
                    control.check_steer(thread, &turn["id"]).await?;
                    row["expectedActiveTurn"] = turn["id"].clone();
                    row["state"] = json!("steering");
                    promoted = Some(row.clone());
                } else {
                    row["allowFailedTurn"] = row["blockedTurn"].clone();
                    row["state"] = json!("queued");
                }
                row["reason"] = Value::Null;
            }
            _ => return Err("INVALID_QUEUE_ACTION".into()),
        }
        save(&path(string(&row, "queueId"))?, &row)?;
        changed.push(public(&row));
    }
    drop(guard);
    drop(thread_guard);
    if let Some(row) = promoted {
        tick(control, row.clone()).await?;
        changed = vec![public(&load(&path(string(&row, "queueId"))?)?)];
    }
    Ok(
        json!({"changed":changed.iter().filter(|r| match string(args,"action") { "cancel" => r["state"] == "cancelled", "resume" => r["state"] == "queued", _ => matches!(string(r,"state"),"steering"|"steered") }).count(),"items":changed}),
    )
}
async fn tick(control: &Arc<control::Control>, mut row: Value) -> Result<()> {
    crate::runtime_metrics::cost::scope(
        crate::runtime_metrics::cost::Owner::DispatchQueue,
        crate::runtime_metrics::cost::Reason::Poll,
        async {
            if string(&row["origin"], "sourceId").is_empty() {
                return Ok(()); // Orphans remain visible for explicit local cancellation.
            }
            // The send path serializes this check with all other ARC writes to this thread.
            let thread = string(&row, "threadId").to_owned();
            if row["state"] != "dispatching" && row["state"] != "steering" {
                let _thread = control.thread_lock(&thread).await;
                {
                    let _guard = LOCK.lock().await;
                    row = load(&path(string(&row, "queueId"))?)?;
                }
                if !matches!(string(&row, "state"), "queued" | "blocked") {
                    return Ok(());
                }
                let latest = control.dispatch_state(&thread).await?;
                let turns = latest["turns"].as_array().ok_or("NATIVE_TURNS_MISSING")?;
                let turn = turns.first().unwrap_or(&Value::Null);
                let waiting_input = control
                    .events
                    .lock()
                    .await
                    .pending
                    .values()
                    .any(|r| r["params"]["threadId"] == thread);
                let _guard = LOCK.lock().await;
                if waiting_input
                    || turn["status"] == "inProgress"
                    || crate::claude_notify::retry_pending(&thread, string(turn, "id"))?
                {
                    row["state"] = json!("queued");
                    row["reason"] = json!(if waiting_input {
                        "waiting-input"
                    } else if turn["status"] == "inProgress" {
                        "active-turn"
                    } else {
                        "automatic-retry"
                    });
                    save(&path(string(&row, "queueId"))?, &row)?;
                    return Ok(());
                }
                if matches!(
                    string(turn, "status"),
                    "failed" | "interrupted" | "cancelled"
                ) && row["allowFailedTurn"] != turn["id"]
                {
                    row["state"] = json!("blocked");
                    row["blockedTurn"] = turn["id"].clone();
                    row["reason"] = json!("previous-turn-failed-or-interrupted");
                    save(&path(string(&row, "queueId"))?, &row)?;
                    return Ok(());
                }
                if !turn.is_null()
                    && !matches!(
                        string(turn, "status"),
                        "completed" | "failed" | "interrupted" | "cancelled"
                    )
                {
                    return Ok(());
                }
                row["state"] = json!("dispatching");
                row["expectedPreviousTurn"] = turn["id"].clone();
                save(&path(string(&row, "queueId"))?, &row)?;
            }
            let mut args = row["args"].clone();
            args.as_object_mut().unwrap().remove("sendMode");
            args["requestId"] = row["dispatchRequestId"].clone();
            args["waitMs"] = json!(0);
            args["approval"] = json!("approved");
            let steering = row["state"] == "steering";
            if steering {
                args["sendMode"] = json!("steer");
                args["_expectedActiveTurn"] = row["expectedActiveTurn"].clone();
            } else {
                args["_newTurn"] = json!(true);
                args["_expectedPreviousTurn"] = row["expectedPreviousTurn"].clone();
            }
            let origin = row["origin"].clone();
            let result = match crate::kernel::origin::ORIGIN
                .scope(
                    origin,
                    crate::dispatch_caller::CALLER.scope(
                        crate::dispatch_caller::validated(&row["caller"]),
                        control.mutate("send", args),
                    ),
                )
                .await
            {
                Ok(result) => result,
                Err(error) => {
                    let _guard = LOCK.lock().await;
                    row["state"] = json!(crate::kernel::receipts::failure_state(&error));
                    row["error"] = crate::egress::failure(&error);
                    return save(&path(string(&row, "queueId"))?, &row);
                }
            };
            let state = string(&result, "state");
            if crate::kernel::receipts::progress::Progress::read(state, true).active() {
                return Ok(());
            }
            let _guard = LOCK.lock().await;
            row["state"] = json!(if state == "completed" {
                if steering {
                    "steered"
                } else {
                    "sent"
                }
            } else if state == "unconfirmed" {
                "unconfirmed"
            } else {
                "failed"
            });
            row["turnId"] = result["turnId"].clone();
            row["error"] = result["result"]["error"].clone();
            row["reason"] = json!(state);
            save(&path(string(&row, "queueId"))?, &row)
        },
    )
    .await
}
pub(crate) fn start(control: &Arc<control::Control>) {
    let weak = Arc::downgrade(control);
    let mut shutdown = control.shutdown.subscribe();
    tokio::spawn(async move {
        let mut reason = crate::runtime_metrics::cost::Reason::Startup;
        let mut queue_wake = None;
        let mut active = false;
        loop {
            let Some(c) = weak.upgrade() else {
                break;
            };
            let cycle = crate::runtime_metrics::cost::scope(
                crate::runtime_metrics::cost::Owner::DispatchQueue,
                reason,
                async {
                    let mut threads = std::collections::HashSet::new();
                    let mut tasks = tokio::task::JoinSet::new();
                    let (mut rows, wake, repair) = scheduled()?;
                    queue_wake = Some(wake);
                    active = !rows.is_empty() || repair;
                    // Reconcile reserved submissions before an older queued row can
                    // block their receipt readback behind a running turn.
                    rows.sort_by_key(|r| !matches!(string(r, "state"), "steering" | "dispatching"));
                    for row in rows {
                        crate::runtime_metrics::cost::rows(1);
                        if !string(&row["origin"], "sourceId").is_empty()
                            && matches!(
                                string(&row, "state"),
                                "queued" | "blocked" | "dispatching" | "steering"
                            )
                            && threads.insert(string(&row, "threadId").to_owned())
                        {
                            let c = c.clone();
                            tasks.spawn(crate::runtime_metrics::cost::inherit(async move {
                                tick(&c, row).await
                            }));
                        }
                    }
                    while let Some(result) = tasks.join_next().await {
                        if let Ok(Err(e)) = result {
                            crate::logs::record("WARN", &format!("Queued send: {e}"), None);
                        }
                    }
                    Ok::<_, String>(())
                },
            );
            tokio::select! {_=shutdown.changed()=>break,r=cycle=>if let Err(e)=r{crate::logs::record("WARN",&format!("Send queue: {e}"),None);}}
            drop(c);
            let wake = queue_wake.clone();
            tokio::select! {
                _=shutdown.changed()=>break,
                _=async { match wake { Some(wake) => wake.notified().await, None => std::future::pending().await } }=>reason = crate::runtime_metrics::cost::Reason::Dirty,
                _=async { if active || queue_wake.is_none() { tokio::time::sleep(std::time::Duration::from_secs(1)).await } else { std::future::pending().await } }=>reason = crate::runtime_metrics::cost::Reason::Deadline,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queue_poll_reuses_history_and_reads_only_the_changed_message() {
        // Regression: the one-second send queue poll reread completed messages indefinitely.
        struct Sandbox(PathBuf);
        impl Drop for Sandbox {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let dir = Sandbox(std::env::temp_dir().join(format!("arc-queue-cache-{}", id())));
        for n in 0..24 {
            save(&dir.0.join(format!("{n}.json")), &json!({"queueId":id(),"threadId":"thread","args":{},"state":"completed","sequence":n})).unwrap();
        }
        assert_eq!(records_in(&dir.0).unwrap().len(), 24);
        let warm = file_cache::thread_io();
        for _ in 0..3 {
            assert_eq!(records_in(&dir.0).unwrap().len(), 24);
        }
        assert_eq!(file_cache::thread_io(), warm);
        save(
            &dir.0.join("0.json"),
            &json!({"queueId":id(),"threadId":"thread","args":{},"state":"queued","sequence":0}),
        )
        .unwrap();
        let records = records_in(&dir.0).unwrap();
        assert_eq!(records[0]["state"], "queued");
        assert_eq!(file_cache::thread_io().file_opens - warm.file_opens, 1);
        assert_eq!(
            file_cache::thread_io().directory_reads,
            warm.directory_reads
        );
    }

    #[test]
    fn orphaned_panel_records_remain_cancellable_only_locally() {
        // Regression: missing sourceId filtered a queued panel record out of every cancel path.
        let orphan =
            json!({"origin":{"controlSource":"ARC","ingressId":"local-ui"},"state":"queued"});
        assert!(visible_to(
            &orphan,
            &json!({"authType":"local","sourceId":"local"})
        ));
        assert!(!visible_to(&orphan, &json!({"sourceId":"remote"})));
        assert!(!visible_to(&orphan, &Value::Null));
        let owned = json!({"origin":{"sourceId":"a"}});
        assert!(visible_to(&owned, &json!({"sourceId":"a"})));
        assert!(!visible_to(&owned, &json!({"sourceId":"b"})));
    }
}

#[cfg(test)]
pub(crate) fn scale_poll() -> Result<()> {
    let rows = records()?;
    assert_eq!(rows.len(), 44);
    Ok(())
}

#[cfg(test)]
mod projection_tests {
    use super::*;
    #[test]
    fn dormant_queue_reactivation_removal_and_rebuild_preserve_fifo_history() {
        // Regression: unchanged queue ticks traversed all completed rows and dormant rows needed discovery after reactivation.
        let dir = std::env::temp_dir().join(format!("arc-queue-projection-{}", id()));
        for n in 0..44 {
            save(&dir.join(format!("{n}.json")), &json!({"queueId":id(),"threadId":"fixture","args":{},"state":"completed","sequence":n,"origin":{"sourceId":"fixture"}})).unwrap();
        }
        assert_eq!(records_in(&dir).unwrap().len(), 44);
        let warm = file_cache::thread_io();
        assert!(with_queue(&dir, |q| q.active.is_empty()).unwrap());
        assert_eq!(file_cache::thread_io(), warm);
        let mut row = load(&dir.join("0.json")).unwrap();
        row["state"] = json!("queued");
        save(&dir.join("0.json"), &row).unwrap();
        let selected = with_queue(&dir, |q| {
            q.active.values().map(|r| (**r).clone()).collect::<Vec<_>>()
        })
        .unwrap();
        assert_eq!(selected, vec![row]);
        let before = file_cache::Stamp::read(&dir).unwrap();
        std::fs::remove_file(dir.join("1.json")).unwrap();
        file_cache::changed(&dir.join("1.json"), before);
        assert_eq!(records_in(&dir).unwrap().len(), 43);
        QUEUES.lock().unwrap().0.remove(&dir);
        let rebuilt = records_in(&dir).unwrap();
        assert_eq!(rebuilt.len(), 43);
        assert_eq!(rebuilt[0]["state"], "queued");
        assert!(rebuilt
            .windows(2)
            .all(|pair| pair[0]["sequence"].as_u64() < pair[1]["sequence"].as_u64()));
        QUEUES.lock().unwrap().0.remove(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
