use super::lifecycle;
use crate::kernel::receipts::progress::{
    self, Event as ProgressEvent, Progress, State as ReceiptState,
};
use crate::owned_children::SpawnOwned;
use crate::turn_lifecycle::adapters as turn_adapter;
use crate::*;
use std::{collections::HashMap, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    sync::oneshot,
};
type Replies = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value>>>>>;

/// Only content deltas may wait for the next checkpoint. Unknown events are structural.
pub(crate) fn streaming_delta(pi: bool, msg: &Value) -> bool {
    if pi {
        msg["type"] == "message_update"
            && matches!(
                string(&msg["assistantMessageEvent"], "type"),
                "text_delta" | "thinking_delta" | "toolcall_delta"
            )
    } else {
        msg["method"] == "session/update"
            && matches!(
                string(&msg["params"]["update"], "sessionUpdate"),
                "agent_message_chunk" | "agent_thought_chunk"
            )
    }
}
/// Configuration inputs exclude output, tracking, and observation timestamps.
pub(crate) fn configuration(state: &Value) -> Value {
    let metadata = &state["metadata"];
    json!([
        metadata["configOptions"],
        metadata["models"],
        metadata["modes"]
    ])
}
pub(crate) fn stdout_diagnostics(previous: &Value, frame: &[u8]) -> Value {
    let mut lines = previous["lines"].as_array().cloned().unwrap_or_default();
    let text = crate::task_tracking::redact(&String::from_utf8_lossy(frame));
    let mut end = text.len().min(1024);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    lines.push(json!(&text[..end]));
    let mut result = json!({"lines":lines,
        "skippedLines":previous["skippedLines"].as_u64().unwrap_or(0).saturating_add(1),
        "truncated":previous["truncated"] == true || end < text.len()});
    while result["lines"].as_array().unwrap().len() > 32 || result.to_string().len() > 4096 {
        result["lines"].as_array_mut().unwrap().remove(0);
        result["truncated"] = json!(true);
    }
    result
}
pub(crate) fn stdout_read_error(error: &str) -> String {
    if error == "FRAME_TOO_LARGE" {
        "AGENT_STDOUT_FRAME_TOO_LARGE: A stdout line exceeded 32 MiB. Configure the Agent to split protocol output into smaller messages, then reconcile the task before resuming.".into()
    } else {
        format!("AGENT_STDOUT_READ_FAILED: {}. Inspect the Agent process and logs, then reconcile the task before resuming.", crate::task_tracking::redact(error))
    }
}
fn bounded_output(mut text: String, state: &mut Value) -> String {
    if text.len() <= 256 * 1024 {
        return text;
    }
    let mut start = text.len() - 256 * 1024;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text = text[start..].to_owned();
    state["outputTruncated"] = json!(true);
    text
}
pub(crate) fn exit_error(error: &str, diagnostics: &Value) -> String {
    if diagnostics["skippedLines"].as_u64().unwrap_or(0) == 0 {
        error.into()
    } else {
        format!("{error} Recent non-JSON stdout (redacted, bounded): {diagnostics}")
    }
}

// Dropping a read-only wait must release its RPC waiter, never cancel the agent.
struct ReplyGuard(Replies, String);
impl Drop for ReplyGuard {
    fn drop(&mut self) {
        let replies = self.0.clone();
        let key = self.1.clone();
        tokio::spawn(async move {
            replies.lock().await.remove(&key);
        });
    }
}

enum Frames {
    Direct(BufReader<tokio::process::ChildStdout>),
    Hosted {
        client: Arc<crate::task_host::Client>,
        offset: u64,
        queued: std::collections::VecDeque<Value>,
        journal: crate::task_host::JournalReader,
    },
}
impl Frames {
    async fn next(&mut self) -> Result<Vec<u8>> {
        match self {
            Self::Direct(reader) => crate::line(reader, 32 * 1024 * 1024).await,
            Self::Hosted {
                client,
                offset,
                queued,
                journal,
            } => loop {
                if let Some(row) = queued.pop_front() {
                    *offset = row["offset"].as_u64().ok_or("TASK_HOST_JOURNAL_INVALID")?;
                    return serde_json::to_vec(&row).map_err(|e| e.to_string());
                }
                let (status, exited) = crate::runtime_metrics::cost::scope(
                    crate::runtime_metrics::cost::Owner::AgentProcess,
                    crate::runtime_metrics::cost::Reason::Poll,
                    async {
                        crate::runtime_metrics::cost::scan_set(1);
                        crate::runtime_metrics::cost::rows(1);
                        (client.status().await, client.exit())
                    },
                )
                .await;
                if !client.alive() && exited.is_none() {
                    return Err(
                        "TASK_HOST_LOST: no exit record; reconcile the task before resuming".into(),
                    );
                }
                // Host heartbeats are independent of Core's current turn waiter.
                if let Err(error) = &status {
                    if exited.is_none() {
                        return Err(error.clone());
                    }
                }
                let next = status
                    .as_ref()
                    .ok()
                    .or(exited.as_ref())
                    .and_then(|s| s["nextOffset"].as_u64());
                if next.is_none_or(|next| next > *offset + 1) {
                    *queued = journal
                        .read(Path::new(string(&client.index, "journalPath")), *offset)?
                        .into();
                }
                if !queued.is_empty() {
                    continue;
                }
                if let Some(exit) = exited {
                    if let Some(error) = exit["error"].as_str() {
                        return Err(error.into());
                    }
                    return Ok(vec![]);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                crate::runtime_metrics::cost::wake(crate::runtime_metrics::cost::Reason::Timer);
            },
        }
    }
}

/// Core indexes a task-host; direct stdio is a degraded fallback.
pub struct Process {
    input: Mutex<Option<tokio::process::ChildStdin>>,
    child: Mutex<Option<tokio::process::Child>>,
    host: Option<Arc<crate::task_host::Client>>,
    replies: Replies,
    pub events: SharedEvents,
    pub state: Arc<Mutex<Value>>,
    pub pi: bool,
    pub antigravity: bool,
    pub alive: std::sync::atomic::AtomicBool,
    pub capabilities: Mutex<Value>,
    pub dispatch: Mutex<()>,
    reader: Mutex<Option<tokio::task::JoinHandle<()>>>,
    detach: Arc<tokio::sync::Notify>,
}
impl Process {
    pub async fn desktop_agentapi(
        binary: &Path,
        mut state: Value,
        wake: Arc<tokio::sync::Notify>,
    ) -> Result<Arc<Self>> {
        state["runtimeSource"] = json!("antigravity-agentapi");
        state["agentapiBinary"] = json!(binary);
        state["status"] = json!("idle");
        state["metadata"] = super::antigravity::facts(&state, "agentapi");
        let process = Arc::new(Self {
            input: Mutex::new(None),
            child: Mutex::new(None),
            host: None,
            replies: Default::default(),
            events: Arc::new(Mutex::new(Events {
                durable: true,
                ..Default::default()
            })),
            state: Arc::new(Mutex::new(state)),
            pi: false,
            antigravity: true,
            alive: true.into(),
            capabilities: Mutex::new(
                json!({"protocol":"antigravity-agentapi","resume":true,"cancel":false,"streaming":false,"completionEvent":null}),
            ),
            dispatch: Mutex::new(()),
            reader: Mutex::new(None),
            detach: Default::default(),
        });
        process.events.lock().await.wake = wake;
        super::save_task(&*process.state.lock().await)?;
        Ok(process)
    }

    pub async fn start(
        binary: &Path,
        args: &[String],
        cwd: &Path,
        pi: bool,
        antigravity: bool,
        mut state: Value,
        wake: Arc<tokio::sync::Notify>,
        launches: &crate::launches::Launches,
    ) -> Result<Arc<Self>> {
        launches.check()?;
        state["processSession"] = json!(id());
        super::save_task(&state)?;
        let mut cmd = launch_command(binary, args)?;
        if state["agent"] == "claude" {
            if let Some(profile) = state["agentProfileId"].as_str() {
                let config = crate::accounts::claude::session_config_dir(profile)?;
                cmd.env_clear()
                    .envs(crate::accounts::claude::isolated_environment(
                        std::env::vars_os().collect(),
                        Some(&config),
                    ));
            }
            cmd.env(
                "CLAUDE_CODE_EXECUTABLE",
                super::driver::discover("claude").ok_or("AGENT_NOT_INSTALLED")?,
            )
            .env_remove("NODE_OPTIONS")
            .env_remove("BUN_OPTIONS");
        }
        cmd.current_dir(cwd);
        if !cfg!(test) && !cfg!(feature = "test-fixture") {
            match crate::task_host::launch(&cmd, &state, launches).await {
                Ok(client) => {
                    state["taskHost"] = client.index.clone();
                    super::save_task(&state)?;
                    return Self::from_host(client, state, pi, antigravity, wake).await;
                }
                Err(error) => crate::logs::record(
                    "WARN",
                    &format!(
                        "Detached task-host unavailable; using a Core-owned Agent process: {error}"
                    ),
                    None,
                ),
            }
        }
        launches.check()?;
        state.as_object_mut().unwrap().remove("taskHost");
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn_owned()
            .map_err(|e| e.to_string())?;
        let input = child.stdin.take().ok_or("MISSING_STDIN")?;
        let stdout = child.stdout.take().ok_or("MISSING_STDOUT")?;
        Self::observe(
            Some(child),
            Some(input),
            None,
            Frames::Direct(BufReader::new(stdout)),
            state,
            pi,
            antigravity,
            wake,
        )
        .await
    }
    pub(crate) async fn reattach(
        state: Value,
        wake: Arc<tokio::sync::Notify>,
        launches: &crate::launches::Launches,
    ) -> Result<Arc<Self>> {
        let pi = state["agent"] == "pi";
        let antigravity = state["agent"] == "antigravity";
        let client = launches.run(|| {
            Ok(crate::task_host::Client::from_index(
                state["taskHost"].clone(),
            ))
        })?;
        Self::from_host(client, state, pi, antigravity, wake).await
    }
    async fn from_host(
        client: crate::task_host::Client,
        mut state: Value,
        pi: bool,
        antigravity: bool,
        wake: Arc<tokio::sync::Notify>,
    ) -> Result<Arc<Self>> {
        if !client.alive() && client.exit().is_none() {
            return Err("TASK_HOST_LOST: reconcile the task before resuming".into());
        }
        let status = client
            .status()
            .await
            .or_else(|error| client.exit().ok_or(error))?;
        state["taskHost"]["drainOnly"] =
            json!(client.index["hostProtocol"] != crate::task_host::PROTOCOL);
        let received = status["receivedSequence"].as_u64().unwrap_or(0);
        state["taskHost"]["receivedSequence"] = json!(received);
        let intent = &state["taskHost"]["unconfirmedWrite"];
        if intent["sequence"]
            .as_u64()
            .is_some_and(|seq| seq <= received)
        {
            state["dispatch"]["submission"] = json!("accepted");
        }
        let exited = !client.alive();
        state["processState"] = json!(if exited { "recovering" } else { "running" });
        let replay_until = status["nextOffset"].as_u64().unwrap_or(1).saturating_sub(1);
        let offset = state["taskHost"]["ackedOffset"].as_u64().unwrap_or(0);
        let client = Arc::new(client);
        let frames = Frames::Hosted {
            client: client.clone(),
            offset,
            queued: Default::default(),
            journal: Default::default(),
        };
        let process = Self::observe(
            None,
            None,
            Some(client),
            frames,
            state,
            pi,
            antigravity,
            wake,
        )
        .await?;
        // Publish the restored process only after its initial journal has rebuilt
        // pending interactions and any terminal result left by the old Core.
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let state = process.state.lock().await;
                let caught_up =
                    state["taskHost"]["ackedOffset"].as_u64().unwrap_or(0) >= replay_until;
                if (caught_up && (!exited || state["processState"] == "exited"))
                    || !process.alive.load(std::sync::atomic::Ordering::SeqCst)
                {
                    break;
                }
                drop(state);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .map_err(|_| {
            "TASK_HOST_REPLAY_TIMEOUT: retry reattachment before dispatching".to_owned()
        })?;
        Ok(process)
    }
    #[allow(clippy::too_many_arguments)]
    async fn observe(
        child: Option<tokio::process::Child>,
        input: Option<tokio::process::ChildStdin>,
        host: Option<Arc<crate::task_host::Client>>,
        mut frames: Frames,
        state: Value,
        pi: bool,
        antigravity: bool,
        wake: Arc<tokio::sync::Notify>,
    ) -> Result<Arc<Self>> {
        let mut tracking: crate::task_tracking::Timeline =
            serde_json::from_value(state["tracking"].clone()).unwrap_or_default();
        tracking.info = json!({"id":state["taskId"],"agent":state["agent"],"project":state["cwd"]});
        let capabilities = state["hostCapabilities"].clone();
        let process = Arc::new(Self {
            input: Mutex::new(input),
            host,
            child: Mutex::new(child),
            replies: Default::default(),
            events: Arc::new(Mutex::new(Events {
                timelines: HashMap::from([(string(&state, "taskId").to_owned(), tracking)]),
                durable: true,
                pending: state["pendingInteractions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|r| (r["id"].to_string(), r.clone()))
                    .collect(),
                ..Events::default()
            })),
            state: Arc::new(Mutex::new(state)),
            pi,
            antigravity,
            alive: true.into(),
            capabilities: Mutex::new(capabilities),
            dispatch: Mutex::new(()),
            reader: Mutex::new(None),
            detach: Default::default(),
        });
        process.events.lock().await.wake = wake;
        let weak = Arc::downgrade(&process);
        let detach = process.detach.clone();
        let reader_job = tokio::spawn(async move {
            let mut deadline = None;
            let mut read_error = None;
            loop {
                // Keep the same read future across timer ticks: line() consumes partial
                // frames and must not be cancelled by the persistence deadline.
                let read = crate::runtime_metrics::cost::scope(
                    crate::runtime_metrics::cost::Owner::AgentProcess,
                    crate::runtime_metrics::cost::Reason::Event,
                    frames.next(),
                );
                tokio::pin!(read);
                let frame = loop {
                    tokio::select! {
                        biased;
                        _ = detach.notified() => return,
                        _ = async {
                            match deadline {
                                Some(at) => tokio::time::sleep_until(at).await,
                                None => std::future::pending::<()>().await,
                            }
                        } => {
                            let Some(p) = weak.upgrade() else { return };
                            crate::runtime_metrics::cost::scope(crate::runtime_metrics::cost::Owner::AgentProcess, crate::runtime_metrics::cost::Reason::Deadline, p.persist(&mut *p.state.lock().await)).await;
                            deadline = None;
                        }
                        result = &mut read => break result,
                    }
                };
                let frame = match frame {
                    Ok(b) if !b.is_empty() => b,
                    Ok(_) => break,
                    Err(error) => {
                        read_error = Some(stdout_read_error(&error));
                        break;
                    }
                };
                let Some(p) = weak.upgrade() else { break };
                let mut offset = None;
                let frame = if p.host.is_some() {
                    let row: Value = match serde_json::from_slice(&frame) {
                        Ok(row) => row,
                        Err(_) => {
                            read_error = Some("TASK_HOST_JOURNAL_INVALID".into());
                            break;
                        }
                    };
                    offset = row["offset"].as_u64();
                    if row["kind"] == "write" {
                        p.replayed_write(&row["frame"], offset).await;
                        continue;
                    }
                    string(&row, "frame").as_bytes().to_vec()
                } else {
                    frame
                };
                let mut msg: Value = match serde_json::from_slice(&frame) {
                    Ok(v) => v,
                    Err(_) => {
                        let mut state = p.state.lock().await;
                        if let Some(offset) = offset {
                            state["taskHost"]["ackedOffset"] = json!(offset);
                        }
                        state["stdoutDiagnostics"] =
                            stdout_diagnostics(&state["stdoutDiagnostics"], &frame);
                        state["updatedAt"] = json!(now());
                        deadline
                            .get_or_insert(tokio::time::Instant::now() + Duration::from_secs(1));
                        continue;
                    }
                };
                let response = if antigravity {
                    false
                } else if pi {
                    msg["type"] == "response"
                } else {
                    msg.get("method").is_none() && msg.get("id").is_some()
                };
                if response {
                    p.replayed_response(&msg, offset).await;
                    if let Some(tx) = p.replies.lock().await.remove(&msg["id"].to_string()) {
                        let result = if msg.get("error").is_some() || (pi && msg["success"] != true)
                        {
                            Err(format!("RPC_REJECTED:{}", msg))
                        } else {
                            Ok(msg[if pi { "data" } else { "result" }].clone())
                        };
                        let _ = tx.send(result);
                    }
                    continue;
                }
                let method = if pi {
                    string(&msg, "type")
                } else if antigravity {
                    string(&msg, "event")
                } else {
                    string(&msg, "method")
                }
                .to_owned();
                let method = method.as_str();
                if !pi
                    && !antigravity
                    && msg.get("id").is_some()
                    && method != "session/request_permission"
                {
                    let _ = p.write(json!({"jsonrpc":"2.0","id":msg["id"],"error":{"code":-32601,"message":"Client capability not supported"}})).await;
                    continue;
                }
                let mut state = p.state.lock().await;
                if let Some(offset) = offset {
                    state["taskHost"]["ackedOffset"] = json!(offset);
                }
                let terminal = matches!(
                    lifecycle::read(&state).state(),
                    crate::turn_lifecycle::TurnState::Terminal(_)
                        | crate::turn_lifecycle::TurnState::Conflict(_)
                );
                let task = string(&state, "taskId").to_owned();
                if antigravity {
                    p.antigravity_event(&mut state, &msg).await;
                    state["updatedAt"] = json!(now());
                    if method == "step_update" && msg["step_update"]["state"] == "ACTIVE" {
                        p.snapshot_tracking(&mut state).await;
                        deadline
                            .get_or_insert(tokio::time::Instant::now() + Duration::from_secs(1));
                    } else {
                        p.persist(&mut state).await;
                        deadline = None;
                    }
                    continue;
                }
                let old_configuration = (method == "session/update"
                    && matches!(
                        string(&msg["params"]["update"], "sessionUpdate"),
                        "config_option_update" | "current_mode_update"
                    ))
                .then(|| configuration(&state));
                if method == "session/request_permission" {
                    if let Some(timeline) = p.events.lock().await.timelines.get(&task) {
                        timeline.enrich_permission(&mut msg);
                    }
                }
                crate::event(&p.events, &task, method, msg.clone()).await;
                if method == "session/update" {
                    let update = &msg["params"]["update"];
                    if update["sessionUpdate"] == "usage_update" {
                        state["contextUsage"] = json!({"kind":"context-occupancy","source":"acp-usage-update","used":update["used"],"size":update["size"],"observedAt":now()});
                    } else if update["sessionUpdate"] == "config_option_update" {
                        state["metadata"]["configOptions"] = update["configOptions"].clone();
                        state["configurationObservedAt"] = json!(now());
                    } else if update["sessionUpdate"] == "current_mode_update" {
                        state["metadata"]["modes"]["currentModeId"] =
                            update["currentModeId"].clone();
                        state["configurationObservedAt"] = json!(now());
                    }
                }
                if !terminal
                    && (method == "session/request_permission"
                        || (method == "extension_ui_request"
                            && matches!(
                                string(&msg, "method"),
                                "select" | "confirm" | "input" | "editor"
                            )))
                {
                    let mut msg = msg.clone();
                    msg["turnId"] = state["turnId"].clone();
                    if let Err(error) = crate::claude_notify::routing::observe(
                        string(&state, "agent"),
                        string(&state, "taskId"),
                        &mut msg,
                    ) {
                        crate::logs::record("WARN", &error, None);
                    }
                    p.events
                        .lock()
                        .await
                        .pending
                        .insert(msg["id"].to_string(), msg.clone());
                    lifecycle::owner(&mut state, "waiting-permission");
                    let mut observation = lifecycle::observation(&state);
                    observation["interaction"] = json!([msg]);
                    if let Err(error) = crate::claude_notify::observe(
                        string(&state, "taskId"),
                        string(&state, "turnId"),
                        &observation,
                    )
                    .await
                    {
                        crate::logs::record("WARN", &error, None);
                    }
                }
                // Delivery output deliberately retains native, unredacted text.
                // Timeline is a bounded/redacted display projection and cannot
                // replace this finalResponse/archive-continuation buffer.
                if pi {
                    if method == "message_end" && msg["message"]["role"] == "assistant" {
                        state["lastMessage"] = msg["message"].clone();
                        state["output"] = json!(msg["message"]["content"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|c| c["type"] == "text")
                            .map(|c| string(c, "text"))
                            .collect::<Vec<_>>()
                            .join(""));
                    }
                    if method == "agent_settled" {
                        let evidence = turn_adapter::pi_settled(
                            lifecycle::key(&state),
                            string(&state["lastMessage"], "stopReason"),
                        );
                        lifecycle::apply(&mut state, evidence);
                    }
                } else if method == "session/update" {
                    let update = &msg["params"]["update"];
                    if update["sessionUpdate"] == "agent_message_chunk"
                        && update["content"]["type"] == "text"
                    {
                        let mut text = string(&state, "output").to_owned();
                        text.push_str(string(&update["content"], "text"));
                        // Complete protocol events remain available through control_output.
                        if text.len() > 256 * 1024 {
                            let mut start = text.len() - 256 * 1024;
                            while !text.is_char_boundary(start) {
                                start += 1;
                            }
                            text = text[start..].to_owned();
                            state["outputTruncated"] = json!(true);
                        }
                        state["output"] = json!(text);
                    }
                }
                if method == "agent_settled" {
                    state["dispatch"]["submission"] = json!("accepted");
                    if let Err(error) =
                        crate::dispatch_policy::agent_observe(&state, Some("accepted"))
                    {
                        state["storageError"] = json!(error);
                    }
                    if let Err(error) = crate::claude_notify::observe(
                        string(&state, "taskId"),
                        string(&state, "turnId"),
                        &lifecycle::observation(&state),
                    )
                    .await
                    {
                        crate::logs::record("WARN", &error, None);
                    }
                }
                if old_configuration.is_some_and(|old| configuration(&state) != old) {
                    if let Err(error) = super::remember_task_configuration(&state) {
                        state["storageError"] = json!(error);
                    }
                }
                state["updatedAt"] = json!(now());
                if streaming_delta(pi, &msg) {
                    p.snapshot_tracking(&mut state).await;
                    deadline.get_or_insert(tokio::time::Instant::now() + Duration::from_secs(1));
                } else {
                    p.persist(&mut state).await;
                    deadline = None;
                }
            }
            if let Some(p) = weak.upgrade() {
                p.alive.store(false, std::sync::atomic::Ordering::SeqCst);
                let exit_status = p
                    .child
                    .lock()
                    .await
                    .as_mut()
                    .and_then(|child| child.try_wait().ok().flatten());
                let host_exit = p.host.as_ref().and_then(|host| host.exit());
                let mut s = p.state.lock().await;
                if let Some(exit) = &host_exit {
                    s["exitCode"] = exit["exitCode"].clone();
                }
                let abnormal = !lifecycle::terminal(&s)
                    || exit_status.as_ref().is_some_and(|status| !status.success());
                let error = read_error.or_else(|| abnormal.then(|| {
                    "PROCESS_EXIT_UNCONFIRMED: Agent stdout closed before a confirmed successful exit. Inspect stdoutDiagnostics and the Agent logs before resuming.".into()
                }));
                let error = error.map(|error| exit_error(&error, &s["stdoutDiagnostics"]));
                if let Some(error) = &error {
                    s["error"] = json!(error);
                    crate::event(
                        &p.events,
                        string(&s, "taskId"),
                        "error",
                        json!({"error":error}),
                    )
                    .await;
                }
                for (_, tx) in p.replies.lock().await.drain() {
                    let _ = tx.send(Err(error
                        .clone()
                        .unwrap_or_else(|| "PROCESS_EXIT_UNCONFIRMED".into())));
                }
                lifecycle::loss(&mut s);
                s["processState"] = json!("exited");
                if let Some(status) = exit_status {
                    s["exitCode"] = json!(status.code());
                }
                {
                    let mut events = p.events.lock().await;
                    if let Some(t) = events.timelines.get_mut(string(&s, "taskId")) {
                        t.finish(string(&s, "status"), &now());
                    }
                }
                {
                    let mut events = p.events.lock().await;
                    if host_exit.is_some() || p.host.is_none() {
                        events.pending.clear();
                    }
                    events.wake.notify_waiters();
                }
                p.persist(&mut s).await;
                p.recover_receipt(&s);
            }
        });
        *process.reader.lock().await = Some(reader_job);
        Ok(process)
    }
    async fn persist(&self, state: &mut Value) {
        state["hostCapabilities"] = self.capabilities.lock().await.clone();
        self.snapshot_tracking(state).await;
        if let Err(error) = super::save_task(state) {
            state["storageError"] = json!(error);
        }
    }
    pub async fn remember_configuration(&self) {
        let mut state = self.state.lock().await;
        self.persist(&mut state).await;
        if let Err(error) = super::remember_task_configuration(&state) {
            state["storageError"] = json!(error);
        }
    }
    pub async fn snapshot_tracking(&self, state: &mut Value) {
        let mut events = self.events.lock().await;
        state["pendingInteractions"] = json!(events.pending.values().collect::<Vec<_>>());
        if let Some(timeline) = events.timelines.get_mut(string(state, "taskId")) {
            if !timeline.turn.is_empty() {
                if let Some(summary) = super::activity::agent_summary(state) {
                    timeline
                        .turn_dispatch_summaries
                        .insert(timeline.turn.clone(), summary);
                }
            }
            state["tracking"] = serde_json::to_value(timeline).unwrap_or(Value::Null);
        }
    }
    pub async fn check_alive(&self) -> Result<()> {
        let stopped = if let Some(host) = &self.host {
            !host.alive()
        } else {
            self.child
                .lock()
                .await
                .as_mut()
                .map(|child| child.try_wait())
                .transpose()
                .map_err(|e| e.to_string())?
                .flatten()
                .is_some()
        };
        if !self.alive.load(std::sync::atomic::Ordering::SeqCst) || stopped {
            return Err("process-exit-unconfirmed".into());
        }
        Ok(())
    }
    pub async fn write(&self, value: Value) -> Result<()> {
        if let Some(host) = &self.host {
            return host.write(value, &self.state).await;
        }
        let mut input = self.input.lock().await;
        let input = input.as_mut().ok_or("PROCESS_NOT_RUNNING")?;
        input
            .write_all(format!("{value}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        input.flush().await.map_err(|e| e.to_string())
    }
    async fn replayed_write(&self, frame: &Value, offset: Option<u64>) {
        let value = &frame["value"];
        let mut state = self.state.lock().await;
        if let Some(offset) = offset {
            state["taskHost"]["ackedOffset"] = json!(offset);
        }
        state["taskHost"]["receivedSequence"] = json!(state["taskHost"]["receivedSequence"]
            .as_u64()
            .unwrap_or(0)
            .max(frame["sequence"].as_u64().unwrap_or(0)));
        if frame["sequence"] == state["taskHost"]["unconfirmedWrite"]["sequence"] {
            state["taskHost"]["unconfirmedWrite"] = Value::Null;
        }
        if value["method"] == "session/prompt" || value["type"] == "prompt" {
            state["taskHost"]["promptId"] = value["id"].clone();
            state["dispatch"]["submission"] = json!("accepted");
            state["taskHost"]["promptSequence"] = frame["sequence"].clone();
            state["taskHost"]["promptResponded"] = json!(false);
        }
        if value.get("id").is_some()
            && (value.get("result").is_some()
                || value.get("error").is_some()
                || value["type"] == "extension_ui_response")
        {
            let mut events = self.events.lock().await;
            events.pending.remove(&value["id"].to_string());
            if events.pending.is_empty() && state["status"] == "waiting-permission" {
                lifecycle::owner(&mut state, "running");
            }
        }
        self.persist(&mut state).await;
        self.recover_receipt(&state);
    }
    fn recover_receipt(&self, state: &Value) {
        let Some(request) = state["taskHost"]["requestId"].as_str() else {
            return;
        };
        let Ok(path) = super::RECEIPTS.path(request) else {
            return;
        };
        let Ok(mut receipt) = load(&path) else {
            return;
        };
        let progress = Progress::read(string(&receipt, "state"), true);
        if !progress.active() && !progress.is(ReceiptState::Unconfirmed) {
            return;
        }
        let received = state["taskHost"]["receivedSequence"].as_u64().unwrap_or(0);
        let Some(prompt) = state["taskHost"]["promptSequence"].as_u64() else {
            return;
        };
        if prompt > received {
            return;
        }
        if (self.pi && state["taskHost"]["promptResponded"] == true) || lifecycle::terminal(state) {
            progress::apply(&mut receipt, ProgressEvent::Complete);
            receipt["result"] = state.clone();
            receipt["error"] = Value::Null;
            if let Err(error) = super::RECEIPTS.checkpoint(&mut receipt) {
                crate::logs::record("WARN", &error, None);
            }
        }
    }
    async fn replayed_response(&self, msg: &Value, offset: Option<u64>) {
        if self.host.is_none() {
            return;
        }
        let mut state = self.state.lock().await;
        if let Some(offset) = offset {
            state["taskHost"]["ackedOffset"] = json!(offset);
        }
        if msg["id"] == state["taskHost"]["promptId"] && !msg["id"].is_null() {
            state["taskHost"]["promptResponded"] = json!(true);
            let failed = msg.get("error").is_some() || (self.pi && msg["success"] != true);
            if !self.pi || failed {
                if self.pi {
                    if let Some(evidence) =
                        turn_adapter::pi_prompt_response(lifecycle::key(&state), msg)
                    {
                        lifecycle::apply(&mut state, evidence);
                    }
                } else if let Some(evidence) =
                    turn_adapter::acp_response(lifecycle::key(&state), msg)
                {
                    lifecycle::apply(&mut state, evidence);
                }
                state["stopReason"] = msg["result"]["stopReason"].clone();
                state["error"] = msg["error"].clone();
                state["dispatch"]["submission"] =
                    json!(if failed { "rejected" } else { "accepted" });
                crate::event(
                    &self.events,
                    string(&state, "taskId"),
                    "arc/settled",
                    json!({"status":state["status"],"error":state["error"]}),
                )
                .await;
            }
        }
        self.persist(&mut state).await;
        self.recover_receipt(&state);
    }
    pub fn drain_only(&self) -> bool {
        self.host
            .as_ref()
            .is_some_and(|host| host.index["hostProtocol"] != crate::task_host::PROTOCOL)
    }
    pub fn hosted(&self) -> bool {
        self.host.is_some()
    }
    pub async fn release(&self) {
        let state = self.state.lock().await.clone();
        let busy = !lifecycle::ready(&state) || !self.events.lock().await.pending.is_empty();
        let uncertain = !self.alive.load(std::sync::atomic::Ordering::SeqCst)
            && self.host.as_ref().is_some_and(|host| host.alive());
        if self.host.is_some() && (busy || uncertain) {
            if let Some(reader) = self.reader.lock().await.take() {
                self.detach.notify_one();
                let _ = reader.await;
            }
            self.persist(&mut *self.state.lock().await).await;
        } else {
            self.close().await;
        }
    }
    pub async fn call(&self, method: &str, params: Value, timeout: u64) -> Result<Value> {
        if !self.alive.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("PROCESS_NOT_RUNNING".into());
        }
        let key = json!(id());
        let (tx, rx) = oneshot::channel();
        self.replies.lock().await.insert(key.to_string(), tx);
        let _cleanup = ReplyGuard(self.replies.clone(), key.to_string());
        let request = if self.pi {
            let mut p = params;
            p["id"] = key.clone();
            p["type"] = json!(method);
            p
        } else {
            json!({"jsonrpc":"2.0","id":key,"method":method,"params":params})
        };
        if let Err(e) = self.write(request).await {
            self.replies.lock().await.remove(&key.to_string());
            return Err(crate::rpc::submission_error(method, e));
        }
        if matches!(method, "prompt" | "session/prompt") {
            let task = self.state.lock().await.clone();
            if crate::dispatch_policy::agent_submitted(&task).is_err() {
                crate::coordination::observers::gap("dispatch", "persistence-failed");
            }
        }
        let result = tokio::time::timeout(Duration::from_millis(timeout), rx).await;
        self.replies.lock().await.remove(&key.to_string());
        result
            .map_err(|_| format!("RPC_TIMEOUT:{method}"))
            .and_then(|v| v.map_err(|_| "PROCESS_EXIT".to_owned()))
            .and_then(|v| v)
            .map_err(|e| crate::rpc::submission_error(method, e))
    }
    pub async fn antigravity_turn(&self, text: &str) -> Result<Value> {
        let task = self.state.lock().await.clone();
        if task["runtimeSource"] == "antigravity-agentapi" {
            let binary = PathBuf::from(string(&task, "agentapiBinary"));
            let result = if let Some(id) = task["sessionId"].as_str() {
                super::antigravity::send_message(&binary, id, text, false).await?
            } else {
                let mut args = vec!["new-conversation".into()];
                if let Some(model) = task["configured"]["model"].as_str() {
                    args.push(format!("--model={model}"));
                }
                if let Some(title) = task["title"].as_str() {
                    args.push(format!("--title={title}"));
                }
                args.push(text.into());
                super::antigravity::agentapi_call(&binary, &args).await?
            };
            let session = task["sessionId"]
                .as_str()
                .or_else(|| result["response"]["newConversation"]["conversationId"].as_str())
                .ok_or("ANTIGRAVITY_CONVERSATION_ID_MISSING")?;
            uuid::Uuid::parse_str(session).map_err(|_| "INVALID_ANTIGRAVITY_SESSION")?;
            let mut state = self.state.lock().await;
            state["sessionId"] = json!(session);
            // agentapi confirms submission, without a streaming turn-completion event.
            state["status"] = json!("idle");
            state["metadata"]["submission"] = json!("accepted");
            state["metadata"]["completionObserved"] = json!(false);
            crate::dispatch_policy::agent_submitted(&state)?;
            super::save_task(&state)?;
            return Ok(result);
        }
        if !self.alive.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("PROCESS_NOT_RUNNING".into());
        }
        let key = "antigravity-turn".to_owned();
        let (tx, rx) = oneshot::channel();
        if self.replies.lock().await.insert(key.clone(), tx).is_some() {
            return Err("TASK_BUSY_OR_UNCONFIRMED".into());
        }
        let _cleanup = ReplyGuard(self.replies.clone(), key.clone());
        let request = json!({"event":"user","message":{"content":text}});
        if let Err(error) = self.write(request).await {
            self.replies.lock().await.remove(&key);
            return Err(crate::rpc::submission_error("antigravity/turn", error));
        }
        let task = self.state.lock().await.clone();
        if crate::dispatch_policy::agent_submitted(&task).is_err() {
            crate::coordination::observers::gap("dispatch", "persistence-failed");
        }
        rx.await
            .map_err(|_| "PROCESS_EXIT".to_owned())?
            .map_err(|error| crate::rpc::submission_error("antigravity/turn", error))
    }
    async fn antigravity_event(&self, state: &mut Value, msg: &Value) {
        let event = string(msg, "event");
        let task = string(state, "taskId").to_owned();
        crate::event(&self.events, &task, event, msg.clone()).await;
        if event == "init" {
            if state["sessionId"].is_null() {
                state["sessionId"] = msg["conversation_id"].clone();
            }
            state["metadata"]["nativeInit"] = msg["init"].clone();
            return;
        }
        if event == "step_update" {
            let update = &msg["step_update"];
            if update["step_type"] == "agent_response" {
                if let Some(delta) = update["text_delta"].as_str() {
                    let mut output = string(state, "output").to_owned();
                    output.push_str(delta);
                    state["output"] = json!(bounded_output(output, state));
                }
            }
            if update["state"] == "ERROR" {
                let errors = state["toolErrors"].as_array_mut();
                if let Some(errors) = errors {
                    errors.push(update.clone());
                } else {
                    state["toolErrors"] = json!([update]);
                }
            }
            return;
        }
        if event != "result" {
            return;
        }
        let result = &msg["result"];
        if state["sessionId"].is_null() {
            state["sessionId"] = result["conversation_id"].clone();
        }
        if let Some(response) = result["response"].as_str() {
            state["output"] = json!(bounded_output(response.to_owned(), state));
        }
        state["deniedActions"] = result["denied_actions"].clone();
        state["stopReason"] = result["finished_reason"].clone();
        state["error"] = result["error"].clone();
        lifecycle::apply(
            state,
            turn_adapter::antigravity_result(lifecycle::key(state), result),
        );
        state["turnEvidence"] = json!({
            "source":"antigravity-result","scope":"turn","observedAt":now(),
            "status":result["status"],"deniedActions":result["denied_actions"]
        });
        crate::event(
            &self.events,
            &task,
            "arc/settled",
            json!({"status":state["status"],"error":state["error"],"deniedActions":state["deniedActions"]}),
        )
        .await;
        if let Some(tx) = self.replies.lock().await.remove("antigravity-turn") {
            let _ = tx.send(Ok(result.clone()));
        }
    }
    pub async fn interrupt(&self) -> Result<()> {
        if let Some(host) = &self.host {
            return host.signal(false).await;
        }
        let child = self.child.lock().await;
        let pid = child
            .as_ref()
            .and_then(|child| child.id())
            .ok_or("PROCESS_NOT_RUNNING")?;
        #[cfg(unix)]
        let result = unsafe { libc::kill(-(pid as i32), libc::SIGINT) };
        #[cfg(unix)]
        if result != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        #[cfg(windows)]
        drop(child);
        #[cfg(windows)]
        self.child
            .lock()
            .await
            .as_mut()
            .ok_or("PROCESS_NOT_RUNNING")?
            .start_kill()
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    pub async fn close(&self) {
        if self.state.lock().await["runtimeSource"] == "antigravity-agentapi" {
            self.alive.store(false, std::sync::atomic::Ordering::SeqCst);
            return;
        }
        if let Some(host) = &self.host {
            let _ = host.close().await;
            if let Some(mut reader) = self.reader.lock().await.take() {
                if tokio::time::timeout(Duration::from_secs(8), &mut reader)
                    .await
                    .is_err()
                {
                    reader.abort();
                    let _ = reader.await;
                }
            }
            self.persist(&mut *self.state.lock().await).await;
            self.alive.store(false, std::sync::atomic::Ordering::SeqCst);
            return;
        }
        if let Some(mut input) = self.input.lock().await.take() {
            let _ = input.shutdown().await;
            // ChildStdin::shutdown alone does not close the pipe. Drop its writer
            // so cooperative Agents can emit their final stdout before exiting.
        }
        let mut owned_child = self.child.lock().await;
        let Some(child) = owned_child.as_mut() else {
            return;
        };
        let pid = child.id();
        if tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
        #[cfg(unix)]
        if let Some(pid) = pid {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        if let Some(pid) = pid {
            let _ = output("taskkill.exe", &["/PID", &pid.to_string(), "/T", "/F"]).await;
        }
        // The reader owns the final snapshot, including buffered stdout. Release
        // the child lock before joining it so exit-code collection cannot deadlock.
        drop(owned_child);
        if let Some(reader) = self.reader.lock().await.take() {
            let _ = reader.await;
        }
        self.persist(&mut *self.state.lock().await).await;
        self.alive.store(false, std::sync::atomic::Ordering::SeqCst);
        self.events.lock().await.wake.notify_waiters();
    }
}

// npm installs Pi as a .cmd launcher on Windows. Never interpolate prompts into a shell.
fn agent_command(binary: &Path, args: &[String]) -> Result<tokio::process::Command> {
    #[cfg(windows)]
    if binary
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
    {
        let words = std::iter::once(binary.to_string_lossy().into_owned())
            .chain(args.iter().cloned())
            .collect::<Vec<_>>();
        if words.iter().any(|s| {
            s.chars().any(|c| {
                matches!(
                    c,
                    '"' | '%' | '!' | '\r' | '\n' | '&' | '|' | '<' | '>' | '^'
                )
            })
        }) {
            return Err("UNSAFE_WINDOWS_LAUNCH_ARGUMENT".into());
        }
        let line = words
            .iter()
            .map(|s| format!("\"{s}\""))
            .collect::<Vec<_>>()
            .join(" ");
        let mut c = command(std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into()));
        c.args(["/d", "/s", "/c", &format!("\"{line}\"")]);
        return Ok(c);
    }
    let mut c = command(binary);
    c.args(args);
    Ok(c)
}

pub(crate) fn launch_command(binary: &Path, args: &[String]) -> Result<tokio::process::Command> {
    let mut c = agent_command(binary, args)?;
    let mut paths = super::driver::search_paths();
    if let Some(parent) = binary.parent() {
        paths.push(parent.into());
    }
    c.env(
        "PATH",
        std::env::join_paths(paths).map_err(|e| e.to_string())?,
    );
    Ok(c)
}
pub(super) async fn probe(binary: &Path, args: &[String]) -> Result<String> {
    let mut command = launch_command(binary, args)?;
    command
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(std::time::Duration::from_secs(8), command.output())
        .await
        .map_err(|_| "AGENT_PROBE_TIMEOUT")?
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("AGENT_PROBE_FAILED".into());
    }
    let text = String::from_utf8_lossy(if out.stdout.is_empty() {
        &out.stderr
    } else {
        &out.stdout
    })
    .trim()
    .to_owned();
    if text.is_empty() {
        return Err("AGENT_PROBE_EMPTY".into());
    }
    Ok(text)
}

#[cfg(test)]
mod stream_stability_tests {
    use super::*;

    #[test]
    fn diagnostics_are_bounded_redacted_and_attached_to_failures() {
        // Regression: non-JSON stdout either killed the reader or disappeared without diagnostic evidence.
        let mut diagnostics = Value::Null;
        for _ in 0..100 {
            diagnostics = stdout_diagnostics(
                &diagnostics,
                "credential password=fixture-secret \u{754c}\n"
                    .repeat(100)
                    .as_bytes(),
            );
        }
        assert_eq!(diagnostics["skippedLines"], 100);
        assert_eq!(diagnostics["truncated"], true);
        assert!(diagnostics.to_string().len() <= 4096);
        assert!(!diagnostics.to_string().contains("fixture-secret"));
        let error = exit_error("PROCESS_EXIT_UNCONFIRMED", &diagnostics);
        assert!(error.contains("credential"));
        assert!(!error.contains("fixture-secret"));
        assert!(stdout_read_error("broken pipe password=fixture-secret")
            .starts_with("AGENT_STDOUT_READ_FAILED:"));
        assert!(
            !stdout_read_error("broken pipe password=fixture-secret").contains("fixture-secret")
        );
    }

    #[test]
    fn only_content_deltas_defer_persistence() {
        // Regression: every ACP and Pi delta rewrote the full task snapshot and catalog.
        for update in ["agent_message_chunk", "agent_thought_chunk"] {
            assert!(streaming_delta(
                false,
                &json!({"method":"session/update","params":{"update":{"sessionUpdate":update}}})
            ));
        }
        for update in ["text_delta", "thinking_delta", "toolcall_delta"] {
            assert!(streaming_delta(
                true,
                &json!({"type":"message_update","assistantMessageEvent":{"type":update}})
            ));
        }
        for update in [
            "tool_call",
            "tool_call_update",
            "plan",
            "usage_update",
            "config_option_update",
            "current_mode_update",
        ] {
            assert!(!streaming_delta(
                false,
                &json!({"method":"session/update","params":{"update":{"sessionUpdate":update}}})
            ));
        }
        for method in [
            "session/request_permission",
            "arc/user",
            "arc/settled",
            "arc/interaction-resolved",
            "error",
        ] {
            assert!(!streaming_delta(false, &json!({"method":method})));
        }
        for event in [
            "agent_start",
            "agent_settled",
            "message_end",
            "tool_execution_start",
            "tool_execution_end",
            "extension_ui_request",
            "error",
        ] {
            assert!(!streaming_delta(true, &json!({"type":event})));
        }
        let state = json!({"metadata":{"configOptions":[{"id":"model","currentValue":"a"}]}});
        let mut updated = state.clone();
        updated["output"] = json!("delta");
        updated["configurationObservedAt"] = json!("later");
        assert_eq!(configuration(&state), configuration(&updated));
        updated["metadata"]["configOptions"][0]["currentValue"] = json!("b");
        assert_ne!(configuration(&state), configuration(&updated));
    }

    // Each subprocess has its own state root. Assertions use the task-query
    // boundary, including a second host with no live process to read checkpoints.
    #[cfg(unix)]
    fn isolated(name: &str) -> bool {
        if std::env::var("ARC_STREAM_TEST_CHILD").as_deref() == Ok(name) {
            return true;
        }
        let directory = std::env::temp_dir().join(format!("arc-stream-test-{}", id()));
        std::fs::create_dir_all(&directory).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &format!("agents::process::stream_stability_tests::{name}"),
                "--nocapture",
            ])
            .env("ARC_STREAM_TEST_CHILD", name)
            .env("ARC_STATE_DIR", &directory)
            .status()
            .unwrap();
        std::fs::remove_dir_all(directory).unwrap();
        assert!(status.success());
        false
    }

    #[cfg(unix)]
    async fn fixture(
        script: &str,
    ) -> (
        Arc<super::super::AgentHost>,
        Arc<super::super::AgentHost>,
        Arc<Process>,
        String,
    ) {
        let live = super::super::AgentHost::new().unwrap();
        let disk = super::super::AgentHost::new().unwrap();
        let task = id();
        let mut tracking = crate::task_tracking::Timeline::default();
        tracking.agent(
            "arc/user",
            &json!({"turnId":"fixture-turn","text":"fixture"}),
            &now(),
        );
        let state = json!({"taskId":task,"agent":"dsh","status":"running","turnId":"fixture-turn","output":"","metadata":{},"tracking":tracking});
        super::super::save_task(&state).unwrap();
        let process = Process::start(
            Path::new("/bin/sh"),
            &["-c".into(), script.into()],
            &std::env::temp_dir(),
            false,
            false,
            state,
            live.wake.clone(),
            &live.launches,
        )
        .await
        .unwrap();
        live.processes
            .lock()
            .await
            .insert(task.clone(), process.clone());
        (live, disk, process, task)
    }

    #[cfg(unix)]
    async fn observed(
        host: &super::super::AgentHost,
        task: &str,
        predicate: impl Fn(&Value) -> bool,
    ) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let state = host.context_task("dsh", task).await.unwrap();
                if predicate(&state) {
                    return state;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("task observation timed out")
    }

    #[cfg(unix)]
    #[test]
    fn detached_journal_rebuilds_pending_and_settles_without_original_waiter() {
        // Regression: Core restart lost ACP prompt waiters, pending approvals and their final result.
        if !isolated("detached_journal_rebuilds_pending_and_settles_without_original_waiter") {
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let host = super::super::AgentHost::new().unwrap();
            let task = id();
            crate::kernel::origin::ORIGIN.scope(json!({"sourceId":"claude"}), crate::claude_notify::bind(
                &json!({"agent":"dsh","notify":{"channel":"claude-session","target":"session_010000000000000000000001"}}),
                &task, "turn", "/project", json!({"op":"agent_send"}))).await.unwrap();
            let directory = std::env::temp_dir().join(format!("arc-journal-replay-{}", id()));
            std::fs::create_dir_all(&directory).unwrap();
            let journal = directory.join("journal.jsonl");
            let request = json!({"id":"approval","method":"session/request_permission","params":{"options":[{"optionId":"allow","kind":"allow_once","name":"Allow"}]}});
            let rows = [json!({"offset":1,"kind":"stdout","frame":format!("{request}\n")})];
            std::fs::write(&journal, format!("{}\n",rows[0])).unwrap();
            let state = json!({"taskId":task,"agent":"dsh","status":"running","turnId":"turn","output":"","metadata":{},
                "taskHost":{"hostPid":std::process::id(),"hostStart":crate::codex_host::process_start(std::process::id()),"hostProtocol":2,
                    "socket":"unused","journalPath":journal,"ackedOffset":0,"promptId":"prompt"}});
            let process = Process::reattach(state,host.wake.clone(), &host.launches).await.unwrap();
            host.processes.lock().await.insert(task.clone(),process.clone());
            let state = observed(&host,&task,|s|s["status"]=="waiting-permission").await;
            assert_eq!(state["pendingInteractions"][0]["id"],"approval");
            assert!(process.write(json!({"method":"session/prompt"})).await.unwrap_err().starts_with("TASK_HOST_DRAIN_ONLY:"));
            process.release().await;
            // Resume from an acknowledged snapshot after the host has exited.
            let mut state = host.context_task("dsh", &task).await.unwrap();
            state["taskHost"]["hostPid"] = json!(0);
            state["taskHost"]["hostStart"] = json!("exited");
            state["taskHost"]["hostProtocol"] = json!(1);
            let next = [
                json!({"offset":2,"kind":"write","frame":{"sequence":1,"value":{"id":"approval","result":{"outcome":{"outcome":"selected","optionId":"allow"}}}}}),
                json!({"offset":3,"kind":"stdout","frame":format!("{}\n",json!({"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"finished"}}}}))}),
                json!({"offset":4,"kind":"stdout","frame":format!("{}\n",json!({"id":"prompt","result":{"stopReason":"end_turn"}}))}),
            ];
            use std::io::Write;
            let mut file=std::fs::OpenOptions::new().append(true).open(&journal).unwrap();
            for row in next { writeln!(file,"{row}").unwrap(); }
            save(&directory.join("exit.json"),&json!({"exitCode":0,"receivedSequence":1,"nextOffset":5,"error":null})).unwrap();
            let recovered = Process::reattach(state,host.wake.clone(), &host.launches).await.unwrap();
            host.processes.lock().await.insert(task.clone(),recovered.clone());
            let state=observed(&host,&task,|s|s["processState"]=="exited" && s["taskHost"]["ackedOffset"]==4).await;
            assert_eq!(state["status"],"completed");
            assert_eq!(state["output"],"finished");
            assert_eq!(state["pendingInteractions"],json!([]));
            assert_eq!(state["exitCode"],0);
            let observed = host.observe_notification("dsh", &task, "turn").await.unwrap();
            assert_eq!(observed["state"], "completed");
            assert_eq!(observed["finalResponse"], "finished");
            crate::claude_notify::observe(&task, "turn", &observed).await.unwrap();
            crate::claude_notify::tests::deliver_fixture_events(&task, "turn").await;
            let sent = crate::claude_notify::read(&task, "turn").unwrap();
            let completed: Vec<_> = sent["deliveries"].as_array().unwrap().iter().filter(|delivery| delivery["kind"] == "completed").collect();
            assert_eq!(completed.len(), 1);
            assert_eq!(completed[0]["state"], "delivered");
            let event_id = completed[0]["eventId"].clone();
            crate::claude_notify::observe(&task, "turn", &observed).await.unwrap();
            crate::claude_notify::tests::deliver_fixture_events(&task, "turn").await;
            let repeated = crate::claude_notify::read(&task, "turn").unwrap();
            let completed: Vec<_> = repeated["deliveries"].as_array().unwrap().iter().filter(|delivery| delivery["kind"] == "completed").collect();
            assert_eq!(completed.len(), 1);
            assert_eq!(completed[0]["eventId"], event_id);
            assert_eq!(completed[0]["state"], "delivered");
            recovered.release().await;
            std::fs::remove_dir_all(directory).unwrap();
        });
    }

    #[cfg(unix)]
    #[test]
    fn pi_interrupt_waits_for_native_settlement() {
        // Regression: Pi abort acknowledgement was projected as cancelled before native interruption confirmation.
        if !isolated("pi_interrupt_waits_for_native_settlement") {
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let host = super::super::AgentHost::new().unwrap();
            let task = id();
            crate::kernel::origin::ORIGIN.scope(json!({"sourceId":"claude"}), crate::claude_notify::bind(
                &json!({"agent":"pi","notify":{"channel":"claude-session","target":"session_010000000000000000000001"}}),
                &task, "turn", "/project", json!({"op":"agent_send"}))).await.unwrap();
            let state = json!({"taskId":task,"agent":"pi","sessionId":"native-session","turnId":"turn","status":"running","metadata":{},"output":""});
            let script = r#"
                read abort
                request_id=$(printf '%s' "$abort" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
                printf '{"type":"response","id":"%s","success":true,"data":{}}\n' "$request_id"
                read get_state
                request_id=$(printf '%s' "$get_state" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
                printf '{"type":"response","id":"%s","success":true,"data":{"sessionId":"native-session","isStreaming":true}}\n' "$request_id"
                read confirm
                printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"aborted"}}' '{"type":"agent_settled"}'
                read hold
            "#;
            let process = Process::start(Path::new("/bin/sh"), &["-c".into(),script.into()], &std::env::temp_dir(), true, false, state, host.wake.clone(), &host.launches).await.unwrap();
            host.processes.lock().await.insert(task.clone(), process.clone());
            let requested = super::super::driver::AgentDriver::Pi.interrupt(&process).await.unwrap();
            assert_eq!(requested["status"], "cancelling");
            assert!(crate::claude_notify::read(&task, "turn").unwrap()["deliveries"].as_array().unwrap().is_empty());
            let active = host.observe_notification("pi", &task, "turn").await.unwrap();
            assert_eq!(active["state"], "running");
            assert_eq!(active["recordedStatus"], "cancelling");
            process.write(json!({"type":"confirm"})).await.unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let notified = host.wake.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if host.context_task("pi", &task).await.unwrap()["status"] == "cancelled" { break; }
                    notified.await;
                }
            }).await.unwrap();
            let confirmed = host.observe_notification("pi", &task, "turn").await.unwrap();
            assert_eq!(confirmed["state"], "cancelled");
            assert_eq!(confirmed["reason"], "agent-turn-terminal");
            let notification = crate::claude_notify::read(&task, "turn").unwrap();
            assert!(notification["deliveries"].as_array().unwrap().iter().any(|delivery| delivery["kind"] == "interrupted"));
            process.close().await;
        });
    }

    #[cfg(unix)]
    #[test]
    fn host_exit_without_native_outcome_stays_unconfirmed() {
        // Regression: a successful detached host exit fabricated a completed native turn.
        if !isolated("host_exit_without_native_outcome_stays_unconfirmed") {
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let host = super::super::AgentHost::new().unwrap();
            let task = id();
            let directory = std::env::temp_dir().join(format!("arc-exit-only-{}", id()));
            std::fs::create_dir_all(&directory).unwrap();
            let journal = directory.join("journal.jsonl");
            std::fs::write(&journal, "").unwrap();
            save(&directory.join("exit.json"), &json!({"exitCode":0,"receivedSequence":0,"nextOffset":1,"error":null})).unwrap();
            let state = json!({"taskId":task,"agent":"dsh","status":"running","turnId":"turn","metadata":{},"output":"",
                "taskHost":{"hostPid":0,"hostStart":"exited","hostProtocol":1,"socket":"unused","journalPath":journal,"ackedOffset":0}});
            let process = Process::reattach(state, host.wake.clone(), &host.launches).await.unwrap();
            host.processes.lock().await.insert(task.clone(), process.clone());
            let saved = host.context_task("dsh", &task).await.unwrap();
            assert_eq!(saved["exitCode"], 0);
            assert_eq!(saved["status"], "unknown");
            let observed = host.observe_notification("dsh", &task, "turn").await;
            assert!(observed.is_err() || observed.unwrap()["state"] == "unconfirmed");
            process.release().await;
            std::fs::remove_dir_all(directory).unwrap();
        });
    }

    #[cfg(unix)]
    #[test]
    fn noisy_stdout_keeps_reading_and_survives_abnormal_exit() {
        // Regression: one non-JSON stdout line ended the reader before subsequent protocol messages.
        if !isolated("noisy_stdout_keeps_reading_and_survives_abnormal_exit") {
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (live, disk, process, task) = fixture(r#"
                printf '%s\n' 'startup password=fixture-secret' '[llm-deepseek-account] catalog'
                printf '%s\n' '{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"after-noise"}}}}'
                read ignored
                exit 7
            "#).await;
            let state = observed(&live, &task, |s| s["output"] == "after-noise").await;
            assert_eq!(state["status"], "running");
            assert_eq!(state["stdoutDiagnostics"]["skippedLines"], 2);
            assert!(!state["stdoutDiagnostics"].to_string().contains("fixture-secret"));
            process.close().await;
            let saved = disk.context_task("dsh", &task).await.unwrap();
            assert_eq!(saved["output"], "after-noise");
            assert_eq!(saved["status"], "unknown");
            assert!(string(&saved, "error").contains("startup"));
            assert!(!string(&saved, "error").contains("fixture-secret"));
            assert!(saved["tracking"]["entries"].as_array().unwrap().iter().any(|r| r["type"] == "error"));
        });
    }

    #[cfg(unix)]
    #[test]
    fn oversize_stdout_records_task_and_timeline_error() {
        // Regression: exceeding the stdout frame limit silently marked the task unknown without an error.
        if !isolated("oversize_stdout_records_task_and_timeline_error") {
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (live, disk, process, task) =
                fixture("dd if=/dev/zero bs=1048576 count=33 2>/dev/null; read ignored").await;
            let state = observed(&live, &task, |s| s["processState"] == "exited").await;
            assert!(string(&state, "error").starts_with("AGENT_STDOUT_FRAME_TOO_LARGE:"));
            process.close().await;
            let saved = disk.context_task("dsh", &task).await.unwrap();
            assert!(string(&saved, "error").starts_with("AGENT_STDOUT_FRAME_TOO_LARGE:"));
            assert!(saved["tracking"]["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["type"] == "error"));
        });
    }

    #[cfg(unix)]
    #[test]
    fn streaming_checkpoints_preserve_partial_frames_and_flush_on_close() {
        // Regression: streaming rewrote snapshots per chunk and shutdown did not join the final stdout snapshot.
        if !isolated("streaming_checkpoints_preserve_partial_frames_and_flush_on_close") {
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (live, disk, process, task) = fixture(r#"
                printf '%s\n' '{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"A"}}}}'
                printf '%s' '{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"B'
                read ignored
                printf '%s\n' '"}}}}'
                read ignored
                printf '%s\n' '{"method":"session/update","params":{"update":{"sessionUpdate":"plan","entries":[]}}}'
                read ignored
                printf '%s\n' '{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"C"}}}}'
            "#).await;
            observed(&live, &task, |s| s["output"] == "A").await;
            assert_eq!(disk.context_task("dsh", &task).await.unwrap()["output"], "");
            tokio::time::timeout(Duration::from_millis(1500), observed(&disk, &task, |s| s["output"] == "A")).await.unwrap();
            process.write(json!("complete-frame")).await.unwrap();
            observed(&live, &task, |s| s["output"] == "AB").await;
            assert_eq!(disk.context_task("dsh", &task).await.unwrap()["output"], "A");
            process.write(json!("plan")).await.unwrap();
            tokio::time::timeout(Duration::from_millis(500), observed(&disk, &task, |s| s["output"] == "AB")).await.unwrap();
            process.close().await;
            assert_eq!(disk.context_task("dsh", &task).await.unwrap()["output"], "ABC");
        });
    }
}
