//! One authenticated, leased Core process per state directory, shared by all local entrypoints.
use crate::*;
use std::{
    collections::HashMap,
    fs::File,
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::sync::{Notify, RwLock, RwLockReadGuard};

const LEASE_TTL: Duration = Duration::from_secs(10);
struct Lease {
    pid: u32,
    kind: String,
    seen: Instant,
    desktop: Option<Value>,
    process_start: Option<String>,
}
#[derive(Default)]
pub struct State {
    pub(crate) launches: Arc<crate::launches::Launches>,
    leases: std::sync::Mutex<HashMap<String, Lease>>,
    pub shutdown: Notify,
    closing: std::sync::atomic::AtomicBool,
    pub daemon: std::sync::atomic::AtomicBool,
}
impl State {
    pub(crate) fn with_launches(launches: Arc<crate::launches::Launches>) -> Self {
        Self {
            launches,
            ..Default::default()
        }
    }
    pub(crate) fn begin_shutdown(&self) {
        self.launches.close();
        self.closing
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    fn close_if_idle(&self) -> bool {
        let leases = self.active();
        if !leases.is_empty() {
            return false;
        }
        // Serialize the final idle check with lease acquisition. A new Desktop
        // must retry instead of attaching to a Core that has begun teardown.
        self.begin_shutdown();
        true
    }
    fn active(&self) -> std::sync::MutexGuard<'_, HashMap<String, Lease>> {
        crate::runtime_metrics::cost::sync(
            crate::runtime_metrics::cost::Owner::RuntimeLease,
            crate::runtime_metrics::cost::Reason::Poll,
            || {
                let mut leases = self.leases.lock().unwrap();
                crate::runtime_metrics::cost::scan_set(leases.len());
                leases.retain(|_, lease| {
                    crate::runtime_metrics::cost::rows(1);
                    lease.seen.elapsed() < LEASE_TTL
                        || lease.process_start.as_ref().is_some_and(|start| {
                            crate::codex_host::process_start(lease.pid).as_ref() == Some(start)
                        })
                });
                leases
            },
        )
    }
    pub fn clients(&self) -> Value {
        json!(self
            .active()
            .iter()
            .map(|(id, lease)| json!({"id":id,"pid":lease.pid,"kind":lease.kind}))
            .collect::<Vec<_>>())
    }
    pub fn request(&self, route: &str, body: Value) -> Result<Value> {
        let key = string(&body, "id");
        uuid::Uuid::parse_str(key).map_err(|_| "invalid client id")?;
        let mut leases = self.active();
        match route {
            "runtime/lease" => {
                if let Some(owner) = body.get("isolatedOwner") {
                    let matches = |key: &str, field: &str| {
                        std::env::var(key).is_ok_and(|value| {
                            !value.is_empty() && owner[field].as_str() == Some(value.as_str())
                        })
                    };
                    if !matches("ARC_DEV_INSTANCE_ID", "instance")
                        || !matches("ARC_DEV_OWNER_ID", "id")
                    {
                        return Err("Core ownership changed. No Core was stopped.".into());
                    }
                }
                if self.closing.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("core shutting down".into());
                }
                let kind = string(&body, "kind");
                if !["desktop", "cli"].contains(&kind) || !body["pid"].is_u64() {
                    return Err("invalid local entrypoint".into());
                }
                if leases.len() >= 128 && !leases.contains_key(key) {
                    return Err("too many local clients".into());
                }
                if kind == "desktop"
                    && leases
                        .iter()
                        .any(|(id, lease)| id != key && lease.kind == kind)
                {
                    return Err("A Desktop entry point is already using this data. Use another state directory.".into());
                }
                let desktop = body.get("desktop").filter(|v| v.is_object()).cloned();
                if let Some(endpoint) = &desktop {
                    if !endpoint["port"]
                        .as_u64()
                        .is_some_and(|p| p > 0 && p <= 65535)
                        || string(endpoint, "token").len() < 32
                    {
                        return Err("invalid desktop endpoint".into());
                    }
                }
                let pid = body["pid"].as_u64().unwrap() as u32;
                let process_start = if kind == "desktop" {
                    leases
                        .get(key)
                        .filter(|lease| lease.pid == pid)
                        .and_then(|lease| lease.process_start.clone())
                        .or_else(|| crate::codex_host::process_start(pid))
                } else {
                    None
                };
                leases.insert(
                    key.into(),
                    Lease {
                        pid,
                        process_start,
                        kind: kind.into(),
                        seen: Instant::now(),
                        desktop,
                    },
                );
                Ok(json!({"instance":key,"version":env!("ARC_BUILD_VERSION")}))
            }
            "runtime/release" => {
                leases.remove(key);
                Ok(json!({"released":true}))
            }
            "runtime/shutdown" => {
                // A fresh isolated supervisor passes its private startup identity only to
                // its Desktop/Core children. Installed Core has no such authority.
                let isolated_owner = std::env::var("ARC_DEV_INSTANCE_ID")
                    .is_ok_and(|instance| !instance.is_empty())
                    && std::env::var("ARC_DEV_OWNER_ID")
                        .is_ok_and(|owner| !owner.is_empty() && owner == key);
                if !isolated_owner && !leases.get(key).is_some_and(|lease| lease.kind == "desktop")
                {
                    return Err("Only the registered Desktop can stop Core.".into());
                }
                self.begin_shutdown();
                self.shutdown.notify_one();
                Ok(json!({"closing":true}))
            }
            _ => Err("UNKNOWN_ROUTE".into()),
        }
    }
    pub(crate) fn uninstall(&self, nonce: &str, proof: &Value) -> Result<Value> {
        if nonce.is_empty()
            || proof["token"] != nonce
            || proof["pid"] != std::process::id()
            || proof["processStart"].as_str()
                != crate::codex_host::process_start(std::process::id()).as_deref()
        {
            return Err("UNINSTALL_AUTH_REQUIRED: run the local uninstall command".into());
        }
        self.begin_shutdown();
        self.shutdown.notify_one();
        Ok(json!({"closing":true}))
    }
    pub async fn desktop_request(
        &self,
        operation: crate::transport::DesktopRequest,
    ) -> Result<Value> {
        if cfg!(target_os = "linux")
            && !matches!(&operation, crate::transport::DesktopRequest::Route(route, _, _) if route == "app/snapshot")
        {
            return Err(
                "DESKTOP_UNSUPPORTED: this operation requires a desktop UI; Linux runs headless."
                    .into(),
            );
        }
        let endpoint = self
            .active()
            .values()
            .find_map(|lease| lease.desktop.clone())
            .ok_or("Desktop is not running. This operation requires the Desktop entry point.")?;
        if let crate::transport::DesktopRequest::Route(route, method, body) = operation {
            return crate::transport::forward_to(&endpoint, &route, &method, body).await;
        }
        let (route, method, body) = match operation {
            crate::transport::DesktopRequest::Route(..) => unreachable!(),
            crate::transport::DesktopRequest::ServiceGet => ("service", "GET", json!({})),
            crate::transport::DesktopRequest::ServiceSet(body) => ("service", "POST", body),
            crate::transport::DesktopRequest::SubscriptionsOpen(body) => {
                ("subscriptions/open", "POST", body)
            }
        };
        crate::transport::forward_to(&endpoint, route, method, body).await
    }
}

pub fn binary() -> Result<PathBuf> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let name = if cfg!(windows) { "arc.exe" } else { "arc" };
    if executable.file_name().is_some_and(|v| {
        v == name
            || cfg!(feature = "test-fixture")
                && (v == "contract-fixture" || v == "contract-fixture.exe")
    }) {
        return Ok(executable);
    }
    let parent = executable.parent().ok_or("missing executable directory")?;
    for path in [
        parent.join("../Resources/bin").join(name),
        parent.join("bin").join(name),
    ] {
        if path.is_file() {
            return Ok(path);
        }
    }
    Err("The installation is missing the standalone Core executable.".into())
}

pub fn build_id(binary: &Path) -> Result<String> {
    #[cfg(test)]
    BUILD_HASHES.with(|count| count.set(count.get() + 1));
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = File::open(binary).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = match file.read(&mut buffer) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            result => result.map_err(|e| e.to_string())?,
        };
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(crate::hex_encode(&digest.finalize()))
}

#[cfg(test)]
thread_local! {
    static BUILD_HASHES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Identity of this running executable, initialized before its request listener.
/// Candidate and replacement files must still use build_id to observe disk changes.
pub fn process_build_id() -> Result<&'static str> {
    static BUILD: std::sync::OnceLock<Result<String>> = std::sync::OnceLock::new();
    BUILD
        .get_or_init(|| build_id(&std::env::current_exe().map_err(|e| e.to_string())?))
        .as_deref()
        .map_err(Clone::clone)
}

pub(crate) async fn owner(build: &str) -> Result<Option<Value>> {
    let Ok(info) = load(&root().join("app/native.json")) else {
        return Ok(None);
    };
    let Some(port) = info["port"].as_u64().filter(|p| *p > 0 && *p <= 65535) else {
        return Ok(None);
    };
    let health = if let Some(result) =
        crate::front_door::process::local_request("healthz", "GET", json!({})).await
    {
        match result {
            Ok(health) => health,
            Err(_) => return Ok(None),
        }
    } else {
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(|e| e.to_string())?
            .get(format!("http://127.0.0.1:{port}/healthz"))
            .bearer_auth(string(&info, "token"))
            .timeout(Duration::from_secs(2))
            .send()
            .await;
        let Ok(response) = response else {
            return Ok(None);
        };
        let Ok(health) = response.json::<Value>().await else {
            return Ok(None);
        };
        health
    };
    if health["instance"] != info["instance"] {
        return Ok(None);
    }
    if health["owner"] != "core"
        || health["version"] != env!("ARC_BUILD_VERSION")
        || health["build"] != build
    {
        return Err(
            "CORE_BUILD_MISMATCH: Close other local entry points. Reload Desktop and CLI from the same build.".into(),
        );
    }
    Ok(Some(info))
}

pub struct Client {
    id: String,
    kind: String,
    binary: PathBuf,
    build: String,
    desktop: Mutex<Option<Value>>,
    startup: Mutex<()>,
    active: RwLock<bool>,
    heartbeat: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}
impl Client {
    fn new(binary: PathBuf, kind: &str, desktop: Option<Value>) -> Result<Arc<Self>> {
        init_crypto();
        Ok(Arc::new(Self {
            id: id(),
            kind: kind.into(),
            build: build_id(&binary)?,
            binary,
            desktop: Mutex::new(desktop),
            startup: Mutex::new(()),
            active: RwLock::new(true),
            heartbeat: Default::default(),
        }))
    }

    pub fn desktop(binary: PathBuf, endpoint: Value) -> Result<Arc<Self>> {
        let client = Self::new(binary, "desktop", Some(endpoint))?;
        client.start_heartbeat();
        Ok(client)
    }

    pub async fn connect(binary: PathBuf, kind: &str) -> Result<Arc<Self>> {
        let client = Self::new(binary, kind, None)?;
        // Only a new entrypoint waits for a previous owner to finish shutting
        // down or for its lease to expire.
        // Retrying under the request gate would serialize every UI poll for 18
        // seconds and keep update shutdown waiting behind all queued readers.
        let deadline = Instant::now() + Duration::from_secs(18);
        loop {
            match client.ensure().await {
                Err(error)
                    if (error.starts_with("CORE_BUILD_MISMATCH")
                        || error.starts_with("CORE_UNAVAILABLE")
                        || error == "core shutting down")
                        && Instant::now() < deadline =>
                {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                result => {
                    drop(result?);
                    break;
                }
            }
        }
        client.resume().await;
        Ok(client)
    }
    pub async fn resume(self: &Arc<Self>) {
        *self.active.write().await = true;
        self.start_heartbeat();
    }
    fn start_heartbeat(self: &Arc<Self>) {
        let mut heartbeat = self.heartbeat.lock().unwrap();
        if heartbeat.is_some() {
            return;
        }
        let weak = Arc::downgrade(self);
        let task = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let Some(client) = weak.upgrade() else {
                    return;
                };
                if !stopped_path().exists() {
                    if let Err(error) = client.ensure().await {
                        eprintln!("Core heartbeat: {error}");
                    }
                }
            }
        });
        *heartbeat = Some(task);
    }
    async fn ensure(&self) -> Result<RwLockReadGuard<'_, bool>> {
        let active = self.active.read().await;
        if !*active {
            return Err("Core is paused for shutdown or update installation.".into());
        }
        self.ensure_core().await?;
        Ok(active)
    }
    async fn ensure_core(&self) -> Result<()> {
        let _startup = self.startup.lock().await;
        if stopped_path().exists() {
            return Err("CORE_STOPPED: Start Core from ARC Desktop.".into());
        }
        let current = owner(&self.build).await?;
        if current.is_none() {
            // A timed-out health probe does not release Core ownership. Never launch
            // another process while the existing Core still owns the state.
            if !core_unlocked()? {
                return Err("CORE_UNAVAILABLE: The existing Core still owns the state directory but did not answer its health check. Retry after it becomes responsive; inspect core.log if this persists.".into());
            }
            let replacement = crate::front_door::process::prepare_install().await?;
            private_dir(&root())?;
            let log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(root().join("core.log"))
                .map_err(|e| e.to_string())?;
            let mut child = std::process::Command::new(&self.binary);
            child
                .arg("serve")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(log);
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                child.process_group(0);
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                child.creation_flags(0x08000200);
            }
            drop(replacement);
            let mut child = child
                .spawn()
                .map_err(|e| format!("Core start failed: {e}"))?;
            let (exited, mut exit) = tokio::sync::oneshot::channel();
            std::thread::spawn(move || {
                let _ = exited.send(child.wait());
            });
            let deadline = Instant::now() + Duration::from_secs(15);
            while owner(&self.build).await?.is_none() {
                if Instant::now() >= deadline {
                    return Err(
                        "Core startup timed out. Check core.log in the state directory.".into(),
                    );
                }
                tokio::select! {
                    result = &mut exit => {
                        let status = result.map_err(|e| format!("Core wait failed: {e}"))?
                            .map_err(|e| format!("Core wait failed: {e}"))?;
                        // Another Core can still hold the lock while its listener
                        // disappears. A successful no-op launch must be retried,
                        // not awaited for a listener it will never create.
                        return Err(if status.success() { "core shutting down".into() }
                            else { format!("Core exited during startup ({status}); check core.log.") });
                    }
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                }
            }
        }
        if let Err(error) =
            crate::transport::forward_request("runtime/lease", "POST", self.lease().await).await
        {
            // Only startup retries this idempotent handshake, never user writes.
            return Err(if owner(&self.build).await?.is_none() {
                "core shutting down".into()
            } else {
                error
            });
        }
        Ok(())
    }

    async fn lease(&self) -> Value {
        json!({"id":self.id,"kind":self.kind,"pid":std::process::id(),"desktop":self.desktop.lock().await.clone()})
    }

    pub async fn hub_health(&self) -> Result<Value> {
        let expected = crate::service::expected_remote();
        let info = owner(&self.build).await;
        let core = match &info {
            Ok(Some(_)) => "ready",
            Ok(None) if stopped_path().exists() && core_unlocked().unwrap_or(false) => "stopped",
            _ => "unavailable",
        };
        let (faults, remote_unavailable) = match (expected, info) {
            (Ok(expected), Ok(Some(info))) if !expected.is_empty() => {
                match tokio::time::timeout(
                    Duration::from_secs(5),
                    crate::transport::forward_to(&info, "runtime/remote", "GET", json!({})),
                )
                .await
                {
                    Ok(Ok(faults)) => (faults, false),
                    _ => (json!(expected), true),
                }
            }
            (Ok(expected), _) => (json!(expected), false),
            (Err(_), _) => (json!([]), true),
        };
        Ok(json!({"core":core,"remoteFaults":faults,"remoteUnavailable":remote_unavailable}))
    }

    pub async fn control_core(self: &Arc<Self>, action: &str) -> Result<()> {
        if self.kind != "desktop" || !matches!(action, "start" | "stop" | "restart") {
            return Err("Invalid Desktop Core action.".into());
        }
        let mut active = self.active.write().await;
        if action != "start" {
            let was_stopped = stopped_path().exists();
            save(&stopped_path(), &json!(true))?;
            *active = false;
            if let Some(task) = self.heartbeat.lock().unwrap().take() {
                task.abort();
            }
            if let Err(error) = self.stop_current(action == "restart").await {
                if action == "restart" && !was_stopped {
                    clear_stopped()?;
                    *active = true;
                    self.start_heartbeat();
                }
                return Err(error);
            }
        }
        if action != "stop" {
            clear_stopped()?;
            *active = true;
            self.start_heartbeat();
            self.ensure_core().await?;
        }
        Ok(())
    }

    async fn stop_current(&self, recover: bool) -> Result<()> {
        if core_unlocked()? {
            return Ok(());
        }
        if let Some(info) = owner(&self.build).await? {
            let request = tokio::time::timeout(Duration::from_secs(5), async {
                crate::transport::forward_to(&info, "runtime/lease", "POST", self.lease().await)
                    .await?;
                crate::transport::forward_to(
                    &info,
                    "runtime/shutdown",
                    "POST",
                    json!({"id":self.id}),
                )
                .await
            })
            .await;
            let shutdown = match request {
                Ok(Ok(_)) => wait_core_exit().await,
                Ok(Err(error)) => Err(error),
                Err(_) => Err("Core did not acknowledge shutdown.".into()),
            };
            if shutdown.is_ok() || !recover {
                return shutdown;
            }
        }
        if !recover {
            return Err("Core did not respond. Use Core recovery to restart it.".into());
        }
        if !core_unlocked()? {
            terminate_core(&self.build)?;
        }
        wait_core_exit().await
    }
    pub async fn request(&self, route: &str, method: &str, body: Value) -> Result<Value> {
        let _active = self.ensure().await?;
        crate::transport::forward_request(route, method, body).await
    }
    pub async fn network_proxy(&self) -> Result<crate::proxy::NetworkProxy> {
        // Core owns effective network settings, including first-launch defaults.
        // Reading its backing file directly discarded those defaults in fresh state.
        crate::proxy::NetworkProxy::resolve(&self.request("network", "GET", json!({})).await?).await
    }
    pub async fn subscriptions(&self) -> Result<Value> {
        self.request("subscriptions", "GET", json!({})).await
    }
    pub async fn log(&self, level: &str, message: &str) {
        crate::logs::record(level, message, None);
    }
    pub async fn close(&self) {
        let mut active = self.active.write().await;
        *active = false;
        if let Some(task) = self.heartbeat.lock().unwrap().take() {
            task.abort();
        }
        let _ = crate::transport::forward_request("runtime/release", "POST", json!({"id":self.id}))
            .await;
    }
    pub async fn shutdown(&self) -> Result<()> {
        // Wait for every in-flight request, including native panel polling, and
        // exclude all ensure/spawn paths until shutdown has been accepted.
        let mut active = self.active.write().await;
        if stopped_path().exists() {
            self.stop_current(false).await?;
        } else {
            if !*active {
                return Err("Core is paused for shutdown or update installation.".into());
            }
            self.ensure_core().await?;
            crate::transport::forward_request("runtime/shutdown", "POST", json!({"id":self.id}))
                .await?;
        }
        *active = false;
        if let Some(task) = self.heartbeat.lock().unwrap().take() {
            task.abort();
        }
        wait_core_exit().await
    }
}
fn stopped_path() -> PathBuf {
    root().join("app/core-stopped.json")
}

fn clear_stopped() -> Result<()> {
    match std::fs::remove_file(stopped_path()) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn core_unlocked() -> Result<bool> {
    match File::options()
        .read(true)
        .write(true)
        .open(root().join("core.lock"))
    {
        Ok(lock) => match lock.try_lock() {
            Ok(()) => Ok(true),
            Err(std::fs::TryLockError::WouldBlock) => Ok(false),
            Err(error) => Err(error.to_string()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.to_string()),
    }
}

async fn wait_core_exit() -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !core_unlocked()? {
        if Instant::now() >= deadline {
            return Err("Core shutdown timed out".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

fn terminate_core(build: &str) -> Result<()> {
    let info = load(&root().join("app/native.json"))?;
    let pid = info["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 1);
    let start = info["processStart"].as_str();
    let Some(pid) = pid.filter(|pid| {
        info["owner"] == "core"
            && info["build"] == build
            && start.is_some()
            && crate::codex_host::process_start(*pid).as_deref() == start
    }) else {
        return Err("Could not verify the running Core process. No process was stopped.".into());
    };
    #[cfg(unix)]
    {
        // Signal only Core. Native Agents and detached App Servers own their processes.
        if unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE},
        };
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let stopped = crate::codex_host::process_start(pid).as_deref() == start
                && TerminateProcess(handle, 1) != 0;
            CloseHandle(handle);
            if !stopped {
                return Err("Could not stop the verified Core process.".into());
            }
        }
    }
    Ok(())
}

impl Drop for Client {
    fn drop(&mut self) {
        if let Some(task) = self.heartbeat.lock().unwrap().take() {
            task.abort();
        }
    }
}

/// Uninstall proves local filesystem access independently of ordinary CLI leases.
/// It never ensures/spawns a Core and targets one process creation identity.
pub(crate) async fn stop_for_uninstall() -> Result<()> {
    let Some(info) = owner(process_build_id()?).await? else {
        return Ok(());
    };
    let pid = info["pid"].as_u64().ok_or("CORE_PID_MISSING")? as u32;
    let start = crate::codex_host::process_start(pid).ok_or("CORE_IDENTITY_UNAVAILABLE")?;
    let path = root().join("uninstall-core.json");
    let token = id();
    save(
        &path,
        &json!({"token":token,"pid":pid,"processStart":start}),
    )?;
    let result = async {
        crate::transport::forward_to(&info, "runtime/uninstall", "POST", json!({"token":token}))
            .await?;
        let lock = File::options()
            .read(true)
            .write(true)
            .open(root().join("core.lock"))
            .map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if lock.try_lock().is_ok() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("Core shutdown timed out; uninstall stopped".into());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    .await;
    let _ = std::fs::remove_file(path);
    result
}

pub async fn serve() -> Result<()> {
    serve_mode(false).await
}

pub async fn serve_mode(daemon: bool) -> Result<()> {
    crate::resources::initialize();
    init_crypto();
    private_dir(&root())?;
    let startup_guard = crate::front_door::process::startup_guard()?;
    let lock = File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root().join("core.lock"))
        .map_err(|e| e.to_string())?;
    if lock.try_lock().is_err() {
        return Ok(());
    }
    if stopped_path().exists() {
        return Err("CORE_STOPPED: Start Core from ARC Desktop.".into());
    }
    // Only the Core lock owner may move runtime metadata or remove old state.
    let old = root().join("web");
    let app = root().join("app");
    if old.exists() {
        if app.exists() {
            std::fs::remove_dir_all(&old).map_err(|e| e.to_string())?;
        } else {
            std::fs::rename(&old, &app).map_err(|e| e.to_string())?;
        }
    }
    // A pre-upgrade Desktop may not use the lock. Never overwrite its live owner.
    if owner(process_build_id()?).await?.is_some() {
        return Ok(());
    }
    crate::owned_children::recover().await?;
    tokio::task::spawn_blocking(crate::sources::initialize)
        .await
        .map_err(|e| e.to_string())??;
    let service = crate::service::Service::new()?;
    service
        .runtime
        .daemon
        .store(daemon, std::sync::atomic::Ordering::SeqCst);
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|e| e.to_string())?;
    let owners = vec![
        root(),
        root().join("agents/requests"),
        root().join("notifications/tasks"),
    ];
    crate::kernel::derived_index::prepare(&owners);
    let listener = crate::transport::listen(service.clone(), None).await?;
    drop(startup_guard);
    let index_service = service.clone();
    let runtime = tokio::runtime::Handle::current();
    let rebuild = crate::kernel::derived_index::background(owners, move || {
        #[cfg(feature = "test-fixture")]
        if let Some(gate) = std::env::var_os("ARC_FIXTURE_INDEX_GATE") {
            while Path::new(&gate).exists() {
                crate::kernel::derived_index::check_cancelled()?;
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        if let Err(error) = crate::kernel::results::prune() {
            crate::logs::record(
                "WARN",
                &format!("Cannot prune temporary outputs: {error}"),
                None,
            );
        }
        let started = Instant::now();
        crate::sources::migrate_history()?;
        runtime.block_on(crate::claude_notify::migrate())?;
        runtime.block_on(crate::sources::complete_migration())?;
        crate::logs::record(
            "INFO",
            &format!(
                "Source history migration completed in {} ms",
                started.elapsed().as_millis()
            ),
            None,
        );
        crate::claude_notify::initialize_index()
    });
    let index_startup = tokio::spawn(async move {
        match rebuild.await {
            Ok(Ok(())) if *index_service.control.shutdown.borrow() == 0 => {
                let mut stopping = index_service.control.shutdown.subscribe();
                tokio::select! {
                    _ = stopping.changed() => return None,
                    _ = async { tokio::join!(index_service.agents.reattach(), index_service.control.reattach()); } => {}
                }
                crate::claude_notify::start(&index_service);
                crate::coordination::messages::start(&index_service);
                crate::dispatch_queue::start(&index_service.control);
                return Some(crate::coordination::observers::start(&index_service));
            }
            Ok(Ok(())) => {}
            result => {
                crate::logs::record("ERROR", &format!("Index startup failed: {result:?}"), None)
            }
        }
        None
    });
    let startup_service = service.clone();
    let startup = tokio::spawn(async move {
        tokio::join!(
            async {
                if daemon {
                    startup_service.autostart().await;
                }
            },
            async {
                if let Err(error) = crate::mcp_hub::restore().await {
                    crate::logs::record("WARN", &format!("MCP hub startup failed: {error}"), None);
                }
            },
        );
    });
    let monitor_service = Arc::downgrade(&service);
    let monitor = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let Some(service) = monitor_service.upgrade() else {
                break;
            };
            let _ = service.request("ingress", "GET", json!({})).await;
        }
    });
    let started = Instant::now();
    let mut empty_since = None;
    loop {
        tokio::select! {
            _ = service.runtime.shutdown.notified() => break,
            _ = tokio::signal::ctrl_c() => break,
            _ = async {
                #[cfg(unix)]
                terminate.recv().await;
                #[cfg(not(unix))]
                std::future::pending::<()>().await;
            } => break,
            _ = tokio::time::sleep(Duration::from_millis(500)) => {
                if crate::runtime_metrics::cost::sync(crate::runtime_metrics::cost::Owner::RuntimeLease, crate::runtime_metrics::cost::Reason::Timer, || !daemon && service.runtime.active().is_empty()) {
                    let empty = empty_since.get_or_insert_with(Instant::now);
                    if started.elapsed() > Duration::from_secs(15) && empty.elapsed() > Duration::from_secs(2)
                        && service.runtime.close_if_idle() { break; }
                } else { empty_since = None; }
            }
        }
    }
    // Keep business owners alive until admitted calls settle or the bounded drain ends.
    if let Err(error) = service
        .execution
        .front_door
        .drain(crate::front_door::Deadline::after(
            crate::front_door::DRAIN_TIMEOUT,
        ))
        .await
    {
        crate::logs::record("WARN", &error, None);
    }
    service.begin_shutdown();
    service.control.stop_waits();
    crate::kernel::derived_index::cancel();
    if let Ok(Some(coordination)) = index_startup.await {
        coordination.abort();
        let _ = coordination.await;
    }
    startup.abort();
    let _ = startup.await;
    monitor.abort();
    let result = service.stop().await;
    listener.abort();
    let metadata = root().join("app/native.json");
    if load(&metadata).is_ok_and(|v| v["pid"] == std::process::id()) {
        let _ = std::fs::remove_file(metadata);
    }
    drop(lock);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_desktop_keeps_its_lease_after_a_delayed_heartbeat() {
        // Regression: the Core could exit after a local bridge quit while Desktop's heartbeat was delayed.
        let state = State::default();
        let desktop = id();
        let cli = id();
        let pid = std::process::id();
        state
            .request(
                "runtime/lease",
                json!({"id":desktop,"kind":"desktop","pid":pid}),
            )
            .unwrap();
        state
            .request("runtime/lease", json!({"id":cli,"kind":"cli","pid":pid}))
            .unwrap();
        state.leases.lock().unwrap().get_mut(&desktop).unwrap().seen = Instant::now() - LEASE_TTL;
        state.request("runtime/release", json!({"id":cli})).unwrap();
        assert_eq!(
            state.clients(),
            json!([{"id":desktop,"kind":"desktop","pid":pid}])
        );
    }

    #[test]
    fn repeated_process_identity_reads_never_rehash_the_executable() {
        // Regression: idle GET app repeatedly allocated and hashed the entire Desktop executable.
        let started = Instant::now();
        let identity = process_build_id().unwrap().to_owned();
        let initialized = started.elapsed();
        let hashed = BUILD_HASHES.with(|count| count.get());
        let started = Instant::now();
        for _ in 0..1024 {
            assert_eq!(process_build_id().unwrap(), identity);
            assert_eq!(BUILD_HASHES.with(|count| count.get()), hashed);
        }
        eprintln!(
            "process identity: initial={initialized:?}, 1024 cached reads={:?}",
            started.elapsed()
        );
    }

    #[test]
    fn streamed_build_identity_matches_sha256_and_observes_replaced_files() {
        // Regression: whole-file build checks allocated entire binaries; streaming must retain fresh replacement evidence.
        let path = std::env::temp_dir().join(format!("arc-build-id-{}", id()));
        for size in [0, 3, 65536, 65537, 1024 * 1024 + 13] {
            let bytes: Vec<_> = (0..size).map(|i| (i % 251) as u8).collect();
            std::fs::write(&path, &bytes).unwrap();
            assert_eq!(build_id(&path).unwrap(), hash(&bytes));
        }
        std::fs::remove_file(&path).unwrap();
        assert!(build_id(&path).is_err());
    }

    #[test]
    fn local_uninstall_stops_headless_core_without_granting_cli_shutdown() {
        // Regression: uninstall of a running daemon failed the Desktop-only update shutdown check.
        let state = State::default();
        let cli = id();
        state
            .request("runtime/lease", json!({"id":cli,"kind":"cli","pid":2}))
            .unwrap();
        assert!(state
            .request("runtime/shutdown", json!({"id":cli}))
            .is_err());
        let token = id();
        let proof = json!({"token":token,"pid":std::process::id(),"processStart":crate::codex_host::process_start(std::process::id())});
        assert!(state.uninstall("wrong", &proof).is_err());
        assert_eq!(state.uninstall(&token, &proof).unwrap()["closing"], true);
        assert!(state.launches.check().is_err());
        assert!(state
            .request("runtime/lease", json!({"id":cli,"kind":"cli","pid":2}))
            .is_err());
    }

    #[tokio::test]
    async fn explicit_update_stops_core_with_other_local_clients_attached() {
        // Regression: an idle Core request could restart Codex after shutdown released the server.
        let control = crate::control::Control::new(PathBuf::from("unused-codex"));
        let state = State::with_launches(control.launches.clone());
        let desktop = id();
        let cli = id();
        state
            .request(
                "runtime/lease",
                json!({"id":desktop,"kind":"desktop","pid":1}),
            )
            .unwrap();
        state
            .request("runtime/lease", json!({"id":cli,"kind":"cli","pid":2}))
            .unwrap();
        assert!(state
            .request("runtime/shutdown", json!({"id":cli}))
            .is_err());
        assert_eq!(
            state
                .request("runtime/shutdown", json!({"id":desktop}))
                .unwrap()["closing"],
            true
        );
        assert!(control
            .utility()
            .await
            .err()
            .unwrap()
            .starts_with("CORE_SHUTTING_DOWN:"));
        assert!(control.profile_rpc("secondary").await.is_err());
    }

    #[test]
    fn restart_handoff_never_attaches_to_a_core_already_tearing_down() {
        // Regression: 42f9056; restart handoff never attaches to a core already tearing down.
        let state = State::default();
        let old = id();
        let new = id();
        state
            .request("runtime/lease", json!({"id":old,"kind":"desktop","pid":1}))
            .unwrap();
        assert!(!state.close_if_idle());
        state.request("runtime/release", json!({"id":old})).unwrap();
        assert!(state.close_if_idle());
        assert_eq!(
            state
                .request("runtime/lease", json!({"id":new,"kind":"desktop","pid":2}))
                .unwrap_err(),
            "core shutting down"
        );
        assert!(state.clients().as_array().unwrap().is_empty());
    }
}
