//! Persistent multiplexed peer HTTP/2 channels. A sent request is never retried here.
use super::*;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Bytes, Request};
use hyper_util::rt::{TokioExecutor, TokioIo};
use rustls::pki_types::ServerName;
use tokio::net::TcpStream;

type Sender = hyper::client::conn::http2::SendRequest<Full<Bytes>>;
pub(super) struct Channel {
    sender: Sender,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Channel {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Channel {
    pub async fn new<S>(stream: S) -> Result<Arc<Self>>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let (sender, connection) =
            hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(stream))
                .await
                .map_err(|e| e.to_string())?;
        let task = tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(Arc::new(Self { sender, task }))
    }
    pub fn close(&self) {
        self.task.abort();
    }
    pub fn alive(&self) -> bool {
        !self.task.is_finished() && !self.sender.is_closed()
    }
    pub async fn ready(&self) -> Result<Sender> {
        let mut sender = self.sender.clone();
        sender.ready().await.map_err(|e| e.to_string())?;
        Ok(sender)
    }
    pub async fn send(
        mut sender: Sender,
        path: &str,
        body: Value,
        bound: Duration,
    ) -> Result<Value> {
        let request = Request::builder()
            .method("POST")
            .uri(format!("https://arc-peer.local{path}"))
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(body.to_string())))
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(bound, async {
            let response = sender
                .send_request(request)
                .await
                .map_err(|e| e.to_string())?;
            let bytes = Limited::new(response.into_body(), crate::front_door::MAX_FRAME_BYTES)
                .collect()
                .await
                .map_err(|e| e.to_string())?
                .to_bytes();
            let response: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if response["ok"] != true {
                return Err(response["error"].to_string());
            }
            Ok(response["result"].clone())
        })
        .await
        .map_err(|_| {
            "DEVICE_RESPONSE_LOST: Peer request deadline expired; read query guide.".to_owned()
        })?
    }
    pub async fn request(&self, path: &str, body: Value, bound: Duration) -> Result<Value> {
        Self::send(self.ready().await?, path, body, bound).await
    }
}
#[derive(Default)]
pub(super) struct Session {
    channel: Mutex<Option<Arc<Channel>>>,
}
impl Session {
    pub async fn cached(&self) -> Option<Arc<Channel>> {
        self.channel
            .lock()
            .await
            .as_ref()
            .filter(|channel| channel.alive())
            .cloned()
    }
    pub async fn close(&self) {
        if let Some(channel) = self.channel.lock().await.take() {
            channel.close();
        }
    }
    pub async fn connect(
        &self,
        identity: &Identity,
        device_id: &str,
        addresses: &[SocketAddr],
    ) -> Result<Arc<Channel>> {
        let mut cached = self.channel.lock().await;
        if let Some(channel) = cached.as_ref().filter(|c| c.alive()) {
            return Ok(channel.clone());
        }
        if let Some(old) = cached.take() {
            old.close();
        }
        let connector = tls::client(identity, device_id.to_owned())?;
        use futures_util::{stream::FuturesUnordered, StreamExt};
        // Race only pre-submission dials. The request is sent once on the winning channel.
        let mut attempts = FuturesUnordered::new();
        for address in addresses.iter().take(64).copied() {
            let connector = connector.clone();
            attempts.push(async move {
                let stream=match tokio::time::timeout(Duration::from_secs(3),TcpStream::connect(address)).await {
                    Ok(Ok(stream))=>stream,
                    Ok(Err(error))=>return Err((error.kind()==std::io::ErrorKind::ConnectionRefused,error.to_string())),
                    Err(_)=>return Err((false,"TCP connect deadline expired".into())),
                };
                let stream=match tokio::time::timeout(Duration::from_secs(5),connector.connect(ServerName::try_from("arc-peer.local").unwrap(),stream)).await {
                    Ok(Ok(stream))=>stream,
                    Ok(Err(error))=>return Err((false,super::error(if tls::protocol_mismatch(&error){"DEVICE_PROTOCOL_MISMATCH"}else{"DEVICE_TLS_FAILED"},&format!("{error}; query guide for device.")))),
                    Err(_)=>return Err((false,"DEVICE_TLS_FAILED: Peer handshake deadline expired; query guide for device.".into())),
                };
                if stream.get_ref().1.alpn_protocol()!=Some(tls::ALPN){return Err((false,"DEVICE_PROTOCOL_MISMATCH: Use matching peer protocol versions; query guide for device.".into()));}
                let channel=Channel::new(stream).await.map_err(|error|(false,error))?;
                Ok::<_,(bool,String)>(channel)
            });
        }
        let mut last = error(
            "DEVICE_LAN_UNAVAILABLE",
            "No known private LAN address is reachable; query devices.",
        );
        let mut refused = !addresses.is_empty();
        while let Some(attempt) = attempts.next().await {
            match attempt {
                Ok(channel) => {
                    *cached = Some(channel.clone());
                    return Ok(channel);
                }
                Err((connection_refused, error)) => {
                    refused &= connection_refused;
                    if !connection_refused {
                        last = error;
                    }
                }
            }
        }
        if refused {
            Err("DEVICE_CONNECTION_REFUSED: Every known LAN address refused the connection; query devices.".into())
        } else {
            Err(last)
        }
    }
}
/// The member's own maximum wait wins; only transport overhead is added.
pub fn request_bound(op: &str, args: &Value) -> Duration {
    let milliseconds = if op.ends_with("_wait") || op == "inbox_wait" {
        args["timeoutMs"].as_u64().unwrap_or(30000)
    } else if args["waitMs"].is_number() {
        args["waitMs"].as_u64().unwrap_or(0)
    } else {
        args["timeoutMs"].as_u64().unwrap_or(1_800_000)
    };
    Duration::from_millis(milliseconds.saturating_add(30_000))
}
