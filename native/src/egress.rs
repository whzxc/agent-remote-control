//! Pure MCP output projection. Storage and execution live outside this module.
use crate::*;
pub fn tool(mut value: Value, error: bool) -> Value {
    if !value.is_object() {
        value = json!({"value":value});
    }
    value["arcVersion"] = json!(arc_version());
    json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":{"result":value},"isError":error})
}
pub fn failure(e: &str) -> Value {
    if let Ok(value) = serde_json::from_str::<Value>(e) {
        if matches!(
            value["code"].as_str(),
            Some(
                "PERMISSION_REQUIRED"
                    | "INVALID_ARGUMENTS"
                    | "UNKNOWN_OP"
                    | "OP_UNAVAILABLE"
                    | "WRONG_TOOL"
            )
        ) {
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

pub(crate) fn arc_version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION.get_or_init(|| hash(catalog().to_string())[..12].to_owned())
}

pub(crate) fn via(spec: &Value) -> &'static str {
    if spec["annotations"]["readOnlyHint"] == true {
        "query"
    } else {
        "act"
    }
}

pub(crate) fn example(spec: &Value) -> Value {
    json!({"tool":via(spec),"arguments":{"op":spec["name"],"args":spec["example"]}})
}

pub(crate) fn validate_op(spec: &Value, args: &Value) -> Result<()> {
    crate::validator("op", string(spec, "name"), &spec["inputSchema"])?
        .validate(args)
        .map_err(|error| json!({"code":"INVALID_ARGUMENTS","op":spec["name"],"message":error.to_string(),"inputSchema":spec["inputSchema"],"example":example(spec)}).to_string())
}

pub(crate) fn unknown_op(name: &str, ops: &[Value]) -> String {
    // Edit distance ranks current, enabled names without keeping old aliases.
    fn distance(a: &str, b: &str) -> usize {
        let b: Vec<_> = b.chars().collect();
        let mut row: Vec<_> = (0..=b.len()).collect();
        for (i, ca) in a.chars().enumerate() {
            let mut diagonal = row[0];
            row[0] = i + 1;
            for (j, cb) in b.iter().enumerate() {
                let old = row[j + 1];
                row[j + 1] = (row[j] + 1)
                    .min(old + 1)
                    .min(diagonal + usize::from(ca != *cb));
                diagonal = old;
            }
        }
        row[b.len()]
    }
    let mut candidates: Vec<_> = ops.iter().map(|op| string(op, "name")).collect();
    candidates.sort_by_key(|candidate| (distance(name, candidate), *candidate));
    candidates.truncate(3);
    json!({"code":"UNKNOWN_OP","op":name,"message":"Call guide for the enabled op index, then guide({op}) for its schema.","candidates":candidates}).to_string()
}

pub(crate) fn guide(origin: &Value, args: &Value, locale: &str, ops: &[Value]) -> Value {
    if let Some(name) = args["op"].as_str() {
        let spec = catalog()["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["name"] == name)
            .unwrap();
        return json!({"op":name,"via":via(spec),"description":spec["description"],"inputSchema":spec["inputSchema"],"example":example(spec)});
    }
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
    let examples: Vec<_> = ops
        .iter()
        .filter(|op| {
            matches!(
                string(op, "name"),
                "codex_create"
                    | "codex_send"
                    | "codex_wait"
                    | "codex_read"
                    | "codex_changes"
                    | "read"
                    | "search"
            )
        })
        .map(|op| {
            let mut call = example(op);
            if source == "claude" && matches!(string(op, "name"), "codex_create" | "codex_send") {
                call["arguments"]["args"]["notify"] =
                    json!({"channel":"claude-session","target":"<your cloud session ID or URL>"});
            }
            call
        })
        .collect();
    json!({"topic":topic,"controlSource":source,"content":format!("{}\n{}",body.as_str().unwrap_or(""),guides["common"].as_str().unwrap_or("")),"examples":examples,"ops":ops.iter().map(|op| json!({"op":op["name"],"via":via(op),"description":op["description"].as_str().unwrap_or("").split(['。','\n']).next().unwrap_or("")})).collect::<Vec<_>>()})
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
        json!({"hint":"Inspect the original request, then decide according to user intent.","via":"act","op":"receipt","args":{"requestId":value["requestId"],"action":"read"}})
    } else if value["state"] == "interaction-required" {
        if agent {
            json!({"hint":"Read the pending interaction, then use act agent_respond with the user's decision.","via":"query","op":"agent_pending","args":{"agent":wait_args["agent"],"taskId":task}})
        } else {
            json!({"hint":"Read the pending interaction, then use act codex_respond; if none is exposed, use Codex Desktop.","via":"query","op":"codex_pending","args":{}})
        }
    } else if matches!(name, "codex_wait" | "agent_wait") && value["state"] == "timeout" {
        let mut arguments = wait_args;
        if value["snapshotHash"].is_string() {
            arguments["expectedHash"] = value["snapshotHash"].clone();
        }
        if let Some(timeout) = args.get("timeoutMs") {
            arguments["timeoutMs"] = timeout.clone();
        }
        json!({"hint":"Continue waiting with the same task and turn.","via":"query","op":wait_tool,"args":arguments})
    } else if matches!(value["state"].as_str(), Some("pending" | "reserved"))
        && value["requestId"].is_string()
    {
        json!({"hint":"Read the dispatch receipt before waiting for the task.","via":"act","op":"receipt","args":{"requestId":value["requestId"]}})
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
            json!({"hint":"Active wakeup is unavailable; continue with segmented waits and watch arcInbox.","via":"query","op":wait_tool,"args":wait_args})
        }
    } else {
        return;
    };
    value["next"] = next;
}
