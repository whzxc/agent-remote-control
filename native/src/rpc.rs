use crate::owned_children::SpawnOwned;
use crate::*;
use futures_util::{
    stream::{SplitSink, SplitStream},
    SinkExt, StreamExt,
};
use std::{collections::HashMap, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout},
    sync::oneshot,
};
use tokio_tungstenite::{
    tungstenite::{protocol::WebSocketConfig, Message},
    WebSocketStream,
};
const FRAME_LIMIT: usize = 32 * 1024 * 1024;
type Bridge = WebSocketStream<tokio::io::Join<ChildStdout, ChildStdin>>;
/// Core-owned stdio app-server, or a detached server reached through `app-server proxy`.
enum Writer {
    Stdio(ChildStdin),
    Socket(SplitSink<Bridge, Message>),
}
enum Frames {
    Lines(BufReader<ChildStdout>),
    Socket(SplitStream<Bridge>),
}
impl Frames {
    async fn next(&mut self) -> Option<Vec<u8>> {
        match self {
            Frames::Lines(reader) => match crate::line(reader, FRAME_LIMIT).await {
                Ok(bytes) if !bytes.is_empty() => Some(bytes),
                _ => None,
            },
            Frames::Socket(stream) => loop {
                match stream.next().await? {
                    Ok(Message::Text(text)) => return Some(text.as_bytes().to_vec()),
                    Ok(Message::Binary(bytes)) => return Some(bytes.to_vec()),
                    Ok(Message::Close(_)) | Err(_) => return None,
                    Ok(_) => continue,
                }
            },
        }
    }
}
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
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConnectionRole {
    Connector,
    SharedDesktop,
    PrivateDesktop,
}

pub struct Rpc {
    input: Mutex<Option<Writer>>,
    /// The stdio app-server, or the disposable proxy of a detached host.
    child: Mutex<tokio::process::Child>,
    host: Option<crate::codex_host::Host>,
    pending: Pending,
    pub events: SharedEvents,
    pub session: String,
    pub(crate) connection: String,
    role: ConnectionRole,
    alive: Arc<std::sync::atomic::AtomicBool>,
    pid: Option<u32>,
    started_at: String,
    inherited_nofile: Value,
}
impl Rpc {
    pub async fn start(binary: &Path, events: SharedEvents, session: &str) -> Result<Arc<Self>> {
        let mut command = command(binary);
        command.env("CODEX_HOME", crate::accounts::codex::default_home()?);
        #[cfg(feature = "test-fixture")]
        command.arg(std::env::var("ARC_FIXTURE_SCRIPT").map_err(|_| "fixture script missing")?);
        #[cfg(not(feature = "test-fixture"))]
        command.arg("app-server");
        // Unsubscribe must unload an idle ARC-owned thread instead of retaining
        // its writer for the native inactivity grace period.
        command.args(["-c", "thread_unload_delay_secs=0"]);
        #[cfg(unix)]
        command.process_group(0);
        let inherited_nofile = crate::resources::before_spawn();
        let mut child = command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn_owned()
            .map_err(|e| e.to_string())?;
        let pid = child.id();
        let started_at = now();
        let input = child.stdin.take().ok_or("missing stdin")?;
        let stdout = child.stdout.take().ok_or("missing stdout")?;
        let stderr = child.stderr.take().ok_or("missing stderr")?;
        forward_stderr(stderr);
        Self::run(
            child,
            Writer::Stdio(input),
            Frames::Lines(BufReader::new(stdout)),
            None,
            events,
            session,
            pid,
            started_at,
            inherited_nofile,
            ConnectionRole::Connector,
        )
        .await
    }
    /// Connect to the native detached app-server, starting it when needed.
    /// Falls back to a Core-owned stdio server when detachment is unavailable.
    pub(crate) async fn attach(
        binary: &Path,
        events: SharedEvents,
        session: &str,
        launches: &crate::launches::Launches,
    ) -> Result<Arc<Self>> {
        launches.check()?;
        if cfg!(feature = "test-fixture") {
            return Self::start(binary, events, session).await;
        }
        match Box::pin(Self::connect_host(
            binary,
            &events,
            session,
            launches,
            ConnectionRole::Connector,
        ))
        .await
        {
            Ok(rpc) => Ok(rpc),
            Err(error) if crate::codex_host::running("codex-home") => Err(error),
            Err(error) => {
                launches.check()?;
                crate::logs::record("WARN", &format!("Detached Codex app-server unavailable; using a Core-owned app-server: {error}"), None);
                Self::start(binary, events, session).await
            }
        }
    }
    pub(crate) async fn connect_host(
        binary: &Path,
        events: &SharedEvents,
        session: &str,
        launches: &crate::launches::Launches,
        role: ConnectionRole,
    ) -> Result<Arc<Self>> {
        loop {
            let host = crate::codex_host::attach(binary, "codex-home", launches).await?;
            let mut failure = String::new();
            let mut connected = None;
            for _ in 0..3 {
                match Self::bridge(binary, events.clone(), session, host.clone(), role).await {
                    Ok(rpc) => {
                        connected = Some(rpc);
                        break;
                    }
                    Err(error) => {
                        failure = error;
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                }
            }
            let rpc = connected.ok_or(failure)?;
            if host.adopted {
                if host.outdated
                    && !rpc.active().await
                    && !crate::codex_host::desktop_attached().await
                {
                    rpc.stop().await;
                    continue;
                }
                rpc.resubscribe().await?;
            }
            return Ok(rpc);
        }
    }
    async fn bridge(
        binary: &Path,
        events: SharedEvents,
        session: &str,
        host: crate::codex_host::Host,
        role: ConnectionRole,
    ) -> Result<Arc<Self>> {
        let socket = host.socket.clone();
        #[cfg(target_os = "macos")]
        if crate::desktop::daemon::native_peer(&socket).await? != host.pid {
            return Err("CODEX_BACKEND_PEER_MISMATCH".into());
        }
        Self::proxy(binary, events, session, &socket, Some(host), role).await
    }
    #[cfg(target_os = "macos")]
    pub(crate) async fn connect_shared_desktop(
        binary: &Path,
        events: SharedEvents,
        socket: &Path,
    ) -> Result<Arc<Self>> {
        Self::proxy(
            binary,
            events,
            &id(),
            socket,
            None,
            ConnectionRole::SharedDesktop,
        )
        .await
    }
    async fn proxy(
        binary: &Path,
        events: SharedEvents,
        session: &str,
        socket: &Path,
        host: Option<crate::codex_host::Host>,
        role: ConnectionRole,
    ) -> Result<Arc<Self>> {
        let mut command = command(binary);
        command.env("CODEX_HOME", crate::accounts::codex::default_home()?);
        command.args(["app-server", "proxy", "--sock"]).arg(socket);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn_owned()
            .map_err(|e| e.to_string())?;
        let input = child.stdin.take().ok_or("missing stdin")?;
        let stdout = child.stdout.take().ok_or("missing stdout")?;
        forward_stderr(child.stderr.take().ok_or("missing stderr")?);
        let config = WebSocketConfig::default()
            .max_message_size(Some(FRAME_LIMIT))
            .max_frame_size(Some(FRAME_LIMIT));
        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(10),
            tokio_tungstenite::client_async_with_config(
                "ws://localhost/",
                tokio::io::join(stdout, input),
                Some(config),
            ),
        )
        .await
        .map_err(|_| "CODEX_HOST_HANDSHAKE_TIMEOUT".to_owned())?
        .map_err(|e| format!("CODEX_HOST_HANDSHAKE_FAILED: {e}"))?;
        let (sink, stream) = socket.split();
        let pid = host.as_ref().map(|host| host.pid).or_else(|| child.id());
        let started_at = host
            .as_ref()
            .map(|host| host.started_at.clone())
            .unwrap_or_else(now);
        let inherited_nofile = host
            .as_ref()
            .map(|host| host.inherited_nofile.clone())
            .unwrap_or(Value::Null);
        Self::run(
            child,
            Writer::Socket(sink),
            Frames::Socket(stream),
            host,
            events,
            session,
            pid,
            started_at,
            inherited_nofile,
            role,
        )
        .await
    }
    #[cfg(target_os = "macos")]
    pub(crate) async fn proxy_identity(&self) -> Value {
        let pid = self.child.lock().await.id();
        json!({"connection":self.connection,"pid":pid,"start":pid.and_then(crate::codex_host::process_start)})
    }
    pub(crate) fn runtime_source(&self) -> &'static str {
        match self.role {
            ConnectionRole::Connector => "connector-app-server",
            ConnectionRole::SharedDesktop => "desktop-shared-app-server",
            ConnectionRole::PrivateDesktop => "desktop-private-app-server",
        }
    }
    /// Subscribe this connection to turns that kept running while no Core was
    /// attached. Codex re-sends their pending server requests on resume.
    async fn resubscribe(&self) -> Result<()> {
        for thread in self.loaded_threads().await? {
            if !self.thread_idle(&thread).await? {
                self.call(
                    "thread/resume",
                    json!({"threadId":thread,"excludeTurns":true}),
                    30000,
                )
                .await?;
            }
        }
        Ok(())
    }

    async fn loaded_threads(&self) -> Result<Vec<String>> {
        let mut threads = Vec::new();
        let mut cursor = Value::Null;
        let mut seen = std::collections::HashSet::new();
        loop {
            let page = self
                .call(
                    "thread/loaded/list",
                    json!({"cursor":cursor,"limit":100}),
                    5000,
                )
                .await?;
            for id in page["data"]
                .as_array()
                .ok_or("CODEX_HOST_INVALID_LOADED_THREADS")?
            {
                threads.push(
                    id.as_str()
                        .ok_or("CODEX_HOST_INVALID_LOADED_THREAD")?
                        .to_owned(),
                );
            }
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                return Ok(threads);
            }
            if !seen.insert(cursor.to_string()) {
                return Err("CODEX_HOST_REPEATED_CURSOR".into());
            }
        }
    }

    async fn thread_idle(&self, thread: &str) -> Result<bool> {
        let read = self
            .call(
                "thread/read",
                json!({"threadId":thread,"includeTurns":false}),
                5000,
            )
            .await?;
        Ok(matches!(
            read["thread"]["status"]["type"].as_str(),
            Some("idle" | "notLoaded")
        ))
    }

    /// Uncertain activity retains the host.
    pub(crate) async fn active(&self) -> bool {
        let Ok(threads) = self.loaded_threads().await else {
            return true;
        };
        for thread in threads {
            if !self.thread_idle(&thread).await.unwrap_or(false) {
                return true;
            }
        }
        false
    }
    pub(crate) fn host_identity(&self) -> Option<(u32, String)> {
        self.host
            .as_ref()
            .map(|host| (host.pid, host.process_start.clone()))
    }
    pub(crate) fn detached(&self) -> bool {
        self.host.is_some()
    }
    /// End the server and its native turns. A stdio server ends with its connection.
    pub(crate) async fn stop(&self) {
        self.close().await;
        if let Some(host) = &self.host {
            if let Err(error) = crate::codex_host::stop(&host.profile).await {
                crate::logs::record("WARN", &error, None);
            }
        }
    }
    #[allow(clippy::too_many_arguments)]
    async fn run(
        child: tokio::process::Child,
        input: Writer,
        mut frames: Frames,
        host: Option<crate::codex_host::Host>,
        events: SharedEvents,
        session: &str,
        pid: Option<u32>,
        started_at: String,
        inherited_nofile: Value,
        role: ConnectionRole,
    ) -> Result<Arc<Self>> {
        let shared_desktop = role == ConnectionRole::SharedDesktop;
        let pending: Pending = Default::default();
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let rpc = Arc::new(Self {
            input: Mutex::new(Some(input)),
            child: Mutex::new(child),
            host,
            pending: pending.clone(),
            events: events.clone(),
            session: session.into(),
            connection: if shared_desktop {
                session.to_owned()
            } else {
                id()
            },
            role,
            alive: alive.clone(),
            pid,
            started_at,
            inherited_nofile,
        });
        let session = session.to_owned();
        let runtime_source = rpc.runtime_source();
        #[cfg(target_os = "macos")]
        let disconnect = (shared_desktop || rpc.detached()).then(|| {
            (
                rpc.connection.clone(),
                if shared_desktop {
                    "desktop-last-disconnect.json"
                } else {
                    "private-last-disconnect.json"
                },
            )
        });
        let connection = rpc.connection.clone();
        let response_id = move |session: &str, key: &Value| {
            if role != ConnectionRole::Connector {
                json!([
                    if shared_desktop {
                        "desktop-daemon"
                    } else {
                        "private-desktop"
                    },
                    session,
                    key
                ])
                .to_string()
            } else {
                key.to_string()
            }
        };
        tokio::spawn(async move {
            while let Some(bytes) = frames.next().await {
                let Ok(msg) = serde_json::from_slice::<Value>(&bytes) else {
                    continue;
                };
                if msg.get("method").is_some() {
                    if let Some(key) = msg.get("id") {
                        let response = response_id(&session, key);
                        let mut request = json!({"id":key,"responseId":response,"method":msg["method"],"params":msg["params"],"backendSession":session,"connection":connection,"owner":runtime_source,"canRespond":true,"next":{"via":"act","op":"codex_respond","args":{"id":response,"backendSession":session},"hint":"Supply exactly one of result/error using the native response schema."}});
                        let task = string(&request["params"], "threadId").to_owned();
                        if let Err(error) =
                            crate::claude_notify::routing::observe("codex", &task, &mut request)
                        {
                            crate::logs::record("WARN", &error, None);
                        }
                        events.lock().await.pending.insert(response, request);
                    }
                    if string(&msg, "method") == "serverRequest/resolved" {
                        events
                            .lock()
                            .await
                            .pending
                            .remove(&response_id(&session, &msg["params"]["requestId"]));
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
            #[cfg(target_os = "macos")]
            if let Some((connection, path)) = disconnect {
                let _ = save(
                    &root().join(path),
                    &json!({"connection":connection,"observedAt":now()}),
                );
            }
            alive.store(false, std::sync::atomic::Ordering::SeqCst);
            for (_, tx) in pending.lock().unwrap().drain() {
                let _ = tx.send(Err("TRANSPORT_CLOSED: execution state unknown".into()));
            }
            let mut events = events.lock().await;
            events
                .pending
                .retain(|_, r| r["owner"] == "desktop" || r["connection"] != connection);
            for timeline in events.timelines.values_mut() {
                if timeline.info["runtimeSource"] == runtime_source {
                    timeline.lose_observation();
                }
            }
            events.wake.notify_waiters();
        });
        let initialize_timeout = if shared_desktop || rpc.detached() {
            5_000
        } else {
            60_000
        };
        let initialized = rpc.call("initialize",json!({"clientInfo":{"name":"agent-remote-control","version":env!("ARC_BUILD_VERSION")},"capabilities":{"experimentalApi":true}}),initialize_timeout).await?;
        if shared_desktop || (cfg!(target_os = "macos") && rpc.detached()) {
            let expected = crate::accounts::codex::default_home()?
                .canonicalize()
                .map_err(|e| e.to_string())?;
            let reported = Path::new(string(&initialized, "codexHome"))
                .canonicalize()
                .map_err(|e| e.to_string())?;
            if reported != expected {
                return Err("DESKTOP_DAEMON_HOME_MISMATCH".into());
            }
        }
        rpc.write(json!({"method":"initialized"})).await?;
        Ok(rpc)
    }
    pub fn alive(&self) -> bool {
        self.alive.load(std::sync::atomic::Ordering::SeqCst)
    }
    pub async fn health(&self) -> Value {
        if let Some(host) = &self.host {
            // A detached server may belong to an earlier Core, so it is not this
            // process's child. Its PID is verified by creation time on every read.
            let running = crate::codex_host::running(&host.profile);
            let resources = crate::resources::child_status(
                running.then_some(host.pid),
                Some(&self.inherited_nofile),
                "process exited or could not be checked",
            );
            return json!({"state":if self.alive(){"ready"}else{"stopped"},"pid":host.pid,"startedAt":self.started_at,"observedAt":now(),"evidence":"native-connector","stale":false,"resources":resources,"detached":true,"adopted":host.adopted});
        }
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
        match input.as_mut().ok_or("TRANSPORT_CLOSED")? {
            Writer::Stdio(stdin) => stdin
                .write_all(format!("{v}\n").as_bytes())
                .await
                .map_err(|e| e.to_string()),
            Writer::Socket(sink) => sink
                .send(Message::Text(v.to_string().into()))
                .await
                .map_err(|e| e.to_string()),
        }
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
    /// Close this connection. A detached server keeps running; only its proxy ends.
    pub async fn close(&self) {
        if self.host.is_some() || self.role == ConnectionRole::SharedDesktop {
            self.input.lock().await.take();
            let _ = self.child.lock().await.kill().await;
            self.alive.store(false, std::sync::atomic::Ordering::SeqCst);
            return;
        }
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

fn forward_stderr(mut stderr: tokio::process::ChildStderr) {
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
