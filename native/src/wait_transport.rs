//! Long MCP responses: SSE when accepted, JSON whitespace otherwise.
use crate::*;
use http_body_util::BodyExt;
use hyper::body::Bytes;
use std::{convert::Infallible, future::Future, time::Duration};
use tokio::sync::mpsc;

pub(crate) type Body = http_body_util::combinators::BoxBody<Bytes, Infallible>;
struct StreamBody(mpsc::Receiver<Bytes>);
impl hyper::body::Body for StreamBody {
    type Data = Bytes;
    type Error = Infallible;
    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<std::result::Result<hyper::body::Frame<Bytes>, Infallible>>> {
        self.0
            .poll_recv(cx)
            .map(|v| v.map(|b| Ok(hyper::body::Frame::data(b))))
    }
}

pub(crate) fn accepts_sse(headers: &hyper::HeaderMap) -> bool {
    headers
        .get("accept")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|accept| {
            accept
                .split(',')
                .any(|v| v.trim().split(';').next() == Some("text/event-stream"))
        })
}

pub(crate) fn stream(
    request: &Value,
    sse: bool,
    operation: impl Future<Output = Result<Value>> + Send + 'static,
    disconnected: impl Future<Output = ()> + Send + 'static,
) -> hyper::Response<Body> {
    let token = request["params"]["_meta"]["progressToken"].clone();
    let token = (token.is_string() || token.is_number()).then_some(token);
    let request_id = request["id"].clone();
    let (tx, rx) = mpsc::channel(1);
    tokio::spawn(async move {
        tokio::pin!(operation, disconnected);
        let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut progress = 0u64;
        loop {
            let frame = tokio::select! {
                biased;
                _ = tx.closed() => return,
                _ = &mut disconnected => return,
                result = &mut operation => {
                    let value = result.unwrap_or_else(|error| json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32603,"message":error}}));
                    let body = if sse { format!("event: message\ndata: {value}\n\n") } else { value.to_string() };
                    tokio::select! {
                        _ = &mut disconnected => {},
                        _ = tx.send(Bytes::from(body)) => {},
                    }
                    return;
                }
                _ = heartbeat.tick() => {
                    crate::runtime_metrics::cost::sync(crate::runtime_metrics::cost::Owner::WaitHeartbeat, crate::runtime_metrics::cost::Reason::Timer, || {
                        crate::runtime_metrics::cost::scan_set(1);
                        crate::runtime_metrics::cost::rows(1);
                    });
                    progress += 1;
                    if sse {
                        if let Some(token) = &token {
                            let notification = json!({"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":token,"progress":progress,"message":"Waiting for ARC events"}});
                            format!("event: message\ndata: {notification}\n\n")
                        } else { ": keepalive\n\n".into() }
                    } else { " \n".into() }
                }
            };
            tokio::select! {
                biased;
                _ = tx.closed() => return,
                _ = &mut disconnected => return,
                result = tx.send(Bytes::from(frame)) => if result.is_err() { return; },
            }
        }
    });
    hyper::Response::builder()
        .header(
            "Content-Type",
            if sse {
                "text/event-stream"
            } else {
                "application/json"
            },
        )
        .header("Cache-Control", "no-store, no-transform")
        .header("X-Accel-Buffering", "no")
        .body(StreamBody(rx).boxed())
        .unwrap()
}

/// The local stdio bridge accepts SSE, forwarding only negotiated progress and
/// the final response. Comments keep HTTP alive without inventing MCP messages.
pub(crate) async fn forward_sse(
    mut response: reqwest::Response,
    out: &Arc<Mutex<tokio::io::Stdout>>,
) -> Result<Value> {
    let mut pending = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        pending.extend_from_slice(&chunk);
        if pending.len() > 16 * 1024 * 1024 {
            return Err("MCP response too large".into());
        }
        while let Some(end) = pending.windows(2).position(|w| w == b"\n\n") {
            let frame =
                String::from_utf8(pending.drain(..end + 2).collect()).map_err(|e| e.to_string())?;
            for line in frame.lines().filter_map(|line| line.strip_prefix("data: ")) {
                let value: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
                if value.get("id").is_some() {
                    return Ok(value);
                }
                if value["method"] == "notifications/progress" {
                    crate::output::async_line(&mut *out.lock().await, value).await?;
                }
            }
        }
    }
    Err("MCP stream closed before response".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn heartbeats_preserve_final_response_and_only_negotiate_progress() {
        // Contract: wait transport emits progress only after negotiation and preserves the final JSON reply.
        for sse in [false, true] {
            for token in [Value::Null, json!("caller-token"), json!(42)] {
                let expected =
                    json!({"jsonrpc":"2.0","id":7,"result":{"events":[],"state":"timeout"}});
                let final_value = expected.clone();
                let response = stream(
                    &json!({"id":7,"params":{"_meta":{"progressToken":token}}}),
                    sse,
                    async move {
                        tokio::time::sleep(Duration::from_secs(61)).await;
                        Ok(final_value)
                    },
                    std::future::pending(),
                );
                let bytes = response.into_body().collect().await.unwrap().to_bytes();
                let text = String::from_utf8(bytes.to_vec()).unwrap();
                if sse {
                    let values: Vec<Value> = text
                        .lines()
                        .filter_map(|l| l.strip_prefix("data: "))
                        .map(|l| serde_json::from_str(l).unwrap())
                        .collect();
                    assert_eq!(values.last().unwrap(), &expected);
                    if token.is_null() {
                        assert_eq!(values.len(), 1);
                        assert_eq!(text.matches(": keepalive").count(), 3);
                    } else {
                        assert_eq!(values.len(), 4);
                        for (index, v) in values[..3].iter().enumerate() {
                            assert_eq!(v["method"], "notifications/progress");
                            assert_eq!(v["params"]["progressToken"], token);
                            assert_eq!(v["params"]["progress"], index + 1);
                        }
                    }
                } else {
                    assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), expected);
                }
            }
        }
    }

    #[tokio::test]
    async fn dropped_body_and_disconnected_socket_cancel_the_operation() {
        // Regression: a disconnected wait must cancel the pending operation.
        for drop_body in [true, false] {
            let (done_tx, done_rx) = tokio::sync::oneshot::channel();
            struct Guard(Option<tokio::sync::oneshot::Sender<()>>);
            impl Drop for Guard {
                fn drop(&mut self) {
                    let _ = self.0.take().unwrap().send(());
                }
            }
            let guard = Guard(Some(done_tx));
            let (disconnect_tx, disconnect_rx) = tokio::sync::oneshot::channel::<()>();
            let response = stream(
                &json!({"id":1}),
                true,
                async move {
                    let _guard = guard;
                    std::future::pending::<Result<Value>>().await
                },
                async move {
                    let _ = disconnect_rx.await;
                },
            );
            if drop_body {
                drop(response);
            } else {
                disconnect_tx.send(()).unwrap();
            }
            tokio::time::timeout(Duration::from_secs(1), done_rx)
                .await
                .unwrap()
                .unwrap();
        }
    }
}
