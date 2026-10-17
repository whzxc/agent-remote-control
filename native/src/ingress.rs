pub mod config;
use crate::*;
use config::{binding, configured, secrets, validate_config};
use std::{
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Child,
};
pub struct Ingress {
    pub id: String,
    pub meta: Mutex<Value>,
    pub(crate) oauth: Mutex<crate::oauth::OAuth>,
    dir: PathBuf,
    pub(crate) execution: Arc<crate::execution::Execution>,
    pub(crate) wait_calls: crate::transport::WaitCalls,
    pub token: String,
    pub port: std::sync::atomic::AtomicU16,
    settings: Mutex<Value>,
    verification: Mutex<Value>,
    logs: Mutex<Vec<String>>,
    tunnel: Mutex<Option<Child>>,
    https: Mutex<Option<tokio::task::JoinHandle<()>>>,
    managed_tunnel: Mutex<Option<crate::https_tunnel::Tunnel>>,
    pub(crate) mcp_url: Mutex<String>,
    starting: std::sync::atomic::AtomicBool,
    run_dir: Mutex<Option<PathBuf>>,
    started: Mutex<Option<Instant>>,
    failure: Mutex<String>,
    control_plane: Mutex<Value>,
    tunnel_dependency: Mutex<Value>,
    tunnel_error: Mutex<String>,
    pub(crate) operation: Mutex<()>,
    pub(crate) retired: std::sync::atomic::AtomicBool,
    pub connected: std::sync::atomic::AtomicBool,
    stopping: std::sync::atomic::AtomicBool,
    ready_logged: std::sync::atomic::AtomicBool,
}
impl Ingress {
    pub fn new(
        entry: Value,
        execution: Arc<crate::execution::Execution>,
        token: String,
    ) -> Result<Arc<Self>> {
        let ingress_id = string(&entry, "id").to_owned();
        let dir = root().join("ingresses").join(&ingress_id);
        private_dir(&dir)?;
        crate::logs::migrate(&dir, &ingress_id)?;
        let settings = entry["config"].clone();
        validate_config(&settings)?;
        let verification = load(&dir.join("verification.json"))
            .unwrap_or_else(|_| json!({"code":id(),"verifiedAt":null}));
        save(&dir.join("verification.json"), &verification)?;
        Ok(Arc::new(Self {
            id: ingress_id,
            meta: Mutex::new(entry),
            oauth: Mutex::new(crate::oauth::OAuth::new(&dir)?),
            dir: dir.clone(),
            execution,
            wait_calls: Default::default(),
            token,
            port: std::sync::atomic::AtomicU16::new(0),
            settings: Mutex::new(settings),
            verification: Mutex::new(verification),
            logs: Mutex::new(crate::logs::recent(
                dir.file_name().and_then(|name| name.to_str()),
            )),
            stopping: std::sync::atomic::AtomicBool::new(false),
            ready_logged: std::sync::atomic::AtomicBool::new(false),
            tunnel: Mutex::new(None),
            https: Mutex::new(None),
            managed_tunnel: Mutex::new(None),
            mcp_url: Mutex::new(String::new()),
            starting: std::sync::atomic::AtomicBool::new(false),
            run_dir: Mutex::new(None),
            started: Mutex::new(None),
            failure: Mutex::new(String::new()),
            control_plane: Mutex::new(Value::Null),
            tunnel_dependency: Mutex::new(Value::Null),
            tunnel_error: Mutex::new(String::new()),
            operation: Mutex::new(()),
            retired: std::sync::atomic::AtomicBool::new(false),
            connected: std::sync::atomic::AtomicBool::new(false),
        }))
    }
    pub(crate) async fn validate_draft_url(&self, url: &str) -> Result<()> {
        let mut managed = self.managed_tunnel.lock().await;
        let tunnel = managed.as_mut().ok_or("MCP URL is not ready")?;
        if !tunnel.ready().await?
            || url.is_empty()
            || !(tunnel.url == url || tunnel.urls.iter().any(|u| u == url))
        {
            return Err("MCP URL is no longer available; obtain it again".into());
        }
        Ok(())
    }
    pub(crate) async fn activate_draft(&self, entry: Value) -> Result<()> {
        let url = string(&entry["config"], "httpsUrl").to_owned();
        if let Some(tunnel) = self.managed_tunnel.lock().await.as_mut() {
            tunnel.selected_url = url.clone();
            tunnel.url = url.clone();
        }
        *self.mcp_url.lock().await = url;
        *self.settings.lock().await = entry["config"].clone();
        *self.meta.lock().await = entry;
        Ok(())
    }
    pub async fn persist(&self, config: &Value) -> Result<()> {
        let mut entry = self.meta.lock().await.clone();
        entry["config"] = config.clone();
        entry["transport"] = json!(if config["connectionMode"] == "https" {
            "https"
        } else {
            "openai-tunnel"
        });
        if entry["transport"] == "openai-tunnel" {
            entry["auth"] = json!("openai");
        } else if entry["auth"] == "openai" {
            entry["auth"] = json!("none");
        }
        crate::service::store_entry(&entry)?;
        *self.meta.lock().await = entry;
        Ok(())
    }
    pub async fn origin(&self) -> Value {
        let meta = self.meta.lock().await;
        json!({"ingressId":self.id,"controlSource":meta["controlSource"],"authType":meta["auth"]})
    }
    pub async fn allows(&self, name: &str) -> bool {
        let meta = self.meta.lock().await;
        let allowed = crate::kernel::policy::allows(&meta["toolPolicy"], name);
        drop(meta);
        allowed && self.execution.available(name).await
    }
    pub async fn authenticate(&self, header: &str) -> bool {
        let meta = self.meta.lock().await;
        if meta["auth"] == "none" {
            return true;
        }
        if meta["auth"] == "oauth" {
            drop(meta);
            let resource = self.mcp_url.lock().await.clone();
            let Ok(resource) = reqwest::Url::parse(&resource) else {
                return false;
            };
            return self
                .oauth
                .lock()
                .await
                .authenticate(header, resource.as_str());
        }
        if meta["auth"] != "bearer" {
            return false;
        }
        let token = string(&meta, "bearerToken");
        !token.is_empty() && hash(header) == hash(format!("Bearer {token}"))
    }
    pub(crate) async fn observe_request(&self, field: &str) -> Result<()> {
        let mut verification = self.verification.lock().await;
        if verification[field].is_null() {
            verification[field] = json!(now());
            save(&self.dir.join("verification.json"), &verification)?;
        }
        Ok(())
    }
    pub(crate) async fn observe(&self, field: &str, value: Value) -> Result<()> {
        let mut verification = self.verification.lock().await;
        verification[field] = value;
        save(&self.dir.join("verification.json"), &verification)
    }
    pub async fn summary(&self) -> Result<Value> {
        let status = self.status().await?;
        let meta = self.meta.lock().await;
        let config = status["config"].clone();
        let mut result = json!({"health":status["tunnel"]["health"],"controlPlane":status["tunnel"]["controlPlane"],"tunnelDependency":status["tunnel"]["dependency"],"tunnelError":status["tunnel"]["lastError"],"discoveredUrls":status["discoveredUrls"],"id":self.id,"name":meta["name"],"controlSource":meta["controlSource"],"transport":meta["transport"],"provider":config["httpsProvider"],"enabled":meta["enabled"],"auth":meta["auth"],"toolPolicy":meta["toolPolicy"],"config":config,"running":status["connection"]["running"],"state":status["tunnel"]["state"],"error":status["tunnel"]["error"],"url":status["connection"]["mcpUrl"],"verification":status["core"]["chatgpt"],"logs":status["logs"]});
        result["diagnostics"] = crate::diagnostics::ingress(&result);
        Ok(result)
    }
    pub async fn network_proxy(&self) -> Result<crate::proxy::NetworkProxy> {
        let settings = self.settings.lock().await.clone();
        crate::proxy::NetworkProxy::resolve(&settings).await
    }
    pub async fn log(&self, level: &str, msg: &str) {
        let settings = self.settings.lock().await;
        let mut msg = msg.replace(&self.token, "[REDACTED]");
        for key in secrets()
            .map(|(key, _)| key)
            .chain(std::iter::once("tunnelId"))
        {
            let value = string(&settings, key);
            if !value.is_empty() {
                msg = msg.replace(value, "[REDACTED]");
            }
        }
        drop(settings);
        let meta = self.meta.lock().await;
        let bearer = string(&meta, "bearerToken");
        if !bearer.is_empty() {
            msg = msg.replace(bearer, "[REDACTED]");
        }
        drop(meta);
        if matches!(level, "WARN" | "WARNING" | "ERROR" | "FATAL" | "PANIC") {
            *self.tunnel_error.lock().await = msg.chars().take(1200).collect();
        }
        let mut logs = self.logs.lock().await;
        logs.push(json!({"time":now(),"level":level,"msg":msg}).to_string());
        if logs.len() > 200 {
            logs.remove(0);
        }
        crate::logs::record(level, &msg, Some(&self.id));
    }
    pub async fn status(&self) -> Result<Value> {
        // Cleanup must not race a start/stop operation; status remains readable during downloads.
        let lifecycle = self.operation.try_lock().ok();
        let mut child = self.tunnel.lock().await;
        let exited = if let Some(c) = child.as_mut() {
            c.try_wait().map_err(|e| e.to_string())?.is_some()
        } else {
            false
        };
        if exited && lifecycle.is_some() {
            child.take();
            self.connected
                .store(false, std::sync::atomic::Ordering::SeqCst);

            *self.failure.lock().await = "连接进程已退出，请重新连接".into();
        }
        let tunnel_running = child.is_some();
        drop(child);
        let mut https = self.https.lock().await;
        if lifecycle.is_some() && https.as_ref().is_some_and(|task| task.is_finished()) {
            https.take();
            self.connected
                .store(false, std::sync::atomic::Ordering::SeqCst);

            *self.failure.lock().await = "MCP 监听已退出，请重新连接".into();
        }
        let https_running = https.is_some();
        drop(https);
        let starting = self.starting.load(std::sync::atomic::Ordering::SeqCst);
        let mut managed = self.managed_tunnel.lock().await;
        if lifecycle.is_some() && !https_running && !starting {
            if let Some(tunnel) = managed.take() {
                tunnel.stop().await;
            }
            self.mcp_url.lock().await.clear();
        }
        let mut health_error = String::new();
        let managed_ready = if let Some(tunnel) = managed.as_mut() {
            match tunnel.ready().await {
                Ok(ready) => {
                    health_error = tunnel.health_error.clone();
                    let mut url = self.mcp_url.lock().await;
                    if *url != tunnel.url {
                        *url = tunnel.url.clone();
                        let settings = self.settings.lock().await;
                        let mut v = self.verification.lock().await;
                        *v = json!({"binding":binding(&settings),"endpoint":*url,"code":id(),"verifiedAt":null});
                        save(&self.dir.join("verification.json"), &v)?;
                    }
                    ready && !url.is_empty()
                }
                Err(error) if lifecycle.is_some() => {
                    *self.failure.lock().await = error;
                    self.connected
                        .store(false, std::sync::atomic::Ordering::SeqCst);
                    if let Some(tunnel) = managed.take() {
                        tunnel.stop().await;
                    }
                    if let Some(task) = self.https.lock().await.take() {
                        task.abort();
                    }
                    self.mcp_url.lock().await.clear();
                    false
                }
                Err(_) => false,
            }
        } else {
            true
        };
        let urls = managed.as_ref().map(|t| t.urls.clone()).unwrap_or_default();

        let tunnel_health = managed
            .as_ref()
            .map(|t| t.health.clone())
            .unwrap_or(Value::Null);
        drop(managed);
        let running = starting
            || tunnel_running
            || (https_running && self.connected.load(std::sync::atomic::Ordering::SeqCst));
        let mut ready = !starting
            && https_running
            && self.connected.load(std::sync::atomic::Ordering::SeqCst)
            && managed_ready;
        let mut control_plane = self.control_plane.lock().await.clone();
        if tunnel_running {
            ready = false;
            if control_plane["state"] != "rejected" {
                control_plane = Value::Null;
            }
            if let Some(dir) = self.run_dir.lock().await.as_ref() {
                if let Ok(url) = std::fs::read_to_string(dir.join("health.url")) {
                    if let Ok(url) = reqwest::Url::parse(url.trim()) {
                        if url.scheme() == "http" && url.host_str() == Some("127.0.0.1") {
                            let client = reqwest::Client::builder()
                                .no_proxy()
                                .timeout(Duration::from_secs(2))
                                .build()
                                .map_err(|e| e.to_string())?;
                            if let Ok(r) = client
                                .get(
                                    url.join("/health/control-plane")
                                        .map_err(|e| e.to_string())?,
                                )
                                .send()
                                .await
                            {
                                if r.status().is_success() {
                                    if let Ok(snapshot) = r.json::<Value>().await {
                                        control_plane = control_plane_health(&snapshot);
                                        *self.control_plane.lock().await = control_plane.clone();
                                    }
                                }
                            }
                            if let Ok(r) = client
                                .get(url.join("/readyz").map_err(|e| e.to_string())?)
                                .send()
                                .await
                            {
                                ready = r.status().is_success()
                                    && control_plane["state"] == "authenticated";
                            }
                        }
                    }
                }
            }
        }
        if control_plane["state"] == "rejected" {
            ready = false;
            health_error =
                crate::i18n::text(&crate::i18n::locale(), "setup.runtime-key-rejected").into();
        }
        let mut error = self.failure.lock().await.clone();
        if error.is_empty() && !starting {
            error = health_error;
        }
        let state = if starting {
            "starting"
        } else if !running {
            if error.is_empty() {
                "stopped"
            } else {
                "error"
            }
        } else if control_plane["state"] == "rejected" {
            "error"
        } else if ready {
            "ready"
        } else if self
            .started
            .lock()
            .await
            .is_some_and(|t| t.elapsed() > Duration::from_secs(30))
        {
            "degraded"
        } else {
            "starting"
        };
        drop(lifecycle);
        let mut config = self.settings.lock().await.clone();
        config["configured"] = json!(configured(&config));
        for (key, flag) in secrets() {
            config[flag] = json!(!string(&config, key).is_empty());
            config.as_object_mut().unwrap().remove(key);
        }
        let mcp_url = self.mcp_url.lock().await.clone();
        let v = self.verification.lock().await;
        let chat = json!({"ingressId":self.id,"controlSource":self.meta.lock().await["controlSource"],"code":v["code"],"verifiedAt":v["verifiedAt"],"challengeVerifiedAt":v["challengeVerifiedAt"],"firstOAuthRequestAt":v["firstOAuthRequestAt"],"firstMcpRequestAt":v["firstMcpRequestAt"],"lastProbe":v["lastProbe"]});
        let logs = self.logs.lock().await.clone();
        if ready
            && !self
                .ready_logged
                .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            self.log(
                "INFO",
                "Local ingress started; verify inbound access from the control source",
            )
            .await;
        }
        let core = json!({"chatgpt":chat,"transport":{"state":state,"error":error}});
        Ok(
            json!({"discoveredUrls":urls,"core":core,"connection":{"running":running,"updateAvailable":false,"mcpUrl":mcp_url},"config":config,"tunnel":{"state":state,"error":error,"health":tunnel_health,"controlPlane":control_plane,"dependency":self.tunnel_dependency.lock().await.clone(),"lastError":self.tunnel_error.lock().await.clone()},"connector":{"state":state},"logs":logs,"version":env!("ARC_BUILD_VERSION"),"platform":if cfg!(target_os="macos"){"darwin"}else if cfg!(windows){"win32"}else{"linux"},"deviceName":std::env::var("HOSTNAME").unwrap_or_else(|_|"本机".into()),"taskApprovalEnabled":self.execution.approval_mode()?,"autoOpenCodex":self.execution.auto_open_codex()?,"notificationsEnabled":crate::claude_notify::settings()?["notificationsEnabled"],"chatgptUrl":"https://chatgpt.com/plugins"}),
        )
    }
    pub async fn stop(&self) -> Result<()> {
        self.stopping
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.ready_logged
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let was_connected = self
            .connected
            .swap(false, std::sync::atomic::Ordering::SeqCst);
        if let Some(task) = self.https.lock().await.take() {
            task.abort();
            let _ = task.await;
        }
        if let Some(tunnel) = self.managed_tunnel.lock().await.take() {
            tunnel.stop().await;
        }
        self.mcp_url.lock().await.clear();
        let mut guard = self.tunnel.lock().await;
        if let Some(child) = guard.as_mut() {
            #[cfg(unix)]
            if let Some(pid) = child.id() {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGTERM);
                }
            }
            #[cfg(windows)]
            if let Some(pid) = child.id() {
                let _ = output("taskkill.exe", &["/PID", &pid.to_string(), "/T", "/F"]).await;
            }
            if tokio::time::timeout(Duration::from_secs(10), child.wait())
                .await
                .is_err()
            {
                #[cfg(unix)]
                if let Some(pid) = child.id() {
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGKILL);
                    }
                }
                let _ = child.kill().await;
            }
        }
        guard.take();
        drop(guard);

        if let Some(dir) = self.run_dir.lock().await.take() {
            let _ = std::fs::remove_dir_all(dir);
        }
        *self.failure.lock().await = String::new();
        *self.control_plane.lock().await = Value::Null;
        self.tunnel_error.lock().await.clear();
        if was_connected {
            self.log("INFO", "Connection closed").await;
        }
        Ok(())
    }
    pub(crate) async fn start(self: &Arc<Self>) -> Result<()> {
        self.starting
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let result = self.start_inner().await;
        if let Err(error) = &result {
            let _ = self.stop().await;
            *self.failure.lock().await = error.clone();
            self.log("ERROR", error).await;
        }
        self.starting
            .store(false, std::sync::atomic::Ordering::SeqCst);
        result
    }
    async fn start_inner(self: &Arc<Self>) -> Result<()> {
        if self.meta.lock().await["enabled"] != true {
            return Err("ingress disabled".into());
        }
        let settings = self.settings.lock().await.clone();
        // Check even an already-running ingress before treating start as a no-op.
        let binary = if settings["connectionMode"] != "https" && configured(&settings) {
            Some(self.prepare_tunnel(false).await?)
        } else {
            None
        };
        if self.connected.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        self.stop().await?;
        if !configured(&settings) {
            return Err("请先填写连接信息".into());
        }
        if settings["connectionMode"] == "https" {
            let (task, address) = crate::https::listen(self.clone(), &settings).await?;
            *self.https.lock().await = Some(task);
            let url = if settings["httpsProvider"] == "custom" {
                string(&settings, "httpsUrl").to_owned()
            } else {
                self.log(
                    "INFO",
                    "Preparing HTTPS tunnel; first use requires downloading components",
                )
                .await;
                let proxy = crate::proxy::NetworkProxy::resolve(&settings).await?;
                let tunnel = crate::https_tunnel::start(
                    self,
                    &settings,
                    &format!("http://{address}"),
                    &proxy,
                )
                .await?;
                let url = tunnel.url.clone();
                *self.managed_tunnel.lock().await = Some(tunnel);
                url
            };
            if self
                .https
                .lock()
                .await
                .as_ref()
                .is_none_or(|task| task.is_finished())
            {
                return Err("MCP 监听未能保持运行，请重新连接".into());
            }
            *self.mcp_url.lock().await = url.clone();
            if settings["httpsProvider"] != "custom" {
                let mut v = self.verification.lock().await;
                if v["endpoint"] != url {
                    *v = json!({"binding":binding(&settings),"endpoint":url,"code":id(),"verifiedAt":null});
                    save(&self.dir.join("verification.json"), &v)?;
                }
            }
            *self.started.lock().await = Some(Instant::now());
            self.stopping
                .store(false, std::sync::atomic::Ordering::SeqCst);
            self.connected
                .store(true, std::sync::atomic::Ordering::SeqCst);
            self.log(
                "INFO",
                "Local MCP listener started; verify public inbound access from the control source",
            )
            .await;
            return Ok(());
        }
        let proxy = crate::proxy::NetworkProxy::resolve(&settings).await?;
        self.log("INFO", proxy.message).await;
        let binary = binary.ok_or("Tunnel Client was not prepared")?;
        let dir = root().join("runs").join(id());
        private_dir(&dir)?;
        let key = dir.join("api-key");
        write_secret(&key, string(&settings, "apiKey"))?;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let mcp = format!(
            "{} stdio",
            serde_json::to_string(exe.to_str().ok_or("invalid executable")?).unwrap()
        );
        let key_ref = format!("file:{}", key.display());
        let port = self.port.load(std::sync::atomic::Ordering::SeqCst);
        if port == 0 {
            return Err("本机通信尚未启动".into());
        }
        let result = async {
            let mut init = tunnel_command(&binary);
            proxy.apply(&mut init);
            init.args([
                "init",
                "--sample",
                "sample_mcp_stdio_local",
                "--profile",
                "arc",
                "--profile-dir",
                dir.to_str().unwrap(),
                "--control-plane-api-key-ref",
                &key_ref,
                "--tunnel-id",
                string(&settings, "tunnelId"),
                "--health-listen-addr",
                "127.0.0.1:0",
                "--mcp-command",
                &mcp,
            ]);
            let o = tokio::time::timeout(Duration::from_secs(30), init.output())
                .await
                .map_err(|_| "Tunnel 配置超时")?
                .map_err(|e| e.to_string())?;
            if !o.status.success() {
                let detail = format!(
                    "{} {}",
                    String::from_utf8_lossy(&o.stderr),
                    String::from_utf8_lossy(&o.stdout)
                );
                self.log("ERROR", &format!("Tunnel init failed: {detail}"))
                    .await;
                return Err(self.tunnel_error.lock().await.clone());
            }
            let mut cmd = tunnel_command(&binary);
            proxy.apply(&mut cmd);
            cmd.args([
                "run",
                "--profile",
                "arc",
                "--profile-dir",
                dir.to_str().unwrap(),
                "--health.url-file",
                dir.join("health.url").to_str().unwrap(),
            ])
            // The official Tunnel admin bridge otherwise resolves the npm Codex launcher.
            .env(
                "TUNNEL_CLIENT_CODEX_APP_SERVER_CMD",
                crate::agents::codex_binary()
                    .unwrap_or_else(|| PathBuf::from(string(&settings, "codexBinary"))),
            )
            .env("TUNNEL_CLIENT_CODEX_APP_SERVER_ARGS", "app-server")
            .env("ARC_NATIVE_PORT", port.to_string())
            .env("ARC_NATIVE_TOKEN", &self.token)
            .env("ARC_INGRESS_ID", &self.id)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
            #[cfg(unix)]
            cmd.process_group(0);
            self.stopping
                .store(false, std::sync::atomic::Ordering::SeqCst);
            let mut child = cmd.spawn().map_err(|e| e.to_string())?;
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            for stream in [
                Box::new(stdout) as Box<dyn tokio::io::AsyncRead + Send + Unpin>,
                Box::new(stderr),
            ] {
                let service = Arc::downgrade(self);
                tokio::spawn(async move {
                    let mut lines = BufReader::new(stream).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        if line.len() > 65536 {
                            continue;
                        }
                        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
                            continue;
                        };
                        let level = string(&entry, "level").to_uppercase();
                        let msg = string(&entry, "msg");
                        let Some(s) = service.upgrade() else { break };
                        if s.stopping.load(std::sync::atomic::Ordering::SeqCst) {
                            continue;
                        }
                        if let Some(status) = rejected_control_plane_log(&entry) {
                            *s.control_plane.lock().await =
                                json!({"state":"rejected","httpStatus":status});
                        }
                        if matches!(
                            level.as_str(),
                            "WARN" | "WARNING" | "ERROR" | "FATAL" | "PANIC"
                        ) {
                            let detail = entry
                                .get("error")
                                .or_else(|| entry.get("err"))
                                .filter(|v| !v.is_null());
                            s.log(
                                &level,
                                &detail
                                    .map(|v| format!("{msg}: {v}"))
                                    .unwrap_or_else(|| msg.to_owned()),
                            )
                            .await;
                        }
                    }
                });
            }
            *self.tunnel.lock().await = Some(child);
            Ok(())
        }
        .await;
        if let Err(e) = result {
            let _ = std::fs::remove_dir_all(dir);
            return Err(e);
        }
        *self.run_dir.lock().await = Some(dir);
        *self.started.lock().await = Some(Instant::now());
        self.connected
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.log("INFO", "Starting connection").await;
        Ok(())
    }
    async fn prepare_tunnel(&self, force: bool) -> Result<PathBuf> {
        let settings = self.settings.lock().await.clone();
        let current = executable(string(&settings, "tunnelBinary"));
        let version = match &current {
            Some(path) => tunnel_version(path).await,
            None => Err("Tunnel Client is missing".into()),
        };
        let observed = version
            .as_ref()
            .ok()
            .map(|v| format!("{}.{}.{}", v[0], v[1], v[2]));
        *self.tunnel_dependency.lock().await = json!({"path":current,"version":observed,
            "minimumVersion":TUNNEL_MIN_VERSION,"state":"checking"});
        if !force {
            if let Ok(version) = &version {
                if *version >= [0, 0, 16] {
                    self.tunnel_dependency.lock().await["state"] = json!("ready");
                    return Ok(current.unwrap());
                }
            } else if current.is_some() {
                let error = version.unwrap_err();
                let mut dependency = self.tunnel_dependency.lock().await;
                dependency["state"] = json!("error");
                dependency["code"] = json!("TUNNEL_VERSION_UNKNOWN");
                dependency["error"] = json!(error);
                return Err(error);
            }
        }
        self.stop().await?;
        self.tunnel_dependency.lock().await["state"] = json!("upgrading");
        self.log(
            "INFO",
            &format!(
                "Installing Tunnel Client >= {TUNNEL_MIN_VERSION} (previous: {})",
                observed.as_deref().unwrap_or("unknown")
            ),
        )
        .await;
        let installed: Result<PathBuf> = async {
            let proxy = self.network_proxy().await?;
            let binary = install_tunnel(&proxy).await?;
            let version = tunnel_version(&binary).await?;
            if version < [0, 0, 16] {
                return Err(format!("Downloaded Tunnel Client is older than {TUNNEL_MIN_VERSION}"));
            }
            // Preserve ownership of the historical ARC launcher after switching paths.
            if let (Some(old), Some(home)) = (&current, dirs::home_dir()) {
                if *old == home.join(".local/bin/tunnel-client") {
                    save(&root().join("dependencies/legacy-tunnel.json"), &json!({"path":old}))?;
                }
            }
            let mut settings = self.settings.lock().await;
            settings["tunnelBinary"] = json!(binary);
            self.persist(&settings).await?;
            *self.tunnel_dependency.lock().await = json!({"state":"ready","path":binary,
                "version":format!("{}.{}.{}",version[0],version[1],version[2]),"minimumVersion":TUNNEL_MIN_VERSION});
            Ok(binary)
        }.await;
        if let Err(error) = &installed {
            self.log("ERROR", &format!("Tunnel Client upgrade failed: {error}"))
                .await;
            let mut dependency = self.tunnel_dependency.lock().await;
            dependency["state"] = json!("error");
            dependency["code"] = json!("TUNNEL_UPGRADE_FAILED");
            dependency["error"] = json!(self.tunnel_error.lock().await.clone());
        }
        installed
    }
    pub async fn request(
        self: &Arc<Self>,
        route: &str,
        method: &str,
        body: Value,
    ) -> Result<Value> {
        let _guard = if method != "GET" {
            Some(self.operation.lock().await)
        } else {
            None
        };
        if self.retired.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("ingress removed or replaced".into());
        }
        match (method, route) {
            ("GET", "status") => self.status().await,
            ("POST", "verification/reset") => {
                let mut v = self.verification.lock().await;
                let next = json!({"binding":v["binding"],"endpoint":v["endpoint"],"code":id(),"verifiedAt":null});
                save(&self.dir.join("verification.json"), &next)?;
                *v = next;
                Ok(json!({"code":v["code"],"verifiedAt":null}))
            }
            ("GET", "core") => Ok(self.status().await?["core"].clone()),
            ("GET", "config/credentials") => {
                let bearer = self.meta.lock().await["bearerToken"].clone();
                let settings = self.settings.lock().await;
                let mut credentials = json!({"bearerToken":bearer});
                for (key, _) in secrets() {
                    credentials[key] = settings[key].clone();
                }
                Ok(credentials)
            }
            ("PUT", "network") => {
                let mode = body["proxyMode"].as_str().ok_or("代理模式无效")?;
                let address = body["proxyUrl"].as_str().ok_or("代理地址无效")?.trim();
                crate::proxy::validate(mode, address)?;
                let mut settings = self.settings.lock().await;
                let mut next = settings.clone();
                next["proxyMode"] = json!(mode);
                next["proxyUrl"] = json!(address);
                self.persist(&next).await?;
                *settings = next;
                Ok(json!({"ok":true}))
            }
            ("PUT", "config") | ("PATCH", "config/tunnel") => {
                if self.connected.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("请先关闭连接".into());
                }
                let mut body = if method == "PATCH" {
                    let fields = body.as_object().ok_or("配置格式错误")?;
                    if fields
                        .keys()
                        .any(|k| !["tunnelId", "apiKey"].contains(&k.as_str()))
                    {
                        return Err("仅接受 tunnelId 和 apiKey".into());
                    }
                    let mut next = self.settings.lock().await.clone();
                    next["connectionMode"] = json!("tunnel");
                    for (key, value) in fields {
                        next[key] = value.clone();
                    }
                    next
                } else {
                    body
                };
                for field in secrets()
                    .map(|(_, flag)| flag)
                    .chain(std::iter::once("configured"))
                {
                    body.as_object_mut().ok_or("配置格式错误")?.remove(field);
                }
                validate_config(&body)?;
                let settings = self.settings.lock().await;
                for (key, _) in secrets() {
                    if string(&body, key).is_empty() {
                        body[key] = settings[key].clone();
                    }
                }
                drop(settings);
                if !configured(&body) {
                    return Err("请补齐所选连接方式的信息".into());
                }
                self.persist(&body).await?;
                let binding = binding(&body);
                *self.settings.lock().await = body;
                let mut v = self.verification.lock().await;
                if v["binding"] != binding {
                    *v = json!({"binding":binding,"code":id(),"verifiedAt":null});
                    save(&self.dir.join("verification.json"), &v)?;
                }
                Ok(json!({"ok":true}))
            }
            ("POST", "start") => self.start().await.map(|_| json!({"ok":true})),
            ("POST", "stop") => {
                self.stop().await?;
                Ok(json!({"ok":true}))
            }
            ("GET", "dependencies") => {
                let s = self.settings.lock().await.clone();
                let describe = |binary: Option<PathBuf>| async move {
                    match binary {
                        None => json!({"source":"missing","path":null,"version":"unknown"}),
                        Some(p) => {
                            let v = output(&p, &["--version"]).await.unwrap_or_default();
                            json!({"source":if p.starts_with(root()){ "managed" }else{"external"},"path":p,"version":v.trim()})
                        }
                    }
                };
                Ok(
                    json!({"codex":describe(crate::agents::codex_binary()).await,"tunnel":describe(executable(string(&s,"tunnelBinary"))).await,"observedAt":now()}),
                )
            }
            ("POST", "install") => {
                if body["component"] != "tunnel" {
                    return Err("请安装官方 Codex Desktop".into());
                }
                let running = self.connected.load(std::sync::atomic::Ordering::SeqCst);
                self.prepare_tunnel(true).await?;
                if running {
                    self.start().await?;
                }
                Ok(json!({"ok":true}))
            }
            _ => Err("UNKNOWN_ROUTE".into()),
        }
    }
    pub async fn call(self: &Arc<Self>, name: &str, args: Value) -> Result<Value> {
        if !self.connected.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Connection closed".into());
        }
        let result = if name == "connector_verify" {
            let spec = catalog()["ops"]
                .as_array()
                .unwrap()
                .iter()
                .find(|op| op["name"] == name)
                .unwrap();
            crate::egress::validate_op(spec, &args)?;
            let mut v = self.verification.lock().await;
            if args["code"] != v["code"] {
                return Err("验证码不匹配".into());
            }
            let mut next = v.clone();
            next["challengeVerifiedAt"] = json!(now());
            next["verifiedAt"] = next["challengeVerifiedAt"].clone();
            save(&self.dir.join("verification.json"), &next)?;
            *v = next;
            Ok(json!({"code":args["code"],"received":true,"origin":self.origin().await}))
        } else {
            let policy = self.meta.lock().await["toolPolicy"].clone();
            self.execution.call(name, args, policy).await
        };
        if result.is_ok() && name != "connector_verify" {
            let mut v = self.verification.lock().await;
            if v["verifiedAt"].is_null() {
                v["verifiedAt"] = json!(now());
                save(&self.dir.join("verification.json"), &v)?;
            }
        }
        self.log(
            if result.is_ok() { "INFO" } else { "ERROR" },
            &format!(
                "{}: {name}",
                if result.is_ok() {
                    "Request processed"
                } else {
                    "Request failed"
                }
            ),
        )
        .await;
        result
    }
}
pub(crate) fn write_secret(path: &Path, text: &str) -> Result<()> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)
        .map_err(|e| e.to_string())?
        .write_all(text.as_bytes())
        .map_err(|e| e.to_string())
}
fn tunnel_command(binary: &Path) -> tokio::process::Command {
    let mut c = command(binary);
    for (k, _) in std::env::vars() {
        if [
            "TUNNEL_CLIENT_",
            "CONTROL_PLANE_",
            "HEALTH_",
            "CLOUDFLARED_",
            "MCP_",
            "HARPOON_",
            "ADMIN_UI_",
            "LOG_",
        ]
        .iter()
        .any(|p| k.starts_with(p))
            || k == "ALLOW_REMOTE_UI"
            || k == "OPEN_WEB_UI"
        {
            c.env_remove(k);
        }
    }
    c.env("ARC_STATE_DIR", root());
    c
}
fn executable(name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    if p.is_absolute() {
        return p.is_file().then(|| p.into());
    }
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|p| p.join(name))
        .find(|p| p.is_file())
}
pub(crate) const TUNNEL_MIN_VERSION: &str = "0.0.16";
async fn tunnel_version(binary: &Path) -> Result<[u64; 3]> {
    let mut command = tunnel_command(binary);
    command.arg("--version").kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .map_err(|_| "Tunnel Client --version timed out")?
        .map_err(|e| format!("Cannot run Tunnel Client --version: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Tunnel Client --version exited with {}",
            output.status
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let pattern =
        regex::Regex::new(r"(?:^|[\s])v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?(?:[\s]|$)")
            .unwrap();
    let captures = pattern
        .captures(&text)
        .ok_or("Unrecognized Tunnel Client --version output")?;
    let mut version = [0; 3];
    for (i, part) in version.iter_mut().enumerate() {
        *part = captures[i + 1]
            .parse()
            .map_err(|_| "Invalid Tunnel Client version")?;
    }
    Ok(version)
}
async fn install_tunnel(proxy: &crate::proxy::NetworkProxy) -> Result<PathBuf> {
    static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = INSTALL.lock().await;
    let parent = root().join("dependencies/tunnel");
    let binary_name = if cfg!(windows) {
        "tunnel-client.exe"
    } else {
        "tunnel-client"
    };
    let cloudflared_name = if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    };
    let mut cached = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&parent) {
        for entry in entries.flatten() {
            let binary = entry.path().join(binary_name);
            if binary.is_file() && entry.path().join(cloudflared_name).is_file() {
                if let Ok(version) = tunnel_version(&binary).await {
                    if version >= [0, 0, 16] {
                        cached.push((version, binary));
                    }
                }
            }
        }
    }
    if let Some((_, binary)) = cached.into_iter().max_by(|a, b| a.0.cmp(&b.0)) {
        return Ok(binary);
    }
    // Install the supported official version directly. Startup must not depend
    // on the anonymous GitHub releases API or on discovering the latest release.
    let tag = format!("v{TUNNEL_MIN_VERSION}");
    let base = format!("https://github.com/openai/tunnel-client/releases/download/{tag}");
    let client = proxy
        .client(reqwest::Client::builder())
        .user_agent("agent-remote-control")
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return Err("不支持的平台".into());
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64"
    };
    let name = format!("tunnel-client-{tag}-{platform}-{arch}.zip");
    let sums = client
        .get(format!("{base}/SHA256SUMS.txt"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let expected = sums
        .lines()
        .find_map(|l| {
            let a: Vec<_> = l.split_whitespace().collect();
            (a.len() == 2 && a[1].trim_start_matches('*') == name).then(|| a[0].to_owned())
        })
        .ok_or("官方校验和缺失")?;
    let bytes = client
        .get(format!("{base}/{name}"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    if hash(&bytes) != expected.to_lowercase() {
        return Err("SHA256 校验失败".into());
    }
    let dir = root().join("dependencies/tunnel").join(tag);
    private_dir(&dir)?;
    let archive = dir.join("download.zip");
    std::fs::write(&archive, &bytes).map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    output(
        "/usr/bin/unzip",
        &["-o", archive.to_str().unwrap(), "-d", dir.to_str().unwrap()],
    )
    .await?;
    #[cfg(windows)]
    output(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                archive.display().to_string().replace('\'', "''"),
                dir.display().to_string().replace('\'', "''")
            ),
        ],
    )
    .await?;
    let _ = std::fs::remove_file(archive);
    let binary = dir.join(if cfg!(windows) {
        "tunnel-client.exe"
    } else {
        "tunnel-client"
    });
    for name in [
        if cfg!(windows) {
            "tunnel-client.exe"
        } else {
            "tunnel-client"
        },
        if cfg!(windows) {
            "cloudflared.exe"
        } else {
            "cloudflared"
        },
    ] {
        let p = dir.join(name);
        if !p.is_file() {
            return Err("组件不完整".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(binary)
}

/// Called before ingress processes start. Keep every configured version and the newest download.
pub(crate) fn prune_tunnel_versions() -> Result<()> {
    let parent = root().join("dependencies/tunnel");
    let Ok(entries) = std::fs::read_dir(&parent) else {
        return Ok(());
    };
    let mut versions = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir()
            && entry.file_name().to_string_lossy().starts_with('v')
            && (entry.path().join("tunnel-client").is_file()
                || entry.path().join("tunnel-client.exe").is_file())
        {
            versions.push((
                entry.metadata().map_err(|e| e.to_string())?.modified().ok(),
                entry.path(),
            ));
        }
    }
    versions.sort_by_key(|v| v.0);
    if versions.len() <= 1 {
        return Ok(());
    }
    versions.pop();
    let mut configured = Vec::new();
    for id in load(&root().join("ingresses/index.json"))?
        .as_array()
        .ok_or("invalid ingress index")?
    {
        let entry = load(
            &root()
                .join("ingresses")
                .join(id.as_str().ok_or("invalid ingress id")?)
                .join("config.json"),
        )?;
        let binary = string(&entry["config"], "tunnelBinary");
        if !binary.is_empty() {
            let path = PathBuf::from(binary);
            configured.push(path.canonicalize().unwrap_or(path));
        }
    }
    for (_, path) in versions {
        let resolved = path.canonicalize().map_err(|e| e.to_string())?;
        if !configured.iter().any(|p| p.starts_with(&resolved)) {
            std::fs::remove_dir_all(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// /readyz is only a startup probe. A successful poll is the authentication proof.
fn control_plane_health(snapshot: &Value) -> Value {
    let details = &snapshot["details"];
    let status = details["http_status"].as_u64().unwrap_or(0);
    json!({"state": if matches!(status, 401 | 403) { "rejected" }
        else if details["last_success"].is_string() && snapshot["status"] == "ok" { "authenticated" }
        else { "unknown" }, "httpStatus":status,"failureCategory":details["failure_category"],"observedAt":snapshot["observed_at"]})
}
fn rejected_control_plane_log(entry: &Value) -> Option<u16> {
    // Older client versions still report explicit control-plane failures in logs.
    let detail = entry.get("error").or_else(|| entry.get("err"))?.as_str()?;
    if !detail.contains("controlplane client:") {
        return None;
    }
    [401, 403]
        .into_iter()
        .find(|status| detail.contains(&format!("unexpected status {status}")))
}

#[cfg(test)]
mod control_plane_tests {
    use super::*;
    #[test]
    fn authentication_requires_a_successful_poll_and_rejections_win() {
        assert_eq!(
            control_plane_health(&json!({"status":"ok","details":{}}))["state"],
            "unknown"
        );
        assert_eq!(
            control_plane_health(
                &json!({"status":"ok","details":{"last_success":"2026-10-17T00:00:00Z"}})
            )["state"],
            "authenticated"
        );
        for code in [401, 403] {
            assert_eq!(
                control_plane_health(
                    &json!({"status":"degraded","details":{"last_success":"earlier","http_status":code}})
                )["state"],
                "rejected"
            );
            assert_eq!(
                rejected_control_plane_log(
                    &json!({"msg":"poll failed", "error":format!("controlplane client: unexpected status {code}")})
                ),
                Some(code)
            );
        }
        assert_eq!(
            rejected_control_plane_log(&json!({"error":"MCP endpoint: unexpected status 401"})),
            None
        );
        assert_eq!(
            control_plane_health(
                &json!({"status":"degraded","details":{"last_success":"earlier","http_status":500}})
            )["state"],
            "unknown"
        );
    }
}
