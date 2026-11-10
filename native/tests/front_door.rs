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
            std::fs::write(&provider,"#!/bin/sh\ncase \"$1\" in\n--version) echo 'tunnel-client 0.0.16'; exit 0;;\ninit) exit 0;;\nrun) echo $$ > \"$ARC_PROVIDER_FIXTURE_PID.$$\"; /bin/mv \"$ARC_PROVIDER_FIXTURE_PID.$$\" \"$ARC_PROVIDER_FIXTURE_PID\"; trap 'exit 0' TERM INT; while :; do sleep 1; done;;\nesac\n").unwrap();
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
            command.env("ARC_FIXTURE_ADMITTED_RPC_ID", "777").env(
                "ARC_FIXTURE_ADMITTED_GATE",
                self.directory.join("admitted-read"),
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
        async fn install_lock(&self) -> std::fs::File {
            let gate = std::fs::File::options()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(self.directory.join("state/front-door-install.lock"))
                .unwrap();
            let until = Instant::now() + Duration::from_secs(3);
            while gate.try_lock().is_err() {
                assert!(Instant::now() < until, "replacement path remained locked");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            gate
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
    #[cfg(target_os = "macos")]
    struct Executor {
        child: Child,
        directory: PathBuf,
        socket: PathBuf,
    }
    #[cfg(target_os = "macos")]
    impl Executor {
        async fn start(fixture: &Fixture) -> Self {
            use std::{io::Write, os::unix::process::CommandExt};
            let directory = fixture
                .directory
                .join("state/task-host/instances/synthetic");
            std::fs::create_dir_all(&directory).unwrap();
            let socket =
                PathBuf::from("/tmp").join(format!("arc-executor-{}", uuid::Uuid::new_v4()));
            let mut command = fixture.command();
            command.arg("task-host").stdin(Stdio::piped());
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
            let mut child = command.spawn().unwrap();
            let script = "while IFS= read -r line; do printf '%s\\n' \"$line\"; done";
            let spec = json!({"program":"/bin/sh","args":["-c",script],"cwd":fixture.directory,
                "env":{},"directory":directory,"socket":socket,"taskId":"synthetic","agent":"pi",
                "executable":fixture.directory.join("installed/arc")});
            writeln!(child.stdin.take().unwrap(), "{spec}").unwrap();
            let executor = Self {
                child,
                directory,
                socket,
            };
            let until = Instant::now() + Duration::from_secs(5);
            while !executor.directory.join("host.json").exists() {
                assert!(Instant::now() < until, "executor startup timed out");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            executor.request(json!({"op":"write","sequence":1,"frame":{"type":"prompt","message":"Synthetic active turn"}}));
            assert_eq!(executor.request(json!({"op":"status"}))["alive"], true);
            executor
        }
        fn request(&self, body: Value) -> Value {
            use std::io::{BufRead, Write};
            let stream = std::os::unix::net::UnixStream::connect(&self.socket).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut stream = std::io::BufReader::new(stream);
            writeln!(stream.get_mut(), "{}", json!({"protocol":1})).unwrap();
            let mut line = String::new();
            stream.read_line(&mut line).unwrap();
            assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["protocol"], 1);
            writeln!(stream.get_mut(), "{body}").unwrap();
            line.clear();
            stream.read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap()
        }
    }
    #[cfg(target_os = "macos")]
    impl Drop for Executor {
        fn drop(&mut self) {
            if self.child.try_wait().ok().flatten().is_none() {
                let index: Value = std::fs::read(self.directory.join("host.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                    .unwrap_or(Value::Null);
                if let Some(pid) = index["agentPid"].as_u64() {
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGKILL);
                    }
                }
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
            let _ = std::fs::remove_file(&self.socket);
        }
    }
    #[cfg(target_os = "macos")]
    impl Fixture {
        fn install_image(&self, fail_readiness: bool) -> String {
            use std::os::unix::fs::PermissionsExt;
            let candidate = self.directory.join("candidate");
            std::fs::create_dir_all(&candidate).unwrap();
            let binary = candidate.join("arc");
            if fail_readiness {
                std::fs::write(&binary, "#!/bin/sh\nexec /bin/sleep 60\n").unwrap();
                std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
            } else {
                std::fs::copy(env!("CARGO_BIN_EXE_arc"), &binary).unwrap();
                let output = Command::new("/usr/bin/codesign")
                    .args(["--force", "--sign", "-", "--identifier"])
                    .arg(format!("arc.fixture.{}", uuid::Uuid::new_v4()))
                    .arg(&binary)
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            let build = arc_core::runtime::build_id(&binary).unwrap();
            std::fs::rename(
                self.directory.join("installed"),
                self.directory.join("previous-install"),
            )
            .unwrap();
            std::fs::rename(candidate, self.directory.join("installed")).unwrap();
            build
        }
        async fn update_outcome(&mut self, expected: &str) -> Value {
            let until = Instant::now() + Duration::from_secs(30);
            loop {
                self.endpoint = self.observation("native");
                let response = reqwest::Client::builder()
                    .no_proxy()
                    .build()
                    .unwrap()
                    .get(format!(
                        "http://127.0.0.1:{}/api/health",
                        self.endpoint["port"]
                    ))
                    .bearer_auth(self.endpoint["token"].as_str().unwrap())
                    .timeout(Duration::from_millis(500))
                    .send()
                    .await;
                if let Ok(response) = response {
                    if let Ok(health) = response.json::<Value>().await {
                        if health["frontDoor"]["update"]["lastOutcome"] == expected {
                            self.front = health["frontDoor"]["pid"].as_u64().map(|p| p as u32);
                            return health["frontDoor"].clone();
                        }
                    }
                }
                assert!(
                    Instant::now() < until,
                    "front-door update outcome timed out: {expected}"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        async fn restored_provider(&self, previous: u32) -> u32 {
            let until = Instant::now() + Duration::from_secs(10);
            loop {
                let status = self.management("ingress/provider", "GET", json!({})).await;
                let pid = self.provider_pid();
                if status["running"] == true && pid != previous {
                    return pid;
                }
                assert!(
                    Instant::now() < until,
                    "provider was not restored: {status}"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "Run serially with isolated state and test-fixture feature"]
    async fn changed_build_updates_only_front_door_and_preserves_active_executor() {
        // Regression: protocol-compatible front doors retained their first build indefinitely after bundle replacement.
        let mut fixture = Fixture::new().await;
        let desktop = fixture.desktop().await;
        fixture.add_provider().await;
        let executor = Executor::start(&fixture).await;
        let active = executor.request(json!({"op":"status"}));
        let core = fixture.core.as_ref().unwrap().id();
        let front = fixture.front.unwrap();
        let provider = fixture.provider_pid();
        assert_eq!(unsafe { libc::getsid(front as i32) }, front as i32);
        assert_eq!(unsafe { libc::getsid(provider as i32) }, front as i32);
        assert_eq!(
            unsafe { libc::getsid(executor.child.id() as i32) },
            executor.child.id() as i32
        );
        assert_ne!(unsafe { libc::getsid(core as i32) }, front as i32);
        fixture.quit_desktop().await;
        desktop.abort();
        let gate = fixture.install_lock().await;
        let target = fixture.install_image(false);
        tokio::time::sleep(Duration::from_millis(1300)).await;
        assert_eq!(fixture.observation("front")["pid"], front);
        assert_eq!(fixture.provider_pid(), provider);
        assert_eq!(
            executor.request(json!({"op":"status"}))["agentPid"],
            active["agentPid"]
        );
        drop(gate);
        let status = fixture.update_outcome("updated").await;
        assert_eq!(status["build"], target);
        assert_eq!(status["update"]["currentBuild"], target);
        assert_eq!(status["update"]["targetBuild"], target);
        assert_eq!(status["matchesInstalledBuild"], true);
        assert_eq!(status["update"]["rollback"], false);
        assert_ne!(fixture.front.unwrap(), front);
        assert_eq!(
            fixture.management("health", "GET", json!({})).await["pid"],
            core
        );
        let lock = std::fs::File::options()
            .read(true)
            .write(true)
            .open(fixture.directory.join("state/core.lock"))
            .unwrap();
        assert!(lock.try_lock().is_err());
        let restored = fixture.restored_provider(provider).await;
        assert_eq!(
            unsafe { libc::getsid(restored as i32) },
            fixture.front.unwrap() as i32
        );
        let resumed = executor.request(json!({"op":"status"}));
        assert_eq!(resumed["agentPid"], active["agentPid"]);
        assert_eq!(resumed["alive"], true);
        let records = |name: &str| -> Vec<Value> {
            std::fs::read_dir(fixture.directory.join("state").join(name))
                .unwrap()
                .map(|e| {
                    serde_json::from_slice(&std::fs::read(e.unwrap().path()).unwrap()).unwrap()
                })
                .collect()
        };
        assert!(records("front-door-children")
            .iter()
            .any(|r| r["pid"] == restored && r["owner"]["pid"] == fixture.front.unwrap()));
        assert!(records("core-children")
            .iter()
            .all(|r| r["pid"] != restored && r["pid"] != executor.child.id()));
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "Run serially with isolated state and test-fixture feature"]
    async fn long_poll_and_snapshot_end_explicitly_during_bounded_image_update() {
        // Regression: cf9cf2e waited for long-poll reads on every drain attempt and could postpone front-door updates indefinitely.
        let mut fixture = Fixture::new().await;
        let core = fixture.core.as_ref().unwrap().id();
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = port.local_addr().unwrap().port();
        drop(port);
        fixture.management("ingress","POST",json!({"id":"public","name":"Synthetic HTTPS","controlSource":"custom","transport":"https","auth":"bearer","bearerToken":"synthetic-bearer-token-with-32-characters","config":{"httpsProvider":"custom","httpsHost":"127.0.0.1","httpsPort":address,"httpsUrl":"https://fixture.example/mcp"}})).await;
        fixture
            .management("ingress/public/start", "POST", json!({}))
            .await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(25))
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
        let response = client.post(format!("http://127.0.0.1:{address}/mcp"))
            .bearer_auth("synthetic-bearer-token-with-32-characters")
            .header("Accept","application/json")
            .json(&json!({"jsonrpc":"2.0","id":777,"method":"tools/call","params":{"name":"query","arguments":{"op":"inbox_wait","args":{"timeoutMs":170000}}}}))
            .send().await.unwrap();
        let admitted = fixture.directory.join("admitted-read");
        let until = Instant::now() + Duration::from_secs(5);
        while !admitted.exists() {
            assert!(
                Instant::now() < until,
                "long poll did not reach Core admission"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let reading = response.json::<Value>();
        tokio::pin!(reading);
        tokio::select! {
            result = &mut reading => panic!("long poll completed before maintenance: {result:?}"),
            _ = tokio::time::sleep(Duration::from_millis(100)) => {},
        }
        let started = Instant::now();
        let target = fixture.install_image(false);
        let status =
            tokio::time::timeout(Duration::from_secs(15), fixture.update_outcome("updated"))
                .await
                .expect("long poll blocked front-door update");
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(15),
            "image update took {elapsed:?}"
        );
        let read = reading.await.unwrap();
        assert_eq!(read["id"], 777);
        assert_eq!(read["error"]["code"], -32603, "{read}");
        assert!(read["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("FRONT_DOOR_CORE_DRAINING:"));
        assert_eq!(
            read["error"]["data"]["next"],
            json!({"via":"query","op":"guide","args":{"topic":"loop"}})
        );
        let frame = Fixture::frame(&mut snapshots).await;
        assert!(frame.contains("event: error"), "{frame}");
        let error: Value = serde_json::from_str(
            frame
                .lines()
                .find_map(|line| line.strip_prefix("data: "))
                .unwrap(),
        )
        .unwrap();
        let error: Value = serde_json::from_str(error["error"].as_str().unwrap()).unwrap();
        assert_eq!(error["code"], -32603);
        assert_eq!(error["data"]["next"]["op"], "guide");
        assert_eq!(status["build"], target);
        assert!(
            status["update"]["endedReads"].as_u64().unwrap() >= 2,
            "{status}"
        );
        assert_eq!(status["update"]["outstandingWrites"], 0);
        assert_eq!(
            fixture.management("health", "GET", json!({})).await["pid"],
            core
        );
        assert!(Fixture::public_ping(address, true)
            .await
            .get("result")
            .is_some());
        eprintln!(
            "Long-poll maintenance fixture updated and returned retry outcomes in {:.3}s",
            elapsed.as_secs_f64()
        );
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "Run serially with isolated state and test-fixture feature"]
    async fn failed_readiness_rolls_back_without_restarting_core_or_executor() {
        // Regression: a front-door image that never becomes ready must restore the previous serving image.
        let mut fixture = Fixture::new().await;
        fixture.add_provider().await;
        let executor = Executor::start(&fixture).await;
        let active = executor.request(json!({"op":"status"}));
        let core = fixture.core.as_ref().unwrap().id();
        let old_build = fixture.observation("front")["build"].clone();
        let provider = fixture.provider_pid();
        let target = fixture.install_image(true);
        let status = fixture.update_outcome("rolled_back").await;
        assert_eq!(status["build"], old_build);
        assert_eq!(status["update"]["targetBuild"], target);
        assert_eq!(status["update"]["rollback"], true);
        assert_eq!(status["matchesInstalledBuild"], false);
        assert!(status["update"]["lastError"]
            .as_str()
            .unwrap()
            .contains("START_TIMEOUT"));
        assert_eq!(
            fixture.management("health", "GET", json!({})).await["pid"],
            core
        );
        fixture.restored_provider(provider).await;
        let front = fixture.front.unwrap();
        tokio::time::sleep(Duration::from_millis(1300)).await;
        assert_eq!(fixture.observation("front")["pid"], front);
        assert_eq!(
            executor.request(json!({"op":"status"}))["agentPid"],
            active["agentPid"]
        );
        assert_eq!(executor.request(json!({"op":"status"}))["alive"], true);
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "Run serially with isolated state and test-fixture feature"]
    async fn core_loss_without_desktop_keeps_owners_until_explicit_restart() {
        // Regression: Core loss with Desktop closed leaves detached owners alive and business admissions waiting for an explicit Core start.
        let mut fixture = Fixture::new().await;
        fixture.add_provider().await;
        let executor = Executor::start(&fixture).await;
        let active = executor.request(json!({"op":"status"}));
        let front = fixture.front.unwrap();
        let provider = fixture.provider_pid();
        fixture.kill_core();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let pending = client
            .get(format!(
                "http://127.0.0.1:{}/api/health",
                fixture.endpoint["port"]
            ))
            .bearer_auth(fixture.endpoint["token"].as_str().unwrap())
            .timeout(Duration::from_secs(10))
            .send();
        tokio::pin!(pending);
        tokio::select! {
            result = &mut pending => panic!("admission did not wait for Core: {result:?}"),
            _ = tokio::time::sleep(Duration::from_millis(1300)) => {},
        }
        let lock = std::fs::File::options()
            .read(true)
            .write(true)
            .open(fixture.directory.join("state/core.lock"))
            .unwrap();
        lock.try_lock().unwrap();
        drop(lock);
        assert_eq!(fixture.observation("front")["pid"], front);
        assert_eq!(fixture.provider_pid(), provider);
        assert_eq!(unsafe { libc::kill(provider as i32, 0) }, 0);
        assert_eq!(
            executor.request(json!({"op":"status"}))["agentPid"],
            active["agentPid"]
        );
        fixture.start().await;
        let health: Value = pending.await.unwrap().json().await.unwrap();
        assert_eq!(health["pid"], fixture.core.as_ref().unwrap().id());
        assert_eq!(fixture.front.unwrap(), front);
        assert_eq!(executor.request(json!({"op":"status"}))["alive"], true);
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "Run serially with isolated state and test-fixture feature"]
    async fn uninstall_removes_front_door_children_images_sockets_and_indexes() {
        // Regression: uninstall left front-door images and private sockets outside the stopped Core owner.
        use sha2::{Digest, Sha256};
        let mut fixture = Fixture::new().await;
        fixture.add_provider().await;
        let mut executor = Executor::start(&fixture).await;
        let front = fixture.front.unwrap();
        let provider = fixture.provider_pid();
        let state = fixture.directory.join("state").canonicalize().unwrap();
        let digest = Sha256::digest(state.to_string_lossy().as_bytes());
        let digest: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        let sockets = PathBuf::from("/tmp").join(format!(
            "arc-ipc-{}-{}",
            unsafe { libc::geteuid() },
            &digest[..24]
        ));
        assert!(sockets.exists());
        let mut command = fixture.command();
        command
            .args(["cli", "uninstall", "--purge"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = tokio::task::spawn_blocking(move || command.output().unwrap())
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["result"]["state"], "completed", "{result}");
        assert!(fixture.core.as_mut().unwrap().wait().unwrap().success());
        executor.child.wait().unwrap();
        for pid in [front, provider, executor.child.id()] {
            assert_eq!(
                unsafe { libc::kill(pid as i32, 0) },
                -1,
                "process {pid} survived uninstall"
            );
        }
        assert!(!state.join("front-door-bin").exists());
        assert!(!state.join("app/front-door.json").exists());
        assert!(!state.join("front-door-children").exists());
        assert!(!sockets.exists());
        assert!(!executor.socket.exists());
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
        let gate = fixture.install_lock().await;
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
