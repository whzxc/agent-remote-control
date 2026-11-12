use super::controller::Controller;
use super::records::{Forward, Records};
use super::*;

#[test]
fn associations_preserve_submission_source_for_event_routing() {
    // Regression: a different receipt reader must not become the task's event destination after removing the extra source gate.
    let mut records = Records::default();
    records.associate(
        "member",
        "source-one",
        &json!({"thread":{"id":"example-task"}}),
    );
    records.associate("member", "source-two", &json!({"threadId":"example-task"}));
    assert_eq!(
        records.task_source("member", "example-task"),
        Some("source-one")
    );
    for index in 0..=super::records::TASK_CAP {
        records.associate(
            "member",
            "source-two",
            &json!({"taskId":format!("other-{index}")}),
        );
    }
    assert_eq!(records.task_source("member", "example-task"), None);
    for index in 0..=super::records::FORWARD_CAP {
        records.record(Forward {
            request_id: format!("request-{index}"),
            device_id: "member".into(),
            op: "command".into(),
            source_id: "source-one".into(),
            sent_at: now(),
            outcome: "completed".into(),
            digest: "example".into(),
            notification: Value::Null,
        });
    }
    records.associate_receipt("member", "request-0", &json!({"taskId":"expired"}));
    assert_eq!(records.task_source("member", "expired"), None);
    records.associate_receipt(
        "member",
        &format!("request-{}", super::records::FORWARD_CAP),
        &json!({"result":{"threadId":"recovered"}}),
    );
    assert_eq!(
        records.task_source("member", "recovered"),
        Some("source-one")
    );
}
#[test]
fn forwarding_wait_bounds_follow_member_arguments() {
    // Property: peer deadlines exceed the member's requested wait bound rather than a fixed short timeout.
    for op in ["codex_wait", "agent_wait", "inbox_wait"] {
        assert!(
            super::client::request_bound(op, &json!({"timeoutMs":1_800_000})).as_millis()
                > 1_800_000
        );
    }
    assert!(
        super::client::request_bound("command", &json!({"waitMs":120000})).as_millis() > 120000
    );
}
#[test]
fn device_discovery_is_full_only_and_dual_tool() {
    // Contract: Device link is disclosed in the full guide and per-op schema without enlarging the common guide.
    let ops = crate::catalog()["ops"].as_array().unwrap();
    let common = crate::egress::guide(&json!({}), &json!({}), "en", ops);
    assert!(common["ops"]
        .as_array()
        .unwrap()
        .iter()
        .all(|op| op["op"] != "device" && op["op"] != "devices"));
    let guide = crate::egress::guide(&json!({}), &json!({"op":"device"}), "en", ops);
    assert_eq!(guide["via"], json!(["query", "act"]));
    let full = crate::egress::guide(&json!({}), &json!({"view":"full"}), "en", ops);
    assert!(full["ops"]
        .as_array()
        .unwrap()
        .iter()
        .any(|op| op["op"] == "devices"));
}
#[test]
fn controller_core_loss_recovers_the_member_receipt() {
    // Contract: a controller Core disconnect retains the member receipt action under the existing private error envelope.
    use crate::front_door::{Deadline, Generation, Operation, Request, RequestId};
    let request = id();
    for body in [
        json!({"op":"notice_post","args":{}}),
        json!({"op":"receipt","args":{"requestId":request,"action":"approve"}}),
    ] {
        let frame = Request {
            version: 3,
            generation: Generation([0; 16]),
            id: RequestId(request.clone()),
            deadline: Deadline::after(Duration::from_secs(5)),
            context: crate::front_door::management_context(),
            operation: Operation::LocalControl,
            body: json!({"op":"device","args":{"device":"example-member","op":body["op"],"args":body["args"]}}),
        };
        let next = crate::front_door::process::forwarded_receipt(&frame).unwrap();
        assert_eq!(next["via"], "act");
        assert_eq!(next["op"], "device");
        assert_eq!(next["args"]["op"], "receipt");
        assert_eq!(next["args"]["args"]["requestId"], request);
    }
}
async fn isolate() -> bool {
    if std::env::var_os("ARC_DEVICE_CONTROLLER_TEST_CHILD").is_some() {
        return false;
    }
    let directory = std::env::temp_dir().join(format!("arc-controller-test-{}", id()));
    let status = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "device_link::controller_tests::controller_member_loopback",
            "--nocapture",
        ])
        .env("ARC_DEVICE_CONTROLLER_TEST_CHILD", "1")
        .env("ARC_STATE_DIR", directory.join("member"))
        .status()
        .await
        .unwrap();
    let _ = std::fs::remove_dir_all(directory);
    assert!(status.success());
    true
}
async fn state(controller: &Controller, online: bool) {
    let result = tokio::time::timeout(Duration::from_secs(if online { 12 } else { 35 }), async {
        loop {
            let changed = controller.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let devices = controller.list(true).await;
            if devices["devices"].as_array().is_some_and(|rows| {
                rows.iter()
                    .any(|row| row["state"] == if online { "online" } else { "offline" })
            }) {
                return;
            }
            changed.await;
        }
    })
    .await;
    assert!(result.is_ok(), "{}", controller.list(true).await);
}
#[tokio::test]
async fn controller_member_loopback() {
    // Contract: native peer forwarding preserves receipt identity and online/offline admission while exposing only tasks dispatched by this controller, excluding member-local and other-controller tasks.
    if isolate().await {
        return;
    }
    crate::sources::initialize().unwrap();
    crate::preferences::write(json!({"values":{"device-link":"on"}})).unwrap();
    let service = crate::service::Service::new().unwrap();
    let core = crate::transport::listen(service.clone(), None)
        .await
        .unwrap();
    let unknown = crate::core_requests::local_control(
        &service,
        json!({"op":"device","requestId":id(),"args":{"device":"missing","op":"guide","args":{}}}),
    )
    .await
    .unwrap();
    assert_eq!(
        crate::egress::tool_value(&unknown).unwrap()["error"]["code"],
        "DEVICE_UNKNOWN"
    );
    let directory = crate::root().parent().unwrap().join("controller");
    let member = super::tests::Fixture::manager(crate::root().join("device-link"));
    // Use the private interface's self-route to exercise the production LAN-only admission policy.
    let listener = tokio::net::TcpListener::bind(lan_sockets(0).unwrap()[0])
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    member
        .request("configure", json!({"port":port,"name":"Example member"}))
        .await
        .unwrap();
    let controller_manager = super::tests::Fixture::manager(directory.join("device-link"));
    let offer = member.request("offer", json!({})).await.unwrap();
    let pair_manager = controller_manager.clone();
    let pair = tokio::spawn(async move {
        pair_manager
            .request("pair", json!({"pairingString":offer["pairingString"]}))
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if member.request("pending", json!({})).await.unwrap()["pending"].is_object() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    member.request("approve", json!({})).await.unwrap();
    let paired = pair.await.unwrap().unwrap();
    let device = paired["deviceId"].as_str().unwrap().to_owned();
    let address = paired["addresses"][0].as_str().unwrap();
    let configured = controller_manager
        .request("address", json!({"device":device,"address":address}))
        .await
        .unwrap();
    assert_eq!(configured["address"], address);
    let controller_source =
        crate::sources::peer_authority(&controller_manager.identity().unwrap().id).unwrap();
    let tasks = [
        (
            id(),
            id(),
            crate::sources::origin(&controller_source, "peer"),
            true,
        ),
        (
            id(),
            id(),
            json!({"sourceId":"member-desktop","authType":"local"}),
            false,
        ),
        (
            id(),
            id(),
            json!({"sourceId":"other-controller-source","authType":"peer","deviceId":hash("Example other controller")}),
            false,
        ),
    ];
    for (task, request, task_origin, _) in &tasks {
        let receipt = json!({
            "requestId":request,"operation":"create","state":"completed",
            "backendSession":service.control.session,"origin":task_origin,
            "threadId":task,"turnId":id(),"dispatchMode":"new-turn",
            "task":{"title":"Example task","dispatch":{"submittedAt":now()}},
            "result":{"threadId":task},"createdAt":now()
        });
        crate::kernel::receipts::ReceiptStore::new("")
            .reserve(&receipt)
            .unwrap();
        crate::dispatch_policy::record(&receipt).unwrap();
    }
    let controller = Controller::new(directory.join("device-link")).unwrap();
    controller.reconcile(true).await.unwrap();
    state(&controller, true).await;
    let origin = json!({"sourceId":"example-controller-source","authType":"oauth"});
    for (task, request, _, visible) in &tasks {
        let read = controller
            .forward(
                "query",
                json!({"device":device,"op":"codex_queue","args":{"threadId":task}}),
                None,
                origin.clone(),
            )
            .await
            .unwrap();
        assert_eq!(read["isError"], !visible, "{read}");
        let task_read = crate::egress::tool_value(&read).unwrap();
        if *visible {
            assert_eq!(task_read["total"], 0);
        } else {
            assert_eq!(task_read["error"]["code"], "DEVICE_TASK_NOT_VISIBLE");
        }
        let receipt = controller
            .forward(
                "act",
                json!({"device":device,"op":"receipt","args":{"requestId":request}}),
                None,
                origin.clone(),
            )
            .await
            .unwrap();
        assert_eq!(receipt["isError"], !visible, "{receipt}");
        let receipt = crate::egress::tool_value(&receipt).unwrap();
        if *visible {
            assert_eq!(receipt["requestId"], *request);
            assert_eq!(receipt["threadId"], *task);
            assert_eq!(receipt["state"], "completed");
        } else {
            assert_eq!(receipt["error"]["code"], "DEVICE_TASK_NOT_VISIBLE");
        }
    }
    let read = controller
        .forward(
            "query",
            json!({"device":"Example member","op":"guide","args":{}}),
            None,
            origin.clone(),
        )
        .await
        .unwrap();
    assert_eq!(read["isError"], false, "{read}");
    let request = id();
    let write=controller.forward("act",json!({"device":device,"op":"notice_post","args":{"intent":"Example native loopback","resources":["app:installed"],"expectedDurationSeconds":60}}),Some(&json!(request)),origin.clone()).await.unwrap();
    assert_eq!(write["isError"], false, "{write}");
    let receipt=controller.forward("act",json!({"device":device,"op":"receipt","args":{"requestId":request,"includeOrigin":true}}),None,origin.clone()).await.unwrap();
    let receipt = crate::egress::tool_value(&receipt).unwrap();
    assert_eq!(receipt["requestId"], request);
    assert_eq!(
        receipt["origin"]["peerOrigin"]["sourceId"],
        origin["sourceId"]
    );
    let other_receipt = controller
        .forward(
            "act",
            json!({"device":device,"op":"receipt","args":{"requestId":request}}),
            None,
            json!({"sourceId":"another-controller-source","authType":"oauth"}),
        )
        .await
        .unwrap();
    assert_eq!(other_receipt["isError"], false, "{other_receipt}");
    assert_eq!(
        crate::egress::tool_value(&other_receipt).unwrap()["requestId"],
        request
    );
    let duplicate=controller.forward("act",json!({"device":device,"op":"notice_post","args":{"intent":"Example native loopback","resources":["app:installed"],"expectedDurationSeconds":60}}),Some(&json!(request)),origin.clone()).await.unwrap_err();
    let duplicate = serde_json::from_str::<Value>(&duplicate).unwrap();
    assert_eq!(duplicate["code"], "DEVICE_OUTCOME_UNCERTAIN");
    assert_eq!(duplicate["next"]["via"], "act");
    assert_eq!(duplicate["next"]["args"]["op"], "receipt");
    let lost = id();
    let gate = Arc::new(ReplyGate {
        request_id: lost.clone(),
        ready: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    *member.reply_gate.lock().unwrap() = Some(gate.clone());
    let lost_controller = controller.clone();
    let lost_device = device.clone();
    let lost_origin = origin.clone();
    let lost_request = lost.clone();
    let pending = tokio::spawn(async move {
        lost_controller.forward("act",json!({"device":lost_device,"op":"notice_post","args":{"intent":"Example lost response","resources":["app:installed"],"expectedDurationSeconds":60}}),Some(&json!(lost_request)),lost_origin).await
    });
    tokio::time::timeout(Duration::from_secs(5), gate.ready.notified())
        .await
        .unwrap();
    member.stop().await;
    let uncertain = serde_json::from_str::<Value>(&pending.await.unwrap().unwrap_err()).unwrap();
    assert_eq!(uncertain["code"], "DEVICE_OUTCOME_UNCERTAIN");
    assert_eq!(uncertain["requestId"], lost);
    assert_eq!(uncertain["next"]["via"], "act");
    *member.reply_gate.lock().unwrap() = None;
    controller.stop().await.unwrap();
    member.reconcile(true).await.unwrap();
    controller.reconcile(true).await.unwrap();
    state(&controller, true).await;
    let recovered = controller
        .forward(
            "act",
            uncertain["next"]["args"].clone(),
            None,
            origin.clone(),
        )
        .await
        .unwrap();
    let recovered = crate::egress::tool_value(&recovered).unwrap();
    assert_eq!(recovered["requestId"], lost);
    assert_eq!(recovered["state"], "completed");
    // Exhaust fresh-handshake admission; established business and heartbeat channels keep working.
    let identity = controller_manager.identity().unwrap();
    let peer = controller_manager.state.lock().unwrap().stored.members[&device].clone();
    let addresses = vec![lan_sockets(port).unwrap()[0]];
    let mut refused = false;
    for _ in 0..40 {
        let session = super::client::Session::default();
        if session
            .connect(&identity, &peer.device_id, &addresses)
            .await
            .is_err()
        {
            refused = true;
            break;
        }
        session.close().await;
    }
    assert!(refused);
    let waiting_controller = controller.clone();
    let waiting_origin = origin.clone();
    let waiting_device = device.clone();
    let waiting = tokio::spawn(async move {
        waiting_controller
            .forward(
                "query",
                json!({"device":waiting_device,"op":"inbox_wait","args":{"timeoutMs":30000}}),
                None,
                waiting_origin,
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(25)).await;
    let read = tokio::time::timeout(
        Duration::from_secs(2),
        controller.forward(
            "query",
            json!({"device":device,"op":"guide","args":{}}),
            None,
            origin.clone(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(read["isError"], false);
    assert!(!waiting.is_finished());
    // A heartbeat completes while the member wait is still active, using its independent channel.
    let previous = controller.list(true).await["devices"][0]["lastSeen"].clone();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let changed = controller.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if controller.list(true).await["devices"][0]["lastSeen"] != previous {
                break;
            }
            changed.await;
        }
    })
    .await
    .unwrap();
    assert!(!waiting.is_finished());
    waiting.abort();
    let _ = waiting.await;
    member.stop().await;
    state(&controller, false).await;
    assert!(controller.list(false).await["devices"]
        .as_array()
        .unwrap()
        .is_empty());
    let not_sent = id();
    let error=controller.forward("act",json!({"device":device,"op":"notice_post","args":{"intent":"Must remain unsent","resources":["app:installed"],"expectedDurationSeconds":60}}),Some(&json!(not_sent)),origin).await.unwrap_err();
    let error = serde_json::from_str::<Value>(&error).unwrap();
    assert_eq!(error["code"], "DEVICE_OFFLINE");
    assert_eq!(error["next"]["op"], "devices");
    let absent = crate::core_requests::local_control(
        &service,
        json!({"op":"receipt","args":{"requestId":not_sent}}),
    )
    .await
    .unwrap();
    assert_eq!(
        crate::egress::tool_value(&absent).unwrap()["state"],
        "not-found"
    );
    controller.stop().await.unwrap();
    service.stop().await.unwrap();
    core.abort();
    let _ = core.await;
}
