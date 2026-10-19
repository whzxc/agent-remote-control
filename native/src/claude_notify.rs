//! Turn-scoped control-source events, inboxes and fixed notification channels.
use crate::*;
mod governance;
pub(crate) mod mcp_events;
mod retry;
pub(crate) mod subscriptions;
use governance::State;
pub(crate) use governance::{notify_control, notify_status};
use serde::{Deserialize, Serialize};
use std::{future::Future, time::Duration};

pub(crate) fn session_id(value: &str) -> Result<String> {
    let value = value.trim();
    let url = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
        .unwrap_or(value);
    let (id, from_url) = match url.strip_prefix("claude.ai/code/") {
        Some(id) => (
            id.split(['?', '#'])
                .next()
                .unwrap_or("")
                .trim_end_matches('/'),
            true,
        ),
        None => (value, false),
    };
    if id.is_empty()
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        || (!from_url
            && !id
                .strip_prefix("session_")
                .or_else(|| id.strip_prefix("cse_"))
                .is_some_and(|suffix| !suffix.is_empty()))
    {
        return Err(
            "INVALID_CLAUDE_SESSION: expected cloud session ID or claude.ai/code URL".into(),
        );
    }
    Ok(id.into())
}

#[derive(Clone, Default, Serialize, Deserialize)]
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

#[derive(Clone, Serialize, Deserialize)]
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
    changes: Value,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    task_error: Value,
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
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    thread_id: String,
    turn_id: String,
    target: Option<String>,
    #[serde(default)]
    channel: Channel,
    #[serde(default)]
    ingress: String,
    #[serde(default)]
    agent: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    explicit: bool,
    project: String,
    terminal: bool,
    created_at: i64,
    waiting: Vec<String>,
    deliveries: Vec<Delivery>,
    #[serde(default)]
    continuation_bound: bool,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    caused_by: Value,
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
fn persist(dir: &Path, b: &Binding) -> Result<()> {
    save(
        &path_in(dir, &b.thread_id, &b.turn_id),
        &serde_json::to_value(b).map_err(|e| e.to_string())?,
    )
}
fn binding(dir: &Path, thread: &str, turn: &str) -> Result<Option<Binding>> {
    let path = path_in(dir, thread, turn);
    if !path.exists() {
        return Ok(None);
    }
    serde_json::from_value(load(&path)?)
        .map(Some)
        .map_err(|e| e.to_string())
}
fn bind_in(dir: &Path, session: Option<&str>, thread: &str, turn: &str, cwd: &str) -> Result<()> {
    let Some(session) = session else {
        return Ok(());
    };
    let previous = binding(dir, thread, turn)?;
    let mut b = previous.unwrap_or_else(|| Binding {
        thread_id: thread.into(),
        turn_id: turn.into(),
        target: None,
        channel: Channel::ClaudeSession,
        ingress: String::new(),
        agent: String::new(),
        title: String::new(),
        explicit: false,
        project: Path::new(cwd)
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("未命名")
            .into(),
        terminal: false,
        created_at: chrono::Utc::now().timestamp(),
        waiting: vec![],
        deliveries: vec![],
        continuation_bound: false,
        caused_by: Value::Null,
        retry: Value::Null,
    });
    b.target = (!session.is_empty()).then(|| session.to_owned());
    persist(dir, &b)
}
pub(crate) static LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
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
    if b.ingress.is_empty() {
        b.ingress = string(&crate::kernel::origin::current_origin(), "ingressId").into();
    }
    if b.agent.is_empty() {
        b.agent = args["agent"].as_str().unwrap_or("codex").into();
    }
    if b.title.is_empty() {
        b.title = args["title"]
            .as_str()
            .filter(|v| !v.is_empty())
            .unwrap_or(&b.project)
            .into();
    }
    if created {
        if cause.is_object() {
            b.caused_by = cause;
        }
        b.retry = json!({"model":args["_retryModel"],"turn":args["_retryTurn"],"attempts":args["_retryAttempt"].as_u64().unwrap_or(0),"origin":crate::kernel::origin::current_origin()});
    }
    let state = State::load(&dir)?;
    if let Some(rule) = state.rule(&b) {
        governance::apply_rebind(&mut b, rule);
    }
    persist(&dir, &b)
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
            next.ingress = old.ingress.clone();
            next.title = old.title.clone();
            next.project = old.project.clone();
            for d in &mut next.deliveries {
                if d.status == "pending" && d.target.is_empty() {
                    d.target = old.target.clone().unwrap_or_default();
                    d.channel = old.channel;
                }
            }
            persist(&directory(), &next)?;
        }
        old.continuation_bound = true;
        persist(&directory(), &old)?;
    }
    Ok(())
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
    if !b.terminal
        || b.deliveries
            .iter()
            .any(|d| matches!(d.status.as_str(), "pending" | "sending"))
        || now - b.created_at <= RETENTION_SECONDS
    {
        return Ok(false);
    }
    std::fs::remove_file(path_in(dir, &b.thread_id, &b.turn_id)).map_err(|e| e.to_string())?;
    Ok(true)
}
fn notification(b: Option<Binding>) -> Value {
    b.filter(|b| b.target.is_some()).map(|b| json!({
        "channel": b.channel, "target": b.target,
        "deliveries": b.deliveries.iter().filter(|d| d.channel == b.channel && Some(d.target.as_str()) == b.target.as_deref()).map(|d| json!({"eventId":d.event_id,"kind":event(&b,d)["kind"],"level":if b.channel==Channel::ClaudeSession {"L1"}else{"L2"},"state":d.status,"error":d.error,"timing":d.timing})).collect::<Vec<_>>()
    })).unwrap_or(Value::Null)
}
pub(crate) fn read(thread: &str, turn: &str) -> Result<Value> {
    read_since(thread, turn, None)
}
pub(crate) fn read_since(thread: &str, turn: &str, since: Option<&str>) -> Result<Value> {
    Ok(notification_since(
        binding(&directory(), thread, turn)?,
        since,
    ))
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
    Ok(binding(&directory(), thread, turn)?.is_some_and(|b| {
        !b.terminal && matches!(string(&b.retry, "status"), "scheduled" | "submitting")
    }))
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
        "completed" => "completed",
        "failed" => "failed",
        "cancelled" => "interrupted",
        _ => "needs-input",
    };
    let agent = !b.agent.is_empty() && b.agent != "codex";
    let next = if kind == "needs-input" {
        if agent {
            json!({"hint":"Read the pending interaction before responding.","via":"query","op":"agent_pending","args":{"agent":b.agent,"taskId":b.thread_id}})
        } else {
            json!({"hint":"Read the pending interaction before responding; if no request is exposed, 需在 Desktop 中处理 / handle in Codex Desktop.","via":"query","op":"codex_pending","args":{"threadId":b.thread_id}})
        }
    } else if agent {
        json!({"hint":"Read the result and review it against the acceptance criteria.","via":"query","op":"agent_read","args":{"agent":b.agent,"taskId":b.thread_id}})
    } else {
        json!({"hint":"Read the result and review its changes.","via":"query","op":"codex_read","args":{"threadId":b.thread_id}})
    };
    json!({"eventId":d.event_id,"kind":kind,"project":b.project,"threadId":if agent {Value::Null}else{json!(b.thread_id)},"taskId":if agent {json!(b.thread_id)}else{Value::Null},"agent":if agent {json!(b.agent)}else{json!("codex")},"turnId":b.turn_id,"title":b.title,"channel":d.channel,"target":if d.target.is_empty(){Value::Null}else{json!(d.target)},"causedBy":b.caused_by,"summary":format!("ARC task {kind}."),"interaction":d.interaction,"next":if d.interaction["next"].is_object() {d.interaction["next"].clone()} else {next}})
}
fn literal(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}
fn question_lines(question: &Value) -> String {
    let text = question
        .get("question")
        .or_else(|| question.get("title"))
        .unwrap_or(&Value::Null);
    let options = question["options"]
        .as_array()
        .filter(|v| !v.is_empty())
        .map(|options| {
            options
                .iter()
                .enumerate()
                .map(|(i, option)| format!("{}) {}", i + 1, literal(option)))
                .collect::<Vec<_>>()
                .join(" | ")
        })
        .unwrap_or_else(|| "(free text)".into());
    // Option objects retain labels, descriptions and any upstream extension fields.
    let mut lines = format!("question: {}\noptions: {options}", literal(text));
    let mut extra = question.clone();
    if let Some(fields) = extra.as_object_mut() {
        for key in ["question", "title", "options"] {
            fields.remove(key);
        }
        if !fields.is_empty() {
            lines.push_str(&format!("\nquestionDetails: {extra}"));
        }
    }
    lines
}
fn response_call(b: &Binding, r: &Value) -> Option<Value> {
    if r["canRespond"] == false {
        return None;
    }
    if r["respondToken"].is_string() && (b.agent.is_empty() || b.agent == "codex") {
        return Some(json!({"op":"codex_respond","args":{"respondToken":r["respondToken"]}}));
    }
    if r["next"]["via"] == "act" && r["next"]["args"].is_object() {
        return Some(json!({"op":r["next"]["op"],"args":r["next"]["args"]}));
    }
    let key = r.get("responseId").or_else(|| r.get("id"))?;
    if !b.agent.is_empty() && b.agent != "codex" {
        Some(
            json!({"op":"agent_respond","args":{"agent":b.agent,"taskId":b.thread_id,"interactionId":r.get("interactionId").unwrap_or(key),"backendSession":r["backendSession"]}}),
        )
    } else if !r["backendSession"].is_null() {
        Some(
            json!({"op":"codex_respond","args":{"backendSession":r["backendSession"],"id":literal(key)}}),
        )
    } else {
        None
    }
}
fn interaction_text(b: &Binding, r: &Value) -> String {
    let respond = response_call(b, r)
        .map(|call| format!("respond={call}"))
        .unwrap_or_else(|| "respond: unavailable (handle in task owner)".into());
    let method = string(r, "method");
    let mut params = r.get("params").cloned().unwrap_or_else(|| r.clone());
    if let Some(fields) = params.as_object_mut() {
        for key in [
            "threadId",
            "turnId",
            "questionItemId",
            "id",
            "backendSession",
            "interactionId",
        ] {
            fields.remove(key);
        }
    }
    if method == "request_user_input_async" {
        return format!(
            "{respond}\n{}\nresult: {{\"answer\":\"<answer>\"}}",
            question_lines(&params)
        );
    }
    if method == "item/tool/requestUserInput" {
        let mut answers = serde_json::Map::new();
        let mut blocks = Vec::new();
        for q in params["questions"].as_array().into_iter().flatten() {
            answers.insert(string(q, "id").into(), json!({"answers":["<answer>"]}));
            blocks.push(format!("{respond}\n{}", question_lines(q)));
        }
        blocks.push(format!(
            "result (submit all question IDs together): {}",
            json!({"answers":answers})
        ));
        if let Some(fields) = params.as_object_mut() {
            fields.remove("questions");
            if !fields.is_empty() {
                blocks.push(format!("details: {params}"));
            }
        }
        return blocks.join("\n");
    }
    let mut lines = format!("{respond}\nmethod: {method}\napproval/input: {params}");
    if matches!(
        method,
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
    ) {
        let decisions = params
            .get("availableDecisions")
            .filter(|v| v.is_array())
            .cloned()
            .unwrap_or_else(|| json!(["accept", "acceptForSession", "decline", "cancel"]));
        lines.push_str(&format!(
            "\ndecisions: {decisions}\nresult: {{\"decision\":\"<decision>\"}}"
        ));
    } else if method == "item/permissions/requestApproval" {
        lines.push_str("\nresult fields: permissions (approved subset of requested permissions), scope (turn|session)");
    } else if method == "mcpServer/elicitation/request" {
        lines.push_str("\nresult fields: action (accept|decline|cancel), content (values matching requestedSchema when accepted)");
    }
    lines
}
fn changes_text(b: &Binding, changes: &Value) -> Vec<String> {
    let query = json!({"op":"codex_changes","args":{"threadId":b.thread_id,"turnId":b.turn_id}});
    if changes.is_null() || !changes["unavailable"].is_null() {
        return vec![
            format!(
                "changes: unavailable ({})",
                changes["unavailable"]
                    .as_str()
                    .unwrap_or("not captured for this event")
            ),
            format!("query={query}"),
        ];
    }
    let stats = &changes["summary"];
    let fallback = changes["fallback"] == true;
    let mut lines = vec![format!(
        "changes (truncated={}, scope={}): {} files, +{} -{}, {} binary/unreadable",
        if changes["truncated"] == true {
            "yes"
        } else {
            "no"
        },
        if fallback {
            "current-workspace; turn baseline unavailable"
        } else {
            "workspace since turn start"
        },
        stats["files"],
        stats["added"],
        stats["removed"],
        stats["binaryOrUnreadable"]
    )];
    lines.push("attribution: may include other tasks and pre-existing dirty files; not exclusively attributable to this task".into());
    lines.push(format!(
        "changes observedAt={}",
        string(changes, "observedAt")
    ));
    if !fallback {
        lines.push(format!("commits: {}", changes["commitCount"]));
        for commit in changes["commits"].as_array().into_iter().flatten() {
            lines.push(format!(
                "{} {}",
                string(commit, "sha").chars().take(8).collect::<String>(),
                string(commit, "title")
            ));
        }
    }
    if fallback || changes["truncated"] == true {
        lines.push(format!("query={query}"));
    }
    lines
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
fn message(b: &Binding) -> String {
    b.deliveries.iter().map(|d| {
        let event = event(b, d);
        let agent = !b.agent.is_empty() && b.agent != "codex";
        let mut lines = vec![format!("[ARC] {} · {} · {}", string(&event,"kind"), b.project, b.title),
            format!("{}={} turn={} event={}", if agent {"task"} else {"thread"}, b.thread_id, b.turn_id, d.event_id)];
        if agent { lines.push(format!("agent={}",b.agent)); }
        match string(&event,"kind") {
            "completed" => {
                let text = d.final_response.as_str().or_else(|| d.final_response["text"].as_str());
                let truncated=text.is_none_or(|text|text.chars().count()>2000 || d.final_response["textTruncated"]==true);
                if let Some(text)=text {lines.push(format!("final (truncated={}):\n{}",if truncated{"yes"}else{"no"},text.chars().take(2000).collect::<String>()));}
                else {lines.push("final: unavailable".into());}
                if truncated {
                    let call=if agent {json!({"op":"agent_read","args":{"agent":b.agent,"taskId":b.thread_id}})}else{json!({"op":"codex_items","args":{"threadId":b.thread_id,"turnId":b.turn_id,"latest":true,"limit":1,"length":65536}})};
                    lines.push(format!("query={call}"));
                }
                if !agent {lines.extend(changes_text(b,&d.changes));}
            },
            "failed" | "interrupted" => {
                lines.push(format!("error: {}", if d.task_error.is_null() {"(not provided by task owner)".into()} else {literal(&d.task_error)}));
                if !b.retry["status"].is_null() || b.retry["attempts"].as_u64().unwrap_or(0)>0 { lines.push(format!("retry: attempts={} status={}{}",b.retry["attempts"].as_u64().unwrap_or(0),b.retry["status"].as_str().unwrap_or("none"),if b.retry["reason"].is_null(){String::new()}else{format!(" reason={}",literal(&b.retry["reason"]))})); }
            },
            _ => lines.push(interaction_text(b, &d.interaction)),
        }
        lines.join("\n")
    }).collect::<Vec<_>>().join("\n\n")
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
        "completed" => Some("完成"),
        "failed" => Some("失败"),
        "cancelled" => Some("中断"),
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
            "等待输入"
        } else if method.contains("Approval") || method.contains("approval") {
            "等待审批"
        } else if !b.agent.is_empty() && b.agent != "codex" {
            "等待输入"
        } else {
            "等待输入"
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
        ("waitingOnApproval", "等待审批"),
        ("waitingOnUserInput", "等待输入"),
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
    fn send(&self, args: Vec<String>) -> impl Future<Output = Result<Vec<u8>>> + Send;
    fn escalate(&self, body: String) -> impl Future<Output = Result<()>> + Send;
}
struct Cli {
    service: std::sync::Weak<crate::service::Service>,
}
impl Executor for Cli {
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
    async fn send(&self, args: Vec<String>) -> Result<Vec<u8>> {
        if settings()?["notificationsEnabled"] == false {
            return Err("NOTIFICATIONS_DISABLED".into());
        }
        let binary = crate::agents::driver::discover("claude").ok_or("CLAUDE_NOT_FOUND")?;
        let paths = std::env::join_paths(crate::agents::driver::search_paths())
            .map_err(|e| e.to_string())?;
        let output = tokio::time::timeout(
            Duration::from_secs(30),
            command(binary)
                .args(args)
                .env("PATH", paths)
                .stdin(std::process::Stdio::null())
                .output(),
        )
        .await
        .map_err(|_| "CLAUDE_SEND_TIMEOUT")?
        .map_err(|e| format!("CLAUDE_SEND_FAILED: {e}"))?;
        if !output.status.success() {
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
async fn deliver_message(executor: &impl Executor, b: &Binding, body: &str) -> &'static str {
    let session = b.target.as_deref().unwrap();
    let result = executor
        .send(arguments(session, body))
        .await
        .and_then(|bytes| {
            serde_json::from_slice::<Value>(&bytes).map_err(|_| "CLAUDE_SEND_UNKNOWN".into())
        });
    let error = match result {
        Ok(ref v) if v["ok"] == true && v["session_id"].as_str() == Some(session) => {
            return "delivered"
        }
        Ok(ref v) if v["ok"] == true => "CLAUDE_SESSION_MISMATCH".to_owned(),
        Ok(v) => format!("CLAUDE_SEND_REJECTED: {}", v["error"]),
        Err(error) => error,
    };
    #[cfg(not(test))]
    crate::logs::record(
        "WARN",
        &format!(
            "Claude notification delivery failed: thread={} turn={}: {error}",
            b.thread_id, b.turn_id
        ),
        None,
    );
    #[cfg(test)]
    let _ = error;
    "failed"
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
async fn process(dir: &Path, lock: &Mutex<()>, b: &mut Binding, observation: &Value) -> Result<()> {
    let guard = lock.lock().await;
    let Some(current) = binding(dir, &b.thread_id, &b.turn_id)? else {
        return Ok(());
    };
    *b = current;
    if let Some(title) = observation["title"]
        .as_str()
        .filter(|title| !title.is_empty())
    {
        b.title = title.into();
    }
    if observation["state"] == "cancelled" && !b.continuation_bound {
        if let Some(next) = observation["nextTurnId"].as_str().filter(|s| !s.is_empty()) {
            let mut successor = binding(dir, &b.thread_id, next)?.unwrap_or_else(|| {
                let mut next_binding = b.clone();
                next_binding.turn_id = next.into();
                next_binding.created_at = chrono::Utc::now().timestamp();
                next_binding.terminal = false;
                next_binding.waiting.clear();
                next_binding.deliveries.clear();
                next_binding.explicit = false;
                next_binding.continuation_bound = false;
                next_binding
            });
            if !successor.explicit {
                successor.target = b.target.clone();
                successor.channel = b.channel;
                for d in &mut successor.deliveries {
                    if d.status == "pending" && d.target.is_empty() {
                        d.target = b.target.clone().unwrap_or_default();
                        d.channel = b.channel;
                    }
                }
                persist(dir, &successor)?;
            }
            b.continuation_bound = true;
            persist(dir, b)?;
        }
    }
    let mut resolved = false;
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
    if events.is_empty() && b.waiting == previous_waiting && b.terminal == was_terminal && !resolved
    {
        return Ok(());
    }
    let first = b.deliveries.len();
    for (key, state) in events {
        b.deliveries.push(Delivery {
            subscription: String::new(),
            channel: b.channel,
            target: b.target.clone().unwrap_or_default(),
            event_id: hash(json!([b.agent, b.thread_id, b.turn_id, key]).to_string()),
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
            changes: observation["changes"].clone(),
            task_error: if matches!(string(observation, "state"), "failed" | "cancelled") {
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
            task_state: string(observation, "state").into(),
            status: "pending".into(),
        });
    }
    // Append first: a crash between writes is reconciled by deterministic event IDs.
    for d in &b.deliveries[first..] {
        inbox_append(dir, &b.ingress, event(b, d))?;
    }
    if resolved && !b.ingress.is_empty() {
        let path = inbox_path(dir, &b.ingress);
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
    persist(dir, b)?;
    drop(guard);
    Ok(())
}

fn inbox_path(dir: &Path, ingress: &str) -> PathBuf {
    dir.join("inboxes").join(format!("{}.json", hash(ingress)))
}
fn inbox_append(dir: &Path, ingress: &str, event: Value) -> Result<()> {
    if ingress.is_empty() {
        return Ok(());
    }
    let path = inbox_path(dir, ingress);
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
    }
    Ok(())
}
pub(crate) async fn inbox(
    ingress: &str,
    reads: &[(String, String)],
    claude: bool,
    caller_target: Option<&str>,
) -> Result<Value> {
    let _guard = LOCK.lock().await;
    let mut result = inbox_in(&directory(), ingress, reads, claude)?;
    for event in result
        .get_mut("events")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if let Some(target) = event["target"].as_str() {
            let notice = match caller_target {
                Some(caller) if caller != target => "绑定其他会话",
                Some(_) => "绑定当前会话",
                None => "会话归属待核对：仅 target 对应会话处理",
            };
            event["bindingNotice"] = json!(notice);
        }
    }
    Ok(result)
}
fn inbox_in(dir: &Path, ingress: &str, reads: &[(String, String)], claude: bool) -> Result<Value> {
    let path = inbox_path(dir, ingress);
    if !path.exists() {
        return Ok(Value::Null);
    }
    let mut rows = load(&path)?;
    let bindings = records(dir)?;
    let mut state = State::load(dir)?;
    let now = chrono::Utc::now().timestamp();
    let mut acknowledged = false;
    let mut events = Vec::new();
    let mut unread = 0;
    for row in rows.as_array_mut().ok_or("INVALID_INBOX")? {
        let bound = bindings.iter().find(|b| {
            b.ingress == ingress
                && b.turn_id == string(row, "turnId")
                && (row["threadId"] == b.thread_id || row["taskId"] == b.thread_id)
        });
        if let Some(b) = bound {
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
        // Only Claude-owned ingress events with an actual session binding change behavior.
        // Looking up existing records also suppresses pre-upgrade delivered events.
        let delivery = bindings
            .iter()
            .filter(|b| b.ingress == ingress)
            .flat_map(|b| &b.deliveries)
            .find(|d| {
                row["eventId"] == d.event_id
                    && d.channel == Channel::ClaudeSession
                    && !d.target.is_empty()
            });
        let incremental = claude && (delivery.is_some() || row["attached"] == true);
        if incremental
            && (row["attached"] == true
                || delivery.is_some_and(|d| matches!(d.status.as_str(), "delivered" | "resolved")))
        {
            row["attached"] = json!(true);
            continue;
        }
        unread += 1;
        if events.len() < 5 {
            if incremental {
                row["attached"] = json!(true);
            }
            let mut event = row.clone();
            event.as_object_mut().unwrap().remove("attached");
            events.push(event);
        }
    }
    save(&path, &rows)?;
    if acknowledged {
        state.save(dir)?;
    }
    Ok(if events.is_empty() {
        Value::Null
    } else {
        json!({"unread":unread,"events":events})
    })
}
pub(crate) async fn acknowledge(args: &Value) -> Result<Value> {
    let ingress = string(&crate::kernel::origin::current_origin(), "ingressId").to_owned();
    if ingress.is_empty() {
        return Err("INGRESS_REQUIRED".into());
    }
    let _guard = LOCK.lock().await;
    acknowledge_in(&directory(), &ingress, args)
}
fn acknowledge_in(dir: &Path, ingress: &str, args: &Value) -> Result<Value> {
    let path = inbox_path(dir, ingress);
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
            .filter(|b| b.ingress == ingress)
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

// An old Desktop callback is eligible only if this ingress was actually given it.
// The Desktop owner still freshly verifies the request before applying any answer.
pub(crate) fn recoverable_response(key: &str, session: &str) -> Result<bool> {
    let origin = crate::kernel::origin::current_origin();
    recoverable_response_in(&directory(), string(&origin, "ingressId"), key, session)
}
fn recoverable_response_in(dir: &Path, ingress: &str, key: &str, session: &str) -> Result<bool> {
    Ok(!ingress.is_empty()
        && records(dir)?
            .iter()
            .filter(|b| b.ingress == ingress)
            .any(|b| {
                b.deliveries.iter().any(|d| {
                    d.interaction["owner"] == "desktop"
                        && d.interaction["id"] == key
                        && d.interaction["backendSession"] == session
                })
            }))
}

fn records(dir: &Path) -> Result<Vec<Binding>> {
    let tasks = dir.join("tasks");
    if !tasks.exists() {
        return Ok(vec![]);
    }
    std::fs::read_dir(tasks)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|v| v == "json"))
        .map(|e| serde_json::from_value(load(&e.path())?).map_err(|e| e.to_string()))
        .collect()
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
fn health(b: &Binding, d: &Delivery, wakes: usize, tokens: u64, capacity: u64) -> String {
    let mut parts = Vec::new();
    if d.urgent() {
        let count = b
            .deliveries
            .iter()
            .take_while(|row| row.event_id != d.event_id)
            .filter(|row| row.urgent() && row.state == d.state)
            .count()
            + 1;
        parts.push(format!(
            "本轮第 {count} 次{}",
            if d.state == "等待输入" {
                "提问"
            } else {
                "审批"
            }
        ));
    }
    parts.push(format!("近 10 分钟尝试唤醒本目标 {wakes} 次（含重试）"));
    if let (Some(op), Some(at)) = (b.caused_by["op"].as_str(), b.caused_by["at"].as_str()) {
        if let Ok(time) = chrono::DateTime::parse_from_rfc3339(at) {
            parts.push(format!(
                "由 {} {op} 触发",
                time.with_timezone(&chrono::Local).format("%H:%M")
            ));
        }
    }
    parts.push(format!("桶余量 {tokens}/{capacity}"));
    parts.join(" · ")
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
    let _operation = mcp_events::OPERATION.lock().await;
    let guard = lock.lock().await;
    let mut all = records(dir)?;
    let original = all
        .iter()
        .map(|b| serde_json::to_value(b).unwrap())
        .collect::<Vec<_>>();
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
    subscriptions::route(&state, &mut all, now);
    let mut targets = Vec::new();
    for b in &mut all {
        if let Some(rule) = state.rule(b) {
            governance::apply_rebind(b, rule);
        }
        for d in &b.deliveries {
            if d.status == "pending" && !targets.contains(&(d.channel, d.target.clone())) {
                targets.push((d.channel, d.target.clone()));
            }
        }
    }
    for t in &state.targets {
        if !targets.contains(&(t.channel, t.target.clone())) {
            targets.push((t.channel, t.target.clone()));
        }
    }
    let mut batches = Vec::new();
    let mut alerts = Vec::new();
    for (channel, target) in targets {
        let (breaker, tokens) = {
            let t = state.target(channel, &target, now, settings);
            (t.breaker, t.tokens)
        };
        let mut eligible = Vec::new();
        for (bi, b) in all.iter_mut().enumerate() {
            let rule = state.rule(b);
            let mode = rule.map(|r| r.mode(now)).unwrap_or("normal");
            let digest_due = rule.is_some_and(|r| now.saturating_sub(r.digest_at) >= 3600);
            for (di, d) in b.deliveries.iter_mut().enumerate() {
                if d.status != "pending" || d.channel != channel || d.target != target {
                    continue;
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
        let window_ready = eligible.iter().any(|(bi, di, digest)| {
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
            let t = state.target(channel, &target, now, settings);
            if let Some(reason) = t.anomaly(now, waiting, settings) {
                let threads = all
                    .iter()
                    .filter(|b| b.channel == channel && b.target.as_deref() == Some(&target))
                    .map(|b| b.thread_id.clone())
                    .collect::<std::collections::BTreeSet<_>>();
                let pending = all
                    .iter()
                    .flat_map(|b| &b.deliveries)
                    .filter(|d| d.channel == channel && d.target == target && d.status == "pending")
                    .count();
                alerts.push((channel,target.clone(),format!("目标 {target}；原因 {reason}；待投递 {pending} 条；线程 {}。请查看 ARC notify_status。",threads.into_iter().collect::<Vec<_>>().join(", "))));
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
        let throttled = selected.iter().any(|(bi, di, _)| {
            all[*bi].deliveries[*di].timing.queue_reason.as_deref() == Some("token-wait")
        });
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
        let (remaining, wakes) = {
            let t = state.target(channel, &target, now, settings);
            if charged {
                t.tokens -= 1;
            }
            t.batches.push(governance::Batch {
                id: batch.clone(),
                at: now,
                kinds,
                threads: thread_ids.into_iter().collect(),
                status: "sending".into(),
                charged,
            });
            (
                t.tokens,
                t.batches
                    .iter()
                    .filter(|b| b.at > now.saturating_sub(600) && b.status != "cancelled")
                    .count(),
            )
        };
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
            if !*digest {
                let mut block = message(&single);
                if throttled || remaining <= (governance::capacity(settings) / 5).max(1) {
                    block.push_str(&format!(
                        "\n{}",
                        health(
                            b,
                            &b.deliveries[*di],
                            wakes,
                            remaining,
                            governance::capacity(settings)
                        )
                    ));
                }
                blocks.push(block);
            }
            if let Some(r) = reserved
                .iter_mut()
                .find(|r| r.thread_id == b.thread_id && r.turn_id == b.turn_id)
            {
                r.deliveries.push(b.deliveries[*di].clone());
            } else {
                reserved.push(single);
            }
        }
        for r in &reserved {
            let ds = r.deliveries.iter().filter(|d| d.digest).collect::<Vec<_>>();
            if let Some(last) = ds.last() {
                let mut counts = std::collections::BTreeMap::<String, usize>::new();
                for d in &ds {
                    *counts
                        .entry(string(&event(r, d), "kind").into())
                        .or_default() += 1;
                }
                let full = all
                    .iter()
                    .find(|b| b.thread_id == r.thread_id && b.turn_id == r.turn_id)
                    .unwrap();
                blocks.push(format!(
                    "[ARC] digest · {} · {}\nthread={} turn={}\ncounts: {}{}",
                    r.project,
                    r.title,
                    r.thread_id,
                    r.turn_id,
                    json!(counts),
                    if throttled || remaining <= (governance::capacity(settings) / 5).max(1) {
                        format!(
                            "\n{}",
                            health(full, last, wakes, remaining, governance::capacity(settings))
                        )
                    } else {
                        String::new()
                    }
                ));
            }
        }
        if throttled {
            blocks.push(format!("节流中，已合并 {} 条", selected.len()));
        }
        batches.push((reserved, blocks.join("\n\n")));
    }
    // Charge before reserving event records: a crash may lose one token, but
    // never duplicates an event or permits an uncharged burst after restart.
    state.save(dir)?;
    for (b, old) in all.iter().zip(original) {
        if serde_json::to_value(b).unwrap() != old {
            persist(dir, b)?;
        }
    }
    drop(guard);
    for (channel, target, body) in alerts {
        if let Err(error) = executor.escalate(body).await {
            let _guard = lock.lock().await;
            let mut state = State::load(dir)?;
            state
                .target(channel, &target, now, settings)
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
    for (batch, body) in batches {
        let started_at = chrono::Utc::now().timestamp_millis();
        {
            let _guard = lock.lock().await;
            let mut state = State::load(dir)?;
            let breaker = state.targets.iter().any(|t| {
                t.channel == batch[0].channel
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
            t.channel == batch[0].channel && Some(t.target.as_str()) == batch[0].target.as_deref()
        }) {
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
        let b: Binding = serde_json::from_value(load(path)?).map_err(|e| e.to_string())?;
        if !path_in(&dir, &b.thread_id, &b.turn_id).exists() {
            persist(&dir, &b)?;
        }
    }
    let old_control = dir.join("control/state.json");
    let new_control = dir.join("subscriptions/state.json");
    let mut state = if !new_control.exists() && old_control.exists() {
        serde_json::from_value(load(&old_control)?).map_err(|e| e.to_string())?
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
                    d.timing =
                        serde_json::from_value(row["timing"].clone()).map_err(|e| e.to_string())?;
                    b.deliveries.push(d);
                }
            }
        }
    }
    subscriptions::sync(&mut state, &all);
    // Populate stable IDs without creating any subscription to the retired event name.
    subscriptions::route(&state, &mut all, chrono::Utc::now().timestamp());
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
    let agents = &service.agents;
    let executor = Cli {
        service: Arc::downgrade(service),
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
        loop {
            let Some(control) = weak.upgrade() else {
                break;
            };
            let Some(agents) = agents.upgrade() else {
                break;
            };
            let cycle = async {
                let mut reads = tokio::task::JoinSet::new();
                if let Ok(entries) = std::fs::read_dir(directory().join("tasks")) {
                    for entry in entries
                        .flatten()
                        .filter(|e| e.path().extension().is_some_and(|v| v == "json"))
                    {
                        let _guard = LOCK.lock().await;
                        let mut b: Binding = serde_json::from_value(load(&entry.path())?)
                            .map_err(|e| e.to_string())?;
                        if remove_expired(&directory(), &b, chrono::Utc::now().timestamp())? {
                            continue;
                        }
                        if recovering {
                            recover(&directory(), &mut b)?;
                        }
                        drop(_guard);
                        let interrupted = b.deliveries.iter().any(|d| d.state == "中断");
                        if b.terminal && (!interrupted || b.continuation_bound) {
                            continue;
                        }
                        let c = control.clone();
                        let agents = agents.clone();
                        reads.spawn(async move {
                            let args = json!({"threadId":b.thread_id,"turnId":b.turn_id});
                            let result = tokio::time::timeout(Duration::from_secs(10), async {
                                if b.agent.is_empty() || b.agent == "codex" {
                                    crate::kernel::origin::ORIGIN
                                        .scope(
                                            json!({"ingressId":b.ingress}),
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
                    let Ok((old, Ok(Ok(observed)))) = result else {
                        continue;
                    };
                    let mut b = old;
                    let mut observed = observed;
                    for request in observed["interaction"].as_array_mut().into_iter().flatten() {
                        crate::respond_tokens::issue(&b.ingress, request)?;
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
                Ok::<_, String>(())
            };
            tokio::select! {
                biased;
                _ = shutdown.changed() => break,
                result = cycle => if let Err(error) = result { crate::logs::record("WARN", &format!("Control-source notification persistence/observation failed: {error}"), None); },
            }
            if recovering {
                let _ = ready.send(true);
            }
            recovering = false;
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
            Self(std::env::temp_dir().join(format!("arc-notify-test-{}", id())))
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
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
            Self::new(Ok(br#"{"ok":true,"session_id":"session_test"}"#.to_vec()))
        }
    }
    impl Executor for Fake {
        async fn send(&self, args: Vec<String>) -> Result<Vec<u8>> {
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
    fn fixture(dir: &Path) -> Binding {
        bind_in(
            dir,
            Some("session_test"),
            "thread-1",
            "turn-1",
            "/projects/sample",
        )
        .unwrap();
        binding(dir, "thread-1", "turn-1").unwrap().unwrap()
    }
    fn interaction(id: Value) -> Value {
        json!({"state":"interaction-required", "interaction":[{"id":id,"method":"item/commandExecution/requestApproval","params":{"command":"SECRET_COMMAND"}}],"activeFlags":["waitingOnApproval"],"finalResponse":"SECRET_OUTPUT","error":"SECRET_ERROR"})
    }
    async fn enqueue(dir: &Path, thread: &str, observation: Value, at: i64) -> Binding {
        bind_in(
            dir,
            Some("session_test"),
            thread,
            "turn-1",
            "/projects/sample",
        )
        .unwrap();
        let mut b = binding(dir, thread, "turn-1").unwrap().unwrap();
        b.ingress = "claude".into();
        b.created_at = at;
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
    #[tokio::test]
    async fn empty_async_completion_is_suppressed_and_changes_are_bounded_in_message() {
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let fake = Fake::success();
        process(&fake,&dir.0,&mut b,&json!({"state":"interaction-required","interaction":[{"id":"q","method":"request_user_input_async","params":{"question":"2+2?"}}]})).await.unwrap();
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
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
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
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
        assert!(body.contains("final (truncated=no):\ndone"));
        assert!(body.contains("abcdef12 feat: sample"));
        assert!(body.contains("2 files, +4 -1"));
        assert!(body.contains("other tasks"));
        assert!(body.contains("codex_changes"));
        assert!(body.contains("truncated=yes"));
        b.deliveries[0].changes = json!({"unavailable":"not a repository"});
        assert!(message(&b).contains("not a repository"));
        b.deliveries[0].changes = changes;
        b.deliveries[0].changes["fallback"] = json!(true);
        let body = message(&b);
        assert!(body.contains("turn baseline unavailable"));
        assert!(!body.contains("abcdef12"));
    }
    #[tokio::test]
    async fn bucket_refill_batches_interactions_and_survives_reload() {
        let dir = Sandbox::new();
        let fake = Fake::success();
        let lock = Mutex::new(());
        let s = json!({"notificationBucketCapacity":1,"notificationRefillSeconds":60});
        enqueue(&dir.0, "question", interaction(json!(1)), 100).await;
        flush(&fake, &dir.0, &lock, 100, 30, &s).await.unwrap();
        assert_eq!(State::load(&dir.0).unwrap().targets[0].tokens, 0);
        enqueue(&dir.0, "approval", interaction(json!(2)), 101).await;
        enqueue(
            &dir.0,
            "completed",
            json!({"state":"completed","finalResponse":"done"}),
            101,
        )
        .await;
        flush(&fake, &dir.0, &lock, 101, 30, &s).await.unwrap();
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
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
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
        flush(&fake, &dir.0, &lock, 160, 30, &s).await.unwrap();
        let calls = fake.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls[1][1].contains("节流中，已合并 2 条"));
        assert!(calls[1][1].contains("桶余量 0/1"));
        assert!(calls[1][1].contains("codex_send 触发"));
        let state = State::load(&dir.0).unwrap();
        assert_eq!(state.targets[0].tokens, 0);
        assert_eq!(state.targets[0].batches[1].kinds["needs-input"], 1);
        assert_eq!(state.targets[0].batches[1].kinds["completed"], 1);
    }
    #[tokio::test]
    async fn exponential_retries_keep_token_credit_and_event_id() {
        let dir = Sandbox::new();
        let failed = Fake::new(Err("offline".into()));
        let lock = Mutex::new(());
        let s = json!({"notificationBucketCapacity":1,"notificationRefillSeconds":60});
        let b = enqueue(&dir.0, "retry", interaction(json!(1)), 100).await;
        let event = b.deliveries[0].event_id.clone();
        flush(&failed, &dir.0, &lock, 100, 30, &s).await.unwrap();
        flush(&failed, &dir.0, &lock, 109, 30, &s).await.unwrap();
        assert_eq!(failed.calls.lock().unwrap().len(), 1);
        flush(&failed, &dir.0, &lock, 111, 30, &s).await.unwrap();
        assert_eq!(failed.calls.lock().unwrap().len(), 2);
        let d = &binding(&dir.0, "retry", "turn-1")
            .unwrap()
            .unwrap()
            .deliveries[0];
        assert_eq!(d.next_attempt_at, 131);
        assert_eq!(d.failures, 2);
        enqueue(&dir.0, "fresh", interaction(json!(2)), 112).await;
        let success = Fake::success();
        flush(&success, &dir.0, &lock, 132, 30, &s).await.unwrap();
        assert_eq!(success.calls.lock().unwrap().len(), 1);
        assert!(success.calls.lock().unwrap()[0][1].contains(&event));
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
        let dir = Sandbox::new();
        let fake = Fake::success();
        let lock = Mutex::new(());
        let s = json!({"notificationBucketCapacity":1,"notificationRefillSeconds":3600,"notificationEscalationSeconds":900});
        enqueue(&dir.0, "blocked", interaction(json!(1)), 100).await;
        governance::control_in(
            &dir.0,
            "claude",
            &json!({"action":"breaker","target":"session_test","enabled":true}),
            100,
            &s,
        )
        .unwrap();
        flush(&fake, &dir.0, &lock, 100, 0, &s).await.unwrap();
        flush(&fake, &dir.0, &lock, 200, 0, &s).await.unwrap();
        assert!(fake.calls.lock().unwrap().is_empty());
        assert_eq!(fake.fallbacks.lock().unwrap().len(), 1);
        assert!(fake.fallbacks.lock().unwrap()[0].contains("blocked"));
        governance::control_in(
            &dir.0,
            "claude",
            &json!({"action":"breaker","target":"session_test","enabled":false}),
            201,
            &s,
        )
        .unwrap();
        flush(&fake, &dir.0, &lock, 201, 0, &s).await.unwrap();
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
        enqueue(&dir.0, "starved", interaction(json!(2)), 202).await;
        flush(&fake, &dir.0, &lock, 202, 0, &s).await.unwrap();
        flush(&fake, &dir.0, &lock, 1101, 0, &s).await.unwrap();
        assert_eq!(fake.fallbacks.lock().unwrap().len(), 1);
        flush(&fake, &dir.0, &lock, 1102, 0, &s).await.unwrap();
        flush(&fake, &dir.0, &lock, 1103, 0, &s).await.unwrap();
        assert_eq!(fake.fallbacks.lock().unwrap().len(), 2);
        flush(&fake, &dir.0, &lock, 3801, 0, &s).await.unwrap();
        assert!(!State::load(&dir.0).unwrap().targets[0].escalated);
        governance::control_in(
            &dir.0,
            "claude",
            &json!({"action":"breaker","target":"session_test","enabled":true}),
            3802,
            &s,
        )
        .unwrap();
        flush(&fake, &dir.0, &lock, 3802, 0, &s).await.unwrap();
        assert_eq!(fake.fallbacks.lock().unwrap().len(), 3);
    }
    #[tokio::test]
    async fn notification_controls_are_scoped_persistent_and_reversible() {
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
        assert!(fake.calls.lock().unwrap().is_empty());
        flush(&fake, &dir.0, &lock, 3700, 0, &s).await.unwrap();
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
        assert!(fake.calls.lock().unwrap()[0][1].contains("[ARC] digest"));
        assert_eq!(
            inbox_in(&dir.0, "claude", &[], true).unwrap()["events"][0]["target"],
            "session_test"
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
            &json!({"action":"rebind","threadId":"thread","target":"session_test"}),
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
            Some("session_test")
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
            b.target = Some(format!("session_{name}"));
            let d = &mut b.deliveries[0];
            d.target = b.target.clone().unwrap();
            d.status = if name == "pending" {
                "pending"
            } else {
                "delivered"
            }
            .into();
            d.attempted_at = 100;
            let target = state.target(b.channel, b.target.as_ref().unwrap(), now, &settings);
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
            json!({"totalTargets":8,"totalThreads":8,"totalBindings":9,"hidden":{"targets":2,"threads":4,"bindings":5}})
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
            json!({"target":"session_recent"}),
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
    async fn actionable_notification_rendering() {
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let fake = Fake::success();
        let request = json!({"id":"[\"desktop\",\"thread-1\",0]","owner":"desktop","backendSession":"old-session","method":"request_user_input_async","canRespond":true,"params":{"question":"原文\n第二行","options":["保持原样","继续"]}});
        process(
            &fake,
            &dir.0,
            &mut b,
            &json!({"state":"interaction-required","interaction":[request]}),
        )
        .await
        .unwrap();
        b.ingress = "caller".into();
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
        let body = message(&b);
        assert!(body.starts_with("[ARC] needs-input · "));
        assert!(body.contains("question: 原文\n第二行\noptions: 1) 保持原样 | 2) 继续"));
        let call: Value = serde_json::from_str(
            body.lines()
                .find_map(|s| s.strip_prefix("respond="))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(call["args"]["id"], request["id"]);
        assert_eq!(call["args"]["backendSession"], "old-session");
        let sync = json!({"id":"sync","backendSession":"session","method":"item/tool/requestUserInput","params":{"questions":[{"id":"a","question":"甲","options":[]},{"id":"b","question":"乙"}]}});
        let text = interaction_text(&b, &sync);
        assert_eq!(text.matches("respond=").count(), 2);
        assert_eq!(text.matches("options: (free text)").count(), 2);
        assert!(text.contains("submit all question IDs together"));
        let approval = json!({"id":"approval","backendSession":"session","method":"item/commandExecution/requestApproval","params":{"command":"echo \"quoted\"","availableDecisions":["decline","cancel"]}});
        assert!(interaction_text(&b, &approval).contains("decisions: [\"decline\",\"cancel\"]"));
        process(&fake, &dir.0, &mut b, &json!({"state":"completed","finalResponse":{"text":"🙂".repeat(2001),"textTruncated":false}})).await.unwrap();
        let mut terminal = b.clone();
        terminal.deliveries = vec![b.deliveries.last().unwrap().clone()];
        let text = message(&terminal);
        assert!(text.contains("final (truncated=yes):"));
        assert_eq!(text.matches('🙂').count(), 2000);
        assert!(text.contains("query={"));
        terminal.deliveries[0].final_response = json!({"text":"完整原文\n下一行"});
        assert!(message(&terminal).contains("final (truncated=no):\n完整原文\n下一行"));
        for state in ["failed", "cancelled"] {
            terminal.deliveries[0].task_state = state.into();
            terminal.deliveries[0].task_error = json!("原始错误\n详情");
            assert!(message(&terminal).ends_with("error: 原始错误\n详情"));
        }
        assert!(!message(&b).contains("**任务**"));
    }
    #[tokio::test]
    async fn quiet_receipts_health_and_ack_distinguish_consumed_events() {
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        b.ingress = "claude".into();
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
        let calls = fake.calls.lock().unwrap();
        assert!(!calls[0][1].contains("桶余量"));
        assert!(!calls[0][1].contains("近 10 分钟"));
        drop(calls);
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
        let request = json!({"respondToken":"abcdefghijklmnopqrstuv","backendSession":"session","id":"legacy","method":"request_user_input_async","params":{"question":"原文","options":[]}});
        let rendered = interaction_text(&fixture(&dir.0), &request);
        assert!(rendered.contains("respondToken"));
        assert!(!rendered.contains("backendSession"));
        assert!(rendered.contains("question: 原文"));
    }
    #[tokio::test]
    async fn inbox_session_dedup_and_scoped_ack() {
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        b.ingress = "claude".into();
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
        assert!(inbox_in(&dir.0, "claude", &[], true).unwrap().is_null());
        assert_eq!(
            inbox_in(&dir.0, "claude", &[], false).unwrap()["events"]
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
            inbox_in(&dir.0, "claude", &[], true).unwrap()["events"][0]["eventId"],
            "fresh"
        );
        assert!(inbox_in(&dir.0, "claude", &[], true).unwrap().is_null());
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
            inbox_in(&dir.0, "chatgpt", &[], false).unwrap()["unread"],
            1
        );
        assert_eq!(
            inbox_in(&dir.0, "chatgpt", &[], false).unwrap()["unread"],
            1
        );
    }
    #[test]
    fn session_forms_and_turn_isolation() {
        for input in [
            "session_test",
            "https://claude.ai/code/session_test?x=y",
            "claude.ai/code/session_test",
            "http://claude.ai/code/session_test#fragment",
        ] {
            assert_eq!(session_id(input).unwrap(), "session_test");
        }
        assert_eq!(session_id("cse_test").unwrap(), "cse_test");
        for bad in [
            "",
            "session_",
            "cse_",
            "hello world",
            "--help",
            "https://other.invalid/code/session_test",
            "session_a extra",
        ] {
            assert!(session_id(bad).is_err());
        }
        let dir = Sandbox::new();
        fixture(&dir.0);
        bind_in(
            &dir.0,
            Some("cse_other"),
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
            Some("session_test")
        );
        assert_eq!(
            binding(&dir.0, "thread-1", "turn-2")
                .unwrap()
                .unwrap()
                .target
                .as_deref(),
            Some("cse_other")
        );
        assert!(binding(&dir.0, "thread-1", "turn-3").unwrap().is_none());
        bind_in(&dir.0, None, "thread-1", "turn-2", "").unwrap();
        assert_eq!(
            binding(&dir.0, "thread-1", "turn-2")
                .unwrap()
                .unwrap()
                .target
                .as_deref(),
            Some("cse_other")
        );
    }
    #[tokio::test]
    async fn steer_without_session_keeps_binding_and_new_turn_stays_unbound() {
        let dir = Sandbox::new();
        fixture(&dir.0);
        bind_in(&dir.0, None, "thread-1", "turn-1", "").unwrap();
        bind_in(&dir.0, None, "thread-1", "turn-2", "").unwrap();
        let mut b = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
        assert_eq!(b.target.as_deref(), Some("session_test"));
        assert!(binding(&dir.0, "thread-1", "turn-2").unwrap().is_none());
        let fake = Fake::success();
        process(&fake, &dir.0, &mut b, &json!({"state":"completed"}))
            .await
            .unwrap();
        assert_eq!(fake.calls.lock().unwrap()[0][3], "session_test");
    }
    #[test]
    fn binding_failure_marks_receipt_without_changing_dispatch_result() {
        let dir = Sandbox::new();
        std::fs::create_dir_all(&dir.0).unwrap();
        let blocked = dir.0.join("not-a-directory");
        std::fs::write(&blocked, "fixture").unwrap();
        let result = bind_in(&blocked, Some("session_test"), "thread-1", "turn-1", "");
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
    fn seven_day_cleanup_preserves_unfinished_records() {
        for terminal in [false, true] {
            let dir = Sandbox::new();
            let mut b = fixture(&dir.0);
            b.terminal = terminal;
            b.created_at = 100;
            persist(&dir.0, &b).unwrap();
            // Rebinding preserves the original creation time.
            bind_in(&dir.0, Some("cse_other"), "thread-1", "turn-1", "").unwrap();
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
        struct Probe<'a> {
            lock: &'a Mutex<()>,
            dir: &'a Path,
            fail: bool,
        }
        impl Executor for Probe<'_> {
            async fn send(&self, _: Vec<String>) -> Result<Vec<u8>> {
                let _guard = self
                    .lock
                    .try_lock()
                    .expect("CLI must not hold binding lock");
                let b = binding(self.dir, "thread-1", "turn-1")?.unwrap();
                assert_eq!(b.deliveries[0].status, "sending");
                bind_in(self.dir, Some("cse_other"), "thread-1", "turn-1", "")?;
                if self.fail {
                    Err("simulated failure".into())
                } else {
                    Ok(br#"{"ok":true,"session_id":"session_test"}"#.to_vec())
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
            assert_eq!(b.target.as_deref(), Some("cse_other"));
            assert_eq!(b.deliveries[0].target, "session_test");
            assert_eq!(
                b.deliveries[0].status,
                if fail { "pending" } else { "delivered" }
            );
            assert_eq!(notification(Some(b))["deliveries"], json!([]));
        }
    }

    #[tokio::test]
    async fn request_dedup_survives_restart_and_terminal_follows_interaction() {
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
        assert_eq!(fake.calls.lock().unwrap().len(), 3);
        assert!(b.terminal);
        let report = notification(binding(&dir.0, "thread-1", "turn-1").unwrap());
        assert_eq!(report["target"], "session_test");
        assert_eq!(
            report["deliveries"][2],
            json!({"eventId":b.deliveries[2].event_id,"kind":"completed","level":"L1","state":"delivered","error":null,"timing":b.deliveries[2].timing})
        );
        assert!(b.deliveries.iter().all(|d| d.status == "delivered"));
        let calls = fake.calls.lock().unwrap();
        assert_eq!(calls[0][0], "-p");
        assert!(calls[0][1].starts_with("[ARC] "));
        assert_eq!(
            &calls[0][2..],
            ["--cloud", "session_test", "--output-format", "json"]
        );
        assert!(serde_json::to_string(&*calls)
            .unwrap()
            .contains("SECRET_OUTPUT"));
        assert!(
            std::fs::read_to_string(path_in(&dir.0, "thread-1", "turn-1"))
                .unwrap()
                .contains("SECRET_OUTPUT")
        );
    }
    #[tokio::test]
    async fn steering_rebind_does_not_report_old_session_delivery() {
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let fake = Fake::success();
        process(&fake, &dir.0, &mut b, &interaction(json!(17)))
            .await
            .unwrap();
        bind_in(&dir.0, Some("cse_other"), "thread-1", "turn-1", "").unwrap();
        let mut b = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
        let report = notification(Some(b.clone()));
        assert_eq!(report["target"], "cse_other");
        assert_eq!(report["deliveries"], json!([]));
        process(&fake, &dir.0, &mut b, &interaction(json!(17)))
            .await
            .unwrap();
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
        let other = Fake::new(Ok(br#"{"ok":true,"session_id":"cse_other"}"#.to_vec()));
        process(&other, &dir.0, &mut b, &json!({"state":"completed"}))
            .await
            .unwrap();
        assert_eq!(other.calls.lock().unwrap()[0][3], "cse_other");
        assert_eq!(
            notification(Some(b.clone()))["deliveries"],
            json!([{"eventId":b.deliveries[1].event_id,"kind":"completed","level":"L1","state":"delivered","error":null,"timing":b.deliveries[1].timing}])
        );
    }

    #[tokio::test]
    async fn idless_waiting_uses_confirmed_state_entries() {
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
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
        process(&fake, &dir.0, &mut b, &json!({"state":"running"}))
            .await
            .unwrap();
        process(&fake, &dir.0, &mut b, &wait).await.unwrap();
        assert_eq!(fake.calls.lock().unwrap().len(), 2);
        assert_eq!(b.deliveries[0].state, "等待输入");
    }
    #[tokio::test]
    async fn failures_remain_pending_during_retry_backoff() {
        for result in [
            Err("timeout".into()),
            Err("not installed".into()),
            Ok(b"not json".to_vec()),
            Ok(br#"{"ok":false,"error":"SECRET_ERROR"}"#.to_vec()),
            Ok(br#"{"ok":true,"session_id":"session_wrong"}"#.to_vec()),
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
            assert_eq!(fake.calls.lock().unwrap().len(), 1);
            assert!(fake.fallbacks.lock().unwrap().is_empty());
            assert_eq!(b.deliveries[0].status, "pending");
            assert_eq!(b.deliveries[0].state, "失败");
        }
    }
    #[tokio::test]
    async fn interrupted_delivery_recovers_with_same_event_id() {
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
            target: "session_test".into(),
            state: "等待审批".into(),
            task_state: "interaction-required".into(),
            interaction: Value::Null,
            status: "sending".into(),
            final_response: Value::Null,
            changes: Value::Null,
            task_error: Value::Null,
        });
        persist(&dir.0, &b).unwrap();
        let mut b = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
        recover(&fake, &dir.0, &mut b).await.unwrap();
        recover(&fake, &dir.0, &mut b).await.unwrap();
        process(&fake, &dir.0, &mut b, &interaction(json!(17)))
            .await
            .unwrap();
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
        assert!(fake.fallbacks.lock().unwrap().is_empty());
        process(&fake, &dir.0, &mut b, &json!({"state":"cancelled"}))
            .await
            .unwrap();
        assert_eq!(fake.calls.lock().unwrap().len(), 2);
        assert_eq!(b.deliveries[1].state, "中断");
    }
}

pub(crate) fn push_available(notification: &Value) -> bool {
    if notification["channel"] != "claude-session" || !notification["target"].is_string() {
        return false;
    }
    let Ok(settings) = settings() else {
        return false;
    };
    if settings["notificationsEnabled"] == false
        || crate::agents::driver::discover("claude").is_none()
    {
        return false;
    }
    let Ok(state) = State::load(&directory()) else {
        return false;
    };
    !state.targets.iter().any(|t| {
        t.channel == Channel::ClaudeSession && notification["target"] == t.target && t.breaker
    })
}

// Both explicit reads and the background observer can publish the first terminal
// event. Collect its snapshot on either path, before process freezes the delivery.
async fn enrich_completion(control: &Arc<control::Control>, b: &Binding, observed: &mut Value) {
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
