//! User-owned public tunnels. Binaries, credentials and processes stay on this device.
use crate::*;
use std::{
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::process::Child;

pub struct Tunnel {
    child: Child,
    command: tokio::process::Command,
    unhealthy_since: Option<Instant>,
    stable_since: Option<Instant>,
    restart_attempts: u32,
    ever_ready: bool,
    pub health: Value,
    owner: std::sync::Weak<crate::ingress::Ingress>,
    pub health_error: String,
    reported_health: Option<String>,
    error_readers: Vec<tokio::task::JoinHandle<Option<String>>>,
    dir: PathBuf,
    health_url: String,
    provider: String,
    discovered: tokio::sync::watch::Receiver<Option<Result<Vec<String>>>>,
    pinggy: Option<PinggySession>,
    fixed: bool,
    cloudflare_named: bool,
    upstream: String,
    pub url: String,
    pub urls: Vec<String>,
    pub(crate) selected_url: String,
}
impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        if let Some(session) = self.pinggy.take() {
            // Cancellation also releases this foreground session. The daemon's orphan
            // timeout is the fallback if the runtime is already shutting down.
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    session.stop().await;
                });
            }
        }
        for reader in &self.error_readers {
            reader.abort();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
impl Tunnel {
    pub async fn stop(mut self) {
        if let Some(session) = self.pinggy.take() {
            session.stop().await;
        }
        let _ = self.child.kill().await;
    }
    pub async fn ready(&mut self) -> Result<bool> {
        self.health_error.clear();
        let mut result = self.probe_ready().await;
        if matches!(result, Ok(true)) {
            self.ever_ready = true;
            self.unhealthy_since = None;
            self.health["retryAfterSeconds"] = Value::Null;
            self.health["lastReadyAt"] = json!(now());
            if self.stable_since.get_or_insert_with(Instant::now).elapsed()
                >= Duration::from_secs(120)
            {
                self.restart_attempts = 0;
            }
        } else {
            self.stable_since = None;
            let elapsed = self
                .unhealthy_since
                .get_or_insert_with(Instant::now)
                .elapsed();
            let backoff = (60u64.saturating_mul(1u64 << self.restart_attempts.min(3))).min(300);
            if self.provider == "cloudflare" && self.ever_ready {
                if elapsed >= Duration::from_secs(backoff) {
                    let _ = self.child.kill().await;
                    for reader in self.error_readers.drain(..) {
                        reader.abort();
                    }
                    match self.command.spawn() {
                        Ok(mut child) => {
                            if let Some(stdout) = child.stdout.take() {
                                self.error_readers.push(tokio::spawn(cloudflare_output(
                                    stdout,
                                    self.owner.clone(),
                                )));
                            }
                            if let Some(stderr) = child.stderr.take() {
                                self.error_readers.push(tokio::spawn(cloudflare_output(
                                    stderr,
                                    self.owner.clone(),
                                )));
                            }
                            self.child = child;
                            self.restart_attempts += 1;
                            self.unhealthy_since = Some(Instant::now());
                            if let Some(owner) = self.owner.upgrade() {
                                owner.log("WARN","Cloudflare remained unavailable; restarting provider to refresh edge discovery").await;
                            }
                            self.health_error = "Cloudflare 正在恢复连接并重新解析边缘地址".into();
                        }
                        Err(error) => {
                            self.health_error = format!("Cloudflare 恢复失败：{error}");
                            self.unhealthy_since = Some(Instant::now());
                            self.restart_attempts += 1;
                        }
                    }
                }
                if let Err(error) = &result {
                    if self.health_error.is_empty() {
                        self.health_error = error.clone();
                    }
                }
                result = Ok(false);
            }
            self.health["retryAfterSeconds"] =
                json!(backoff.saturating_sub(self.unhealthy_since.unwrap().elapsed().as_secs()));
        }
        self.health["pid"] = json!(self.child.id());
        self.health["restartAttempts"] = json!(self.restart_attempts);
        self.health["state"] = json!(if matches!(result, Ok(true)) {
            "ready"
        } else if self.ever_ready {
            "degraded"
        } else {
            "starting"
        });
        self.health["observedAt"] = json!(now());
        let message = match &result {
            Ok(true) => String::new(),
            Ok(false) if !self.health_error.is_empty() => self.health_error.clone(),
            Ok(false) => format!("{} 隧道尚未就绪", self.provider),
            Err(error) => error.clone(),
        };
        self.health_error = message.clone();
        self.health["error"] = json!(message);
        self.health["code"] = json!(if matches!(result, Ok(true)) {
            "READY"
        } else if self.health["readyConnections"] == 0 {
            "EDGE_UNAVAILABLE"
        } else {
            "PROVIDER_UNAVAILABLE"
        });
        // An initial not-ready probe is expected while the provider starts.
        // After readiness, retain each degradation and recovery transition.
        if self.reported_health.as_ref() != Some(&message)
            && (!matches!(&result, Ok(false)) || self.reported_health.is_some())
        {
            self.reported_health = Some(message.clone());
            if let Some(owner) = self.owner.upgrade() {
                if message.is_empty() {
                    owner
                        .log("INFO", &format!("{} tunnel ready", self.provider))
                        .await;
                } else {
                    owner.log("WARN", &message).await;
                }
            }
        }
        result
    }
    async fn probe_ready(&mut self) -> Result<bool> {
        if self.child.try_wait().map_err(|e| e.to_string())?.is_some() {
            let mut code = None;
            for mut reader in self.error_readers.drain(..) {
                match tokio::time::timeout(Duration::from_secs(2), &mut reader).await {
                    Ok(Ok(Some(value))) => code = Some(value),
                    Err(_) => reader.abort(),
                    _ => {}
                }
            }
            if let Some(code) = code {
                if code == "ERR_NGROK_334" {
                    return Err("ngrok 固定域名已被其他连接占用，请关闭占用该域名的连接，或使用其他域名（ERR_NGROK_334）".into());
                }
                return Err(format!(
                    "ngrok 隧道启动失败（{code}），请查看 https://ngrok.com/docs/errors/{}",
                    code.to_lowercase()
                ));
            }
            return Err(format!(
                "{} 隧道进程已退出，请检查凭据、网络、账号并发会话和端点额度后重试",
                self.provider
            ));
        }
        if matches!(self.provider.as_str(), "pinggy" | "localxpose") {
            let Some(discovered) = self.discovered.borrow().clone() else {
                return Ok(false);
            };
            let urls = discovered?;
            let url = if self.fixed {
                urls.iter()
                    .find(|url| *url == &self.selected_url)
                    .ok_or_else(|| format!("{} 公网域名与配置不匹配", self.provider))?
            } else {
                urls.first().ok_or("未发现公网 HTTPS 地址")?
            }
            .clone();
            if !self.url.is_empty() && self.url != url {
                return Err(format!("{} 公网地址已变化，请重新连接", self.provider));
            }
            self.url = url;
            return Ok(true);
        }
        self.health["readyConnections"] = Value::Null;
        self.health["httpStatus"] = Value::Null;
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|e| e.to_string())?;
        let response = match client.get(&self.health_url).send().await {
            Ok(response) => response,
            Err(error) => {
                self.health_error = format!("{} 隧道健康检查失败：{error}", self.provider);
                return Ok(false);
            }
        };
        self.health["httpStatus"] = json!(response.status().as_u16());
        if !response.status().is_success() {
            self.health_error = format!(
                "{} 隧道未就绪（HTTP {}）",
                self.provider,
                response.status().as_u16()
            );
            if self.provider == "cloudflare" {
                if let Ok(value) = response.json::<Value>().await {
                    if let Some(count) = value["readyConnections"].as_u64() {
                        self.health["readyConnections"] = json!(count);
                        self.health_error
                            .push_str(&format!("，可用边缘连接数：{count}"));
                    }
                }
            }
            return Ok(false);
        }
        if self.provider == "cloudflare" {
            if let Ok(value) = response.json::<Value>().await {
                self.health["readyConnections"] = value["readyConnections"].clone();
            }
            if self.cloudflare_named {
                self.url = self.selected_url.clone();
                return Ok(true);
            }
            let Ok(response) = client
                .get(self.health_url.replace("/ready", "/quicktunnel"))
                .send()
                .await
            else {
                return Ok(false);
            };
            let Ok(value) = response.json::<Value>().await else {
                return Ok(false);
            };
            let hostname = string(&value, "hostname");
            let address = if hostname.starts_with("https://") {
                hostname.to_owned()
            } else {
                format!("https://{hostname}")
            };
            let Some(url) = public_url(&address, true) else {
                return Ok(false);
            };
            if self.url.is_empty() {
                self.url = url.clone();
            }
            return Ok(self.url == url);
        }
        let Ok(value) = response.json::<Value>().await else {
            return Ok(false);
        };
        for endpoint in value["endpoints"].as_array().into_iter().flatten() {
            if string(&endpoint["upstream"], "url").trim_end_matches('/') != self.upstream {
                continue;
            }
            if let Some(url) = public_url(string(endpoint, "url"), false) {
                // A different endpoint requires a fresh connection and ChatGPT configuration.
                if self.url.is_empty() {
                    self.url = url.clone();
                }
                return Ok(self.url == url);
            }
        }
        Ok(false)
    }
}
fn public_url(text: &str, cloudflare: bool) -> Option<String> {
    let u = reqwest::Url::parse(text).ok()?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
    {
        return None;
    }
    if cloudflare && !u.host_str()?.ends_with(".trycloudflare.com") {
        return None;
    }
    Some(format!("{}/mcp", u.origin().ascii_serialization()))
}
pub async fn start(
    owner: &Arc<crate::ingress::Ingress>,
    settings: &Value,
    upstream: &str,
    proxy: &crate::proxy::NetworkProxy,
) -> Result<Tunnel> {
    let provider = string(settings, "httpsProvider");
    let binary = install(provider, proxy).await?;
    let dir = root().join("runs").join(id());
    private_dir(&dir)?;
    let result = spawn(owner, settings, upstream, proxy, &binary, &dir).await;
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    result
}
async fn spawn(
    owner: &Arc<crate::ingress::Ingress>,
    settings: &Value,
    upstream: &str,
    proxy: &crate::proxy::NetworkProxy,
    binary: &Path,
    dir: &Path,
) -> Result<Tunnel> {
    let provider = string(settings, "httpsProvider");
    // Reserve an isolated loopback admin/metrics port; never use the user's existing agent API.
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let admin = reservation
        .local_addr()
        .map_err(|e| e.to_string())?
        .to_string();
    let config = dir.join("config.yml");
    let mut cmd = command(binary);
    for (name, _) in std::env::vars() {
        if name.starts_with("TUNNEL_")
            || name.starts_with("CLOUDFLARED_")
            || name.starts_with("NGROK_")
            || name.starts_with("PINGGY_")
            || name.starts_with("LX_")
            || name == "ACCESS_TOKEN"
        {
            cmd.env_remove(name);
        }
    }
    proxy.apply(&mut cmd);
    let cloudflare_named = provider == "cloudflare" && settings["cloudflareMode"] == "named";
    let health;
    let mut pinggy = None;
    match provider {
        "cloudflare" => {
            save(&config, &json!({}))?;
            cmd.args(["tunnel", "--config"]).arg(&config).args([
                "--no-autoupdate",
                "--protocol",
                "http2",
                "--metrics",
                &admin,
            ]);
            if cloudflare_named && settings["cloudflareAuth"] == "login" {
                let tunnel = string(settings, "cloudflareTunnelId");
                let hostname =
                    reqwest::Url::parse(string(settings, "httpsUrl")).map_err(|e| e.to_string())?;
                save(
                    &config,
                    &json!({"tunnel":tunnel,
                    "credentials-file":crate::cloudflare::credentials(tunnel),
                    "ingress":[{"hostname":hostname.host_str(),"service":upstream},{"service":"http_status:404"}]}),
                )?;
                cmd.arg("run").arg(tunnel);
            } else if cloudflare_named {
                let token_file = dir.join("tunnel-token");
                crate::service::write_secret(&token_file, string(settings, "cloudflareToken"))?;
                cmd.args(["run", "--token-file"]).arg(token_file);
            } else {
                cmd.args(["--url", upstream]);
            }
            health = format!("http://{admin}/ready");
        }
        "ngrok" => {
            let mut agent = json!({"authtoken":settings["ngrokAuthtoken"],"web_addr":admin,
            "console_ui":false,"inspect_db_size":-1,"log_format":"json","log":"stdout","update_check":false,"remote_management":false});
            if let Some(url) = proxy.tunnel_proxy_url() {
                agent["proxy_url"] = json!(url);
            }
            save(&config, &json!({"version":"3","agent":agent}))?;
            // Request inspection is disabled through the agent configuration above.
            cmd.args(["http", upstream, "--config"]).arg(&config);
            if settings["ngrokMode"] == "named" {
                let endpoint = ngrok_endpoint(string(settings, "ngrokEndpoint"))?;
                cmd.args(["--url", &endpoint]);
            }
            // Temporary mode never reuses a discovered URL as a requested hostname.
            health = format!("http://{admin}/api/endpoints");
        }
        "pinggy" => {
            let state_dir = root().join("dependencies/pinggy/state");
            private_dir(&state_dir)?;
            let session = PinggySession {
                binary: binary.into(),
                config_id: id(),
                state_dir,
            };
            session.environment(&mut cmd);
            let config = dir.join("pinggy.json");
            let named = settings["pinggyMode"] == "named";
            let value = json!({"version":"1.0","configId":session.config_id,
            "token":if named {string(settings, "pinggyToken")} else {""},
            "serverAddress":if named {"pro.pinggy.io"} else {"free.pinggy.io"},
            "forwarding":[{"type":"http","address":upstream.trim_start_matches("http://")}],
            "autoReconnect":false,"optional":{"noTui":true}});
            crate::service::write_secret(&config, &value.to_string())?;
            cmd.arg("--conf").arg(config);
            pinggy = Some(session);
            health = String::new();
        }
        "localxpose" => {
            cmd.env("LX_ACCESS_TOKEN", string(settings, "localxposeAccessToken"));
            cmd.args([
                "tunnel",
                "--raw-mode",
                "http",
                "--to",
                upstream.trim_start_matches("http://"),
            ]);
            if settings["localxposeMode"] == "named" {
                let url = reqwest::Url::parse(string(settings, "httpsUrl"))
                    .map_err(|_| "LocalXpose 固定域名无效")?;
                cmd.args([
                    "--reserved-domain",
                    url.host_str().ok_or("LocalXpose 固定域名无效")?,
                ]);
            } else {
                cmd.args(["--region", string(settings, "localxposeRegion")]);
            }
            health = String::new();
        }
        _ => return Err("HTTPS 服务商无效".into()),
    }
    // Provider diagnostics are consumed continuously; Cloudflare uses the ingress redaction path.
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    drop(reservation);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 {provider}: {e}"))?;
    let mut error_readers = Vec::new();
    let (discovery, discovered) = tokio::sync::watch::channel(None);
    if let Some(stdout) = child.stdout.take() {
        error_readers.push(if provider == "cloudflare" {
            tokio::spawn(cloudflare_output(stdout, Arc::downgrade(owner)))
        } else if provider == "ngrok" {
            tokio::spawn(ngrok_error_code(stdout))
        } else {
            tokio::spawn(discover_output(
                stdout,
                provider.to_owned(),
                discovery.clone(),
            ))
        });
    }
    if let Some(stderr) = child.stderr.take() {
        error_readers.push(if provider == "cloudflare" {
            tokio::spawn(cloudflare_output(stderr, Arc::downgrade(owner)))
        } else if provider == "ngrok" {
            tokio::spawn(ngrok_error_code(stderr))
        } else {
            tokio::spawn(discover_output(stderr, provider.to_owned(), discovery))
        });
    }
    let mut tunnel = Tunnel {
        child,
        command: cmd,
        unhealthy_since: None,
        stable_since: None,
        restart_attempts: 0,
        ever_ready: false,
        health: json!({}),
        owner: Arc::downgrade(owner),
        health_error: String::new(),
        reported_health: None,
        error_readers,
        dir: dir.into(),
        health_url: health,
        provider: provider.into(),
        discovered,
        pinggy,
        fixed: (provider == "pinggy" && settings["pinggyMode"] == "named")
            || (provider == "localxpose" && settings["localxposeMode"] == "named"),
        cloudflare_named,
        upstream: upstream.into(),
        url: String::new(),
        urls: Vec::new(),
        selected_url: string(settings, "httpsUrl").to_owned(),
    };
    let deadline = Instant::now() + Duration::from_secs(90);
    let result = loop {
        match tunnel.ready().await {
            Ok(true) => break Ok(()),
            Err(error) => break Err(error),
            Ok(false) => {}
        }
        if Instant::now() >= deadline {
            break Err(format!(
                "{provider} 连接超时，请检查网络{}",
                match provider {
                    "cloudflare" => "；Cloudflare 需允许出站连接到 7844 端口",
                    "ngrok" => "、Authtoken 和账号的隧道额度",
                    _ => "",
                }
            ));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    };
    if let Err(error) = result {
        tunnel.stop().await;
        return Err(error);
    }
    Ok(tunnel)
}

struct PinggySession {
    binary: PathBuf,
    config_id: String,
    state_dir: PathBuf,
}
impl PinggySession {
    fn environment(&self, cmd: &mut tokio::process::Command) {
        // CLI and stop must address the same Agent Remote Control-owned daemon, never a user's daemon.
        cmd.env("XDG_CONFIG_HOME", &self.state_dir)
            .env("APPDATA", &self.state_dir)
            .env("LOCALAPPDATA", &self.state_dir)
            .env("PINGGY_LOG_LEVEL", "error")
            .env("NO_COLOR", "1");
    }
    async fn stop(self) {
        let mut cmd = command(&self.binary);
        self.environment(&mut cmd);
        cmd.args(["stop", &self.config_id])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = tokio::time::timeout(Duration::from_secs(8), cmd.status()).await;
    }
}

async fn discover_output(
    mut stream: impl tokio::io::AsyncRead + Unpin,
    provider: String,
    sender: tokio::sync::watch::Sender<Option<Result<Vec<String>>>>,
) -> Option<String> {
    use tokio::io::AsyncReadExt;
    let ansi = regex::Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").unwrap();
    let https = regex::Regex::new(r#"https://[^\s<>"']+"#).unwrap();
    let localxpose =
        regex::Regex::new(r"(?:^|\s)([A-Za-z0-9][A-Za-z0-9.-]*)\s*=>\s*\[running\]").unwrap();
    let mut buffer = [0; 4096];
    let mut line = Vec::new();
    let mut remote_urls = None::<Vec<String>>;
    while let Ok(count) = stream.read(&mut buffer).await {
        if count == 0 {
            break;
        }
        for byte in &buffer[..count] {
            if matches!(*byte, b'\n' | b'\r') {
                let text = String::from_utf8_lossy(&line);
                let text = ansi.replace_all(&text, "");
                if provider == "pinggy" {
                    let text = text.trim();
                    if text == "Remote URLs:" {
                        remote_urls = Some(Vec::new());
                    } else if let Some(urls) = remote_urls.as_mut() {
                        if text.starts_with("https://") {
                            if let Some(url) =
                                https.find(text).and_then(|m| public_url(m.as_str(), false))
                            {
                                if urls.len() < 16 && !urls.contains(&url) {
                                    urls.push(url);
                                }
                            }
                        } else if text.starts_with('─') {
                            if !urls.is_empty() {
                                sender.send_replace(Some(Ok(urls.clone())));
                            }
                            remote_urls = None;
                        }
                    }
                } else if let Some(url) = localxpose
                    .captures(&text)
                    .and_then(|c| public_url(&format!("https://{}", &c[1]), false))
                {
                    sender.send_replace(Some(Ok(vec![url])));
                }
                if provider == "pinggy"
                    && (text.contains("Disconnected:") || text.contains("Tunnel stopped."))
                {
                    sender.send_replace(Some(Err("Pinggy 隧道已断开，请重新连接".into())));
                }
                line.clear();
            } else if line.len() < 16384 {
                line.push(*byte);
            }
        }
    }
    None
}

pub(crate) async fn install(provider: &str, proxy: &crate::proxy::NetworkProxy) -> Result<PathBuf> {
    static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = INSTALL.lock().await;
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
    } else if cfg!(target_arch = "x86_64") {
        "amd64"
    } else {
        return Err("不支持此 CPU 架构".into());
    };
    let name = match provider {
        "cloudflare" => "cloudflared",
        "ngrok" => "ngrok",
        "pinggy" => "pinggy",
        "localxpose" => "loclx",
        _ => return Err("HTTPS 服务商无效".into()),
    };
    let executable = format!("{name}{}", if cfg!(windows) { ".exe" } else { "" });
    let dir = root()
        .join("dependencies")
        .join(provider)
        .join(format!("{platform}-{arch}"));
    private_dir(&dir)?;
    let binary = dir.join(&executable);
    let manifest = dir.join("installed.json");
    if let (Ok(bytes), Ok(meta)) = (std::fs::read(&binary), load(&manifest)) {
        if meta["sha256"] == hash(bytes) {
            return Ok(binary);
        }
    }
    let client = proxy
        .client(reqwest::Client::builder())
        .user_agent("agent-remote-control")
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let (url, digest, extension) = match provider {
        "cloudflare" | "pinggy" => {
            let (repo, version, asset_name, extension) = if provider == "cloudflare" {
                let extension = if cfg!(windows) {
                    "exe"
                } else if cfg!(target_os = "linux") {
                    "binary"
                } else {
                    "tgz"
                };
                (
                    "cloudflare/cloudflared",
                    "latest",
                    if extension == "binary" {
                        format!("cloudflared-{platform}-{arch}")
                    } else {
                        format!("cloudflared-{platform}-{arch}.{extension}")
                    },
                    extension,
                )
            } else {
                let os = if cfg!(windows) {
                    "win"
                } else if cfg!(target_os = "linux") {
                    "linux"
                } else {
                    "macos"
                };
                let cpu = if arch == "amd64" { "x64" } else { "arm64" };
                (
                    "Pinggy-io/cli-js",
                    "tags/v0.5.8",
                    format!(
                        "pinggy-{os}-{cpu}{}",
                        if cfg!(windows) { ".exe" } else { "" }
                    ),
                    "binary",
                )
            };
            let release: Value = client
                .get(format!(
                    "https://api.github.com/repos/{repo}/releases/{version}"
                ))
                .send()
                .await
                .map_err(|e| e.to_string())?
                .error_for_status()
                .map_err(|e| e.to_string())?
                .json()
                .await
                .map_err(|e| e.to_string())?;
            let asset = release["assets"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|a| a["name"] == asset_name)
                .ok_or_else(|| format!("{provider} 未提供此平台的下载"))?;
            let url = string(asset, "browser_download_url");
            if !url.starts_with(&format!("https://github.com/{repo}/releases/download/")) {
                return Err(format!("无效的 {provider} 下载地址"));
            }
            let digest = string(asset, "digest")
                .strip_prefix("sha256:")
                .ok_or_else(|| format!("{provider} 官方校验和缺失"))?;
            (url.to_owned(), Some(digest.to_owned()), extension)
        }
        "ngrok" => {
            let extension = if cfg!(target_os = "linux") {
                "tgz"
            } else {
                "zip"
            };
            (format!("https://bin.ngrok.com/c/bNyj1mQVY4c/ngrok-v3-stable-{platform}-{arch}.{extension}"), None, extension)
        }
        "localxpose" => {
            if cfg!(windows) && arch != "amd64" {
                return Err("LocalXpose 未提供此平台的下载".into());
            }
            (
                format!("https://api.localxpose.io/api/v2/downloads/loclx-{platform}-{arch}.zip"),
                None,
                "zip",
            )
        }
        _ => return Err("HTTPS 服务商无效".into()),
    };
    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 128 * 1024 * 1024 {
            return Err("隧道组件下载过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if digest.is_some_and(|digest| hash(&bytes) != digest) {
        return Err(format!("{provider} 隧道组件 SHA256 校验失败"));
    }
    let staging = dir.join(id());
    private_dir(&staging)?;
    let result = async {
        let archive = staging.join(format!("download.{extension}"));
        std::fs::write(&archive, &bytes).map_err(|e| e.to_string())?;
        let extracted = staging.join(&executable);
        if matches!(extension, "exe" | "binary") {
            std::fs::rename(&archive, &extracted).map_err(|e| e.to_string())?;
        } else if cfg!(target_os = "linux") && extension == "zip" {
            output(
                "unzip",
                &[
                    "-o",
                    archive.to_str().ok_or("invalid path")?,
                    &executable,
                    "-d",
                    staging.to_str().ok_or("invalid path")?,
                ],
            )
            .await?;
        } else {
            // Extract only the expected executable from the official archive.
            output(
                if cfg!(windows) {
                    "tar.exe"
                } else {
                    "/usr/bin/tar"
                },
                &[
                    "-xf",
                    archive.to_str().ok_or("invalid path")?,
                    "-C",
                    staging.to_str().ok_or("invalid path")?,
                    &executable,
                ],
            )
            .await?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&extracted, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let digest = hash(std::fs::read(&extracted).map_err(|e| e.to_string())?);
        if binary.exists() {
            std::fs::remove_file(&binary).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&extracted, &binary).map_err(|e| e.to_string())?;
        save(&manifest, &json!({"sha256":digest}))?;
        Ok(binary)
    }
    .await;
    let _ = std::fs::remove_dir_all(staging);
    result
}

// Accept a user-owned hostname or HTTPS origin, never an MCP path or credentials.
pub(crate) fn ngrok_endpoint(endpoint: &str) -> Result<String> {
    let endpoint = endpoint.trim();
    if endpoint.is_empty() {
        return Err("请填写 ngrok 固定域名".into());
    }
    let address = if endpoint.contains("://") {
        endpoint.to_owned()
    } else {
        format!("https://{endpoint}")
    };
    let url = reqwest::Url::parse(&address)
        .map_err(|_| "ngrok 固定域名无效，请填写域名或 HTTPS 地址（不含路径）")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || endpoint.contains('*')
        || endpoint.chars().any(char::is_whitespace)
    {
        return Err("ngrok 固定域名无效，请填写域名或 HTTPS 地址（不含路径）".into());
    }
    Ok(url.origin().ascii_serialization())
}

async fn ngrok_error_code(mut stream: impl tokio::io::AsyncRead + Unpin) -> Option<String> {
    use tokio::io::AsyncReadExt;
    let mut buffer = [0u8; 4096];
    let mut tail = Vec::new();
    let mut code = None;
    while let Ok(count) = stream.read(&mut buffer).await {
        if count == 0 {
            break;
        }
        tail.extend_from_slice(&buffer[..count]);
        let prefix = b"ERR_NGROK_";
        for (index, window) in tail.windows(prefix.len()).enumerate() {
            if window == prefix {
                let digits: Vec<u8> = tail[index + prefix.len()..]
                    .iter()
                    .copied()
                    .take_while(u8::is_ascii_digit)
                    .take(12)
                    .collect();
                if !digits.is_empty() {
                    code = Some(format!("ERR_NGROK_{}", String::from_utf8_lossy(&digits)));
                }
            }
        }
        if tail.len() > 64 {
            tail.drain(..tail.len() - 64);
        }
    }
    code
}

async fn cloudflare_output(
    stream: impl tokio::io::AsyncRead + Unpin,
    owner: std::sync::Weak<crate::ingress::Ingress>,
) -> Option<String> {
    let mut reader = tokio::io::BufReader::new(stream);
    while let Ok(bytes) = crate::line(&mut reader, 64 * 1024).await {
        if bytes.is_empty() {
            break;
        }
        let Some(owner) = owner.upgrade() else {
            break;
        };
        let text = String::from_utf8_lossy(&bytes);
        let level = if text.contains(" ERR ") {
            "ERROR"
        } else if text.contains(" WRN ") {
            "WARN"
        } else if text.contains(" DBG ") {
            "DEBUG"
        } else {
            "INFO"
        };
        owner
            .log(level, &format!("cloudflare: {}", text.trim()))
            .await;
    }
    None
}
