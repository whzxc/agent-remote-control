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
fn records_in(dir: &Path) -> Result<Vec<Value>> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut rows = file_cache::entries(dir)?
        .iter()
        .filter(|e| e.path.extension().is_some_and(|v| v == "json"))
        .filter_map(|e| {
            let row = load(&e.path).ok()?;
            if !row.is_object()
                || uuid::Uuid::parse_str(string(&row, "queueId")).is_err()
                || string(&row, "threadId").is_empty()
                || !row["args"].is_object()
            {
                return None;
            }
            Some(row)
        })
        .collect::<Vec<_>>();
    rows.sort_by_key(|r| r["sequence"].as_u64().unwrap_or(0));
    Ok(rows)
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
        let sequence = records()?
            .iter()
            .filter_map(|r| r["sequence"].as_u64())
            .max()
            .unwrap_or(0)
            + 1;
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
    for row in records()?.into_iter().filter(|r| {
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
    if crate::app_replace::check_dispatch().is_err() {
        return Ok(());
    }
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
    if matches!(
        state,
        "pending"
            | "reserved"
            | "submitting"
            | "thread-submitting"
            | "thread-created"
            | "turn-submitting"
    ) {
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
}
pub(crate) fn start(control: &Arc<control::Control>) {
    let weak = Arc::downgrade(control);
    let mut shutdown = control.shutdown.subscribe();
    tokio::spawn(async move {
        loop {
            let Some(c) = weak.upgrade() else {
                break;
            };
            let cycle = async {
                let mut threads = std::collections::HashSet::new();
                let mut tasks = tokio::task::JoinSet::new();
                let mut rows = records()?;
                // Reconcile reserved submissions before an older queued row can
                // block their receipt readback behind a running turn.
                rows.sort_by_key(|r| !matches!(string(r, "state"), "steering" | "dispatching"));
                for row in rows {
                    if !string(&row["origin"], "sourceId").is_empty()
                        && matches!(
                            string(&row, "state"),
                            "queued" | "blocked" | "dispatching" | "steering"
                        )
                        && threads.insert(string(&row, "threadId").to_owned())
                    {
                        let c = c.clone();
                        tasks.spawn(async move { tick(&c, row).await });
                    }
                }
                while let Some(result) = tasks.join_next().await {
                    if let Ok(Err(e)) = result {
                        crate::logs::record("WARN", &format!("Queued send: {e}"), None);
                    }
                }
                Ok::<_, String>(())
            };
            tokio::select! {_=shutdown.changed()=>break,r=cycle=>if let Err(e)=r{crate::logs::record("WARN",&format!("Send queue: {e}"),None);}}
            drop(c);
            tokio::select! {_=shutdown.changed()=>break,_=tokio::time::sleep(std::time::Duration::from_secs(1))=>{}}
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
