#[path = "relay_fixture.rs"]
mod relay_fixture;
use super::*;
use receiver::*;
struct Fixture {
    directory: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("arc-transfer-{}", id()));
        std::fs::create_dir_all(&directory).unwrap();
        Self { directory }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
#[test]
fn transfer_catalog_envelopes() {
    // Contract: device_transfer uses act, explicit receipt actions and exactly the current endpoint fields.
    let op = crate::catalog()["ops"]
        .as_array()
        .unwrap()
        .iter()
        .find(|op| op["name"] == "device_transfer")
        .unwrap();
    assert_eq!(crate::egress::via(op), "act");
    for args in [
        json!({"from":{"path":"/input"},"to":{"device":"member","path":"/output"}}),
        json!({"action":"resume","requestId":id()}),
        json!({"action":"cancel","requestId":id()}),
    ] {
        crate::egress::validate_op(op, &args).unwrap();
    }
    assert_eq!(crate::egress::retry_contract(op)["mode"], "receipt");
    assert!(super::super::transport::forbidden("device_transfer"));
}

struct Network {
    directory: PathBuf,
    member: Arc<Manager>,
    controller: Arc<controller::Controller>,
    identity: Arc<Identity>,
    device: String,
    channel: Arc<super::super::client::Channel>,
    listener: tokio::task::JoinHandle<()>,
    core: tokio::task::JoinHandle<()>,
    service: Arc<crate::service::Service>,
}
impl Network {
    async fn new() -> Self {
        crate::init_crypto();
        crate::sources::initialize().unwrap();
        crate::preferences::write(json!({"values":{"device-link":"on"}})).unwrap();
        let directory = crate::root();
        let member = super::super::tests::Fixture::manager(directory.join("device-link"));
        let controller_manager =
            super::super::tests::Fixture::manager(directory.join("controller/device-link"));
        let identity = controller_manager.identity().unwrap();
        super::super::tunnel_tests::paired(&member, &identity);
        let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        {
            let mut state = member.state.lock().unwrap();
            state.stored.port = port;
            member.persist(&state).unwrap();
        }
        crate::sources::peer_connect(&identity.id, &identity.public_key, "Example controller")
            .await
            .unwrap();
        let member_identity = member.identity().unwrap();
        let device = member_identity.id.clone();
        {
            let mut state = controller_manager.state.lock().unwrap();
            state.stored.members.insert(
                device.clone(),
                Peer {
                    device_id: device.clone(),
                    public_key: member_identity.public_key.clone(),
                    name: "Example member".into(),
                    addresses: lan_sockets(port)
                        .unwrap()
                        .iter()
                        .map(ToString::to_string)
                        .collect(),
                    address_override: None,
                    tunnel_url: None,
                },
            );
            controller_manager.persist(&state).unwrap();
        }
        let service = crate::service::Service::new().unwrap();
        let core = crate::transport::listen(service.clone(), None)
            .await
            .unwrap();
        let acceptor = super::super::tls::server(&member, &member_identity).unwrap();
        let server = member.clone();
        let listener = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>{let Ok((stream,_))=accepted else{break;};let permit=Arc::new(tokio::sync::Semaphore::new(1)).acquire_owned().await.unwrap();tasks.spawn(server.clone().accept_connection(stream,acceptor.clone(),permit));},
                    Some(_)=tasks.join_next(),if !tasks.is_empty()=>{},
                }
            }
        });
        let channel = super::super::client::Session::default()
            .connect(
                &identity,
                &device,
                &[format!("127.0.0.1:{port}").parse().unwrap()],
            )
            .await
            .unwrap();
        let controller =
            controller::Controller::new(directory.join("controller/device-link")).unwrap();
        controller.reconcile(true).await.unwrap();
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if controller.list(false).await["devices"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty())
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        Self {
            directory,
            member,
            controller,
            identity,
            device,
            channel,
            listener,
            core,
            service,
        }
    }
    async fn stop(self) {
        self.channel.close();
        self.controller.stop().await.unwrap();
        self.listener.abort();
        let _ = self.listener.await;
        self.core.abort();
        let _ = self.core.await;
        self.service.stop().await.unwrap();
    }
    async fn completed(&self, request: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                let row = self
                    .controller
                    .transfer(json!({"action":"read","requestId":request}))
                    .await
                    .unwrap();
                if row["state"] != "executing" && row["state"] != "reserved" {
                    return row;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }
}
fn synthetic(path: &Path, length: u64) -> String {
    use sha2::{Digest, Sha256};
    use std::io::Write;
    let block = (0..BLOCK)
        .map(|i| ((i * 17 + i / 251) % 251) as u8)
        .collect::<Vec<_>>();
    let mut file = std::fs::File::create(path).unwrap();
    let mut sha = Sha256::new();
    let mut left = length;
    while left > 0 {
        let bytes = &block[..left.min(BLOCK as u64) as usize];
        file.write_all(bytes).unwrap();
        sha.update(bytes);
        left -= bytes.len() as u64;
    }
    file.sync_all().unwrap();
    crate::hex_encode(&sha.finalize())
}
async fn isolated(name: &str) -> bool {
    super::super::tunnel_fixture::isolate(name).await
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lan_transfer_receipts_resume_cancel_and_integrity() {
    // Contract: LAN transfers verify both directions, preserve destinations, resume verified bytes only, read repeated IDs and cancel temporary files.
    if isolated("device_link::transfer::tests::lan_transfer_receipts_resume_cancel_and_integrity")
        .await
    {
        return;
    }
    let network = Network::new().await;
    let source = network.directory.join("source.bin");
    let destination = network.directory.join("uploaded.bin");
    let downloaded = network.directory.join("downloaded.bin");
    let sha = synthetic(&source, 64 * 1024 * 1024);
    let request = id();
    let plan = json!({"requestId":request,"from":{"path":source},"to":{"device":network.device,"path":destination},"expectedSha256":sha});
    let started = network.controller.transfer(plan.clone()).await.unwrap();
    assert_eq!(started["requestId"], request);
    assert_eq!(started["state"], "executing");
    let repeated = network.controller.transfer(plan.clone()).await.unwrap();
    assert_eq!(repeated["requestId"], request);
    let done = network.completed(&request).await;
    assert_eq!(done["state"], "completed", "{done}");
    assert_eq!(done["result"]["sha256"], sha);
    assert_eq!(done["progress"]["bytes"], 64 * 1024 * 1024);
    let down = id();
    network.controller.transfer(json!({"requestId":down,"from":{"device":network.device,"path":destination},"to":{"path":downloaded},"expectedSha256":sha})).await.unwrap();
    let done = network.completed(&down).await;
    assert_eq!(done["state"], "completed", "{done}");
    assert_eq!(done["result"]["sha256"], sha);
    assert_eq!(file_digest(&downloaded), sha);
    let refusal = id();
    network.controller.transfer(json!({"requestId":refusal,"from":{"path":source},"to":{"device":network.device,"path":destination}})).await.unwrap();
    let refused = network.completed(&refusal).await;
    assert_eq!(refused["error"]["code"], "DESTINATION_EXISTS");
    let mismatch = id();
    network.controller.transfer(json!({"requestId":mismatch,"from":{"path":source},"to":{"device":network.device,"path":destination},"overwrite":true,"expectedSha256":digest(b"different")})).await.unwrap();
    let failed = network.completed(&mismatch).await;
    assert_eq!(failed["error"]["code"], "SHA256_MISMATCH");
    assert_eq!(file_digest(&destination), sha);
    let link = wire::Link::Lan(network.channel.clone());
    let stamp = link
        .control(json!({"action":"stat","path":destination}))
        .await
        .unwrap();
    assert_eq!(stamp["total"], 64 * 1024 * 1024);
    let cancelled = network
        .controller
        .transfer(json!({"action":"cancel","requestId":mismatch}))
        .await
        .unwrap();
    assert_eq!(cancelled["state"], "cancelled");
    let meta = link
        .control(json!({"action":"status","requestId":mismatch}))
        .await
        .unwrap();
    assert!(!Path::new(string(&meta, "temporary")).exists());
    let replacement = network.directory.join("replacement-source");
    let replacement_sha = synthetic(&replacement, BLOCK as u64);
    let replaced = id();
    network.controller.transfer(json!({"requestId":replaced,"from":{"path":replacement},"to":{"device":network.device,"path":destination},"overwrite":true,"expectedSha256":replacement_sha})).await.unwrap();
    let done = network.completed(&replaced).await;
    assert_eq!(done["state"], "completed", "{done}");
    assert_eq!(file_digest(&destination), replacement_sha);
    let disabled = crate::preferences::write(json!({"values":{"device-link":"off"}}));
    assert!(disabled.is_ok());
    assert!(network
        .controller
        .transfer(plan)
        .await
        .unwrap_err()
        .starts_with("OP_UNAVAILABLE"));
    network.stop().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tunnel_twenty_mib_ranges_are_correct() {
    // Contract: authenticated tunnel transfer ranges fit 2a caps and preserve a 20 MiB file in both directions.
    if isolated("device_link::transfer::tests::tunnel_twenty_mib_ranges_are_correct").await {
        return;
    }
    let network = Network::new().await;
    let mut provider = super::super::tunnel_fixture::Provider::new(&network.member).await;
    let session = super::super::tunnel::Client::default();
    let (url, token) = session
        .prepare(&network.identity, &network.device, &provider.url)
        .await
        .unwrap();
    let link = wire::Link::Tunnel {
        url,
        token,
        closed: session.subscribe(),
    };
    let source = network.directory.join("tunnel-source");
    let destination = network.directory.join("tunnel-destination");
    let downloaded = network.directory.join("tunnel-download");
    let total = 20 * 1024 * 1024;
    let sha = synthetic(&source, total);
    let request = id();
    link.control(json!({"action":"begin","requestId":request,"spec":{"path":destination,"total":total,"expectedSha256":sha}})).await.unwrap();
    let mut offset = 0;
    while offset < total {
        let length = link.range().min(total - offset);
        let meta = link
            .upload(&request, &source, offset, length)
            .await
            .unwrap();
        assert_eq!(meta["offset"], offset + length);
        offset += length;
    }
    let result = link
        .control(json!({"action":"commit","requestId":request}))
        .await
        .unwrap();
    assert_eq!(result["sha256"], sha);
    let stamp = link
        .control(json!({"action":"stat","path":destination}))
        .await
        .unwrap();
    let store = Store::default();
    let request = id();
    let directory = network.directory.join("download-receivers");
    store
        .begin(
            &directory,
            &request,
            json!({"path":downloaded,"total":total,"expectedSha256":sha}),
        )
        .await
        .unwrap();
    let entry = store.get(&directory, &request).await.unwrap();
    let mut receiver = entry.lock().await;
    while receiver.offset() < total {
        let length = link.range().min(total - receiver.offset());
        link.download(
            &request,
            destination.to_str().unwrap(),
            &stamp,
            &mut receiver,
            length,
        )
        .await
        .unwrap();
    }
    assert_eq!(receiver.commit().unwrap()["sha256"], sha);
    drop(receiver);
    provider.stop().await;
    network.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "Targeted 1 GiB native throughput/RSS fixture; run explicitly with --ignored --nocapture"]
async fn lan_gib_performance() {
    // Contract: LAN binary streams transfer a generated 1 GiB file with bounded buffers, measured throughput and first-byte latency.
    // This fixture reports host-dependent targets and asserts deterministic byte integrity.
    if performance_isolate().await {
        return;
    }
    let network = Network::new().await;
    let source = network.directory.join("gib-source");
    let destination = network.directory.join("gib-upload");
    let downloaded = network.directory.join("gib-download");
    let total = 1024 * 1024 * 1024;
    let sha = synthetic(&source, total);
    let request = id();
    let link = wire::Link::Lan(network.channel.clone());
    let before = rss();
    let started = Instant::now();
    let meta=link.control(json!({"action":"begin","requestId":request,"spec":{"path":destination,"total":total,"expectedSha256":sha}})).await.unwrap();
    let temporary = PathBuf::from(string(&meta, "temporary"));
    let admitted = Instant::now();
    let first = tokio::spawn(async move {
        loop {
            if std::fs::metadata(&temporary).is_ok_and(|m| m.len() > 0) {
                return admitted.elapsed();
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    });
    let mut peak = before;
    let mut offset = 0;
    while offset < total {
        let length = link.range().min(total - offset);
        link.upload(&request, &source, offset, length)
            .await
            .unwrap();
        peak = peak.max(peak_rss());
        offset += length;
    }
    let result = link
        .control(json!({"action":"commit","requestId":request}))
        .await
        .unwrap();
    let elapsed = started.elapsed();
    let first = first.await.unwrap();
    assert_eq!(result["sha256"], sha);
    println!("LAN_UPLOAD bytes={total} seconds={:.3} MBps={:.1} rss_growth_MiB={:.2} first_byte_ms={:.2}",elapsed.as_secs_f64(),total as f64/elapsed.as_secs_f64()/1e6,peak.saturating_sub(before) as f64/1048576.0,first.as_secs_f64()*1000.0);
    assert!(first < Duration::from_millis(200), "first byte {first:?}");
    assert!(
        peak.saturating_sub(before) <= 64 * 1024 * 1024,
        "RSS growth exceeded 64 MiB"
    );
    let stamp = link
        .control(json!({"action":"stat","path":destination}))
        .await
        .unwrap();
    let request = id();
    let store = Store::default();
    let directory = network.directory.join("gib-receivers");
    store
        .begin(
            &directory,
            &request,
            json!({"path":downloaded,"total":total,"expectedSha256":sha}),
        )
        .await
        .unwrap();
    let entry = store.get(&directory, &request).await.unwrap();
    let mut receiver = entry.lock().await;
    let before = rss();
    let mut peak = before;
    let started = Instant::now();
    while receiver.offset() < total {
        let length = link.range().min(total - receiver.offset());
        link.download(
            &request,
            destination.to_str().unwrap(),
            &stamp,
            &mut receiver,
            length,
        )
        .await
        .unwrap();
        peak = peak.max(peak_rss());
    }
    let result = receiver.commit().unwrap();
    let elapsed = started.elapsed();
    assert_eq!(result["sha256"], sha);
    println!(
        "LAN_DOWNLOAD bytes={total} seconds={:.3} MBps={:.1} rss_growth_MiB={:.2}",
        elapsed.as_secs_f64(),
        total as f64 / elapsed.as_secs_f64() / 1e6,
        peak.saturating_sub(before) as f64 / 1048576.0
    );
    assert!(
        peak.saturating_sub(before) <= 64 * 1024 * 1024,
        "RSS growth exceeded 64 MiB"
    );
    drop(receiver);
    for (direction, from, to) in [
        (
            "UPLOAD",
            json!({"path":source}),
            json!({"device":network.device,"path":destination}),
        ),
        (
            "DOWNLOAD",
            json!({"device":network.device,"path":destination}),
            json!({"path":downloaded}),
        ),
    ] {
        let request = id();
        let before = rss();
        let started = Instant::now();
        network.controller.transfer(json!({"requestId":request,"from":from,"to":to,"overwrite":true,"expectedSha256":sha})).await.unwrap();
        let result = network.completed(&request).await;
        let elapsed = started.elapsed();
        assert_eq!(result["state"], "completed", "{result}");
        assert_eq!(result["result"]["sha256"], sha);
        let growth = peak_rss().saturating_sub(before);
        println!(
            "LAN_RECEIPT_{direction} bytes={total} seconds={:.3} MBps={:.1} rss_growth_MiB={:.2}",
            elapsed.as_secs_f64(),
            total as f64 / elapsed.as_secs_f64() / 1e6,
            growth as f64 / 1048576.0
        );
        assert!(growth <= 64 * 1024 * 1024, "RSS growth exceeded 64 MiB");
    }
    network.stop().await;
}
fn rss() -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut info = std::mem::MaybeUninit::<libc::proc_taskinfo>::uninit();
        let size = std::mem::size_of::<libc::proc_taskinfo>() as i32;
        if unsafe {
            libc::proc_pidinfo(
                std::process::id() as i32,
                libc::PROC_PIDTASKINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        } == size
        {
            return unsafe { info.assume_init() }.pti_resident_size;
        }
    }
    0
}
fn peak_rss() -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } == 0 {
            return unsafe { usage.assume_init() }.ru_maxrss as u64;
        }
    }
    0
}

async fn performance_isolate() -> bool {
    let name = "device_link::transfer::tests::lan_gib_performance";
    if std::env::var("ARC_TRANSFER_PERFORMANCE").ok().as_deref() == Some(name) {
        return false;
    }
    let fixture = Fixture::new();
    let status = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--ignored", "--nocapture"])
        .env("ARC_TRANSFER_PERFORMANCE", name)
        .env("ARC_STATE_DIR", &fixture.directory)
        .status()
        .await
        .unwrap();
    assert!(status.success());
    true
}

fn file_digest(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path).unwrap();
    let mut sha = Sha256::new();
    let mut buffer = vec![0; BLOCK];
    loop {
        let n = file.read(&mut buffer).unwrap();
        if n == 0 {
            break;
        }
        sha.update(&buffer[..n]);
    }
    crate::hex_encode(&sha.finalize())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn interrupted_owner_resumes_only_verified_bytes() {
    // Regression: losing a streaming execution owner left its receipt executing and could resend its verified prefix.
    if isolated("device_link::transfer::tests::interrupted_owner_resumes_only_verified_bytes").await
    {
        return;
    }
    let network = Network::new().await;
    let source = network.directory.join("resume-source");
    let destination = network.directory.join("resume-destination");
    let sha = synthetic(&source, 32 * 1024 * 1024);
    let request = id();
    let ready = execution::pause_after_range_fixture(&request);
    let plan = json!({"requestId":request,"from":{"path":source},"to":{"device":network.device,"path":destination},"expectedSha256":sha});
    network.controller.transfer(plan.clone()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(30), ready.notified())
        .await
        .unwrap();
    execution::interrupt_fixture(&request).await;
    let link = wire::Link::Lan(network.channel.clone());
    let status = link
        .control(json!({"action":"status","requestId":request}))
        .await
        .unwrap();
    assert_eq!(status["offset"], LAN_RANGE);
    let replay = network.controller.transfer(plan).await.unwrap();
    assert_eq!(replay["state"], "unconfirmed");
    network
        .controller
        .transfer(json!({"action":"resume","requestId":request}))
        .await
        .unwrap();
    let done = network.completed(&request).await;
    assert_eq!(done["state"], "completed", "{done}");
    assert_eq!(file_digest(&destination), sha);
    let cancel = id();
    let cancel_path = network.directory.join("cancel-in-flight");
    let ready = execution::pause_after_range_fixture(&cancel);
    network.controller.transfer(json!({"requestId":cancel,"from":{"path":source},"to":{"device":network.device,"path":cancel_path},"expectedSha256":sha})).await.unwrap();
    tokio::time::timeout(Duration::from_secs(30), ready.notified())
        .await
        .unwrap();
    let cancelled = network
        .controller
        .transfer(json!({"action":"cancel","requestId":cancel}))
        .await
        .unwrap();
    assert_eq!(cancelled["state"], "cancelled");
    let status = link
        .control(json!({"action":"status","requestId":cancel}))
        .await
        .unwrap();
    assert!(!Path::new(string(&status, "temporary")).exists());
    assert!(!cancel_path.exists());
    let shared = network.directory.join("queued-destination");
    let first = id();
    let queued = id();
    link.control(
        json!({"action":"begin","requestId":first,"spec":{"path":shared,"total":32*1024*1024}}),
    )
    .await
    .unwrap();
    let queued_channel = network.channel.clone();
    let queued_id = queued.clone();
    let queued_path = shared.clone();
    let waiting = tokio::spawn(async move {
        wire::Link::Lan(queued_channel).control(json!({"action":"begin","requestId":queued_id,"spec":{"path":queued_path,"total":32*1024*1024}})).await
    });
    tokio::task::yield_now().await;
    assert_eq!(
        link.control(json!({"action":"cancel","requestId":queued}))
            .await
            .unwrap()["state"],
        "cancelled"
    );
    link.control(json!({"action":"cancel","requestId":first}))
        .await
        .unwrap();
    assert_eq!(waiting.await.unwrap().unwrap()["state"], "cancelled");
    assert!(!shared.exists());
    network.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_multichunk_upload_does_not_expire_peer_body_deadline() {
    // Regression: device_transfer via relay fails at 0 bytes with DEVICE_TUNNEL_LIMIT: Peer body deadline expired for a 64 KiB file.
    use base64::engine::general_purpose::STANDARD;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{
        tungstenite::{protocol::Role, Message},
        WebSocketStream,
    };
    if isolated(
        "device_link::transfer::tests::relay_multichunk_upload_does_not_expire_peer_body_deadline",
    )
    .await
    {
        return;
    }
    let network = Network::new().await;
    let member = &network.member;
    let ingress = crate::ingress::Ingress::with_execution(json!({"id":"relay-fixture","name":"Example relay","controlSource":"custom","transport":"relay","auth":"none","enabled":true,"config":crate::ingress::config::defaults()}), None, "fixture".into()).unwrap();
    ingress
        .connected
        .store(true, std::sync::atomic::Ordering::SeqCst);
    member.attach_ingress(&ingress);
    let (listener, local) =
        crate::https::listen(ingress.clone(), &json!({"httpsProvider":"fixture"}))
            .await
            .unwrap();
    let local = format!("http://{local}");
    let session = super::super::tunnel::Client::default();
    let (_, token) = session
        .prepare(
            &network.identity,
            &member.identity().unwrap().id,
            &format!("{local}/arc-peer/3"),
        )
        .await
        .unwrap();
    let (native, worker) = tokio::io::duplex(256 * 1024);
    let native = WebSocketStream::from_raw_socket(native, Role::Client, None).await;
    let mut worker = WebSocketStream::from_raw_socket(worker, Role::Server, None).await;
    let url = format!("{local}/arc-peer/3");
    let relay = tokio::spawn(async move { crate::relay::transport::run(native, &local).await });
    let data = vec![42; 64 * 1024];
    let request = id();
    let destination = network.directory.join("relay-upload");
    let sha = digest(&data);

    super::super::tunnel::post(&url, "transfer/control", Some(&token), json!({"version":VERSION,"action":"begin","requestId":request,"spec":{"path":destination,"total":data.len(),"expectedSha256":sha}}), Duration::from_secs(25)).await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(12), async {
        // The deployed 0.9.42 Worker retains Content-Length and waits for one
        // request-credit after each 32 KiB request-chunk, including the last.
        let bytes = serde_json::to_vec(&json!({"version":VERSION,"action":"put","requestId":request,"offset":0,"sha256":sha,"data":STANDARD.encode(&data)})).unwrap();
        let chunks: Vec<_> = bytes.chunks(32768).collect();
        assert!(chunks.len() >= 3);
        let send_frame = |frame: Value| Message::Text(frame.to_string().into());
        worker.send(send_frame(json!({"type":"request","id":"upload","method":"POST","path":"/arc-peer/3/transfer/control","headers":[["content-length",bytes.len().to_string()],["content-type","application/json"],["authorization",format!("Bearer {token}")]]}))).await.unwrap();
        let mut response = Vec::new();
        let mut uploaded = 0;
        worker.send(send_frame(json!({"type":"request-chunk","id":"upload","data":STANDARD.encode(chunks[uploaded])}))).await.unwrap();
        uploaded += 1;
        loop {
            let message = worker.next().await.unwrap().unwrap();
            let text = message.to_text().unwrap();
            if text == "ping" { worker.send(Message::Text("pong".into())).await.unwrap(); continue; }
            let frame: Value = serde_json::from_str(text).unwrap();
            match string(&frame,"type") {
                "request-credit" => {
                    if uploaded < chunks.len() {
                        tokio::time::sleep(Duration::from_millis(2600)).await;
                        worker.send(send_frame(json!({"type":"request-chunk","id":"upload","data":STANDARD.encode(chunks[uploaded])}))).await.unwrap();
                        uploaded += 1;
                    } else {
                        worker.send(send_frame(json!({"type":"request-end","id":"upload"}))).await.unwrap();
                    }
                }
                "response" => {
                    assert_eq!(frame["status"],200);
                    worker.send(send_frame(json!({"type":"response-credit","id":"upload"}))).await.unwrap();
                }
                "response-chunk" => {
                    response.extend(STANDARD.decode(string(&frame,"data")).unwrap());
                    worker.send(send_frame(json!({"type":"response-credit","id":"upload"}))).await.unwrap();
                }
                "response-end" => break,
                _ => panic!("Unexpected relay frame: {frame}"),
            }
        }
        let response: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(response["ok"],true,"{response}; sent {uploaded} chunks");
        assert_eq!(response["result"]["offset"],data.len());
    }).await;
    relay.abort();
    let _ = relay.await;
    result.unwrap();
    let committed = super::super::tunnel::post(
        &url,
        "transfer/control",
        Some(&token),
        json!({"version":VERSION,"action":"commit","requestId":request}),
        Duration::from_secs(25),
    )
    .await;
    // Commit before stopping the ingress.
    assert_eq!(committed.unwrap()["sha256"], sha);
    assert_eq!(std::fs::read(&destination).unwrap(), data);
    listener.abort();
    let _ = listener.await;
    network.stop().await;
}

#[tokio::test]
async fn relay_six_hundred_kb_survives_two_second_credit_rtt_in_both_directions() {
    // Regression: 600 KB relay transfer fails at the 25 s deadline with approximately 2 s credit RTT.
    if isolated("device_link::transfer::tests::relay_six_hundred_kb_survives_two_second_credit_rtt_in_both_directions").await { return; }
    let network = Network::new().await;
    let mut relay = relay_fixture::Relay::new(&network.member).await;
    let session = super::super::tunnel::Client::default();
    let (url, token) = session
        .prepare(&network.identity, &network.device, &relay.url)
        .await
        .unwrap();
    let link = wire::Link::Tunnel {
        url,
        token,
        closed: session.subscribe(),
    };
    // Measure the real native TCP/WebSocket and ingress hops before adding delay.
    let source = network.directory.join("relay-source");
    let sha = synthetic(&source, 600_000);
    let warm_size = 512 * 1024;
    let warm = id();
    let warm_path = network.directory.join("relay-warm");
    link.control(
        json!({"action":"begin","requestId":warm,"spec":{"path":warm_path,"total":warm_size}}),
    )
    .await
    .unwrap();
    link.upload(&warm, &source, 0, warm_size).await.unwrap();
    link.control(json!({"action":"commit","requestId":warm}))
        .await
        .unwrap();
    let stamp = link
        .control(json!({"action":"stat","path":warm_path}))
        .await
        .unwrap();
    let store = Store::default();
    let received = id();
    let directory = network.directory.join("relay-receivers");
    let warm_download = network.directory.join("relay-warm-download");
    store
        .begin(
            &directory,
            &received,
            json!({"path":warm_download,"total":warm_size}),
        )
        .await
        .unwrap();
    let entry = store.get(&directory, &received).await.unwrap();
    link.download(
        &received,
        warm_path.to_str().unwrap(),
        &stamp,
        &mut *entry.lock().await,
        warm_size,
    )
    .await
    .unwrap();
    entry.lock().await.commit().unwrap();
    {
        let metrics = relay.metrics.lock().unwrap();
        for (direction, samples) in [
            ("request", &metrics.upload),
            ("response", &metrics.download),
        ] {
            let max = samples.iter().max().unwrap();
            let mean = samples.iter().sum::<Duration>() / samples.len() as u32;
            eprintln!("Native {direction} credit over loopback TCP: {} samples, mean {mean:?}, max {max:?}",samples.len());
            assert!(
                *max < Duration::from_millis(500),
                "Native {direction} credit stalled: {max:?}"
            );
        }
    }
    // Keep the runtime runnable so only observed relay credits advance time.
    tokio::time::pause();
    let clock = tokio::spawn(async {
        loop {
            tokio::task::yield_now().await;
        }
    });
    *relay.delay.lock().unwrap() = Duration::from_secs(2);
    let request = id();
    let destination = network.directory.join("relay-upload");
    link.control(json!({"action":"begin","requestId":request,"spec":{"path":destination,"total":600_000,"expectedSha256":sha}})).await.unwrap();
    let mut offset = 0;
    let mut upload_time = Duration::ZERO;
    let mut max_upload = Duration::ZERO;
    while offset < 600_000 {
        let length = link.range().min(600_000 - offset);
        let started = tokio::time::Instant::now();
        let meta = link
            .upload(&request, &source, offset, length)
            .await
            .unwrap();
        let elapsed = started.elapsed();
        assert!(elapsed < Duration::from_secs(20));
        upload_time += elapsed;
        max_upload = max_upload.max(elapsed);
        offset += length;
        assert_eq!(meta["offset"], offset);
        // Resume uses the acknowledged offset under the same request ID.
        assert_eq!(
            link.control(json!({"action":"status","requestId":request}))
                .await
                .unwrap()["offset"],
            offset
        );
    }
    assert_eq!(
        link.control(json!({"action":"commit","requestId":request}))
            .await
            .unwrap()["sha256"],
        sha
    );
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        std::fs::read(&source).unwrap()
    );
    let downloaded = network.directory.join("relay-download");
    let request = id();
    store
        .begin(
            &directory,
            &request,
            json!({"path":downloaded,"total":600_000,"expectedSha256":sha}),
        )
        .await
        .unwrap();
    let stamp = link
        .control(json!({"action":"stat","path":destination}))
        .await
        .unwrap();
    let entry = store.get(&directory, &request).await.unwrap();
    let mut receiver = entry.lock().await;
    let mut download_time = Duration::ZERO;
    let mut max_download = Duration::ZERO;
    while receiver.offset() < 600_000 {
        let length = link.range().min(600_000 - receiver.offset());
        let started = tokio::time::Instant::now();
        link.download(
            &request,
            destination.to_str().unwrap(),
            &stamp,
            &mut receiver,
            length,
        )
        .await
        .unwrap();
        let elapsed = started.elapsed();
        assert!(elapsed < Duration::from_secs(20));
        download_time += elapsed;
        max_download = max_download.max(elapsed);
    }
    assert_eq!(receiver.commit().unwrap()["sha256"], sha);
    assert_eq!(
        std::fs::read(&downloaded).unwrap(),
        std::fs::read(&source).unwrap()
    );
    eprintln!("Injected 2 s credit RTT, 600000 bytes each direction: upload max range {max_upload:?}, {:.0} B/s; download max range {max_download:?}, {:.0} B/s",600_000.0/upload_time.as_secs_f64(),600_000.0/download_time.as_secs_f64());
    *relay.delay.lock().unwrap() = Duration::ZERO;
    clock.abort();
    let _ = clock.await;
    tokio::time::resume();
    relay.stop().await;
    network.stop().await;
}
