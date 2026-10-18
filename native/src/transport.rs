use crate::service::Service;
use crate::*;
use std::time::Duration;
use tokio::{
    io::BufReader,
    net::{TcpListener, TcpStream},
};
pub enum DesktopRequest {
    Route(String, String, Value),
    ServiceGet,
    ServiceSet(Value),
    SubscriptionsOpen(Value),
}
pub trait DesktopAccess: Send + Sync {
    fn check_write(&self) -> Result<()>;
    fn request(
        &self,
        request: DesktopRequest,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send>>;
}

/// A Desktop entrypoint exposes only native window operations; Core stays in the shared process.
pub async fn listen_desktop(
    owner: Arc<dyn DesktopAccess>,
) -> Result<(Value, tokio::task::JoinHandle<()>)> {
    use http_body_util::{BodyExt, Full, Limited};
    use hyper::{body::Bytes, server::conn::http1, service::service_fn, Request, Response};
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = id() + &id();
    let endpoint = json!({"port":port,"token":token});
    let job = tokio::spawn(async move {
        while let Ok((stream, peer)) = listener.accept().await {
            if !peer.ip().is_loopback() {
                continue;
            }
            let (owner, token) = (owner.clone(), token.clone());
            tokio::spawn(async move {
                let service = service_fn(move |request: Request<hyper::body::Incoming>| {
                    let (owner, token) = (owner.clone(), token.clone());
                    async move {
                        let result: Result<Value> = async {
                            if !local_host(
                                request.headers().get("host").and_then(|h| h.to_str().ok()),
                                port,
                            ) || request
                                .headers()
                                .get("authorization")
                                .and_then(|h| h.to_str().ok())
                                != Some(format!("Bearer {token}").as_str())
                                || request.headers().contains_key("origin")
                            {
                                return Err("unauthorized".into());
                            }
                            let method = request.method().clone();
                            let path = request.uri().path().to_owned();
                            let bytes = Limited::new(request.into_body(), 65536)
                                .collect()
                                .await
                                .map_err(|e| e.to_string())?
                                .to_bytes();
                            let body = if bytes.is_empty() {
                                json!({})
                            } else {
                                serde_json::from_slice(&bytes).map_err(|e| e.to_string())?
                            };
                            let operation = match (path.as_str(), method.as_str()) {
                                ("/api/service", "GET") => DesktopRequest::ServiceGet,
                                ("/api/service", "POST") => DesktopRequest::ServiceSet(body),
                                ("/api/subscriptions/open", "POST") => {
                                    DesktopRequest::SubscriptionsOpen(body)
                                }
                                _ if crate::management::desktop_route(
                                    path.trim_start_matches("/api/"),
                                ) =>
                                {
                                    DesktopRequest::Route(
                                        path.trim_start_matches("/api/").into(),
                                        method.to_string(),
                                        body,
                                    )
                                }
                                _ => return Err("UNKNOWN_ROUTE".into()),
                            };
                            owner.request(operation).await
                        }
                        .await;
                        let (status, body) = match result {
                            Ok(value) => (200, value),
                            Err(error) => (400, json!({"error":error})),
                        };
                        Ok::<_, std::convert::Infallible>(
                            Response::builder()
                                .status(status)
                                .header("Content-Type", "application/json")
                                .header("Cache-Control", "no-store")
                                .body(Full::new(Bytes::from(body.to_string())))
                                .unwrap(),
                        )
                    }
                });
                let _ = http1::Builder::new()
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    Ok((endpoint, job))
}

pub async fn listen(
    service: Arc<Service>,
    desktop: Option<Arc<dyn DesktopAccess>>,
) -> Result<tokio::task::JoinHandle<()>> {
    service.subscriptions.start();
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    service
        .port
        .store(port, std::sync::atomic::Ordering::SeqCst);
    let build = crate::runtime::build_id(&std::env::current_exe().map_err(|e| e.to_string())?)?;
    save(
        &root().join("app/native.json"),
        &json!({"port":port,"pid":std::process::id(),"token":service.token,"instance":service.control.session,"runtime":"rust","version":env!("ARC_BUILD_VERSION"),"owner":"core","daemon":service.runtime.daemon.load(std::sync::atomic::Ordering::SeqCst),"build":build}),
    )?;
    Ok(tokio::spawn(async move {
        loop {
            let Ok((stream, peer)) = listener.accept().await else {
                break;
            };
            if !peer.ip().is_loopback() {
                continue;
            }
            let s = service.clone();
            let desktop = desktop.clone();
            tokio::spawn(async move {
                let _ = handle(stream, s, desktop).await;
            });
        }
    }))
}
fn local_host(host: Option<&str>, port: u16) -> bool {
    host.is_some_and(|host| {
        host.eq_ignore_ascii_case(&format!("localhost:{port}"))
            || host == format!("127.0.0.1:{port}")
    })
}
type LocalBody = http_body_util::combinators::BoxBody<hyper::body::Bytes, std::convert::Infallible>;

struct EventBody(tokio::sync::mpsc::Receiver<hyper::body::Bytes>);
impl hyper::body::Body for EventBody {
    type Data = hyper::body::Bytes;
    type Error = std::convert::Infallible;
    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<std::result::Result<hyper::body::Frame<Self::Data>, Self::Error>>>
    {
        self.0
            .poll_recv(cx)
            .map(|v| v.map(|bytes| Ok(hyper::body::Frame::data(bytes))))
    }
}
fn local_reply(code: u16, value: Value) -> hyper::Response<LocalBody> {
    use http_body_util::BodyExt;
    hyper::Response::builder()
        .status(code)
        .header("Content-Type", "application/json")
        .header("Cache-Control", "no-store")
        .body(http_body_util::Full::new(hyper::body::Bytes::from(value.to_string())).boxed())
        .unwrap()
}
async fn handle(
    stream: TcpStream,
    s: Arc<Service>,
    desktop: Option<Arc<dyn DesktopAccess>>,
) -> Result<()> {
    use hyper::{server::conn::http1, service::service_fn};
    let socket = stream.into_std().map_err(|e| e.to_string())?;
    let disconnect = Arc::new(
        TcpStream::from_std(socket.try_clone().map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?,
    );
    let stream = TcpStream::from_std(socket).map_err(|e| e.to_string())?;
    let service = service_fn(move |request| {
        let (s, desktop, disconnect) = (s.clone(), desktop.clone(), disconnect.clone());
        async move {
            Ok::<_, std::convert::Infallible>(local_request(request, s, desktop, disconnect).await)
        }
    });
    http1::Builder::new()
        .timer(hyper_util::rt::TokioTimer::new())
        .header_read_timeout(Duration::from_secs(5))
        .keep_alive(false)
        .max_buf_size(16384)
        .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
        .await
        .map_err(|e| e.to_string())
}
// Starts only after the complete request body is consumed. This endpoint serves
// one request per connection, so any remaining incoming bytes are not another request.
async fn wait_disconnect(stream: &TcpStream) {
    let mut bytes = [0; 1024];
    loop {
        if stream.readable().await.is_err() {
            return;
        }
        match stream.try_read(&mut bytes) {
            Ok(0) => return,
            Err(e) if e.kind() != std::io::ErrorKind::WouldBlock => return,
            _ => (),
        }
    }
}
async fn local_request(
    request: hyper::Request<hyper::body::Incoming>,
    s: Arc<Service>,
    desktop: Option<Arc<dyn DesktopAccess>>,
    disconnect: Arc<TcpStream>,
) -> hyper::Response<LocalBody> {
    use http_body_util::{BodyExt, Limited};
    let port = s.port.load(std::sync::atomic::Ordering::SeqCst);
    let headers = request.headers();
    if !local_host(headers.get("host").and_then(|v| v.to_str().ok()), port)
        || headers.get("authorization").and_then(|v| v.to_str().ok())
            != Some(format!("Bearer {}", s.token).as_str())
        || headers
            .get("origin")
            .is_some_and(|v| v.to_str().ok() != Some(format!("http://127.0.0.1:{port}").as_str()))
    {
        return local_reply(403, json!({"error":"unauthorized"}));
    }
    let method = request.method().to_string();
    let path = request.uri().path().to_owned();
    let parsed = tokio::time::timeout(Duration::from_secs(5), async {
        let bytes = Limited::new(request.into_body(), 16 * 1024 * 1024)
            .collect()
            .await
            .map_err(|e| e.to_string())?
            .to_bytes();
        if bytes.is_empty() {
            Ok(json!({}))
        } else {
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())
        }
    })
    .await;
    let body = match parsed {
        Ok(Ok(body)) => body,
        Ok(Err(e)) => return local_reply(400, json!({"error":e})),
        Err(_) => return local_reply(408, json!({"error":"request timeout"})),
    };
    if method == "GET" && matches!(path.as_str(), "/api/events" | "/api/subscriptions/events") {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        tokio::spawn(async move {
            let subscriptions = path == "/api/subscriptions/events";
            let mut changes = s.subscriptions.subscribe();
            loop {
                let snapshot = if subscriptions {
                    json!(&*changes.borrow_and_update())
                } else {
                    match tokio::select! { _ = tx.closed() => return, v = s.status() => v } {
                        Ok(v) => v,
                        Err(_) => return,
                    }
                };
                if tx
                    .send(hyper::body::Bytes::from(format!(
                        "event: snapshot\ndata: {snapshot}\n\n"
                    )))
                    .await
                    .is_err()
                {
                    return;
                }
                tokio::select! {
                    _ = tx.closed() => return,
                    result = changes.changed(), if subscriptions => if result.is_err() { return; },
                    _ = tokio::time::sleep(Duration::from_secs(if subscriptions { 15 } else { 2 })) => {},
                }
            }
        });
        return hyper::Response::builder()
            .header("Content-Type", "text/event-stream")
            .header("Cache-Control", "no-store")
            .body(EventBody(rx).boxed())
            .unwrap();
    }
    let waiting = method == "POST"
        && (path == "/mcp" || path.starts_with("/mcp/"))
        && body["method"] == "tools/call"
        && is_wait(&body);
    let operation = async {
        if (path == "/mcp" || path.starts_with("/mcp/")) && method == "POST" {
            let ingress = if let Some(id) = path.strip_prefix("/mcp/") {
                s.ingress(id).await?
            } else {
                s.primary().await?
            };
            mcp_ingress(&ingress, body).await
        } else if method == "GET" && path == "/healthz" {
            Ok(
                json!({"runtime":"rust","instance":s.control.session,"pid":std::process::id(),"owner":"core","version":env!("ARC_BUILD_VERSION"),"build":load(&root().join("app/native.json"))?["build"]}),
            )
        } else if let Some(route) = path.strip_prefix("/api/") {
            if method != "GET" {
                if let Some(owner) = &desktop {
                    owner.check_write()?;
                }
            }
            let operation = match (route, method.as_str()) {
                ("service", "GET") => Some(DesktopRequest::ServiceGet),
                ("service", "POST") => Some(DesktopRequest::ServiceSet(body.clone())),
                ("subscriptions/open", "POST") => {
                    Some(DesktopRequest::SubscriptionsOpen(body.clone()))
                }
                _ if crate::management::desktop_route(route) => Some(DesktopRequest::Route(
                    route.into(),
                    method.clone(),
                    body.clone(),
                )),
                _ => None,
            };
            if let Some(operation) = operation {
                if let Some(desktop) = &desktop {
                    desktop.request(operation).await
                } else {
                    s.runtime.desktop_request(operation).await
                }
            } else {
                s.request(route, &method, body).await
            }
        } else {
            Err("not found".into())
        }
    };
    let result = if waiting {
        tokio::select! {
            biased;
            _ = wait_disconnect(&disconnect) => Err("wait disconnected".into()),
            result = operation => result,
        }
    } else {
        operation.await
    };
    match result {
        Ok(v) => local_reply(200, v),
        Err(e) => local_reply(400, json!({"error":e})),
    }
}
fn is_wait(request: &Value) -> bool {
    request["params"]["name"] == "query"
        && matches!(
            string(&request["params"]["arguments"], "op"),
            "codex_wait" | "agent_wait"
        )
}
async fn enabled_ops(s: &Arc<crate::ingress::Ingress>) -> Vec<Value> {
    let mut ops = Vec::new();
    for op in catalog()["ops"].as_array().unwrap() {
        if s.allows(string(op, "name")).await {
            ops.push(op.clone());
        }
    }
    ops
}

async fn call_tool(s: &Arc<crate::ingress::Ingress>, tool: &str, envelope: Value) -> Result<Value> {
    let name = if tool == "guide" {
        "guide"
    } else {
        string(&envelope, "op")
    };
    let mut args = if tool == "guide" {
        envelope.clone()
    } else {
        envelope["args"].clone()
    };
    let result = async {
        if !s.connected.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Connection closed".into());
        }
        let spec = catalog()["tools"].as_array().unwrap().iter().find(|t| t["name"] == tool)
            .ok_or("Unknown tool; call guide, query or act.")?;
        crate::validator("tool", tool, &spec["inputSchema"])?
            .validate(&envelope)
            .map_err(|e| json!({"code":"INVALID_ARGUMENTS","message":e.to_string(),"inputSchema":spec["inputSchema"],"guide":{"tool":"query","arguments":{"op":"guide","args":{}}}}).to_string())?;
        if tool != "guide" && name == "guide" {
            let spec = catalog()["ops"].as_array().unwrap().iter().find(|op| op["name"] == "guide").unwrap();
            if tool != "query" {
                return Err(json!({"code":"WRONG_TOOL","op":"guide","via":"query","example":crate::egress::example(spec)}).to_string());
            }
            crate::egress::validate_op(spec, &args)?;
        }
        let op_name = if name == "guide" { string(&args,"op") } else { name };
        if name != "guide" || args.get("op").is_some() {
            let op = catalog()["ops"].as_array().unwrap().iter().find(|op| op["name"] == op_name);
            let Some(op) = op else {
                return Err(crate::egress::unknown_op(op_name, &enabled_ops(s).await));
            };
            if !s.allows(op_name).await {
                return Err(json!({"code":"OP_UNAVAILABLE","op":op_name,"message":"This op is disabled by the ingress policy or unavailable on this device. Call guide for enabled ops."}).to_string());
            }
            if name != "guide" && tool != crate::egress::via(op) {
                return Err(json!({"code":"WRONG_TOOL","op":op_name,"message":"Use the op's assigned tool.","via":crate::egress::via(op),"example":crate::egress::example(op)}).to_string());
            }
        }
        if name == "guide" {
            return Ok(crate::egress::guide(&s.origin().await, &args, &crate::i18n::locale(), &enabled_ops(s).await));
        }
        if let Some(request_id) = envelope.get("requestId") {
            args["requestId"] = request_id.clone();
        }
        s.call(name, args.clone()).await
    }.await;
    let mut images = Vec::new();
    let mut reads = Vec::new();
    let (mut value, error) = match result {
        Ok(mut value) => {
            match crate::claude_notify::read_turns(&s.execution.control, name, &args, &value).await
            {
                Ok(turns) => reads = turns,
                Err(error) => crate::logs::record(
                    "WARN",
                    &format!("Inbox read tracking failed: {error}"),
                    None,
                ),
            }
            if matches!(name, "read" | "codex_read" | "codex_items" | "screen") {
                images = crate::images::take(&mut value);
            }
            (
                crate::kernel::results::page_output(crate::egress::receipt(value))?,
                false,
            )
        }
        Err(error) => (json!({"error":crate::egress::failure(&error)}), true),
    };
    if !error {
        let task = value["threadId"]
            .as_str()
            .or_else(|| value["taskId"].as_str())
            .or_else(|| args["taskId"].as_str())
            .unwrap_or("");
        let turn = value["turnId"].as_str().unwrap_or("");
        if !task.is_empty() && !turn.is_empty() && value["notification"] != "bind-failed" {
            match crate::claude_notify::read(task, turn) {
                Ok(notification) => value["notification"] = notification,
                Err(error) => {
                    value["notificationError"] = json!(error);
                }
            }
        }
        let available = crate::claude_notify::push_available(&value["notification"]);
        crate::egress::next(&mut value, name, &args, available);
    }
    let inbox = match crate::claude_notify::inbox(
        &s.id,
        &reads,
        s.origin().await["controlSource"] == "claude",
        args["notify"]["target"].as_str(),
    )
    .await
    {
        Ok(inbox) => inbox,
        Err(error) => {
            crate::logs::record("WARN", &format!("Inbox unavailable: {error}"), None);
            Value::Null
        }
    };
    if !inbox.is_null() {
        if !value.is_object() {
            value = json!({"value":value});
        }
        value["arcInbox"] = inbox;
    }
    let mut result = crate::egress::tool(value, error);
    result["content"].as_array_mut().unwrap().extend(images);
    Ok(result)
}
pub async fn mcp(s: &Arc<Service>, request: Value) -> Result<Value> {
    mcp_ingress(&s.primary().await?, request).await
}
pub async fn mcp_ingress(s: &Arc<crate::ingress::Ingress>, request: Value) -> Result<Value> {
    let origin = s.origin().await;
    crate::kernel::origin::ORIGIN
        .scope(origin, dispatch(s, request))
        .await
}
async fn dispatch(s: &Arc<crate::ingress::Ingress>, request: Value) -> Result<Value> {
    if request["jsonrpc"] != "2.0" {
        return Err("invalid jsonrpc".into());
    }
    s.observe_request("firstMcpRequestAt").await?;
    let id = request.get("id").cloned();
    let method = string(&request, "method");
    let result = match method {
        "initialize" => {
            let protocol = request["params"]["protocolVersion"]
                .as_str()
                .unwrap_or("2025-03-26");
            Ok(
                json!({"protocolVersion":if ["2024-11-05","2025-03-26","2025-06-18","2025-11-25"].contains(&protocol){protocol}else{"2025-03-26"},"capabilities":{"tools":{}},"serverInfo":{"name":"arc","version":env!("ARC_BUILD_VERSION")},"instructions":catalog()["instructions"]}),
            )
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools":catalog()["tools"]})),
        "tools/call" if is_wait(&request) => {
            let key = id.as_ref().ok_or("wait requires a request id")?.to_string();
            let (guard, mut cancel) = s.wait_calls.register(key)?;
            let args = request["params"]
                .get("arguments")
                .cloned()
                .unwrap_or(json!({}));
            let op_args = &args["args"];
            let started = std::time::Instant::now();
            let response = tokio::select! {
                result = call_tool(s, string(&request["params"], "name"), args.clone()) => result,
                _ = cancel.changed() => {
                    let mut value = json!({"state":"unconfirmed","reason":"wait-cancelled","threadId":op_args["threadId"],"turnId":op_args["turnId"],"runtimeStatus":"unknown","recordedStatus":null,"finalResponse":null,"interaction":[],"changed":false,"conditionMet":false,"observedAt":null,"returnedAt":now(),"elapsedMs":started.elapsed().as_millis() as u64});
                    if args["op"] == "agent_wait" {
                        value["agent"] = op_args["agent"].clone();
                        value["taskId"] = op_args["taskId"].clone();
                    }
                    Ok(crate::egress::tool(value, false))
                }
            };
            drop(guard);
            response
        }
        "tools/call" => {
            call_tool(
                s,
                string(&request["params"], "name"),
                request["params"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or(json!({})),
            )
            .await
        }
        "notifications/cancelled" => {
            s.wait_calls
                .cancel(&request["params"]["requestId"].to_string());
            return Ok(Value::Null);
        }
        "notifications/initialized" => return Ok(Value::Null),
        _ => Err("method not found".into()),
    };
    if id.is_none() {
        return Ok(Value::Null);
    }
    Ok(match result {
        Ok(v) => json!({"jsonrpc":"2.0","id":id,"result":v}),
        Err(e) => {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":if e=="method not found"{-32601}else{-32603},"message":e,"data":{"arcVersion":crate::egress::arc_version()}}})
        }
    })
}
pub async fn stdio() -> Result<()> {
    init_crypto();
    let port = std::env::var("ARC_NATIVE_PORT")
        .map_err(|_| "MCP must be launched by Agent Remote Control")?
        .parse::<u16>()
        .map_err(|_| "invalid port")?;
    let token = std::env::var("ARC_NATIVE_TOKEN").map_err(|_| "missing connector token")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let ingress = std::env::var("ARC_INGRESS_ID").map_err(|_| "missing ingress id")?;
    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut reader = BufReader::new(tokio::io::stdin());
    let mut jobs = tokio::task::JoinSet::new();
    loop {
        let bytes = crate::line(&mut reader, 16 * 1024 * 1024).await?;
        if bytes.is_empty() {
            break;
        }
        let request: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let (client, token, out) = (client.clone(), token.clone(), stdout.clone());
        let ingress = ingress.clone();
        jobs.spawn(async move {
            let response = client
                .post(format!("http://127.0.0.1:{port}/mcp/{ingress}"))
                .bearer_auth(token)
                .timeout(Duration::from_secs(if is_wait(&request) {
                    330
                } else {
                    120
                }))
                .json(&request)
                .send()
                .await;
            let value = match response {
                Ok(r) => r.json::<Value>().await.map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            };
            let response = match value {
                Ok(v) => v,
                Err(e) => {
                    json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32603,"message":e}})
                }
            };
            if request.get("id").is_some() && !response.is_null() {
                let mut out = out.lock().await;
                let _ = crate::output::async_line(&mut out, response).await;
            }
        });
        while jobs.try_join_next().is_some() {}
    }
    jobs.abort_all();
    Ok(())
}

pub async fn forward_request(route: &str, method: &str, body: Value) -> Result<Value> {
    crate::init_crypto();
    let unavailable = "无法连接本机 Core，请重新运行 CLI 或打开 Agent Remote Control。";
    let info = load(&root().join("app/native.json")).map_err(|_| unavailable)?;
    let port = info["port"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= 65535)
        .ok_or(unavailable)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    let health: Value = client
        .get(format!("http://127.0.0.1:{port}/healthz"))
        .bearer_auth(string(&info, "token"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map_err(|_| unavailable)?
        .error_for_status()
        .map_err(|_| unavailable)?
        .json()
        .await
        .map_err(|_| unavailable)?;
    if health["instance"] != info["instance"] {
        return Err(unavailable.into());
    }
    forward_to(&info, route, method, body).await
}
pub async fn forward_to(info: &Value, route: &str, method: &str, body: Value) -> Result<Value> {
    let port = info["port"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= 65535)
        .ok_or("invalid local endpoint")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut request = client
        .request(
            method.clone(),
            format!("http://127.0.0.1:{port}/api/{route}"),
        )
        .bearer_auth(string(&info, "token"))
        .timeout(Duration::from_secs(if route == "setup/wait" {
            body["timeout"].as_u64().unwrap_or(60).saturating_add(30)
        } else if route == "setup/apply"
            || route == "start"
            || route.ends_with("/start")
            || route.ends_with("/restart")
            || route.ends_with("/start-all")
            || route.starts_with("updates/")
        {
            360
        } else {
            120
        }));
    if method != reqwest::Method::GET {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    let success = response.status().is_success();
    let value: Value = response.json().await.map_err(|e| e.to_string())?;
    if success {
        Ok(value)
    } else {
        Err(string(&value, "error").into())
    }
}

// Stateless ingress has no MCP sessions. Active wait request IDs must be unique
// across callers; collisions are rejected rather than cancelling another wait.
#[derive(Default)]
pub(crate) struct WaitCalls(
    Arc<std::sync::Mutex<std::collections::HashMap<String, tokio::sync::watch::Sender<bool>>>>,
);
struct WaitCallGuard {
    calls:
        Arc<std::sync::Mutex<std::collections::HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    key: String,
}
impl Drop for WaitCallGuard {
    fn drop(&mut self) {
        self.calls.lock().unwrap().remove(&self.key);
    }
}
impl WaitCalls {
    fn register(&self, key: String) -> Result<(WaitCallGuard, tokio::sync::watch::Receiver<bool>)> {
        let mut calls = self.0.lock().unwrap();
        if calls.contains_key(&key) {
            return Err("duplicate active wait request id".into());
        }
        let (tx, rx) = tokio::sync::watch::channel(false);
        calls.insert(key.clone(), tx);
        Ok((
            WaitCallGuard {
                calls: self.0.clone(),
                key,
            },
            rx,
        ))
    }
    fn cancel(&self, key: &str) {
        if let Some(tx) = self.0.lock().unwrap().get(key) {
            let _ = tx.send(true);
        }
    }
}
