//! Per-ingress OAuth server with local owner consent and authenticated local management.
use crate::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const ACCESS_TTL: i64 = 3600;
const REGISTRATION_TTL: i64 = 30 * 86400;
fn clock() -> i64 {
    chrono::Utc::now().timestamp()
}
fn secret() -> String {
    id().replace('-', "") + &id().replace('-', "")
}
#[derive(Clone, Serialize, Deserialize)]
struct Client {
    name: String,
    redirects: Vec<String>,
    method: String,
    secret_hash: String,
    created: i64,
}
#[derive(Clone, Serialize, Deserialize)]
struct Grant {
    id: String,
    #[serde(default)]
    connected_at: Option<i64>,
    client: String,
    resource: String,
    authorization_code: String,
    access: String,
    access_expires: i64,
    refresh: String,
    used_refresh: Vec<String>,
}
#[derive(Clone)]
struct Pending {
    client: String,
    redirect: String,
    state: String,
    challenge: String,
    resource: String,
    expires: i64,
    decision: Option<bool>,
    code: Option<String>,
    code_hash: String,
}
#[derive(Default, Serialize, Deserialize)]
struct Stored {
    resource: String,
    clients: BTreeMap<String, Client>,
    grants: Vec<Grant>,
}
pub struct OAuth {
    path: PathBuf,
    stored: Stored,
    pending: BTreeMap<String, Pending>,
    registrations: Vec<i64>,
}
#[derive(Debug)]
pub struct RegistrationError {
    code: String,
    field: Option<&'static str>,
    detail: Option<String>,
}
impl RegistrationError {
    fn metadata(code: &str, field: &'static str) -> Self {
        Self {
            code: code.to_owned(),
            field: Some(field),
            detail: None,
        }
    }
    fn redirect(reason: &str, url: Option<&reqwest::Url>) -> Self {
        let summary = url.map(|url| {
            let mut summary = format!("{}://{}", url.scheme(), url.host_str().unwrap_or(""));
            if let Some(port) = url.port() {
                summary.push_str(&format!(":{port}"));
            }
            summary.push_str(url.path());
            if let Some(query) = url.query() {
                let keys = query
                    .split('&')
                    .filter(|pair| !pair.is_empty())
                    .map(|pair| pair.split_once('=').map_or(pair, |(key, _)| key))
                    .collect::<Vec<_>>();
                if !keys.is_empty() {
                    summary.push('?');
                    summary.push_str(&keys.join("&"));
                }
            }
            summary
        });
        let mut error = Self::metadata("invalid_redirect_uri", "redirect_uris");
        error.detail = Some(
            format!(
                "reason={reason} uri={}",
                summary.as_deref().unwrap_or("<unavailable>")
            )
            .chars()
            .filter(|c| !c.is_control())
            .take(300)
            .collect(),
        );
        error
    }
}
impl From<String> for RegistrationError {
    fn from(code: String) -> Self {
        Self {
            code,
            field: None,
            detail: None,
        }
    }
}
impl From<RegistrationError> for String {
    fn from(error: RegistrationError) -> Self {
        error.code
    }
}
impl OAuth {
    pub fn new(dir: &Path) -> Result<Self> {
        let path = dir.join("oauth.json");
        let stored = if path.exists() {
            serde_json::from_value(load(&path)?).map_err(|e| e.to_string())?
        } else {
            Stored::default()
        };
        Ok(Self {
            path,
            stored,
            pending: BTreeMap::new(),
            registrations: vec![],
        })
    }
    fn persist(&self) -> Result<()> {
        save(
            &self.path,
            &serde_json::to_value(&self.stored).map_err(|e| e.to_string())?,
        )
    }
    pub fn reset(&mut self) -> Result<()> {
        self.stored.grants.clear();
        self.pending.clear();
        self.persist()
    }
    fn prepare(&mut self, resource: &str) -> Result<()> {
        if self.stored.resource != resource {
            self.reset()?;
            self.stored.resource = resource.to_owned();
            self.persist()?;
        }
        let now = clock();
        self.pending
            .retain(|_, p| p.expires + if p.decision == Some(true) { 300 } else { 0 } > now);
        // Unused dynamic registrations expire; active grants retain their client metadata.
        self.stored.clients.retain(|id, c| {
            c.created + REGISTRATION_TTL > now || self.stored.grants.iter().any(|g| &g.client == id)
        });
        self.registrations.retain(|t| *t + 3600 > now);
        Ok(())
    }
    pub fn authenticate(&mut self, header: &str, resource: &str) -> bool {
        if self.prepare(resource).is_err() {
            return false;
        }
        let Some(token) = header.strip_prefix("Bearer ") else {
            return false;
        };
        let digest = hash(token);
        self.stored
            .grants
            .iter()
            .any(|g| g.resource == resource && g.access == digest && g.access_expires > clock())
    }
    pub fn register(
        &mut self,
        body: &Value,
        resource: &str,
    ) -> std::result::Result<Value, RegistrationError> {
        self.prepare(resource)?;
        if self.stored.clients.len() >= 128 || self.registrations.len() >= 20 {
            return Err("temporarily_unavailable".to_owned().into());
        }
        let name = string(body, "client_name").trim();
        if name.len() > 120 || name.chars().any(char::is_control) {
            return Err(RegistrationError::metadata(
                "invalid_client_metadata",
                "client_name",
            ));
        }
        let redirects = body["redirect_uris"]
            .as_array()
            .ok_or_else(|| RegistrationError::redirect("count", None))?;
        if redirects.is_empty() || redirects.len() > 8 {
            return Err(RegistrationError::redirect("count", None));
        }
        let redirects: Vec<String> = redirects
            .iter()
            .map(|r| {
                let text = r
                    .as_str()
                    .ok_or_else(|| RegistrationError::redirect("not_string", None))?;
                let parsed = reqwest::Url::parse(text);
                if text.len() > 2048 {
                    return Err(RegistrationError::redirect(
                        "too_long",
                        parsed.as_ref().ok(),
                    ));
                }
                let url = parsed.map_err(|_| RegistrationError::redirect("parse", None))?;
                let loopback = matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"));
                let reason = if url.fragment().is_some() {
                    Some("fragment")
                } else if !url.username().is_empty() || url.password().is_some() {
                    Some("userinfo")
                } else if url.host_str().is_none() {
                    Some("no_host")
                } else if !(url.scheme() == "https" || url.scheme() == "http" && loopback) {
                    Some("scheme")
                } else {
                    None
                };
                if let Some(reason) = reason {
                    return Err(RegistrationError::redirect(reason, Some(&url)));
                }
                Ok(text.to_owned())
            })
            .collect::<std::result::Result<_, RegistrationError>>()?;
        for (key, required) in [
            ("grant_types", "authorization_code"),
            ("response_types", "code"),
        ] {
            if let Some(values) = body.get(key) {
                if !values.as_array().is_some_and(|a| {
                    !a.is_empty()
                        && a.iter().all(Value::is_string)
                        && a.iter().any(|v| v.as_str() == Some(required))
                }) {
                    return Err(RegistrationError::metadata("invalid_client_metadata", key));
                }
            }
        }
        if body.get("scope").is_some_and(|v| {
            !v.as_str().is_some_and(|scope| {
                scope.is_empty() || scope.split(' ').any(|token| token == "mcp")
            })
        }) {
            return Err(RegistrationError::metadata("invalid_scope", "scope"));
        }
        let method = body["token_endpoint_auth_method"]
            .as_str()
            .unwrap_or("client_secret_basic");
        if !["none", "client_secret_post", "client_secret_basic"].contains(&method) {
            return Err(RegistrationError::metadata(
                "invalid_client_metadata",
                "token_endpoint_auth_method",
            ));
        }
        let client_id = secret();
        let client_secret = if method == "none" {
            String::new()
        } else {
            secret()
        };
        let name = if name.is_empty() { "MCP client" } else { name };
        self.stored.clients.insert(
            client_id.clone(),
            Client {
                name: name.to_owned(),
                redirects: redirects.clone(),
                method: method.to_owned(),
                secret_hash: hash(&client_secret),
                created: clock(),
            },
        );
        self.registrations.push(clock());
        self.persist()?;
        let mut result = json!({"client_id":client_id,"client_name":name,"redirect_uris":redirects,"client_id_issued_at":clock(),"token_endpoint_auth_method":method,"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"scope":"mcp"});
        if method != "none" {
            result["client_secret"] = json!(client_secret);
            result["client_secret_expires_at"] = json!(0);
        }
        Ok(result)
    }
    pub fn authorize(&mut self, q: &BTreeMap<String, String>, resource: &str) -> Result<String> {
        self.prepare(resource)?;
        let get = |k: &str| q.get(k).map(String::as_str).unwrap_or("");
        let client = self
            .stored
            .clients
            .get(get("client_id"))
            .ok_or("invalid_client")?;
        if !client.redirects.iter().any(|r| r == get("redirect_uri")) {
            return Err("invalid_redirect_uri".into());
        }
        if get("response_type") != "code" {
            return Err("unsupported_response_type".into());
        }
        if get("resource") != resource {
            return Err("invalid_target".into());
        }
        if !get("scope").is_empty() && get("scope") != "mcp" {
            return Err("invalid_scope".into());
        }
        let challenge = get("code_challenge");
        if get("code_challenge_method") != "S256"
            || challenge.len() != 43
            || !challenge
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || get("state").len() > 2048
        {
            return Err("invalid_request".into());
        }
        // A retried authorization URL is the same transaction, not a new consent.
        // Keep independent state/PKCE challenges isolated even for the same client.
        if let Some((key, _)) = self.pending.iter().find(|(_, pending)| {
            pending.decision.is_none()
                && pending.expires > clock()
                && pending.client == get("client_id")
                && pending.redirect == get("redirect_uri")
                && pending.state == get("state")
                && pending.challenge == challenge
                && pending.resource == resource
        }) {
            return Ok(key.clone());
        }
        if self.pending.len() >= 32 {
            return Err("temporarily_unavailable".into());
        }
        let key = secret();
        self.pending.insert(
            key.clone(),
            Pending {
                client: get("client_id").to_owned(),
                redirect: get("redirect_uri").to_owned(),
                state: get("state").to_owned(),
                challenge: challenge.to_owned(),
                resource: resource.to_owned(),
                expires: clock() + 300,
                decision: None,
                code: None,
                code_hash: String::new(),
            },
        );
        Ok(key)
    }
    pub fn management(&mut self, resource: &str) -> Result<Value> {
        self.prepare(resource)?;
        let pending: Vec<_> = self
            .pending
            .keys()
            .map(|key| self.status(key, resource))
            .collect::<Result<_>>()?;
        let mut grants: Vec<_> = self.stored.grants.iter().collect();
        grants.sort_by_key(|g| {
            std::cmp::Reverse(
                g.connected_at
                    .or_else(|| self.stored.clients.get(&g.client).map(|c| c.created)),
            )
        });
        let grants: Vec<_> = grants
            .into_iter()
            .map(|g| {
                let client = self.stored.clients.get(&g.client);
                json!({"id":g.id,"clientName":client.map(|c|c.name.as_str()),"clientId":g.client,
                "connectedAt":g.connected_at,"registeredAt":client.map(|c|c.created)})
            })
            .collect();
        let clients: Vec<_> = self.stored.clients.iter().map(|(id,c)|json!({"id":id,"name":c.name,"redirectUris":c.redirects,"tokenEndpointAuthMethod":c.method,"createdAt":c.created})).collect();
        Ok(json!({"pending":pending,"grants":grants,"clients":clients}))
    }
    pub fn status(&self, key: &str, resource: &str) -> Result<Value> {
        if let Some(p) = self.pending.get(key).filter(|p| p.resource == resource) {
            return Ok(
                json!({"id":key,"clientName":self.stored.clients.get(&p.client).map(|c|c.name.as_str()),"clientId":p.client,"redirectUri":p.redirect,"resource":p.resource,"expiresAt":p.expires,"status":if p.expires <= clock() { "expired" } else { match p.decision { Some(true) => "approved", Some(false) => "denied", None => "pending" } }}),
            );
        }
        if let Some(g) = self
            .stored
            .grants
            .iter()
            .find(|g| g.id == key && g.resource == resource)
        {
            return Ok(
                json!({"id":key,"status":"completed","clientName":self.stored.clients.get(&g.client).map(|c|c.name.as_str()),"resource":resource}),
            );
        }
        Ok(json!({"id":key,"status":"expired"}))
    }
    pub fn decide(&mut self, key: &str, allow: bool) -> Result<()> {
        let p = self
            .pending
            .get_mut(key)
            .ok_or("Authorization request expired")?;
        if p.expires <= clock() {
            return Err("Authorization request expired".into());
        }
        if let Some(decision) = p.decision {
            return if decision == allow {
                Ok(())
            } else {
                Err("Authorization request already decided".into())
            };
        }
        p.decision = Some(allow);
        if allow {
            let code = secret();
            p.code_hash = hash(&code);
            p.code = Some(code);
            p.expires = clock() + 60;
        }
        Ok(())
    }
    pub fn resume(&mut self, key: &str, resource: &str) -> Result<Option<String>> {
        self.prepare(resource)?;
        let p = self
            .pending
            .get_mut(key)
            .ok_or("Authorization request expired; reconnect from your client")?;
        if p.expires <= clock() {
            return Err("Authorization request expired".into());
        }
        let Some(allowed) = p.decision else {
            return Ok(None);
        };
        let mut url = reqwest::Url::parse(&p.redirect).map_err(|_| "invalid_redirect_uri")?;
        {
            let mut query = url.query_pairs_mut();
            if allowed {
                query.append_pair(
                    "code",
                    &p.code.clone().ok_or(
                        "Authorization response already delivered; reconnect from your client",
                    )?,
                );
            } else {
                query.append_pair("error", "access_denied");
            }
            if !p.state.is_empty() {
                query.append_pair("state", &p.state);
            }
            query.append_pair("iss", resource.trim_end_matches("/mcp"));
        }
        Ok(Some(url.to_string()))
    }
    fn client(
        &self,
        q: &BTreeMap<String, String>,
        basic: Option<(String, String)>,
    ) -> Result<String> {
        let id = basic
            .as_ref()
            .map(|b| b.0.as_str())
            .or_else(|| q.get("client_id").map(String::as_str))
            .ok_or("invalid_client")?;
        let c = self.stored.clients.get(id).ok_or("invalid_client")?;
        let supplied = basic
            .as_ref()
            .map(|b| b.1.as_str())
            .or_else(|| q.get("client_secret").map(String::as_str))
            .unwrap_or("");
        if basic.is_some()
            && (q.contains_key("client_secret") || q.get("client_id").is_some_and(|v| v != id))
        {
            return Err("invalid_client".into());
        }
        if match c.method.as_str() {
            "none" => basic.is_some() || !supplied.is_empty(),
            "client_secret_basic" => basic.is_none() || hash(supplied) != c.secret_hash,
            "client_secret_post" => basic.is_some() || hash(supplied) != c.secret_hash,
            _ => true,
        } {
            return Err("invalid_client".into());
        }
        Ok(id.to_owned())
    }
    pub fn token(
        &mut self,
        q: &BTreeMap<String, String>,
        basic: Option<(String, String)>,
        resource: &str,
    ) -> Result<Value> {
        self.prepare(resource)?;
        let client = self.client(q, basic)?;
        let get = |k: &str| q.get(k).map(String::as_str).unwrap_or("");
        if get("resource") != resource {
            return Err("invalid_target".into());
        }
        if !get("scope").is_empty() && get("scope") != "mcp" {
            return Err("invalid_scope".into());
        }
        let access = secret();
        let refresh = secret();
        match get("grant_type") {
            "authorization_code" => {
                let code_hash = hash(get("code"));
                if self
                    .stored
                    .grants
                    .iter()
                    .any(|g| g.client == client && g.authorization_code == code_hash)
                {
                    self.stored
                        .grants
                        .retain(|g| !(g.client == client && g.authorization_code == code_hash));
                    self.persist()?;
                    return Err("invalid_grant".into());
                }
                let (key, p) = self
                    .pending
                    .iter()
                    .find(|(_, p)| {
                        p.code_hash == code_hash && p.decision == Some(true) && p.expires > clock()
                    })
                    .map(|(k, p)| (k.clone(), p.clone()))
                    .ok_or("invalid_grant")?;
                let verifier = get("code_verifier");
                if p.client != client
                    || p.resource != resource
                    || p.redirect != get("redirect_uri")
                    || !(43..=128).contains(&verifier.len())
                    || !verifier
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
                    || URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())) != p.challenge
                {
                    return Err("invalid_grant".into());
                }
                if self.stored.grants.len() >= 128 {
                    return Err("temporarily_unavailable".into());
                }
                self.pending.remove(&key);
                self.stored.grants.push(Grant {
                    id: key,
                    connected_at: Some(clock()),
                    client,
                    resource: resource.to_owned(),
                    authorization_code: code_hash,
                    access: hash(&access),
                    access_expires: clock() + ACCESS_TTL,
                    refresh: hash(&refresh),
                    used_refresh: vec![],
                });
            }
            "refresh_token" => {
                let digest = hash(get("refresh_token"));
                if let Some(index) = self
                    .stored
                    .grants
                    .iter()
                    .position(|g| g.client == client && g.used_refresh.contains(&digest))
                {
                    self.stored.grants.remove(index);
                    self.persist()?;
                    return Err("invalid_grant".into());
                }
                let g = self
                    .stored
                    .grants
                    .iter_mut()
                    .find(|g| g.client == client && g.resource == resource && g.refresh == digest)
                    .ok_or("invalid_grant")?;
                g.used_refresh.push(g.refresh.clone());
                g.refresh = hash(&refresh);
                g.access = hash(&access);
                g.access_expires = clock() + ACCESS_TTL;
            }
            _ => return Err("unsupported_grant_type".into()),
        }
        self.persist()?;
        let expires = self
            .stored
            .grants
            .iter()
            .find(|g| g.access == hash(&access))
            .map(|g| g.access_expires - clock())
            .unwrap_or(ACCESS_TTL);
        Ok(
            json!({"access_token":access,"token_type":"Bearer","expires_in":expires,"refresh_token":refresh,"scope":"mcp"}),
        )
    }
    pub fn remove_client(&mut self, client: &str) -> Result<()> {
        self.stored.clients.remove(client);
        self.stored.grants.retain(|g| g.client != client);
        self.pending.retain(|_, p| p.client != client);
        self.persist()
    }
    pub fn revoke(&mut self, grant: &str) -> Result<()> {
        self.stored.grants.retain(|g| g.id != grant);
        self.persist()
    }
    pub fn revoke_token(
        &mut self,
        q: &BTreeMap<String, String>,
        basic: Option<(String, String)>,
        resource: &str,
    ) -> Result<()> {
        self.prepare(resource)?;
        let client = self.client(q, basic)?;
        let digest = hash(q.get("token").ok_or("invalid_request")?);
        self.stored.grants.retain(|g| {
            !(g.client == client
                && (g.refresh == digest || g.access == digest || g.used_refresh.contains(&digest)))
        });
        self.persist()
    }
}

use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    body::{Bytes, Incoming},
    Request, Response,
};
fn response(status: u16, body: Value) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .header("Cache-Control", "no-store")
        .header("Pragma", "no-cache")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap()
}
fn asset(content_type: &str, bytes: &'static [u8]) -> Response<Full<Bytes>> {
    Response::builder()
        .header("Content-Type", content_type)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-cache")
        .body(Full::new(Bytes::from_static(bytes)))
        .unwrap()
}
fn html() -> Response<Full<Bytes>> {
    Response::builder()
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Frame-Options", "DENY")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        .body(Full::new(Bytes::from_static(include_bytes!("oauth-page.html"))))
        .unwrap()
}
fn parameters(text: &str) -> Result<BTreeMap<String, String>> {
    if text.len() > 16384 {
        return Err("invalid_request".into());
    }
    let url =
        reqwest::Url::parse(&format!("http://localhost/?{text}")).map_err(|_| "invalid_request")?;
    let mut q = BTreeMap::new();
    for (k, v) in url.query_pairs() {
        if q.insert(k.into_owned(), v.into_owned()).is_some() {
            return Err("invalid_request".into());
        }
    }
    Ok(q)
}
pub async fn handle(
    request: Request<Incoming>,
    ingress: &crate::ingress::Ingress,
    resource: &str,
) -> Response<Full<Bytes>> {
    let audit_path = match request.uri().path() {
        "/oauth/authorize" | "/oauth/register" | "/oauth/token" | "/oauth/revoke" => {
            Some(request.uri().path().to_owned())
        }
        _ => None,
    };
    let supplied_auth = request.headers().contains_key("authorization");
    let cors = matches!(
        request.uri().path(),
        "/oauth/register" | "/oauth/token" | "/oauth/revoke"
    ) || request.uri().path().starts_with("/.well-known/");
    let mut registration_field = None;
    let mut registration_detail = None;
    let mut audit_error = None;
    let result = if cors && request.method() == hyper::Method::OPTIONS {
        Ok(response(204, Value::Null))
    } else {
        route(
            request,
            ingress,
            resource,
            &mut registration_field,
            &mut registration_detail,
        )
        .await
    };
    let mut reply = match result {
        Ok(r) => r,
        Err(e) => {
            let allowed = [
                "invalid_request",
                "invalid_client",
                "invalid_client_metadata",
                "invalid_redirect_uri",
                "unsupported_response_type",
                "invalid_target",
                "invalid_scope",
                "temporarily_unavailable",
                "invalid_grant",
                "unsupported_grant_type",
            ];
            let error = if allowed.contains(&e.as_str()) {
                e.as_str()
            } else {
                "server_error"
            };
            audit_error = Some(error.to_owned());
            let mut failure = response(
                if error == "invalid_client" && supplied_auth {
                    401
                } else if error == "temporarily_unavailable" {
                    429
                } else if error == "server_error" {
                    500
                } else {
                    400
                },
                json!({"error":error}),
            );
            if failure.status() == 401 {
                failure.headers_mut().insert(
                    "www-authenticate",
                    hyper::header::HeaderValue::from_static("Basic realm=\"oauth\""),
                );
            }
            failure
        }
    };
    if let Some(path) = audit_path {
        let mut message = format!("OAuth {path}: HTTP {}", reply.status().as_u16());
        if path == "/oauth/register" && reply.status() == 400 {
            message.push_str(&format!(
                " error={} fields={}",
                audit_error.as_deref().unwrap_or("invalid_request"),
                registration_field.unwrap_or("request"),
            ));
            if let Some(detail) = registration_detail {
                message.push_str(&format!(" detail={detail}"));
            }
        }
        ingress
            .log(
                if reply.status().is_success() || reply.status().is_redirection() {
                    "INFO"
                } else {
                    "WARN"
                },
                &message,
            )
            .await;
    }
    if cors {
        for (key, value) in [
            ("access-control-allow-origin", "*"),
            ("access-control-allow-methods", "GET, POST, OPTIONS"),
            (
                "access-control-allow-headers",
                "Authorization, Content-Type",
            ),
            ("access-control-expose-headers", "WWW-Authenticate"),
        ] {
            reply
                .headers_mut()
                .insert(key, hyper::header::HeaderValue::from_static(value));
        }
    }
    reply
}
async fn route(
    request: Request<Incoming>,
    ingress: &crate::ingress::Ingress,
    resource: &str,
    registration_field: &mut Option<&'static str>,
    registration_detail: &mut Option<String>,
) -> Result<Response<Full<Bytes>>> {
    let path = request.uri().path().to_owned();
    let issuer = resource.trim_end_matches("/mcp");
    if request.method() == hyper::Method::GET {
        let q = parameters(request.uri().query().unwrap_or(""))?;
        match path.as_str() {
            "/.well-known/oauth-protected-resource"
            | "/.well-known/oauth-protected-resource/mcp" => {
                return Ok(response(
                    200,
                    json!({"resource":resource,"authorization_servers":[issuer],"scopes_supported":["mcp"],"bearer_methods_supported":["header"]}),
                ))
            }
            "/.well-known/oauth-authorization-server" => {
                return Ok(response(
                    200,
                    json!({"issuer":issuer,"authorization_endpoint":format!("{issuer}/oauth/authorize"),"token_endpoint":format!("{issuer}/oauth/token"),"registration_endpoint":format!("{issuer}/oauth/register"),"revocation_endpoint":format!("{issuer}/oauth/revoke"),"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none","client_secret_basic","client_secret_post"],"revocation_endpoint_auth_methods_supported":["none","client_secret_basic","client_secret_post"],"scopes_supported":["mcp"],"authorization_response_iss_parameter_supported":true}),
                ))
            }
            "/oauth/authorize" => {
                let key = ingress.oauth.lock().await.authorize(&q, resource)?;
                return Ok(Response::builder()
                    .status(303)
                    .header("Location", format!("{issuer}/oauth/resume?request={key}"))
                    .header("Cache-Control", "no-store")
                    .header("Referrer-Policy", "no-referrer")
                    .body(Full::new(Bytes::new()))
                    .unwrap());
            }
            "/oauth/resume" => return Ok(html()),
            "/oauth/page.js" => {
                return Ok(asset(
                    "text/javascript; charset=utf-8",
                    include_bytes!("oauth-page.js"),
                ))
            }
            "/oauth/tokens.css" => {
                return Ok(asset(
                    "text/css; charset=utf-8",
                    include_bytes!("../../ui/tokens.css"),
                ))
            }
            "/oauth/logo.png" => {
                return Ok(asset(
                    "image/png",
                    include_bytes!("../../ui/assets/brand-reserve/app/arc-remote/icon.png"),
                ))
            }
            "/oauth/favicon.ico" => {
                return Ok(asset(
                    "image/x-icon",
                    include_bytes!("../../ui/assets/brand-reserve/app/arc-remote/icon.ico"),
                ))
            }
            "/oauth/status" => {
                let connection_name = ingress.meta.lock().await["name"].clone();
                let mut oauth = ingress.oauth.lock().await;
                oauth.prepare(resource)?;
                let mut state =
                    oauth.status(q.get("request").ok_or("invalid_request")?, resource)?;
                state["openAppUrl"] =
                    json!(format!("clc://oauth?request={}", q.get("request").unwrap()));
                state["connectionName"] = connection_name;
                return Ok(response(200, state));
            }
            "/oauth/continue" => {
                return Ok(
                    match ingress
                        .oauth
                        .lock()
                        .await
                        .resume(q.get("request").ok_or("invalid_request")?, resource)
                    {
                        Ok(Some(url)) => Response::builder()
                            .status(303)
                            .header("Location", url)
                            .header("Cache-Control", "no-store")
                            .header("Referrer-Policy", "no-referrer")
                            .body(Full::new(Bytes::new()))
                            .unwrap(),
                        _ => html(),
                    },
                );
            }
            _ => return Ok(response(404, json!({"error":"not_found"}))),
        }
    }
    if request.method() != hyper::Method::POST {
        return Ok(response(405, json!({"error":"invalid_request"})));
    }
    if !["/oauth/register", "/oauth/token", "/oauth/revoke"].contains(&path.as_str()) {
        return Ok(response(404, json!({"error":"not_found"})));
    }
    let content = request
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_owned();
    let basic = if let Some(h) = request.headers().get("authorization") {
        let text = h
            .to_str()
            .map_err(|_| "invalid_client")?
            .strip_prefix("Basic ")
            .ok_or("invalid_client")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(text)
            .map_err(|_| "invalid_client")?;
        let text = String::from_utf8(bytes).map_err(|_| "invalid_client")?;
        let (id, secret) = text.split_once(':').ok_or("invalid_client")?;
        let decoded = parameters(&format!("id={id}&secret={secret}"))?;
        if decoded.len() != 2 {
            return Err("invalid_client".into());
        }
        Some((decoded["id"].clone(), decoded["secret"].clone()))
    } else {
        None
    };
    let body = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        Limited::new(request.into_body(), 16384).collect(),
    )
    .await
    .map_err(|_| "invalid_request")?
    .map_err(|_| "invalid_request")?
    .to_bytes();
    let mut oauth = ingress.oauth.lock().await;
    if path == "/oauth/register" {
        if content != "application/json" {
            *registration_field = Some("content-type");
            return Err("invalid_request".into());
        }
        let metadata = serde_json::from_slice(&body).map_err(|_| {
            *registration_field = Some("body");
            "invalid_request"
        })?;
        return Ok(response(
            201,
            oauth.register(&metadata, resource).map_err(|error| {
                *registration_field = error.field;
                *registration_detail = error.detail;
                error.code
            })?,
        ));
    }
    if content != "application/x-www-form-urlencoded" {
        return Err("invalid_request".into());
    }
    let q = parameters(std::str::from_utf8(&body).map_err(|_| "invalid_request")?)?;
    if path == "/oauth/revoke" {
        oauth.revoke_token(&q, basic, resource)?;
        Ok(response(200, json!({})))
    } else {
        Ok(response(200, oauth.token(&q, basic, resource)?))
    }
}
