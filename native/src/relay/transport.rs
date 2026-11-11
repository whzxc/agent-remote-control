use super::identity::Identity;
use crate::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use std::{collections::HashMap, sync::atomic::Ordering, time::Duration};
use tokio::sync::{mpsc, watch, Semaphore};
use tokio_tungstenite::{
    tungstenite::{
        protocol::{Role, WebSocketConfig},
        Message,
    },
    WebSocketStream,
};

pub(crate) struct Runtime {
    task: tokio::task::JoinHandle<()>,
    pub status: watch::Receiver<Value>,
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Runtime {
    pub async fn stop(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
    }
    pub async fn ready(mut status: watch::Receiver<Value>) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                if status.borrow()["state"] == "ready" {
                    return Ok(());
                }
                status
                    .changed()
                    .await
                    .map_err(|_| "Relay connection stopped".to_owned())?;
            }
        })
        .await
        .map_err(|_| {
            format!(
                "Relay connection not ready: {}",
                string(&status.borrow(), "error")
            )
        })?
    }
}
pub(crate) fn start(
    ingress: &Arc<crate::ingress::Ingress>,
    origin: String,
    local: String,
) -> Runtime {
    let (status, receiver) = watch::channel(json!({"state":"connecting","error":""}));
    let weak = Arc::downgrade(ingress);
    let task = tokio::spawn(async move {
        let mut delay = 1;
        loop {
            let Some(ingress) = weak.upgrade() else { break };
            let started = std::time::Instant::now();
            let result = connect(&ingress, &origin, &local, &status).await;
            ingress.connected.store(false, Ordering::SeqCst);
            let error = result.err().unwrap_or_else(|| "Relay disconnected".into());
            if started.elapsed() > Duration::from_secs(60) {
                delay = 1;
            }
            status.send_replace(json!({"state":"reconnecting","error":error,"retrySeconds":delay}));
            drop(ingress);
            tokio::time::sleep(Duration::from_secs(delay)).await;
            delay = (delay * 2).min(60);
        }
    });
    Runtime {
        task,
        status: receiver,
    }
}
pub(super) async fn client(proxy: &crate::proxy::NetworkProxy) -> Result<reqwest::Client> {
    proxy
        .client(reqwest::Client::builder())
        .http1_only()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}
pub(super) struct ControlError {
    pub status: Option<reqwest::StatusCode>,
    message: String,
}

impl From<String> for ControlError {
    fn from(message: String) -> Self {
        Self {
            status: None,
            message,
        }
    }
}

impl From<ControlError> for String {
    fn from(error: ControlError) -> Self {
        error.message
    }
}

async fn envelope(
    client: &reqwest::Client,
    origin: &str,
    identity: &Identity,
    payload: &Value,
) -> std::result::Result<Value, ControlError> {
    let response = client
        .post(format!("{origin}/challenge"))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Cannot reach relay challenge endpoint: {}", e.without_url()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(ControlError {
            status: Some(status),
            message: format!("Relay challenge HTTP {status}"),
        });
    }
    let challenge: Value = response
        .json()
        .await
        .map_err(|_| "Invalid relay challenge".to_owned())?;
    Ok(identity.envelope(origin, string(&challenge, "challenge"), payload))
}
pub(super) async fn wait_deployed(client: &reqwest::Client, origin: &str) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(60), async {
        let mut delay = 1;
        loop {
            // A fresh workers.dev route can return 404 briefly after Wrangler
            // succeeds. Only retry this challenge, not signed management writes.
            if let Ok(response) = client.post(format!("{origin}/challenge")).timeout(Duration::from_secs(10)).send().await {
                if response.status().is_success() {
                    if let Ok(value) = response.json::<Value>().await {
                        if value["version"] == env!("ARC_BUILD_VERSION") && value["challenge"].is_string() { return; }
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(delay)).await;
            delay = (delay * 2).min(8);
        }
    }).await.map_err(|_| "Worker deployed, but workers.dev is not ready after 60 seconds; check proxy and retry relay.redeploy".into())
}
pub(super) async fn control(
    client: &reqwest::Client,
    origin: &str,
    identity: &Identity,
    payload: Value,
) -> std::result::Result<Value, ControlError> {
    let auth = envelope(client, origin, identity, &payload).await?;
    let response = client
        .post(format!("{origin}/control"))
        .json(&auth)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "Relay management request failed; read status before retrying".to_owned())?;
    let status = response.status();
    match response.json::<Value>().await {
        Ok(value) if status.is_success() => Ok(value),
        result => Err(ControlError {
            status: Some(status),
            message: match result {
                Ok(value) => format!("Relay HTTP {status}: {}", string(&value, "error")),
                Err(_) => "Invalid relay management response".into(),
            },
        }),
    }
}

/// Members have no Cloudflare credentials. A missing root and challenge together
/// distinguish a removed Worker from one missing management route.
pub(super) async fn worker_missing(client: &reqwest::Client, origin: &str) -> Result<bool> {
    for (method, path) in [
        (reqwest::Method::GET, "/"),
        (reqwest::Method::POST, "/challenge"),
    ] {
        let response = client
            .request(method, format!("{origin}{path}"))
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| format!("Cannot confirm missing relay Worker: {}", e.without_url()))?;
        if response.status() != reqwest::StatusCode::NOT_FOUND {
            return Ok(false);
        }
    }
    Ok(true)
}
pub(crate) async fn upgrade(
    client: &reqwest::Client,
    origin: &str,
    instance_id: &str,
    auth: &Value,
) -> Result<WebSocketStream<reqwest::Upgraded>> {
    let key = tokio_tungstenite::tungstenite::handshake::client::generate_key();
    let response = client
        .get(format!("{origin}/connect/{}", instance_id))
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", &key)
        .header("x-arc-auth", auth.to_string())
        .timeout(Duration::from_secs(25))
        .send()
        .await
        .map_err(|_| "Relay WebSocket connection failed")?;
    if response.status() != 101
        || response
            .headers()
            .get("sec-websocket-accept")
            .and_then(|v| v.to_str().ok())
            != Some(
                tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes())
                    .as_str(),
            )
    {
        return Err(format!(
            "Relay WebSocket upgrade rejected: HTTP {}",
            response.status()
        ));
    }
    let socket = response
        .upgrade()
        .await
        .map_err(|_| "Relay WebSocket upgrade failed")?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(65536))
        .max_frame_size(Some(65536));
    let ws = WebSocketStream::from_raw_socket(socket, Role::Client, Some(config)).await;
    Ok(ws)
}
async fn send_frame<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    ws: &mut WebSocketStream<S>,
    frame: String,
) -> Result<()> {
    tokio::time::timeout(
        Duration::from_secs(15),
        ws.send(Message::Text(frame.into())),
    )
    .await
    .map_err(|_| "Relay send timed out")?
    .map_err(|_| "Relay send failed".into())
}
struct RequestState {
    body: Option<mpsc::Sender<std::result::Result<Vec<u8>, std::io::Error>>>,
    credit: Arc<Semaphore>,
    abort: tokio::task::AbortHandle,
}
async fn connect(
    ingress: &Arc<crate::ingress::Ingress>,
    origin: &str,
    local: &str,
    status: &watch::Sender<Value>,
) -> Result<()> {
    let identity = Identity::instance()?;
    if ingress.meta.lock().await["config"]["relayInstanceId"] != identity.id() {
        return Err("Relay instance identity does not match this machine".into());
    }
    let proxy = ingress.network_proxy().await?;
    let client = client(&proxy).await?;
    let auth = envelope(
        &client,
        origin,
        &identity,
        &json!({"op":"connect","id":identity.id()}),
    )
    .await?;
    let mut ws = upgrade(&client, origin, &identity.id(), &auth).await?;
    let ready = tokio::time::timeout(Duration::from_secs(10), ws.next())
        .await
        .map_err(|_| "Relay ready timed out")?
        .ok_or("Relay closed before ready")?
        .map_err(|_| "Relay ready failed")?;
    let ready: Value = serde_json::from_str(ready.to_text().map_err(|_| "Invalid relay ready")?)
        .map_err(|_| "Invalid relay ready")?;
    if ready["type"] != "ready" {
        return Err("Relay did not acknowledge connection".into());
    }
    ingress.connected.store(true, Ordering::SeqCst);
    status.send_replace(json!({"state":"ready","error":"","workerVersion":ready["version"]}));
    run(ws, local).await
}
pub(crate) async fn run<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    mut ws: WebSocketStream<S>,
    local: &str,
) -> Result<()> {
    let local_client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let (send, mut outgoing) = mpsc::channel::<Value>(128);
    let mut requests: HashMap<String, RequestState> = HashMap::new();
    let mut tasks = tokio::task::JoinSet::new();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
    let mut pong = std::time::Instant::now();
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                crate::runtime_metrics::cost::sync(crate::runtime_metrics::cost::Owner::Relay, crate::runtime_metrics::cost::Reason::Timer, || {
                    crate::runtime_metrics::cost::scan_set(requests.len() + 1);
                    crate::runtime_metrics::cost::rows(1);
                });
                if pong.elapsed() > Duration::from_secs(75) { return Err("Relay heartbeat timed out".into()); }
                send_frame(&mut ws, "ping".into()).await?;
            }
            Some(done) = tasks.join_next(), if !tasks.is_empty() => {
                if let Ok(id) = done { requests.remove(&id); }
            }
            Some(frame) = outgoing.recv() => { send_frame(&mut ws, frame.to_string()).await?; }
            message = ws.next() => {
                let message = message.ok_or("Relay closed")?.map_err(|_| "Relay receive failed")?;
                let text = match message { Message::Text(text) => text, Message::Ping(_) | Message::Pong(_) => continue, Message::Close(_) => return Err("Relay closed connection".into()), _ => return Err("Invalid relay message".into()) };
                if text == "pong" { pong = std::time::Instant::now(); continue; }
                let frame: Value = serde_json::from_str(&text).map_err(|_| "Invalid relay frame")?;
                let id = string(&frame,"id").to_owned();
                match string(&frame,"type") {
                    "request" => {
                        if requests.len() >= 64 || requests.contains_key(&id) { return Err("Relay request limit exceeded".into()); }
                        let (body, receiver) = mpsc::channel(2);
                        let credit = Arc::new(Semaphore::new(0));
                        let args = (local_client.clone(), local.to_owned(), frame, receiver, credit.clone(), send.clone());
                        let request_id = id.clone();
                        let errors = send.clone();
                        let abort = tasks.spawn(async move {
                            if forward(args).await.is_err() { let _ = errors.send(json!({"type":"error","id":request_id})).await; }
                            request_id
                        });
                        requests.insert(id, RequestState { body:Some(body), credit, abort });
                    }
                    "request-chunk" => {
                        let data = STANDARD.decode(string(&frame,"data")).map_err(|_| "Invalid relay body")?;
                        if data.len() > 32768 { return Err("Relay chunk too large".into()); }
                        if let Some(request) = requests.get(&id) { if let Some(body) = &request.body { match body.try_send(Ok(data)) {
                                Ok(()) | Err(mpsc::error::TrySendError::Closed(_)) => {},
                                Err(mpsc::error::TrySendError::Full(_)) => return Err("Relay upload credit exceeded".into()),
                            } } }
                    }
                    "request-end" => { if let Some(request) = requests.get_mut(&id) { request.body.take(); } }
                    "response-credit" => { if let Some(request) = requests.get(&id) { if request.credit.available_permits() != 0 { return Err("Invalid relay credit".into()); } request.credit.add_permits(1); } }
                    "cancel" => { if let Some(request) = requests.remove(&id) { request.abort.abort(); } }
                    _ => return Err("Unknown relay frame".into()),
                }
            }
        }
    }
}
type Forward = (
    reqwest::Client,
    String,
    Value,
    mpsc::Receiver<std::result::Result<Vec<u8>, std::io::Error>>,
    Arc<Semaphore>,
    mpsc::Sender<Value>,
);
async fn forward((client, local, frame, receiver, credit, send): Forward) -> Result<()> {
    let id = string(&frame, "id").to_owned();
    let path = string(&frame, "path");
    if !path.starts_with('/') || path.starts_with("//") || path.contains('#') {
        return Err("Invalid relay path".into());
    }
    let method = reqwest::Method::from_bytes(string(&frame, "method").as_bytes())
        .map_err(|_| "Invalid method")?;
    let mut request = client.request(method, format!("{local}{path}"));
    for entry in frame["headers"].as_array().ok_or("Invalid headers")? {
        let name = entry[0].as_str().ok_or("Invalid header")?;
        let value = entry[1].as_str().ok_or("Invalid header")?;
        if ![
            "host",
            "connection",
            "transfer-encoding",
            "upgrade",
            "expect",
        ]
        .contains(&name.to_ascii_lowercase().as_str())
        {
            let bytes: Vec<u8> = value
                .chars()
                .map(|c| u8::try_from(c as u32).map_err(|_| "Invalid header byte"))
                .collect::<std::result::Result<_, _>>()?;
            request = request.header(
                name,
                reqwest::header::HeaderValue::from_bytes(&bytes)
                    .map_err(|_| "Invalid header value")?,
            );
        }
    }
    let body_id = id.clone();
    let body_send = send.clone();
    let stream = futures_util::stream::unfold(receiver, move |mut receiver| {
        let send = body_send.clone();
        let id = body_id.clone();
        async move {
            let item = receiver.recv().await?;
            let _ = send.send(json!({"type":"request-credit","id":id})).await;
            Some((item, receiver))
        }
    });
    let mut response = request
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .map_err(|_| "Local ingress request failed")?;
    let headers: Vec<_> = response
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                k.as_str(),
                v.as_bytes()
                    .iter()
                    .map(|b| char::from(*b))
                    .collect::<String>(),
            )
        })
        .collect();
    send.send(
        json!({"type":"response","id":id,"status":response.status().as_u16(),"headers":headers}),
    )
    .await
    .map_err(|_| "Relay stopped")?;
    while let Some(bytes) = response
        .chunk()
        .await
        .map_err(|_| "Local response interrupted")?
    {
        for chunk in bytes.chunks(32768) {
            credit
                .acquire()
                .await
                .map_err(|_| "Relay stopped")?
                .forget();
            send.send(json!({"type":"response-chunk","id":id,"data":STANDARD.encode(chunk)}))
                .await
                .map_err(|_| "Relay stopped")?;
        }
    }
    send.send(json!({"type":"response-end","id":id}))
        .await
        .map_err(|_| "Relay stopped")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn deployment_waits_for_the_current_worker_version_after_route_propagation() {
        // Regression: 42f9056; deployment waits for the current worker version after route propagation.
        crate::init_crypto();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for (status, body) in [
                (404, "{}".to_owned()),
                (
                    200,
                    json!({"version":env!("ARC_BUILD_VERSION"),"challenge":"ready"}).to_string(),
                ),
            ] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).await.unwrap();
                    request.push(byte[0]);
                    if request.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                assert!(String::from_utf8(request)
                    .unwrap()
                    .starts_with("POST /challenge "));
                stream.write_all(format!("HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        wait_deployed(
            &reqwest::Client::builder().no_proxy().build().unwrap(),
            &format!("http://{address}"),
        )
        .await
        .unwrap();
        server.await.unwrap();
    }
    #[tokio::test]
    async fn forwards_binary_upload_and_sse_with_credit() {
        // Contract: relay wire frames preserve binary payloads, SSE and flow credit.
        crate::init_crypto();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (first_sent, first_received) = tokio::sync::oneshot::channel();
        let (finish, finished) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let header_end = loop {
                let mut byte = [0];
                stream.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
                if request.ends_with(b"\r\n\r\n") {
                    break request.len();
                }
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            assert!(headers.starts_with("POST /oauth/token?x=%2F HTTP/1.1"));
            assert!(headers.contains("authorization: Bearer test"));
            assert!(headers.contains("x-test: exact"));
            assert!(!headers.contains("host: evil.example"));
            let mut body = [0; 4];
            stream.read_exact(&mut body).await.unwrap();
            assert_eq!(body, [0, 1, 254, 255]);
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nSet-Cookie: one=1\r\nSet-Cookie: two=2\r\n\r\nb\r\ndata: one\n\n\r\n").await.unwrap();
            first_sent.send(()).unwrap();
            finished.await.unwrap();
            stream
                .write_all(b"b\r\ndata: two\n\n\r\n0\r\n\r\n")
                .await
                .unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let (body, receiver) = mpsc::channel(2);
        let (send, mut frames) = mpsc::channel(8);
        let credit = Arc::new(Semaphore::new(0));
        let args = (
            client,
            format!("http://{address}"),
            json!({"id":"request","method":"POST","path":"/oauth/token?x=%2F","headers":[["authorization","Bearer test"],["host","evil.example"],["content-length","4"],["x-test","exact"]]}),
            receiver,
            credit.clone(),
            send,
        );
        let task = tokio::spawn(forward(args));
        body.send(Ok(vec![0, 1, 254, 255])).await.unwrap();
        drop(body);
        assert_eq!(frames.recv().await.unwrap()["type"], "request-credit");
        let head = frames.recv().await.unwrap();
        assert_eq!(head["status"], 200);
        assert_eq!(
            head["headers"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|h| h[0] == "set-cookie")
                .count(),
            2
        );
        first_received.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(30), frames.recv())
                .await
                .is_err()
        );
        credit.add_permits(1);
        let first = frames.recv().await.unwrap();
        assert_eq!(
            STANDARD.decode(string(&first, "data")).unwrap(),
            b"data: one\n\n"
        );
        assert!(!task.is_finished());
        finish.send(()).unwrap();
        credit.add_permits(1);
        let second = frames.recv().await.unwrap();
        assert_eq!(
            STANDARD.decode(string(&second, "data")).unwrap(),
            b"data: two\n\n"
        );
        assert_eq!(frames.recv().await.unwrap()["type"], "response-end");
        task.await.unwrap().unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_drops_the_local_http_connection() {
        // Regression: relay cancellation must close the outstanding local HTTP request.
        crate::init_crypto();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted, connected) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                bytes.push(byte[0]);
                if bytes.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            accepted.send(()).unwrap();
            let mut byte = [0];
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), socket.read(&mut byte))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        });
        let (body, receiver) = mpsc::channel(1);
        drop(body);
        let (send, _) = mpsc::channel(4);
        let task = tokio::spawn(forward((
            reqwest::Client::builder().no_proxy().build().unwrap(),
            format!("http://{address}"),
            json!({"id":"cancel","method":"GET","path":"/mcp","headers":[["content-length","0"]]}),
            receiver,
            Arc::new(Semaphore::new(0)),
            send,
        )));
        connected.await.unwrap();
        task.abort();
        let _ = task.await;
        server.await.unwrap();
    }
    #[tokio::test]
    async fn websocket_upgrade_uses_the_http_client_proxy() {
        // Regression: WebSocket upgrade must follow the configured HTTP proxy.
        crate::init_crypto();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut byte = [0];
                stream.read_exact(&mut byte).await.unwrap();
                bytes.push(byte[0]);
                if bytes.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let headers = String::from_utf8(bytes).unwrap();
            assert!(headers.starts_with("GET http://unresolvable.invalid/connect/test HTTP/1.1"));
            assert!(headers.contains("x-arc-auth: {"));
            let key = headers
                .lines()
                .find_map(|line| line.strip_prefix("sec-websocket-key: "))
                .unwrap();
            let accept =
                tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
            stream.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").as_bytes()).await.unwrap();
            let mut ws = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
            ws.send(Message::Text("ready".into())).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(format!("http://{address}")).unwrap())
            .http1_only()
            .build()
            .unwrap();
        let mut ws = upgrade(
            &client,
            "http://unresolvable.invalid",
            "test",
            &json!({"signature":"test"}),
        )
        .await
        .unwrap();
        assert_eq!(
            ws.next().await.unwrap().unwrap().to_text().unwrap(),
            "ready"
        );
        server.await.unwrap();
    }
}
