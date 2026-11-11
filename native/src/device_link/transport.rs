//! LAN-only HTTPS transport. TLS completes before hyper can read any request.
use super::*;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    body::{Bytes, Incoming},
    Request, Response,
};
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::net::TcpListener;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PeerRequest {
    pub version: u16,
    pub tool: String,
    pub body: Value,
    /// A controller's bounded source reference; never member authority.
    pub origin: Value,
}
impl PeerRequest {
    pub fn validate(&self) -> Result<()> {
        if self.version != VERSION {
            return Err(error(
                "DEVICE_PROTOCOL_MISMATCH",
                "Use peer protocol version 3; read cli guide.",
            ));
        }
        if !matches!(self.tool.as_str(), "guide" | "query" | "act") {
            return Err(error(
                "DEVICE_PEER_FORBIDDEN",
                "Peers may call guide, query or act only; read query guide.",
            ));
        }
        let op = string(&self.body, "op");
        if forbidden(op)
            || self.body["op"] == "guide" && forbidden(string(&self.body["args"], "op"))
        {
            return Err(error("DEVICE_PEER_FORBIDDEN", "Peer-origin Device link and local management calls are unavailable; read query guide."));
        }
        if serde_json::to_vec(&self.origin)
            .map_err(|e| e.to_string())?
            .len()
            > 4096
        {
            return Err("INVALID_ARGUMENT: origin must fit 4096 bytes".into());
        }
        Ok(())
    }
}
pub(crate) fn forbidden(op: &str) -> bool {
    op == "devices"
        || op == "device"
        || op.starts_with("device_")
        || op.starts_with("device.")
        || op.starts_with("device/")
}

pub(super) struct HandshakeBudget {
    addresses: BTreeMap<IpAddr, AddressBudget>,
}
struct AddressBudget {
    since: Instant,
    used: Instant,
    remaining: u8,
    slots: Arc<tokio::sync::Semaphore>,
}
impl HandshakeBudget {
    pub(super) fn new() -> Self {
        Self {
            addresses: BTreeMap::new(),
        }
    }
    pub(super) fn admit(
        &mut self,
        address: IpAddr,
        now: Instant,
    ) -> Option<tokio::sync::OwnedSemaphorePermit> {
        let address = match address {
            IpAddr::V6(ip) => ip
                .to_ipv4_mapped()
                .map(IpAddr::V4)
                .unwrap_or(IpAddr::V6(ip)),
            other => other,
        };
        if !self.addresses.contains_key(&address) {
            if self.addresses.len() >= 256 {
                let oldest = self
                    .addresses
                    .iter()
                    .filter(|(_, entry)| entry.slots.available_permits() == 2)
                    .min_by_key(|(_, entry)| entry.used)
                    .map(|(key, _)| *key)?;
                self.addresses.remove(&oldest);
            }
            self.addresses.insert(
                address,
                AddressBudget {
                    since: now,
                    used: now,
                    remaining: 32,
                    slots: Arc::new(tokio::sync::Semaphore::new(2)),
                },
            );
        }
        let entry = self.addresses.get_mut(&address).unwrap();
        entry.used = now;
        if now.duration_since(entry.since) >= Duration::from_secs(60) {
            entry.since = now;
            entry.remaining = 32;
        }
        if entry.remaining == 0 {
            return None;
        }
        let permit = entry.slots.clone().try_acquire_owned().ok()?;
        entry.remaining -= 1;
        Some(permit)
    }
}
impl Manager {
    pub(super) async fn start_runtime(self: &Arc<Self>) -> Result<Runtime> {
        let identity = self.identity()?;
        let port = self.state.lock().unwrap().stored.port;
        let sockets = lan_sockets(port)?;
        let acceptor = tls::server(self, &identity)?;
        let mut listeners = Vec::new();
        // Bind all interfaces before spawning, so a partial bind cannot leave a listener behind.
        for address in &sockets {
            listeners.push(TcpListener::bind(address).await.map_err(|e| {
                error(
                    "DEVICE_LISTEN_FAILED",
                    &format!("Cannot bind {address}: {e}. Configure another peer port locally."),
                )
            })?);
        }
        let advertisement = mdns_sd::ServiceDaemon::new().map_err(|e| e.to_string())?;
        let runtime = Runtime {
            listeners: vec![],
            advertisement,
        };
        advertise(&runtime.advertisement, &identity.id, port, &sockets)?;
        let budget = Arc::new(StdMutex::new(HandshakeBudget::new()));
        let manager = self.clone();
        let advertisement = runtime.advertisement.clone();
        let mut runtime = runtime;
        runtime.listeners.push(tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            let mut interfaces = BTreeMap::new();
            for listener in listeners {
                let address = listener.local_addr().unwrap();
                let handle = tasks.spawn(manager.clone().listen_interface(listener,acceptor.clone(),budget.clone()));
                interfaces.insert(address,handle);
            }
            let mut advertised = interfaces.keys().copied().collect::<Vec<_>>();
            let mut refresh = tokio::time::interval(Duration::from_secs(5));
            loop {
                tokio::select! {
                    _ = refresh.tick() => {
                        let desired = match lan_sockets(port) { Ok(addresses) => addresses, Err(error) => { crate::logs::record("WARN",&error,None); continue; } };
                        let previous = interfaces.keys().copied().collect::<Vec<_>>();
                        for address in &previous {
                            if !desired.contains(address) { interfaces.remove(address).unwrap().abort(); }
                        }
                        for address in desired {
                            if interfaces.contains_key(&address) { continue; }
                            match TcpListener::bind(address).await {
                                Ok(listener) => {
                                    let handle = tasks.spawn(manager.clone().listen_interface(listener,acceptor.clone(),budget.clone()));
                                    interfaces.insert(address,handle);
                                }
                                Err(error) => crate::logs::record("WARN", &format!("Device link cannot bind {address}: {error}"),None),
                            }
                        }
                        let current = interfaces.keys().copied().collect::<Vec<_>>();
                        if advertised != current {
                            match advertise(&advertisement,&identity.id,port,&current) {
                                Ok(()) => advertised = current,
                                Err(error) => crate::logs::record("WARN",&error,None),
                            }
                        }
                    }
                    Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
                }
            }
        }));
        Ok(runtime)
    }
    async fn listen_interface(
        self: Arc<Self>,
        listener: TcpListener,
        acceptor: tokio_rustls::TlsAcceptor,
        budget: Arc<StdMutex<HandshakeBudget>>,
    ) {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((stream,address)) = accepted else { break; };
                    if !lan_address(address.ip()) { continue; }
                    let Some(permit) = budget.lock().unwrap().admit(address.ip(),Instant::now()) else { continue; };
                    connections.spawn(self.clone().accept_connection(stream, acceptor.clone(), permit));
                }
                Some(_) = connections.join_next(), if !connections.is_empty() => {},
            }
        }
    }
    pub(super) async fn accept_connection<S>(
        self: Arc<Self>,
        stream: S,
        acceptor: tokio_rustls::TlsAcceptor,
        permit: tokio::sync::OwnedSemaphorePermit,
    ) where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let mut closed = self.closed.subscribe();
        tokio::select! {
            _ = closed.changed() => {},
            _ = async {
                let Ok(Ok(tls)) = tokio::time::timeout(Duration::from_secs(5),acceptor.accept(stream)).await else { return; };
                drop(permit);
                if tls.get_ref().1.alpn_protocol() != Some(tls::ALPN) { return; }
                let Some(cert) = tls.get_ref().1.peer_certificates().and_then(|c|c.first()) else { return; };
                let Ok((id,key)) = identity::certificate_identity(cert) else { return; };
                let paired=self.controller(&id).is_ok();
                let slots=if paired {&self.paired_connections}else{&self.unpaired_connections};
                let Ok(_connection)=slots.clone().try_acquire_owned() else{return;};
                if paired {let _=self.serve(tls,id,key).await;}
                else {let _=tokio::time::timeout(OFFER_TTL,self.serve(tls,id,key)).await;}
            } => {},
        }
    }
    async fn serve<S>(self: Arc<Self>, stream: S, id: String, public_key: String) -> Result<()>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let service = hyper::service::service_fn(move |request| {
            let manager = self.clone();
            let id = id.clone();
            let key = public_key.clone();
            async move {
                let result = manager.handle_http(&id, &key, request).await;
                let body = match result {
                    Ok(value) => json!({"ok":true,"result":value}),
                    Err(message) => {
                        json!({"ok":false,"error":{"code":crate::management::error_code(&message),"message":message,"next":{"via":"query","op":"guide","args":{}}}})
                    }
                };
                Ok::<_, std::convert::Infallible>(
                    Response::builder()
                        .header("content-type", "application/json")
                        .body(Full::new(Bytes::from(body.to_string())))
                        .unwrap(),
                )
            }
        });
        hyper::server::conn::http2::Builder::new(TokioExecutor::new())
            .max_concurrent_streams(128)
            .max_header_list_size(32768)
            .serve_connection(TokioIo::new(stream), service)
            .await
            .map_err(|e| e.to_string())
    }
    async fn handle_http(
        &self,
        id: &str,
        public_key: &str,
        request: Request<Incoming>,
    ) -> Result<Value> {
        if !self.accept_certificate(id) {
            return Err(error(
                "DEVICE_UNPAIRED",
                "Create and approve a new member-local offer; read cli guide.",
            ));
        }
        let path = request.uri().path().to_owned();
        if request.method() != hyper::Method::POST
            || !matches!(
                path.as_str(),
                "/arc-peer/3/pair" | "/arc-peer/3/request" | "/arc-peer/3/hello"
            )
        {
            return Err(error(
                "DEVICE_PEER_FORBIDDEN",
                "Use peer protocol version 3 routes; read cli guide.",
            ));
        }
        let limit = if path.ends_with("/request") {
            crate::front_door::MAX_REQUEST_BYTES
        } else {
            16384
        };
        let bytes = tokio::time::timeout(
            Duration::from_secs(10),
            Limited::new(request.into_body(), limit).collect(),
        )
        .await
        .map_err(|_| "INVALID_ARGUMENT: peer body deadline expired")?
        .map_err(|_| "INVALID_ARGUMENT: peer body exceeds its bound")?
        .to_bytes();
        let body: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "INVALID_ARGUMENT: peer body must be JSON")?;
        if body["version"] != VERSION {
            return Err(error(
                "DEVICE_PROTOCOL_MISMATCH",
                "Use peer protocol version 3; read cli guide.",
            ));
        }
        if path.ends_with("/hello") {
            return self.hello().await;
        }
        if path.ends_with("/pair") {
            return self.prove(id, public_key, &body).await;
        }
        self.business_request(id, body).await
    }
    pub(super) async fn hello(&self) -> Result<Value> {
        Ok(
            json!({"version":VERSION,"deviceId":self.identity()?.id,"name":self.name()?,"platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"arcVersion":env!("ARC_BUILD_VERSION"),"tunnelUrl":self.public_peer_url().await,"addresses":self.addresses()?,"capabilities":{"tools":["guide","query","act"],"screen":cfg!(target_os="macos"),"forwarding":false}}),
        )
    }
    pub(super) async fn business_request(&self, id: &str, body: Value) -> Result<Value> {
        self.controller(id)?;
        let request: PeerRequest = serde_json::from_value(body)
            .map_err(|_| "INVALID_ARGUMENT: expected {version,tool,body,origin}")?;
        request.validate()?;
        #[cfg(test)]
        let request_id = request.body["requestId"].as_str().map(str::to_owned);
        let result = crate::front_door::process::call(
            crate::front_door::peer_context(id.into()),
            crate::front_door::Operation::PeerControl,
            serde_json::to_value(request).map_err(|e| e.to_string())?,
        )
        .await?;
        #[cfg(test)]
        let gate = self.reply_gate.lock().unwrap().clone();
        #[cfg(test)]
        if let Some(gate) = gate {
            if request_id.as_deref() == Some(gate.request_id.as_str()) {
                gate.ready.notify_one();
                gate.release.notified().await;
            }
        }
        Ok(result)
    }
    pub(super) async fn pair(self: &Arc<Self>, offer: Offer) -> Result<Value> {
        let identity = self.identity()?;
        if identity.id == offer.device_id {
            return Err(error(
                "DEVICE_PAIRING_INVALID",
                "Pair a different device; read cli guide.",
            ));
        }
        if self
            .state
            .lock()
            .unwrap()
            .stored
            .controller
            .as_ref()
            .is_some_and(|peer| peer.device_id == offer.device_id)
        {
            return Err(error(
                "DEVICE_PEER_FORBIDDEN",
                "A member cannot pair its controller as a member. Read cli guide.",
            ));
        }
        let mut closed = self.closed.subscribe();
        let epoch = *closed.borrow();
        let session = super::client::Session::default();
        let addresses = connect_addresses(&offer.addresses)?;
        let channel = session
            .connect(&identity, &offer.device_id, &addresses)
            .await?;
        let result = tokio::select! {
            _=closed.changed()=>return Err(error("DEVICE_UNPAIRED","Local pairing was revoked or disabled; read cli guide.")),
            result=channel.request("/arc-peer/3/pair",json!({"version":VERSION,"secret":offer.secret,"name":self.name()?}),OFFER_TTL)=>result,
        };
        session.close().await;
        let result = result?;
        let member: Peer = serde_json::from_value(result["member"].clone()).map_err(|_| {
            error(
                "DEVICE_PAIRING_INVALID",
                "Member approval response is invalid; read cli guide.",
            )
        })?;
        if result["version"] != VERSION
            || member.device_id != offer.device_id
            || hash(
                base64::engine::general_purpose::STANDARD
                    .decode(&member.public_key)
                    .map_err(|e| e.to_string())?,
            ) != offer.device_id
        {
            return Err(error(
                "DEVICE_PAIRING_INVALID",
                "Member approval does not match the pinned key; read cli guide.",
            ));
        }
        let _configuration = self.configuration.lock().await;
        let mut state = self.state.lock().unwrap();
        if !state.enabled || epoch != *self.closed.borrow() {
            return Err(error(
                "DEVICE_UNPAIRED",
                "Pairing was disabled or revoked; read cli guide.",
            ));
        }
        state
            .stored
            .members
            .insert(member.device_id.clone(), member.clone());
        self.persist(&state)?;
        Ok(
            json!({"paired":true,"deviceId":member.device_id,"name":member.name,"addresses":member.addresses,"protocolVersion":VERSION}),
        )
    }
}
fn advertise(
    daemon: &mdns_sd::ServiceDaemon,
    id: &str,
    port: u16,
    sockets: &[SocketAddr],
) -> Result<()> {
    if sockets.is_empty() {
        daemon
            .unregister(&format!("{}._arc-peer._tcp.local.", &id[..32]))
            .map_err(|e| e.to_string())?;
    } else {
        let version = VERSION.to_string();
        let properties = [("id", id), ("version", version.as_str())];
        let ips = sockets.iter().map(|a| a.ip()).collect::<Vec<_>>();
        let info = mdns_sd::ServiceInfo::new(
            "_arc-peer._tcp.local.",
            &id[..32],
            &format!("arc-{}.local.", &id[..32]),
            ips.as_slice(),
            port,
            &properties[..],
        )
        .map_err(|e| e.to_string())?;
        daemon.register(info).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub(super) fn connect_addresses(addresses: &[String]) -> Result<Vec<SocketAddr>> {
    let interfaces = lan_interfaces()?;
    let mut result = Vec::new();
    for address in addresses {
        let address: SocketAddr = address
            .parse()
            .map_err(|_| "DEVICE_PAIRING_INVALID: Invalid LAN address; read cli guide.")?;
        if !lan_address(address.ip()) || address.port() == 0 {
            continue;
        }
        if let SocketAddr::V6(v6) = address {
            if v6.ip().is_unicast_link_local()
                && v6.scope_id() != 0
                && !interfaces.iter().any(|i| i.index == Some(v6.scope_id()))
            {
                continue;
            }
            if v6.ip().is_unicast_link_local() && v6.scope_id() == 0 {
                for interface in &interfaces {
                    if let Some(index) = interface.index {
                        let mut scoped = v6;
                        scoped.set_scope_id(index);
                        let scoped = SocketAddr::V6(scoped);
                        if !result.contains(&scoped) {
                            result.push(scoped);
                        }
                    }
                }
                continue;
            }
        }
        result.push(address);
    }
    addresses::sort(&mut result);
    Ok(result)
}
#[cfg(test)]
pub(super) async fn post<S>(stream: S, path: &str, body: Value) -> Result<Value>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let channel = super::client::Channel::new(stream).await?;
    let response = channel.request(path, body, OFFER_TTL).await;
    channel.close();
    response
}
