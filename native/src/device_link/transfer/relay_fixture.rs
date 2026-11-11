//! The 0.9.42 stop-and-wait Worker protocol against the production native loop.
use super::*;
use base64::engine::general_purpose::STANDARD;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::{
    body::{Bytes, Incoming},
    Request, Response,
};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{
    tungstenite::{protocol::Role, Message},
    WebSocketStream,
};

#[derive(Default)]
pub(super) struct Metrics {
    pub upload: Vec<Duration>,
    pub download: Vec<Duration>,
}
pub(super) struct Relay {
    pub url: String,
    pub metrics: Arc<StdMutex<Metrics>>,
    pub delay: Arc<StdMutex<Duration>>,
    _ingress: Arc<crate::ingress::Ingress>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Relay {
    pub async fn new(member: &Arc<Manager>) -> Self {
        let ingress = crate::ingress::Ingress::with_execution(json!({"id":"relay-fixture","name":"Example relay","controlSource":"custom","transport":"relay","auth":"none","enabled":true,"config":crate::ingress::config::defaults()}), None, "fixture".into()).unwrap();
        ingress
            .connected
            .store(true, std::sync::atomic::Ordering::SeqCst);
        member.attach_ingress(&ingress);
        let (listener, local) =
            crate::https::listen(ingress.clone(), &json!({"httpsProvider":"fixture"}))
                .await
                .unwrap();
        let sockets = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", sockets.local_addr().unwrap());
        let upgraded = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut worker, _) = sockets.accept().await.unwrap();
            worker.set_nodelay(true).unwrap();
            let mut headers = Vec::new();
            loop {
                let mut byte = [0];
                worker.read_exact(&mut byte).await.unwrap();
                headers.push(byte[0]);
                if headers.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let headers = String::from_utf8(headers).unwrap();
            let key = headers
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(name, _)| name.eq_ignore_ascii_case("sec-websocket-key"))
                        .map(|(_, value)| value.trim())
                })
                .unwrap();
            let accept =
                tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
            worker.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").as_bytes()).await.unwrap();
            WebSocketStream::from_raw_socket(worker, Role::Server, None).await
        });
        // Exercise reqwest's real Upgraded stream; its TCP_NODELAY default is true.
        let client = reqwest::Client::builder()
            .no_proxy()
            .http1_only()
            .build()
            .unwrap();
        let native = crate::relay::transport::upgrade(&client, &origin, "fixture", &json!({}))
            .await
            .unwrap();
        let worker = upgraded.await.unwrap();
        let transport = tokio::spawn(async move {
            crate::relay::transport::run(native, &format!("http://{local}"))
                .await
                .unwrap();
        });
        let worker = Arc::new(tokio::sync::Mutex::new(worker));
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/arc-peer/3", proxy.local_addr().unwrap());
        let metrics = Arc::new(StdMutex::new(Metrics::default()));
        let delay = Arc::new(StdMutex::new(Duration::ZERO));
        let observed = metrics.clone();
        let latency = delay.clone();
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = proxy.accept() => {
                        let (stream, _) = accepted.unwrap();
                        let worker = worker.clone();
                        let metrics = observed.clone();
                        let delay = latency.clone();
                        connections.spawn(async move {
                            let service = hyper::service::service_fn(move |request| exchange(request, worker.clone(), metrics.clone(), delay.clone()));
                            let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(stream), service).await;
                        });
                    }
                    Some(_) = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Self {
            url,
            metrics,
            delay,
            _ingress: ingress,
            tasks: vec![task, transport, listener],
        }
    }
    pub async fn stop(&mut self) {
        for task in self.tasks.drain(..) {
            task.abort();
            let _ = task.await;
        }
    }
}
impl Drop for Relay {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}
async fn send(worker: &mut WebSocketStream<TcpStream>, frame: Value) {
    worker
        .send(Message::Text(frame.to_string().into()))
        .await
        .unwrap();
}
async fn exchange(
    request: Request<Incoming>,
    worker: Arc<tokio::sync::Mutex<WebSocketStream<TcpStream>>>,
    metrics: Arc<StdMutex<Metrics>>,
    delay: Arc<StdMutex<Duration>>,
) -> std::result::Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let (parts, body) = request.into_parts();
    let body = body.collect().await.unwrap().to_bytes();
    let headers: Vec<_> = parts
        .headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.to_str().unwrap()))
        .collect();
    let id = id();
    let mut worker = worker.lock().await;
    send(&mut worker, json!({"type":"request","id":id,"method":parts.method.as_str(),"path":parts.uri.to_string(),"headers":headers})).await;
    let mut chunks = body.chunks(32768);
    let mut upload_sent = None;
    if let Some(chunk) = chunks.next() {
        upload_sent = Some(Instant::now());
        send(
            &mut worker,
            json!({"type":"request-chunk","id":id,"data":STANDARD.encode(chunk)}),
        )
        .await;
    } else {
        send(&mut worker, json!({"type":"request-end","id":id})).await;
    }
    let mut download_sent = None;
    let mut bytes = Vec::new();
    let mut response = Response::builder();
    loop {
        let message = worker.next().await.unwrap().unwrap();
        let text = message.to_text().unwrap();
        if text == "ping" {
            worker.send(Message::Text("pong".into())).await.unwrap();
            continue;
        }
        let frame: Value = serde_json::from_str(text).unwrap();
        assert_eq!(frame["id"], id);
        let latency = *delay.lock().unwrap();
        match string(&frame, "type") {
            "request-credit" => {
                metrics
                    .lock()
                    .unwrap()
                    .upload
                    .push(upload_sent.take().unwrap().elapsed());
                // Advance only on observed credit, with Tokio auto-advance disabled
                // by the test's runnable clock guard. No wall-clock sleep is needed.
                if !latency.is_zero() {
                    tokio::time::advance(latency).await;
                }
                if let Some(chunk) = chunks.next() {
                    upload_sent = Some(Instant::now());
                    send(
                        &mut worker,
                        json!({"type":"request-chunk","id":id,"data":STANDARD.encode(chunk)}),
                    )
                    .await;
                } else {
                    send(&mut worker, json!({"type":"request-end","id":id})).await;
                }
            }
            "response" => {
                response = response.status(frame["status"].as_u64().unwrap() as u16);
                for header in frame["headers"].as_array().unwrap() {
                    if header[0] != "transfer-encoding" && header[0] != "connection" {
                        response = response
                            .header(header[0].as_str().unwrap(), header[1].as_str().unwrap());
                    }
                }
                download_sent = Some(Instant::now());
                send(&mut worker, json!({"type":"response-credit","id":id})).await;
            }
            "response-chunk" => {
                metrics
                    .lock()
                    .unwrap()
                    .download
                    .push(download_sent.take().unwrap().elapsed());
                bytes.extend(STANDARD.decode(string(&frame, "data")).unwrap());
                if !latency.is_zero() {
                    tokio::time::advance(latency).await;
                }
                download_sent = Some(Instant::now());
                send(&mut worker, json!({"type":"response-credit","id":id})).await;
            }
            "response-end" => break,
            _ => panic!("Unexpected relay frame: {frame}"),
        }
    }
    send(&mut worker, json!({"type":"cancel","id":id})).await;
    Ok(response.body(Full::new(Bytes::from(bytes))).unwrap())
}
