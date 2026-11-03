//! Key-authenticated, read-only browser surface on existing HTTPS ingresses.
use crate::*;
use futures_util::StreamExt;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Bytes, Request, Response};
use ring::rand::{SecureRandom, SystemRandom};
use std::{convert::Infallible, time::Duration};

include!(concat!(env!("OUT_DIR"), "/browser_assets.rs"));

fn key_path() -> PathBuf {
    root().join("app/browser-access.json")
}
fn stored_key() -> Option<String> {
    load(&key_path()).ok()?["key"].as_str().map(str::to_owned)
}
pub(crate) async fn access(service: &service::Service, rotate: bool) -> Result<Value> {
    static WRITE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = WRITE.lock().await;
    let key = match stored_key().filter(|_| !rotate) {
        Some(key) => key,
        None => {
            let mut bytes = [0u8; 32];
            SystemRandom::new()
                .fill(&mut bytes)
                .map_err(|_| "Cannot generate browser access key")?;
            let key = format!("arc_{}", hex_encode(&bytes));
            save(&key_path(), &json!({"key":key}))?;
            key
        }
    };
    let mut links = Vec::new();
    for ingress in service.entries().await {
        let meta = ingress.meta.lock().await.clone();
        if !matches!(string(&meta, "transport"), "https" | "relay") {
            continue;
        }
        let address = ingress.mcp_url.lock().await.clone();
        let configured = string(&meta["config"], "httpsUrl");
        let Ok(mut url) = reqwest::Url::parse(if address.is_empty() {
            configured
        } else {
            &address
        }) else {
            continue;
        };
        let Some(base) = url.path().strip_suffix("/mcp").map(str::to_owned) else {
            continue;
        };
        url.set_path(&format!("{base}/"));
        url.set_query(None);
        url.query_pairs_mut().append_pair("key", &key);
        links.push(json!({"ingressId":meta["id"],"name":meta["name"],"url":url.as_str()}));
    }
    Ok(json!({"key":key,"links":links}))
}
fn session(key: &str) -> String {
    hash(format!("arc-browser-session:{key}"))
}
fn same(a: &str, b: &str) -> bool {
    // Compare fixed-size digests without a prefix-dependent early return.
    hash(a)
        .bytes()
        .zip(hash(b).bytes())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}
fn authenticated(headers: &hyper::HeaderMap, query: Option<&str>, page: bool, key: &str) -> bool {
    let supplied: Vec<_> = url::form_urlencoded::parse(query.unwrap_or("").as_bytes())
        .filter(|(name, _)| name == "key")
        .map(|(_, value)| value.into_owned())
        .collect();
    if !supplied.is_empty() {
        return supplied.len() == 1 && same(&supplied[0], key);
    }
    // A fresh document navigation always requires the key URL, even in an authenticated browser.
    if page {
        return false;
    }
    let expected = session(key);
    headers
        .get_all("cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|v| v.trim().strip_prefix("arc_browser="))
        .any(|value| same(value, &expected))
}
fn response(
    code: u16,
    body: impl Into<Bytes>,
    content_type: Option<&str>,
) -> Response<crate::wait_transport::Body> {
    let mut builder = Response::builder()
        .status(code)
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff");
    if let Some(content_type) = content_type {
        builder = builder.header("Content-Type", content_type);
    }
    builder.body(Full::new(body.into()).boxed()).unwrap()
}
fn empty(code: u16) -> Response<crate::wait_transport::Body> {
    response(code, Bytes::new(), None)
}

fn allowed(route: &str, method: &str) -> bool {
    match method {
        "GET" => {
            matches!(
                route,
                "status"
                    | "source"
                    | "agents"
                    | "agents/activity"
                    | "subscriptions"
                    | "tasks"
                    | "preferences"
                    | "accounts"
                    | "events"
                    | "subscriptions/events"
                    | "agents/activity/events"
            ) || route
                .strip_prefix("accounts/")
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        }
        "POST" => matches!(
            route,
            "agents/conversations"
                | "agents/conversations/timeline"
                | "coordination/board"
                | "coordination/events"
        ),
        _ => false,
    }
}

struct Stream(tokio::sync::mpsc::Receiver<Bytes>);
impl hyper::body::Body for Stream {
    type Data = Bytes;
    type Error = Infallible;
    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<std::result::Result<hyper::body::Frame<Bytes>, Infallible>>> {
        self.0
            .poll_recv(cx)
            .map(|frame| frame.map(|bytes| Ok(hyper::body::Frame::data(bytes))))
    }
}

pub(crate) async fn handle(
    request: Request<hyper::body::Incoming>,
    ingress: Arc<ingress::Ingress>,
    local_host: &str,
) -> Response<crate::wait_transport::Body> {
    let path = request.uri().path().to_owned();
    let page = path == "/" || path == "/browser.html";
    let Some(key) = stored_key() else {
        return empty(401);
    };
    if !authenticated(request.headers(), request.uri().query(), page, &key) {
        return empty(401);
    }
    let address = ingress.mcp_url.lock().await.clone();
    let Ok(public) = reqwest::Url::parse(&address) else {
        return empty(503);
    };
    let origin = public.origin().ascii_serialization();
    let host = request
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let public_host = origin.strip_prefix("https://").unwrap_or("");
    if (host != public_host && host != format!("{public_host}:443") && host != local_host)
        || request
            .headers()
            .get("origin")
            .is_some_and(|v| v.to_str().ok() != Some(origin.as_str()))
    {
        return empty(403);
    }
    if !ingress.connected.load(std::sync::atomic::Ordering::SeqCst) {
        return empty(503);
    }
    let method = request.method().as_str().to_owned();
    if let Some(route) = path.strip_prefix("/view-api/") {
        if !allowed(route, &method) {
            return empty(403);
        }
        let body = if method == "POST" {
            let bytes = match tokio::time::timeout(
                Duration::from_secs(5),
                Limited::new(request.into_body(), 16384).collect(),
            )
            .await
            {
                Ok(Ok(bytes)) => bytes.to_bytes(),
                _ => return empty(400),
            };
            let Ok(body) = serde_json::from_slice::<Value>(&bytes) else {
                return empty(400);
            };
            let operation = route.replace('/', ".");
            if crate::management::resolve(&operation, &json!({"body":body})).is_err() {
                return empty(400);
            }
            Some(body)
        } else {
            None
        };
        let port = ingress.port.load(std::sync::atomic::Ordering::SeqCst);
        let Ok(client) = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .build()
        else {
            return empty(503);
        };
        let mut upstream = client
            .request(
                reqwest::Method::from_bytes(method.as_bytes()).unwrap(),
                format!("http://127.0.0.1:{port}/api/{route}"),
            )
            .bearer_auth(&ingress.token);
        if let Some(body) = body {
            upstream = upstream.json(&body);
        }
        let streaming = matches!(
            route,
            "events" | "subscriptions/events" | "agents/activity/events"
        );
        if !streaming {
            upstream = upstream.timeout(Duration::from_secs(30));
        }
        let Ok(upstream) = upstream.send().await else {
            return empty(503);
        };
        if !upstream.status().is_success() {
            let code = upstream.status().as_u16();
            return match upstream.bytes().await {
                Ok(bytes) => response(code, bytes, Some("application/json")),
                Err(_) => empty(502),
            };
        }
        if streaming {
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            let mut stream = upstream.bytes_stream();
            tokio::spawn(async move {
                let mut check = tokio::time::interval(Duration::from_secs(2));
                loop {
                    tokio::select! {
                        _ = tx.closed() => break,
                        _ = check.tick() => {
                            if stored_key().is_none_or(|current| !same(&current, &key))
                                || !ingress.connected.load(std::sync::atomic::Ordering::SeqCst) { break; }
                        },
                        chunk = stream.next() => match chunk {
                            Some(Ok(bytes)) => if !matches!(tokio::time::timeout(Duration::from_secs(2), tx.send(bytes)).await, Ok(Ok(()))) { break; },
                            _ => break,
                        }
                    }
                }
            });
            let mut result = empty(200);
            result
                .headers_mut()
                .insert("Content-Type", "text/event-stream".parse().unwrap());
            result
                .headers_mut()
                .insert("X-Accel-Buffering", "no".parse().unwrap());
            *result.body_mut() = Stream(rx).boxed();
            return result;
        }
        return match upstream.bytes().await {
            Ok(bytes) => response(200, bytes, Some("application/json")),
            Err(_) => empty(502),
        };
    }
    if method != "GET" {
        return empty(403);
    }
    let asset_path = if page {
        "browser.html"
    } else {
        path.trim_start_matches('/')
    };
    let Some((_, bytes)) = BROWSER_ASSETS.iter().find(|(name, _)| *name == asset_path) else {
        return empty(404);
    };
    let content_type = match asset_path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    let mut result = response(200, Bytes::from_static(bytes), Some(content_type));
    result.headers_mut().insert("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'".parse().unwrap());
    if page {
        let base = public.path().strip_suffix("/mcp").unwrap_or("");
        result.headers_mut().insert(
            "Set-Cookie",
            format!(
                "arc_browser={}; Path={base}/; Secure; HttpOnly; SameSite=Strict",
                session(&key)
            )
            .parse()
            .unwrap(),
        );
    }
    result
}
