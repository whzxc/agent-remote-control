//! Turn-scoped Claude follow-ups. Delivery is attempted once, never retried.
use crate::*;
use serde::{Deserialize, Serialize};
use std::{future::Future, time::Duration};

pub(crate) fn session_id(value: &str) -> Result<String> {
    let value = value.trim();
    let url = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
        .unwrap_or(value);
    let (id, from_url) = match url.strip_prefix("claude.ai/code/") {
        Some(id) => (
            id.split(['?', '#'])
                .next()
                .unwrap_or("")
                .trim_end_matches('/'),
            true,
        ),
        None => (value, false),
    };
    if id.is_empty()
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        || (!from_url
            && !id
                .strip_prefix("session_")
                .or_else(|| id.strip_prefix("cse_"))
                .is_some_and(|suffix| !suffix.is_empty()))
    {
        return Err(
            "INVALID_CLAUDE_SESSION: expected cloud session ID or claude.ai/code URL".into(),
        );
    }
    Ok(id.into())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Delivery {
    key: String,
    session_id: String,
    state: String,
    status: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    thread_id: String,
    turn_id: String,
    session_id: Option<String>,
    project: String,
    terminal: bool,
    created_at: i64,
    waiting: Vec<String>,
    deliveries: Vec<Delivery>,
    #[serde(default)]
    continuation_bound: bool,
}
fn directory() -> PathBuf {
    root().join("claude-notifications")
}
fn path_in(dir: &Path, thread: &str, turn: &str) -> PathBuf {
    dir.join(format!("{}.json", hash(json!([thread, turn]).to_string())))
}
fn persist(dir: &Path, b: &Binding) -> Result<()> {
    save(
        &path_in(dir, &b.thread_id, &b.turn_id),
        &serde_json::to_value(b).map_err(|e| e.to_string())?,
    )
}
fn binding(dir: &Path, thread: &str, turn: &str) -> Result<Option<Binding>> {
    let path = path_in(dir, thread, turn);
    if !path.exists() {
        return Ok(None);
    }
    serde_json::from_value(load(&path)?)
        .map(Some)
        .map_err(|e| e.to_string())
}
fn bind_in(dir: &Path, session: Option<&str>, thread: &str, turn: &str, cwd: &str) -> Result<()> {
    let Some(session) = session else {
        return Ok(());
    };
    let previous = binding(dir, thread, turn)?;
    let mut b = previous.unwrap_or_else(|| Binding {
        thread_id: thread.into(),
        turn_id: turn.into(),
        session_id: None,
        project: Path::new(cwd)
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("未命名")
            .into(),
        terminal: false,
        created_at: chrono::Utc::now().timestamp(),
        waiting: vec![],
        deliveries: vec![],
        continuation_bound: false,
    });
    b.session_id = (!session.is_empty()).then(|| session.to_owned());
    persist(dir, &b)
}
pub(crate) async fn bind(
    control: &control::Control,
    args: &Value,
    thread: &str,
    turn: &str,
    cwd: &str,
) -> Result<()> {
    if args.get("notifyClaudeSession").is_none() {
        return Ok(());
    }
    if turn.is_empty() {
        return Err("MISSING_TURN_ID".into());
    }
    let _guard = control.claude_notifications.lock().await;
    bind_in(
        &directory(),
        Some(args["notifyClaudeSession"].as_str().unwrap_or("")),
        thread,
        turn,
        cwd,
    )
}
pub(crate) fn record_binding(receipt: &mut Value, result: Result<()>) {
    if let Err(error) = result {
        #[cfg(not(test))]
        crate::logs::record(
            "WARN",
            &format!("Codex task dispatched, but Claude notification binding failed: {error}"),
            None,
        );
        receipt["claudeNotification"] = json!("bind-failed");
        receipt["claudeNotificationError"] = json!(error);
    }
}
const RETENTION_SECONDS: i64 = 7 * 24 * 60 * 60;
fn remove_expired(dir: &Path, b: &Binding, now: i64) -> Result<bool> {
    if now - b.created_at <= RETENTION_SECONDS {
        return Ok(false);
    }
    std::fs::remove_file(path_in(dir, &b.thread_id, &b.turn_id)).map_err(|e| e.to_string())?;
    Ok(true)
}
fn notification(b: Option<Binding>) -> Value {
    b.filter(|b| b.session_id.is_some()).map(|b| json!({
        "sessionId": b.session_id,
        "deliveries": b.deliveries.iter().filter(|d| Some(d.session_id.as_str()) == b.session_id.as_deref()).map(|d| json!({"state":d.state,"status":d.status})).collect::<Vec<_>>()
    })).unwrap_or(Value::Null)
}
pub(crate) fn read(thread: &str, turn: &str) -> Result<Value> {
    Ok(notification(binding(&directory(), thread, turn)?))
}
fn message(b: &Binding, state: &str) -> String {
    format!(
        "Codex 任务通知：项目 {}，线程 {}，轮次 {}，状态 {}，请检查。",
        b.project, b.thread_id, b.turn_id, state
    )
}
fn arguments(session: &str, message: &str) -> Vec<String> {
    ["-p", message, "--cloud", session, "--output-format", "json"]
        .map(str::to_owned)
        .to_vec()
}

// Only state/IDs reach the persisted delivery or message, never owner text.
fn transitions(b: &mut Binding, observed: &Value) -> Vec<(String, String)> {
    if b.terminal {
        return vec![];
    }
    let terminal = match string(observed, "state") {
        "completed" => Some("完成"),
        "failed" => Some("失败"),
        "cancelled" => Some("中断"),
        _ => None,
    };
    if let Some(state) = terminal {
        b.terminal = true;
        b.waiting.clear();
        return vec![("terminal".into(), state.into())];
    }
    if observed["state"] == "running" {
        b.waiting.clear();
    }
    if observed["state"] != "interaction-required" {
        return vec![];
    }
    let mut events = vec![];
    let mut waiting = vec![];
    for request in observed["interaction"].as_array().into_iter().flatten() {
        let method = string(request, "method");
        let state = if method.contains("requestUserInput") {
            "等待输入"
        } else if method.contains("Approval") || method.contains("approval") {
            "等待审批"
        } else {
            continue;
        };
        waiting.push(state.to_owned());
        if !request["id"].is_null() {
            events.push((format!("request:{}", request["id"]), state.to_owned()));
        } else if !b.waiting.iter().any(|v| v == state) {
            events.push((
                format!("entry:{}:{state}", b.deliveries.len()),
                state.into(),
            ));
        }
    }
    for (flag, state) in [
        ("waitingOnApproval", "等待审批"),
        ("waitingOnUserInput", "等待输入"),
    ] {
        if observed["activeFlags"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == flag))
            && !waiting.iter().any(|v| v == state)
        {
            waiting.push(state.into());
            if !b.waiting.iter().any(|v| v == state) {
                events.push((
                    format!("entry:{}:{state}", b.deliveries.len()),
                    state.into(),
                ));
            }
        }
    }
    b.waiting = waiting;
    events.retain(|(key, _)| !b.deliveries.iter().any(|d| &d.key == key));
    events.sort();
    events.dedup();
    events
}
trait Executor {
    fn send(&self, args: Vec<String>) -> impl Future<Output = Result<Vec<u8>>> + Send;
    fn fallback(&self, body: String) -> impl Future<Output = ()> + Send;
}
struct Cli;
impl Executor for Cli {
    async fn send(&self, args: Vec<String>) -> Result<Vec<u8>> {
        let binary = crate::agents::driver::discover("claude").ok_or("CLAUDE_NOT_FOUND")?;
        let paths = std::env::join_paths(crate::agents::driver::search_paths())
            .map_err(|e| e.to_string())?;
        let output = tokio::time::timeout(
            Duration::from_secs(30),
            command(binary)
                .args(args)
                .env("PATH", paths)
                .stdin(std::process::Stdio::null())
                .output(),
        )
        .await
        .map_err(|_| "CLAUDE_SEND_TIMEOUT")?
        .map_err(|e| format!("CLAUDE_SEND_FAILED: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "CLAUDE_SEND_FAILED: exit {}; {}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
                    .chars()
                    .take(2000)
                    .collect::<String>()
            ));
        }
        Ok(output.stdout)
    }
    async fn fallback(&self, body: String) {
        #[cfg(target_os = "macos")]
        {
            // Core has no Tauri/UI handle. Static AppleScript receives text as argv.
            let result = tokio::time::timeout(Duration::from_secs(5), command("/usr/bin/osascript")
                .args(["-e", "on run argv\ndisplay notification (item 1 of argv) with title \"Agent Remote Control 通知未送达\"\nend run", &body])
                .output()).await;
            if !matches!(result, Ok(Ok(ref out)) if out.status.success()) {
                crate::logs::record("WARN", "Claude notification fallback failed", None);
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = body;
            crate::logs::record(
                "WARN",
                "Claude notification delivery failed; system fallback is macOS only",
                None,
            );
        }
    }
}
async fn deliver(executor: &impl Executor, b: &Binding, state: &str) -> &'static str {
    let session = b.session_id.as_deref().unwrap();
    let result = executor
        .send(arguments(session, &message(b, state)))
        .await
        .and_then(|bytes| {
            serde_json::from_slice::<Value>(&bytes).map_err(|_| "CLAUDE_SEND_UNKNOWN".into())
        });
    let error = match result {
        Ok(ref v) if v["ok"] == true && v["session_id"].as_str() == Some(session) => {
            return "delivered"
        }
        Ok(ref v) if v["ok"] == true => "CLAUDE_SESSION_MISMATCH".to_owned(),
        Ok(v) => format!("CLAUDE_SEND_REJECTED: {}", v["error"]),
        Err(error) => error,
    };
    #[cfg(not(test))]
    crate::logs::record(
        "WARN",
        &format!(
            "Claude notification delivery failed: thread={} turn={}: {error}",
            b.thread_id, b.turn_id
        ),
        None,
    );
    #[cfg(test)]
    let _ = error;
    executor.fallback(fallback_body(b)).await;
    "failed"
}
fn fallback_body(b: &Binding) -> String {
    format!(
        "项目 {}，线程 {}，轮次 {} 的 Claude 通知未送达，请检查。",
        b.project, b.thread_id, b.turn_id
    )
}
fn recover(dir: &Path, b: &mut Binding) -> Result<bool> {
    if b.deliveries.iter().any(|d| d.status == "sending") {
        for d in &mut b.deliveries {
            if d.status == "sending" {
                d.status = "failed".into();
            }
        }
        persist(dir, b)?;
        return Ok(true);
    }
    Ok(false)
}
async fn process(
    executor: &impl Executor,
    dir: &Path,
    lock: &Mutex<()>,
    b: &mut Binding,
    observation: &Value,
) -> Result<()> {
    let guard = lock.lock().await;
    let Some(current) = binding(dir, &b.thread_id, &b.turn_id)? else {
        return Ok(());
    };
    *b = current;
    if b.session_id.is_none() {
        return Ok(());
    }
    if observation["state"] == "cancelled" && !b.continuation_bound {
        if let Some(next) = observation["nextTurnId"].as_str().filter(|s| !s.is_empty()) {
            // An existing record, including an explicit unbind, wins over inheritance.
            if binding(dir, &b.thread_id, next)?.is_none() {
                bind_in(dir, b.session_id.as_deref(), &b.thread_id, next, &b.project)?;
            }
            b.continuation_bound = true;
            persist(dir, b)?;
        }
    }
    let previous_waiting = b.waiting.clone();
    let events = transitions(b, observation);
    if events.is_empty() && b.waiting == previous_waiting {
        return Ok(());
    }
    let first = b.deliveries.len();
    for (key, state) in events {
        b.deliveries.push(Delivery {
            session_id: b.session_id.clone().unwrap(),
            key,
            state,
            status: "sending".into(),
        });
    }
    // Reservation and terminal/interaction dedup state are one atomic write.
    persist(dir, b)?;
    drop(guard);
    let reserved = b.clone();
    for delivery in &reserved.deliveries[first..] {
        let status = deliver(executor, &reserved, &delivery.state).await;
        let _guard = lock.lock().await;
        if let Some(mut current) = binding(dir, &reserved.thread_id, &reserved.turn_id)? {
            if let Some(record) = current
                .deliveries
                .iter_mut()
                .find(|d| d.key == delivery.key && d.session_id == delivery.session_id)
            {
                record.status = status.into();
            }
            persist(dir, &current)?;
            *b = current;
        }
    }
    Ok(())
}
pub(crate) fn start(control: &Arc<control::Control>) {
    let weak = Arc::downgrade(control);
    let mut shutdown = control.shutdown.subscribe();
    tokio::spawn(async move {
        crate::logs::record("INFO", "Claude notification observer started", None);
        let mut recovering = true;
        loop {
            let Some(control) = weak.upgrade() else {
                break;
            };
            let cycle = async {
                let mut reads = tokio::task::JoinSet::new();
                if let Ok(entries) = std::fs::read_dir(directory()) {
                    for entry in entries
                        .flatten()
                        .filter(|e| e.path().extension().is_some_and(|v| v == "json"))
                    {
                        let _guard = control.claude_notifications.lock().await;
                        let mut b: Binding = serde_json::from_value(load(&entry.path())?)
                            .map_err(|e| e.to_string())?;
                        if remove_expired(&directory(), &b, chrono::Utc::now().timestamp())? {
                            continue;
                        }
                        let fallback = recovering && recover(&directory(), &mut b)?;
                        drop(_guard);
                        if fallback {
                            Cli.fallback(fallback_body(&b)).await;
                        }
                        let interrupted = b.deliveries.iter().any(|d| d.state == "中断");
                        if (b.terminal && (!interrupted || b.continuation_bound))
                            || b.session_id.is_none()
                        {
                            continue;
                        }
                        let c = control.clone();
                        reads.spawn(async move {
                            let args = json!({"threadId":b.thread_id,"turnId":b.turn_id});
                            let result = tokio::time::timeout(
                                Duration::from_secs(10),
                                crate::waiter::codex_observe(&c, &args),
                            )
                            .await;
                            (b, result)
                        });
                    }
                }
                while let Some(result) = reads.join_next().await {
                    let Ok((old, Ok(Ok(observed)))) = result else {
                        continue;
                    };
                    let mut b = old;
                    process(
                        &Cli,
                        &directory(),
                        &control.claude_notifications,
                        &mut b,
                        &observed,
                    )
                    .await?;
                }
                Ok::<_, String>(())
            };
            tokio::select! {
                biased;
                _ = shutdown.changed() => break,
                result = cycle => if let Err(error) = result { crate::logs::record("WARN", &format!("Claude notification persistence/observation failed: {error}"), None); },
            }
            recovering = false;
            drop(control);
            tokio::select! {
                _ = shutdown.changed() => break,
                _ = tokio::time::sleep(Duration::from_secs(2)) => {},
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as SyncMutex;
    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("arc-notify-test-{}", id())))
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    struct Fake {
        result: Result<Vec<u8>>,
        calls: SyncMutex<Vec<Vec<String>>>,
        fallbacks: SyncMutex<Vec<String>>,
    }
    impl Fake {
        fn new(result: Result<Vec<u8>>) -> Self {
            Self {
                result,
                calls: Default::default(),
                fallbacks: Default::default(),
            }
        }
        fn success() -> Self {
            Self::new(Ok(br#"{"ok":true,"session_id":"session_test"}"#.to_vec()))
        }
    }
    impl Executor for Fake {
        async fn send(&self, args: Vec<String>) -> Result<Vec<u8>> {
            self.calls.lock().unwrap().push(args);
            self.result.clone()
        }
        async fn fallback(&self, body: String) {
            self.fallbacks.lock().unwrap().push(body);
        }
    }
    async fn process(
        executor: &impl Executor,
        dir: &Path,
        b: &mut Binding,
        observation: &Value,
    ) -> Result<()> {
        super::process(executor, dir, &Mutex::new(()), b, observation).await
    }
    async fn recover(executor: &impl Executor, dir: &Path, b: &mut Binding) -> Result<()> {
        if super::recover(dir, b)? {
            executor.fallback(fallback_body(b)).await;
        }
        Ok(())
    }
    fn fixture(dir: &Path) -> Binding {
        bind_in(
            dir,
            Some("session_test"),
            "thread-1",
            "turn-1",
            "/projects/sample",
        )
        .unwrap();
        binding(dir, "thread-1", "turn-1").unwrap().unwrap()
    }
    fn interaction(id: Value) -> Value {
        json!({"state":"interaction-required", "interaction":[{"id":id,"method":"item/commandExecution/requestApproval","params":{"command":"SECRET_COMMAND"}}],"activeFlags":["waitingOnApproval"],"finalResponse":"SECRET_OUTPUT","error":"SECRET_ERROR"})
    }
    #[test]
    fn session_forms_and_turn_isolation() {
        for input in [
            "session_test",
            "https://claude.ai/code/session_test?x=y",
            "claude.ai/code/session_test",
            "http://claude.ai/code/session_test#fragment",
        ] {
            assert_eq!(session_id(input).unwrap(), "session_test");
        }
        assert_eq!(session_id("cse_test").unwrap(), "cse_test");
        for bad in [
            "",
            "session_",
            "cse_",
            "hello world",
            "--help",
            "https://other.invalid/code/session_test",
            "session_a extra",
        ] {
            assert!(session_id(bad).is_err());
        }
        let dir = Sandbox::new();
        fixture(&dir.0);
        bind_in(
            &dir.0,
            Some("cse_other"),
            "thread-1",
            "turn-2",
            "/projects/sample",
        )
        .unwrap();
        bind_in(&dir.0, None, "thread-1", "turn-3", "/projects/sample").unwrap();
        assert_eq!(
            binding(&dir.0, "thread-1", "turn-1")
                .unwrap()
                .unwrap()
                .session_id
                .as_deref(),
            Some("session_test")
        );
        assert_eq!(
            binding(&dir.0, "thread-1", "turn-2")
                .unwrap()
                .unwrap()
                .session_id
                .as_deref(),
            Some("cse_other")
        );
        assert!(binding(&dir.0, "thread-1", "turn-3").unwrap().is_none());
        bind_in(&dir.0, None, "thread-1", "turn-2", "").unwrap();
        assert_eq!(
            binding(&dir.0, "thread-1", "turn-2")
                .unwrap()
                .unwrap()
                .session_id
                .as_deref(),
            Some("cse_other")
        );
    }
    #[tokio::test]
    async fn steer_without_session_keeps_binding_and_new_turn_stays_unbound() {
        let dir = Sandbox::new();
        fixture(&dir.0);
        bind_in(&dir.0, None, "thread-1", "turn-1", "").unwrap();
        bind_in(&dir.0, None, "thread-1", "turn-2", "").unwrap();
        let mut b = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
        assert_eq!(b.session_id.as_deref(), Some("session_test"));
        assert!(binding(&dir.0, "thread-1", "turn-2").unwrap().is_none());
        let fake = Fake::success();
        process(&fake, &dir.0, &mut b, &json!({"state":"completed"}))
            .await
            .unwrap();
        assert_eq!(fake.calls.lock().unwrap()[0][3], "session_test");
    }
    #[test]
    fn binding_failure_marks_receipt_without_changing_dispatch_result() {
        let dir = Sandbox::new();
        std::fs::create_dir_all(&dir.0).unwrap();
        let blocked = dir.0.join("not-a-directory");
        std::fs::write(&blocked, "fixture").unwrap();
        let result = bind_in(&blocked, Some("session_test"), "thread-1", "turn-1", "");
        assert!(result.is_err());
        let mut receipt =
            json!({"state":"completed","result":{"submitted":true,"turnId":"turn-1"}});
        record_binding(&mut receipt, result);
        assert_eq!(receipt["state"], "completed");
        assert_eq!(
            receipt["result"],
            json!({"submitted":true,"turnId":"turn-1"})
        );
        assert_eq!(receipt["claudeNotification"], "bind-failed");
    }
    #[test]
    fn seven_day_cleanup_covers_terminal_and_unfinished_records() {
        for terminal in [false, true] {
            let dir = Sandbox::new();
            let mut b = fixture(&dir.0);
            b.terminal = terminal;
            b.created_at = 100;
            persist(&dir.0, &b).unwrap();
            // A later rebind/write must not extend the observation lifetime.
            bind_in(&dir.0, Some("cse_other"), "thread-1", "turn-1", "").unwrap();
            let b = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
            assert_eq!(b.created_at, 100);
            assert!(!remove_expired(&dir.0, &b, 100 + RETENTION_SECONDS).unwrap());
            assert!(remove_expired(&dir.0, &b, 101 + RETENTION_SECONDS).unwrap());
            assert!(binding(&dir.0, "thread-1", "turn-1").unwrap().is_none());
        }
    }
    #[tokio::test]
    async fn delivery_releases_lock_and_merges_result_without_overwriting_rebind() {
        struct Probe<'a> {
            lock: &'a Mutex<()>,
            dir: &'a Path,
            fail: bool,
        }
        impl Executor for Probe<'_> {
            async fn send(&self, _: Vec<String>) -> Result<Vec<u8>> {
                let _guard = self
                    .lock
                    .try_lock()
                    .expect("CLI must not hold binding lock");
                let b = binding(self.dir, "thread-1", "turn-1")?.unwrap();
                assert_eq!(b.deliveries[0].status, "sending");
                bind_in(self.dir, Some("cse_other"), "thread-1", "turn-1", "")?;
                if self.fail {
                    Err("simulated failure".into())
                } else {
                    Ok(br#"{"ok":true,"session_id":"session_test"}"#.to_vec())
                }
            }
            async fn fallback(&self, _: String) {
                let _guard = self
                    .lock
                    .try_lock()
                    .expect("fallback must not hold binding lock");
            }
        }
        for fail in [false, true] {
            let dir = Sandbox::new();
            let mut b = fixture(&dir.0);
            let lock = Mutex::new(());
            let probe = Probe {
                lock: &lock,
                dir: &dir.0,
                fail,
            };
            super::process(&probe, &dir.0, &lock, &mut b, &interaction(json!(17)))
                .await
                .unwrap();
            let b = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
            assert_eq!(b.session_id.as_deref(), Some("cse_other"));
            assert_eq!(b.deliveries[0].session_id, "session_test");
            assert_eq!(
                b.deliveries[0].status,
                if fail { "failed" } else { "delivered" }
            );
            assert_eq!(notification(Some(b))["deliveries"], json!([]));
        }
    }

    #[tokio::test]
    async fn request_dedup_survives_restart_and_terminal_follows_interaction() {
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let fake = Fake::success();
        process(&fake, &dir.0, &mut b, &interaction(json!(17)))
            .await
            .unwrap();
        let mut b = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
        recover(&fake, &dir.0, &mut b).await.unwrap();
        process(&fake, &dir.0, &mut b, &interaction(json!(17)))
            .await
            .unwrap();
        process(&fake, &dir.0, &mut b, &json!({"state":"running"}))
            .await
            .unwrap();
        process(&fake, &dir.0, &mut b, &interaction(json!(17)))
            .await
            .unwrap();
        process(&fake, &dir.0, &mut b, &interaction(json!(18)))
            .await
            .unwrap();
        for _ in 0..2 {
            process(
                &fake,
                &dir.0,
                &mut b,
                &json!({"state":"completed","finalResponse":"SECRET_OUTPUT"}),
            )
            .await
            .unwrap();
        }
        assert_eq!(fake.calls.lock().unwrap().len(), 3);
        assert!(b.terminal);
        let report = notification(binding(&dir.0, "thread-1", "turn-1").unwrap());
        assert_eq!(report["sessionId"], "session_test");
        assert_eq!(
            report["deliveries"][2],
            json!({"state":"完成", "status":"delivered"})
        );
        assert!(b.deliveries.iter().all(|d| d.status == "delivered"));
        let calls = fake.calls.lock().unwrap();
        assert_eq!(
            calls[0],
            vec![
                "-p",
                "Codex 任务通知：项目 sample，线程 thread-1，轮次 turn-1，状态 等待审批，请检查。",
                "--cloud",
                "session_test",
                "--output-format",
                "json"
            ]
        );
        assert!(!serde_json::to_string(&*calls).unwrap().contains("SECRET"));
        assert!(
            !std::fs::read_to_string(path_in(&dir.0, "thread-1", "turn-1"))
                .unwrap()
                .contains("SECRET")
        );
    }
    #[tokio::test]
    async fn steering_rebind_does_not_report_old_session_delivery() {
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let fake = Fake::success();
        process(&fake, &dir.0, &mut b, &interaction(json!(17)))
            .await
            .unwrap();
        bind_in(&dir.0, Some("cse_other"), "thread-1", "turn-1", "").unwrap();
        let mut b = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
        let report = notification(Some(b.clone()));
        assert_eq!(report["sessionId"], "cse_other");
        assert_eq!(report["deliveries"], json!([]));
        process(&fake, &dir.0, &mut b, &interaction(json!(17)))
            .await
            .unwrap();
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
        let other = Fake::new(Ok(br#"{"ok":true,"session_id":"cse_other"}"#.to_vec()));
        process(&other, &dir.0, &mut b, &json!({"state":"completed"}))
            .await
            .unwrap();
        assert_eq!(other.calls.lock().unwrap()[0][3], "cse_other");
        assert_eq!(
            notification(Some(b))["deliveries"],
            json!([{"state":"完成","status":"delivered"}])
        );
    }

    #[tokio::test]
    async fn idless_waiting_uses_confirmed_state_entries() {
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let fake = Fake::success();
        let wait = json!({"state":"interaction-required","activeFlags":["waitingOnUserInput"]});
        process(&fake, &dir.0, &mut b, &wait).await.unwrap();
        for state in ["unconfirmed", "timeout", "interaction-required"] {
            let observation = if state == "interaction-required" {
                wait.clone()
            } else {
                json!({"state":state})
            };
            process(&fake, &dir.0, &mut b, &observation).await.unwrap();
        }
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
        process(&fake, &dir.0, &mut b, &json!({"state":"running"}))
            .await
            .unwrap();
        process(&fake, &dir.0, &mut b, &wait).await.unwrap();
        assert_eq!(fake.calls.lock().unwrap().len(), 2);
        assert_eq!(b.deliveries[0].state, "等待输入");
    }
    #[tokio::test]
    async fn failures_fallback_once_without_retry_including_unknown_results() {
        for result in [
            Err("timeout".into()),
            Err("not installed".into()),
            Ok(b"not json".to_vec()),
            Ok(br#"{"ok":false,"error":"SECRET_ERROR"}"#.to_vec()),
            Ok(br#"{"ok":true,"session_id":"session_wrong"}"#.to_vec()),
        ] {
            let dir = Sandbox::new();
            let mut b = fixture(&dir.0);
            let fake = Fake::new(result);
            for _ in 0..2 {
                process(
                    &fake,
                    &dir.0,
                    &mut b,
                    &json!({"state":"failed","error":"SECRET_ERROR"}),
                )
                .await
                .unwrap();
            }
            assert_eq!(fake.calls.lock().unwrap().len(), 1);
            assert_eq!(fake.fallbacks.lock().unwrap().len(), 1);
            assert!(!fake.fallbacks.lock().unwrap()[0].contains("SECRET"));
            assert_eq!(b.deliveries[0].status, "failed");
            assert_eq!(b.deliveries[0].state, "失败");
        }
    }
    #[tokio::test]
    async fn interrupted_delivery_recovers_as_failed_without_resending() {
        let dir = Sandbox::new();
        let mut b = fixture(&dir.0);
        let fake = Fake::success();
        b.deliveries.push(Delivery {
            key: "request:17".into(),
            session_id: "session_test".into(),
            state: "等待审批".into(),
            status: "sending".into(),
        });
        persist(&dir.0, &b).unwrap();
        let mut b = binding(&dir.0, "thread-1", "turn-1").unwrap().unwrap();
        recover(&fake, &dir.0, &mut b).await.unwrap();
        recover(&fake, &dir.0, &mut b).await.unwrap();
        process(&fake, &dir.0, &mut b, &interaction(json!(17)))
            .await
            .unwrap();
        assert!(fake.calls.lock().unwrap().is_empty());
        assert_eq!(fake.fallbacks.lock().unwrap().len(), 1);
        process(&fake, &dir.0, &mut b, &json!({"state":"cancelled"}))
            .await
            .unwrap();
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
        assert_eq!(b.deliveries[1].state, "中断");
    }
}
