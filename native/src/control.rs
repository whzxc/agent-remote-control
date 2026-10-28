use crate::*;
use crate::{
    desktop::{self, Ipc},
    rpc::Rpc,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::{collections::HashMap, time::Duration};
pub struct Control {
    pub session: String,
    pub events: SharedEvents,
    pub(crate) shutdown: tokio::sync::watch::Sender<u64>,
    binary: PathBuf,
    rpc: Mutex<Option<Arc<Rpc>>>,
    monitor: Mutex<Option<Arc<Ipc>>>,
    jobs: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    schemas: Mutex<Option<Value>>,
    requests: crate::kernel::receipts::RequestLocks,
    pub(crate) projects: Mutex<Option<(std::time::Instant, Vec<Value>)>>,
    task_records: Mutex<crate::kernel::file_cache::Projection<Vec<Value>>>,
}
const RECEIPTS: crate::kernel::receipts::ReceiptStore =
    crate::kernel::receipts::ReceiptStore::new("");
// Fresh creations have no user history and may not be materialized until turn/start.
async fn submission_history<F, Fut>(fresh_thread: bool, mut list: F) -> Result<Vec<Value>>
where
    F: FnMut(Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value>>,
{
    let mut turns = Vec::new();
    if fresh_thread {
        return Ok(turns);
    }
    let mut cursor = Value::Null;
    loop {
        let page = list(cursor.clone()).await?;
        turns.extend(
            page["data"]
                .as_array()
                .ok_or("native-turns-missing")?
                .iter()
                .cloned(),
        );
        let next = page["nextCursor"].clone();
        if next.is_null() {
            break;
        }
        if next == cursor {
            return Err("native-turn-cursor-repeated".into());
        }
        cursor = next;
    }
    turns.reverse();
    Ok(turns)
}
fn unmaterialized_thread(error: &str) -> bool {
    error.contains("is not materialized yet")
}
fn cleanup_result(result: Result<Value>) -> Result<Value> {
    match result {
        Ok(_) => Ok(json!({"archived":true})),
        Err(error) if unmaterialized_thread(&error) => {
            Ok(json!({"archived":false,"reason":"thread-not-materialized"}))
        }
        Err(error) => Err(error),
    }
}
tokio::task_local! { static REPLACEMENT_RESUME: bool; }

impl Control {
    pub fn new(binary: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            session: id(),
            events: Default::default(),
            shutdown: tokio::sync::watch::channel(0).0,
            binary,
            rpc: Mutex::new(None),
            monitor: Mutex::new(None),
            jobs: Default::default(),
            schemas: Mutex::new(None),
            requests: Default::default(),
            projects: Default::default(),
            task_records: Default::default(),
        })
    }
    fn rpc_binary(&self) -> Result<PathBuf> {
        if cfg!(target_os = "linux") && !cfg!(feature = "test-fixture") {
            crate::agents::codex_binary().ok_or_else(|| "CODEX_NOT_FOUND: install Codex CLI and log in as this user; searched PATH, ~/.local/bin, /usr/local/bin, npm global prefixes, nvm, bun and Volta directories.".into())
        } else {
            Ok(self.binary.clone())
        }
    }
    pub(crate) async fn runtime_metrics(&self) -> Value {
        let mut result = crate::runtime_metrics::snapshot();
        result["instance"] = json!(self.session);
        let monitor = self.monitor.lock().await.clone();
        result["desktopIpc"] = match monitor {
            Some(ipc) => ipc.diagnostics().await,
            None => json!({"connected":false,"pendingRequests":0,"owners":0,"snapshots":null}),
        };
        let events = self.events.lock().await;
        result["events"] = json!({"rows":events.rows.len(),"wireBytes":events.bytes,"timelines":events.timelines.len(),
            "timelineEntries":events.timelines.values().map(|t| t.entries.len()).sum::<usize>(),"pendingInteractions":events.pending.len()});
        result
    }
    pub async fn utility(&self) -> Result<Arc<Rpc>> {
        let mut rpc = self.rpc.lock().await;
        if rpc.as_ref().is_none_or(|r| !r.alive()) {
            *rpc = Some(Rpc::start(&self.rpc_binary()?, self.events.clone(), &self.session).await?)
        }
        Ok(rpc.as_ref().unwrap().clone())
    }
    pub async fn account_rate_limits(&self) -> Result<Value> {
        // A short-lived reader follows the current native login on each refresh.
        let rpc = Rpc::start(&self.rpc_binary()?, Default::default(), &id()).await?;
        let result = rpc.call("account/rateLimits/read", json!({}), 15000).await;
        rpc.close().await;
        result
    }
    pub(crate) async fn ipc(&self) -> Result<Arc<Ipc>> {
        if cfg!(target_os = "linux") {
            return Err("DESKTOP_UNSUPPORTED: headless Linux uses Codex CLI app-server.".into());
        }
        let mut ipc = self.monitor.lock().await;
        if ipc.as_ref().is_none_or(|i| !i.alive()) {
            *ipc = Some(Arc::new(
                Ipc::open(self.events.clone(), &self.session).await?,
            ));
        }
        Ok(ipc.as_ref().unwrap().clone())
    }
    async fn follow(&self, thread: &str) -> Result<()> {
        self.ipc().await?.follow(thread).await
    }
    /// Sample only existing observation streams. Never start an app-server, discover
    /// an owner or turn persisted running history into a fresh liveness claim.
    pub(crate) async fn coordination_observations(
        &self,
        threads: &[String],
    ) -> Vec<(String, String, String)> {
        let rpc = self.rpc.lock().await.clone();
        let monitor = self.monitor.lock().await.clone();
        let connected = (rpc.is_some() || monitor.is_some())
            && rpc.as_ref().is_none_or(|r| r.alive())
            && monitor.as_ref().is_none_or(|m| m.alive());
        let events = self.events.lock().await;
        threads
            .iter()
            .filter_map(|thread| {
                events.timelines.get(thread).map(|t| {
                    (
                        thread.clone(),
                        t.turn.clone(),
                        if connected && !t.observation_lost && t.observed_events > 0 {
                            t.status.clone()
                        } else {
                            "unknown".into()
                        },
                    )
                })
            })
            .collect()
    }
    pub async fn health(&self) -> Value {
        // Reading diagnostics never calls utility(), which can start app-server.
        let rpc = self.rpc.lock().await.clone();
        let app_server = match rpc {
            Some(rpc) => rpc.health().await,
            None => {
                json!({"state":"stopped","pid":null,"startedAt":null,"observedAt":now(),"evidence":"native-connector","stale":false,"resources":crate::resources::child_status(None,None,"app-server has not been started")})
            }
        };
        json!({"appServer":app_server,"resources":crate::resources::core_status(),"activeWrites":self.jobs.lock().await.len()})
    }
    pub fn stop_waits(&self) {
        self.shutdown.send_modify(|v| *v = v.wrapping_add(1));
    }
    pub async fn close(&self) {
        if let Err(error) = crate::app_replace::capture_shutdown(self).await {
            crate::logs::record(
                "ERROR",
                &format!("Replacement shutdown snapshot failed: {error}"),
                None,
            );
        }
        self.stop_waits();
        let jobs: Vec<_> = self.jobs.lock().await.drain().collect();
        for (request, job) in jobs {
            job.abort();
            let _ = job.await;
            if let Ok(mut receipt) = load(&root().join(format!("{request}.json"))) {
                if !matches!(
                    string(&receipt, "state"),
                    "completed" | "failed" | "rejected" | "not-executed" | "unconfirmed"
                ) {
                    receipt["previousState"] = receipt["state"].clone();
                    receipt["state"] = json!("unconfirmed");
                    let _ = self.checkpoint(&mut receipt);
                }
            }
        }
        self.monitor.lock().await.take();
        if let Some(rpc) = self.rpc.lock().await.take() {
            rpc.close().await;
        }
    }
    pub fn auto_open_codex(&self) -> Result<bool> {
        if cfg!(target_os = "linux") {
            return Ok(false);
        }
        let path = root().join("task-settings.json");
        Ok(!path.exists() || load(&path)?["autoOpenCodex"] != false)
    }
    pub(crate) fn background(&self, thread: &str) -> Result<bool> {
        if cfg!(target_os = "linux") {
            return Ok(!thread.is_empty());
        }
        if uuid::Uuid::parse_str(thread).is_err() {
            return Ok(false);
        }
        let path = root().join("execution").join(format!("{thread}.json"));
        Ok(path.exists() && crate::kernel::file_cache::load(&path)?["owner"] == "connector")
    }
    fn handed_to_desktop(&self, thread: &str) -> bool {
        crate::claude_notify::ownership::read(thread)
            .ok()
            .is_some_and(|state| {
                state["currentOwner"] == "desktop"
                    || state["history"]
                        .as_array()
                        .is_some_and(|history| history.iter().any(|row| row["to"] == "desktop"))
            })
    }
    pub(crate) async fn effective_background(&self, thread: &str) -> Result<bool> {
        let background = self.background(thread)?;
        if !background || cfg!(target_os = "linux") {
            return Ok(background);
        }
        if self.handed_to_desktop(thread) {
            return Ok(false);
        }
        if crate::writer::probe(thread)["state"] == "held" {
            let owner = self.writer_ownership(thread).await;
            if owner["owner"] == "desktop" {
                crate::claude_notify::ownership::observe(thread, &owner).await?;
                return Ok(false);
            }
        }
        Ok(true)
    }
    async fn create_background(
        &self,
        args: Value,
        title: &str,
        receipt: Option<&mut Value>,
    ) -> Result<Value> {
        if args["ephemeral"] == true {
            return Err("BACKGROUND_TASK_MUST_PERSIST".into());
        }
        let title = dispatch_title(
            &json!({"title":title,"prompt":receipt.as_deref().map(|r| &r["task"]["prompt"])}),
        );
        let rpc = self.utility().await?;
        let mut args = args;
        args["ephemeral"] = json!(false);
        let result = rpc.call("thread/start", args, 60000).await?;
        let thread = string(&result["thread"], "id");
        if uuid::Uuid::parse_str(thread).is_ok() {
            save(
                &root().join("execution").join(format!("{thread}.json")),
                &json!({"owner":"connector"}),
            )?;
        }
        if let Some(r) = receipt {
            r["threadId"] = json!(thread);
            r["task"]["directory"] = result["thread"]["cwd"].clone();
            r["state"] = json!("thread-created");
            self.checkpoint(r)?;
        }
        if !title.is_empty() {
            rpc.call(
                "thread/name/set",
                json!({"threadId":thread,"name":title}),
                60000,
            )
            .await?;
        }
        Ok(result)
    }
    async fn background_request(
        &self,
        method: &str,
        mut args: Value,
        timeout: u64,
    ) -> Result<Value> {
        let rpc = self.utility().await?;
        if method == "thread/resume" && args.get("excludeTurns").is_none() {
            args["excludeTurns"] = json!(true);
        }
        // Resume only an explicit new-turn write; reads and interrupts never restart a task.
        if method == "turn/start" {
            let state = rpc
                .call(
                    "thread/read",
                    json!({"threadId":args["threadId"],"includeTurns":false}),
                    60000,
                )
                .await?;
            if state["thread"]["status"]["type"] == "notLoaded" {
                let thread = string(&args, "threadId");
                // Record the triggering source before the observer can see acquisition.
                self.observe_ownership(thread).await?;
                let token = crate::claude_notify::ownership::begin_acquisition(thread).await?;
                let resumed = rpc
                    .call(
                        "thread/resume",
                        json!({"threadId":thread,"excludeTurns":true}),
                        60000,
                    )
                    .await;
                // An uncertain resume may still have acquired the writer.
                let _ = self.observe_ownership(thread).await;
                crate::claude_notify::ownership::end_acquisition(thread, &token).await?;
                resumed?;
            }
        }
        let mut result = rpc.call(method, args, timeout).await?;
        if method == "thread/read" {
            result["thread"]["runtimeSource"] = json!("connector-app-server");
        }
        Ok(result)
    }
    async fn seed(
        &self,
        args: Value,
        title: &str,
        mut receipt: Option<&mut Value>,
    ) -> Result<Value> {
        #[cfg(not(feature = "test-fixture"))]
        self.ipc().await?;
        if args["ephemeral"] == true {
            return Err("DESKTOP_TASK_MUST_PERSIST".into());
        }
        let started = std::time::Instant::now();
        let seed = Rpc::start(&self.rpc_binary()?, Default::default(), &id()).await?;
        let mut timings = json!({"initializeMs":started.elapsed().as_millis()});
        let mut created = None;
        let derived = dispatch_title(
            &json!({"title":title,"prompt":receipt.as_deref().map(|r| &r["task"]["prompt"])}),
        );
        let title = if derived.is_empty() {
            "ARC task".into()
        } else {
            derived
        };
        let result = async {
            let mut args = args;
            args["ephemeral"] = json!(false);
            let step = std::time::Instant::now();
            let response = seed.call("thread/start", args, 60000).await;
            timings["startMs"] = json!(step.elapsed().as_millis());
            let mut response = response?;
            let thread = string(&response["thread"], "id");
            created = Some(thread.to_owned());
            if let Some(r) = receipt.as_deref_mut() {
                r["threadId"] = json!(thread);
                if r["task"].is_object() {
                    r["task"]["directory"] = response["thread"]["cwd"].clone();
                }
                r["state"] = json!("thread-created");
                self.checkpoint(r)?;
            }
            // New threads are lazy: metadata reads do not materialize a rollout.
            // Naming persists it without submitting a turn or hydrating history.
            let step = std::time::Instant::now();
            let named = seed
                .call(
                    "thread/name/set",
                    json!({"threadId":thread,"name":title}),
                    60000,
                )
                .await;
            timings["nameMs"] = json!(step.elapsed().as_millis());
            named?;
            // An independent reader must see the durable thread before Desktop
            // takes ownership. thread.path is nullable and not a readiness signal.
            let reader = self.utility().await?;
            let step = std::time::Instant::now();
            let persisted = reader
                .call(
                    "thread/read",
                    json!({"threadId":thread,"includeTurns":false}),
                    60000,
                )
                .await;
            timings["readMs"] = json!(step.elapsed().as_millis());
            let persisted = persisted?;
            seed.call("thread/unsubscribe", json!({"threadId":thread}), 60000)
                .await?;
            response["thread"] = persisted["thread"].clone();
            Ok(response)
        }
        .await;
        if result.is_err() {
            if let Some(thread) = created {
                // This private seed has never been revealed or received a turn.
                // Clean it up on its owner even if materialization failed.
                let cleanup = seed
                    .call("thread/archive", json!({"threadId":thread}), 60000)
                    .await;
                let cleanup = cleanup_result(cleanup)
                    .unwrap_or_else(|error| json!({"archived":false,"error":error}));
                if let Some(r) = receipt.as_deref_mut() {
                    r["cleanup"] = cleanup;
                } else if cleanup["error"].is_string() {
                    crate::logs::record(
                        "WARN",
                        &format!("Seed {thread} cleanup failed: {}", cleanup["error"]),
                        None,
                    );
                }
            }
        }
        let step = std::time::Instant::now();
        seed.close().await;
        timings["closeMs"] = json!(step.elapsed().as_millis());
        timings["totalMs"] = json!(started.elapsed().as_millis());
        if let Some(r) = receipt {
            r["seedTimings"] = timings;
            self.checkpoint(r)?;
        }
        result
    }
    pub(crate) async fn writer_ownership(&self, thread: &str) -> Value {
        let mut result = crate::writer::probe(thread);
        result["threadId"] = json!(thread);
        if result["state"] != "held" {
            return result;
        }
        if self.background(thread).unwrap_or(false) {
            let read = tokio::time::timeout(Duration::from_millis(1500), async {
                self.utility()
                    .await?
                    .call(
                        "thread/read",
                        json!({"threadId":thread,"includeTurns":false}),
                        1000,
                    )
                    .await
            })
            .await;
            if let Ok(Ok(metadata)) = read {
                if matches!(
                    metadata["thread"]["status"]["type"].as_str(),
                    Some("active" | "idle")
                ) {
                    result["owner"] = json!("connector");
                    return result;
                }
            }
        }
        let owner = tokio::time::timeout(Duration::from_millis(1800), async {
            self.ipc().await?.owner(thread).await
        })
        .await;
        match owner {
            Ok(Ok(client)) => {
                result["owner"] = json!("desktop");
                result["clientId"] = json!(client);
            }
            _ => {
                result["owner"] = json!("external");
                result["reason"] = json!("native-writer-held-without-desktop-follower-owner");
            }
        }
        result
    }
    pub(crate) async fn observe_ownership(&self, thread: &str) -> Result<Value> {
        let mut owner = self.writer_ownership(thread).await;
        let history = crate::claude_notify::ownership::observe(thread, &owner).await?;
        owner["currentOwner"] = history["currentOwner"].clone();
        owner["history"] = history["history"].clone();
        owner["observedAt"] = history["observedAt"].clone();
        Ok(owner)
    }
    async fn release_writer(&self, thread: &str) -> Result<Value> {
        let mut ownership = self.writer_ownership(thread).await;
        if ownership["state"] == "unheld" {
            return Ok(
                json!({"threadId":thread,"released":true,"alreadyUnheld":true,"ownership":ownership,"state":"completed"}),
            );
        }
        if ownership["state"] == "held" {
            ownership["processes"] = crate::writer::processes(thread).await;
        }
        if !self.background(thread)?
            || (ownership["state"] == "held" && ownership["owner"] != "connector")
        {
            return Err(json!({"code":"WRITER_RELEASE_REQUIRES_OWNER","message":"This writer is not owned by ARC's connector. The Desktop follower protocol exposes no safe per-thread release request. Use the exact owner step; ARC will not close another session.","ownership":ownership,"next":crate::writer::release_step(thread,&ownership)}).to_string());
        }
        let rpc = self.utility().await?;
        let metadata = rpc
            .call(
                "thread/read",
                json!({"threadId":thread,"includeTurns":false}),
                3000,
            )
            .await?;
        if metadata["thread"]["status"]["type"] == "active" {
            return Err(
                "WRITER_ACTIVE: finish or explicitly interrupt this turn before release".into(),
            );
        }
        rpc.call("thread/unsubscribe", json!({"threadId":thread}), 3000)
            .await?;
        let observed = crate::writer::probe(thread);
        Ok(
            json!({"threadId":thread,"released":observed["state"] == "unheld","ownership":observed,"state":if observed["state"] == "unheld" {"completed"} else {"unconfirmed"}}),
        )
    }
    // Only an explicit write may load a persisted thread. Never retry a turn
    // submission on another owner: its acceptance may already be unknown.
    async fn prepare_thread(&self, thread: &str) -> Result<()> {
        #[cfg(feature = "test-fixture")]
        {
            if std::env::var_os("ARC_FIXTURE_DESKTOP").is_none() {
                return Ok(());
            }
        }
        #[allow(unreachable_code)]
        if self.effective_background(thread).await? {
            return Ok(());
        }
        let ipc = self.ipc().await?;
        let discovery_unanswered = match ipc.owner(thread).await {
            Ok(_) => return Ok(()),
            Err(e)
                if desktop::owner_missing(&e)
                    || (desktop::owner_discovery_pending(&e)
                        && crate::writer::probe(thread)["state"] == "unheld") =>
            {
                e == "DESKTOP_REQUEST_TIMEOUT: thread-owner-discovery"
            }
            Err(e) => return Err(e),
        };
        if self.handed_to_desktop(thread) {
            return desktop::reveal(&ipc,thread).await.map(|_|()).map_err(|error|
                json!({"code":"DESKTOP_HANDOFF_UNAVAILABLE","message":error,
                "next":{"via":"act","op":"task_open","args":{"agent":"codex","id":thread},
                "hint":"Open this exact thread in its Desktop owner, then inspect it before retrying. ARC will not reclaim a handed-off writer."}}).to_string());
        }
        // Validate existence before navigation; metadata needs no history API.
        let rpc = self.utility().await?;
        rpc.call(
            "thread/read",
            json!({"threadId":thread,"includeTurns":false}),
            60000,
        )
        .await?;
        let loaded = if discovery_unanswered {
            Err("DESKTOP_REQUEST_TIMEOUT: thread-owner-discovery".into())
        } else {
            desktop::reveal(&ipc, thread).await
        };
        match loaded {
            Ok(_) => Ok(()),
            Err(e)
                if desktop::owner_discovery_pending(&e)
                    && crate::writer::probe(thread)["state"] == "unheld" =>
            {
                // The bounded Desktop load still has no owner, and no turn has
                // been submitted. Resume this same thread, never create another.
                rpc.call(
                    "thread/resume",
                    json!({"threadId":thread,"excludeTurns":true}),
                    60000,
                )
                .await
                .map_err(|fallback| {
                    format!("THREAD_LOAD_FAILED: desktop={e}; app-server={fallback}")
                })?;
                save(
                    &root().join("execution").join(format!("{thread}.json")),
                    &json!({"owner":"connector","reason":"desktop-load-no-owner"}),
                )?;
                crate::logs::record("WARN", &format!("Thread {thread} resumed in ARC app-server after Desktop load found no owner"), None);
                Ok(())
            }
            Err(e) => Err(e),
        }
    }
    async fn archive_empty_creation(&self, thread: &str) -> Result<Value> {
        let rpc = self.utility().await?;
        let history = match rpc
            .call(
                "thread/turns/list",
                json!({"threadId":thread,"limit":1,"itemsView":"notLoaded"}),
                10000,
            )
            .await
        {
            Ok(history) => history,
            Err(error) if unmaterialized_thread(&error) => {
                return Ok(json!({"archived":false,"reason":"thread-not-materialized"}))
            }
            Err(error) => return Err(error),
        };
        if history["data"]
            .as_array()
            .is_none_or(|rows| !rows.is_empty())
        {
            return Ok(json!({"archived":false}));
        }
        cleanup_result(
            rpc.call("thread/archive", json!({"threadId":thread}), 10000)
                .await,
        )
    }
    pub(crate) async fn external_timeline(&self, thread: &str) -> Result<Value> {
        let ownership = self.observe_ownership(thread).await?;
        let history = self
            .utility()
            .await?
            .call(
                "thread/read",
                json!({"threadId":thread,"includeTurns":true}),
                15000,
            )
            .await?;
        let mut timeline = crate::task_tracking::Timeline::default();
        timeline.backfill_codex(&history["thread"], 0, 0, &now());
        crate::interaction_responses::project(&mut timeline, thread)?;
        let mut result = timeline.response(thread, 0);
        let projects = crate::projects::catalog(self).await.unwrap_or_default();
        result["projectName"] = json!(crate::projects::display_name(
            &projects,
            string(&history["thread"], "cwd"),
            history["thread"]["projectId"].as_str(),
        ));
        result["readOnly"] = json!(true);
        if result["snapshotHash"].is_string() {
            result["snapshotHash"] = json!(hash(
                json!([
                    result["snapshotHash"],
                    ownership["currentOwner"],
                    ownership["state"],
                    ownership["history"]
                ])
                .to_string()
            ));
        }
        result["ownership"] = ownership;
        Ok(result)
    }
    pub(crate) async fn timeline(&self, thread: &str, after: u64) -> Result<Value> {
        let ownership = self.observe_ownership(thread).await?;
        let _read = self.requests.lock(&format!("timeline-read:{thread}")).await;
        let (baseline, observed) = {
            let mut events = self.events.lock().await;
            let timeline = events.timelines.entry(thread.into()).or_default();
            if after > timeline.revision {
                return Err("TIMELINE_CURSOR_EXPIRED: fetch again without after".into());
            }
            if timeline.history_loaded && !timeline.observation_lost {
                crate::interaction_responses::project(timeline, thread)?;
                let mut result = timeline.response(thread, after);
                if result["snapshotHash"].is_string() {
                    result["snapshotHash"] = json!(hash(
                        json!([
                            result["snapshotHash"],
                            ownership["currentOwner"],
                            ownership["state"],
                            ownership["history"]
                        ])
                        .to_string()
                    ));
                }
                result["ownership"] = ownership;
                return Ok(result);
            }
            (timeline.revision, timeline.observed_events)
        };
        // Reconnect the desktop observation stream before reading its persisted history.
        // This is read-only: it never resumes a background task.
        #[cfg(not(feature = "test-fixture"))]
        if !self.effective_background(thread).await? && !cfg!(target_os = "linux") {
            let _ = self.follow(thread).await;
        }
        let history = async {
            let rpc = self.utility().await?;
            let mut result = rpc.call("thread/read", json!({"threadId":thread,"includeTurns":false}), 15000).await?;
            let turns = submission_history(false, |cursor| rpc.call("thread/turns/list", json!({"threadId":thread,"cursor":cursor,"limit":100,"sortDirection":"desc","itemsView":"full"}), 15000)).await?;
            result["thread"]["turns"] = json!(turns);
            Ok::<_, String>(result)
        }
        .await;
        let mut events = self.events.lock().await;
        let timeline = events.timelines.entry(thread.into()).or_default();
        match history {
            Ok(result) => timeline.backfill_codex(&result["thread"], baseline, observed, &now()),
            Err(error) => return Err(error),
        }
        crate::interaction_responses::project(timeline, thread)?;
        if after > timeline.revision {
            return Err("TIMELINE_CURSOR_EXPIRED: fetch again without after".into());
        }
        {
            let mut result = timeline.response(thread, after);
            if result["snapshotHash"].is_string() {
                result["snapshotHash"] = json!(hash(
                    json!([
                        result["snapshotHash"],
                        ownership["currentOwner"],
                        ownership["state"],
                        ownership["history"]
                    ])
                    .to_string()
                ));
            }
            result["ownership"] = ownership;
            Ok(result)
        }
    }
    pub async fn request(&self, method: &str, args: Value, timeout: u64) -> Result<Value> {
        if method == "fs/fetchFile"
            || (method == "fs/writeFile"
                && ["expectedSha256", "append", "offset"]
                    .iter()
                    .any(|key| args.get(*key).is_some()))
        {
            return crate::text_files::binary::transfer(method, &args).await;
        }
        if method == "turn/start" {
            let thread = string(&args, "threadId");
            let baseline = if let Some(cwd) = args["cwd"].as_str() {
                crate::changes::capture(cwd).await
            } else {
                match self
                    .request_inner(
                        "thread/read",
                        json!({"threadId":thread,"includeTurns":false}),
                        10000,
                        false,
                    )
                    .await
                {
                    Ok(t) => crate::changes::capture(string(&t["thread"], "cwd")).await,
                    Err(e) => json!({"unavailable":e}),
                }
            };
            let out = self
                .request_inner(method, args.clone(), timeout, false)
                .await?;
            if let Err(e) = crate::changes::record(thread, string(&out["turn"], "id"), &baseline) {
                crate::logs::record("WARN", &e, None);
            }
            return Ok(out);
        }
        self.request_inner(method, args, timeout, false).await
    }
    async fn request_inner(
        &self,
        method: &str,
        args: Value,
        timeout: u64,
        fresh_thread: bool,
    ) -> Result<Value> {
        if matches!(method, "turn/start" | "turn/steer") {
            if !REPLACEMENT_RESUME
                .try_with(|allowed| *allowed)
                .unwrap_or(false)
            {
                crate::app_replace::check_dispatch()?;
            }
            let thread = string(&args, "threadId");
            let turns = submission_history(fresh_thread, |cursor| {
                self.request_native("thread/turns/list", json!({"threadId":thread,"limit":100,"cursor":cursor,"sortDirection":"desc","itemsView":"full"}), timeout)
            }).await?;
            crate::external_inputs::observe(thread, &turns, None)?;
            let token = crate::external_inputs::begin(
                thread,
                &turns,
                &args["input"],
                &args["expectedTurnId"],
            )?;
            // Register before submission so fast native events cannot escape the timeline.
            let info = self
                .request_native(
                    "thread/read",
                    json!({"threadId":thread,"includeTurns":false}),
                    timeout.min(5000),
                )
                .await
                .unwrap_or(Value::Null);
            {
                let mut events = self.events.lock().await;
                let unseen_history = !events.timelines.contains_key(thread) && !turns.is_empty();
                let timeline = events.timelines.entry(thread.into()).or_default();
                timeline.partial |= unseen_history;
                timeline.info = json!({"runtimeSource":info["thread"]["runtimeSource"],"id":thread,"title":info["thread"]["name"].as_str().unwrap_or("Codex task"),"project":info["thread"]["cwd"],"startedAt":timeline.info.get("startedAt").cloned().unwrap_or(json!(now()))});
                timeline.status = "running".into();
            }
            let result = self.request_native(method, args.clone(), timeout).await;
            if result.is_err() {
                if let Some(t) = self.events.lock().await.timelines.get_mut(thread) {
                    t.finish("unknown", &now());
                }
            }
            crate::external_inputs::submitted(thread, &token, &result).map_err(|e| {
                format!("SUBMISSION_UNCONFIRMED: input provenance persistence failed: {e}")
            })?;
            return result;
        }
        self.request_native(method, args, timeout).await
    }
    async fn writer_conflict(&self, thread: &str, error: Option<&str>) -> Value {
        let mut ownership = self.writer_ownership(thread).await;
        if ownership["owner"] == "desktop" {
            return json!({"code":"DESKTOP_HANDOFF_UNAVAILABLE","message":"The Desktop route did not confirm this operation. Inspect the original receipt and current Desktop state before retrying.","ownership":ownership,"next":{"via":"query","op":"codex_owner","args":{"threadId":thread}}});
        }
        if ownership["state"] == "held" {
            ownership["processes"] = crate::writer::processes(thread).await;
        }
        if let Some(error) = error {
            let rpc = error
                .strip_prefix("RPC_REJECTED:")
                .and_then(|s| serde_json::from_str::<Value>(s).ok());
            ownership["lockObservation"] = ownership["state"].clone();
            ownership["state"] = json!("held");
            ownership["evidence"] = json!("native-writer-rejection");
            if ownership["owner"].is_null() {
                ownership["owner"] = json!("external");
            }
            if rpc.as_ref().is_some_and(|r| r["data"]["injected"] == true) {
                ownership["injected"] = json!(true);
                ownership["evidence"] = json!("isolated-native-writer-rejection");
            }
        }
        crate::writer::busy(thread, ownership)
    }
    async fn request_native(&self, method: &str, args: Value, timeout: u64) -> Result<Value> {
        let thread = string(&args, "threadId");
        if !thread.is_empty()
            && matches!(
                method,
                "thread/read"
                    | "thread/turns/list"
                    | "thread/items/list"
                    | "thread/resume"
                    | "turn/start"
                    | "turn/steer"
                    | "turn/interrupt"
            )
            && crate::writer::probe(thread)["state"] == "held"
        {
            let mut ownership = self.writer_ownership(thread).await;
            if ownership["owner"] == "external" {
                ownership["processes"] = crate::writer::processes(thread).await;
                return Err(crate::writer::busy(thread, ownership).to_string());
            }
        }
        let result = self.request_native_raw(method, args.clone(), timeout).await;
        if let Err(error) = &result {
            if !thread.is_empty() && error.contains("already has an active writer") {
                let ownership = self.writer_ownership(thread).await;
                if ownership["owner"] == "desktop" {
                    // This explicit native rejection occurs before admission. It
                    // is safe to route once through the newly observed Desktop;
                    // never do this after a timeout or an uncertain submission.
                    crate::claude_notify::ownership::observe(thread, &ownership).await?;
                    return self.request_native_raw(method, args, timeout).await;
                }
                return Err(self.writer_conflict(thread, Some(error)).await.to_string());
            }
            if !thread.is_empty()
                && desktop::owner_discovery_pending(error)
                && crate::writer::probe(thread)["state"] == "held"
            {
                return Err(self.writer_conflict(thread, None).await.to_string());
            }
        }
        result
    }
    async fn request_native_raw(&self, method: &str, args: Value, timeout: u64) -> Result<Value> {
        let args = if method == "command/exec" {
            crate::shell_command::command_environment(args)
        } else {
            args
        };
        crate::acceptance_fault::check_read(method, &args)?;
        #[cfg(feature = "test-fixture")]
        {
            if std::env::var_os("ARC_FIXTURE_DESKTOP").is_none() {
                return self.utility().await?.call(method, args, timeout).await;
            }
        }
        #[allow(unreachable_code)]
        if method == "turn/start" || method == "thread/resume" {
            self.prepare_thread(string(&args, "threadId")).await?;
        }
        if self.effective_background(string(&args, "threadId")).await? {
            return self.background_request(method, args, timeout).await;
        }
        if matches!(method, "turn/start" | "turn/steer" | "turn/interrupt") {
            let ipc = self.ipc().await?;
            return ipc.mutate(method, &args).await;
        }
        if method == "thread/start" {
            if !self.auto_open_codex()? {
                return self.create_background(args, "", None).await;
            }
            let result = self.seed(args, "", None).await?;
            desktop::reveal(self.ipc().await?.as_ref(), string(&result["thread"], "id")).await?;
            return Ok(result);
        }
        if method == "thread/resume" {
            return Ok(
                json!({"threadId":args["threadId"],"executionOwner":"desktop","resumed":true,"reason":"desktop-owner-confirmed"}),
            );
        }
        if matches!(
            method,
            "thread/read" | "thread/turns/list" | "thread/items/list"
        ) {
            let id = string(&args, "threadId");
            let complete = method != "thread/read" || args["includeTurns"] == true;
            let result = async { self.ipc().await?.read(id, complete).await }.await;
            match result {
                Ok(state) => {
                    let _ = self.follow(id).await;
                    if method == "thread/read" {
                        return Ok(json!({"thread":thread(&state,complete)?}));
                    }
                    let mut data = desktop::turns(&state)?;
                    if method == "thread/items/list" {
                        data = data
                            .iter()
                            .filter(|t| args["turnId"].is_null() || t["id"] == args["turnId"])
                            .flat_map(|t| {
                                t["items"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .map(|i| json!({"turnId":t["id"],"item":i}))
                            })
                            .collect();
                    } else if args["itemsView"] == "notLoaded" {
                        for t in &mut data {
                            t["items"] = json!([]);
                        }
                    }
                    if (method == "thread/turns/list" && args["sortDirection"] != "asc")
                        || (method == "thread/items/list" && args["sortDirection"] == "desc")
                    {
                        data.reverse()
                    }
                    return page(method, &args, data);
                }
                Err(e)
                    if desktop::owner_missing(&e)
                        || (desktop::owner_discovery_pending(&e)
                            && crate::writer::probe(id)["state"] == "unheld")
                        || e.contains("No such file")
                        || e.contains("Connection refused") =>
                {
                    if string(&args, "cursor").starts_with("desktop:") {
                        return Err("DESKTOP_CURSOR_STALE: Desktop history owner changed; omit cursor to restart pagination".into());
                    }
                }
                Err(e) => return Err(e),
            }
        } else if (method.starts_with("thread/")
            && !matches!(method, "thread/list" | "thread/loaded/list"))
            || method.starts_with("turn/")
        {
            return Err(format!("DESKTOP_METHOD_UNSUPPORTED: {method}"));
        }
        self.utility().await?.call(method, args, timeout).await
    }
    pub async fn schema(&self, args: &Value) -> Result<Value> {
        let mut cache = self.schemas.lock().await;
        if cache.is_none() {
            let dir = std::env::temp_dir().join(format!("arc-schema-{}", id()));
            private_dir(&dir)?;
            let result=async{output(&self.rpc_binary()?,&["app-server","generate-json-schema","--experimental","--out",dir.to_str().ok_or("invalid schema path")?]).await?;let mut responses=json!({});let server=load(&dir.join("ServerRequest.json"))?;for branch in server["oneOf"].as_array().into_iter().flatten(){let method=string(&branch["properties"]["method"]["enum"],"0");let method=branch["properties"]["method"]["enum"][0].as_str().unwrap_or(method);if let Some(param)=branch["properties"]["params"]["$ref"].as_str().and_then(|v|v.rsplit('/').next()){let file=format!("{}.json",param.trim_end_matches("Params").to_owned()+"Response");if let Ok(v)=load(&dir.join(file)){responses[method]=v;}}}Ok::<_,String>(json!({"client":load(&dir.join("ClientRequest.json"))?,"server":server,"responses":responses}))}.await;
            let _ = std::fs::remove_dir_all(dir);
            *cache = Some(result?);
        }
        let data = cache.as_ref().unwrap();
        let direction = args["direction"].as_str().unwrap_or("client");
        let root = &data[direction];
        let all = root["oneOf"].as_array().ok_or("SCHEMA_UNAVAILABLE")?;
        if let Some(method) = args["method"].as_str() {
            let b = all
                .iter()
                .find(|b| b["properties"]["method"]["enum"][0] == method)
                .ok_or("METHOD_NOT_FOUND")?;
            let mut params = b["properties"]["params"].clone();
            if params.is_null() {
                params = json!({"type":"null"})
            }
            params = crate::kernel::results::schema_closure(params, &root["definitions"]);
            return Ok(
                json!({"method":method,"direction":direction,"description":b["description"],"paramsSchema":params,"responseSchema":data["responses"][method]}),
            );
        }
        let search = string(args, "search").to_lowercase();
        let methods:Vec<Value>=all.iter().filter(|b|b["properties"]["method"]["enum"][0].as_str().unwrap_or("").to_lowercase().contains(&search)).map(|b|json!({"method":b["properties"]["method"]["enum"][0],"description":b["description"]})).collect();
        let offset = num(args, "offset", 0);
        let end = offset.saturating_add(num(args, "limit", 100).min(1000));
        Ok(
            json!({"source":"current-binary-generated-experimental-schema","total":methods.len(),"methods":methods.iter().skip(offset).take(end-offset).collect::<Vec<_>>(),"nextOffset":if end<methods.len(){Some(end)}else{None}}),
        )
    }
    fn checkpoint(&self, r: &mut Value) -> Result<()> {
        RECEIPTS.checkpoint(r)
    }
    pub async fn receipt(&self, request: &str) -> Result<Value> {
        if !RECEIPTS.path(request)?.exists() {
            return Ok(
                json!({"requestId":request,"state":"not-found","executionState":"no-reservation"}),
            );
        }
        RECEIPTS.read(request, &self.session)
    }

    pub async fn mutate(self: &Arc<Self>, operation: &str, mut args: Value) -> Result<Value> {
        if matches!(operation, "create" | "send" | "resume" | "native") {
            let op = match operation {
                "send" => "codex_send",
                "resume" => "codex_resume",
                _ => "",
            };
            if crate::app_replace::continuation_context(op, &args)?.is_none() {
                crate::app_replace::check_dispatch()?;
            }
        }
        if matches!(operation, "create" | "send") {
            crate::claude_notify::normalize(&mut args)?;
        }
        if args.get("requestId").is_none_or(Value::is_null) {
            args["requestId"] = json!(id());
        }
        let request = string(&args, "requestId").to_owned();
        RECEIPTS.path(&request)?;
        let mut payload = args.clone();
        payload.as_object_mut().map(|p| p.remove("waitMs"));
        let digest = hash(json!({"operation":operation,"args":payload}).to_string());
        let request_lock = self.requests.lock(&request).await;
        if let Some(receipt) = RECEIPTS.replay(&request, &digest, &self.session)? {
            return Ok(receipt);
        }
        if matches!(operation, "create" | "send") {
            let selected = crate::accounts::select("codex", args["account"].as_str())?;
            crate::accounts::attach(&mut args, &selected);
        }
        let dispatch = if matches!(operation, "create" | "send") {
            if args["sendMode"] == "queue" {
                // Validate now, but choose omitted values when the queue actually dispatches.
                crate::dispatch_policy::resolve(&mut args.clone())?;
                Value::Null
            } else if operation == "send" {
                let thread = string(&args, "threadId");
                let state = self.dispatch_state(thread).await?;
                let records = crate::dispatch_policy::records(thread)?;
                let inherited = crate::dispatch_policy::inherited_configuration(&state, &records);
                if args["sendMode"] == "next" && state["turns"][0]["status"] == "inProgress" {
                    crate::dispatch_policy::resolve_with_inheritance(
                        &mut args.clone(),
                        &inherited,
                    )?;
                    Value::Null
                } else {
                    crate::dispatch_policy::resolve_with_inheritance(&mut args, &inherited)?
                }
            } else {
                crate::dispatch_policy::resolve(&mut args)?
            }
        } else {
            Value::Null
        };
        let mut receipt = json!({"agentAccountId":args["agentAccountId"],"agentProfileId":args["agentProfileId"],"origin":crate::kernel::origin::current_origin(),"requestId":request,"backendSession":self.session,"digest":digest,"operation":operation,"arguments":args,"state":"reserved","createdAt":now(),"updatedAt":now()});
        if matches!(operation, "create" | "send") {
            crate::dispatch_caller::attach_current(&mut receipt);
            receipt["srcConversation"] = crate::src_conversations::capture(&args).await?;
        }
        if operation == "resume" {
            if let Some(entry) =
                crate::app_replace::continuation_entry(string(&args, "threadId"), &request)?
            {
                receipt["replacementContinuation"] = json!({"threadId":entry["threadId"],"interruptedTurnId":entry["turnId"],
                    "originalRequestId":entry["dispatch"]["requestId"],"requestId":entry["continuation"]["requestId"]});
            }
        }
        if operation == "create" || (operation == "native" && args["method"] == "thread/start") {
            receipt["executionOwner"] = json!(if self.auto_open_codex()? {
                "desktop"
            } else {
                "connector"
            });
        }
        if let Some(task) = task_details(operation, &args)? {
            let decision = match string(&args, "approval") {
                "approved" => "approved",
                "bypass" => "bypass",
                _ if self.approval_mode()? => "pending",
                _ => "automatic",
            };
            receipt["task"] = task;
            receipt["task"]["agentAccountId"] = receipt["agentAccountId"].clone();
            if !dispatch.is_null() {
                receipt["task"]["dispatch"] = dispatch;
            }
            receipt["task"]["origin"] = receipt["origin"].clone();
            receipt["arguments"] = args.clone();
            receipt["approval"] = json!({"decision":decision,"source":"cloud","at":now()});
            if decision == "pending" {
                receipt["state"] = json!("awaiting-approval");
                receipt["nextAction"] = json!("receipt: approve, bypass or reject; user intent overrides the default approval mode");
            }
        }
        RECEIPTS.reserve(&receipt)?;
        if receipt["state"] == "awaiting-approval" {
            return Ok(receipt);
        }
        let wait = if operation == "command" && args.get("waitMs").is_none() {
            num(&args, "timeoutMs", 60000) as u64 + 10000
        } else {
            num(
                &args,
                "waitMs",
                if operation == "create" { 45000 } else { 25000 },
            )
            .min(120000) as u64
        };
        let mut jobs = self.jobs.lock().await;
        let rx = self.launch(operation, args, receipt, &mut jobs);
        drop(jobs);
        drop(request_lock);
        match tokio::time::timeout(Duration::from_millis(wait), rx).await {
            Ok(Ok(r)) => r,
            _ => {
                let mut pending = json!({"requestId":request,"state":"pending","operation":operation,"nextAction":"receipt"});
                if matches!(operation, "create" | "send") {
                    let receipt = self.receipt(&request).await?;
                    pending["agentAccountId"] = receipt["agentAccountId"].clone();
                    pending["origin"] = receipt["origin"].clone();
                }
                Ok(pending)
            }
        }
    }
    fn launch(
        self: &Arc<Self>,
        operation: &str,
        args: Value,
        mut receipt: Value,
        jobs: &mut HashMap<String, tokio::task::JoinHandle<()>>,
    ) -> tokio::sync::oneshot::Receiver<Result<Value>> {
        let request = string(&receipt, "requestId").to_owned();
        let c = self.clone();
        let op = operation.to_owned();
        let key = request.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let origin = receipt["origin"].clone();
        let job = tokio::spawn(crate::kernel::origin::ORIGIN.scope(origin, async move {
            // Only a validated durable replacement continuation may cross admission.
            // The private scope cannot be supplied through native tool parameters.
            let recovery = receipt["replacementContinuation"].is_object();
            let outcome = REPLACEMENT_RESUME
                .scope(recovery, c.perform(&op, &args, &mut receipt))
                .await;
            match outcome {
                Ok(result) => {
                    receipt["result"] = result;
                    receipt["state"] = json!("completed")
                }
                Err(err) => {
                    // A definite pre-acceptance create failure must not leave an
                    // apparently usable empty task. Unknown submissions are retained.
                    if op == "create"
                        && receipt["threadId"].is_string()
                        && !receipt["cleanup"].is_object()
                        && !err.starts_with("SUBMISSION_UNCONFIRMED:")
                    {
                        let thread = string(&receipt, "threadId");
                        let cleanup = c.archive_empty_creation(thread).await;
                        receipt["cleanup"] = match cleanup {
                            Ok(cleanup) => cleanup,
                            Err(error) => json!({"archived":false,"error":error}),
                        };
                    }
                    receipt["failureStage"] = receipt["state"].clone();
                    receipt["state"] = json!(crate::kernel::receipts::failure_state(&err));
                    let mut error = crate::egress::failure(&err);
                    if error["code"] == "THREAD_WRITER_BUSY" && receipt["threadId"].is_string() {
                        error["next"] =
                            crate::writer::busy(string(&receipt, "threadId"), Value::Null)["next"]
                                .clone();
                    }
                    if op == "command" || args["method"] == "command/exec" {
                        let mut recovery = json!({"error":error});
                        crate::egress::next(&mut recovery, "command", &args, false);
                        receipt["next"] = recovery["next"].clone();
                        error = recovery["error"].clone();
                    }
                    receipt["result"] = json!({"error":error});
                }
            }
            let result = c.checkpoint(&mut receipt).map(|_| receipt);
            let _ = tx.send(result);
            c.jobs.lock().await.remove(&key);
        }));
        jobs.insert(request.clone(), job);
        rx
    }
    pub fn approval_mode(&self) -> Result<bool> {
        let path = root().join("task-settings.json");
        Ok(path.exists() && load(&path)?["enabled"] == true)
    }
    pub async fn decide(
        self: &Arc<Self>,
        request: &str,
        action: &str,
        source: &str,
        wait_ms: u64,
    ) -> Result<Value> {
        if !matches!(action, "approve" | "bypass" | "reject") {
            return Err("invalid approval action".into());
        }
        let _request_lock = self.requests.lock(request).await;
        let mut r = self.receipt(request).await?;
        if r["state"] != "awaiting-approval" {
            return Ok(r);
        }
        r["approval"] = json!({"decision":if action=="approve"{"approved"}else{action},"source":source,"at":now()});
        r.as_object_mut().unwrap().remove("nextAction");
        r["state"] = json!(if action == "reject" {
            "not-executed"
        } else {
            "reserved"
        });
        r["backendSession"] = json!(self.session);
        self.checkpoint(&mut r)?;
        if action != "reject" {
            let op = string(&r, "operation").to_owned();
            let mut jobs = self.jobs.lock().await;
            let rx = self.launch(&op, r["arguments"].clone(), r.clone(), &mut jobs);
            drop(jobs);
            drop(_request_lock);
            if let Ok(Ok(result)) =
                tokio::time::timeout(Duration::from_millis(wait_ms.min(120000)), rx).await
            {
                return result;
            }
            r["state"] = json!("pending");
        }
        Ok(r)
    }
    pub async fn task_records(&self) -> Result<Vec<Value>> {
        use crate::kernel::file_cache::{self, Projection};
        let dependencies = [root(), root().join("tasks"), root().join("execution")];
        let mut cache = self.task_records.lock().await;
        let stamps = Projection::<Vec<Value>>::stamps(&dependencies)?;
        if let Some(records) = cache.get(&stamps) {
            return Ok(records);
        }
        let mut complete = true;
        let mut records = Vec::new();
        for entry in file_cache::entries(&root())?.iter() {
            let path = &entry.path;
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            let Some(request) = path.file_stem().and_then(|v| v.to_str()) else {
                continue;
            };
            if uuid::Uuid::parse_str(request).is_err() {
                continue;
            }
            let mut r = match self.receipt(request).await {
                Ok(r) => r,
                Err(e) => {
                    complete = false;
                    crate::logs::record(
                        "WARN",
                        &format!("Skipping task receipt {request}: {e}"),
                        None,
                    );
                    continue;
                }
            };
            // Reviews update existing turn metadata; they are not execution tasks.
            if r["operation"] == "review" {
                continue;
            }
            if !r["task"].is_object() {
                let kind = string(&r, "operation");
                let thread_id = r["threadId"]
                    .as_str()
                    .or_else(|| r["result"]["threadId"].as_str())
                    .or_else(|| r["result"]["resolved"]["thread"]["id"].as_str())
                    .or_else(|| r["result"]["thread"]["id"].as_str());
                if !matches!(kind, "create" | "send" | "interrupt") && thread_id.is_none() {
                    continue;
                }
                let thread_id = thread_id.map(str::to_owned);
                let resolved = &r["result"]["resolved"];
                let thread = resolved.get("thread").unwrap_or(&r["result"]["thread"]);
                r["task"] = json!({"kind":kind,"title":thread["name"],"prompt":"",
                    "project":null,"directory":thread.get("cwd").unwrap_or(&resolved["cwd"]),
                    "threadId":thread_id,"model":r["requested"]["model"],"effort":r["requested"]["effort"],
                    "detailsRecorded":false});
                r["threadId"] = json!(thread_id);
            }
            if !r["createdAt"].is_string() {
                r["createdAt"] = r["updatedAt"].clone();
            }
            if !r["approval"].is_object() {
                r["approval"] =
                    json!({"decision":"unrecorded","source":"cloud","at":r["createdAt"]});
            }
            if let Some(thread_id) = r["threadId"]
                .as_str()
                .or_else(|| r["task"]["threadId"].as_str())
            {
                if uuid::Uuid::parse_str(thread_id).is_ok() {
                    let path = root().join("tasks").join(format!("{thread_id}.json"));
                    match file_cache::load(&path) {
                        Ok(mut runtime) => {
                            runtime["stale"] = json!(true);
                            r["runtime"] = runtime;
                        }
                        Err(_) => complete &= !path.exists(),
                    }
                }
            }
            if let Some(thread_id) = r["threadId"].as_str() {
                match self.background(thread_id) {
                    Ok(background) => {
                        r["executionOwner"] =
                            json!(if background { "connector" } else { "desktop" })
                    }
                    Err(e) => {
                        complete = false;
                        crate::logs::record(
                            "WARN",
                            &format!("Skipping task {thread_id}: {e}"),
                            None,
                        );
                        continue;
                    }
                }
            }
            r["error"] = r["result"]["error"].clone();
            r.as_object_mut().unwrap().remove("arguments");
            r.as_object_mut().unwrap().remove("result");
            records.push(r);
        }
        records.sort_by(|a, b| string(b, "createdAt").cmp(string(a, "createdAt")));
        if complete {
            cache.set(&dependencies, stamps, records.clone())?;
        }
        Ok(records)
    }
    pub async fn task_runtime(&self, id: &str) -> Result<Value> {
        let ownership = self.observe_ownership(id).await?;
        let path = uuid::Uuid::parse_str(id)
            .ok()
            .map(|_| root().join("tasks").join(format!("{id}.json")));
        let live = tokio::time::timeout(Duration::from_secs(5), async {
            if ownership["owner"] == "desktop" {
                let state = self.ipc().await?.read(id, false).await?;
                Ok(json!({"thread":crate::control::thread(&state,false)?}))
            } else {
                self.request(
                    "thread/read",
                    json!({"threadId":id,"includeTurns":false}),
                    5000,
                )
                .await
            }
        })
        .await;
        let mut snapshot = match live {
            Ok(Ok(result)) => summary(&result["thread"]),
            _ => {
                // Unloaded tasks still have native basic metadata; never load conversation items.
                let result = self
                    .utility()
                    .await?
                    .call(
                        "thread/read",
                        json!({"threadId":id,"includeTurns":false}),
                        5000,
                    )
                    .await?;
                let mut thread = result["thread"].clone();
                thread["status"] = json!({"type":"notLoaded"});
                let mut snapshot = summary(&thread);
                if let Some(previous) = path.as_ref().and_then(|p| load(p).ok()) {
                    snapshot["runtimeStatus"] = previous["runtimeStatus"].clone();
                    snapshot["observedAt"] = previous["observedAt"].clone();
                }
                snapshot["stale"] = json!(true);
                snapshot
            }
        };
        if snapshot["archived"].is_null() {
            if let Some(previous) = path.as_ref().and_then(|p| load(p).ok()) {
                snapshot["archived"] = previous["archived"].clone();
            }
        }
        snapshot["ownership"] = ownership;
        if let Some(path) = path {
            save(&path, &snapshot)?;
        }
        Ok(snapshot)
    }
    pub(crate) async fn thread_lock(&self, thread: &str) -> tokio::sync::OwnedMutexGuard<()> {
        self.requests.lock(&format!("thread-write:{thread}")).await
    }
    pub(crate) async fn dispatch_state(&self, thread: &str) -> Result<Value> {
        let mut state = self
            .request(
                "thread/read",
                json!({"threadId":thread,"includeTurns":false}),
                10000,
            )
            .await?["thread"]
            .clone();
        let latest = self
            .request(
                "thread/turns/list",
                json!({"threadId":thread,"limit":1,"sortDirection":"desc","itemsView":"notLoaded"}),
                10000,
            )
            .await?;
        let turns = latest["data"].as_array().ok_or("NATIVE_TURNS_MISSING")?;
        if state["status"]["type"] == "active"
            && turns.first().is_none_or(|t| t["status"] != "inProgress")
        {
            return Err("THREAD_STATE_UNCONFIRMED: native runtime is active without a confirmed active turn; read codex_read and keep queued messages pending".into());
        }
        state["turns"] = latest["data"].clone();
        Ok(state)
    }
    pub(crate) async fn check_steer(&self, thread: &str, turn: &Value) -> Result<()> {
        #[cfg(feature = "test-fixture")]
        if std::env::var_os("ARC_FIXTURE_DESKTOP").is_none() {
            return Ok(());
        }
        if !self.effective_background(thread).await? {
            let state = self.ipc().await?.read(thread, true).await?;
            desktop::check_steer(&state, thread, turn)?;
        }
        Ok(())
    }
    async fn perform(&self, operation: &str, args: &Value, r: &mut Value) -> Result<Value> {
        if operation == "send" && args["sendMode"] == "queue" {
            return crate::dispatch_queue::enqueue(args, r).await;
        }
        let thread_key = args["threadId"]
            .as_str()
            .or_else(|| args["params"]["threadId"].as_str())
            .unwrap_or("");
        let _thread_guard = if !thread_key.is_empty()
            && (matches!(
                operation,
                "send" | "resume" | "interrupt" | "review" | "archive" | "release"
            ) || (operation == "native"
                && matches!(
                    string(args, "method"),
                    "turn/start" | "turn/steer" | "turn/interrupt" | "thread/resume"
                ))) {
            Some(self.thread_lock(thread_key).await)
        } else {
            None
        };

        if operation == "send"
            || (operation == "native"
                && matches!(
                    string(args, "method"),
                    "thread/resume" | "turn/start" | "turn/steer"
                ))
        {
            let ownership = self.writer_ownership(thread_key).await;
            if ownership["state"] == "held" && ownership["owner"] == "external" {
                r["threadId"] = json!(thread_key);
                return Err(crate::writer::busy(thread_key, ownership).to_string());
            }
        }
        if operation == "release" {
            r["threadId"] = args["threadId"].clone();
            return self.release_writer(string(args, "threadId")).await;
        }
        if operation == "resume" {
            let thread = string(args, "threadId");
            let previous = string(args, "turnId");
            r["threadId"] = json!(thread);
            let context = crate::claude_notify::resume_context(thread, previous)?;
            let ownership = self.observe_ownership(thread).await?;
            if ownership["state"] == "held"
                && !matches!(ownership["owner"].as_str(), Some("connector" | "desktop"))
            {
                return Err(crate::writer::busy(thread, ownership).to_string());
            }
            let desktop = ownership["owner"] == "desktop" || self.handed_to_desktop(thread);
            let state = if desktop {
                let state = self.ipc().await?.read(thread, true).await?;
                crate::control::thread(&state, true)?
            } else {
                let rpc = self.utility().await?;
                let mut state = rpc
                    .call(
                        "thread/read",
                        json!({"threadId":thread,"includeTurns":false}),
                        10000,
                    )
                    .await?["thread"]
                    .clone();
                let page = rpc.call("thread/turns/list",json!({"threadId":thread,"limit":1,"sortDirection":"desc","itemsView":"full"}),10000).await?;
                state["turns"] = json!(page["data"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .rev()
                    .cloned()
                    .collect::<Vec<_>>());
                state
            };
            let latest = state["turns"]
                .as_array()
                .and_then(|turns| turns.last())
                .ok_or("RESUME_TURN_MISSING")?;
            if latest["id"] != previous
                || !matches!(string(latest, "status"), "interrupted" | "cancelled")
                || state["status"]["type"] == "active"
            {
                return Err(json!({"code":"RESUME_TURN_ADVANCED","message":"Only the latest interrupted turn can resume. No input was submitted.","next":{"via":"query","op":"codex_read","args":{"threadId":thread,"statusOnly":true}}}).to_string());
            }
            if !desktop {
                crate::claude_notify::prepare_replacement_resume(
                    thread,
                    previous,
                    if ownership["state"] == "unheld" {
                        &r["replacementContinuation"]
                    } else {
                        &Value::Null
                    },
                )
                .await?;
                if state["status"]["type"] == "notLoaded" {
                    self.utility()
                        .await?
                        .call(
                            "thread/resume",
                            json!({"threadId":thread,"excludeTurns":true}),
                            10000,
                        )
                        .await?;
                }
                save(
                    &root().join("execution").join(format!("{thread}.json")),
                    &json!({"owner":"connector","reason":"explicit-interrupted-resume"}),
                )?;
            }
            r["state"] = json!("submitting");
            self.checkpoint(r)?;
            let mut params = json!({"threadId":thread,"input":[],"turnTrigger":"resume_interrupted_task","parentTurnId":previous,"rootTurnId":previous});
            let inherited = crate::dispatch_policy::inherited_configuration(
                &state,
                &crate::dispatch_policy::records(thread)?,
            );
            for field in ["model", "effort"] {
                if let Some(value) = inherited.get(field) {
                    params[field] = value.clone();
                }
            }
            let result = if desktop {
                self.ipc().await?.mutate("turn/start", &params).await?
            } else {
                self.request("turn/start", params, 10000).await?
            };
            let turn = string(&result["turn"], "id");
            if turn.is_empty() {
                return Err(
                    "RESUME_UNCONFIRMED: read the original receipt and thread before retrying"
                        .into(),
                );
            }
            r["turnId"] = json!(turn);
            r["dispatchMode"] = json!("resumed");
            r["executionOwner"] = json!(if desktop { "desktop" } else { "connector" });
            crate::claude_notify::record_binding(
                r,
                crate::claude_notify::resumed(thread, previous, turn, context).await,
            );
            return Ok(
                json!({"threadId":thread,"turnId":turn,"resumedFrom":previous,"executionOwner":r["executionOwner"]}),
            );
        }
        if operation == "archive" {
            let thread = string(args, "threadId");
            r["threadId"] = json!(thread);
            let rpc = self.utility().await?;
            let native = rpc
                .call(
                    "thread/read",
                    json!({"threadId":thread,"includeTurns":false}),
                    10000,
                )
                .await?;
            if native["thread"]["status"]["type"] == "active"
                || self
                    .events
                    .lock()
                    .await
                    .pending
                    .values()
                    .any(|v| v["params"]["threadId"] == thread)
            {
                return Err(json!({"code":"ARCHIVE_ACTIVE_TURN","message":"The thread is active or has a pending interaction. Finish it, or explicitly interrupt it, before archiving.","next":{"via":"query","op":"codex_read","args":{"threadId":thread,"statusOnly":true}}}).to_string());
            }
            if args["release"] == true {
                let owner = self.writer_ownership(thread).await;
                // Native archive already handles its own idle writer atomically.
                // Unsubscribe acknowledgement need not mean the session unloaded.
                let unnecessary = owner["state"] == "unheld"
                    || (owner["owner"] == "connector"
                        && native["thread"]["status"]["type"] == "idle");
                if !unnecessary && self.release_writer(thread).await?["released"] != true {
                    return Err("RELEASE_UNCONFIRMED: read codex_owner before archive".into());
                }
            }
            r["state"] = json!("submitting");
            self.checkpoint(r)?;
            if let Err(error) = rpc
                .call("thread/archive", json!({"threadId":thread}), 10000)
                .await
            {
                if error.contains("active writer") {
                    let mut ownership = self.writer_ownership(thread).await;
                    ownership["processes"] = crate::writer::processes(thread).await;
                    return Err(json!({"code":"ARCHIVE_WRITER_BUSY","message":"Native archival requires the owning session to release or archive this exact thread.","nativeCode":error.strip_prefix("RPC_REJECTED:").and_then(|s|serde_json::from_str::<Value>(s).ok()).map(|v|v["code"].clone()),"ownership":ownership,"retryable":false,"next":crate::writer::release_step(thread,&ownership)}).to_string());
                }
                return Err(error);
            }
            crate::claude_notify::ownership::end_scope(thread, "thread-archived").await?;
            return Ok(json!({"threadId":thread,"archived":true,"nativeMethod":"thread/archive"}));
        }
        if operation == "review" {
            r["threadId"] = args["threadId"].clone();
            return crate::dispatch_policy::review(self, args).await;
        }
        if matches!(operation, "edit" | "write") {
            return crate::text_files::write(self, operation, args).await;
        }
        if operation == "command" {
            return crate::shell_command::run(self, args, r).await;
        }
        if operation == "git_write" {
            r["state"] = json!("submitting");
            self.checkpoint(r)?;
            return crate::projects::write(self, args).await;
        }
        if operation == "respond" {
            let token_request = if args["respondToken"].is_string() {
                Some(crate::respond_tokens::resolve(args)?)
            } else {
                None
            };
            let mut resolved = args.clone();
            if let Some(pending) = &token_request {
                let key = pending.get("responseId").unwrap_or(&pending["id"]);
                resolved["id"] = json!(key
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| key.to_string()));
                resolved["backendSession"] = pending["backendSession"].clone();
            }
            let args = &resolved;
            let key = string(args, "id");
            let stale = || {
                let identity = serde_json::from_str::<Value>(key).unwrap_or(Value::Null);
                let thread = token_request
                    .as_ref()
                    .and_then(|r| r["params"]["threadId"].as_str())
                    .or_else(|| identity[1].as_str());
                json!({"code":"STALE_INTERACTION","message":"The original interaction is no longer exposed by its owner. Read the current native interactions and answer the exact current request; do not replay a previous approval.",
                    "next":{"via":"query","op":"codex_pending","args":thread.map(|thread|json!({"threadId":thread})).unwrap_or(json!({}))}}).to_string()
            };
            let recovered = args["backendSession"] != self.session;
            if recovered
                && !token_request
                    .as_ref()
                    .is_some_and(|r| r["owner"] == "desktop")
                && !crate::claude_notify::recoverable_response(key, string(args, "backendSession"))?
            {
                return Err(stale());
            }
            // Refresh the Desktop snapshot after restart; never depend on an empty pending cache.
            if let Ok(identity) = serde_json::from_str::<Value>(key) {
                if identity[0] == "desktop" {
                    let thread = identity[1].as_str().ok_or_else(stale)?;
                    self.ipc().await?.read(thread, true).await?;
                }
            }
            let _interaction_guard = self.requests.lock(&format!("interaction:{key}")).await;
            let pending = self
                .events
                .lock()
                .await
                .pending
                .get(key)
                .cloned()
                .ok_or_else(stale)?;
            if let Some(expected) = &token_request {
                if pending["params"]["threadId"] != expected["params"]["threadId"]
                    || pending["params"]["turnId"] != expected["params"]["turnId"]
                {
                    return Err("RESPOND_TOKEN_SCOPE_MISMATCH".into());
                }
            }
            let _thread_guard = self
                .thread_lock(string(&pending["params"], "threadId"))
                .await;
            if recovered && pending["owner"] != "desktop" {
                return Err(stale());
            }
            if args.get("result").is_some() == args.get("error").is_some() {
                return Err("provide exactly one of result/error".into());
            }
            if pending["owner"] == "desktop" {
                if args.get("error").is_some() {
                    return Err(
                        "Desktop responses require result; use the native decline/cancel response"
                            .into(),
                    );
                }
                let baseline = if pending["method"] == "request_user_input_async" {
                    match self
                        .request(
                            "thread/read",
                            json!({"threadId":pending["params"]["threadId"],"includeTurns":false}),
                            10000,
                        )
                        .await
                    {
                        Ok(t) => crate::changes::capture(string(&t["thread"], "cwd")).await,
                        Err(e) => json!({"unavailable":e}),
                    }
                } else {
                    Value::Null
                };
                r["state"] = json!("responding");
                self.checkpoint(r)?;
                crate::external_inputs::responding(
                    string(&pending["params"], "threadId"),
                    &pending,
                )?;
                let result = self.ipc().await?.respond(key, &args["result"]).await;
                if let Err(error) = &result {
                    crate::external_inputs::response_failed(
                        string(&pending["params"], "threadId"),
                        &pending,
                        error,
                    )?;
                }
                let result = result.map_err(|error| {
                    if error == "STALE_INTERACTION" {
                        stale()
                    } else {
                        error
                    }
                })?;
                crate::interaction_responses::record(&pending, args)?;
                if let Some(turn) = result["nextTurnId"].as_str() {
                    let thread = string(&result, "threadId");
                    if let Err(e) = crate::changes::record(thread, turn, &baseline) {
                        crate::logs::record("WARN", &e, None);
                    }
                    crate::claude_notify::bind(&json!({}), thread, turn, "", Value::Null).await?;
                    crate::claude_notify::inherit(thread, string(&result, "answeredTurnId"), turn)
                        .await?;
                }
                crate::respond_tokens::consume(args).map_err(|e| {
                    format!("SUBMISSION_UNCONFIRMED: response sent; token persistence failed: {e}")
                })?;
                return Ok(result);
            }
            let rpc = self.utility().await?;
            r["state"] = json!("responding");
            self.checkpoint(r)?;
            let mut response = json!({"id":pending["id"]});
            let field = if args.get("result").is_some() {
                "result"
            } else {
                "error"
            };
            response[field] = args[field].clone();
            crate::external_inputs::responding(string(&pending["params"], "threadId"), &pending)?;
            rpc.write(response)
                .await
                .map_err(|e| format!("SUBMISSION_UNCONFIRMED: {e}"))?;
            crate::interaction_responses::record(&pending, args)?;
            {
                let mut events = self.events.lock().await;
                events.pending.remove(key);
                if let Some(t) = events
                    .timelines
                    .get_mut(string(&pending["params"], "threadId"))
                {
                    t.resolve(&pending["id"], &now());
                }
            }
            crate::respond_tokens::consume(args).map_err(|e| {
                format!("SUBMISSION_UNCONFIRMED: response sent; token persistence failed: {e}")
            })?;
            return Ok(json!({"responseSent":true,"backendSession":self.session,"id":key}));
        }
        let mut retry_args = args.clone();
        let mut params = args["params"].clone();
        let mut method = string(args, "method").to_owned();
        let timeout = args["timeoutMs"].as_u64().unwrap_or(86400000);
        if operation == "create" {
            let input = task_input(args)?;
            let mut seed = args["thread"].as_object().cloned().unwrap_or_default();
            for k in ["model", "serviceTier"] {
                if let Some(v) = args.get(k) {
                    seed.entry(k).or_insert(v.clone());
                }
            }
            if args["project"].is_string() {
                let p = crate::projects::resolve_args(self, args).await?;
                seed.insert("cwd".into(), p["root"].clone());
                let pid = if Path::new(string(&p, "id")).is_absolute() {
                    crate::projects::native_id(self, string(&p, "root")).await?
                } else {
                    Some(string(&p, "id").to_owned())
                };
                if let Some(pid) = pid {
                    seed.entry("projectId").or_insert(json!(pid));
                }
            }
            r["task"]["directory"] = seed.get("cwd").cloned().unwrap_or(Value::Null);
            r["state"] = json!("thread-submitting");
            self.checkpoint(r)?;
            let background = r["executionOwner"] == "connector";
            let result = if background {
                self.create_background(json!(seed), string(args, "title"), Some(r))
                    .await?
            } else {
                self.seed(json!(seed), string(args, "title"), Some(r))
                    .await?
            };
            let thread = string(&result["thread"], "id");
            let mut turn = configured(args, string(&result["thread"], "cwd"))?;
            if !background && turn["model"].is_null() {
                turn["model"] = result["model"].clone();
            }
            turn["threadId"] = json!(thread);
            turn["input"] = input;
            let step = std::time::Instant::now();
            let baseline = crate::changes::capture(
                turn["cwd"]
                    .as_str()
                    .unwrap_or_else(|| string(&result["thread"], "cwd")),
            )
            .await;
            r["turnBaseline"] = baseline.clone();
            r["seedTimings"]["baselineMs"] = json!(step.elapsed().as_millis());
            let step = std::time::Instant::now();
            self.prepare_thread(thread).await?;
            r["seedTimings"]["ownerMs"] = json!(step.elapsed().as_millis());
            let background = self.effective_background(thread).await?;
            r["executionOwner"] = json!(if background { "connector" } else { "desktop" });
            r["state"] = json!("turn-submitting");
            r["task"]["dispatch"]["submittedAt"] = json!(now());
            self.checkpoint(r)?;
            retry_args["_retryModel"] = turn
                .get("model")
                .filter(|m| m.is_string())
                .cloned()
                .unwrap_or_else(|| result["model"].clone());
            retry_args["_retryTurn"] = retry_turn(&turn);
            let out = self
                .request_inner("turn/start", turn, timeout, true)
                .await?;
            r["dispatchMode"] = json!("new-turn");
            if !background {
                let _ = self.follow(thread).await;
            }
            r["turnId"] = out["turn"]["id"].clone();
            crate::dispatch_policy::record(r)?;
            let notification_binding = crate::claude_notify::bind(
                &retry_args,
                thread,
                string(r, "turnId"),
                string(&result["thread"], "cwd"),
                json!({"op":"codex_create","at":r["createdAt"],"requestId":r["requestId"]}),
            )
            .await;
            crate::claude_notify::record_binding(r, notification_binding);
            if let Err(e) = crate::changes::record(thread, string(&r, "turnId"), &baseline) {
                crate::logs::record("WARN", &e, None);
            }
            let mut response = json!({"threadId":thread,"turnId":r["turnId"],"resolved":result,"submitted":true,"executionOwner":if background {"connector"} else {"desktop"},"desktop":{"state":if background {"not-opened"} else {"owner-confirmed"},"sharedBackend":false}});
            if !background {
                response["desktopUrl"] = json!(format!("codex://threads/{thread}"));
            }
            return Ok(response);
        }
        if operation == "send" {
            let input = task_input(args)?;
            let thread = string(args, "threadId");
            r["threadId"] = json!(thread);
            if let Some(resume) = args.get("resume") {
                let mut resume = resume.clone();
                resume["threadId"] = json!(thread);
                self.request("thread/resume", resume, timeout).await?;
            }
            self.prepare_thread(thread).await?;
            r["executionOwner"] = json!(if self.effective_background(thread).await? {
                "connector"
            } else {
                "desktop"
            });
            let state = self.dispatch_state(thread).await?;
            let active = state["turns"]
                .as_array()
                .and_then(|turns| turns.first())
                .filter(|t| t["status"] == "inProgress");
            if args["sendMode"] == "next" && active.is_some() {
                return crate::dispatch_queue::enqueue(args, r).await;
            }
            if args["sendMode"] == "steer"
                && (active.is_none()
                    || args.get("_expectedActiveTurn").is_some_and(|id| {
                        active.is_none_or(|turn| turn.get("turnId").unwrap_or(&turn["id"]) != id)
                    }))
            {
                return Err("NO_ACTIVE_TURN: steering was not submitted; queue the message or send a new turn explicitly".into());
            }
            params = configured(args, string(&state, "cwd"))?;
            params["threadId"] = json!(thread);
            params["input"] = input;
            r["task"]["directory"] = state["cwd"].clone();
            if args["_newTurn"] == true {
                if active.is_some() {
                    return Err(
                        "QUEUED_OR_RETRY_THREAD_ADVANCED: thread is active; no message submitted"
                            .into(),
                    );
                }
                if args.get("_expectedPreviousTurn").is_some() {
                    let turns = state["turns"].as_array().ok_or("NATIVE_TURNS_MISSING")?;
                    if turns.first().map(|t| &t["id"]).unwrap_or(&Value::Null)
                        != &args["_expectedPreviousTurn"]
                    {
                        return Err("QUEUED_OR_RETRY_THREAD_ADVANCED: no message submitted".into());
                    }
                }
            }
            retry_args["_retryModel"] = params
                .get("model")
                .filter(|m| m.is_string())
                .or_else(|| state.get("model").filter(|m| m.is_string()))
                .or_else(|| state.get("latestModel").filter(|m| m.is_string()))
                .cloned()
                .unwrap_or(Value::Null);
            retry_args["_retryTurn"] = retry_turn(&params);
            if let Some(active) = active {
                self.check_steer(thread, &active["id"]).await?;
                let model = active
                    .get("model")
                    .or_else(|| state["latestThreadSettings"].get("model"))
                    .or_else(|| state.get("latestModel"))
                    .or_else(|| state.get("model"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let effort = active
                    .get("effort")
                    .or_else(|| state["latestThreadSettings"].get("effort"))
                    .or_else(|| state.get("latestReasoningEffort"))
                    .or_else(|| state.get("reasoningEffort"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let tier = active
                    .get("serviceTier")
                    .or_else(|| state["latestThreadSettings"].get("serviceTier"))
                    .cloned()
                    .unwrap_or(json!("unknown"));
                for (field, value) in [("model", model), ("effort", effort), ("serviceTier", tier)]
                {
                    if r["task"]["dispatch"]["source"][field] == "explicit"
                        && r["task"]["dispatch"][field] != value
                    {
                        return Err("ACTIVE_TURN_CONFIGURATION: cannot change model/effort/serviceTier with steer; wait for completion or use sendMode:queue".into());
                    }
                    r["task"]["dispatch"][field] = value;
                    r["task"]["dispatch"]["source"][field] = json!("active-turn");
                }
                r["dispatchMode"] = json!("steered");
                method = "turn/steer".into();
                params["expectedTurnId"] = active.get("turnId").unwrap_or(&active["id"]).clone();
            } else {
                r["dispatchMode"] = json!("new-turn");
                method = "turn/start".into();
                r["turnBaseline"] = crate::changes::capture(
                    params["cwd"]
                        .as_str()
                        .unwrap_or_else(|| string(&state, "cwd")),
                )
                .await;
            }
        }
        if operation == "interrupt" {
            method = "turn/interrupt".into();
            let turn = if let Some(turn) = args["turnId"].as_str() {
                turn.to_owned()
            } else {
                let thread = self
                    .request(
                        "thread/read",
                        json!({"threadId":args["threadId"],"includeTurns":false}),
                        10000,
                    )
                    .await?;
                if thread["thread"]["status"]["type"] != "active" {
                    return Err("NO_ACTIVE_TURN: no active turn is confirmed; read codex_read(statusOnly:true). Supply an explicit turnId only when the owning session confirms it.".into());
                }
                let page = self.request("thread/turns/list", json!({"threadId":args["threadId"],"limit":1,"sortDirection":"desc","itemsView":"full"}), 10000).await?;
                let active = &page["data"][0];
                if active["status"] != "inProgress" {
                    return Err("NO_ACTIVE_TURN: latest native turn is not active; read codex_read(statusOnly:true) before interrupting.".into());
                }
                active["id"]
                    .as_str()
                    .ok_or("NO_ACTIVE_TURN: native owner returned no turn ID")?
                    .to_owned()
            };
            r["turnId"] = json!(turn);
            params = json!({"threadId":args["threadId"],"turnId":turn});
        }
        if args["project"].is_string()
            && matches!(
                method.as_str(),
                "command/exec" | "process/spawn" | "thread/fork"
            )
        {
            let mut directory_args = args.clone();
            if let Some(cwd) = params.get("cwd") {
                directory_args["cwd"] = cwd.clone();
            }
            params["cwd"] = crate::projects::working_directory(self, &directory_args).await?;
        }
        r["threadId"] = params["threadId"].clone();
        r["state"] = json!(if method == "command/exec" {
            "executing"
        } else {
            "submitting"
        });
        if operation == "send" {
            r["task"]["dispatch"]["submittedAt"] = json!(now());
        }
        self.checkpoint(r)?;
        let result = if method == "thread/start" && r["executionOwner"] == "connector" {
            self.create_background(params, "", Some(r)).await?
        } else if method == "thread/start" {
            let out = self.seed(params, "", Some(r)).await?;
            desktop::reveal(self.ipc().await?.as_ref(), string(&out["thread"], "id")).await?;
            out
        } else if method == "turn/start" && r["turnBaseline"].is_object() {
            self.request_inner(&method, params, timeout, false).await?
        } else {
            self.request(&method, params, timeout).await?
        };
        let result = if method == "command/exec" && args["outputBudget"].is_number() {
            crate::shell_command::budget(result, args)?
        } else {
            result
        };
        if result["turn"]["id"].is_string() {
            r["turnId"] = result["turn"]["id"].clone();
            if r["turnBaseline"].is_object() {
                if let Err(e) = crate::changes::record(
                    string(r, "threadId"),
                    string(r, "turnId"),
                    &r["turnBaseline"],
                ) {
                    crate::logs::record("WARN", &e, None);
                }
            }
        }
        if operation == "send" {
            let turn = result["turn"]["id"]
                .as_str()
                .or_else(|| result["turnId"].as_str())
                .unwrap_or("");
            r["turnId"] = json!(turn);
            crate::dispatch_policy::record(r)?;
            let notification_binding = crate::claude_notify::bind(
                &retry_args,
                string(r, "threadId"),
                turn,
                string(&r["task"], "directory"),
                json!({"op":"codex_send","at":r["createdAt"],"requestId":r["requestId"]}),
            )
            .await;
            crate::claude_notify::record_binding(r, notification_binding);
        }
        Ok(result)
    }
    pub async fn tool(self: &Arc<Self>, name: &str, args: Value) -> Result<Value> {
        let warnings = crate::coordination::bulletin::command_warnings(name, &args);
        let mut result = self.tool_inner(name, args.clone()).await;
        if let (Some(warnings), Ok(value)) = (warnings, &mut result) {
            value["conflicts"] = warnings["conflicts"].clone();
            value["conflictCoverage"] = warnings["conflictCoverage"].clone();
        }
        crate::coordination::ax::observe_control_result(name, &args, &result);
        result
    }
    async fn tool_inner(self: &Arc<Self>, name: &str, mut args: Value) -> Result<Value> {
        let catalog = catalog();
        let spec = catalog["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .ok_or("UNKNOWN_TOOL")?;
        crate::egress::validate_op(spec, &args)?;
        crate::egress::normalize_args(name, &mut args)?;
        for (k, v) in spec["inputSchema"]["properties"]
            .as_object()
            .into_iter()
            .flatten()
        {
            if args.get(k).is_none() {
                if let Some(default) = v.get("default") {
                    args[k] = default.clone();
                }
            }
        }
        if name == "command" && args["cmd"].is_string() {
            return self.mutate("command", args).await;
        }
        let domain = &catalog["domains"][name];
        if domain.is_object() {
            let action = string(&args, "action");
            let mapping = &domain["actions"][action];
            let method = mapping[0].as_str().ok_or("UNKNOWN_ACTION")?;
            let params = args.get("params").cloned().unwrap_or_else(|| {
                if method == "account/workspaceMessages/read" {
                    Value::Null
                } else {
                    json!({})
                }
            });
            if mapping[1] == true {
                return self
                    .request(method, params, args["timeoutMs"].as_u64().unwrap_or(60000))
                    .await;
            }
            let mut native_args = json!({"method":method,"params":params,"requestId":args["requestId"],"timeoutMs":args["timeoutMs"].as_u64().unwrap_or(86400000),"waitMs":num(&args,"waitMs",25000)});
            if name == "command" && action == "exec" {
                if let Some(budget) = args.get("outputBudget") {
                    native_args["outputBudget"] = budget.clone();
                }
            }
            if args["project"].is_string() {
                native_args["project"] = args["project"].clone();
                if let Some(root) = args.get("root") {
                    native_args["root"] = root.clone();
                }
            }
            return self.mutate("native", native_args).await;
        }
        match name {
            "runtime_metrics" => Ok(self.runtime_metrics().await),
            "events" => crate::coordination::query(&args),
            "board"
            | "notice_post"
            | "notice_update"
            | "notice_close"
            | "blocker_open"
            | "blocker_clear"
            | "coordination_session" => crate::coordination::bulletin::call(name, args, self).await,
            "message_send" | "message_route" | "messages" => {
                crate::coordination::messages::call(name, args, &self.session).await
            }
            "ax_report" | "ax_list" | "ax_candidate" | "ax_triage" | "ax_issue_draft" => {
                crate::coordination::ax::call(name, args, &self.session).await
            }
            "codex_review" => self.mutate("review", args).await,
            "screen" => crate::screen::call(args).await,
            "projects" => Ok(
                json!({"observedAt":now(),"source":"codex-app-server:project/list","projects":crate::projects::list(self).await?}),
            ),
            "overview" => {
                let mut result = crate::projects::query(self, name, &args).await?;
                result["permissions"] =
                    crate::transport::forward_request("permissions", "GET", json!({})).await?;
                Ok(result)
            }
            "tree" | "search" | "read" | "git" => crate::projects::query(self, name, &args).await,
            "edit" | "write" | "git_write" => self.mutate(name, args).await,
            "logs" => {
                args["descending"] = json!(true);
                crate::logs::query(&args)
            }
            "codex_changes" => crate::changes::query(self, &args).await,
            "codex_create" => self.mutate("create", args).await,
            "codex_send" => self.mutate("send", args).await,
            "codex_resume" => self.mutate("resume", args).await,
            "codex_queue" => crate::dispatch_queue::query(&args).await,
            "codex_queue_control" => crate::dispatch_queue::control(self, &args).await,
            "app_env" => crate::app_env::control(&args),
            "acceptance_fault" => crate::acceptance_fault::control(&args),
            "codex_release" => self.mutate("release", args).await,
            "codex_owner" => {
                let mut owner = self.observe_ownership(string(&args, "threadId")).await?;
                if owner["state"] == "held" {
                    owner["processes"] = crate::writer::processes(string(&args, "threadId")).await;
                    owner["next"] = crate::writer::release_step(string(&args, "threadId"), &owner);
                }
                Ok(owner)
            }
            "codex_archive" => self.mutate("archive", args).await,
            "codex_interrupt" => self.mutate("interrupt", args).await,
            "codex_call" => self.mutate("native", args).await,
            "codex_query" => {
                self.request(string(&args, "method"), args["params"].clone(), 60000)
                    .await
            }
            "file_search" => self.request("fuzzyFileSearch", args, 60000).await,
            "codex_schema" => self.schema(&args).await,
            "receipt" => {
                let action = args["action"].as_str().unwrap_or("read");
                if action == "read" {
                    self.receipt(string(&args, "requestId")).await
                } else {
                    self.decide(
                        string(&args, "requestId"),
                        action,
                        "cloud",
                        num(&args, "waitMs", 25000) as u64,
                    )
                    .await
                }
            }
            "notify_status" => {
                if let Some(thread) = args["threadId"].as_str() {
                    if uuid::Uuid::parse_str(thread).is_ok() {
                        let _ = self.observe_ownership(thread).await;
                    }
                }
                crate::claude_notify::notify_status(&args).await
            }
            "request_route" => crate::claude_notify::routing::control(&args, false),
            "notify_control" => crate::claude_notify::notify_control(&args).await,
            "inbox_wait" => crate::claude_notify::inbox_wait(self, &args).await,
            "notification_ack" => crate::claude_notify::acknowledge(&args).await,
            "codex_interactions" => crate::egress::interaction_history(&args),
            "codex_pending" => {
                if let Some(thread) = args["threadId"].as_str() {
                    if !self.effective_background(thread).await? {
                        self.ipc().await?.read(thread, true).await?;
                    }
                }
                let mut requests: Vec<_> = self
                    .events
                    .lock()
                    .await
                    .pending_interactions()
                    .into_iter()
                    .filter(|r| {
                        args["threadId"].is_null() || r["params"]["threadId"] == args["threadId"]
                    })
                    .map(|mut r| {
                        if r["responseId"].is_null() {
                            r["responseId"] = json!(r["id"].to_string());
                        }
                        r
                    })
                    .collect();
                let origin = crate::kernel::origin::current_origin();
                for request in &mut requests {
                    crate::respond_tokens::issue(string(&origin, "sourceId"), request)?;
                    let task = string(&request["params"], "threadId").to_owned();
                    crate::claude_notify::routing::observe("codex", &task, request)?;
                    request["questionSummary"] = crate::egress::interaction_preview(request);
                }
                Ok(json!({"backendSession":self.session,"requests":requests}))
            }
            "codex_respond" => self.mutate("respond", args).await,
            "codex_events" => {
                let e = self.events.lock().await;
                let after = num(&args, "after", 0) as u64;
                Ok(
                    json!({"backendSession":self.session,"reset":args.get("backendSession").is_some()&&args["backendSession"]!=self.session,"gap":after.saturating_add(1)<e.rows.first().and_then(|r|r["cursor"].as_u64()).unwrap_or_else(||e.sequence.saturating_add(1)),"events":e.rows.iter().filter(|r|r["cursor"].as_u64().unwrap_or(0)>after).take(num(&args,"limit",100).min(2000)).collect::<Vec<_>>(),"latestCursor":e.sequence,"retention":"memory-window","historyOp":"codex_read"}),
                )
            }
            "control_output" => crate::kernel::results::read_output(&args),
            "codex_tasks" => crate::task_overview::list(self, &args).await,
            "codex_wait" => crate::waiter::codex_wait(self, &args).await,
            "codex_read" => {
                let id = string(&args, "threadId");
                let mut t = self
                    .request(
                        "thread/read",
                        json!({"threadId":id,"includeTurns":false}),
                        60000,
                    )
                    .await?["thread"]
                    .clone();
                let deadline = tokio::time::Instant::now()
                    + Duration::from_millis(num(&args, "waitMs", 0).min(10000) as u64);
                while t["status"]["type"] == "active" && tokio::time::Instant::now() < deadline {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    t = self
                        .request(
                            "thread/read",
                            json!({"threadId":id,"includeTurns":false}),
                            60000,
                        )
                        .await?["thread"]
                        .clone();
                }
                if args["view"] == "summary"
                    || (args["statusOnly"] == true && args["turnId"].is_string())
                {
                    let page = crate::review::turn_page(self, &args).await?;
                    let mut turns = page["data"].as_array().cloned().unwrap_or_default();
                    turns.reverse();
                    let mut native = t.clone();
                    native["turns"] = json!(turns);
                    let pending = self
                        .events
                        .lock()
                        .await
                        .pending
                        .values()
                        .cloned()
                        .collect::<Vec<_>>();
                    let mut status = crate::waiter::classify(
                        &json!({"thread":native,"pending":pending}),
                        &mut args["turnId"].as_str().map(str::to_owned),
                    );
                    if args["view"] == "summary" {
                        status["files"] = turns
                            .iter()
                            .find(|turn| turn["id"] == status["turnId"])
                            .map(|turn| {
                                crate::review::native_files(
                                    turn["items"].as_array().map(Vec::as_slice).unwrap_or(&[]),
                                )
                            })
                            .unwrap_or(Value::Null);
                    }
                    return Ok(status);
                }
                if args["statusOnly"] == true {
                    let mut progress = crate::review::progress(self, id, &t).await;
                    if t["status"]["activeFlags"].as_array().is_some_and(|flags| {
                        flags.iter().any(|flag| {
                            matches!(
                                flag.as_str(),
                                Some("waitingOnApproval" | "waitingOnUserInput")
                            )
                        })
                    }) && progress["pendingInteractionCount"] == 0
                    {
                        progress["pendingInteractionCount"] = Value::Null;
                        progress["interactionRequired"] = json!(true);
                    }
                    let mut status = progress.as_object_mut().unwrap().remove("status").unwrap_or_else(|| json!({"state":"unconfirmed","reason":"progress-unavailable","runtimeStatus":t["status"]["type"]}));
                    status["threadId"] = json!(id);
                    status["turns"] = Value::Null;
                    status["stateScope"] = json!("turn");
                    status["observedAt"] = json!(now());
                    status["progress"] = progress;
                    return Ok(status);
                }
                if args["view"] == "review" {
                    let page = crate::review::turn_page(self, &args).await?;
                    let mut turns = Vec::new();
                    for turn in page["data"].as_array().into_iter().flatten() {
                        turns.push(crate::review::turn(self, id, turn).await);
                    }
                    return Ok(
                        json!({"threadId":id,"turns":turns,"nextCursor":page["nextCursor"]}),
                    );
                }
                let full = args["view"] == "full";
                let mut result = if full {
                    summary(&t)
                } else {
                    json!({"threadId":id,"title":t["name"],"runtimeStatus":t["status"]["type"],"observedAt":now()})
                };
                result["origin"] = crate::sources::task_origin(id, None);
                result["srcConversation"] = crate::src_conversations::task_ref("codex", id)?;
                if !full
                    && t["status"]["activeFlags"]
                        .as_array()
                        .is_some_and(|flags| !flags.is_empty())
                {
                    result["activeFlags"] = t["status"]["activeFlags"].clone();
                }
                if args["statusOnly"] != true {
                    let page = crate::review::turn_page(self, &{
                        let mut read = args.clone();
                        if read["limit"].is_null() {
                            read["limit"] = json!(if full { 2 } else { 1 });
                        }
                        read
                    })
                    .await?;
                    result["nextCursor"] = page["nextCursor"].clone();
                    let mut turns = page["data"].as_array().cloned().unwrap_or_default();
                    turns.reverse();
                    let mut native = t.clone();
                    native["turns"] = json!(turns);
                    let pending = self
                        .events
                        .lock()
                        .await
                        .pending
                        .values()
                        .cloned()
                        .collect::<Vec<_>>();
                    let status = crate::waiter::classify(
                        &json!({"thread":native,"pending":pending}),
                        &mut None,
                    );
                    for key in ["state", "reason", "turnId", "recordedStatus"] {
                        result[key] = status[key].clone();
                    }
                    result["stateScope"] = json!("turn");
                    crate::external_inputs::observe(id, &turns, None)?;
                    let external = crate::external_inputs::inputs(id, None)?;
                    result["externalUserInputs"] = json!(external
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(
                            |input| turns.iter().any(|turn| input["turnId"] == turn["id"]
                                || input["answeredTurnId"] == turn["id"])
                        )
                        .collect::<Vec<_>>());
                    if args["includeImages"] == true {
                        let raw: Vec<Value> = page["data"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .flat_map(|turn| {
                                turn["items"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .rev()
                                    .take(15)
                                    .cloned()
                            })
                            .collect();
                        crate::images::attach(
                            &mut result,
                            crate::images::from_items(&raw, id, string(&t, "cwd"), &args),
                        );
                    }
                    let configurations = if full {
                        persisted_turns(&t).configurations
                    } else {
                        HashMap::new()
                    };
                    result["turns"] = json!(page["data"].as_array().into_iter().flatten().map(|turn| {
                        let items: Vec<_> = turn["items"].as_array().into_iter().flatten()
                            .filter_map(|i| if full {Some(item(i,0,600))} else {
                                let mut out = compact_item(i,600)?;
                                if args["includeItemKeys"]==true && out["truncated"]!=true {
                                    out["itemKey"] = json!(item_key(id,string(turn,"id"),i));
                                }
                                Some(out)
                            }).collect();
                        let mut row = json!({"origin":crate::sources::task_origin(id,turn["id"].as_str()),"turnId":turn["id"],"recordedStatus":turn["status"],
                            "items":items.iter().skip(items.len().saturating_sub(15)).collect::<Vec<_>>(),
                            "externalUserInputs":crate::external_inputs::inputs(id, turn["id"].as_str()).unwrap_or(json!([]))});
                        if items.len()>15 {row["itemsTruncated"]=json!(true);}
                        if !turn["error"].is_null() {row["error"]=turn["error"].clone();}
                        if full {
                            row["effectiveConfiguration"] = configurations.get(string(turn,"id")).cloned()
                                .unwrap_or(json!({"source":"unavailable","model":"unknown","effort":"unknown"}));
                        }
                        row
                    }).collect::<Vec<_>>());
                    if !full
                        && result["turns"].as_array().unwrap().iter().any(|t| {
                            t["itemsTruncated"] == true
                                || t["items"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .any(|i| i["truncated"] == true)
                        })
                    {
                        result["readMore"] = json!("Use codex_items with threadId, turnId and view:full for complete items and text pagination.");
                    }
                }
                if full {
                    result["reviews"] = crate::dispatch_policy::reviews(id)
                        .map(|rows| json!(rows))
                        .unwrap_or_else(|error| json!({"unavailable":error}));
                }
                if let Some(turns) = result["turns"].as_array_mut() {
                    for turn in turns {
                        let retry = crate::claude_notify::retry_status(id, string(turn, "turnId"))?;
                        if !retry.is_null() {
                            turn["retry"] = retry;
                        }
                    }
                }
                Ok(result)
            }
            "codex_items" => {
                let full = args["view"] == "full";
                if !full && (num(&args, "offset", 0) > 0 || args["expectedHash"].is_string()) {
                    return Err(crate::egress::invalid_arguments(
                        "codex_items",
                        "/view",
                        "Use view:full for offset/expectedHash text pagination.",
                    ));
                }
                if full && args["knownItemKeys"].is_array() {
                    return Err(crate::egress::invalid_arguments("codex_items","/knownItemKeys","Use compact view to omit known compact items; full view retains all metadata."));
                }
                let known: std::collections::HashSet<&str> = args["knownItemKeys"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                let mut omitted = 0;
                let latest = args["latest"] == true;
                let mut params = args.clone();
                params["sortDirection"] = json!(if latest { "desc" } else { "asc" });
                if latest && args["turnId"].is_null() {
                    if args["cursor"].is_string() {
                        return Err("LATEST_CURSOR_REQUIRES_TURN_ID: continue with the returned turnId, cursor and latest=true".into());
                    }
                    let turns = self.request("thread/turns/list", json!({"threadId":args["threadId"],"limit":1,"sortDirection":"desc","itemsView":"notLoaded"}), 60000).await?;
                    let data = turns["data"].as_array().ok_or("INVALID_TURN_LIST")?;
                    if data.is_empty() {
                        return Ok(
                            json!({"threadId":args["threadId"],"turnId":null,"items":[],"nextCursor":null,"observedAt":now()}),
                        );
                    }
                    params["turnId"] = json!(data[0]["id"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or("INVALID_TURN_ID")?);
                }
                let turn_id = params["turnId"].clone();
                for key in [
                    "offset",
                    "length",
                    "expectedHash",
                    "includeImages",
                    "maxImages",
                    "latest",
                    "view",
                    "knownItemKeys",
                    "includeItemKeys",
                ] {
                    params.as_object_mut().unwrap().remove(key);
                }
                let page = self.request("thread/items/list", params, 60000).await?;
                let items: Vec<_> = page["data"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|r| {
                        let key = if !full && (!known.is_empty() || args["includeItemKeys"] == true)
                        {
                            Some(item_key(
                                string(&args, "threadId"),
                                string(r, "turnId"),
                                &r["item"],
                            ))
                        } else {
                            None
                        };
                        if key.as_deref().is_some_and(|k| known.contains(k)) {
                            omitted += 1;
                            return None;
                        }
                        let mut i = if full {
                            item(
                                &r["item"],
                                num(&args, "offset", 0),
                                num(&args, "length", 6000),
                            )
                        } else {
                            compact_item(&r["item"], num(&args, "length", 6000))?
                        };
                        if !full && args["includeItemKeys"] == true && i["truncated"] != true {
                            i["itemKey"] = json!(key);
                        }
                        i["turnId"] = r["turnId"].clone();
                        Some(i)
                    })
                    .collect();
                if let Some(h) = args["expectedHash"].as_str() {
                    if items.first().is_none_or(|i| i["textHash"] != h) {
                        return Err("CONTENT_CHANGED".into());
                    }
                }
                let mut result = json!({"threadId":args["threadId"],"items":items,"nextCursor":page["nextCursor"],"observedAt":now()});
                if omitted > 0 {
                    result["omittedKnownItems"] = json!(omitted);
                }
                if latest {
                    result["turnId"] = turn_id;
                }
                if !full
                    && result["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|i| i["truncated"] == true)
                {
                    result["readMore"] = json!("Repeat this page with view:full for textHash/offset/nextOffset pagination.");
                }
                if args["includeImages"] == true {
                    let thread = self
                        .request(
                            "thread/read",
                            json!({"threadId":args["threadId"],"includeTurns":false}),
                            60000,
                        )
                        .await?;
                    let mut raw: Vec<Value> = page["data"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|r| r["item"].clone())
                        .collect();
                    if !latest {
                        raw.reverse();
                    }
                    crate::images::attach(
                        &mut result,
                        crate::images::from_items(
                            &raw,
                            string(&args, "threadId"),
                            string(&thread["thread"], "cwd"),
                            &args,
                        ),
                    );
                }
                Ok(result)
            }
            "codex_capabilities" => Ok(
                json!({"version":env!("ARC_BUILD_VERSION"),"backendSession":self.session,"executionOwner":if self.auto_open_codex()? {"desktop"} else {"connector"},"models":self.request("model/list",json!({}),60000).await?,"configuration":self.request("config/read",json!({}),60000).await?}),
            ),
            _ => Err("UNKNOWN_TOOL".into()),
        }
    }
}
fn task_details(operation: &str, args: &Value) -> Result<Option<Value>> {
    let kind = match operation {
        "create" | "send" | "interrupt" => operation,
        "resume" => "send",
        "native" => match string(args, "method") {
            "thread/start" => "create",
            "turn/start" | "turn/steer" | "thread/resume" => "send",
            "turn/interrupt" => "interrupt",
            _ => return Ok(None),
        },
        _ => return Ok(None),
    };
    let native = operation == "native";
    let p = if native {
        args["params"].clone()
    } else {
        configured(args, "")?
    };
    let input = if native {
        p["input"].clone()
    } else if kind != "interrupt" && operation != "resume" {
        task_input(args)?
    } else {
        json!([])
    };
    let prompt = input
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let model = p
        .get("model")
        .or_else(|| args["thread"].get("model"))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(Some(
        json!({"kind":kind,"title":dispatch_title(&json!({"title":args["title"],"prompt":prompt})),"prompt":prompt,"input":input,
        "project":args["project"],"directory":if native{p["cwd"].clone()}else{args["thread"]["cwd"].clone()},
        "threadId":if native{p["threadId"].clone()}else{args["threadId"].clone()},
        "model":model,"effort":p["effort"],
        "settings":if native{json!({"params":p})}else{json!({"thread":args["thread"],"turn":args["turn"],"resume":args["resume"],"mode":args["mode"],"networkAccess":args["networkAccess"],"serviceTier":args["serviceTier"]})}}),
    ))
}
pub(crate) fn dispatch_title(args: &Value) -> String {
    static PREFIX: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^\s*(?:(?:[#>]+|[-*+]|[0-9]+[.)])\s+)*").unwrap()
    });
    let explicit = string(args, "title").trim();
    if !explicit.is_empty() {
        return explicit
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(120)
            .collect();
    }
    let input = args["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = args["prompt"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&input);
    let line = prompt
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    PREFIX.replace(line, "").trim().chars().take(120).collect()
}
fn task_input(args: &Value) -> Result<Value> {
    desktop::input(
        &args
            .get("input")
            .cloned()
            .unwrap_or_else(|| json!([{"type":"text","text":args["prompt"]}])),
    )
}
fn retry_turn(params: &Value) -> Value {
    let mut params = params.clone();
    if let Some(p) = params.as_object_mut() {
        for key in ["input", "threadId", "expectedTurnId"] {
            p.remove(key);
        }
    }
    params
}
fn configured(args: &Value, cwd: &str) -> Result<Value> {
    let mut p = json!({});
    for k in ["model", "effort", "serviceTier"] {
        if let Some(v) = args.get(k) {
            p[k] = v.clone();
        }
    }
    if let Some(o) = args["turn"].as_object() {
        for (k, v) in o {
            p[k] = v.clone();
        }
    }
    if !p["sandboxPolicy"].is_object() && p["permissions"].is_null() {
        if let Some(mode) = args["mode"].as_str() {
            p["sandboxPolicy"] = match mode {
                "danger-full-access" => json!({"type":"dangerFullAccess"}),
                "read-only" => {
                    json!({"type":"readOnly","networkAccess":args["networkAccess"].as_bool().unwrap_or(false)})
                }
                _ => {
                    json!({"type":"workspaceWrite","writableRoots":if cwd.is_empty(){vec![]}else{vec![cwd]},"networkAccess":args["networkAccess"].as_bool().unwrap_or(false),"excludeTmpdirEnvVar":false,"excludeSlashTmp":false})
                }
            };
        }
    }
    if args.get("networkAccess").is_some() && p["sandboxPolicy"].is_null() {
        return Err("networkAccess requires mode or sandboxPolicy".into());
    }
    Ok(p)
}
pub(crate) fn thread(s: &Value, complete: bool) -> Result<Value> {
    let mut t = json!({"id":s["id"],"name":s["title"],"cwd":s["cwd"],"path":s["rolloutPath"],"createdAt":s["createdAt"].as_u64().unwrap_or(0)/1000,"updatedAt":s["updatedAt"].as_u64().unwrap_or(0)/1000,"model":s["latestModel"],"reasoningEffort":s["latestReasoningEffort"],"status":s["threadRuntimeStatus"],"runtimeSource":"codex-desktop-owner"});
    let settings = &s["latestThreadSettings"];
    if let Some(model) = settings.get("model") {
        t["model"] = model.clone();
    }
    if let Some(effort) = settings.get("effort") {
        t["reasoningEffort"] = effort.clone();
    } else if let Some(effort) = s["latestCollaborationMode"]["settings"].get("reasoning_effort") {
        t["reasoningEffort"] = effort.clone();
    }
    if let Some(provider) = settings.get("modelProvider") {
        t["modelProvider"] = provider.clone();
    }
    if complete {
        t["turns"] = Value::Array(desktop::turns(s)?)
    }
    Ok(t)
}
fn page(kind: &str, args: &Value, data: Vec<Value>) -> Result<Value> {
    let binding = json!({"kind":kind,"threadId":args["threadId"],"turnId":args["turnId"],"direction":args["sortDirection"]});
    let mut offset = 0;
    if let Some(cursor) = args["cursor"].as_str() {
        let bytes = URL_SAFE_NO_PAD
            .decode(
                cursor
                    .strip_prefix("desktop:")
                    .ok_or("DESKTOP_CURSOR_MISMATCH: cursor belongs to another read; reuse the same op, threadId and selection (turnId/latest for codex_items), or omit cursor to restart pagination")?,
            )
            .map_err(|e| e.to_string())?;
        let c: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if c["binding"] != binding {
            return Err("DESKTOP_CURSOR_MISMATCH: cursor belongs to another read; reuse the same op, threadId and selection (turnId/latest for codex_items), or omit cursor to restart pagination".into());
        }
        offset = num(&c, "offset", 0);
    }
    let limit = num(args, "limit", 50).clamp(1, 100);
    let end = offset.saturating_add(limit);
    Ok(
        json!({"data":data.iter().skip(offset).take(limit).collect::<Vec<_>>(),"nextCursor":if end<data.len(){Some(format!("desktop:{}",URL_SAFE_NO_PAD.encode(json!({"binding":binding,"offset":end}).to_string())))}else{None}}),
    )
}
pub(crate) fn summary(t: &Value) -> Value {
    let state = match t["status"]["type"].as_str() {
        Some("notLoaded") | None => "unknown",
        Some(v) => v,
    };
    // thread/read returns the authoritative rollout path even for archived threads.
    // Inspect path components lexically: querying thread/list can touch unrelated WSL
    // workspaces on Windows, and filesystem normalization can activate UNC providers.
    let archived = t["path"].as_str().and_then(|path| {
        path.rsplit(['/', '\\']).find_map(|part| match part {
            "archived_sessions" => Some(true),
            "sessions" => Some(false),
            _ => None,
        })
    });
    let mut summary = json!({"archived":archived,"threadId":t["id"],"project":t["cwd"],"title":t["name"],"preview":t["preview"],"cwd":t["cwd"],"runtimeStatus":state,"runtimeSource":if state=="unknown"{json!("persisted-history-only")}else{t["runtimeSource"].clone()},"configuration":{"scope":"thread-defaults","source":"thread/read-or-list","model":t.get("model").unwrap_or(&json!("unknown")),"effort":t.get("reasoningEffort").unwrap_or(&json!("unknown")),"modelProvider":t.get("modelProvider").unwrap_or(&json!("unknown")),"turnEffective":"unknown"},"actions":{"read":true,"send":if state=="idle"{"new-turn"}else if state=="active"{"steer"}else{"requires-native-ownership-check"},"interrupt":"native-ownership-check","configurationChange":if state=="idle"{"new-turn-and-subsequent"}else{"requires-idle"}},"activeFlags":t["status"].get("activeFlags").unwrap_or(&json!([])),"updatedAt":t["updatedAt"],"observedAt":now(),"businessDelivery":"not-assessed"});
    if !cfg!(target_os = "linux") && t["runtimeSource"] != "connector-app-server" {
        summary["desktopUrl"] = json!(format!("codex://threads/{}", string(t, "id")));
    }
    summary
}
fn item_key(thread: &str, turn: &str, item: &Value) -> String {
    hash(json!([thread, turn, item]).to_string())
}

fn compact_item(v: &Value, length: usize) -> Option<Value> {
    let mut out = json!({"type":v["type"]});
    let mut truncated = false;
    let mut text = |v: &Value| {
        let mut chars = v.as_str().unwrap_or("").chars();
        let result: String = chars.by_ref().take(length).collect();
        truncated |= chars.next().is_some();
        json!(result)
    };
    match string(v, "type") {
        "agentMessage" => {
            out["text"] = text(&v["text"]);
        }
        "userMessage" => {
            let mut content = v["content"].clone();
            for part in content.as_array_mut().into_iter().flatten() {
                if part["text"].is_string() {
                    part["text"] = text(&part["text"]);
                }
            }
            out["content"] = content;
        }
        "commandExecution" => {
            out["command"] = v["command"].clone();
            out["exitCode"] = v["exitCode"].clone();
            out["status"] = v["status"].clone();
            out["output"] = text(&v["aggregatedOutput"]);
        }
        "fileChange" => {
            out["status"] = v["status"].clone();
            out["changes"] = json!(v["changes"].as_array().into_iter().flatten().map(|change|
                json!({"path":change["path"],"kind":change["kind"],"diff":text(&change["diff"])})).collect::<Vec<_>>());
        }
        "error" => {
            for key in ["message", "code", "error"] {
                if let Some(value) = v.get(key) {
                    out[key] = value.clone();
                }
            }
        }
        _ => return None,
    }
    if truncated {
        out["truncated"] = json!(true);
    }
    Some(out)
}

pub(crate) fn item(v: &Value, offset: usize, len: usize) -> Value {
    let text = match string(v, "type") {
        "agentMessage" => string(v, "text").to_owned(),
        "userMessage" => v["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| v["type"] == "text")
            .map(|v| string(v, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => v.to_string(),
    };
    let units: Vec<u16> = text.encode_utf16().collect();
    let end = offset.saturating_add(len);
    json!({"itemId":v["id"],"type":v["type"],"text":String::from_utf16_lossy(&units[offset.min(units.len())..end.min(units.len())]),"textHash":hash(&text),"offset":offset,"textLength":units.len(),"nextOffset":if end<units.len(){Some(end)}else{None},"textTruncated":end<units.len()})
}

pub(crate) fn open_persisted_history(thread: &Value) -> Result<std::fs::File> {
    let sessions = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap().join(".codex"))
        .join("sessions")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = PathBuf::from(string(thread, "path"));
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if canonical != path
        || !path.starts_with(sessions)
        || path.extension().is_none_or(|e| e != "jsonl")
    {
        return Err("invalid history path".into());
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let file = opts.open(path).map_err(|e| e.to_string())?;
    let stat = file.metadata().map_err(|e| e.to_string())?;
    if !stat.is_file() {
        return Err("invalid history file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if stat.nlink() != 1 {
            return Err("linked history".into());
        }
    }
    Ok(file)
}

pub(crate) fn persisted_history(thread: &Value) -> Result<String> {
    use std::io::Read;
    let file = open_persisted_history(thread)?;
    if file.metadata().map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024 {
        return Err("history too large".into());
    }
    let mut text = String::new();
    file.take(32 * 1024 * 1024)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    Ok(text)
}

#[derive(Default)]
pub(crate) struct PersistedTurns {
    pub configurations: HashMap<String, Value>,
    pub timings: HashMap<String, Value>,
}

pub(crate) fn persisted_turns(thread: &Value) -> PersistedTurns {
    let mut result = PersistedTurns::default();
    use std::io::{BufRead, BufReader};
    if let Ok(file) = open_persisted_history(thread) {
        let mut matched = false;
        let mut thread_tier = json!("unknown");
        let mut turn_tiers = HashMap::new();
        let mut active_turn = String::new();
        for line in BufReader::new(file)
            .lines()
            .map_while(std::result::Result::ok)
            .filter(|l| l.len() <= 1024 * 1024)
        {
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let p = &event["payload"];
            if event["type"] == "session_meta" {
                matched = p["id"] == thread["id"];
            }
            if matched && event["type"] == "event_msg" {
                if p["type"] == "thread_settings_applied" && p["thread_id"] == thread["id"] {
                    thread_tier = p["thread_settings"]
                        .get("service_tier")
                        .cloned()
                        .unwrap_or(json!("unknown"));
                }
                if p["type"] == "task_started" && p["turn_id"].is_string() {
                    active_turn = string(p, "turn_id").into();
                    turn_tiers.insert(active_turn.clone(), thread_tier.clone());
                    if event["timestamp"].is_string() {
                        result
                            .timings
                            .entry(active_turn.clone())
                            .or_insert(json!({}))["startedAt"] = event["timestamp"].clone();
                    }
                }
            }
            if matched
                && event["type"] == "event_msg"
                && matches!(string(p, "type"), "task_complete" | "turn_aborted")
            {
                let turn = p["turn_id"].as_str().unwrap_or(&active_turn);
                if !turn.is_empty() && event["timestamp"].is_string() {
                    result.timings.entry(turn.into()).or_insert(json!({}))["endedAt"] =
                        event["timestamp"].clone();
                }
            }
            if matched
                && event["type"] == "turn_context"
                && p["cwd"] == thread["cwd"]
                && p["turn_id"].is_string()
            {
                let value = |key: &str| p.get(key).cloned().unwrap_or(json!("unknown"));
                result.configurations.insert(string(p,"turn_id").into(), json!({"scope":"turn","source":"native-persisted-turn-context","turnId":p["turn_id"],"model":value("model"),"effort":value("effort"),"mode":p["sandbox_policy"].get("type").unwrap_or(&json!("unknown")),"networkAccess":p["sandbox_policy"].get("network_access").unwrap_or(&json!("unknown")),"serviceTier":value("service_tier"),"threadServiceTier":turn_tiers.get(string(p,"turn_id")).unwrap_or(&json!("unknown")),"approvalPolicy":value("approval_policy"),"observedAt":now()}));
            }
        }
    }
    result
}

#[cfg(test)]
mod pagination_tests {
    use super::*;
    #[test]
    fn dispatch_titles_use_control_source_text() {
        // Property: dispatch titles use control source text.
        assert_eq!(
            dispatch_title(&json!({"prompt":"\n## Verify task\nDo work"})),
            "Verify task"
        );
        assert_eq!(
            dispatch_title(&json!({"title":" Explicit\n title ","prompt":"ignored"})),
            "Explicit title"
        );
        assert_eq!(
            dispatch_title(&json!({"input":[{"type":"text","text":"1. Input title\nDetails"}]})),
            "Input title"
        );
        let unicode_prompt = "題".repeat(130);
        assert_eq!(
            dispatch_title(&json!({"prompt":unicode_prompt}))
                .chars()
                .count(),
            120
        );
        assert_eq!(dispatch_title(&json!({})), "");
    }
    #[tokio::test]
    async fn fresh_submission_skips_unmaterialized_history_but_existing_turns_are_read() {
        // Regression: 775472c; fresh submission skips unmaterialized history but existing turns are read.
        let history = submission_history(true, |_| {
            std::future::ready(Err("thread is not materialized yet".into()))
        })
        .await
        .unwrap();
        assert!(history.is_empty());
        let history = submission_history(false, |cursor| {
            std::future::ready(Ok(if cursor.is_null() {
                json!({"data":[{"id":"newer"}],"nextCursor":"older"})
            } else {
                json!({"data":[{"id":"older"}],"nextCursor":null})
            }))
        })
        .await
        .unwrap();
        assert_eq!(history, vec![json!({"id":"older"}), json!({"id":"newer"})]);
    }
    #[test]
    fn cleanup_ignores_only_unmaterialized_threads() {
        // Property: cleanup ignores only unmaterialized threads.
        assert_eq!(cleanup_result(Err("NATIVE_RPC_ERROR: thread example is not materialized yet; thread/archive is unavailable before first user message".into())).unwrap(), json!({"archived":false,"reason":"thread-not-materialized"}));
        assert_eq!(
            cleanup_result(Ok(json!({}))).unwrap(),
            json!({"archived":true})
        );
        assert_eq!(
            cleanup_result(Err("RPC_TIMEOUT: thread/archive".into())).unwrap_err(),
            "RPC_TIMEOUT: thread/archive"
        );
    }
    #[test]
    fn desktop_cursor_retains_binding_and_explains_restart() {
        // Property: desktop cursor retains binding and explains restart.
        let mut args =
            json!({"threadId":"thread","turnId":"turn","sortDirection":"desc","limit":1});
        let data = vec![json!({"id":"one"}), json!({"id":"two"})];
        let first = page("thread/items/list", &args, data.clone()).unwrap();
        args["cursor"] = first["nextCursor"].clone();
        assert_eq!(
            page("thread/items/list", &args, data.clone()).unwrap()["data"][0]["id"],
            "two"
        );
        args["threadId"] = json!("other");
        let error = page("thread/items/list", &args, data).unwrap_err();
        assert!(error.starts_with("DESKTOP_CURSOR_MISMATCH:"));
        assert!(error.contains("omit cursor"));
    }
}
