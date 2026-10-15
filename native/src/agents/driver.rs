use super::{process::Process, *};

pub use super::manifest::Manifest;
#[derive(Clone)]
pub enum AgentDriver {
    CodexNative,
    Pi,
    Acp(Manifest),
}
impl AgentDriver {
    pub fn protocol(&self) -> &str {
        match self {
            Self::CodexNative => "codex-native",
            Self::Pi => "pi-rpc",
            Self::Acp(_) => "acp-v1",
        }
    }
    pub fn binary(&self) -> Option<PathBuf> {
        match self {
            Self::CodexNative => super::codex_binary(),
            Self::Pi => discover("pi"),
            Self::Acp(m) if m.id == "claude" => discover("claude"),
            Self::Acp(m) => m.candidates().into_iter().next(),
        }
    }
    pub fn descriptor(&self) -> Value {
        match self {
            Self::Acp(m) => serde_json::to_value(m).unwrap(),
            Self::CodexNative => json!({"displayName":"Codex","integration":"native"}),
            Self::Pi => json!({"displayName":"Pi","integration":"native"}),
        }
    }
    /// Verify launch conditions without starting ACP, logging in, or fetching packages.
    pub async fn discover(&self) -> (Option<PathBuf>, Option<String>, Option<String>) {
        if matches!(self, Self::Acp(m) if m.id == "claude") {
            return super::adapter::discover().await;
        }
        let candidates = match self {
            Self::Acp(m) => m.candidates(),
            _ => self.binary().into_iter().collect(),
        };
        let mut observed = (None, None, Some("AGENT_NOT_INSTALLED".into()));
        for binary in candidates {
            let version_args = match self {
                Self::Acp(m) => m.version_args.clone(),
                _ => vec!["--version".into()],
            };
            let version = if version_args.is_empty() {
                Ok(String::new()) // Explicitly disabled for custom launchers without a version flag.
            } else {
                process::probe(&binary, &version_args).await
            };
            let mut error = version.as_ref().err().cloned();
            if error.is_none() {
                if let Self::Acp(m) = self {
                    if !m.compatibility.help_args.is_empty() {
                        match process::probe(&binary, &m.compatibility.help_args).await {
                            Ok(help)
                                if !m
                                    .compatibility
                                    .identity_contains
                                    .iter()
                                    .all(|text| help.contains(text)) =>
                            {
                                if observed.0.is_none() {
                                    observed.2 = Some("AGENT_IDENTITY_MISMATCH".into());
                                }
                                continue;
                            }
                            Ok(help)
                                if m.compatibility
                                    .help_contains
                                    .iter()
                                    .all(|text| help.contains(text)) => {}
                            Ok(_) => error = Some("ACP_ENTRY_OR_IDENTITY_UNSUPPORTED".into()),
                            Err(e) => error = Some(e),
                        }
                    }
                }
            }
            let result = (Some(binary), version.ok().filter(|v| !v.is_empty()), error);
            if result.2.is_none() {
                return result;
            }
            if observed.0.is_none() {
                observed = result;
            }
        }
        observed
    }
    pub async fn start(
        &self,
        task: Value,
        resume: bool,
        wake: Arc<tokio::sync::Notify>,
    ) -> Result<Arc<Process>> {
        let (binary, _, error) = self.discover().await;
        let binary = binary
            .filter(|_| error.is_none())
            .ok_or_else(|| error.unwrap_or_else(|| "AGENT_NOT_INSTALLED".into()))?;
        let cwd = PathBuf::from(string(&task, "cwd"));
        let args = match self {
            Self::Pi => {
                let mut args = vec![
                    "--mode".into(),
                    "rpc".into(),
                    "--session-dir".into(),
                    root()
                        .join("agents/pi-sessions")
                        .to_string_lossy()
                        .into_owned(),
                ];
                if resume {
                    let path = string(&task["metadata"], "sessionFile");
                    if path.is_empty() {
                        return Err("SESSION_NOT_PERSISTED".into());
                    }
                    args.extend(["--session".into(), path.into()]);
                }
                args
            }
            Self::Acp(m) => m.args.clone(),
            Self::CodexNative => return Err("USE_NATIVE_CONTROL".into()),
        };
        let (binary, args) = if matches!(self, Self::Acp(m) if m.id == "claude") {
            super::adapter::launch()?
        } else {
            (binary, args)
        };
        let p = Process::start(&binary, &args, &cwd, matches!(self, Self::Pi), task, wake).await?;
        let init=async {
            if p.pi {
                let state=p.call("get_state",json!({}),15000).await?;
                *p.capabilities.lock().await=json!({"protocol":"pi-rpc","resume":true,"cancel":true,"streaming":true,"permissions":"extension-ui-only","completionEvent":"agent_settled"});
                let mut t=p.state.lock().await;t["sessionId"]=state["sessionId"].clone();t["metadata"]=state;
            } else {
                let init=p.call("initialize",json!({"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"local-connector","version":env!("CLC_BUILD_VERSION")}}),15000).await?;
                if init["protocolVersion"]!=1 {return Err("ACP_VERSION_UNSUPPORTED".into());}
                *p.capabilities.lock().await=init.clone();
                let t=p.state.lock().await.clone();
                if resume && init["agentCapabilities"]["loadSession"]!=true {return Err("RESUME_UNSUPPORTED".into());}
                let mut params=json!({"cwd":cwd,"mcpServers":[]});
                if resume {params["sessionId"]=t["sessionId"].clone();}
                let result=p.call(if resume {"session/load"}else{"session/new"},params,60000).await?;
                p.capabilities.lock().await["session"]=result.clone();
                let mut t=p.state.lock().await;
                if !resume {if string(&result,"sessionId").is_empty(){return Err("MISSING_SESSION_ID".into());}t["sessionId"]=result["sessionId"].clone();}
                t["metadata"]=result;
            }
            let mut t=p.state.lock().await;t["status"]=json!("idle");t["processState"]=json!("running");save_task(&t)?;
            p.events.lock().await.wake.notify_waiters();
            Ok(())
        }.await;
        if let Err(e) = init {
            p.close().await;
            return Err(e);
        }
        Ok(p)
    }
    pub async fn prompt(&self, p: &Arc<Process>, text: &str) -> Result<Value> {
        {
            let mut t = p.state.lock().await;
            if !matches!(
                string(&t, "status"),
                "idle" | "completed" | "cancelled" | "failed"
            ) {
                return Err("TASK_BUSY_OR_UNCONFIRMED".into());
            }
            t["status"] = json!("running");
            t["turnId"] = json!(id());
            t["output"] = json!("");
            t["lastMessage"] = Value::Null;
            t["error"] = Value::Null;
            t["stopReason"] = Value::Null;
            t["outputTruncated"] = json!(false);
            save_task(&t)?;
            p.events.lock().await.wake.notify_waiters();
        }
        let sid = p.state.lock().await["sessionId"].clone();
        let result = if p.pi {
            p.call("prompt", json!({"message":text}), 30000).await
        } else {
            p.call(
                "session/prompt",
                json!({"sessionId":sid,"prompt":[{"type":"text","text":text}]}),
                86400000,
            )
            .await
        };
        let mut t = p.state.lock().await;
        match &result {
            Ok(v) if !p.pi => {
                t["status"] = json!(if v["stopReason"] == "cancelled" {
                    "cancelled"
                } else {
                    "completed"
                });
                t["stopReason"] = v["stopReason"].clone();
            }
            Err(e) => {
                t["status"] = json!(
                    if crate::kernel::receipts::failure_state(e) == "unconfirmed" {
                        "unknown"
                    } else {
                        "failed"
                    }
                );
                t["error"] = json!(e);
            }
            _ => {}
        }
        t["updatedAt"] = json!(now());
        save_task(&t)?;
        p.events.lock().await.wake.notify_waiters();
        result.map(|_| t.clone())
    }
    pub async fn interrupt(&self, p: &Arc<Process>) -> Result<Value> {
        let requests = p
            .events
            .lock()
            .await
            .pending
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for request in requests {
            self.respond(p, &json!({"interactionId":request["id"],"cancelled":true}))
                .await?;
        }
        if p.pi {
            p.call("abort", json!({}), 30000).await?;
        } else {
            let sid = p.state.lock().await["sessionId"].clone();
            p.write(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":sid}}))
                .await
                .map_err(|e| format!("SUBMISSION_UNCONFIRMED: {e}"))?;
        }
        let mut t = p.state.lock().await;
        if !matches!(
            string(&t, "status"),
            "idle" | "completed" | "cancelled" | "failed"
        ) {
            t["status"] = json!(if p.pi { "cancelled" } else { "cancelling" });
        }
        save_task(&t)?;
        p.events.lock().await.wake.notify_waiters();
        Ok(t.clone())
    }
    pub async fn respond(&self, p: &Arc<Process>, a: &Value) -> Result<Value> {
        let key = a["interactionId"].to_string();
        let mut pending = p.events.lock().await;
        let req = pending.pending.get(&key).ok_or("INTERACTION_NOT_PENDING")?;
        let response = if p.pi {
            let mut v = json!({"type":"extension_ui_response","id":req["id"]});
            if a["cancelled"] == true {
                v["cancelled"] = json!(true);
            } else {
                match string(req, "method") {
                    "confirm" => {
                        if !a["confirmed"].is_boolean() {
                            return Err("CONFIRMATION_REQUIRED".into());
                        }
                        v["confirmed"] = a["confirmed"].clone();
                    }
                    _ => {
                        if !a["value"].is_string() {
                            return Err("VALUE_REQUIRED".into());
                        }
                        if req["method"] == "select"
                            && !req["options"]
                                .as_array()
                                .is_some_and(|o| o.contains(&a["value"]))
                        {
                            return Err("INVALID_OPTION".into());
                        }
                        v["value"] = a["value"].clone();
                    }
                }
            }
            v
        } else {
            let outcome = if a["cancelled"] == true {
                json!({"outcome":"cancelled"})
            } else {
                if !req["params"]["options"]
                    .as_array()
                    .is_some_and(|v| v.iter().any(|o| o["optionId"] == a["optionId"]))
                {
                    return Err("INVALID_OPTION".into());
                }
                json!({"outcome":"selected","optionId":a["optionId"]})
            };
            json!({"jsonrpc":"2.0","id":req["id"],"result":{"outcome":outcome}})
        };
        p.write(response)
            .await
            .map_err(|e| format!("SUBMISSION_UNCONFIRMED: {e}"))?;
        pending.pending.remove(&key);
        let empty = pending.pending.is_empty();
        drop(pending);
        let mut t = p.state.lock().await;
        if empty && t["status"] == "waiting-permission" {
            t["status"] = json!("running");
        }
        save_task(&t)?;
        p.events.lock().await.wake.notify_waiters();
        Ok(json!({"responded":true}))
    }
}
/// GUI launches often have a minimal PATH. Known user-owned CLI directories are also searched.
pub(super) fn search_paths() -> Vec<PathBuf> {
    let mut paths =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect::<Vec<_>>();
    if let Some(home) = dirs::home_dir() {
        paths.extend([
            home.join(".local/bin"),
            home.join(".opencode/bin"),
            home.join(".bun/bin"),
            home.join(".npm-global/bin"),
            home.join(".npm/bin"),
            home.join(".volta/bin"),
            home.join(".asdf/shims"),
        ]);
    }
    for key in [
        "NPM_CONFIG_PREFIX",
        "npm_config_prefix",
        "BUN_INSTALL",
        "VOLTA_HOME",
    ] {
        if let Some(prefix) = std::env::var_os(key) {
            paths.push(PathBuf::from(prefix).join("bin"));
        }
    }
    if let Some(home) = dirs::home_dir() {
        // npm writes a custom global prefix here; no shell or npm process is needed.
        if let Ok(config) = std::fs::read_to_string(home.join(".npmrc")) {
            for line in config.lines() {
                if let Some((key, value)) = line.split_once('=') {
                    if key.trim() == "prefix" {
                        let value = value.trim().trim_matches(['\"', '\'']);
                        let prefix = value
                            .strip_prefix("~/")
                            .map(|v| home.join(v))
                            .unwrap_or_else(|| PathBuf::from(value));
                        if prefix.is_absolute() {
                            paths.push(prefix.join("bin"));
                        }
                    }
                }
            }
        }
        let nvm = std::env::var_os("NVM_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".nvm"));
        if let Ok(entries) = std::fs::read_dir(nvm.join("versions/node")) {
            let mut bins: Vec<_> = entries.flatten().map(|e| e.path().join("bin")).collect();
            bins.sort();
            bins.reverse();
            paths.extend(bins);
        }
    }
    #[cfg(unix)]
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ]);
    #[cfg(windows)]
    if let Some(app) = dirs::config_dir() {
        paths.push(app.join("npm"));
    }
    paths
}
pub fn discover(name: &str) -> Option<PathBuf> {
    discover_in(name, &search_paths()).into_iter().next()
}
pub(super) fn discover_in(name: &str, paths: &[PathBuf]) -> Vec<PathBuf> {
    fn executable(p: &Path) -> bool {
        if !p.is_file() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            return p
                .metadata()
                .is_ok_and(|m| m.permissions().mode() & 0o111 != 0);
        }
        #[cfg(not(unix))]
        {
            true
        }
    }
    let p = Path::new(name);
    if p.is_absolute() {
        return executable(p).then(|| p.into()).into_iter().collect();
    }
    if name.contains('/') || name.contains('\\') {
        return vec![];
    }
    paths
        .iter()
        .flat_map(|path| {
            (if cfg!(windows) {
                vec![".exe", ".cmd", ".bat", ""]
            } else {
                vec![""]
            })
            .into_iter()
            .map(move |suffix| path.join(format!("{name}{suffix}")))
        })
        .filter(|p| executable(p))
        .collect()
}
