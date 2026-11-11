//! Persistent multiplexed peer HTTP/2 channels. A sent request is never retried here.
use super::*;
use http_body_util::{BodyExt, Limited};
use hyper::Request;
use hyper_util::rt::{TokioExecutor, TokioIo};
use rustls::pki_types::ServerName;
use tokio::net::TcpStream;

type Sender = hyper::client::conn::http2::SendRequest<super::transfer::wire::Body>;
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
        let (sender, connection) = hyper::client::conn::http2::Builder::new(TokioExecutor::new())
            .initial_stream_window_size(2 * 1024 * 1024)
            .initial_connection_window_size(4 * 1024 * 1024)
            .max_send_buf_size(512 * 1024)
            .max_frame_size(256 * 1024)
            .handshake(TokioIo::new(stream))
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
            .body(super::transfer::wire::full(body.to_string()))
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
                let result = async {
                    let delay = Duration::from_millis(u64::from(addresses::rank(&address)) * 50);
                    tokio::time::sleep(delay).await;
                    let stream = match tokio::time::timeout(
                        Duration::from_millis(750), TcpStream::connect(address),
                    ).await {
                        Ok(Ok(stream)) => stream,
                        Ok(Err(error)) => {
                            use std::io::ErrorKind;
                            let refused = match error.kind() {
                                ErrorKind::ConnectionRefused => Some(true),
                                ErrorKind::NetworkUnreachable | ErrorKind::HostUnreachable
                                | ErrorKind::AddrNotAvailable | ErrorKind::InvalidInput
                                | ErrorKind::NotFound => None,
                                _ => Some(false),
                            };
                            return Err((refused, lan_connect_error(&error)));
                        }
                        Err(_) => return Err((Some(false), "TCP connect deadline expired".into())),
                    };
                    let stream = match tokio::time::timeout(
                        Duration::from_millis(1250),
                        connector.connect(ServerName::try_from("arc-peer.local").unwrap(), stream),
                    ).await {
                        Ok(Ok(stream)) => stream,
                        Ok(Err(error)) => {
                            let code = if tls::protocol_mismatch(&error) {
                                "DEVICE_PROTOCOL_MISMATCH"
                            } else {
                                "DEVICE_TLS_FAILED"
                            };
                            return Err((Some(false), super::error(code, &format!("{error}; query guide for device."))));
                        }
                        Err(_) => return Err((Some(false), "DEVICE_TLS_FAILED: Peer handshake deadline expired; query guide for device.".into())),
                    };
                    if stream.get_ref().1.alpn_protocol() != Some(tls::ALPN) {
                        return Err((Some(false), "DEVICE_PROTOCOL_MISMATCH: Use matching peer protocol versions; query guide for device.".into()));
                    }
                    let channel = tokio::time::timeout(Duration::from_millis(500), Channel::new(stream))
                        .await
                        .map_err(|_| (Some(false), "Peer HTTP/2 handshake deadline expired".into()))?
                        .map_err(|error| (Some(false), error))?;
                    Ok::<_, (Option<bool>, String)>(channel)
                }.await;
                result.map_err(|(refused, message)| (address, refused, message))
            });
        }
        let mut failures = Vec::new();
        while let Some(attempt) = attempts.next().await {
            match attempt {
                Ok(channel) => {
                    *cached = Some(channel.clone());
                    return Ok(channel);
                }
                Err(failure) => failures.push(failure),
            }
        }
        Err(lan_dial_error(&failures))
    }
}
/// Keep the OS evidence and add recovery only for macOS host-unreachable dials.
pub fn lan_connect_error(error: &std::io::Error) -> String {
    let message = error.to_string();
    if cfg!(target_os = "macos") && error.raw_os_error() == Some(libc::EHOSTUNREACH) {
        return format!("{message}; macOS Local Network permission may be blocking ARC. Check System Settings > Privacy & Security > Local Network, then run `arc cli app quit` and reopen Agent Remote Control with `open -a \"Agent Remote Control\"`");
    }
    message
}
/// Select diagnostic evidence independently of the order in which dials finish.
pub fn lan_dial_error(failures: &[(SocketAddr, Option<bool>, String)]) -> String {
    let Some((address, _, message)) = failures.iter().max_by_key(|(address, refused, message)| {
        let severity = if message.contains("DEVICE_PROTOCOL_MISMATCH") {
            4
        } else if message.contains("DEVICE_TLS_FAILED") || message.contains("HTTP/2") {
            3
        } else if *refused == Some(true) {
            2
        } else if message.contains("deadline expired") {
            0
        } else {
            1
        };
        (
            severity,
            std::cmp::Reverse(addresses::rank(address)),
            std::cmp::Reverse(*address),
        )
    }) else {
        return error(
            "DEVICE_LAN_UNAVAILABLE",
            "No known private LAN address is reachable; query devices.",
        );
    };
    if message.starts_with("DEVICE_") {
        return format!("{message} (LAN address {address})");
    }
    let mut dialable = failures
        .iter()
        .filter_map(|(_, refused, _)| *refused)
        .peekable();
    if dialable.peek().is_some() && dialable.all(|refused| refused) {
        return error("DEVICE_CONNECTION_REFUSED", &format!("Every currently dialable LAN address refused the connection; {address}: {message}; query devices."));
    }
    error(
        "DEVICE_LAN_UNAVAILABLE",
        &format!("{address}: {message}; query devices."),
    )
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
