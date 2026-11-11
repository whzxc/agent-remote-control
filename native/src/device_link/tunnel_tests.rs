use super::tunnel::*;
use super::*;

pub(super) fn paired(member: &Arc<Manager>, controller: &Identity) {
    member.state.lock().unwrap().stored.controller = Some(Peer {
        device_id: controller.id.clone(),
        public_key: controller.public_key.clone(),
        name: "Example controller".into(),
        addresses: vec![],
        tunnel_url: None,
        address_override: None,
    });
}
#[tokio::test]
async fn challenge_sessions_are_bounded_and_revoked() {
    // Contract: HTTPS peer authentication admits only paired signatures, consumes challenges, expires sessions and invalidates them on revocation.
    if super::tunnel_fixture::isolate(
        "device_link::tunnel_tests::challenge_sessions_are_bounded_and_revoked",
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
    let directory = crate::root();
    let member = super::tests::Fixture::manager(directory.join("member"));
    let controller = Identity::load_or_create(&directory.join("controller")).unwrap();
    let mut provider = super::tunnel_fixture::Provider::new(&member).await;
    let challenge_body = json!({"version":VERSION,"deviceId":controller.id});
    assert!(post(
        &provider.url,
        "challenge",
        None,
        challenge_body.clone(),
        DEADLINE
    )
    .await
    .unwrap_err()
    .contains("DEVICE_UNPAIRED"));
    paired(&member, &controller);
    let challenge = post(
        &provider.url,
        "challenge",
        None,
        challenge_body.clone(),
        DEADLINE,
    )
    .await
    .unwrap();
    let nonce = string(&challenge, "challenge");
    let body = json!({"version":VERSION,"deviceId":controller.id,"challenge":nonce,"signature":controller.sign(transcript(&member.identity().unwrap().id,&controller.id,nonce).as_bytes()).unwrap()});
    let session = post(&provider.url, "session", None, body.clone(), DEADLINE)
        .await
        .unwrap();
    let token = string(&session, "token");
    let hello = json!({"version":VERSION});
    assert_eq!(
        post(&provider.url, "hello", Some(token), hello.clone(), DEADLINE)
            .await
            .unwrap()["deviceId"],
        member.identity().unwrap().id
    );
    assert!(post(&provider.url, "session", None, body, DEADLINE)
        .await
        .unwrap_err()
        .contains("DEVICE_TUNNEL_AUTH"));
    let bad = post(
        &provider.url,
        "challenge",
        None,
        challenge_body.clone(),
        DEADLINE,
    )
    .await
    .unwrap();
    assert!(post(&provider.url,"session",None,json!({"version":VERSION,"deviceId":controller.id,"challenge":bad["challenge"],"signature":"invalid"}),DEADLINE).await.unwrap_err().contains("DEVICE_TUNNEL_AUTH"));
    member
        .tunnel
        .lock()
        .unwrap()
        .tokens
        .get_mut(token)
        .unwrap()
        .1 = Instant::now();
    assert!(
        post(&provider.url, "hello", Some(token), hello.clone(), DEADLINE)
            .await
            .unwrap_err()
            .contains("DEVICE_TUNNEL_AUTH")
    );
    let expired = post(
        &provider.url,
        "challenge",
        None,
        challenge_body.clone(),
        DEADLINE,
    )
    .await
    .unwrap();
    let nonce = string(&expired, "challenge");
    member
        .tunnel
        .lock()
        .unwrap()
        .challenges
        .get_mut(nonce)
        .unwrap()
        .1 = Instant::now();
    assert!(post(&provider.url,"session",None,json!({"version":VERSION,"deviceId":controller.id,"challenge":nonce,"signature":controller.sign(transcript(&member.identity().unwrap().id,&controller.id,nonce).as_bytes()).unwrap()}),DEADLINE).await.unwrap_err().contains("DEVICE_TUNNEL_AUTH"));
    for _ in 0..32 {
        post(
            &provider.url,
            "challenge",
            None,
            challenge_body.clone(),
            DEADLINE,
        )
        .await
        .unwrap();
    }
    assert!(post(
        &provider.url,
        "challenge",
        None,
        challenge_body.clone(),
        DEADLINE
    )
    .await
    .unwrap_err()
    .contains("DEVICE_BUSY"));
    member
        .tunnel
        .lock()
        .unwrap()
        .tokens
        .get_mut(token)
        .unwrap()
        .1 = Instant::now() + Duration::from_secs(60);
    member.tunnel.lock().unwrap().challenges.clear();
    let oversized = reqwest::Client::new()
        .post(format!("{}/request", provider.url))
        .bearer_auth(token)
        .body(vec![b' '; REQUEST_CAP + 1])
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(oversized["error"]["code"], "DEVICE_TUNNEL_LIMIT");
    let mut denied = false;
    for _ in 0..32 {
        let challenge = post(
            &provider.url,
            "challenge",
            None,
            challenge_body.clone(),
            DEADLINE,
        )
        .await
        .unwrap();
        let nonce = string(&challenge, "challenge");
        let result=post(&provider.url,"session",None,json!({"version":VERSION,"deviceId":controller.id,"challenge":nonce,"signature":controller.sign(transcript(&member.identity().unwrap().id,&controller.id,nonce).as_bytes()).unwrap()}),DEADLINE).await;
        if let Err(error) = result {
            assert!(error.contains("DEVICE_BUSY"));
            denied = true;
            break;
        }
    }
    assert!(denied);
    // Restore the pairing after revocation to ensure old bearer tokens still cannot return.
    member.revoke(&controller.id).await.unwrap();
    paired(&member, &controller);
    assert!(post(&provider.url, "hello", Some(token), hello, DEADLINE)
        .await
        .unwrap_err()
        .contains("DEVICE_TUNNEL_AUTH"));
    provider.stop().await;
    core.abort();
    let _ = core.await;
    service.stop().await.unwrap();
}
#[tokio::test]
async fn refused_addresses_finish_without_heartbeat_wait() {
    // Regression: 33 s offline on real MacBook because stale virtual link-local addresses masked all-address refusal.
    let directory = std::env::temp_dir().join(format!("arc-refusal-{}", id()));
    let identity = Identity::load_or_create(&directory).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let started = Instant::now();
    let failure = super::client::Session::default()
        .connect(
            &identity,
            &identity.id,
            &[
                address,
                address,
                "[fe80::1%4294967295]:7143".parse().unwrap(),
            ],
        )
        .await
        .err()
        .unwrap();
    assert!(failure.starts_with("DEVICE_CONNECTION_REFUSED"));
    assert!(started.elapsed() < Duration::from_secs(1));
    let _ = std::fs::remove_dir_all(directory);
}
#[test]
fn bounded_wait_segments_preserve_request_identity() {
    // Contract: provider waits use bounded segments in the unchanged peer request envelope.
    let mut body = json!({"op":"codex_wait","requestId":"original","args":{"timeoutMs":120000}});
    segment(&mut body);
    assert_eq!(body["requestId"], "original");
    assert_eq!(body["args"]["timeoutMs"], 15000);
    assert!(validate_wait(&json!({"body":body})).is_ok());
    assert!(
        validate_wait(&json!({"body":{"op":"codex_wait","args":{"timeoutMs":30000}}}))
            .unwrap_err()
            .contains("DEVICE_TUNNEL_LIMIT")
    );
}
