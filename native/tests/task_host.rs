//! Process-level fixtures for the frozen task-host wire contract.
#[cfg(unix)]
mod unix {
    use serde_json::{json, Value};
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::net::UnixStream,
        path::PathBuf,
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };

    struct Fixture {
        directory: PathBuf,
        child: Child,
        socket: PathBuf,
    }
    impl Fixture {
        fn start() -> Self {
            let directory = std::env::temp_dir().join(format!("arc-th-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&directory).unwrap();
            let socket = directory.join("s");
            let mut child = Command::new(env!("CARGO_BIN_EXE_arc"))
                .arg("task-host")
                .env("ARC_STATE_DIR", &directory)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
            let script = "while IFS= read -r line; do printf '%s\\n' \"$line\"; done; exit 7";
            let spec = json!({"program":"/bin/sh","args":["-c",script],"cwd":directory,"env":{},"directory":directory,"socket":socket,"taskId":"fixture","agent":"pi","executable":env!("CARGO_BIN_EXE_arc")});
            writeln!(child.stdin.take().unwrap(), "{spec}").unwrap();
            let fixture = Self {
                directory,
                child,
                socket,
            };
            let deadline = Instant::now() + Duration::from_secs(10);
            while !fixture.directory.join("host.json").exists() {
                assert!(Instant::now() < deadline, "host startup timed out");
                std::thread::sleep(Duration::from_millis(20));
            }
            fixture
        }
        fn request(&self, value: Value) -> Value {
            let mut stream = BufReader::new(UnixStream::connect(&self.socket).unwrap());
            stream
                .get_mut()
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            writeln!(stream.get_mut(), "{}", json!({"protocol":1})).unwrap();
            let mut line = String::new();
            stream.read_line(&mut line).unwrap();
            assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["protocol"], 1);
            writeln!(stream.get_mut(), "{value}").unwrap();
            line.clear();
            stream.read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap()
        }
        fn journal(&self) -> Vec<Value> {
            std::fs::read_to_string(self.directory.join("journal.jsonl"))
                .unwrap()
                .lines()
                .map(|s| serde_json::from_str(s).unwrap())
                .collect()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn disconnected_clients_keep_agent_and_deduplicate_writes() {
        // Contract: task-host v1 persists ordered stdout, survives client disconnect, and acknowledges a write sequence only once.
        let mut fixture = Fixture::start();
        let first = fixture.request(json!({"op":"status"}));
        let write = json!({"op":"write","sequence":1,"frame":{"id":"string-id","type":"prompt","message":"fixture"}});
        assert_eq!(fixture.request(write.clone())["receivedSequence"], 1);
        // Every request closes its socket; reconnecting must retain the same Agent.
        assert_eq!(fixture.request(write)["receivedSequence"], 1);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let rows = fixture.journal();
            if rows.iter().any(|r| r["kind"] == "stdout") {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        let status = fixture.request(json!({"op":"status"}));
        assert_eq!(status["agentPid"], first["agentPid"]);
        assert_eq!(status["alive"], true);
        fixture.request(json!({"op":"close"}));
        assert!(fixture.child.wait().unwrap().success());
        let exit: Value =
            serde_json::from_slice(&std::fs::read(fixture.directory.join("exit.json")).unwrap())
                .unwrap();
        assert_eq!(exit["exitCode"], 7);
        assert_eq!(exit["receivedSequence"], 1);
        let rows = fixture.journal();
        assert_eq!(rows.iter().filter(|r| r["kind"] == "stdout").count(), 1);
        assert_eq!(
            rows.iter()
                .map(|r| r["offset"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }
}
