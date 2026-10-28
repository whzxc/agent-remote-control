//! Official MCP Events: ingress-owned subscriptions and signed, public-only webhooks.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::hmac;
use std::net::{IpAddr, SocketAddr};

pub(super) const NAME: &str = "notification";
const LIMIT: usize = 256 * 1024;
const TTL_MS: i64 = 86_400_000;
// Lifecycle calls and the shared sender serialize; unsubscribe cannot race a new send.
pub(super) static OPERATION: Mutex<()> = Mutex::const_new(());
use super::subscriptions::{Subscription, Webhook};

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
        let url = callback_url(&s.webhook.as_ref().ok_or("missing_webhook")?.url)
            .map_err(|_| "invalid_url")?;
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
                None,
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
        let mut sig = signature(
            &s.webhook.as_ref().ok_or("missing_webhook")?.secret,
            id,
            at,
            body,
        )?;
        if s.webhook.as_ref().ok_or("missing_webhook")?.rotate_until > at {
            if let Some(old) = &s.webhook.as_ref().ok_or("missing_webhook")?.previous_secret {
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
        if !crate::sources::for_grant(&s.id, principal)
            .is_ok_and(|source| source["state"] != "revoked")
        {
            return false;
        }
        let resource = s.mcp_url.lock().await.clone();
        s.oauth
            .lock()
            .await
            .event_grant_active(principal, &resource)
    } else {
        !crate::sources::ingress_retired(&s.id)
            && self::principal(s, None).await.is_ok_and(|p| p == principal)
    }
}
pub(crate) fn list() -> Value {
    json!({"events":[{"name":NAME,"description":"ARC notifications. Read guide({topic:notify}) for supported op and args contracts. Currently task_status wakes only for completed, failed, interrupted without automatic resume, or needs-input tasks from this source. Lifecycle and handoff records remain inbox-only. Work wakeups may take minutes; read full results with query.","delivery":["webhook"],
        "inputSchema":subscriptions::guide()["inputSchema"],
        "payloadSchema":{"type":"object","properties":{"op":{"type":"string"},"kind":{"type":"string"},"summary":{"type":"string"},"threadId":{"type":["string","null"]},"taskId":{"type":["string","null"]},"turnId":{"type":"string"},"agent":{"type":"string"},"project":{"type":"string"},"title":{"type":"string"},"query":{"type":"object"},
        "recovery":{"type":["object","null"],"properties":{"recoveredAt":{"type":"string","format":"date-time"},"affectedTasks":{"type":"integer","minimum":0}},"required":["recoveredAt","affectedTasks"],"additionalProperties":false},
        "continuation":{"type":["object","null"],"properties":{"turnId":{"type":"string"},"state":{"type":"string","enum":["running","completed","failed","interrupted","needs-input","unknown"]}},"required":["turnId","state"],"additionalProperties":false},
        "reconciliation":{"type":["object","null"],"properties":{"endedAt":{"type":["string","null"],"format":"date-time"},"durationMs":{"type":["integer","null"],"minimum":0},"timeBasis":{"type":"string","enum":["native-terminal","last-observed-activity","unknown","observed-terminal"]}},"required":["endedAt","durationMs","timeBasis"],"additionalProperties":false},
        "ownership":{"type":["object","null"],"properties":{"eventId":{"type":"string"},"from":{"type":"string"},"to":{"type":"string"},"observedAt":{"type":"string","format":"date-time"},"evidence":{"type":["string","null"]},"timeBasis":{"type":"string"}},"required":["eventId","from","to","observedAt","evidence","timeBasis"],"additionalProperties":false}},"required":["op","kind","summary","threadId","taskId","turnId","agent","project","title","query","ownership","reconciliation","continuation","recovery"],"additionalProperties":false}}]})
}

pub(crate) fn payload(op: &str, event: &Value) -> Value {
    let agent = event["agent"] != "codex";
    let pending = event["kind"] == "needs-input";
    let query = if event["next"]["op"] == "update_status" {
        json!({"op":"update_status","args":{}})
    } else if event["kind"] == "recovered" {
        json!({"op":"notify_status","args":{"target":event["target"]}})
    } else if agent {
        json!({"op":if pending {"agent_pending"} else {"agent_read"},"args":{"agent":event["agent"],"taskId":event["taskId"]}})
    } else {
        json!({"op":if pending {"codex_pending"} else {"codex_read"},"args":{"threadId":event["threadId"]}})
    };
    let mut data = json!({"op":op,"query":query});
    for key in [
        "kind",
        "summary",
        "threadId",
        "taskId",
        "turnId",
        "agent",
        "project",
        "title",
        "ownership",
        "reconciliation",
        "continuation",
        "recovery",
    ] {
        data[key] = event[key].clone();
    }
    // Internal acquisition attribution is not part of the frozen ownership payload.
    if let Some(ownership) = data["ownership"].as_object_mut() {
        ownership.remove("causedBySourceId");
    }
    // Lifecycle text lives in summary, outside the strict recovery payload.
    if let Some(recovery) = data["recovery"].as_object_mut() {
        recovery.remove("message");
    }
    data
}
pub(crate) async fn request(
    s: &crate::ingress::Ingress,
    method: &str,
    params: &Value,
) -> Result<Value> {
    let source_id = string(&crate::kernel::origin::current_origin(), "sourceId").to_owned();
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
        return Err(invalid("Use name=notification, delivery.mode=webhook and arguments={op:task_status,args:{}}; see guide({topic:notify})"));
    }
    let args = subscriptions::validate(&params["arguments"])?;
    let url = callback_url(string(&params["delivery"], "url"))?.to_string();
    let sub_id = format!(
        "sub_{}",
        hash(json!([source_id, principal, NAME, args, url]).to_string())
    );
    let _operation = OPERATION.lock().await;
    let _guard = LOCK.lock().await;
    let dir = directory();
    let mut store = State::load(&dir)?;
    if method == "events/unsubscribe" {
        store.subscriptions.retain(|s| s.id != sub_id);
        for mut b in records(&dir)? {
            for d in &mut b.deliveries {
                if d.subscription == sub_id && matches!(d.status.as_str(), "pending" | "sending") {
                    d.status = "unsubscribed".into();
                    d.timing.finished_at = Some(chrono::Utc::now().timestamp_millis());
                }
            }
            persist(&dir, &b)?;
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
    let mut webhook = Webhook {
        principal: principal.clone(),
        url,
        secret,
        ..Default::default()
    };
    let mut created_at = now_ms;
    if let Some(old) = old {
        if old.active(now_ms) {
            created_at = old.created_at;
        }
        if let Some(w) = &old.webhook {
            if w.secret != webhook.secret {
                webhook.previous_secret = Some(w.secret.clone());
                webhook.rotate_until = now + 300;
            } else {
                webhook.previous_secret = w.previous_secret.clone();
                webhook.rotate_until = w.rotate_until;
            }
        }
    }
    let verified_until = store
        .subscriptions
        .iter()
        .filter_map(|v| {
            v.webhook.as_ref().filter(|w| {
                v.source_id == source_id
                    && w.principal == principal
                    && w.url == webhook.url
                    && w.secret == webhook.secret
            })
        })
        .map(|w| w.verified_until)
        .max()
        .unwrap_or(0);
    let mut sub = Subscription {
        id: sub_id.clone(),
        source_id: source_id.clone(),
        channel: Channel::McpEvents,
        target: sub_id.clone(),
        op: "task_status".into(),
        args: args["args"].clone(),
        turn: None,
        created_at,
        expires_at: Some(now_ms + ttl),
        webhook: Some(webhook),
        muted: old.is_some_and(|s| s.muted),
        until: old.and_then(|s| s.until),
    };
    if verified_until <= now {
        let challenge = id() + &id();
        let body =
            serde_json::to_vec(&json!({"type":"verification","challenge":challenge})).unwrap();
        let (status, bytes) = post(&sub, &format!("msg_verification_{}", id()), &body)
            .await
            .map_err(|e| rpc(-32015, &e))?;
        let response: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let compare_key = hmac::Key::new(
            hmac::HMAC_SHA256,
            &key(&sub.webhook.as_ref().unwrap().secret)?,
        );
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
    sub.webhook.as_mut().unwrap().verified_until = if verified_until > now {
        verified_until
    } else {
        now + 300
    };
    if !s.connected.load(std::sync::atomic::Ordering::SeqCst) || !authorized(s, &principal).await {
        return Err(rpc(-32001, "access_revoked"));
    }
    // Expiration is granted after callback verification, including very short requested TTLs.
    sub.expires_at = Some(chrono::Utc::now().timestamp_millis() + ttl);
    let expiration = chrono::DateTime::from_timestamp_millis(sub.expires_at.unwrap())
        .unwrap()
        .to_rfc3339();
    store.subscriptions.retain(|s| s.id != sub_id);
    store.subscriptions.push(sub);
    store.save(&dir)?;
    Ok(json!({"id":sub_id,"refreshBefore":expiration,"cursor":null,"truncated":false}))
}

// Channel adapter only: routing, dedup, controls, buckets and retries belong to the shared sender.
pub(super) async fn send(
    service: &crate::service::Service,
    sub: &Subscription,
    b: &Binding,
    d: &Delivery,
) -> SendOutcome {
    let Some(w) = &sub.webhook else {
        return SendOutcome::failed("missing_webhook", false);
    };
    let Ok(source) = crate::sources::get(&sub.source_id) else {
        return SendOutcome::failed("access_revoked", false);
    };
    if source["state"] == "revoked" {
        return SendOutcome::failed("access_revoked", false);
    }
    let Ok(ingress) = service.ingress(string(&source, "ingressId")).await else {
        return SendOutcome::failed("access_revoked", false);
    };
    if !sub.active(chrono::Utc::now().timestamp_millis())
        || !authorized(&ingress, &w.principal).await
    {
        return SendOutcome {
            remove_subscription: true,
            ..SendOutcome::failed("access_revoked", false)
        };
    }
    if !ingress.connected.load(std::sync::atomic::Ordering::SeqCst) {
        return SendOutcome::failed("ingress_disconnected", true);
    }
    let event = event(b, d);
    let data = payload(&sub.op, &event);
    if !ingress.allows(string(&data["query"], "op")).await {
        return SendOutcome::failed("access_revoked", false);
    }
    let body = json!({"eventId":d.event_id,"name":NAME,"timestamp":chrono::DateTime::from_timestamp(d.created_at,0).unwrap().to_rfc3339(),"data":data,"cursor":null});
    match post(sub, &d.event_id, &serde_json::to_vec(&body).unwrap()).await {
        Ok((code, _)) if (200..300).contains(&code) => SendOutcome::success("callback-accepted"),
        Ok((410, _)) => SendOutcome {
            remove_subscription: true,
            ..SendOutcome::failed("http_410", false)
        },
        Ok((code, _)) => SendOutcome::failed(
            &format!("http_{code}"),
            code != 413 && (code == 408 || code == 429 || code >= 500),
        ),
        Err(error) => {
            let retry = matches!(
                error.as_str(),
                "timeout" | "connection_failed" | "dns_failed" | "response_failed"
            );
            SendOutcome::failed(&error, retry)
        }
    }
}
