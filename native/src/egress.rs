//! Pure MCP output projection. Storage and execution live outside this module.
use crate::*;
pub fn tool(value: Value, error: bool) -> Value {
    json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":{"result":value},"isError":error})
}
pub fn failure(e: &str) -> Value {
    if let Ok(value) = serde_json::from_str::<Value>(e) {
        if value["code"] == "PERMISSION_REQUIRED" {
            return value;
        }
    }
    let rpc = e
        .strip_prefix("RPC_REJECTED:")
        .and_then(|s| serde_json::from_str::<Value>(s).ok());
    json!({"code":if rpc.is_some(){"NATIVE_RPC_ERROR"}else{if e == "REQUEST_ID_CONFLICT" { "REQUEST_ID_CONFLICT" } else { "CONTROL_ERROR" }},"message":e,"rpcError":rpc})
}

/// Public receipts never echo submitted arguments or internal execution records.
pub fn receipt(value: Value) -> Value {
    if !value["requestId"].is_string() || !value["state"].is_string() {
        return value;
    }
    let mut out = json!({});
    for key in [
        "requestId",
        "state",
        "operation",
        "threadId",
        "turnId",
        "taskId",
        "error",
        "claudeNotification",
        "claudeNotificationError",
    ] {
        if !value[key].is_null() {
            out[key] = value[key].clone();
        }
    }
    let result = &value["result"];
    for key in ["threadId", "turnId", "taskId"] {
        if out[key].is_null() && !result[key].is_null() {
            out[key] = result[key].clone();
        }
    }
    if out["threadId"].is_null() && result["thread"]["id"].is_string() {
        out["threadId"] = result["thread"]["id"].clone();
    }
    if out["turnId"].is_null() && result["turn"]["id"].is_string() {
        out["turnId"] = result["turn"]["id"].clone();
    }
    if value.get("result").is_some() {
        let operation = string(&value, "operation");
        let mut result = result.clone();
        if let Some(fields) = result.as_object_mut() {
            for key in ["threadId", "turnId", "taskId"] {
                if !out[key].is_null() {
                    fields.remove(key);
                }
            }
            for key in [
                "arguments",
                "params",
                "prompt",
                "input",
                "digest",
                "origin",
                "backendSession",
                "resolved",
                "task",
                "thread",
                "turn",
                "native",
            ] {
                fields.remove(key);
            }
            if matches!(operation, "create" | "send" | "interrupt")
                || operation.starts_with("agent_")
            {
                fields.retain(|key, _| {
                    [
                        "threadId",
                        "turnId",
                        "taskId",
                        "sessionId",
                        "desktopUrl",
                        "submitted",
                        "accepted",
                        "responseSent",
                        "status",
                        "output",
                        "outputTruncated",
                        "error",
                        "stopReason",
                    ]
                    .contains(&key.as_str())
                });
            }
        }
        if result.as_object().is_none_or(|m| !m.is_empty()) {
            out["result"] = result;
        }
    }
    out
}
