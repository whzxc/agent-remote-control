//! Official MCP Events: ingress-owned subscriptions and signed, public-only webhooks.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::hmac;
use std::net::{IpAddr, SocketAddr};

const NAME: &str = "task.status";
const LIMIT: usize = 256 * 1024;
const TTL_MS: i64 = 86_400_000;
const MAX_ATTEMPTS: u32 = 6;
// Serializes lifecycle changes with sends: after unsubscribe returns no send can start.
static OPERATION: Mutex<()> = Mutex::const_new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Subscription {
    id: String,
    ingress: String,
    principal: String,
    arguments: Value,
    url: String,
    secret: String,
    previous_secret: Option<String>,
    rotate_until: i64,
    verified_until: i64,
    created_at: i64,
    expires_at: i64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    subscription: String,
    ingress: String,
    thread: String,
    body: Value,
    status: String,
    attempts: u32,
    charged: bool,
    next_attempt_at: i64,
    error: Option<String>,
    timing: DeliveryTiming,
}
#[derive(Default, Serialize, Deserialize)]
struct Store {
    subscriptions: Vec<Subscription>,
    deliveries: Vec<Pending>,
}
impl Store {
    fn load(dir: &Path) -> Result<Self> {
        let path = dir.join("mcp-events/state.json");
        if !path.exists() {
            return Ok(Self::default());
        }
        serde_json::from_value(load(&path)?).map_err(|e| e.to_string())
    }
    fn save(&self, dir: &Path) -> Result<()> {
        save(
            &dir.join("mcp-events/state.json"),
            &serde_json::to_value(self).map_err(|e| e.to_string())?,
        )
    }
}
fn rpc(code: i64, reason: &str) -> String {
    json!({"code":code,"message":if code == -32015 {"CallbackEndpointError"} else {"Invalid event request"},"data":{"reason":reason}}).to_string()
}
fn invalid(reason: &str) -> String {
    rpc(-32602, reason)
}
fn key(secret: &str) -> Result<Vec<u8>> {
    let bytes = secret
        .strip_prefix("whsec_")
        .and_then(|s| STANDARD.decode(s).ok())
        .filter(|b| (24..=64).contains(&b.len()))
        .ok_or_else(|| invalid("invalid_signing_secret"))?;
    Ok(bytes)
}
fn signature(secret: &str, id: &str, timestamp: i64, body: &[u8]) -> Result<String> {
    let key = hmac::Key::new(hmac::HMAC_SHA256, &key(secret)?);
    let mut input = format!("{id}.{timestamp}.").into_bytes();
    input.extend_from_slice(body);
    Ok(format!(
        "v1,{}",
        STANDARD.encode(hmac::sign(&key, &input).as_ref())
    ))
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(matches!(a, 0 | 10 | 127 | 224..=255)
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && (b == 0 || b == 168 || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            // Global unicast only; exclude special-use, transition and documentation ranges.
            s[0] & 0xe000 == 0x2000
                && s[0] != 0x2002
                && s[0] != 0x3ffe
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}
fn callback_url(raw: &str) -> Result<reqwest::Url> {
    let u = reqwest::Url::parse(raw).map_err(|_| rpc(-32015, "invalid_url"))?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        return Err(rpc(-32015, "invalid_url"));
    }
    Ok(u)
}
async fn post(s: &Subscription, id: &str, body: &[u8]) -> Result<(u16, Vec<u8>)> {
    if body.len() > LIMIT {
        return Err("payload_too_large".into());
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        let url = callback_url(&s.url).map_err(|_| "invalid_url")?;
        let host = url
            .host_str()
            .ok_or("invalid_url")?
            .trim_matches(['[', ']']);
        let port = url.port_or_known_default().ok_or("invalid_url")?;
        let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| "dns_failed")?
            .collect();
        if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
            crate::logs::record(
                "WARN",
                &format!("MCP callback DNS rejected: host={host}; addresses={addresses:?}"),
                Some(&s.ingress),
            );
            return Err("non_public_address".to_owned());
        }
        // No environment proxy or connection pool: DNS validation also governs the actual socket.
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(host, &addresses)
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| "client_failed")?;
        let at = chrono::Utc::now().timestamp();
        let mut sig = signature(&s.secret, id, at, body)?;
        if s.rotate_until > at {
            if let Some(old) = &s.previous_secret {
                sig.push(' ');
                sig.push_str(&signature(old, id, at, body)?);
            }
        }
        let mut response = client
            .post(url)
            .header("Content-Type", "application/json")
            .header("webhook-id", id)
            .header("webhook-timestamp", at.to_string())
            .header("webhook-signature", sig)
            .header("X-MCP-Subscription-Id", &s.id)
            .body(body.to_vec())
            .send()
            .await
            .map_err(|_| "connection_failed")?;
        let status = response.status().as_u16();
        if !id.starts_with("msg_verification_") {
            return Ok((status, Vec::new()));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "response_failed")? {
            if bytes.len() + chunk.len() > 8192 {
                return Err("response_too_large".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((status, bytes))
    })
    .await
    .map_err(|_| "timeout".to_owned())?
}

pub(crate) async fn principal(s: &crate::ingress::Ingress, header: Option<&str>) -> Result<String> {
    let meta = s.meta.lock().await;
    if meta["auth"] == "oauth" {
        let header = header.ok_or_else(|| rpc(-32001, "authenticated_principal_required"))?;
        drop(meta);
        return s
            .oauth
            .lock()
            .await
            .event_principal(header)
            .ok_or_else(|| rpc(-32001, "access_revoked"));
    }
    Ok(hash(
        json!([
            s.id,
            meta["auth"],
            meta["bearerToken"],
            meta["config"]["tunnelId"],
            meta["config"]["apiKey"]
        ])
        .to_string(),
    ))
}
async fn authorized(s: &crate::ingress::Ingress, principal: &str) -> bool {
    let meta = s.meta.lock().await;
    if meta["enabled"] != true {
        return false;
    }
    let oauth = meta["auth"] == "oauth";
    drop(meta);
    if oauth {
        let resource = s.mcp_url.lock().await.clone();
        s.oauth
            .lock()
            .await
            .event_grant_active(principal, &resource)
    } else {
        self::principal(s, None).await.is_ok_and(|p| p == principal)
    }
}
pub(crate) fn list() -> Value {
    json!({"events":[{"name":NAME,"description":"ARC task completed, failed, interrupted, or needs input. Only tasks dispatched through this ingress. Subscribe in Work Cloud; read full results with query.","delivery":["webhook"],
        "inputSchema":{"type":"object","properties":{"threadId":{"type":"string","minLength":1},"taskId":{"type":"string","minLength":1}},"additionalProperties":false},
        "payloadSchema":{"type":"object","properties":{"kind":{"type":"string","enum":["completed","failed","interrupted","needs-input"]},"summary":{"type":"string"},"threadId":{"type":["string","null"]},"taskId":{"type":["string","null"]},"turnId":{"type":"string"},"agent":{"type":"string"},"project":{"type":"string"},"title":{"type":"string"},"query":{"type":"object"}},"required":["kind","summary","threadId","taskId","turnId","agent","project","title","query"],"additionalProperties":false}}]})
}
pub(crate) async fn request(
    s: &crate::ingress::Ingress,
    method: &str,
    params: &Value,
) -> Result<Value> {
    let principal = crate::kernel::origin::current_origin()["eventPrincipal"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| rpc(-32001, "authenticated_principal_required"))?;
    if !s.connected.load(std::sync::atomic::Ordering::SeqCst) || !authorized(s, &principal).await {
        return Err(rpc(-32001, "access_revoked"));
    }
    if method != "events/unsubscribe"
        && !s.allows("codex_read").await
        && !s.allows("agent_read").await
    {
        return if method == "events/list" {
            Ok(json!({"events":[]}))
        } else {
            Err(rpc(-32001, "event_access_denied"))
        };
    }
    if method == "events/list" {
        return Ok(list());
    }
    if params["name"] != NAME || params["delivery"]["mode"] != "webhook" {
        return Err(invalid("unsupported_event_or_delivery"));
    }
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    crate::validator("event", NAME, &list()["events"][0]["inputSchema"])?
        .validate(&args)
        .map_err(|_| invalid("invalid_arguments"))?;
    // Explicit order also works when a desktop dependency enables preserve_order.
    let mut canonical = serde_json::Map::new();
    for field in ["taskId", "threadId"] {
        if let Some(value) = args.get(field) {
            canonical.insert(field.into(), value.clone());
        }
    }
    let args = Value::Object(canonical);
    let url = callback_url(string(&params["delivery"], "url"))?.to_string();
    let sub_id = format!(
        "sub_{}",
        hash(json!([s.id, principal, NAME, args, url]).to_string())
    );
    let _operation = OPERATION.lock().await;
    let dir = directory();
    let mut store = Store::load(&dir)?;
    if method == "events/unsubscribe" {
        store.subscriptions.retain(|s| s.id != sub_id);
        for d in &mut store.deliveries {
            if d.subscription == sub_id && matches!(d.status.as_str(), "pending" | "sending") {
                d.status = "unsubscribed".into();
                d.timing.finished_at = Some(chrono::Utc::now().timestamp_millis());
            }
        }
        store.save(&dir)?;
        return Ok(json!({}));
    }
    if !params["cursor"].is_null() {
        return Err(invalid("replay_not_supported"));
    }
    let secret = string(&params["delivery"], "secret").to_owned();
    key(&secret)?;
    let ttl = match params.get("ttlMs") {
        None | Some(Value::Null) => TTL_MS,
        Some(v) => v
            .as_i64()
            .filter(|v| *v > 0)
            .ok_or_else(|| invalid("invalid_ttl"))?
            .min(TTL_MS),
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let now = now_ms / 1000;
    let old = store.subscriptions.iter().find(|s| s.id == sub_id);
    let mut sub = Subscription {
        id: sub_id.clone(),
        ingress: s.id.clone(),
        principal: principal.clone(),
        arguments: args,
        url,
        secret,
        previous_secret: None,
        rotate_until: 0,
        verified_until: 0,
        created_at: now_ms,
        expires_at: now_ms + ttl,
    };
    if let Some(old) = old {
        if old.expires_at > now_ms {
            sub.created_at = old.created_at;
        }
        if old.secret != sub.secret {
            sub.previous_secret = Some(old.secret.clone());
            sub.rotate_until = now + 300;
        } else {
            sub.previous_secret = old.previous_secret.clone();
            sub.rotate_until = old.rotate_until;
        }
    }
    let verified_until = store
        .subscriptions
        .iter()
        .filter(|v| {
            v.principal == principal
                && v.ingress == s.id
                && v.url == sub.url
                && v.secret == sub.secret
        })
        .map(|v| v.verified_until)
        .max()
        .unwrap_or(0);
    if verified_until <= now {
        let challenge = id() + &id();
        let body =
            serde_json::to_vec(&json!({"type":"verification","challenge":challenge})).unwrap();
        let (status, bytes) = post(&sub, &format!("msg_verification_{}", id()), &body)
            .await
            .map_err(|e| rpc(-32015, &e))?;
        let response: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let compare_key = hmac::Key::new(hmac::HMAC_SHA256, &key(&sub.secret)?);
        let expected = hmac::sign(&compare_key, challenge.as_bytes());
        if !(200..300).contains(&status)
            || hmac::verify(
                &compare_key,
                string(&response, "challenge").as_bytes(),
                expected.as_ref(),
            )
            .is_err()
        {
            return Err(rpc(-32015, "challenge_failed"));
        }
    }
    sub.verified_until = if verified_until > now {
        verified_until
    } else {
        now + 300
    };
    if !s.connected.load(std::sync::atomic::Ordering::SeqCst) || !authorized(s, &principal).await {
        return Err(rpc(-32001, "access_revoked"));
    }
    // Expiration is granted after callback verification, including very short requested TTLs.
    sub.expires_at = chrono::Utc::now().timestamp_millis() + ttl;
    let expiration = chrono::DateTime::from_timestamp_millis(sub.expires_at)
        .unwrap()
        .to_rfc3339();
    store.subscriptions.retain(|s| s.id != sub_id);
    store.subscriptions.push(sub);
    store.save(&dir)?;
    Ok(json!({"id":sub_id,"refreshBefore":expiration,"cursor":null,"truncated":false}))
}

pub(super) fn owns(dir: &Path, ingress: &str, target: &str) -> Result<bool> {
    Ok(Store::load(dir)?
        .subscriptions
        .iter()
        .any(|s| s.ingress == ingress && s.id == target))
}
pub(super) fn status(dir: &Path, ingress: &str, args: &Value) -> Result<Value> {
    let store = Store::load(dir)?;
    let matches = |id: &str, thread: Option<&str>| {
        args["target"].as_str().is_none_or(|t| t == id)
            && args["threadId"]
                .as_str()
                .is_none_or(|t| thread.is_none_or(|v| v == t))
    };
    let now = chrono::Utc::now().timestamp_millis();
    let mut state = State::load(dir)?;
    let settings = settings()?;
    let ids: std::collections::BTreeSet<_> = store
        .subscriptions
        .iter()
        .filter(|s| s.ingress == ingress && matches(&s.id, s.arguments["threadId"].as_str()))
        .map(|s| s.id.clone())
        .chain(
            store
                .deliveries
                .iter()
                .filter(|d| d.ingress == ingress && matches(&d.subscription, Some(&d.thread)))
                .map(|d| d.subscription.clone()),
        )
        .collect();
    let buckets = ids.iter().map(|id| { let target = state.target(Channel::McpEvents,id,now/1000,&settings); json!({"subscriptionId":id,"tokens":target.tokens,"capacity":governance::capacity(&settings),"refillSeconds":governance::refill_seconds(&settings),"breaker":target.breaker,"recentBatches":target.batches}) }).collect::<Vec<_>>();
    Ok(
        json!({"buckets":buckets,"channel":"mcp-events","subscriptions":store.subscriptions.iter().filter(|s|s.ingress == ingress && matches(&s.id,s.arguments["threadId"].as_str())).map(|s|json!({"id":s.id,"arguments":s.arguments,"refreshBefore":chrono::DateTime::from_timestamp_millis(s.expires_at).map(|d|d.to_rfc3339()),"active":s.expires_at > now})).collect::<Vec<_>>(),
        "deliveries":store.deliveries.iter().filter(|d|d.ingress == ingress && matches(&d.subscription,Some(&d.thread))).map(|d|json!({"subscriptionId":d.subscription,"eventId":d.body["eventId"],"kind":d.body["data"]["kind"],"threadId":d.body["data"]["threadId"],"taskId":d.body["data"]["taskId"],"state":d.status,"attempts":d.attempts,"nextAttemptAt":d.next_attempt_at,"error":d.error,"timing":d.timing})).collect::<Vec<_>>()}),
    )
}

async fn flush(service: &crate::service::Service) -> Result<()> {
    let _operation = OPERATION.lock().await;
    let dir = directory();
    let mut store = Store::load(&dir)?;
    if store.subscriptions.is_empty() && store.deliveries.is_empty() {
        return Ok(());
    }
    let now = chrono::Utc::now().timestamp();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut active = Vec::new();
    for sub in &store.subscriptions {
        let Ok(ingress) = service.ingress(&sub.ingress).await else {
            continue;
        };
        if sub.expires_at > now_ms && authorized(&ingress, &sub.principal).await {
            active.push(sub.id.clone());
        }
    }
    store.subscriptions.retain(|s| active.contains(&s.id));
    for sub in &mut store.subscriptions {
        if sub.rotate_until <= now {
            sub.previous_secret = None;
        }
    }
    let bindings = {
        let _guard = LOCK.lock().await;
        records(&dir)?
    };
    for sub in &store.subscriptions {
        for b in &bindings {
            if b.ingress != sub.ingress {
                continue;
            }
            for d in &b.deliveries {
                let event = event(b, d);
                if d.timing.queued_at.unwrap_or(d.created_at * 1000) < sub.created_at
                    || d.status == "resolved"
                    || event["interaction"]["resolved"] == true
                    || ["threadId", "taskId"]
                        .iter()
                        .any(|k| sub.arguments[*k].as_str().is_some_and(|v| event[*k] != v))
                    || store
                        .deliveries
                        .iter()
                        .any(|p| p.subscription == sub.id && p.body["eventId"] == d.event_id)
                {
                    continue;
                }
                let mut data = json!({});
                for k in [
                    "kind", "summary", "threadId", "taskId", "turnId", "agent", "project", "title",
                ] {
                    data[k] = event[k].clone();
                }
                let agent = !b.agent.is_empty() && b.agent != "codex";
                let pending = event["kind"] == "needs-input";
                data["query"] = if agent {
                    json!({"op":if pending {"agent_pending"} else {"agent_read"},"args":{"agent":b.agent,"taskId":b.thread_id}})
                } else {
                    json!({"op":if pending {"codex_pending"} else {"codex_read"},"args":{"threadId":b.thread_id}})
                };
                store.deliveries.push(Pending { subscription:sub.id.clone(),ingress:sub.ingress.clone(),thread:b.thread_id.clone(),body:json!({"eventId":d.event_id,"name":NAME,"timestamp":chrono::DateTime::from_timestamp(d.created_at,0).unwrap().to_rfc3339(),"data":data,"cursor":null}),status:"pending".into(),attempts:0,charged:false,next_attempt_at:0,error:None,timing:DeliveryTiming {queued_at:d.timing.queued_at,..Default::default()} });
            }
        }
    }
    // Keep dedup records as long as their source records can be scanned.
    store.deliveries.retain(|d| {
        matches!(d.status.as_str(), "pending" | "sending")
            || store.subscriptions.iter().any(|s| s.id == d.subscription)
            || d.timing.finished_at.unwrap_or(now_ms) >= now_ms - RETENTION_SECONDS * 1000
    });
    store.save(&dir)?;
    for i in 0..store.deliveries.len() {
        let d = &store.deliveries[i];
        if !matches!(d.status.as_str(), "pending" | "sending") {
            continue;
        }
        let sub = store
            .subscriptions
            .iter()
            .find(|s| s.id == d.subscription)
            .cloned();
        let Some(sub) = sub else {
            store.deliveries[i].status = "subscription-ended".into();
            store.deliveries[i].timing.finished_at = Some(now_ms);
            continue;
        };
        let ingress = service.ingress(&sub.ingress).await?;
        if !ingress.connected.load(std::sync::atomic::Ordering::SeqCst)
            || !authorized(&ingress, &sub.principal).await
            || sub.expires_at <= chrono::Utc::now().timestamp_millis()
        {
            continue;
        }
        if !ingress.allows(string(&d.body["data"]["query"], "op")).await {
            store.deliveries[i].status = "access-revoked".into();
            store.deliveries[i].timing.finished_at = Some(now_ms);
            continue;
        }
        if d.next_attempt_at > now {
            continue;
        }
        if d.attempts >= MAX_ATTEMPTS {
            store.deliveries[i].status = "failed".into();
            store.deliveries[i].timing.finished_at = Some(now_ms);
            continue;
        }
        let Some(binding) = bindings.iter().find(|b| {
            b.thread_id == d.thread && b.deliveries.iter().any(|e| e.event_id == d.body["eventId"])
        }) else {
            continue;
        };
        if binding.deliveries.iter().any(|e| {
            e.event_id == d.body["eventId"]
                && (e.status == "resolved" || e.interaction["resolved"] == true)
        }) {
            store.deliveries[i].status = "resolved".into();
            store.deliveries[i].timing.finished_at = Some(now_ms);
            continue;
        }
        let settings = settings()?;
        {
            let _guard = LOCK.lock().await;
            let mut state = State::load(&dir)?;
            let mode = state
                .rule(binding)
                .map(|r| r.mode(now))
                .unwrap_or("normal")
                .to_owned();
            let target = state.target(Channel::McpEvents, &sub.id, now, &settings);
            let reason = if settings["notificationsEnabled"] == false {
                Some("disabled")
            } else if target.breaker {
                Some("breaker")
            } else if mode == "mute" {
                Some("muted")
            } else if mode == "digest" && now - d.timing.queued_at.unwrap_or(now_ms) / 1000 < 3600 {
                Some("digest-wait")
            } else if !d.charged && target.tokens == 0 {
                Some("token-wait")
            } else {
                None
            };
            if let Some(reason) = reason {
                store.deliveries[i].timing.queue_reason = Some(reason.into());
                state.save(&dir)?;
                continue;
            }
            let charged = !d.charged;
            if charged {
                target.tokens -= 1;
            }
            target.batches.push(governance::Batch {
                id: format!("{}:{}", d.body["eventId"], d.attempts + 1),
                at: now,
                kinds: std::collections::BTreeMap::from([(
                    string(&d.body["data"], "kind").into(),
                    1,
                )]),
                threads: vec![d.thread.clone()],
                status: "sending".into(),
                charged,
            });
            state.save(&dir)?;
        }
        let d = &mut store.deliveries[i];
        d.charged = true;
        d.attempts += 1;
        d.status = "sending".into();
        let started = chrono::Utc::now().timestamp_millis();
        d.timing.started_at = Some(started);
        d.timing.queue_ms = d.timing.queued_at.map(|t| started.saturating_sub(t));
        let body = serde_json::to_vec(&d.body).map_err(|e| e.to_string())?;
        let event_id = string(&d.body, "eventId").to_owned();
        store.save(&dir)?;
        let response = post(&sub, &event_id, &body).await;
        let d = &mut store.deliveries[i];
        let finished = chrono::Utc::now().timestamp_millis();
        d.timing.finished_at = Some(finished);
        d.timing.send_ms = Some((finished - started).max(0) as u64);
        match response {
            Ok((code, _)) if (200..300).contains(&code) => {
                d.status = "callback-accepted".into();
                d.error = None;
                d.next_attempt_at = 0;
            }
            Ok((410, _)) => {
                d.status = "subscription-gone".into();
                d.error = Some("http_410".into());
                store.subscriptions.retain(|s| s.id != sub.id);
            }
            result => {
                let (error, retry) = match result {
                    Ok((code, _)) => (
                        format!("http_{code}"),
                        code != 413 && (code == 408 || code == 429 || code >= 500),
                    ),
                    Err(error) => {
                        let retry = matches!(
                            error.as_str(),
                            "timeout" | "connection_failed" | "dns_failed" | "response_failed"
                        );
                        (error, retry)
                    }
                };
                d.status = if retry && d.attempts < MAX_ATTEMPTS {
                    "pending"
                } else {
                    "failed"
                }
                .into();
                d.error = Some(error);
                d.next_attempt_at = finished / 1000 + governance::retry_seconds(d.attempts);
            }
        }
        {
            let _guard = LOCK.lock().await;
            let mut state = State::load(&dir)?;
            let target = state.target(Channel::McpEvents, &sub.id, now, &settings);
            if let Some(batch) = target.batches.last_mut() {
                batch.status = d.status.clone();
            }
            state.save(&dir)?;
        }
        store.save(&dir)?;
        break; // Bound lifecycle RPC latency to one callback timeout.
    }
    store.save(&dir)
}
pub(crate) fn start(service: &Arc<crate::service::Service>) {
    let weak = Arc::downgrade(service);
    let mut shutdown = service.control.shutdown.subscribe();
    tokio::spawn(async move {
        loop {
            let Some(service) = weak.upgrade() else {
                break;
            };
            tokio::select! { _ = shutdown.changed() => break, result = flush(&service) => if result.is_err() {crate::logs::record("WARN","MCP event delivery cycle failed",None);} }
            drop(service);
            tokio::select! { _ = shutdown.changed() => break, _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
        }
    });
}
