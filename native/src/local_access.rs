//! Local clients reuse the control-source protocol over authenticated loopback IPC.
use crate::*;

const SERVER: &str = "agent-remote-control";
fn desktop_config() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        dirs::home_dir()
            .map(|p| p.join("Library/Application Support/Claude/claude_desktop_config.json"))
    } else if cfg!(windows) {
        dirs::config_dir().map(|p| p.join("Claude/claude_desktop_config.json"))
    } else {
        None
    }
}
fn code_config() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .map(|p| p.join(".claude.json"))
        .or_else(|| dirs::home_dir().map(|p| p.join(".claude.json")))
}
fn antigravity_home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
}
fn antigravity_config() -> Option<PathBuf> {
    antigravity_home().map(|p| p.join(".gemini/config/mcp_config.json"))
}
fn antigravity_available() -> bool {
    antigravity_home().is_some_and(|home| {
        [
            ".gemini/config",
            ".gemini/antigravity",
            ".gemini/antigravity/bin/agentapi",
        ]
        .iter()
        .any(|p| home.join(p).exists())
    }) || Path::new("/Applications/Antigravity.app").exists()
        || crate::agents::driver::discover("agy").is_some()
        || crate::agents::driver::discover("antigravity").is_some()
}
fn read_json(path: &Path) -> Result<Value> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}
fn server_config(id: &str) -> Result<Value> {
    if id == "local-antigravity" {
        return Ok(json!({"command":crate::runtime::binary()?,"args":["cli","local-mcp",id]}));
    }
    Ok(
        json!({"command":crate::runtime::binary()?,"args":["cli","local-mcp",id],"env":{"ARC_STATE_DIR":root()}}),
    )
}
fn installed(path: Option<PathBuf>, expected: &Value) -> bool {
    path.and_then(|p| read_json(&p).ok()).is_some_and(|v| {
        let c = &v["mcpServers"][SERVER];
        c["command"] == expected["command"]
            && c["args"] == expected["args"]
            && c["env"] == expected["env"]
    })
}
pub(crate) fn request<'a>(
    service: &'a Arc<crate::service::Service>,
    route: &'a str,
    method: &'a str,
    body: Value,
) -> futures_util::future::BoxFuture<'a, Result<Value>> {
    Box::pin(async move {
        static INSTALL: Mutex<()> = Mutex::const_new(());
        let _guard = INSTALL.lock().await;
        let code = crate::agents::driver::discover("claude");
        let desktop = desktop_config();
        if route == "local-access/status" && method == "GET" {
            return Ok(json!({
                "codeAvailable":code.is_some(), "desktopAvailable":desktop.is_some(),
                "codeInstalled":installed(code_config(), &server_config("local-claude-code")?) && service.ingress("local-claude-code").await.is_ok(),
                "antigravityAvailable":antigravity_available(),
                "antigravityInstalled":antigravity_config().and_then(|p| read_json(&p).ok()).is_some_and(|v| v["mcpServers"][SERVER].is_object()) && service.request("ingress", "GET", json!({})).await?.as_array().is_some_and(|rows| rows.iter().any(|row| row["transport"] == "local" && (row["id"] == "local-antigravity" || row["name"] == "local-antigravity" || row["controlSource"] == "antigravity"))),
                "desktopInstalled":installed(desktop, &server_config("local-claude-desktop")?) && service.ingress("local-claude-desktop").await.is_ok()
            }));
        }
        if route != "local-access/install" || method != "POST" {
            return Err("UNKNOWN_ROUTE".into());
        }
        let target = string(&body, "target");
        let (id, name) = match target {
            "antigravity" if antigravity_available() => ("local-antigravity", "Antigravity"),
            "code" if code.is_some() => ("local-claude-code", "Claude Code"),
            "desktop" if desktop.is_some() => ("local-claude-desktop", "Claude Desktop"),
            _ => return Err("LOCAL_CLIENT_UNAVAILABLE".into()),
        };
        let expected = server_config(id)?;
        if matches!(target, "desktop" | "antigravity") {
            let path = if target == "antigravity" {
                antigravity_config().ok_or("HOME_UNAVAILABLE")?
            } else {
                desktop.unwrap()
            };
            let mut config = if path.exists() {
                read_json(&path)?
            } else {
                json!({})
            };
            let object = config
                .as_object_mut()
                .ok_or("Invalid client configuration")?;
            let servers = object
                .entry("mcpServers")
                .or_insert(json!({}))
                .as_object_mut()
                .ok_or("Invalid client server configuration")?;
            if let Some(existing) = servers.get(SERVER) {
                if target != "antigravity" && existing != &expected {
                    return Err("LOCAL_CONFIG_CONFLICT".into());
                }
            }
            servers.insert(SERVER.into(), expected);
            save(&path, &config)?;
        } else if !installed(code_config(), &expected) {
            // Never remove or overwrite a same-name server configured by the user.
            if code_config()
                .and_then(|p| read_json(&p).ok())
                .is_some_and(|c| !c["mcpServers"][SERVER].is_null())
            {
                return Err("LOCAL_CONFIG_CONFLICT".into());
            }
            let output = tokio::time::timeout(
                std::time::Duration::from_secs(20),
                command(code.unwrap())
                    .args([
                        "mcp",
                        "add",
                        "--transport",
                        "stdio",
                        "--scope",
                        "user",
                        "--env",
                    ])
                    .arg(format!("ARC_STATE_DIR={}", root().display()))
                    .args([SERVER, "--"])
                    .arg(crate::runtime::binary()?)
                    .args(["cli", "local-mcp", id])
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            .map_err(|_| "LOCAL_INSTALL_TIMEOUT")?
            .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err("LOCAL_INSTALL_FAILED".into());
            }
        }
        let path = if target == "antigravity" {
            antigravity_config()
        } else if target == "desktop" {
            desktop_config()
        } else {
            code_config()
        };
        if !installed(path, &server_config(id)?) {
            return Err("LOCAL_INSTALL_NOT_CONFIRMED".into());
        }
        if target == "antigravity" {
            let body = json!({"id":id,"name":name,"controlSource":"antigravity","transport":"local","auth":"none","enabled":true,"config":{"autoStart":true}});
            if service.ingress(id).await.is_ok() {
                service
                    .request(&format!("ingress/{id}"), "PUT", body)
                    .await?;
            } else {
                service.request("ingress", "POST", body).await?;
            }
        } else if service.ingress(id).await.is_err() {
            service.request("ingress", "POST", json!({"id":id,"name":name,"controlSource":"claude","transport":"local","auth":"none","config":{"autoStart":true}})).await?;
        }
        service
            .request(&format!("ingress/{id}/start"), "POST", json!({}))
            .await?;
        Ok(json!({"installed":true,"ingressId":id}))
    })
}
pub async fn stdio(id: &str) -> Result<()> {
    let owner = crate::runtime::Client::connect(crate::runtime::binary()?, "cli").await?;
    let result = async {
        let entry = owner
            .request(&format!("ingress/{id}"), "GET", json!({}))
            .await?;
        if entry["transport"] != "local" {
            return Err("Not a local control source".into());
        }
        owner
            .request(&format!("ingress/{id}/start"), "POST", json!({}))
            .await?;
        let info = load(&root().join("app/native.json"))?;
        let port = info["port"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= 65535)
            .ok_or("Invalid Core port")?;
        crate::transport::stdio_connection(port as u16, string(&info, "token").into(), id.into())
            .await
    }
    .await;
    owner.close().await;
    result
}
