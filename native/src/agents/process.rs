use crate::*;
use std::{collections::HashMap, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    sync::oneshot,
};
type Replies = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value>>>>>;

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
    input: Mutex<tokio::process::ChildStdin>,
    child: Mutex<tokio::process::Child>,
    replies: Replies,
    pub events: SharedEvents,
    pub state: Arc<Mutex<Value>>,
    pub pi: bool,
    pub alive: std::sync::atomic::AtomicBool,
    pub capabilities: Mutex<Value>,
    pub dispatch: Mutex<()>,
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
        let process = Arc::new(Self {
            input: Mutex::new(input),
            child: Mutex::new(child),
            replies: Default::default(),
            events: Arc::new(Mutex::new(Events {
                durable: true,
                ..Events::default()
            })),
            state: Arc::new(Mutex::new(state)),
            pi,
            alive: true.into(),
            capabilities: Mutex::new(Value::Null),
            dispatch: Mutex::new(()),
        });
        process.events.lock().await.wake = wake;
        let weak = Arc::downgrade(&process);
        let dsh = process.state.lock().await["agent"] == "dsh";
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let frame = match crate::line(&mut reader, 32 * 1024 * 1024).await {
                    Ok(b) if !b.is_empty() => b,
                    _ => break,
                };
                let Some(p) = weak.upgrade() else { break };
                // DSH Desktop 0.2.1-rc.2 writes model-catalog diagnostics to ACP stdout.
                // Remove this narrow workaround once upstream keeps them on stderr.
                if dsh && frame.starts_with(b"[llm-deepseek-account] ") {
                    continue;
                }
                let msg: Value = match serde_json::from_slice(&frame) {
                    Ok(v) => v,
                    Err(_) => break,
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
                };
                if !pi && msg.get("id").is_some() && method != "session/request_permission" {
                    let _ = p.write(json!({"jsonrpc":"2.0","id":msg["id"],"error":{"code":-32601,"message":"Client capability not supported"}})).await;
                    continue;
                }
                let mut state = p.state.lock().await;
                let task = string(&state, "taskId").to_owned();
                crate::event(&p.events, &task, method, msg.clone()).await;
                if method == "session/update" {
                    let update = &msg["params"]["update"];
                    if update["sessionUpdate"] == "config_option_update" {
                        state["metadata"]["configOptions"] = update["configOptions"].clone();
                        state["configurationObservedAt"] = json!(now());
                    } else if update["sessionUpdate"] == "current_mode_update" {
                        state["metadata"]["modes"]["currentModeId"] =
                            update["currentModeId"].clone();
                        state["configurationObservedAt"] = json!(now());
                    }
                }
                if method == "session/request_permission"
                    || (method == "extension_ui_request"
                        && matches!(
                            string(&msg, "method"),
                            "select" | "confirm" | "input" | "editor"
                        ))
                {
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
                        &json!({"state":state["status"],"title":state["title"]}),
                    )
                    .await
                    {
                        crate::logs::record("WARN", &error, None);
                    }
                }
                state["updatedAt"] = json!(now());
                if let Err(e) = super::save_task(&state) {
                    state["storageError"] = json!(e);
                }
            }
            if let Some(p) = weak.upgrade() {
                p.alive.store(false, std::sync::atomic::Ordering::SeqCst);
                for (_, tx) in p.replies.lock().await.drain() {
                    let _ = tx.send(Err("PROCESS_EXIT_UNCONFIRMED".into()));
                }
                let mut s = p.state.lock().await;
                if !matches!(string(&s, "status"), "completed" | "cancelled" | "failed") {
                    s["status"] = json!("unknown");
                }
                s["processState"] = json!("exited");
                let _ = super::save_task(&s);
                {
                    let mut events = p.events.lock().await;
                    events.pending.clear();
                    events.wake.notify_waiters();
                }
                if let Ok(Some(status)) = p.child.lock().await.try_wait() {
                    s["exitCode"] = json!(status.code());
                    let _ = super::save_task(&s);
                }
            }
        });
        Ok(process)
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
        let result = tokio::time::timeout(Duration::from_millis(timeout), rx).await;
        self.replies.lock().await.remove(&key.to_string());
        result
            .map_err(|_| format!("RPC_TIMEOUT:{method}"))
            .and_then(|v| v.map_err(|_| "PROCESS_EXIT".to_owned()))
            .and_then(|v| v)
            .map_err(|e| crate::rpc::submission_error(method, e))
    }
    pub async fn close(&self) {
        let _ = self.input.lock().await.shutdown().await;
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

fn launch_command(binary: &Path, args: &[String]) -> Result<tokio::process::Command> {
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
