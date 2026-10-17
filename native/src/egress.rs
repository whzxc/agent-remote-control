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
        "agent",
        "error",
        "notification",
        "notificationError",
        "next",
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

pub(crate) fn guide(origin: &Value, args: &Value, locale: &str) -> Value {
    let topic = args["topic"].as_str().unwrap_or("loop");
    let source = match string(origin, "controlSource") {
        "claude" => "claude",
        "chatgpt" => "chatgpt",
        _ => "other",
    };
    let guides = &catalog()["guides"][if locale == "zh-CN" { "zh-CN" } else { "en" }];
    let body = if topic == "loop" {
        &guides[topic][source]
    } else {
        &guides[topic]
    };
    json!({"topic":topic,"controlSource":source,"content":format!("{}\n{}",body.as_str().unwrap_or(""),guides["common"].as_str().unwrap_or(""))})
}

/// Only suggest reads or waits; a suggested next step never authorizes a write.
pub(crate) fn next(value: &mut Value, name: &str, args: &Value, push_available: bool) {
    if !value.is_object() {
        return;
    }
    let agent = name.starts_with("agent_") || string(value, "operation").starts_with("agent_");
    let task = value["taskId"].as_str().or_else(|| args["taskId"].as_str());
    let thread = value["threadId"]
        .as_str()
        .or_else(|| args["threadId"].as_str());
    let turn = value["turnId"].as_str().or_else(|| args["turnId"].as_str());
    let wait_args = if agent {
        json!({"agent":value["agent"].as_str().or_else(||args["agent"].as_str()),"taskId":task,"turnId":turn})
    } else {
        json!({"threadId":thread,"turnId":turn})
    };
    let wait_tool = if agent { "agent_wait" } else { "codex_wait" };
    let next = if value["state"] == "awaiting-approval" {
        json!({"hint":"Inspect the original request, then decide according to user intent.","tool":"receipt","arguments":{"requestId":value["requestId"],"action":"read"}})
    } else if value["state"] == "interaction-required" {
        if agent {
            json!({"hint":"Read the pending interaction, then use agent_respond with the user's decision.","tool":"agent_pending","arguments":{"agent":wait_args["agent"],"taskId":task}})
        } else {
            json!({"hint":"Read the pending interaction, then use codex_respond; if none is exposed, use Codex Desktop.","tool":"codex_pending","arguments":{}})
        }
    } else if matches!(name, "codex_wait" | "agent_wait") && value["state"] == "timeout" {
        let mut arguments = wait_args;
        if value["snapshotHash"].is_string() {
            arguments["expectedHash"] = value["snapshotHash"].clone();
        }
        if let Some(timeout) = args.get("timeoutMs") {
            arguments["timeoutMs"] = timeout.clone();
        }
        json!({"hint":"Continue waiting with the same task and turn.","tool":wait_tool,"arguments":arguments})
    } else if matches!(value["state"].as_str(), Some("pending" | "reserved"))
        && value["requestId"].is_string()
    {
        json!({"hint":"Read the dispatch receipt before waiting for the task.","tool":"receipt","arguments":{"requestId":value["requestId"]}})
    } else if (matches!(
        name,
        "codex_create" | "codex_send" | "agent_create" | "agent_send"
    ) || matches!(
        string(value, "operation"),
        "create" | "send" | "agent_create" | "agent_send"
    )) && turn.is_some()
        && value["state"] == "completed"
    {
        if push_available {
            json!({"hint":"You may end this turn and wait for an [ARC] notification; use guide for the review workflow."})
        } else {
            json!({"hint":"Active wakeup is unavailable; continue with segmented waits and watch arcInbox.","tool":wait_tool,"arguments":wait_args})
        }
    } else {
        return;
    };
    value["next"] = next;
}
