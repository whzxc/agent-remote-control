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
    pending: std::sync::Mutex<std::collections::BTreeMap<String, tokio::sync::watch::Sender<bool>>>,
    service: std::sync::Mutex<std::sync::Weak<Service>>,
}
impl InProcess {
    pub(crate) fn new() -> Self {
        Self {
            generation: Generation(*uuid::Uuid::new_v4().as_bytes()),
            readiness: AtomicU8::new(0),
            admission: Default::default(),
            slots: Arc::new(tokio::sync::Semaphore::new(MAX_IN_FLIGHT)),
            pending: Default::default(),
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
                1 => Readiness::Draining,
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
        drop(_admission);
        let (_pending, mut cancelled) = self.register(&request)?;
        let body = tokio::select! {
            biased;
            _ = cancelled.changed() => return Err("FRONT_DOOR_CANCELLED: Request cancelled; Agent execution is unchanged.".into()),
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
    ) -> Result<(Pending, tokio::sync::watch::Receiver<bool>)> {
        let mut pending = self.pending.lock().unwrap();
        if pending.contains_key(&request.id.0) {
            return Err("FRONT_DOOR_DUPLICATE_REQUEST".into());
        }
        let (tx, rx) = tokio::sync::watch::channel(false);
        pending.insert(request.id.0.clone(), tx);
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
        if let Some(tx) = self.pending.lock().unwrap().get(&cancellation.request_id.0) {
            let _ = tx.send(true);
        }
        Ok(())
    }
    pub(crate) fn begin_drain(&self) {
        let _admission = self.admission.lock().unwrap();
        self.readiness.store(1, Ordering::SeqCst);
    }
    #[allow(dead_code)] // The process-swap owner will consume the bounded drain operation.
    pub(crate) async fn drain(&self, deadline: Deadline) -> Result<DrainAck> {
        self.begin_drain();
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
        let rpc_id = body.get("id").cloned();
        let result = async {
            let context = process::call(
                management_context(),
                Operation::IngressContext {
                    ingress_id: s.id.clone(),
                },
                json!({"principal":principal,"header":header}),
            )
            .await?;
            let context: AuthenticatedContext =
                serde_json::from_value(context).map_err(|e| e.to_string())?;
            process::call(context, Operation::Mcp, body).await
        }
        .await;
        return match result {
            Err(error)
                if error.starts_with("FRONT_DOOR_")
                    || serde_json::from_str::<Value>(&error)
                        .is_ok_and(|v| v["data"]["state"] == "unconfirmed") =>
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
            return self
                .oauth
                .lock()
                .await
                .authenticate(header, resource.as_str())
                .await;
        }
        let allowed = meta["auth"] == "none"
            || meta["auth"] == "bearer"
                && !string(&meta, "bearerToken").is_empty()
                && hash(header) == hash(format!("Bearer {}", string(&meta, "bearerToken")));
        (allowed && !crate::front_door::authority::ingress_retired(&self.id))
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
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "FRONT_DOOR_BUSY")?;
        drop(_admission);
        let (pending, mut cancelled) = self.register(&request)?;
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        let endpoint = self.clone();
        tokio::spawn(async move {
            let (_permit, _pending) = (permit, pending);
            tokio::select! {
                _ = cancelled.changed() => {},
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
        // Contract: private version 1 refuses incompatible attachment and acknowledges drain only after admitted work releases.
        let endpoint = Arc::new(InProcess::new());
        assert_eq!(endpoint.hello(VERSION).unwrap().readiness, Readiness::Ready);
        assert!(endpoint
            .hello(VERSION + 1)
            .unwrap_err()
            .starts_with("FRONT_DOOR_PROTOCOL_MISMATCH:"));
        let request = request(&endpoint);
        let permit = endpoint.slots.clone().try_acquire_owned().unwrap();
        let (pending, mut cancellation) = endpoint.register(&request).unwrap();
        endpoint
            .cancel(&Cancellation {
                generation: request.generation,
                request_id: request.id.clone(),
            })
            .unwrap();
        cancellation.changed().await.unwrap();
        assert!(*cancellation.borrow());
        assert!(endpoint
            .drain(Deadline::after(Duration::ZERO))
            .await
            .unwrap_err()
            .starts_with("FRONT_DOOR_DRAIN_DEADLINE:"));
        assert_eq!(
            endpoint.hello(VERSION).unwrap().readiness,
            Readiness::Draining
        );
        drop((permit, pending));
        let ack = endpoint
            .drain(Deadline::after(Duration::from_secs(1)))
            .await
            .unwrap();
        assert_eq!(ack.generation, request.generation);
        assert_eq!(ack.outstanding, 0);
    }
}
