//! Controller Core owns reachability, multiplexed links and bounded forwarding metadata.
use super::client::{Channel, Session};
use super::records::{Forward, Records};
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Notify;

#[derive(Clone, Default)]
struct Status {
    online: bool,
    last_seen: Option<String>,
    latency: Option<u64>,
    hello: Value,
    error: Option<String>,
}
struct Member {
    peer: Peer,
    status: StdMutex<Status>,
    business: Session,
    heartbeat: Session,
    slots: Arc<tokio::sync::Semaphore>,
    task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
}
impl Member {
    async fn stop(&self) {
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
        self.business.close().await;
        self.heartbeat.close().await;
    }
}
struct Resolution {
    fullname: String,
    addresses: Vec<SocketAddr>,
    version: u16,
}
pub(crate) struct Controller {
    directory: PathBuf,
    members: Mutex<BTreeMap<String, Arc<Member>>>,
    records: Arc<StdMutex<Records>>,
    identity: StdMutex<Option<Arc<Identity>>>,
    discovered: StdMutex<BTreeMap<String, Resolution>>,
    runtime: Mutex<Option<tokio::task::JoinHandle<()>>>,
    running: AtomicBool,
    pub(crate) changed: Notify,
}
impl Controller {
    pub fn new(directory: PathBuf) -> Result<Arc<Self>> {
        let records = Records::open(&directory)?;
        Ok(Arc::new(Self {
            directory,
            members: Mutex::new(BTreeMap::new()),
            records: Arc::new(StdMutex::new(records)),
            identity: StdMutex::new(None),
            discovered: Default::default(),
            runtime: Mutex::new(None),
            running: AtomicBool::new(false),
            changed: Notify::new(),
        }))
    }
    pub async fn reconcile(self: &Arc<Self>, enabled: bool) -> Result<()> {
        if !enabled {
            return self.stop().await;
        }
        let mut runtime = self.runtime.lock().await;
        if runtime.is_some() {
            drop(runtime);
            return self.sync().await;
        }
        *self.identity.lock().unwrap() = Some(Arc::new(Identity::load_or_create(&self.directory)?));
        self.running.store(true, Ordering::SeqCst);
        let daemon = mdns_sd::ServiceDaemon::new().map_err(|e| e.to_string())?;
        let receiver = daemon
            .browse("_arc-peer._tcp.local.")
            .map_err(|e| e.to_string())?;
        let controller = self.clone();
        *runtime = Some(tokio::spawn(async move {
            struct Shutdown(mdns_sd::ServiceDaemon);
            impl Drop for Shutdown {
                fn drop(&mut self) {
                    let _ = self.0.shutdown();
                }
            }
            let _daemon = Shutdown(daemon);
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            loop {
                tokio::select! {
                    _=tick.tick()=> {if let Err(error)=controller.sync().await {crate::logs::record("WARN",&error,None);}},
                    event=receiver.recv_async()=> {match event {Ok(event)=>controller.discover(event).await,Err(_)=>break}},
                }
            }
        }));
        Ok(())
    }
    pub async fn stop(&self) -> Result<()> {
        self.running.store(false, Ordering::SeqCst);
        if let Some(task) = self.runtime.lock().await.take() {
            task.abort();
            let _ = task.await;
        }
        let members = std::mem::take(&mut *self.members.lock().await);
        for member in members.values() {
            member.stop().await;
        }
        self.discovered.lock().unwrap().clear();
        self.changed.notify_waiters();
        Ok(())
    }
    async fn sync(self: &Arc<Self>) -> Result<()> {
        let path = self.directory.join("peers.json");
        let stored: Stored = if path.exists() {
            serde_json::from_value(crate::kernel::file_cache::load(&path)?)
                .map_err(|e| e.to_string())?
        } else {
            Stored::default()
        };
        let mut members = self.members.lock().await;
        let removed = members
            .iter()
            .filter(|(id, member)| stored.members.get(*id) != Some(&member.peer))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in removed {
            if let Some(member) = members.remove(&id) {
                member.stop().await;
            }
        }
        for (id, peer) in stored.members {
            if members.contains_key(&id) {
                continue;
            }
            let last_seen = self.records.lock().unwrap().last_seen.get(&id).cloned();
            let member = Arc::new(Member {
                peer,
                status: StdMutex::new(Status {
                    hello: self
                        .records
                        .lock()
                        .unwrap()
                        .facts
                        .get(&id)
                        .cloned()
                        .unwrap_or(Value::Null),
                    last_seen,
                    ..Status::default()
                }),
                business: Session::default(),
                heartbeat: Session::default(),
                slots: Arc::new(tokio::sync::Semaphore::new(64)),
                task: Default::default(),
            });
            members.insert(id, member.clone());
            let controller = self.clone();
            let monitor = member.clone();
            *member.task.lock().unwrap() = Some(tokio::spawn(async move {
                controller.monitor(monitor).await;
            }));
        }
        self.discovered
            .lock()
            .unwrap()
            .retain(|id, _| members.contains_key(id));
        let mut records = self.records.lock().unwrap();
        records.last_seen.retain(|id, _| members.contains_key(id));
        records.facts.retain(|id, _| members.contains_key(id));
        Ok(())
    }
    async fn discover(&self, event: mdns_sd::ServiceEvent) {
        match event {
            mdns_sd::ServiceEvent::ServiceResolved(service) => {
                let Some(id) = service.get_property_val_str("id") else {
                    return;
                };
                if !self.members.lock().await.contains_key(id) {
                    return;
                }
                let Some(version) = service
                    .get_property_val_str("version")
                    .and_then(|v| v.parse().ok())
                else {
                    return;
                };
                let addresses = service
                    .get_addresses()
                    .iter()
                    .filter_map(|ip| {
                        let address = match ip {
                            mdns_sd::ScopedIp::V6(ip) => {
                                SocketAddr::V6(std::net::SocketAddrV6::new(
                                    *ip.addr(),
                                    service.get_port(),
                                    0,
                                    ip.scope_id().index,
                                ))
                            }
                            _ => SocketAddr::new(ip.to_ip_addr(), service.get_port()),
                        };
                        lan_address(address.ip()).then_some(address)
                    })
                    .take(64)
                    .collect();
                self.discovered.lock().unwrap().insert(
                    id.into(),
                    Resolution {
                        fullname: service.get_fullname().into(),
                        addresses,
                        version,
                    },
                );
            }
            mdns_sd::ServiceEvent::ServiceRemoved(_, name) => {
                self.discovered
                    .lock()
                    .unwrap()
                    .retain(|_, r| r.fullname != name);
            }
            _ => {}
        }
    }
    async fn addresses(&self, peer: &Peer) -> Result<Vec<SocketAddr>> {
        if let Some(address) = &peer.address_override {
            let addresses = tokio::net::lookup_host(address)
                .await
                .map_err(|e| {
                    error(
                        "DEVICE_LAN_UNAVAILABLE",
                        &format!("{e}; check the controller address override."),
                    )
                })?
                .filter(|a| lan_address(a.ip()))
                .take(64)
                .collect::<Vec<_>>();
            return super::transport::connect_addresses(
                &addresses
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>(),
            );
        }
        let discovered = self.discovered.lock().unwrap();
        if let Some(resolution) = discovered.get(&peer.device_id) {
            if resolution.version != VERSION {
                return Err(error(
                    "DEVICE_PROTOCOL_MISMATCH",
                    "Install matching peer protocol versions; query guide for device.",
                ));
            }
            if !resolution.addresses.is_empty() {
                return super::transport::connect_addresses(
                    &resolution
                        .addresses
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>(),
                );
            }
        }
        super::transport::connect_addresses(&peer.addresses)
    }
    async fn channel(&self, member: &Member, heartbeat: bool) -> Result<Arc<Channel>> {
        let session = if heartbeat {
            &member.heartbeat
        } else {
            &member.business
        };
        if let Some(channel) = session.cached().await {
            return Ok(channel);
        }
        let addresses = self.addresses(&member.peer).await?;
        let identity = self
            .identity
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(unavailable)?;
        session
            .connect(&identity, &member.peer.device_id, &addresses)
            .await
    }
    async fn monitor(self: Arc<Self>, member: Arc<Member>) {
        let mut tick = tokio::time::interval(Duration::from_secs(10));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut misses = 0;
        loop {
            tick.tick().await;
            let start = Instant::now();
            let result = tokio::time::timeout(Duration::from_secs(5), async {
                let channel = self.channel(&member, true).await?;
                let hello = channel
                    .request(
                        "/arc-peer/2/hello",
                        json!({"version":VERSION}),
                        Duration::from_secs(5),
                    )
                    .await?;
                if hello["version"] != VERSION {
                    return Err(error(
                        "DEVICE_PROTOCOL_MISMATCH",
                        "Install matching peer protocol versions; query guide for device.",
                    ));
                }
                if hello["deviceId"] != member.peer.device_id {
                    return Err(error(
                        "DEVICE_TLS_FAILED",
                        "The pinned member identity does not match; query guide for device.",
                    ));
                }
                // Establish the persistent business channel before advertising online readiness.
                self.channel(&member, false).await?.ready().await?;
                Ok::<Value, String>(hello)
            })
            .await
            .unwrap_or_else(|_| {
                Err("DEVICE_LAN_UNAVAILABLE: Heartbeat deadline expired; query devices.".into())
            });
            match result {
                Ok(hello) => {
                    misses = 0;
                    let seen = now();
                    *member.status.lock().unwrap() = Status {
                        online: true,
                        last_seen: Some(seen.clone()),
                        latency: Some(start.elapsed().as_millis() as u64),
                        hello,
                        error: None,
                    };
                    let mut records = self.records.lock().unwrap();
                    records.facts.insert(
                        member.peer.device_id.clone(),
                        member.status.lock().unwrap().hello.clone(),
                    );
                    records
                        .last_seen
                        .insert(member.peer.device_id.clone(), seen);
                    if let Err(error) = records.save(&self.directory) {
                        crate::logs::record("WARN", &error, None);
                    }
                }
                Err(error) => {
                    misses += 1;
                    let mut status = member.status.lock().unwrap();
                    if misses >= 3
                        || error.starts_with("DEVICE_CONNECTION_REFUSED")
                        || error.contains("DEVICE_PROTOCOL_MISMATCH")
                    {
                        status.online = false;
                    }
                    status.error = Some(error);
                }
            }
            self.changed.notify_waiters();
        }
    }
    pub async fn list(&self, all: bool) -> Value {
        let members = self.members.lock().await;
        let devices=members.values().filter_map(|member|{
            let status=member.status.lock().unwrap();
            if !all && !status.online{return None;}
            Some(json!({"id":member.peer.device_id,"name":member.peer.name,"platform":status.hello["platform"],"arch":status.hello["arch"],"arcVersion":status.hello["arcVersion"],"state":if status.online{"online"}else{"offline"},"path":"lan","lastSeen":status.last_seen,"latency":status.latency,"capabilities":status.hello["capabilities"],"error":status.error}))
        }).collect::<Vec<_>>();
        json!({"devices":devices})
    }
    async fn member(&self, selector: &str) -> Result<Arc<Member>> {
        let members = self.members.lock().await;
        if let Some(member) = members.get(selector) {
            return Ok(member.clone());
        }
        let matching = members
            .values()
            .filter(|m| m.peer.name == selector)
            .collect::<Vec<_>>();
        if matching.len() != 1 {
            return Err(device_error(
                "DEVICE_UNKNOWN",
                "Use a device ID or a unique paired name from query devices.",
                json!({"via":"query","op":"devices","args":{"all":true}}),
            ));
        }
        Ok(matching[0].clone())
    }
    pub async fn forward(
        self: &Arc<Self>,
        tool: &str,
        args: Value,
        caller_request: Option<&Value>,
        origin: Value,
    ) -> Result<Value> {
        if !self.running.load(Ordering::SeqCst) {
            return Err(unavailable());
        }
        let member = self.member(string(&args, "device")).await?;
        let op = string(&args, "op");
        let inner = args["args"].clone();
        if super::transport::forbidden(op) {
            return Err(error("DEVICE_PEER_FORBIDDEN","A forwarded request cannot reach Device link or local management; query guide for device."));
        }
        if !member.status.lock().unwrap().online {
            let mismatch = member
                .status
                .lock()
                .unwrap()
                .error
                .as_ref()
                .is_some_and(|e| e.contains("DEVICE_PROTOCOL_MISMATCH"));
            return Err(if mismatch {
                device_error(
                    "DEVICE_PROTOCOL_MISMATCH",
                    "Install matching peer protocol versions.",
                    json!({"via":"query","op":"guide","args":{"op":"device"}}),
                )
            } else {
                offline()
            });
        }
        self.records
            .lock()
            .unwrap()
            .authorize(&member.peer.device_id, op, &inner, &origin)?;
        let write = tool == "act"
            && !(op == "receipt" && inner["action"].as_str().unwrap_or("read") == "read");
        let request = (if op == "receipt" {
            inner.get("requestId")
        } else {
            caller_request
        })
        .and_then(Value::as_str)
        .or_else(|| inner["requestId"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(id);
        if write && op != "receipt" && inner["requestId"].as_str().is_some_and(|id| id != request) {
            return Err(device_error(
                "REQUEST_ID_CONFLICT",
                "Outer and inner request IDs must match; retain the original member receipt ID.",
                json!({"via":"query","op":"guide","args":{"op":"device"}}),
            ));
        }
        if write {
            uuid::Uuid::parse_str(&request)
                .map_err(|_| "INVALID_ARGUMENT: requestId must be a UUID")?;
        }
        let _slot=member.slots.clone().try_acquire_owned().map_err(|_|error("DEVICE_BUSY","64 member requests are already active; read the original receipts or wait for a read to finish."))?;
        let channel = tokio::time::timeout(Duration::from_secs(5), self.channel(&member, false))
            .await
            .map_err(|_| {
                error(
                    "DEVICE_LAN_UNAVAILABLE",
                    "Preparing a member connection timed out; query devices.",
                )
            })?
            .map_err(|error| {
                if error.starts_with("DEVICE_CONNECTION_REFUSED") {
                    member.status.lock().unwrap().online = false;
                    offline()
                } else {
                    error
                }
            })?;
        let sender =
            tokio::time::timeout(super::client::request_bound(op, &inner), channel.ready())
                .await
                .map_err(|_| {
                    error(
                        "DEVICE_BUSY",
                        "The peer did not admit a stream before the op deadline; query devices.",
                    )
                })?
                .map_err(|_| {
                    error(
                        "DEVICE_LAN_UNAVAILABLE",
                        "The peer connection closed before submission; query devices.",
                    )
                })?;
        let source = string(&origin, "sourceId").to_owned();
        let mut payload = inner.clone();
        if let Some(payload) = payload.as_object_mut() {
            payload.remove("requestId");
            payload.remove("waitMs");
        }
        let digest = hash(json!([tool, op, payload]).to_string());
        if write && op != "receipt" {
            let mut records = self.records.lock().unwrap();
            if let Some(previous) = records.forwards.iter().find(|r| r.request_id == request) {
                if previous.source_id != source
                    || previous.device_id != member.peer.device_id
                    || previous.op != op
                    || previous.digest != digest
                {
                    return Err(device_error(
                        "REQUEST_ID_CONFLICT",
                        "This request ID belongs to another forward; read its original receipt.",
                        json!({"via":"query","op":"guide","args":{"op":"device"}}),
                    ));
                }
                return Err(uncertain(
                    &request,
                    &member.peer.device_id,
                    "This write was already sent. Read its member receipt.",
                ));
            }
            records.record(Forward {
                request_id: request.clone(),
                device_id: member.peer.device_id.clone(),
                op: op.into(),
                source_id: source.clone(),
                sent_at: now(),
                outcome: "sent".into(),
                digest,
            });
            records.save(&self.directory)?;
        }
        let _guard = ForwardGuard {
            controller: self.clone(),
            request: request.clone(),
            active: write,
        };
        let mut body = json!({"op":op,"args":inner});
        if write {
            body["requestId"] = json!(request);
        }
        let wire = json!({"version":VERSION,"tool":tool,"body":body,"origin":{"sourceId":source}});
        let result = Channel::send(
            sender,
            "/arc-peer/2/request",
            wire,
            super::client::request_bound(op, &args["args"]),
        )
        .await;
        match result {
            Ok(response) => {
                let value = crate::egress::tool_value(&response).map_err(|error| {
                    if write {
                        uncertain(&request, &member.peer.device_id, &error)
                    } else {
                        error
                    }
                })?;
                let mut records = self.records.lock().unwrap();
                if write {
                    records.outcome(
                        &request,
                        if response["isError"] == true {
                            "failed"
                        } else {
                            "completed"
                        },
                    );
                }
                if write || op == "receipt" {
                    records.associate(&member.peer.device_id, &source, &value);
                }
                records.save(&self.directory).map_err(|error| {
                    if write {
                        uncertain(&request, &member.peer.device_id, &error)
                    } else {
                        error
                    }
                })?;
                Ok(response)
            }
            Err(error) => {
                if write {
                    Err(uncertain(&request, &member.peer.device_id, &error))
                } else {
                    Err(device_error(
                        "DEVICE_RESPONSE_LOST",
                        &error,
                        json!({"via":"query","op":"devices","args":{}}),
                    ))
                }
            }
        }
    }
}
struct ForwardGuard {
    controller: Arc<Controller>,
    request: String,
    active: bool,
}
impl Drop for ForwardGuard {
    fn drop(&mut self) {
        if self.active {
            let mut records = self.controller.records.lock().unwrap();
            if records
                .forwards
                .iter()
                .any(|r| r.request_id == self.request && r.outcome == "sent")
            {
                records.outcome(&self.request, "uncertain");
                let _ = records.save(&self.controller.directory);
            }
        }
    }
}
fn device_error(code: &str, message: &str, next: Value) -> String {
    json!({"code":code,"message":message,"next":next}).to_string()
}
fn offline() -> String {
    device_error(
        "DEVICE_OFFLINE",
        "Member is offline. Request was not transmitted.",
        json!({"via":"query","op":"devices","args":{}}),
    )
}
fn uncertain(request: &str, device: &str, message: &str) -> String {
    json!({"code":"DEVICE_OUTCOME_UNCERTAIN","state":"unconfirmed","requestId":request,"message":message,"next":{"via":"act","op":"device","args":{"device":device,"op":"receipt","args":{"requestId":request,"action":"read"}}}}).to_string()
}
