//! MCP client sessions owned by the ARC hub: newline-delimited stdio and Streamable HTTP.
use crate::owned_children::SpawnOwned;
use crate::*;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::{
    collections::{BTreeMap, HashMap},
    process::Stdio,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};

const LIMIT: usize = 32 * 1024 * 1024;
const PROTOCOLS: [&str; 4] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

/// Connection fields shared by stdio and HTTP servers.
pub(crate) struct Endpoint<'a> {
    pub transport: &'a str,
    pub command: &'a str,
    pub args: &'a [String],
    pub env: &'a BTreeMap<String, String>,
    pub cwd: Option<&'a str>,
    pub url: &'a str,
    pub headers: &'a BTreeMap<String, String>,
}

struct Http {
    client: reqwest::Client,
    url: String,
    headers: HeaderMap,
    session: Mutex<Option<String>>,
    protocol: Mutex<Option<String>>,
}
impl Http {
    async fn new(url: &str, configured: &BTreeMap<String, String>) -> Result<Self> {
        crate::init_crypto();
        let mut headers = HeaderMap::new();
        for (name, value) in configured {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| "MCP_INVALID_HEADER: Correct the header name")?,
                HeaderValue::from_str(value)
                    .map_err(|_| "MCP_INVALID_HEADER: Correct the header value")?,
            );
        }
        let settings =
            load(&root().join("app/preferences.json")).unwrap_or(json!({"proxyMode":"system"}));
        let proxy = crate::proxy::NetworkProxy::resolve(&settings)
            .await
            .map_err(|_| "MCP_PROXY_FAILED: Inspect ARC network settings")?;
        let client = proxy
            .client(reqwest::Client::builder())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| "MCP_CLIENT_FAILED: Inspect ARC network settings")?;
        Ok(Self {
            client,
            url: url.into(),
            headers,
            session: Mutex::new(None),
            protocol: Mutex::new(None),
        })
    }
    async fn request(&self, method: reqwest::Method) -> reqwest::RequestBuilder {
        let mut request = self
            .client
            .request(method, &self.url)
            .headers(self.headers.clone())
            .header("Accept", "application/json, text/event-stream");
        if let Some(session) = &*self.session.lock().await {
            request = request.header("Mcp-Session-Id", session);
        }
        if let Some(protocol) = &*self.protocol.lock().await {
            request = request.header("MCP-Protocol-Version", protocol);
        }
        request
    }
    /// Server requests inside a response stream get a minimal client reply.
    async fn answer(&self, message: &Value) -> Result<()> {
        if message.get("id").is_none() {
            return Ok(());
        }
        self.request(reqwest::Method::POST)
            .await
            .json(&client_reply(message))
            .send()
            .await
            .map_err(|_| "MCP_CONNECTION_FAILED: Check the endpoint and network")?;
        Ok(())
    }
    async fn exchange(&self, message: &Value) -> Result<Value> {
        let expected = message
            .get("id")
            .filter(|_| message.get("method").is_some());
        let response = self
            .request(reqwest::Method::POST)
            .await
            .json(message)
            .send()
            .await
            .map_err(|_| "MCP_CONNECTION_FAILED: Check the endpoint and network")?;
        let status = response.status();
        if !status.is_success() {
            let recovery = match status.as_u16() {
                401 | 403 => "Set the required Authorization or custom headers with mcp_configure update",
                404 => "The endpoint or its upstream session is gone; ARC reconnects on the next request",
                301..=399 => "Use the final MCP endpoint URL; credentials are not forwarded through redirects",
                _ => "Inspect the upstream service; do not replay an unconfirmed tool call",
            };
            return Err(format!("MCP_HTTP_{}: {recovery}", status.as_u16()));
        }
        if message["method"] == "initialize" {
            if let Some(session) = response.headers().get("mcp-session-id") {
                *self.session.lock().await = Some(
                    session
                        .to_str()
                        .map_err(|_| "MCP_INVALID_SESSION_HEADER")?
                        .into(),
                );
            }
        }
        let Some(expected) = expected else {
            return Ok(Value::Null);
        };
        let sse = response
            .headers()
            .get("content-type")
            .and_then(|s| s.to_str().ok())
            .is_some_and(|s| s.starts_with("text/event-stream"));
        let mut stream = response.bytes_stream();
        let mut buffer = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| {
                "MCP_CONNECTION_LOST: The response stream ended; reconcile tool effects before retrying"
            })?;
            buffer.extend_from_slice(&chunk);
            if buffer.len() > LIMIT {
                return Err(
                    "MCP_RESPONSE_TOO_LARGE: Upstream responses are capped at 32 MiB".into(),
                );
            }
            if !sse {
                continue;
            }
            while let Some((end, size)) = sse_boundary(&buffer) {
                let event = String::from_utf8(buffer.drain(..end + size).collect())
                    .map_err(|_| "MCP_INVALID_RESPONSE: Expected UTF-8 SSE")?;
                let data = event
                    .lines()
                    .filter_map(|line| {
                        line.strip_prefix("data:")
                            .map(|s| s.strip_prefix(' ').unwrap_or(s))
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if data.is_empty() {
                    continue;
                }
                let message: Value = serde_json::from_str(&data)
                    .map_err(|_| "MCP_INVALID_RESPONSE: Expected JSON in SSE data")?;
                if message.get("method").is_some() {
                    self.answer(&message).await?;
                } else if message.get("id") == Some(expected) {
                    return Ok(message);
                }
            }
        }
        if !sse {
            let message: Value = serde_json::from_slice(&buffer)
                .map_err(|_| "MCP_INVALID_RESPONSE: Expected a JSON-RPC response")?;
            if message.get("id") == Some(expected) {
                return Ok(message);
            }
        }
        Err("MCP_RESPONSE_MISSING: The service closed before replying; reconcile tool effects before retrying".into())
    }
}
fn sse_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer.windows(2).position(|b| b == b"\n\n").map(|i| (i, 2));
    let crlf = buffer
        .windows(4)
        .position(|b| b == b"\r\n\r\n")
        .map(|i| (i, 4));
    lf.into_iter().chain(crlf).min_by_key(|(i, _)| *i)
}
fn client_reply(message: &Value) -> Value {
    if message["method"] == "ping" {
        json!({"jsonrpc":"2.0","id":message["id"],"result":{}})
    } else {
        json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32601,"message":"Client capability not supported"}})
    }
}

type Waiters = Arc<std::sync::Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>>;
struct StdioLink {
    input: Arc<Mutex<tokio::process::ChildStdin>>,
    waiters: Waiters,
    child: Mutex<tokio::process::Child>,
    stderr: Arc<std::sync::Mutex<String>>,
}
enum Link {
    Stdio(StdioLink),
    Http(Http),
}

/// One initialized MCP session. Requests may run concurrently.
pub(crate) struct Session {
    link: Link,
    next: AtomicU64,
    closed: Arc<AtomicBool>,
    stale: Arc<AtomicBool>,
    pub(crate) info: Value,
}
impl Session {
    pub(crate) async fn open(endpoint: &Endpoint<'_>, timeout: Duration) -> Result<Arc<Self>> {
        let closed = Arc::new(AtomicBool::new(false));
        let stale = Arc::new(AtomicBool::new(false));
        let link = if endpoint.transport == "http" {
            Link::Http(Http::new(endpoint.url, endpoint.headers).await?)
        } else {
            Link::Stdio(spawn(endpoint, closed.clone(), stale.clone())?)
        };
        let mut session = Self {
            link,
            next: AtomicU64::new(1),
            closed,
            stale,
            info: Value::Null,
        };
        let init = session
            .request(
                "initialize",
                json!({"protocolVersion":"2025-11-25","capabilities":{},
            "clientInfo":{"name":"arc-mcp-hub","version":env!("ARC_BUILD_VERSION")}}),
                timeout,
            )
            .await;
        let init = match init {
            Ok(init) => init,
            Err(error) => {
                let tail = session.stderr_tail();
                session.close().await;
                return Err(if tail.is_empty() {
                    error
                } else {
                    format!("{error}. Server stderr: {tail}")
                });
            }
        };
        let protocol = string(&init, "protocolVersion");
        if !PROTOCOLS.contains(&protocol) {
            session.close().await;
            return Err(format!(
                "MCP_PROTOCOL_UNSUPPORTED: Server negotiated {protocol:?}; ARC supports {}",
                PROTOCOLS.join(", ")
            ));
        }
        if let Link::Http(http) = &session.link {
            *http.protocol.lock().await = Some(protocol.into());
        }
        session
            .notify("notifications/initialized", Value::Null)
            .await?;
        session.info = json!({"protocolVersion":protocol,"serverInfo":init["serverInfo"],
            "capabilities":init["capabilities"],"instructions":init["instructions"]});
        Ok(Arc::new(session))
    }
    pub(crate) fn alive(&self) -> bool {
        !self.closed.load(Ordering::SeqCst)
    }
    /// True after the server sent notifications/tools/list_changed.
    pub(crate) fn take_stale(&self) -> bool {
        self.stale.swap(false, Ordering::SeqCst)
    }
    fn stderr_tail(&self) -> String {
        match &self.link {
            Link::Stdio(stdio) => stdio
                .stderr
                .lock()
                .map(|s| s.trim().to_owned())
                .unwrap_or_default(),
            Link::Http(_) => String::new(),
        }
    }
    pub(crate) async fn notify(&self, method: &str, params: Value) -> Result<()> {
        let mut message = json!({"jsonrpc":"2.0","method":method});
        if !params.is_null() {
            message["params"] = params;
        }
        match &self.link {
            Link::Http(http) => http.exchange(&message).await.map(|_| ()),
            Link::Stdio(stdio) => write(&stdio.input, &message).await,
        }
    }
    /// Returns the JSON-RPC result. Timeouts send notifications/cancelled and never replay.
    pub(crate) async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        if !self.alive() {
            return Err("MCP_SESSION_CLOSED: ARC reconnects on the next request".into());
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let message = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        let reply = match &self.link {
            Link::Http(http) => tokio::time::timeout(timeout, http.exchange(&message)).await,
            Link::Stdio(stdio) => {
                let (send, receive) = tokio::sync::oneshot::channel();
                stdio
                    .waiters
                    .lock()
                    .map_err(|_| "MCP_SESSION_BUSY")?
                    .insert(id, send);
                if let Err(error) = write(&stdio.input, &message).await {
                    stdio
                        .waiters
                        .lock()
                        .map_err(|_| "MCP_SESSION_BUSY")?
                        .remove(&id);
                    return Err(error);
                }
                let outcome = tokio::time::timeout(timeout, receive).await;
                if outcome.is_err() {
                    stdio
                        .waiters
                        .lock()
                        .map_err(|_| "MCP_SESSION_BUSY")?
                        .remove(&id);
                }
                outcome.map(|r| r.map_err(|_| "MCP_STDIO_CLOSED: The server process exited; ARC restarts it on the next request".to_string()))
            }
        };
        let reply = match reply {
            Ok(reply) => reply?,
            Err(_) => {
                let _ = self
                    .notify(
                        "notifications/cancelled",
                        json!({"requestId":id,"reason":"timeout"}),
                    )
                    .await;
                return Err(format!("MCP_TIMEOUT: {method} exceeded {}ms; the server may still complete it. Read downstream state before retrying a side effect", timeout.as_millis()));
            }
        };
        if let Some(error) = reply.get("error") {
            let message: String = string(error, "message").chars().take(500).collect();
            return Err(format!(
                "MCP_RPC_ERROR: {method} failed upstream with code {}: {message}",
                error["code"]
            ));
        }
        reply
            .get("result")
            .cloned()
            .ok_or("MCP_INVALID_RESPONSE: The JSON-RPC response has no result".into())
    }
    pub(crate) async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        match &self.link {
            Link::Http(http) => {
                if http.session.lock().await.is_some() {
                    let _ = http
                        .request(reqwest::Method::DELETE)
                        .await
                        .timeout(Duration::from_secs(3))
                        .send()
                        .await;
                }
            }
            Link::Stdio(stdio) => {
                let _ = stdio.child.lock().await.kill().await;
            }
        }
    }
}

async fn write(input: &Mutex<tokio::process::ChildStdin>, message: &Value) -> Result<()> {
    let mut input = input.lock().await;
    input
        .write_all(format!("{message}\n").as_bytes())
        .await
        .map_err(|_| {
            "MCP_STDIO_CLOSED: The server process exited; ARC restarts it on the next request"
        })?;
    input.flush().await.map_err(|_| "MCP_STDIO_CLOSED".into())
}

/// GUI launches have a minimal PATH; bare commands resolve through known user CLI directories.
fn executable(command: &str) -> Result<PathBuf> {
    let path = Path::new(command);
    if path.is_absolute() {
        return Ok(path.into());
    }
    let names: Vec<String> = if cfg!(windows) && path.extension().is_none() {
        ["exe", "cmd", "bat"]
            .iter()
            .map(|ext| format!("{command}.{ext}"))
            .collect()
    } else {
        vec![command.into()]
    };
    crate::agents::driver::search_paths()
        .into_iter()
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
        .ok_or(format!("MCP_COMMAND_NOT_FOUND: {command} is not on ARC's search path; use an absolute command path"))
}

fn spawn(
    endpoint: &Endpoint<'_>,
    closed: Arc<AtomicBool>,
    stale: Arc<AtomicBool>,
) -> Result<StdioLink> {
    let binary = executable(endpoint.command)?;
    let mut command = crate::command(&binary);
    let paths = std::env::join_paths(crate::agents::driver::search_paths()).unwrap_or_default();
    command
        .args(endpoint.args)
        .env("PATH", paths)
        .envs(endpoint.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = endpoint.cwd {
        command.current_dir(cwd);
    }
    let mut child = command.spawn_owned().map_err(|_| {
        "MCP_START_FAILED: Check the command, arguments, environment and executable permissions"
    })?;
    let input = Arc::new(Mutex::new(child.stdin.take().ok_or("MCP_MISSING_STDIN")?));
    let mut output = BufReader::new(child.stdout.take().ok_or("MCP_MISSING_STDOUT")?);
    let mut errors = child.stderr.take().ok_or("MCP_MISSING_STDERR")?;
    let waiters: Waiters = Arc::default();
    let stderr = Arc::new(std::sync::Mutex::new(String::new()));
    let tail = stderr.clone();
    tokio::spawn(async move {
        let mut chunk = [0u8; 2048];
        while let Ok(n) = errors.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            if let Ok(mut tail) = tail.lock() {
                tail.push_str(&String::from_utf8_lossy(&chunk[..n]));
                let excess = tail.chars().count().saturating_sub(800);
                if excess > 0 {
                    *tail = tail.chars().skip(excess).collect();
                }
            }
        }
    });
    let pending = waiters.clone();
    let replies = input.clone();
    tokio::spawn(async move {
        loop {
            let Ok(frame) = crate::line(&mut output, LIMIT).await else {
                break;
            };
            if frame.is_empty() {
                break;
            }
            let Ok(message) = serde_json::from_slice::<Value>(&frame) else {
                continue;
            };
            if message.get("method").is_some() {
                if message["method"] == "notifications/tools/list_changed" {
                    stale.store(true, Ordering::SeqCst);
                }
                if message.get("id").is_some()
                    && write(&replies, &client_reply(&message)).await.is_err()
                {
                    break;
                }
                continue;
            }
            let waiter = message["id"]
                .as_u64()
                .and_then(|id| pending.lock().ok()?.remove(&id));
            if let Some(waiter) = waiter {
                let _ = waiter.send(message);
            }
        }
        closed.store(true, Ordering::SeqCst);
        // Dropping senders fails every outstanding request immediately.
        if let Ok(mut pending) = pending.lock() {
            pending.clear();
        }
    });
    Ok(StdioLink {
        input,
        waiters,
        child: Mutex::new(child),
        stderr,
    })
}
