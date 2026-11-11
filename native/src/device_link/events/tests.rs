use super::*;
#[test]
fn queue_cursor_reports_overflow_and_resets_without_replay() {
    // Contract: peer events are capped at 256, batches at 64; a stale cursor or epoch reports a gap and skips retained events.
    let mut queue = Queue::default();
    for n in 0..CAP + 10 {
        queue.push(json!({"eventId":format!("event-{n}"),"kind":"completed"}));
    }
    let gap = queue.read("epoch", &json!({"epoch":"epoch","cursor":0}));
    assert_eq!(gap["gap"], true);
    assert_eq!(gap["cursor"], CAP + 10);
    assert_eq!(gap["events"], json!([]));
    let fresh = queue.read("epoch", &json!({"epoch":"epoch","cursor":10}));
    assert_eq!(fresh["events"].as_array().unwrap().len(), BATCH);
    assert_eq!(fresh["cursor"], 10 + BATCH);
    assert_eq!(
        queue.read("new", &json!({"epoch":"epoch","cursor":10}))["gap"],
        true
    );
    assert_eq!(
        queue.read("new", &json!({"cursor":null}))["events"],
        json!([])
    );
}
#[tokio::test]
async fn event_long_poll_is_bounded_and_wakes_on_member_event() {
    // Contract: the internal peer request long-polls by cursor, wakes on an event and rejects waits beyond 25 seconds.
    let source = id();
    let baseline = read(&source, &json!({"cursor":null})).await.unwrap();
    let pending_source = source.clone();
    let pending = tokio::spawn(async move {
        read(
            &pending_source,
            &json!({"epoch":baseline["epoch"],"cursor":baseline["cursor"],"waitMs":25000}),
        )
        .await
        .unwrap()
    });
    tokio::task::yield_now().await;
    publish(
        &source,
        json!({"kind":"needs-input","threadId":"task","turnId":"turn"}),
    );
    let events = tokio::time::timeout(Duration::from_secs(1), pending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(events["events"][0]["event"]["kind"], "needs-input");
    assert!(read(&source, &json!({"waitMs":25001}))
        .await
        .unwrap_err()
        .starts_with("INVALID_ARGUMENT:"));
}

async fn isolate_loopback() -> bool {
    if std::env::var_os("ARC_DEVICE_EVENT_TEST_CHILD").is_some() {
        return false;
    }
    let dir = std::env::temp_dir().join(format!("arc-device-event-loopback-{}", id()));
    let status = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "device_link::controller::events::tests::controller_member_notification_loopback",
            "--nocapture",
        ])
        .env("ARC_DEVICE_EVENT_TEST_CHILD", "1")
        .env("ARC_STATE_DIR", &dir)
        .status()
        .await
        .unwrap();
    let _ = std::fs::remove_dir_all(dir);
    assert!(status.success());
    true
}
fn fixture_directory() -> PathBuf {
    crate::root()
}
async fn await_delivery(thread: &str, turn: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let value = crate::claude_notify::read(thread, turn).unwrap();
            if value["deliveries"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty())
            {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn controller_member_notification_loopback() {
    // Contract: forwarded notify binds the originating controller source, member observation delivers only there, offline remains unconfirmed and reconnect reconciles an observed terminal state.
    if isolate_loopback().await {
        return;
    }
    use http_body_util::{BodyExt, Full};
    use hyper::{body::Bytes, service::service_fn, Response};
    use hyper_util::rt::{TokioExecutor, TokioIo};
    use std::convert::Infallible;
    let root = fixture_directory();
    let member_identity =
        Arc::new(Identity::load_or_create(&root.join("member-identity")).unwrap());
    let controller_identity =
        Arc::new(Identity::load_or_create(&root.join("controller-identity")).unwrap());
    let device = member_identity.id.clone();
    let terminal = Arc::new(AtomicBool::new(false));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let manager = crate::device_link::tests::Fixture::manager(root.join("member-identity"));
    manager.state.lock().unwrap().stored.controller = Some(Peer {
        device_id: controller_identity.id.clone(),
        public_key: controller_identity.public_key.clone(),
        name: "Controller".into(),
        addresses: vec![],
        tunnel_url: None,
        address_override: None,
    });
    let acceptor = tls::server(&manager, &member_identity).unwrap();
    let observed_terminal = terminal.clone();
    let server = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                Some(_) = connections.join_next(), if !connections.is_empty()=>{},
                accepted = listener.accept()=>{
                    let (stream,_) = accepted.unwrap();
                    let acceptor = acceptor.clone();
                    let terminal = observed_terminal.clone();
                    connections.spawn(async move {
                        let stream = acceptor.accept(stream).await.unwrap();
                        let service = service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                            let terminal = terminal.clone();
                            async move {
                                let bytes = request.into_body().collect().await.unwrap().to_bytes();
                                let request: Value = serde_json::from_slice(&bytes).unwrap();
                                let body = &request["body"];
                                let op = string(body,"op");
                                let args = &body["args"];
                                let value = if op==OP {
                                    read("member-peer",args).await.unwrap()
                                } else if matches!(op,"codex_create"|"codex_send") {
                                    assert!(args.get("notify").is_none());
                                    let task = if op=="codex_send" { string(args,"threadId") } else if args["title"]=="Second" {"synthetic-second"}else{"synthetic-first"};
                                    crate::kernel::origin::ORIGIN.scope(json!({"sourceId":"member-peer","controlTransport":"peer"}),
                                        crate::claude_notify::bind(args,task,"turn","",json!({"op":"codex_create","requestId":body["requestId"]}))).await.unwrap();
                                    json!({"threadId":task,"turnId":"turn","requestId":body["requestId"]})
                                } else {
                                    assert_eq!(op,"codex_read");
                                    assert_eq!(args["statusOnly"],true);
                                    json!({"threadId":args["threadId"],"turnId":"turn","state":if terminal.load(Ordering::SeqCst){"completed"}else{"running"},"recordedStatus":if terminal.load(Ordering::SeqCst){"completed"}else{"inProgress"}})
                                };
                                Ok::<_,Infallible>(Response::new(Full::new(Bytes::from(json!({"ok":true,"result":crate::egress::tool(value,false)}).to_string()))))
                            }
                        });
                        let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new()).serve_connection(TokioIo::new(stream),service).await;
                    });
                }
            }
        }
    });
    let controller = Controller::new(root.join("controller-identity")).unwrap();
    *controller.identity.lock().unwrap() = Some(controller_identity.clone());
    controller.running.store(true, Ordering::SeqCst);
    let member = Arc::new(Member {
        peer: Peer {
            device_id: device.clone(),
            public_key: member_identity.public_key.clone(),
            name: "Notebook".into(),
            addresses: vec![],
            tunnel_url: None,
            address_override: None,
        },
        status: StdMutex::new(Status {
            online: true,
            ..Default::default()
        }),
        business: Session::default(),
        heartbeat: Session::default(),
        slots: Arc::new(tokio::sync::Semaphore::new(64)),
        task: Default::default(),
        event_task: Default::default(),
    });
    member
        .business
        .connect(&controller_identity, &device, &[address])
        .await
        .unwrap();
    controller
        .members
        .lock()
        .await
        .insert(device.clone(), member.clone());
    let polled = member.clone();
    let poll_controller = controller.clone();
    *member.event_task.lock().unwrap() = Some(tokio::spawn(async move {
        poll_controller.poll_events(polled).await;
    }));
    let notify = json!({"channel":"claude-session","target":"session_010000000000000000000001"});
    let origin = json!({"sourceId":"originating-controller-source"});
    let first = controller
        .forward(
            "act",
            json!({"device":device,"op":"codex_create","args":{"title":"First","notify":notify}}),
            None,
            origin.clone(),
        )
        .await
        .unwrap();
    assert_ne!(first["isError"], true);
    crate::claude_notify::observe("synthetic-first","turn",&json!({"state":"completed","recordedStatus":"completed","finalResponse":"Synthetic completion"})).await.unwrap();
    let first_key = crate::claude_notify::device::key(&device, "synthetic-first");
    assert_eq!(
        await_delivery(&first_key, "turn").await["sourceId"],
        origin["sourceId"]
    );
    crate::claude_notify::tests::deliver_fixture_events(&first_key, "turn").await;
    assert_eq!(
        crate::claude_notify::read(&first_key, "turn").unwrap()["deliveries"][0]["state"],
        "delivered"
    );
    assert!(crate::claude_notify::inbox("member-peer", &[], false, None)
        .await
        .unwrap()
        .is_null());
    let inbox = crate::claude_notify::inbox("originating-controller-source", &[], false, None)
        .await
        .unwrap();
    assert_eq!(inbox["events"][0]["device"]["id"], device);
    assert_eq!(inbox["events"][0]["next"]["op"], "device");
    controller
        .forward(
            "act",
            json!({"device":device,"op":"codex_create","args":{"title":"Second","notify":notify}}),
            None,
            origin,
        )
        .await
        .unwrap();
    controller.forward("act",json!({"device":device,"op":"codex_send","args":{"threadId":"synthetic-first","notify":null}}),None,json!({"sourceId":"originating-controller-source"})).await.unwrap();
    assert!(crate::claude_notify::read(&first_key, "turn")
        .unwrap()
        .is_null());
    let second_key = crate::claude_notify::device::key(&device, "synthetic-second");
    member.status.lock().unwrap().online = false;
    member.business.close().await;
    controller.changed.notify_waiters();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = crate::kernel::origin::ORIGIN
                .scope(
                    json!({"sourceId":"originating-controller-source"}),
                    crate::claude_notify::notify_status(&json!({"threadId":second_key})),
                )
                .await
                .unwrap();
            if status["threads"][0]["diagnosis"]["observation"]["state"] == "unconfirmed" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        crate::claude_notify::read(&second_key, "turn").unwrap()["deliveries"],
        json!([])
    );
    terminal.store(true, Ordering::SeqCst);
    crate::claude_notify::observe(
        "synthetic-second",
        "turn",
        &json!({"state":"completed","recordedStatus":"completed"}),
    )
    .await
    .unwrap();
    member
        .business
        .connect(&controller_identity, &device, &[address])
        .await
        .unwrap();
    member.status.lock().unwrap().online = true;
    controller.changed.notify_waiters();
    assert_eq!(
        await_delivery(&second_key, "turn").await["deliveries"][0]["kind"],
        "completed"
    );
    crate::claude_notify::tests::deliver_fixture_events(&second_key, "turn").await;
    assert_eq!(
        crate::claude_notify::read(&second_key, "turn").unwrap()["deliveries"][0]["state"],
        "delivered"
    );
    controller.stop().await.unwrap();
    server.abort();
    let _ = server.await;
}
