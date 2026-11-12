//! Controller Core owns reachability, multiplexed links and bounded forwarding metadata.
#[path = "events.rs"]
pub(crate) mod events;
mod transfer;
use super::client::{Channel, Session};
mod path;
use super::records::{Forward, Records};
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Notify;

#[derive(Clone, Default)]
struct Status {
    online: bool,
    path: String,
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
    tunnel: super::tunnel::Client,
    slots: Arc<tokio::sync::Semaphore>,
    task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
    event_task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
}
impl Member {
    async fn stop(&self) {
        self.status.lock().unwrap().online = false;
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
        if let Some(task) = self.event_task.lock().unwrap().take() {
            task.abort();
        }
        self.business.close().await;
        self.heartbeat.close().await;
        self.tunnel.close().await;
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
            .filter(|(id, member)| {
                let Some(saved) = stored.members.get(*id) else {
                    return true;
                };
                let mut current = member.peer.clone();
                current.addresses = saved.addresses.clone();
                current.tunnel_url = saved.tunnel_url.clone();
                &current != saved
            })
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
                tunnel: Default::default(),
                slots: Arc::new(tokio::sync::Semaphore::new(64)),
                task: Default::default(),
                event_task: Default::default(),
            });
            members.insert(id, member.clone());
            let events = self.clone();
            let polled = member.clone();
            *member.event_task.lock().unwrap() = Some(tokio::spawn(async move {
                events.poll_events(polled).await;
            }));
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
        let saved = self
            .records
            .lock()
            .unwrap()
            .facts
            .get(&peer.device_id)
            .and_then(|hello| hello["addresses"].as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|a| a.as_str().map(str::to_owned))
                    .collect::<Vec<_>>()
            });
        super::transport::connect_addresses(saved.as_deref().unwrap_or(&peer.addresses))
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
            self.heartbeat(&member, &mut misses).await;
        }
    }
    pub async fn list(&self, all: bool) -> Value {
        let members = self.members.lock().await;
        let devices=members.values().filter_map(|member|{
            let status=member.status.lock().unwrap();
            if !all && !status.online{return None;}
            Some(json!({"id":member.peer.device_id,"name":member.peer.name,"platform":status.hello["platform"],"arch":status.hello["arch"],"arcVersion":status.hello["arcVersion"],"state":if status.online{"online"}else{"offline"},"path":if status.path.is_empty(){"lan"}else{&status.path},"lastSeen":status.last_seen,"latency":status.latency,"capabilities":status.hello["capabilities"],"error":status.error}))
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
            let path = self.directory.join("peers.json");
            let stored: Stored = if path.exists() {
                serde_json::from_value(crate::kernel::file_cache::load(&path)?)
                    .map_err(|e| e.to_string())?
            } else {
                Stored::default()
            };
            if stored
                .controller
                .as_ref()
                .is_some_and(|peer| peer.device_id == selector || peer.name == selector)
            {
                return Err(device_error("DEVICE_UNPAIRED", "This device is an upstream controller, not a paired member. Pair a direct member locally; query guide with topic:device.",json!({"via":"query","op":"guide","args":{"topic":"device"}})));
            }
            return Err(device_error(
                "DEVICE_UNKNOWN",
                "Use a device ID or a unique paired name from query devices.",
                json!({"via":"query","op":"devices","args":{"all":true}}),
            ));
        }
        Ok(matching[0].clone())
    }
    pub async fn tasks(self: &Arc<Self>, device: &str) -> Result<Value> {
        let response = self
            .forward(
                "query",
                json!({"device":device,"op":"task_activity","args":{}}),
                None,
                crate::sources::panel_origin().await?,
            )
            .await?;
        let origin = crate::sources::panel_origin().await?;
        crate::management::device_read(response, |args| {
            self.forward(
                "query",
                json!({"device":device,"op":"control_output","args":args}),
                None,
                origin.clone(),
            )
        })
        .await
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
        let mut inner = args["args"].clone();
        let notification = if tool == "act" {
            events::binding_args(op, &inner)?
        } else {
            Value::Null
        };
        if super::transport::forbidden(op) || op == events::OP {
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
        let prepared = tokio::time::timeout(Duration::from_secs(5), self.prepare(&member))
            .await
            .map_err(|_| {
                error(
                    "DEVICE_RESPONSE_LOST",
                    "Preparing a member path timed out; query devices.",
                )
            })?
            .map_err(|failure| {
                if failure.starts_with("DEVICE_CONNECTION_REFUSED") {
                    member.status.lock().unwrap().online = false;
                    offline()
                } else {
                    failure
                }
            })?;
        let source = string(&origin, "sourceId").to_owned();
        let mut payload = inner.clone();
        if let Some(payload) = payload.as_object_mut() {
            payload.remove("requestId");
            payload.remove("waitMs");
        }
        let digest = hash(json!([tool, op, payload]).to_string());
        if events::dispatch(op) {
            inner.as_object_mut().map(|args| args.remove("notify"));
        }
        let mut body = json!({"op":op,"args":inner});
        if write {
            body["requestId"] = json!(request);
        }
        let wire = json!({"version":VERSION,"tool":tool,"body":body,"origin":{"sourceId":source,"sourceLabel":origin["sourceLabel"],"controlSource":origin["controlSource"]}});
        prepared.validate(&wire)?;
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
                notification,
            });
            records.save(&self.directory)?;
        }
        let _guard = ForwardGuard {
            controller: self.clone(),
            request: request.clone(),
            active: write,
        };
        let result = prepared
            .send(wire, super::client::request_bound(op, &inner))
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
                {
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
                    if op == "receipt" {
                        records.associate_receipt(&member.peer.device_id, &request, &value);
                    } else if write {
                        records.associate(&member.peer.device_id, &source, &value);
                    }
                    records.save(&self.directory).map_err(|error| {
                        if write {
                            uncertain(&request, &member.peer.device_id, &error)
                        } else {
                            error
                        }
                    })?;
                }
                if response["isError"] != true {
                    self.bind_result(&member, &request, &value)
                        .await
                        .map_err(|e| {
                            if write {
                                uncertain(&request, &member.peer.device_id, &e)
                            } else {
                                e
                            }
                        })?;
                    crate::claude_notify::device::acknowledge_read(
                        &member.peer.device_id,
                        &source,
                        op,
                        &args["args"],
                        &value,
                    )
                    .await?;
                }
                let mut response = response;
                if let Ok(mut value) = crate::egress::tool_value(&response) {
                    qualify_actions(&mut value, &member.peer.device_id);
                    response = crate::egress::tool(value, response["isError"] == true);
                }
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

/// Keep member continuations on their original directly paired device.
fn qualify_actions(value: &mut Value, device: &str) {
    match value {
        Value::Array(rows) => {
            for row in rows {
                qualify_actions(row, device);
            }
        }
        Value::Object(fields) => {
            if matches!(
                fields.get("via").and_then(Value::as_str),
                Some("query" | "act")
            ) && fields.get("op").is_some_and(Value::is_string)
                && fields.get("args").is_some_and(Value::is_object)
            {
                let op = fields["op"].clone();
                let args = fields["args"].clone();
                fields.insert("op".into(), json!("device"));
                fields.insert("args".into(), json!({"device":device,"op":op,"args":args}));
                return;
            }
            for (key, child) in fields {
                if !matches!(
                    key.as_str(),
                    "input" | "output" | "arguments" | "params" | "peerOrigin"
                ) {
                    qualify_actions(child, device);
                }
            }
        }
        _ => (),
    }
}
