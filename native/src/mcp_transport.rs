//! MCP discovery and the Rust Streamable HTTP-to-stdio process boundary.
use crate::*;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::{collections::HashSet, process::Stdio, time::Duration};
use tokio::io::{AsyncWriteExt, BufReader};

const LIMIT: usize = 32 * 1024 * 1024;
type Output = Arc<Mutex<tokio::io::Stdout>>;

async fn emit(output: &Output, message: &Value) -> Result<()> {
    let mut output = output.lock().await;
    output
        .write_all(format!("{message}\n").as_bytes())
        .await
        .map_err(|_| "MCP_STDIO_CLOSED")?;
    output.flush().await.map_err(|_| "MCP_STDIO_CLOSED".into())
}

pub(crate) struct Http {
    client: reqwest::Client,
    url: String,
    headers: HeaderMap,
    session: Mutex<Option<String>>,
    protocol: Mutex<Option<String>>,
}
impl Http {
    pub(crate) async fn new(service: &crate::mcp_services::Service) -> Result<Self> {
        crate::init_crypto();
        let mut headers = HeaderMap::new();
        for (name, value) in &service.headers {
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
            url: service.url.clone(),
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
    async fn received(
        &self,
        message: Value,
        expected: Option<&Value>,
        output: Option<&Output>,
    ) -> Result<Option<Value>> {
        if message.get("method").is_some() {
            if let Some(output) = output {
                emit(output, &message).await?;
            } else if message.get("id").is_some() {
                let response = if message["method"] == "ping" {
                    json!({"jsonrpc":"2.0","id":message["id"],"result":{}})
                } else {
                    json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32601,"message":"Client capability not supported"}})
                };
                self.request(reqwest::Method::POST)
                    .await
                    .json(&response)
                    .send()
                    .await
                    .map_err(|_| {
                        "MCP_CONNECTION_FAILED: Check the endpoint and network, then check again"
                    })?;
            }
            return Ok(None);
        }
        if expected.is_some_and(|id| message.get("id") == Some(id)) {
            if let Some(protocol) = message["result"]["protocolVersion"].as_str() {
                *self.protocol.lock().await = Some(protocol.into());
            }
            if let Some(output) = output {
                emit(output, &message).await?;
            }
            return Ok(Some(message));
        }
        Ok(None)
    }
    pub(crate) async fn exchange(&self, message: &Value, output: Option<&Output>) -> Result<Value> {
        let expected = message
            .get("id")
            .filter(|_| message.get("method").is_some());
        let response = self
            .request(reqwest::Method::POST)
            .await
            .json(message)
            .send()
            .await
            .map_err(|_| {
                "MCP_CONNECTION_FAILED: Check the endpoint and network, then check again"
            })?;
        let status = response.status();
        if !status.is_success() {
            let recovery = match status.as_u16() {
                401 | 403 => "Configure the required bearer/custom headers, or use the native Agent OAuth profile, then check again",
                404 => "Check the MCP endpoint; a running task may have lost its upstream session. Reconcile tool effects before starting a new task",
                301..=399 => "Use the final MCP endpoint URL; credentials are not forwarded through redirects",
                _ => "Inspect the upstream service and retry the connection check; do not replay an unconfirmed tool call",
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
        if expected.is_none() {
            return Ok(Value::Null);
        }
        let sse = response
            .headers()
            .get("content-type")
            .and_then(|s| s.to_str().ok())
            .is_some_and(|s| s.starts_with("text/event-stream"));
        let mut stream = response.bytes_stream();
        let mut buffer = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "MCP_CONNECTION_LOST: Reconcile tool effects before a new task; retry discovery to inspect connectivity")?;
            buffer.extend_from_slice(&chunk);
            if buffer.len() > LIMIT {
                return Err(
                    "MCP_RESPONSE_TOO_LARGE: Limit upstream response size to 32 MiB".into(),
                );
            }
            if sse {
                loop {
                    let boundary = buffer
                        .windows(2)
                        .position(|b| b == b"\n\n")
                        .map(|i| (i, 2))
                        .into_iter()
                        .chain(
                            buffer
                                .windows(4)
                                .position(|b| b == b"\r\n\r\n")
                                .map(|i| (i, 4)),
                        )
                        .min_by_key(|(i, _)| *i);
                    let Some((end, size)) = boundary else { break };
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
                    let message = serde_json::from_str(&data)
                        .map_err(|_| "MCP_INVALID_RESPONSE: Expected JSON in SSE data")?;
                    if let Some(reply) = self.received(message, expected, output).await? {
                        return Ok(reply);
                    }
                }
            }
        }
        if !sse {
            let message = serde_json::from_slice(&buffer)
                .map_err(|_| "MCP_INVALID_RESPONSE: Expected a JSON-RPC response")?;
            if let Some(reply) = self.received(message, expected, output).await? {
                return Ok(reply);
            }
        }
        Err("MCP_RESPONSE_MISSING: The service closed before replying; reconcile tool effects before retrying a call".into())
    }
    pub(crate) async fn close(&self) {
        if self.session.lock().await.is_some() {
            let _ = self
                .request(reqwest::Method::DELETE)
                .await
                .timeout(Duration::from_secs(3))
                .send()
                .await;
        }
    }
}

enum Client {
    Http(Http),
    Stdio {
        child: tokio::process::Child,
        input: tokio::process::ChildStdin,
        output: BufReader<tokio::process::ChildStdout>,
    },
}
impl Client {
    async fn new(service: &crate::mcp_services::Service) -> Result<Self> {
        if service.transport == "http" {
            return Ok(Self::Http(Http::new(service).await?));
        }
        let mut child = crate::command(&service.command).args(&service.args).envs(&service.env)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
            .map_err(|_| "MCP_START_FAILED: Check the absolute command, arguments, environment, and executable permissions")?;
        let input = child.stdin.take().ok_or("MCP_MISSING_STDIN")?;
        let output = BufReader::new(child.stdout.take().ok_or("MCP_MISSING_STDOUT")?);
        Ok(Self::Stdio {
            child,
            input,
            output,
        })
    }
    async fn exchange(&mut self, request: Value) -> Result<Value> {
        match self {
            Self::Http(http) => http.exchange(&request, None).await,
            Self::Stdio { input, output, .. } => {
                input
                    .write_all(format!("{request}\n").as_bytes())
                    .await
                    .map_err(|_| "MCP_STDIO_CLOSED: Inspect the service executable")?;
                input.flush().await.map_err(|_| "MCP_STDIO_CLOSED")?;
                let Some(id) = request.get("id") else {
                    return Ok(Value::Null);
                };
                loop {
                    let bytes = crate::line(output, LIMIT).await.map_err(|_| {
                        "MCP_STDIO_READ_FAILED: Inspect service framing and response size"
                    })?;
                    if bytes.is_empty() {
                        return Err(
                            "MCP_STDIO_CLOSED: Inspect the service executable and its native login"
                                .into(),
                        );
                    }
                    let message: Value = serde_json::from_slice(&bytes).map_err(|_| {
                        "MCP_INVALID_RESPONSE: stdout must contain newline-delimited JSON-RPC only"
                    })?;
                    if message.get("method").is_some() {
                        if let Some(id) = message.get("id") {
                            let reply = if message["method"] == "ping" {
                                json!({"jsonrpc":"2.0","id":id,"result":{}})
                            } else {
                                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Client capability not supported"}})
                            };
                            input
                                .write_all(format!("{reply}\n").as_bytes())
                                .await
                                .map_err(|_| "MCP_STDIO_CLOSED")?;
                            input.flush().await.map_err(|_| "MCP_STDIO_CLOSED")?;
                        }
                        continue;
                    }
                    if message.get("id") == Some(id) {
                        return Ok(message);
                    }
                }
            }
        }
    }
    async fn close(&mut self) {
        match self {
            Self::Http(http) => http.close().await,
            Self::Stdio { child, .. } => {
                let _ = child.kill().await;
            }
        }
    }
}
fn result(reply: Value) -> Result<Value> {
    if let Some(error) = reply.get("error") {
        return Err(format!("MCP_RPC_ERROR: Upstream returned code {}; inspect the service protocol and native login", error["code"]));
    }
    reply
        .get("result")
        .cloned()
        .ok_or("MCP_INVALID_RESPONSE: Missing result".into())
}
pub(crate) async fn discover(service: &crate::mcp_services::Service) -> Value {
    let mut stage = "connect";
    let mut client = None;
    let outcome = tokio::time::timeout(Duration::from_secs(30), async {
        client = Some(Client::new(service).await?);
        let client = client.as_mut().unwrap();
        stage = "initialize";
        let init = result(client.exchange(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"arc-mcp-check","version":env!("ARC_BUILD_VERSION")}
        }})).await?)?;
        if !matches!(init["protocolVersion"].as_str(), Some("2024-11-05" | "2025-03-26" | "2025-06-18" | "2025-11-25")) {
            return Err("MCP_PROTOCOL_UNSUPPORTED: Use a handshake-era MCP server or its native Agent integration".into());
        }
        client.exchange(json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await?;
        stage = "tools/list";
        let mut tools = vec![];
        let mut cursor = Value::Null;
        let mut seen = HashSet::new();
        let mut id = 2;
        loop {
            let params = if cursor.is_null() { json!({}) } else { json!({"cursor":cursor}) };
            let page = result(client.exchange(json!({"jsonrpc":"2.0","id":id,"method":"tools/list","params":params})).await?)?;
            tools.extend(page["tools"].as_array().ok_or("MCP_INVALID_TOOLS: tools/list must return a tools array")?.iter().cloned());
            cursor = page["nextCursor"].clone();
            if cursor.is_null() { break; }
            if !seen.insert(cursor.to_string()) { return Err("MCP_CURSOR_REPEATED: Inspect tools/list pagination in the service".into()); }
            id += 1;
        }
        Ok(json!({"state":"ready","checkedAt":now(),"protocolVersion":init["protocolVersion"],
            "serverInfo":{"name":init["serverInfo"]["name"],"version":init["serverInfo"]["version"]},"tools":tools}))
    }).await;
    if let Some(client) = client.as_mut() {
        client.close().await;
    }
    match outcome {
        Ok(Ok(value)) => value,
        other => {
            let message: String = match other { Ok(Err(message)) => message, _ => "MCP_TIMEOUT: Check the service startup, authentication, and network, then check again".into() };
            json!({"state":"failed","checkedAt":now(),"stage":stage,"error":message,"tools":[]})
        }
    }
}

pub async fn stdio() -> Result<()> {
    let service: crate::mcp_services::Service =
        serde_json::from_str(&std::env::var("ARC_MCP_SERVICE_CONFIG").map_err(|_| {
            "MCP_CONFIG_MISSING: Launch this adapter through an assigned ARC Agent session"
        })?)
        .map_err(|_| "MCP_CONFIG_INVALID: Reconfigure the service in ARC")?;
    let http = Arc::new(Http::new(&service).await?);
    let output = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut input = BufReader::new(tokio::io::stdin());
    let mut jobs = tokio::task::JoinSet::new();
    loop {
        let frame = crate::line(&mut input, LIMIT).await?;
        if frame.is_empty() {
            break;
        }
        let message: Value = serde_json::from_slice(&frame)
            .map_err(|_| "MCP_INVALID_REQUEST: Expected newline-delimited JSON-RPC")?;
        let http = http.clone();
        let output = output.clone();
        let initializing = matches!(
            string(&message, "method"),
            "initialize" | "notifications/initialized"
        );
        let forward = async move {
            if let Err(error) = http.exchange(&message, Some(&output)).await {
                if message.get("id").is_some() && message.get("method").is_some() {
                    let _ = emit(&output, &json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32000,"message":error}})).await;
                }
            }
        };
        if initializing {
            forward.await;
        } else {
            jobs.spawn(forward);
        }
        while jobs.try_join_next().is_some() {}
    }
    jobs.abort_all();
    while jobs.join_next().await.is_some() {}
    http.close().await;
    Ok(())
}
