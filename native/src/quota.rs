//! Current native quota readings. No persisted readings or display settings.
use crate::{agents::AgentHost, control::Control, *};
use std::time::Duration;

pub struct QuotaService {
    control: Arc<Control>,
    agents: Arc<AgentHost>,
    changed: tokio::sync::watch::Sender<Value>,
    job: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}
impl QuotaService {
    pub fn new(control: Arc<Control>, agents: Arc<AgentHost>) -> Arc<Self> {
        Arc::new(Self {
            control,
            agents,
            changed: tokio::sync::watch::channel(json!({})).0,
            job: Default::default(),
        })
    }
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<Value> {
        self.changed.subscribe()
    }
    pub fn snapshot(&self) -> Value {
        self.changed.borrow().clone()
    }
    pub fn start(self: &Arc<Self>) {
        let service = self.clone();
        *self.job.lock().unwrap() = Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(300));
            loop {
                interval.tick().await;
                let inventory = service.agents.ui_inventory(false).await;
                let enabled = |id: &str| {
                    inventory["agents"].as_array().is_some_and(|rows| {
                        rows.iter().any(|a| {
                            a["agent"] == id && a["enabled"] == true && a["installed"] == true
                        })
                    })
                };
                let (codex, claude) = tokio::join!(
                    async {
                        if enabled("codex") {
                            service
                                .control
                                .account_rate_limits()
                                .await
                                .ok()
                                .and_then(|v| codex_quota(&v))
                        } else {
                            None
                        }
                    },
                    async {
                        if enabled("claude") {
                            claude_quota().await.ok().flatten()
                        } else {
                            None
                        }
                    }
                );
                service
                    .changed
                    .send_replace(json!({"codex":codex,"claude":claude}));
            }
        }));
    }
    pub async fn stop(&self) {
        let job = self.job.lock().unwrap().take();
        if let Some(job) = job {
            job.abort();
            let _ = job.await;
        }
    }
}
fn reading(used: f64, reset: Value) -> Value {
    json!({"remaining":(100.0-used).clamp(0.0,100.0),"resetsAt":reset})
}
fn codex_quota(v: &Value) -> Option<Value> {
    let group = v["rateLimitsByLimitId"]["codex"]
        .as_object()
        .map(|_| &v["rateLimitsByLimitId"]["codex"])
        .or_else(|| v["rateLimits"].as_object().map(|_| &v["rateLimits"]))
        .or_else(|| v["rateLimitsByLimitId"].as_object()?.values().next())?;
    let q = [&group["primary"], &group["secondary"]]
        .into_iter()
        .filter(|q| q["usedPercent"].as_f64().is_some())
        .max_by(|a, b| {
            a["usedPercent"]
                .as_f64()
                .unwrap()
                .total_cmp(&b["usedPercent"].as_f64().unwrap())
        })?;
    let reset = q["resetsAt"]
        .as_i64()
        .and_then(|n| chrono::DateTime::from_timestamp(n, 0))
        .map(|d| d.to_rfc3339());
    Some(reading(q["usedPercent"].as_f64()?, json!(reset)))
}
async fn claude_quota() -> Result<Option<Value>> {
    let path = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".claude"))
        .join(".credentials.json");
    #[cfg(target_os = "macos")]
    let credentials: Value = {
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            command("/usr/bin/security")
                .args([
                    "find-generic-password",
                    "-s",
                    "Claude Code-credentials",
                    "-w",
                ])
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        if result.status.success() {
            serde_json::from_slice(&result.stdout).map_err(|e| e.to_string())?
        } else if result.status.code() == Some(44) {
            load(&path)?
        } else {
            return Err("credential-access-denied".into());
        }
    };
    #[cfg(not(target_os = "macos"))]
    let credentials = load(&path)?;
    let settings = load(&root().join("web/preferences.json"))
        .unwrap_or(json!({"proxyMode":"system","proxyUrl":""}));
    let proxy = crate::proxy::NetworkProxy::resolve(&settings).await?;
    let client = proxy
        .client(
            reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none()),
        )
        .build()
        .map_err(|e| e.to_string())?;
    let version = tokio::time::timeout(
        Duration::from_secs(5),
        command("claude")
            .arg("--version")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()
    .and_then(|r| r.ok())
    .filter(|r| r.status.success())
    .and_then(|r| String::from_utf8(r.stdout).ok())
    .and_then(|s| s.split_whitespace().next().map(str::to_owned));
    let mut request = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .query(&[("cedar_ember", "1")])
        .bearer_auth(
            credentials["claudeAiOauth"]["accessToken"]
                .as_str()
                .unwrap_or(""),
        )
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("x-app", "cli");
    if let Some(version) = version {
        request = request.header(
            "User-Agent",
            format!("claude-cli/{version} (external, cli) agent-remote-control"),
        );
    }
    let v: Value = request
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(limits) = v["limits"].as_array() {
        if let Some(q) = limits
            .iter()
            .filter(|q| {
                (q["kind"] == "weekly_all" || q["kind"] == "session") && q["percent"].is_number()
            })
            .max_by(|a, b| {
                a["percent"]
                    .as_f64()
                    .unwrap()
                    .total_cmp(&b["percent"].as_f64().unwrap())
            })
        {
            return Ok(q["percent"]
                .as_f64()
                .map(|used| reading(used, q["resets_at"].clone())));
        }
    }
    Ok([&v["five_hour"], &v["seven_day"]]
        .into_iter()
        .filter_map(|q| q["utilization"].as_f64().map(|used| (used, q)))
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(used, q)| reading(used, q["resets_at"].clone())))
}
