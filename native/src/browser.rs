//! Key-authenticated, read-only browser surface on existing HTTPS ingresses.
use crate::*;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Bytes, Request, Response};
use ring::rand::{SecureRandom, SystemRandom};
use std::{convert::Infallible, time::Duration};

include!(concat!(env!("OUT_DIR"), "/browser_assets.rs"));

pub(crate) fn not_modified(validator: Option<&str>, etag: &str) -> bool {
    // Compression proxies may weaken an ETag without changing its entity.
    validator.is_some_and(|value| {
        value.split(',').any(|tag| {
            let tag = tag.trim();
            tag == "*" || tag.strip_prefix("W/").unwrap_or(tag) == etag
        })
    })
}

fn key_path() -> PathBuf {
    root().join("app/browser-access.json")
}
fn stored_key() -> Option<String> {
    load(&key_path()).ok()?["key"].as_str().map(str::to_owned)
}
pub(crate) fn key_digest() -> Option<String> {
    stored_key().map(hash)
}
pub(crate) async fn access(
    entries: Vec<Arc<crate::ingress::Ingress>>,
    rotate: bool,
) -> Result<Value> {
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
    for ingress in entries {
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
fn authenticated(headers: &hyper::HeaderMap, query: Option<&str>, key: &str) -> bool {
    let supplied: Vec<_> = url::form_urlencoded::parse(query.unwrap_or("").as_bytes())
        .filter(|(name, _)| name == "key")
        .map(|(_, value)| value.into_owned())
        .collect();
    if !supplied.is_empty() {
        return supplied.len() == 1 && same(&supplied[0], key);
    }
    if let Some(header) = headers.get("authorization") {
        return header
            .to_str()
            .ok()
            .and_then(|v| v.strip_prefix("Bearer "))
            .is_some_and(|value| same(value, key));
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

pub(crate) fn compact_status(mut value: Value) -> Value {
    value.as_object_mut().unwrap().remove("logs");
    if let Some(core) = value["core"].as_object_mut() {
        core.remove("logs");
    }
    if let Some(ingresses) = value["ingresses"].as_array_mut() {
        for ingress in ingresses {
            if let Some(fields) = ingress.as_object_mut() {
                for field in ["logs", "requests", "platformInfo"] {
                    fields.remove(field);
                }
            }
        }
    }
    value["sources"] = json!(crate::sources::control_sources().unwrap_or_default());
    value
}

pub(crate) fn status_comparison(value: &Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .filter(|(name, _)| {
                    ![
                        "observedAt",
                        "sampledAt",
                        "attemptedAt",
                        "lastReadyAt",
                        "requests",
                        "logs",
                    ]
                    .contains(&name.as_str())
                })
                .map(|(name, value)| (name.clone(), status_comparison(value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(status_comparison).collect()),
        _ => value.clone(),
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
    let query = request.uri().query().map(str::to_owned);
    let validator = request
        .headers()
        .get("if-none-match")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let page = path == "/" || path == "/browser.html";
    let Some(key) = stored_key() else {
        return empty(401);
    };
    if !authenticated(request.headers(), query.as_deref(), &key) {
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
        if !crate::core_requests::browser_allowed(route, &method) {
            return empty(403);
        }
        let mut body = if method == "POST" {
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
            body
        } else {
            json!({})
        };
        if let Err(error) = crate::core_requests::authorize_browser(route, &method, &body) {
            return empty(if error == "FRONT_DOOR_BROWSER_INVALID" {
                400
            } else {
                403
            });
        }
        if route.starts_with("agents/timeline/") {
            for (key, value) in
                url::form_urlencoded::parse(query.as_deref().unwrap_or("").as_bytes())
            {
                match key.as_ref() {
                    "after" => {
                        let Ok(after) = value.parse::<u64>() else {
                            return empty(400);
                        };
                        body["after"] = json!(after);
                    }
                    "recent" if value == "1" => body["recent"] = json!(true),
                    _ => {}
                }
            }
        }
        if matches!(
            route,
            "events" | "subscriptions/events" | "agents/activity/events"
        ) {
            let kind = match route {
                "events" => crate::front_door::Snapshot::Browser,
                "subscriptions/events" => crate::front_door::Snapshot::Subscriptions,
                _ => crate::front_door::Snapshot::Activity,
            };
            let Ok(rx) = crate::front_door::browser_stream(&ingress, &key, kind).await else {
                return empty(503);
            };
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
        let value =
            match crate::front_door::browser_request(&ingress, &key, route, &method, body).await {
                Ok(value) => value,
                Err(error) if error == "FRONT_DOOR_BROWSER_FORBIDDEN" => return empty(403),
                Err(error) if error == "FRONT_DOOR_BROWSER_INVALID" => return empty(400),
                Err(error) if error == "FRONT_DOOR_BROWSER_UNAUTHORIZED" => return empty(401),
                Err(error) if error.starts_with("FRONT_DOOR_") => return empty(503),
                Err(error) => {
                    return response(
                        400,
                        json!({"error":error}).to_string(),
                        Some("application/json"),
                    )
                }
            };
        let bytes = serde_json::to_vec(&value).unwrap();
        let etag = format!("\"{}\"", hash(&bytes));
        // Preserve the upstream conditional-read response, including its empty body.
        if not_modified(validator.as_deref(), &etag) {
            if method == "GET"
                || matches!(
                    route,
                    "agents/conversations" | "agents/conversations/timeline" | "tasks/reviews"
                )
            {
                return response(304, Bytes::new(), Some("application/json"));
            }
            let mut result = empty(304);
            result.headers_mut().insert("ETag", etag.parse().unwrap());
            return result;
        }
        let mut result = response(200, bytes, Some("application/json"));
        result.headers_mut().insert("ETag", etag.parse().unwrap());
        return result;
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
                "arc_browser={}; Path={base}/; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict",
                session(&key)
            )
            .parse()
            .unwrap(),
        );
    }
    result
}
