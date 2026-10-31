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
}
#[derive(Default)]
pub struct State {
    leases: std::sync::Mutex<HashMap<String, Lease>>,
    pub shutdown: Notify,
    closing: std::sync::atomic::AtomicBool,
    pub daemon: std::sync::atomic::AtomicBool,
}
impl State {
    fn close_if_idle(&self) -> bool {
        let leases = self.active();
        if !leases.is_empty() {
            return false;
        }
        // Serialize the final idle check with lease acquisition. A new Desktop
        // must retry instead of attaching to a Core that has begun teardown.
        self.closing
            .store(true, std::sync::atomic::Ordering::SeqCst);
        true
    }
    fn active(&self) -> std::sync::MutexGuard<'_, HashMap<String, Lease>> {
        let mut leases = self.leases.lock().unwrap();
        leases.retain(|_, lease| lease.seen.elapsed() < LEASE_TTL);
        leases
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
                leases.insert(
                    key.into(),
                    Lease {
                        pid: body["pid"].as_u64().unwrap() as u32,
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
                if !leases.contains_key(key) || leases.keys().any(|id| id != key) {
                    return Err(
                        "Other local entry points still use Core. Close those CLI or Desktop clients before installing the update."
                            .into(),
                    );
                }
                self.closing
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                self.shutdown.notify_one();
                Ok(json!({"closing":true}))
            }
            _ => Err("UNKNOWN_ROUTE".into()),
        }
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
    if executable.file_name().is_some_and(|v| v == name) {
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
    pub async fn connect(binary: PathBuf, kind: &str) -> Result<Arc<Self>> {
        init_crypto();
        let client = Arc::new(Self {
            id: id(),
            kind: kind.into(),
            build: build_id(&binary)?,
            binary,
            desktop: Mutex::new(None),
            startup: Mutex::new(()),
            active: RwLock::new(true),
            heartbeat: Default::default(),
        });
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
                if let Err(error) = client.ensure().await {
                    eprintln!("Core heartbeat: {error}");
                };
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
        let current = owner(&self.build).await?;
        if current.is_none() {
            // A timed-out health probe does not release Core ownership. Never launch
            // another process while the existing Core still owns the state.
            match File::options()
                .read(true)
                .write(true)
                .open(root().join("core.lock"))
            {
                Ok(lock) => match lock.try_lock() {
                    Ok(()) => drop(lock),
                    Err(std::fs::TryLockError::WouldBlock) => {
                        return Err("CORE_UNAVAILABLE: The existing Core still owns the state directory but did not answer its health check. Retry after it becomes responsive; inspect core.log if this persists.".into());
                    }
                    Err(error) => return Err(error.to_string()),
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
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
        if let Err(error) = crate::transport::forward_request("runtime/lease", "POST", json!({"id":self.id,"kind":self.kind,"pid":std::process::id(),"desktop":self.desktop.lock().await.clone()})).await {
            // The listener may disappear between the health check and lease.
            // Only startup retries this idempotent handshake, never user writes.
            return Err(if owner(&self.build).await?.is_none() { "core shutting down".into() } else { error });
        }
        Ok(())
    }
    pub async fn attach_desktop(&self, endpoint: Value) -> Result<()> {
        *self.desktop.lock().await = Some(endpoint);
        let _active = self.ensure().await?;
        Ok(())
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
        if !*active {
            return Err("Core is paused for shutdown or update installation.".into());
        }
        self.ensure_core().await?;
        let lock = File::options()
            .read(true)
            .write(true)
            .open(root().join("core.lock"))
            .map_err(|e| e.to_string())?;
        crate::transport::forward_request("runtime/shutdown", "POST", json!({"id":self.id}))
            .await?;
        *active = false;
        if let Some(task) = self.heartbeat.lock().unwrap().take() {
            task.abort();
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        // A missing HTTP listener alone does not prove Core finished stopping.
        // Core releases this lock only after service cleanup and metadata removal.
        loop {
            match lock.try_lock() {
                Ok(()) => return Ok(()),
                Err(std::fs::TryLockError::WouldBlock) => {}
                Err(error) => return Err(error.to_string()),
            }
            if Instant::now() > deadline {
                return Err("Core shutdown timed out".into());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        if let Some(task) = self.heartbeat.lock().unwrap().take() {
            task.abort();
        }
    }
}

pub async fn serve() -> Result<()> {
    serve_mode(false).await
}

pub async fn serve_mode(daemon: bool) -> Result<()> {
    crate::resources::initialize();
    init_crypto();
    private_dir(&root())?;
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
    crate::claude_notify::migrate().await?;
    crate::sources::complete_migration().await?;
    let listener = crate::transport::listen(service.clone(), None).await?;
    crate::claude_notify::start(&service);
    crate::coordination::messages::start(&service);
    crate::dispatch_queue::start(&service.control);
    crate::update_queue::start(&service.execution);
    let coordination = crate::coordination::observers::start(&service);
    let startup_service = service.clone();
    let startup = tokio::spawn(async move {
        if daemon {
            startup_service.autostart().await;
        }
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
                if !daemon && service.runtime.active().is_empty() {
                    let empty = empty_since.get_or_insert_with(Instant::now);
                    if started.elapsed() > Duration::from_secs(15) && empty.elapsed() > Duration::from_secs(2)
                        && service.runtime.close_if_idle() { break; }
                } else { empty_since = None; }
            }
        }
    }
    coordination.abort();
    let _ = coordination.await;
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
