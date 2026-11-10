//! Transport/auth adapters and the in-process implementation of the private Core protocol.
pub(crate) mod authority;
pub(crate) mod owner;
pub mod process;
mod protocol;
use crate::{ingress::Ingress, service::Service, *};
pub(crate) use protocol::*;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

pub(crate) enum Target<'a> {
    Service(
        &'a Arc<Service>,
        Option<&'a Arc<dyn crate::transport::DesktopAccess>>,
    ),
    Ingress(&'a Arc<Ingress>),
}

pub(crate) struct InProcess {
    generation: Generation,
    readiness: AtomicU8,
    admission: std::sync::Mutex<()>,
    slots: Arc<tokio::sync::Semaphore>,
    stream_slots: Arc<tokio::sync::Semaphore>,
    pending: std::sync::Mutex<std::collections::BTreeMap<String, AdmittedRequest>>,
    #[cfg(target_os = "macos")]
    pending_changed: tokio::sync::Notify,
    service: std::sync::Mutex<std::sync::Weak<Service>>,
}
impl InProcess {
    pub(crate) fn new() -> Self {
        Self {
            generation: Generation(*uuid::Uuid::new_v4().as_bytes()),
            readiness: AtomicU8::new(0),
            admission: Default::default(),
            slots: Arc::new(tokio::sync::Semaphore::new(MAX_IN_FLIGHT)),
            stream_slots: Arc::new(tokio::sync::Semaphore::new(MAX_IN_FLIGHT)),
            pending: Default::default(),
            #[cfg(target_os = "macos")]
            pending_changed: Default::default(),
            service: Default::default(),
        }
    }
    pub(crate) fn bind(&self, service: &Arc<Service>) {
        *self.service.lock().unwrap() = Arc::downgrade(service);
    }
    fn service(&self) -> Result<Arc<Service>> {
        self.service
            .lock()
            .unwrap()
            .upgrade()
            .ok_or("FRONT_DOOR_CORE_UNAVAILABLE".into())
    }
    fn generation(&self) -> Generation {
        self.generation
    }
    pub(crate) fn hello(&self, version: u16) -> Result<Hello> {
        if version != VERSION {
            return Err(
                "FRONT_DOOR_PROTOCOL_MISMATCH: Use matching front-door and Core protocol versions."
                    .into(),
            );
        }
        Ok(Hello {
            version: VERSION,
            generation: self.generation(),
            readiness: match self.readiness.load(Ordering::SeqCst) {
                0 => Readiness::Ready,
                1 | 3 => Readiness::Draining,
                _ => Readiness::Unavailable,
            },
            max_request_bytes: MAX_REQUEST_BYTES,
            max_frame_bytes: MAX_FRAME_BYTES,
        })
    }
    fn request(
        &self,
        context: AuthenticatedContext,
        operation: Operation,
        body: Value,
        deadline: Deadline,
    ) -> Result<Request> {
        let hello = self.hello(VERSION)?;
        Ok(Request {
            version: hello.version,
            generation: hello.generation,
            id: RequestId(id()),
            context,
            operation,
            body,
            deadline,
        })
    }
    async fn send(self: &Arc<Self>, request: Request, target: Target<'_>) -> Result<Value> {
        let hello = self.hello(request.version)?;
        fence(hello.generation, request.generation)?;
        if hello.readiness != Readiness::Ready {
            return Err("FRONT_DOOR_CORE_DRAINING: Read current state after Core is ready.".into());
        }
        request.validate()?;
        let _admission = self.admission.lock().unwrap();
        if self.hello(VERSION)?.readiness != Readiness::Ready {
            return Err("FRONT_DOOR_CORE_DRAINING: Read current state after Core is ready.".into());
        }
        let _permit = self
            .slots
            .try_acquire()
            .map_err(|_| "FRONT_DOOR_BUSY: Wait for an admitted request to finish.")?;
        let (_pending, mut cancelled) = self.register(&request)?;
        drop(_admission);
        #[cfg(feature = "test-fixture")]
        if std::env::var("ARC_FIXTURE_ADMITTED_RPC_ID").ok().as_deref()
            == Some(&request.body["id"].to_string())
        {
            if let Some(path) = std::env::var_os("ARC_FIXTURE_ADMITTED_GATE") {
                save(&PathBuf::from(path), &json!({"admitted":true}))?;
            }
        }
        let body = tokio::select! {
            biased;
            _ = cancelled.changed() => return Err(cancelled.borrow().unwrap_or(Interruption::Cancelled).error(&request)),
            result = tokio::time::timeout(request.deadline.remaining()?, crate::core_requests::handle(target, &request)) =>
                result.map_err(|_| "FRONT_DOOR_DEADLINE_EXPIRED: Read current state before retrying a write.".to_owned())?,
        };
        let frame = ResponseFrame {
            generation: request.generation,
            request_id: request.id.clone(),
            body,
        };
        self.deliver(&request, frame)
    }
    fn deliver(&self, request: &Request, frame: ResponseFrame) -> Result<Value> {
        fence(self.generation(), frame.generation)?;
        fence(request.generation, frame.generation)?;
        if request.id.0 != frame.request_id.0 {
            return Err("FRONT_DOOR_REQUEST_MISMATCH".into());
        }
        request.deadline.remaining()?;
        request.context.validate()?;
        bounded(&frame, MAX_FRAME_BYTES)?;
        frame.body
    }
    fn register(
        self: &Arc<Self>,
        request: &Request,
    ) -> Result<(Pending, tokio::sync::watch::Receiver<Option<Interruption>>)> {
        let mut pending = self.pending.lock().unwrap();
        if pending.contains_key(&request.id.0) {
            return Err("FRONT_DOOR_DUPLICATE_REQUEST".into());
        }
        let (tx, rx) = tokio::sync::watch::channel(None);
        pending.insert(
            request.id.0.clone(),
            AdmittedRequest {
                interruption: tx,
                #[cfg(target_os = "macos")]
                write: process::is_write(request),
            },
        );
        Ok((
            Pending {
                endpoint: self.clone(),
                cancellation: Cancellation {
                    generation: request.generation,
                    request_id: request.id.clone(),
                },
            },
            rx,
        ))
    }
    // Cancellation releases only an admitted request future, never an Agent turn.
    pub(crate) fn cancel(&self, cancellation: &Cancellation) -> Result<()> {
        fence(self.generation(), cancellation.generation)?;
        if let Some(request) = self.pending.lock().unwrap().get(&cancellation.request_id.0) {
            let _ = request.interruption.send(Some(Interruption::Cancelled));
        }
        Ok(())
    }
    pub(crate) fn begin_drain(&self) {
        let _admission = self.admission.lock().unwrap();
        self.readiness.store(1, Ordering::SeqCst);
    }
    pub(crate) async fn drain(&self, deadline: Deadline) -> Result<DrainAck> {
        self.begin_drain();
        self.wait_drained(deadline).await
    }
    async fn wait_drained(&self, deadline: Deadline) -> Result<DrainAck> {
        let remaining = deadline.remaining().map_err(|_| {
            "FRONT_DOOR_DRAIN_DEADLINE: Admitted requests remain; read their original receipts."
                .to_owned()
        })?;
        let permits = tokio::time::timeout(
            remaining,
            self.slots.acquire_many(MAX_IN_FLIGHT as u32),
        )
        .await
        .map_err(|_| {
            "FRONT_DOOR_DRAIN_DEADLINE: Admitted requests remain; read their original receipts."
                .to_owned()
        })?
        .map_err(|e| e.to_string())?;
        let ack = DrainAck {
            generation: self.generation(),
            outstanding: 0,
        };
        drop(permits);
        Ok(ack)
    }
    #[cfg(target_os = "macos")]
    pub(crate) fn maintenance(&self) -> Result<Maintenance<'_>> {
        let _admission = self.admission.lock().unwrap();
        self.readiness
            .compare_exchange(0, 3, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "FRONT_DOOR_CORE_DRAINING: Core is shutting down.".to_owned())?;
        let mut ended_reads = 0;
        for request in self.pending.lock().unwrap().values() {
            let active = request.interruption.borrow().is_none();
            if !request.write
                && active
                && request
                    .interruption
                    .send(Some(Interruption::Maintenance))
                    .is_ok()
            {
                ended_reads += 1;
            }
        }
        Ok(Maintenance {
            endpoint: self,
            ended_reads,
        })
    }
    pub(crate) fn stream_frame(
        &self,
        request: &Request,
        sequence: u64,
        body: Value,
    ) -> Result<StreamFrame> {
        let frame = StreamFrame {
            generation: request.generation,
            request_id: request.id.clone(),
            sequence,
            body,
        };
        fence(self.generation(), frame.generation)?;
        request.deadline.remaining()?;
        request.context.validate()?;
        bounded(&frame, MAX_FRAME_BYTES)?;
        Ok(frame)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Interruption {
    Cancelled,
    #[cfg(target_os = "macos")]
    Maintenance,
}
impl Interruption {
    fn error(self, request: &Request) -> String {
        #[cfg(not(target_os = "macos"))]
        let _ = request;
        match self {
            Self::Cancelled => "FRONT_DOOR_CANCELLED: Request cancelled; Agent execution is unchanged.".into(),
            #[cfg(target_os = "macos")]
            Self::Maintenance => json!({"code":-32603,
                "message":"FRONT_DOOR_CORE_DRAINING: Front-door maintenance ended this read. Issue a new authorized read after Core is ready.",
                "data":{"requestId":request.id.0,"next":{"via":"query","op":"guide","args":{"topic":"loop"}}}}).to_string(),
        }
    }
}
struct AdmittedRequest {
    interruption: tokio::sync::watch::Sender<Option<Interruption>>,
    #[cfg(target_os = "macos")]
    write: bool,
}
#[cfg(target_os = "macos")]
pub(crate) struct Maintenance<'a> {
    endpoint: &'a InProcess,
    pub(crate) ended_reads: usize,
}
#[cfg(target_os = "macos")]
impl Maintenance<'_> {
    pub(crate) fn outstanding_writes(&self) -> usize {
        self.endpoint
            .pending
            .lock()
            .unwrap()
            .values()
            .filter(|request| request.write)
            .count()
    }
    pub(crate) async fn drain(&self) -> Result<DrainAck> {
        let deadline = Deadline::after(DRAIN_TIMEOUT);
        let expired = || {
            "FRONT_DOOR_DRAIN_DEADLINE: Admitted writes remain; read their original receipts."
                .to_owned()
        };
        loop {
            let changed = self.endpoint.pending_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.outstanding_writes() == 0 {
                return Ok(DrainAck {
                    generation: self.endpoint.generation(),
                    outstanding: 0,
                });
            }
            let remaining = deadline.remaining().map_err(|_| expired())?;
            // Recheck the write count at the deadline before reporting a timeout.
            let _ = tokio::time::timeout(remaining, changed).await;
        }
    }
}
#[cfg(target_os = "macos")]
impl Drop for Maintenance<'_> {
    fn drop(&mut self) {
        // Shutdown can supersede maintenance and must never be resumed by it.
        let _admission = self.endpoint.admission.lock().unwrap();
        let _ = self
            .endpoint
            .readiness
            .compare_exchange(3, 0, Ordering::SeqCst, Ordering::SeqCst);
    }
}
struct Pending {
    endpoint: Arc<InProcess>,
    cancellation: Cancellation,
}
impl Drop for Pending {
    fn drop(&mut self) {
        let _ = self.endpoint.cancel(&self.cancellation);
        self.endpoint
            .pending
            .lock()
            .unwrap()
            .remove(&self.cancellation.request_id.0);
        #[cfg(target_os = "macos")]
        self.endpoint.pending_changed.notify_waiters();
    }
}
fn deadline() -> Deadline {
    Deadline::after(Duration::from_secs(1830))
}
pub(crate) fn management_context() -> AuthenticatedContext {
    AuthenticatedContext {
        authority: protocol::Authority::Management,
    }
}

pub async fn mcp(s: &Arc<Service>, request: Value) -> Result<Value> {
    mcp_ingress(&s.primary().await?, request).await
}
pub async fn mcp_ingress(s: &Arc<Ingress>, request: Value) -> Result<Value> {
    let principal = json!({"type":"ingress","ingressId":s.id});
    mcp_ingress_authenticated(s, request, &principal, None).await
}
pub(crate) async fn mcp_ingress_authenticated(
    s: &Arc<Ingress>,
    body: Value,
    principal: &Value,
    header: Option<&str>,
) -> Result<Value> {
    let (local, enabled) = {
        let meta = s.meta.lock().await;
        (meta["transport"] == "local", meta["enabled"] == true)
    };
    if local && (!s.connected.load(Ordering::SeqCst) || !enabled) {
        return Err("Local connection disabled".into());
    }
    if s.execution.is_none() {
        // Cancel the exact front-door wait future. Its private socket is tied to
        // the admitted generation; cancellation is never queued for a newer Core.
        if body["method"] == "notifications/cancelled" {
            s.wait_calls
                .cancel(&body["params"]["requestId"].to_string());
            return Ok(Value::Null);
        }
        let rpc_id = body.get("id").cloned();
        let registration = if crate::transport::is_wait(&body) {
            Some(s.wait_calls.register(body["id"].to_string())?)
        } else {
            None
        };
        let call = process::call(
            AuthenticatedContext {
                authority: protocol::Authority::Ingress {
                    ingress_id: s.id.clone(),
                    principal: principal.clone(),
                    header: header.map(str::to_owned),
                },
            },
            Operation::Mcp,
            body,
        );
        let result = if let Some((_guard, mut cancelled)) = registration {
            tokio::select! {
                biased;
                _ = cancelled.changed() => Err("FRONT_DOOR_CANCELLED: Request cancelled; Agent execution is unchanged.".into()),
                result = call => result,
            }
        } else {
            call.await
        };
        return match result {
            Err(error)
                if error.starts_with("FRONT_DOOR_")
                    || serde_json::from_str::<Value>(&error).is_ok_and(|v| v["code"] == -32603) =>
            {
                let error=serde_json::from_str::<Value>(&error).unwrap_or_else(|_|json!({"code":-32603,"message":error,"data":{"arcVersion":crate::egress::arc_version()}}));
                Ok(rpc_id.map_or(
                    Value::Null,
                    |id| json!({"jsonrpc":"2.0","id":id,"error":error}),
                ))
            }
            result => result,
        };
    }
    let context = authenticated_context(s, principal, header).await?;
    let endpoint = &s.execution.as_ref().unwrap().front_door;
    let request = endpoint.request(context, Operation::Mcp, body, deadline())?;
    endpoint.send(request, Target::Ingress(s)).await
}
pub(crate) async fn browser_request(
    ingress: &Arc<Ingress>,
    key: &str,
    route: &str,
    method: &str,
    body: Value,
) -> Result<Value> {
    if ingress.execution.is_none() {
        return process::call(
            AuthenticatedContext {
                authority: protocol::Authority::Browser {
                    ingress_id: ingress.id.clone(),
                    key_digest: hash(key),
                },
            },
            Operation::Management {
                route: route.into(),
                method: method.into(),
            },
            body,
        )
        .await;
    }
    let endpoint = &ingress.execution.as_ref().unwrap().front_door;
    let service = endpoint.service()?;
    let context = AuthenticatedContext {
        authority: protocol::Authority::Browser {
            ingress_id: ingress.id.clone(),
            key_digest: hash(key),
        },
    };
    let request = endpoint.request(
        context,
        Operation::Management {
            route: route.into(),
            method: method.into(),
        },
        body,
        Deadline::after(Duration::from_secs(30)),
    )?;
    endpoint
        .send(request, Target::Service(&service, None))
        .await
}

pub(crate) async fn authenticated_context(
    s: &Ingress,
    principal: &Value,
    header: Option<&str>,
) -> Result<AuthenticatedContext> {
    let meta = s.meta.lock().await;
    let source = if principal["type"] == "oauth-grant" {
        crate::sources::for_grant(&s.id, string(principal, "grantId"))?
    } else {
        if meta["auth"] == "oauth" {
            return Err("OAuth principal required".into());
        }
        crate::sources::connect_ingress(&meta).await?
    };
    let mut origin = crate::sources::touch(&source, string(&meta, "auth")).await?;
    drop(meta);
    if principal["type"] == "oauth-grant" {
        origin["eventPrincipal"] = principal["grantId"].clone();
    } else if let Ok(principal) = crate::claude_notify::mcp_events::principal(s, header).await {
        origin["eventPrincipal"] = json!(principal);
    }
    Ok(AuthenticatedContext {
        authority: protocol::Authority::Mcp {
            ingress_id: s.id.clone(),
            source_id: string(&source, "id").into(),
            credential: source["credential"].clone(),
            origin,
        },
    })
}

impl Ingress {
    pub async fn authenticate(&self, header: &str) -> Option<Value> {
        let meta = self.meta.lock().await;
        if meta["auth"] == "oauth" {
            drop(meta);
            let resource = self.mcp_url.lock().await.clone();
            let resource = reqwest::Url::parse(&resource).ok()?;
            let mut oauth = self.oauth.lock().await;
            return if self.execution.is_none() {
                oauth.authenticate_transport(header, resource.as_str())
            } else {
                oauth.authenticate(header, resource.as_str()).await
            };
        }
        let allowed = meta["auth"] == "none"
            || meta["auth"] == "bearer"
                && !string(&meta, "bearerToken").is_empty()
                && hash(header) == hash(format!("Bearer {}", string(&meta, "bearerToken")));
        // The detached transport owns ingress credentials. Current source authority
        // is resolved by Core at business admission, after bounded swap-time waiting.
        (allowed
            && !self.retired.load(Ordering::SeqCst)
            && (self.execution.is_none()
                || !crate::front_door::authority::ingress_retired(&self.id)))
        .then(|| json!({"type":"ingress","ingressId":self.id}))
    }
}

impl InProcess {
    async fn open_stream(
        self: &Arc<Self>,
        request: Request,
        service: Arc<Service>,
    ) -> Result<tokio::sync::mpsc::Receiver<Result<StreamFrame>>> {
        let hello = self.hello(request.version)?;
        fence(hello.generation, request.generation)?;
        if hello.readiness != Readiness::Ready {
            return Err("FRONT_DOOR_CORE_DRAINING".into());
        }
        request.validate()?;
        let _admission = self.admission.lock().unwrap();
        if self.hello(VERSION)?.readiness != Readiness::Ready {
            return Err("FRONT_DOOR_CORE_DRAINING".into());
        }
        let permit = self
            .stream_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "FRONT_DOOR_BUSY")?;
        let (pending, mut cancelled) = self.register(&request)?;
        drop(_admission);
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        let endpoint = self.clone();
        tokio::spawn(async move {
            let (_permit, _pending) = (permit, pending);
            tokio::select! {
                _ = cancelled.changed() => {
                    #[cfg(target_os = "macos")]
                    if *cancelled.borrow() == Some(Interruption::Maintenance) {
                        let _ = tokio::time::timeout(Duration::from_secs(2), tx.send(Err(Interruption::Maintenance.error(&request)))).await;
                    }
                },
                _ = crate::core_requests::stream(&service, &request, &endpoint, &tx) => {},
            }
        });
        Ok(rx)
    }
}

async fn stream_bytes(
    endpoint: Arc<InProcess>,
    request: Request,
    service: Arc<Service>,
    ingress: Option<Arc<Ingress>>,
) -> Result<tokio::sync::mpsc::Receiver<hyper::body::Bytes>> {
    let mut frames = endpoint.open_stream(request.clone(), service).await?;
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    tokio::spawn(async move {
        let mut authority = tokio::time::interval(Duration::from_secs(2));
        let mut sequence = 0;
        loop {
            let frame = tokio::select! {
                _ = tx.closed() => return,
                _ = authority.tick() => {
                    let authorized = if ingress.is_some() {
                        crate::runtime_metrics::cost::sync(crate::runtime_metrics::cost::Owner::BrowserGuard, crate::runtime_metrics::cost::Reason::Timer, || {
                            crate::runtime_metrics::cost::scan_set(1);
                            crate::runtime_metrics::cost::rows(1);
                            request.context.validate()
                        })
                    } else { request.context.validate() };
                    if authorized.is_err() || fence(endpoint.generation(), request.generation).is_err()
                        || ingress.as_ref().is_some_and(|i| !i.connected.load(Ordering::SeqCst)) { return; }
                    continue;
                }
                frame = frames.recv() => match frame { Some(frame) => frame, None => return },
            };
            let body = match frame.and_then(|frame| {
                fence(endpoint.generation(), frame.generation)?;
                request.deadline.remaining()?;
                request.context.validate()?;
                if frame.request_id.0 != request.id.0 || frame.sequence != sequence {
                    return Err("FRONT_DOOR_REQUEST_MISMATCH".into());
                }
                bounded(&frame, MAX_FRAME_BYTES)?;
                Ok(frame.body)
            }) {
                Ok(body) => body,
                Err(error) => {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(2),
                        tx.send(hyper::body::Bytes::from(format!(
                            "event: error\ndata: {}\n\n",
                            json!({"error":error})
                        ))),
                    )
                    .await;
                    return;
                }
            };
            sequence += 1;
            let bytes = if body.is_null() {
                ": keepalive\n\n".to_owned()
            } else {
                format!("event: snapshot\ndata: {body}\n\n")
            };
            if !matches!(
                tokio::time::timeout(
                    Duration::from_secs(2),
                    tx.send(hyper::body::Bytes::from(bytes))
                )
                .await,
                Ok(Ok(()))
            ) {
                return;
            }
        }
    });
    Ok(rx)
}
pub(crate) async fn browser_stream(
    ingress: &Arc<Ingress>,
    key: &str,
    kind: Snapshot,
) -> Result<tokio::sync::mpsc::Receiver<hyper::body::Bytes>> {
    if ingress.execution.is_none() {
        return process::stream(
            AuthenticatedContext {
                authority: protocol::Authority::Browser {
                    ingress_id: ingress.id.clone(),
                    key_digest: hash(key),
                },
            },
            kind,
        )
        .await;
    }
    let endpoint = ingress.execution.as_ref().unwrap().front_door.clone();
    let service = endpoint.service()?;
    let context = AuthenticatedContext {
        authority: protocol::Authority::Browser {
            ingress_id: ingress.id.clone(),
            key_digest: hash(key),
        },
    };
    let request = endpoint.request(context, Operation::Snapshot { kind }, json!({}), deadline())?;
    stream_bytes(endpoint, request, service, Some(ingress.clone())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(endpoint: &InProcess) -> Request {
        endpoint
            .request(
                management_context(),
                Operation::Health,
                json!({}),
                deadline(),
            )
            .unwrap()
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn maintenance_resumes_admissions_unless_shutdown_supersedes_it() {
        // Regression: front-door maintenance must release queued admissions without reopening a shutting-down Core.
        let endpoint = InProcess::new();
        let maintenance = endpoint.maintenance().unwrap();
        assert_eq!(
            endpoint.hello(VERSION).unwrap().readiness,
            Readiness::Draining
        );
        assert_eq!(maintenance.drain().await.unwrap().outstanding, 0);
        drop(maintenance);
        assert_eq!(endpoint.hello(VERSION).unwrap().readiness, Readiness::Ready);
        let maintenance = endpoint.maintenance().unwrap();
        endpoint.begin_drain();
        drop(maintenance);
        assert_eq!(
            endpoint.hello(VERSION).unwrap().readiness,
            Readiness::Draining
        );
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn maintenance_ends_reads_and_only_writes_can_expire_the_drain() {
        // Regression: cf9cf2e included long reads in the maintenance drain and prevented compatible image updates.
        let endpoint = Arc::new(InProcess::new());
        let read = request(&endpoint);
        let (reading, mut interrupted) = endpoint.register(&read).unwrap();
        let mut snapshot = request(&endpoint);
        snapshot.operation = Operation::Snapshot {
            kind: Snapshot::Subscriptions,
        };
        let (streaming, mut ended_stream) = endpoint.register(&snapshot).unwrap();
        let mut write = request(&endpoint);
        write.operation = Operation::Mcp;
        write.body =
            json!({"method":"tools/call","params":{"name":"act","arguments":{"op":"ax_report"}}});
        let (writing, write_interruption) = endpoint.register(&write).unwrap();
        let maintenance = endpoint.maintenance().unwrap();
        assert_eq!(maintenance.ended_reads, 2);
        assert_eq!(maintenance.outstanding_writes(), 1);
        interrupted.changed().await.unwrap();
        ended_stream.changed().await.unwrap();
        let error: Value =
            serde_json::from_str(&interrupted.borrow().unwrap().error(&read)).unwrap();
        assert_eq!(error["data"]["requestId"], read.id.0);
        assert_eq!(error["data"]["next"]["op"], "guide");
        assert_eq!(*ended_stream.borrow(), Some(Interruption::Maintenance));
        assert!(!write_interruption.has_changed().unwrap());
        {
            let drain = maintenance.drain();
            tokio::pin!(drain);
            assert!(tokio::time::timeout(Duration::from_millis(10), &mut drain)
                .await
                .is_err());
            drop(writing);
            assert_eq!(drain.await.unwrap().outstanding, 0);
        }
        // Read cancellation delivery can still be in progress without gating writes.
        assert_eq!(maintenance.outstanding_writes(), 0);
        drop(maintenance);
        let (writing, _) = endpoint.register(&write).unwrap();
        let maintenance = endpoint.maintenance().unwrap();
        assert!(maintenance
            .drain()
            .await
            .unwrap_err()
            .starts_with("FRONT_DOOR_DRAIN_DEADLINE:"));
        assert_eq!(maintenance.outstanding_writes(), 1);
        drop((writing, reading, streaming));
    }
    #[test]
    fn generations_fence_responses_from_other_core_incarnations() {
        // Property: only responses tagged with the current Core generation pass the fence.
        let first = InProcess::new();
        let second = InProcess::new();
        assert!(fence(first.generation(), first.generation()).is_ok());
        assert!(fence(second.generation(), first.generation())
            .unwrap_err()
            .starts_with("FRONT_DOOR_STALE_GENERATION:"));
    }
    #[test]
    fn framing_bounds_count_encoded_bytes_including_escapes() {
        // Property: the frame bound includes JSON escaping and multibyte UTF-8.
        for body in [json!("abc"), json!("\n\"\\"), json!("\u{1f680}")] {
            let size = serde_json::to_vec(&body).unwrap().len();
            assert!(bounded(&body, size).is_ok());
            assert!(bounded(&body, size - 1)
                .unwrap_err()
                .starts_with("FRONT_DOOR_FRAME_TOO_LARGE:"));
        }
    }
    #[test]
    fn protocol_refuses_stale_expired_and_oversized_deliveries() {
        // Contract: private response delivery fails explicitly for stale generations, frame bounds and deadlines.
        let endpoint = InProcess::new();
        let mut request = request(&endpoint);
        let frame = |generation, body| ResponseFrame {
            generation,
            request_id: request.id.clone(),
            body: Ok(body),
        };
        assert_eq!(
            endpoint
                .deliver(&request, frame(request.generation, json!({"ok":true})))
                .unwrap(),
            json!({"ok":true})
        );
        assert!(endpoint
            .deliver(
                &request,
                frame(InProcess::new().generation(), json!({"ok":true}))
            )
            .unwrap_err()
            .starts_with("FRONT_DOOR_STALE_GENERATION:"));
        assert!(endpoint
            .deliver(
                &request,
                frame(request.generation, json!("x".repeat(MAX_FRAME_BYTES)))
            )
            .unwrap_err()
            .starts_with("FRONT_DOOR_FRAME_TOO_LARGE:"));
        request.body = json!("x".repeat(MAX_REQUEST_BYTES));
        assert!(request
            .validate()
            .unwrap_err()
            .starts_with("FRONT_DOOR_FRAME_TOO_LARGE:"));
        request.body = json!({});
        request.deadline = Deadline::after(Duration::ZERO);
        assert!(request
            .validate()
            .unwrap_err()
            .starts_with("FRONT_DOOR_DEADLINE_EXPIRED:"));
        let frame = ResponseFrame {
            generation: request.generation,
            request_id: request.id.clone(),
            body: Ok(json!({"ok":true})),
        };
        assert!(endpoint
            .deliver(&request, frame)
            .unwrap_err()
            .starts_with("FRONT_DOOR_DEADLINE_EXPIRED:"));
    }
    #[tokio::test]
    async fn protocol_handshake_cancellation_and_drain_acknowledgement() {
        // Contract: private protocol refuses incompatible attachment and acknowledges drain only after admitted work releases.
        let endpoint = Arc::new(InProcess::new());
        assert_eq!(endpoint.hello(VERSION).unwrap().readiness, Readiness::Ready);
        assert!(endpoint
            .hello(VERSION + 1)
            .unwrap_err()
            .starts_with("FRONT_DOOR_PROTOCOL_MISMATCH:"));
        let request = request(&endpoint);
        let permit = endpoint.slots.clone().try_acquire_owned().unwrap();
        let (pending, mut cancellation) = endpoint.register(&request).unwrap();
        assert!(endpoint
            .cancel(&Cancellation {
                generation: InProcess::new().generation(),
                request_id: request.id.clone(),
            })
            .is_err());
        assert!(cancellation.borrow().is_none());
        endpoint
            .cancel(&Cancellation {
                generation: request.generation,
                request_id: request.id.clone(),
            })
            .unwrap();
        cancellation.changed().await.unwrap();
        assert_eq!(*cancellation.borrow(), Some(Interruption::Cancelled));
        assert!(endpoint
            .drain(Deadline::after(Duration::ZERO))
            .await
            .unwrap_err()
            .starts_with("FRONT_DOOR_DRAIN_DEADLINE:"));
        assert_eq!(
            endpoint.hello(VERSION).unwrap().readiness,
            Readiness::Draining
        );
        assert!(tokio::time::timeout(
            Duration::from_millis(10),
            endpoint.drain(Deadline::after(Duration::from_secs(1))),
        )
        .await
        .is_err());
        drop((permit, pending));
        let ack = endpoint
            .drain(Deadline::after(Duration::from_secs(1)))
            .await
            .unwrap();
        assert_eq!(ack.generation, request.generation);
        assert_eq!(ack.outstanding, 0);
    }
}
