//! Turn-scoped control-source events, inboxes and fixed notification channels.
use crate::*;
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Delivery {
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
}
fn directory() -> PathBuf {
    root().join("notifications")
}
fn path_in(dir: &Path, thread: &str, turn: &str) -> PathBuf {
    dir.join(format!("{}.json", hash(json!([thread, turn]).to_string())))
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
    ChatgptWeb,
}

pub(crate) fn normalize(args: &mut Value) -> Result<()> {
    if args["notify"]["channel"] == "claude-session" {
        args["notify"]["target"] = json!(session_id(string(&args["notify"], "target"))?);
    }
    Ok(())
}

pub(crate) async fn bind(args: &Value, thread: &str, turn: &str, cwd: &str) -> Result<()> {
    if turn.is_empty() {
        return Ok(());
    } // Thread-only create has no event yet.
    let _guard = LOCK.lock().await;
    let dir = directory();
    if binding(&dir, thread, turn)?.is_none() {
        bind_in(&dir, Some(""), thread, turn, cwd)?;
    }
    let mut b = binding(&dir, thread, turn)?.unwrap();
    if let Some(notify) = args.get("notify") {
        if b.target.as_deref() != notify["target"].as_str()
            || serde_json::to_value(b.channel).unwrap() != notify["channel"]
        {
            for d in &mut b.deliveries {
                if d.status == "pending" {
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
        "deliveries": b.deliveries.iter().filter(|d| d.channel == b.channel && Some(d.target.as_str()) == b.target.as_deref()).map(|d| json!({"eventId":d.event_id,"kind":event(&b,d)["kind"],"level":if b.channel==Channel::ClaudeSession {"L1"}else{"L4"},"state":d.status,"error":d.error})).collect::<Vec<_>>()
    })).unwrap_or(Value::Null)
}
pub(crate) fn read(thread: &str, turn: &str) -> Result<Value> {
    Ok(notification(binding(&directory(), thread, turn)?))
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
    json!({"eventId":d.event_id,"kind":kind,"project":b.project,"threadId":if agent {Value::Null}else{json!(b.thread_id)},"taskId":if agent {json!(b.thread_id)}else{Value::Null},"agent":if agent {json!(b.agent)}else{json!("codex")},"turnId":b.turn_id,"title":b.title,"summary":format!("ARC task {kind}."),"interaction":d.interaction,"next":if d.interaction["next"].is_object() {d.interaction["next"].clone()} else {next}})
}
// Keep the persisted event lossless; render only the outbound notification here.
fn notification_block(text: &str, language: &str) -> String {
    let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(3.max(longest + 1));
    format!("{fence}{language}\n{text}\n{fence}")
}
fn notification_value(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        // Quoting keeps upstream text visibly separate from ARC's own guidance.
        text.split('\n')
            .map(|line| format!("> {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        notification_block(
            &serde_json::to_string_pretty(value).unwrap_or_default(),
            "json",
        )
    }
}
fn interaction_text(interaction: &Value) -> String {
    let mut params = interaction.get("params").cloned().unwrap_or_else(|| {
        let mut content = interaction.clone();
        if let Some(fields) = content.as_object_mut() {
            for key in [
                "id",
                "responseId",
                "interactionId",
                "nativeId",
                "backendSession",
                "owner",
                "canRespond",
                "next",
                "resolved",
                "jsonrpc",
            ] {
                fields.remove(key);
            }
        }
        content
    });
    if let Some(fields) = params.as_object_mut() {
        // These are routing metadata, never approval or question content.
        for key in ["threadId", "turnId", "questionItemId"] {
            fields.remove(key);
        }
    }
    let mut sections = Vec::new();
    if let Some(fields) = params.as_object_mut() {
        for (key, label) in [
            ("question", "需要确认"),
            ("questions", "需要确认"),
            ("message", "说明"),
            ("command", "待执行命令"),
            ("cwd", "工作目录"),
            ("reason", "原因"),
            ("options", "可选回答"),
        ] {
            if let Some(value) = fields.remove(key) {
                let body = if key == "options" {
                    value
                        .as_array()
                        .map(|options| {
                            options
                                .iter()
                                .enumerate()
                                .map(|(i, option)| {
                                    format!(
                                        "{}. {}",
                                        i + 1,
                                        notification_value(option).replace('\n', "\n   ")
                                    )
                                })
                                .collect::<Vec<_>>()
                                .join("\n\n")
                        })
                        .unwrap_or_else(|| notification_value(&value))
                } else if key == "questions" && value.is_array() {
                    value
                        .as_array()
                        .unwrap()
                        .iter()
                        .enumerate()
                        .map(|(i, question)| {
                            format!(
                                "**问题 {}**\n\n{}",
                                i + 1,
                                interaction_text(&json!({"params": question}))
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n")
                } else {
                    notification_value(&value)
                };
                sections.push(format!("**{label}**\n\n{body}"));
            }
        }
    }
    if !params.is_null() && params.as_object().is_none_or(|fields| !fields.is_empty()) {
        sections.push(format!("**交互详情**\n\n{}", notification_value(&params)));
    }
    sections.join("\n\n")
}
fn message(b: &Binding) -> String {
    b.deliveries.iter().map(|d| {
        let agent = !b.agent.is_empty() && b.agent != "codex";
        let pending = !matches!(d.task_state.as_str(), "completed" | "failed" | "cancelled");
        let status = match d.task_state.as_str() {
            "completed" => "本轮完成",
            "failed" => "执行失败",
            "cancelled" => "已中断",
            _ if d.state == "等待审批" => "等待审批",
            _ => "等待输入",
        };
        let title = if b.title.is_empty() { "未命名任务" } else { &b.title };
        let mut sections = vec![format!("[ARC] {status}\n\n**任务**\n\n{}\n\n项目：{} · Agent：{}",
            notification_value(&json!(title)), b.project, if agent { &b.agent } else { "Codex" })];
        if pending {
            let content = interaction_text(&d.interaction);
            if !content.is_empty() { sections.push(content); }
            if let Some(method) = d.interaction["method"].as_str() {
                sections.push(format!("交互类型：{method}"));
            }
            if d.interaction["method"] == "request_user_input_async" {
                sections.push("支持选项或自由文本回复。".into());
            }
        }
        let op = match (agent, pending) {
            (true, true) => "agent_pending",
            (true, false) => "agent_read",
            (false, true) => "codex_pending",
            (false, false) => "codex_read",
        };
        let args = if agent { json!({"agent":b.agent,"taskId":b.thread_id}) }
            else { json!({"threadId":b.thread_id}) };
        let hint = if pending && d.interaction["canRespond"] == false {
            "此交互不能远程回复，需在原任务所属应用中处理；可查询最新状态。"
        } else if pending {
            "先查询最新待处理交互，按原任务的交互契约回复；不要重发任务。若没有可回复请求，需在原任务所属应用中处理。"
        } else if d.task_state == "completed" {
            "读取本轮结果并对照要求验收；本轮完成不代表验收通过。"
        } else {
            "读取任务结果，检查原因与当前进度。"
        };
        sections.push(format!("**下一步**\n\n{hint}\n\n调用 query：\n\n{}", notification_block(
            &json!({"op":op,"args":args}).to_string(), "json")));
        // IDs occur once in the query above or in this footer, without abbreviation.
        sections.push(format!("**定位信息**\n\n{}", notification_block(
            &format!("turnId: {}\neventId: {}", b.turn_id, d.event_id), "text")));
        sections.join("\n\n")
    }).collect::<Vec<_>>().join("\n\n---\n\n")
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
trait Executor {
    fn send(&self, args: Vec<String>) -> impl Future<Output = Result<Vec<u8>>> + Send;
    fn fallback(&self, body: String) -> impl Future<Output = ()> + Send;
}
struct Cli;
impl Executor for Cli {
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
    async fn fallback(&self, body: String) {
        if !settings().is_ok_and(|s| s["notificationsEnabled"] != false) {
            return;
        }
        if let Err(error) =
            crate::transport::forward_request("permissions/notify", "POST", json!({"body":body}))
                .await
        {
            crate::logs::record(
                "WARN",
                &format!("Claude notification fallback unavailable: {error}"),
                None,
            );
        }
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
    executor.fallback(fallback_body(b)).await;
    "failed"
}
fn fallback_body(b: &Binding) -> String {
    format!(
        "项目 {}，线程 {}，轮次 {} 的 Claude 通知未送达，请检查。",
        b.project, b.thread_id, b.turn_id
    )
}
fn recover(dir: &Path, b: &mut Binding) -> Result<bool> {
    let retry = |d: &Delivery| {
        d.status == "sending"
            || (d.status == "failed"
                && matches!(
                    d.error.as_deref(),
                    None | Some("delivery-failed-or-unconfirmed" | "wake-limit" | "disabled")
                ))
    };
    if b.deliveries.iter().any(retry) {
        for d in &mut b.deliveries {
            if retry(d) {
                d.status = "pending".into();
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
    let events = transitions(b, observation);
    if events.is_empty() && b.waiting == previous_waiting && !resolved {
        return Ok(());
    }
    let first = b.deliveries.len();
    for (key, state) in events {
        b.deliveries.push(Delivery {
            channel: b.channel,
            target: b.target.clone().unwrap_or_default(),
            event_id: hash(json!([b.agent, b.thread_id, b.turn_id, key]).to_string()),
            created_at: chrono::Utc::now().timestamp(),
            batch: String::new(),
            attempted_at: 0,
            attempts: vec![],
            error: None,
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
                    *row = event(b, d);
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
pub(crate) async fn inbox(ingress: &str, reads: &[(String, String)]) -> Result<Value> {
    let _guard = LOCK.lock().await;
    let path = inbox_path(&directory(), ingress);
    if !path.exists() {
        return Ok(Value::Null);
    }
    let mut rows = load(&path)?;
    if let Some(rows) = rows.as_array_mut() {
        for row in rows {
            if reads.iter().any(|(task, turn)| {
                (row["threadId"] == *task || row["taskId"] == *task) && row["turnId"] == *turn
            }) {
                row["read"] = json!(true);
            }
        }
    }
    if !reads.is_empty() {
        save(&path, &rows)?;
    }
    let unread: Vec<_> = rows
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["read"] != true)
        .cloned()
        .map(|mut row| {
            // Stored events predate the frozen surface; project their next call
            // through the current catalog without rewriting notification history.
            if let Some(op) = row["next"]["tool"].as_str().map(str::to_owned) {
                let mut next = row["next"].take();
                if let Some(spec) = catalog()["ops"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["name"] == op)
                {
                    next["via"] = json!(crate::egress::via(spec));
                    next["op"] = json!(op);
                    next["args"] = next["arguments"].take();
                }
                next.as_object_mut().unwrap().remove("tool");
                next.as_object_mut().unwrap().remove("arguments");
                row["next"] = next;
            }
            row
        })
        .collect();
    Ok(if unread.is_empty() {
        Value::Null
    } else {
        json!({"unread":unread.len(),"events":unread.into_iter().take(5).collect::<Vec<_>>()})
    })
}

fn records(dir: &Path) -> Result<Vec<Binding>> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    std::fs::read_dir(dir)
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
    if settings["enabled"].is_null() {
        settings["enabled"] = json!(false);
    }
    if settings["autoOpenCodex"].is_null() {
        settings["autoOpenCodex"] = json!(!cfg!(target_os = "linux"));
    }
    if settings["notificationsEnabled"].is_null() {
        settings["notificationsEnabled"] = json!(true);
    }
    if settings["notificationWakeLimit"].is_null() {
        settings["notificationWakeLimit"] = json!(20);
    }
    Ok(settings)
}

// A batch is reserved under the existing lock, sent outside it, then merged.
// Only pending records are eligible; sending records never retry after restart.
async fn flush(
    executor: &impl Executor,
    dir: &Path,
    lock: &Mutex<()>,
    now: i64,
    window: i64,
    settings: &Value,
) -> Result<()> {
    let guard = lock.lock().await;
    let mut all = records(dir)?;
    let mut targets = Vec::new();
    for b in &all {
        for d in &b.deliveries {
            if d.status == "pending"
                && (d.task_state == "interaction-required" || now - d.created_at >= window)
                && (d.attempted_at == 0 || now - d.attempted_at >= 10)
                && !targets.contains(&(d.channel, d.target.clone()))
            {
                targets.push((d.channel, d.target.clone()));
            }
        }
    }
    let mut batches = Vec::new();
    for (channel, target) in targets {
        let wakes: std::collections::HashSet<_> = all
            .iter()
            .flat_map(|b| &b.deliveries)
            .filter(|d| d.channel == channel && d.target == target)
            .flat_map(|d| {
                d.attempts
                    .iter()
                    .map(|(batch, time)| (batch, *time))
                    .chain(std::iter::once((&d.batch, d.attempted_at)))
            })
            .filter(|(batch, time)| !batch.is_empty() && *time > now.saturating_sub(3600))
            .map(|(batch, _)| batch)
            .collect();
        let reason = if settings["notificationsEnabled"] == false {
            Some("disabled")
        } else if target.is_empty() {
            Some("unbound")
        } else if channel != Channel::ClaudeSession {
            Some("channel-unavailable-in-P0")
        } else if wakes.len() >= settings["notificationWakeLimit"].as_u64().unwrap_or(20) as usize {
            Some("wake-limit")
        } else {
            None
        };
        if reason == Some("wake-limit") || reason == Some("disabled") {
            continue;
        }
        let batch = id();
        let mut reserved = Vec::new();
        for b in &mut all {
            let mut selected = b.clone();
            selected.target = Some(target.clone());
            selected.channel = channel;
            selected.deliveries.clear();
            for d in &mut b.deliveries {
                if d.channel == channel && d.target == target && d.status == "pending" {
                    if d.attempted_at != 0 && now - d.attempted_at < 10 {
                        continue;
                    }
                    d.status = if reason.is_some() {
                        "failed"
                    } else {
                        "sending"
                    }
                    .into();
                    d.error = reason.map(str::to_owned);
                    if reason.is_none() {
                        d.attempts
                            .retain(|(_, time)| *time > now.saturating_sub(3600));
                        if !d.batch.is_empty() {
                            d.attempts.push((d.batch.clone(), d.attempted_at));
                        }
                        d.batch = batch.clone();
                        d.attempted_at = now;
                    }
                    selected.deliveries.push(d.clone());
                }
            }
            if !selected.deliveries.is_empty() {
                persist(dir, b)?;
                if reason == Some("wake-limit") && !b.ingress.is_empty() {
                    let path = inbox_path(dir, &b.ingress);
                    if path.exists() {
                        let mut rows = load(&path)?;
                        for row in rows.as_array_mut().into_iter().flatten() {
                            if selected
                                .deliveries
                                .iter()
                                .any(|d| row["eventId"] == d.event_id)
                            {
                                row["notificationError"] = json!("wake-limit");
                            }
                        }
                        save(&path, &rows)?;
                    }
                }
                reserved.push(selected);
            }
        }
        if reason.is_none() {
            batches.push(reserved);
        }
    }
    drop(guard);
    for batch in batches {
        let body = batch
            .iter()
            .map(|b| message(b))
            .collect::<Vec<_>>()
            .join("\n");
        let status = deliver_message(executor, &batch[0], &body).await;
        let _guard = lock.lock().await;
        for reserved in batch {
            if let Some(mut current) = binding(dir, &reserved.thread_id, &reserved.turn_id)? {
                for d in &mut current.deliveries {
                    if reserved
                        .deliveries
                        .iter()
                        .any(|r| r.event_id == d.event_id && r.target == d.target)
                    {
                        d.status = if status == "failed" {
                            "pending"
                        } else {
                            status
                        }
                        .into();
                        if status == "failed" {
                            d.error = Some("delivery-failed-or-unconfirmed".into());
                        }
                    }
                }
                persist(dir, &current)?;
            }
        }
    }
    Ok(())
}

pub(crate) async fn migrate() -> Result<()> {
    let _guard = LOCK.lock().await;
    let old = root().join("claude-notifications");
    if !old.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&old)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        if !entry.path().extension().is_some_and(|v| v == "json") {
            continue;
        }
        let mut v = load(&entry.path())?;
        v["target"] = v["sessionId"].take();
        v["channel"] = json!("claude-session");
        v["explicit"] = json!(true);
        v["agent"] = json!("codex");
        // Recover the original ingress from existing dispatch receipts once.
        for receipt in std::fs::read_dir(root())
            .map_err(|e| e.to_string())?
            .flatten()
        {
            if !receipt.path().extension().is_some_and(|ext| ext == "json") {
                continue;
            }
            if let Ok(r) = load(&receipt.path()) {
                if r["threadId"] == v["threadId"] && r["turnId"] == v["turnId"] {
                    v["ingress"] = json!(string(&r["origin"], "ingressId"));
                    v["title"] = json!(string(&r["task"], "title"));
                    break;
                }
            }
        }
        if let Some(ds) = v["deliveries"].as_array_mut() {
            for d in ds {
                d["target"] = d["sessionId"].take();
            }
        }
        let mut b: Binding = serde_json::from_value(v).map_err(|e| e.to_string())?;
        for d in &mut b.deliveries {
            d.event_id = hash(json!([b.agent, b.thread_id, b.turn_id, d.key]).to_string());
            d.batch = d.event_id.clone();
        }
        if binding(&directory(), &b.thread_id, &b.turn_id)?.is_none() {
            persist(&directory(), &b)?;
        }
        std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
    }
    std::fs::remove_dir(&old).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn start(control: &Arc<control::Control>, agents: &Arc<crate::agents::AgentHost>) {
    let agents = Arc::downgrade(agents);
    let weak = Arc::downgrade(control);
    let ready = Arc::new(tokio::sync::Notify::new());
    let delivery_ready = ready.clone();
    let mut delivery_shutdown = control.shutdown.subscribe();
    let wake = control.events.clone();
    tokio::spawn(async move {
        tokio::select! { _ = delivery_shutdown.changed() => return, _ = delivery_ready.notified() => {} }
        loop {
            let result = async {
                flush(
                    &Cli,
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
                if let Ok(entries) = std::fs::read_dir(directory()) {
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
                        let fallback = recovering && recover(&directory(), &mut b)?;
                        drop(_guard);
                        if fallback && settings()?["notificationsEnabled"] != false {
                            Cli.fallback(fallback_body(&b)).await;
                        }
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
                                    crate::waiter::codex_observe(&c, &args).await
                                } else {
                                    agents
                                        .observe_notification(&b.agent, &b.thread_id, &b.turn_id)
                                        .await
                                }
                            })
                            .await;
                            (b, result)
                        });
                    }
                }
                while let Some(result) = reads.join_next().await {
                    let Ok((old, Ok(Ok(observed)))) = result else {
                        continue;
                    };
                    let mut b = old;
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
                ready.notify_one();
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
        async fn fallback(&self, body: String) {
            self.fallbacks.lock().unwrap().push(body);
        }
    }
    async fn process(
        executor: &impl Executor,
        dir: &Path,
        b: &mut Binding,
        observation: &Value,
    ) -> Result<()> {
        super::process(dir, &Mutex::new(()), b, observation).await?;
        flush(
            executor,
            dir,
            &Mutex::new(()),
            i64::MAX,
            0,
            &json!({"notificationWakeLimit":100}),
        )
        .await?;
        *b = binding(dir, &b.thread_id, &b.turn_id)?.unwrap();
        Ok(())
    }
    async fn recover(executor: &impl Executor, dir: &Path, b: &mut Binding) -> Result<()> {
        if super::recover(dir, b)? {
            executor.fallback(fallback_body(b)).await;
        }
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
            async fn fallback(&self, _: String) {
                let _guard = self
                    .lock
                    .try_lock()
                    .expect("fallback must not hold binding lock");
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
            json!({"eventId":b.deliveries[2].event_id,"kind":"completed","level":"L1","state":"delivered","error":null})
        );
        assert!(b.deliveries.iter().all(|d| d.status == "delivered"));
        let calls = fake.calls.lock().unwrap();
        assert_eq!(calls[0][0], "-p");
        assert!(calls[0][1].starts_with("[ARC] "));
        assert_eq!(
            &calls[0][2..],
            ["--cloud", "session_test", "--output-format", "json"]
        );
        assert!(!serde_json::to_string(&*calls)
            .unwrap()
            .contains("SECRET_OUTPUT"));
        assert!(
            !std::fs::read_to_string(path_in(&dir.0, "thread-1", "turn-1"))
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
            json!([{"eventId":b.deliveries[1].event_id,"kind":"completed","level":"L1","state":"delivered","error":null}])
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
            assert_eq!(fake.fallbacks.lock().unwrap().len(), 1);
            assert!(!fake.fallbacks.lock().unwrap()[0].contains("SECRET"));
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
            channel: Channel::ClaudeSession,
            event_id: "event-17".into(),
            created_at: 0,
            batch: String::new(),
            attempted_at: 0,
            attempts: vec![],
            error: None,
            key: "request:17".into(),
            target: "session_test".into(),
            state: "等待审批".into(),
            task_state: "interaction-required".into(),
            interaction: Value::Null,
            status: "sending".into(),
        });
        persist(&dir.0, &b).unwrap();
        let mut b = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
        recover(&fake, &dir.0, &mut b).await.unwrap();
        recover(&fake, &dir.0, &mut b).await.unwrap();
        process(&fake, &dir.0, &mut b, &interaction(json!(17)))
            .await
            .unwrap();
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
        assert_eq!(fake.fallbacks.lock().unwrap().len(), 1);
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
    let Ok(all) = records(&directory()) else {
        return false;
    };
    let now = chrono::Utc::now().timestamp();
    let wakes: std::collections::HashSet<_> = all
        .iter()
        .flat_map(|b| &b.deliveries)
        .filter(|d| d.channel == Channel::ClaudeSession && notification["target"] == d.target)
        .flat_map(|d| {
            d.attempts
                .iter()
                .map(|(batch, time)| (batch, *time))
                .chain(std::iter::once((&d.batch, d.attempted_at)))
        })
        .filter(|(batch, time)| !batch.is_empty() && *time > now.saturating_sub(3600))
        .map(|(batch, _)| batch)
        .collect();
    wakes.len() < settings["notificationWakeLimit"].as_u64().unwrap_or(20) as usize
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
        if matches!(name, "codex_items" | "codex_changes")
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
        if name == "codex_read" || name == "agent_read" {
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
        observe(task, turn, &observation).await?;
        reads.push((task.into(), turn.into()));
    }
    reads.sort();
    reads.dedup();
    Ok(reads)
}
