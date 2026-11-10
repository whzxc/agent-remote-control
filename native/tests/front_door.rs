//! Main-checkout process fixture. No real providers, credentials or Agent accounts are used.
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
    }
    impl Fixture {
        async fn new() -> Self {
            arc_core::init_crypto();
            use std::os::unix::fs::PermissionsExt;
            let directory = std::env::temp_dir().join(format!("arc-fd-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(directory.join("home")).unwrap();
            let provider = directory.join("provider");
            std::fs::write(&provider,"#!/bin/sh\ncase \"$1\" in\n--version) echo 'tunnel-client 0.0.16'; exit 0;;\ninit) exit 0;;\nrun) echo $$ > \"$ARC_PROVIDER_FIXTURE_PID\"; trap 'exit 0' TERM INT; while :; do sleep 1; done;;\nesac\n").unwrap();
            std::fs::set_permissions(&provider, std::fs::Permissions::from_mode(0o700)).unwrap();
            let mut fixture = Self {
                directory,
                core: None,
                front: None,
                endpoint: Value::Null,
            };
            fixture.start().await;
            fixture
        }
        fn command(&self) -> Command {
            let mut command = Command::new(env!("CARGO_BIN_EXE_arc"));
            command
                .env("ARC_STATE_DIR", self.directory.join("state"))
                .env("HOME", self.directory.join("home"))
                .env("CODEX_HOME", self.directory.join("home/.codex"))
                .env(
                    "ARC_PROVIDER_FIXTURE_PID",
                    self.directory.join("provider.pid"),
                );
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
        }
        async fn replace(&mut self) {
            let mut core = self.core.take().unwrap();
            core.kill().unwrap();
            core.wait().unwrap();
            self.start().await;
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
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
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
            if let Some(pid) = self.front {
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
    #[tokio::test]
    #[ignore = "Run serially from the main checkout: cargo test -p arc-core --test front_door -- --ignored --test-threads=1"]
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
        fixture.replace().await;
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
        assert!(Fixture::public_ping(port, true)
            .await
            .get("result")
            .is_none());
        assert!(fixture
            .command()
            .arg("front-door-prepare")
            .status()
            .unwrap()
            .success());
        assert_eq!(fixture.observation("front")["pid"], front.unwrap());
    }
}
