//! Path choice is captured before submission. Sending never retries or changes paths.
use super::*;

pub(super) enum Prepared {
    Lan(hyper::client::conn::http2::SendRequest<http_body_util::Full<hyper::body::Bytes>>),
    Tunnel {
        url: String,
        token: String,
        closed: tokio::sync::watch::Receiver<u64>,
    },
}
impl Prepared {
    pub(super) fn validate(&self, wire: &Value) -> Result<()> {
        if matches!(self, Self::Tunnel { .. })
            && wire.to_string().len() > super::super::tunnel::REQUEST_CAP
        {
            return Err(error(
                "DEVICE_TUNNEL_LIMIT",
                "Peer request exceeds 1 MiB; use LAN.",
            ));
        }
        Ok(())
    }

    pub(super) async fn send(self, mut wire: Value, deadline: Duration) -> Result<Value> {
        match self {
            Self::Lan(sender) => Channel::send(sender, "/arc-peer/3/request", wire, deadline).await,
            Self::Tunnel {
                url,
                token,
                mut closed,
            } => {
                super::super::tunnel::segment(&mut wire["body"]);
                tokio::select! {
                    biased;
                    _=closed.changed()=>Err(error("DEVICE_UNPAIRED","Local pairing was revoked or disabled; query guide for device.")),
                    result=super::super::tunnel::post(&url,"request",Some(&token),wire,deadline)=>result,
                }
            }
        }
    }
}
impl Controller {
    pub(super) async fn heartbeat(&self, member: &Member, misses: &mut u8) {
        let start = Instant::now();
        let result = self.probe(member).await;
        match result {
            Ok((mut hello, path)) => {
                if path == "tunnel" {
                    hello["tunnelUrl"] = member
                        .status
                        .lock()
                        .unwrap()
                        .hello
                        .get("tunnelUrl")
                        .cloned()
                        .unwrap_or_else(|| json!(member.peer.tunnel_url));
                }
                *misses = 0;
                let seen = now();
                *member.status.lock().unwrap() = Status {
                    online: true,
                    path: path.into(),
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
                *misses = misses.saturating_add(1);
                let mut status = member.status.lock().unwrap();
                if *misses >= 3
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
    fn identity(&self) -> Result<Arc<Identity>> {
        self.identity
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(unavailable)
    }
    async fn tunnel_url(&self, member: &Member) -> Result<String> {
        let status = member.status.lock().unwrap();
        let url = if status.hello.get("tunnelUrl").is_some() {
            status.hello["tunnelUrl"].as_str()
        } else {
            member.peer.tunnel_url.as_deref()
        };
        url.and_then(super::super::tunnel::peer_url).ok_or_else(|| {
            error(
                "DEVICE_TUNNEL_UNAVAILABLE",
                "No public HTTPS peer URL was learned; restore LAN once and query devices.",
            )
        })
    }
    async fn tunnel_session(&self, member: &Member) -> Result<(String, String)> {
        let url = self.tunnel_url(member).await?;
        member
            .tunnel
            .prepare(self.identity()?.as_ref(), &member.peer.device_id, &url)
            .await
    }
    pub(super) async fn prepare(&self, member: &Member) -> Result<Prepared> {
        if !member.status.lock().unwrap().online {
            return Err(offline());
        }
        if member.status.lock().unwrap().path == "tunnel" {
            let closed = member.tunnel.subscribe();
            let (url, token) = self.tunnel_session(member).await?;
            Ok(Prepared::Tunnel { url, token, closed })
        } else {
            let channel = self.channel(member, false).await?;
            Ok(Prepared::Lan(channel.ready().await?))
        }
    }
    /// Shared transport API for bounded member calls, including event long polls.
    /// Each invocation submits once. Callers segment waits and retain receipt ownership.
    #[allow(dead_code)] // Internal integration API for member event polls.
    pub(crate) async fn send(
        &self,
        device: &str,
        tool: &str,
        body: Value,
        deadline: Duration,
    ) -> Result<Value> {
        let member = self.member(device).await?;
        if !member.status.lock().unwrap().online {
            return Err(offline());
        }
        let _slot = member.slots.clone().try_acquire_owned().map_err(|_| {
            error(
                "DEVICE_BUSY",
                "Member request capacity reached; wait for an active request.",
            )
        })?;
        tokio::time::timeout(deadline, async {
            let prepared = self.prepare(&member).await?;
            prepared
                .send(
                    json!({"version":VERSION,"tool":tool,"body":body,"origin":{}}),
                    deadline,
                )
                .await
        })
        .await
        .map_err(|_| {
            error(
                "DEVICE_RESPONSE_LOST",
                "Member deadline expired; retain write receipt IDs and query devices.",
            )
        })?
    }
    fn validate_hello(&self, member: &Member, hello: &Value) -> Result<()> {
        if hello["version"] != VERSION {
            return Err(error(
                "DEVICE_PROTOCOL_MISMATCH",
                "Install peer protocol version 3 on both devices; query guide for device.",
            ));
        }
        if hello["deviceId"] != member.peer.device_id {
            return Err(error(
                "DEVICE_TLS_FAILED",
                "Pinned member identity differs; query guide for device.",
            ));
        }
        Ok(())
    }
    async fn lan_hello(&self, member: &Member) -> Result<Value> {
        let channel = self.channel(member, true).await?;
        let hello = channel
            .request(
                "/arc-peer/3/hello",
                json!({"version":VERSION}),
                Duration::from_secs(1),
            )
            .await?;
        self.validate_hello(member, &hello)?;
        // LAN readiness includes the business channel; tunnel requests need no persistent channel.
        self.channel(member, false).await?.ready().await?;
        Ok(hello)
    }
    pub(super) async fn probe(&self, member: &Member) -> Result<(Value, &'static str)> {
        let lan = tokio::time::timeout(Duration::from_secs(3), async {
            let cached = member.heartbeat.cached().await.is_some();
            let result = self.lan_hello(member).await;
            if cached
                && result
                    .as_ref()
                    .is_err_and(|e| !e.contains("DEVICE_PROTOCOL_MISMATCH"))
            {
                member.heartbeat.close().await;
                if member.slots.available_permits() == 64 {
                    member.business.close().await;
                }
                return self.lan_hello(member).await;
            }
            result
        })
        .await
        .unwrap_or_else(|_| {
            Err(error(
                "DEVICE_LAN_UNAVAILABLE",
                "LAN heartbeat deadline expired; query devices.",
            ))
        });
        match lan {
            Ok(hello) => Ok((hello, "lan")),
            Err(lan_error) => {
                member.heartbeat.close().await;
                if member.slots.available_permits() == 64 {
                    member.business.close().await;
                }
                if self.tunnel_url(member).await.is_err() {
                    return Err(lan_error);
                }
                let tunnel = tokio::time::timeout(Duration::from_secs(4), async {
                    let (url, token) = self.tunnel_session(member).await?;
                    let hello = super::super::tunnel::post(
                        &url,
                        "hello",
                        Some(&token),
                        json!({"version":VERSION}),
                        Duration::from_secs(2),
                    )
                    .await?;
                    self.validate_hello(member, &hello)?;
                    Ok::<_, String>(hello)
                })
                .await
                .unwrap_or_else(|_| {
                    Err(error(
                        "DEVICE_TUNNEL_UNAVAILABLE",
                        "Tunnel heartbeat deadline expired; query devices.",
                    ))
                });
                match tunnel {
                    Ok(hello) => Ok((hello, "tunnel")),
                    Err(tunnel_error) => {
                        member.tunnel.clear().await;
                        // LAN refusal is immediate offline only after HTTPS also fails.
                        if lan_error.starts_with("DEVICE_CONNECTION_REFUSED") {
                            Err(format!("{lan_error}; {tunnel_error}"))
                        } else {
                            Err(error(
                                "DEVICE_TUNNEL_UNAVAILABLE",
                                &format!("{lan_error}; {tunnel_error}"),
                            ))
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_link::tunnel_fixture::Provider;
    async fn lan_listener(
        manager: Arc<Manager>,
        address: SocketAddr,
    ) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind(address).await.unwrap();
        let address = listener.local_addr().unwrap();
        let acceptor = tls::server(&manager, &manager.identity().unwrap()).unwrap();
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=> {
                        let Ok((stream,_))=accepted else {break;};
                        let permit=Arc::new(tokio::sync::Semaphore::new(1)).acquire_owned().await.unwrap();
                        connections.spawn(manager.clone().accept_connection(stream,acceptor.clone(),permit));
                    },
                    Some(_)=connections.join_next(), if !connections.is_empty()=>{},
                }
            }
        });
        (address, task)
    }
    #[tokio::test]
    async fn lan_tunnel_lan_through_http_provider() {
        // Contract: a paired member learns its HTTPS URL on LAN, switches paths on heartbeat, keeps submitted calls on their path, and returns to LAN.
        if crate::device_link::tunnel_fixture::isolate(
            "device_link::controller::path::tests::lan_tunnel_lan_through_http_provider",
        )
        .await
        {
            return;
        }
        crate::init_crypto();
        crate::sources::initialize().unwrap();
        crate::preferences::write(json!({"values":{"device-link":"on"}})).unwrap();
        let service = crate::service::Service::new().unwrap();
        let core = crate::transport::listen(service.clone(), None)
            .await
            .unwrap();
        let manager =
            crate::device_link::tests::Fixture::manager(crate::root().join("device-link"));
        let directory = crate::root().join("controller");
        let controller = Controller::new(directory.clone()).unwrap();
        let identity = Arc::new(Identity::load_or_create(&directory).unwrap());
        *controller.identity.lock().unwrap() = Some(identity.clone());
        let mut provider = Provider::new(&manager).await;
        let offer = manager.request("offer", json!({})).await.unwrap();
        assert_eq!(
            Offer::decode(string(&offer, "pairingString"))
                .unwrap()
                .tunnel_url
                .as_deref(),
            Some(provider.url.as_str())
        );
        crate::device_link::tunnel_tests::paired(&manager, &identity);
        {
            let state = manager.state.lock().unwrap();
            manager.persist(&state).unwrap();
        }
        crate::sources::peer_connect(&identity.id, &identity.public_key, "Example controller")
            .await
            .unwrap();
        // The pinned LAN channel uses the host's private self-route; provider HTTP stays on loopback.
        let (address, lan) = lan_listener(manager.clone(), lan_sockets(0).unwrap()[0]).await;
        {
            let mut state = manager.state.lock().unwrap();
            state.stored.port = address.port();
            manager.persist(&state).unwrap();
        }

        let member = Arc::new(Member {
            peer: Peer {
                device_id: manager.identity().unwrap().id.clone(),
                public_key: manager.identity().unwrap().public_key.clone(),
                name: "Example member".into(),
                addresses: vec![address.to_string()],
                tunnel_url: None,
                address_override: None,
            },
            status: Default::default(),
            business: Session::default(),
            heartbeat: Session::default(),
            tunnel: Default::default(),
            slots: Arc::new(tokio::sync::Semaphore::new(64)),
            task: Default::default(),
            event_task: Default::default(),
        });
        controller
            .members
            .lock()
            .await
            .insert(member.peer.device_id.clone(), member.clone());
        let mut misses = 0;
        controller.heartbeat(&member, &mut misses).await;
        assert_eq!(controller.list(false).await["devices"][0]["path"], "lan");
        let guide = json!({"op":"guide","args":{"view":"full"}});
        assert!(controller
            .send(
                &member.peer.device_id,
                "query",
                guide.clone(),
                Duration::from_secs(5)
            )
            .await
            .is_ok());
        lan.abort();
        let _ = lan.await;
        controller.heartbeat(&member, &mut misses).await;
        assert_eq!(controller.list(false).await["devices"][0]["path"], "tunnel");
        assert!(controller
            .send(
                &member.peer.device_id,
                "query",
                guide.clone(),
                Duration::from_secs(5)
            )
            .await
            .is_ok());
        // Exercise the same adapter and reconciliation owner through authenticated HTTPS.
        let source = crate::sources::peer_authority(&identity.id).unwrap();
        let baseline = controller
            .event_request(
                &member,
                super::super::events::OP,
                json!({"cursor":null}),
                "",
            )
            .await
            .unwrap();
        let polling = controller.clone();
        let polled = member.clone();
        let pending = tokio::spawn(async move {
            polling
                .event_request(
                    &polled,
                    super::super::events::OP,
                    json!({"epoch":baseline["epoch"],"cursor":baseline["cursor"],"waitMs":15000}),
                    "",
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        super::super::events::publish(
            string(&source, "id"),
            json!({"kind":"completed","threadId":"synthetic","turnId":"turn"}),
        );
        let batch = tokio::time::timeout(Duration::from_secs(3), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(batch["events"][0]["event"]["kind"], "completed");
        let task = id();
        let result = json!({"taskId":task,"turnId":"turn"});
        crate::claude_notify::device::bind_forward(
            &member.peer.device_id,
            "Example member",
            "fixture-origin",
            "agent_create",
            &json!({"agent":"pi"}),
            &result,
        )
        .await
        .unwrap();
        controller.records.lock().unwrap().associate(
            &member.peer.device_id,
            "fixture-origin",
            &result,
        );
        controller.reconcile_events(&member).await.unwrap();
        let status = crate::kernel::origin::ORIGIN.scope(json!({"sourceId":"fixture-origin"}),crate::claude_notify::notify_status(&json!({"threadId":crate::claude_notify::device::key(&member.peer.device_id,&task)}))).await.unwrap();
        assert_eq!(
            status["threads"][0]["diagnosis"]["observation"]["state"],
            "unconfirmed"
        );
        let forbidden = controller
            .send(
                &member.peer.device_id,
                "act",
                json!({"op":"device","args":{}}),
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();
        assert!(forbidden.contains("DEVICE_PEER_FORBIDDEN"));
        provider.gate.0.store(true, Ordering::SeqCst);
        provider.lose_response.store(true, Ordering::SeqCst);
        let sending = controller.clone();
        let device = member.peer.device_id.clone();
        let body = guide.clone();
        let sent = tokio::spawn(async move {
            sending
                .send(&device, "query", body, Duration::from_secs(5))
                .await
        });
        tokio::time::timeout(Duration::from_secs(3), provider.gate.1.notified())
            .await
            .unwrap();
        let (_, lan) = lan_listener(manager.clone(), address).await;
        controller.heartbeat(&member, &mut misses).await;
        assert_eq!(controller.list(false).await["devices"][0]["path"], "lan");
        provider.gate.2.notify_one();
        assert!(sent.await.unwrap().is_err());
        assert!(controller
            .send(
                &member.peer.device_id,
                "query",
                guide,
                Duration::from_secs(5)
            )
            .await
            .is_ok());
        // Refusal becomes offline within this heartbeat even with an unreachable saved HTTPS path.
        lan.abort();
        let _ = lan.await;
        provider.stop().await;
        let started = Instant::now();
        controller.heartbeat(&member, &mut misses).await;
        assert!(
            controller.list(false).await["devices"]
                .as_array()
                .unwrap()
                .is_empty(),
            "{}",
            controller.list(true).await
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        controller.stop().await.unwrap();
        manager.stop().await;
        service.stop().await.unwrap();
        core.abort();
        let _ = core.await;
    }
}
