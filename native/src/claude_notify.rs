//! Turn-scoped control-source events, inboxes and fixed notification channels.
use crate::kernel::file_cache::{self, load};
use crate::*;
pub(crate) mod continuation;
pub(crate) mod coordination_delivery;
mod diagnostics;
mod governance;
pub(crate) mod mcp_events;
pub(crate) mod ownership;
mod reachability;
mod recovery;
mod retry;
pub(crate) mod routing;
pub(crate) mod subscriptions;
use governance::State;
pub(crate) use governance::{notify_control, notify_status, source_account};
use serde::{Deserialize, Serialize};
use std::{future::Future, time::Duration};

pub(crate) fn session_id(value: &str) -> Result<String> {
    let value = value.trim();
    let url = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
        .unwrap_or(value);
    let id = match url.strip_prefix("claude.ai/code/") {
        Some(id) => id
            .split(['?', '#'])
            .next()
            .unwrap_or("")
            .trim_end_matches('/'),
        None => value,
    };
    let suffix = id
        .strip_prefix("session_")
        .or_else(|| id.strip_prefix("cse_"));
    if !suffix.is_some_and(|suffix| {
        suffix.len() == 24 && suffix.bytes().all(|c| c.is_ascii_alphanumeric())
    }) {
        return Err(json!({
            "code":"INVALID_CLAUDE_SESSION",
            "message":"Invalid cloud-session target. Expected session_ or cse_ followed by exactly 24 ASCII letters/digits, or a claude.ai/code URL containing that ID. A local Claude CLI UUID is not a cloud-session ID.",
            "argument":"target",
            "expectedFormat":"^(session_|cse_)[A-Za-z0-9]{24}$",
            "next":{"via":"query","op":"guide","args":{"topic":"notify"},"hint":"Copy the receiving conversation's complete cloud-session ID from its claude.ai/code URL, then retry notify_control action:bind with that target. This request was rejected before binding or delivery."}
        }).to_string());
    }
    Ok(id.into())
}

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct DeliveryTiming {
    queued_at: Option<i64>,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    queue_ms: Option<i64>,
    send_ms: Option<u64>,
    // Last observed blocking reason; retained after delivery for diagnosis.
    queue_reason: Option<String>,
}

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Delivery {
    #[serde(default)]
    subscription: String,
    #[serde(default)]
    channel: Channel,
    key: String,
    target: String,
    #[serde(default)]
    event_id: String,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    batch: String,
    #[serde(default)]
    attempted_at: i64,
    #[serde(default)]
    attempts: Vec<(String, i64)>,
    #[serde(default)]
    error: Option<String>,
    state: String,
    #[serde(default)]
    task_state: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    interaction: Value,
    status: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    final_response: Value,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    external_user_inputs: Value,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    changes: Value,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    dispatches: Value,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    task_error: Value,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    reconciliation: Value,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    continuation: Value,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    recovery: Value,
    #[serde(default)]
    timing: DeliveryTiming,
    #[serde(default)]
    token_charged: bool,
    #[serde(default)]
    failures: u32,
    #[serde(default)]
    next_attempt_at: i64,
    #[serde(default)]
    digest: bool,
}
impl Delivery {
    fn urgent(&self) -> bool {
        self.task_state == "interaction-required"
    }
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    thread_id: String,
    turn_id: String,
    target: Option<String>,
    #[serde(default)]
    channel: Channel,
    #[serde(default)]
    source_id: String,
    #[serde(default)]
    agent: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    thread_title: String,
    #[serde(default)]
    explicit: bool,
    project: String,
    terminal: bool,
    created_at: i64,
    waiting: Vec<String>,
    deliveries: Vec<Delivery>,
    #[serde(default)]
    continuation_bound: bool,
    #[serde(default)]
    continuation_until: i64,
    #[serde(default)]
    scope_end: Option<String>,
    #[serde(default)]
    scope_started_at: i64,
    #[serde(default)]
    successor: Value,
    #[serde(default)]
    observation: Value,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    caused_by: Value,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    replacement_resume: Value,
    #[serde(default)]
    retry: Value,
}
fn directory() -> PathBuf {
    root().join("notifications")
}
fn path_in(dir: &Path, thread: &str, turn: &str) -> PathBuf {
    dir.join("tasks")
        .join(format!("{}.json", hash(json!([thread, turn]).to_string())))
}
static BINDINGS: std::sync::LazyLock<std::sync::Mutex<file_cache::Cache<Binding>>> =
    std::sync::LazyLock::new(Default::default);
pub(crate) fn diagnostics() -> Value {
    BINDINGS
        .lock()
        .map(|cache| cache.diagnostics())
        .unwrap_or(Value::Null)
}
fn binding_paths(dir: &Path) -> Result<Arc<Vec<file_cache::Entry>>> {
    BINDINGS
        .lock()
        .map_err(|e| e.to_string())?
        .entries(&dir.join("tasks"))
}
fn persist(dir: &Path, b: &Binding) -> Result<()> {
    let path = path_in(dir, &b.thread_id, &b.turn_id);
    let before = file_cache::Stamp::read(path.parent().unwrap())?;
    let mut cache = BINDINGS.lock().map_err(|e| e.to_string())?;
    save(&path, &serde_json::to_value(b).map_err(|e| e.to_string())?)?;
    cache.written(&path, before, b.clone())
}
fn binding(dir: &Path, thread: &str, turn: &str) -> Result<Option<Binding>> {
    let path = path_in(dir, thread, turn);
    if !path.exists() {
        return Ok(None);
    }
    read_binding(&path)
}
// Fail a malformed record closed without making unrelated bindings unavailable.
fn read_binding(path: &Path) -> Result<Option<Binding>> {
    Ok(shared_binding(path)?.map(|b| (*b).clone()))
}
fn shared_binding(path: &Path) -> Result<Option<Arc<Binding>>> {
    match BINDINGS.lock().map_err(|e| e.to_string())?.read(path) {
        Ok(binding) => Ok(Some(binding)),
        Err(error) if error.starts_with("INVALID_JSON:") => {
            crate::logs::record("WARN", "Ignored malformed notification binding", None);
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn bind_in(dir: &Path, session: Option<&str>, thread: &str, turn: &str, cwd: &str) -> Result<()> {
    let Some(session) = session else {
        return Ok(());
    };
    let previous = binding(dir, thread, turn)?;
    let origin = crate::kernel::origin::current_origin();
    if previous
        .as_ref()
        .is_some_and(|b| !origin.is_null() && b.source_id != string(&origin, "sourceId"))
    {
        return Err("NOTIFICATION_SOURCE_MISMATCH".into());
    }
    let mut b = previous.unwrap_or_else(|| Binding {
        thread_id: thread.into(),
        turn_id: turn.into(),
        target: None,
        channel: Channel::ClaudeSession,
        source_id: string(&origin, "sourceId").into(),
        agent: String::new(),
        title: String::new(),
        thread_title: String::new(),
        explicit: false,
        project: Path::new(cwd)
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("Untitled")
            .into(),
        terminal: false,
        created_at: chrono::Utc::now().timestamp(),
        waiting: vec![],
        deliveries: vec![],
        continuation_bound: false,
        continuation_until: 0,
        scope_end: None,
        scope_started_at: chrono::Utc::now().timestamp_millis(),
        successor: Value::Null,
        observation: Value::Null,
        caused_by: Value::Null,
        replacement_resume: Value::Null,
        retry: Value::Null,
    });
    b.target = (!session.is_empty()).then(|| session.to_owned());
    persist(dir, &b)
}
pub(crate) static LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Channel {
    #[default]
    ClaudeSession,
    McpEvents,
}

pub(crate) fn normalize(args: &mut Value) -> Result<()> {
    if args["purpose"] == "self-test" && args.get("notify").is_none() {
        args["notify"] = Value::Null;
    }
    if args["notify"]["channel"] == "claude-session" {
        args["notify"]["target"] = json!(session_id(string(&args["notify"], "target"))?);
    }
    Ok(())
}

pub(crate) async fn bind(
    args: &Value,
    thread: &str,
    turn: &str,
    cwd: &str,
    cause: Value,
) -> Result<()> {
    if turn.is_empty() {
        return Ok(());
    } // Thread-only create has no event yet.
    let _guard = LOCK.lock().await;
    let dir = directory();
    let created = binding(&dir, thread, turn)?.is_none();
    let origin = crate::kernel::origin::current_origin();
    let continued = if created && args.get("notify").is_none() && cause["op"] == "codex_send" {
        records(&dir)?
            .into_iter()
            .filter(|b| {
                b.thread_id == thread
                    && b.scope_end.is_none()
                    && b.source_id == string(&origin, "sourceId")
                    && !b.continuation_bound
            })
            .max_by_key(|b| b.created_at)
    } else {
        None
    };
    if created
        && continued.is_none()
        && matches!(string(&cause, "op"), "codex_send" | "codex_create")
        && args["_retryAttempt"].as_u64().unwrap_or(0) == 0
        && !crate::app_replace::continuation_request_matches(thread, string(&cause, "requestId"))?
    {
        for mut previous in records(&dir)?
            .into_iter()
            .filter(|b| b.thread_id == thread && b.scope_end.is_none())
        {
            previous.scope_end = Some("new-unrelated-dispatch".into());
            persist(&dir, &previous)?;
        }
    }
    if created {
        bind_in(&dir, Some(""), thread, turn, cwd)?;
    }
    let mut b = binding(&dir, thread, turn)?.unwrap();
    if let Some(notify) = args.get("notify") {
        if b.target.as_deref() != notify["target"].as_str()
            || serde_json::to_value(b.channel).unwrap() != notify["channel"]
        {
            for d in &mut b.deliveries {
                if d.channel == Channel::ClaudeSession && d.status == "pending" {
                    d.status = "failed".into();
                    d.error = Some("binding-changed".into());
                }
            }
        }
        b.explicit = true;
        b.target = notify["target"].as_str().map(str::to_owned);
        if !notify.is_null() {
            b.channel =
                serde_json::from_value(notify["channel"].clone()).map_err(|e| e.to_string())?;
        }
    }
    let caller = crate::kernel::origin::current_origin();
    if !b.source_id.is_empty() && b.source_id != string(&caller, "sourceId") {
        return Err("NOTIFICATION_SOURCE_MISMATCH".into());
    }
    if !created && b.source_id.is_empty() {
        return Err("NOTIFICATION_SOURCE_UNATTRIBUTED".into());
    }
    if b.source_id.is_empty() {
        b.source_id = string(&crate::kernel::origin::current_origin(), "sourceId").into();
    }
    if b.agent.is_empty() {
        b.agent = args["agent"].as_str().unwrap_or("codex").into();
    }
    if created && b.title.is_empty() {
        let mut prompt = args.clone();
        prompt.as_object_mut().map(|args| args.remove("title"));
        b.title = crate::control::dispatch_title(&prompt);
    }
    if created {
        if cause.is_object() {
            b.caused_by = cause;
        }
        b.retry = json!({"model":args["_retryModel"],"turn":args["_retryTurn"],"attempts":args["_retryAttempt"].as_u64().unwrap_or(0),"origin":crate::kernel::origin::current_origin()});
    }
    let mut state = State::load(&dir)?;
    if let Some(rule) = state.rule(&b) {
        governance::apply_rebind(&mut b, rule);
    }
    if let Some(target) = &b.target {
        state.target(
            &b.source_id,
            b.channel,
            target,
            chrono::Utc::now().timestamp(),
            &settings()?,
        );
        state.save(&dir)?;
    }
    persist(&dir, &b)?;
    if let Some(mut previous) = continued {
        b.target = previous.target.clone();
        b.channel = previous.channel;
        b.title = previous.title.clone();
        b.scope_started_at = if previous.scope_started_at == 0 {
            previous.created_at.saturating_mul(1000)
        } else {
            previous.scope_started_at
        };
        b.caused_by["continuationOf"] = json!(previous.turn_id);
        if let Some(rule) = state.rule(&b) {
            governance::apply_rebind(&mut b, rule);
        }
        persist(&dir, &b)?;
        previous.continuation_bound = true;
        previous.successor =
            json!({"turnId":turn,"inherited":true,"reason":"same-origin-thread-continuation"});
        persist(&dir, &previous)?;
    }
    Ok(())
}
pub(crate) async fn inherit(thread: &str, previous: &str, turn: &str) -> Result<()> {
    let _guard = LOCK.lock().await;
    if let (Some(mut old), Some(mut next)) = (
        binding(&directory(), thread, previous)?,
        binding(&directory(), thread, turn)?,
    ) {
        if !next.explicit && !old.continuation_bound {
            next.target = old.target.clone();
            next.channel = old.channel;
            next.source_id = old.source_id.clone();
            next.title = old.title.clone();
            next.project = old.project.clone();
            next.scope_started_at = if old.scope_started_at == 0 {
                old.created_at.saturating_mul(1000)
            } else {
                old.scope_started_at
            };
            for d in &mut next.deliveries {
                if d.status == "pending" && d.target.is_empty() {
                    d.target = old.target.clone().unwrap_or_default();
                    d.channel = old.channel;
                }
            }
            persist(&directory(), &next)?;
        }
        old.continuation_bound = true;
        old.successor =
            json!({"turnId":turn,"reason":"interaction-continuation","inherited":!next.explicit});
        persist(&directory(), &old)?;
    }
    Ok(())
}

pub(crate) fn command_submitter(origin: &Value) -> Result<Value> {
    command_submitter_in(&directory(), origin)
}

fn command_submitter_in(dir: &Path, origin: &Value) -> Result<Value> {
    let mut destinations = Vec::new();
    if origin["authType"] != "local" {
        let all = records(dir)?;
        let mut state = State::load(dir)?;
        subscriptions::sync(&mut state, &all);
        for target in &state.targets {
            if target.registered
                && target.source_id == string(origin, "sourceId")
                && target.channel == Channel::ClaudeSession
            {
                let notify = json!({"channel":target.channel,"target":target.target});
                if !destinations.contains(&notify) {
                    destinations.push(notify);
                }
            }
        }
        for sub in &state.subscriptions {
            if sub.source_id != string(origin, "sourceId")
                || !sub.active(chrono::Utc::now().timestamp_millis())
                || (sub.channel == Channel::McpEvents
                    && !sub
                        .webhook
                        .as_ref()
                        .is_some_and(|w| origin["eventPrincipal"] == w.principal))
                || (sub.channel == Channel::ClaudeSession
                    && !all.iter().any(|b| b.scope_end.is_none() && sub.matches(b)))
            {
                continue;
            }
            let notify = json!({"channel":sub.channel,"target":sub.target});
            if !destinations.contains(&notify) {
                destinations.push(notify);
            }
        }
    }
    // A source can span conversations. Ambiguity must not select another chat.
    Ok(
        json!({"origin":origin,"notify":if destinations.len() == 1 {destinations.pop()} else {None}}),
    )
}

// Local replacement captures the exact active dispatch before stopping Core.
pub(crate) fn replacement_binding(thread: &str) -> Result<Value> {
    replacement_turn_binding(thread, None)
}

pub(crate) fn replacement_turn_binding(thread: &str, turn: Option<&str>) -> Result<Value> {
    let all = records(&directory())?;
    let Some(b) = all
        .iter()
        .filter(|b| {
            b.thread_id == thread
                && !b.terminal
                && (b.agent.is_empty() || b.agent == "codex")
                && turn.is_none_or(|turn| b.turn_id == turn)
        })
        .max_by_key(|b| b.created_at)
    else {
        return Ok(Value::Null);
    };
    let dispatches = crate::dispatch_policy::records(thread)?;
    let Some(dispatch) = dispatches
        .iter()
        .find(|d| d["turnId"] == b.turn_id && d["origin"]["sourceId"] == b.source_id)
    else {
        return Ok(Value::Null);
    };
    Ok(
        json!({"threadId":thread,"turnId":b.turn_id,"origin":dispatch["origin"],
        "purpose":dispatch["purpose"],"dispatch":dispatch,"model":b.retry["model"],"turn":b.retry["turn"],"notify":b.target.as_ref().map(|target|json!({"channel":b.channel,"target":target}))}),
    )
}

pub(crate) fn resume_context(thread: &str, turn: &str) -> Result<Value> {
    let error = |code: &str, message: &str| {
        json!({"code":code,"message":message,"next":{"via":"query","op":"codex_read","args":{"threadId":thread,"statusOnly":true}}}).to_string()
    };
    let b = binding(&directory(), thread, turn)?.ok_or_else(|| {
        error(
            "RESUME_BINDING_MISSING",
            "Resume only a bound ARC dispatch.",
        )
    })?;
    let caller = crate::kernel::origin::current_origin();
    if b.scope_end.is_some() || (caller["authType"] != "local" && caller["sourceId"] != b.source_id)
    {
        return Err(error(
            "RESUME_SOURCE_MISMATCH",
            "The thread binding ended or belongs to another source.",
        ));
    }
    let rows = crate::dispatch_policy::records(thread)?;
    let parent = rows
        .iter()
        .find(|r| r["turnId"] == turn)
        .ok_or("RESUME_DISPATCH_MISSING")?;
    Ok(
        json!({"model":parent["model"],"effort":parent["effort"],"serviceTier":parent["serviceTier"],"source":"inherited-dispatch-not-confirmed"}),
    )
}

pub(crate) async fn prepare_replacement_resume(
    thread: &str,
    turn: &str,
    lineage: &Value,
) -> Result<()> {
    prepare_replacement_resume_in(&directory(), &LOCK, thread, turn, lineage).await
}

async fn prepare_replacement_resume_in(
    dir: &Path,
    lock: &Mutex<()>,
    thread: &str,
    turn: &str,
    lineage: &Value,
) -> Result<()> {
    let _guard = lock.lock().await;
    let mut b = binding(dir, thread, turn)?.ok_or("RESUME_BINDING_MISSING")?;
    // Clear stale attribution on ordinary resumes. Successor bindings inherit
    // this marker, including a handoff already observed before adoption.
    if lineage["requestId"].is_string() && b.replacement_resume["requestId"] == lineage["requestId"]
    {
        return Ok(());
    }
    if b.replacement_resume != *lineage {
        b.replacement_resume = lineage.clone();
        if b.replacement_resume.is_object() {
            b.replacement_resume["startedAt"] = json!(now());
        }
        persist(dir, &b)?;
    }
    Ok(())
}

pub(crate) async fn resumed(
    thread: &str,
    previous: &str,
    turn: &str,
    configuration: Value,
) -> Result<()> {
    let Some(mut b) = binding(&directory(), thread, previous)? else {
        return Err("RESUME_BINDING_MISSING".into());
    };
    process(
        &directory(),
        &LOCK,
        &mut b,
        &json!({"state":"cancelled","nextTurnId":turn,
        "nativeContinuation":{"retry":{"turnId":turn,"trigger":"resume_interrupted_task",
        "startedAt":chrono::Utc::now().timestamp(),"configuration":configuration}}}),
    )
    .await
}
pub(crate) fn record_binding(receipt: &mut Value, result: Result<()>) {
    if let Err(error) = result {
        #[cfg(not(test))]
        crate::logs::record(
            "WARN",
            &format!("Task dispatched, but notification binding failed: {error}"),
            None,
        );
        receipt["notification"] = json!("bind-failed");
        receipt["notificationError"] = json!(error);
    }
}
const RETENTION_SECONDS: i64 = 7 * 24 * 60 * 60;
fn remove_expired(dir: &Path, b: &Binding, now: i64) -> Result<bool> {
    if (!b.continuation_bound && b.scope_end.is_none())
        || !b.terminal
        || b.deliveries
            .iter()
            .any(|d| matches!(d.status.as_str(), "pending" | "sending"))
        || now - b.created_at <= RETENTION_SECONDS
    {
        return Ok(false);
    }
    let path = path_in(dir, &b.thread_id, &b.turn_id);
    let before = file_cache::Stamp::read(path.parent().unwrap())?;
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    file_cache::changed(&path, before.clone());
    BINDINGS
        .lock()
        .map_err(|e| e.to_string())?
        .changed(&path, before);
    Ok(true)
}
fn notification(b: Option<Binding>) -> Value {
    b.filter(|b| b.target.is_some()).map(|b| json!({
        "sourceId": b.source_id, "channel": b.channel, "target": b.target,
        "deliveries": b.deliveries.iter().filter(|d| d.channel == b.channel && Some(d.target.as_str()) == b.target.as_deref()).map(|d| json!({"eventId":d.event_id,"kind":event(&b,d)["kind"],"level":if b.channel==Channel::ClaudeSession {"L1"}else{"L2"},"state":d.status,"error":d.error,"timing":d.timing})).collect::<Vec<_>>()
    })).unwrap_or(Value::Null)
}
pub(crate) fn read(thread: &str, turn: &str) -> Result<Value> {
    read_since(thread, turn, None)
}
pub(crate) fn read_since(thread: &str, turn: &str, since: Option<&str>) -> Result<Value> {
    let origin = crate::kernel::origin::current_origin();
    let b = binding(&directory(), thread, turn)?
        .filter(|b| origin.is_null() || b.source_id == string(&origin, "sourceId"));
    let mut result = notification_since(b, since);
    if result.is_object() {
        let state = State::load(&directory())?;
        let reachability = state
            .targets
            .iter()
            .find(|t| {
                result["sourceId"] == t.source_id
                    && result["channel"] == serde_json::to_value(t.channel).unwrap()
                    && result["target"] == t.target
            })
            .map(|t| t.reachability.clone())
            .unwrap_or_default();
        let mut reachability = reachability;
        reachability.expire(chrono::Utc::now().timestamp());
        result["reachability"] = json!(reachability.state);
        result["reason"] = json!(reachability.reason);
    }
    Ok(result)
}
fn notification_since(mut b: Option<Binding>, since: Option<&str>) -> Value {
    if let (Some(b), Some(at)) = (
        &mut b,
        since.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()),
    ) {
        b.deliveries
            .retain(|d| d.timing.queued_at.unwrap_or(d.created_at * 1000) >= at.timestamp_millis());
    }
    notification(b)
}
pub(crate) fn retry_pending(thread: &str, turn: &str) -> Result<bool> {
    Ok(binding(&directory(), thread, turn)?
        .is_some_and(|b| matches!(string(&b.retry, "status"), "scheduled" | "submitting")))
}
pub(crate) fn retry_status(thread: &str, turn: &str) -> Result<Value> {
    let Some(b) = binding(&directory(), thread, turn)? else {
        return Ok(Value::Null);
    };
    if b.retry["status"].is_null() && b.retry["attempts"].as_u64().unwrap_or(0) == 0 {
        return Ok(Value::Null);
    }
    Ok(
        json!({"status":b.retry["status"],"attempts":b.retry["attempts"],"nextAttempt":b.retry["nextAttempt"],"notBefore":b.retry["notBefore"],"reason":b.retry["reason"],"successorTurnId":b.retry["successorTurnId"]}),
    )
}
fn event(b: &Binding, d: &Delivery) -> Value {
    let kind = match d.task_state.as_str() {
        "handoff" => "handoff",
        "recovered" => "recovered",
        "completed" => "completed",
        "failed" => "failed",
        "cancelled" => "interrupted",
        _ => "needs-input",
    };
    let agent = !b.agent.is_empty() && b.agent != "codex";
    let next = if d.key.starts_with("update:") {
        json!({"via":"query","op":"update_status","args":{},"hint":"Read update progress, affected tasks and the outcome."})
    } else if kind == "recovered" {
        json!({"via":"query","op":"notify_status","args":{"target":d.target},"hint":"Inspect affected bindings and reconnect the control-source client if needed."})
    } else if kind == "handoff" {
        json!({"via":"query","op":"codex_owner","args":{"threadId":b.thread_id},"hint":"Inspect the current writer and observed handoff history before continuing."})
    } else if kind == "needs-input" {
        if agent {
            json!({"hint":"Read the pending interaction before responding.","via":"query","op":"agent_pending","args":{"agent":b.agent,"taskId":b.thread_id}})
        } else {
            json!({"hint":"Read the pending interaction before responding. If no request is exposed, handle it in Codex Desktop.","via":"query","op":"codex_pending","args":{"threadId":b.thread_id}})
        }
    } else if agent {
        json!({"hint":"Read the result and review it against the acceptance criteria.","via":"query","op":"agent_read","args":{"agent":b.agent,"taskId":b.thread_id}})
    } else {
        json!({"hint":"Read the result and review its changes.","via":"query","op":"codex_read","args":{"threadId":b.thread_id}})
    };
    json!({"eventId":d.event_id,"kind":kind,"project":b.project,"threadId":if agent {Value::Null}else{json!(b.thread_id)},"taskId":if agent {json!(b.thread_id)}else{Value::Null},"agent":if agent {json!(b.agent)}else{json!("codex")},"turnId":b.turn_id,"title":task_title(b),"channel":d.channel,"target":if d.target.is_empty(){Value::Null}else{json!(d.target)},"causedBy":b.caused_by,"summary":receipt(b, d),"interaction":d.interaction,"questionSummary":crate::egress::interaction_preview(&d.interaction),"routing":d.interaction["routing"],"dispatches":d.dispatches,"externalUserInputs":d.external_user_inputs,"finalResponse":d.final_response,"error":if kind=="handoff" {Value::Null}else{d.task_error.clone()},"reconciliation":d.reconciliation,"continuation":d.continuation,"recovery":d.recovery,"ownership":if kind=="handoff" {d.task_error.clone()}else{Value::Null},"next":if d.interaction["next"].is_object() {d.interaction["next"].clone()} else {next}})
}
fn empty_answered_completion(b: &Binding, observed: &Value) -> bool {
    observed["state"] == "completed"
        && (b.agent.is_empty() || b.agent == "codex")
        && observed["finalResponse"]
            .as_str()
            .or_else(|| observed["finalResponse"]["text"].as_str())
            .is_none_or(|s| s.trim().is_empty())
        && (b.continuation_bound
            || b.deliveries
                .iter()
                .any(|d| d.interaction["method"] == "request_user_input_async"))
}
// Only dispatch metadata belongs in pushed text. Task output remains queryable.
fn receipt_line(value: &str, limit: usize) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > limit {
        format!("{}…", text.chars().take(limit - 1).collect::<String>())
    } else {
        text
    }
}
fn task_title(b: &Binding) -> &str {
    [&b.thread_title, &b.title, &b.project]
        .into_iter()
        .map(|title| title.trim())
        .find(|title| !title.is_empty())
        .unwrap_or("")
}
const RECEIPT_HEADER: &str = "⟢ ARC receipt — automated, not a user message";

fn receipt(b: &Binding, d: &Delivery) -> String {
    if d.task_state == "recovered" {
        if let Some(message) = d.recovery["message"].as_str() {
            return format!("{RECEIPT_HEADER}\n{message}");
        }
        let count = d.recovery["affectedTasks"].as_u64().unwrap_or(0);
        let outcome = match count {
            0 => "no turns interrupted".into(),
            1 => "1 turn interrupted".into(),
            _ => format!("{count} turns interrupted"),
        };
        return format!(
            "{RECEIPT_HEADER}\nARC recovered at {}; {outcome}.",
            string(&d.recovery, "recoveredAt")
        );
    }
    if d.task_state == "handoff" {
        return format!(
            "⟢ ARC receipt — automated, not a user message\n↔ handoff · {} → {}\n{} · ref {}",
            string(&d.task_error, "from"),
            string(&d.task_error, "to"),
            b.project,
            b.thread_id
        );
    }
    let (icon, state) = match d.task_state.as_str() {
        "completed" => ("✓", "completed"),
        "failed" => ("✗", "failed"),
        "cancelled" | "interrupted" if d.continuation.is_object() => ("↪", "superseded"),
        "cancelled" | "interrupted" => ("■", "interrupted"),
        _ if d.state == "waiting for approval" => ("?", "approval"),
        _ => ("?", "needs-input"),
    };
    let dispatch = d
        .dispatches
        .as_array()
        .and_then(|rows| rows.iter().rev().find(|row| row["turnId"] == b.turn_id));
    let title = task_title(b);
    let mut configuration = Vec::new();
    if let Some(row) = dispatch {
        let effective = &row["effectiveConfiguration"];
        for key in ["model", "effort", "serviceTier"] {
            if let Some(value) = effective[key]
                .as_str()
                .filter(|v| !v.is_empty() && *v != "unknown")
                .or_else(|| {
                    row[key]
                        .as_str()
                        .filter(|v| !v.is_empty() && *v != "unknown")
                })
            {
                if key == "serviceTier" && matches!(value, "default" | "standard") {
                    continue;
                }
                configuration.push(receipt_line(
                    if key == "serviceTier" && matches!(value, "fast" | "priority") {
                        "Fast"
                    } else {
                        value
                    },
                    100,
                ));
            }
        }
    }
    let duration = if d.reconciliation.is_object() {
        d.reconciliation["durationMs"].as_u64()
    } else {
        dispatch.and_then(|row| row["terminal"]["observedDurationMs"].as_u64())
    }
    .map(|ms| format!(" · {}m{}s", ms / 60000, ms / 1000 % 60))
    .unwrap_or_default();
    let project = b
        .project
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("");
    let agent = if b.agent.is_empty() {
        "codex"
    } else {
        &b.agent
    };
    let config = if configuration.is_empty() {
        String::new()
    } else {
        format!(" · {}", configuration.join(" "))
    };
    let reconciliation = if d.reconciliation.is_object() {
        " · reconciled after restart"
    } else {
        ""
    };
    let continuation = if d.continuation.is_object() {
        format!(
            "\ncontinued in turn {} · {}",
            string(&d.continuation, "turnId"),
            string(&d.continuation, "state")
        )
    } else {
        String::new()
    };
    format!("⟢ ARC receipt — automated, not a user message\n{icon} {state}{reconciliation} · {}{duration}\n{}\n{}{config} · ref {}{continuation}",
        receipt_line(project, 100), receipt_line(title, 100),
        receipt_line(agent, 100), b.thread_id)
}
fn message(b: &Binding) -> String {
    b.deliveries
        .iter()
        .map(|d| receipt(b, d))
        .collect::<Vec<_>>()
        .join("\n\n")
}
fn arguments(session: &str, message: &str) -> Vec<String> {
    ["-p", message, "--cloud", session, "--output-format", "json"]
        .map(str::to_owned)
        .to_vec()
}

// Persist the exact interaction alongside its stable event ID for restart recovery.
fn transitions(b: &mut Binding, observed: &Value) -> Vec<(String, String)> {
    if b.terminal {
        return vec![];
    }
    let terminal = match string(observed, "state") {
        "completed" => Some("completed"),
        "failed" => Some("failed"),
        "cancelled" => Some("interrupted"),
        _ => None,
    };
    if let Some(state) = terminal {
        b.terminal = true;
        b.waiting.clear();
        return vec![("terminal".into(), state.into())];
    }
    if observed["state"] == "running" {
        b.waiting.clear();
    }
    if observed["state"] != "interaction-required" {
        return vec![];
    }
    let mut events = vec![];
    let mut waiting = vec![];
    for request in observed["interaction"].as_array().into_iter().flatten() {
        let method = string(request, "method");
        let state = if method.contains("requestUserInput")
            || method == "request_user_input_async"
            || method.contains("elicitation")
        {
            "waiting for input"
        } else if method.contains("Approval") || method.contains("approval") {
            "waiting for approval"
        } else if !b.agent.is_empty() && b.agent != "codex" {
            "waiting for input"
        } else {
            "waiting for input"
        };
        waiting.push(state.to_owned());
        if !request["id"].is_null() {
            events.push((format!("request:{}", request["id"]), state.to_owned()));
        } else if !b.waiting.iter().any(|v| v == state) {
            events.push((
                format!("entry:{}:{state}", b.deliveries.len()),
                state.into(),
            ));
        }
    }
    for (flag, state) in [
        ("waitingOnApproval", "waiting for approval"),
        ("waitingOnUserInput", "waiting for input"),
    ] {
        if observed["activeFlags"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == flag))
            && !waiting.iter().any(|v| v == state)
        {
            waiting.push(state.into());
            if !b.waiting.iter().any(|v| v == state) {
                events.push((
                    format!("entry:{}:{state}", b.deliveries.len()),
                    state.into(),
                ));
            }
        }
    }
    b.waiting = waiting;
    events.retain(|(key, _)| !b.deliveries.iter().any(|d| &d.key == key));
    events.sort();
    events.dedup();
    events
}
struct SendOutcome {
    status: &'static str,
    error: Option<String>,
    retry: bool,
    remove_subscription: bool,
}
impl SendOutcome {
    fn success(status: &'static str) -> Self {
        Self {
            status,
            error: None,
            retry: false,
            remove_subscription: false,
        }
    }
    fn failed(error: &str, retry: bool) -> Self {
        Self {
            status: "failed",
            error: Some(error.into()),
            retry,
            remove_subscription: false,
        }
    }
}
trait Executor: Sync {
    fn webhook(
        &self,
        _sub: &subscriptions::Subscription,
        _b: &Binding,
        _d: &Delivery,
    ) -> impl Future<Output = SendOutcome> + Send {
        async { SendOutcome::failed("webhook_unavailable", false) }
    }
    fn send(
        &self,
        source_id: &str,
        args: Vec<String>,
    ) -> impl Future<Output = Result<Vec<u8>>> + Send;
    fn local_account(&self, _source_id: &str, _target: &str) -> impl Future<Output = Value> + Send {
        async { json!({"available":false,"reason":"auth-status-unavailable"}) }
    }
    fn verification_identity(&self) -> impl Future<Output = Result<Value>> + Send {
        async { Ok(Value::Null) }
    }
    fn escalate(&self, body: String) -> impl Future<Output = Result<()>> + Send;
}
struct Cli {
    service: std::sync::Weak<crate::service::Service>,
    account_id: Option<String>,
}
impl Executor for Cli {
    async fn local_account(&self, source_id: &str, target: &str) -> Value {
        let account_id = match self
            .account_id
            .clone()
            .map(Ok)
            .unwrap_or_else(|| source_account(source_id, target))
        {
            Ok(id) => id,
            Err(error) => return json!({"available":false,"reason":error}),
        };
        let mut identity = match crate::accounts::claude::account_identity(&account_id).await {
            Ok(value) => safe_account(&value),
            Err(error) => json!({"available":false,"reason":error}),
        };
        identity["accountId"] = json!(account_id);
        identity["observedAt"] = json!(now());
        identity
    }

    async fn verification_identity(&self) -> Result<Value> {
        let Some(profile) = &self.account_id else {
            return Ok(Value::Null);
        };
        let Ok(facts) = crate::accounts::claude::refresh_profile(profile).await else {
            return Ok(Value::Null);
        };
        crate::accounts::migrate()?;
        if facts["loggedIn"] != true || crate::accounts::identity_key("anthropic", &facts).is_none()
        {
            return Ok(Value::Null);
        }
        let account = crate::accounts::profile_account(profile)?;
        Ok(
            json!({"kind":"claude-session-handshake","profileId":profile,"accountId":account["id"],"identityKey":account["identityKey"],"orgId":facts["orgId"]}),
        )
    }

    async fn webhook(
        &self,
        sub: &subscriptions::Subscription,
        b: &Binding,
        d: &Delivery,
    ) -> SendOutcome {
        match self.service.upgrade() {
            Some(service) => mcp_events::send(&service, sub, b, d).await,
            None => SendOutcome::failed("service_stopped", true),
        }
    }
    async fn escalate(&self, body: String) -> Result<()> {
        crate::transport::forward_request(
            "permissions/notify",
            "POST",
            json!({"title":"ARC 通知需要处理", "body":body}),
        )
        .await
        .map(|_| ())
    }
    async fn send(&self, source_id: &str, args: Vec<String>) -> Result<Vec<u8>> {
        if settings()?["notificationsEnabled"] == false {
            return Err("NOTIFICATIONS_DISABLED".into());
        }
        let target = args
            .windows(2)
            .find(|pair| pair[0] == "--cloud")
            .map(|pair| pair[1].as_str())
            .ok_or("INVALID_CLAUDE_SESSION")?;
        let account_id = self
            .account_id
            .clone()
            .map(Ok)
            .unwrap_or_else(|| source_account(source_id, target))?;
        let mut cmd = crate::accounts::claude::account_command(&account_id).await?;
        let output = tokio::time::timeout(
            Duration::from_secs(30),
            cmd.args(args).stdin(std::process::Stdio::null()).output(),
        )
        .await
        .map_err(|_| "CLAUDE_SEND_TIMEOUT")?
        .map_err(|e| format!("CLAUDE_SEND_FAILED: {e}"))?;
        if !output.status.success() {
            if session_not_found(&String::from_utf8_lossy(&output.stderr))
                || session_not_found(&String::from_utf8_lossy(&output.stdout))
            {
                return Err("CLAUDE_SESSION_NOT_FOUND: Session not found".into());
            }
            return Err(format!(
                "CLAUDE_SEND_FAILED: exit {}; {}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
                    .chars()
                    .take(2000)
                    .collect::<String>()
            ));
        }
        Ok(output.stdout)
    }
}
/// One explicit local send; no automatic retry after an uncertain result.
pub(crate) async fn send_account_notification(args: &Value) -> Result<Value> {
    let target = session_id(string(args, "target"))?;
    let account_id = string(args, "accountId");
    let message = string(args, "message");
    if message.trim().is_empty() || message.chars().count() > 8000 {
        return Err("INVALID_NOTIFICATION_MESSAGE: Supply 1 to 8000 characters".into());
    }
    crate::accounts::claude::routing::bind(&target, account_id, false).await?;
    let executor = Cli {
        service: std::sync::Weak::new(),
        account_id: Some(account_id.into()),
    };
    deliver_target(&executor, "", &target, message).await?;
    Ok(
        json!({"accountId":account_id,"target":target,"deliveryStatus":"delivered",
        "hint":"Claude CLI accepted the message for this exact session. This does not confirm receiver display or acknowledgement."}),
    )
}

async fn deliver_message(executor: &impl Executor, b: &Binding, body: &str) -> &'static str {
    if deliver_target(executor, &b.source_id, b.target.as_deref().unwrap(), body)
        .await
        .is_ok()
    {
        "delivered"
    } else {
        "failed"
    }
}
fn session_not_found(error: &str) -> bool {
    error.to_ascii_lowercase().contains("session not found")
        || error.contains("CLAUDE_SESSION_NOT_FOUND")
}
fn safe_account(value: &Value) -> Value {
    let mut identity = json!({"available":false});
    if let Some(logged_in) = value["loggedIn"].as_bool() {
        identity["loggedIn"] = json!(logged_in);
        identity["available"] = json!(true);
    }
    for key in ["email", "authMethod"] {
        if let Some(text) = value[key].as_str() {
            identity[key] = json!(text.chars().take(320).collect::<String>());
            identity["available"] = json!(true);
        }
    }
    identity
}
async fn deliver_target(
    executor: &impl Executor,
    source_id: &str,
    session: &str,
    body: &str,
) -> Result<()> {
    let result = executor
        .send(source_id, arguments(session, body))
        .await
        .and_then(|bytes| {
            serde_json::from_slice::<Value>(&bytes).map_err(|_| {
                if session_not_found(&String::from_utf8_lossy(&bytes)) {
                    "CLAUDE_SESSION_NOT_FOUND: Session not found".into()
                } else {
                    "CLAUDE_SEND_UNKNOWN".into()
                }
            })
        });
    let error = match result {
        Ok(ref v) if v["ok"] == true && v["session_id"].as_str() == Some(session) => return Ok(()),
        Ok(ref v) if v["ok"] == true => "CLAUDE_SESSION_MISMATCH".to_owned(),
        Ok(v)
            if ["error", "errors", "message"]
                .iter()
                .any(|key| session_not_found(&v[*key].to_string())) =>
        {
            "CLAUDE_SESSION_NOT_FOUND: Session not found".into()
        }
        Ok(v) => format!("CLAUDE_SEND_REJECTED: {}", v["error"]),
        Err(error) => error,
    };
    #[cfg(not(test))]
    crate::logs::record(
        "WARN",
        &format!("Claude notification delivery failed: {error}"),
        None,
    );
    Err(if session_not_found(&error) {
        "CLAUDE_SESSION_NOT_FOUND: Session not found".into()
    } else {
        error
    })
}
fn recover(dir: &Path, b: &mut Binding) -> Result<bool> {
    let retry = |d: &Delivery| {
        (d.status == "sending"
            || (d.status == "failed"
                && matches!(
                    d.error.as_deref(),
                    None | Some("delivery-failed-or-unconfirmed" | "wake-limit" | "disabled")
                )))
            && d.failures < 6
    };
    if b.deliveries.iter().any(retry) {
        for d in &mut b.deliveries {
            if retry(d) {
                d.failures = d.failures.saturating_add(1);
                d.status = if d.failures < 6 { "pending" } else { "failed" }.into();
                d.token_charged = d.attempted_at > 0;
                d.next_attempt_at = chrono::Utc::now()
                    .timestamp()
                    .saturating_add(governance::retry_seconds(d.failures));
                d.error = Some("restart-delivery-unconfirmed".into());
            }
        }
        persist(dir, b)?;
        return Ok(true);
    }
    Ok(false)
}
fn quiet_terminal(b: &Binding) -> bool {
    b.terminal
        && b.waiting.is_empty()
        && !b.deliveries.iter().any(|d| {
            !d.interaction.is_null()
                && d.interaction["resolved"] != true
                && matches!(d.status.as_str(), "pending" | "sending")
        })
}

async fn process(dir: &Path, lock: &Mutex<()>, b: &mut Binding, observation: &Value) -> Result<()> {
    let guard = lock.lock().await;
    let Some(current) = binding(dir, &b.thread_id, &b.turn_id)? else {
        return Ok(());
    };
    *b = current;
    let reconciliation = if b.observation["reconciliation"] == "pending-after-restart"
        && matches!(
            string(observation, "state"),
            "completed" | "failed" | "cancelled"
        ) {
        let terminal = observation["dispatches"].as_array()
            .and_then(|rows| rows.iter().find(|row| row["turnId"] == b.turn_id))
            .map(|row| row["terminal"].clone())
            .filter(|terminal| terminal["reconciledAfterRestart"] == true)
            .unwrap_or_else(|| crate::dispatch_policy::terminal_snapshot(
                &json!({"submittedAt":chrono::DateTime::from_timestamp(b.created_at,0).map(|t|t.to_rfc3339())}),
                string(observation, "state"), &observation["turnTiming"],
                b.observation["observedAt"].as_str(), true));
        json!({"endedAt":terminal["endedAt"],"durationMs":terminal["observedDurationMs"],"timeBasis":terminal["timeBasis"]})
    } else {
        Value::Null
    };
    continuation::adopt(dir, b, observation)?;
    let diagnostic_changed = if observation.get("handoffs").is_none() {
        let diagnostic = json!({"state":observation["state"],"reason":observation["reason"],
            "runtimeSource":observation["runtimeSource"],"runtimeStatus":observation["runtimeStatus"],
            "recordedStatus":observation["recordedStatus"],"observedAt":if observation["state"]=="unconfirmed" {b.observation["observedAt"].clone()}else{observation["observedAt"].clone()},
            "reconciliation":if observation["state"]=="unconfirmed" {"pending-after-restart"}else{"reconciled"}});
        let changed = b.observation != diagnostic;
        b.observation = diagnostic;
        changed
    } else {
        false
    };

    if let Some(title) = observation["title"]
        .as_str()
        .filter(|title| !title.trim().is_empty())
    {
        b.thread_title = title.to_owned();
    }
    let history = if b.successor["inherited"] == true
        || observation["handoffs"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty())
    {
        records(dir)?
    } else {
        Vec::new()
    };
    let continuation = continuation::notice(b, observation, &history);
    let mut resolved = false;
    if continuation.is_object() {
        for d in &mut b.deliveries {
            if d.key == "terminal" && d.status == "pending" && d.continuation != continuation {
                d.continuation = continuation.clone();
                resolved = true;
            }
        }
    }
    if observation["state"] != "unconfirmed" {
        for d in &mut b.deliveries {
            if d.task_state == "interaction-required"
                && d.interaction.is_null()
                && d.status == "pending"
                && observation["state"] != "interaction-required"
            {
                d.status = "resolved".into();
                resolved = true;
            }
            if d.status == "pending" {
                if let Some(current) = observation["interaction"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|r| r["id"] == d.interaction["id"])
                {
                    if d.interaction != *current {
                        d.interaction = current.clone();
                        resolved = true;
                    }
                }
            }
            if !d.interaction.is_null()
                && d.interaction["resolved"] != true
                && !observation["interaction"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|r| r["id"] == d.interaction["id"])
            {
                d.interaction["resolved"] = json!(true);
                if d.status == "pending" {
                    d.status = "resolved".into();
                }
                resolved = true;
            }
        }
    }
    let previous_waiting = b.waiting.clone();
    let was_terminal = b.terminal;
    let suppress_empty = empty_answered_completion(b, observation);
    let mut events = transitions(b, observation);
    if suppress_empty {
        events.clear();
    }
    for handoff in observation["handoffs"].as_array().into_iter().flatten() {
        if handoff["from"] == "unheld"
            && handoff["to"] == "connector"
            && handoff["eventId"].is_string()
            && b.replacement_resume["requestId"].is_string()
            && b.replacement_resume["handoffEventId"].is_null()
            && chrono::DateTime::parse_from_rfc3339(string(handoff, "observedAt"))
                .ok()
                .zip(
                    chrono::DateTime::parse_from_rfc3339(string(
                        &b.replacement_resume,
                        "startedAt",
                    ))
                    .ok(),
                )
                .is_some_and(|(observed, started)| observed >= started)
        {
            // Consume exactly the acquisition caused by this replacement resume.
            // Retain the acquisition event even when the predecessor is terminal.
            b.replacement_resume["handoffEventId"] = handoff["eventId"].clone();
            resolved = true;
        }
        // Ownership observation already persisted history. Its enqueue cursor
        // advances even when an ended task needs no individual wakeup.
        if quiet_terminal(b) && b.replacement_resume["handoffEventId"] != handoff["eventId"] {
            continue;
        }

        let started = if b.scope_started_at == 0 {
            b.created_at.saturating_mul(1000)
        } else {
            b.scope_started_at
        };
        if chrono::DateTime::parse_from_rfc3339(string(handoff, "observedAt"))
            .ok()
            .is_none_or(|at| at.timestamp_millis() < started)
        {
            continue;
        }
        let key = format!("handoff:{}", string(handoff, "eventId"));
        let id = hash(json!([b.source_id, b.thread_id, key]).to_string());
        if !history
            .iter()
            .filter(|other| other.source_id == b.source_id)
            .any(|other| other.deliveries.iter().any(|d| d.event_id == id))
        {
            events.push((key, "handoff".into()));
        }
    }
    if events.is_empty() && b.waiting == previous_waiting && b.terminal == was_terminal && !resolved
    {
        if diagnostic_changed {
            persist(dir, b)?;
        }
        return Ok(());
    }
    let first = b.deliveries.len();
    for (key, state) in events {
        let handoff = key.starts_with("handoff:");
        b.deliveries.push(Delivery {
            subscription: String::new(),
            channel: b.channel,
            target: b.target.clone().unwrap_or_default(),
            event_id: if handoff {
                hash(json!([b.source_id, b.thread_id, key]).to_string())
            } else {
                hash(json!([b.agent, b.thread_id, b.turn_id, key]).to_string())
            },
            created_at: chrono::Utc::now().timestamp(),
            timing: DeliveryTiming {
                queued_at: Some(chrono::Utc::now().timestamp_millis()),
                ..Default::default()
            },
            batch: String::new(),
            attempted_at: 0,
            attempts: vec![],
            token_charged: false,
            failures: 0,
            next_attempt_at: 0,
            digest: false,
            error: None,
            final_response: if observation["state"] == "completed" {
                observation["finalResponse"].clone()
            } else {
                Value::Null
            },
            external_user_inputs: observation["externalUserInputs"].clone(),
            changes: observation["changes"].clone(),
            dispatches: if observation["dispatches"].is_null() {
                crate::dispatch_policy::records(&b.thread_id)
                    .map(|rows| json!(rows))
                    .unwrap_or(Value::Null)
            } else {
                observation["dispatches"].clone()
            },
            reconciliation: reconciliation.clone(),
            continuation: continuation.clone(),
            recovery: Value::Null,
            task_error: if handoff {
                observation["handoffs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|h| key == format!("handoff:{}", string(h, "eventId")))
                    .cloned()
                    .unwrap_or(Value::Null)
            } else if matches!(string(observation, "state"), "failed" | "cancelled") {
                observation["error"].clone()
            } else {
                Value::Null
            },
            interaction: observation["interaction"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|r| key == format!("request:{}", r["id"]))
                .cloned()
                .unwrap_or(Value::Null),
            key,
            state,
            task_state: if handoff {
                "handoff"
            } else {
                string(observation, "state")
            }
            .into(),
            status: if handoff { "inbox-only" } else { "pending" }.into(),
        });
    }
    routing::refresh(dir, b)?;
    // Append first: a crash between writes is reconciled by deterministic event IDs.
    for d in &b.deliveries[first..] {
        inbox_append(dir, &b.source_id, event(b, d))?;
    }
    if resolved {
        inbox_refresh(dir, b)?;
    }
    persist(dir, b)?;
    drop(guard);
    Ok(())
}

fn inbox_refresh(dir: &Path, b: &Binding) -> Result<()> {
    if !b.source_id.is_empty() {
        let path = inbox_path(dir, &b.source_id);
        if path.exists() {
            let mut rows = load(&path)?;
            for row in rows.as_array_mut().into_iter().flatten() {
                if let Some(d) = b.deliveries.iter().find(|d| row["eventId"] == d.event_id) {
                    let read = row["read"].clone();
                    let attached = row["attached"].clone();
                    let read_at = row["readAt"].clone();
                    *row = event(b, d);
                    if !attached.is_null() {
                        row["attached"] = attached;
                    }
                    if !read_at.is_null() {
                        row["readAt"] = read_at;
                    }
                    if !read.is_null() {
                        row["read"] = read;
                    }
                }
            }
            save(&path, &rows)?;
        }
    }
    Ok(())
}

fn inbox_path(dir: &Path, source_id: &str) -> PathBuf {
    dir.join("inboxes")
        .join(format!("{}.json", hash(source_id)))
}
static INBOX_CHANGED: tokio::sync::Notify = tokio::sync::Notify::const_new();

fn inbox_append(dir: &Path, source_id: &str, event: Value) -> Result<()> {
    if source_id.is_empty() {
        return Ok(());
    }
    let path = inbox_path(dir, source_id);
    let mut rows = if path.exists() {
        load(&path)?
    } else {
        json!([])
    };
    let rows = rows.as_array_mut().ok_or("INVALID_INBOX")?;
    if !rows.iter().any(|v| v["eventId"] == event["eventId"]) {
        rows.push(event);
        if rows.len() > 50 {
            rows.drain(..rows.len() - 50);
        }
        save(&path, &json!(rows))?;
        INBOX_CHANGED.notify_waiters();
    }
    Ok(())
}
pub(crate) async fn inbox(
    source_id: &str,
    reads: &[(String, String)],
    claude: bool,
    caller_target: Option<&str>,
) -> Result<Value> {
    let _guard = LOCK.lock().await;
    let caller_target = caller_target.and_then(|target| session_id(target).ok());
    let mut result = inbox_in(
        &directory(),
        source_id,
        reads,
        claude,
        caller_target.as_deref(),
    )?;
    binding_notices(&mut result, caller_target.as_deref());
    Ok(result)
}
fn binding_notices(result: &mut Value, caller_target: Option<&str>) {
    for event in result
        .get_mut("events")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if let Some(target) = event["target"].as_str() {
            let notice = match caller_target {
                Some(caller) if caller != target => "bound to another conversation",
                Some(_) => "bound to this conversation",
                None => "Conversation ownership needs verification. Only the target conversation may handle this.",
            };
            event["bindingNotice"] = json!(notice);
        }
    }
}

fn inbox_in(
    dir: &Path,
    source_id: &str,
    reads: &[(String, String)],
    claude: bool,
    caller_target: Option<&str>,
) -> Result<Value> {
    inbox_select(dir, source_id, reads, claude, caller_target, None)
}
fn inbox_select(
    dir: &Path,
    source_id: &str,
    reads: &[(String, String)],
    claude: bool,
    caller_target: Option<&str>,
    filters: Option<&Value>,
) -> Result<Value> {
    let path = inbox_path(dir, source_id);
    if !path.exists() {
        return Ok(Value::Null);
    }
    let mut rows = load(&path)?;
    let bindings = records(dir)?;
    let mut state = State::load(dir)?;
    let now = chrono::Utc::now().timestamp();
    // An MCP principal can span chats. Active subscriptions deliver to their
    // exact callbacks; do not also leak these events through a shared inbox.
    let origin = crate::kernel::origin::current_origin();
    let subscribed = state.subscriptions.iter().any(|s| {
        s.source_id == source_id
            && s.channel == Channel::McpEvents
            && s.active(now.saturating_mul(1000))
            && s.webhook
                .as_ref()
                .is_some_and(|w| origin["eventPrincipal"] == w.principal)
    });
    let mut acknowledged = false;
    let mut events = Vec::new();
    let mut unread = 0;
    let mut repeated = Vec::new();
    for row in rows.as_array_mut().ok_or("INVALID_INBOX")? {
        let bound = bindings.iter().find(|b| {
            b.source_id == source_id
                && b.turn_id == string(row, "turnId")
                && (row["threadId"] == b.thread_id || row["taskId"] == b.thread_id)
        });
        if let Some(b) = bound {
            if row["interaction"].is_object() && row["interaction"]["resolved"] != true {
                let agent = if b.agent.is_empty() {
                    "codex"
                } else {
                    &b.agent
                };
                routing::observe_in(dir, agent, &b.thread_id, &mut row["interaction"])?;
                row["routing"] = row["interaction"]["routing"].clone();
                row["questionSummary"] = crate::egress::interaction_preview(&row["interaction"]);
            }
            row["target"] = json!(b.target);
            row["channel"] = json!(b.channel);
        }
        if row["read"] != true
            && reads.iter().any(|(task, turn)| {
                (row["threadId"] == *task || row["taskId"] == *task) && row["turnId"] == *turn
            })
        {
            row["read"] = json!(true);
            row["readAt"] = json!(now);
            if let Some(b) = bound {
                state.thread(b, now).last_ack_at = Some(now);
                acknowledged = true;
            }
        }
        if row["read"] == true {
            continue;
        }
        if (claude
            && caller_target
                .is_none_or(|target| row["channel"] != "claude-session" || row["target"] != target))
            || (!claude && subscribed)
        {
            continue;
        }
        if let Some(filters) = filters {
            let threads = filters["threadIds"].as_array();
            let tasks = filters["taskIds"].as_array();
            if (threads.is_some() || tasks.is_some())
                && !threads.is_some_and(|ids| ids.contains(&row["threadId"]))
                && !tasks.is_some_and(|ids| ids.contains(&row["taskId"]))
            {
                continue;
            }
            if filters["eventTypes"]
                .as_array()
                .is_some_and(|types| !types.contains(&row["kind"]))
            {
                continue;
            }
        }
        // Only Claude-owned source events with an actual session binding change behavior.
        // Looking up existing records also suppresses pre-upgrade delivered events.
        let delivery = bindings
            .iter()
            .filter(|b| b.source_id == source_id)
            .flat_map(|b| &b.deliveries)
            .find(|d| {
                row["eventId"] == d.event_id
                    && d.channel == Channel::ClaudeSession
                    && !d.target.is_empty()
            });
        let incremental =
            filters.is_none() && claude && (delivery.is_some() || row["attached"] == true);
        if incremental
            && (row["attached"] == true
                || delivery.is_some_and(|d| matches!(d.status.as_str(), "delivered" | "resolved")))
        {
            row["attached"] = json!(true);
            continue;
        }
        unread += 1;
        let mut visible = row.clone();
        visible.as_object_mut().unwrap().remove("attached");
        visible.as_object_mut().unwrap().remove("attachedHash");
        let fingerprint = hash(visible.to_string());
        if filters.is_none() && !claude && row["attachedHash"] == fingerprint {
            if repeated.len() < 5 {
                repeated.push(json!({"eventId":row["eventId"],"kind":row["kind"],"threadId":row["threadId"],"taskId":row["taskId"],"turnId":row["turnId"]}));
            }
            continue;
        }
        if events.len() < 5 {
            if filters.is_none() {
                row["attachedHash"] = json!(fingerprint);
            }
            if incremental {
                row["attached"] = json!(true);
            }
            let mut event = row.clone();
            event.as_object_mut().unwrap().remove("attached");
            event.as_object_mut().unwrap().remove("attachedHash");
            events.push(event);
        }
    }
    if filters.is_none() {
        save(&path, &rows)?;
    }
    if acknowledged {
        state.save(dir)?;
    }
    Ok(if events.is_empty() && repeated.is_empty() {
        Value::Null
    } else {
        json!({"unread":unread,"events":events,"unchangedEvents":repeated,"next":{"via":"query","op":"inbox_wait","args":{"timeoutMs":0},"hint":"Explicit inbox_wait returns complete unread events without acknowledging them."}})
    })
}
/// Explicit inbox polling never attaches or acknowledges an event. Existing
/// source/session/subscription visibility remains shared with arcInbox.
pub(crate) async fn inbox_wait(
    control: &Arc<crate::control::Control>,
    args: &Value,
) -> Result<Value> {
    let origin = crate::kernel::origin::current_origin();
    let source_id = string(&origin, "sourceId");
    if source_id.is_empty() {
        return Err("SOURCE_REQUIRED".into());
    }
    let target = args["target"].as_str().map(session_id).transpose()?;
    let mut shutdown = control.shutdown.subscribe();
    let started = tokio::time::Instant::now();
    let deadline = started + Duration::from_millis(args["timeoutMs"].as_u64().unwrap_or(30000));
    loop {
        let changed = INBOX_CHANGED.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        let mut inbox = {
            let _guard = LOCK.lock().await;
            inbox_select(
                &directory(),
                source_id,
                &[],
                origin["controlSource"] == "claude",
                target.as_deref(),
                Some(args),
            )?
        };
        binding_notices(&mut inbox, target.as_deref());
        if !inbox.is_null() {
            return Ok(
                json!({"state":"events","events":inbox["events"],"unread":inbox["unread"],"elapsedMs":started.elapsed().as_millis() as u64}),
            );
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(
                json!({"state":"timeout","events":[],"unread":0,"elapsedMs":started.elapsed().as_millis() as u64,"next":{"via":"query","op":"inbox_wait","args":args,"hint":"Continue waiting with the same filters; read a task or use notification_ack after handling its events."}}),
            );
        }
        tokio::select! {
            _ = shutdown.changed() => return Ok(json!({"state":"unconfirmed","reason":"connector-shutdown","events":[],"unread":0})),
            _ = changed => {},
            _ = tokio::time::sleep_until(deadline.min(tokio::time::Instant::now()+Duration::from_secs(1))) => {},
        }
    }
}

pub(crate) async fn acknowledge(args: &Value) -> Result<Value> {
    let source_id = string(&crate::kernel::origin::current_origin(), "sourceId").to_owned();
    if source_id.is_empty() {
        return Err("SOURCE_REQUIRED".into());
    }
    let _guard = LOCK.lock().await;
    let result = acknowledge_in(&directory(), &source_id, args)?;
    if result["reachability"] == "verified" {
        sync_src_conversation(&source_id, string(&result, "target"), true)?;
    }
    Ok(result)
}
fn acknowledge_in(dir: &Path, source_id: &str, args: &Value) -> Result<Value> {
    if args.get("code").is_some() {
        return reachability::acknowledge(dir, source_id, args);
    }
    let path = inbox_path(dir, source_id);
    let mut rows = if path.exists() {
        load(&path)?
    } else {
        json!([])
    };
    let bindings = records(dir)?;
    let mut state = State::load(dir)?;
    let now = chrono::Utc::now().timestamp();
    let ids: std::collections::BTreeSet<String> = if args["all"] == true {
        rows.as_array()
            .ok_or("INVALID_INBOX")?
            .iter()
            .filter_map(|r| r["eventId"].as_str().map(str::to_owned))
            .collect()
    } else {
        args["eventIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect()
    };
    let (mut marked, mut already) = (0, 0);
    let mut missing = Vec::new();
    for id in ids {
        let bound = bindings
            .iter()
            .filter(|b| b.source_id == source_id)
            .find_map(|b| {
                b.deliveries
                    .iter()
                    .find(|d| d.event_id == id)
                    .map(|d| (b, d))
            });
        let index = rows
            .as_array()
            .unwrap()
            .iter()
            .position(|r| r["eventId"] == id);
        if index.is_none() && bound.is_none() {
            missing.push(id);
            continue;
        }
        let read = index.is_some_and(|i| rows[i]["read"] == true)
            || bound.is_some_and(|(_, d)| {
                matches!(d.status.as_str(), "delivered" | "digested" | "resolved")
            });
        if read {
            already += 1;
        } else {
            marked += 1;
        }
        let index = index.unwrap_or_else(|| {
            let (b, d) = bound.unwrap();
            rows.as_array_mut().unwrap().push(event(b, d));
            rows.as_array().unwrap().len() - 1
        });
        rows[index]["read"] = json!(true);
        rows[index]["readAt"] = json!(now);
        if let Some((b, _)) = bound {
            state.thread(b, now).last_ack_at = Some(now);
        }
    }
    save(&path, &rows)?;
    state.save(dir)?;
    Ok(
        json!({"markedRead":marked,"alreadyRead":already,"notFound":missing.len(),"notFoundEventIds":missing}),
    )
}

// An old Desktop callback is eligible only if this source was actually given it.
// The Desktop owner still freshly verifies the request before applying any answer.
pub(crate) fn recoverable_response(key: &str, session: &str) -> Result<bool> {
    let origin = crate::kernel::origin::current_origin();
    recoverable_response_in(&directory(), string(&origin, "sourceId"), key, session)
}
fn recoverable_response_in(dir: &Path, source_id: &str, key: &str, session: &str) -> Result<bool> {
    Ok(!source_id.is_empty()
        && records(dir)?
            .iter()
            .filter(|b| b.source_id == source_id)
            .any(|b| {
                b.deliveries.iter().any(|d| {
                    d.interaction["owner"] == "desktop"
                        && d.interaction["id"] == key
                        && d.interaction["backendSession"] == session
                })
            }))
}

fn records(dir: &Path) -> Result<Vec<Binding>> {
    matching_records(dir, |_| true)
}
fn matching_records(dir: &Path, matches: impl Fn(&Binding) -> bool) -> Result<Vec<Binding>> {
    Ok(shared_records(dir)?
        .into_iter()
        .filter(|binding| matches(binding))
        .map(|binding| (*binding).clone())
        .collect())
}
fn shared_records(dir: &Path) -> Result<Vec<Arc<Binding>>> {
    // Bindings are owned by Core and atomically replaced. A directory stamp can
    // reuse the parsed collection across nested routing/ownership queries.
    type Snapshot = (PathBuf, file_cache::Projection<Vec<Arc<Binding>>>);
    static SNAPSHOT: std::sync::LazyLock<std::sync::Mutex<Option<Snapshot>>> =
        std::sync::LazyLock::new(Default::default);
    let dependencies = [dir.join("tasks")];
    let mut snapshot = SNAPSHOT.lock().map_err(|e| e.to_string())?;
    if snapshot.as_ref().is_none_or(|(path, _)| path != dir) {
        *snapshot = Some((dir.into(), Default::default()));
    }
    let snapshot = &mut snapshot.as_mut().unwrap().1;
    let stamps = file_cache::Projection::<Vec<Arc<Binding>>>::stamps(&dependencies)?;
    let bindings = if let Some(bindings) = snapshot.get(&stamps) {
        bindings
    } else {
        let mut bindings = Vec::new();
        for entry in binding_paths(dir)?
            .iter()
            .filter(|entry| entry.path.extension().is_some_and(|v| v == "json"))
        {
            if let Some(binding) = shared_binding(&entry.path)? {
                bindings.push(binding);
            }
        }
        snapshot.set(&dependencies, stamps, bindings.clone())?;
        bindings
    };
    Ok(bindings)
}

pub(crate) fn settings() -> Result<Value> {
    let path = root().join("task-settings.json");
    let mut settings = if path.exists() {
        load(&path)?
    } else {
        json!({})
    };
    // One-time rename. The old default becomes the new default; custom positive
    // values become burst capacity. Zero maps to the existing global switch.
    let migrated = settings
        .as_object_mut()
        .and_then(|s| s.remove("notificationWakeLimit"));
    if let Some(old) = &migrated {
        if settings["notificationBucketCapacity"].is_null() {
            settings["notificationBucketCapacity"] = json!(match old.as_u64() {
                Some(n) if n > 0 && n != 20 => n.min(1000),
                _ => 10,
            });
        }
        if old == 0 {
            settings["notificationsEnabled"] = json!(false);
        }
    }
    for (key, value) in [
        ("enabled", json!(false)),
        ("autoOpenCodex", json!(!cfg!(target_os = "linux"))),
        ("notificationsEnabled", json!(true)),
        ("requestRoutingDelaySeconds", json!(15)),
        ("notificationBucketCapacity", json!(10)),
        ("notificationRefillSeconds", json!(60)),
        ("notificationEscalationSeconds", json!(900)),
        ("codexRetryMaxAttempts", json!(3)),
        ("codexRetryInitialSeconds", json!(30)),
    ] {
        if settings[key].is_null() {
            settings[key] = value;
        }
    }
    if migrated.is_some() {
        save(&path, &settings)?;
    }
    Ok(settings)
}

fn wakes(d: &Delivery) -> bool {
    matches!(
        d.task_state.as_str(),
        "completed" | "failed" | "cancelled" | "interrupted" | "interaction-required"
    )
}

fn queued(d: &mut Delivery, reason: &str) {
    if d.timing.queue_reason.as_deref() != Some(reason) {
        d.timing.queue_reason = Some(reason.into());
        #[cfg(not(test))]
        crate::logs::record(
            "INFO",
            &format!("Notification queued: event={} reason={reason}", d.event_id),
            None,
        );
    }
}
// One target bucket and one scheduling path for every kind. Retried events have
// already paid; new events join a retry only when a token is available for them.
async fn flush(
    executor: &impl Executor,
    dir: &Path,
    lock: &Mutex<()>,
    now: i64,
    window: i64,
    settings: &Value,
) -> Result<()> {
    let _scope =
        crate::runtime_metrics::Scope::new(crate::runtime_metrics::Work::NotificationDelivery);
    let _operation = mcp_events::OPERATION.lock().await;
    let guard = lock.lock().await;
    let original = shared_records(dir)?;
    let mut all: Vec<_> = original.iter().map(|binding| (**binding).clone()).collect();
    let mut state = State::load(dir)?;
    subscriptions::sync(&mut state, &all);
    state
        .subscriptions
        .retain(|s| s.active(now.saturating_mul(1000)));
    for s in &mut state.subscriptions {
        if let Some(w) = &mut s.webhook {
            if w.rotate_until <= now {
                w.previous_secret = None;
            }
        }
    }
    let continuations = all
        .iter()
        .map(|b| {
            if b.deliveries
                .iter()
                .any(|d| d.key == "terminal" && d.status == "pending")
            {
                continuation::notice(b, &Value::Null, &all)
            } else {
                Value::Null
            }
        })
        .collect::<Vec<_>>();
    for (b, continuation) in all.iter_mut().zip(continuations) {
        let mut changed = false;
        for d in &mut b.deliveries {
            if matches!(d.status.as_str(), "pending" | "sending") && !wakes(d) {
                d.status = "inbox-only".into();
                changed = true;
            }
            if d.task_state == "cancelled" && d.status == "pending" && b.scope_end.is_some() {
                d.status = "resolved".into();
                queued(d, "superseded");
                changed = true;
            }
            if d.key == "terminal"
                && d.status == "pending"
                && continuation.is_object()
                && (continuation["state"] != "unknown" || !d.continuation.is_object())
            {
                changed |= d.continuation != continuation;
                d.continuation = continuation.clone();
                if d.task_state == "cancelled" && continuation["state"] != "unknown" {
                    d.status = "resolved".into();
                    queued(d, "superseded");
                    changed = true;
                }
            }
        }
        if changed {
            inbox_refresh(dir, b)?;
        }
        routing::refresh(dir, b)?;
    }
    // Keep interruptions pending while their automatic resume is undecided.
    // A failed or skipped resume releases the original task-failure event.
    let replacement = if all.iter().any(|b| {
        b.deliveries
            .iter()
            .any(|d| d.task_state == "cancelled" && d.status == "pending")
    }) {
        crate::app_replace::status().unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    subscriptions::route(&state, &mut all, now);
    let mut targets = Vec::new();
    for b in &mut all {
        if let Some(rule) = state.rule(b) {
            governance::apply_rebind(b, rule);
        }
        for d in &b.deliveries {
            if d.status == "pending"
                && !targets.contains(&(b.source_id.clone(), d.channel, d.target.clone()))
            {
                targets.push((b.source_id.clone(), d.channel, d.target.clone()));
            }
        }
    }
    for t in &state.targets {
        if !targets.contains(&(t.source_id.clone(), t.channel, t.target.clone())) {
            targets.push((t.source_id.clone(), t.channel, t.target.clone()));
        }
    }
    let mut batches = Vec::new();
    let mut alerts = Vec::new();
    for (source_id, channel, target) in targets {
        if source_id.is_empty() {
            continue;
        }
        if crate::sources::get(&source_id).is_ok_and(|s| s["state"] == "revoked") {
            continue;
        }
        let (breaker, tokens) = {
            let t = state.target(&source_id, channel, &target, now, settings);
            (t.breaker, t.tokens)
        };
        let mut eligible = Vec::new();
        for (bi, b) in all.iter_mut().enumerate() {
            if b.source_id != source_id {
                continue;
            }
            let rule = state.rule(b);
            let mode = rule.map(|r| r.mode(now)).unwrap_or("normal");
            let digest_due = rule.is_some_and(|r| now.saturating_sub(r.digest_at) >= 3600);
            for (di, d) in b.deliveries.iter_mut().enumerate() {
                if d.status != "pending"
                    || d.channel != channel
                    || d.target != target
                    || routing::held(d)
                {
                    continue;
                }
                if d.task_state == "cancelled" {
                    if let Some(row) = recovery::interrupted_turn(
                        b.thread_id.as_str(),
                        b.turn_id.as_str(),
                        &b.agent,
                        &replacement,
                    ) {
                        if recovery::resumed(row) {
                            d.status = "inbox-only".into();
                            continue;
                        }
                        if recovery::resume_pending(row)
                            || (!matches!(
                                string(&replacement, "state"),
                                "succeeded" | "rolled-back" | "failed" | "cancelled"
                            ) && matches!(
                                string(row, "state"),
                                "recorded" | "submitting" | "explicit-continuation"
                            ))
                        {
                            queued(d, "automatic-resume");
                            continue;
                        }
                    }
                }
                let reason = if settings["notificationsEnabled"] == false {
                    Some("disabled")
                } else if target.is_empty() {
                    Some("unbound")
                } else if state
                    .subscriptions
                    .iter()
                    .find(|s| s.id == d.subscription)
                    .is_some_and(|s| s.muted(now))
                {
                    Some("subscription-muted")
                } else if !d.subscription.is_empty()
                    && !state.subscriptions.iter().any(|s| s.id == d.subscription)
                {
                    Some("subscription-ended")
                } else if breaker {
                    Some("breaker")
                } else if mode == "mute" {
                    Some("muted")
                } else if mode == "digest" && !digest_due && !d.digest {
                    Some("digest-wait")
                } else if d.next_attempt_at != 0 && now <= d.next_attempt_at {
                    Some("retry-backoff")
                } else {
                    None
                };
                if let Some(reason) = reason {
                    queued(d, reason);
                    if reason == "subscription-ended" {
                        d.status = "failed".into();
                        d.error = Some(reason.into());
                    }
                } else {
                    eligible.push((bi, di, mode == "digest"));
                }
            }
        }
        // Debounce short bursts for two quiet seconds; the original window
        // still bounds a continuously arriving batch.
        let quiet = eligible
            .iter()
            .map(|(bi, di, _)| all[*bi].deliveries[*di].created_at)
            .max()
            .is_some_and(|last| now.saturating_sub(last) >= window.min(2));
        let window_ready = quiet
            || eligible.iter().any(|(bi, di, digest)| {
                let d = &all[*bi].deliveries[*di];
                channel == Channel::McpEvents
                    || *digest
                    || d.urgent()
                    || d.token_charged
                    || now.saturating_sub(d.created_at) >= window
                    || d.timing.queue_reason.as_deref() == Some("token-wait")
            });
        let waiting = window_ready
            && eligible
                .iter()
                .any(|(bi, di, _)| !all[*bi].deliveries[*di].token_charged)
            && tokens == 0;
        if settings["notificationsEnabled"] != false {
            let t = state.target(&source_id, channel, &target, now, settings);
            if let Some(reason) = t.anomaly(now, waiting, settings) {
                let threads = all
                    .iter()
                    .filter(|b| {
                        b.source_id == source_id
                            && b.channel == channel
                            && b.target.as_deref() == Some(&target)
                    })
                    .map(|b| b.thread_id.clone())
                    .collect::<std::collections::BTreeSet<_>>();
                let pending = all
                    .iter()
                    .filter(|b| b.source_id == source_id)
                    .flat_map(|b| &b.deliveries)
                    .filter(|d| d.channel == channel && d.target == target && d.status == "pending")
                    .count();
                alerts.push((source_id.clone(),channel,target.clone(),format!("{RECEIPT_HEADER}\nTarget {target}. Reason: {reason}. Pending deliveries: {pending}. Threads: {}. Read ARC notify_status.",threads.into_iter().collect::<Vec<_>>().join(", "))));
            }
        }
        let mut selected = Vec::new();
        for (bi, di, digest) in eligible {
            let d = &mut all[bi].deliveries[di];
            if !window_ready {
                queued(d, "batch-window");
                continue;
            }
            if !d.token_charged && tokens == 0 {
                queued(d, "token-wait");
                continue;
            }
            if channel == Channel::McpEvents && !selected.is_empty() {
                if digest {
                    d.digest = true;
                }
                continue;
            }
            selected.push((bi, di, digest));
        }
        if selected.is_empty() {
            continue;
        }
        let charged = selected
            .iter()
            .any(|(bi, di, _)| !all[*bi].deliveries[*di].token_charged);
        let batch = id();
        let mut kinds = std::collections::BTreeMap::new();
        let mut thread_ids = std::collections::BTreeSet::new();
        for (bi, di, _) in &selected {
            let b = &all[*bi];
            *kinds
                .entry(string(&event(b, &b.deliveries[*di]), "kind").to_owned())
                .or_insert(0) += 1;
            thread_ids.insert(b.thread_id.clone());
        }
        {
            let t = state.target(&source_id, channel, &target, now, settings);
            if charged {
                t.charge(now, settings);
            }
            t.batches.push(governance::Batch {
                id: batch.clone(),
                at: now,
                kinds,
                threads: thread_ids.into_iter().collect(),
                status: "sending".into(),
                charged,
            });
        }
        let mut reserved = Vec::<Binding>::new();
        let mut blocks = Vec::new();
        for (bi, di, digest) in &selected {
            let b = &mut all[*bi];
            let d = &mut b.deliveries[*di];
            d.status = "sending".into();
            d.error = None;
            d.token_charged = true;
            d.digest = *digest;
            d.attempts
                .retain(|(_, time)| *time > now.saturating_sub(3600));
            if !d.batch.is_empty() {
                d.attempts.push((d.batch.clone(), d.attempted_at));
            }
            d.batch = batch.clone();
            d.attempted_at = now;
            let mut single = b.clone();
            single.deliveries = vec![b.deliveries[*di].clone()];
            single.channel = channel;
            single.target = Some(target.clone());
            blocks.push(message(&single));
            if let Some(r) = reserved
                .iter_mut()
                .find(|r| r.thread_id == b.thread_id && r.turn_id == b.turn_id)
            {
                r.deliveries.push(b.deliveries[*di].clone());
            } else {
                reserved.push(single);
            }
        }
        batches.push((reserved, blocks.join("\n\n")));
    }
    // Charge before reserving event records: a crash may lose one token, but
    // never duplicates an event or permits an uncharged burst after restart.
    state.save(dir)?;
    for (b, old) in all.iter().zip(original) {
        if b != old.as_ref() {
            persist(dir, b)?;
        }
    }
    drop(guard);
    for (source_id, channel, target, body) in alerts {
        if let Err(error) = executor.escalate(body).await {
            let _guard = lock.lock().await;
            let mut state = State::load(dir)?;
            state
                .target(&source_id, channel, &target, now, settings)
                .escalation_error = Some(error.clone());
            state.save(dir)?;
            #[cfg(not(test))]
            crate::logs::record(
                "WARN",
                &format!("Notification escalation failed: {error}"),
                None,
            );
        }
    }
    for (mut batch, mut body) in batches {
        let started_at = chrono::Utc::now().timestamp_millis();
        {
            let _guard = lock.lock().await;
            let mut state = State::load(dir)?;
            // Another destination can take time to send. Recheck a reserved
            // interruption against successor evidence immediately before transport.
            if batch
                .iter()
                .flat_map(|b| &b.deliveries)
                .any(|d| d.task_state == "cancelled")
            {
                let latest = records(dir)?;
                let batch_id = batch[0].deliveries[0].batch.clone();
                for reserved in &mut batch {
                    if let Some(mut current) = latest
                        .iter()
                        .find(|b| {
                            b.thread_id == reserved.thread_id && b.turn_id == reserved.turn_id
                        })
                        .cloned()
                    {
                        let continuation = continuation::notice(&current, &Value::Null, &latest);
                        if current.scope_end.is_some()
                            || (continuation.is_object() && continuation["state"] != "unknown")
                        {
                            for d in &mut current.deliveries {
                                if d.batch == batch_id
                                    && d.status == "sending"
                                    && d.task_state == "cancelled"
                                {
                                    if continuation.is_object() {
                                        d.continuation = continuation.clone();
                                    }
                                    d.status = "resolved".into();
                                    queued(d, "superseded");
                                }
                            }
                            inbox_refresh(dir, &current)?;
                            persist(dir, &current)?;
                            reserved.deliveries.retain(|d| {
                                current.deliveries.iter().any(|c| {
                                    c.event_id == d.event_id
                                        && c.subscription == d.subscription
                                        && c.status == "sending"
                                })
                            });
                        }
                    }
                }
                batch.retain(|b| !b.deliveries.is_empty());
                if batch.is_empty() {
                    for record in state
                        .targets
                        .iter_mut()
                        .flat_map(|t| &mut t.batches)
                        .filter(|r| r.id == batch_id)
                    {
                        record.status = "cancelled".into();
                    }
                    state.save(dir)?;
                    continue;
                }
                body = batch.iter().map(message).collect::<Vec<_>>().join("\n\n");
            }
            let breaker = state.targets.iter().any(|t| {
                t.source_id == batch[0].source_id
                    && t.channel == batch[0].channel
                    && Some(t.target.as_str()) == batch[0].target.as_deref()
                    && t.breaker
            });
            let mut current_batch = Vec::new();
            let mut deferred = breaker;
            for reserved in &batch {
                if let Some(current) = binding(dir, &reserved.thread_id, &reserved.turn_id)? {
                    let mode = state
                        .rule(&current)
                        .map(|r| r.mode(chrono::Utc::now().timestamp()))
                        .unwrap_or("normal");
                    deferred |= (reserved.channel == Channel::ClaudeSession
                        && (current.target != reserved.target
                            || current.channel != reserved.channel))
                        || !state.subscriptions.iter().any(|s| {
                            s.id == reserved.deliveries[0].subscription
                                && s.active(chrono::Utc::now().timestamp_millis())
                                && !s.muted(chrono::Utc::now().timestamp())
                        })
                        || mode == "mute"
                        || (mode == "digest" && reserved.deliveries.iter().any(|d| !d.digest));
                    current_batch.push(current);
                }
            }
            if deferred {
                for mut current in current_batch {
                    for d in &mut current.deliveries {
                        if d.batch == batch[0].deliveries[0].batch && d.status == "sending" {
                            d.status = "pending".into();
                            queued(
                                d,
                                if breaker {
                                    "breaker"
                                } else {
                                    "control-changed"
                                },
                            );
                        }
                    }
                    if let Some(rule) = state.rule(&current) {
                        governance::apply_rebind(&mut current, rule);
                    }
                    persist(dir, &current)?;
                }
                for t in &mut state.targets {
                    for record in &mut t.batches {
                        if record.id == batch[0].deliveries[0].batch {
                            record.status = "cancelled".into();
                        }
                    }
                }
                state.save(dir)?;
                continue;
            }
            for reserved in &batch {
                if let Some(mut current) = binding(dir, &reserved.thread_id, &reserved.turn_id)? {
                    for d in &mut current.deliveries {
                        if d.batch == reserved.deliveries[0].batch && d.status == "sending" {
                            let queued_at = *d
                                .timing
                                .queued_at
                                .get_or_insert(d.created_at.saturating_mul(1000));
                            d.timing.started_at = Some(started_at);
                            d.timing.finished_at = None;
                            d.timing.send_ms = None;
                            d.timing.queue_ms = Some(started_at.saturating_sub(queued_at).max(0));
                        }
                    }
                    persist(dir, &current)?;
                }
            }
        }
        let started = std::time::Instant::now();
        let outcome = if batch[0].channel == Channel::McpEvents {
            let sub = {
                let _guard = lock.lock().await;
                State::load(dir)?
                    .subscriptions
                    .into_iter()
                    .find(|s| s.id == batch[0].deliveries[0].subscription)
            };
            match sub {
                Some(sub) => {
                    executor
                        .webhook(&sub, &batch[0], &batch[0].deliveries[0])
                        .await
                }
                None => SendOutcome::failed("subscription-ended", false),
            }
        } else {
            match deliver_message(executor, &batch[0], &body).await {
                "delivered" => SendOutcome::success("delivered"),
                _ => SendOutcome::failed("delivery-failed-or-unconfirmed", true),
            }
        };
        let status = outcome.status;
        let send_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        let finished_at = chrono::Utc::now().timestamp_millis();
        let _guard = lock.lock().await;
        let mut state = State::load(dir)?;
        if outcome.remove_subscription {
            state
                .subscriptions
                .retain(|s| s.id != batch[0].deliveries[0].subscription);
        }
        if let Some(t) = state.targets.iter_mut().find(|t| {
            t.source_id == batch[0].source_id
                && t.channel == batch[0].channel
                && Some(t.target.as_str()) == batch[0].target.as_deref()
        }) {
            // Delivery failures remain on the batch/event. A transient transport
            // failure does not revoke a completed source/account handshake.
            if let Some(record) = t
                .batches
                .iter_mut()
                .find(|b| b.id == batch[0].deliveries[0].batch)
            {
                record.status = status.into();
            }
        }
        for reserved in batch {
            if let Some(mut current) = binding(dir, &reserved.thread_id, &reserved.turn_id)? {
                let mut digested = false;
                let mut delivered = false;
                for d in &mut current.deliveries {
                    if d.batch == reserved.deliveries[0].batch && d.status == "sending" {
                        d.timing.finished_at = Some(finished_at);
                        d.timing.send_ms = Some(send_ms);
                        if status == "failed" {
                            d.failures = d.failures.saturating_add(1);
                            let retry = outcome.retry && d.failures < 6;
                            d.status = if retry { "pending" } else { "failed" }.into();
                            d.next_attempt_at = if retry {
                                now.saturating_add((send_ms / 1000) as i64)
                                    .saturating_add(governance::retry_seconds(d.failures))
                            } else {
                                0
                            };
                            d.error = outcome.error.clone();
                        } else {
                            d.status = if d.channel == Channel::McpEvents {
                                "callback-accepted"
                            } else if d.digest {
                                "digested"
                            } else {
                                "delivered"
                            }
                            .into();
                            delivered = true;
                            digested |= d.digest;
                            d.next_attempt_at = 0;
                        }
                        #[cfg(not(test))] crate::logs::record("INFO",&format!("Notification delivery: event={} status={status} queueMs={} sendMs={send_ms} queueReason={}",d.event_id,d.timing.queue_ms.unwrap_or(0),d.timing.queue_reason.as_deref().unwrap_or("none")),None);
                    }
                }
                if delivered {
                    let rule = state.thread(&current, now);
                    rule.last_delivered_at = Some(finished_at / 1000);
                    if digested {
                        rule.digest_at = now;
                    }
                }
                // A rebind made during a send governs its retry, never rewrites
                // the successful delivery to the previous target.
                if let Some(rule) = state.rule(&current) {
                    governance::apply_rebind(&mut current, rule);
                }
                persist(dir, &current)?;
            }
        }
        state.save(dir)?;
    }
    Ok(())
}

pub(crate) async fn migrate() -> Result<()> {
    let _guard = LOCK.lock().await;
    settings()?;
    let dir = directory();
    std::fs::create_dir_all(dir.join("tasks")).map_err(|e| e.to_string())?;
    // Write destinations first. Re-running after a crash never replaces migrated state.
    let old_tasks = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|v| v == "json"))
        .map(|e| e.path())
        .collect::<Vec<_>>();
    for path in &old_tasks {
        let Some(b) = read_binding(path)? else {
            continue;
        };
        if !path_in(&dir, &b.thread_id, &b.turn_id).exists() {
            persist(&dir, &b)?;
        }
    }
    let old_control = dir.join("control/state.json");
    let new_control = dir.join("subscriptions/state.json");
    let mut state = if !new_control.exists() && old_control.exists() {
        State::decode(load(&old_control)?)?
    } else {
        State::load(&dir)?
    };
    let old_events = dir.join("mcp-events/state.json");
    let mut all = records(&dir)?;
    if old_events.exists() {
        let old = load(&old_events)?;
        for row in old["deliveries"].as_array().into_iter().flatten() {
            let thread = string(row, "thread");
            let turn = string(&row["body"]["data"], "turnId");
            if let Some(b) = all
                .iter_mut()
                .find(|b| b.thread_id == thread && b.turn_id == turn)
            {
                let event_id = string(&row["body"], "eventId");
                let sub = string(row, "subscription");
                if b.deliveries
                    .iter()
                    .any(|d| d.subscription == sub && d.event_id == event_id)
                {
                    continue;
                }
                if let Some(source) = b.deliveries.iter().find(|d| d.event_id == event_id) {
                    let mut d = source.clone();
                    d.subscription = sub.into();
                    d.channel = Channel::McpEvents;
                    d.target = sub.into();
                    d.status = if matches!(string(row, "status"), "pending" | "sending") {
                        "subscription-ended"
                    } else {
                        string(row, "status")
                    }
                    .into();
                    d.error = row["error"].as_str().map(str::to_owned);
                    d.token_charged = row["charged"] == true;
                    let attempts = row["attempts"].as_u64().unwrap_or(0) as u32;
                    d.failures =
                        attempts.saturating_sub(u32::from(d.status == "callback-accepted"));
                    d.next_attempt_at = 0;
                    let Ok(timing) = serde_json::from_value(row["timing"].clone()) else {
                        crate::logs::record(
                            "WARN",
                            "Ignored malformed legacy notification delivery",
                            None,
                        );
                        continue;
                    };
                    d.timing = timing;
                    b.deliveries.push(d);
                }
            }
        }
    }
    // Convert owned display labels in persisted records. User payloads and stable
    // delivery keys are deliberately untouched, including Chinese user input.
    for b in &mut all {
        for label in b
            .waiting
            .iter_mut()
            .chain(b.deliveries.iter_mut().map(|d| &mut d.state))
        {
            let translated = match label.as_str() {
                "完成" => "completed",
                "失败" => "failed",
                "中断" => "interrupted",
                "等待输入" => "waiting for input",
                "等待审批" => "waiting for approval",
                _ => continue,
            };
            *label = translated.into();
        }
    }
    // Older targets have no handshake. Preserve known failures without treating a
    // historical successful send as controller acknowledgement.
    let settings = settings()?;
    for b in &all {
        if b.source_id.is_empty() {
            continue;
        }
        for d in &b.deliveries {
            if !d.target.is_empty() && d.failures > 0 {
                let t = state.target(
                    &b.source_id,
                    d.channel,
                    &d.target,
                    chrono::Utc::now().timestamp(),
                    &settings,
                );
                if t.reachability.reason == "handshake-required" {
                    t.reachability.fail("delivery-failed");
                }
            }
        }
    }
    subscriptions::sync(&mut state, &all);
    // Populate stable IDs without creating any subscription to the retired event name.
    subscriptions::route(&state, &mut all, chrono::Utc::now().timestamp());
    for b in &all {
        if b.channel == Channel::ClaudeSession {
            if let Some(target) = &b.target {
                state.target(
                    &b.source_id,
                    Channel::ClaudeSession,
                    target,
                    chrono::Utc::now().timestamp(),
                    &settings,
                );
            }
        }
    }
    let legacy_routes = crate::accounts::claude::routing::list()?;
    for t in &mut state.targets {
        if t.channel == Channel::ClaudeSession && t.account_id.is_none() {
            t.account_id = legacy_routes.get(&t.target).cloned();
            if t.account_id.is_none() && t.reachability.state == "verified" {
                // Keep already verified pre-route destinations pinned to their original profile.
                t.account_id = crate::accounts::claude::routing::legacy_account(&t.target).ok();
            }
        }
    }
    state.save(&dir)?;
    for b in &all {
        persist(&dir, b)?;
    }
    for path in old_tasks.into_iter().chain([old_control, old_events]) {
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    for name in ["control", "mcp-events"] {
        let p = dir.join(name);
        if p.exists() {
            std::fs::remove_dir(p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn start(service: &Arc<crate::service::Service>) {
    let control = &service.control;
    // Capture before the worker can finish recovery. The same journal drives
    // replacement resumes and its outcome, even if bindings are already terminal.
    let replacement = crate::app_replace::status().map(|receipt| {
        crate::app_replace::recovery_turns(&receipt, &control.session)
            .map(|turns| (string(&receipt, "id").to_owned(), turns))
    });
    let agents = &service.agents;
    let executor = Cli {
        service: Arc::downgrade(service),
        account_id: None,
    };
    let agents = Arc::downgrade(agents);
    let weak = Arc::downgrade(control);
    let (ready, delivery_ready) = tokio::sync::watch::channel(false);
    {
        let mut delivery_ready = delivery_ready.clone();
        let mut delivery_shutdown = control.shutdown.subscribe();
        let wake = control.events.clone();
        tokio::spawn(async move {
            tokio::select! { _ = delivery_shutdown.changed() => return, _ = delivery_ready.wait_for(|ready| *ready) => {} }
            loop {
                let result = async {
                    flush(
                        &executor,
                        &directory(),
                        &LOCK,
                        chrono::Utc::now().timestamp(),
                        30,
                        &settings()?,
                    )
                    .await
                };
                tokio::select! {
                    _ = delivery_shutdown.changed() => break,
                    result = result => if let Err(error) = result { crate::logs::record("WARN", &format!("Notification delivery: {error}"), None); },
                }
                let wake = wake.lock().await.wake.clone();
                tokio::select! {
                    _ = delivery_shutdown.changed() => break,
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {},
                    _ = wake.notified() => {},
                }
            }
        });
    }
    let mut shutdown = control.shutdown.subscribe();
    tokio::spawn(async move {
        crate::logs::record("INFO", "Control-source notification observer started", None);
        let mut recovering = true;
        let restart = id();
        let mut interrupted = std::collections::HashSet::new();
        let mut outcome_reconciled = false;
        loop {
            let Some(control) = weak.upgrade() else {
                break;
            };
            let Some(agents) = agents.upgrade() else {
                break;
            };
            let cycle = async {
                let _scope = crate::runtime_metrics::Scope::new(
                    crate::runtime_metrics::Work::NotificationObserve,
                );
                let replacement = replacement.as_ref().map_err(Clone::clone)?;
                if recovering {
                    if let Some((_, turns)) = replacement {
                        interrupted.extend(turns.iter().cloned());
                    }
                }
                let mut reads = tokio::task::JoinSet::new();
                let permits = Arc::new(tokio::sync::Semaphore::new(8));
                let mut owner_threads = std::collections::HashSet::new();
                if let Ok(entries) = binding_paths(&directory()) {
                    for entry in entries
                        .iter()
                        .filter(|e| e.path.extension().is_some_and(|v| v == "json"))
                    {
                        let _guard = LOCK.lock().await;
                        let Some(mut b) = read_binding(&entry.path)? else {
                            continue;
                        };
                        if b.source_id.is_empty() {
                            continue;
                        }
                        if remove_expired(&directory(), &b, chrono::Utc::now().timestamp())? {
                            continue;
                        }
                        if recovering {
                            recover(&directory(), &mut b)?;
                            if !b.terminal
                                || (!b.continuation_bound
                                    && b.scope_end.is_none()
                                    && b.continuation_until > 0)
                            {
                                if !b.observation.is_object() {
                                    b.observation = json!({});
                                }
                                b.observation["reconciliation"] = json!("pending-after-restart");
                                persist(&directory(), &b)?;
                            }
                        }
                        drop(_guard);
                        if b.scope_end.is_none() && (b.agent.is_empty() || b.agent == "codex") {
                            owner_threads.insert(b.thread_id.clone());
                        }
                        if b.terminal && (b.scope_end.is_some() || b.continuation_bound) {
                            continue;
                        }
                        let c = control.clone();
                        let agents = agents.clone();
                        let permits = permits.clone();
                        reads.spawn(async move {
                            let _permit = permits
                                .acquire_owned()
                                .await
                                .expect("observer semaphore remains open");
                            let args = json!({"threadId":b.thread_id,"turnId":b.turn_id});
                            let result = tokio::time::timeout(Duration::from_secs(10), async {
                                if b.agent.is_empty() || b.agent == "codex" {
                                    crate::kernel::origin::ORIGIN
                                        .scope(
                                            json!({"sourceId":b.source_id}),
                                            crate::waiter::codex_observe(&c, &args),
                                        )
                                        .await
                                } else {
                                    agents
                                        .observe_notification(&b.agent, &b.thread_id, &b.turn_id)
                                        .await
                                }
                            })
                            .await;
                            let result = match result {
                                Ok(Ok(mut observed)) => {
                                    enrich_completion(&c, &b, &mut observed).await;
                                    Ok(Ok(observed))
                                }
                                other => other,
                            };
                            (b, result)
                        });
                    }
                }
                while let Some(result) = reads.join_next().await {
                    let Ok((old, result)) = result else {
                        continue;
                    };
                    let observed = match result {
                        Ok(Ok(observed)) => observed,
                        failure => {
                            let error = match failure {
                                Ok(Err(error)) => error,
                                _ => "native-observation-timeout".into(),
                            };
                            let _guard = LOCK.lock().await;
                            if let Some(mut b) =
                                binding(&directory(), &old.thread_id, &old.turn_id)?
                            {
                                if !b.observation.is_object() {
                                    b.observation = json!({});
                                }
                                b.observation["lastError"] = json!(error);
                                b.observation["reconciliation"] = json!("pending-after-restart");
                                persist(&directory(), &b)?;
                            }
                            continue;
                        }
                    };
                    // Replacement owns its interruption record. For ordinary restarts,
                    // count previously live turns confirmed interrupted during recovery.
                    if recovering
                        && replacement.is_none()
                        && !old.terminal
                        && observed["state"] == "cancelled"
                    {
                        interrupted.insert((old.thread_id.clone(), old.turn_id.clone()));
                    }
                    let mut b = old;
                    let mut observed = observed;
                    for request in observed["interaction"].as_array_mut().into_iter().flatten() {
                        crate::respond_tokens::issue(&b.source_id, request)?;
                    }
                    // Downtime terminal reconciliation precedes capacity recovery.
                    // A scheduled retry must not erase the predecessor's one event.
                    if b.observation["reconciliation"] == "pending-after-restart"
                        && matches!(
                            string(&observed, "state"),
                            "completed" | "failed" | "cancelled"
                        )
                    {
                        process(&directory(), &LOCK, &mut b, &observed).await?;
                    }
                    match retry::handle(&control, &mut b, &observed).await {
                        Ok(true) => continue,
                        Ok(false) => {}
                        Err(error) => {
                            // Fail closed: incomplete history must not hide a failure indefinitely.
                            b.retry["status"] = json!("skipped");
                            b.retry["reason"] = json!(error);
                            let retry = b.retry.clone();
                            retry::update(&mut b, retry, false).await?;
                        }
                    }
                    process(&directory(), &LOCK, &mut b, &observed).await?;
                }
                for thread in owner_threads {
                    let _ = control.observe_ownership(&thread).await;
                }
                if recovering {
                    if replacement.is_some() {
                        // The worker merges recovery and task resume into the outcome.
                        let receipt = crate::app_replace::status()?;
                        recovery::update(
                            &directory(),
                            &LOCK,
                            &receipt,
                            "recovered",
                            chrono::Utc::now().timestamp(),
                        )
                        .await?;
                    } else {
                        recovery::enqueue(
                            &directory(),
                            &LOCK,
                            &restart,
                            chrono::Utc::now().timestamp(),
                            &interrupted,
                        )
                        .await?;
                    }
                }
                // Reuse the observer to reconcile delayed resume receipts. The
                // outcome keeps its event ID while remaining inbox-only.
                if !outcome_reconciled && replacement.is_some() {
                    let receipt = crate::app_replace::status()?;
                    if replacement
                        .as_ref()
                        .is_some_and(|(id, _)| receipt["id"] == *id)
                        && receipt["shutdownRequested"] == true
                        && matches!(
                            string(&receipt, "state"),
                            "succeeded" | "rolled-back" | "failed" | "cancelled"
                        )
                    {
                        recovery::update(
                            &directory(),
                            &LOCK,
                            &receipt,
                            "outcome",
                            chrono::Utc::now().timestamp(),
                        )
                        .await?;
                        outcome_reconciled = !receipt["interruptedTurns"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(recovery::resume_pending);
                    }
                }
                Ok::<_, String>(())
            };
            tokio::select! {
                biased;
                _ = shutdown.changed() => break,
                result = cycle => match result {
                    Ok(()) => {
                        if recovering { let _ = ready.send(true); }
                        recovering = false;
                    }
                    Err(error) => crate::logs::record("WARN", &format!("Control-source notification persistence/observation failed: {error}"), None),
                },
            }
            let wake = control.events.lock().await.wake.clone();
            drop(control);
            tokio::select! {
                _ = shutdown.changed() => break,
                _ = tokio::time::sleep(Duration::from_secs(2)) => {},
                _ = wake.notified() => {},
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as SyncMutex;
    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            Self(
                std::env::temp_dir()
                    .join(format!("arc-notify-test-{}", id()))
                    .join("notifications"),
            )
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.0.parent().unwrap());
        }
    }
    #[tokio::test]
    async fn registered_target_verifies_without_a_task_and_remains_source_scoped() {
        // Regression: a cloud source with no turn binding could never start a reachability handshake.
        let dir = Sandbox::new();
        let settings = json!({"notificationsEnabled":true});
        let args = json!({"target":"session_010000000000000000000001"});
        let bound = governance::bind_target_in(
            &dir.0,
            "source-a",
            &args,
            chrono::Utc::now().timestamp(),
            &settings,
        )
        .unwrap();
        assert_eq!(bound["taskBound"], false);
        let fake = Fake::success();
        assert!(
            reachability::verify_in(&dir.0, "source-b", &args, &settings, &fake)
                .await
                .unwrap_err()
                .contains("NOTIFICATION_TARGET_NOT_BOUND_TO_SOURCE")
        );
        let result = reachability::verify_in(&dir.0, "source-a", &args, &settings, &fake)
            .await
            .unwrap();
        assert_eq!(result["verificationAttempts"], 1);
        assert_eq!(result["deliveryStatus"], "delivered");
        assert_ne!(result["reachability"], "verified");
        let message = fake.calls.lock().unwrap()[0][1].clone();
        let start = message.find('{').unwrap();
        let end = message.rfind('}').unwrap();
        let delivered: Value = serde_json::from_str(&message[start..=end]).unwrap();
        assert!(!result
            .to_string()
            .contains(string(&delivered["args"], "code")));
        assert!(reachability::acknowledge(&dir.0, "source-b", &delivered["args"]).is_err());
        assert_eq!(
            reachability::acknowledge(&dir.0, "source-a", &delivered["args"]).unwrap()
                ["reachability"],
            "verified"
        );
        let visible = governance::status_in(
            &dir.0,
            "source-a",
            &args,
            chrono::Utc::now().timestamp(),
            &settings,
        )
        .unwrap();
        assert_eq!(visible["targets"][0]["verificationAttempts"], 1);
        let failed = reachability::verify_in(
            &dir.0,
            "source-a",
            &args,
            &settings,
            &Fake::new(Err("offline".into())),
        )
        .await
        .unwrap();
        assert_eq!(failed["ok"], false);
        assert_eq!(failed["verificationAttempts"], 2);
        assert_eq!(failed["deliveryStatus"], "failed");
        assert_eq!(failed["next"]["op"], "notify_control");
        assert_eq!(failed["next"]["args"]["action"], "verify");
        assert!(governance::status_in(
            &dir.0,
            "source-b",
            &args,
            chrono::Utc::now().timestamp(),
            &settings
        )
        .unwrap()["targets"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    #[tokio::test]
    async fn missing_cloud_session_reports_safe_account_and_manual_recovery() {
        // Regression: Session not found became generic handshake-delivery-failed and hid a likely host-account mismatch.
        let dir = Sandbox::new();
        let settings = json!({"notificationsEnabled":true});
        let args = json!({"target":"session_010000000000000000000001"});
        governance::bind_target_in(
            &dir.0,
            "source-a",
            &args,
            chrono::Utc::now().timestamp(),
            &settings,
        )
        .unwrap();
        for reply in [
            Err("CLAUDE_SEND_FAILED: exit 1; Session not found".into()),
            Ok(br#"{"ok":false,"error":"Session not found"}"#.to_vec()),
            Ok(br#"{"is_error":true,"errors":["Session not found"]}"#.to_vec()),
            Ok(b"Session not found".to_vec()),
        ] {
            let result =
                reachability::verify_in(&dir.0, "source-a", &args, &settings, &Fake::new(reply))
                    .await
                    .unwrap();
            assert_eq!(result["ok"], false);
            assert_eq!(result["reason"], "claude-session-not-found");
            assert_eq!(result["error"]["code"], "CLAUDE_SESSION_NOT_FOUND");
            assert_eq!(
                result["error"]["localAccount"]["email"],
                "fixture@example.invalid"
            );
            assert_eq!(result["next"]["op"], "notify_control");
            assert_eq!(result["next"]["args"]["action"], "route");
            assert_eq!(
                result["next"]["args"],
                json!({"action":"route","target":"session_010000000000000000000001"})
            );
            let status = governance::status_in(
                &dir.0,
                "source-a",
                &args,
                chrono::Utc::now().timestamp(),
                &settings,
            )
            .unwrap();
            assert_eq!(
                status["targets"][0]["lastVerificationError"]["code"],
                "CLAUDE_SESSION_NOT_FOUND"
            );
            assert!(!result.to_string().contains("fixture-secret"));
            assert!(!status.to_string().contains("fixture-secret"));
        }
        assert!(!session_not_found("Connection timed out"));
        assert_eq!(
            safe_account(&json!({"accessToken":"fixture-secret"})),
            json!({"available":false})
        );
    }
    struct Fake {
        result: Result<Vec<u8>>,
        calls: SyncMutex<Vec<Vec<String>>>,
        fallbacks: SyncMutex<Vec<String>>,
    }
    impl Fake {
        fn new(result: Result<Vec<u8>>) -> Self {
            Self {
                result,
                calls: Default::default(),
                fallbacks: Default::default(),
            }
        }
        fn success() -> Self {
            Self::new(Ok(
                br#"{"ok":true,"session_id":"session_010000000000000000000001"}"#.to_vec(),
            ))
        }
    }
    impl Executor for Fake {
        async fn local_account(&self, _source_id: &str, _target: &str) -> Value {
            safe_account(
                &json!({"loggedIn":true,"authMethod":"claude.ai","email":"fixture@example.invalid","accessToken":"fixture-secret","credentials":{"refreshToken":"fixture-secret"}}),
            )
        }
        async fn webhook(
            &self,
            _sub: &subscriptions::Subscription,
            _b: &Binding,
            _d: &Delivery,
        ) -> SendOutcome {
            SendOutcome::success("callback-accepted")
        }
        async fn send(&self, _source_id: &str, args: Vec<String>) -> Result<Vec<u8>> {
            self.calls.lock().unwrap().push(args);
            self.result.clone()
        }
        async fn escalate(&self, body: String) -> Result<()> {
            self.fallbacks.lock().unwrap().push(body);
            Ok(())
        }
    }
    async fn process(
        executor: &impl Executor,
        dir: &Path,
        b: &mut Binding,
        observation: &Value,
    ) -> Result<()> {
        super::process(dir, &Mutex::new(()), b, observation).await?;
        {
            flush(
                executor,
                dir,
                &Mutex::new(()),
                i64::MAX,
                0,
                &json!({"notificationBucketCapacity":100}),
            )
            .await?;
        }
        *b = binding(dir, &b.thread_id, &b.turn_id)?.unwrap();
        Ok(())
    }
    async fn recover(_executor: &impl Executor, dir: &Path, b: &mut Binding) -> Result<()> {
        super::recover(dir, b)?;
        Ok(())
    }
    fn verified_fixture_target(dir: &Path, b: &Binding) {
        if let Some(target) = &b.target {
            let mut state = State::load(dir).unwrap();
            state
                .target(&b.source_id, b.channel, target, 0, &json!({}))
                .reachability
                .state = "verified".into();
            state.save(dir).unwrap();
        }
    }
    fn fixture(dir: &Path) -> Binding {
        bind_in(
            dir,
            Some("session_010000000000000000000001"),
            "thread-1",
            "turn-1",
            "/projects/sample",
        )
        .unwrap();
        let mut b = binding(dir, "thread-1", "turn-1").unwrap().unwrap();
        b.source_id = "claude".into();
        verified_fixture_target(dir, &b);
        persist(dir, &b).unwrap();
        b
    }
    #[test]
    fn historical_subscription_sync_preserves_scope_and_delivery_preferences() {
        // Regression: 698 historical bindings caused subscription synchronization to repeatedly hash every binding for every subscription.
        let dir = Sandbox::new();
        let base = fixture(&dir.0);
        let mut bindings: Vec<_> = (0..1500)
            .map(|index| {
                let mut binding = base.clone();
                binding.thread_id = format!("task-{index}");
                binding.source_id = format!("source-{}", index % 2);
                binding
            })
            .collect();
        let mut state = State::default();
        subscriptions::sync(&mut state, &bindings);
        let id = subscriptions::claude_id(&bindings[0]);
        let saved = state.subscriptions.iter_mut().find(|s| s.id == id).unwrap();
        saved.muted = true;
        saved.until = Some(999);
        saved.expires_at = Some(999_000);
        let created = saved.created_at;
        bindings[0].target = Some("session_010000000000000000000002".into());
        bindings[1].target = None;
        bindings[2].source_id.clear();
        subscriptions::sync(&mut state, &bindings);
        let public: Vec<_> = state.subscriptions.iter().map(|s| s.public(1)).collect();
        let saved = public.iter().find(|s| s["id"] == id).unwrap();
        assert_eq!(
            saved["target"],
            bindings[0].target.as_ref().unwrap().as_str()
        );
        assert_eq!(saved["muted"], true);
        assert_eq!(saved["until"], 999);
        assert_eq!(saved["expiresAt"], 999_000);
        assert_eq!(saved["createdAt"], created);
        assert_eq!(public.len(), 1498);
        for subscription in &state.subscriptions {
            assert!(bindings.iter().any(|b| subscription.matches(b)
                && b.target.as_deref() == Some(subscription.target.as_str())));
        }
    }

    fn interaction(id: Value) -> Value {
        json!({"state":"interaction-required", "interaction":[{"id":id,"method":"item/commandExecution/requestApproval","params":{"command":"SECRET_COMMAND"}}],"activeFlags":["waitingOnApproval"],"finalResponse":"SECRET_OUTPUT","error":"SECRET_ERROR"})
    }
    async fn enqueue(dir: &Path, thread: &str, observation: Value, at: i64) -> Binding {
        bind_in(
            dir,
            Some("session_010000000000000000000001"),
            thread,
            "turn-1",
            "/projects/sample",
        )
        .unwrap();
        let mut b = binding(dir, thread, "turn-1").unwrap().unwrap();
        b.source_id = "claude".into();
        b.created_at = at;
        verified_fixture_target(dir, &b);
        b.caused_by =
            json!({"op":"codex_send","at":"2026-10-01T00:00:00Z","requestId":"request-test"});
        persist(dir, &b).unwrap();
        super::process(dir, &Mutex::new(()), &mut b, &observation)
            .await
            .unwrap();
        for d in &mut b.deliveries {
            d.created_at = at;
        }
        persist(dir, &b).unwrap();
        b
    }
    fn delivery_status(dir: &Path, thread: &str) -> String {
        binding(dir, thread, "turn-1").unwrap().unwrap().deliveries[0]
            .status
            .clone()
    }
    #[tokio::test]
    async fn empty_async_completion_is_suppressed_and_changes_stay_out_of_message() {
        // Regression: de629dd; empty async completion is suppressed and changes stay out of message.
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let fake = Fake::success();
        process(&fake,&dir.0,&mut b,&json!({"state":"interaction-required","interaction":[{"id":"q","method":"request_user_input_async","params":{"question":"2+2?"}}]})).await.unwrap();

        process(
            &fake,
            &dir.0,
            &mut b,
            &json!({"state":"completed","finalResponse":{"text":"  "},"interaction":[]}),
        )
        .await
        .unwrap();
        assert!(b.terminal);
        assert_eq!(b.deliveries.len(), 1);

        let dir2 = Sandbox::new();
        let mut b = fixture(&dir2.0);
        let changes = json!({"summary":{"files":2,"added":4,"removed":1,"binaryOrUnreadable":0},"commits":[{"sha":"abcdef123456","title":"feat: sample"}],"commitCount":8,"fallback":false,"truncated":true,"observedAt":"2026-01-01T00:00:00Z"});
        process(
            &fake,
            &dir2.0,
            &mut b,
            &json!({"state":"completed","finalResponse":{"text":"done"},"changes":changes}),
        )
        .await
        .unwrap();
        let body = message(&b);
        assert!(!body.contains("done"));
        assert!(!body.contains("abcdef12"));
        assert_eq!(b.deliveries[0].changes, changes);
        assert_eq!(event(&b, &b.deliveries[0])["finalResponse"]["text"], "done");
        b.deliveries[0].changes = json!({"unavailable":"not a repository"});
        assert_eq!(message(&b), body);
        b.deliveries[0].changes = changes;
        b.deliveries[0].changes["fallback"] = json!(true);
        assert_eq!(message(&b), body);
    }
    #[test]
    fn idle_bucket_spending_waits_a_complete_refill_interval() {
        // Regression: eliminating idle bucket writes must not refund the first spent token immediately.
        let mut state = State::default();
        let settings = json!({"notificationBucketCapacity":1,"notificationRefillSeconds":60});
        let target = state.target("source", Channel::ClaudeSession, "target", 100, &settings);
        target.refill(1000, &settings);
        target.charge(1000, &settings);
        target.refill(1059, &settings);
        assert_eq!(target.tokens, 0);
        target.refill(1060, &settings);
        assert_eq!(target.tokens, 1);
    }
    #[tokio::test]
    async fn bucket_refill_batches_interactions_and_survives_reload() {
        // Regression: an empty bucket queues events until refill without losing their batch identity.
        let dir = Sandbox::new();
        let fake = Fake::success();
        let lock = Mutex::new(());
        let s = json!({"notificationBucketCapacity":1,"notificationRefillSeconds":60});
        enqueue(&dir.0, "question", interaction(json!(1)), 100).await;
        flush(&fake, &dir.0, &lock, 100, 30, &s).await.unwrap();
        assert_eq!(State::load(&dir.0).unwrap().targets[0].tokens, 0);
        let approval = enqueue(&dir.0, "approval", interaction(json!(2)), 101).await;
        let completed = enqueue(
            &dir.0,
            "completed",
            json!({"state":"completed","finalResponse":"done"}),
            101,
        )
        .await;
        flush(&fake, &dir.0, &lock, 101, 30, &s).await.unwrap();

        assert_eq!(
            binding(&dir.0, "approval", "turn-1")
                .unwrap()
                .unwrap()
                .deliveries[0]
                .timing
                .queue_reason
                .as_deref(),
            Some("token-wait")
        );
        flush(&fake, &dir.0, &lock, 159, 30, &s).await.unwrap();
        assert_eq!(delivery_status(&dir.0, "approval"), "pending");
        assert_eq!(delivery_status(&dir.0, "completed"), "pending");
        assert_eq!(State::load(&dir.0).unwrap().targets[0].batches.len(), 1);
        flush(&fake, &dir.0, &lock, 160, 30, &s).await.unwrap();

        let state = State::load(&dir.0).unwrap();
        assert_eq!(state.targets[0].tokens, 0);
        assert_eq!(state.targets[0].batches.len(), 2);
        for queued in [approval, completed] {
            let delivered = binding(&dir.0, &queued.thread_id, "turn-1")
                .unwrap()
                .unwrap();
            assert_eq!(
                delivered.deliveries[0].event_id,
                queued.deliveries[0].event_id
            );
            assert_eq!(
                delivered.deliveries[0].batch,
                state.targets[0].batches[1].id
            );
        }
        assert_eq!(state.targets[0].batches[1].kinds["needs-input"], 1);
        assert_eq!(state.targets[0].batches[1].kinds["completed"], 1);
    }
    #[tokio::test]
    async fn exponential_retries_keep_token_credit_and_event_id() {
        // Regression: offline delivery retries retain event identity and do not charge another token.
        let dir = Sandbox::new();
        let failed = Fake::new(Err("offline".into()));
        let lock = Mutex::new(());
        let s = json!({"notificationBucketCapacity":1,"notificationRefillSeconds":60});
        let b = enqueue(&dir.0, "retry", interaction(json!(1)), 100).await;
        let event = b.deliveries[0].event_id.clone();
        flush(&failed, &dir.0, &lock, 100, 30, &s).await.unwrap();
        flush(&failed, &dir.0, &lock, 109, 30, &s).await.unwrap();
        let waiting = binding(&dir.0, "retry", "turn-1").unwrap().unwrap();
        assert_eq!(waiting.deliveries[0].failures, 1);
        assert_eq!(waiting.deliveries[0].next_attempt_at, 110);
        assert_eq!(waiting.deliveries[0].status, "pending");

        flush(&failed, &dir.0, &lock, 111, 30, &s).await.unwrap();

        let d = &binding(&dir.0, "retry", "turn-1")
            .unwrap()
            .unwrap()
            .deliveries[0];
        assert_eq!(d.next_attempt_at, 131);
        assert_eq!(d.failures, 2);
        enqueue(&dir.0, "fresh", interaction(json!(2)), 112).await;
        let success = Fake::success();
        flush(&success, &dir.0, &lock, 132, 30, &s).await.unwrap();

        assert!(!success.calls.lock().unwrap()[0][1].contains(&event));
        assert_eq!(
            binding(&dir.0, "retry", "turn-1")
                .unwrap()
                .unwrap()
                .deliveries[0]
                .event_id,
            event
        );
        assert_eq!(
            binding(&dir.0, "fresh", "turn-1")
                .unwrap()
                .unwrap()
                .deliveries[0]
                .status,
            "pending"
        );
        let state = State::load(&dir.0).unwrap();
        assert_eq!(state.targets[0].tokens, 0);
        assert_eq!(
            state.targets[0]
                .batches
                .iter()
                .filter(|b| b.charged)
                .count(),
            1
        );
        assert_eq!(
            [1, 2, 3, 4, 5, 6, 20].map(governance::retry_seconds),
            [10, 20, 40, 80, 160, 300, 300]
        );
    }
    #[tokio::test]
    async fn breaker_and_starvation_escalate_once_then_rearm() {
        // Regression: blocked delivery escalates and recovery rearms the target.
        let dir = Sandbox::new();
        let fake = Fake::success();
        let lock = Mutex::new(());
        let s = json!({"notificationBucketCapacity":1,"notificationRefillSeconds":3600,"notificationEscalationSeconds":900});
        enqueue(&dir.0, "blocked", interaction(json!(1)), 100).await;
        governance::control_in(
            &dir.0,
            "claude",
            &json!({"action":"breaker","target":"session_010000000000000000000001","enabled":true}),
            100,
            &s,
        )
        .unwrap();
        flush(&fake, &dir.0, &lock, 100, 0, &s).await.unwrap();
        flush(&fake, &dir.0, &lock, 200, 0, &s).await.unwrap();
        assert_eq!(delivery_status(&dir.0, "blocked"), "pending");
        assert!(State::load(&dir.0).unwrap().targets[0].escalated);
        assert_eq!(
            State::load(&dir.0).unwrap().targets[0].anomaly(200, true, &s),
            None
        );

        assert!(fake.fallbacks.lock().unwrap()[0].contains("blocked"));
        governance::control_in(
            &dir.0,
            "claude",
            &json!({"action":"breaker","target":"session_010000000000000000000001","enabled":false}),
            201,
            &s,
        )
        .unwrap();
        flush(&fake, &dir.0, &lock, 201, 0, &s).await.unwrap();
        assert_eq!(delivery_status(&dir.0, "blocked"), "delivered");
        assert!(!State::load(&dir.0).unwrap().targets[0].escalated);

        enqueue(&dir.0, "starved", interaction(json!(2)), 202).await;
        flush(&fake, &dir.0, &lock, 202, 0, &s).await.unwrap();
        flush(&fake, &dir.0, &lock, 1101, 0, &s).await.unwrap();
        assert_eq!(delivery_status(&dir.0, "starved"), "pending");
        assert!(!State::load(&dir.0).unwrap().targets[0].escalated);

        flush(&fake, &dir.0, &lock, 1102, 0, &s).await.unwrap();
        flush(&fake, &dir.0, &lock, 1103, 0, &s).await.unwrap();
        assert!(State::load(&dir.0).unwrap().targets[0].escalated);
        assert_eq!(
            State::load(&dir.0).unwrap().targets[0].anomaly(1103, true, &s),
            None
        );

        flush(&fake, &dir.0, &lock, 3801, 0, &s).await.unwrap();
        assert!(!State::load(&dir.0).unwrap().targets[0].escalated);
        governance::control_in(
            &dir.0,
            "claude",
            &json!({"action":"breaker","target":"session_010000000000000000000001","enabled":true}),
            3802,
            &s,
        )
        .unwrap();
        flush(&fake, &dir.0, &lock, 3802, 0, &s).await.unwrap();
        assert!(State::load(&dir.0).unwrap().targets[0].escalated);
    }
    #[tokio::test]
    async fn notification_controls_are_scoped_persistent_and_reversible() {
        // Regression: cross-source mute is rejected and unmute restores delivery.
        let dir = Sandbox::new();
        let fake = Fake::success();
        let lock = Mutex::new(());
        let s = json!({});
        enqueue(&dir.0, "thread", interaction(json!(1)), 100).await;
        assert!(governance::control_in(
            &dir.0,
            "other",
            &json!({"action":"mute","threadId":"thread"}),
            100,
            &s
        )
        .is_err());
        governance::control_in(
            &dir.0,
            "claude",
            &json!({"action":"mute","threadId":"thread","mode":"digest"}),
            100,
            &s,
        )
        .unwrap();
        flush(&fake, &dir.0, &lock, 3699, 0, &s).await.unwrap();
        assert_eq!(delivery_status(&dir.0, "thread"), "pending");

        flush(&fake, &dir.0, &lock, 3700, 0, &s).await.unwrap();
        assert_eq!(delivery_status(&dir.0, "thread"), "digested");

        assert_eq!(
            State::load(&dir.0).unwrap().targets[0].batches[0].kinds["needs-input"],
            1
        );
        assert_eq!(
            inbox_in(
                &dir.0,
                "claude",
                &[],
                true,
                Some("session_010000000000000000000001")
            )
            .unwrap()["events"][0]["target"],
            "session_010000000000000000000001"
        );
        acknowledge_in(&dir.0, "claude", &json!({"all":true})).unwrap();
        let status = governance::status_in(&dir.0, "claude", &json!({}), 3701, &s).unwrap();
        assert!(status["threads"][0]["lastAckAt"].is_number());
        assert!(status["threads"][0]["lastDeliveredAt"].is_number());
        governance::control_in(
            &dir.0,
            "claude",
            &json!({"action":"unmute","threadId":"thread"}),
            3701,
            &s,
        )
        .unwrap();
        governance::control_in(
            &dir.0,
            "claude",
            &json!({"action":"rebind","threadId":"thread","target":null}),
            3701,
            &s,
        )
        .unwrap();
        assert!(binding(&dir.0, "thread", "turn-1")
            .unwrap()
            .unwrap()
            .target
            .is_none());
        governance::control_in(
            &dir.0,
            "claude",
            &json!({"action":"rebind","threadId":"thread","target":"session_010000000000000000000001"}),
            3702,
            &s,
        )
        .unwrap();
        assert_eq!(
            binding(&dir.0, "thread", "turn-1")
                .unwrap()
                .unwrap()
                .target
                .as_deref(),
            Some("session_010000000000000000000001")
        );
        assert_eq!(State::load(&dir.0).unwrap().threads[0].mode, "normal");
        assert!(
            governance::status_in(&dir.0, "other", &json!({}), 3702, &s).unwrap()["targets"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn notification_status_defaults_to_activity_and_expands_explicit_scope() {
        // Regression: f3d8d3e; notification status defaults to activity and expands explicit scope.
        let dir = Sandbox::new();
        let settings = json!({});
        let now = 10000;
        let mut state = State::default();
        for name in [
            "idle",
            "recent",
            "pending",
            "muted",
            "breaker",
            "empty",
            "escalated",
            "batch",
        ] {
            let mut b = enqueue(&dir.0, name, interaction(json!(name)), 100).await;
            b.target = Some(format!("session_{name:0>24}"));
            let d = &mut b.deliveries[0];
            d.target = b.target.clone().unwrap();
            d.status = if name == "pending" {
                "pending"
            } else {
                "delivered"
            }
            .into();
            d.attempted_at = 100;
            let target = state.target(
                &b.source_id,
                b.channel,
                b.target.as_ref().unwrap(),
                now,
                &settings,
            );
            match name {
                "breaker" => target.breaker = true,
                "empty" => target.empty_since = Some(now - 60),
                "escalated" => target.escalated = true,
                "recent" | "batch" => target.batches.push(governance::Batch {
                    id: name.into(),
                    at: now - 1,
                    kinds: [("needs-input".into(), 1)].into(),
                    threads: vec![name.into()],
                    status: "delivered".into(),
                    charged: true,
                }),
                _ => {}
            }
            if name == "muted" {
                state.thread(&b, now).mode = "mute".into();
            }
            persist(&dir.0, &b).unwrap();
            if name == "recent" {
                b.turn_id = "turn-2".into();
                b.created_at = now - 1;
                b.deliveries[0].attempted_at = now - 1;
                persist(&dir.0, &b).unwrap();
            }
        }
        state.save(&dir.0).unwrap();
        let compact = governance::status_in(&dir.0, "claude", &json!({}), now, &settings).unwrap();
        assert_eq!(
            compact["summary"],
            json!({"totalTargets":8,"totalThreads":8,"totalBindings":9,"hidden":{"targets":0,"threads":4,"bindings":5}})
        );
        let recent = compact["threads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["threadId"] == "recent")
            .unwrap();
        assert_eq!(recent["turns"].as_array().unwrap().len(), 1);
        assert_eq!(recent["turns"][0]["turnId"], "turn-2");
        assert_eq!(recent["turns"][0]["causedBy"]["requestId"], "request-test");
        for args in [
            json!({"all":true}),
            json!({"target":format!("session_{:0>24}", "recent")}),
            json!({"threadId":"recent"}),
        ] {
            let full = governance::status_in(&dir.0, "claude", &args, now, &settings).unwrap();
            assert_eq!(
                full["summary"]["hidden"],
                json!({"targets":0,"threads":0,"bindings":0})
            );
            let recent = full["threads"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["threadId"] == "recent")
                .unwrap();
            assert_eq!(recent["turns"].as_array().unwrap().len(), 2);
        }
        let idle = governance::status_in(
            &dir.0,
            "claude",
            &json!({"threadId":"idle","all":false}),
            now,
            &settings,
        )
        .unwrap();
        assert_eq!(idle["targets"].as_array().unwrap().len(), 1);
        assert_eq!(idle["threads"].as_array().unwrap().len(), 1);
        let other =
            governance::status_in(&dir.0, "other", &json!({"all":true}), now, &settings).unwrap();
        assert_eq!(other["summary"]["totalBindings"], 0);
    }

    #[tokio::test]
    async fn notification_preserves_interaction_and_scopes_recovery() {
        // Regression: de629dd; response recovery must not cross source or backend-session boundaries.
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let fake = Fake::success();
        b.title = "Dispatch title".into();
        persist(&dir.0, &b).unwrap();
        let request = json!({"id":"[\"desktop\",\"thread-1\",0]","owner":"desktop","backendSession":"old-session","method":"request_user_input_async","canRespond":true,"params":{"question":"原文\n第二行","options":["保持原样","继续"]}});
        process(
            &fake,
            &dir.0,
            &mut b,
            &json!({"state":"interaction-required","title":"Existing thread title","interaction":[request]}),
        )
        .await
        .unwrap();
        b.source_id = "caller".into();
        persist(&dir.0, &b).unwrap();
        assert!(
            recoverable_response_in(&dir.0, "caller", string(&request, "id"), "old-session")
                .unwrap()
        );
        assert!(
            !recoverable_response_in(&dir.0, "other", string(&request, "id"), "old-session")
                .unwrap()
        );
        assert!(!recoverable_response_in(
            &dir.0,
            "caller",
            string(&request, "id"),
            "unknown-session"
        )
        .unwrap());
        let emitted = event(&b, &b.deliveries[0]);
        for (field, value) in request.as_object().unwrap() {
            assert_eq!(&emitted["interaction"][field], value);
        }
        for (state, kind) in [
            ("completed", "completed"),
            ("failed", "failed"),
            ("cancelled", "interrupted"),
            ("interaction-required", "needs-input"),
        ] {
            b.deliveries[0].task_state = state.into();
            b.deliveries[0].final_response = json!("SECRET_OUTPUT");
            b.deliveries[0].task_error = json!("SECRET_ERROR");
            assert!(!message(&b).contains("SECRET"));
            let payload = event(&b, &b.deliveries[0]);
            assert_eq!(payload["kind"], kind);
            assert_eq!(payload["finalResponse"], "SECRET_OUTPUT");
        }
    }
    #[tokio::test]
    async fn routing_countdown_keeps_inbox_answers_available_and_source_scoped() {
        // Regression: proactive notification raced a user's pending dock answer; delaying push must not hide the request from its source.
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        b.thread_id = "routing-fixture".into();
        persist(&dir.0, &b).unwrap();
        routing::presence(&json!({"agent":"codex","taskId":b.thread_id,"present":true})).unwrap();
        let lock = Mutex::new(());
        super::process(&dir.0, &lock, &mut b, &interaction(json!(41)))
            .await
            .unwrap();
        let inbox = inbox_in(&dir.0, "claude", &[], false, None).unwrap();
        assert_eq!(inbox["events"][0]["routing"]["state"], "deferred");
        assert_eq!(inbox["events"][0]["interaction"]["id"], 41);
        let args = json!({"taskId":b.thread_id,"id":"41","action":"handoff"});
        let denied = crate::kernel::origin::ORIGIN.sync_scope(json!({"sourceId":"other"}), || {
            routing::control_in(&dir.0, &args, false)
        });
        assert!(denied.unwrap_err().contains("REQUEST_SOURCE_MISMATCH"));
        // Native resolution is independent of notification routing and prevents a late push.
        super::process(
            &dir.0,
            &lock,
            &mut b,
            &json!({"state":"running","interaction":[]}),
        )
        .await
        .unwrap();
        let inbox = inbox_in(&dir.0, "claude", &[], false, None).unwrap();
        assert_eq!(inbox["events"][0]["interaction"]["resolved"], true);
        let resolved = crate::kernel::origin::ORIGIN
            .sync_scope(json!({"sourceId":"claude"}), || {
                routing::control_in(&dir.0, &args, false)
            });
        assert!(resolved.unwrap_err().contains("REQUEST_RESOLVED"));
        super::process(&dir.0, &lock, &mut b, &interaction(json!(42)))
            .await
            .unwrap();
        for (action, expected) in [
            ("pause", "paused"),
            ("resume", "deferred"),
            ("handoff", "routed"),
        ] {
            let result = crate::kernel::origin::ORIGIN
                .sync_scope(json!({"sourceId":"claude"}), || {
                    routing::control_in(
                        &dir.0,
                        &json!({"taskId":b.thread_id,"id":"42","action":action}),
                        false,
                    )
                })
                .unwrap();
            assert_eq!(result["routing"]["state"], expected);
        }
        routing::presence(&json!({"agent":"codex","taskId":b.thread_id,"present":false})).unwrap();
    }
    #[tokio::test]
    async fn receipts_keep_thread_title_and_original_prompt_after_steering() {
        // Regression: completion labels used the latest steer prompt instead of the thread title or original dispatch prompt.
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let thread_title = "Stable task title";
        let initial_prompt = "Original dispatch first line";
        let steer_prompt = "Later steering instruction";
        b.title = initial_prompt.into();
        persist(&dir.0, &b).unwrap();
        let observation = json!({"state":"completed","title":thread_title,
            "dispatches":[{"turnId":b.turn_id,"title":initial_prompt},{"turnId":b.turn_id,"title":steer_prompt}]});
        super::process(&dir.0, &Mutex::new(()), &mut b, &observation)
            .await
            .unwrap();
        let inbox = inbox_in(&dir.0, "claude", &[], false, None).unwrap();
        let delivered = &inbox["events"][0];
        assert_eq!(delivered["title"], thread_title);
        assert!(string(delivered, "summary").contains(thread_title));
        assert!(!string(delivered, "summary").contains(steer_prompt));
        b.thread_title.clear();
        let fallback = event(&b, &b.deliveries[0]);
        assert_eq!(fallback["title"], initial_prompt);
        assert!(string(&fallback, "summary").contains(initial_prompt));
        assert!(!string(&fallback, "summary").contains(steer_prompt));
    }
    #[tokio::test]
    async fn every_emitted_notification_payload_validates_against_discovery_schema() {
        // Contract: every notification payload variant must validate against the strict public payloadSchema; the envelope is unchanged.
        let schema = mcp_events::list()["events"][0]["payloadSchema"].clone();
        let validator = crate::validator("event-payload", "notification", &schema).unwrap();
        for agent in ["codex", "claude"] {
            for (state, kind, method) in [
                ("completed", "completed", ""),
                ("failed", "failed", ""),
                ("cancelled", "interrupted", ""),
                (
                    "interaction-required",
                    "needs-input",
                    "item/commandExecution/requestApproval",
                ),
                (
                    "interaction-required",
                    "needs-input",
                    "item/tool/requestUserInput",
                ),
            ] {
                let dir = Sandbox::new();
                let mut b = fixture(&dir.0);
                b.agent = agent.into();
                persist(&dir.0, &b).unwrap();
                let observation = json!({"state":state,"interaction":if method.is_empty(){json!([])}else{json!([{"id":1,"method":method}])}});
                super::process(&dir.0, &Mutex::new(()), &mut b, &observation)
                    .await
                    .unwrap();
                let data = mcp_events::payload("task_status", &event(&b, &b.deliveries[0]));
                validator.validate(&data).unwrap();
                assert_eq!(data["kind"], kind);
                assert_eq!(data["agent"], agent);
                assert!(data["ownership"].is_null());
            }
        }
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        super::process(
            &dir.0,
            &Mutex::new(()),
            &mut b,
            &json!({"state":"unconfirmed","handoffs":[{
            "eventId":"fixture-handoff","from":"connector","to":"desktop","observedAt":now(),
            "evidence":"native-writer-file-lock","timeBasis":"observed-not-transition-time"}]}),
        )
        .await
        .unwrap();
        let data = mcp_events::payload("task_status", &event(&b, &b.deliveries[0]));
        validator.validate(&data).unwrap();
        assert_eq!(data["kind"], "handoff");
        assert!(data["ownership"].is_object());
        recovery::enqueue(
            &dir.0,
            &Mutex::new(()),
            "schema-restart",
            chrono::Utc::now().timestamp(),
            &[(b.thread_id.clone(), b.turn_id.clone())].into(),
        )
        .await
        .unwrap();
        let recovered = records(&dir.0).unwrap();
        let delivery = recovered
            .iter()
            .flat_map(|b| b.deliveries.iter().map(move |d| (b, d)))
            .find(|(_, d)| d.task_state == "recovered")
            .unwrap();
        let recovered = mcp_events::payload("task_status", &event(delivery.0, delivery.1));
        validator.validate(&recovered).unwrap();
        assert_eq!(recovered["kind"], "recovered");
        assert_eq!(recovered["query"]["op"], "notify_status");
        let mut invalid = recovered;
        invalid["recovery"]["undeclared"] = json!(true);
        assert!(validator.validate(&invalid).is_err());
        let mut continued = data.clone();
        continued["kind"] = json!("interrupted");
        for state in [
            "running",
            "completed",
            "failed",
            "interrupted",
            "needs-input",
            "unknown",
        ] {
            continued["continuation"] = json!({"turnId":"resumed-turn","state":state});
            validator.validate(&continued).unwrap();
        }
        continued["continuation"]["undeclared"] = json!(true);
        assert!(validator.validate(&continued).is_err());
        let mut reconciled = data.clone();
        reconciled["kind"] = json!("interrupted");
        for (ended, duration, basis) in [
            (
                json!("2026-01-01T00:10:00Z"),
                json!(600000),
                "native-terminal",
            ),
            (
                json!("2026-01-01T00:09:00Z"),
                json!(540000),
                "last-observed-activity",
            ),
            (Value::Null, Value::Null, "unknown"),
        ] {
            reconciled["reconciliation"] =
                json!({"endedAt":ended,"durationMs":duration,"timeBasis":basis});
            validator.validate(&reconciled).unwrap();
        }
        reconciled["reconciliation"]["undeclared"] = json!(true);
        assert!(validator.validate(&reconciled).is_err());
        let mut extra = data.clone();
        extra["undeclared"] = json!(true);
        assert!(validator.validate(&extra).is_err());
        let mut missing = data;
        missing.as_object_mut().unwrap().remove("ownership");
        assert!(validator.validate(&missing).is_err());
    }

    #[tokio::test]
    async fn quiet_receipts_health_and_ack_distinguish_consumed_events() {
        // Regression: acknowledging a consumed or foreign event must not consume another event.
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        b.source_id = "claude".into();
        persist(&dir.0, &b).unwrap();
        let fake = Fake::success();
        super::process(
            &dir.0,
            &Mutex::new(()),
            &mut b,
            &json!({"state":"completed","finalResponse":{"text":"done"}}),
        )
        .await
        .unwrap();
        flush(
            &fake,
            &dir.0,
            &Mutex::new(()),
            chrono::Utc::now().timestamp() + 31,
            30,
            &json!({"notificationBucketCapacity":10}),
        )
        .await
        .unwrap();
        b = binding(&dir.0, &b.thread_id, &b.turn_id).unwrap().unwrap();
        let e = b.deliveries[0].event_id.clone();
        let ack = acknowledge_in(&dir.0, "claude", &json!({"eventIds":[e,e,"missing"]})).unwrap();
        assert_eq!(ack["markedRead"], 0);
        assert_eq!(ack["alreadyRead"], 1);
        assert_eq!(ack["notFound"], 1);
        assert_eq!(
            acknowledge_in(&dir.0, "other", &json!({"eventIds":[e]})).unwrap()["notFound"],
            1
        );
        let since =
            chrono::DateTime::from_timestamp_millis(b.deliveries[0].timing.queued_at.unwrap() + 1)
                .unwrap()
                .to_rfc3339();
        assert_eq!(
            notification_since(Some(b.clone()), Some(&since))["deliveries"],
            json!([])
        );
        assert_eq!(
            notification(Some(b))["deliveries"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mut args = json!({"purpose":"self-test"});
        normalize(&mut args).unwrap();
        assert!(args.get("notify").is_some_and(Value::is_null));
    }
    #[tokio::test]
    async fn inbox_session_dedup_and_scoped_ack() {
        // Regression: aab23a2; inbox session dedup and scoped ack.
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        b.source_id = "claude".into();
        persist(&dir.0, &b).unwrap();
        let fake = Fake::success();
        process(
            &fake,
            &dir.0,
            &mut b,
            &json!({"state":"completed","finalResponse":"done"}),
        )
        .await
        .unwrap();
        assert!(inbox_in(
            &dir.0,
            "claude",
            &[],
            true,
            Some("session_010000000000000000000001")
        )
        .unwrap()
        .is_null());
        assert_eq!(
            inbox_in(&dir.0, "claude", &[], false, None).unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        b.deliveries[0].event_id = "fresh".into();
        b.deliveries[0].status = "pending".into();
        persist(&dir.0, &b).unwrap();
        inbox_append(&dir.0, "claude", event(&b, &b.deliveries[0])).unwrap();
        assert_eq!(
            inbox_in(
                &dir.0,
                "claude",
                &[],
                true,
                Some("session_010000000000000000000001")
            )
            .unwrap()["events"][0]["eventId"],
            "fresh"
        );
        assert!(inbox_in(
            &dir.0,
            "claude",
            &[],
            true,
            Some("session_010000000000000000000001")
        )
        .unwrap()
        .is_null());
        inbox_append(&dir.0, "chatgpt", event(&b, &b.deliveries[0])).unwrap();
        assert_eq!(
            acknowledge_in(&dir.0, "claude", &json!({"all":true})).unwrap()["markedRead"],
            2
        );
        assert_eq!(
            acknowledge_in(&dir.0, "claude", &json!({"all":true})).unwrap()["markedRead"],
            0
        );
        assert_eq!(
            inbox_in(&dir.0, "chatgpt", &[], false, None).unwrap()["unread"],
            1
        );
        let compact = inbox_in(&dir.0, "chatgpt", &[], false, None).unwrap();
        assert_eq!(compact["unread"], 1);
        assert_eq!(compact["events"], json!([]));
        assert_eq!(compact["unchangedEvents"].as_array().unwrap().len(), 1);
        let full = inbox_select(&dir.0, "chatgpt", &[], false, None, Some(&json!({}))).unwrap();
        assert_eq!(full["events"].as_array().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn inbox_matches_caller_target_and_defers_subscribed_mcp_events() {
        // Regression: 292260b; inbox matches caller target and defers subscribed mcp events.
        let dir = Sandbox::new();
        let first = enqueue(
            &dir.0,
            "first",
            json!({"state":"completed","finalResponse":"done"}),
            100,
        )
        .await;
        let mut second = enqueue(
            &dir.0,
            "second",
            json!({"state":"completed","finalResponse":"done"}),
            100,
        )
        .await;
        second.target = Some("session_010000000000000000000002".into());
        second.deliveries[0].target = "session_010000000000000000000002".into();
        persist(&dir.0, &second).unwrap();
        assert!(inbox_in(&dir.0, "claude", &[], true, None)
            .unwrap()
            .is_null());
        let inbox = inbox_in(
            &dir.0,
            "claude",
            &[],
            true,
            Some("session_010000000000000000000001"),
        )
        .unwrap();
        assert_eq!(inbox["unread"], 1);
        assert_eq!(inbox["events"][0]["threadId"], "first");
        let other = inbox_in(
            &dir.0,
            "claude",
            &[],
            true,
            Some("session_010000000000000000000002"),
        )
        .unwrap();
        assert_eq!(other["events"][0]["threadId"], "second");
        inbox_append(&dir.0, "chatgpt", event(&first, &first.deliveries[0])).unwrap();
        assert_eq!(
            inbox_in(&dir.0, "chatgpt", &[], false, None).unwrap()["unread"],
            1
        );
        let mut state = State::load(&dir.0).unwrap();
        state.subscriptions.push(subscriptions::Subscription {
            id: "mcp-test".into(),
            source_id: "chatgpt".into(),
            channel: Channel::McpEvents,
            target: "callback".into(),
            op: "task_status".into(),
            args: json!({}),
            turn: None,
            created_at: 100,
            expires_at: None,
            muted: false,
            until: None,
            webhook: Some(subscriptions::Webhook {
                principal: "caller".into(),
                ..Default::default()
            }),
        });
        state.save(&dir.0).unwrap();
        crate::kernel::origin::ORIGIN
            .scope(json!({"eventPrincipal":"caller"}), async {
                assert!(inbox_in(&dir.0, "chatgpt", &[], false, None)
                    .unwrap()
                    .is_null());
            })
            .await;
        // Suppression neither marks another caller's event read nor attaches it.
        assert_eq!(
            inbox_in(&dir.0, "chatgpt", &[], false, None).unwrap()["unread"],
            1
        );
    }

    #[tokio::test]
    async fn explicit_inbox_poll_preserves_session_visibility_and_ack_state() {
        // Regression: filtered polling must not expose another target or acknowledge unread events.
        let dir = Sandbox::new();
        let first = enqueue(
            &dir.0,
            "first",
            json!({"state":"completed","finalResponse":"done"}),
            100,
        )
        .await;
        let mut other = enqueue(
            &dir.0,
            "other",
            json!({"state":"failed","finalResponse":"failed"}),
            100,
        )
        .await;
        other.target = Some("session_010000000000000000000002".into());
        other.deliveries[0].target = "session_010000000000000000000002".into();
        persist(&dir.0, &other).unwrap();
        let filters = json!({"threadIds":["first"],"eventTypes":["completed"]});
        assert!(
            inbox_select(&dir.0, "claude", &[], true, None, Some(&filters))
                .unwrap()
                .is_null()
        );
        assert!(
            inbox_select(&dir.0, "different-source", &[], false, None, Some(&filters))
                .unwrap()
                .is_null()
        );
        let path = inbox_path(&dir.0, "claude");
        let before = load(&path).unwrap();
        for _ in 0..2 {
            let result = inbox_select(
                &dir.0,
                "claude",
                &[],
                true,
                Some("session_010000000000000000000001"),
                Some(&filters),
            )
            .unwrap();
            assert_eq!(result["events"][0]["threadId"], "first");
            assert_eq!(result["unread"], 1);
            assert_eq!(load(&path).unwrap(), before);
        }
        acknowledge_in(
            &dir.0,
            "claude",
            &json!({"eventIds":[first.deliveries[0].event_id]}),
        )
        .unwrap();
        assert!(inbox_select(
            &dir.0,
            "claude",
            &[],
            true,
            Some("session_010000000000000000000001"),
            Some(&filters)
        )
        .unwrap()
        .is_null());
        let result = inbox_select(
            &dir.0,
            "claude",
            &[],
            true,
            Some("session_010000000000000000000002"),
            Some(&json!({})),
        )
        .unwrap();
        assert_eq!(result["events"][0]["threadId"], "other");
    }

    #[tokio::test]
    async fn ordinary_notifications_flush_after_quiet_time_and_merge_bursts() {
        // Regression: 292260b; ordinary notifications flush after quiet time and merge bursts.
        let dir = Sandbox::new();
        let fake = Fake::success();
        let lock = Mutex::new(());
        let settings = json!({"notificationBucketCapacity":10});
        enqueue(
            &dir.0,
            "single",
            json!({"state":"completed","finalResponse":"done"}),
            100,
        )
        .await;
        flush(&fake, &dir.0, &lock, 101, 30, &settings)
            .await
            .unwrap();
        assert_eq!(delivery_status(&dir.0, "single"), "pending");

        flush(&fake, &dir.0, &lock, 102, 30, &settings)
            .await
            .unwrap();
        assert_eq!(delivery_status(&dir.0, "single"), "delivered");

        enqueue(
            &dir.0,
            "burst-a",
            json!({"state":"completed","finalResponse":"done"}),
            110,
        )
        .await;
        enqueue(
            &dir.0,
            "burst-b",
            json!({"state":"completed","finalResponse":"done"}),
            111,
        )
        .await;
        flush(&fake, &dir.0, &lock, 112, 30, &settings)
            .await
            .unwrap();
        assert_eq!(delivery_status(&dir.0, "burst-a"), "pending");
        assert_eq!(delivery_status(&dir.0, "burst-b"), "pending");

        flush(&fake, &dir.0, &lock, 113, 30, &settings)
            .await
            .unwrap();
        assert_eq!(delivery_status(&dir.0, "burst-a"), "delivered");
        let a = binding(&dir.0, "burst-a", "turn-1").unwrap().unwrap();
        let b = binding(&dir.0, "burst-b", "turn-1").unwrap().unwrap();
        assert!(!a.deliveries[0].batch.is_empty());
        assert_eq!(a.deliveries[0].batch, b.deliveries[0].batch);

        assert_eq!(
            binding(&dir.0, "burst-a", "turn-1")
                .unwrap()
                .unwrap()
                .deliveries[0]
                .status,
            "delivered"
        );
        assert_eq!(
            binding(&dir.0, "burst-b", "turn-1")
                .unwrap()
                .unwrap()
                .deliveries[0]
                .status,
            "delivered"
        );
    }

    #[test]
    fn session_forms_and_turn_isolation() {
        // Regression: session parsing must reject invalid targets and binding must not cross turns.
        for input in [
            "session_010000000000000000000001",
            "https://claude.ai/code/session_010000000000000000000001?x=y",
            "claude.ai/code/session_010000000000000000000001",
            "http://claude.ai/code/session_010000000000000000000001#fragment",
        ] {
            assert_eq!(
                session_id(input).unwrap(),
                "session_010000000000000000000001"
            );
        }
        assert_eq!(
            session_id("cse_010000000000000000000005").unwrap(),
            "cse_010000000000000000000005"
        );
        for bad in [
            "",
            "session_",
            "cse_",
            "hello world",
            "--help",
            "https://other.invalid/code/session_010000000000000000000001",
            "session_a extra",
        ] {
            assert!(session_id(bad).is_err());
        }
        let dir = Sandbox::new();
        fixture(&dir.0);
        bind_in(
            &dir.0,
            Some("cse_010000000000000000000006"),
            "thread-1",
            "turn-2",
            "/projects/sample",
        )
        .unwrap();
        bind_in(&dir.0, None, "thread-1", "turn-3", "/projects/sample").unwrap();
        assert_eq!(
            binding(&dir.0, "thread-1", "turn-1")
                .unwrap()
                .unwrap()
                .target
                .as_deref(),
            Some("session_010000000000000000000001")
        );
        assert_eq!(
            binding(&dir.0, "thread-1", "turn-2")
                .unwrap()
                .unwrap()
                .target
                .as_deref(),
            Some("cse_010000000000000000000006")
        );
        assert!(binding(&dir.0, "thread-1", "turn-3").unwrap().is_none());
        bind_in(&dir.0, None, "thread-1", "turn-2", "").unwrap();
        assert_eq!(
            binding(&dir.0, "thread-1", "turn-2")
                .unwrap()
                .unwrap()
                .target
                .as_deref(),
            Some("cse_010000000000000000000006")
        );
    }
    #[tokio::test]
    async fn steer_without_session_keeps_binding_and_new_turn_stays_unbound() {
        // Regression: steering without a target must not erase the existing notification binding.
        let dir = Sandbox::new();
        fixture(&dir.0);
        bind_in(&dir.0, None, "thread-1", "turn-1", "").unwrap();
        bind_in(&dir.0, None, "thread-1", "turn-2", "").unwrap();
        let mut b = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
        assert_eq!(
            b.target.as_deref(),
            Some("session_010000000000000000000001")
        );
        assert!(binding(&dir.0, "thread-1", "turn-2").unwrap().is_none());
        let fake = Fake::success();
        process(&fake, &dir.0, &mut b, &json!({"state":"completed"}))
            .await
            .unwrap();
        assert_eq!(
            fake.calls.lock().unwrap()[0][3],
            "session_010000000000000000000001"
        );
    }
    #[test]
    fn notification_polls_reuse_bindings_and_publish_writes_without_reopening_history() {
        // Regression: the observer, delivery loop and nested routing reopened all bindings on every poll.
        let dir = Sandbox::new();
        let mut first = fixture(&dir.0);
        for index in 0..458 {
            let mut b = first.clone();
            b.thread_id = format!("thread-{index}");
            persist(&dir.0, &b).unwrap();
        }
        let count = records(&dir.0).unwrap().len();
        let warm = file_cache::thread_io();
        for _ in 0..3 {
            assert_eq!(records(&dir.0).unwrap().len(), count);
            assert_eq!(
                binding(&dir.0, "thread-1", "turn-1")
                    .unwrap()
                    .unwrap()
                    .source_id,
                "claude"
            );
        }
        assert_eq!(file_cache::thread_io(), warm);
        first.scope_end = Some("closed".into());
        persist(&dir.0, &first).unwrap();
        assert_eq!(
            matching_records(&dir.0, |b| b.scope_end.is_none())
                .unwrap()
                .len(),
            count - 1
        );
        assert_eq!(file_cache::thread_io(), warm);
        let state = governance::State::load(&dir.0).unwrap();
        state.save(&dir.0).unwrap();
        let path = dir.0.join("subscriptions/state.json");
        let before = file_cache::Stamp::read(&path).unwrap();
        state.save(&dir.0).unwrap();
        assert_eq!(file_cache::Stamp::read(&path).unwrap(), before);
    }
    #[test]
    fn binding_failure_marks_receipt_without_changing_dispatch_result() {
        // Regression: notification binding failure must not turn a successful dispatch into a failure.
        let dir = Sandbox::new();
        std::fs::create_dir_all(&dir.0).unwrap();
        let blocked = dir.0.join("not-a-directory");
        std::fs::write(&blocked, "fixture").unwrap();
        let result = bind_in(
            &blocked,
            Some("session_010000000000000000000001"),
            "thread-1",
            "turn-1",
            "",
        );
        assert!(result.is_err());
        let mut receipt =
            json!({"state":"completed","result":{"submitted":true,"turnId":"turn-1"}});
        record_binding(&mut receipt, result);
        assert_eq!(receipt["state"], "completed");
        assert_eq!(
            receipt["result"],
            json!({"submitted":true,"turnId":"turn-1"})
        );
        assert_eq!(receipt["notification"], "bind-failed");
    }
    #[test]
    fn seven_day_cleanup_preserves_open_scopes_and_unfinished_records() {
        // Regression: retention cleanup must preserve unfinished work and open thread-origin bindings; closed terminal records can expire.
        for terminal in [false, true] {
            let dir = Sandbox::new();
            let mut b = fixture(&dir.0);
            b.terminal = terminal;
            b.created_at = 100;
            persist(&dir.0, &b).unwrap();
            assert!(!remove_expired(&dir.0, &b, 101 + RETENTION_SECONDS).unwrap());
            governance::control_in(
                &dir.0,
                "claude",
                &json!({"action":"rebind","threadId":b.thread_id,"target":null}),
                100,
                &json!({}),
            )
            .unwrap();
            // Rebinding preserves the original creation time.
            bind_in(
                &dir.0,
                Some("cse_010000000000000000000006"),
                "thread-1",
                "turn-1",
                "",
            )
            .unwrap();
            let b = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
            assert_eq!(b.created_at, 100);
            assert!(!remove_expired(&dir.0, &b, 100 + RETENTION_SECONDS).unwrap());
            assert_eq!(
                remove_expired(&dir.0, &b, 101 + RETENTION_SECONDS).unwrap(),
                terminal
            );
            assert_eq!(
                binding(&dir.0, "thread-1", "turn-1").unwrap().is_none(),
                terminal
            );
        }
    }
    #[tokio::test]
    async fn delivery_releases_lock_and_merges_result_without_overwriting_rebind() {
        // Regression: delivery completion must not overwrite a concurrent rebind.
        struct Probe<'a> {
            lock: &'a Mutex<()>,
            dir: &'a Path,
            fail: bool,
        }
        impl Executor for Probe<'_> {
            async fn send(&self, _source_id: &str, _: Vec<String>) -> Result<Vec<u8>> {
                let _guard = self
                    .lock
                    .try_lock()
                    .expect("CLI must not hold binding lock");
                let b = binding(self.dir, "thread-1", "turn-1")?.unwrap();
                assert_eq!(b.deliveries[0].status, "sending");
                bind_in(
                    self.dir,
                    Some("cse_010000000000000000000006"),
                    "thread-1",
                    "turn-1",
                    "",
                )?;
                if self.fail {
                    Err("simulated failure".into())
                } else {
                    Ok(br#"{"ok":true,"session_id":"session_010000000000000000000001"}"#.to_vec())
                }
            }
            async fn escalate(&self, _: String) -> Result<()> {
                let _guard = self
                    .lock
                    .try_lock()
                    .expect("escalation must not hold binding lock");
                Ok(())
            }
        }
        for fail in [false, true] {
            let dir = Sandbox::new();
            let mut b = fixture(&dir.0);
            let lock = Mutex::new(());
            let probe = Probe {
                lock: &lock,
                dir: &dir.0,
                fail,
            };
            super::process(&dir.0, &lock, &mut b, &interaction(json!(17)))
                .await
                .unwrap();
            flush(&probe, &dir.0, &lock, i64::MAX, 0, &json!({}))
                .await
                .unwrap();
            let b = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
            assert_eq!(b.target.as_deref(), Some("cse_010000000000000000000006"));
            assert_eq!(b.deliveries[0].target, "session_010000000000000000000001");
            assert_eq!(
                b.deliveries[0].status,
                if fail { "pending" } else { "delivered" }
            );
            assert_eq!(notification(Some(b))["deliveries"], json!([]));
        }
    }

    #[tokio::test]
    async fn notification_diagnosis_explains_pending_restart_and_excluded_successors() {
        // Regression: notify_status returned empty deliveries without explaining restart gaps or non-inherited continuations.
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let pending = governance::status_in(
            &dir.0,
            "claude",
            &json!({"threadId":b.thread_id}),
            100,
            &json!({}),
        )
        .unwrap();
        assert!(pending["threads"][0]["diagnosis"]["reasons"]
            .as_array()
            .unwrap()
            .contains(&json!("pending-observation")));
        b.observation = json!({"reconciliation":"pending-after-restart","lastError":"native-observer-unavailable"});
        persist(&dir.0, &b).unwrap();
        let restarted = governance::status_in(
            &dir.0,
            "claude",
            &json!({"threadId":b.thread_id}),
            100,
            &json!({}),
        )
        .unwrap();
        assert!(restarted["threads"][0]["diagnosis"]["reasons"]
            .as_array()
            .unwrap()
            .contains(&json!("pending-after-restart")));
        let fake = Fake::success();
        process(
            &fake,
            &dir.0,
            &mut b,
            &json!({"state":"cancelled","nextTurnId":"user-turn",
            "nativeContinuation":{"excluded":true,"reason":"new-user-content"}}),
        )
        .await
        .unwrap();
        let explained = governance::status_in(
            &dir.0,
            "claude",
            &json!({"threadId":b.thread_id}),
            100,
            &json!({}),
        )
        .unwrap();
        let diagnosis = &explained["threads"][0]["diagnosis"];
        assert_eq!(diagnosis["successor"]["turnId"], "user-turn");
        assert_eq!(diagnosis["successor"]["inherited"], false);
        assert_eq!(diagnosis["scope"]["active"], false);
        assert!(diagnosis["reasons"]
            .as_array()
            .unwrap()
            .contains(&json!("successor-not-inherited")));
        for value in [&pending["threads"][0]["diagnosis"], diagnosis] {
            let catalog = catalog();
            let spec = catalog["ops"]
                .as_array()
                .unwrap()
                .iter()
                .find(|op| op["name"] == value["next"]["op"])
                .unwrap();
            crate::egress::validate_op(spec, &value["next"]["args"]).unwrap();
        }
    }

    async fn update_phases(dir: &Path, receipt: &Value, at: i64) {
        for phase in [
            "settling",
            "interrupting",
            "recovered",
            "outcome",
            "outcome",
        ] {
            recovery::update(dir, &Mutex::new(()), receipt, phase, at)
                .await
                .unwrap();
        }
        flush(
            &Fake::success(),
            dir,
            &Mutex::new(()),
            at + 31,
            0,
            &json!({}),
        )
        .await
        .unwrap();
    }

    fn lifecycle_status(dir: &Path, source: &str, at: i64) -> Value {
        governance::status_in(dir, source, &json!({"all":true}), at + 31, &json!({})).unwrap()
    }

    #[tokio::test]
    async fn update_and_restart_leave_unaffected_bound_conversations_inbox_only() {
        // Regression: ded33bbf woke unrelated conversations, including long-finished bindings, at every update phase.
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let at = chrono::Utc::now().timestamp();
        for terminal in [false, true] {
            b.terminal = terminal;
            persist(&dir.0, &b).unwrap();
            let receipt = json!({"id":format!("unaffected-{terminal}"),"state":"succeeded","shutdownRequested":true,
                "waiting":{"blockingTurns":[{"taskId":b.thread_id,"turnId":if terminal {&b.turn_id} else {"other-turn"},"question":{"id":1}}]},
                "interruptedTurns":[{"threadId":b.thread_id,"turnId":if terminal {&b.turn_id} else {"other-turn"},"state":if terminal {"finished-before-shutdown"} else {"receipt-returned"}}]});
            update_phases(&dir.0, &receipt, at).await;
        }
        recovery::enqueue(
            &dir.0,
            &Mutex::new(()),
            "unaffected-restart",
            at,
            &Default::default(),
        )
        .await
        .unwrap();
        flush(
            &Fake::success(),
            &dir.0,
            &Mutex::new(()),
            at + 31,
            0,
            &json!({}),
        )
        .await
        .unwrap();
        let status = lifecycle_status(&dir.0, &b.source_id, at);
        assert!(status["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d["state"] == "inbox-only"));
        let inbox = inbox_select(
            &dir.0,
            &b.source_id,
            &[],
            true,
            b.target.as_deref(),
            Some(&json!({})),
        )
        .unwrap();
        assert!(inbox["events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["next"]["op"].is_string()));
    }

    #[tokio::test]
    async fn update_retains_recovery_with_the_named_resumed_task_without_waking() {
        // Regression: ded33bbf sent pre-restart and separate recovered/outcome wakeups for one resumed task.
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        super::process(
            &dir.0,
            &Mutex::new(()),
            &mut b,
            &json!({"state":"cancelled"}),
        )
        .await
        .unwrap();
        b.thread_title = "Resume fixture".into();
        b.terminal = true;
        b.continuation_bound = true;
        persist(&dir.0, &b).unwrap();
        let mut successor = b.clone();
        successor.deliveries.clear();
        successor.turn_id = "resumed-turn".into();
        successor.terminal = false;
        successor.continuation_bound = false;
        persist(&dir.0, &successor).unwrap();
        let at = chrono::Utc::now().timestamp();
        let receipt = json!({"id":"resumed-update","state":"succeeded","shutdownRequested":true,
            "waiting":{"willResume":[{"taskId":b.thread_id,"turnId":b.turn_id}]},
            "interruptedTurns":[{"threadId":b.thread_id,"turnId":b.turn_id,"state":"receipt-returned",
                "resumeReceipt":{"state":"completed","turnId":successor.turn_id}}]});
        update_phases(&dir.0, &receipt, at).await;
        let status = lifecycle_status(&dir.0, &b.source_id, at);
        let sent = status["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["state"] == "delivered")
            .collect::<Vec<_>>();
        assert!(sent.is_empty());
        let inbox = inbox_in(&dir.0, &b.source_id, &[], false, None).unwrap();
        assert!(inbox["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "interrupted"));
        let outcome = inbox["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| {
                e["next"]["op"] == "update_status"
                    && e["summary"].as_str().is_some_and(|s| s.contains("resumed"))
            })
            .unwrap();
        assert_eq!(outcome["threadId"], b.thread_id);
        assert_eq!(outcome["recovery"]["affectedTasks"], 1);
        let summary = outcome["summary"].as_str().unwrap();
        assert!(
            summary.contains(&b.thread_title)
                && summary.contains(&b.thread_id)
                && summary.contains("resumed")
        );
        jsonschema::validator_for(&mcp_events::list()["events"][0]["payloadSchema"])
            .unwrap()
            .validate(&mcp_events::payload("task_status", outcome))
            .unwrap();
    }

    #[tokio::test]
    async fn replacement_resume_and_later_handoffs_stay_inbox_only() {
        // Regression: replacement resume woke the conversation twice, first with the merged resume notice and then unheld-to-connector handoff.
        for (handoff_before_outcome, handoff_before_adoption) in
            [(false, false), (true, false), (true, true)]
        {
            let dir = Sandbox::new();
            let mut original = fixture(&dir.0);
            original.terminal = true;
            original.continuation_bound = true;
            persist(&dir.0, &original).unwrap();
            prepare_replacement_resume_in(
                &dir.0, &Mutex::new(()), &original.thread_id, &original.turn_id,
                &json!({"threadId":original.thread_id,"interruptedTurnId":original.turn_id,"requestId":"replacement-resume"}),
            ).await.unwrap();
            let handoff = json!({"eventId":"resume-handoff","from":"unheld","to":"connector","observedAt":now(),"evidence":"native-writer-file-lock","timeBasis":"observed-not-transition-time"});
            if handoff_before_adoption {
                super::process(
                    &dir.0,
                    &Mutex::new(()),
                    &mut original,
                    &json!({"state":"unconfirmed","handoffs":[handoff]}),
                )
                .await
                .unwrap();
            }
            let mut successor = binding(&dir.0, &original.thread_id, &original.turn_id)
                .unwrap()
                .unwrap();
            successor.turn_id = "resumed-turn".into();
            successor.terminal = false;
            successor.continuation_bound = false;
            successor.deliveries.clear();
            persist(&dir.0, &successor).unwrap();
            let at = chrono::Utc::now().timestamp();
            let receipt = json!({"id":"resumed-update","state":"succeeded","shutdownRequested":true,
                "interruptedTurns":[{"threadId":original.thread_id,"turnId":original.turn_id,"state":"receipt-returned",
                    "resumeReceipt":{"state":"completed","turnId":successor.turn_id}}]});
            if !handoff_before_outcome {
                update_phases(&dir.0, &receipt, at).await;
            }
            super::process(
                &dir.0,
                &Mutex::new(()),
                &mut successor,
                &json!({"state":"unconfirmed","handoffs":[handoff]}),
            )
            .await
            .unwrap();
            if handoff_before_outcome {
                update_phases(&dir.0, &receipt, at).await;
            }
            flush(
                &Fake::success(),
                &dir.0,
                &Mutex::new(()),
                at + 31,
                0,
                &json!({}),
            )
            .await
            .unwrap();
            let status = lifecycle_status(&dir.0, &original.source_id, at);
            let deliveries = status["deliveries"].as_array().unwrap();
            assert_eq!(
                deliveries
                    .iter()
                    .filter(|d| d["state"] == "delivered")
                    .count(),
                0
            );
            let inbox = inbox_in(&dir.0, &original.source_id, &[], false, None).unwrap();
            let retained = inbox["events"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["kind"] == "handoff")
                .unwrap();
            assert_eq!(retained["ownership"], handoff);
            assert!(deliveries
                .iter()
                .any(|d| d["eventId"] == retained["eventId"] && d["state"] == "inbox-only"));
            // Re-observation and later ownership changes must not consume a second wake.
            let others = [
                json!({"eventId":"to-desktop","from":"connector","to":"desktop","observedAt":now()}),
                json!({"eventId":"to-unheld","from":"desktop","to":"unheld","observedAt":now()}),
                json!({"eventId":"later-connector","from":"unheld","to":"connector","observedAt":now()}),
            ];
            super::process(
                &dir.0,
                &Mutex::new(()),
                &mut successor,
                &json!({"state":"unconfirmed","handoffs":[handoff,others[0],others[1],others[2]]}),
            )
            .await
            .unwrap();
            flush(
                &Fake::success(),
                &dir.0,
                &Mutex::new(()),
                at + 62,
                0,
                &json!({}),
            )
            .await
            .unwrap();
            let status = lifecycle_status(&dir.0, &original.source_id, at + 62);
            assert_eq!(
                status["deliveries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|d| d["state"] == "delivered")
                    .count(),
                0
            );
            let inbox = inbox_select(
                &dir.0,
                &original.source_id,
                &[],
                false,
                None,
                Some(&json!({})),
            )
            .unwrap();
            assert!(inbox["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["eventId"] == retained["eventId"]));
        }
    }

    #[tokio::test]
    async fn delayed_resume_refreshes_one_outcome_without_waking() {
        // Regression: replacement resume receipts can still be pending when the worker publishes its terminal outcome.
        let dir = Sandbox::new();
        let b = fixture(&dir.0);
        let at = chrono::Utc::now().timestamp();
        let mut receipt = json!({"id":"pending-resume","state":"succeeded","shutdownRequested":true,
            "interruptedTurns":[{"threadId":b.thread_id,"turnId":b.turn_id,"state":"receipt-returned",
                "resumeReceipt":{"state":"pending"}}]});
        update_phases(&dir.0, &receipt, at).await;
        assert!(lifecycle_status(&dir.0, &b.source_id, at)["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d["state"] == "inbox-only"));
        let before = inbox_in(&dir.0, &b.source_id, &[], false, None).unwrap();
        receipt["interruptedTurns"][0]["resumeReceipt"] =
            json!({"state":"completed","turnId":"resumed"});
        update_phases(&dir.0, &receipt, at + 1).await;
        let status = lifecycle_status(&dir.0, &b.source_id, at + 1);
        let sent = status["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["state"] == "delivered")
            .collect::<Vec<_>>();
        assert!(sent.is_empty());
        let after = inbox_in(&dir.0, &b.source_id, &[], false, None).unwrap();
        assert_eq!(before["unread"], after["unread"]);
        let outcome = after["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| {
                e["next"]["op"] == "update_status"
                    && e["summary"].as_str().is_some_and(|s| s.contains("resumed"))
            })
            .unwrap();
        assert!(before["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["eventId"] == outcome["eventId"]));
        assert!(outcome["summary"].as_str().unwrap().contains("resumed"));
    }

    #[tokio::test]
    async fn settling_question_wakes_once_without_a_separate_update_notice() {
        // Regression: ded33bbf broadcast settling blockers to every bound conversation instead of asking their owner.
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let mut unrelated = b.clone();
        unrelated.thread_id = "unrelated".into();
        unrelated.source_id = "other-source".into();
        verified_fixture_target(&dir.0, &unrelated);
        persist(&dir.0, &unrelated).unwrap();
        super::process(&dir.0, &Mutex::new(()), &mut b,
            &json!({"state":"interaction-required","interaction":[{"id":7,"method":"item/tool/requestUserInput","params":{"questions":[{"id":"q","question":"Choose a plan"}]}}]})).await.unwrap();
        let at = chrono::Utc::now().timestamp();
        let receipt = json!({"id":"question-update","state":"settling","waiting":{"blockingTurns":[
            {"agent":"codex","taskId":b.thread_id,"turnId":b.turn_id,"question":{"id":7}}]}});
        recovery::update(&dir.0, &Mutex::new(()), &receipt, "settling", at)
            .await
            .unwrap();
        flush(
            &Fake::success(),
            &dir.0,
            &Mutex::new(()),
            at + 31,
            0,
            &json!({}),
        )
        .await
        .unwrap();
        recovery::update(&dir.0, &Mutex::new(()), &receipt, "settling", at + 1)
            .await
            .unwrap();
        flush(
            &Fake::success(),
            &dir.0,
            &Mutex::new(()),
            at + 32,
            0,
            &json!({}),
        )
        .await
        .unwrap();
        let status = lifecycle_status(&dir.0, &b.source_id, at);
        let sent = status["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["state"] == "delivered")
            .collect::<Vec<_>>();
        assert_eq!(sent.len(), 1);
        let inbox = inbox_in(&dir.0, &b.source_id, &[], false, None).unwrap();
        let question = inbox["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["eventId"] == sent[0]["eventId"])
            .unwrap();
        assert_eq!(question["threadId"], b.thread_id);
        assert_eq!(question["kind"], "needs-input");
        assert_eq!(question["interaction"]["id"], 7);
        assert!(
            lifecycle_status(&dir.0, &unrelated.source_id, at)["deliveries"]
                .as_array()
                .unwrap()
                .iter()
                .all(|d| d["state"] == "inbox-only")
        );
    }

    #[tokio::test]
    async fn update_submitter_keeps_outcome_inbox_only_even_with_a_blocker() {
        // Regression: ded33bbf woke the update submitter at settling, interruption and recovery before the outcome.
        let dir = Sandbox::new();
        let b = fixture(&dir.0);
        let at = chrono::Utc::now().timestamp();
        let receipt = json!({"id":"submitted-update","state":"cancelled",
            "continuationBinding":{"threadId":b.thread_id,"turnId":b.turn_id,"origin":{"sourceId":b.source_id}},
            "waiting":{"blockingTurns":[{"taskId":b.thread_id,"turnId":b.turn_id,"question":{"id":7}}]}});
        update_phases(&dir.0, &receipt, at).await;
        let status = lifecycle_status(&dir.0, &b.source_id, at);
        let sent = status["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["state"] == "delivered")
            .collect::<Vec<_>>();
        assert!(sent.is_empty());
        let inbox = inbox_in(&dir.0, &b.source_id, &[], false, None).unwrap();
        let events = inbox["events"].as_array().unwrap();
        assert!(events.iter().all(|e| e["next"]["op"] == "update_status"));
        assert!(events.iter().any(|e| e["recovery"]["affectedTasks"] == 0));
        assert!(events.iter().any(|e| e["recovery"]["affectedTasks"] == 1));
    }

    #[tokio::test]
    async fn command_submitter_retains_outcome_without_waking() {
        // Regression: replacement launched by a control-source command lost its submitter and never notified that conversation.
        let dir = Sandbox::new();
        let b = fixture(&dir.0);
        let mut other = b.clone();
        other.source_id = "other-source".into();
        other.thread_id = "other-thread".into();
        other.turn_id = "other-turn".into();
        other.target = Some("session_010000000000000000000002".into());
        persist(&dir.0, &other).unwrap();
        let origin = json!({"sourceId":b.source_id,"controlSource":"claude","authType":"oauth"});
        governance::bind_target_in(
            &dir.0,
            &b.source_id,
            &json!({"target":b.target}),
            chrono::Utc::now().timestamp(),
            &json!({}),
        )
        .unwrap();
        let mut ended = b.clone();
        ended.scope_end = Some("thread-archived".into());
        persist(&dir.0, &ended).unwrap();
        let submitter = command_submitter_in(&dir.0, &origin).unwrap();
        let encoded = submitter.to_string();
        let submitter = crate::shell_command::submitter_from_environment(Some(&encoded));
        assert_eq!(submitter["origin"], origin);
        assert_eq!(submitter["notify"]["target"], json!(b.target));
        let at = chrono::Utc::now().timestamp();
        let receipt = json!({"id":"command-update","state":"succeeded","submitter":submitter});
        update_phases(&dir.0, &receipt, at).await;
        let status = lifecycle_status(&dir.0, &b.source_id, at);
        let sent = status["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["state"] == "delivered")
            .collect::<Vec<_>>();
        assert!(sent.is_empty());
        let inbox = inbox_in(&dir.0, &b.source_id, &[], false, None).unwrap();
        let outcome = inbox["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["next"]["op"] == "update_status")
            .unwrap();
        assert_eq!(outcome["next"]["op"], "update_status");
        assert_eq!(outcome["recovery"]["affectedTasks"], 0);
        assert!(lifecycle_status(&dir.0, &other.source_id, at)["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d["state"] == "inbox-only"));
    }

    #[test]
    fn command_submitter_does_not_guess_between_conversations_or_attribute_plain_terminals() {
        // Regression: command-based replacement must not infer a submitter for an unattributed local terminal or an ambiguous source.
        let dir = Sandbox::new();
        let b = fixture(&dir.0);
        let mut other = b.clone();
        other.thread_id = "other-thread".into();
        other.turn_id = "other-turn".into();
        other.target = Some("session_010000000000000000000002".into());
        persist(&dir.0, &other).unwrap();
        let origin = json!({"sourceId":b.source_id,"authType":"oauth"});
        let context = command_submitter_in(&dir.0, &origin).unwrap();
        assert_eq!(context["origin"], origin);
        assert!(context["notify"].is_null());
        for raw in [
            None,
            Some(""),
            Some("invalid"),
            Some("{}"),
            Some("{\"origin\":{\"sourceId\":\"\"}} "),
        ] {
            assert!(crate::shell_command::submitter_from_environment(raw).is_null());
        }
        assert!(
            command_submitter_in(&dir.0, &json!({"sourceId":b.source_id,"authType":"local"}))
                .unwrap()["notify"]
                .is_null()
        );
    }

    #[tokio::test]
    async fn recovery_aggregates_interrupted_turns_per_verified_target_and_restart() {
        // Regression: disconnected conversations received no recovery wakeup and per-thread restart notices flooded targets.
        let dir = Sandbox::new();
        let b = fixture(&dir.0);
        let interrupted = [
            ("thread-1".into(), "turn-1".into()),
            ("thread-1".into(), "turn-2".into()),
        ]
        .into();
        for (thread, turn, source, target, closed) in [
            ("thread-1", "turn-2", "claude", b.target.clone(), false),
            ("thread-2", "turn-1", "claude", b.target.clone(), false),
            ("closed", "turn-1", "claude", b.target.clone(), true),
            (
                "unverified",
                "turn-1",
                "claude",
                Some("session_010000000000000000000002".into()),
                false,
            ),
            (
                "foreign",
                "turn-1",
                "foreign-source",
                b.target.clone(),
                false,
            ),
        ] {
            let mut next = b.clone();
            next.thread_id = thread.into();
            next.turn_id = turn.into();
            next.source_id = source.into();
            next.target = target;
            next.scope_end = closed.then(|| "thread-archived".into());
            persist(&dir.0, &next).unwrap();
        }
        let at = chrono::Utc::now().timestamp();
        for _ in 0..3 {
            recovery::enqueue(&dir.0, &Mutex::new(()), "restart-1", at, &interrupted)
                .await
                .unwrap();
        }
        let fake = Fake::success();
        flush(&fake, &dir.0, &Mutex::new(()), at + 31, 0, &json!({}))
            .await
            .unwrap();
        // Each restart retains one source-scoped inbox event without a wakeup.
        for restart in ["restart-1", "restart-2", "restart-2", "restart-3"] {
            recovery::enqueue(&dir.0, &Mutex::new(()), restart, at + 32, &interrupted)
                .await
                .unwrap();
        }
        let status =
            governance::status_in(&dir.0, "claude", &json!({"all":true}), at + 32, &json!({}))
                .unwrap();
        let deliveries = status["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["target"] == b.target.as_deref().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            deliveries
                .iter()
                .filter(|d| d["kind"] == "recovered")
                .count(),
            3
        );
        assert_eq!(
            deliveries
                .iter()
                .filter(|d| d["state"] == "delivered")
                .count(),
            0
        );
        let inbox = inbox_in(&dir.0, "claude", &[], false, None).unwrap();
        for event in inbox["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["target"] == b.target.as_deref().unwrap())
        {
            assert_eq!(event["recovery"]["affectedTasks"], 2);
            assert_eq!(event["target"], b.target.clone().unwrap());
        }
        let foreign = inbox_in(&dir.0, "foreign-source", &[], false, None).unwrap();
        assert!(foreign["events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["threadId"] == "foreign" && e["recovery"]["affectedTasks"] == 0));
    }

    #[tokio::test]
    async fn recovery_counts_a_replacement_turn_already_interrupted_and_resumed() {
        // Regression: 4ffbe47 reported zero interrupted turns after replacement resumed one journaled turn.
        let dir = Sandbox::new();
        let mut old = fixture(&dir.0);
        let lock = Mutex::new(());
        super::process(&dir.0, &lock, &mut old, &json!({"state":"cancelled"}))
            .await
            .unwrap();
        old.continuation_bound = true;
        persist(&dir.0, &old).unwrap();
        let mut resumed = old.clone();
        resumed.turn_id = "resumed-turn".into();
        resumed.terminal = false;
        resumed.continuation_bound = false;
        resumed.deliveries.clear();
        persist(&dir.0, &resumed).unwrap();
        let mut replacement = json!({
            "state":"resuming", "shutdownRequested":true, "coreInstance":"old-core",
            "resumedCount":1, "interruptedTurns":[{
                "threadId":old.thread_id, "turnId":old.turn_id, "state":"receipt-returned",
                "resumeReceipt":{"state":"completed", "turnId":resumed.turn_id}
            }]
        });
        let interrupted = crate::app_replace::recovery_turns(&replacement, "new-core").unwrap();
        recovery::enqueue(
            &dir.0,
            &lock,
            "replacement-restart",
            chrono::Utc::now().timestamp(),
            &interrupted,
        )
        .await
        .unwrap();
        let inbox = inbox_in(&dir.0, "claude", &[], false, None).unwrap();
        let recovered = inbox["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["kind"] == "recovered")
            .collect::<Vec<_>>();
        assert_eq!(recovered.len(), 1);
        assert_eq!(
            recovered[0]["recovery"]["affectedTasks"],
            replacement["resumedCount"]
        );
        assert!(crate::app_replace::recovery_turns(&replacement, "old-core").is_none());
        replacement["interruptedTurns"][0]["state"] = json!("finished-before-shutdown");
        assert!(crate::app_replace::recovery_turns(&replacement, "new-core")
            .unwrap()
            .is_empty());
        replacement["state"] = json!("succeeded");
        assert!(crate::app_replace::recovery_turns(&replacement, "later-core").is_none());
        replacement["state"] = json!("countdown");
        replacement["shutdownRequested"] = json!(false);
        assert!(crate::app_replace::recovery_turns(&replacement, "other-core").is_none());
    }

    #[tokio::test]
    async fn recovery_excludes_finished_turns_with_retained_bindings() {
        // Regression: finished tasks with notification bindings were reported as affected after replacement with no interrupted turns.
        let dir = Sandbox::new();
        let b = fixture(&dir.0);
        let lock = Mutex::new(());
        for (thread, state) in [
            ("finished", "completed"),
            ("failed", "failed"),
            ("previously-interrupted", "cancelled"),
        ] {
            let mut ended = b.clone();
            ended.thread_id = thread.into();
            persist(&dir.0, &ended).unwrap();
            super::process(&dir.0, &lock, &mut ended, &json!({"state":state}))
                .await
                .unwrap();
        }
        let at = chrono::Utc::now().timestamp();
        recovery::enqueue(&dir.0, &lock, "idle-restart", at, &Default::default())
            .await
            .unwrap();
        let inbox = inbox_in(&dir.0, "claude", &[], false, None).unwrap();
        let recovered = inbox["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["kind"] == "recovered")
            .collect::<Vec<_>>();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0]["recovery"]["affectedTasks"], 0);
        assert!(recovered[0]["summary"]
            .as_str()
            .unwrap()
            .starts_with(RECEIPT_HEADER));
        let schema = mcp_events::list()["events"][0]["payloadSchema"].clone();
        let validator = jsonschema::validator_for(&schema).unwrap();
        let payload = mcp_events::payload("task_status", recovered[0]);
        validator.validate(&payload).unwrap();
        let mut invalid = payload;
        invalid["recovery"]["affectedTasks"] = json!(-1);
        assert!(validator.validate(&invalid).is_err());
    }

    #[tokio::test]
    async fn recovery_honors_disabled_notifications_without_verifying_targets() {
        // Regression: recovery must preserve 6ed4ed8 verification gates and never promote an unverified target.
        let dir = Sandbox::new();
        let b = fixture(&dir.0);
        let at = chrono::Utc::now().timestamp();
        let mut unverified = b.clone();
        unverified.thread_id = "unverified-thread".into();
        unverified.target = Some("session_010000000000000000000002".into());
        persist(&dir.0, &unverified).unwrap();
        let disabled = json!({"notificationsEnabled":false});
        let mut state = State::load(&dir.0).unwrap();
        state.target(
            &b.source_id,
            b.channel,
            unverified.target.as_deref().unwrap(),
            at,
            &disabled,
        );
        state.save(&dir.0).unwrap();
        let before =
            governance::status_in(&dir.0, "claude", &json!({"all":true}), at, &disabled).unwrap();
        recovery::enqueue(
            &dir.0,
            &Mutex::new(()),
            "disabled-restart",
            at,
            &[
                (b.thread_id.clone(), b.turn_id.clone()),
                (unverified.thread_id.clone(), unverified.turn_id.clone()),
            ]
            .into(),
        )
        .await
        .unwrap();
        let fake = Fake::success();
        flush(&fake, &dir.0, &Mutex::new(()), at + 31, 0, &disabled)
            .await
            .unwrap();
        let waiting =
            governance::status_in(&dir.0, "claude", &json!({"all":true}), at + 31, &disabled)
                .unwrap();
        let deliveries = waiting["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["target"] == b.target.as_deref().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0]["kind"], "recovered");
        assert_eq!(deliveries[0]["target"], b.target.as_deref().unwrap());
        assert_eq!(deliveries[0]["state"], "inbox-only");
        assert!(deliveries[0]["timing"]["queueReason"].is_null());
        for target in waiting["targets"].as_array().unwrap() {
            let original = before["targets"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["target"] == target["target"])
                .unwrap();
            assert_eq!(target["tokens"], original["tokens"]);
            assert_eq!(target["reachability"], original["reachability"]);
            assert_eq!(
                target["verificationAttempts"],
                original["verificationAttempts"]
            );
        }
        flush(
            &fake,
            &dir.0,
            &Mutex::new(()),
            at + 32,
            0,
            &json!({"notificationsEnabled":true}),
        )
        .await
        .unwrap();
        let delivered =
            governance::status_in(&dir.0, "claude", &json!({"all":true}), at + 32, &json!({}))
                .unwrap();
        let sent = delivered["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["target"] == b.target.as_deref().unwrap())
            .unwrap();
        assert!(delivered["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["target"] == unverified.target.as_deref().unwrap()
                && d["state"] == "inbox-only"));
        assert_eq!(sent["eventId"], deliveries[0]["eventId"]);
        assert_eq!(sent["state"], "inbox-only");
        let unverified = delivered["targets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["target"] == unverified.target.as_deref().unwrap())
            .unwrap();
        assert_eq!(unverified["reachability"], "unverified");
        assert_eq!(unverified["verificationAttempts"], 0);
    }

    #[tokio::test]
    async fn recovery_stays_inbox_only_across_bucket_refill() {
        // Regression: a recovery wakeup must not bypass a depleted bucket or duplicate across repeated restarts.
        let dir = Sandbox::new();
        let b = fixture(&dir.0);
        let at = chrono::Utc::now().timestamp();
        let settings = json!({"notificationBucketCapacity":1,"notificationRefillSeconds":600});
        let mut state = State::load(&dir.0).unwrap();
        let target = state.target(
            &b.source_id,
            b.channel,
            b.target.as_deref().unwrap(),
            at,
            &settings,
        );
        target.tokens = 0;
        target.refilled_at = at;
        state.save(&dir.0).unwrap();
        recovery::enqueue(
            &dir.0,
            &Mutex::new(()),
            "restart-1",
            at,
            &[(b.thread_id.clone(), b.turn_id.clone())].into(),
        )
        .await
        .unwrap();
        let fake = Fake::success();
        flush(&fake, &dir.0, &Mutex::new(()), at + 31, 0, &settings)
            .await
            .unwrap();
        let waiting =
            governance::status_in(&dir.0, "claude", &json!({"all":true}), at + 31, &settings)
                .unwrap();
        assert_eq!(waiting["deliveries"][0]["state"], "inbox-only");
        assert!(waiting["deliveries"][0]["timing"]["queueReason"].is_null());
        for restart in ["restart-1", "restart-2", "restart-3"] {
            recovery::enqueue(
                &dir.0,
                &Mutex::new(()),
                restart,
                at + 32,
                &[(b.thread_id.clone(), b.turn_id.clone())].into(),
            )
            .await
            .unwrap();
        }
        flush(&fake, &dir.0, &Mutex::new(()), at + 601, 0, &settings)
            .await
            .unwrap();
        let delivered =
            governance::status_in(&dir.0, "claude", &json!({"all":true}), at + 601, &settings)
                .unwrap();
        assert_eq!(delivered["deliveries"].as_array().unwrap().len(), 3);
        assert!(delivered["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["eventId"] == waiting["deliveries"][0]["eventId"]));
        assert!(delivered["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d["state"] == "inbox-only"));
        assert_eq!(delivered["targets"][0]["tokens"], 1);
    }

    #[tokio::test]
    async fn recovery_callbacks_stay_inbox_only_and_preserve_subscription_filters() {
        // Regression: recovery must wake only verified matching destinations without task-subscription fanout.
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        b.target = None;
        persist(&dir.0, &b).unwrap();
        let mut other = b.clone();
        other.thread_id = "thread-2".into();
        persist(&dir.0, &other).unwrap();
        let at = chrono::Utc::now().timestamp();
        let mut state = State::load(&dir.0).unwrap();
        for (id, source, verified, args) in [
            (
                "verified-callback",
                "claude",
                at + 3600,
                json!({"threadId":"thread-1"}),
            ),
            ("expired-callback", "claude", at, json!({})),
            ("foreign-callback", "foreign", at + 3600, json!({})),
            (
                "no-binding",
                "claude",
                at + 3600,
                json!({"threadId":"absent"}),
            ),
        ] {
            state.subscriptions.push(subscriptions::Subscription {
                id: id.into(),
                source_id: source.into(),
                channel: Channel::McpEvents,
                target: id.into(),
                op: "task_status".into(),
                args,
                turn: None,
                created_at: at * 1000,
                expires_at: None,
                muted: false,
                until: None,
                webhook: Some(subscriptions::Webhook {
                    verified_until: verified,
                    ..Default::default()
                }),
            });
        }
        state.save(&dir.0).unwrap();
        for _ in 0..3 {
            recovery::enqueue(
                &dir.0,
                &Mutex::new(()),
                "restart-callback",
                at,
                &[(b.thread_id.clone(), b.turn_id.clone())].into(),
            )
            .await
            .unwrap();
        }
        flush(
            &Fake::success(),
            &dir.0,
            &Mutex::new(()),
            at + 31,
            0,
            &json!({}),
        )
        .await
        .unwrap();
        let status =
            governance::status_in(&dir.0, "claude", &json!({"all":true}), at + 31, &json!({}))
                .unwrap();
        let deliveries = status["deliveries"].as_array().unwrap();
        assert!(deliveries
            .iter()
            .any(|d| d["target"] == "verified-callback" && d["state"] == "inbox-only"));
        assert!(deliveries
            .iter()
            .filter(|d| d["target"] != "verified-callback")
            .all(|d| d["state"] == "inbox-only"));
        assert!(!deliveries
            .iter()
            .any(|d| d["target"] == "foreign-callback" || d["target"] == "no-binding"));
        let inbox = inbox_in(&dir.0, "claude", &[], false, None).unwrap();
        assert_eq!(inbox["events"][0]["recovery"]["affectedTasks"], 1);
    }

    #[tokio::test]
    async fn handoff_stays_inbox_only_if_task_ends_before_delivery() {
        // Regression: persisted handoff queues replayed idle-thread wakeups after restart.
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let handoff = json!({"state":"unconfirmed","handoffs":[{"eventId":"queued-handoff","from":"connector","to":"unheld","observedAt":now(),"evidence":null,"timeBasis":"observed-not-transition-time"}]});
        super::process(&dir.0, &Mutex::new(()), &mut b, &handoff)
            .await
            .unwrap();
        super::process(
            &dir.0,
            &Mutex::new(()),
            &mut b,
            &json!({"state":"completed"}),
        )
        .await
        .unwrap();
        let fake = Fake::success();
        let at = chrono::Utc::now().timestamp() + 31;
        for _ in 0..3 {
            super::recover(&dir.0, &mut b).unwrap();
            flush(&fake, &dir.0, &Mutex::new(()), at, 0, &json!({}))
                .await
                .unwrap();
            b = binding(&dir.0, &b.thread_id, &b.turn_id).unwrap().unwrap();
        }
        let status =
            governance::status_in(&dir.0, "claude", &json!({"all":true}), at, &json!({})).unwrap();
        let deliveries = status["deliveries"].as_array().unwrap();
        assert!(deliveries
            .iter()
            .filter(|d| d["kind"] == "handoff")
            .all(|d| d["state"] == "inbox-only"));
        assert!(deliveries
            .iter()
            .any(|d| d["kind"] == "completed" && d["state"] == "delivered"));
    }

    #[tokio::test]
    async fn handoffs_retain_existing_inbox_coverage_without_push() {
        // Regression: every ended bound thread emitted connector-to-unheld and desktop-to-unheld notices after restart.
        for (state, terminal, expected) in [
            ("completed", true, 0),
            ("running", false, 2),
            ("interaction-required", true, 2),
        ] {
            let dir = Sandbox::new();
            let mut b = fixture(&dir.0);
            let observed = if state == "interaction-required" {
                interaction(json!(17))
            } else {
                json!({"state":state})
            };
            super::process(&dir.0, &Mutex::new(()), &mut b, &observed)
                .await
                .unwrap();
            b.terminal = terminal;
            persist(&dir.0, &b).unwrap();
            let handoffs = json!({"state":"unconfirmed","handoffs":[
                {"eventId":"connector-unheld","from":"connector","to":"unheld","observedAt":now(),"evidence":null,"timeBasis":"observed-not-transition-time"},
                {"eventId":"desktop-unheld","from":"desktop","to":"unheld","observedAt":now(),"evidence":null,"timeBasis":"observed-not-transition-time"}
            ]});
            for _ in 0..3 {
                b = binding(&dir.0, &b.thread_id, &b.turn_id).unwrap().unwrap();
                super::recover(&dir.0, &mut b).unwrap();
                super::process(&dir.0, &Mutex::new(()), &mut b, &handoffs)
                    .await
                    .unwrap();
            }
            let status =
                governance::status_in(&dir.0, "claude", &json!({"all":true}), i64::MAX, &json!({}))
                    .unwrap();
            assert_eq!(
                status["deliveries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|d| d["kind"] == "handoff")
                    .count(),
                expected
            );
            flush(
                &Fake::success(),
                &dir.0,
                &Mutex::new(()),
                chrono::Utc::now().timestamp() + 31,
                0,
                &json!({}),
            )
            .await
            .unwrap();
            let status =
                governance::status_in(&dir.0, "claude", &json!({"all":true}), i64::MAX, &json!({}))
                    .unwrap();
            assert!(status["deliveries"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|d| d["kind"] == "handoff")
                .all(|d| d["state"] == "inbox-only"));
            let inbox = inbox_in(&dir.0, "claude", &[], false, None).unwrap();
            assert_eq!(
                inbox["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|e| e["kind"] == "handoff")
                    .count(),
                expected
            );
        }
    }

    #[tokio::test]
    async fn reconciled_interruption_reports_continued_outcome_once() {
        // Regression: restart sent a bare interruption after Desktop Resume had already completed the work.
        for state in ["completed", "running"] {
            let dir = Sandbox::new();
            let mut old = fixture(&dir.0);
            old.continuation_bound = true;
            old.successor =
                json!({"turnId":"resumed-turn","inherited":true,"reason":"native-continuation"});
            old.observation = json!({"reconciliation":"pending-after-restart"});
            persist(&dir.0, &old).unwrap();
            let mut next = old.clone();
            next.turn_id = "resumed-turn".into();
            next.continuation_bound = false;
            next.successor = Value::Null;
            next.observation = json!({"state":state});
            persist(&dir.0, &next).unwrap();
            let fake = Fake::success();
            for _ in 0..3 {
                super::recover(&dir.0, &mut old).unwrap();
                process(&fake, &dir.0, &mut old, &json!({"state":"cancelled"}))
                    .await
                    .unwrap();
            }
            let inbox = inbox_in(&dir.0, "claude", &[], false, None).unwrap();
            assert_eq!(inbox["events"].as_array().unwrap().len(), 1);
            assert!(string(&inbox["events"][0], "summary")
                .contains(string(&inbox["events"][0]["continuation"], "turnId")));
            assert_eq!(
                inbox["events"][0]["continuation"],
                json!({"turnId":"resumed-turn","state":state})
            );
        }
    }

    include!("claude_notify/ax_tests.rs");

    #[tokio::test]
    async fn pending_interruption_refreshes_when_continuation_finishes() {
        // Regression: an interruption waiting for bucket tokens lost the continuation's completed outcome.
        let dir = Sandbox::new();
        let mut old = fixture(&dir.0);
        super::process(
            &dir.0,
            &Mutex::new(()),
            &mut old,
            &json!({"state":"cancelled"}),
        )
        .await
        .unwrap();
        old.continuation_bound = true;
        old.successor = json!({"turnId":"resumed-turn","inherited":true});
        persist(&dir.0, &old).unwrap();
        let mut next = old.clone();
        next.turn_id = "resumed-turn".into();
        next.successor = Value::Null;
        next.deliveries.clear();
        next.observation = json!({"state":"completed"});
        persist(&dir.0, &next).unwrap();
        let fake = Fake::success();
        flush(&fake, &dir.0, &Mutex::new(()), i64::MAX, 0, &json!({}))
            .await
            .unwrap();
        let restored = binding(&dir.0, &old.thread_id, &old.turn_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            notification(Some(restored.clone()))["deliveries"][0]["state"],
            "resolved"
        );
        let data = mcp_events::payload("task_status", &event(&restored, &restored.deliveries[0]));
        assert_eq!(
            data["continuation"],
            json!({"turnId":"resumed-turn","state":"completed"})
        );
        let inbox = inbox_in(&dir.0, "claude", &[], false, None).unwrap();
        assert_eq!(inbox["events"][0]["continuation"], data["continuation"]);
        assert!(inbox_in(&dir.0, "claude", &[], true, old.target.as_deref())
            .unwrap()
            .is_null());
    }

    #[tokio::test]
    async fn restart_duration_uses_native_end_or_last_activity_without_downtime() {
        // Regression: a ten-minute interrupted turn was reported as 146 minutes after restart.
        for (timing, last, expected, basis) in [
            (
                json!({"startedAt":"2026-01-01T00:00:00Z","endedAt":"2026-01-01T00:10:00Z"}),
                Some("2026-01-01T00:09:00Z"),
                json!(600000),
                "native-terminal",
            ),
            (
                Value::Null,
                Some("2026-01-01T00:09:00Z"),
                json!(540000),
                "last-observed-activity",
            ),
            (Value::Null, None, Value::Null, "unknown"),
        ] {
            let dir = Sandbox::new();
            let mut b = fixture(&dir.0);
            b.created_at = 1767225600;
            b.observation = json!({"reconciliation":"pending-after-restart","observedAt":last});
            persist(&dir.0, &b).unwrap();
            let observed = json!({"state":"cancelled","turnTiming":timing});
            let fake = Fake::success();
            process(&fake, &dir.0, &mut b, &observed).await.unwrap();
            for _ in 0..3 {
                b = binding(&dir.0, &b.thread_id, &b.turn_id).unwrap().unwrap();
                super::recover(&dir.0, &mut b).unwrap();
                process(&fake, &dir.0, &mut b, &observed).await.unwrap();
            }
            let inbox = inbox_in(&dir.0, "claude", &[], false, None).unwrap();
            let event = &inbox["events"][0];
            assert_eq!(inbox["events"].as_array().unwrap().len(), 1);
            assert_eq!(event["reconciliation"]["durationMs"], expected);
            assert_eq!(event["reconciliation"]["timeBasis"], basis);
        }
    }

    #[tokio::test]
    async fn downtime_terminal_reconciliation_is_idempotent_without_a_loaded_writer() {
        // Regression: connector restart left interrupted/completed bound turns with zero deliveries forever.
        for (native, expected) in [
            ("interrupted", "interrupted"),
            ("completed", "completed"),
            ("failed", "failed"),
        ] {
            let dir = Sandbox::new();
            let mut b = fixture(&dir.0);
            let fake = Fake::success();
            let observed = crate::waiter::classify(
                &json!({"thread":{"id":b.thread_id,
                "status":{"type":"notLoaded"},"turns":[{"id":b.turn_id,"status":native,"items":[]}]}}),
                &mut Some(b.turn_id.clone()),
            );
            process(&fake, &dir.0, &mut b, &observed).await.unwrap();
            let delivered =
                governance::status_in(&dir.0, "claude", &json!({"all":true}), i64::MAX, &json!({}))
                    .unwrap();
            for _ in 0..3 {
                let mut restored = binding(&dir.0, &b.thread_id, &b.turn_id).unwrap().unwrap();
                super::recover(&dir.0, &mut restored).unwrap();
                process(&fake, &dir.0, &mut restored, &observed)
                    .await
                    .unwrap();
            }
            let replayed =
                governance::status_in(&dir.0, "claude", &json!({"all":true}), i64::MAX, &json!({}))
                    .unwrap();
            assert_eq!(replayed["deliveries"].as_array().unwrap().len(), 1);
            assert_eq!(replayed["deliveries"][0]["kind"], expected);
            assert_eq!(replayed["deliveries"][0]["state"], "delivered");
            assert_eq!(
                replayed["targets"][0]["tokens"],
                delivered["targets"][0]["tokens"]
            );
            assert_eq!(
                replayed["targets"][0]["breaker"],
                delivered["targets"][0]["breaker"]
            );
        }
    }

    #[tokio::test]
    async fn request_dedup_survives_restart_and_terminal_follows_interaction() {
        // Regression: replayed interaction after reload must not duplicate the pending event.
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let fake = Fake::success();
        process(&fake, &dir.0, &mut b, &interaction(json!(17)))
            .await
            .unwrap();
        let mut b = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
        recover(&fake, &dir.0, &mut b).await.unwrap();
        process(&fake, &dir.0, &mut b, &interaction(json!(17)))
            .await
            .unwrap();
        process(&fake, &dir.0, &mut b, &json!({"state":"running"}))
            .await
            .unwrap();
        process(&fake, &dir.0, &mut b, &interaction(json!(17)))
            .await
            .unwrap();
        process(&fake, &dir.0, &mut b, &interaction(json!(18)))
            .await
            .unwrap();
        for _ in 0..2 {
            process(
                &fake,
                &dir.0,
                &mut b,
                &json!({"state":"completed","finalResponse":"SECRET_OUTPUT"}),
            )
            .await
            .unwrap();
        }

        assert!(b.terminal);
        let report = notification(binding(&dir.0, "thread-1", "turn-1").unwrap());
        assert_eq!(report["target"], "session_010000000000000000000001");
        assert_eq!(report["deliveries"].as_array().unwrap().len(), 3);
        assert_eq!(
            report["deliveries"][2],
            json!({"eventId":b.deliveries[2].event_id,"kind":"completed","level":"L1","state":"delivered","error":null,"timing":b.deliveries[2].timing})
        );
        assert!(b.deliveries.iter().all(|d| d.status == "delivered"));
        let calls = fake.calls.lock().unwrap();
        assert_eq!(calls[0][0], "-p");
        assert_eq!(
            &calls[0][2..],
            [
                "--cloud",
                "session_010000000000000000000001",
                "--output-format",
                "json"
            ]
        );
        assert!(!serde_json::to_string(&*calls)
            .unwrap()
            .contains("SECRET_OUTPUT"));
        let restored = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
        assert_eq!(restored.deliveries[2].final_response, "SECRET_OUTPUT");
    }
    #[tokio::test]
    async fn steering_rebind_does_not_report_old_session_delivery() {
        // Regression: a rebound receipt must not report delivery to the previous session.
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let fake = Fake::success();
        process(&fake, &dir.0, &mut b, &interaction(json!(17)))
            .await
            .unwrap();
        bind_in(
            &dir.0,
            Some("cse_010000000000000000000006"),
            "thread-1",
            "turn-1",
            "",
        )
        .unwrap();
        let mut b = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
        let report = notification(Some(b.clone()));
        assert_eq!(report["target"], "cse_010000000000000000000006");
        assert_eq!(report["deliveries"], json!([]));
        process(&fake, &dir.0, &mut b, &interaction(json!(17)))
            .await
            .unwrap();

        let other = Fake::new(Ok(
            br#"{"ok":true,"session_id":"cse_010000000000000000000006"}"#.to_vec(),
        ));
        process(&other, &dir.0, &mut b, &json!({"state":"completed"}))
            .await
            .unwrap();
        assert_eq!(
            other.calls.lock().unwrap()[0][3],
            "cse_010000000000000000000006"
        );
        assert_eq!(
            notification(Some(b.clone()))["deliveries"],
            json!([{"eventId":b.deliveries[1].event_id,"kind":"completed","level":"L1","state":"delivered","error":null,"timing":b.deliveries[1].timing}])
        );
    }

    #[tokio::test]
    async fn idless_waiting_uses_confirmed_state_entries() {
        // Regression: unconfirmed idless waiting must not invent an actionable interaction.
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let fake = Fake::success();
        let wait = json!({"state":"interaction-required","activeFlags":["waitingOnUserInput"]});
        process(&fake, &dir.0, &mut b, &wait).await.unwrap();
        for state in ["unconfirmed", "timeout", "interaction-required"] {
            let observation = if state == "interaction-required" {
                wait.clone()
            } else {
                json!({"state":state})
            };
            process(&fake, &dir.0, &mut b, &observation).await.unwrap();
        }

        process(&fake, &dir.0, &mut b, &json!({"state":"running"}))
            .await
            .unwrap();
        process(&fake, &dir.0, &mut b, &wait).await.unwrap();

        assert_eq!(b.deliveries.len(), 2);
        assert_eq!(b.deliveries[0].state, "waiting for input");
    }
    #[tokio::test]
    async fn failures_remain_pending_during_retry_backoff() {
        // Regression: offline delivery remains pending during backoff.
        for result in [
            Err("timeout".into()),
            Err("not installed".into()),
            Ok(b"not json".to_vec()),
            Ok(br#"{"ok":false,"error":"SECRET_ERROR"}"#.to_vec()),
            Ok(br#"{"ok":true,"session_id":"session_010000000000000000000004"}"#.to_vec()),
        ] {
            let dir = Sandbox::new();
            let mut b = fixture(&dir.0);
            let fake = Fake::new(result);
            for _ in 0..2 {
                process(
                    &fake,
                    &dir.0,
                    &mut b,
                    &json!({"state":"failed","error":"SECRET_ERROR"}),
                )
                .await
                .unwrap();
            }

            assert_eq!(b.deliveries[0].status, "pending");
            assert_eq!(b.deliveries[0].failures, 1);
            assert!(!State::load(&dir.0).unwrap().targets[0].escalated);
            assert_eq!(b.deliveries[0].state, "failed");
        }
    }
    #[tokio::test]
    async fn interrupted_delivery_recovers_with_same_event_id() {
        // Regression: a crash during delivery must not replace the recovered event id.
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let fake = Fake::success();
        b.deliveries.push(Delivery {
            subscription: String::new(),
            channel: Channel::ClaudeSession,
            event_id: "event-17".into(),
            created_at: 0,
            timing: DeliveryTiming::default(),
            batch: String::new(),
            attempted_at: 0,
            attempts: vec![],
            token_charged: false,
            failures: 0,
            next_attempt_at: 0,
            digest: false,
            error: None,
            key: "request:17".into(),
            target: "session_010000000000000000000001".into(),
            state: "waiting for approval".into(),
            task_state: "interaction-required".into(),
            interaction: Value::Null,
            status: "sending".into(),
            final_response: Value::Null,
            external_user_inputs: Value::Null,
            changes: Value::Null,
            dispatches: Value::Null,
            task_error: Value::Null,
            reconciliation: Value::Null,
            continuation: Value::Null,
            recovery: Value::Null,
        });
        persist(&dir.0, &b).unwrap();
        let mut b = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
        recover(&fake, &dir.0, &mut b).await.unwrap();
        recover(&fake, &dir.0, &mut b).await.unwrap();
        process(&fake, &dir.0, &mut b, &interaction(json!(17)))
            .await
            .unwrap();

        process(&fake, &dir.0, &mut b, &json!({"state":"cancelled"}))
            .await
            .unwrap();

        assert_eq!(b.deliveries.len(), 2);
        assert_eq!(b.deliveries[0].event_id, "event-17");
        assert_eq!(b.deliveries[1].state, "interrupted");
    }
}

pub(crate) fn push_available(notification: &Value) -> bool {
    let (Ok(settings), Ok(state)) = (settings(), State::load(&directory())) else {
        return false;
    };
    effective_push(
        notification,
        &settings,
        &state,
        crate::agents::driver::discover("claude").is_some(),
    )
}
fn effective_push(notification: &Value, settings: &Value, state: &State, cli: bool) -> bool {
    notification["reachability"] == "verified"
        && notification["channel"] == "claude-session"
        && notification["target"].is_string()
        && settings["notificationsEnabled"] != false
        && cli
        && !state.targets.iter().any(|t| {
            notification["sourceId"] == t.source_id
                && t.channel == Channel::ClaudeSession
                && notification["target"] == t.target
                && t.breaker
        })
}

// Both explicit reads and the background observer can publish the first terminal
// event. Collect its snapshot on either path, before process freezes the delivery.
async fn enrich_completion(control: &Arc<control::Control>, b: &Binding, observed: &mut Value) {
    if !b.terminal
        && matches!(
            string(observed, "state"),
            "completed" | "failed" | "cancelled"
        )
        && (b.agent.is_empty() || b.agent == "codex")
    {
        observed["dispatches"] = crate::dispatch_policy::complete(
            control,
            &b.thread_id,
            &b.turn_id,
            string(observed, "state"),
            b.observation["observedAt"]
                .as_str()
                .filter(|_| b.observation["reconciliation"] == "pending-after-restart"),
            b.observation["reconciliation"] == "pending-after-restart",
        )
        .await
        .unwrap_or_else(|error| json!({"unavailable":error}));
    }
    if !b.terminal
        && observed["state"] == "completed"
        && (b.agent.is_empty() || b.agent == "codex")
        && !empty_answered_completion(b, observed)
    {
        observed["changes"] = crate::changes::notification(control, &b.thread_id, &b.turn_id).await;
    }
}

pub(crate) async fn observe(thread: &str, turn: &str, observed: &Value) -> Result<()> {
    if let Some(mut b) = binding(&directory(), thread, turn)? {
        process(&directory(), &LOCK, &mut b, observed).await?;
    }
    Ok(())
}

// A read can beat the background observer. Record the state it actually read
// before marking that turn read; later transitions remain unread.
pub(crate) async fn read_turns(
    control: &Arc<control::Control>,
    name: &str,
    args: &Value,
    value: &Value,
) -> Result<Vec<(String, String)>> {
    let mut reads = Vec::new();
    if !matches!(
        name,
        "codex_read" | "codex_wait" | "codex_items" | "codex_changes" | "agent_read" | "agent_wait"
    ) || value["state"] == "unconfirmed"
    {
        return Ok(reads);
    }
    let task = value["taskId"]
        .as_str()
        .or_else(|| args["taskId"].as_str())
        .or_else(|| value["threadId"].as_str())
        .or_else(|| args["threadId"].as_str())
        .unwrap_or("");
    let turns = if name == "codex_read" {
        value["turns"].as_array().cloned().unwrap_or_default()
    } else if name == "codex_items" && value["turnId"].is_null() && args["turnId"].is_null() {
        value["items"].as_array().cloned().unwrap_or_default()
    } else {
        vec![value.clone()]
    };
    for t in turns {
        let turn = t["turnId"]
            .as_str()
            .or_else(|| args["turnId"].as_str())
            .unwrap_or("");
        if turn.is_empty() {
            continue;
        }
        if reads
            .iter()
            .any(|(read_task, read_turn)| read_task == task && read_turn == turn)
        {
            continue;
        }
        let mut observation = t.clone();
        // Item/change pages identify the read turn but carry no lifecycle state.
        // Reconcile a pending binding now, before inbox() acknowledges it, so the
        // observer cannot append an already-read completion on its next cycle.
        if matches!(name, "codex_read" | "codex_items" | "codex_changes")
            && binding(&directory(), task, turn)?.is_some_and(|b| !b.terminal)
        {
            match tokio::time::timeout(
                Duration::from_secs(10),
                crate::waiter::codex_observe(control, &json!({"threadId":task,"turnId":turn})),
            )
            .await
            {
                Ok(Ok(value)) => observation = value,
                error => crate::logs::record(
                    "WARN",
                    &format!("Inbox turn observation unavailable: {error:?}"),
                    None,
                ),
            }
        }
        if observation["title"].is_null() {
            observation["title"] = value["title"].clone();
        }
        if name == "agent_read" {
            observation["finalResponse"] = value["output"].clone();
            observation["state"] = json!(match t["recordedStatus"]
                .as_str()
                .or_else(|| t["status"].as_str())
                .unwrap_or("")
            {
                "completed" => "completed",
                "failed" => "failed",
                "cancelled" | "interrupted" => "cancelled",
                _ => "unconfirmed",
            });
        }
        if let Some(b) = binding(&directory(), task, turn)? {
            enrich_completion(control, &b, &mut observation).await;
        }
        observe(task, turn, &observation).await?;
        reads.push((task.into(), turn.into()));
    }
    reads.sort();
    reads.dedup();
    Ok(reads)
}

/// Account workspace projection. Challenges and credentials never leave notification ownership.
pub(crate) async fn account_sessions() -> Result<Vec<Value>> {
    let _guard = LOCK.lock().await;
    let state = governance::State::load(&directory())?;
    let now = chrono::Utc::now().timestamp();
    let mut sessions: Vec<Value> = state.targets.into_iter().map(|mut t| {
        t.reachability.expire(now);
        json!({"sourceId":t.source_id,"accountId":t.account_id,"channel":t.channel,"target":t.target,
            "registered":t.registered,"state":t.reachability.state,"verified":t.reachability.state == "verified",
            "lastDelivery":t.batches.last().map(|b| json!({"at":b.at,"status":b.status})),"lastVerificationDelivery":t.reachability.delivery_status})
    }).collect();
    for sub in state
        .subscriptions
        .iter()
        .filter(|s| s.channel == Channel::McpEvents)
    {
        let reachable = sub.active(now.saturating_mul(1000))
            && !sub.muted(now)
            && sub.webhook.as_ref().is_some_and(|w| w.verified_until > now);
        sessions.push(json!({"sourceId":sub.source_id,"channel":"mcp-events","target":sub.id,"state":if reachable {"reachable"} else {"unavailable"},"reachable":reachable,"registered":true}));
    }
    Ok(sessions)
}

pub(crate) async fn update_notice(args: &Value) -> Result<Value> {
    recovery::update(
        &directory(),
        &LOCK,
        &args["receipt"],
        string(args, "phase"),
        chrono::Utc::now().timestamp(),
    )
    .await?;
    Ok(json!({"queued":true}))
}

/// Project current source-owned notification bindings into the conversation registry.
fn sync_src_conversation(source: &str, target: &str, handshake: bool) -> Result<()> {
    let state = State::load(&directory())?;
    let Some(verified) = state.targets.iter().find(|t| {
        t.source_id == source
            && t.target == target
            && t.channel == Channel::ClaudeSession
            && t.reachability.state == "verified"
    }) else {
        return Ok(());
    };
    let confirmed_at = handshake
        .then(|| chrono::DateTime::from_timestamp_millis(verified.reachability.verified_at))
        .flatten()
        .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    let Some(account) = crate::accounts::source_rows()?.into_iter().find(|a| {
        a["provider"] == "anthropic"
            && a["sources"]
                .as_array()
                .is_some_and(|sources| sources.iter().any(|s| s == source))
    }) else {
        return Ok(());
    };
    let tasks = records(&directory())?
        .into_iter()
        .filter(|b| {
            b.source_id == source
                && b.channel == Channel::ClaudeSession
                && b.target.as_deref() == Some(target)
                && b.scope_end.is_none()
                && !b.continuation_bound
        })
        .map(|b| {
            (
                if b.agent.is_empty() {
                    "codex".into()
                } else {
                    b.agent
                },
                b.thread_id,
            )
        })
        .collect::<Vec<_>>();
    crate::src_conversations::notify_target(
        string(&account, "id"),
        target,
        confirmed_at.as_deref(),
        &tasks,
    )
}

/// Conversation association requires a verified target owned by this exact source.
pub(crate) fn verified_conversation_target(source: &str, target: &str) -> Result<bool> {
    let mut state = State::load(&directory())?;
    Ok(state.targets.iter_mut().any(|t| {
        t.reachability.expire(chrono::Utc::now().timestamp());
        t.source_id == source
            && t.target == target
            && t.channel == Channel::ClaudeSession
            && t.reachability.state == "verified"
    }))
}

/// Registered, verified targets are URL evidence even before a local window opens.
pub(crate) fn verified_conversation_targets(source_ids: &[String]) -> Result<Vec<String>> {
    let mut state = State::load(&directory())?;
    Ok(state
        .targets
        .iter_mut()
        .filter_map(|t| {
            t.reachability.expire(chrono::Utc::now().timestamp());
            (source_ids.contains(&t.source_id)
                && t.channel == Channel::ClaudeSession
                && t.reachability.state == "verified")
                .then(|| t.target.clone())
        })
        .collect())
}
/// Reuse only this task's still-open notification binding, never an account-wide guess.
pub(crate) fn conversation_target_for_send(source: &str, task: &str) -> Result<Option<String>> {
    Ok(records(&directory())?
        .into_iter()
        .filter(|b| {
            b.source_id == source
                && b.thread_id == task
                && b.scope_end.is_none()
                && !b.continuation_bound
                && (b.agent.is_empty() || b.agent == "codex")
                && b.channel == Channel::ClaudeSession
        })
        .max_by_key(|b| b.created_at)
        .and_then(|b| b.target))
}
