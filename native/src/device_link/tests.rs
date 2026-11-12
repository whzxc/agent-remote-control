use super::*;
use rustls::pki_types::ServerName;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use transport::{post, PeerRequest};

pub(super) struct Fixture {
    directory: PathBuf,
    member: Arc<Manager>,
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("arc-peer-test-{}", id()));
        let member = Self::manager(directory.join("member"));
        Self { directory, member }
    }
    pub(super) fn manager(directory: PathBuf) -> Arc<Manager> {
        let member = Manager::new(directory.clone()).unwrap();
        let identity = Arc::new(Identity::load_or_create(&directory).unwrap());
        {
            let mut state = member.state.lock().unwrap();
            state.enabled = true;
            state.stored.identity_id = Some(identity.id.clone());
            state.identity = Some(identity);
            state.stored.name = Some("Example device".into());
        }
        member
    }
    fn controller(&self) -> Arc<Identity> {
        Self::manager(self.directory.join("controller"))
            .identity()
            .unwrap()
    }
    fn offer(&self) -> Offer {
        // The TLS fixture is independent of host network interfaces.
        let secret = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.member.state.lock().unwrap().offer = Some((hash(&secret), Instant::now() + OFFER_TTL));
        Offer {
            version: VERSION,
            device_id: self.member.identity().unwrap().id.clone(),
            addresses: vec!["192.168.1.2:7143".into()],
            tunnel_url: None,
            secret,
        }
    }
    async fn incoming(&self) -> Result<(DuplexStream, tokio::task::JoinHandle<()>)> {
        let (client_stream, server_stream) = tokio::io::duplex(65536);
        let member_identity = self.member.identity()?;
        let acceptor = tls::server(&self.member, &member_identity).unwrap();
        let permit = Arc::new(tokio::sync::Semaphore::new(1))
            .acquire_owned()
            .await
            .unwrap();
        let server = tokio::spawn(self.member.clone().accept_connection(
            server_stream,
            acceptor,
            permit,
        ));
        Ok((client_stream, server))
    }
    async fn connect(
        &self,
        client: &Identity,
        pin: &str,
    ) -> Result<(
        tokio_rustls::client::TlsStream<DuplexStream>,
        tokio::task::JoinHandle<()>,
    )> {
        let (client_stream, server) = self.incoming().await?;
        let connector = tls::client(client, pin.into()).unwrap();
        let result = connector
            .connect(
                ServerName::try_from("arc-peer.local").unwrap(),
                client_stream,
            )
            .await;
        match result {
            Ok(stream) => Ok((stream, server)),
            Err(e) => {
                server.abort();
                let _ = server.await;
                Err(e.to_string())
            }
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

/// Leave the transport open while preventing the vanished peer from answering PING.
struct StalledPeer<S> {
    stream: S,
    stalled: Arc<std::sync::atomic::AtomicBool>,
}
impl<S: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for StalledPeer<S> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if self.stalled.load(std::sync::atomic::Ordering::SeqCst) {
            return std::task::Poll::Pending;
        }
        std::pin::Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}
impl<S: tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for StalledPeer<S> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        if self.stalled.load(std::sync::atomic::Ordering::SeqCst) {
            return std::task::Poll::Pending;
        }
        std::pin::Pin::new(&mut self.stream).poll_write(cx, buf)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

async fn unfinished_hello(
    channel: &super::client::Channel,
) -> (
    tokio::sync::oneshot::Sender<String>,
    tokio::task::JoinHandle<
        std::result::Result<hyper::Response<hyper::body::Incoming>, hyper::Error>,
    >,
) {
    let (body_tx, body_rx) = tokio::sync::oneshot::channel::<String>();
    let body = http_body_util::StreamBody::new(futures_util::stream::once(async move {
        let bytes = body_rx.await.map_err(std::io::Error::other)?;
        Ok::<_, std::io::Error>(hyper::body::Frame::data(hyper::body::Bytes::from(bytes)))
    }));
    let mut sender = channel.ready().await.unwrap();
    let request = hyper::Request::builder()
        .method("POST")
        .uri("https://arc-peer.local/arc-peer/3/hello")
        .body(http_body_util::BodyExt::boxed_unsync(body))
        .unwrap();
    (
        body_tx,
        tokio::spawn(async move { sender.send_request(request).await }),
    )
}

#[tokio::test]
async fn leaked_controller_connections_are_reaped_within_keepalive_bound() {
    // Regression: eight half-open controller connections retained every paired LAN slot for hours.
    let fixture = Fixture::new();
    let identity = fixture.controller();
    super::tunnel_tests::paired(&fixture.member, &identity);
    *fixture.member.keepalive.lock().unwrap() =
        Some((Duration::from_millis(50), Duration::from_millis(50)));
    let member = fixture.member.identity().unwrap();
    let mut channels = Vec::new();
    let mut servers = Vec::new();
    let mut stalled = Vec::new();
    for _ in 0..8 {
        let (stream, server) = fixture.connect(&identity, &member.id).await.unwrap();
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let channel = super::client::Channel::new(StalledPeer {
            stream,
            stalled: flag.clone(),
        })
        .await
        .unwrap();
        assert_eq!(
            channel
                .request(
                    "/arc-peer/3/hello",
                    json!({"version":VERSION}),
                    Duration::from_secs(1)
                )
                .await
                .unwrap()["deviceId"],
            member.id
        );
        channels.push(channel);
        servers.push(server);
        stalled.push(flag);
    }
    let mut pending = Vec::new();
    for channel in &channels {
        pending.push(unfinished_hello(channel).await);
    }
    tokio::time::sleep(Duration::from_millis(25)).await;
    for flag in stalled {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    tokio::time::timeout(Duration::from_millis(300), async {
        for server in servers {
            server.await.unwrap();
        }
    })
    .await
    .expect("half-open connections exceeded the short keepalive bound");
    let (stream, server) = fixture.connect(&identity, &member.id).await.unwrap();
    assert_eq!(
        tokio::time::timeout(
            Duration::from_secs(1),
            post(stream, "/arc-peer/3/hello", json!({"version":VERSION}))
        )
        .await
        .expect("a new LAN hello was blocked after keepalive cleanup")
        .unwrap()["deviceId"],
        member.id
    );
    tokio::time::timeout(Duration::from_secs(1), server)
        .await
        .unwrap()
        .unwrap();
    for channel in channels {
        channel.close();
    }
    for (body, request) in pending {
        drop(body);
        request.abort();
        let _ = request.await;
    }
}

#[tokio::test]
async fn leaked_controller_connections_do_not_block_new_lan_connection() {
    // Regression: a reconnecting paired controller was silently dropped after eight idle LAN connections filled admission.
    let fixture = Fixture::new();
    let identity = fixture.controller();
    super::tunnel_tests::paired(&fixture.member, &identity);
    let member = fixture.member.identity().unwrap();
    let mut channels = Vec::new();
    let mut servers = Vec::new();
    for _ in 0..8 {
        let (stream, server) = fixture.connect(&identity, &member.id).await.unwrap();
        let channel = super::client::Channel::new(stream).await.unwrap();
        channel
            .request(
                "/arc-peer/3/hello",
                json!({"version":VERSION}),
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        channels.push(channel);
        servers.push(server);
    }
    // Keep the oldest connection active with an unfinished request body. It must
    // survive admission while the next oldest idle connection is replaced.
    let (body_tx, pending) = unfinished_hello(&channels[0]).await;
    tokio::time::sleep(Duration::from_millis(25)).await;
    let (stream, server) = fixture.connect(&identity, &member.id).await.unwrap();
    assert_eq!(
        post(stream, "/arc-peer/3/hello", json!({"version":VERSION}))
            .await
            .unwrap()["deviceId"],
        member.id
    );
    server.await.unwrap();
    let oldest_idle = servers.remove(1);
    tokio::time::timeout(Duration::from_secs(1), oldest_idle)
        .await
        .unwrap()
        .unwrap();
    body_tx
        .send(json!({"version":VERSION}).to_string())
        .unwrap();
    let response = pending.await.unwrap().unwrap();
    let bytes = http_body_util::BodyExt::collect(response.into_body())
        .await
        .unwrap()
        .to_bytes();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["result"]["deviceId"],
        member.id
    );
    for channel in channels {
        channel.close();
    }
    for server in servers {
        server.await.unwrap();
    }
}

#[test]
fn link_local_timeout_does_not_mask_ipv4_error() {
    // Regression: the last IPv6 link-local timeout hid the IPv4 TLS failure in controller LAN diagnostics.
    let ipv4 = "192.168.2.2:7143".parse().unwrap();
    let link_local = "[fe80::2%1]:7143".parse().unwrap();
    let tls = "DEVICE_TLS_FAILED: Peer handshake failed".to_owned();
    let timeout = "TCP connect deadline expired".to_owned();
    let mut failures = vec![
        (ipv4, Some(false), tls.clone()),
        (link_local, Some(false), timeout.clone()),
    ];
    for _ in 0..2 {
        let selected = super::client::lan_dial_error(&failures);
        assert_eq!(
            crate::management::error_code(&selected),
            "DEVICE_TLS_FAILED"
        );
        assert!(selected.contains(&ipv4.to_string()));
        failures.reverse();
    }
    failures = vec![
        (ipv4, Some(true), "Connection refused".into()),
        (link_local, Some(false), timeout.clone()),
    ];
    assert!(super::client::lan_dial_error(&failures).contains("Connection refused"));
    failures = vec![
        (ipv4, Some(false), timeout.clone()),
        (link_local, Some(false), timeout),
    ];
    let selected = super::client::lan_dial_error(&failures);
    assert_eq!(
        crate::management::error_code(&selected),
        "DEVICE_LAN_UNAVAILABLE"
    );
    assert!(selected.contains(&ipv4.to_string()));
}

#[tokio::test]
async fn leaked_lan_connections_do_not_starve_tunnel_requests() {
    // Regression: eight retained LAN connections made every authenticated tunnel request return DEVICE_BUSY.
    if super::tunnel_fixture::isolate(
        "device_link::tests::leaked_lan_connections_do_not_starve_tunnel_requests",
    )
    .await
    {
        return;
    }
    crate::sources::initialize().unwrap();
    crate::preferences::write(json!({"values":{"device-link":"on"}})).unwrap();
    let service = crate::service::Service::new().unwrap();
    let core = crate::transport::listen(service.clone(), None)
        .await
        .unwrap();
    let fixture = Fixture {
        directory: crate::root().join("fixture"),
        member: Fixture::manager(crate::root().join("device-link")),
    };
    let identity = fixture.controller();
    super::tunnel_tests::paired(&fixture.member, &identity);
    {
        let state = fixture.member.state.lock().unwrap();
        fixture.member.persist(&state).unwrap();
    }
    crate::sources::peer_connect(&identity.id, &identity.public_key, "Example controller")
        .await
        .unwrap();
    let member = fixture.member.identity().unwrap();
    let mut provider = super::tunnel_fixture::Provider::new(&fixture.member).await;
    let mut channels = Vec::new();
    let mut servers = Vec::new();
    for _ in 0..8 {
        let (stream, server) = fixture.connect(&identity, &member.id).await.unwrap();
        let channel = super::client::Channel::new(stream).await.unwrap();
        channel
            .request(
                "/arc-peer/3/hello",
                json!({"version":VERSION}),
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        channels.push(channel);
        servers.push(server);
    }
    let session = super::tunnel::Client::default();
    let (url, token) = session
        .prepare(&identity, &member.id, &provider.url)
        .await
        .unwrap();
    let result = super::tunnel::post(
        &url,
        "request",
        Some(&token),
        json!({"version":VERSION,"tool":"query","body":{"op":"guide","args":{}},"origin":{}}),
        Duration::from_secs(2),
    )
    .await
    .unwrap();
    assert_eq!(result["isError"], false);
    for channel in channels {
        channel.close();
    }
    for server in servers {
        server.await.unwrap();
    }
    provider.stop().await;
    core.abort();
    let _ = core.await;
    service.stop().await.unwrap();
}

#[test]
fn pairing_string_roundtrip_and_version() {
    // Contract: peer pairing strings preserve identity, LAN endpoints, version and one-time secret.
    let fixture = Fixture::new();
    let offer = fixture.offer();
    let decoded = Offer::decode(&offer.encode().unwrap()).unwrap();
    assert_eq!(decoded.device_id, offer.device_id);
    assert_eq!(decoded.addresses, offer.addresses);
    assert_eq!(decoded.secret, offer.secret);
    assert_eq!(decoded.tunnel_url, None);
    let mut incompatible = offer;
    incompatible.version = VERSION + 1;
    assert_eq!(
        crate::management::error_code(&Offer::decode(&incompatible.encode().unwrap()).unwrap_err()),
        "DEVICE_PROTOCOL_MISMATCH"
    );
}
#[test]
fn lan_policy_excludes_public_loopback_and_mapped_public() {
    // Property: peer admission is restricted to private, unique-local and link-local addresses.
    for address in [
        "10.1.2.3",
        "172.16.0.2",
        "192.168.2.3",
        "169.254.1.2",
        "fc01::1",
        "fe80::1",
        "::ffff:192.168.1.2",
    ] {
        assert!(lan_address(address.parse().unwrap()));
    }
    for address in [
        "8.8.8.8",
        "127.0.0.1",
        "0.0.0.0",
        "::1",
        "::",
        "2001:4860:4860::8888",
        "::ffff:8.8.8.8",
    ] {
        assert!(!lan_address(address.parse().unwrap()));
    }
}
#[test]
fn device_cli_errors_preserve_json_codes() {
    // Contract: Device link CLI errors retain the version-1 JSON envelope, stable code and next action.
    for code in [
        "OP_UNAVAILABLE",
        "DEVICE_PAIRING_INVALID",
        "DEVICE_TLS_FAILED",
        "DEVICE_PROTOCOL_MISMATCH",
        "DEVICE_LAN_UNAVAILABLE",
        "DEVICE_TUNNEL_AUTH",
        "DEVICE_TUNNEL_UNAVAILABLE",
        "DEVICE_TUNNEL_LIMIT",
        "DEVICE_LISTEN_FAILED",
        "DEVICE_CONTROLLER_EXISTS",
        "DEVICE_PAIRING_PENDING",
        "DEVICE_PAIRING_MISSING",
        "DEVICE_OFFER_EXPIRED",
        "DEVICE_PAIRING_SECRET",
        "DEVICE_PAIRING_DECLINED",
        "DEVICE_PEER_FORBIDDEN",
        "DEVICE_UNPAIRED",
    ] {
        let result = crate::cli::error_response(
            &format!("{code}: Read cli guide."),
            "cli device offer",
            &["device", "offer"],
        );
        assert_eq!(result["schemaVersion"], 1);
        assert_eq!(result["ok"], false);
        assert_eq!(result["error"]["code"], code);
        assert_eq!(result["next"]["op"], "guide");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn host_unreachable_dial_retains_os_evidence_and_app_recovery() {
    // Regression: macOS LAN privacy denial surfaced only os error 65 with no quit-and-reopen recovery.
    let os_error = std::io::Error::from_raw_os_error(libc::EHOSTUNREACH);
    let message = client::lan_connect_error(&os_error);
    let diagnostic =
        client::lan_dial_error(&[("192.168.1.6:7143".parse().unwrap(), None, message)]);
    assert!(diagnostic.starts_with("DEVICE_LAN_UNAVAILABLE:"));
    assert!(diagnostic.contains(&os_error.to_string()));
    assert!(diagnostic.contains("arc cli app quit"));
    assert!(diagnostic.contains("open -a"));
    let refused = std::io::Error::from_raw_os_error(libc::ECONNREFUSED);
    assert_eq!(client::lan_connect_error(&refused), refused.to_string());
}
#[test]
fn peer_envelope_preserves_receipt_and_blocks_management() {
    // Contract: peer envelopes preserve receipt IDs and reject local management and multihop operations.
    let receipt = id();
    let request = PeerRequest {
        version: VERSION,
        tool: "act".into(),
        body: json!({"op":"command","args":{"cmd":"true"},"requestId":receipt}),
        origin: json!({"sourceId":"example-source"}),
    };
    request.validate().unwrap();
    let wire = serde_json::to_value(&request).unwrap();
    let read: PeerRequest = serde_json::from_value(wire).unwrap();
    assert_eq!(read.body["requestId"], receipt);
    for op in [
        "devices",
        "device",
        "device_transfer",
        "device.offer",
        "device/revoke",
    ] {
        let mut denied = request.clone();
        denied.body["op"] = json!(op);
        assert_eq!(
            crate::management::error_code(&denied.validate().unwrap_err()),
            "DEVICE_PEER_FORBIDDEN"
        );
    }
    let mut denied = request;
    denied.tool = "management".into();
    assert_eq!(
        crate::management::error_code(&denied.validate().unwrap_err()),
        "DEVICE_PEER_FORBIDDEN"
    );
}
#[test]
fn handshake_budget_is_bounded_and_recovers() {
    // Regression: one global 32/min handshake bucket let a LAN host starve every paired controller.
    let mut budget = transport::HandshakeBudget::new();
    let start = Instant::now();
    let first = "192.168.1.10".parse().unwrap();
    let controller = "192.168.1.11".parse().unwrap();
    for _ in 0..32 {
        assert!(budget.admit(first, start).is_some());
    }
    assert!(budget.admit(first, start).is_none());
    assert!(budget.admit(controller, start).is_some());
    assert!(budget
        .admit(first, start + Duration::from_secs(60))
        .is_some());
    for address in 0..512 {
        let ip = IpAddr::V4(std::net::Ipv4Addr::new(
            10,
            0,
            (address / 256) as u8,
            (address % 256) as u8,
        ));
        assert!(budget.admit(ip, start).is_some());
    }
    assert!(budget.admit(controller, start).is_some());
}
#[tokio::test]
async fn tls_requires_pins_client_keys_and_an_offer() {
    // Contract: peer TLS rejects unknown keys before reading HTTP and exposes its protocol in ALPN.
    let fixture = Fixture::new();
    let controller = fixture.controller();
    let member = fixture.member.identity().unwrap();
    let offer = fixture.offer();
    let (stream, server) = fixture.connect(&controller, &member.id).await.unwrap();
    assert_eq!(stream.get_ref().1.alpn_protocol(), Some(tls::ALPN));
    let response = post(stream, "/arc-peer/3/hello", json!({"version":VERSION}))
        .await
        .unwrap();
    assert_eq!(response["deviceId"], offer.device_id);
    server.await.unwrap();
    assert!(fixture.connect(&controller, &"0".repeat(64)).await.is_err());
    let connector = tls::client(&controller, member.id.clone()).unwrap();
    let mut config = connector.config().as_ref().clone();
    config.alpn_protocols = vec![b"arc-peer/unsupported".to_vec()];
    let (stream, server) = fixture.incoming().await.unwrap();
    let mismatch = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(ServerName::try_from("arc-peer.local").unwrap(), stream)
        .await
        .unwrap_err();
    assert!(tls::protocol_mismatch(&mismatch));
    server.await.unwrap();

    let (stream, server) = fixture.incoming().await.unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots.add(member.certificate.clone()).unwrap();
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    config.alpn_protocols = vec![tls::ALPN.to_vec()];
    let anonymous = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(ServerName::try_from("arc-peer.local").unwrap(), stream)
        .await;
    if let Ok(stream) = anonymous {
        assert!(
            post(stream, "/arc-peer/3/hello", json!({"version":VERSION}))
                .await
                .is_err()
        );
    }
    server.await.unwrap();

    fixture.member.state.lock().unwrap().offer = None;
    // TLS 1.3 can deliver the server's rejection only on the client's first I/O.
    match fixture.connect(&controller, &member.id).await {
        Err(_) => {}
        Ok((mut stream, server)) => {
            let _ = stream.write_all(b"POST /arc-peer/3/hello HTTP/1.1\r\nHost: arc-peer.local\r\nContent-Length: 2\r\n\r\n{}").await;
            let mut byte = [0];
            assert!(!matches!(stream.read(&mut byte).await,Ok(n) if n > 0));
            server.await.unwrap();
        }
    }
    let reciprocal = Fixture::manager(fixture.directory.join("reverse"));
    let member_peer = Peer {
        device_id: member.id.clone(),
        public_key: member.public_key.clone(),
        name: "Example member".into(),
        addresses: vec![],
        tunnel_url: None,
        address_override: None,
    };
    reciprocal.state.lock().unwrap().stored.controller = Some(member_peer);
    let mut reverse_offer = fixture.offer();
    reverse_offer.device_id = member.id.clone();
    let denied = reciprocal
        .request(
            "pair",
            json!({"pairingString":reverse_offer.encode().unwrap()}),
        )
        .await
        .unwrap_err();
    assert_eq!(
        crate::management::error_code(&denied),
        "DEVICE_PEER_FORBIDDEN"
    );
}
#[tokio::test]
async fn pairing_secret_is_consumed_and_local_decline_is_required() {
    // Contract: an offer proof waits for member-local consent and consumes its secret exactly once.
    let fixture = Fixture::new();
    let controller = fixture.controller();
    let member = fixture.member.identity().unwrap();
    let offer = fixture.offer();
    let (stream, server) = fixture.connect(&controller, &member.id).await.unwrap();
    let pair = tokio::spawn(post(
        stream,
        "/arc-peer/3/pair",
        json!({"version":VERSION,"secret":offer.secret,"name":"Example controller"}),
    ));
    // Wait for the HTTP request to reach its explicit approval suspension point.
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let pending = fixture.member.request("pending", json!({})).await.unwrap();
            if pending["pending"].is_object() {
                assert_eq!(pending["pending"]["deviceId"], controller.id);
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!pair.is_finished());
    fixture.member.request("decline", json!({})).await.unwrap();
    assert_eq!(
        crate::management::error_code(&pair.await.unwrap().unwrap_err()),
        "DEVICE_PAIRING_DECLINED"
    );
    server.await.unwrap();
    assert!(!fixture.member.accept_certificate(&controller.id));
}

async fn isolated_core_fixture() -> bool {
    if std::env::var_os("ARC_DEVICE_TEST_CHILD").is_some() {
        return false;
    }
    let directory = std::env::temp_dir().join(format!("arc-device-core-{}", id()));
    let result = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "device_link::tests::approved_peer_uses_private_core_source_and_receipt",
            "--nocapture",
        ])
        .env("ARC_DEVICE_TEST_CHILD", "1")
        .env("ARC_STATE_DIR", &directory)
        .status()
        .await
        .unwrap();
    let _ = std::fs::remove_dir_all(directory);
    assert!(result.success());
    true
}
#[tokio::test]
async fn approved_peer_uses_private_core_source_and_receipt() {
    // Contract: locally approved peer requests use private Core IPC, peer source ownership and the caller's receipt ID.
    if isolated_core_fixture().await {
        return;
    }
    crate::sources::initialize().unwrap();
    crate::preferences::write(json!({"values":{"device-link":"on"}})).unwrap();
    let service = crate::service::Service::new().unwrap();
    let core = crate::transport::listen(service.clone(), None)
        .await
        .unwrap();
    let fixture = Fixture {
        directory: std::env::temp_dir().join(format!("arc-peer-controller-{}", id())),
        member: Fixture::manager(crate::root().join("device-link")),
    };
    let available = tokio::net::TcpListener::bind(lan_sockets(0).unwrap()[0])
        .await
        .unwrap();
    let port = available.local_addr().unwrap().port();
    drop(available);
    let configuration = fixture
        .member
        .request("configure", json!({"port":port,"name":"Example member"}))
        .await
        .unwrap();
    assert_eq!(configuration["port"], port);
    let first_id = fixture.member.identity().unwrap().id.clone();
    let controller_manager = Fixture::manager(fixture.directory.join("controller"));
    let offer = fixture.member.request("offer", json!({})).await.unwrap();
    let endpoint = Offer::decode(offer["pairingString"].as_str().unwrap())
        .unwrap()
        .addresses[0]
        .clone();
    let pairing = {
        let controller = controller_manager.clone();
        tokio::spawn(async move {
            controller
                .request("pair", json!({"pairingString":offer["pairingString"]}))
                .await
        })
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if fixture.member.request("pending", json!({})).await.unwrap()["pending"].is_object() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!pairing.is_finished());
    let approval = fixture.member.request("approve", json!({})).await.unwrap();
    assert_eq!(approval["approved"], true);
    let paired = pairing.await.unwrap().unwrap();
    assert_eq!(paired["paired"], true);
    assert_eq!(paired["deviceId"], first_id);
    assert_eq!(
        crate::management::error_code(
            &fixture
                .member
                .request("offer", json!({}))
                .await
                .unwrap_err()
        ),
        "DEVICE_CONTROLLER_EXISTS"
    );
    let controller = controller_manager.identity().unwrap();
    let source = crate::sources::peer_authority(&controller.id).unwrap();
    assert_eq!(source["credential"]["type"], "peer");
    let (stream, server) = fixture.connect(&controller, &first_id).await.unwrap();
    let request = id();
    let result = post(stream,"/arc-peer/3/request",json!({"version":VERSION,"tool":"act","body":{"op":"command","args":{"cmd":"echo ARC_PEER_FIXTURE","cwd":fixture.directory.join("missing"),"waitMs":1000},"requestId":request},"origin":{"sourceId":"example-origin"}})).await.unwrap();
    let result = crate::egress::tool_value(&result).unwrap();
    assert_eq!(result["requestId"], request, "{result}");
    server.await.unwrap();
    let (stream, server) = fixture.connect(&controller, &first_id).await.unwrap();
    let receipt = post(stream,"/arc-peer/3/request",json!({"version":VERSION,"tool":"act","body":{"op":"receipt","args":{"requestId":request,"includeOrigin":true}},"origin":{"sourceId":"example-origin"}})).await.unwrap();
    let receipt = crate::egress::tool_value(&receipt).unwrap();
    assert_eq!(receipt["requestId"], request, "{receipt}");
    assert_eq!(receipt["origin"]["sourceId"], source["id"], "{receipt}");
    assert_eq!(
        receipt["origin"]["peerOrigin"]["sourceId"],
        "example-origin"
    );
    server.await.unwrap();
    let (stream, server) = fixture.connect(&controller, &first_id).await.unwrap();
    let denied = post(
        stream,
        "/arc-peer/3/request",
        json!({"version":VERSION,"tool":"act","body":{"op":"device","args":{}},"origin":{}}),
    )
    .await
    .unwrap_err();
    assert_eq!(
        crate::management::error_code(&denied),
        "DEVICE_PEER_FORBIDDEN"
    );
    server.await.unwrap();
    let (mut stream, server) = fixture.connect(&controller, &first_id).await.unwrap();
    fixture
        .member
        .request("revoke", json!({"deviceId":controller.id}))
        .await
        .unwrap();
    let mut byte = [0];
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), stream.read(&mut byte)).await,
        Ok(Ok(0)) | Ok(Err(_))
    ));
    server.await.unwrap();
    assert_eq!(
        crate::management::error_code(&crate::sources::peer_authority(&controller.id).unwrap_err()),
        "DEVICE_UNPAIRED"
    );
    // Controller-side revocation uses its persisted pairing and closes its local connections.
    let restored = Fixture::manager(fixture.directory.join("controller"));
    assert_eq!(
        restored
            .request("revoke", json!({"deviceId":first_id}))
            .await
            .unwrap()["revoked"],
        true
    );
    fixture.member.reconcile(false).await.unwrap();
    assert!(tokio::net::TcpStream::connect(&endpoint).await.is_err());
    assert_eq!(
        crate::management::error_code(
            &fixture
                .member
                .request("offer", json!({}))
                .await
                .unwrap_err()
        ),
        "OP_UNAVAILABLE"
    );
    fixture.member.reconcile(true).await.unwrap();
    assert_eq!(fixture.member.identity().unwrap().id, first_id);
    fixture.member.stop().await;
    service.stop().await.unwrap();
    core.abort();
    let _ = core.await;
    crate::preferences::write(json!({"values":{"device-link":"off"}})).unwrap();
    assert!(crate::management::catalog()["operations"]
        .as_array()
        .unwrap()
        .iter()
        .all(|op| !string(op, "name").starts_with("device.")));
    assert_eq!(
        crate::management::error_code(
            &crate::management::resolve("device.offer", &json!({})).unwrap_err()
        ),
        "OP_UNAVAILABLE"
    );
}

#[tokio::test]
async fn hello_refresh_replaces_stale_persisted_addresses_without_rewriting_unchanged() {
    // Regression: successful hello left the stale 12-address list and null tunnel URL persisted across controller restart.
    let fixture = Fixture::new();
    let member = fixture.controller();
    let stale = Peer {
        device_id: member.id.clone(),
        public_key: member.public_key.clone(),
        name: "Example member".into(),
        addresses: (1..=12).map(|i| format!("192.168.1.{i}:7143")).collect(),
        tunnel_url: None,
        address_override: None,
    };
    {
        let mut state = fixture.member.state.lock().unwrap();
        state.stored.members.insert(member.id.clone(), stale);
        fixture.member.persist(&state).unwrap();
    }
    let body = json!({"deviceId":member.id,"publicKey":member.public_key,"hello":{"addresses":["192.168.1.20:7143"],"tunnelUrl":"https://example.com/arc-peer/3"}});
    assert_eq!(
        fixture.member.request("learn", body.clone()).await.unwrap()["changed"],
        true
    );
    assert_eq!(
        fixture.member.request("learn", body.clone()).await.unwrap()["changed"],
        false
    );
    let reopened = Fixture::manager(fixture.member.directory.clone());
    assert_eq!(
        reopened.request("learn", body).await.unwrap()["changed"],
        false
    );
}

#[tokio::test]
async fn desktop_snapshot_reads_identity_pairings_and_pending_deadline() {
    // Regression: Desktop had no management read for identity, paired controller, or address overrides.
    let fixture = Fixture::new();
    let identity = fixture.member.identity().unwrap();
    let controller = fixture.controller();
    let peer = Peer {
        device_id: controller.id.clone(),
        public_key: controller.public_key.clone(),
        name: "Example controller".into(),
        addresses: vec!["192.168.1.5:7143".into()],
        tunnel_url: None,
        address_override: Some("example.local:7143".into()),
    };
    let (decision, _receiver) = tokio::sync::oneshot::channel();
    {
        let mut state = fixture.member.state.lock().unwrap();
        state.stored.controller = Some(peer.clone());
        state
            .stored
            .members
            .insert(peer.device_id.clone(), peer.clone());
        state.pending = Some(Pending {
            peer,
            expires: Instant::now() + Duration::from_secs(120),
            decision,
        });
    }
    let snapshot = fixture.member.request("snapshot", json!({})).await.unwrap();
    assert_eq!(snapshot["deviceId"], identity.id);
    assert_eq!(snapshot["controller"]["name"], "Example controller");
    assert_eq!(
        snapshot["members"][0]["addressOverride"],
        "example.local:7143"
    );
    assert_eq!(snapshot["pending"]["deviceId"], controller.id);
    assert!(snapshot["pending"]["expiresInSeconds"].as_u64().unwrap() > 0);
    assert!(snapshot["controller"].get("publicKey").is_none());
}

#[tokio::test]
async fn cancelled_pairing_cannot_accept_a_late_member_approval() {
    // Regression: the waiting-pair dialog had no stop action and could leave its native pairing attempt running after close.
    let fixture = Fixture::new();
    let controller = Fixture::manager(fixture.directory.join("cancel-controller"));
    let listener = tokio::net::TcpListener::bind(lan_sockets(0).unwrap()[0])
        .await
        .unwrap();
    let mut offer = fixture.offer();
    offer.addresses = vec![listener.local_addr().unwrap().to_string()];
    let member = fixture.member.clone();
    let acceptor = tls::server(&member, &member.identity().unwrap()).unwrap();
    let permit = Arc::new(tokio::sync::Semaphore::new(1))
        .acquire_owned()
        .await
        .unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        member.accept_connection(stream, acceptor, permit).await;
    });
    let pairing = {
        let controller = controller.clone();
        tokio::spawn(async move {
            controller
                .request("pair", json!({"pairingString":offer.encode().unwrap()}))
                .await
        })
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if fixture.member.request("pending", json!({})).await.unwrap()["pending"].is_object() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        controller.request("cancel-pair", json!({})).await.unwrap()["cancelled"],
        true
    );
    assert!(pairing
        .await
        .unwrap()
        .unwrap_err()
        .contains("DEVICE_PAIRING_CANCELLED"));
    tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
    assert!(fixture.member.request("pending", json!({})).await.unwrap()["pending"].is_null());
    assert!(fixture.member.request("approve", json!({})).await.is_err());
    assert_eq!(
        controller.request("snapshot", json!({})).await.unwrap()["members"],
        json!([])
    );
}
