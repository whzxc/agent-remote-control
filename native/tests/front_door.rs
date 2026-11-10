//! Isolated process fixture. No real providers, credentials or Agent accounts are used.
#[cfg(unix)]
mod unix {
    use serde_json::{json, Value};
    use std::{
        path::PathBuf,
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };

    struct Fixture {
        directory: PathBuf,
        core: Option<Child>,
        front: Option<u32>,
        endpoint: Value,
        lost_response: String,
        callback: Option<String>,
    }
    impl Fixture {
        async fn new() -> Self {
            arc_core::init_crypto();
            use std::os::unix::fs::PermissionsExt;
            let directory = std::env::temp_dir().join(format!("arc-fd-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(directory.join("home")).unwrap();
            std::fs::create_dir_all(directory.join("installed")).unwrap();
            std::fs::copy(env!("CARGO_BIN_EXE_arc"), directory.join("installed/arc")).unwrap();
            let provider = directory.join("provider");
            std::fs::write(&provider,"#!/bin/sh\ncase \"$1\" in\n--version) echo 'tunnel-client 0.0.16'; exit 0;;\ninit) exit 0;;\nrun) echo $$ > \"$ARC_PROVIDER_FIXTURE_PID\"; trap 'exit 0' TERM INT; while :; do sleep 1; done;;\nesac\n").unwrap();
            std::fs::set_permissions(&provider, std::fs::Permissions::from_mode(0o700)).unwrap();
            let mut fixture = Self {
                directory,
                core: None,
                front: None,
                endpoint: Value::Null,
                lost_response: uuid::Uuid::new_v4().to_string(),
                callback: None,
            };
            fixture.start().await;
            fixture
        }
        fn command(&self) -> Command {
            let mut command = Command::new(self.directory.join("installed/arc"));
            command
                .env("ARC_STATE_DIR", self.directory.join("state"))
                .env("HOME", self.directory.join("home"))
                .env("CODEX_HOME", self.directory.join("home/.codex"))
                .env(
                    "ARC_PROVIDER_FIXTURE_PID",
                    self.directory.join("provider.pid"),
                );
            command.env(
                "ARC_FIXTURE_FRONT_DOOR_INCOMPATIBLE",
                self.directory.join("incompatible"),
            );
            command
                .env("ARC_FIXTURE_LOST_RESPONSE_ID", &self.lost_response)
                .env(
                    "ARC_FIXTURE_LOST_RESPONSE_GATE",
                    self.directory.join("response-gate"),
                );
            if let Some(callback) = &self.callback {
                command.env("ARC_FIXTURE_WEBHOOK", callback);
            }
            for key in [
                "ARC_DEV_INSTANCE_ID",
                "ARC_DEV_OWNER_ID",
                "ARC_DEV_TAKEOVER",
            ] {
                command.env_remove(key);
            }
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit());
            command
        }
        fn observation(&self, name: &str) -> Value {
            let file = match name {
                "native" => self.directory.join("state/app/native.json"),
                "front" => self.directory.join("state/app/front-door.json"),
                _ => panic!("unknown observation"),
            };
            std::fs::read(file)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or(Value::Null)
        }
        async fn start(&mut self) {
            self.core = Some(self.command().arg("daemon").spawn().unwrap());
            let until = Instant::now() + Duration::from_secs(20);
            loop {
                let endpoint = self.observation("native");
                if endpoint["pid"] == self.core.as_ref().unwrap().id() {
                    self.endpoint = endpoint;
                    self.front = self.observation("front")["pid"].as_u64().map(|p| p as u32);
                    break;
                }
                assert!(
                    self.core.as_mut().unwrap().try_wait().unwrap().is_none(),
                    "fixture Core exited"
                );
                assert!(Instant::now() < until, "fixture startup timed out");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let until = Instant::now() + Duration::from_secs(10);
            loop {
                let ready = self
                    .management(
                        "cli/control",
                        "POST",
                        json!({"op":"notify_status","args":{}}),
                    )
                    .await;
                if ready["isError"] != true {
                    break;
                }
                assert!(
                    Instant::now() < until,
                    "notification owner startup timed out: {ready}"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        fn kill_core(&mut self) {
            let mut core = self.core.take().unwrap();
            core.kill().unwrap();
            core.wait().unwrap();
        }
        async fn replace(&mut self) {
            self.kill_core();
            self.start().await;
        }
        async fn public_rpc(&self, port: u16, body: Value) -> Value {
            reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap()
                .post(format!("http://127.0.0.1:{port}/mcp"))
                .bearer_auth("synthetic-bearer-token-with-32-characters")
                .header("Mcp-Session-Id", "synthetic-session")
                .json(&body)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap()
        }
        async fn frame(response: &mut reqwest::Response) -> String {
            tokio::time::timeout(Duration::from_secs(10), async {
                let mut bytes = Vec::new();
                loop {
                    bytes.extend_from_slice(
                        &response.chunk().await.unwrap().expect("stream closed"),
                    );
                    if bytes.ends_with(b"\n\n") {
                        return String::from_utf8(bytes).unwrap();
                    }
                }
            })
            .await
            .expect("stream frame timed out")
        }
        async fn management(&self, route: &str, method: &str, body: Value) -> Value {
            let response = reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .request(
                    method.parse().unwrap(),
                    format!("http://127.0.0.1:{}/api/{route}", self.endpoint["port"]),
                )
                .bearer_auth(self.endpoint["token"].as_str().unwrap())
                .json(&body)
                .timeout(Duration::from_secs(20))
                .send()
                .await
                .unwrap();
            let status = response.status();
            let value: Value = response.json().await.unwrap();
            assert!(status.is_success(), "{status}: {value}");
            value
        }
        fn provider_pid(&self) -> u32 {
            std::fs::read_to_string(self.directory.join("provider.pid"))
                .unwrap()
                .trim()
                .parse()
                .unwrap()
        }
        async fn add_provider(&self) {
            self.management("ingress","POST",json!({"id":"provider","name":"Synthetic provider","controlSource":"custom","transport":"openai-tunnel","auth":"openai","config":{"tunnelId":"tunnel_synthetic","apiKey":"synthetic","tunnelBinary":self.directory.join("provider")}})).await;
            self.management("ingress/provider/start", "POST", json!({}))
                .await;
            let until = Instant::now() + Duration::from_secs(3);
            while !self.directory.join("provider.pid").exists() {
                assert!(Instant::now() < until);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        async fn public_ping(port: u16, authorized: bool) -> Value {
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap();
            let request = client
                .post(format!("http://127.0.0.1:{port}/mcp"))
                .json(&json!({"jsonrpc":"2.0","id":9,"method":"ping"}));
            let request = if authorized {
                request.bearer_auth("synthetic-bearer-token-with-32-characters")
            } else {
                request
            };
            request.send().await.unwrap().json().await.unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Some(mut core) = self.core.take() {
                let _ = core.kill();
                let _ = core.wait();
            }
            let latest = self.observation("front")["pid"].as_u64().map(|p| p as u32);
            if let Some(pid) = latest.or(self.front) {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
                let until = Instant::now() + Duration::from_secs(15);
                while unsafe { libc::kill(pid as i32, 0) } == 0 && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(20));
                }
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
            if let Ok(pid) = std::fs::read_to_string(self.directory.join("provider.pid"))
                .unwrap_or_default()
                .trim()
                .parse::<i32>()
            {
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                }
            }
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
    struct Desktop;
    impl arc_core::transport::DesktopAccess for Desktop {
        fn check_write(&self) -> Result<(), String> {
            Ok(())
        }
        fn request(
            &self,
            request: arc_core::transport::DesktopRequest,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>>
        {
            Box::pin(async move {
                match request {
                    arc_core::transport::DesktopRequest::Route(route, _, _)
                        if route == "app/quit" =>
                    {
                        Ok(json!({"closing":true}))
                    }
                    _ => Err("unexpected fixture Desktop operation".into()),
                }
            })
        }
    }
    impl Fixture {
        async fn desktop(&self) -> tokio::task::JoinHandle<()> {
            let (endpoint, task) =
                arc_core::transport::listen_desktop(std::sync::Arc::new(Desktop))
                    .await
                    .unwrap();
            self.management("runtime/lease", "POST", json!({"id":uuid::Uuid::new_v4().to_string(),"kind":"desktop","pid":std::process::id(),"desktop":endpoint})).await;
            task
        }
        async fn quit_desktop(&self) {
            let mut command = self.command();
            command
                .args(["cli", "app", "quit"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let output = tokio::task::spawn_blocking(move || command.output().unwrap())
                .await
                .unwrap();
            let value: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert!(
                output.status.success(),
                "{value}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(value["result"]["closing"], true, "{value}");
        }
        fn stop_core(&mut self) {
            let mut core = self.core.take().unwrap();
            unsafe {
                libc::kill(core.id() as i32, libc::SIGTERM);
            }
            assert!(core.wait().unwrap().success());
        }
        async fn wait_for_new_front(&mut self, previous: u32) {
            let until = Instant::now() + Duration::from_secs(20);
            loop {
                let info = self.observation("front");
                if info["pid"]
                    .as_u64()
                    .is_some_and(|pid| pid != previous as u64)
                {
                    self.front = info["pid"].as_u64().map(|pid| pid as u32);
                    self.endpoint = self.observation("native");
                    if self.endpoint["port"] == info["port"] {
                        break;
                    }
                }
                assert!(Instant::now() < until, "front door did not reattach");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
    #[tokio::test]
    #[ignore = "Run serially with isolated state and test-fixture feature"]
    async fn incompatible_front_door_install_stops_core_before_replacement() {
        // Regression: ax-327c543d stopped the v1 front door before app quit and stranded the live Core.
        let mut fixture = Fixture::new().await;
        for fail_replacement in [false, true] {
            let desktop = fixture.desktop().await;
            std::fs::write(fixture.directory.join("incompatible"), b"v1").unwrap();
            let rejected = fixture
                .command()
                .arg("front-door-prepare")
                .stderr(Stdio::piped())
                .output()
                .unwrap();
            assert!(!rejected.status.success());
            assert!(String::from_utf8_lossy(&rejected.stderr).contains("CORE_UNAVAILABLE"));
            assert_eq!(fixture.observation("front")["pid"], fixture.front.unwrap());
            // Quit reaches Core despite the incompatible gateway.
            fixture.quit_desktop().await;
            fixture.stop_core();
            let mut hold = fixture
                .command()
                .args(["front-door-prepare", "--hold"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            use std::io::BufRead;
            let mut ready = String::new();
            std::io::BufReader::new(hold.stdout.take().unwrap())
                .read_line(&mut ready)
                .unwrap();
            assert_eq!(ready.trim(), "ready");
            assert!(fixture.observation("front").is_null());
            let blocked = fixture
                .command()
                .arg("daemon")
                .stderr(Stdio::piped())
                .output()
                .unwrap();
            assert!(!blocked.status.success());
            assert!(String::from_utf8_lossy(&blocked.stderr).contains("CORE_UNAVAILABLE"));
            let installed = fixture.directory.join("installed/arc");
            let candidate = fixture.directory.join("candidate");
            let previous = fixture.directory.join("previous");
            std::fs::copy(env!("CARGO_BIN_EXE_arc"), &candidate).unwrap();
            std::fs::rename(&installed, &previous).unwrap();
            if fail_replacement {
                assert!(
                    std::fs::rename(fixture.directory.join("missing-candidate"), &installed)
                        .is_err()
                );
                std::fs::rename(&previous, &installed).unwrap();
            } else {
                std::fs::rename(&candidate, &installed).unwrap();
                std::fs::remove_file(previous).unwrap();
            }
            drop(hold.stdin.take());
            assert!(hold.wait().unwrap().success());
            std::fs::remove_file(fixture.directory.join("incompatible")).unwrap();
            // Both a successful install and a rollback must start Core and its
            // front door from the runnable image left at the installed path.
            fixture.start().await;
            let health = fixture.management("health", "GET", json!({})).await;
            assert_eq!(health["pid"], fixture.core.as_ref().unwrap().id());
            desktop.abort();
        }
    }

    #[tokio::test]
    #[ignore = "Run serially with isolated state and test-fixture feature"]
    async fn exited_front_door_is_relaunched_and_restores_providers() {
        // Regression: ax-327c543d left a live Core without a front door or remote providers until Desktop restarted.
        let mut fixture = Fixture::new().await;
        let desktop = fixture.desktop().await;
        fixture.add_provider().await;
        let previous = fixture.front.unwrap();
        let provider = fixture.provider_pid();
        let core = fixture.core.as_ref().unwrap().id();
        let gate = std::fs::File::options()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(fixture.directory.join("state/front-door-install.lock"))
            .unwrap();
        gate.try_lock().unwrap();
        unsafe {
            libc::kill(previous as i32, libc::SIGKILL);
        }
        // CLI app quit must work during the outage without starting another listener.
        fixture.quit_desktop().await;
        tokio::time::sleep(Duration::from_millis(1300)).await;
        assert_eq!(fixture.observation("front")["pid"], previous);
        drop(gate);
        fixture.wait_for_new_front(previous).await;
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let status = fixture
                .management("ingress/provider", "GET", json!({}))
                .await;
            if status["running"] == true && fixture.provider_pid() != provider {
                break;
            }
            assert!(
                Instant::now() < until,
                "provider intent was not restored: {status}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            fixture.management("health", "GET", json!({})).await["pid"],
            core
        );
        assert_ne!(fixture.front.unwrap(), previous);
        // Repeated startup reuses the same locked front door.
        assert!(fixture.command().arg("start").status().unwrap().success());
        assert_eq!(fixture.observation("front")["pid"], fixture.front.unwrap());
        desktop.abort();
    }
    #[tokio::test]
    #[ignore = "Run serially with isolated state: cargo test -p arc-core --features test-fixture --test front_door -- --ignored --test-threads=1"]
    async fn replacing_core_preserves_ingress_provider_and_live_authority() {
        // Regression: replacing Core closed listener sockets, killed providers and allowed stale authority on transport reconnect.
        let mut fixture = Fixture::new().await;
        fixture.add_provider().await;
        let provider = fixture.provider_pid();
        let front = fixture.front;
        let address = fixture.endpoint["port"].clone();
        let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        fixture.management("ingress","POST",json!({"id":"public","name":"Synthetic HTTPS","controlSource":"custom","transport":"https","auth":"bearer","bearerToken":"synthetic-bearer-token-with-32-characters","config":{"httpsProvider":"custom","httpsHost":"127.0.0.1","httpsPort":port,"httpsUrl":"https://fixture.example/mcp"}})).await;
        fixture
            .management("ingress/public/start", "POST", json!({}))
            .await;
        assert!(Fixture::public_ping(port, false)
            .await
            .get("result")
            .is_none());
        assert!(Fixture::public_ping(port, true)
            .await
            .get("result")
            .is_some());
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap();
        let mut snapshots = client
            .get(format!(
                "http://127.0.0.1:{}/api/subscriptions/events",
                fixture.endpoint["port"]
            ))
            .bearer_auth(fixture.endpoint["token"].as_str().unwrap())
            .send()
            .await
            .unwrap();
        assert!(Fixture::frame(&mut snapshots)
            .await
            .contains("event: snapshot"));
        fixture.kill_core();
        let gap = Fixture::frame(&mut snapshots).await;
        assert!(gap.contains("event: error"));
        assert!(gap.contains("fresh snapshot"));
        let queued = client
            .get(format!(
                "http://127.0.0.1:{}/api/health",
                fixture.endpoint["port"]
            ))
            .bearer_auth(fixture.endpoint["token"].as_str().unwrap())
            .send();
        tokio::pin!(queued);
        let waiting = client.post(format!("http://127.0.0.1:{port}/mcp"))
            .bearer_auth("synthetic-bearer-token-with-32-characters")
            .header("Accept", "application/json")
            .json(&json!({"jsonrpc":"2.0","id":41,"method":"tools/call","params":{"name":"query","arguments":{"op":"inbox_wait","args":{"timeoutMs":10000}}}}))
            .send().await.unwrap();
        tokio::select! {
            result = &mut queued => panic!("swap-time admission did not wait: {result:?}"),
            _ = tokio::time::sleep(Duration::from_millis(100)) => {},
        }
        let cancellation = client.post(format!("http://127.0.0.1:{port}/mcp"))
            .bearer_auth("synthetic-bearer-token-with-32-characters")
            .json(&json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":41}}))
            .send().await.unwrap();
        assert_eq!(cancellation.status(), 202);
        let cancelled: Value = tokio::time::timeout(Duration::from_secs(3), waiting.json())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cancelled["error"]["code"], -32603);
        fixture.start().await;
        let admitted: Value = queued.await.unwrap().json().await.unwrap();
        assert_eq!(admitted["pid"], fixture.core.as_ref().unwrap().id());
        assert!(Fixture::frame(&mut snapshots)
            .await
            .contains("event: snapshot"));
        drop(snapshots);
        let health = fixture.management("health", "GET", json!({})).await;
        assert_eq!(health["pid"], fixture.core.as_ref().unwrap().id());
        assert_eq!(fixture.endpoint["port"], address);
        assert_eq!(fixture.front, front);
        assert_eq!(fixture.provider_pid(), provider);
        assert_eq!(unsafe { libc::kill(provider as i32, 0) }, 0);
        assert!(Fixture::public_ping(port, true)
            .await
            .get("result")
            .is_some());
        assert!(Fixture::public_ping(port, false)
            .await
            .get("result")
            .is_none());
        #[cfg(feature = "test-fixture")]
        {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let callback = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            fixture.callback = Some(format!(
                "http://{}/callback",
                callback.local_addr().unwrap()
            ));
            // The new Core inherits the fixture-only synthetic callback address.
            fixture.replace().await;
            let webhook = tokio::spawn(async move {
                let (mut socket, _) = callback.accept().await.unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                loop {
                    let size = socket.read(&mut buffer).await.unwrap();
                    assert!(size > 0);
                    bytes.extend_from_slice(&buffer[..size]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length: usize = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length: "))
                            .unwrap()
                            .parse()
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            let body: Value =
                                serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
                            let response = json!({"challenge":body["challenge"]}).to_string();
                            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
                            return;
                        }
                    }
                }
            });
            let subscribe = json!({"jsonrpc":"2.0","id":21,"method":"events/subscribe","params":{"name":"notification","arguments":{"op":"task_status","args":{}},"delivery":{"mode":"webhook","url":fixture.callback,"secret":"whsec_c3ludGhldGljLXNpZ25pbmcta2V5LWZvci1maXh0dXJl"},"ttlMs":60000}});
            let subscribed = fixture.public_rpc(port, subscribe.clone()).await;
            assert!(subscribed["result"]["id"].is_string(), "{subscribed}");
            tokio::time::timeout(Duration::from_secs(3), webhook)
                .await
                .unwrap()
                .unwrap();
            let subscription = subscribed["result"]["id"].clone();
            let expiry = subscribed["result"]["refreshBefore"].clone();
            fixture.replace().await;
            let diagnosis = fixture.public_rpc(port, json!({"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"query","arguments":{"op":"notify_status","args":{"target":subscription}}}})).await;
            let content: Value =
                serde_json::from_str(diagnosis["result"]["content"][0]["text"].as_str().unwrap())
                    .unwrap();
            let retained = content["subscriptions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["id"] == subscription)
                .unwrap();
            assert_eq!(retained["active"], true);
            assert_eq!(
                retained["expiresAt"],
                chrono::DateTime::parse_from_rfc3339(expiry.as_str().unwrap())
                    .unwrap()
                    .timestamp_millis()
            );
            let mut replay = subscribe;
            replay["params"]["cursor"] = json!("before-replacement");
            let gap = fixture.public_rpc(port, replay).await;
            assert_eq!(gap["error"]["code"], -32602);
            assert_eq!(gap["error"]["data"]["reason"], "replay_not_supported");
            assert_eq!(gap["error"]["data"]["next"]["op"], "notify_status");
            assert!(
                chrono::DateTime::parse_from_rfc3339(expiry.as_str().unwrap())
                    .unwrap()
                    .timestamp_millis()
                    > chrono::Utc::now().timestamp_millis()
            );

            // Hold only the original completed write's response, then lose that Core.
            std::fs::write(fixture.directory.join("response-gate"), b"hold").unwrap();
            let request_id = fixture.lost_response.clone();
            let writing = client.post(format!("http://127.0.0.1:{}/api/cli/control", fixture.endpoint["port"]))
                .bearer_auth(fixture.endpoint["token"].as_str().unwrap())
                .json(&json!({"op":"ax_report","requestId":request_id,"args":{"symptom":"Synthetic lost write response","expected":"Reconcile original receipt","severity":"cosmetic"}})).send();
            tokio::pin!(writing);
            let gate = fixture.directory.join("response-gate.ready");
            let waiting = async {
                while !gate.exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            };
            tokio::select! {
                result = &mut writing => panic!("write response was not held: {result:?}"),
                _ = tokio::time::timeout(Duration::from_secs(10), waiting) => assert!(gate.exists(), "completed response gate timed out"),
            }
            fixture.kill_core();
            std::fs::remove_file(fixture.directory.join("response-gate")).unwrap();
            let lost: Value = writing.await.unwrap().json().await.unwrap();
            let error: Value = serde_json::from_str(lost["error"].as_str().unwrap()).unwrap();
            assert_eq!(error["data"]["requestId"], request_id);
            assert_eq!(error["data"]["next"]["op"], "receipt");
            fixture.start().await;
            let receipt = fixture
                .management(
                    "cli/control",
                    "POST",
                    json!({"op":"receipt","args":{"action":"read","requestId":request_id}}),
                )
                .await;
            let receipt: Value =
                serde_json::from_str(receipt["content"][0]["text"].as_str().unwrap()).unwrap();
            assert_eq!(receipt["requestId"], request_id, "{receipt}");
            assert_eq!(receipt["state"], "completed", "{receipt}");
            let entries = fixture
                .management("coordination/ax_list", "POST", json!({}))
                .await;
            assert_eq!(entries["entries"].as_array().unwrap().len(), 1);
        }
        let sources = fixture.management("source", "GET", json!({})).await;
        let source = sources["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["ingressId"] == "public")
            .unwrap();
        fixture
            .management(
                &format!("source/{}/disconnect", source["id"].as_str().unwrap()),
                "POST",
                json!({}),
            )
            .await;
        fixture.replace().await;
        let denied = client
            .post(format!("http://127.0.0.1:{port}/mcp"))
            .bearer_auth("synthetic-bearer-token-with-32-characters")
            .json(&json!({"jsonrpc":"2.0","id":9,"method":"ping"}))
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), 400);
        assert_eq!(
            denied.json::<Value>().await.unwrap(),
            json!({"error":"invalid MCP request"})
        );
        fixture.kill_core();
        assert!(fixture
            .command()
            .arg("front-door-prepare")
            .status()
            .unwrap()
            .success());
        assert_eq!(fixture.observation("front")["pid"], front.unwrap());
    }
}
