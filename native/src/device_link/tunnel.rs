//! Provider-neutral HTTPS pipe with device-key authentication and bounded requests.
use super::*;
use base64::engine::general_purpose::STANDARD;
use http_body_util::{BodyExt, Limited};
use hyper::{body::Incoming, Request};

pub(super) const REQUEST_CAP: usize = 1024 * 1024;
pub(super) const RESPONSE_CAP: usize = 4 * 1024 * 1024;
pub(super) const DEADLINE: Duration = Duration::from_secs(25);
pub(super) const WAIT_MS: u64 = 15_000;
const AUTH_CAP: usize = 32;
const CHALLENGE_TTL: Duration = Duration::from_secs(30);
const TOKEN_TTL: Duration = Duration::from_secs(300);
#[derive(Default)]
pub(super) struct Auth {
    pub(super) challenges: BTreeMap<String, (String, Instant, u64)>,
    pub(super) tokens: BTreeMap<String, (String, Instant, u64)>,
}
fn auth_error() -> String {
    error("DEVICE_TUNNEL_AUTH", "Request a fresh peer challenge and sign it with the paired device key; query guide for device.")
}
fn random() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
pub(super) fn transcript(member: &str, controller: &str, challenge: &str) -> String {
    format!("arc-peer/3/session:{member}:{controller}:{challenge}")
}
pub(super) fn peer_url(text: &str) -> Option<String> {
    let url = url::Url::parse(text).ok()?;
    if !(url.scheme() == "https"
        || cfg!(test) && url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url.to_string().trim_end_matches('/').to_owned())
}
impl Manager {
    pub(crate) fn attach_ingress(self: &Arc<Self>, ingress: &Arc<crate::ingress::Ingress>) {
        *ingress.peer.lock().unwrap() = Arc::downgrade(self);
        let mut ingresses = self.ingresses.lock().unwrap();
        ingresses.retain(|i| i.strong_count() > 0);
        ingresses.push(Arc::downgrade(ingress));
    }
    pub(super) async fn public_peer_url(&self) -> Option<String> {
        let ingresses = self
            .ingresses
            .lock()
            .unwrap()
            .iter()
            .filter_map(|i| i.upgrade())
            .collect::<Vec<_>>();
        for ingress in ingresses {
            if !ingress.connected.load(std::sync::atomic::Ordering::SeqCst)
                || ingress.retired.load(std::sync::atomic::Ordering::SeqCst)
            {
                continue;
            }
            let meta = ingress.meta.lock().await;
            if !matches!(meta["transport"].as_str(), Some("https" | "relay")) {
                continue;
            }
            drop(meta);
            let url = ingress.mcp_url.lock().await.clone();
            if let Some(base) = url.strip_suffix("/mcp").and_then(peer_url) {
                return Some(format!("{base}/arc-peer/3"));
            }
        }
        None
    }
    fn challenge(&self, device: &str) -> Result<Value> {
        self.controller(device)?;
        let mut auth = self.tunnel.lock().unwrap();
        auth.challenges.retain(|_, (_, expires, epoch)| {
            *expires > Instant::now() && *epoch == *self.closed.borrow()
        });
        if auth.challenges.len() >= AUTH_CAP {
            return Err(error(
                "DEVICE_BUSY",
                "Peer challenge capacity reached; wait 30 seconds and retry.",
            ));
        }
        let challenge = random();
        auth.challenges.insert(
            challenge.clone(),
            (
                device.into(),
                Instant::now() + CHALLENGE_TTL,
                *self.closed.borrow(),
            ),
        );
        Ok(
            json!({"version":VERSION,"deviceId":self.identity()?.id,"challenge":challenge,"expiresInSeconds":30}),
        )
    }
    fn authenticate(&self, body: &Value) -> Result<Value> {
        let device = string(body, "deviceId");
        let peer = self.controller(device)?;
        let challenge = string(body, "challenge");
        let mut auth = self.tunnel.lock().unwrap();
        let (owner, expires, epoch) = auth.challenges.remove(challenge).ok_or_else(auth_error)?;
        if owner != device || expires <= Instant::now() || epoch != *self.closed.borrow() {
            return Err(auth_error());
        }
        let key = STANDARD
            .decode(&peer.public_key)
            .map_err(|_| auth_error())?;
        let (_, key) =
            x509_parser::prelude::SubjectPublicKeyInfo::from_der(&key).map_err(|_| auth_error())?;
        let signature = STANDARD
            .decode(string(body, "signature"))
            .map_err(|_| auth_error())?;
        ring::signature::UnparsedPublicKey::new(
            &ring::signature::ECDSA_P256_SHA256_ASN1,
            key.subject_public_key.data.as_ref(),
        )
        .verify(
            transcript(&self.identity()?.id, device, challenge).as_bytes(),
            &signature,
        )
        .map_err(|_| auth_error())?;
        auth.tokens.retain(|_, (_, expires, epoch)| {
            *expires > Instant::now() && *epoch == *self.closed.borrow()
        });
        if auth.tokens.len() >= AUTH_CAP {
            return Err(error(
                "DEVICE_BUSY",
                "Peer session capacity reached; wait for a session to expire.",
            ));
        }
        let token = random();
        auth.tokens.insert(
            token.clone(),
            (device.into(), Instant::now() + TOKEN_TTL, epoch),
        );
        Ok(json!({"version":VERSION,"token":token,"expiresInSeconds":300}))
    }
    fn token_device(&self, token: &str) -> Result<String> {
        let auth = self.tunnel.lock().unwrap();
        let (device, expires, epoch) = auth.tokens.get(token).ok_or_else(auth_error)?;
        if *expires <= Instant::now() || *epoch != *self.closed.borrow() {
            return Err(auth_error());
        }
        self.controller(device)?;
        Ok(device.clone())
    }
    pub(crate) async fn tunnel_http(&self, request: Request<Incoming>) -> Result<Value> {
        let started = tokio::time::Instant::now();
        let mut closed = self.closed.subscribe();
        self.identity()?;
        let path = request.uri().path().to_owned();
        if !path.starts_with("/arc-peer/3/") {
            return Err(error(
                "DEVICE_PROTOCOL_MISMATCH",
                "Use peer protocol version 3 routes; query guide for device.",
            ));
        }
        if request.method() != hyper::Method::POST || request.uri().query().is_some() {
            return Err(error(
                "DEVICE_PEER_FORBIDDEN",
                "Use POST peer routes; query guide for device.",
            ));
        }
        let token = request
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or("")
            .to_owned();
        // Authenticate before reading business bodies; challenges never admit unpaired devices.
        let device = if path.ends_with("/challenge") || path.ends_with("/session") {
            None
        } else {
            Some(self.token_device(&token)?)
        };
        let limit = if device.is_some() { REQUEST_CAP } else { 16384 };
        // Relay uploads advance one 32 KiB chunk per credit round trip. Bound
        // inactivity, not total upload time, within the original request deadline.
        // Auth bodies fit one relay chunk and retain their five-second total cap.
        let body_deadline = started
            + if device.is_some() {
                DEADLINE
            } else {
                Duration::from_secs(5)
            };
        let mut incoming = Limited::new(request.into_body(), limit);
        let mut bytes = Vec::new();
        loop {
            let next = tokio::select! {
                biased;
                _ = closed.changed() => return Err(error("DEVICE_UNPAIRED", "Peer was revoked or disabled; query guide for device.")),
                next = tokio::time::timeout_at(
                    body_deadline.min(tokio::time::Instant::now() + Duration::from_secs(5)),
                    incoming.frame(),
                ) => next,
            };
            let frame = next.map_err(|_| {
                error(
                    "DEVICE_TUNNEL_LIMIT",
                    "Peer body deadline expired; query guide for device.",
                )
            })?;
            let Some(frame) = frame else { break };
            let frame = frame.map_err(|_| {
                error(
                    "DEVICE_TUNNEL_LIMIT",
                    "Peer body exceeds its byte cap; use LAN.",
                )
            })?;
            if let Ok(data) = frame.into_data() {
                bytes.extend_from_slice(&data);
            }
        }
        let body: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "INVALID_ARGUMENT: peer body must be JSON")?;
        if body["version"] != VERSION {
            return Err(error(
                "DEVICE_PROTOCOL_MISMATCH",
                "Use peer protocol version 3; query guide for device.",
            ));
        }
        if path == "/arc-peer/3/challenge" {
            return self.challenge(string(&body, "deviceId"));
        }
        if path == "/arc-peer/3/session" {
            return self.authenticate(&body);
        }
        let device = device.ok_or_else(auth_error)?;
        self.token_device(&token)?;
        let operation = async {
            match path.as_str() {
                "/arc-peer/3/hello" => self.hello().await,
                "/arc-peer/3/transfer/control" => self.transfer_control(&device, body).await,
                "/arc-peer/3/request" => {
                    validate_wait(&body)?;
                    let _slot = self
                        .paired_connections
                        .clone()
                        .try_acquire_owned()
                        .map_err(|_| {
                            error(
                                "DEVICE_BUSY",
                                "Peer request capacity reached; wait for a request to finish.",
                            )
                        })?;
                    self.business_request(&device, body).await
                }
                _ => Err(error(
                    "DEVICE_PEER_FORBIDDEN",
                    "Use peer hello or request routes; query guide for device.",
                )),
            }
        };
        tokio::select! {
            biased;
            _=closed.changed()=>Err(error("DEVICE_UNPAIRED", "Peer was revoked or disabled; query guide for device.")),
            result=tokio::time::timeout(DEADLINE.saturating_sub(started.elapsed()),operation)=>result.map_err(|_|error("DEVICE_RESPONSE_LOST","Peer deadline expired; retain write receipt IDs and query guide for device."))?,
        }
    }
}
use x509_parser::prelude::FromDer;
pub(super) fn validate_wait(wire: &Value) -> Result<()> {
    let args = &wire["body"]["args"];
    let op = string(&wire["body"], "op");
    if args["waitMs"].as_u64().is_some_and(|ms| ms > WAIT_MS)
        || (op.ends_with("_wait") && args["timeoutMs"].as_u64().unwrap_or(30000) > WAIT_MS)
    {
        return Err(error(
            "DEVICE_TUNNEL_LIMIT",
            "Tunnel waits must use segments of at most 15000 ms; query guide for device.",
        ));
    }
    Ok(())
}
pub(super) fn segment(body: &mut Value) {
    let op = string(body, "op").to_owned();
    if let Some(args) = body["args"].as_object_mut() {
        if let Some(wait) = args.get_mut("waitMs") {
            if wait.as_u64().is_some_and(|n| n > WAIT_MS) {
                *wait = json!(WAIT_MS);
            }
        }
        if op.ends_with("_wait") {
            let wait = args.entry("timeoutMs").or_insert(json!(WAIT_MS));
            if wait.as_u64().is_some_and(|n| n > WAIT_MS) {
                *wait = json!(WAIT_MS);
            }
        }
    }
}

pub(super) struct Client {
    session: Mutex<Option<(String, String, Instant)>>,
    closed: tokio::sync::watch::Sender<u64>,
}
impl Default for Client {
    fn default() -> Self {
        let (closed, _) = tokio::sync::watch::channel(0);
        Self {
            session: Default::default(),
            closed,
        }
    }
}
impl Client {
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.closed.subscribe()
    }
    pub async fn close(&self) {
        self.closed
            .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
        self.clear().await;
    }

    pub async fn prepare(
        &self,
        identity: &Identity,
        member: &str,
        url: &str,
    ) -> Result<(String, String)> {
        let mut session = self.session.lock().await;
        if let Some((base, token, expires)) = session
            .as_ref()
            .filter(|(base, _, expires)| base == url && *expires > Instant::now())
        {
            let _ = expires;
            return Ok((base.clone(), token.clone()));
        }
        let challenge = post(
            url,
            "challenge",
            None,
            json!({"version":VERSION,"deviceId":identity.id}),
            Duration::from_secs(3),
        )
        .await?;
        if challenge["version"] != VERSION || challenge["deviceId"] != member {
            return Err(error(
                "DEVICE_PROTOCOL_MISMATCH",
                "Peer challenge identity or protocol differs; query guide for device.",
            ));
        }
        let nonce = string(&challenge, "challenge");
        if nonce.len() != 64 {
            return Err(auth_error());
        }
        let signature = identity.sign(transcript(member, &identity.id, nonce).as_bytes())?;
        let response=post(url,"session",None,json!({"version":VERSION,"deviceId":identity.id,"challenge":nonce,"signature":signature}),Duration::from_secs(3)).await?;
        let token = string(&response, "token").to_owned();
        if response["version"] != VERSION || token.len() != 64 {
            return Err(auth_error());
        }
        *session = Some((
            url.into(),
            token.clone(),
            Instant::now() + Duration::from_secs(270),
        ));
        Ok((url.into(), token))
    }
    pub async fn clear(&self) {
        self.session.lock().await.take();
    }
}
pub(super) async fn post(
    url: &str,
    route: &str,
    token: Option<&str>,
    body: Value,
    deadline: Duration,
) -> Result<Value> {
    let bytes = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
    if bytes.len() > REQUEST_CAP {
        return Err(error(
            "DEVICE_TUNNEL_LIMIT",
            "Peer request exceeds 1 MiB; use LAN.",
        ));
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(2))
        .timeout(deadline.min(DEADLINE))
        .build()
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(deadline.min(DEADLINE), async {
        let mut request = client
            .post(format!("{url}/{route}"))
            .header("content-type", "application/json")
            .body(bytes);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let mut response = request
            .send()
            .await
            .map_err(|e| error("DEVICE_TUNNEL_UNAVAILABLE", &format!("{e}; query devices.")))?;
        if !response.status().is_success() {
            return Err(error(
                "DEVICE_TUNNEL_UNAVAILABLE",
                &format!("HTTPS status {}; query devices.", response.status()),
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > RESPONSE_CAP {
                return Err(error(
                    "DEVICE_TUNNEL_LIMIT",
                    "Peer response exceeds 4 MiB; use LAN or a bounded read.",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let response: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if response["ok"] != true {
            return Err(response["error"].to_string());
        }
        Ok(response["result"].clone())
    })
    .await
    .map_err(|_| {
        error(
            "DEVICE_RESPONSE_LOST",
            "HTTPS peer deadline expired; retain write receipt IDs and query devices.",
        )
    })?
}
