//! Durable FIFO messages. A reservation is never replayed after uncertain submission.
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
    if !directory().exists() {
        return Ok(vec![]);
    }
    let mut rows = std::fs::read_dir(directory())
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|v| v == "json"))
        .map(|e| load(&e.path()))
        .collect::<Result<Vec<_>>>()?;
    rows.sort_by_key(|r| r["sequence"].as_u64().unwrap_or(0));
    Ok(rows)
}
fn visible(row: &Value) -> bool {
    row["origin"]["ingressId"] == crate::kernel::origin::current_origin()["ingressId"]
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
    ] {
        if !row[key].is_null() {
            out[key] = row[key].clone();
        }
    }
    out["preview"] = json!(string(&row["args"], "prompt")
        .chars()
        .take(120)
        .collect::<String>());
    out
}
pub(crate) async fn enqueue(args: &Value, receipt: &mut Value) -> Result<Value> {
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
        let row = json!({"queueId":id,"threadId":args["threadId"],"args":args,"origin":receipt["origin"],"state":"queued","sequence":sequence,"createdAt":now(),"dispatchRequestId":crate::id()});
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
        visible(r) && matches!(string(r, "state"), "queued" | "blocked" | "dispatching")
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
    let _thread = control.thread_lock(thread).await;
    let _guard = LOCK.lock().await;
    let mut changed = Vec::new();
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
            "resume" => {
                row["allowFailedTurn"] = row["blockedTurn"].clone();
                row["state"] = json!("queued");
                row["reason"] = Value::Null;
            }
            _ => return Err("INVALID_QUEUE_ACTION".into()),
        }
        save(&path(string(&row, "queueId"))?, &row)?;
        changed.push(public(&row));
    }
    Ok(json!({"changed":changed.len(),"items":changed}))
}
async fn tick(control: &Arc<control::Control>, mut row: Value) -> Result<()> {
    // The send path serializes this check with all other ARC writes to this thread.
    let thread = string(&row, "threadId").to_owned();
    if row["state"] != "dispatching" {
        let _thread = control.thread_lock(&thread).await;
        {
            let _guard = LOCK.lock().await;
            row = load(&path(string(&row, "queueId"))?)?;
        }
        if !matches!(string(&row, "state"), "queued" | "blocked") {
            return Ok(());
        }
        let latest = control
            .request(
                "thread/turns/list",
                json!({"threadId":thread,"limit":1,"sortDirection":"desc","itemsView":"notLoaded"}),
                10000,
            )
            .await?;
        let turns = latest["data"].as_array().ok_or("NATIVE_TURNS_MISSING")?;
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
    args["_newTurn"] = json!(true);
    args["_expectedPreviousTurn"] = row["expectedPreviousTurn"].clone();
    let origin = row["origin"].clone();
    let result = crate::kernel::origin::ORIGIN
        .scope(origin, control.mutate("send", args))
        .await?;
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
        "sent"
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
                for row in records()? {
                    if matches!(string(&row, "state"), "queued" | "blocked" | "dispatching")
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
