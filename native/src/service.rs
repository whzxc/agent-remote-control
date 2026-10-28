//! One execution core, with independently owned ingress runtimes.
pub(crate) use crate::ingress::write_secret;
use crate::{control::Control, ingress::Ingress, *};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU16, Ordering};

fn remember_connection(id: &str, connected: bool) -> Result<()> {
    // Core is the single writer. Internal shutdown and restart cleanup must not
    // turn a transient failure into a persistent request to disconnect.
    static WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = WRITER.lock().unwrap();
    let path = root().join("desktop-session.json");
    let mut ids: std::collections::BTreeSet<String> = if path.exists() {
        serde_json::from_value(load(&path)?).map_err(|error| error.to_string())?
    } else {
        Default::default()
    };
    if connected {
        ids.insert(id.to_owned());
    } else {
        ids.remove(id);
    }
    save(&path, &json!(ids))
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
    drafts: Mutex<BTreeMap<String, (Arc<Ingress>, std::time::Instant, tokio::task::AbortHandle)>>,
    configuration: Mutex<()>,
    pub(crate) relay: crate::relay::Manager,
    accounts: Arc<crate::accounts::Manager>,
    closing: std::sync::atomic::AtomicBool,
}
use crate::ingress::config::{defaults, secrets};
// Secrets use the existing private-directory/atomic-file storage, separately from configuration.
pub(crate) fn store_entry(entry: &Value) -> Result<()> {
    let dir = root().join("ingresses").join(string(entry, "id"));
    private_dir(&dir)?;
    let mut public = entry.clone();
    public["config"]
        .as_object_mut()
        .unwrap()
        .remove("connectionMode");
    let mut secret = json!({"bearerToken":public.as_object_mut().unwrap().remove("bearerToken").unwrap_or(Value::Null)});
    for (key, _) in secrets() {
        secret[key] = public["config"]
            .as_object_mut()
            .unwrap()
            .remove(key)
            .unwrap_or(Value::Null);
    }
    save(&dir.join("secrets.json"), &secret)?;
    save(&dir.join("config.json"), &public)
}
fn read_entry(id: &str) -> Result<Value> {
    valid_id(id)?;
    let dir = root().join("ingresses").join(id);
    let mut entry = load(&dir.join("config.json"))?;
    if entry["id"] != id {
        return Err("ingress id mismatch".into());
    }
    let secret = load(&dir.join("secrets.json"))?;
    entry["bearerToken"] = secret["bearerToken"].clone();
    for (key, _) in secrets() {
        entry["config"][key] = secret.get(key).cloned().unwrap_or_else(|| json!(""));
    }
    Ok(entry)
}
fn valid_id(id: &str) -> Result<()> {
    if id == "local-cli"
        || id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("id must contain 1-64 ASCII letters, digits, - or _".into());
    }
    Ok(())
}
fn normalize(mut entry: Value) -> Result<Value> {
    if let Some(config) = entry["config"].as_object_mut() {
        config.remove("ngrokDomain");
    }
    if entry
        .as_object()
        .ok_or("expected ingress object")?
        .keys()
        .any(|k| {
            ![
                "id",
                "name",
                "controlSource",
                "transport",
                "auth",
                "bearerToken",
                "enabled",
                "toolPolicy",
                "config",
            ]
            .contains(&k.as_str())
        })
    {
        return Err("unknown ingress field; see cli help".into());
    }
    valid_id(string(&entry, "id"))?;
    for field in ["name", "controlSource"] {
        let text = entry[field]
            .as_str()
            .ok_or("name and controlSource are required")?;
        if text.is_empty() || text.len() > 120 || text.chars().any(char::is_control) {
            return Err("invalid ingress label".into());
        }
    }
    if !entry["enabled"].is_boolean() {
        return Err("enabled must be boolean".into());
    }
    if !["openai-tunnel", "https", "relay", "local"].contains(&string(&entry, "transport")) {
        return Err("transport must be openai-tunnel, https, relay or local".into());
    }
    if entry["transport"] == "local" && entry["auth"] != "none" {
        return Err("Local connections use authenticated IPC".into());
    }
    if entry["transport"] == "openai-tunnel" {
        if entry["auth"] != "openai" {
            return Err("OpenAI Tunnel requires auth=openai".into());
        }
    } else if !["none", "bearer", "oauth"].contains(&string(&entry, "auth")) {
        return Err("HTTPS auth must be none, bearer or oauth".into());
    }
    if entry.get("toolPolicy").is_none() {
        entry["toolPolicy"] = crate::kernel::policy::default_policy();
    }
    if entry["toolPolicy"] != "all" {
        let allowed = entry["toolPolicy"]["allowlist"]
            .as_array()
            .ok_or("toolPolicy must be all or {allowlist:[op names]}")?;
        for name in allowed {
            if !catalog()["ops"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == *name)
            {
                return Err("unknown op in allowlist".into());
            }
        }
    }
    let mut config = defaults();
    if let Ok(prefs) = load(&root().join("app/preferences.json")) {
        for key in ["proxyMode", "proxyUrl"] {
            if let Some(v) = prefs.get(key) {
                config[key] = v.clone();
            }
        }
    }
    for (k, v) in entry["config"]
        .as_object()
        .ok_or("config must be an object")?
    {
        config[k] = v.clone();
    }
    config["connectionMode"] = json!(if entry["transport"] == "local" {
        "local"
    } else if entry["transport"] == "relay" {
        "relay"
    } else if entry["transport"] == "https" {
        "https"
    } else {
        "tunnel"
    });
    crate::ingress::config::validate_config(&config)?;
    entry["config"] = config;
    if entry["auth"] == "bearer" {
        let token = string(&entry, "bearerToken");
        if token.len() < 32 || token.len() > 4096 || !token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(
                "bearerToken requires 32-4096 printable ASCII characters; supply via stdin".into(),
            );
        }
    }
    Ok(entry)
}
impl Service {
    pub fn new() -> Result<Arc<Self>> {
        crate::resources::initialize();
        crate::runtime_metrics::initialize();
        init_crypto();
        crate::logs::record("INFO", "Service starting", None);
        private_dir(&root())?;
        let index = root().join("ingresses/index.json");
        if !index.exists() {
            save(&index, &json!([]))?;
        }
        if let Err(error) = crate::kernel::results::prune() {
            crate::logs::record(
                "WARN",
                &format!("Cannot prune temporary outputs: {error}"),
                None,
            );
        }
        if let Err(error) = crate::ingress::prune_tunnel_versions() {
            crate::logs::record(
                "WARN",
                &format!("Cannot prune unused Tunnel components: {error}"),
                None,
            );
        }
        let control =
            Control::new(crate::agents::codex_binary().unwrap_or_else(|| PathBuf::from("codex")));
        let agents = crate::agents::AgentHost::new()?;
        let subscriptions =
            crate::subscriptions::SubscriptionService::new(control.clone(), agents.clone())?;
        let accounts = Arc::new(crate::accounts::Manager::default());
        let execution = crate::execution::Execution::new(
            control.clone(),
            agents.clone(),
            subscriptions.clone(),
            accounts.clone(),
        );
        let token = id() + &id();
        let mut ingresses = BTreeMap::new();
        for id in load(&index)?.as_array().ok_or("invalid ingress index")? {
            let mut entry = read_entry(id.as_str().ok_or("invalid ingress id")?)?;
            // Removed registry entries cannot prevent the remaining tools or management UI starting.
            let mut changed = false;
            if let Some(allowed) = entry
                .get_mut("toolPolicy")
                .and_then(Value::as_object_mut)
                .and_then(|p| p.get_mut("allowlist"))
                .and_then(Value::as_array_mut)
            {
                let before = allowed.len();
                allowed.retain(|name| {
                    catalog()["ops"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|t| t["name"] == *name)
                });
                changed = before != allowed.len();
            }
            let entry = normalize(entry)?;
            if changed {
                store_entry(&entry)?;
            }
            let ingress = Ingress::new(entry, execution.clone(), token.clone())?;
            ingresses.insert(ingress.id.clone(), ingress);
        }
        Ok(Arc::new(Self {
            runtime: Default::default(),
            subscriptions,
            execution,
            control,
            agents,
            token,
            port: AtomicU16::new(0),
            ingresses: Mutex::new(ingresses),
            drafts: Mutex::new(BTreeMap::new()),
            configuration: Mutex::new(()),
            relay: Default::default(),
            accounts,
            closing: std::sync::atomic::AtomicBool::new(false),
        }))
    }
    #[cfg(feature = "test-fixture")]
    pub fn fixture(binary: PathBuf) -> Result<Arc<Self>> {
        crate::sources::initialize()?;
        let mut service = Self::new()?;
        let service_mut = Arc::get_mut(&mut service).unwrap();
        service_mut.control = Control::new(binary);
        service_mut.subscriptions = crate::subscriptions::SubscriptionService::new(
            service_mut.control.clone(),
            service_mut.agents.clone(),
        )?;
        service_mut.execution = crate::execution::Execution::new(
            service_mut.control.clone(),
            service_mut.agents.clone(),
            service_mut.subscriptions.clone(),
            service_mut.accounts.clone(),
        );
        for ingress in service_mut.ingresses.get_mut().values_mut() {
            let i = Arc::get_mut(ingress).unwrap();
            i.execution = service_mut.execution.clone();
            i.connected.store(true, Ordering::SeqCst);
        }
        crate::claude_notify::start(&service);
        crate::dispatch_queue::start(&service.control);
        crate::update_queue::start(&service.execution);
        Ok(service)
    }
    pub async fn ingress(&self, id: &str) -> Result<Arc<Ingress>> {
        self.ingresses
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or("ingress not found".into())
    }
    pub async fn primary(&self) -> Result<Arc<Ingress>> {
        let items = self.ingresses.lock().await;
        items
            .get("default")
            .or_else(|| items.values().next())
            .cloned()
            .ok_or("no ingresses; run cli ingress add --stdin".into())
    }
    pub async fn autostart(self: &Arc<Self>) {
        let mut jobs = tokio::task::JoinSet::new();
        for ingress in self.entries().await {
            let meta = ingress.meta.lock().await.clone();
            if meta["enabled"] != true || meta["config"]["autoStart"] != true {
                continue;
            }
            let service = self.clone();
            jobs.spawn(async move {
                if let Err(error) = service
                    .request(&format!("ingress/{}/start", ingress.id), "POST", json!({}))
                    .await
                {
                    crate::logs::record(
                        "ERROR",
                        &format!("Ingress {} autostart failed: {error}", ingress.id),
                        None,
                    );
                }
            });
        }
        while jobs.join_next().await.is_some() {}
    }
    async fn entries(&self) -> Vec<Arc<Ingress>> {
        self.ingresses.lock().await.values().cloned().collect()
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
            crate::claude_notify::settings()?["requestRoutingDelaySeconds"].clone();
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
        status["core"]["version"] = json!(env!("ARC_BUILD_VERSION"));
        status["core"]["backendSession"] = json!(self.control.session);
        status["core"]["activeWrites"] = health["activeWrites"].clone();
        status["core"]["pendingInteractions"] =
            json!(self.control.events.lock().await.pending.len());
        status["core"]["toolCount"] = json!(catalog()["tools"].as_array().unwrap().len());
        status["core"]["opCount"] = json!(catalog()["ops"].as_array().unwrap().len());
        status["core"]["package"] = json!({"version":env!("ARC_BUILD_VERSION"),"sha":"native"});
        let mut items = Vec::new();
        for i in self.entries().await {
            items.push(i.summary().await?);
        }
        let running = items.iter().filter(|i| i["running"] == true).count();
        let ready = items.iter().filter(|i| i["state"] == "ready").count();
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
    }
    pub async fn stop(&self) -> Result<()> {
        self.accounts.stop().await;
        self.relay.cancel().await;
        crate::cloudflare::stop_login().await;
        let _configuration = self.configuration.lock().await;
        self.closing.store(true, Ordering::SeqCst);
        crate::logs::record("INFO", "Service stopping", None);
        self.subscriptions.stop().await;
        let entries = self.entries().await;
        for ingress in &entries {
            ingress.retired.store(true, Ordering::SeqCst);
        }
        let mut errors = Vec::new();
        for ingress in entries {
            let _runtime = ingress.operation.lock().await;
            if let Err(error) = ingress.stop().await {
                errors.push(error);
            }
        }
        let drafts = std::mem::take(&mut *self.drafts.lock().await);
        for (id, (draft, _, task)) in drafts {
            task.abort();
            let _runtime = draft.operation.lock().await;
            draft.retired.store(true, Ordering::SeqCst);
            let _ = draft.stop().await;
            let _ = std::fs::remove_dir_all(root().join("ingresses").join(id));
        }
        self.agents.close().await;
        self.control.close().await;
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
    async fn all(&self, action: &str) -> Result<Value> {
        let mut jobs = tokio::task::JoinSet::new();
        for ingress in self.entries().await {
            if action == "start" && ingress.meta.lock().await["enabled"] != true {
                continue;
            }
            ingress
                .port
                .store(self.port.load(Ordering::SeqCst), Ordering::SeqCst);
            let action = action.to_owned();
            jobs.spawn(async move {
                let result = Self::set_connection(&ingress, action == "start").await;
                json!({"id":ingress.id,"ok":result.is_ok(),"error":result.err()})
            });
        }
        let mut results = Vec::new();
        while let Some(result) = jobs.join_next().await {
            results.push(result.map_err(|e| e.to_string())?);
        }
        results.sort_by(|a, b| string(a, "id").cmp(string(b, "id")));
        Ok(json!({"results":results}))
    }
    async fn set_connection(ingress: &Arc<Ingress>, connected: bool) -> Result<Value> {
        let _runtime = ingress.operation.lock().await;
        if ingress.retired.load(Ordering::SeqCst) {
            return Err("ingress removed or replaced".into());
        }
        if connected && ingress.meta.lock().await["enabled"] != true {
            return Err("ingress disabled".into());
        }
        remember_connection(&ingress.id, connected)?;
        if connected {
            ingress.start().await?;
        } else {
            ingress.stop().await?;
        }
        Ok(json!({"ok":true}))
    }
    async fn discard_draft(&self, id: &str) -> Result<()> {
        if let Some((draft, _, task)) = self.drafts.lock().await.remove(id) {
            task.abort();
            let _runtime = draft.operation.lock().await;
            draft.retired.store(true, Ordering::SeqCst);
            draft.stop().await?;
            let _ = std::fs::remove_dir_all(root().join("ingresses").join(id));
        }
        Ok(())
    }
    pub async fn request(
        self: &Arc<Self>,
        route: &str,
        method: &str,
        body: Value,
    ) -> Result<Value> {
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
        let mut result = self.request_inner(route, method, body).await;
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
        if let Some(path) = route.strip_prefix("source/") {
            let (id, action) = path.split_once('/').unwrap_or((path, ""));
            let source = crate::sources::get(id)?;
            if action.is_empty() && method == "PUT" {
                return crate::sources::update(id, &body).await;
            }
            if action == "switch" && method == "POST" {
                if let Ok(current) = self.ingress(string(&source, "ingressId")).await {
                    if current
                        .oauth
                        .lock()
                        .await
                        .pending_ids()
                        .iter()
                        .any(|id| source["credential"]["grantId"] == *id)
                    {
                        return Err(
                            "SOURCE_NOT_SWITCHABLE: approve the pending source first".into()
                        );
                    }
                }
                let i = self.ingress(string(&body, "ingressId")).await?;
                let _runtime = i.operation.lock().await;
                if i.retired.load(Ordering::SeqCst) {
                    return Err("Connection removed; select another connection".into());
                }
                let entry = i.meta.lock().await.clone();
                let _oauth = i.oauth.lock().await;
                return crate::sources::begin_switch(id, &entry).await;
            }
            if action == "switch" && method == "DELETE" {
                if let Ok(i) = self
                    .ingress(string(&source["pendingSwitch"], "ingressId"))
                    .await
                {
                    let _runtime = i.operation.lock().await;
                    let mut oauth = i.oauth.lock().await;
                    let current = crate::sources::get(id)?;
                    if let Some(request) = current["pendingSwitch"]["requestId"].as_str() {
                        oauth.revoke(request).await?;
                    }
                }
                return crate::sources::cancel_switch(id).await;
            }
            if action == "disconnect" && method == "POST" {
                crate::sources::require_control_source(&source)?;
                if source["credential"]["type"] == "oauth-grant" {
                    if let Ok(i) = self.ingress(string(&source, "ingressId")).await {
                        let _runtime = i.operation.lock().await;
                        let mut oauth = i.oauth.lock().await;
                        let current = crate::sources::get(id)?;
                        oauth
                            .revoke(string(&current["credential"], "grantId"))
                            .await?;
                    }
                } else if let Ok(i) = self.ingress(string(&source, "ingressId")).await {
                    i.stop().await?;
                }
                return crate::sources::disconnect(id).await;
            }
            if action == "claim" && method == "POST" {
                let i = self.ingress(string(&source, "ingressId")).await?;
                let _runtime = i.operation.lock().await;
                if i.retired.load(Ordering::SeqCst) || i.meta.lock().await["auth"] != "oauth" {
                    return Err("Connection configuration changed; retry".into());
                }
                let mut oauth = i.oauth.lock().await;
                oauth
                    .decide(
                        string(&source["credential"], "grantId"),
                        true,
                        Some(
                            body["sourceId"]
                                .as_str()
                                .ok_or("sourceId must be new or an existing source ID")?,
                        ),
                    )
                    .await?;
                return Ok(json!({"approved":true,"sourceId":body["sourceId"]}));
            }
            return Err("UNKNOWN_ROUTE".into());
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
            return crate::relay::request(self, route, method, body).await;
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
            ("POST", "updates/task-notice") => {
                return crate::claude_notify::update_notice(&body).await
            }
            ("GET", "updates/status") => return crate::app_replace::update_status(true).await,
            ("POST", "updates/request") => {
                return crate::kernel::origin::ORIGIN
                    .scope(
                        crate::sources::local_origin().await?,
                        crate::app_replace::update_request(body),
                    )
                    .await
            }
            ("POST", "app/replace") => {
                crate::management::resolve("app.replace", &json!({"body":body}))?;
                return crate::app_replace::prepare(body).await;
            }
            ("GET", "app/replace/snapshot") => {
                return crate::app_replace::snapshot(&self.control).await
            }
            ("GET", "app/replace/status") => return crate::app_replace::status(),
            ("POST", "app/replace/ack") => {
                crate::management::resolve("app.replace.ack", &json!({"body":body}))?;
                return crate::app_replace::acknowledge(string(&body, "id"));
            }
            ("GET", "runtime/metrics") => return Ok(self.control.runtime_metrics().await),
            ("GET", "capabilities") => return Ok(crate::management::catalog()),
            ("GET", "health") => {
                return Ok(
                    json!({"state":"ready","version":env!("ARC_BUILD_VERSION"),"pid":std::process::id(),"instance":self.control.session,"build":load(&root().join("app/native.json"))?["build"]}),
                )
            }
            ("GET", "preferences") => return Ok(crate::preferences::read()),
            ("PUT", "preferences") => return crate::preferences::write(body),
            ("POST", "preferences/import") => return crate::preferences::import(body),
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
        if route.starts_with("runtime/") && method == "POST" {
            return self.runtime.request(route, body);
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
                    item["available"] = json!(
                        name == "agent_archive"
                            || (!name.starts_with("agent_") && name != "agents")
                            || agents_available
                    );
                    item
                })
                .collect();
            return Ok(
                json!({"groups":exposure["groups"],"required":exposure["required"],"tools":tools}),
            );
        }
        if route == "ingress-drafts" && method == "POST" {
            let _guard = self.configuration.lock().await;
            if self.closing.load(Ordering::SeqCst) {
                return Err("core shutting down".into());
            }
            if self.drafts.lock().await.len() >= 8 {
                return Err("too many pending connections".into());
            }
            let mut config = body["config"].clone();
            if !config.is_object()
                || !["cloudflare", "ngrok", "pinggy", "localxpose"]
                    .contains(&string(&config, "httpsProvider"))
            {
                return Err("managed HTTPS provider required".into());
            }
            let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
            config["httpsHost"] = json!("127.0.0.1");
            config["httpsPort"] = json!(listener.local_addr().map_err(|e| e.to_string())?.port());
            if !(config["httpsProvider"] == "pinggy" && config["pinggyMode"] == "named"
                || config["httpsProvider"] == "localxpose")
            {
                config["httpsUrl"] = json!("");
            }
            drop(listener);
            let entry = normalize(
                json!({"id":format!("draft-{}",id()),"name":"Pending connection","controlSource":"custom","transport":"https","enabled":true,"auth":"bearer","bearerToken":id()+&id(),"toolPolicy":{"allowlist":[]},"config":config}),
            )?;
            let draft = Ingress::new(entry, self.execution.clone(), self.token.clone())?;
            let draft_id = draft.id.clone();
            draft
                .port
                .store(self.port.load(Ordering::SeqCst), Ordering::SeqCst);
            let starter = draft.clone();
            let task = tokio::spawn(async move {
                let _ = starter.request("start", "POST", json!({})).await;
            });
            self.drafts.lock().await.insert(
                draft_id.clone(),
                (
                    draft.clone(),
                    std::time::Instant::now(),
                    task.abort_handle(),
                ),
            );
            let owner = Arc::downgrade(self);
            let expires_id = draft_id.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    let Some(owner) = owner.upgrade() else { break };
                    let _guard = owner.configuration.lock().await;
                    let expired = owner
                        .drafts
                        .lock()
                        .await
                        .get(&expires_id)
                        .map(|(_, last, _)| last.elapsed().as_secs() >= 120);
                    match expired {
                        None => break,
                        Some(true) => {
                            let _ = owner.discard_draft(&expires_id).await;
                            break;
                        }
                        _ => {}
                    }
                }
            });
            return draft.summary().await;
        }
        if let Some(path) = route.strip_prefix("ingress-drafts/") {
            let (id, action) = path.split_once('/').unwrap_or((path, ""));
            valid_id(id)?;
            let _guard = self.configuration.lock().await;
            if self.closing.load(Ordering::SeqCst) {
                return Err("core shutting down".into());
            }
            if method == "DELETE" && action.is_empty() {
                self.discard_draft(id).await?;
                return Ok(json!({"removed":id}));
            }
            let draft = {
                let mut drafts = self.drafts.lock().await;
                let (draft, last, _) = drafts
                    .get_mut(id)
                    .ok_or("pending connection expired; obtain the MCP URL again")?;
                *last = std::time::Instant::now();
                draft.clone()
            };
            if method == "GET" && action.is_empty() {
                return draft.summary().await;
            }
            if method == "POST" && action == "commit" {
                let _runtime = draft.operation.lock().await;
                let mut entry = draft.meta.lock().await.clone();
                for key in ["name", "controlSource", "auth", "bearerToken"] {
                    if let Some(value) = body.get(key) {
                        entry[key] = value.clone();
                    }
                }
                if !["none", "bearer", "oauth"].contains(&string(&entry, "auth")) {
                    return Err("invalid authentication".into());
                }
                entry["toolPolicy"] = body
                    .get("toolPolicy")
                    .cloned()
                    .unwrap_or_else(crate::kernel::policy::default_policy);
                entry["config"]["httpsUrl"] = body["url"].clone();
                let entry = normalize(entry)?;
                // Validate the live URL before publishing or enabling any tools.
                draft
                    .validate_draft_url(string(&entry["config"], "httpsUrl"))
                    .await?;
                store_entry(&entry)?;
                let mut entries = self.ingresses.lock().await;
                let mut ids: Vec<_> = entries.keys().cloned().collect();
                ids.push(id.to_owned());
                save(&root().join("ingresses/index.json"), &json!(ids))?;
                draft.activate_draft(entry).await?;
                entries.insert(id.to_owned(), draft.clone());
                self.drafts.lock().await.remove(id);
                drop(entries);
                drop(_runtime);
                return draft.summary().await;
            }
            return Err("UNKNOWN_ROUTE".into());
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
        if route == "ingress" && method == "GET" {
            let mut items = Vec::new();
            for i in self.entries().await {
                items.push(i.summary().await?);
            }
            return Ok(json!(items));
        }
        if route == "ingress/start-all" && method == "POST" {
            return self.all("start").await;
        }
        if route == "ingress/stop-all" && method == "POST" {
            return self.all("stop").await;
        }
        if route == "ingress" && method == "POST" {
            let _guard = self.configuration.lock().await;
            if self.closing.load(Ordering::SeqCst) {
                return Err("core shutting down".into());
            }
            if !body.is_object() {
                return Err("expected ingress object".into());
            }
            let mut entry = body;
            if entry.get("id").is_none() {
                entry["id"] = json!(id());
            }
            if entry.get("name").is_none() {
                let mut names = Vec::new();
                for ingress in self.entries().await {
                    names.push(string(&*ingress.meta.lock().await, "name").to_owned());
                }
                entry["name"] = json!(crate::control_sources::default_name(
                    string(&entry, "controlSource"),
                    &names,
                ));
            }
            for (k, v) in json!({"enabled":true,"toolPolicy":crate::kernel::policy::default_policy(),"config":{}})
                .as_object()
                .unwrap()
            {
                entry
                    .as_object_mut()
                    .ok_or("invalid ingress")?
                    .entry(k.clone())
                    .or_insert(v.clone());
            }
            if entry["transport"] == "https" && entry["config"].get("httpsPort").is_none() {
                let listener =
                    std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
                entry["config"]["httpsPort"] =
                    json!(listener.local_addr().map_err(|e| e.to_string())?.port());
            }
            let entry = normalize(entry)?;
            if self
                .ingresses
                .lock()
                .await
                .contains_key(string(&entry, "id"))
            {
                return Err("ingress already exists".into());
            }
            store_entry(&entry)?;
            let i = Ingress::new(entry, self.execution.clone(), self.token.clone())?;
            let mut entries = self.ingresses.lock().await;
            let mut ids: Vec<_> = entries.keys().cloned().collect();
            ids.push(i.id.clone());
            save(&root().join("ingresses/index.json"), &json!(ids))?;
            entries.insert(i.id.clone(), i.clone());
            drop(entries);
            return i.summary().await;
        }
        if let Some(path) = route.strip_prefix("ingress/") {
            let (id, action) = path.split_once('/').unwrap_or((path, ""));
            valid_id(id)?;
            let _guard = if matches!(method, "PUT" | "DELETE") || action == "token" {
                Some(self.configuration.lock().await)
            } else {
                None
            };
            if self.closing.load(Ordering::SeqCst) {
                return Err("core shutting down".into());
            }
            let i = self.ingress(id).await?;
            if action.starts_with("oauth") {
                let _runtime = i.operation.lock().await;
                if i.retired.load(Ordering::SeqCst) {
                    return Err("Connection configuration changed; retry".into());
                }
                if i.meta.lock().await["auth"] != "oauth" {
                    return Err("OAuth is not enabled for this connection".into());
                }
                let resource = i.mcp_url.lock().await.clone();
                let mut oauth = i.oauth.lock().await;
                let resource = if resource.is_empty() {
                    oauth.resource().to_owned()
                } else {
                    resource
                };
                if resource.is_empty() {
                    return Err("Start this connection before managing OAuth".into());
                }
                let resource = reqwest::Url::parse(&resource)
                    .map_err(|_| "Invalid OAuth resource URL")?
                    .to_string();
                if method == "GET" && action == "oauth" {
                    return oauth.management(&resource).await;
                }
                if method == "GET" && action.starts_with("oauth/request/") {
                    oauth.management(&resource).await?;
                    return oauth.status(action.trim_start_matches("oauth/request/"), &resource);
                }
                if method == "POST" && action == "oauth/decision" {
                    oauth.management(&resource).await?;
                    oauth
                        .decide(
                            string(&body, "id"),
                            body["allow"].as_bool().ok_or("allow must be boolean")?,
                            body["sourceId"].as_str(),
                        )
                        .await?;
                    return oauth.status(string(&body, "id"), &resource);
                }
                if method == "POST" && action == "oauth/client/remove" {
                    oauth.remove_client(string(&body, "id")).await?;
                    return Ok(json!({"removed":true}));
                }
                if method == "POST" && action == "oauth/revoke" {
                    oauth.revoke(string(&body, "id")).await?;
                    return Ok(json!({"ok":true}));
                }
                if method == "POST" && action == "oauth/register" {
                    return oauth.register(&body, &resource).await.map_err(String::from);
                }
                return Err("UNKNOWN_ROUTE".into());
            }
            if method == "POST" && action == "credentials" {
                let credentials = i.request("config/credentials", "GET", json!({})).await?;
                return Ok(
                    json!({"apiKey": credentials["apiKey"], "bearerToken": credentials["bearerToken"]}),
                );
            }
            if method == "GET" && action.is_empty() {
                return i.summary().await;
            }
            if method == "DELETE" && action.is_empty() {
                let _runtime = i.operation.lock().await;
                i.stop().await?;
                remember_connection(id, false)?;
                i.retired.store(true, Ordering::SeqCst);
                let mut oauth = i.oauth.lock().await;
                crate::sources::remove_connection(
                    &i.meta.lock().await.clone(),
                    oauth.pending_ids(),
                )
                .await?;
                oauth.reset().await?;
                drop(oauth);
                let mut entries = self.ingresses.lock().await;
                let ids: Vec<_> = entries.keys().filter(|k| *k != id).cloned().collect();
                save(&root().join("ingresses/index.json"), &json!(ids))?;
                entries.remove(id);
                drop(entries);
                std::fs::remove_dir_all(root().join("ingresses").join(id))
                    .map_err(|e| e.to_string())?;
                return Ok(json!({"removed":id}));
            }
            if method == "POST" && action == "probe" {
                return crate::diagnostics::probe(&i).await;
            }
            if method == "POST" && action == "restart" {
                let _runtime = i.operation.lock().await;
                if i.meta.lock().await["enabled"] != true {
                    return Err("ingress disabled".into());
                }
                remember_connection(id, true)?;
                i.stop().await?;
                i.port
                    .store(self.port.load(Ordering::SeqCst), Ordering::SeqCst);
                i.start().await?;
                return i.summary().await;
            }
            if method == "PUT" && action.is_empty() || action == "token" && method == "POST" {
                let _runtime = i.operation.lock().await;
                let restart = i.summary().await?["running"] == true;
                let mut entry = read_entry(id)?;
                let previous = normalize(entry.clone())?;
                if action == "token" && entry["auth"] != "bearer" {
                    return Err("token rotation requires auth=bearer".into());
                }
                if action == "token" {
                    entry["bearerToken"] = json!(crate::id() + &crate::id());
                } else {
                    for (k, v) in body.as_object().ok_or("expected JSON object")? {
                        if k == "config" {
                            for (k, v) in v.as_object().ok_or("config must be an object")? {
                                entry["config"][k] = v.clone();
                            }
                        } else {
                            entry[k] = v.clone();
                        }
                    }
                }
                if entry["id"] != id {
                    return Err("cannot change ingress id".into());
                }
                let entry = normalize(entry)?;
                // Metadata and startup preferences apply to the existing runtime. In
                // particular, policy changes must preserve OAuth and active requests.
                let mut old_runtime = previous["config"].clone();
                let mut new_runtime = entry["config"].clone();
                old_runtime.as_object_mut().unwrap().remove("autoStart");
                new_runtime.as_object_mut().unwrap().remove("autoStart");
                let runtime_changed = old_runtime != new_runtime
                    || ["transport", "enabled", "auth", "bearerToken"]
                        .iter()
                        .any(|key| previous[*key] != entry[*key]);
                if !runtime_changed {
                    store_entry(&entry)?;
                    i.update_entry(entry).await;
                    return i.summary().await;
                }
                i.stop().await?;
                if let Err(error) = store_entry(&entry) {
                    if restart {
                        let _ = i.start().await;
                    }
                    return Err(error);
                }
                if entry["enabled"] != true {
                    remember_connection(id, false)?;
                }
                let next = Ingress::new(entry.clone(), self.execution.clone(), self.token.clone())?;
                let identity_changed = crate::ingress::config::binding(&previous["config"])
                    != crate::ingress::config::binding(&entry["config"])
                    || ["transport", "controlSource", "auth", "bearerToken"]
                        .iter()
                        .any(|key| previous[*key] != entry[*key]);
                if previous["auth"] != entry["auth"] || previous["transport"] != entry["transport"]
                {
                    next.oauth.lock().await.reset().await?;
                }
                if identity_changed {
                    next.request("verification/reset", "POST", json!({}))
                        .await?;
                }
                i.retired.store(true, Ordering::SeqCst);
                self.ingresses
                    .lock()
                    .await
                    .insert(id.to_owned(), next.clone());
                if restart && entry["enabled"] == true {
                    next.port
                        .store(self.port.load(Ordering::SeqCst), Ordering::SeqCst);
                    next.start().await?;
                }
                return if action == "token" {
                    Ok(
                        json!({"id":id,"token":entry["bearerToken"],"delivery":"secret; store locally, do not paste into chat"}),
                    )
                } else {
                    next.summary().await
                };
            }
            if method != "POST"
                || !["start", "stop", "install", "verification/reset"].contains(&action)
            {
                return Err("UNKNOWN_ROUTE".into());
            }
            if action == "start" && i.meta.lock().await["enabled"] != true {
                return Err("ingress disabled".into());
            }
            i.port
                .store(self.port.load(Ordering::SeqCst), Ordering::SeqCst);
            if matches!(action, "start" | "stop") {
                return Self::set_connection(&i, action == "start").await;
            }
            return i.request(action, method, body).await;
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
                    let mut records = self.control.task_records().await?;
                    records.extend(self.agents.task_records()?);
                    for record in &mut records {
                        let agent = record["agent"].as_str().unwrap_or("codex");
                        let task = record["taskId"]
                            .as_str()
                            .or(record["threadId"].as_str())
                            .or(record["task"]["threadId"].as_str())
                            .unwrap_or("");
                        if let Some(open) = self.agents.task_navigation(agent, task) {
                            record["open"] = open;
                        }
                    }
                    records.sort_by(|a, b| string(b, "createdAt").cmp(string(a, "createdAt")));
                    Ok(json!({"records":records}))
                }
                ("POST", "tasks/open") => {
                    self.agents
                        .open_task(string(&body, "agent"), string(&body, "taskId"))
                        .await
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
        if method == "PUT" && route == "config" && self.ingresses.lock().await.is_empty() {
            let _guard = self.configuration.lock().await;
            if self.closing.load(Ordering::SeqCst) {
                return Err("core shutting down".into());
            }
            if !self.ingresses.lock().await.is_empty() {
                return Err("ingress was created; refresh configuration".into());
            }
            let https = body["connectionMode"] == "https";
            let entry = normalize(
                json!({"id":"default","name":"ChatGPT","controlSource":"chatgpt","transport":if https{"https"}else{"openai-tunnel"},"auth":if https{"none"}else{"openai"},"enabled":true,"toolPolicy":crate::kernel::policy::default_policy(),"config":body}),
            )?;
            store_entry(&entry)?;
            let ingress = Ingress::new(entry, self.execution.clone(), self.token.clone())?;
            save(&root().join("ingresses/index.json"), &json!(["default"]))?;
            self.ingresses
                .lock()
                .await
                .insert("default".into(), ingress);
            return Ok(json!({"ok":true}));
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
