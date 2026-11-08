use crate::*;
use std::{collections::HashMap, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    sync::oneshot,
};
type Pending = Arc<std::sync::Mutex<HashMap<String, oneshot::Sender<Result<Value>>>>>;
struct PendingCall {
    pending: Pending,
    key: String,
}
impl Drop for PendingCall {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.key);
    }
}
pub struct Rpc {
    input: Mutex<Option<tokio::process::ChildStdin>>,
    child: Mutex<tokio::process::Child>,
    pending: Pending,
    pub events: SharedEvents,
    pub session: String,
    alive: Arc<std::sync::atomic::AtomicBool>,
    pid: Option<u32>,
    started_at: String,
    inherited_nofile: Value,
}
impl Rpc {
    pub async fn start(binary: &Path, events: SharedEvents, session: &str) -> Result<Arc<Self>> {
        Self::start_profile(binary, events, session, None).await
    }
    pub(crate) async fn start_profile(
        binary: &Path,
        events: SharedEvents,
        session: &str,
        profile: Option<&str>,
    ) -> Result<Arc<Self>> {
        let mut command = command(binary);
        if let Some(profile) = profile {
            command.env("CODEX_HOME", crate::accounts::codex::home(profile)?);
            #[cfg(not(feature = "test-fixture"))]
            command.args(["-c", "cli_auth_credentials_store=\"file\""]);
            for key in ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"] {
                command.env_remove(key);
            }
        }
        #[cfg(feature = "test-fixture")]
        command.arg(std::env::var("ARC_FIXTURE_SCRIPT").map_err(|_| "fixture script missing")?);
        #[cfg(not(feature = "test-fixture"))]
        command.arg("app-server");
        // Unsubscribe must unload an idle ARC-owned thread instead of retaining
        // its writer for the native default grace period (30 minutes).
        command.args(["-c", "thread_unload_delay_secs=0"]);
        #[cfg(unix)]
        command.process_group(0);
        let inherited_nofile = crate::resources::before_spawn();
        let mut child = command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let pid = child.id();
        let started_at = now();
        let input = child.stdin.take().ok_or("missing stdin")?;
        let stdout = child.stdout.take().ok_or("missing stdout")?;
        let mut stderr = child.stderr.take().ok_or("missing stderr")?;
        tokio::spawn(async move {
            let mut bytes = [0; 4096];
            let mut window = std::time::Instant::now();
            let mut count = 0;
            while let Ok(n) = stderr.read(&mut bytes).await {
                if n == 0 {
                    break;
                }
                if window.elapsed().as_secs() >= 1 {
                    window = std::time::Instant::now();
                    count = 0;
                }
                if count < 8 {
                    crate::logs::record(
                        "WARN",
                        &format!("app-server: {}", String::from_utf8_lossy(&bytes[..n])),
                        None,
                    );
                    count += 1;
                }
            }
        });
        let pending: Pending = Default::default();
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let rpc = Arc::new(Self {
            input: Mutex::new(Some(input)),
            child: Mutex::new(child),
            pending: pending.clone(),
            events: events.clone(),
            session: session.into(),
            alive: alive.clone(),
            pid,
            started_at,
            inherited_nofile,
        });
        let session = session.to_owned();
        let profile = profile.map(str::to_owned);
        let response_input = Arc::downgrade(&rpc);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let bytes = match crate::line(&mut reader, 32 * 1024 * 1024).await {
                    Ok(bytes) if !bytes.is_empty() => bytes,
                    _ => break,
                };
                let Ok(mut msg) = serde_json::from_slice::<Value>(&bytes) else {
                    continue;
                };
                if let Some(profile) = profile.as_deref() {
                    if msg["method"] == "thread/started" {
                        if let Some(thread) = msg["params"]["thread"]["id"]
                            .as_str()
                            .filter(|s| uuid::Uuid::parse_str(s).is_ok())
                        {
                            let account = crate::accounts::profile_account(profile).ok();
                            if let Err(error) = save(
                                &root().join("execution").join(format!("{thread}.json")),
                                &json!({"owner":"connector","agentProfileId":profile,"agentAccountId":account.map(|a|a["id"].clone())}),
                            ) {
                                crate::logs::record("WARN", &error, None);
                            }
                        }
                    }
                    if msg["method"] == "account/chatgptAuthTokens/refresh"
                        && msg.get("id").is_some()
                    {
                        let Some(rpc) = response_input.upgrade() else {
                            break;
                        };
                        let profile = profile.to_owned();
                        tokio::spawn(async move {
                            let response = match crate::accounts::codex::tokens(
                                &profile,
                                Some(&msg["params"]),
                            )
                            .await
                            {
                                Ok(tokens) => json!({"id":msg["id"],"result":tokens}),
                                Err(error) => {
                                    json!({"id":msg["id"],"error":{"code":-32000,"message":error}})
                                }
                            };
                            let _ = rpc.write(response).await;
                        });
                        continue;
                    }
                    if msg.get("method").is_some() {
                        if let Some(key) = msg.get("id").cloned() {
                            msg["nativeResponseId"] = key.clone();
                            msg["id"] = json!(format!("{profile}:{}", key));
                        }
                        if msg["method"] == "serverRequest/resolved" {
                            msg["params"]["requestId"] =
                                json!(format!("{profile}:{}", msg["params"]["requestId"]));
                        }
                    }
                }
                if msg.get("method").is_some() {
                    if let Some(key) = msg.get("id") {
                        let mut request = json!({"id":key,"responseId":key.to_string(),"method":msg["method"],"params":msg["params"],"backendSession":session,"owner":"connector-app-server","canRespond":true,"next":{"via":"act","op":"codex_respond","args":{"id":key.to_string(),"backendSession":session},"hint":"Supply exactly one of result/error using the native response schema."}});
                        request["agentProfileId"] = json!(profile);
                        if msg.get("nativeResponseId").is_some() {
                            request["nativeResponseId"] = msg["nativeResponseId"].clone();
                        }
                        let task = string(&request["params"], "threadId").to_owned();
                        if let Err(error) =
                            crate::claude_notify::routing::observe("codex", &task, &mut request)
                        {
                            crate::logs::record("WARN", &error, None);
                        }
                        events.lock().await.pending.insert(key.to_string(), request);
                    }
                    if string(&msg, "method") == "serverRequest/resolved" {
                        events
                            .lock()
                            .await
                            .pending
                            .remove(&msg["params"]["requestId"].to_string());
                    }
                    crate::event(
                        &events,
                        &session,
                        string(&msg, "method"),
                        msg["params"].clone(),
                    )
                    .await;
                } else if let Some(key) = msg.get("id") {
                    if let Some(tx) = pending.lock().unwrap().remove(&key.to_string()) {
                        let result = if msg.get("error").is_some() {
                            Err(format!("RPC_REJECTED:{}", msg["error"]))
                        } else {
                            Ok(msg["result"].clone())
                        };
                        let _ = tx.send(result);
                    }
                }
            }
            alive.store(false, std::sync::atomic::Ordering::SeqCst);
            for (_, tx) in pending.lock().unwrap().drain() {
                let _ = tx.send(Err("TRANSPORT_CLOSED: execution state unknown".into()));
            }
            let mut events = events.lock().await;
            events
                .pending
                .retain(|_, r| r["owner"] == "desktop" || r["agentProfileId"] != json!(profile));
            for (thread, timeline) in events.timelines.iter_mut() {
                let owner = crate::accounts::codex::thread_profile(thread).ok();
                if timeline.info["runtimeSource"] == "connector-app-server"
                    && owner.as_deref() == Some(profile.as_deref().unwrap_or("codex-home"))
                {
                    timeline.lose_observation();
                }
            }
            events.wake.notify_waiters();
        });
        rpc.call("initialize",json!({"clientInfo":{"name":"agent-remote-control","version":env!("ARC_BUILD_VERSION")},"capabilities":{"experimentalApi":true}}),60000).await?;
        rpc.write(json!({"method":"initialized"})).await?;
        Ok(rpc)
    }
    pub fn alive(&self) -> bool {
        self.alive.load(std::sync::atomic::Ordering::SeqCst)
    }
    pub async fn health(&self) -> Value {
        // Hold the owned Child while sampling, and check for exit on both sides.
        // Never sample an old PID after it has been reaped/reused.
        let child = self.child.lock().await;
        let mut resources = match crate::resources::child_running(child.id()) {
            Ok(true) => crate::resources::child_status(
                child.id(),
                Some(&self.inherited_nofile),
                "process PID unavailable",
            ),
            Ok(false) => {
                crate::resources::child_status(None, Some(&self.inherited_nofile), "process exited")
            }
            Err(error) => crate::resources::child_status(
                None,
                Some(&self.inherited_nofile),
                &error.to_string(),
            ),
        };
        if !matches!(crate::resources::child_running(child.id()), Ok(true)) {
            resources = crate::resources::child_status(
                None,
                Some(&self.inherited_nofile),
                "process exited or could not be checked",
            );
        }
        json!({"state":if self.alive(){"ready"}else{"stopped"},"pid":self.pid,"startedAt":self.started_at,"observedAt":now(),"evidence":"native-connector","stale":false,"resources":resources})
    }
    pub async fn write(&self, v: Value) -> Result<()> {
        let mut input = self.input.lock().await;
        input
            .as_mut()
            .ok_or("TRANSPORT_CLOSED")?
            .write_all(format!("{v}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())
    }
    pub async fn call(&self, method: &str, params: Value, timeout: u64) -> Result<Value> {
        if !self.alive() {
            return Err("TRANSPORT_CLOSED".into());
        }
        let key = id();
        let (tx, rx) = oneshot::channel();
        let _guard = PendingCall {
            pending: self.pending.clone(),
            key: json!(key).to_string(),
        };
        self.pending
            .lock()
            .unwrap()
            .insert(json!(key).to_string(), tx);
        if let Err(e) = self
            .write(json!({"id":key,"method":method,"params":params}))
            .await
        {
            self.pending.lock().unwrap().remove(&json!(key).to_string());
            return Err(submission_error(method, e));
        }
        let out = tokio::time::timeout(Duration::from_millis(timeout), rx).await;
        self.pending.lock().unwrap().remove(&json!(key).to_string());
        let result = out
            .map_err(|_| format!("RPC_TIMEOUT: {method}"))
            .and_then(|v| v.map_err(|_| "TRANSPORT_CLOSED".to_string()))
            .and_then(|v| v);
        if result.is_ok() && matches!(method, "thread/unsubscribe" | "thread/resume") {
            let mut events = self.events.lock().await;
            let timeline = events
                .timelines
                .entry(string(&params, "threadId").into())
                .or_default();
            if method == "thread/unsubscribe" {
                timeline.lose_observation();
            } else {
                timeline.observation_lost = false;
                timeline.history_loaded = false;
            }
            events.wake.notify_waiters();
        }
        result.map_err(|e| submission_error(method, e))
    }
    pub async fn close(&self) {
        // Dropping the pipe sends EOF. AsyncWrite::shutdown alone leaves the
        // child stdin handle open and makes cooperative processes hit the 5s kill deadline.
        self.input.lock().await.take();
        let mut child = self.child.lock().await;
        let pid = child.id();
        if tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
        // The utility process group belongs only to Agent Remote Control, never Desktop.
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
    }
}

// Only transport failures after a mutating request was submitted leave its result unknown.
pub(crate) fn submission_error(method: &str, error: String) -> String {
    let read = matches!(
        method,
        "initialize" | "get_state" | "get_commands" | "get_available_models"
    ) || method.ends_with("/read")
        || method.ends_with("/list")
        || crate::catalog()["domains"]
            .as_object()
            .into_iter()
            .flat_map(|d| d.values())
            .flat_map(|d| {
                d["actions"]
                    .as_object()
                    .into_iter()
                    .flat_map(|a| a.values())
            })
            .any(|a| a[0] == method && a[1] == true);
    if read || error.starts_with("RPC_REJECTED") {
        error
    } else {
        format!("SUBMISSION_UNCONFIRMED: {error}")
    }
}
