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
fn terminal_status(status: &str) -> bool {
    matches!(status, "completed" | "cancelled" | "failed")
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

/// One owned stdio process per task. ACP and Pi share framing, not protocol semantics.
pub struct Process {
    input: Mutex<Option<tokio::process::ChildStdin>>,
    child: Mutex<tokio::process::Child>,
    replies: Replies,
    pub events: SharedEvents,
    pub state: Arc<Mutex<Value>>,
    pub pi: bool,
    pub alive: std::sync::atomic::AtomicBool,
    pub capabilities: Mutex<Value>,
    pub dispatch: Mutex<()>,
    reader: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
impl Process {
    pub async fn start(
        binary: &Path,
        args: &[String],
        cwd: &Path,
        pi: bool,
        mut state: Value,
        wake: Arc<tokio::sync::Notify>,
    ) -> Result<Arc<Self>> {
        state["processSession"] = json!(id());
        let mut cmd = launch_command(binary, args)?;
        if state["agent"] == "claude" {
            if let Some(profile) = state["agentProfileId"].as_str() {
                let config = crate::accounts::claude::config_dir(profile)?;
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
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let input = child.stdin.take().ok_or("MISSING_STDIN")?;
        let stdout = child.stdout.take().ok_or("MISSING_STDOUT")?;
        let mut tracking: crate::task_tracking::Timeline =
            serde_json::from_value(state["tracking"].clone()).unwrap_or_default();
        tracking.info = json!({"id":state["taskId"],"project":state["cwd"]});
        let process = Arc::new(Self {
            input: Mutex::new(Some(input)),
            child: Mutex::new(child),
            replies: Default::default(),
            events: Arc::new(Mutex::new(Events {
                timelines: HashMap::from([(string(&state, "taskId").to_owned(), tracking)]),
                durable: true,
                ..Events::default()
            })),
            state: Arc::new(Mutex::new(state)),
            pi,
            alive: true.into(),
            capabilities: Mutex::new(Value::Null),
            dispatch: Mutex::new(()),
            reader: Mutex::new(None),
        });
        process.events.lock().await.wake = wake;
        let weak = Arc::downgrade(&process);
        let reader_job = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut deadline = None;
            let mut read_error = None;
            loop {
                // Keep the same read future across timer ticks: line() consumes partial
                // frames and must not be cancelled by the persistence deadline.
                let read = crate::line(&mut reader, 32 * 1024 * 1024);
                tokio::pin!(read);
                let frame = loop {
                    tokio::select! {
                        biased;
                        _ = async {
                            match deadline {
                                Some(at) => tokio::time::sleep_until(at).await,
                                None => std::future::pending::<()>().await,
                            }
                        } => {
                            let Some(p) = weak.upgrade() else { return };
                            p.persist(&mut *p.state.lock().await).await;
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
                let mut msg: Value = match serde_json::from_slice(&frame) {
                    Ok(v) => v,
                    Err(_) => {
                        let mut state = p.state.lock().await;
                        state["stdoutDiagnostics"] =
                            stdout_diagnostics(&state["stdoutDiagnostics"], &frame);
                        state["updatedAt"] = json!(now());
                        deadline
                            .get_or_insert(tokio::time::Instant::now() + Duration::from_secs(1));
                        continue;
                    }
                };
                let response = if pi {
                    msg["type"] == "response"
                } else {
                    msg.get("method").is_none() && msg.get("id").is_some()
                };
                if response {
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
                } else {
                    string(&msg, "method")
                }
                .to_owned();
                let method = method.as_str();
                if !pi && msg.get("id").is_some() && method != "session/request_permission" {
                    let _ = p.write(json!({"jsonrpc":"2.0","id":msg["id"],"error":{"code":-32601,"message":"Client capability not supported"}})).await;
                    continue;
                }
                let mut state = p.state.lock().await;
                let terminal = terminal_status(string(&state, "status"));
                let task = string(&state, "taskId").to_owned();
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
                    state["status"] = json!("waiting-permission");
                    if let Err(error) = crate::claude_notify::observe(
                        string(&state, "taskId"),
                        string(&state, "turnId"),
                        &json!({"state":"interaction-required","title":state["title"],"interaction":[msg]}),
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
                    if method == "agent_settled" && !terminal {
                        state["status"] =
                            json!(match string(&state["lastMessage"], "stopReason") {
                                "error" => "failed",
                                "aborted" => "cancelled",
                                _ => "completed",
                            });
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
                        &json!({"state":state["status"],"title":state["title"],"finalResponse":state["output"],"error":state["lastMessage"]["errorMessage"]}),
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
                let exit_status = p.child.lock().await.try_wait().ok().flatten();
                let mut s = p.state.lock().await;
                let abnormal = !terminal_status(string(&s, "status"))
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
                if !terminal_status(string(&s, "status")) {
                    s["status"] = json!("unknown");
                }
                s["processState"] = json!("exited");
                if let Some(status) = exit_status {
                    s["exitCode"] = json!(status.code());
                }
                {
                    let mut events = p.events.lock().await;
                    if let Some(t) = events.timelines.get_mut(string(&s, "taskId")) {
                        t.finish("unknown", &now());
                    }
                }
                p.persist(&mut s).await;
                {
                    let mut events = p.events.lock().await;
                    events.pending.clear();
                    events.wake.notify_waiters();
                }
            }
        });
        *process.reader.lock().await = Some(reader_job);
        Ok(process)
    }
    async fn persist(&self, state: &mut Value) {
        self.snapshot_tracking(state).await;
        if let Err(error) = super::save_task(state) {
            state["storageError"] = json!(error);
        }
    }
    pub async fn remember_configuration(&self) {
        let mut state = self.state.lock().await;
        if let Err(error) = super::remember_task_configuration(&state) {
            state["storageError"] = json!(error);
        }
    }
    pub async fn snapshot_tracking(&self, state: &mut Value) {
        if let Some(timeline) = self
            .events
            .lock()
            .await
            .timelines
            .get_mut(string(state, "taskId"))
        {
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
        if !self.alive.load(std::sync::atomic::Ordering::SeqCst)
            || self
                .child
                .lock()
                .await
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_some()
        {
            return Err("process-exit-unconfirmed".into());
        }
        Ok(())
    }
    pub async fn write(&self, value: Value) -> Result<()> {
        let mut input = self.input.lock().await;
        let input = input.as_mut().ok_or("PROCESS_NOT_RUNNING")?;
        input
            .write_all(format!("{value}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        input.flush().await.map_err(|e| e.to_string())
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
    pub async fn close(&self) {
        if let Some(mut input) = self.input.lock().await.take() {
            let _ = input.shutdown().await;
            // ChildStdin::shutdown alone does not close the pipe. Drop its writer
            // so cooperative Agents can emit their final stdout before exiting.
        }
        let mut child = self.child.lock().await;
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
        drop(child);
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
            state,
            live.wake.clone(),
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
