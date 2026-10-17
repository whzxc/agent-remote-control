//! Agent Remote Control-owned Claude ACP dependencies. Discovery never downloads or uses global npm.
use super::*;
use base64::Engine;
use sha2::{Digest, Sha512};
use std::time::Duration;

fn manifest() -> Value {
    serde_json::from_str(include_str!("claude-adapter.json")).expect("bundled adapter manifest")
}
fn directory() -> PathBuf {
    root()
        .join("dependencies/claude-acp")
        .join(string(&manifest(), "version"))
}
fn runtime(dir: &Path) -> PathBuf {
    dir.join(if cfg!(windows) {
        "runtime/bin/bun.exe"
    } else {
        "runtime/bin/bun"
    })
}
fn entry(dir: &Path) -> PathBuf {
    dir.join("node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js")
}
// Called only while creating a new Core, before any owned Agent process starts.
pub fn prune() -> Result<()> {
    let current = directory();
    let Some(parent) = current.parent() else {
        return Ok(());
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Ok(());
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path != current
            && entry.file_type().map_err(|e| e.to_string())?.is_dir()
            && load(&path.join("ready.json")).is_ok_and(|v| v["manifest"].is_string())
        {
            std::fs::remove_dir_all(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
pub fn ready() -> bool {
    let dir = directory();
    load(&dir.join("ready.json"))
        .ok()
        .is_some_and(|v| v == json!({"manifest":hash(include_bytes!("claude-adapter.json"))}))
        && runtime(&dir).is_file()
        && entry(&dir).is_file()
}
pub fn launch() -> Result<(PathBuf, Vec<String>)> {
    if !ready() {
        return Err("CLAUDE_ADAPTER_NOT_READY".into());
    }
    let dir = directory();
    Ok((
        runtime(&dir),
        vec![entry(&dir).to_string_lossy().into_owned()],
    ))
}
pub async fn discover() -> (Option<PathBuf>, Option<String>, Option<String>) {
    let Some(binary) = driver::discover("claude") else {
        return (None, None, Some("AGENT_NOT_INSTALLED".into()));
    };
    match process::probe(&binary, &["--version".into()]).await {
        Ok(version) if version.contains("Claude Code") => {
            let error = (!ready()).then(|| "CLAUDE_ADAPTER_NOT_READY".into());
            (Some(binary), Some(version), error)
        }
        Ok(_) => (Some(binary), None, Some("AGENT_IDENTITY_MISMATCH".into())),
        Err(error) => (Some(binary), None, Some(error)),
    }
}

// A cancelled or failed preparation leaves no half-installed active directory.
struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
async fn unpack(client: &reqwest::Client, package: &Value, destination: &Path) -> Result<()> {
    private_dir(destination)?;
    let mut response = client
        .get(string(package, "url"))
        .send()
        .await
        .map_err(|_| "CLAUDE_ADAPTER_DOWNLOAD_FAILED")?
        .error_for_status()
        .map_err(|_| "CLAUDE_ADAPTER_DOWNLOAD_FAILED")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "CLAUDE_ADAPTER_DOWNLOAD_FAILED")?
    {
        if bytes.len() + chunk.len() > 128 * 1024 * 1024 {
            return Err("CLAUDE_ADAPTER_DOWNLOAD_TOO_LARGE".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let actual = format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(Sha512::digest(&bytes))
    );
    if actual != string(package, "integrity") {
        return Err("CLAUDE_ADAPTER_CHECKSUM_FAILED".into());
    }
    let archive = destination.join("download.tgz");
    std::fs::write(&archive, bytes).map_err(|e| e.to_string())?;
    // Both supported OSes ship bsdtar; only immutable, integrity-pinned archives are extracted.
    let tar = if cfg!(windows) {
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32/tar.exe")
    } else {
        PathBuf::from("/usr/bin/tar")
    };
    let mut cmd = command(tar);
    cmd.args(["-xzf"])
        .arg(&archive)
        .arg("--strip-components=1")
        .arg("-C")
        .arg(destination)
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(60), cmd.output())
        .await
        .map_err(|_| "CLAUDE_ADAPTER_EXTRACT_FAILED")?
        .map_err(|_| "CLAUDE_ADAPTER_EXTRACT_FAILED")?;
    if !out.status.success() {
        return Err("CLAUDE_ADAPTER_EXTRACT_FAILED".into());
    }
    std::fs::remove_file(archive).map_err(|e| e.to_string())?;
    Ok(())
}
pub async fn prepare() -> Result<()> {
    let (claude, version, error) = discover().await;
    if version.is_none() {
        return Err(error.unwrap_or_else(|| "AGENT_NOT_INSTALLED".into()));
    }
    if ready() {
        return Ok(());
    }
    let manifest = manifest();
    let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    let runtime_package = &manifest["runtimes"][&platform];
    if runtime_package.is_null() {
        return Err("UNSUPPORTED_PLATFORM".into());
    }
    let parent = directory().parent().unwrap().to_owned();
    private_dir(&parent)?;
    let staging = Staging(parent.join(format!(".prepare-{}", id())));
    private_dir(&staging.0)?;
    let settings = load(&root().join("app/preferences.json"))
        .unwrap_or_else(|_| json!({"proxyMode":"system","proxyUrl":""}));
    let proxy = crate::proxy::NetworkProxy::resolve(&settings).await?;
    let client = proxy
        .client(reqwest::Client::builder())
        .user_agent("agent-remote-control")
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    unpack(&client, runtime_package, &staging.0.join("runtime")).await?;
    for package in manifest["packages"].as_array().unwrap() {
        unpack(
            &client,
            package,
            &staging.0.join("node_modules").join(string(package, "name")),
        )
        .await?;
    }
    // Probe the actual bundle before activation, with the user's Claude binary selected.
    let mut cmd = command(runtime(&staging.0));
    cmd.arg(entry(&staging.0))
        .arg("--version")
        .env("CLAUDE_CODE_EXECUTABLE", claude.unwrap())
        .env_remove("NODE_OPTIONS")
        .env_remove("BUN_OPTIONS")
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(15), cmd.output())
        .await
        .map_err(|_| "CLAUDE_ADAPTER_PROBE_FAILED")?
        .map_err(|_| "CLAUDE_ADAPTER_PROBE_FAILED")?;
    if !out.status.success()
        || String::from_utf8_lossy(&out.stdout).trim()
            != string(&manifest["packages"][0], "version")
    {
        return Err("CLAUDE_ADAPTER_PROBE_FAILED".into());
    }
    save(
        &staging.0.join("ready.json"),
        &json!({"manifest":hash(include_bytes!("claude-adapter.json"))}),
    )?;
    let target = directory();
    // An incomplete version is replaceable; prior versions and active sessions are untouched.
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&staging.0, &target).map_err(|e| e.to_string())?;
    Ok(())
}
