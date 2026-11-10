//! Listener, ingress authentication and provider owner. No business runtime is constructed here.
use crate::{ingress::Ingress, *};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU16, Ordering};
type ConnectionIntent = std::collections::BTreeSet<String>;

fn connection_intent() -> Result<ConnectionIntent> {
    let path = root().join("desktop-session.json");
    if !path.exists() {
        return Ok(ConnectionIntent::new());
    }
    serde_json::from_value(crate::kernel::file_cache::load(&path)?)
        .map_err(|error| error.to_string())
}

pub(crate) fn expected_remote() -> Result<Vec<Value>> {
    let mut entries = Vec::new();
    for id in connection_intent()? {
        valid_id(&id)?;
        let path = root().join("ingresses").join(&id).join("config.json");
        if !path.exists() {
            continue;
        }
        let entry = crate::kernel::file_cache::load(&path)?;
        if entry["enabled"] == true && entry["transport"] != "local" {
            entries.push(json!({"id":id,"name":entry["name"]}));
        }
    }
    Ok(entries)
}

fn remember_connection(id: &str, connected: bool) -> Result<()> {
    // Core owns intent. Runtime shutdown and source lifecycle leave it intact.
    static WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = WRITER.lock().unwrap();
    let mut ids = connection_intent()?;
    if connected {
        ids.insert(id.to_owned());
    } else {
        ids.remove(id);
    }
    save(&root().join("desktop-session.json"), &json!(ids))
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
pub(crate) fn read_entry(id: &str) -> Result<Value> {
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
pub(crate) fn valid_id(id: &str) -> Result<()> {
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
pub(crate) fn normalize(mut entry: Value) -> Result<Value> {
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
        entry["toolPolicy"] = super::authority::default_policy()?;
    }
    if entry["toolPolicy"] != "all" {
        let allowed = entry["toolPolicy"]["allowlist"]
            .as_array()
            .ok_or("toolPolicy must be all or {allowlist:[op names]}")?;
        if allowed.iter().any(|name| !name.is_string()) {
            return Err("toolPolicy allowlist must contain op names".into());
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

pub(crate) struct Gateway {
    pub(crate) generation: super::Generation,
    pub token: String,
    pub port: AtomicU16,
    ingresses: Mutex<BTreeMap<String, Arc<Ingress>>>,
    drafts: Mutex<BTreeMap<String, (Arc<Ingress>, std::time::Instant, tokio::task::AbortHandle)>>,
    configuration: Mutex<()>,
    closing: std::sync::atomic::AtomicBool,
    pub(crate) relay: crate::relay::Manager,
}
impl Gateway {
    pub(crate) fn new() -> Result<Arc<Self>> {
        let index = root().join("ingresses/index.json");
        if !index.exists() {
            save(&index, &json!([]))?;
        }
        if let Err(error) = crate::ingress::prune_tunnel_versions() {
            crate::logs::record(
                "WARN",
                &format!("Cannot prune unused Tunnel components: {error}"),
                None,
            );
        }
        let token = super::process::ensure_secret()?;
        let mut ingresses = BTreeMap::new();
        for id in load(&index)?.as_array().ok_or("invalid ingress index")? {
            let entry = normalize(read_entry(id.as_str().ok_or("invalid ingress id")?)?)?;
            let ingress = Ingress::with_execution(entry, None, token.clone())?;
            #[cfg(feature = "test-fixture")]
            if std::env::var_os("ARC_FIXTURE_CONNECTED").is_some() {
                ingress.connected.store(true, Ordering::SeqCst);
            }
            ingresses.insert(ingress.id.clone(), ingress);
        }
        Ok(Arc::new(Self {
            generation: super::Generation(*uuid::Uuid::new_v4().as_bytes()),
            token,
            port: AtomicU16::new(0),
            ingresses: Mutex::new(ingresses),
            drafts: Default::default(),
            configuration: Default::default(),
            closing: std::sync::atomic::AtomicBool::new(false),
            relay: Default::default(),
        }))
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
    pub(crate) async fn restore_remote(self: &Arc<Self>) -> Result<()> {
        let mut jobs = tokio::task::JoinSet::new();
        for entry in expected_remote()? {
            let Ok(ingress) = self.ingress(string(&entry, "id")).await else {
                continue;
            };
            let port = self.port.load(Ordering::SeqCst);
            jobs.spawn(async move {
                let _runtime = ingress.operation.lock().await;
                if !connection_intent()?.contains(&ingress.id)
                    || ingress.retired.load(Ordering::SeqCst)
                    || ingress.meta.lock().await["enabled"] != true
                {
                    return Ok::<(), String>(());
                }
                ingress.port.store(port, Ordering::SeqCst);
                if let Err(error) = ingress.start().await {
                    crate::logs::record("ERROR", &error, Some(&ingress.id));
                }
                Ok(())
            });
        }
        while let Some(job) = jobs.join_next().await {
            job.map_err(|error| error.to_string())??;
        }
        Ok(())
    }

    pub(crate) async fn entries(&self) -> Vec<Arc<Ingress>> {
        self.ingresses.lock().await.values().cloned().collect()
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

    pub(crate) fn request<'a>(
        self: &'a Arc<Self>,
        route: &'a str,
        method: &'a str,
        body: Value,
    ) -> futures_util::future::BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            if let Some(path) = route.strip_prefix("_ingress_request/") {
                let (id, route) = path.split_once('/').ok_or("invalid ingress request")?;
                return self.ingress(id).await?.request(route, method, body).await;
            }
            if let Some(id) = route.strip_prefix("_connector_verify/") {
                let ingress = self.ingress(id).await?;
                let mut verification = ingress.verification.lock().await;
                if body["code"] != verification["code"] {
                    return Err("Verification code does not match".into());
                }
                verification["challengeVerifiedAt"] = json!(now());
                verification["verifiedAt"] = verification["challengeVerifiedAt"].clone();
                save(&ingress.dir.join("verification.json"), &verification)?;
                return Ok(json!({"code":body["code"],"received":true}));
            }
            if let Some(id) = route.strip_prefix("_verified/") {
                self.ingress(id)
                    .await?
                    .observe_request("verifiedAt")
                    .await?;
                return Ok(json!({}));
            }
            if let Some(id) = route.strip_prefix("_status/") {
                return self.ingress(id).await?.status().await;
            }
            if let Some(id) = route.strip_prefix("_relay_ready/") {
                return self
                    .ingress(id)
                    .await?
                    .relay_ready()
                    .await
                    .map(|_| json!({}));
            }
            if route == "_initial_config" {
                let _guard = self.configuration.lock().await;
                if !self.ingresses.lock().await.is_empty() {
                    return Err("ingress was created; refresh configuration".into());
                }
                let https = body["connectionMode"] == "https";
                let entry = normalize(
                    json!({"id":"default","name":"ChatGPT","controlSource":"chatgpt","transport":if https{"https"}else{"openai-tunnel"},"auth":if https{"none"}else{"openai"},"enabled":true,"toolPolicy":super::authority::default_policy()?,"config":body}),
                )?;
                store_entry(&entry)?;
                let ingress = Ingress::with_execution(entry, None, self.token.clone())?;
                save(&root().join("ingresses/index.json"), &json!(["default"]))?;
                self.ingresses
                    .lock()
                    .await
                    .insert("default".into(), ingress);
                return Ok(json!({"ok":true}));
            }
            if let Some(id) = route.strip_prefix("_event_active/") {
                let ingress = self.ingress(id).await?;
                let resource = ingress.mcp_url.lock().await.clone();
                return Ok(json!(ingress
                    .oauth
                    .lock()
                    .await
                    .event_grant_active(string(&body, "principal"), &resource)));
            }
            if route == "_entries" {
                return Ok(json!(self
                    .entries()
                    .await
                    .iter()
                    .map(|i| i.id.clone())
                    .collect::<Vec<_>>()));
            }
            if let Some(id) = route.strip_prefix("_entry/") {
                let i = self.ingress(id).await?;
                return Ok(
                    json!({"entry":i.meta.lock().await.clone(),"connected":i.connected.load(Ordering::SeqCst),"url":i.mcp_url.lock().await.clone()}),
                );
            }
            if route == "_restore" {
                self.restore_remote().await?;
                return Ok(json!({}));
            }
            if route == "_autostart" {
                self.autostart().await;
                return Ok(json!({}));
            }
            if route.starts_with("relay/") {
                return crate::relay::request(self, route, method, body).await;
            }
            if route == "browser/access" || route == "browser/access/rotate" {
                return crate::browser::access(self.entries().await, route.ends_with("/rotate"))
                    .await;
            }
            if let Some(path) = route.strip_prefix("source/") {
                let (id, action) = path.split_once('/').unwrap_or((path, ""));
                let source = crate::front_door::authority::get(id)?;
                if action.is_empty() && method == "PUT" {
                    return crate::front_door::authority::update(id, &body).await;
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
                    return crate::front_door::authority::begin_switch(id, &entry).await;
                }
                if action == "switch" && method == "DELETE" {
                    if let Ok(i) = self
                        .ingress(string(&source["pendingSwitch"], "ingressId"))
                        .await
                    {
                        let _runtime = i.operation.lock().await;
                        let mut oauth = i.oauth.lock().await;
                        let current = crate::front_door::authority::get(id)?;
                        if let Some(request) = current["pendingSwitch"]["requestId"].as_str() {
                            oauth.revoke(request).await?;
                        }
                    }
                    return crate::front_door::authority::cancel_switch(id).await;
                }
                if action == "disconnect" && method == "POST" {
                    crate::front_door::authority::require_control_source(&source)?;
                    if source["credential"]["type"] == "oauth-grant" {
                        if let Ok(i) = self.ingress(string(&source, "ingressId")).await {
                            let _runtime = i.operation.lock().await;
                            let mut oauth = i.oauth.lock().await;
                            let current = crate::front_door::authority::get(id)?;
                            oauth
                                .revoke(string(&current["credential"], "grantId"))
                                .await?;
                        }
                    } else if source["credential"]["type"] == "local" {
                        if let Ok(i) = self.ingress(string(&source, "ingressId")).await {
                            let _runtime = i.operation.lock().await;
                            i.stop().await?;
                        }
                    }
                    return crate::front_door::authority::disconnect(id).await;
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
                let listener =
                    std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
                config["httpsHost"] = json!("127.0.0.1");
                config["httpsPort"] =
                    json!(listener.local_addr().map_err(|e| e.to_string())?.port());
                if !(config["httpsProvider"] == "pinggy" && config["pinggyMode"] == "named"
                    || config["httpsProvider"] == "localxpose")
                {
                    config["httpsUrl"] = json!("");
                }
                drop(listener);
                let entry = normalize(
                    json!({"id":format!("draft-{}",id()),"name":"Pending connection","controlSource":"custom","transport":"https","enabled":true,"auth":"bearer","bearerToken":id()+&id(),"toolPolicy":{"allowlist":[]},"config":config}),
                )?;
                let draft = Ingress::with_execution(entry, None, self.token.clone())?;
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
                        crate::runtime_metrics::cost::sync(
                            crate::runtime_metrics::cost::Owner::DraftExpiry,
                            crate::runtime_metrics::cost::Reason::Timer,
                            || {
                                crate::runtime_metrics::cost::scan_set(1);
                                crate::runtime_metrics::cost::rows(1);
                            },
                        );
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
                        .map_or_else(super::authority::default_policy, Ok)?;
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
                for (k, v) in json!({"enabled":true,"toolPolicy":super::authority::default_policy()?,"config":{}})
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
                let i = Ingress::with_execution(entry, None, self.token.clone())?;
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
                        return oauth
                            .status(action.trim_start_matches("oauth/request/"), &resource);
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
                    crate::front_door::authority::remove_connection(
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
                    let next = Ingress::with_execution(entry.clone(), None, self.token.clone())?;
                    let identity_changed = crate::ingress::config::binding(&previous["config"])
                        != crate::ingress::config::binding(&entry["config"])
                        || ["transport", "controlSource", "auth", "bearerToken"]
                            .iter()
                            .any(|key| previous[*key] != entry[*key]);
                    if previous["auth"] != entry["auth"]
                        || previous["transport"] != entry["transport"]
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
            Err("UNKNOWN_ROUTE".into())
        })
    }
    pub(crate) async fn stop(&self) -> Result<()> {
        self.closing.store(true, Ordering::SeqCst);
        self.relay.cancel().await;
        crate::cloudflare::stop_login().await;
        let _configuration = self.configuration.lock().await;
        for ingress in self.entries().await {
            let _runtime = ingress.operation.lock().await;
            ingress.stop().await?;
        }
        for (id, (draft, _, task)) in std::mem::take(&mut *self.drafts.lock().await) {
            task.abort();
            let _runtime = draft.operation.lock().await;
            draft.stop().await?;
            let _ = std::fs::remove_dir_all(root().join("ingresses").join(id));
        }
        Ok(())
    }
}
