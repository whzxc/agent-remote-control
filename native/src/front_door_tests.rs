//! HTTP contract harness. The child uses a fresh state directory and no Agent runtime.
use crate::*;
use std::sync::atomic::Ordering;

async fn wire(response: reqwest::Response) -> Value {
    let status = response.status().as_u16();
    let mut headers = serde_json::Map::new();
    for name in [
        "content-type",
        "cache-control",
        "www-authenticate",
        "allow",
        "referrer-policy",
        "x-content-type-options",
    ] {
        if let Some(value) = response.headers().get(name) {
            headers.insert(name.into(), json!(value.to_str().unwrap()));
        }
    }
    json!({"status":status,"headers":headers,"body":response.text().await.unwrap()})
}

#[tokio::test]
async fn mcp_browser_oauth_local_wire_contract() {
    // Contract: MCP, browser and private management preserve their HTTP authentication and result envelopes.
    if isolated().await {
        return;
    }
    init_crypto();
    crate::sources::initialize().unwrap();
    let service = service::Service::new().unwrap();
    let local = transport::listen(service.clone(), None).await.unwrap();
    let ingress = ingress::Ingress::new(json!({"id":"wire","name":"Wire fixture","controlSource":"custom","transport":"https","auth":"bearer","bearerToken":"fixture-token","enabled":true,"toolPolicy":"all","config":ingress::config::defaults()}), service.execution.clone(), service.token.clone()).unwrap();
    ingress
        .port
        .store(service.port.load(Ordering::SeqCst), Ordering::SeqCst);
    *ingress.mcp_url.lock().await = "https://wire.example/mcp".into();
    ingress.connected.store(true, Ordering::SeqCst);
    let (https, address) = https::listen(ingress.clone(), &json!({"httpsProvider":"relay"}))
        .await
        .unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let base = format!("http://{address}");
    let local_base = format!("http://127.0.0.1:{}", service.port.load(Ordering::SeqCst));
    let access = crate::browser::access(service.entries().await, false)
        .await
        .unwrap();
    let ping = json!({"jsonrpc":"2.0","id":7,"method":"ping"});
    let mut cases = serde_json::Map::new();
    cases.insert(
        "mcp_denied".into(),
        wire(
            client
                .post(format!("{base}/mcp"))
                .json(&ping)
                .send()
                .await
                .unwrap(),
        )
        .await,
    );
    cases.insert(
        "mcp_allowed".into(),
        wire(
            client
                .post(format!("{base}/mcp"))
                .bearer_auth("fixture-token")
                .header("Accept", "application/json")
                .header("X-ARC-Ingress-Id", "forged")
                .header("X-ARC-Source-Id", "forged")
                .json(&ping)
                .send()
                .await
                .unwrap(),
        )
        .await,
    );
    cases.insert(
        "mcp_method".into(),
        wire(
            client
                .get(format!("{base}/mcp"))
                .bearer_auth("fixture-token")
                .send()
                .await
                .unwrap(),
        )
        .await,
    );
    cases.insert(
        "browser_denied".into(),
        wire(
            client
                .get(format!("{base}/view-api/preferences"))
                .send()
                .await
                .unwrap(),
        )
        .await,
    );
    cases.insert(
        "browser_allowed".into(),
        wire(
            client
                .get(format!("{base}/view-api/preferences"))
                .bearer_auth(string(&access, "key"))
                .send()
                .await
                .unwrap(),
        )
        .await,
    );
    cases.insert(
        "browser_write".into(),
        wire(
            client
                .post(format!("{base}/view-api/ingress/stop-all"))
                .bearer_auth(string(&access, "key"))
                .send()
                .await
                .unwrap(),
        )
        .await,
    );
    cases.insert(
        "local_denied".into(),
        wire(
            client
                .get(format!("{local_base}/api/preferences"))
                .send()
                .await
                .unwrap(),
        )
        .await,
    );
    cases.insert(
        "local_allowed".into(),
        wire(
            client
                .get(format!("{local_base}/api/preferences"))
                .bearer_auth(&service.token)
                .header("X-ARC-Source-Id", "forged")
                .send()
                .await
                .unwrap(),
        )
        .await,
    );
    cases.insert(
        "local_origin".into(),
        wire(
            client
                .get(format!("{local_base}/api/preferences"))
                .bearer_auth(&service.token)
                .header("Origin", "https://forged.example")
                .send()
                .await
                .unwrap(),
        )
        .await,
    );
    // Also keep the complete cached tool definitions and text-result wire shape under comparison.
    let tools = client
        .post(format!("{base}/mcp"))
        .bearer_auth("fixture-token")
        .header("Accept", "application/json")
        .json(&json!({"jsonrpc":"2.0","id":8,"method":"tools/list"}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(tools["result"]["tools"], catalog()["tools"]);
    let source = crate::sources::connect_ingress(&ingress.meta.lock().await.clone())
        .await
        .unwrap();
    assert_eq!(source["ingressId"], "wire");
    let actual = Value::Object(cases);
    compare_wire(actual);
    let page = client
        .get(format!("{base}/?key={}", string(&access, "key")))
        .send()
        .await
        .unwrap();
    assert_eq!(page.status(), 200);
    let cookie = page
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(cookie.ends_with("; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict"));
    let cookie = cookie.split(';').next().unwrap();
    let reopened = wire(
        client
            .get(format!("{base}/view-api/preferences"))
            .header("Cookie", cookie)
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(reopened, actual_browser_wire());
    let mut browser_events = client
        .get(format!("{base}/view-api/subscriptions/events"))
        .bearer_auth(string(&access, "key"))
        .send()
        .await
        .unwrap()
        .bytes_stream();
    let mut local_events = client
        .get(format!("{local_base}/api/subscriptions/events"))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap()
        .bytes_stream();
    use futures_util::StreamExt;
    let browser_frame =
        tokio::time::timeout(std::time::Duration::from_secs(2), browser_events.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    let local_frame = tokio::time::timeout(std::time::Duration::from_secs(2), local_events.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(snapshot_frame(&browser_frame), snapshot_frame(&local_frame));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(25), browser_events.next())
            .await
            .is_err()
    );
    drop(local_events);
    crate::browser::access(service.entries().await, true)
        .await
        .unwrap();
    assert_eq!(
        client
            .get(format!("{base}/view-api/preferences"))
            .header("Cookie", cookie)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );

    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while browser_events.next().await.is_some() {}
    })
    .await
    .unwrap();
    let code = ingress.verification.lock().await["code"].clone();
    let verify = json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"act","arguments":{"op":"connector_verify","args":{"code":code}}}});
    let verified = client
        .post(format!("{base}/mcp"))
        .bearer_auth("fixture-token")
        .header("Accept", "application/json")
        .header("X-ARC-Ingress-Id", "forged")
        .header("X-ARC-Source-Id", "forged")
        .json(&verify)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(verified["result"]["content"].as_array().unwrap().len(), 1);
    assert_eq!(verified["result"]["content"][0]["type"], "text");
    let result = crate::egress::tool_value(&verified["result"]).unwrap();
    assert_eq!(result["origin"]["ingressId"], "wire");
    assert_eq!(result["origin"]["sourceId"], source["id"]);
    assert_eq!(result["received"], true);
    let principal = ingress.authenticate("Bearer fixture-token").await.unwrap();
    crate::sources::disconnect(string(&source, "id"))
        .await
        .unwrap();
    let cached = crate::front_door::mcp_ingress_authenticated(
        &ingress,
        ping.clone(),
        &principal,
        Some("Bearer fixture-token"),
    )
    .await
    .unwrap_err();
    assert!(cached.starts_with("SOURCE_REVOKED:"));
    let reconnect = client
        .post(format!("{base}/mcp"))
        .bearer_auth("fixture-token")
        .header("Accept", "application/json")
        .header("Mcp-Session-Id", "old-session")
        .header("X-ARC-Source-Id", "forged")
        .json(&ping)
        .send()
        .await
        .unwrap();
    assert_eq!(reconnect.status(), 400);
    assert_eq!(
        reconnect.json::<Value>().await.unwrap(),
        json!({"error":"invalid MCP request"})
    );
    oauth_wire(&service).await;
    https.abort();
    local.abort();
    let _ = https.await;
    let _ = local.await;
    service.stop().await.unwrap();
}

async fn isolated() -> bool {
    if std::env::var_os("ARC_FRONT_DOOR_TEST_CHILD").is_none() {
        let directory = std::env::temp_dir().join(format!("arc-front-door-{}", id()));
        let result = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "front_door_tests::mcp_browser_oauth_local_wire_contract",
                "--nocapture",
            ])
            .env("ARC_FRONT_DOOR_TEST_CHILD", "1")
            .env("ARC_STATE_DIR", &directory)
            .env("CODEX_HOME", directory.join("codex"))
            .env("HOME", &directory)
            .status()
            .await
            .unwrap();
        let _ = std::fs::remove_dir_all(directory);
        assert!(result.success());
        return true;
    }
    false
}

fn compare_wire(actual: Value) {
    if let Some(path) = std::env::var_os("ARC_CAPTURE_FRONT_DOOR_WIRE") {
        std::fs::write(path, serde_json::to_vec_pretty(&actual).unwrap()).unwrap();
    } else {
        let expected: Value = serde_json::from_str(include_str!("front_door_wire.json")).unwrap();
        assert_eq!(actual, expected);
    }
}

fn actual_browser_wire() -> Value {
    let baseline: Value = serde_json::from_str(include_str!("front_door_wire.json")).unwrap();
    baseline["browser_allowed"].clone()
}

async fn oauth_wire(service: &Arc<service::Service>) {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let resource = "https://oauth-wire.example/mcp";
    service.request("ingress", "POST", json!({"id":"oauthwire","name":"OAuth wire fixture","controlSource":"custom","transport":"https","auth":"oauth","toolPolicy":"all","config":{"httpsProvider":"custom","httpsUrl":resource}})).await.unwrap();
    let ingress = service.ingress("oauthwire").await.unwrap();
    *ingress.mcp_url.lock().await = resource.into();
    ingress.connected.store(true, Ordering::SeqCst);
    let (listener, address) = https::listen(ingress.clone(), &json!({"httpsProvider":"relay"}))
        .await
        .unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let base = format!("http://{address}");
    let registration = client.post(format!("{base}/oauth/register")).json(&json!({"client_name":"Wire fixture","redirect_uris":["http://127.0.0.1:43210/callback"],"token_endpoint_auth_method":"none"})).send().await.unwrap();
    assert_eq!(registration.status(), 201);
    let registered = registration.json::<Value>().await.unwrap();
    let verifier = "v".repeat(43);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    let mut params = std::collections::BTreeMap::from([
        (
            "client_id".into(),
            string(&registered, "client_id").to_owned(),
        ),
        (
            "redirect_uri".into(),
            "http://127.0.0.1:43210/callback".into(),
        ),
        ("response_type".into(), "code".into()),
        ("resource".into(), resource.into()),
        ("code_challenge".into(), challenge),
        ("code_challenge_method".into(), "S256".into()),
    ]);
    let key = ingress
        .oauth
        .lock()
        .await
        .authorize(&params, resource)
        .await
        .unwrap();
    ingress
        .oauth
        .lock()
        .await
        .decide(&key, true, Some("new"))
        .await
        .unwrap();
    let redirect = ingress
        .oauth
        .lock()
        .await
        .resume(&key, resource)
        .await
        .unwrap()
        .unwrap();
    let code = reqwest::Url::parse(&redirect)
        .unwrap()
        .query_pairs()
        .find(|(name, _)| name == "code")
        .unwrap()
        .1
        .into_owned();
    params.insert("grant_type".into(), "authorization_code".into());
    params.insert("code".into(), code);
    params.insert("code_verifier".into(), verifier);
    let tokens = client
        .post(format!("{base}/oauth/token"))
        .form(&params)
        .send()
        .await
        .unwrap();
    assert_eq!(tokens.status(), 200);
    let tokens = tokens.json::<Value>().await.unwrap();
    assert_eq!(tokens["token_type"], "Bearer");
    let header = format!("Bearer {}", string(&tokens, "access_token"));
    let principal = ingress.authenticate(&header).await.unwrap();
    let ping = json!({"jsonrpc":"2.0","id":12,"method":"ping"});
    let admitted = client
        .post(format!("{base}/mcp"))
        .header("Authorization", &header)
        .header("Accept", "application/json")
        .json(&ping)
        .send()
        .await
        .unwrap();
    assert_eq!(admitted.status(), 200);
    assert_eq!(
        admitted.json::<Value>().await.unwrap(),
        json!({"jsonrpc":"2.0","id":12,"result":{"resultType":"complete"}})
    );
    let source = crate::sources::for_grant("oauthwire", string(&principal, "grantId")).unwrap();
    crate::sources::disconnect(string(&source, "id"))
        .await
        .unwrap();
    assert!(crate::front_door::mcp_ingress_authenticated(
        &ingress,
        ping.clone(),
        &principal,
        Some(&header)
    )
    .await
    .unwrap_err()
    .starts_with("SOURCE_REVOKED:"));
    let refused = wire(
        client
            .post(format!("{base}/mcp"))
            .header("Authorization", &header)
            .header("Accept", "application/json")
            .header("Mcp-Session-Id", "cached-session")
            .json(&ping)
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        refused,
        json!({"status":401,"headers":{"cache-control":"no-store","content-type":"application/json","www-authenticate":"Bearer resource_metadata=\"https://oauth-wire.example/.well-known/oauth-protected-resource/mcp\", scope=\"mcp\""},"body":"{\"error\":\"unauthorized\"}"})
    );
    listener.abort();
    let _ = listener.await;
}

fn snapshot_frame(bytes: &[u8]) -> Value {
    let frame = std::str::from_utf8(bytes).unwrap();
    assert!(frame.starts_with("event: snapshot\ndata: "));
    serde_json::from_str(
        frame
            .strip_prefix("event: snapshot\ndata: ")
            .unwrap()
            .trim(),
    )
    .unwrap()
}
