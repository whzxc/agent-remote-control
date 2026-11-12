//! Peer task visibility follows controller-device associations in existing native metadata.
use super::*;

pub(crate) fn peer_device() -> Option<String> {
    let origin = crate::kernel::origin::current_origin();
    (origin["controlTransport"] == "peer").then(|| device_id(&origin).unwrap_or("").to_owned())
}
fn device_id(origin: &Value) -> Option<&str> {
    origin["deviceId"]
        .as_str()
        .or_else(|| origin["ingressId"].as_str()?.strip_prefix("peer:"))
}
pub(crate) fn owns(origin: &Value, device: &str) -> bool {
    !device.is_empty() && origin["authType"] == "peer" && device_id(origin) == Some(device)
}
pub(crate) fn visible(agent: &str, task: &str, source: &str) -> bool {
    if crate::dispatch_policy::records(task)
        .unwrap_or_default()
        .iter()
        .any(|record| owns(&record["origin"], source))
    {
        return true;
    }
    if agent != "codex" && uuid::Uuid::parse_str(task).is_ok() {
        return load(&root().join("agents/tasks").join(format!("{task}.json")))
            .is_ok_and(|record| record["agent"] == agent && owns(&record["origin"], source));
    }
    false
}
fn denied() -> String {
    json!({"code":"DEVICE_TASK_NOT_VISIBLE","message":"Only tasks dispatched by this controller are visible. List codex_tasks or agent_tasks on the paired member; query guide with topic:device.","next":{"via":"query","op":"guide","args":{"topic":"device"}}}).to_string()
}
pub(crate) fn authorize(op: &str, args: &Value, source: &str, session: &str) -> Result<()> {
    // Raw native enumeration cannot expose another controller's task IDs or events.
    if matches!(
        op,
        "codex_query" | "codex_call" | "codex_thread" | "codex_events"
    ) {
        return Err(denied());
    }
    if matches!(op, "codex_pending" | "codex_respond") && !args["threadId"].is_string() {
        return Err(denied());
    }
    let agent = if op.starts_with("codex_") {
        "codex"
    } else {
        string(args, "agent")
    };
    if let Some(task) = args["threadId"].as_str().or(args["taskId"].as_str()) {
        if !visible(agent, task, source) {
            return Err(denied());
        }
    }
    if op == "receipt" {
        let request = string(args, "requestId");
        let mut found = false;
        for directory in ["", "agents/requests"] {
            let store = crate::kernel::receipts::ReceiptStore::new(directory);
            if store.path(request)?.exists() {
                let receipt = store.read(request, session)?;
                if !owns(&receipt["origin"], source) {
                    return Err(denied());
                }
                found = true;
            }
        }
        if !found {
            return Err(denied());
        }
    }
    Ok(())
}
pub(crate) fn filter_activity(value: &mut Value, source: &str) {
    if let Some(agents) = value["agents"].as_object_mut() {
        for (agent, activity) in agents.iter_mut() {
            if let Some(sessions) = activity["sessions"].as_array_mut() {
                sessions.retain(|row| visible(agent, string(row, "id"), source));
            }
        }
        agents.retain(|_, activity| {
            activity["sessions"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty())
        });
        let active = agents.keys().cloned().collect::<Vec<_>>();
        value["activeAgents"] = json!(active);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visibility_requires_dispatch_from_the_authenticated_peer_device() {
        // Property: remote dispatch ownership follows the controller device across peer source renewal.
        let peer = json!({"sourceId":"controller-a","authType":"peer","deviceId":"device-a"});
        let other = json!({"sourceId":"controller-b","authType":"peer","deviceId":"device-b"});
        let local = json!({"sourceId":"controller-a","authType":"local"});
        let renewed = json!({"sourceId":"renewed-source","authType":"peer","deviceId":"device-a"});
        assert!(owns(&peer, "device-a"));
        assert!(owns(&renewed, "device-a"));
        assert!(!owns(&other, "device-a"));
        assert!(!owns(&local, "device-a"));
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    #[tokio::test]
    async fn peer_receipts_keep_controller_attribution_and_hide_foreign_work() {
        // Regression: peer receipt reads exposed member-local work without checking controller dispatch ownership.
        if super::super::tunnel_fixture::isolate("device_link::visibility::integration_tests::peer_receipts_keep_controller_attribution_and_hide_foreign_work").await { return; }
        crate::init_crypto();
        crate::sources::initialize().unwrap();
        crate::preferences::write(json!({"values":{"device-link":"on"}})).unwrap();
        let service = crate::service::Service::new().unwrap();
        let core = crate::transport::listen(service.clone(), None)
            .await
            .unwrap();
        let member = super::super::tests::Fixture::manager(crate::root().join("device-link"));
        let controller =
            Identity::load_or_create(&crate::root().join("controller-identity")).unwrap();
        super::super::tunnel_tests::paired(&member, &controller);
        member.persist(&member.state.lock().unwrap()).unwrap();
        crate::sources::peer_connect(&controller.id, &controller.public_key, "Example controller")
            .await
            .unwrap();
        assert_eq!(
            member.request("snapshot", json!({})).await.unwrap()["controller"]
                ["showUpstreamSources"],
            false
        );
        let request = id();
        let wire = |op: &str, tool: &str, args: Value| json!({"version":VERSION,"tool":tool,"body":{"op":op,"args":args,"requestId":request},"origin":{"sourceId":"upstream-source","sourceLabel":"Example upstream","controlSource":"custom"}});
        let write = member.business_request(&controller.id,wire("notice_post","act",json!({"intent":"Example peer dispatch","resources":["app:installed"],"expectedDurationSeconds":60}))).await.unwrap();
        assert_eq!(write["isError"], false);
        let read = member
            .business_request(
                &controller.id,
                wire(
                    "receipt",
                    "act",
                    json!({"requestId":request,"includeOrigin":true}),
                ),
            )
            .await
            .unwrap();
        let receipt = crate::egress::tool_value(&read).unwrap();
        assert_eq!(receipt["origin"]["deviceId"], controller.id);
        assert_eq!(receipt["origin"]["sourceLabel"], "Example controller");
        assert_eq!(
            receipt["origin"]["peerOrigin"]["sourceId"],
            "upstream-source"
        );
        let foreign = id();
        crate::kernel::receipts::ReceiptStore::new("").reserve(&json!({"requestId":foreign,"operation":"notice_post","state":"completed","backendSession":service.control.session,"origin":{"sourceId":"other-controller","authType":"peer","deviceId":"device-b"},"result":{"threadId":id()},"createdAt":now()})).unwrap();
        let denied = member
            .business_request(
                &controller.id,
                wire("receipt", "act", json!({"requestId":foreign})),
            )
            .await
            .unwrap();
        assert_eq!(
            crate::egress::tool_value(&denied).unwrap()["error"]["code"],
            "DEVICE_TASK_NOT_VISIBLE"
        );
        let listener = tokio::net::TcpListener::bind(lan_sockets(0).unwrap()[0])
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        member
            .request("configure", json!({"port":port,"showUpstreamSources":true}))
            .await
            .unwrap();
        let shown = member.request("snapshot", json!({})).await.unwrap();
        assert_eq!(
            shown["controller"]["upstreamSources"][0]["sourceId"],
            "upstream-source"
        );
        member
            .request("configure", json!({"showUpstreamSources":false}))
            .await
            .unwrap();
        assert_eq!(
            member.request("snapshot", json!({})).await.unwrap()["controller"]["upstreamSources"],
            json!([])
        );
        member.stop().await;
        service.stop().await.unwrap();
        core.abort();
        let _ = core.await;
    }
}
