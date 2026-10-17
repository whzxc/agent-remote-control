use crate::*;
use std::{collections::HashMap, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    sync::oneshot,
};
type Pending = Arc<std::sync::Mutex<HashMap<String, oneshot::Sender<Result<Value>>>>>;
struct PendingCall {
    pending: Pending,
    key: String,
}
impl Drop for PendingCall {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.key);
    }
}
pub struct Rpc {
    input: Mutex<tokio::process::ChildStdin>,
    child: Mutex<tokio::process::Child>,
    pending: Pending,
    pub events: SharedEvents,
    pub session: String,
    alive: Arc<std::sync::atomic::AtomicBool>,
}
impl Rpc {
    pub async fn start(binary: &Path, events: SharedEvents, session: &str) -> Result<Arc<Self>> {
        let mut command = command(binary);
        #[cfg(feature = "test-fixture")]
        command.arg(std::env::var("ARC_FIXTURE_SCRIPT").map_err(|_| "fixture script missing")?);
        #[cfg(not(feature = "test-fixture"))]
        command.arg("app-server");
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let input = child.stdin.take().ok_or("missing stdin")?;
        let stdout = child.stdout.take().ok_or("missing stdout")?;
        let mut stderr = child.stderr.take().ok_or("missing stderr")?;
        tokio::spawn(async move {
            let mut bytes = [0; 4096];
            let mut window = std::time::Instant::now();
            let mut count = 0;
            while let Ok(n) = stderr.read(&mut bytes).await {
                if n == 0 {
                    break;
                }
                if window.elapsed().as_secs() >= 1 {
                    window = std::time::Instant::now();
                    count = 0;
                }
                if count < 8 {
                    crate::logs::record(
                        "WARN",
                        &format!("app-server: {}", String::from_utf8_lossy(&bytes[..n])),
                        None,
                    );
                    count += 1;
                }
            }
        });
        let pending: Pending = Default::default();
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let rpc = Arc::new(Self {
            input: Mutex::new(input),
            child: Mutex::new(child),
            pending: pending.clone(),
            events: events.clone(),
            session: session.into(),
            alive: alive.clone(),
        });
        let session = session.to_owned();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let bytes = match crate::line(&mut reader, 32 * 1024 * 1024).await {
                    Ok(bytes) if !bytes.is_empty() => bytes,
                    _ => break,
                };
                let Ok(msg) = serde_json::from_slice::<Value>(&bytes) else {
                    continue;
                };
                if msg.get("method").is_some() {
                    if let Some(key) = msg.get("id") {
                        events.lock().await.pending.insert(key.to_string(),json!({"id":key,"method":msg["method"],"params":msg["params"],"backendSession":session}));
                    }
                    if string(&msg, "method") == "serverRequest/resolved" {
                        events
                            .lock()
                            .await
                            .pending
                            .remove(&msg["params"]["requestId"].to_string());
                    }
                    crate::event(
                        &events,
                        &session,
                        string(&msg, "method"),
                        msg["params"].clone(),
                    )
                    .await;
                } else if let Some(key) = msg.get("id") {
                    if let Some(tx) = pending.lock().unwrap().remove(&key.to_string()) {
                        let result = if msg.get("error").is_some() {
                            Err(format!("RPC_REJECTED:{}", msg["error"]))
                        } else {
                            Ok(msg["result"].clone())
                        };
                        let _ = tx.send(result);
                    }
                }
            }
            alive.store(false, std::sync::atomic::Ordering::SeqCst);
            for (_, tx) in pending.lock().unwrap().drain() {
                let _ = tx.send(Err("TRANSPORT_CLOSED: execution state unknown".into()));
            }
            let mut events = events.lock().await;
            events.pending.clear();
            events.wake.notify_waiters();
        });
        rpc.call("initialize",json!({"clientInfo":{"name":"agent-remote-control","version":env!("ARC_BUILD_VERSION")},"capabilities":{"experimentalApi":true}}),60000).await?;
        rpc.write(json!({"method":"initialized"})).await?;
        Ok(rpc)
    }
    pub fn alive(&self) -> bool {
        self.alive.load(std::sync::atomic::Ordering::SeqCst)
    }
    pub async fn write(&self, v: Value) -> Result<()> {
        let mut input = self.input.lock().await;
        input
            .write_all(format!("{v}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())
    }
    pub async fn call(&self, method: &str, params: Value, timeout: u64) -> Result<Value> {
        if !self.alive() {
            return Err("TRANSPORT_CLOSED".into());
        }
        let key = id();
        let (tx, rx) = oneshot::channel();
        let _guard = PendingCall {
            pending: self.pending.clone(),
            key: json!(key).to_string(),
        };
        self.pending
            .lock()
            .unwrap()
            .insert(json!(key).to_string(), tx);
        if let Err(e) = self
            .write(json!({"id":key,"method":method,"params":params}))
            .await
        {
            self.pending.lock().unwrap().remove(&json!(key).to_string());
            return Err(submission_error(method, e));
        }
        let out = tokio::time::timeout(Duration::from_millis(timeout), rx).await;
        self.pending.lock().unwrap().remove(&json!(key).to_string());
        let result = out
            .map_err(|_| format!("RPC_TIMEOUT: {method}"))
            .and_then(|v| v.map_err(|_| "TRANSPORT_CLOSED".to_string()))
            .and_then(|v| v);
        result.map_err(|e| submission_error(method, e))
    }
    pub async fn close(&self) {
        let _ = self.input.lock().await.shutdown().await;
        let mut child = self.child.lock().await;
        let pid = child.id();
        if tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
        // The utility process group belongs only to Agent Remote Control, never Desktop.
        #[cfg(unix)]
        if let Some(pid) = pid {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        if let Some(pid) = pid {
            let _ = output("taskkill.exe", &["/PID", &pid.to_string(), "/T", "/F"]).await;
        }
        self.alive.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

// Only transport failures after a mutating request was submitted leave its result unknown.
pub(crate) fn submission_error(method: &str, error: String) -> String {
    let read = matches!(
        method,
        "initialize" | "get_state" | "get_commands" | "get_available_models"
    ) || method.ends_with("/read")
        || method.ends_with("/list")
        || crate::catalog()["domains"]
            .as_object()
            .into_iter()
            .flat_map(|d| d.values())
            .flat_map(|d| {
                d["actions"]
                    .as_object()
                    .into_iter()
                    .flat_map(|a| a.values())
            })
            .any(|a| a[0] == method && a[1] == true);
    if read || error.starts_with("RPC_REJECTED") {
        error
    } else {
        format!("SUBMISSION_UNCONFIRMED: {error}")
    }
}
