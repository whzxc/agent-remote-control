//! Device link identity and local pairing authority. The front door owns this state.
mod addresses;
mod client;
mod connections;
mod topology;
pub(crate) mod transfer;
mod tunnel;
#[cfg(test)]
mod tunnel_fixture;
#[cfg(test)]
mod tunnel_tests;
pub(crate) mod visibility;
use addresses::{lan_interfaces, lan_sockets};
pub(crate) mod controller;
#[cfg(test)]
mod controller_tests;
mod identity;
mod records;
#[cfg(test)]
mod tests;
mod tls;
pub(crate) mod transport;
use crate::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use identity::Identity;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr},
    sync::Mutex as StdMutex,
    time::{Duration, Instant},
};

pub const VERSION: u16 = 3;
pub const DEFAULT_PORT: u16 = 7143;
const OFFER_TTL: Duration = Duration::from_secs(600);
pub fn enabled() -> bool {
    crate::preferences::read()["device-link"] == "on"
}
pub fn unavailable() -> String {
    "OP_UNAVAILABLE: Enable the device-link preference locally; read cli guide for Device link commands.".into()
}
fn error(code: &str, message: &str) -> String {
    format!("{code}: {message}")
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Offer {
    pub version: u16,
    pub device_id: String,
    pub addresses: Vec<String>,
    pub tunnel_url: Option<String>,
    pub secret: String,
}
impl Offer {
    pub fn encode(&self) -> Result<String> {
        Ok(format!(
            "arc-device:3:{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).map_err(|e| e.to_string())?)
        ))
    }
    pub fn decode(text: &str) -> Result<Self> {
        let invalid = || {
            error(
                "DEVICE_PAIRING_INVALID",
                "Use a fresh member-local device offer.",
            )
        };
        if text.len() > 16384 {
            return Err(invalid());
        }
        let (prefix, payload) = text.rsplit_once(':').ok_or_else(invalid)?;
        if prefix != "arc-device:3" {
            return Err(error(
                "DEVICE_PROTOCOL_MISMATCH",
                "Use peer protocol version 3 on both devices; read cli guide.",
            ));
        }
        let offer: Self =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).map_err(|_| invalid())?)
                .map_err(|_| invalid())?;
        if offer.version != VERSION {
            return Err(error(
                "DEVICE_PROTOCOL_MISMATCH",
                "Use peer protocol version 3 on both devices; read cli guide.",
            ));
        }
        if offer
            .tunnel_url
            .as_deref()
            .is_some_and(|url| tunnel::peer_url(url).is_none() || !url.ends_with("/arc-peer/3"))
        {
            return Err(invalid());
        }
        if offer.device_id.len() != 64
            || !offer.device_id.bytes().all(|b| b.is_ascii_hexdigit())
            || offer.secret.len() != 64
            || offer.addresses.is_empty()
            || offer.addresses.len() > 64
        {
            return Err(invalid());
        }
        for address in &offer.addresses {
            let socket = address.parse::<SocketAddr>().map_err(|_| invalid())?;
            if !lan_address(socket.ip()) || socket.port() == 0 {
                return Err(invalid());
            }
        }
        Ok(offer)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Peer {
    device_id: String,
    public_key: String,
    name: String,
    addresses: Vec<String>,
    tunnel_url: Option<String>,
    #[serde(default)]
    address_override: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    identity_id: Option<String>,
    port: u16,
    name: Option<String>,
    controller: Option<Peer>,
    members: BTreeMap<String, Peer>,
    #[serde(default)]
    show_upstream_sources: bool,
    #[serde(default)]
    upstream_sources: BTreeMap<String, Value>,
}
impl Default for Stored {
    fn default() -> Self {
        Self {
            identity_id: None,
            port: DEFAULT_PORT,
            name: None,
            controller: None,
            members: BTreeMap::new(),
            show_upstream_sources: false,
            upstream_sources: BTreeMap::new(),
        }
    }
}
struct Pending {
    peer: Peer,
    expires: Instant,
    decision: tokio::sync::oneshot::Sender<Result<Value>>,
}
struct State {
    enabled: bool,
    identity: Option<Arc<Identity>>,
    stored: Stored,
    offer: Option<(String, Instant)>,
    pending: Option<Pending>,
}
struct Runtime {
    listeners: Vec<tokio::task::JoinHandle<()>>,
    advertisement: mdns_sd::ServiceDaemon,
}
impl Drop for Runtime {
    fn drop(&mut self) {
        for task in &self.listeners {
            task.abort();
        }
        let _ = self.advertisement.shutdown();
    }
}
#[cfg(test)]
pub(super) struct ReplyGate {
    request_id: String,
    ready: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
pub(crate) struct Manager {
    directory: PathBuf,
    state: StdMutex<State>,
    tunnel: StdMutex<tunnel::Auth>,
    ingresses: StdMutex<Vec<std::sync::Weak<crate::ingress::Ingress>>>,
    runtime: Mutex<Option<Runtime>>,
    configuration: Mutex<()>,
    closed: tokio::sync::watch::Sender<u64>,
    pairing_cancel: StdMutex<Option<Arc<tokio::sync::Notify>>>,
    #[cfg(test)]
    reply_gate: StdMutex<Option<Arc<ReplyGate>>>,
    transfers: transfer::Store,
    lan_connections: Arc<StdMutex<connections::Connections>>,
    tunnel_requests: Arc<tokio::sync::Semaphore>,
    unpaired_connections: Arc<tokio::sync::Semaphore>,
    #[cfg(test)]
    keepalive: StdMutex<Option<(Duration, Duration)>>,
}
impl Manager {
    pub fn new(directory: PathBuf) -> Result<Arc<Self>> {
        let path = directory.join("peers.json");
        let stored = if path.exists() {
            serde_json::from_value(load(&path)?).map_err(|e| e.to_string())?
        } else {
            Stored::default()
        };
        let (closed, _) = tokio::sync::watch::channel(0);
        Ok(Arc::new(Self {
            directory,
            state: StdMutex::new(State {
                enabled: false,
                identity: None,
                stored,
                offer: None,
                pending: None,
            }),
            tunnel: Default::default(),
            ingresses: Default::default(),
            runtime: Mutex::new(None),
            configuration: Mutex::new(()),
            closed,
            pairing_cancel: Default::default(),
            #[cfg(test)]
            reply_gate: Default::default(),
            transfers: Default::default(),
            lan_connections: Default::default(),
            tunnel_requests: Arc::new(tokio::sync::Semaphore::new(8)),
            unpaired_connections: Arc::new(tokio::sync::Semaphore::new(8)),
            #[cfg(test)]
            keepalive: Default::default(),
        }))
    }
    fn persist(&self, state: &State) -> Result<()> {
        save(
            &self.directory.join("peers.json"),
            &serde_json::to_value(&state.stored).map_err(|e| e.to_string())?,
        )
    }
    fn identity(&self) -> Result<Arc<Identity>> {
        let state = self.state.lock().unwrap();
        if !state.enabled {
            return Err(unavailable());
        }
        state.identity.clone().ok_or_else(unavailable)
    }
    fn accept_certificate(&self, id: &str) -> bool {
        let state = self.state.lock().unwrap();
        state.enabled
            && !state.stored.members.contains_key(id)
            && (state
                .stored
                .controller
                .as_ref()
                .is_some_and(|p| p.device_id == id)
                || state.stored.controller.is_none()
                    && state
                        .offer
                        .as_ref()
                        .is_some_and(|(_, expires)| *expires > Instant::now()))
    }
    fn controller(&self, id: &str) -> Result<Peer> {
        let state = self.state.lock().unwrap();
        if !state.enabled {
            return Err(unavailable());
        }
        state
            .stored
            .controller
            .as_ref()
            .filter(|p| p.device_id == id)
            .cloned()
            .ok_or_else(|| {
                error(
                    "DEVICE_UNPAIRED",
                    "Pair and approve this controller locally; read cli guide.",
                )
            })
    }
    fn name(&self) -> Result<String> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .stored
            .name
            .clone()
            .unwrap_or_else(|| "ARC device".into()))
    }
    fn addresses(&self) -> Result<Vec<String>> {
        let port = self.state.lock().unwrap().stored.port;
        let mut addresses = lan_sockets(port)?
            .into_iter()
            .map(|mut a| {
                if let SocketAddr::V6(ref mut v6) = a {
                    v6.set_scope_id(0);
                }
                a.to_string()
            })
            .collect::<Vec<_>>();
        addresses.dedup();
        Ok(addresses)
    }
    pub async fn reconcile(self: &Arc<Self>, enabled: bool) -> Result<()> {
        let _configuration = self.configuration.lock().await;
        self.stop_runtime().await;
        {
            let mut state = self.state.lock().unwrap();
            state.enabled = enabled;
            state.offer = None;
            state.pending = None;
            if enabled {
                let identity = Arc::new(Identity::load_or_create(&self.directory)?);
                if state
                    .stored
                    .identity_id
                    .as_ref()
                    .is_some_and(|id| *id != identity.id)
                {
                    state.stored.controller = None;
                    state.stored.members.clear();
                    state.stored.upstream_sources.clear();
                }
                state.stored.identity_id = Some(identity.id.clone());
                state.identity = Some(identity);
                self.persist(&state)?;
            }
        }
        if enabled {
            let runtime = self.start_runtime().await?;
            *self.runtime.lock().await = Some(runtime);
        }
        Ok(())
    }
    async fn stop_runtime(&self) {
        self.closed
            .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
        if let Some(runtime) = self.runtime.lock().await.take() {
            for task in &runtime.listeners {
                task.abort();
            }
            // Dropping listener JoinSets closes every handshake and HTTP connection.
            for task in &runtime.listeners {
                while !task.is_finished() {
                    tokio::task::yield_now().await;
                }
            }
            if let Ok(stopped) = runtime.advertisement.shutdown() {
                let _ = tokio::time::timeout(Duration::from_secs(2), stopped.recv_async()).await;
            }
            drop(runtime);
        }
    }
    pub async fn stop(&self) {
        let _configuration = self.configuration.lock().await;
        self.state.lock().unwrap().enabled = false;
        self.stop_runtime().await;
    }
    pub async fn request(self: &Arc<Self>, action: &str, body: Value) -> Result<Value> {
        self.identity()?;
        match action {
            "learn" => {
                let mut state = self.state.lock().unwrap();
                let Some(peer) = state.stored.members.get_mut(string(&body, "deviceId")) else {
                    return Err("DEVICE_UNKNOWN: member was removed".into());
                };
                if peer.public_key != string(&body, "publicKey") {
                    return Err("DEVICE_UNPAIRED: member identity changed".into());
                }
                let mut next = peer.clone();
                if let Some(addresses) = body["hello"]["addresses"].as_array() {
                    next.addresses = addresses
                        .iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect();
                }
                if let Some(url) = body["hello"].get("tunnelUrl") {
                    next.tunnel_url = url.as_str().and_then(tunnel::peer_url);
                }
                let changed = *peer != next;
                if changed {
                    *peer = next;
                    self.persist(&state)?;
                }
                Ok(json!({"changed":changed}))
            }
            "snapshot" => {
                let identity = self.identity()?;
                let state = self.state.lock().unwrap();
                let peer = |p: &Peer| json!({"deviceId":p.device_id,"name":p.name,"addresses":p.addresses,"tunnelUrl":p.tunnel_url,"addressOverride":p.address_override});
                let remaining =
                    |expires: Instant| expires.saturating_duration_since(Instant::now()).as_secs();
                Ok(json!({
                    "deviceId":identity.id,"name":state.stored.name.as_deref().unwrap_or("ARC device"),
                    "controller":state.stored.controller.as_ref().map(|p| { let mut row = peer(p); row["showUpstreamSources"] = json!(state.stored.show_upstream_sources); row["upstreamSources"] = json!(if state.stored.show_upstream_sources {state.stored.upstream_sources.values().cloned().collect::<Vec<_>>()} else {vec![]}); row }),
                    "members":state.stored.members.values().map(peer).collect::<Vec<_>>(),
                    "offerExpiresInSeconds":state.offer.as_ref().map(|(_,expires)|remaining(*expires)),
                    "pending":state.pending.as_ref().filter(|p|p.expires > Instant::now() && !p.decision.is_closed()).map(|p|json!({"deviceId":p.peer.device_id,"name":p.peer.name,"expiresInSeconds":remaining(p.expires)}))
                }))
            }
            "offer" => self.offer().await,
            "pending" => {
                let state = self.state.lock().unwrap();
                Ok(
                    json!({"pending":state.pending.as_ref().filter(|p| p.expires > Instant::now() && !p.decision.is_closed()).map(|p| json!({"deviceId":p.peer.device_id,"name":p.peer.name,"publicKey":p.peer.public_key}))}),
                )
            }
            "approve" | "decline" => self.decide(action == "approve").await,
            "cancel-pair" => {
                if let Some(cancel) = self.pairing_cancel.lock().unwrap().take() {
                    cancel.notify_one();
                }
                Ok(json!({"cancelled":true}))
            }
            "pair" => {
                self.pair(Offer::decode(string(&body, "pairingString"))?)
                    .await
            }
            "address" => {
                let mut state = self.state.lock().unwrap();
                let selector = string(&body, "device");
                let ids = state
                    .stored
                    .members
                    .iter()
                    .filter(|(id, peer)| *id == selector || peer.name == selector)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                if ids.len() != 1 {
                    return Err(error("DEVICE_UNKNOWN","Use a device ID or unique paired member name; query devices with all:true."));
                }
                let address = if body["address"].is_null() {
                    None
                } else {
                    let address = string(&body, "address");
                    let parsed = url::Url::parse(&format!("https://{address}"))
                        .map_err(|_| "INVALID_ARGUMENT: address must be host:port")?;
                    if parsed.host_str().is_none()
                        || !address.rsplit_once(':').is_some_and(|(_, port)| {
                            port.parse::<u16>().is_ok_and(|port| port != 0)
                        })
                        || parsed.path() != "/"
                        || !parsed.username().is_empty()
                        || parsed.password().is_some()
                        || parsed.query().is_some()
                        || parsed.fragment().is_some()
                    {
                        return Err("INVALID_ARGUMENT: address must be host:port".into());
                    }
                    Some(address.to_owned())
                };
                state
                    .stored
                    .members
                    .get_mut(&ids[0])
                    .unwrap()
                    .address_override = address.clone();
                self.persist(&state)?;
                Ok(json!({"deviceId":ids[0],"address":address}))
            }
            "revoke" => self.revoke(string(&body, "deviceId")).await,
            "configure" => {
                let show_upstream_sources = body
                    .get("showUpstreamSources")
                    .map(|value| {
                        value
                            .as_bool()
                            .ok_or("INVALID_ARGUMENT: showUpstreamSources must be a boolean")
                    })
                    .transpose()?;
                let port = body
                    .get("port")
                    .map(|port| {
                        port.as_u64()
                            .filter(|port| *port > 0 && *port <= 65535)
                            .map(|port| port as u16)
                            .ok_or("INVALID_ARGUMENT: port must be 1..65535")
                    })
                    .transpose()?;
                let name = body
                    .get("name")
                    .map(|name| {
                        name.as_str()
                            .filter(|name| {
                                !name.is_empty()
                                    && name.len() <= 120
                                    && !name.chars().any(char::is_control)
                            })
                            .map(str::to_owned)
                            .ok_or("INVALID_ARGUMENT: name must be a label of 1..120 bytes")
                    })
                    .transpose()?;
                {
                    let mut state = self.state.lock().unwrap();
                    if let Some(show) = show_upstream_sources {
                        state.stored.show_upstream_sources = show;
                    }
                    if let Some(port) = port {
                        state.stored.port = port;
                    }
                    if let Some(name) = name {
                        state.stored.name = Some(name);
                    }
                    self.persist(&state)?;
                }
                self.reconcile(enabled()).await?;
                let port = self.state.lock().unwrap().stored.port;
                Ok(
                    json!({"deviceId":self.identity()?.id,"port":port,"name":self.name()?,"showUpstreamSources":self.state.lock().unwrap().stored.show_upstream_sources}),
                )
            }
            _ => Err("UNKNOWN_OPERATION: Read cli guide for Device link commands.".into()),
        }
    }
    async fn offer(&self) -> Result<Value> {
        let identity = self.identity()?;
        let addresses = self.addresses()?;
        if addresses.is_empty() {
            return Err(error(
                "DEVICE_LAN_UNAVAILABLE",
                "Connect a private LAN interface and retry device offer.",
            ));
        }
        let tunnel_url = self.public_peer_url().await;
        let mut state = self.state.lock().unwrap();
        if state.stored.controller.is_some() {
            return Err(error(
                "DEVICE_CONTROLLER_EXISTS",
                "Revoke the existing controller locally before offering again.",
            ));
        }
        if state
            .pending
            .as_ref()
            .is_some_and(|p| p.expires > Instant::now())
        {
            return Err(error(
                "DEVICE_PAIRING_PENDING",
                "Read device pending, then approve or decline locally.",
            ));
        }
        let secret = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let offer = Offer {
            version: VERSION,
            device_id: identity.id.clone(),
            addresses,
            tunnel_url,
            secret: secret.clone(),
        };
        state.offer = Some((hash(&secret), Instant::now() + OFFER_TTL));
        Ok(
            json!({"pairingString":offer.encode()?,"deviceId":identity.id,"protocolVersion":VERSION,"expiresInSeconds":600}),
        )
    }
    async fn prove(&self, id: &str, public_key: &str, body: &Value) -> Result<Value> {
        self.reject_cycle(id).await?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        let expires = {
            let mut state = self.state.lock().unwrap();
            if !state.enabled {
                return Err(unavailable());
            }
            if state.stored.controller.is_some() {
                return Err(error(
                    "DEVICE_CONTROLLER_EXISTS",
                    "Revoke the existing controller locally first.",
                ));
            }
            if state.stored.members.contains_key(id) {
                return Err(error(
                    "DEVICE_PEER_FORBIDDEN",
                    "A member cannot control its controller. Read cli guide.",
                ));
            }
            let (secret, expires) = state.offer.as_ref().ok_or_else(|| {
                error(
                    "DEVICE_OFFER_EXPIRED",
                    "Create a fresh member-local device offer.",
                )
            })?;
            if *expires <= Instant::now() {
                state.offer = None;
                return Err(error(
                    "DEVICE_OFFER_EXPIRED",
                    "Create a fresh member-local device offer.",
                ));
            }
            if hash(string(body, "secret")) != *secret {
                return Err(error(
                    "DEVICE_PAIRING_SECRET",
                    "Use the current member offer; read cli guide.",
                ));
            }
            let expires = *expires;
            let name = string(body, "name");
            if name.is_empty() || name.len() > 120 || name.chars().any(char::is_control) {
                return Err("INVALID_ARGUMENT: name must be a label of 1..120 bytes".into());
            }
            state.offer = None;
            state.pending = Some(Pending {
                peer: Peer {
                    device_id: id.into(),
                    public_key: public_key.into(),
                    name: name.into(),
                    addresses: vec![],
                    tunnel_url: None,
                    address_override: None,
                },
                expires,
                decision: tx,
            });
            expires
        };
        tokio::time::timeout_at(tokio::time::Instant::from_std(expires), rx)
            .await
            .map_err(|_| {
                error(
                    "DEVICE_OFFER_EXPIRED",
                    "Create a fresh member-local device offer.",
                )
            })?
            .map_err(|_| {
                error(
                    "DEVICE_PAIRING_DECLINED",
                    "Create a fresh member-local offer after local approval is available.",
                )
            })?
    }
    async fn decide(&self, approve: bool) -> Result<Value> {
        let _configuration = self.configuration.lock().await;
        let pending = self.state.lock().unwrap().pending.take().ok_or_else(|| {
            error(
                "DEVICE_PAIRING_MISSING",
                "Read device pending after the controller proves an offer.",
            )
        })?;
        if pending.expires <= Instant::now() || pending.decision.is_closed() {
            return Err(error(
                "DEVICE_OFFER_EXPIRED",
                "Create a fresh member-local device offer.",
            ));
        }
        if !approve {
            let _ = pending.decision.send(Err(error(
                "DEVICE_PAIRING_DECLINED",
                "The member declined. Create a new offer to try again.",
            )));
            return Ok(json!({"declined":true,"deviceId":pending.peer.device_id}));
        }
        if let Err(error) = self.reject_cycle(&pending.peer.device_id).await {
            let _ = pending.decision.send(Err(error.clone()));
            return Err(error);
        }
        let identity = self.identity()?;
        // Core owns the source store; front-door pairing never writes it directly.
        crate::front_door::process::authority("peer_connect", json!({"deviceId":pending.peer.device_id,"publicKey":pending.peer.public_key,"name":pending.peer.name})).await?;
        {
            let mut state = self.state.lock().unwrap();
            if state.stored.controller.is_some() {
                return Err(error(
                    "DEVICE_CONTROLLER_EXISTS",
                    "Revoke the existing controller locally first.",
                ));
            }
            state.stored.controller = Some(pending.peer.clone());
            self.persist(&state)?;
        }
        let member = Peer {
            device_id: identity.id.clone(),
            public_key: identity.public_key.clone(),
            name: self.name()?,
            addresses: self.addresses()?,
            tunnel_url: self.public_peer_url().await,
            address_override: None,
        };
        let _ = pending
            .decision
            .send(Ok(json!({"paired":true,"version":VERSION,"member":member})));
        Ok(json!({"approved":true,"deviceId":pending.peer.device_id,"name":pending.peer.name}))
    }
    async fn revoke(&self, id: &str) -> Result<Value> {
        let _configuration = self.configuration.lock().await;
        let controller = {
            let mut state = self.state.lock().unwrap();
            let controller = state
                .stored
                .controller
                .as_ref()
                .is_some_and(|p| p.device_id == id);
            if controller {
                state.stored.controller = None;
                state.stored.upstream_sources.clear();
            } else if state.stored.members.remove(id).is_none() {
                return Err(error(
                    "DEVICE_UNPAIRED",
                    "Use the paired device ID; read cli guide.",
                ));
            }
            // Cancel before IPC so revocation still closes sockets while Core is unavailable.
            self.closed
                .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
            self.persist(&state)?;
            controller
        };
        if controller {
            crate::front_door::process::authority("peer_revoke", json!({"deviceId":id})).await?;
        }
        Ok(json!({"revoked":true,"deviceId":id}))
    }
}

pub fn lan_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_private() || ip.is_link_local(),
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(|ip| lan_address(IpAddr::V4(ip)))
            .unwrap_or_else(|| {
                (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80
            }),
    }
}

pub fn operations() -> Vec<Value> {
    if !enabled() {
        return vec![];
    }
    ["snapshot","offer","pending","approve","decline","pair","cancel-pair","revoke","configure","address","tasks"].into_iter().map(|action| {
        let (properties, required) = match action {
            "pair" => (json!({"pairingString":{"type":"string","maxLength":16384}}),json!(["pairingString"])),
            "tasks" => (json!({"device":{"type":"string","minLength":1}}),json!(["device"])),
            "address" => (json!({"device":{"type":"string","minLength":1},"address":{"type":["string","null"]}}),json!(["device","address"])),
            "revoke" => (json!({"deviceId":{"type":"string","pattern":"^[a-f0-9]{64}$"}}),json!(["deviceId"])),
            "configure" => (json!({"showUpstreamSources":{"type":"boolean","default":false},"port":{"type":"integer","minimum":1,"maximum":65535},"name":{"type":"string","minLength":1,"maxLength":120}}),json!([])),
            _ => (json!({}),json!([])),
        };
        json!({"name":format!("device.{action}"),"method":"POST","route":format!("device/{action}"),"localOnly":true,"description":format!("Device link local {action}. Read cli guide for pairing and transport contracts."),
            "inputSchema":{"type":"object","properties":{"body":{"type":"object","properties":properties,"required":required,"additionalProperties":false}},"required":if required.as_array().is_some_and(|r| !r.is_empty()) {json!(["body"])} else {json!([])},"additionalProperties":false}})
    }).collect()
}

pub(crate) fn tunnel_response_cap() -> usize {
    tunnel::RESPONSE_CAP
}
