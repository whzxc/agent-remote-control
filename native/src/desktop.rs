use crate::*;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
// Keep the receive bound aligned with Codex Desktop IPC (256 MiB).
// Screenshot-heavy conversation snapshots can exceed 32 MiB.
const MAX_DESKTOP_IPC_FRAME_BYTES: u32 = 256 * 1024 * 1024;
#[cfg(unix)]
use tokio::net::UnixStream;
#[cfg(unix)]
type DesktopStream = UnixStream;
#[cfg(windows)]
type DesktopStream = tokio::net::windows::named_pipe::NamedPipeClient;
mod interactions;
#[cfg(windows)]
mod windows;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{oneshot, Notify},
};
#[derive(Clone)]
pub struct Installation {
    pub app: PathBuf,
    pub binary: PathBuf,
}
#[cfg(not(windows))]
pub fn installation() -> Option<Installation> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    for root in [
        PathBuf::from("/Applications"),
        dirs::home_dir()?.join("Applications"),
    ] {
        for name in ["ChatGPT", "Codex"] {
            let app = root.join(format!("{name}.app"));
            let binary = app.join("Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
            if binary.is_file() {
                return Some(Installation { app, binary });
            }
        }
    }
    None
}
#[cfg(windows)]
pub fn installation() -> Option<Installation> {
    windows::installation()
}
pub fn require_installation() -> Result<Installation> {
    installation()
        .ok_or_else(|| "Install Codex Desktop and ensure its bundled Codex CLI is available".into())
}
const SNAPSHOT_TTL: Duration = Duration::from_secs(4);
struct Snapshot {
    received: Instant,
    value: Value,
    wire_bytes: usize,
}
const SNAPSHOT_BUDGET: usize = 32 * 1024 * 1024;
#[derive(Default)]
struct Snapshots {
    rows: HashMap<String, Snapshot>,
    evictions: u64,
}
impl Snapshots {
    fn prune(&mut self) {
        let before = self.rows.len();
        self.rows.retain(|_, s| s.received.elapsed() < SNAPSHOT_TTL);
        self.evictions += (before - self.rows.len()) as u64;
    }
    fn insert(&mut self, thread: String, value: Value, wire_bytes: usize) {
        self.prune();
        self.rows.remove(&thread);
        let mut bytes: usize = self.rows.values().map(|s| s.wire_bytes).sum();
        // One oversized frame remains readable until its TTL expires. Never
        // reject a supported native history because of the cache budget.
        while !self.rows.is_empty()
            && (self.rows.len() >= 64 || bytes.saturating_add(wire_bytes) > SNAPSHOT_BUDGET)
        {
            let oldest = self
                .rows
                .iter()
                .min_by_key(|(_, s)| s.received)
                .map(|(id, _)| id.clone())
                .unwrap();
            bytes -= self.rows.remove(&oldest).unwrap().wire_bytes;
            self.evictions += 1;
        }
        self.rows.insert(
            thread,
            Snapshot {
                received: Instant::now(),
                value,
                wire_bytes,
            },
        );
    }
    fn remove(&mut self, thread: &str) {
        self.rows.remove(thread);
    }
    fn get(&self, thread: &str) -> Option<&Snapshot> {
        self.rows.get(thread)
    }
    fn clear(&mut self) {
        self.rows.clear();
    }
    fn report(&self) -> Value {
        json!({"entries":self.rows.len(),"wireBytes":self.rows.values().map(|s| s.wire_bytes).sum::<usize>(),
            "budgetWireBytes":SNAPSHOT_BUDGET,"maxEntries":64,"ttlMs":SNAPSHOT_TTL.as_millis(),"evictions":self.evictions,
            "oversizedEntry":self.rows.values().any(|s| s.wire_bytes > SNAPSHOT_BUDGET)})
    }
}
type PendingRequests = Arc<std::sync::Mutex<HashMap<String, Pending>>>;
struct PendingCall {
    pending: PendingRequests,
    key: String,
}
impl Drop for PendingCall {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.key);
    }
}
struct Pending {
    tx: oneshot::Sender<Result<Value>>,
    target: Option<String>,
}
pub struct Ipc {
    writer: Arc<Mutex<tokio::io::WriteHalf<DesktopStream>>>,
    pending: PendingRequests,
    owners: Arc<Mutex<HashMap<String, String>>>,
    snapshots: Arc<Mutex<Snapshots>>,
    wake: Arc<Notify>,
    pub(crate) changes: Arc<Notify>,
    client: String,
    session: String,
    events: SharedEvents,
    reader: tokio::task::JoinHandle<()>,
    maintenance: tokio::task::JoinHandle<()>,
    alive: Arc<std::sync::atomic::AtomicBool>,
}
impl Drop for Ipc {
    fn drop(&mut self) {
        self.reader.abort();
        self.maintenance.abort();
    }
}
impl Ipc {
    pub async fn open(events: SharedEvents, session: &str) -> Result<Self> {
        #[cfg(unix)]
        let socket = {
            use std::os::unix::fs::{FileTypeExt, MetadataExt};
            let home = std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| dirs::home_dir().unwrap().join(".codex"));
            let socket = home.join("ipc/ipc.sock");
            let stat = std::fs::symlink_metadata(&socket).map_err(|e| e.to_string())?;
            if !stat.file_type().is_socket() || stat.uid() != unsafe { libc::geteuid() } {
                return Err("DESKTOP_SOCKET_OWNER_MISMATCH".into());
            }
            let socket = tokio::time::timeout(Duration::from_secs(3), UnixStream::connect(socket))
                .await
                .map_err(|_| "DESKTOP_CONNECT_TIMEOUT")?
                .map_err(|e| e.to_string())?;
            socket
        };
        #[cfg(windows)]
        let socket = windows::connect().await?;
        Self::connect(socket, events, session).await
    }
    async fn connect(socket: DesktopStream, events: SharedEvents, session: &str) -> Result<Self> {
        let (mut rd, wr) = tokio::io::split(socket);
        let writer = Arc::new(Mutex::new(wr));
        let pending: PendingRequests = Default::default();
        let owners: Arc<Mutex<HashMap<String, String>>> = Default::default();
        let snapshots: Arc<Mutex<Snapshots>> = Default::default();
        let wake = Arc::new(Notify::new());
        let changes = Arc::new(Notify::new());
        let changed = changes.clone();
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let (w, p, o, s, n, a) = (
            writer.clone(),
            pending.clone(),
            owners.clone(),
            snapshots.clone(),
            wake.clone(),
            alive.clone(),
        );
        let cleanup_snapshots = snapshots.clone();
        let maintenance = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            loop {
                interval.tick().await;
                cleanup_snapshots.lock().await.prune();
            }
        });
        let session = session.to_owned();
        let reader_session = session.clone();
        let reader_events = events.clone();
        let reader = tokio::spawn(async move {
            let session = reader_session;
            let events = reader_events;
            let mut revisions = HashMap::new();
            loop {
                let Ok(len) = rd.read_u32_le().await else {
                    break;
                };
                if len == 0 || len > MAX_DESKTOP_IPC_FRAME_BYTES {
                    break;
                }
                let mut bytes = vec![0; len as usize];
                if rd.read_exact(&mut bytes).await.is_err() {
                    break;
                }
                let _scope =
                    crate::runtime_metrics::Scope::new(crate::runtime_metrics::Work::DesktopFrame);
                let Ok(msg) = serde_json::from_slice::<Value>(&bytes) else {
                    continue;
                };
                match string(&msg, "type") {
                    "client-discovery-request" => {
                        let reply = json!({"type":"client-discovery-response","requestId":msg["requestId"],"response":{"canHandle":false}});
                        if Self::frame(&w, reply).await.is_err() {
                            break;
                        }
                    }
                    "response" => {
                        if let Some(request) = p.lock().unwrap().remove(string(&msg, "requestId")) {
                            let result = if msg["resultType"] == "error" {
                                Err(format!("DESKTOP_REJECTED:{}", msg["error"]))
                            } else if request
                                .target
                                .as_deref()
                                .is_some_and(|v| Some(v) != msg["handledByClientId"].as_str())
                            {
                                Err("DESKTOP_RESPONSE_OWNER_MISMATCH".into())
                            } else {
                                Ok(msg)
                            };
                            let _ = request.tx.send(result);
                        }
                    }
                    "broadcast" => {
                        if msg["method"] == "ipc-connection-reset" {
                            break;
                        }
                        if msg["method"] != "thread-stream-state-changed" {
                            continue;
                        }
                        if msg["version"] != 11 {
                            continue;
                        }
                        let params = &msg["params"];
                        if params["hostId"] != "local" {
                            continue;
                        }
                        let thread = string(params, "conversationId");
                        if o.lock().await.get(thread).map(String::as_str)
                            != msg["sourceClientId"].as_str()
                        {
                            continue;
                        }
                        let revision = params["change"]["revision"].as_u64();
                        let owner = string(&msg, "sourceClientId").to_owned();
                        let snapshot_frame = params["change"]["type"] == "snapshot";
                        let repeated = revision.is_some()
                            && revisions.get(thread) == Some(&(owner.clone(), revision, true));
                        if repeated && snapshot_frame {
                            let mut snapshots = s.lock().await;
                            if let Some(snapshot) = snapshots.rows.get_mut(thread) {
                                snapshot.received = Instant::now();
                            } else {
                                snapshots.insert(
                                    thread.into(),
                                    params["change"].clone(),
                                    len as usize,
                                );
                            }
                            n.notify_waiters();
                            continue;
                        }
                        if params["change"]["type"] == "snapshot" {
                            interactions::sync(
                                &events,
                                &params["change"]["conversationState"],
                                &session,
                            )
                            .await;
                            s.lock().await.insert(
                                thread.into(),
                                params["change"].clone(),
                                len as usize,
                            );
                        } else {
                            // Delta frames are not full snapshots. Request a fresh snapshot on the next read.
                            s.lock().await.remove(thread);
                        }
                        n.notify_waiters();
                        // Follow/read can repeat an unchanged snapshot. Wake task waiters
                        // only for a changed revision, not another reader's refresh.
                        if !revisions.contains_key(thread) && revisions.len() >= 2000 {
                            revisions.clear();
                        }
                        let previous = revisions
                            .insert(thread.to_owned(), (owner.clone(), revision, snapshot_frame));
                        if revision.is_none()
                            || previous.map(|r| (r.0, r.1)) != Some((owner, revision))
                        {
                            changed.notify_waiters();
                        }
                        let mut params = params.clone();
                        params["ownerClientId"] = msg["sourceClientId"].clone();
                        crate::event(
                            &events,
                            &session,
                            "desktop/thread-stream-state-changed",
                            params,
                        )
                        .await;
                    }
                    _ => (),
                }
            }
            a.store(false, std::sync::atomic::Ordering::SeqCst);
            s.lock().await.clear();
            o.lock().await.clear();
            for (_, r) in p.lock().unwrap().drain() {
                let _ = r.tx.send(Err("DESKTOP_DISCONNECTED".into()));
            }
            n.notify_waiters();
            changed.notify_waiters();
            events.lock().await.wake.notify_waiters();
        });
        let mut ipc = Self {
            writer,
            pending,
            owners,
            snapshots,
            wake,
            changes,
            client: String::new(),
            session,
            events,
            reader,
            maintenance,
            alive,
        };
        let init = ipc
            .request(
                "initialize",
                json!({"clientType":"agent-remote-control"}),
                None,
            )
            .await?;
        ipc.client = string(&init["result"], "clientId").into();
        Ok(ipc)
    }
    async fn frame(w: &Arc<Mutex<tokio::io::WriteHalf<DesktopStream>>>, v: Value) -> Result<()> {
        let bytes = serde_json::to_vec(&v).map_err(|e| e.to_string())?;
        let mut w = w.lock().await;
        w.write_u32_le(bytes.len() as u32)
            .await
            .map_err(|e| e.to_string())?;
        w.write_all(&bytes).await.map_err(|e| e.to_string())
    }
    async fn write(&self, v: Value) -> Result<()> {
        let result = Self::frame(&self.writer, v).await;
        if result.is_err() {
            self.alive.store(false, std::sync::atomic::Ordering::SeqCst);
        }
        result
    }
    pub(crate) async fn diagnostics(&self) -> Value {
        let mut snapshots = self.snapshots.lock().await;
        snapshots.prune();
        let pending = self.pending.lock().unwrap().len();
        let owners = self.owners.lock().await.len();
        json!({"connected":self.alive(),"pendingRequests":pending,
            "owners":owners,"snapshots":snapshots.report()})
    }
    pub fn alive(&self) -> bool {
        self.alive.load(std::sync::atomic::Ordering::SeqCst)
    }
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        target: Option<&str>,
    ) -> Result<Value> {
        if !self.alive() {
            return Err("DESKTOP_DISCONNECTED".into());
        }
        let submitted_error = |e: String| {
            if matches!(
                method,
                "thread-follower-start-turn"
                    | "thread-follower-steer-turn"
                    | "thread-follower-interrupt-turn"
                    | "thread-follower-command-approval-decision"
                    | "thread-follower-file-approval-decision"
                    | "thread-follower-permissions-request-approval-response"
                    | "thread-follower-submit-user-input"
                    | "thread-follower-submit-mcp-server-elicitation-response"
            ) && !e.starts_with("DESKTOP_REJECTED")
                && e != "DESKTOP_RESPONSE_OWNER_MISMATCH"
            {
                format!("SUBMISSION_UNCONFIRMED: {e}")
            } else {
                e
            }
        };
        let request_id = id();
        let (tx, rx) = oneshot::channel();
        let base = match method {
            "thread-owner-discovery"
            | "thread-stream-following-changed"
            | "thread-follower-steer-turn"
            | "thread-follower-load-complete-history"
            | "thread-follower-command-approval-decision"
            | "thread-follower-file-approval-decision"
            | "thread-follower-permissions-request-approval-response"
            | "thread-follower-submit-user-input"
            | "thread-follower-submit-mcp-server-elicitation-response" => 1,
            "thread-follower-start-turn" | "thread-follower-update-thread-settings" => 2,
            "thread-follower-interrupt-turn" => 4,
            _ => 0,
        };
        let version = base + u32::from(target.is_some() && method.starts_with("thread-follower-"));
        let mut msg = json!({"type":"request","requestId":request_id,"sourceClientId":self.client,"method":method,"version":version,"params":params});
        if let Some(t) = target {
            msg["targetClientId"] = json!(t);
            msg["hostId"] = json!("local");
        }
        self.pending.lock().unwrap().insert(
            request_id.clone(),
            Pending {
                tx,
                target: target.map(str::to_owned),
            },
        );
        let _pending = PendingCall {
            pending: self.pending.clone(),
            key: request_id.clone(),
        };
        if let Err(e) = self.write(msg).await {
            self.alive.store(false, std::sync::atomic::Ordering::SeqCst);
            return Err(submitted_error(e));
        }
        let out = tokio::time::timeout(
            Duration::from_secs(if method == "thread-owner-discovery" {
                1
            } else {
                30
            }),
            rx,
        )
        .await;
        out.map_err(|_| format!("DESKTOP_REQUEST_TIMEOUT: {method}"))
            .and_then(|v| v.map_err(|_| "DESKTOP_DISCONNECTED".to_string()))
            .and_then(|v| v)
            .map_err(submitted_error)
    }
    pub async fn owner(&self, thread: &str) -> Result<String> {
        let r = self
            .request(
                "thread-owner-discovery",
                json!({"hostId":"local","conversationId":thread}),
                None,
            )
            .await?;
        let owner = r["handledByClientId"]
            .as_str()
            .ok_or("DESKTOP_OWNER_NOT_FOUND")?
            .to_owned();
        let previous = self
            .owners
            .lock()
            .await
            .insert(thread.into(), owner.clone());
        if previous.as_ref().is_some_and(|v| v != &owner) {
            self.snapshots.lock().await.remove(thread);
        }
        Ok(owner)
    }
    pub async fn follow(&self, thread: &str) -> Result<()> {
        let known = self.owners.lock().await.get(thread).cloned();
        let owner = match known {
            Some(owner) => owner,
            None => self.owner(thread).await?,
        };
        self.follow_owner(thread, &owner).await
    }
    async fn follow_owner(&self, thread: &str, owner: &str) -> Result<()> {
        self.write(json!({"type":"broadcast","sourceClientId":self.client,"targetClientIds":[owner],"method":"thread-stream-following-changed","version":1,"params":{"hostId":"local","conversationId":thread,"following":true}})).await
    }
    async fn wait(&self, thread: &str, revision: u64) -> Result<Value> {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let wake = self.wake.notified();
                tokio::pin!(wake);
                wake.as_mut().enable();
                if !self.alive() {
                    return Err("DESKTOP_DISCONNECTED".into());
                }
                if let Some(s) = self.snapshots.lock().await.get(thread) {
                    if s.received.elapsed() < SNAPSHOT_TTL
                        && s.value["revision"].as_u64().unwrap_or(0) >= revision
                    {
                        return Ok(s.value["conversationState"].clone());
                    }
                }
                wake.await;
            }
        })
        .await
        .map_err(|_| "DESKTOP_SNAPSHOT_TIMEOUT")?
    }
    pub async fn read(&self, thread: &str, complete: bool) -> Result<Value> {
        if let Some(state) = self.snapshot(thread).await {
            if !complete || state["turnHistory"]["history"]["isComplete"] == true {
                return Ok(state);
            }
        }
        let owner = self.owner(thread).await?;
        self.read_owned(thread, complete, &owner).await
    }
    pub(crate) async fn read_owned(
        &self,
        thread: &str,
        complete: bool,
        owner: &str,
    ) -> Result<Value> {
        let mut state = match self.snapshot(thread).await {
            Some(state) => state,
            None => {
                self.follow_owner(thread, owner).await?;
                self.wait(thread, 0).await?
            }
        };
        if complete && state["turnHistory"]["history"]["isComplete"] != true {
            let r = self
                .request(
                    "thread-follower-load-complete-history",
                    json!({"conversationId":thread}),
                    Some(&owner),
                )
                .await?;
            state = self
                .wait(
                    thread,
                    r["result"]["revision"]
                        .as_u64()
                        .ok_or("DESKTOP_HISTORY_INCOMPLETE")?,
                )
                .await?;
        }
        Ok(crate::acceptance_fault::snapshot(thread, state))
    }
    pub async fn snapshot(&self, thread: &str) -> Option<Value> {
        if !self.alive() {
            return None;
        }
        let mut snapshots = self.snapshots.lock().await;
        snapshots.prune();
        snapshots.get(thread).map(|s| {
            crate::acceptance_fault::snapshot(thread, s.value["conversationState"].clone())
        })
    }
    pub async fn mutate(&self, method: &str, args: &Value) -> Result<Value> {
        let thread = string(args, "threadId");
        let known_owner = self.owners.lock().await.get(thread).cloned();
        let owner = match known_owner {
            Some(owner) => owner,
            None => self.owner(thread).await?,
        };
        let _ = self.follow_owner(thread, &owner).await;
        match method {
            "turn/start" => {
                let mut args = args.clone();
                if !(args["turnTrigger"] == "resume_interrupted_task"
                    && args["parentTurnId"].is_string()
                    && args["input"].as_array().is_some_and(Vec::is_empty))
                {
                    args["input"] = input(&args["input"])?;
                }
                // Desktop inherits collaborationMode separately from model/effort;
                // its settings take precedence when App Server starts the turn.
                if args["collaborationMode"].is_null() {
                    let state = self.read_owned(thread, false, &owner).await?;
                    let settings = &state["latestThreadSettings"];
                    if args["model"].is_null() {
                        let model = settings["model"]
                            .as_str()
                            .filter(|model| !model.is_empty())
                            .unwrap_or_else(|| string(&state, "latestModel"));
                        if !model.is_empty() {
                            args["model"] = json!(model);
                        }
                    }
                    let mut mode = settings
                        .get("collaborationMode")
                        .filter(|mode| mode.is_object())
                        .unwrap_or(&state["latestCollaborationMode"])
                        .clone();
                    if mode.is_object() {
                        if !args["model"].is_null() {
                            mode["settings"]["model"] = args["model"].clone();
                        }
                        if let Some(effort) = args.get("effort") {
                            mode["settings"]["reasoning_effort"] = effort.clone();
                        }
                        args["collaborationMode"] = mode;
                    }
                }
                // Persist the same overrides through the owner before starting the turn.
                // Desktop's next-turn defaults and collaboration settings are separate
                // from the App Server request and must agree with explicit dispatches.
                let mut settings = serde_json::Map::new();
                for key in [
                    "model",
                    "effort",
                    "collaborationMode",
                    "serviceTier",
                    "cwd",
                    "sandboxPolicy",
                    "permissions",
                    "approvalPolicy",
                    "approvalsReviewer",
                ] {
                    if let Some(value) = args.get(key) {
                        settings.insert(key.into(), value.clone());
                    }
                }
                if !settings.is_empty() {
                    let updated = self
                        .request(
                            "thread-follower-update-thread-settings",
                            json!({"conversationId":thread,"threadSettings":settings}),
                            Some(&owner),
                        )
                        .await?;
                    if updated["result"]["applied"] != true {
                        return Err("DESKTOP_REJECTED: thread settings not applied".into());
                    }
                }
                let r = self
                    .request(
                        "thread-follower-start-turn",
                        json!({"conversationId":thread,"turnStart":{"request":args,"context":{}}}),
                        Some(&owner),
                    )
                    .await?;
                Ok(r["result"]["result"].clone())
            }
            "turn/steer" => {
                let state = self.read_owned(thread, true, &owner).await?;
                let params = steer_params(&state, args)?;
                let r = self
                    .request("thread-follower-steer-turn", params, Some(&owner))
                    .await.map_err(|error| {
                        if error.contains("thread-follower-steer-turn-timeout") {
                            format!("SUBMISSION_UNCONFIRMED: Desktop did not confirm steering; read the original receipt and codex_read for thread {thread}; do not replay or switch execution owners")
                        } else { error }
                    })?;
                Ok(r["result"]["result"].clone())
            }
            "turn/interrupt" => {
                if string(args, "turnId").is_empty() {
                    return Err("DESKTOP_TURN_ID_REQUIRED".into());
                }
                let r=self.request("thread-follower-interrupt-turn",json!({"conversationId":thread,"mode":"user-stop","expectedTurnId":args["turnId"]}),Some(&owner)).await?;
                if r["result"]["ok"] != true {
                    return Err("DESKTOP_REJECTED: interrupt not accepted".into());
                }
                Ok(json!({}))
            }
            _ => Err(format!("DESKTOP_METHOD_UNSUPPORTED: {method}")),
        }
    }
}
pub(crate) fn check_steer(state: &Value, thread: &str, expected: &Value) -> Result<()> {
    let history = &state["turnHistory"]["history"];
    let tail = history["islands"]
        .as_array()
        .and_then(|islands| islands.last());
    let selected = tail
        .and_then(|island| island["entries"].as_array())
        .into_iter()
        .flatten()
        .rev()
        .filter_map(|entry| history["entitiesByKey"].get(string(entry, "value")))
        .find(|turn| {
            turn["turnId"].is_string() || !matches!(string(turn, "status"), "completed" | "failed")
        });
    if tail.is_none_or(|island| island["newerBoundary"]["status"] != "exhausted")
        || selected.is_none_or(|turn| {
            !turn["turnId"].is_string()
                || turn["turnId"] != *expected
                || turn["status"] != "inProgress"
        })
    {
        return Err(json!({"code":"DESKTOP_STEER_UNAVAILABLE","message":"Desktop's follower selects an unconfirmed or different turn. Steering was not submitted. Keep the queued message pending until the current turn ends, or explicitly submit codex_send with sendMode:queue. ARC will not switch owners or start another turn as a steering fallback.","retryable":false,"threadId":thread,"next":{"via":"query","op":"codex_queue","args":{"threadId":thread},"hint":"Inspect the queue; an unsuccessful promotion leaves the message queued. Use codex_read statusOnly:true for the current native turn."}}).to_string());
    }
    Ok(())
}
pub(crate) fn steer_params(state: &Value, args: &Value) -> Result<Value> {
    check_steer(state, string(args, "threadId"), &args["expectedTurnId"])?;
    let message = id();
    Ok(
        json!({"conversationId":args["threadId"],"input":input(&args["input"])? ,"attachments":[],"clientUserMessageId":message,"serviceTier":args["serviceTier"],"restoreMessage":{"id":message,"cwd":state["cwd"],"context":{"workspaceRoots":state["cwd"].as_str().map(|cwd| vec![cwd]).unwrap_or_default(),"commentAttachments":[]}}}),
    )
}
pub fn turns(state: &Value) -> Result<Vec<Value>> {
    let h = &state["turnHistory"]["history"];
    if state["turnHistory"]["kind"] != "canonical" || h["isComplete"] != true {
        return Err("DESKTOP_HISTORY_INCOMPLETE".into());
    }
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for island in h["islands"].as_array().into_iter().flatten() {
        for entry in island["entries"].as_array().into_iter().flatten() {
            let mut t = h["entitiesByKey"][string(entry, "value")].clone();
            if let Some(id) = t["turnId"].as_str() {
                if seen.insert(id.to_owned()) {
                    t["id"] = t["turnId"].clone();
                    out.push(t);
                }
            }
        }
    }
    Ok(out)
}
pub fn input(v: &Value) -> Result<Value> {
    let rows = v
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or("DESKTOP_INPUT_REQUIRED")?;
    let mut out = Vec::new();
    for row in rows {
        if row["type"] != "text"
            || !row["text"].is_string()
            || row
                .get("text_elements")
                .is_some_and(|x| x.as_array().is_none_or(|a| !a.is_empty()))
        {
            return Err("DESKTOP_INPUT_UNSUPPORTED: only plain text is supported".into());
        }
        out.push(json!({"type":"text","text":row["text"],"text_elements":[]}))
    }
    Ok(json!(out))
}
pub async fn open_thread(thread: &str) -> Result<Value> {
    crate::agents::driver::AgentDriver::CodexNative
        .open_task(thread)
        .await
}
pub async fn reveal(ipc: &Ipc, thread: &str) -> Result<Value> {
    let opened = open_thread(thread).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        match ipc.owner(thread).await {
            Ok(_) => {
                return Ok(
                    json!({"state":"owner-confirmed","sharedBackend":false,"url":opened["url"]}),
                )
            }
            Err(e) if owner_discovery_pending(&e) && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(250)).await
            }
            Err(e) => return Err(e),
        }
    }
}

pub fn owner_discovery_pending(error: &str) -> bool {
    owner_missing(error) || error == "DESKTOP_REQUEST_TIMEOUT: thread-owner-discovery"
}

pub(crate) fn owner_missing(error: &str) -> bool {
    error == "DESKTOP_OWNER_NOT_FOUND" || error == "DESKTOP_REJECTED:\"no-client-found\""
}

pub async fn open_app() -> Result<()> {
    open_url(None).await
}
pub(crate) async fn open_url(url: Option<&str>) -> Result<()> {
    #[cfg(feature = "test-fixture")]
    if let Some(path) = std::env::var_os("ARC_FIXTURE_OPEN_FILE") {
        std::fs::write(path, url.unwrap_or("codex://")).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if cfg!(target_os = "linux") {
        return Err("DESKTOP_UNSUPPORTED: headless Linux has no Codex Desktop.".into());
    }
    let installation = require_installation()?;
    #[cfg(windows)]
    {
        let _ = installation;
        windows::open(url.unwrap_or("codex://"))
    }
    #[cfg(not(windows))]
    {
        let mut args = vec!["-a", installation.app.to_str().ok_or("invalid path")?];
        if let Some(url) = url {
            args.push(url);
        }
        output("/usr/bin/open", &args).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    async fn diagnostic_fixture() -> (Ipc, tokio::task::JoinHandle<()>) {
        let (client, mut server) = UnixStream::pair().unwrap();
        let peer = tokio::spawn(async move {
            loop {
                let Ok(len) = server.read_u32_le().await else {
                    break;
                };
                let mut data = vec![0; len as usize];
                if server.read_exact(&mut data).await.is_err() {
                    break;
                }
                let request: Value = serde_json::from_slice(&data).unwrap();
                let method = string(&request, "method");
                let response = match method {
                    "initialize" => {
                        json!({"type":"response","requestId":request["requestId"],"result":{"clientId":"fixture-client"}})
                    }
                    "thread-owner-discovery" => {
                        json!({"type":"response","requestId":request["requestId"],"handledByClientId":"fixture-owner","result":{}})
                    }
                    "thread-stream-following-changed" => {
                        json!({"type":"broadcast","method":"thread-stream-state-changed","version":11,"sourceClientId":"fixture-owner",
                        "params":{"hostId":"local","conversationId":request["params"]["conversationId"],"change":{"type":"snapshot","revision":1,"conversationState":{
                            "id":request["params"]["conversationId"],"turnHistory":{"history":{"isComplete":true}},"fixture":"x".repeat(512*1024)}}}})
                    }
                    _ => continue, // Deliberately never answer the cancelled read.
                };
                let bytes = serde_json::to_vec(&response).unwrap();
                if server.write_u32_le(bytes.len() as u32).await.is_err() {
                    break;
                }
                if server.write_all(&bytes).await.is_err() {
                    break;
                }
            }
        });
        (
            Ipc::connect(client, Default::default(), "fixture")
                .await
                .unwrap(),
            peer,
        )
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_desktop_requests_release_pending_storage() {
        // Regression: outer notification timeouts abandoned Desktop IPC pending requests indefinitely.
        let (ipc, peer) = diagnostic_fixture().await;
        for _ in 0..32 {
            assert!(tokio::time::timeout(
                Duration::from_millis(2),
                ipc.request("fixture-unanswered-read", json!({}), None)
            )
            .await
            .is_err());
        }
        assert_eq!(ipc.diagnostics().await["pendingRequests"], 0);
        assert_eq!(
            ipc.owner("after-cancellation").await.unwrap(),
            "fixture-owner"
        );
        drop(ipc);
        peer.await.unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn desktop_snapshots_are_bounded_and_expire_without_rereading_old_threads() {
        // Regression: visited Desktop histories accumulated because TTL cleanup only visited the requested key.
        let (ipc, peer) = diagnostic_fixture().await;
        for n in 0..80 {
            let thread = format!("fixture-{n}");
            assert_eq!(ipc.read(&thread, true).await.unwrap()["id"], thread);
        }
        let report = ipc.diagnostics().await;
        assert!(report["snapshots"]["entries"].as_u64().unwrap() <= 64);
        assert!(report["snapshots"]["wireBytes"].as_u64().unwrap() <= 32 * 1024 * 1024);
        assert!(report["snapshots"]["evictions"].as_u64().unwrap() > 0);
        // Native history remains available after eviction; retention is not authorization.
        assert_eq!(
            ipc.read("fixture-0", true).await.unwrap()["id"],
            "fixture-0"
        );
        tokio::time::sleep(Duration::from_millis(4100)).await;
        assert_eq!(ipc.diagnostics().await["snapshots"]["entries"], 0);
        drop(ipc);
        peer.await.unwrap();
    }
    #[test]
    fn only_definite_missing_owner_allows_loading_fallback() {
        // Property: only definite missing owner allows loading fallback.
        assert!(owner_missing("DESKTOP_REJECTED:\"no-client-found\""));
        assert!(owner_missing("DESKTOP_OWNER_NOT_FOUND"));
        for error in [
            "SUBMISSION_UNCONFIRMED: no-client-found",
            "DESKTOP_DISCONNECTED",
            "DESKTOP_REQUEST_TIMEOUT: thread-follower-start-turn",
            "DESKTOP_REJECTED: permission denied",
        ] {
            assert!(!owner_missing(error));
        }
    }
}
