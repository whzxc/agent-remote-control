#![cfg(unix)]

use arc_core::{load, runtime::Client};
use serde_json::{json, Value};
use std::{net::TcpListener, path::PathBuf, time::Duration};

struct IsolatedCore(PathBuf);

impl IsolatedCore {
    fn pid(&self) -> u32 {
        load(&self.0.join("app/native.json")).unwrap()["pid"]
            .as_u64()
            .unwrap() as u32
    }
}

impl Drop for IsolatedCore {
    fn drop(&mut self) {
        // On assertion failure the fixture may still own a deliberately suspended Core.
        if let Ok(info) = load(&self.0.join("app/native.json")) {
            if let Some(pid) = info["pid"].as_u64() {
                unsafe {
                    libc::kill(pid as i32, libc::SIGCONT);
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }
        }
    }
}

async fn wait_remote(client: &Client) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let health = client.hub_health().await.unwrap();
            if health["core"] == "ready" && health["remoteFaults"] == json!([]) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("Expected remote entrance did not restore");
}

#[tokio::test]
async fn desktop_recovers_core_and_remote_connections_independently() {
    // Regression: a source disconnect stopped its remote transport, and Core replacement left intended connections offline.
    let state =
        IsolatedCore(std::env::temp_dir().join(format!("arc-hub-{}", uuid::Uuid::new_v4())));
    std::env::set_var("ARC_STATE_DIR", &state.0);
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_arc"));
    let client = Client::desktop(
        binary.clone(),
        json!({"port":1,"token":"fixture-local-desktop-authority-0000"}),
    )
    .unwrap();
    client.control_core("start").await.unwrap();
    let original = state.pid();
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    client.request("ingress", "POST", json!({
        "id":"fixture-remote","name":"Fixture remote","controlSource":"claude","transport":"https","auth":"bearer",
        "bearerToken":"fixture-remote-bearer-token-00000000",
        "config":{"httpsProvider":"custom","httpsUrl":"https://arc.example.invalid/mcp","httpsHost":"127.0.0.1","httpsPort":port}
    })).await.unwrap();
    client
        .request("ingress/fixture-remote/start", "POST", json!({}))
        .await
        .unwrap();
    let sources = client.request("source", "GET", Value::Null).await.unwrap();
    let source = sources["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["ingressId"] == "fixture-remote")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    client
        .request(&format!("source/{source}/disconnect"), "POST", json!({}))
        .await
        .unwrap();
    assert_eq!(
        client.hub_health().await.unwrap()["remoteFaults"],
        json!([])
    );
    client
        .request("ingress/fixture-remote/restart", "POST", json!({}))
        .await
        .unwrap();
    assert_eq!(state.pid(), original);

    client.control_core("stop").await.unwrap();
    let stopped = client.hub_health().await.unwrap();
    assert_eq!(stopped["core"], "stopped");
    assert_eq!(stopped["remoteFaults"][0]["id"], "fixture-remote");
    let cli = Client::connect(binary, "cli").await;
    assert!(matches!(cli, Err(error) if error.starts_with("CORE_STOPPED")));
    client.control_core("start").await.unwrap();
    wait_remote(&client).await;
    let restarted = state.pid();
    assert_ne!(restarted, original);

    assert_eq!(unsafe { libc::kill(restarted as i32, libc::SIGSTOP) }, 0);
    assert_eq!(client.hub_health().await.unwrap()["core"], "unavailable");
    client.control_core("restart").await.unwrap();
    wait_remote(&client).await;
    assert_ne!(state.pid(), restarted);
    client
        .request("ingress/fixture-remote/stop", "POST", json!({}))
        .await
        .unwrap();
    client.control_core("stop").await.unwrap();
    client.shutdown().await.unwrap();
    client.control_core("start").await.unwrap();
    let entry = client
        .request("ingress/fixture-remote", "GET", json!({}))
        .await
        .unwrap();
    assert_eq!(entry["state"], "stopped");
    client.control_core("stop").await.unwrap();
}
