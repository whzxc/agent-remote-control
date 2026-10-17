//! Cloudflare's locally-managed setup. Provider credentials never leave Core.
use crate::*;
use base64::Engine;
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, BufReader};

struct Login {
    child: tokio::process::Child,
    url: Arc<std::sync::Mutex<Option<String>>>,
    reader: tokio::task::JoinHandle<()>,
}
impl Drop for Login {
    fn drop(&mut self) {
        self.reader.abort();
    }
}
static LOGIN: Mutex<Option<Login>> = Mutex::const_new(None);
fn directory() -> PathBuf {
    root().join("cloudflare")
}
pub fn certificate() -> PathBuf {
    directory().join(".cloudflared/cert.pem")
}
pub fn credentials(tunnel: &str) -> PathBuf {
    directory().join(format!("{tunnel}.json"))
}
pub fn configured(config: &Value) -> bool {
    let tunnel = string(config, "cloudflareTunnelId");
    !tunnel.is_empty() && credentials(tunnel).is_file()
}
pub async fn stop_login() {
    LOGIN.lock().await.take();
}
pub async fn status() -> Value {
    let ready = origin().is_ok();
    let mut login = LOGIN.lock().await;
    if ready {
        login.take();
    }
    let mut url = None;
    let mut running = false;
    if let Some(session) = login.as_mut() {
        running = session.child.try_wait().ok().flatten().is_none();
        if running {
            url = session.url.lock().unwrap().clone();
        }
    }
    if !running {
        login.take();
    }
    json!({"hasOriginCert":ready,"running":running,"openUrl":url})
}
async fn command_for(settings: &Value) -> Result<tokio::process::Command> {
    private_dir(&directory())?;
    let proxy = crate::proxy::NetworkProxy::resolve(settings).await?;
    let binary = crate::https_tunnel::install("cloudflare", &proxy).await?;
    let mut cmd = command(binary);
    for (key, _) in std::env::vars() {
        if key.starts_with("TUNNEL_") || key.starts_with("CLOUDFLARED_") {
            cmd.env_remove(key);
        }
    }
    // login ignores --origincert for its output. Isolate only this child's home.
    cmd.env("HOME", directory()).env("USERPROFILE", directory());
    cmd.env("TUNNEL_ORIGIN_CERT", certificate());
    proxy.apply(&mut cmd);
    let config = directory().join("empty.json");
    save(&config, &json!({}))?;
    cmd.args(["tunnel", "--no-autoupdate", "--config"])
        .arg(config);
    Ok(cmd)
}
pub async fn login(settings: &Value) -> Result<()> {
    if status().await["hasOriginCert"] == true {
        return Ok(());
    }
    let mut active = LOGIN.lock().await;
    if active.is_some() {
        return Ok(());
    }
    let mut child = command_for(settings)
        .await?
        .arg("login")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stderr = child.stderr.take().unwrap();
    let url = Arc::new(std::sync::Mutex::new(None));
    let captured = url.clone();
    let reader = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            for word in line.split_whitespace() {
                if word.starts_with("https://dash.cloudflare.com/argotunnel?") {
                    *captured.lock().unwrap() = Some(word.to_owned());
                }
            }
        }
    });
    *active = Some(Login { child, url, reader });
    drop(active);
    // Give the CLI time to emit its browser URL; later next/wait reads keep polling.
    for _ in 0..30 {
        let observed = status().await;
        if observed["openUrl"].is_string() || observed["running"] != true {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let observed = status().await;
    if observed["running"] != true && observed["hasOriginCert"] != true {
        return Err(
            "Cloudflare login ended before authorization completed; apply again to retry".into(),
        );
    }
    Ok(())
}
fn origin() -> Result<Value> {
    let text = std::fs::read_to_string(certificate()).map_err(|_| "Cloudflare login required")?;
    let encoded = text
        .split("-----BEGIN ARGO TUNNEL TOKEN-----")
        .nth(1)
        .and_then(|s| s.split("-----END ARGO TUNNEL TOKEN-----").next())
        .ok_or("Cloudflare origin certificate is unreadable")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.split_whitespace().collect::<String>())
        .map_err(|_| "Cloudflare origin certificate is unreadable")?;
    serde_json::from_slice(&bytes).map_err(|_| "Cloudflare origin certificate is unreadable".into())
}
async fn api(settings: &Value, cert: &Value, path: &str) -> Result<Value> {
    #[cfg(feature = "test-fixture")]
    if let Ok(fixtures) = load(&root().join("fixtures/cloudflare-api.json")) {
        return fixtures
            .get(path)
            .cloned()
            .ok_or("Cloudflare API fixture missing".into());
    }
    let proxy = crate::proxy::NetworkProxy::resolve(settings).await?;
    let client = proxy
        .client(reqwest::Client::builder())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(format!("https://api.cloudflare.com/client/v4/{path}"))
        .bearer_auth(string(cert, "apiToken"))
        .send()
        .await
        .map_err(|_| "Cloudflare API request failed")?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|_| "Cloudflare API response unreadable")?;
    if !status.is_success() || value["success"] != true {
        return Err(format!("Cloudflare API request failed ({status})"));
    }
    Ok(value["result"].clone())
}
async fn run(settings: &Value, args: &[&str]) -> Result<String> {
    let out = tokio::time::timeout(
        Duration::from_secs(60),
        command_for(settings).await?.args(args).output(),
    )
    .await
    .map_err(|_| "Cloudflare command timed out")?
    .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("Cloudflare {} failed ({})", args[0], out.status));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}
async fn host_label() -> String {
    let hostname = crate::output("hostname", &[])
        .await
        .unwrap_or_else(|_| "computer".into());
    let label = hostname
        .split('.')
        .next()
        .unwrap_or("mac")
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(24)
        .collect::<String>();
    let label = label.trim_matches('-');
    format!("arc-{}", if label.is_empty() { "computer" } else { label })
}
pub async fn provision(settings: &Value) -> Result<Value> {
    let cert = origin()?;
    let zone_id = string(&cert, "zoneID");
    let zone = api(settings, &cert, &format!("zones/{zone_id}")).await?;
    let zone_name = zone["name"]
        .as_str()
        .ok_or("Cloudflare zone name missing")?;
    let mut name = host_label().await;
    let tunnels: Value = serde_json::from_str(&run(settings, &["list", "--output", "json"]).await?)
        .map_err(|_| "Cloudflare tunnel list unreadable")?;
    let rows = tunnels
        .as_array()
        .ok_or("Cloudflare tunnel list unreadable")?;
    let mut existing = rows
        .iter()
        .find(|t| {
            !string(settings, "cloudflareTunnelId").is_empty()
                && t["id"] == settings["cloudflareTunnelId"]
        })
        .or_else(|| rows.iter().find(|t| t["name"] == name));
    if existing.is_none() {
        // Only adopt a differently named route when this ARC already owns its credentials.
        let records = api(
            settings,
            &cert,
            &format!("zones/{zone_id}/dns_records?type=CNAME&name={name}.{zone_name}"),
        )
        .await?;
        let routed = records.as_array().into_iter().flatten().find_map(|record| {
            string(record, "content")
                .strip_suffix(".cfargotunnel.com")
                .filter(|id| credentials(id).is_file())
        });
        existing = rows.iter().find(|t| Some(string(t, "id")) == routed);
    }
    let mut tunnel = None;
    if let Some(existing) = existing {
        let id = string(existing, "id");
        let detail = api(
            settings,
            &cert,
            &format!("accounts/{}/cfd_tunnel/{id}", string(&cert, "accountID")),
        )
        .await?;
        if detail["config_src"] != "cloudflare" {
            tunnel = Some(id.to_owned());
        } else {
            // A dashboard-managed tunnel keeps its remote routes. Create/reuse a local sibling.
            name.push_str("-local");
            if let Some(sibling) = rows.iter().find(|t| t["name"] == name) {
                let id = string(sibling, "id");
                let detail = api(
                    settings,
                    &cert,
                    &format!("accounts/{}/cfd_tunnel/{id}", string(&cert, "accountID")),
                )
                .await?;
                if detail["config_src"] == "cloudflare" {
                    return Err("Cloudflare setup tunnel name is already used by a dashboard-managed tunnel".into());
                }
                tunnel = Some(id.to_owned());
            }
        }
    }
    let hostname = tunnel
        .as_deref()
        .filter(|id| *id == string(settings, "cloudflareTunnelId"))
        .and_then(|_| reqwest::Url::parse(string(settings, "httpsUrl")).ok())
        .and_then(|url| url.host_str().map(str::to_owned))
        .filter(|host| host.ends_with(&format!(".{zone_name}")))
        .unwrap_or_else(|| format!("{name}.{zone_name}"));
    let tunnel = if let Some(id) = tunnel {
        let file = credentials(&id);
        if !file.exists() {
            run(
                settings,
                &["token", "--cred-file", &file.to_string_lossy(), &id],
            )
            .await?;
        }
        id
    } else {
        // create writes the secret before returning. Retrying after a partial failure lists by name.
        let pending = directory().join("created.json");
        if pending.exists() {
            std::fs::remove_file(&pending).map_err(|e| e.to_string())?;
        }
        run(
            settings,
            &[
                "create",
                "--credentials-file",
                &pending.to_string_lossy(),
                &name,
            ],
        )
        .await?;
        let id = load(&pending)?["TunnelID"]
            .as_str()
            .ok_or("Cloudflare tunnel ID missing")?
            .to_owned();
        std::fs::rename(pending, credentials(&id)).map_err(|e| e.to_string())?;
        id
    };
    // Do not replace a DNS record owned by another service. The CLI treats the same route as success.
    run(settings, &["route", "dns", &tunnel, &hostname]).await?;
    Ok(
        json!({"httpsProvider":"cloudflare","cloudflareMode":"named","cloudflareAuth":"login", "cloudflareTunnelId":tunnel,"httpsUrl":format!("https://{hostname}/mcp")}),
    )
}
