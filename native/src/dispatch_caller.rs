//! Optional display attribution, independent of source identity and task ownership.
use crate::*;

tokio::task_local! { pub(crate) static CALLER: Option<Value>; }

const SESSION_ENV: &[(&str, &str)] = &[
    ("claude", "CLAUDE_CODE_SESSION_ID"),
    ("codex", "CODEX_THREAD_ID"),
    ("pi", "PI_SESSION_ID"),
];

pub(crate) fn from_environment(mut read: impl FnMut(&str) -> Option<String>) -> Option<Value> {
    let mut callers = SESSION_ENV.iter().filter_map(|(agent, key)| {
        read(key)
            .filter(|id| !id.trim().is_empty() && id != "unknown")
            .map(|id| json!({"agent":agent,"conversationId":id}))
    });
    let caller = callers.next()?;
    callers.next().is_none().then_some(caller)
}

pub(crate) fn validated(value: &Value) -> Option<Value> {
    let agent = value["agent"].as_str()?;
    let id = value["conversationId"]
        .as_str()
        .filter(|id| !id.trim().is_empty() && *id != "unknown")?;
    SESSION_ENV
        .iter()
        .any(|(known, _)| *known == agent)
        .then(|| json!({"agent":agent,"conversationId":id}))
}

pub(crate) fn attach_current(value: &mut Value) {
    if let Some(caller) = CALLER.try_with(Clone::clone).ok().flatten() {
        value["caller"] = caller;
    }
}

pub(crate) fn control_request(op: &str, args: &Value) -> Value {
    let mut body = json!({"op":op,"args":args});
    if matches!(
        op,
        "codex_create" | "codex_send" | "agent_create" | "agent_send"
    ) {
        if let Some(caller) = from_environment(|key| std::env::var(key).ok()) {
            body["caller"] = caller;
        }
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    // Run the real process-environment path without changing the test runner's environment.
    fn isolated(test: &str) -> bool {
        if std::env::var("ARC_CALLER_TEST").as_deref() == Ok(test) {
            return false;
        }
        let state = std::env::temp_dir().join(format!("arc-caller-{}", id()));
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.args([
            "--exact",
            &format!("dispatch_caller::tests::{test}"),
            "--nocapture",
        ]);
        for (_, key) in SESSION_ENV {
            command.env_remove(key);
        }
        let result = command
            .env("ARC_CALLER_TEST", test)
            .env("ARC_STATE_DIR", &state)
            .env("CLAUDE_CODE_SESSION_ID", "fixture-claude-conversation")
            .output()
            .unwrap();
        let _ = std::fs::remove_dir_all(state);
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        true
    }

    #[test]
    fn cli_dispatch_captures_caller() {
        // Recurring bug class: local CLI dispatches lost the calling Agent conversation and appeared only as local-cli.
        if isolated("cli_dispatch_captures_caller") {
            for (agent, key) in SESSION_ENV {
                assert_eq!(
                    from_environment(|name| (name == *key).then(|| "session".into())),
                    Some(json!({"agent":agent,"conversationId":"session"}))
                );
            }
            assert!(from_environment(|_| None).is_none());
            assert!(from_environment(|_| Some("session".into())).is_none());
            for empty in ["", "  ", "unknown"] {
                assert!(from_environment(|_| Some(empty.into())).is_none());
            }
            assert!(
                validated(&json!({"agent":"unconfirmed","conversationId":"session"})).is_none()
            );
            return;
        }
        let args = json!({"prompt":"Fixture dispatch","notify":null});
        for op in ["codex_create", "codex_send", "agent_create", "agent_send"] {
            let body = control_request(op, &args);
            assert_eq!(
                body["caller"],
                json!({"agent":"claude","conversationId":"fixture-claude-conversation"})
            );
            assert_eq!(body["args"], args);
            assert!(body.get("origin").is_none());
        }
        assert!(control_request("codex_read", &json!({}))
            .get("caller")
            .is_none());
    }

    
}
