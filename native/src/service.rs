//! One execution core, with independently owned ingress runtimes.
pub(crate) use crate::ingress::write_secret;
use crate::{control::Control, ingress::Ingress, *};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU16, Ordering};

pub(crate) use crate::front_door::owner::expected_remote;
fn status_settings() -> Result<Value> {
    use crate::kernel::file_cache::Projection;
    static SETTINGS: std::sync::LazyLock<std::sync::Mutex<Projection<Value>>> =
        std::sync::LazyLock::new(Default::default);
    let paths = [root().join("task-settings.json")];
    let mut cache = SETTINGS.lock().map_err(|e| e.to_string())?;
    let before = Projection::<Value>::stamps(&paths)?;
    if let Some(settings) = cache.get(&before) {
        return Ok(settings);
    }
    let settings = crate::claude_notify::settings()?;
    cache.set(&paths, before, settings.clone())?;
    Ok(settings)
}

pub struct Service {
    pub runtime: crate::runtime::State,
    pub subscriptions: Arc<crate::subscriptions::SubscriptionService>,
    pub control: Arc<Control>,
    pub agents: Arc<crate::agents::AgentHost>,
    pub(crate) execution: Arc<crate::execution::Execution>,
    pub token: String,
    pub port: AtomicU16,
    ingresses: Mutex<BTreeMap<String, Arc<Ingress>>>,
    accounts: Arc<crate::accounts::Manager>,
    task_feed: Mutex<crate::task_overview::Feed>,
    closing: std::sync::atomic::AtomicBool,
}
pub(crate) use crate::front_door::owner::store_entry;
use crate::ingress::config::{defaults, secrets};
impl Service {
    pub fn new() -> Result<Arc<Self>> {
        crate::resources::initialize();
        crate::runtime_metrics::initialize();
        init_crypto();
        crate::logs::record("INFO", "Service starting", None);
        private_dir(&root())?;
        let control =
            Control::new(crate::agents::codex_binary().unwrap_or_else(|| PathBuf::from("codex")));
        let agents = crate::agents::AgentHost::with_launches(control.launches.clone())?;
        let subscriptions =
            crate::subscriptions::SubscriptionService::new(control.clone(), agents.clone())?;
        let accounts = Arc::new(crate::accounts::Manager::default());
        let execution = crate::execution::Execution::new(
            control.clone(),
            agents.clone(),
            subscriptions.clone(),
            accounts.clone(),
        )?;
        let token = crate::front_door::process::ensure_secret()?;
        Ok(Arc::new(Self {
            runtime: crate::runtime::State::with_launches(control.launches.clone()),
            subscriptions,
            execution,
            control,
            agents,
            token,
            port: AtomicU16::new(0),
            ingresses: Mutex::new(BTreeMap::new()),
            accounts,
            task_feed: Default::default(),
            closing: std::sync::atomic::AtomicBool::new(false),
        }))
    }
    #[cfg(feature = "test-fixture")]
    pub fn fixture(binary: PathBuf) -> Result<Arc<Self>> {
        crate::sources::initialize()?;
        crate::sources::migrate_history()?;
        let mut service = Self::new()?;
        let service_mut = Arc::get_mut(&mut service).unwrap();
        service_mut.control = Control::new(binary);
        service_mut.runtime.launches = service_mut.control.launches.clone();
        service_mut.agents =
            crate::agents::AgentHost::with_launches(service_mut.control.launches.clone())?;
        service_mut.subscriptions = crate::subscriptions::SubscriptionService::new(
            service_mut.control.clone(),
            service_mut.agents.clone(),
        )?;
        service_mut.execution = crate::execution::Execution::new(
            service_mut.control.clone(),
            service_mut.agents.clone(),
            service_mut.subscriptions.clone(),
            service_mut.accounts.clone(),
        )?;
        for ingress in service_mut.ingresses.get_mut().values_mut() {
            let i = Arc::get_mut(ingress).unwrap();
            i.execution = Some(service_mut.execution.clone());
            i.connected.store(true, Ordering::SeqCst);
        }
        crate::claude_notify::start(&service);
        crate::dispatch_queue::start(&service.control);
        Ok(service)
    }
    pub async fn ingress(&self, id: &str) -> Result<Arc<Ingress>> {
        crate::front_door::owner::valid_id(id)?;
        let info =
            crate::front_door::process::gateway_request(&format!("_entry/{id}"), "GET", json!({}))
                .await?;
        let mut entries = self.ingresses.lock().await;
        let ingress = match entries.get(id) {
            Some(i) => {
                i.update_entry(info["entry"].clone()).await;
                i.clone()
            }
            None => {
                let i = Ingress::new(
                    info["entry"].clone(),
                    self.execution.clone(),
                    self.token.clone(),
                )?;
                entries.insert(id.into(), i.clone());
                i
            }
        };
        ingress
            .connected
            .store(info["connected"] == true, Ordering::SeqCst);
        *ingress.mcp_url.lock().await = string(&info, "url").into();
        Ok(ingress)
    }
    pub async fn primary(&self) -> Result<Arc<Ingress>> {
        let entries =
            crate::front_door::process::gateway_request("_entries", "GET", json!({})).await?;
        let ids = entries
            .as_array()
            .ok_or("invalid front-door ingress registry")?;
        let id = ids
            .iter()
            .find(|id| **id == "default")
            .or_else(|| ids.first())
            .and_then(Value::as_str)
            .ok_or("no ingresses; run cli ingress add --stdin")?;
        self.ingress(id).await
    }
    pub async fn autostart(self: &Arc<Self>) {
        if let Err(error) =
            crate::front_door::process::gateway_request("_autostart", "POST", json!({})).await
        {
            crate::logs::record("ERROR", &error, None);
        }
    }
    pub(crate) async fn restore_remote(self: &Arc<Self>) -> Result<()> {
        crate::front_door::process::gateway_request("_restore", "POST", json!({}))
            .await
            .map(|_| ())
    }
    async fn remote_faults(&self) -> Result<Vec<Value>> {
        let mut faults = Vec::new();
        for entry in expected_remote()? {
            if self
                .ingress(string(&entry, "id"))
                .await?
                .transport_status()
                .await?
                .state
                != "ready"
            {
                faults.push(entry);
            }
        }
        Ok(faults)
    }
    pub(crate) async fn entries(&self) -> Vec<Arc<Ingress>> {
        let Ok(ids) =
            crate::front_door::process::gateway_request("_entries", "GET", json!({})).await
        else {
            return Vec::new();
        };
        self.ingresses.lock().await.retain(|id, _| {
            ids.as_array()
                .is_some_and(|ids| ids.iter().any(|live| live == id))
        });
        let mut entries = Vec::new();
        for id in ids
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if let Ok(i) = self.ingress(id).await {
                entries.push(i);
            }
        }
        entries
    }
    pub async fn network_proxy(&self) -> Result<crate::proxy::NetworkProxy> {
        crate::proxy::NetworkProxy::resolve(
            &load(&root().join("app/preferences.json")).unwrap_or_else(|_| defaults()),
        )
        .await
    }
    pub async fn log(&self, level: &str, msg: &str) {
        if let Ok(i) = self.primary().await {
            i.log(level, msg).await;
        } else {
            crate::logs::record(level, msg, None);
        }
    }
    pub async fn status(&self) -> Result<Value> {
        crate::runtime_metrics::cost::scope(crate::runtime_metrics::cost::Owner::Status, crate::runtime_metrics::cost::Reason::Poll, async {
        let _scope = crate::runtime_metrics::Scope::new(crate::runtime_metrics::Work::Status);
        let mut status = if let Ok(primary) = self.primary().await {
            primary.status().await?
        } else {
            let mut config = defaults();
            config["configured"] = json!(false);
            for (key, _) in secrets() {
                config.as_object_mut().unwrap().remove(key);
            }
            json!({"config":config,"core":{"desktop":{"state":"unknown"},"appServer":{"state":"unknown"},"chatgpt":{},"logs":[]},"connection":{"running":false,"mcpUrl":""},"connector":{"state":"stopped"},"tunnel":{"state":"stopped","error":""},"logs":[],"version":env!("ARC_BUILD_VERSION"),"platform":if cfg!(target_os="macos"){"darwin"}else if cfg!(windows){"win32"}else{"linux"},"taskApprovalEnabled":self.control.approval_mode()?,"autoOpenCodex":self.control.auto_open_codex()?})
        };
        status["requestRoutingDelaySeconds"] =
            status_settings()?["requestRoutingDelaySeconds"].clone();
        status["cliPath"] = json!(crate::cli_shim::executable()?);
        let desktop = match self.control.ipc().await {
            Ok(_) => {
                json!({"supported":true,"state":"ready","executionOwner":"desktop","message":"Codex Desktop is ready"})
            }
            Err(e) => {
                json!({"supported":crate::desktop::installation().is_some(),"state":if crate::desktop::installation().is_some(){"disconnected"}else{"unavailable"},"executionOwner":"desktop","message":e})
            }
        };
        let health = self.control.health().await;
        for (key,value) in json!({"pid":std::process::id(),"activeTurns":0,"liveProcesses":0,"uncertain":false,"draining":false,"account":{"state":"unknown","observedAt":null},"lastInbound":null,"schemaDiscovered":"unknown","operationVerified":"business-delivery-not-assessed"}).as_object().unwrap() {status["core"][key]=value.clone();}
        status["core"]["desktop"] = desktop;
        status["core"]["appServer"] = health["appServer"].clone();
        status["core"]["resources"] = health["resources"].clone();
        status["frontDoor"]=crate::front_door::process::status(crate::runtime::process_build_id()?);
        status["core"]["version"] = json!(env!("ARC_BUILD_VERSION"));
        status["core"]["backendSession"] = json!(self.control.session);
        status["core"]["activeWrites"] = health["activeWrites"].clone();
        status["core"]["pendingInteractions"] =
            json!(self.control.events.lock().await.pending.len());
        status["core"]["toolCount"] = json!(catalog()["tools"].as_array().unwrap().len());
        status["core"]["opCount"] = json!(catalog()["ops"].as_array().unwrap().len());
        status["core"]["package"] = json!({"version":env!("ARC_BUILD_VERSION"),"sha":"native"});
        let mut items = Vec::new();
        let entries = self.entries().await;
        crate::runtime_metrics::cost::scan_set(entries.len());
        for i in entries {
            crate::runtime_metrics::cost::rows(1);
            items.push(i.summary().await?);
        }
        let running = items.iter().filter(|i| i["running"] == true).count();
        let ready = items.iter().filter(|i| i["state"] == "ready").count();
        if let Ok(expected) = expected_remote() {
            status["remoteFaults"] = json!(expected
                .into_iter()
                .filter(|entry| {
                    !items
                        .iter()
                        .any(|item| item["id"] == entry["id"] && item["state"] == "ready")
                })
                .collect::<Vec<_>>());
        }
        status["ingresses"] = json!(items);
        status["diagnostics"] = crate::diagnostics::status(&status);
        crate::diagnostics::receipts(
            &mut status["diagnostics"],
            self.control.task_records().await,
        );
        status["ingressSummary"] = json!({"running":running,"ready":ready,"total":items.len()});
        status["core"]["transport"] =
            json!({"state":if ready>0{"ready"}else if running>0{"starting"}else{"stopped"}});
        status["connector"] = status["core"]["transport"].clone();
        status["preferences"] = crate::preferences::read();
        status["logs"] = json!(crate::logs::recent(None));
        status["core"]["logs"] = status["logs"].clone();
        status["core"]["registered"] = json!(running > 0);
        Ok(status)
        }).await
    }
    pub(crate) fn begin_shutdown(&self) {
        self.execution.front_door.begin_drain();
        self.closing.store(true, Ordering::SeqCst);
        self.runtime.begin_shutdown();
    }
    pub async fn stop(&self) -> Result<()> {
        self.begin_shutdown();
        self.execution.devices.stop().await?;
        self.accounts.stop(&self.control).await;
        self.subscriptions.stop().await;
        self.agents.close().await;
        self.control.close().await;
        Ok(())
    }
    pub async fn request(
        self: &Arc<Self>,
        route: &str,
        method: &str,
        body: Value,
    ) -> Result<Value> {
        if route == "device/tasks" && method == "POST" {
            crate::management::resolve("device.tasks", &json!({"body":body}))?;
            return self.execution.devices.tasks(string(&body, "device")).await;
        }
        if route == "ingress"
            || route.starts_with("ingress/")
            || route.starts_with("ingress-drafts")
            || route.starts_with("source/")
            || route.starts_with("browser/access")
            || route.starts_with("device/")
        {
            if let Some(policy) = body.get("toolPolicy").filter(|policy| **policy != "all") {
                for name in policy["allowlist"]
                    .as_array()
                    .ok_or("toolPolicy must be all or {allowlist:[op names]}")?
                {
                    if !catalog()["ops"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|op| op["name"] == *name)
                    {
                        return Err("unknown op in allowlist".into());
                    }
                }
            }
            let mut result =
                crate::front_door::process::gateway_request(route, method, body).await?;
            if route == "device/snapshot" {
                result["devices"] = self.execution.devices.list(true).await["devices"].clone();
            } else if route.starts_with("device/") {
                self.execution
                    .devices
                    .reconcile(crate::device_link::enabled())
                    .await?;
            }
            return Ok(result);
        }
        if route == "tasks/snapshot" && method == "POST" {
            crate::management::resolve("tasks.snapshot", &json!({"body":body}))?;
            let mut feed = self.task_feed.lock().await;
            let codex = self.control.task_display_records().await?;
            let agents = self.agents.task_records()?;
            return Ok(feed.read(codex, agents, &self.agents, body["revision"].as_str()));
        }
        if route == "preferences" && method == "PUT" {
            let current = crate::preferences::read();
            if body["values"].as_object().is_some_and(|fields| {
                fields
                    .iter()
                    .all(|(key, value)| !value.is_null() && current.get(key) == Some(value))
            }) {
                return Ok(current);
            }
        }
        let operation = id();
        let ingress_id = route
            .strip_prefix("ingress/")
            .and_then(|p| p.split('/').next());
        let audit = method != "GET"
            && ![
                "runtime/lease",
                "src-conversations/observe",
                "src-conversations/query",
                "logs/query",
                "agents/conversations",
                "agents/dispatch-catalog",
                "agents/dispatch-defaults/read",
                "tasks/dispatch-defaults/read",
                "agents/conversations/timeline",
                "state/wait",
                "setup/next",
                "setup/wait",
            ]
            .contains(&route);
        if audit {
            crate::logs::append(
                json!({"time":now(),"level":"INFO","msg":format!("{method} {route}: started"),"operationId":operation,"ingressId":ingress_id,"phase":"started"}),
            )?;
        }
        let mut result = crate::runtime_metrics::cost::read_scope(
            route,
            method,
            self.request_inner(route, method, body),
        )
        .await;
        if let Ok(value) = &mut result {
            crate::sources::decorate(value);
        }
        if audit || (route == "runtime/lease" && result.is_err()) {
            let outcome = if result.is_ok() {
                "succeeded"
            } else {
                "failed"
            };
            if let Err(error) = crate::logs::append(
                json!({"time":now(),"level":if result.is_ok(){"INFO"}else{"ERROR"},"msg":format!("{method} {route}: {outcome}"),"operationId":operation,"ingressId":ingress_id,"phase":outcome}),
            ) {
                eprintln!("Cannot persist operation outcome: {error}");
            }
        }
        result
    }
    async fn request_inner(
        self: &Arc<Self>,
        route: &str,
        method: &str,
        body: Value,
    ) -> Result<Value> {
        if self.closing.load(Ordering::SeqCst) {
            return Err("core shutting down".into());
        }
        if route == "mcp-hub" && method == "GET" {
            return crate::mcp_hub::overview();
        }
        if route == "mcp-hub/configure" && method == "POST" {
            crate::management::resolve("mcp-hub.configure", &json!({"body":body}))?;
            return crate::mcp_hub::local(&body).await;
        }
        if route == "coordination/resources" && method == "GET" {
            return crate::coordination::desktop_resources();
        }
        if let Some(op) = route.strip_prefix("coordination/") {
            if method == "POST"
                && matches!(
                    op,
                    "events"
                        | "board"
                        | "notice_post"
                        | "notice_update"
                        | "notice_close"
                        | "blocker_open"
                        | "blocker_clear"
                        | "ax_list"
                )
            {
                crate::management::resolve(&format!("coordination.{op}"), &json!({"body":body}))?;
                return crate::kernel::origin::ORIGIN
                    .scope(
                        crate::sources::local_origin().await?,
                        crate::coordination::desktop_call(op, body, &self.control),
                    )
                    .await;
            }
        }
        if route == "coordination/conflicts" && method == "POST" {
            return Ok(crate::coordination::bulletin::tooling_warnings(&body));
        }
        if route == "coordination/observe" && method == "POST" {
            return crate::coordination::lifecycle::report(&self.control, body).await;
        }
        if let Some(id) = route.strip_prefix("coordination/observations/") {
            if method == "GET" {
                return crate::coordination::lifecycle::read(id);
            }
        }
        if route == "source" && method == "GET" {
            return Ok(json!({"sources":crate::sources::control_sources()?}));
        }
        if route.starts_with("local-access/") {
            return crate::local_access::request(self, route, method, body).await;
        }
        if route == "src-conversations/observe" && method == "POST" {
            return crate::src_conversations::observe(&body);
        }
        if let Some(action) = route.strip_prefix("src-conversations/") {
            let name = match (method, action) {
                ("POST", "query") => "src_conversations",
                ("GET", "profiles") => "src_chrome_profiles",
                ("POST", "open") => "src_conversation_open",
                ("POST", "import") => "src_login_import",
                ("POST", "clear") => "src_login_clear",
                ("POST", "bind") => "src_conversation_bind",
                _ => return Err("UNKNOWN_ROUTE".into()),
            };
            return crate::src_conversations::op(name, body).await;
        }
        if route == "pets" || route.starts_with("pets/") {
            return crate::pets::request(route, method, body).await;
        }
        if route == "accounts" || route.starts_with("accounts/") {
            return self
                .accounts
                .request(
                    &self.control,
                    &self.agents,
                    &self.subscriptions,
                    route,
                    method,
                    body,
                )
                .await;
        }
        if route.starts_with("relay/") {
            return crate::front_door::process::gateway_request(route, method, body).await;
        }
        if route.starts_with("setup/") {
            return crate::setup::request(self, route, method, body).await;
        }
        if route == "operations" && method == "POST" {
            return crate::operations::submit(body, self.control.session.clone());
        }
        if let Some(id) = route.strip_prefix("operations/") {
            if method == "GET" {
                return crate::operations::read(id, &self.control.session);
            }
        }
        if matches!(route, "permissions" | "permissions/passive") && method == "GET" {
            let mut readiness = crate::permissions::status().await;
            if route == "permissions/passive" {
                if let Some(items) = readiness["items"].as_array_mut() {
                    for id in ["codex-login", "command-full-disk-access"] {
                        items.push(json!({"id":id,"process":"Codex app-server","state":"unknown","reason":"not probed by passive diagnostics"}));
                    }
                }
                return Ok(readiness);
            }
            let account = self
                .control
                .request("account/read", json!({"refreshToken":false}), 5000)
                .await;
            let command_fda = crate::permissions::command_disk_access(&self.control).await;
            if let Some(items) = readiness["items"].as_array_mut() {
                items.push(json!({"id":"command-full-disk-access","process":"Codex app-server","state":command_fda,"heuristic":true,"grantTarget":crate::permissions::grant_target()}));
                items.push(json!({"id":"codex-login","process":"Codex app-server","state":match account { Ok(ref a) if !a["account"].is_null() => "granted", Ok(_) => "missing", Err(_) => "unknown" }}));
                for entry in self.entries().await {
                    let summary = entry.summary().await?;
                    items.push(json!({"id":format!("ingress:{}",entry.id),"process":"Core","state":if summary["verification"]["challengeVerifiedAt"].is_string() {"granted"}else{"missing"},"diagnostics":crate::diagnostics::ingress(&summary)}));
                }
            }
            return Ok(readiness);
        }
        match (method, route) {
            ("GET", "browser/access") => {
                return crate::browser::access(self.entries().await, false).await
            }
            ("GET", "browser/snapshot") => {
                return self.status().await.map(crate::browser::compact_status)
            }
            ("POST", "browser/access/rotate") => {
                return crate::browser::access(self.entries().await, true).await
            }
            ("GET", "runtime/metrics") => return Ok(self.control.runtime_metrics().await),
            ("GET", "updates/history") => {
                let releases: Vec<Value> = self
                    .network_proxy()
                    .await?
                    .client(reqwest::Client::builder())
                    .user_agent("agent-remote-control")
                    .timeout(std::time::Duration::from_secs(10))
                    .build()
                    .map_err(|error| error.to_string())?
                    .get("https://api.github.com/repos/whzxc/agent-remote-control/releases?per_page=50")
                    .send()
                    .await
                    .and_then(reqwest::Response::error_for_status)
                    .map_err(|error| error.to_string())?
                    .json()
                    .await
                    .map_err(|error| error.to_string())?;
                return Ok(json!(releases
                    .iter()
                    .filter(|release| release["draft"] == false && release["prerelease"] == false)
                    .filter_map(|release| {
                        let version = string(release, "tag_name").strip_prefix('v')?;
                        Some(json!({"version":version,"notes":string(release,"body")}))
                    })
                    .collect::<Vec<_>>()));
            }
            ("GET", "capabilities") => return Ok(crate::management::catalog()),
            ("GET", "health") => {
                return Ok(
                    json!({"state":"ready","version":env!("ARC_BUILD_VERSION"),"pid":std::process::id(),"instance":self.control.session,"build":load(&root().join("app/native.json"))?["build"],"frontDoor":crate::front_door::process::status(crate::runtime::process_build_id()?)}),
                )
            }
            ("GET", "preferences") => return Ok(crate::preferences::read()),
            ("PUT", "preferences") => {
                let previous = crate::device_link::enabled();
                let result = crate::preferences::write(body)?;
                if previous != (result["device-link"] == "on") {
                    crate::front_door::process::gateway_request(
                        "_peer_reconcile",
                        "POST",
                        json!({"enabled":result["device-link"] == "on"}),
                    )
                    .await?;
                }
                self.execution
                    .devices
                    .reconcile(crate::device_link::enabled())
                    .await?;
                return Ok(result);
            }
            ("POST", "preferences/import") => {
                let previous = crate::device_link::enabled();
                let result = crate::preferences::import(body)?;
                if previous != (result["device-link"] == "on") {
                    crate::front_door::process::gateway_request(
                        "_peer_reconcile",
                        "POST",
                        json!({"enabled":result["device-link"] == "on"}),
                    )
                    .await?;
                }
                self.execution
                    .devices
                    .reconcile(crate::device_link::enabled())
                    .await?;
                return Ok(result);
            }
            ("GET", "network") => {
                return Ok(load(&root().join("app/preferences.json"))
                    .unwrap_or(json!({"proxyMode":"system","proxyUrl":""})))
            }
            ("POST", "logs/query") => return crate::logs::query(&body),
            ("POST", "state/wait") => {
                let deadline = tokio::time::Instant::now()
                    + std::time::Duration::from_millis(
                        num(&body, "timeoutMs", 30000).min(30000) as u64
                    );
                loop {
                    let entries = self.entries().await;
                    crate::runtime_metrics::cost::sync(
                        crate::runtime_metrics::cost::Owner::ScopedWait,
                        crate::runtime_metrics::cost::Reason::Poll,
                        || {
                            crate::runtime_metrics::cost::scan_set(entries.len());
                            crate::runtime_metrics::cost::rows(entries.len());
                        },
                    );
                    let mut states = Vec::new();
                    for entry in entries {
                        if body["ingressId"].as_str().is_some_and(|id| entry.id != id) {
                            continue;
                        }
                        let summary = entry.summary().await?;
                        states.push(json!({"id":summary["id"],"state":summary["state"],"running":summary["running"],"error":summary["error"],"url":summary["url"]}));
                    }
                    states.sort_by(|a, b| string(a, "id").cmp(string(b, "id")));
                    let state = json!({"instance":self.control.session,"ingresses":states,"preferences":crate::preferences::read()});
                    let cursor = hash(state.to_string());
                    let matched = if let Some(expected) = body["state"].as_str() {
                        !states.is_empty() && states.iter().all(|s| s["state"] == expected)
                    } else {
                        cursor != string(&body, "cursor")
                    };
                    if matched || tokio::time::Instant::now() >= deadline {
                        return Ok(
                            json!({"cursor":cursor,"changed":cursor != string(&body,"cursor"),"conditionMet":matched,"timedOut":!matched,"snapshot":state,"observedAt":now()}),
                        );
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
            _ => {}
        }
        if route == "runtime/clients" && method == "GET" {
            return Ok(self.runtime.clients());
        }
        if route == "runtime/uninstall" && method == "POST" {
            let proof = load(&root().join("uninstall-core.json")).unwrap_or(Value::Null);
            return self.runtime.uninstall(string(&body, "token"), &proof);
        }
        if route == "runtime/remote" && method == "GET" {
            return Ok(json!(self.remote_faults().await?));
        }
        if route.starts_with("runtime/") && method == "POST" {
            let result = self.runtime.request(route, body)?;
            return Ok(result);
        }
        if route == "app/env" && method == "GET" {
            return crate::app_env::control(&json!({"action":"read"}));
        }
        if route == "tasks/presence" && method == "POST" {
            crate::management::resolve("tasks.presence", &json!({"body":body}))?;
            return crate::claude_notify::routing::presence(&body);
        }
        if route == "tasks/request-routing" && method == "POST" {
            crate::management::resolve("tasks.request-routing", &json!({"body":body}))?;
            return crate::claude_notify::routing::control(&body, true);
        }
        if route == "tasks/control" && method == "POST" {
            crate::management::resolve("tasks.control", &json!({"body":body}))?;
            let mut args = body["args"].clone();
            if body["op"] == "codex_send" && args.get("purpose").is_none() {
                let records = crate::dispatch_policy::records(string(&args, "threadId"))?;
                if records.last().is_some_and(|r| r["purpose"] == "self-test") {
                    args["purpose"] = json!("self-test");
                }
            }
            if matches!(string(&body, "op"), "codex_send" | "agent_send")
                && args["purpose"] == "self-test"
                && args.get("notify").is_none()
            {
                args["notify"] = Value::Null;
            }
            // This local bridge exposes only existing task operations. Their owners
            // still validate arguments, receipts, permissions and task boundaries.
            return crate::kernel::origin::ORIGIN
                .scope(
                    crate::sources::panel_origin().await?,
                    self.execution.call(
                        string(&body, "op"),
                        args,
                        crate::kernel::policy::default_policy(),
                    ),
                )
                .await;
        }
        if route == "tasks/reviews" && method == "POST" {
            crate::management::resolve("tasks.reviews", &json!({"body":body}))?;
            return Ok(json!({"reviews":crate::dispatch_policy::reviews(string(&body,"id"))?}));
        }
        if route == "tasks/reviews/undo" && method == "POST" {
            crate::management::resolve("tasks.reviews.undo", &json!({"body":body}))?;
            return crate::dispatch_policy::undo_local_review(
                string(&body, "id"),
                string(&body, "turnId"),
                string(&body, "reviewRequestId"),
            );
        }
        if route == "agents/respond" && method == "POST" {
            // Local authentication is enforced by transport; keep the existing
            // respond owners responsible for scope, validation and UUID replay.
            crate::management::resolve("agents.respond", &json!({"body":body}))?;
            return crate::kernel::origin::ORIGIN
                .scope(
                    crate::sources::panel_origin().await?,
                    self.execution.call(
                        string(&body, "op"),
                        body["args"].clone(),
                        crate::kernel::policy::default_policy(),
                    ),
                )
                .await;
        }
        if route == "agents/dispatch-catalog" && method == "POST" {
            crate::management::resolve("agents.dispatch_catalog", &json!({"body":body}))?;
            return crate::dispatch_policy::catalog(&self.control, &self.agents, &body).await;
        }
        if route == "agents/dispatch-defaults/read" && method == "POST" {
            crate::management::resolve("agents.dispatch_defaults.read", &json!({"body":body}))?;
            return self.agents.dispatch_defaults(&body, false);
        }
        if route == "tasks/dispatch-defaults/read" && method == "POST" {
            crate::management::resolve("tasks.dispatch_defaults.read", &json!({"body":body}))?;
            return crate::dispatch_policy::task_defaults(&body);
        }
        if route == "tasks/dispatch-defaults" && method == "POST" {
            crate::management::resolve("tasks.dispatch_defaults.update", &json!({"body":body}))?;
            return crate::dispatch_policy::set_task_defaults(&body);
        }
        if route == "agents/dispatch-defaults" && method == "POST" {
            crate::management::resolve("agents.dispatch_defaults.update", &json!({"body":body}))?;
            return self.agents.dispatch_defaults(&body, true);
        }
        if route == "agents/activity" && method == "GET" {
            return Ok(self.agents.activity(&self.control).await);
        }
        if route == "agents/conversations" && method == "POST" {
            crate::management::resolve("agents.conversations", &json!({"body":body}))?;
            return self.agents.conversations(&self.control, &body).await;
        }
        if route == "agents/conversations/timeline" && method == "POST" {
            crate::management::resolve("agents.conversations.timeline", &json!({"body":body}))?;
            return self
                .agents
                .conversation_timeline(&self.control, &body)
                .await;
        }
        if route == "agents/resources" && method == "POST" {
            crate::management::resolve("agents.resources", &json!({"body":body}))?;
            return self.agents.resource(&self.control, &body).await;
        }
        if let Some(session) = route
            .strip_prefix("agents/timeline/")
            .filter(|_| method == "GET")
        {
            if body["recent"] == true && body["after"].is_null() {
                return self
                    .agents
                    .conversation_timeline(
                        &self.control,
                        &json!({
                            "agent":"codex","id":session,"recent":true
                        }),
                    )
                    .await;
            }
            let after = match body.get("after") {
                None => 0,
                Some(v) => v.as_u64().ok_or("INVALID_TIMELINE_CURSOR")?,
            };
            return self.agents.timeline(&self.control, session, after).await;
        }

        if route == "subscriptions" || route.starts_with("subscriptions/") {
            return self.subscriptions.request(route, method, body).await;
        }
        if route == "tool-catalog" && method == "GET" {
            let catalog = catalog();
            let exposure = &catalog["toolExposure"];
            let agents_available = self.execution.available("agents").await;
            let tools: Vec<_> = catalog["ops"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tool| {
                    let name = string(tool, "name");
                    let mut item = exposure["tools"][name].clone();
                    if !item.is_object() {
                        item = json!({"group":"native","presets":[],"requires":["control_output"]});
                    }
                    item["name"] = json!(name);
                    item["description"] = tool["description"].clone();
                    item["via"] = json!(crate::egress::via(tool));
                    item["available"] = json!(if crate::mcp_hub::OPS.contains(&name) {
                        crate::mcp_hub::enabled()
                    } else {
                        name == "agent_archive"
                            || (!name.starts_with("agent_") && name != "agents")
                            || agents_available
                    });
                    item
                })
                .collect();
            return Ok(
                json!({"groups":exposure["groups"],"required":exposure["required"],"tools":tools}),
            );
        }
        if route == "coordination/messages" && matches!(method, "GET" | "POST") {
            return crate::coordination::messages::local(method, &body);
        }
        if matches!(route, "ax/import" | "ax/export") && method == "POST" {
            return crate::coordination::ax::local(route.strip_prefix("ax/").unwrap(), &body);
        }
        if route == "context" && method == "POST" {
            return crate::context::read(&self.agents, &self.control, body, json!("all")).await;
        }
        if route == "status" || route == "core" {
            let v = self.status().await?;
            return Ok(if route == "core" {
                v["core"].clone()
            } else {
                v
            });
        }
        if [
            "task-settings",
            "tasks/decision",
            "tasks",
            "tasks/open",
            "agents",
            "agents/open",
            "codex/login",
        ]
        .contains(&route)
            || route.starts_with("tasks/runtime/")
        {
            return match (method, route) {
                ("GET", "task-settings") => Ok(crate::claude_notify::settings()?),
                ("PUT", "task-settings") => {
                    let mut settings = crate::claude_notify::settings()?;
                    for key in ["enabled", "autoOpenCodex", "notificationsEnabled"] {
                        if let Some(value) = body.get(key) {
                            settings[key] = json!(value.as_bool().ok_or("invalid task setting")?);
                        }
                    }
                    if body.get("notificationWakeLimit").is_some() {
                        return Err("RETIRED_SETTING: use notificationBucketCapacity and notificationRefillSeconds".into());
                    }
                    for (key, max) in [
                        ("notificationBucketCapacity", 1000),
                        ("notificationRefillSeconds", 86400),
                        ("notificationEscalationSeconds", 86400),
                    ] {
                        if let Some(value) = body.get(key) {
                            let value = value
                                .as_u64()
                                .filter(|n| *n >= 1 && *n <= max)
                                .ok_or("invalid notification setting")?;
                            settings[key] = json!(value);
                        }
                    }
                    for (key, min, max) in [
                        ("requestRoutingDelaySeconds", 0, 300),
                        ("codexRetryMaxAttempts", 0, 10),
                        ("codexRetryInitialSeconds", 1, 3600),
                    ] {
                        if let Some(value) = body.get(key) {
                            let n = value
                                .as_u64()
                                .filter(|n| *n >= min && *n <= max)
                                .ok_or("invalid retry setting")?;
                            settings[key] = json!(n);
                        }
                    }
                    save(&root().join("task-settings.json"), &settings)?;
                    Ok(settings)
                }
                ("POST", "tasks/decision") => {
                    if let Some(receipt) = self.agents.receipt(body.clone()).await? {
                        return Ok(receipt);
                    }
                    self.control
                        .decide(
                            string(&body, "requestId"),
                            string(&body, "action"),
                            "local",
                            25000,
                        )
                        .await
                }
                ("GET", "tasks") => {
                    let codex = self.control.task_display_records().await?;
                    let agents = self.agents.task_records()?;
                    let records = crate::task_overview::list_records(&codex, &agents, &self.agents);
                    Ok(json!({"records":records}))
                }
                ("POST", "tasks/open") => {
                    let task = string(&body, "taskId");
                    if body["agent"] == "codex" {
                        self.control.observe_thread_account(task).await?;
                    }
                    self.agents.open_task(string(&body, "agent"), task).await
                }
                ("GET", route) if route.starts_with("tasks/runtime/") => {
                    self.control.task_runtime(&route[14..]).await
                }
                ("POST", "agents/open") => {
                    self.agents.open_interactive(string(&body, "agent")).await
                }
                ("GET" | "POST", "agents") => {
                    let inventory = self.agents.ui_inventory(method == "POST").await;
                    self.subscriptions.inventory(&inventory).await;
                    Ok(inventory)
                }
                ("PUT", "agents") => {
                    let result = self.agents.set_enabled(&body).await?;
                    let inventory = self.agents.ui_inventory(false).await;
                    self.subscriptions.inventory(&inventory).await;
                    Ok(result)
                }
                ("GET", "codex/login") => {
                    let binary = crate::agents::codex_binary()
                        .ok_or(if cfg!(target_os = "linux") { "CODEX_NOT_FOUND: install Codex CLI and run codex login in your terminal." } else { "Install Codex Desktop first" })?;
                    let out = command(binary)
                        .args(["login", "status"])
                        .output()
                        .await
                        .map_err(|e| e.to_string())?;
                    Ok(
                        json!({"state":if out.status.success(){"authenticated"}else{"unauthenticated"}}),
                    )
                }
                ("POST", "codex/login") => {
                    crate::desktop::open_app().await?;
                    Ok(
                        json!({"state":"unauthenticated","message":"Complete login in Codex Desktop"}),
                    )
                }
                _ => Err("UNKNOWN_ROUTE".into()),
            };
        }
        match (method, route) {
            ("PUT", "network") => {
                let mode = body["proxyMode"].as_str().ok_or("invalid proxy mode")?;
                let url = body["proxyUrl"].as_str().ok_or("invalid proxy URL")?;
                crate::proxy::validate(mode, url)?;
                save(&root().join("app/preferences.json"), &body)?;
                for ingress in self.entries().await {
                    ingress.request("network", "PUT", body.clone()).await?;
                }
                return Ok(json!({"ok":true}));
            }
            _ => {}
        }
        if method == "PUT" && route == "config" && self.entries().await.is_empty() {
            return crate::front_door::process::gateway_request("_initial_config", "PUT", body)
                .await;
        }
        if route == "stop" && self.ingresses.lock().await.is_empty() {
            return Ok(json!({"ok":true}));
        }
        let i = self.primary().await?;
        i.port
            .store(self.port.load(Ordering::SeqCst), Ordering::SeqCst);
        i.request(route, method, body).await
    }
}

#[cfg(test)]
pub(crate) fn scale_seed() -> Result<()> {
    let entry = crate::front_door::owner::normalize(
        json!({"id":"synthetic","name":"Synthetic ingress","controlSource":"Synthetic source","transport":"https","auth":"bearer","bearerToken":"synthetic-token-for-fixture-only-000000","enabled":true,"config":{}}),
    )?;
    store_entry(&entry)?;
    save(&root().join("ingresses/index.json"), &json!(["synthetic"]))
}
