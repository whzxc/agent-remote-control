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
