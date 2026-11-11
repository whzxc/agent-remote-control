//! Device-qualified bindings share the local notification owner and delivery scheduler.
use super::*;

pub(crate) fn key(device: &str, task: &str) -> String {
    format!("device:{device}:{task}")
}
pub(crate) fn has_binding(device: &str, task: &str, turn: &str) -> Result<bool> {
    Ok(binding(&directory(), &key(device, task), turn)?.is_some())
}
fn native_id(b: &Binding) -> &str {
    b.device["taskId"].as_str().unwrap_or(&b.thread_id)
}
fn identity(value: &Value) -> Option<(&str, &str)> {
    let task = value["threadId"]
        .as_str()
        .or_else(|| value["taskId"].as_str())
        .or_else(|| value["thread"]["id"].as_str())
        .or_else(|| value["task"]["id"].as_str());
    let turn = value["turnId"]
        .as_str()
        .or_else(|| value["turn"]["id"].as_str());
    task.zip(turn)
}
fn result_identity(value: &Value, depth: usize) -> Option<(&str, &str)> {
    if depth > 5 {
        return None;
    }
    identity(value).or_else(|| {
        ["result", "receipt"]
            .into_iter()
            .find_map(|k| result_identity(&value[k], depth + 1))
    })
}
pub(crate) async fn bind_forward(
    device: &str,
    name: &str,
    source: &str,
    op: &str,
    args: &Value,
    result: &Value,
) -> Result<bool> {
    let Some((task, turn)) = result_identity(result, 0) else {
        return Ok(false);
    };
    let thread = key(device, task);
    let mut args = args.clone();
    if !args["agent"].is_string() {
        args.as_object_mut().unwrap().remove("agent");
    }
    args["_device"] = json!({"id":device,"name":name,"taskId":task});
    let origin = json!({"sourceId":source});
    crate::kernel::origin::ORIGIN
        .scope(origin, async {
            bind(
                &args,
                &thread,
                turn,
                "",
                json!({"op":op,"requestId":result["requestId"],"at":now()}),
            )
            .await?;
            if op == "codex_resume" {
                inherit(&thread, string(&args, "previousTurnId"), turn).await?;
            }
            Ok(true)
        })
        .await
}
pub(super) fn read_request(b: &Binding) -> Value {
    let agent = !b.agent.is_empty() && b.agent != "codex";
    json!({"taskId":native_id(b),"turnId":b.turn_id,"sourceId":b.source_id,
        "op":if agent {"agent_read"}else{"codex_read"},
        "args":if agent {json!({"agent":b.agent,"taskId":native_id(b),"view":"summary"})}
        else {json!({"threadId":native_id(b),"turnId":b.turn_id,"statusOnly":true})}})
}
pub(crate) fn open(device: &str) -> Result<Vec<Value>> {
    index::device_open(&directory(), device)
}
pub(crate) async fn unconfirmed(device: &str, only: Option<&Value>) -> Result<()> {
    let bindings = match only {
        Some(row) => vec![row.clone()],
        None => open(device)?,
    };
    let _guard = LOCK.lock().await;
    for row in bindings {
        if let Some(mut b) = binding(
            &directory(),
            &key(device, string(&row, "taskId")),
            string(&row, "turnId"),
        )? {
            if b.terminal() {
                continue;
            }
            lifecycle::loss(&mut b);
            b.observation = json!({"state":"unconfirmed","reason":"member-unavailable","reconciliation":"pending-after-restart"});
            persist(&directory(), &b)?;
        }
    }
    Ok(())
}
fn observed_event(event: &Value, thread: &str) -> Value {
    let kind = string(event, "kind");
    let state = match kind {
        "completed" => "completed",
        "failed" => "failed",
        "interrupted" => "cancelled",
        "needs-input" => "interaction-required",
        _ => "running",
    };
    json!({"threadId":thread,"turnId":event["turnId"],"agent":event["agent"],"state":state,
        "recordedStatus":match kind {"completed"=>"completed","failed"=>"failed","interrupted"=>"interrupted",_=>"inProgress"},
        "title":event["title"],"finalResponse":event["finalResponse"],"error":event["error"],
        "interaction":if event["interaction"].is_object(){json!([event["interaction"]])}else{json!([])},
        "activeFlags":if kind=="needs-input" && !event["interaction"].is_object(){json!([if event["state"]=="waiting for approval"{"waitingOnApproval"}else{"waitingOnUserInput"}])}else{json!([])},
        "progressStalled":kind=="stalled","progress":event["progress"],
        "handoffs":if kind=="handoff"{json!([event["ownership"]])}else{Value::Null},"dispatches":[]})
}
pub(crate) async fn receive(device: &str, source: &str, event: &Value) -> Result<()> {
    receive_in(&directory(), &LOCK, device, source, event).await
}
async fn receive_in(
    dir: &Path,
    lock: &Mutex<()>,
    device: &str,
    source: &str,
    event: &Value,
) -> Result<()> {
    let Some((task, turn)) = identity(event) else {
        return Ok(());
    };
    let thread = key(device, task);
    let Some(mut b) = binding(dir, &thread, turn)?.filter(|b| b.source_id == source) else {
        return Ok(());
    };
    let mut observed = observed_event(event, &thread);
    // A null handoffs field would bypass normal lifecycle processing.
    if event["kind"] != "handoff" {
        observed.as_object_mut().unwrap().remove("handoffs");
    }
    if event["kind"] == "recovered" {
        let _guard = lock.lock().await;
        let event_id = hash(json!([device, event["eventId"]]).to_string());
        if b.deliveries.iter().any(|d| d.event_id == event_id) {
            return Ok(());
        }
        let d: Delivery = serde_json::from_value(json!({"key":format!("recovered:{event_id}"),"target":b.target.clone().unwrap_or_default(),"eventId":event_id,"createdAt":chrono::Utc::now().timestamp(),"state":"recovered","taskState":"recovered","status":"inbox-only","recovery":event["recovery"]})).map_err(|e|e.to_string())?;
        inbox_append(dir, source, super::event(&b, &d))?;
        b.deliveries.push(d);
        return persist(dir, &b);
    }
    process(dir, lock, &mut b, &observed).await
}
pub(crate) async fn reconcile(
    device: &str,
    source: &str,
    row: &Value,
    value: &Value,
) -> Result<()> {
    let thread = key(device, string(row, "taskId"));
    let turn = string(row, "turnId");
    let Some(mut b) = binding(&directory(), &thread, turn)?.filter(|b| b.source_id == source)
    else {
        return Ok(());
    };
    let value = value["turns"]
        .as_array()
        .and_then(|rows| rows.iter().find(|v| v["turnId"] == turn))
        .unwrap_or(value);
    // A status for a successor cannot settle this binding.
    if value["turnId"].as_str().is_some_and(|id| id != turn) {
        return Ok(());
    }
    let mut observation = value.clone();
    observation
        .as_object_mut()
        .ok_or("INVALID_ARGUMENT: member status must be an object")?
        .remove("_turnLifecycle");
    observation["threadId"] = json!(thread);
    observation["turnId"] = json!(turn);
    observation["agent"] = json!(if b.agent.is_empty() {
        "codex"
    } else {
        &b.agent
    });
    process(&directory(), &LOCK, &mut b, &observation).await
}
/// Public events keep native IDs and route all follow-up reads through query device.
pub(super) fn project(b: &Binding, event: &mut Value) {
    if b.device.is_null() {
        return;
    }
    let task = native_id(b);
    event["device"] = b.device.clone();
    if b.agent.is_empty() || b.agent == "codex" {
        event["threadId"] = json!(task);
    } else {
        event["taskId"] = json!(task);
    }
    event["title"] = json!(format!("{} · {}", string(&b.device, "name"), task_title(b)));
    let agent = !b.agent.is_empty() && b.agent != "codex";
    event["next"] = json!({"via":"query","op":"device","args":{"device":b.device["id"],"op":if agent {"agent_read"}else{"codex_read"},"args":if agent {json!({"agent":b.agent,"taskId":task})}else{json!({"threadId":task,"turnId":b.turn_id})}}});
    if event["interaction"].is_object() {
        event["interaction"]["next"] = event["next"].clone();
        if event["interaction"]["respond"].is_object() {
            let respond = event["interaction"]["respond"].clone();
            event["interaction"]["respond"] = json!({"op":"device","args":{"device":b.device["id"],"op":respond["op"],"args":respond["args"]}});
        }
    }
}

#[cfg(test)]
mod tests;

/// Explicit member reads acknowledge only that device-qualified task's events.
pub(crate) async fn acknowledge_read(
    device: &str,
    source: &str,
    op: &str,
    args: &Value,
    value: &Value,
) -> Result<()> {
    if !matches!(
        op,
        "codex_read" | "codex_wait" | "codex_items" | "codex_changes" | "agent_read" | "agent_wait"
    ) {
        return Ok(());
    }
    if value["state"] == "unconfirmed" {
        return Ok(());
    }
    let task = args["threadId"]
        .as_str()
        .or_else(|| args["taskId"].as_str())
        .unwrap_or("");
    let mut reads = Vec::new();
    for row in value["turns"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![value.clone()])
    {
        if let Some(turn) = row["turnId"].as_str().or_else(|| args["turnId"].as_str()) {
            let thread = key(device, task);
            if binding(&directory(), &thread, turn)?.is_some_and(|b| b.source_id == source) {
                index::read_key(&directory(), &thread, turn)?;
                reads.push((thread, turn.to_owned()));
            }
        }
    }
    if !reads.is_empty() {
        let _guard = LOCK.lock().await;
        inbox_in(&directory(), source, &reads, false, None)?;
    }
    Ok(())
}
pub(super) fn event_thread(row: &Value) -> String {
    let native = row["threadId"]
        .as_str()
        .or_else(|| row["taskId"].as_str())
        .unwrap_or("");
    row["device"]["id"]
        .as_str()
        .map(|device| key(device, native))
        .unwrap_or_else(|| native.into())
}
