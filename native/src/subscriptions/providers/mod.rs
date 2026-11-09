mod antigravity;
mod claude;
mod codex;
mod cursor;
mod grok;
mod kimi;
mod opencode_go;
use super::types::*;
use crate::owned_children::SpawnOwned;
use crate::{control::Control, *};
use std::time::Duration;
pub struct Registration {
    pub id: &'static str,
    pub agent: &'static str,
    pub name: &'static str,
    pub default_pool: &'static str,
    pub accepts_key: bool,
}
pub const REGISTRY: &[Registration] = &[
    Registration {
        id: "antigravity",
        agent: "antigravity",
        name: "Antigravity",
        default_pool: "gemini",
        accepts_key: false,
    },
    Registration {
        id: "codex",
        agent: "codex",
        name: "Codex",
        default_pool: "codex",
        accepts_key: false,
    },
    Registration {
        id: "opencode-go",
        agent: "opencode",
        name: "OpenCode Go",
        default_pool: "go",
        accepts_key: true,
    },
    Registration {
        id: "claude-code",
        agent: "claude",
        name: "Claude",
        default_pool: "subscription",
        accepts_key: false,
    },
    Registration {
        id: "cursor",
        agent: "cursor",
        name: "Cursor",
        default_pool: "cursorModels",
        accepts_key: false,
    },
    Registration {
        id: "grok",
        agent: "grok",
        name: "Grok",
        default_pool: "grok",
        accepts_key: false,
    },
    Registration {
        id: "kimi-code",
        agent: "kimi",
        name: "Kimi",
        default_pool: "coding",
        accepts_key: true,
    },
];
pub struct Credential {
    pub secret: String,
    pub source: &'static str,
}
impl Credential {
    fn new(secret: String, source: &'static str) -> std::result::Result<Self, Failure> {
        if secret.trim().is_empty() {
            return Err("credentials-missing".into());
        }
        Ok(Self { secret, source })
    }
}
pub async fn credential(id: &str) -> std::result::Result<Credential, Failure> {
    if REGISTRY.iter().any(|r| r.id == id && r.accepts_key) {
        let path = credential_path(id);
        if path.exists() {
            let saved = file(&path)?;
            return Credential::new(saved["key"].as_str().unwrap_or("").into(), "saved-key");
        }
    }
    match id {
        "opencode-go" => opencode_go::credential(),
        "cursor" => cursor::credential().await,
        "antigravity" => antigravity::credential().await,
        "grok" => grok::credential().await,
        "kimi-code" => Err("credentials-missing".into()),
        _ => Err("invalid-response".into()),
    }
}
pub async fn read(
    id: &str,
    control: &Control,
) -> std::result::Result<(Reading, &'static str), Failure> {
    if id == "codex" {
        return codex::read(control).await.map(|r| (r, "codex-account"));
    }
    if id == "claude-code" {
        return claude::read().await.map(|r| (r, "claude-login"));
    }
    let c = credential(id).await?;
    let client = client().await?;
    let reading = match id {
        "opencode-go" => opencode_go::read(&client, &c).await,
        "cursor" => cursor::read(&client, &c).await,
        "antigravity" => antigravity::read(&client, &c).await,
        "grok" => grok::read(&client, &c).await,
        "kimi-code" => kimi::read(&client, &c).await,
        _ => Err("invalid-response".into()),
    }?;
    Ok((reading, c.source))
}
async fn client() -> std::result::Result<reqwest::Client, Failure> {
    let proxy = network_proxy().await?;
    let client = proxy
        .client(
            reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none()),
        )
        .build()
        .map_err(|_| Failure::from("network-error"))?;
    Ok(client)
}
async fn network_proxy() -> std::result::Result<crate::proxy::NetworkProxy, Failure> {
    let settings = load(&root().join("app/preferences.json"))
        .unwrap_or(json!({"proxyMode":"system","proxyUrl":""}));
    crate::proxy::NetworkProxy::resolve(&settings)
        .await
        .map_err(|_| Failure::from("network-error"))
}

// Native CLIs own login renewal. Quota reads never rotate their tokens themselves.
async fn native_cli(
    agent: &str,
    args: &[&str],
) -> std::result::Result<std::process::Output, Failure> {
    use tokio::io::AsyncReadExt;
    let binary = crate::agents::driver::discover(agent).ok_or(Failure {
        code: "credentials-missing",
        message: Some(format!(
            "Install {agent} and sign in with its native CLI, then refresh usage."
        )),
        retry_at: None,
    })?;
    let mut command = crate::agents::launch_command(
        &binary,
        &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
    )
    .map_err(|_| Failure::from("request-failed"))?;
    network_proxy().await?.apply(&mut command);
    let directory = std::env::temp_dir().join(format!("arc-quota-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).map_err(|_| Failure::from("request-failed"))?;
    struct Directory(PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let directory = Directory(directory);
    command
        .current_dir(&directory.0)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if agent == "claude" {
        // /usage is a built-in command; no project settings, tools or saved turn.
        command
            .env("TZ", "UTC")
            .env("LC_ALL", "C")
            .env("DISABLE_TELEMETRY", "1")
            .env("DISABLE_ERROR_REPORTING", "1")
            .env("DISABLE_AUTOUPDATER", "1")
            .env_remove("CLAUDECODE")
            .env_remove("CLAUDE_CODE_ENTRYPOINT")
            .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("ANTHROPIC_AUTH_TOKEN")
            .env_remove("ANTHROPIC_BASE_URL")
            .env_remove("NODE_OPTIONS")
            .env_remove("BUN_OPTIONS");
    }
    let result = tokio::time::timeout(Duration::from_secs(45), async {
        let mut child = command
            .spawn_owned()
            .map_err(|_| Failure::from("request-failed"))?;
        let stdout = child.stdout.take().ok_or(Failure::from("request-failed"))?;
        let stderr = child.stderr.take().ok_or(Failure::from("request-failed"))?;
        let read = async |stream: tokio::process::ChildStdout| {
            let mut bytes = Vec::new();
            stream.take(1024 * 1024 + 1).read_to_end(&mut bytes).await?;
            Ok::<_, std::io::Error>(bytes)
        };
        let err = async {
            let mut bytes = Vec::new();
            stderr.take(1024 * 1024 + 1).read_to_end(&mut bytes).await?;
            Ok::<_, std::io::Error>(bytes)
        };
        let (stdout, stderr) =
            tokio::try_join!(read(stdout), err).map_err(|_| Failure::from("request-failed"))?;
        if stdout.len() > 1024 * 1024 || stderr.len() > 1024 * 1024 {
            return Err("invalid-response".into());
        }
        let status = child
            .wait()
            .await
            .map_err(|_| Failure::from("request-failed"))?;
        Ok(std::process::Output {
            status,
            stdout,
            stderr,
        })
    })
    .await
    .map_err(|_| Failure::from("network-error"))?;
    result
}

async fn get(request: reqwest::RequestBuilder) -> std::result::Result<Value, Failure> {
    let response = request
        .send()
        .await
        .map_err(|_| Failure::from("network-error"))?;
    match response.status().as_u16() {
        200 => {}
        401 => return Err("authentication-failed".into()),
        403 => return Err("request-forbidden".into()),
        429 => {
            let retry = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| {
                    s.parse::<i64>()
                        .ok()
                        .map(|n| chrono::Utc::now() + chrono::Duration::seconds(n.max(0)))
                        .or_else(|| {
                            chrono::DateTime::parse_from_rfc2822(s)
                                .ok()
                                .map(|v| v.with_timezone(&chrono::Utc))
                        })
                });
            return Err(Failure {
                code: "rate-limited",
                message: None,
                retry_at: retry.map(|d| d.to_rfc3339()),
            });
        }
        _ => return Err("network-error".into()),
    }
    let bytes = limited_bytes(response, 1024 * 1024).await?;
    serde_json::from_slice(&bytes).map_err(|_| "invalid-response".into())
}
async fn limited_bytes(
    mut response: reqwest::Response,
    limit: usize,
) -> std::result::Result<Vec<u8>, Failure> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("invalid-response".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Failure::from("network-error"))?
    {
        if bytes.len() + chunk.len() > limit {
            return Err("invalid-response".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub fn standalone_available(id: &str) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    match id {
        "antigravity" => home.join(".gemini").read_dir().ok().is_some_and(|entries| {
            entries
                .flatten()
                .any(|e| e.file_name().to_string_lossy().starts_with("antigravity"))
        }),
        "cursor" => {
            #[cfg(target_os = "macos")]
            let dir = home.join("Library/Application Support");
            #[cfg(not(target_os = "macos"))]
            let dir = dirs::config_dir().unwrap_or(home);
            dir.join("Cursor/User/globalStorage/state.vscdb").exists()
        }
        _ => false,
    }
}

fn file(path: &std::path::Path) -> std::result::Result<Value, Failure> {
    let data = std::fs::read(path).map_err(|e| {
        Failure::from(if e.kind() == std::io::ErrorKind::NotFound {
            "credentials-missing"
        } else {
            "credential-access-denied"
        })
    })?;
    serde_json::from_slice(&data).map_err(|_| "invalid-response".into())
}
fn home() -> std::result::Result<std::path::PathBuf, Failure> {
    dirs::home_dir().ok_or_else(|| "credentials-missing".into())
}

pub(super) fn credential_path(id: &str) -> PathBuf {
    root()
        .join("subscriptions/credentials")
        .join(format!("{id}.json"))
}

pub(crate) async fn account_read(
    control: &Control,
    agent: &str,
    profile: &str,
) -> std::result::Result<Reading, Failure> {
    match agent {
        "codex" => codex::read_profile(control, profile).await,
        "claude" => claude::read_profile(profile).await,
        _ => Err("provider-not-integrated".into()),
    }
}
