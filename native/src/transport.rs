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
    service.execution.front_door.bind(&service);
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
        &json!({"port":port,"pid":std::process::id(),"processStart":crate::codex_host::process_start(std::process::id()),"token":service.token,"instance":service.control.session,"runtime":"rust","version":env!("ARC_BUILD_VERSION"),"owner":"core","daemon":service.runtime.daemon.load(std::sync::atomic::Ordering::SeqCst),"build":build}),
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
    let validator = request
        .headers()
        .get("if-none-match")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
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
    let timeline_query = path
        .starts_with("/api/agents/timeline/")
        .then(|| request.uri().query().unwrap_or_default().to_owned());
    let parsed = tokio::time::timeout(Duration::from_secs(5), async {
        let bytes = Limited::new(
            request.into_body(),
            if path == "/api/pets/import" {
                35 * 1024 * 1024
            } else {
                16 * 1024 * 1024
            },
        )
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
    if let Some(query) = timeline_query {
        for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
            match key.as_ref() {
                "after" => match value.parse::<u64>() {
                    Ok(after) => body["after"] = json!(after),
                    Err(_) => return local_reply(400, json!({"error":"INVALID_TIMELINE_CURSOR"})),
                },
                "recent" if value == "1" => body["recent"] = json!(true),
                _ => {}
            }
        }
    }
    if method == "GET"
        && matches!(
            path.as_str(),
            "/api/events"
                | "/api/browser/events"
                | "/api/subscriptions/events"
                | "/api/agents/activity/events"
        )
    {
        let kind = match path.as_str() {
            "/api/subscriptions/events" => crate::front_door::Snapshot::Subscriptions,
            "/api/agents/activity/events" => crate::front_door::Snapshot::Activity,
            "/api/browser/events" => crate::front_door::Snapshot::Browser,
            _ => crate::front_door::Snapshot::Status,
        };
        let rx = match crate::front_door::local_stream(&s, kind).await {
            Ok(rx) => rx,
            Err(error) => return local_reply(400, json!({"error":error})),
        };
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
            async move { crate::front_door::mcp_ingress(&ingress, request).await },
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
            crate::front_door::mcp_ingress(&ingress, body).await
        } else if method == "GET" && path == "/healthz" {
            crate::front_door::health(&s).await
        } else if path == "/api/cli/control" && method == "POST" {
            crate::front_door::local_control(&s, body).await
        } else if let Some(route) = path.strip_prefix("/api/") {
            let cancel = method == "GET" || route == "app/snapshot";
            let response =
                crate::front_door::management(&s, desktop.as_ref(), route, &method, body);
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
            Err("not found".into())
        }
    };
    let result = operation.await;
    match result {
        Ok(v)
            if path.starts_with("/api/")
                && (method == "GET"
                    || matches!(
                        path.as_str(),
                        "/api/agents/conversations"
                            | "/api/agents/conversations/timeline"
                            | "/api/tasks/reviews"
                    )) =>
        {
            use http_body_util::Full;
            let bytes = serde_json::to_vec(&v).unwrap();
            let etag = format!("\"{}\"", hash(&bytes));
            let unchanged = crate::browser::not_modified(validator.as_deref(), &etag);
            hyper::Response::builder()
                .status(if unchanged { 304 } else { 200 })
                .header("Content-Type", "application/json")
                .header("Cache-Control", "no-store")
                .header("ETag", etag)
                .body(
                    Full::new(hyper::body::Bytes::from(if unchanged {
                        Vec::new()
                    } else {
                        bytes
                    }))
                    .boxed(),
                )
                .unwrap()
        }
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
        let mut write = connect(&endpoint, "POST", "permissions/notify").await;
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
