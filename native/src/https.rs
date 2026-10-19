//! Stateless Streamable HTTP MCP ingress. TLS is terminated by the user's proxy.
//! This listener never exposes the desktop management API.
use crate::{ingress::Ingress, *};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    body::{Bytes, Incoming},
    Request, Response,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{
    convert::Infallible,
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    task::{JoinHandle, JoinSet},
};

pub async fn listen(
    service: Arc<Ingress>,
    settings: &Value,
) -> Result<(JoinHandle<()>, SocketAddr)> {
    let managed = settings["httpsProvider"] != "custom";
    let addr = if settings["httpsProvider"] == "cloudflare" && settings["cloudflareMode"] == "named"
    {
        SocketAddr::new(
            "127.0.0.1".parse().unwrap(),
            settings["httpsPort"].as_u64().ok_or("invalid port")? as u16,
        )
    } else if managed {
        "127.0.0.1:0".parse::<SocketAddr>().unwrap()
    } else {
        SocketAddr::new(
            string(settings, "httpsHost")
                .parse::<IpAddr>()
                .map_err(|e| e.to_string())?,
            settings["httpsPort"].as_u64().ok_or("invalid port")? as u16,
        )
    };
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("无法监听 MCP 地址 {addr}: {e}"))?;
    let address = listener.local_addr().map_err(|e| e.to_string())?;
    let service = Arc::downgrade(&service);
    Ok((
        tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    Some(_) = connections.join_next(), if !connections.is_empty() => {},
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break };
                        if connections.len() >= 128 { continue; }
                        let local_host = stream.local_addr().map(|addr|addr.to_string()).unwrap_or_default();
                        let Some(service) = service.upgrade() else { break };
                        connections.spawn(async move {
                            let handler = hyper::service::service_fn(move |request| {
                                handle(request, service.clone(), local_host.clone())
                            });
                            let _ = hyper::server::conn::http1::Builder::new()
                                .timer(TokioTimer::new())
                                .header_read_timeout(Duration::from_secs(10))
                                .keep_alive(false)
                                .serve_connection(TokioIo::new(stream), handler).await;
                        });
                    }
                }
            }
            // Dropping JoinSet also closes accepted connections on stop.
        }),
        address,
    ))
}
fn reply(code: u16, value: Option<Value>) -> Response<Full<Bytes>> {
    let mut response = Response::builder()
        .status(code)
        .header("Cache-Control", "no-store");
    if value.is_some() {
        response = response.header("Content-Type", "application/json");
    }
    if code == 405 {
        response = response.header("Allow", "POST");
    }
    response
        .body(Full::new(Bytes::from(
            value.map(|v| v.to_string()).unwrap_or_default(),
        )))
        .unwrap()
}
async fn handle(
    request: Request<Incoming>,
    service: Arc<Ingress>,
    local_host: String,
) -> std::result::Result<Response<Full<Bytes>>, Infallible> {
    let error = |code, message| Ok(reply(code, Some(json!({"error":message}))));
    let url = service.mcp_url.lock().await.clone();
    let Ok(url) = reqwest::Url::parse(&url) else {
        return error(503, "tunnel starting");
    };
    let origin = url.origin().ascii_serialization();
    let host = request
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let public_host = origin.strip_prefix("https://").unwrap_or("");
    if host != public_host && host != format!("{public_host}:443") && host != local_host {
        return error(403, "invalid host");
    }
    let oauth = service.meta.lock().await["auth"] == "oauth";
    if oauth
        && (request.uri().path().starts_with("/.well-known/")
            || request.uri().path().starts_with("/oauth/"))
    {
        if !service.connected.load(std::sync::atomic::Ordering::SeqCst) {
            return error(503, "connector stopped");
        }
        return Ok(crate::oauth::handle(request, &service, url.as_str()).await);
    }
    if request.uri().path() != "/mcp" || request.uri().query().is_some() {
        return error(404, "not found");
    }
    let event_header = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    if !service
        .authenticate(
            request
                .headers()
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or(""),
        )
        .await
    {
        let mut response = reply(401, Some(json!({"error":"unauthorized"})));
        response.headers_mut().insert(
            "www-authenticate",
            hyper::header::HeaderValue::from_str(&if oauth { format!("Bearer resource_metadata=\"{origin}/.well-known/oauth-protected-resource/mcp\", scope=\"mcp\"") } else { "Bearer".to_owned() }).unwrap(),
        );
        return Ok(response);
    }
    if let Some(value) = request.headers().get("origin") {
        if value.to_str().ok() != Some(origin.as_str()) {
            return error(403, "invalid origin");
        }
    }
    if request.method() != hyper::Method::POST {
        return error(405, "method not allowed");
    }
    if !service.connected.load(std::sync::atomic::Ordering::SeqCst) {
        return error(503, "connector stopped");
    }
    let accept = request
        .headers()
        .get("accept")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !accept.split(',').any(|v| {
        matches!(
            v.trim().split(';').next().unwrap_or(""),
            "application/json" | "*/*"
        )
    }) {
        return error(406, "expected application/json in Accept");
    }
    let content_type = request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !content_type
        .split(';')
        .next()
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
    {
        return error(415, "expected application/json");
    }
    if let Some(version) = request.headers().get("mcp-protocol-version") {
        if !version.to_str().is_ok_and(|v| {
            [
                "2024-11-05",
                "2025-03-26",
                "2025-06-18",
                "2025-11-25",
                "2026-07-28",
            ]
            .contains(&v)
        }) {
            return error(400, "unsupported protocol version");
        }
    }
    let body = match tokio::time::timeout(
        Duration::from_secs(15),
        Limited::new(request.into_body(), 16 * 1024 * 1024).collect(),
    )
    .await
    {
        Ok(Ok(body)) => body.to_bytes(),
        Ok(Err(_)) => return error(413, "invalid or oversized body"),
        Err(_) => return error(408, "request timeout"),
    };
    let value: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return Ok(reply(
                400,
                Some(
                    json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}),
                ),
            ))
        }
    };
    if value["jsonrpc"] != "2.0"
        || !value["method"].is_string()
        || value
            .get("id")
            .is_some_and(|v| !v.is_string() && !v.is_number())
    {
        return Ok(reply(
            400,
            Some(
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}),
            ),
        ));
    }
    // Notifications have no response and must never execute tools without a request ID.
    if value.get("id").is_none() {
        if matches!(
            string(&value, "method"),
            "notifications/cancelled" | "notifications/initialized"
        ) {
            let _ = crate::transport::mcp_ingress(&service, value).await;
        }
        return Ok(reply(202, None));
    }
    match crate::transport::mcp_ingress_authenticated(&service, value, Some(&event_header)).await {
        Ok(value) => Ok(reply(200, Some(value))),
        Err(_) => error(400, "invalid MCP request"),
    }
}
