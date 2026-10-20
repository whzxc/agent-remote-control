//! Common task host. Codex's native Control remains the owner of all native semantics.
use crate::*;
use std::collections::{HashMap, HashSet};
mod activity;
mod adapter;
mod dispatch;
pub(crate) mod driver;
mod manifest;
mod process;
mod wait;

/// Codex Desktop supplies the CLI on desktop platforms; Linux uses the installed CLI.
pub fn codex_binary() -> Option<PathBuf> {
    if cfg!(target_os = "linux") {
        driver::discover("codex")
    } else {
        crate::desktop::installation().map(|i| i.binary)
    }
}

struct Operation {
    task: String,
    previous_turn: Value,
    job: tokio::task::JoinHandle<()>,
}
use driver::{AgentDriver, Manifest};
use process::Process;

pub struct AgentHost {
    activity: Mutex<activity::Monitor>,
    drivers: HashMap<String, AgentDriver>,
    adapter_job: Mutex<Option<tokio::task::JoinHandle<()>>>,
    adapter_error: Mutex<Option<String>>,
    inventory_cache: Mutex<Option<(std::time::Instant, Value)>>,
    disabled: Mutex<HashSet<String>>,
    processes: Mutex<HashMap<String, Arc<Process>>>,
    operations: Mutex<HashMap<String, Operation>>,
    requests: crate::kernel::receipts::RequestLocks,
    session: String,
    lifecycle: Mutex<()>,
    wake: Arc<tokio::sync::Notify>,
}
fn task_path(task: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(task).map_err(|_| "INVALID_TASK_ID")?;
    Ok(root().join("agents/tasks").join(format!("{task}.json")))
}
fn save_task(task: &Value) -> Result<()> {
    save(&task_path(string(task, "taskId"))?, task)
}
const RECEIPTS: crate::kernel::receipts::ReceiptStore =
    crate::kernel::receipts::ReceiptStore::new("agents/requests");
impl AgentHost {
    pub fn new() -> Result<Arc<Self>> {
        if let Err(error) = adapter::prune() {
            crate::logs::record(
                "WARN",
                &format!("Cannot prune unused Agent components: {error}"),
                None,
            );
        }
        let mut drivers = HashMap::from([
            ("codex".into(), AgentDriver::CodexNative),
            ("pi".into(), AgentDriver::Pi),
        ]);
        for m in manifest::builtins()? {
            m.validate()?;
            if drivers.insert(m.id.clone(), AgentDriver::Acp(m)).is_some() {
                return Err("INVALID_OR_DUPLICATE_AGENT_ID".into());
            }
        }
        let path = root().join("agents/manifests.json");
        if path.exists() {
            let manifests: Vec<Manifest> =
                serde_json::from_value(load(&path)?).map_err(|e| e.to_string())?;
            for m in manifests {
                m.validate()?;
                if drivers.contains_key(&m.id) {
                    return Err("INVALID_OR_DUPLICATE_AGENT_ID".into());
                }
                drivers.insert(m.id.clone(), AgentDriver::Acp(m));
            }
        }
        let preferences = root().join("agents/disabled.json");
        let disabled: HashSet<String> = if preferences.exists() {
            serde_json::from_value(load(&preferences)?).map_err(|e| e.to_string())?
        } else {
            HashSet::new()
        };
        Ok(Arc::new(Self {
            activity: Default::default(),
            disabled: Mutex::new(disabled),
            drivers,
            adapter_job: Default::default(),
            adapter_error: Default::default(),
            inventory_cache: Default::default(),
            processes: Default::default(),
            operations: Default::default(),
            requests: Default::default(),
            session: id(),
            lifecycle: Mutex::new(()),
            wake: Default::default(),
        }))
    }
    async fn ensure_enabled(&self, agent: &str) -> Result<()> {
        if self.disabled.lock().await.contains(agent) {
            return Err("AGENT_DISABLED".into());
        }
        if agent == "claude" && !adapter::ready() {
            return Err("CLAUDE_ADAPTER_NOT_READY".into());
        }
        Ok(())
    }
    pub async fn set_enabled(self: &Arc<Self>, body: &Value) -> Result<Value> {
        let agent = string(body, "agent");
        if !self.drivers.contains_key(agent) {
            return Err("UNKNOWN_AGENT".into());
        }
        let enabled = body["enabled"]
            .as_bool()
            .ok_or("ENABLED_BOOLEAN_REQUIRED")?;
        if agent == "claude" {
            let mut job = self.adapter_job.lock().await;
            if let Some(active) = job.as_ref() {
                if !active.is_finished() && enabled {
                    return Ok(json!({"enabled":false,"preparing":true}));
                }
            }
            if let Some(active) = job.take() {
                active.abort();
                let _ = active.await;
            }
            *self.adapter_error.lock().await = None;
            if enabled && !adapter::ready() {
                let host = self.clone();
                *job = Some(tokio::spawn(async move {
                    let result = async {
                        adapter::prepare().await?;
                        let mut disabled = host.disabled.lock().await;
                        let mut next = disabled.clone();
                        next.remove("claude");
                        save(&root().join("agents/disabled.json"), &json!(next))?;
                        *disabled = next;
                        Ok::<_, String>(())
                    }
                    .await;
                    *host.adapter_error.lock().await = result.err();
                    *host.inventory_cache.lock().await = None;
                }));
                return Ok(json!({"enabled":false,"preparing":true}));
            }
        }
        let mut disabled = self.disabled.lock().await;
        let mut next = disabled.clone();
        if enabled {
            next.remove(agent);
        } else {
            next.insert(agent.to_owned());
        }
        save(&root().join("agents/disabled.json"), &json!(next))?;
        *disabled = next;
        Ok(json!({"agent":agent,"enabled":enabled}))
    }
    /// Local UI action; interactive launches are owned by the user's app/terminal.
    #[cfg(target_os = "linux")]
    pub async fn open_interactive(&self, _agent: &str) -> Result<Value> {
        Err("TERMINAL_UNSUPPORTED: headless Linux cannot open a terminal or Codex Desktop; run the Agent CLI in your own terminal.".into())
    }
    pub async fn open_claude_login(&self) -> Result<Value> {
        #[cfg(target_os = "linux")]
        {
            Ok(json!({"command":"claude auth login"}))
        }
        #[cfg(not(target_os = "linux"))]
        {
            self.launch_interactive("claude", " auth login").await
        }
    }
    #[cfg(not(target_os = "linux"))]
    pub async fn open_interactive(&self, agent: &str) -> Result<Value> {
        self.launch_interactive(agent, "").await
    }
    #[cfg(not(target_os = "linux"))]
    async fn launch_interactive(&self, agent: &str, arguments: &str) -> Result<Value> {
        let driver = self.drivers.get(agent).ok_or("UNKNOWN_AGENT")?;
        if matches!(driver, AgentDriver::CodexNative) {
            crate::desktop::open_app().await?;
            return Ok(json!({"opened":true,"target":"desktop"}));
        }
        let binary = if agent == "claude" {
            driver::discover("claude")
        } else {
            driver.binary()
        }
        .ok_or("AGENT_NOT_INSTALLED")?;
        let home = dirs::home_dir().ok_or("HOME_NOT_FOUND")?;
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = root().join("agents/launchers");
            private_dir(&dir)?;
            let script = dir.join(format!("{}.command", id()));
            let quote =
                |p: &std::path::Path| format!("'{}'", p.to_string_lossy().replace('\'', "'\"'\"'"));
            let content = format!(
                "#!/bin/zsh -l\n/bin/rm -f -- {}\ncd -- {} || exit 1\n{}{}\n",
                quote(&script),
                quote(&home),
                quote(&binary),
                arguments
            );
            std::fs::write(&script, content).map_err(|e| e.to_string())?;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
            if let Err(error) =
                crate::output("/usr/bin/open", &[script.to_str().ok_or("INVALID_PATH")?]).await
            {
                let _ = std::fs::remove_file(script);
                return Err(error);
            }
        }
        #[cfg(windows)]
        {
            use base64::Engine;
            use std::os::windows::process::CommandExt;
            let quote =
                |p: &std::path::Path| format!("'{}'", p.to_string_lossy().replace('\'', "''"));
            let script = format!(
                "Set-Location -LiteralPath {}; & {}{}",
                quote(&home),
                quote(&binary),
                arguments
            );
            let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
            let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
            std::process::Command::new("powershell.exe")
                .args(["-NoLogo", "-NoExit", "-EncodedCommand", &encoded])
                .creation_flags(0x00000010)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        return Err("UNSUPPORTED_PLATFORM".into());
        Ok(json!({"opened":true,"target":"terminal"}))
    }
    /// UI polling reuses discovery facts; manual refresh bypasses the cache.
    /// MCP discovery and task launch continue to verify the actual executables.
    pub async fn ui_inventory(&self, refresh: bool) -> Value {
        let mut cache = self.inventory_cache.lock().await;
        if refresh
            || cache
                .as_ref()
                .is_none_or(|(at, _)| at.elapsed().as_secs() >= 300)
        {
            let value = self.inventory().await;
            *cache = Some((std::time::Instant::now(), value));
        }
        let mut value = cache.as_ref().unwrap().1.clone();
        drop(cache);
        self.inventory_status(&mut value).await;
        value
    }
    /// Cached discovery only: subscriptions never probe executables in a GET.
    pub async fn cached_subscription_inventory(&self) -> Option<Value> {
        let mut value = self.inventory_cache.lock().await.as_ref()?.1.clone();
        self.inventory_status(&mut value).await;
        Some(value)
    }
    async fn inventory_status(&self, inventory: &mut Value) {
        let preparing = self
            .adapter_job
            .lock()
            .await
            .as_ref()
            .is_some_and(|j| !j.is_finished());
        let adapter_error = self.adapter_error.lock().await.clone();
        let disabled = self.disabled.lock().await;
        let processes = self.processes.lock().await;
        for row in inventory["agents"].as_array_mut().unwrap() {
            let agent_id = string(row, "agent").to_owned();
            let agent = agent_id.as_str();
            let enabled = !disabled.contains(agent) && (agent != "claude" || adapter::ready());
            if agent == "claude" {
                row["adapter"] = json!({"state":if preparing {"preparing"} else if adapter_error.is_some() {"failed"} else if adapter::ready() {"ready"} else {"missing"},"error":adapter_error,"managed":true});
            }
            let ready = processes.values().any(|p| {
                p.alive.load(std::sync::atomic::Ordering::SeqCst)
                    && p.state.try_lock().is_ok_and(|s| s["agent"] == agent)
            });
            row["enabled"] = json!(enabled);
            row["status"] = json!(if ready {
                "ready"
            } else if row["available"] == true {
                "installed"
            } else {
                "unavailable"
            });
        }
    }
    pub async fn activity(&self, selected: Vec<String>) -> Value {
        let processes: Vec<_> = self.processes.lock().await.values().cloned().collect();
        let mut active = std::collections::BTreeSet::new();
        for process in processes {
            if process.alive.load(std::sync::atomic::Ordering::SeqCst) {
                let state = process.state.lock().await;
                if state["status"] == "running" {
                    active.insert(string(&state, "agent").to_owned());
                }
            }
        }
        let disabled = self.disabled.lock().await.clone();
        let selected = selected
            .into_iter()
            .filter(|id| !disabled.contains(id))
            .collect();
        active.extend(self.activity.lock().await.sample(selected).await);
        active.retain(|id| !disabled.contains(id));
        json!({"activeAgents":active,"observedAt":now(),"scope":"selected-local-transcripts-and-connector-live-sessions"})
    }
    pub async fn inventory(&self) -> Value {
        let mut rows = Vec::new();
        let mut probes = tokio::task::JoinSet::new();
        for (agent, driver) in &self.drivers {
            let agent = agent.clone();
            let driver = driver.clone();
            probes.spawn(async move {
                let discovery = driver.discover().await;
                (agent, driver, discovery)
            });
        }
        while let Some(result) = probes.join_next().await {
            let Ok((agent, driver, (binary, version, discovery_error))) = result else {
                continue;
            };
            let available = discovery_error.is_none();
            let descriptor = driver.descriptor();
            rows.push(json!({"agent":agent,"protocol":driver.protocol(),"installed":binary.is_some(),"available":available,"discoveryError":discovery_error,"descriptor":descriptor,"displayName":descriptor["displayName"],"integration":descriptor["integration"],"version":version.as_deref().map(str::trim),"path":binary,"configuration":"inherited","readiness":"ready means a live initialized session, not provider authentication"}));
        }
        rows.sort_by(|a, b| string(a, "agent").cmp(string(b, "agent")));
        let mut inventory = json!({"agents":rows,"defaultAgent":"codex","observedAt":now()});
        self.inventory_status(&mut inventory).await;
        inventory
    }
    pub(crate) async fn context_task(&self, agent: &str, task: &str) -> Result<Value> {
        if !self.drivers.contains_key(agent) {
            return Err("UNKNOWN_AGENT".into());
        }
        self.task(agent, task).await
    }
    async fn task(&self, agent: &str, task: &str) -> Result<Value> {
        let p = self.processes.lock().await.get(task).cloned();
        let mut value = if let Some(p) = p {
            p.state.lock().await.clone()
        } else {
            let mut t = load(&task_path(task)?)?;
            t["processState"] = json!("stopped");
            if !matches!(
                string(&t, "status"),
                "completed" | "cancelled" | "failed" | "idle"
            ) {
                t["status"] = json!("unknown");
            }
            t
        };
        if value["agent"] != agent {
            return Err("AGENT_TASK_MISMATCH".into());
        }
        value["observedAt"] = json!(now());
        Ok(value)
    }
    async fn process(&self, agent: &str, task: &str, resume: bool) -> Result<Arc<Process>> {
        let _lock = self.lifecycle.lock().await;
        if let Some(p) = self.processes.lock().await.get(task).cloned() {
            if p.alive.load(std::sync::atomic::Ordering::SeqCst) {
                return Ok(p);
            }
        }
        if !resume {
            return Err("PROCESS_NOT_RUNNING".into());
        }
        let state = self.task(agent, task).await?;
        if state["status"] == "unknown" {
            return Err("TASK_UNCONFIRMED_RECONCILE_BEFORE_RESUME".into());
        }
        let p = self.drivers[agent]
            .start(state, true, self.wake.clone())
            .await?;
        self.processes.lock().await.insert(task.into(), p.clone());
        Ok(p)
    }
    pub async fn close(&self) {
        if let Some(job) = self.adapter_job.lock().await.take() {
            job.abort();
            let _ = job.await;
        }
        let _lock = self.lifecycle.lock().await;
        let operations: Vec<_> = self.operations.lock().await.drain().collect();
        for (request, job) in operations {
            job.job.abort();
            let _ = job.job.await;
            if let Ok(path) = RECEIPTS.path(&request) {
                if let Ok(mut r) = load(&path) {
                    if r["state"] == "pending" {
                        r["state"] = json!("unconfirmed");
                        let _ = RECEIPTS.checkpoint(&mut r);
                    }
                }
            }
        }
        let processes = self
            .processes
            .lock()
            .await
            .drain()
            .map(|(_, p)| p)
            .collect::<Vec<_>>();
        self.wake.notify_waiters();
        for p in processes {
            p.close().await;
        }
    }
    pub async fn receipt(self: &Arc<Self>, args: Value) -> Result<Option<Value>> {
        if !RECEIPTS.path(string(&args, "requestId"))?.exists() {
            return Ok(None);
        }
        if crate::kernel::receipts::ReceiptStore::new("")
            .path(string(&args, "requestId"))?
            .exists()
        {
            return Err("REQUEST_ID_CONFLICT: ambiguous receipt owner".into());
        }
        self.decide_receipt(args).await.map(Some)
    }
    async fn decide_receipt(self: &Arc<Self>, args: Value) -> Result<Value> {
        let request = string(&args, "requestId");
        let _request_lock = self.requests.lock(request).await;
        let mut r = RECEIPTS.read(request, &self.session)?;
        let agent_id = string(&r, "agent").to_owned();
        let agent = agent_id.as_str();
        let action = args["action"].as_str().unwrap_or("read");
        if !matches!(action, "read" | "approve" | "bypass" | "reject") {
            return Err("INVALID_APPROVAL_ACTION".into());
        }
        if action != "read" && r["state"] == "awaiting-approval" {
            let driver = if action == "reject" {
                None
            } else {
                Some(self.drivers.get(agent).ok_or("UNKNOWN_AGENT")?.clone())
            };
            r["state"] = json!(if action == "reject" {
                "not-executed"
            } else {
                "pending"
            });
            r["approval"] = json!(action);
            r["backendSession"] = json!(self.session);
            if action != "reject" && r["operation"] != "agent_create" {
                r["previousTurnId"] =
                    self.task(agent, string(&r, "taskId")).await?["turnId"].clone();
            }
            RECEIPTS.checkpoint(&mut r)?;
            if action != "reject" {
                let mut ops = self.operations.lock().await;
                let (job, rx) = self.launch(driver.unwrap(), r.clone());
                ops.insert(request.into(), job);
                drop(ops);
                drop(_request_lock);
                if let Ok(Ok(result)) =
                    tokio::time::timeout(
                        std::time::Duration::from_millis(
                            num(&args, "waitMs", 25000).min(120000) as u64
                        ),
                        rx,
                    )
                    .await
                {
                    return result;
                }
            }
        }
        Ok(r)
    }
    pub(crate) async fn observe_notification(
        self: &Arc<Self>,
        agent: &str,
        task: &str,
        turn: &str,
    ) -> Result<Value> {
        wait::observe(self, agent, task, turn).await
    }
    pub async fn tool(
        self: &Arc<Self>,
        native: &Arc<control::Control>,
        name: &str,
        mut args: Value,
    ) -> Result<Value> {
        let catalog = crate::catalog();
        let spec = catalog["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .ok_or("UNKNOWN_TOOL")?;
        crate::egress::validate_op(spec, &args)?;
        if matches!(name, "agent_create" | "agent_send") {
            crate::claude_notify::normalize(&mut args)?;
        }
        if name == "agents" {
            let mut inventory = self.inventory().await;
            inventory["agents"]
                .as_array_mut()
                .unwrap()
                .retain(|a| a["agent"] != "codex");
            inventory.as_object_mut().unwrap().remove("defaultAgent");
            return Ok(inventory);
        }
        let agent = string(&args, "agent").to_owned();
        if agent == "codex" {
            return Err("USE_CODEX_TOOLS".into());
        }
        if args.get("requestId").is_none() {
            args["requestId"] = json!(id());
        }
        let agent = agent.as_str();
        let driver = self.drivers.get(agent).ok_or("UNKNOWN_AGENT")?;
        self.ensure_enabled(agent).await?;
        if name == "agent_wait" {
            return wait::agent_wait(self, native, &args).await;
        }
        if name == "agent_tasks" {
            let dir = root().join("agents/tasks");
            private_dir(&dir)?;
            let mut tasks = Vec::new();
            for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
                let path = match entry {
                    Ok(entry) => entry.path(),
                    Err(e) => {
                        crate::logs::record("WARN", &format!("Skipping task record: {e}"), None);
                        continue;
                    }
                };
                if path.extension().is_some_and(|e| e == "json") {
                    let result: Result<Option<Value>> = async {
                        let t = load(&path)?;
                        if t["agent"] == agent {
                            Ok(Some(self.task(agent, string(&t, "taskId")).await?))
                        } else {
                            Ok(None)
                        }
                    }
                    .await;
                    match result {
                        Ok(Some(t)) => tasks.push(t),
                        Ok(None) => (),
                        Err(e) => crate::logs::record(
                            "WARN",
                            &format!("Skipping agent task {}: {e}", path.display()),
                            None,
                        ),
                    }
                }
            }
            tasks.sort_by(|a, b| string(b, "updatedAt").cmp(string(a, "updatedAt")));
            let offset = num(&args, "offset", 0);
            let limit = num(&args, "limit", 50).clamp(1, 200);
            let total = tasks.len();
            return Ok(
                json!({"tasks":tasks.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),"total":total,"nextOffset":if offset+limit<total{Some(offset+limit)}else{None}}),
            );
        }
        if name == "agent_capabilities" {
            if let Some(task) = args["taskId"].as_str() {
                let _ = self.task(agent, task).await?;
                let p = self.process(agent, task, false).await?;
                return Ok(p.capabilities.lock().await.clone());
            }
            let (binary, _, error) = driver.discover().await;
            return Ok(
                json!({"agent":agent,"protocol":driver.protocol(),"installed":binary.is_some(),"available":error.is_none(),"discoveryError":error,"descriptor":driver.descriptor(),"negotiated":false,"capabilities":null,"nextAction":"agent_create then agent_capabilities(taskId)"}),
            );
        }
        if name == "agent_read" {
            let mut task = self.task(agent, string(&args, "taskId")).await?;
            task["dispatches"] = json!(crate::dispatch_policy::records(string(&args, "taskId"))?);
            return Ok(task);
        }
        if matches!(name, "agent_events" | "agent_pending") {
            let task = string(&args, "taskId");
            let _ = self.task(agent, task).await?;
            let p = self.process(agent, task, false).await?;
            let backend = p.state.lock().await["processSession"].clone();
            let e = p.events.lock().await;
            if name == "agent_pending" {
                return Ok(json!({"requests":e.pending.values().collect::<Vec<_>>() }));
            }
            let after = num(&args, "after", 0) as u64;
            return Ok(
                json!({"events":e.rows.iter().filter(|r|r["cursor"].as_u64().unwrap_or(0)>after).take(num(&args,"limit",100).min(2000)).collect::<Vec<_>>(),"backendSession":backend,"reset":args.get("backendSession").is_some()&&args["backendSession"]!=backend,"latestCursor":e.sequence,"gap":after.saturating_add(1)<e.rows.first().and_then(|r|r["cursor"].as_u64()).unwrap_or_else(||e.sequence.saturating_add(1)),"persistedOutput":{"outputId":task,"format":"JSONL","error":e.storage_error}}),
            );
        }
        if !matches!(
            name,
            "agent_create" | "agent_send" | "agent_interrupt" | "agent_respond" | "agent_review"
        ) {
            return Err("UNKNOWN_TOOL".into());
        }
        let request = string(&args, "requestId");
        RECEIPTS.path(request)?;
        let mut payload = args.clone();
        payload.as_object_mut().map(|p| p.remove("waitMs"));
        let digest = hash(json!({"name":name,"args":payload}).to_string());
        let request_lock = self.requests.lock(request).await;
        if let Some(receipt) = RECEIPTS.replay(request, &digest, &self.session)? {
            return Ok(receipt);
        }
        let task = if name == "agent_create" {
            id()
        } else {
            string(&args, "taskId").into()
        };
        if name == "agent_create" {
            let cwd = Path::new(string(&args, "cwd"));
            if !cwd.is_absolute() || !cwd.is_dir() {
                return Err("ABSOLUTE_CWD_REQUIRED".into());
            }
        }
        if name == "agent_send" && string(&args, "prompt").is_empty() {
            return Err("PROMPT_REQUIRED".into());
        }
        let needs_approval = matches!(name, "agent_create" | "agent_send" | "agent_interrupt")
            && native.approval_mode()?
            && !matches!(string(&args, "approval"), "approved" | "bypass");
        let previous_turn = if name == "agent_create" {
            Value::Null
        } else {
            self.task(agent, &task).await?["turnId"].clone()
        };
        let receipt = json!({"origin":crate::kernel::origin::current_origin(),"requestId":request,"agent":agent,"taskId":task,"previousTurnId":previous_turn,"operation":name,"arguments":args,"digest":digest,"state":if needs_approval{"awaiting-approval"}else{"pending"},"backendSession":self.session,"createdAt":now(),"nextAction":"receipt"});
        RECEIPTS.reserve(&receipt)?;
        if needs_approval {
            return Ok(receipt);
        }
        let mut ops = self.operations.lock().await;
        let (job, rx) = self.launch(driver.clone(), receipt.clone());
        ops.insert(request.into(), job);
        drop(ops);
        drop(request_lock);
        match tokio::time::timeout(
            std::time::Duration::from_millis(num(&args, "waitMs", 25000).min(120000) as u64),
            rx,
        )
        .await
        {
            Ok(Ok(result)) => result,
            _ => Ok(receipt),
        }
    }
    fn launch(
        self: &Arc<Self>,
        driver: AgentDriver,
        mut r: Value,
    ) -> (Operation, tokio::sync::oneshot::Receiver<Result<Value>>) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let host = self.clone();
        let task = string(&r, "taskId").to_owned();
        let previous_turn = r["previousTurnId"].clone();
        let origin = r["origin"].clone();
        let job = tokio::spawn(crate::kernel::origin::ORIGIN.scope(origin, async move {
            let result = host
                .perform(
                    &driver,
                    string(&r, "operation"),
                    &r["arguments"],
                    string(&r, "taskId"),
                )
                .await;
            match result {
                Ok(v) => {
                    r["state"] = json!(if v["configurationError"].is_string() {
                        "failed"
                    } else {
                        "completed"
                    });
                    if v["configurationError"].is_string() {
                        r["error"] = v["configurationError"].clone();
                    }
                    for key in ["notification", "notificationError"] {
                        if let Some(value) = v.get(key) {
                            r[key] = value.clone();
                        }
                    }
                    r["result"] = v;
                }
                Err(e) => {
                    r["state"] = json!(crate::kernel::receipts::failure_state(&e));
                    r["error"] = json!(e);
                }
            }
            // Failure leaves the original pending receipt; replay is always prohibited.
            let result = RECEIPTS.checkpoint(&mut r).map(|_| r.clone());
            let _ = tx.send(result);
            host.operations.lock().await.remove(string(&r, "requestId"));
            host.wake.notify_waiters();
        }));
        (
            Operation {
                task,
                previous_turn,
                job,
            },
            rx,
        )
    }
    async fn perform(
        &self,
        driver: &AgentDriver,
        name: &str,
        args: &Value,
        task: &str,
    ) -> Result<Value> {
        let agent = string(args, "agent");
        self.ensure_enabled(agent).await?;
        if name == "agent_review" {
            return crate::dispatch_policy::agent_review(args);
        }
        let p = if name == "agent_create" {
            let _guard = self.lifecycle.lock().await;
            let t = json!({"origin":crate::kernel::origin::current_origin(),"taskId":task,"agent":agent,"runtimeSource":driver.protocol(),"sessionId":null,"threadId":null,"cwd":args["cwd"],"title":args["title"],"status":"starting","createdAt":now(),"updatedAt":now(),"metadata":{},"output":""});
            save_task(&t)?;
            let p = match driver.start(t, false, self.wake.clone()).await {
                Ok(p) => p,
                Err(e) => {
                    let mut t = load(&task_path(task)?)?;
                    t["status"] = json!("unknown");
                    t["error"] = json!(e);
                    save_task(&t)?;
                    return Err(e);
                }
            };
            self.processes.lock().await.insert(task.into(), p.clone());
            p
        } else {
            self.process(agent, task, name == "agent_send").await?
        };
        match name {
            "agent_create" | "agent_send" => {
                let _dispatch = p
                    .dispatch
                    .try_lock()
                    .map_err(|_| "TASK_BUSY_OR_UNCONFIRMED")?;
                let snapshot = p.state.lock().await.clone();
                if !matches!(
                    string(&snapshot, "status"),
                    "idle" | "completed" | "cancelled" | "failed"
                ) {
                    return Err("TASK_BUSY_OR_UNCONFIRMED".into());
                }
                // Empty creates expose capabilities without applying policy or recording work.
                if string(args, "prompt").is_empty() {
                    return Ok(snapshot);
                }
                match self.configure_dispatch(&p, args).await {
                    Ok(selection) => {
                        let mut task = p.state.lock().await;
                        task["dispatch"] = selection;
                    }
                    Err(error) => {
                        let snapshot = p.state.lock().await.clone();
                        let facts = self
                            .session_dispatch_facts(&snapshot, true)
                            .await
                            .unwrap_or_else(|e| json!({"unavailable":e}));
                        return Ok(
                            json!({"taskId":task,"agent":agent,"configurationError":error,
                            "promptSubmitted":false,"sessionConfirmation":dispatch::current_configuration(&facts)}),
                        );
                    }
                }
                driver.prompt(&p, string(args, "prompt"), args, name).await
            }
            "agent_interrupt" => driver.interrupt(&p).await,
            "agent_respond" => driver.respond(&p, args).await,
            _ => Err("UNKNOWN_TOOL".into()),
        }
    }
}
