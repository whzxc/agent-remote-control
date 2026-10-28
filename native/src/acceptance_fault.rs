//! Expiring observation faults for explicitly isolated debug instances only.
use crate::*;
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex as SyncMutex},
    time::{Duration, Instant},
};
static FAULTS: LazyLock<SyncMutex<HashMap<String, (String, Instant)>>> =
    LazyLock::new(|| SyncMutex::new(HashMap::new()));
fn isolated() -> bool {
    if !cfg!(debug_assertions) {
        return false;
    }
    let Ok(instance) = std::env::var("ARC_DEV_INSTANCE_ID") else {
        return false;
    };
    !instance.is_empty()
        && load(&root().join("acceptance-instance.json")).is_ok_and(|v| v["instanceId"] == instance)
}
pub(crate) fn control(args: &Value) -> Result<Value> {
    if !isolated() || crate::kernel::origin::current_origin()["authType"] != "local" {
        return Err(json!({"code":"ACCEPTANCE_FAULT_UNAVAILABLE","message":"Use the local CLI of npm run dev:isolated; production instances cannot inject faults"}).to_string());
    }
    let thread = string(args, "threadId");
    let rows = crate::dispatch_policy::records(thread)?;
    if rows.last().is_none_or(|r| r["purpose"] != "self-test") {
        return Err(json!({"code":"ACCEPTANCE_SELF_TEST_REQUIRED","message":"Select an ARC dispatch with purpose:self-test"}).to_string());
    }
    let mode = string(args, "mode");
    let mut faults = FAULTS.lock().map_err(|e| e.to_string())?;
    if mode == "clear" {
        faults.remove(thread);
        return Ok(json!({"threadId":thread,"mode":"clear","injected":false}));
    }
    if !matches!(mode, "placeholder" | "read-rejection") {
        return Err("INVALID_ACCEPTANCE_FAULT: use placeholder, read-rejection or clear".into());
    }
    let ms = args["durationMs"]
        .as_u64()
        .unwrap_or(300000)
        .clamp(1, 600000);
    faults.insert(
        thread.into(),
        (mode.into(), Instant::now() + Duration::from_millis(ms)),
    );
    Ok(
        json!({"threadId":thread,"mode":mode,"injected":true,"expiresInMs":ms,"next":{"op":"acceptance_fault","args":{"threadId":thread,"mode":"clear"}}}),
    )
}
fn active(thread: &str, mode: &str) -> bool {
    if !isolated() {
        return false;
    }
    FAULTS
        .lock()
        .ok()
        .and_then(|f| f.get(thread).map(|(m, t)| m == mode && *t > Instant::now()))
        .unwrap_or(false)
}
pub(crate) fn check_read(method: &str, args: &Value) -> Result<()> {
    if matches!(
        method,
        "thread/read" | "thread/turns/list" | "thread/items/list"
    ) && active(string(args, "threadId"), "read-rejection")
    {
        return Err(format!(
            "RPC_REJECTED:{}",
            json!({"code":-32600,"message":format!("thread {} already has an active writer",string(args,"threadId")),"data":{"injected":true,"mode":"read-rejection"}})
        ));
    }
    Ok(())
}
pub(crate) fn snapshot(thread: &str, mut state: Arc<Value>) -> Arc<Value> {
    if active(thread, "placeholder") {
        let state = Arc::make_mut(&mut state);
        let history = &mut state["turnHistory"]["history"];
        if history["entitiesByKey"].is_object() {
            history["entitiesByKey"]["arc-acceptance-placeholder"] =
                json!({"turnId":null,"status":"inProgress","items":[]});
            if let Some(entries) = history["islands"]
                .as_array_mut()
                .and_then(|v| v.last_mut())
                .and_then(|i| i["entries"].as_array_mut())
            {
                entries.retain(|e| e["value"] != "arc-acceptance-placeholder");
                entries.push(json!({"value":"arc-acceptance-placeholder"}));
            }
        }
        state["acceptanceFault"] = json!({"injected":true,"mode":"placeholder"});
    }
    state
}
