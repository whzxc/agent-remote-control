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
}
const RECEIPTS: crate::kernel::receipts::ReceiptStore =
    crate::kernel::receipts::ReceiptStore::new("");
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
        })
    }
    fn rpc_binary(&self) -> Result<PathBuf> {
        if cfg!(target_os = "linux") && !cfg!(feature = "test-fixture") {
            crate::agents::codex_binary().ok_or_else(|| "CODEX_NOT_FOUND: install Codex CLI and log in as this user; searched PATH, ~/.local/bin, /usr/local/bin, npm global prefixes, nvm, bun and Volta directories.".into())
        } else {
            Ok(self.binary.clone())
        }
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
    pub async fn health(&self) -> Value {
        json!({"appServer":if self.rpc.lock().await.as_ref().is_some_and(|r|r.alive()){"ready"}else{"stopped"},"activeWrites":self.jobs.lock().await.len()})
    }
    pub fn stop_waits(&self) {
        self.shutdown.send_modify(|v| *v = v.wrapping_add(1));
    }
    pub async fn close(&self) {
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
        Ok(path.exists() && load(&path)?["owner"] == "connector")
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
                rpc.call(
                    "thread/resume",
                    json!({"threadId":args["threadId"],"excludeTurns":true}),
                    60000,
                )
                .await?;
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
        let title = if title.trim().is_empty() {
            let line = receipt
                .as_deref()
                .and_then(|r| r["task"]["prompt"].as_str())
                .unwrap_or("")
                .lines()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("ARC task");
            regex::Regex::new(r"^\s*(?:(?:[#>]+|[-*+]|[0-9]+[.)])\s+)*")
                .unwrap()
                .replace(line, "")
                .chars()
                .take(120)
                .collect::<String>()
        } else {
            title.to_owned()
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
                let cleanup = match cleanup {
                    Ok(_) => json!({"archived":true}),
                    Err(error) => json!({"archived":false,"error":error}),
                };
                if let Some(r) = receipt.as_deref_mut() {
                    r["cleanup"] = cleanup;
                } else if cleanup["archived"] != true {
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
    // Only an explicit write may load a persisted thread. Never retry a turn
    // submission on another owner: its acceptance may already be unknown.
    async fn prepare_thread(&self, thread: &str) -> Result<()> {
        #[cfg(feature = "test-fixture")]
        {
            let _ = thread;
            return Ok(());
        }
        #[allow(unreachable_code)]
        if self.background(thread)? {
            return Ok(());
        }
        let ipc = self.ipc().await?;
        match ipc.owner(thread).await {
            Ok(_) => return Ok(()),
            Err(e) if desktop::owner_missing(&e) => (),
            Err(e) => return Err(e),
        }
        // Validate existence before navigation; metadata needs no history API.
        let rpc = self.utility().await?;
        rpc.call(
            "thread/read",
            json!({"threadId":thread,"includeTurns":false}),
            60000,
        )
        .await?;
        match desktop::reveal(&ipc, thread).await {
            Ok(_) => Ok(()),
            Err(e) if desktop::owner_missing(&e) => {
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
    async fn archive_empty_creation(&self, thread: &str) -> Result<bool> {
        let rpc = self.utility().await?;
        let history = rpc
            .call(
                "thread/turns/list",
                json!({"threadId":thread,"limit":1,"itemsView":"notLoaded"}),
                10000,
            )
            .await?;
        if history["data"]
            .as_array()
            .is_none_or(|rows| !rows.is_empty())
        {
            return Ok(false);
        }
        rpc.call("thread/archive", json!({"threadId":thread}), 10000)
            .await?;
        Ok(true)
    }
    pub async fn request(&self, method: &str, args: Value, timeout: u64) -> Result<Value> {
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
                    )
                    .await
                {
                    Ok(t) => crate::changes::capture(string(&t["thread"], "cwd")).await,
                    Err(e) => json!({"unavailable":e}),
                }
            };
            let out = self.request_inner(method, args.clone(), timeout).await?;
            if let Err(e) = crate::changes::record(thread, string(&out["turn"], "id"), &baseline) {
                crate::logs::record("WARN", &e, None);
            }
            return Ok(out);
        }
        self.request_inner(method, args, timeout).await
    }
    async fn request_inner(&self, method: &str, args: Value, timeout: u64) -> Result<Value> {
        #[cfg(feature = "test-fixture")]
        {
            return self.utility().await?.call(method, args, timeout).await;
        }
        #[allow(unreachable_code)]
        if method == "turn/start" || method == "thread/resume" {
            self.prepare_thread(string(&args, "threadId")).await?;
        }
        if self.background(string(&args, "threadId"))? {
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
                    if e.contains("no-client-found")
                        || e.contains("No such file")
                        || e.contains("Connection refused") =>
                {
                    if string(&args, "cursor").starts_with("desktop:") {
                        return Err("DESKTOP_CURSOR_STALE".into());
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
            params["definitions"] = root["definitions"].clone();
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
        let dispatch = if matches!(operation, "create" | "send") {
            if args["sendMode"] == "queue" {
                // Validate now, but choose omitted values when the queue actually dispatches.
                crate::dispatch_policy::resolve(&mut args.clone())?;
                Value::Null
            } else {
                crate::dispatch_policy::resolve(&mut args)?
            }
        } else {
            Value::Null
        };
        let mut receipt = json!({"origin":crate::kernel::origin::current_origin(),"requestId":request,"backendSession":self.session,"digest":digest,"operation":operation,"arguments":args,"state":"reserved","createdAt":now(),"updatedAt":now()});
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
        let wait = if operation == "command" {
            num(&args, "timeoutMs", 60000) as u64 + 10000
        } else {
            num(&args, "waitMs", 25000).min(120000) as u64
        };
        let mut jobs = self.jobs.lock().await;
        let rx = self.launch(operation, args, receipt, &mut jobs);
        drop(jobs);
        drop(request_lock);
        match tokio::time::timeout(Duration::from_millis(wait), rx).await {
            Ok(Ok(r)) => r,
            _ => Ok(
                json!({"requestId":request,"state":"pending","operation":operation,"nextAction":"receipt"}),
            ),
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
            let outcome = c.perform(&op, &args, &mut receipt).await;
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
                            Ok(archived) => json!({"archived":archived}),
                            Err(error) => json!({"archived":false,"error":error}),
                        };
                    }
                    receipt["failureStage"] = receipt["state"].clone();
                    receipt["state"] = json!(crate::kernel::receipts::failure_state(&err));
                    receipt["result"] = json!({"error":crate::egress::failure(&err)});
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
        let mut records = Vec::new();
        for entry in std::fs::read_dir(root()).map_err(|e| e.to_string())? {
            let path = match entry {
                Ok(entry) => entry.path(),
                Err(e) => {
                    crate::logs::record("WARN", &format!("Skipping task record: {e}"), None);
                    continue;
                }
            };
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
                    if let Ok(mut runtime) =
                        load(&root().join("tasks").join(format!("{thread_id}.json")))
                    {
                        runtime["stale"] = json!(true);
                        r["runtime"] = runtime;
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
        Ok(records)
    }
    pub async fn task_runtime(&self, id: &str) -> Result<Value> {
        let path = uuid::Uuid::parse_str(id)
            .ok()
            .map(|_| root().join("tasks").join(format!("{id}.json")));
        let live = tokio::time::timeout(
            Duration::from_secs(5),
            self.request(
                "thread/read",
                json!({"threadId":id,"includeTurns":false}),
                5000,
            ),
        )
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
        if let Some(path) = path {
            save(&path, &snapshot)?;
        }
        Ok(snapshot)
    }
    pub(crate) async fn thread_lock(&self, thread: &str) -> tokio::sync::OwnedMutexGuard<()> {
        self.requests.lock(&format!("thread-write:{thread}")).await
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
            && (matches!(operation, "send" | "interrupt" | "review")
                || (operation == "native"
                    && matches!(
                        string(args, "method"),
                        "turn/start" | "turn/steer" | "turn/interrupt" | "thread/resume"
                    ))) {
            Some(self.thread_lock(thread_key).await)
        } else {
            None
        };

        if operation == "review" {
            r["threadId"] = args["threadId"].clone();
            return crate::dispatch_policy::review(self, args).await;
        }
        if matches!(operation, "edit" | "write") {
            return crate::text_files::write(self, operation, args).await;
        }
        if operation == "command" {
            return crate::shell_command::run(self, args).await;
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
            let recovered = args["backendSession"] != self.session;
            if recovered
                && !token_request
                    .as_ref()
                    .is_some_and(|r| r["owner"] == "desktop")
                && !crate::claude_notify::recoverable_response(key, string(args, "backendSession"))?
            {
                return Err("STALE_INTERACTION".into());
            }
            // Refresh the Desktop snapshot after restart; never depend on an empty pending cache.
            if let Ok(identity) = serde_json::from_str::<Value>(key) {
                if identity[0] == "desktop" {
                    let thread = identity[1].as_str().ok_or("STALE_INTERACTION")?;
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
                .ok_or("STALE_INTERACTION")?;
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
                return Err("STALE_INTERACTION".into());
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
                let result = self.ipc().await?.respond(key, &args["result"]).await?;
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
            rpc.write(response)
                .await
                .map_err(|e| format!("SUBMISSION_UNCONFIRMED: {e}"))?;
            self.events.lock().await.pending.remove(key);
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
            if let Some(project) = args["project"].as_str() {
                let p = crate::projects::resolve(self, project).await?;
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
            let baseline = crate::changes::capture(
                turn["cwd"]
                    .as_str()
                    .unwrap_or_else(|| string(&result["thread"], "cwd")),
            )
            .await;
            r["turnBaseline"] = baseline.clone();
            self.prepare_thread(thread).await?;
            let background = self.background(thread)?;
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
            let out = self.request_inner("turn/start", turn, timeout).await?;
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
            r["executionOwner"] = json!(if self.background(thread)? {
                "connector"
            } else {
                "desktop"
            });
            let state = if self.background(thread)? {
                let mut state = self
                    .request(
                        "thread/read",
                        json!({"threadId":thread,"includeTurns":false}),
                        60000,
                    )
                    .await?["thread"]
                    .clone();
                if state["status"]["type"] == "active" {
                    let latest = self.request("thread/turns/list",
                        json!({"threadId":thread,"limit":1,"sortDirection":"desc","itemsView":"notLoaded"}), 60000).await?;
                    state["turns"] = latest["data"].clone();
                }
                state
            } else {
                // Refresh missing/expired snapshots once; mutate reuses the IPC cache.
                self.ipc().await?.read(thread, false).await?
            };
            let active = state["turnHistory"]["history"]["entitiesByKey"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.values())
                .chain(state["turns"].as_array().into_iter().flatten())
                .find(|t| t["status"] == "inProgress");
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
                    let latest=self.request("thread/turns/list",json!({"threadId":thread,"limit":1,"sortDirection":"desc","itemsView":"notLoaded"}),10000).await?;
                    let turns = latest["data"].as_array().ok_or("NATIVE_TURNS_MISSING")?;
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
                for (field, value) in [("model", model), ("effort", effort)] {
                    if r["task"]["dispatch"]["source"][field] == "explicit"
                        && params[field] != value
                    {
                        return Err("ACTIVE_TURN_CONFIGURATION: cannot change model/effort with steer; wait for completion or use sendMode:queue".into());
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
            params = json!({"threadId":args["threadId"],"turnId":args["turnId"]});
        }
        r["threadId"] = params["threadId"].clone();
        r["state"] = json!("submitting");
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
            self.request_inner(&method, params, timeout).await?
        } else {
            self.request(&method, params, timeout).await?
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
    pub async fn tool(self: &Arc<Self>, name: &str, mut args: Value) -> Result<Value> {
        let catalog = catalog();
        let spec = catalog["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .ok_or("UNKNOWN_TOOL")?;
        crate::egress::validate_op(spec, &args)?;
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
            return self.mutate("native",json!({"method":method,"params":params,"requestId":args["requestId"],"timeoutMs":args["timeoutMs"].as_u64().unwrap_or(86400000),"waitMs":num(&args,"waitMs",25000)})).await;
        }
        match name {
            "dispatch_policy" => crate::dispatch_policy::query(self).await,
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
            "codex_queue" => crate::dispatch_queue::query(&args).await,
            "codex_queue_control" => crate::dispatch_queue::control(self, &args).await,
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
            "notify_status" => crate::claude_notify::notify_status(&args).await,
            "notify_control" => crate::claude_notify::notify_control(&args).await,
            "notification_ack" => crate::claude_notify::acknowledge(&args).await,
            "codex_pending" => {
                if let Some(thread) = args["threadId"].as_str() {
                    if !self.background(thread)? {
                        self.ipc().await?.read(thread, true).await?;
                    }
                }
                let mut requests: Vec<_> = self
                    .events
                    .lock()
                    .await
                    .pending
                    .values()
                    .filter(|r| {
                        args["threadId"].is_null() || r["params"]["threadId"] == args["threadId"]
                    })
                    .cloned()
                    .map(|mut r| {
                        if r["responseId"].is_null() {
                            r["responseId"] = json!(r["id"].to_string());
                        }
                        r
                    })
                    .collect();
                let origin = crate::kernel::origin::current_origin();
                for request in &mut requests {
                    crate::respond_tokens::issue(string(&origin, "ingressId"), request)?;
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
                let mut result = summary(&t);
                if args["statusOnly"] != true {
                    let page=self.request("thread/turns/list",json!({"threadId":id,"cursor":args["cursor"],"limit":num(&args,"limit",2),"sortDirection":"desc","itemsView":"full"}),60000).await?;
                    result["nextCursor"] = page["nextCursor"].clone();
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
                    let configurations = turn_configurations(&t);
                    result["turns"]=json!(page["data"].as_array().into_iter().flatten().map(|t|{let items=t["items"].as_array().cloned().unwrap_or_default();json!({"turnId":t["id"],"recordedStatus":t["status"],"error":t["error"],"effectiveConfiguration":configurations.get(string(t,"id")).cloned().unwrap_or(json!({"source":"unavailable","model":"unknown","effort":"unknown"})),"items":items.iter().skip(items.len().saturating_sub(15)).map(|i|item(i,0,600)).collect::<Vec<_>>(),"itemsTruncated":items.len()>15})}).collect::<Vec<_>>());
                }
                if let Some(turns) = result["turns"].as_array_mut() {
                    for turn in turns {
                        turn["notification"] =
                            crate::claude_notify::read(id, string(turn, "turnId"))?;
                        turn["retry"] =
                            crate::claude_notify::retry_status(id, string(turn, "turnId"))?;
                    }
                }
                Ok(result)
            }
            "codex_items" => {
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
                ] {
                    params.as_object_mut().unwrap().remove(key);
                }
                let page = self.request("thread/items/list", params, 60000).await?;
                let items: Vec<_> = page["data"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|r| {
                        let mut i = item(
                            &r["item"],
                            num(&args, "offset", 0),
                            num(&args, "length", 6000),
                        );
                        i["turnId"] = r["turnId"].clone();
                        i
                    })
                    .collect();
                if let Some(h) = args["expectedHash"].as_str() {
                    if items.first().is_none_or(|i| i["textHash"] != h) {
                        return Err("CONTENT_CHANGED".into());
                    }
                }
                let mut result = json!({"threadId":args["threadId"],"items":items,"nextCursor":page["nextCursor"],"observedAt":now()});
                if latest {
                    result["turnId"] = turn_id;
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
    } else if kind != "interrupt" {
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
        json!({"kind":kind,"title":args["title"],"prompt":prompt,"input":input,
        "project":args["project"],"directory":if native{p["cwd"].clone()}else{args["thread"]["cwd"].clone()},
        "threadId":if native{p["threadId"].clone()}else{args["threadId"].clone()},
        "model":model,"effort":p["effort"],
        "settings":if native{json!({"params":p})}else{json!({"thread":args["thread"],"turn":args["turn"],"resume":args["resume"],"mode":args["mode"],"networkAccess":args["networkAccess"],"serviceTier":args["serviceTier"]})}}),
    ))
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
        t["turns"] = json!(desktop::turns(s)?)
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
                    .ok_or("DESKTOP_CURSOR_MISMATCH")?,
            )
            .map_err(|e| e.to_string())?;
        let c: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if c["binding"] != binding {
            return Err("DESKTOP_CURSOR_MISMATCH".into());
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

pub(crate) fn turn_configurations(thread: &Value) -> HashMap<String, Value> {
    let mut result = HashMap::new();
    let read = || -> Result<String> {
        use std::io::Read;
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
        if !stat.is_file() || stat.len() > 32 * 1024 * 1024 {
            return Err("history too large".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if stat.nlink() != 1 {
                return Err("linked history".into());
            }
        }
        let mut text = String::new();
        file.take(32 * 1024 * 1024)
            .read_to_string(&mut text)
            .map_err(|e| e.to_string())?;
        Ok(text)
    };
    if let Ok(text) = read() {
        let mut matched = false;
        for line in text.lines().filter(|l| l.len() <= 1024 * 1024) {
            let Ok(event) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let p = &event["payload"];
            if event["type"] == "session_meta" {
                matched = p["id"] == thread["id"];
            }
            if matched
                && event["type"] == "turn_context"
                && p["cwd"] == thread["cwd"]
                && p["turn_id"].is_string()
            {
                let value = |key: &str| p.get(key).cloned().unwrap_or(json!("unknown"));
                result.insert(string(p,"turn_id").into(), json!({"scope":"turn","source":"native-persisted-turn-context","turnId":p["turn_id"],"model":value("model"),"effort":value("effort"),"mode":p["sandbox_policy"].get("type").unwrap_or(&json!("unknown")),"networkAccess":p["sandbox_policy"].get("network_access").unwrap_or(&json!("unknown")),"serviceTier":value("service_tier"),"approvalPolicy":value("approval_policy"),"observedAt":now()}));
            }
        }
    }
    result
}
