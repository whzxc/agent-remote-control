mod changes;
mod claude_notify;
mod cloudflare;
pub mod screen;
mod setup_secret;
mod shell_command;
mod text_files;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;
pub mod agents;
pub mod cli;
pub mod context;
pub mod control;
pub mod control_sources;
pub mod desktop;
pub mod diagnostics;
pub mod egress;
pub mod execution;
pub mod headless;
pub mod https;
pub mod https_tunnel;
pub mod i18n;
pub mod images;
pub mod ingress;
pub mod kernel;
pub mod logs;
pub mod management;
pub mod oauth;
pub mod operations;
pub mod output;
pub mod permissions;
pub mod preferences;
pub mod projects;
pub mod proxy;
pub mod rpc;
pub mod runtime;
pub mod service;
pub mod setup;
pub mod skills;
pub mod subscriptions;
pub mod transport;
pub mod waiter;
pub type Result<T> = std::result::Result<T, String>;
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn hash(value: impl AsRef<[u8]>) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(value.as_ref()))
}
pub fn string<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn num(v: &Value, key: &str, default: usize) -> usize {
    v[key].as_u64().unwrap_or(default as u64) as usize
}
pub fn root() -> PathBuf {
    std::env::var_os("ARC_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(windows) {
                dirs::data_local_dir().unwrap().join("agent-remote-control")
            } else if cfg!(target_os = "linux") {
                dirs::state_dir()
                    .unwrap_or_else(|| {
                        dirs::home_dir()
                            .expect("home directory")
                            .join(".local/state")
                    })
                    .join("agent-remote-control")
            } else {
                dirs::home_dir()
                    .unwrap()
                    .join(".local/state/agent-remote-control")
            }
        })
}
pub fn private_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        static PROTECTED: std::sync::OnceLock<
            std::sync::Mutex<std::collections::HashSet<PathBuf>>,
        > = std::sync::OnceLock::new();
        let mut protected = PROTECTED
            .get_or_init(Default::default)
            .lock()
            .map_err(|e| e.to_string())?;
        if !protected.contains(path) {
            let who = std::process::Command::new("whoami.exe")
                .args(["/user", "/fo", "csv", "/nh"])
                .creation_flags(0x08000000)
                .output()
                .map_err(|e| e.to_string())?;
            let text = String::from_utf8_lossy(&who.stdout);
            let sid = text
                .trim()
                .rsplit(',')
                .next()
                .unwrap_or("")
                .trim_matches('"');
            if !who.status.success() || !sid.starts_with("S-1-") {
                return Err("无法确认本机账户".into());
            }
            let status = std::process::Command::new("icacls.exe")
                .arg(path)
                .args(["/inheritance:r", "/grant:r", &format!("*{sid}:(OI)(CI)F")])
                .creation_flags(0x08000000)
                .output()
                .map_err(|e| e.to_string())?;
            if !status.status.success() {
                return Err("无法保护私有目录".into());
            }
            protected.insert(path.into());
        }
    }
    Ok(())
}
pub fn save(path: &Path, value: &Value) -> Result<()> {
    save_bytes(path, &serde_json::to_vec(value).map_err(|e| e.to_string())?)
}
pub fn save_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    private_dir(path.parent().ok_or("invalid path")?)?;
    let temp = path.with_extension(format!("{}.tmp", id()));
    std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}
pub fn load(path: &Path) -> Result<Value> {
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
pub fn command(binary: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(binary);
    c.kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x08000000);
    c
}
pub async fn output(binary: impl AsRef<std::ffi::OsStr>, args: &[&str]) -> Result<String> {
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        command(binary).args(args).output(),
    )
    .await
    .map_err(|_| "COMMAND_TIMEOUT")?
    .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = decode_command_output(&out.stderr);
        let message = if stderr.trim().is_empty() {
            decode_command_output(&out.stdout)
        } else {
            stderr
        };
        return Err(if message.trim().is_empty() {
            format!("Command failed: {}", out.status)
        } else {
            message.trim().into()
        });
    }
    Ok(decode_command_output(&out.stdout))
}
fn decode_command_output(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.into();
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_OEMCP};
        // Native Windows CLI tools emit the system OEM code page when redirected.
        // Preserve UTF-8 from tools such as Node and Git before using this fallback.
        if let Ok(length) = i32::try_from(bytes.len()) {
            let mut wide = vec![0u16; bytes.len()];
            let count = unsafe {
                MultiByteToWideChar(
                    CP_OEMCP,
                    0,
                    bytes.as_ptr(),
                    length,
                    wide.as_mut_ptr(),
                    length,
                )
            };
            if count > 0 {
                return String::from_utf16_lossy(&wide[..count as usize]);
            }
        }
    }
    String::from_utf8_lossy(bytes).into()
}
#[derive(Default)]
pub struct Events {
    pub wake: Arc<tokio::sync::Notify>,
    pub rows: Vec<Value>,
    pub bytes: usize,
    pub sequence: u64,
    pub pending: std::collections::HashMap<String, Value>,
    pub storage_error: Option<String>,
    pub durable: bool,
    desktop_states: std::collections::HashMap<(String, String), String>,
}
pub type SharedEvents = Arc<Mutex<Events>>;
pub async fn event(events: &SharedEvents, session: &str, method: &str, params: Value) {
    let mut e = events.lock().await;
    // All short-lived IPC readers share this event stream. Deduplicate here,
    // rather than per connection, so repeated follow/read calls stay bounded.
    if method == "desktop/thread-stream-state-changed" {
        let key = (
            string(&params, "conversationId").to_owned(),
            string(&params, "ownerClientId").to_owned(),
        );
        let digest = hash(params["change"].to_string());
        if e.desktop_states.get(&key) == Some(&digest) {
            return;
        }
        if !e.desktop_states.contains_key(&key) && e.desktop_states.len() >= 2000 {
            if let Some(old) = e.desktop_states.keys().next().cloned() {
                e.desktop_states.remove(&old);
            }
        }
        e.desktop_states.insert(key, digest);
    }
    e.sequence += 1;
    let row = json!({"cursor":e.sequence,"backendSession":session,"method":method,"params":params,"time":now()});
    e.bytes += row.to_string().len();
    e.rows.push(row.clone());
    e.wake.notify_waiters();
    while e.rows.len() > 2000 || e.bytes > 8 * 1024 * 1024 {
        let removed = e.rows.remove(0);
        e.bytes -= removed.to_string().len();
    }
    // Codex owns its history. Only Agent Remote Control-owned Agent streams need an archive.
    if !e.durable {
        return;
    }
    let session = session.to_owned();
    let result = tokio::task::spawn_blocking(move || {
        crate::kernel::event_store::append(&session, &format!("{row}\n"))
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    if let Err(err) = result {
        e.storage_error = Some(err);
    }
}
pub fn catalog() -> &'static Value {
    static CATALOG: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    CATALOG
        .get_or_init(|| serde_json::from_str(include_str!("catalog.json")).expect("tool catalog"))
}
pub(crate) fn validator(
    scope: &str,
    name: &str,
    schema: &Value,
) -> Result<Arc<jsonschema::Validator>> {
    static VALIDATORS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, Arc<jsonschema::Validator>>>,
    > = std::sync::OnceLock::new();
    let mut validators = VALIDATORS
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?;
    let key = format!("{scope}:{name}");
    if let Some(v) = validators.get(&key) {
        return Ok(v.clone());
    }
    let v = Arc::new(jsonschema::validator_for(schema).map_err(|e| e.to_string())?);
    validators.insert(key, v.clone());
    Ok(v)
}

// Bound allocation before accepting a complete line from a child or socket.
pub async fn line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    cap: usize,
) -> Result<Vec<u8>> {
    use tokio::io::AsyncBufReadExt;
    let mut out = Vec::new();
    loop {
        let buf = reader.fill_buf().await.map_err(|e| e.to_string())?;
        if buf.is_empty() {
            return Ok(out);
        }
        let n = buf
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(buf.len());
        if out.len() + n > cap {
            return Err("FRAME_TOO_LARGE".into());
        }
        let done = buf[n - 1] == b'\n';
        out.extend_from_slice(&buf[..n]);
        reader.consume(n);
        if done {
            return Ok(out);
        }
    }
}

pub fn init_crypto() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}
