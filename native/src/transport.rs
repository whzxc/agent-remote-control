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
impl DesktopRequest {
    fn cancel_on_disconnect(&self) -> bool {
        matches!(self, Self::ServiceGet)
            || matches!(self, Self::Route(route, method, _) if method == "GET" || route == "app/snapshot")
    }
}

// Fail fast rather than retaining a queue of bodies and abandoned callers.
// Core forwarding and Desktop's HTTP/Tauri entrypoints each share this budget.
pub fn desktop_request_permit() -> Result<tokio::sync::SemaphorePermit<'static>> {
    static REQUESTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(16);
    REQUESTS.try_acquire().map_err(|_| {
        "DESKTOP_BUSY: Too many desktop requests are in flight. Wait for completion and read current state before retrying.".into()
    })
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
    let connections = Arc::new(tokio::sync::Semaphore::new(32));
    let job = tokio::spawn(async move {
        while let Ok((stream, peer)) = listener.accept().await {
            if !peer.ip().is_loopback() {
                continue;
            }
            let Ok(permit) = connections.clone().try_acquire_owned() else {
                // Do not spawn a task or retain a socket when the listener is full.
                continue;
            };
            let socket = stream.into_std().map_err(|e| e.to_string());
            let Ok(socket) = socket else { continue };
            let disconnect = socket
                .try_clone()
                .ok()
                .and_then(|s| TcpStream::from_std(s).ok());
            let (Ok(stream), Some(disconnect)) = (TcpStream::from_std(socket), disconnect) else {
                continue;
            };
            let disconnect = Arc::new(disconnect);
            let (owner, token) = (owner.clone(), token.clone());
            tokio::spawn(async move {
                let _permit = permit;
                let service = service_fn(move |request: Request<hyper::body::Incoming>| {
                    let (owner, token, disconnect) =
                        (owner.clone(), token.clone(), disconnect.clone());
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
                            let bytes = tokio::time::timeout(Duration::from_secs(5), Limited::new(request.into_body(), 65536).collect())
                                .await
                                .map_err(|_| "desktop request body timed out")?
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
                            if operation.cancel_on_disconnect() {
                                tokio::select! {
                                    biased;
                                    _ = wait_disconnect(&disconnect) => Err("desktop caller disconnected".into()),
                                    result = owner.request(operation) => result,
                                }
                            } else {
                                // Do not add explicit cancellation to mutation paths.
                                owner.request(operation).await
                            }
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
                    .timer(hyper_util::rt::TokioTimer::new())
                    .header_read_timeout(Duration::from_secs(5))
                    .keep_alive(false)
                    .max_buf_size(16384)
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
    let build = crate::runtime::process_build_id()?;
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
pub(crate) async fn wait_disconnect(stream: &TcpStream) {
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
    let sse = crate::wait_transport::accepts_sse(request.headers());
    let method = request.method().to_string();
    let path = request.uri().path().to_owned();
    let _desktop_permit = if path.strip_prefix("/api/").is_some_and(|route| {
        crate::management::desktop_route(route) || matches!(route, "service" | "subscriptions/open")
    }) {
        match desktop_request_permit() {
            Ok(permit) => Some(permit),
            Err(error) => return local_reply(503, json!({"error":error})),
        }
    } else {
        None
    };
    let timeline_after = if path.starts_with("/api/agents/timeline/") {
        request
            .uri()
            .query()
            .and_then(|q| q.split('&').find_map(|p| p.strip_prefix("after=")))
            .map(str::to_owned)
    } else {
        None
    };
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
    let mut body = match parsed {
        Ok(Ok(body)) => body,
        Ok(Err(e)) => return local_reply(400, json!({"error":e})),
        Err(_) => return local_reply(408, json!({"error":"request timeout"})),
    };
    if let Some(after) = timeline_after {
        match after.parse::<u64>() {
            Ok(after) => body["after"] = json!(after),
            Err(_) => return local_reply(400, json!({"error":"INVALID_TIMELINE_CURSOR"})),
        }
    }
    if method == "GET"
        && matches!(
            path.as_str(),
            "/api/events" | "/api/subscriptions/events" | "/api/agents/activity/events"
        )
    {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        tokio::spawn(async move {
            let subscriptions = path == "/api/subscriptions/events";
            let activity = path == "/api/agents/activity/events";
            let mut previous = Value::Null;
            let mut changes = s.subscriptions.subscribe();
            loop {
                let snapshot = if activity {
                    s.agents.activity(&s.control).await
                } else if subscriptions {
                    json!(&*changes.borrow_and_update())
                } else {
                    match tokio::select! { _ = tx.closed() => return, v = s.status() => v } {
                        Ok(v) => v,
                        Err(_) => return,
                    }
                };
                let mut comparison = snapshot.clone();
                if activity {
                    comparison.as_object_mut().unwrap().remove("observedAt");
                }
                if !activity || comparison != previous {
                    previous = comparison;
                    if tx
                        .send(hyper::body::Bytes::from(format!(
                            "event: snapshot\ndata: {snapshot}\n\n"
                        )))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                tokio::select! {
                    _ = tx.closed() => return,
                    result = changes.changed(), if subscriptions => if result.is_err() { return; },
                    _ = tokio::time::sleep(Duration::from_secs(if subscriptions { 15 } else if activity { 1 } else { 2 })) => {},
                }
            }
        });
        return hyper::Response::builder()
            .header("Content-Type", "text/event-stream")
            .header("Cache-Control", "no-store")
            .body(EventBody(rx).boxed())
            .unwrap();
    }
    if method == "POST" && (path == "/mcp" || path.starts_with("/mcp/")) && is_wait(&body) {
        let ingress = if let Some(id) = path.strip_prefix("/mcp/") {
            s.ingress(id).await
        } else {
            s.primary().await
        };
        let ingress = match ingress {
            Ok(v) => v,
            Err(e) => return local_reply(400, json!({"error":e})),
        };
        let request = body.clone();
        return crate::wait_transport::stream(
            &body,
            sse,
            async move { mcp_ingress(&ingress, request).await },
            async move { wait_disconnect(&disconnect).await },
        );
    }
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
        } else if path == "/api/cli/control" && method == "POST" {
            local_control(&s, body).await
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
                let cancel = operation.cancel_on_disconnect();
                let response = async {
                    if let Some(desktop) = &desktop {
                        desktop.request(operation).await
                    } else {
                        s.runtime.desktop_request(operation).await
                    }
                };
                if cancel {
                    tokio::select! {
                        biased;
                        _ = wait_disconnect(&disconnect) => Err("desktop caller disconnected".into()),
                        result = response => result,
                    }
                } else {
                    response.await
                }
            } else {
                s.request(route, &method, body).await
            }
        } else {
            Err("not found".into())
        }
    };
    let result = operation.await;
    match result {
        Ok(v) => local_reply(200, v),
        Err(e) => local_reply(400, json!({"error":e})),
    }
}
pub(crate) fn is_wait(request: &Value) -> bool {
    request["method"] == "tools/call"
        && request["params"]["name"] == "query"
        && matches!(
            string(&request["params"]["arguments"], "op"),
            "codex_wait" | "agent_wait" | "inbox_wait"
        )
}
// Both transports use this exact validator, dispatcher and output projection.
// Local CLI is an execution identity, never an ingress registry entry.
enum ControlSource<'a> {
    Ingress(&'a Arc<crate::ingress::Ingress>),
    Local(&'a Arc<crate::execution::Execution>),
}
impl ControlSource<'_> {
    fn execution(&self) -> &Arc<crate::execution::Execution> {
        match self {
            Self::Ingress(s) => &s.execution,
            Self::Local(s) => s,
        }
    }
    fn connected(&self) -> bool {
        match self {
            Self::Ingress(s) => s.connected.load(std::sync::atomic::Ordering::SeqCst),
            Self::Local(_) => true,
        }
    }
    async fn origin(&self) -> Value {
        match self {
            Self::Ingress(s) => s.origin().await,
            Self::Local(_) => crate::kernel::origin::current_origin(),
        }
    }
    async fn allows(&self, name: &str) -> bool {
        match self {
            Self::Ingress(s) => s.allows(name).await,
            Self::Local(s) => s.available(name).await,
        }
    }
    async fn call(&self, name: &str, args: Value) -> Result<Value> {
        match self {
            Self::Ingress(s) => s.call(name, args).await,
            Self::Local(s) => {
                if name == "connector_verify" {
                    let spec = catalog()["ops"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|o| o["name"] == name)
                        .unwrap();
                    crate::egress::validate_op(spec, &args)?;
                    return Ok(
                        json!({"received":true,"code":args["code"],"origin":self.origin().await}),
                    );
                }
                s.call(name, args, json!("all")).await
            }
        }
    }
}
async fn local_control(s: &Arc<Service>, body: Value) -> Result<Value> {
    let source = ControlSource::Local(&s.execution);
    let name = string(&body, "op");
    let tool = if name == "guide" {
        "query"
    } else {
        catalog()["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["name"] == name)
            .map(crate::egress::via)
            .unwrap_or("query")
    };
    let mut args = body.get("args").cloned().unwrap_or(json!({}));
    let replacement = if matches!(name, "codex_send" | "codex_resume") {
        crate::app_replace::continuation_context(name, &args)?
    } else {
        None
    };
    let mut origin = if let Some(context) = &replacement {
        if name == "codex_send" {
            if args.get("notify").is_none() {
                args["notify"] = context["notify"].clone();
            }
            args["purpose"] = context["purpose"].clone();
        }
        // codex_resume owns notification inheritance and accepts no new input/settings.
        context["origin"].clone()
    } else {
        crate::sources::local_origin().await?
    };
    origin["controlTransport"] = json!("cli");
    if matches!(
        name,
        "codex_create" | "codex_send" | "agent_create" | "agent_send"
    ) {
        if let Some(fields) = args.as_object_mut() {
            fields.entry("purpose").or_insert(json!("self-test"));
            fields.entry("notify").or_insert(Value::Null);
        }
    }
    let envelope = if tool == "guide" {
        args
    } else {
        let mut envelope = json!({"op":name,"args":args});
        if let Some(request) = body.get("requestId") {
            envelope["requestId"] = request.clone();
        }
        envelope
    };
    crate::kernel::origin::ORIGIN
        .scope(
            origin,
            crate::dispatch_caller::CALLER.scope(
                crate::dispatch_caller::validated(&body["caller"]),
                call_tool(&source, tool, envelope),
            ),
        )
        .await
}
async fn enabled_ops(s: &ControlSource<'_>) -> Vec<Value> {
    let mut ops = Vec::new();
    for op in catalog()["ops"].as_array().unwrap() {
        if s.allows(string(op, "name")).await {
            ops.push(op.clone());
        }
    }
    ops
}

async fn call_tool(s: &ControlSource<'_>, tool: &str, envelope: Value) -> Result<Value> {
    let metric = crate::control_metrics::Call::new(&s.origin().await, tool, &envelope);
    let mut response = call_tool_inner(s, tool, envelope).await;
    if crate::sources::minimal_text(string(&s.origin().await, "sourceId")) {
        if let Ok(response) = &mut response {
            crate::egress::minimal_text(response);
        }
    }
    metric.finish(&response).await;
    response
}

async fn call_tool_inner(s: &ControlSource<'_>, tool: &str, envelope: Value) -> Result<Value> {
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
    let summary = crate::task_summary::requested(name, &args);
    let mut wait_limit = None;
    let result = async {
        if !s.connected() {
            return Err("Connection closed".into());
        }
        let spec = catalog()["tools"].as_array().unwrap().iter().find(|t| t["name"] == tool)
            .ok_or("Unknown tool; call guide, query or act.")?;
        if let (true, Some(topic)) = (tool == "guide", envelope["topic"].as_str()) {
            let accepts = |schema: &Value| schema["properties"]["topic"]["enum"].as_array().is_some_and(|topics| topics.iter().any(|t| t == topic));
            let op = catalog()["ops"].as_array().unwrap().iter().find(|op| op["name"] == "guide").unwrap();
            if !accepts(&spec["inputSchema"]) && accepts(&op["inputSchema"]) {
                return Err(json!({"code":"WRONG_TOOL","op":"guide","field":"/topic","via":"query",
                    "message":"The frozen guide tool accepts only its original topics; read this topic through query guide.",
                    "next":{"via":"query","op":"guide","args":{"topic":topic},"hint":"Read this topic through query guide with the same topic."}}).to_string());
            }
        }
        crate::validator("tool", tool, &spec["inputSchema"])?
            .validate(&envelope)
            .map_err(|e| crate::egress::validation_error("", &spec["inputSchema"], &e))?;
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
        crate::coordination::bulletin::authenticated_activity();
        if name == "guide" {
            return Ok(crate::egress::guide(&s.origin().await, &args, &crate::i18n::locale(), &enabled_ops(s).await));
        }
        if let Some(request_id) = envelope.get("requestId") {
            args["requestId"] = request_id.clone();
        }
        if matches!(name, "codex_wait" | "agent_wait" | "inbox_wait") {
            let op = catalog()["ops"].as_array().unwrap().iter().find(|op| op["name"] == name).unwrap();
            crate::egress::validate_op(op, &args)?;
            wait_limit = crate::control_sources::limit_wait(&s.origin().await, &mut args);
        }
        s.call(name, args.clone()).await
    }.await;
    let mut images = Vec::new();
    let mut reads = Vec::new();
    let (mut value, error) = match result {
        Ok(mut value) => {
            if matches!(
                name,
                "codex_read" | "codex_wait" | "agent_read" | "agent_wait"
            ) && value["state"].is_string()
                && value["operation"].is_null()
            {
                value["stateScope"] = json!("turn");
            }
            if let Some(limit) = wait_limit {
                value["waitLimit"] = limit;
            }
            match crate::claude_notify::read_turns(&s.execution().control, name, &args, &value)
                .await
            {
                Ok(turns) => reads = turns,
                Err(error) => crate::logs::record(
                    "WARN",
                    &format!("Inbox read tracking failed: {error}"),
                    None,
                ),
            }
            if matches!(name, "codex_wait" | "agent_wait") {
                crate::waiter::compact_response(&mut value, &args);
            }
            if matches!(name, "read" | "codex_read" | "codex_items" | "screen") {
                images = crate::images::take(&mut value);
            }
            let mut value = crate::egress::receipt(value);
            if args["includeOrigin"] != true {
                crate::egress::control_source(name, &mut value);
            }
            let outcome = crate::egress::outcome_error(&value);
            if let Some(reason) = &outcome {
                value["error"] = reason.clone();
            }
            let mut paged = if summary || matches!(name, "guide" | "control_output") {
                value.clone()
            } else {
                crate::kernel::results::page_output(
                    value.clone(),
                    if args["view"] == "full" {
                        64 * 1024
                    } else {
                        12 * 1024
                    },
                )?
            };
            if outcome.is_some() && paged["outputId"].is_string() {
                for key in ["requestId", "state", "error", "threadId", "turnId"] {
                    if let Some(field) = value.get(key) {
                        paged[key] = field.clone();
                    }
                }
            }
            (paged, outcome.is_some())
        }
        Err(error) => (json!({"error":crate::egress::failure(&error)}), true),
    };
    crate::sources::decorate(&mut value);
    if !error {
        let task = value["threadId"]
            .as_str()
            .or_else(|| value["taskId"].as_str())
            .or_else(|| args["taskId"].as_str())
            .unwrap_or("")
            .to_owned();
        let turn = value["turnId"].as_str().unwrap_or("").to_owned();
        if crate::egress::dispatch_receipt(&value)
            && !task.is_empty()
            && !turn.is_empty()
            && value["notification"] != "bind-failed"
        {
            let since = if matches!(string(&value, "operation"), "send" | "create") {
                value["createdAt"].as_str()
            } else {
                None
            };
            match crate::claude_notify::read_since(&task, &turn, since) {
                Ok(notification) => value["notification"] = notification,
                Err(error) => {
                    value["notificationError"] = json!(error);
                }
            }
        }
        if !task.is_empty() && !turn.is_empty() {
            if let Ok(retry) = crate::claude_notify::retry_status(&task, &turn) {
                if !retry.is_null() {
                    value["retry"] = retry;
                }
            }
        }
        let available = crate::claude_notify::push_available(&value["notification"]);
        crate::egress::next(&mut value, name, &args, available);
    }
    if error {
        crate::egress::next(&mut value, name, &args, false);
        if summary {
            value = crate::task_summary::project(name, &args, &value);
        }
        return Ok(crate::egress::tool(value, true));
    }
    if summary {
        value = crate::task_summary::project(name, &args, &value);
    }
    let inbox = if summary
        || (name == "dispatch_policy" && args["view"] != "full")
        || (name == "guide" && value["profile"]["name"] == "local-code")
        || name == "inbox_wait"
    {
        Value::Null
    } else {
        match crate::claude_notify::inbox(
            string(&s.origin().await, "sourceId"),
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
        }
    };
    if !inbox.is_null() && !(name == "codex_read" && args["view"] == "review") {
        if !value.is_object() {
            value = json!({"value":value});
        }
        value["arcInbox"] = crate::kernel::results::page_output(inbox, 4096)?;
    }
    let mut result = crate::egress::tool(value, error);
    result["content"].as_array_mut().unwrap().extend(images);
    Ok(result)
}
pub async fn mcp(s: &Arc<Service>, request: Value) -> Result<Value> {
    mcp_ingress(&s.primary().await?, request).await
}
pub async fn mcp_ingress(s: &Arc<crate::ingress::Ingress>, request: Value) -> Result<Value> {
    // This entry point is behind authenticated local management / native IPC.
    let principal = json!({"type":"ingress","ingressId":s.id});
    mcp_ingress_authenticated(s, request, &principal, None).await
}
pub(crate) async fn mcp_ingress_authenticated(
    s: &Arc<crate::ingress::Ingress>,
    request: Value,
    principal: &Value,
    header: Option<&str>,
) -> Result<Value> {
    let (local, enabled) = {
        let meta = s.meta.lock().await;
        (meta["transport"] == "local", meta["enabled"] == true)
    };
    if local && (!s.connected.load(std::sync::atomic::Ordering::SeqCst) || !enabled) {
        return Err("Local connection disabled".into());
    }
    let mut origin = s.principal_origin(principal).await?;
    if let Ok(principal) = crate::claude_notify::mcp_events::principal(s, header).await {
        origin["eventPrincipal"] = json!(principal);
    }
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
    if matches!(
        method,
        "server/discover"
            | "initialize"
            | "tools/list"
            | "events/list"
            | "events/subscribe"
            | "events/unsubscribe"
    ) {
        let version = string(&request["params"], "protocolVersion");
        let version = if [
            "2024-11-05",
            "2025-03-26",
            "2025-06-18",
            "2025-11-25",
            "2026-07-28",
        ]
        .contains(&version)
        {
            version
        } else {
            "unspecified"
        };
        s.log(
            "INFO",
            &format!("MCP protocol request: {method}; version={version}"),
        )
        .await;
    }
    let result = match method {
        "server/discover" => Ok(
            json!({"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{"tools":{},"events":{}},"serverInfo":{"name":"arc","version":env!("ARC_BUILD_VERSION")},"instructions":catalog()["instructions"]}),
        ),
        "events/list" | "events/subscribe" | "events/unsubscribe" if id.is_some() => {
            let result =
                crate::claude_notify::mcp_events::request(s, method, &request["params"]).await;
            let outcome = match &result {
                Ok(_) => "accepted".to_owned(),
                Err(error) => serde_json::from_str::<Value>(error)
                    .ok()
                    .and_then(|v| v["data"]["reason"].as_str().map(str::to_owned))
                    .unwrap_or_else(|| "internal_error".into()),
            };
            s.log(
                "INFO",
                &format!("MCP event operation: {method}; result={outcome}"),
            )
            .await;
            result
        }
        "initialize" => {
            let protocol = request["params"]["protocolVersion"]
                .as_str()
                .unwrap_or("2025-03-26");
            Ok(
                json!({"protocolVersion":if ["2024-11-05","2025-03-26","2025-06-18","2025-11-25","2026-07-28"].contains(&protocol){protocol}else{"2025-03-26"},"capabilities":if protocol == "2026-07-28" {json!({"tools":{},"events":{}})} else {json!({"tools":{}})},"serverInfo":{"name":"arc","version":env!("ARC_BUILD_VERSION")},"instructions":catalog()["instructions"]}),
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
            let source = ControlSource::Ingress(s);
            let response = tokio::select! {
                result = call_tool(&source, string(&request["params"], "name"), args.clone()) => result,
                _ = cancel.changed() => {
                    let mut value = json!({"state":"unconfirmed","reason":"wait-cancelled","threadId":op_args["threadId"],"turnId":op_args["turnId"],"runtimeStatus":"unknown","recordedStatus":null,"finalResponse":null,"interaction":[],"changed":false,"conditionMet":false,"observedAt":null,"returnedAt":now(),"elapsedMs":started.elapsed().as_millis() as u64});
                    if args["op"] == "inbox_wait" {
                        value = json!({"state":"unconfirmed","reason":"wait-cancelled","events":[],"unread":0});
                    }
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
                &ControlSource::Ingress(s),
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
            let error = serde_json::from_str::<Value>(&e).ok().filter(|e|e["code"].is_i64() && e["message"].is_string()).unwrap_or_else(||json!({"code":if e=="method not found"{-32601}else{-32603},"message":e,"data":{"arcVersion":crate::egress::arc_version()}}));
            json!({"jsonrpc":"2.0","id":id,"error":error})
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
    let ingress = std::env::var("ARC_INGRESS_ID").map_err(|_| "missing ingress id")?;
    stdio_connection(port, token, ingress).await
}
pub(crate) async fn stdio_connection(port: u16, token: String, ingress: String) -> Result<()> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
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
                .bearer_auth(&token)
                .header("Accept", "application/json, text/event-stream")
                .timeout(Duration::from_secs(if is_wait(&request) {
                    1830
                } else if matches!(
                    request["params"]["arguments"]["op"].as_str(),
                    Some("context_amend" | "context_check")
                ) {
                    // Leave room for the provider's 120-second deadline and response delivery.
                    150
                } else {
                    120
                }))
                .json(&request)
                .send()
                .await;
            let value = match response {
                Ok(r)
                    if r.headers()
                        .get("content-type")
                        .is_some_and(|v| v == "text/event-stream") =>
                {
                    crate::wait_transport::forward_sse(r, &out).await
                }
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
                let replacement = &response["result"]["structuredContent"]["result"];
                let update_submit = request["params"]["name"] == "act"
                    && request["params"]["arguments"]["op"] == "update_request"
                    && request["params"]["arguments"]["args"]["action"] == "submit";
                let acknowledgment = if update_submit {
                    crate::app_replace::acknowledgment_id("app.replace", replacement)
                        .map(str::to_owned)
                } else {
                    None
                };
                if crate::output::async_line(&mut out, response).await.is_ok() {
                    if let Some(id) = acknowledgment {
                        let _ = client
                            .post(format!("http://127.0.0.1:{port}/api/app/replace/ack"))
                            .bearer_auth(&token)
                            .json(&json!({"id":id}))
                            .send()
                            .await;
                    }
                }
            }
        });
        while jobs.try_join_next().is_some() {}
    }
    jobs.abort_all();
    Ok(())
}

pub async fn forward_request(route: &str, method: &str, body: Value) -> Result<Value> {
    crate::init_crypto();
    let unavailable =
        "Cannot connect to local Core. Run the CLI again or open Agent Remote Control.";
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

#[cfg(test)]
mod desktop_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct Finished(tokio::sync::mpsc::UnboundedSender<()>);
    impl Drop for Finished {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }
    struct HoldingDesktop {
        started: tokio::sync::mpsc::UnboundedSender<()>,
        finished: tokio::sync::mpsc::UnboundedSender<()>,
        release: Arc<tokio::sync::Notify>,
    }
    impl DesktopAccess for HoldingDesktop {
        fn check_write(&self) -> Result<()> {
            Ok(())
        }
        fn request(
            &self,
            operation: DesktopRequest,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send>> {
            let (started, finished, release) = (
                self.started.clone(),
                self.finished.clone(),
                self.release.clone(),
            );
            Box::pin(async move {
                let _permit = desktop_request_permit()?;
                if matches!(&operation, DesktopRequest::Route(route, _, _) if route == "app") {
                    return Ok(json!({"build":crate::runtime::process_build_id()?}));
                }
                let _finished = Finished(finished);
                started.send(()).unwrap();
                release.notified().await;
                Ok(json!({"completed":true}))
            })
        }
    }
    async fn signal(receiver: &mut tokio::sync::mpsc::UnboundedReceiver<()>) {
        tokio::time::timeout(Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
            .unwrap();
    }
    async fn connect(endpoint: &Value, method: &str, route: &str) -> TcpStream {
        let port = endpoint["port"].as_u64().unwrap();
        let mut stream = TcpStream::connect(format!("127.0.0.1:{port}"))
            .await
            .unwrap();
        stream.write_all(format!("{method} /api/{route} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", string(endpoint, "token")).as_bytes()).await.unwrap();
        stream
    }

    #[tokio::test]
    async fn desktop_requests_are_bounded_and_abandoned_reads_release_their_work() {
        // Regression: Desktop had no admission bound while synchronous executable hashing prevented cancellation.
        crate::init_crypto();
        let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
        let (finished, mut finishes) = tokio::sync::mpsc::unbounded_channel();
        let release = Arc::new(tokio::sync::Notify::new());
        let (endpoint, listener) = listen_desktop(Arc::new(HoldingDesktop {
            started,
            finished,
            release: release.clone(),
        }))
        .await
        .unwrap();
        let mut sockets = Vec::new();
        for _ in 0..16 {
            sockets.push(connect(&endpoint, "GET", "permissions/desktop").await);
            signal(&mut starts).await;
        }
        let rejected = tokio::time::timeout(
            Duration::from_secs(2),
            forward_to(&endpoint, "app", "GET", json!({})),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(rejected.starts_with("DESKTOP_BUSY:"));
        drop(sockets.pop());
        signal(&mut finishes).await;
        let identity = forward_to(&endpoint, "app", "GET", json!({}))
            .await
            .unwrap();
        assert_eq!(
            identity["build"],
            crate::runtime::process_build_id().unwrap()
        );
        drop(sockets);
        for _ in 0..15 {
            signal(&mut finishes).await;
        }

        // Snapshot cancellation must also remove work queued behind another capture.
        let snapshot = connect(&endpoint, "POST", "app/snapshot").await;
        signal(&mut starts).await;
        drop(snapshot);
        signal(&mut finishes).await;

        // Mutation dispatch still returns the completed operation's response.
        let mut write = connect(&endpoint, "POST", "updates/check").await;
        signal(&mut starts).await;
        release.notify_waiters();
        let mut response = String::new();
        tokio::time::timeout(Duration::from_secs(2), write.read_to_string(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        assert_eq!(
            serde_json::from_str::<Value>(response.split("\r\n\r\n").nth(1).unwrap()).unwrap(),
            json!({"completed":true})
        );
        signal(&mut finishes).await;

        // Idle sockets cannot create an unbounded number of per-connection tasks.
        let port = endpoint["port"].as_u64().unwrap();
        let mut idle = Vec::new();
        for _ in 0..32 {
            idle.push(
                TcpStream::connect(format!("127.0.0.1:{port}"))
                    .await
                    .unwrap(),
            );
        }
        let mut overflow = TcpStream::connect(format!("127.0.0.1:{port}"))
            .await
            .unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(2), overflow.read(&mut [0; 1]))
            .await
            .unwrap();
        assert!(ended.is_err() || ended.unwrap() == 0);
        drop(idle);
        listener.abort();
    }
}
