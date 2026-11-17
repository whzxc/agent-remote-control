//! Client metadata only. Ingress identity and authentication remain generic.
use crate::{json, string, Value};
use std::sync::OnceLock;

pub fn presets() -> &'static Vec<Value> {
    static PRESETS: OnceLock<Vec<Value>> = OnceLock::new();
    PRESETS.get_or_init(|| {
        serde_json::from_str(include_str!("../../shared/control-sources.json"))
            .expect("valid bundled control source registry")
    })
}
pub fn preset(source: &str) -> Value {
    presets()
        .iter()
        .find(|p| p["id"] == source)
        .cloned()
        .unwrap_or_else(|| json!({"id":source,"platform":"custom","displayName":source,"curated":false,"status":"custom","recommendedTransport":"https","recommendedAuth":"bearer","caveat":{"en":"Check the client's transport and auth support; unknown sources remain valid."}}))
}
pub fn default_name(source: &str, names: &[String]) -> String {
    let p = preset(source);
    let base = string(&p, "displayName");
    let mut candidate = base.to_owned();
    let mut suffix = 2;
    while names.contains(&candidate) {
        candidate = format!("{base} {suffix}");
        suffix += 1;
    }
    candidate
}

/// Bound task waits by the authenticated source product, not caller-supplied arguments.
pub(crate) fn limit_wait(origin: &Value, args: &mut Value) -> Option<Value> {
    let source = string(origin, "controlSource");
    let metadata = preset(source);
    let limit = metadata["waitTimeoutMs"].as_u64()?;
    let requested = args["timeoutMs"].as_u64().unwrap_or(30000);
    if requested <= limit {
        return None;
    }
    args["timeoutMs"] = json!(limit);
    Some(
        json!({"controlSource":source,"requestedTimeoutMs":requested,"timeoutMs":limit,
        "capped":true,"reason":metadata["waitTimeoutReason"],
        "hint":"Continue long tasks in multiple waits using next.args and the previous snapshotHash as expectedHash."}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_wait_caps_and_continuations_follow_source_metadata() {
        // Algorithmic core: task wait caps and continuations follow source metadata.
        for source in presets().iter().map(|p| string(p, "id")).chain(["custom"]) {
            for op in ["codex_wait", "agent_wait"] {
                for until in [
                    "terminal",
                    "interaction-required",
                    "terminal-or-interaction",
                ] {
                    let mut args = json!({"threadId":"thread","agent":"pi","taskId":"task","turnId":"turn","timeoutMs":1800000,"until":until});
                    let cap = limit_wait(&json!({"controlSource":source}), &mut args);
                    let expected = if source == "claude" { 170000 } else { 1800000 };
                    assert_eq!(args["timeoutMs"], expected);
                    assert_eq!(cap.is_some(), source == "claude");
                    if let Some(cap) = cap {
                        assert_eq!(cap["requestedTimeoutMs"], 1800000);
                        assert_eq!(cap["timeoutMs"], expected);
                        assert_eq!(cap["capped"], true);
                    }
                    let mut result = json!({"state":"timeout","snapshotHash":"opaque"});
                    crate::egress::next(&mut result, op, &args, false);
                    assert_eq!(result["next"]["args"]["until"], until);
                    assert_eq!(result["next"]["args"]["timeoutMs"], expected);
                    assert_eq!(result["next"]["args"]["expectedHash"], "opaque");
                }
            }
        }
        for timeout in [None, Some(30000), Some(170000)] {
            let mut args = json!({});
            if let Some(timeout) = timeout {
                args["timeoutMs"] = json!(timeout);
            }
            let original = args.clone();
            assert!(limit_wait(&json!({"controlSource":"claude"}), &mut args).is_none());
            assert_eq!(args, original);
        }
    }
}
