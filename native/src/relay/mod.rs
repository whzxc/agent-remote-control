//! Self-hosted relay administration is local-only; public traffic uses the existing ingress.
mod deploy;
mod identity;
pub(crate) mod transport;
use crate::*;
use identity::Identity;

#[derive(Default)]
pub(crate) struct Manager {
    job: Mutex<Option<Job>>,
}
struct Job {
    status: Arc<Mutex<Value>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Job {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Manager {
    pub(crate) async fn cancel(&self) -> Option<String> {
        let mut guard = self.job.lock().await;
        let job = guard.as_mut()?;
        if job.task.is_finished() {
            return None;
        }
        job.task.abort();
        let _ = (&mut job.task).await;
        let mut state = job.status.lock().await;
        state["phase"] = json!("failed");
        state["cancelled"] = json!(true);
        state["reason"] = json!("Cancelled. Completed remote effects are retained; use relay.list to reconnect, redeploy or delete.");
        state["loginUrl"] = Value::Null;
        state["ingressId"].as_str().map(str::to_owned)
    }
}
fn directory(id: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid relay id")?;
    Ok(root().join("relay").join(id))
}
fn read(id: &str) -> Result<Value> {
    load(&directory(id)?.join("config.json"))
}
fn records() -> Result<Vec<Value>> {
    let mut records = Vec::new();
    let dir = root().join("relay");
    if !dir.exists() {
        return Ok(records);
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().join("config.json").is_file() {
            records.push(load(&entry.path().join("config.json"))?);
        }
    }
    Ok(records)
}
fn owner(config: &Value) -> Result<Identity> {
    if config["owner"] != true {
        return Err("Only the relay owner can manage or invite instances".into());
    }
    let secrets = load(&directory(string(config, "id"))?.join("secrets.json"))?;
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(string(&secrets, "managementPrivateKey"))
        .map_err(|_| "Invalid management key")?;
    Identity::from_bytes(&bytes)
}
async fn client() -> Result<reqwest::Client> {
    let proxy = crate::proxy::NetworkProxy::resolve_relay(
        &load(&root().join("app/preferences.json"))
            .unwrap_or_else(|_| crate::ingress::config::defaults()),
    )
    .await?;
    transport::client(&proxy).await
}
pub(crate) fn validate_config(settings: &Value) -> Result<()> {
    identity::origin(string(settings, "relayUrl"))?;
    let id = string(settings, "relayInstanceId");
    if id.len() != 64
        || !id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err("Invalid relay instance id".into());
    }
    Ok(())
}
async fn step(status: &Mutex<Value>, phase: &str) {
    status.lock().await["phase"] = json!(phase);
}
async fn connect(
    service: &Arc<crate::service::Service>,
    config: &mut Value,
    status: &Mutex<Value>,
) -> Result<Value> {
    step(status, "connecting").await;
    let identity = Identity::instance()?;
    if string(config, "ingressId").is_empty() {
        // Persist the intended id first so cancellation/restart can resume it.
        config["ingressId"] = json!(id());
        save(
            &directory(string(config, "id"))?.join("config.json"),
            config,
        )?;
    }
    let ingress_id = string(config, "ingressId");
    status.lock().await["ingressId"] = json!(ingress_id);
    if service.ingress(ingress_id).await.is_err() {
        Box::pin(service.request("ingress","POST",json!({
            "id":ingress_id,"name":config["name"],"controlSource":"shared-relay","transport":"relay","auth":"oauth",
            "enabled":true,"config":{"relayUrl":config["url"],"relayInstanceId":identity.id(),"autoStart":true}
        }))).await?;
    }
    Box::pin(service.request(&format!("ingress/{ingress_id}/start"), "POST", json!({}))).await?;
    let ingress = service.ingress(ingress_id).await?;
    ingress.relay_ready().await?;
    status.lock().await["ingressId"] = json!(ingress_id);
    Ok(
        json!({"relayId":config["id"],"ingressId":ingress_id,"url":format!("{}/u/{}/mcp",string(config,"url"),identity.id())}),
    )
}
async fn execute(
    service: Arc<crate::service::Service>,
    action: String,
    body: Value,
    status: Arc<Mutex<Value>>,
) -> Result<Value> {
    if action == "join" {
        let (url, token) = identity::parse_link(string(&body, "link"))?;
        let existing = records()?.into_iter().find(|r| r["url"] == url);
        if existing.as_ref().is_some_and(|r| r["owner"] == true) {
            return Err("This machine owns the relay; use relay.connect or relay.redeploy".into());
        }
        let instance = Identity::instance()?;
        let mut config =
            existing.unwrap_or_else(|| json!({"id":id(),"url":url,"owner":false,"ingressId":""}));
        config["name"] = json!(label(&body)?);
        let relay_id = string(&config, "id").to_owned();
        status.lock().await["relayId"] = json!(relay_id);
        // Retain a recoverable record even if cancellation races remote registration.
        save(&directory(&relay_id)?.join("config.json"), &config)?;
        // Invitation is used only for registration, never persisted on a member machine.
        transport::control(&client().await?, &url, &instance, json!({"op":"register","publicKey":instance.public_key(),"name":crate::device_name().await,"token":token})).await?;
        save(&directory(&relay_id)?.join("config.json"), &config)?;
        return connect(&service, &mut config, &status).await;
    }
    let mut config = if action == "create" {
        let existing = records()?.into_iter().find(undeployed);
        let config = draft(existing, &body)?;
        let relay_id = string(&config, "id");
        let secrets = directory(relay_id)?.join("secrets.json");
        if !secrets.exists() {
            let key = Identity::generate()?;
            use base64::Engine;
            save(
                &secrets,
                &json!({"managementPrivateKey":base64::engine::general_purpose::STANDARD.encode(key)}),
            )?;
        }
        save(&directory(relay_id)?.join("config.json"), &config)?;
        config
    } else {
        read(string(&body, "id"))?
    };
    if let Some(account) = body.get("accountId") {
        let id = account.as_str().ok_or("Invalid accountId")?;
        if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid accountId".into());
        }
        config["accountId"] = account.clone();
        save(
            &directory(string(&config, "id"))?.join("config.json"),
            &config,
        )?;
    }
    status.lock().await["relayId"] = config["id"].clone();
    if action == "connect" {
        return connect(&service, &mut config, &status).await;
    }
    let owner = owner(&config)?;
    if config["deleted"] == true && action != "delete" {
        return Err("Relay deleted; finish relay.delete cleanup".into());
    }
    if action == "delete" {
        step(&status, "deploying").await;
        if config["deleted"] != true && !string(&config, "url").is_empty() {
            transport::control(
                &client().await?,
                string(&config, "url"),
                &owner,
                json!({"op":"delete"}),
            )
            .await?;
        }
        config["deleted"] = json!(true);
        save(
            &directory(string(&config, "id"))?.join("config.json"),
            &config,
        )?;
        remove_ingress(&service, &config).await?;
        if config["deploymentStarted"] == true {
            deploy::delete(&config, &status).await?;
        }
        std::fs::remove_dir_all(directory(string(&config, "id"))?).map_err(|e| e.to_string())?;
        return Ok(json!({"deleted":true}));
    }
    let url = deploy::run(
        &config,
        &owner.public_key(),
        &status,
        body["openBrowser"] != false,
    )
    .await?;
    config = read(string(&config, "id"))?;
    config["url"] = json!(url);
    config["workerVersion"] = json!(env!("ARC_BUILD_VERSION"));
    save(
        &directory(string(&config, "id"))?.join("config.json"),
        &config,
    )?;
    let instance = Identity::instance()?;
    let client = client().await?;
    step(&status, "connecting").await;
    transport::wait_deployed(&client, &url).await?;
    transport::control(
        &client,
        &url,
        &owner,
        json!({"op":"register","publicKey":instance.public_key(),"name":crate::device_name().await}),
    )
    .await?;
    let secrets_path = directory(string(&config, "id"))?.join("secrets.json");
    let mut secrets = load(&secrets_path)?;
    if string(&secrets, "sharedToken").is_empty() {
        let token = transport::control(&client, &url, &owner, json!({"op":"rotate"})).await?;
        secrets["sharedToken"] = token["token"].clone();
        save(&secrets_path, &secrets)?;
    }
    connect(&service, &mut config, &status).await
}
// Never discard a record once a remote deployment may have started.
fn undeployed(config: &Value) -> bool {
    config["owner"] == true
        && config["deleted"] != true
        && config["deploymentStarted"] != true
        && string(config, "url").is_empty()
        && string(config, "ingressId").is_empty()
}
fn draft(existing: Option<Value>, body: &Value) -> Result<Value> {
    let mut config = existing.unwrap_or_else(|| {
        let id = id();
        json!({"id":id,"url":"","owner":true,"workerName":format!("arc-relay-{}", &id[..8]),"ingressId":"","workerVersion":null})
    });
    config["name"] = json!(label(body)?);
    if let Some(worker) = body.get("workerName") {
        config["workerName"] = worker.clone();
    }
    let worker = string(&config, "workerName");
    if worker.is_empty()
        || worker.len() > 63
        || !worker
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("Worker name must contain lowercase letters, digits or hyphens (1-63)".into());
    }
    Ok(config)
}
fn label(body: &Value) -> Result<String> {
    let name = body["name"].as_str().unwrap_or("Shared relay").trim();
    if name.is_empty() || name.len() > 120 || name.chars().any(char::is_control) {
        return Err("Invalid relay display name".into());
    }
    Ok(name.into())
}
async fn remove_ingress(service: &Arc<crate::service::Service>, config: &Value) -> Result<()> {
    let id = string(config, "ingressId");
    if !id.is_empty() && service.ingress(id).await.is_ok() {
        Box::pin(service.request(&format!("ingress/{id}"), "DELETE", json!({}))).await?;
    }
    Ok(())
}
pub(crate) fn request<'a>(
    service: &'a Arc<crate::service::Service>,
    route: &'a str,
    method: &'a str,
    body: Value,
) -> futures_util::future::BoxFuture<'a, Result<Value>> {
    Box::pin(async move {
        let action = route.strip_prefix("relay/").ok_or("UNKNOWN_ROUTE")?;
        if action == "list" && method == "GET" {
            return Ok(json!({"relays":records()?,"version":env!("ARC_BUILD_VERSION")}));
        }
        if action == "progress" && method == "GET" {
            crate::runtime_metrics::cost::scan_set(1);
            crate::runtime_metrics::cost::rows(1);
            let guard = service.relay.job.lock().await;
            return Ok(match guard.as_ref() {
                Some(job) => job.status.lock().await.clone(),
                None => json!({"phase":"idle"}),
            });
        }
        if method != "POST" {
            return Err("UNKNOWN_ROUTE".into());
        }
        if action == "cancel" {
            let ingress_id = service.relay.cancel().await;
            if let Some(id) = ingress_id {
                if let Ok(ingress) = service.ingress(&id).await {
                    let _guard = ingress.operation.lock().await;
                    ingress.stop().await?;
                }
            }
            return Ok(json!({"cancelled":true}));
        }
        let mut guard = service.relay.job.lock().await;
        if guard.as_ref().is_some_and(|job| !job.task.is_finished()) {
            return Err("A relay operation is already running".into());
        }
        if ["create", "redeploy", "join", "connect", "delete"].contains(&action) {
            let deploys = matches!(action, "create" | "redeploy");
            let state = Arc::new(Mutex::new(json!({
                "jobId":id(),
                "action":action,
                "phase":if deploys {"login"} else {"connecting"},
                "reason":null,
                "loginUrl":null,
                "loginStage":deploys.then_some("preparing"),
            })));
            let status = state.clone();
            let service = service.clone();
            let action = action.to_owned();
            let task = tokio::spawn(async move {
                let result = execute(service, action, body, status.clone()).await;
                let mut status = status.lock().await;
                status["loginUrl"] = Value::Null;
                match result {
                    Ok(value) => {
                        status["phase"] = json!("ready");
                        status["result"] = value;
                    }
                    Err(error) => {
                        status["failedPhase"] = status["phase"].clone();
                        status["phase"] = json!("failed");
                        status["reason"] = json!(error);
                    }
                }
            });
            *guard = Some(Job {
                status: state.clone(),
                task,
            });
            return Ok(state.lock().await.clone());
        }
        let config = read(string(&body, "id"))?;
        let url = string(&config, "url");
        let client = client().await?;
        match action {
            "me" => {
                transport::control(&client, url, &Identity::instance()?, json!({"op":"me"})).await
            }
            "leave" => {
                transport::control(&client, url, &Identity::instance()?, json!({"op":"leave"}))
                    .await?;
                remove_ingress(service, &config).await?;
                if config["owner"] == true {
                    let mut config = config.clone();
                    config["ingressId"] = json!("");
                    save(
                        &directory(string(&config, "id"))?.join("config.json"),
                        &config,
                    )?;
                } else {
                    std::fs::remove_dir_all(directory(string(&config, "id"))?)
                        .map_err(|e| e.to_string())?;
                }
                Ok(json!({"left":true}))
            }
            "instances" => {
                let mut members =
                    transport::control(&client, url, &owner(&config)?, json!({"op":"list"}))
                        .await?;
                let own_id = Identity::instance()?.id();
                if let Some(rows) = members.as_array_mut() {
                    for member in rows {
                        member["isSelf"] = json!(member["id"] == own_id);
                    }
                }
                Ok(members)
            }
            "remove" => {
                let result = transport::control(
                    &client,
                    url,
                    &owner(&config)?,
                    json!({"op":"remove","id":body["instanceId"]}),
                )
                .await?;
                if body["instanceId"] == Identity::instance()?.id() {
                    remove_ingress(service, &config).await?;
                }
                Ok(result)
            }
            "share" | "reset-token" => {
                let owner = owner(&config)?;
                let path = directory(string(&config, "id"))?.join("secrets.json");
                let mut secrets = load(&path)?;
                if action == "reset-token" {
                    secrets["sharedToken"] =
                        transport::control(&client, url, &owner, json!({"op":"rotate"})).await?
                            ["token"]
                            .clone();
                    save(&path, &secrets)?;
                }
                if string(&secrets, "sharedToken").is_empty() {
                    return Err("No shared token; reset the token first".into());
                }
                Ok(json!({"link":identity::share_link(url,string(&secrets,"sharedToken"))}))
            }
            _ => Err("UNKNOWN_ROUTE".into()),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelled_creation_reuses_only_an_undeployed_draft() {
        // Regression: 42f9056; cancelled creation reuses only an undeployed draft.
        let first = draft(None, &json!({"name":"First"})).unwrap();
        assert!(undeployed(&first));
        let retry = draft(Some(first.clone()), &json!({"name":"Retry"})).unwrap();
        assert_eq!(retry["id"], first["id"]);
        assert_eq!(retry["workerName"], first["workerName"]);
        assert_eq!(retry["name"], "Retry");
        for (key, value) in [
            ("deploymentStarted", json!(true)),
            ("owner", json!(false)),
            ("deleted", json!(true)),
            ("url", json!("https://relay.example")),
            ("ingressId", json!("existing")),
        ] {
            let mut existing = first.clone();
            existing[key] = value;
            assert!(!undeployed(&existing), "must preserve {key}");
        }
    }
    #[tokio::test]
    async fn cancellation_waits_for_job_drop_and_keeps_recovery_information() {
        // Regression: cancelled deployment must retain recovery information until its job stops.
        let state = Arc::new(Mutex::new(
            json!({"phase":"connecting","relayId":"saved","ingressId":"local","loginUrl":"https://example.invalid"}),
        ));
        let (ready, receive) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        receive.await.unwrap();
        let manager = Manager {
            job: Mutex::new(Some(Job {
                status: state.clone(),
                task,
            })),
        };
        assert_eq!(manager.cancel().await, Some("local".into()));
        let state = state.lock().await;
        assert_eq!(state["phase"], "failed");
        assert_eq!(state["cancelled"], true);
        assert_eq!(state["relayId"], "saved");
        assert!(state["loginUrl"].is_null());
    }
    #[test]
    fn relay_api_is_local_and_uses_existing_management_envelope() {
        // Contract: relay management routes retain the local JSON request envelope.
        for (name, body) in [
            ("relay.create", json!({})),
            (
                "relay.join",
                json!({"link":"https://example.invalid/#arc-relay=example"}),
            ),
            (
                "relay.remove",
                json!({"id":"00000000-0000-0000-0000-000000000001","instanceId":"a".repeat(64)}),
            ),
        ] {
            let (route, method, _) =
                crate::management::resolve(name, &json!({"body":body})).unwrap();
            assert_eq!(method, "POST");
            assert!(route.starts_with("relay/"));
        }
        assert!(
            crate::management::resolve("relay.remove", &json!({"body":{"id":"../escape"}}))
                .is_err()
        );
    }
}
