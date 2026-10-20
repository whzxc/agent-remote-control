//! Pure MCP output projection. Storage and execution live outside this module.
use crate::*;
pub fn tool(mut value: Value, error: bool) -> Value {
    if !value.is_object() {
        value = json!({"value":value});
    }
    value["arcVersion"] = json!(arc_version());
    let text = if error {
        format!(
            "{{\"error\":{},\"arcVersion\":{}}}",
            value["error"], value["arcVersion"]
        )
    } else {
        value.to_string()
    };
    json!({"content":[{"type":"text","text":text}],"structuredContent":{"result":value},"isError":error})
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
        "createdAt",
        "dispatchMode",
        "queueId",
        "state",
        "operation",
        "threadId",
        "turnId",
        "taskId",
        "agent",
        "error",
        "notification",
        "notificationError",
        "executionOwner",
        "failureStage",
        "cleanup",
        "next",
    ] {
        if !value[key].is_null() {
            out[key] = value[key].clone();
        }
    }
    let result = &value["result"];
    if value["task"]["dispatch"].is_object() {
        out["dispatch"] = value["task"]["dispatch"].clone();
    }
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
                        "dispatch",
                        "review",
                        "promptSubmitted",
                        "configurationError",
                        "configurationState",
                        "sessionConfirmation",
                        "turnEvidence",
                    ]
                    .contains(&key.as_str())
                });
            }
        }
        if result.as_object().is_none_or(|m| !m.is_empty()) {
            out["result"] = result;
        }
    }
    if !dispatch_receipt(&out) {
        out.as_object_mut().unwrap().remove("notification");
        out.as_object_mut().unwrap().remove("notificationError");
    }
    out
}

pub(crate) fn dispatch_receipt(value: &Value) -> bool {
    matches!(
        string(value, "operation"),
        "create" | "send" | "agent_create" | "agent_send"
    )
}

pub(crate) fn arc_version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION.get_or_init(|| protocol_hash(catalog()))
}

fn protocol_hash(catalog: &Value) -> String {
    let mut ops: Vec<_> = catalog["ops"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|op| {
            json!({"op":op["name"],"via":via(op),"description":op["description"],
            "inputSchema":op["inputSchema"],"signature":signature(op),"example":example(op)})
        })
        .collect();
    ops.sort_by(|a, b| string(a, "op").cmp(string(b, "op")));
    hash(
        json!({"tools":catalog["tools"],"instructions":catalog["instructions"],
        "guides":catalog["guides"],"ops":ops,"events":crate::claude_notify::subscriptions::guide()})
        .to_string(),
    )[..12]
        .to_owned()
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

pub(crate) fn invalid_arguments(op: &str, field: &str, message: &str) -> String {
    json!({"code":"INVALID_ARGUMENTS","op":op,"field":field,"message":message,
        "guide":{"tool":"query","arguments":{"op":"guide","args":if op.is_empty(){json!({})}else{json!({"op":op})}}}}).to_string()
}

pub(crate) fn validation_error(
    op: &str,
    schema: &Value,
    error: &jsonschema::ValidationError<'_>,
) -> String {
    use jsonschema::error::ValidationErrorKind as Kind;
    let mut field = error.instance_path.to_string();
    let message = match &error.kind {
        Kind::Required { property } => {
            field.push('/');
            field.push_str(property.as_str().unwrap_or(""));
            "Required field is missing.".into()
        }
        Kind::AdditionalProperties { unexpected } => {
            let name = &unexpected[0];
            let parent = error
                .schema_path
                .as_str()
                .strip_suffix("/additionalProperties")
                .unwrap_or("");
            let properties = schema.pointer(parent).unwrap_or(schema)["properties"].as_object();
            let suggestion = properties.and_then(|p| {
                if name == "order" && op == "codex_items" {
                    return Some("latest");
                }
                p.keys()
                    .min_by_key(|key| distance(name, key))
                    .filter(|key| distance(name, key) <= 3)
                    .map(String::as_str)
            });
            field.push('/');
            field.push_str(name);
            suggestion
                .map(|key| format!("Unknown field; did you mean {key}?"))
                .unwrap_or_else(|| "Unknown field; see guide for supported parameters.".into())
        }
        Kind::Type { .. } => error.masked().to_string(),
        Kind::Enum { options } => format!("Expected one of {options}."),
        Kind::Constant { expected_value } => format!("Expected {expected_value}."),
        Kind::Maximum { limit } => format!("Must be at most {limit}."),
        Kind::Minimum { limit } => format!("Must be at least {limit}."),
        Kind::ExclusiveMaximum { limit } => format!("Must be less than {limit}."),
        Kind::ExclusiveMinimum { limit } => format!("Must be greater than {limit}."),
        Kind::MinLength { limit } => format!("Must contain at least {limit} characters."),
        Kind::MaxLength { limit } => format!("Must contain at most {limit} characters."),
        Kind::MinItems { limit } => format!("Must contain at least {limit} items."),
        Kind::MaxItems { limit } => format!("Must contain at most {limit} items."),
        Kind::Format { format } => format!("Expected {format} format."),
        Kind::Pattern { .. } => "Value does not match the required format.".into(),
        Kind::AnyOf { context } | Kind::OneOfNotValid { context } => {
            // Report the closest branch's specific error, never the submitted JSON.
            if let Some(detail) = context
                .iter()
                .filter(|errors| !errors.is_empty())
                .min_by_key(|errors| errors.len())
                .and_then(|errors| errors.first())
            {
                return validation_error(op, schema, detail);
            }
            "Parameters do not match a supported form; see guide.".into()
        }
        Kind::Not { .. } | Kind::OneOfMultipleValid { .. } => {
            "Conflicting parameters; use one form from guide.".into()
        }
        _ => "Value does not satisfy this field's schema; see guide.".into(),
    };
    invalid_arguments(op, if field.is_empty() { "/" } else { &field }, &message)
}

pub(crate) fn validate_op(spec: &Value, args: &Value) -> Result<()> {
    crate::validator("op", string(spec, "name"), &spec["inputSchema"])?
        .validate(args)
        .map_err(|error| {
            if spec["name"] == "command" && error.instance_path.as_str().is_empty() {
                if args.get("cmd").is_some() {
                    for field in ["action", "params"] {
                        if args.get(field).is_some() {
                            return invalid_arguments(
                                "command",
                                &format!("/{field}"),
                                "Cannot combine with cmd; use cmd/cwd or action/params.",
                            );
                        }
                    }
                    if args.get("cwd").is_none() {
                        return invalid_arguments("command", "/cwd", "Required with cmd.");
                    }
                }
            }
            validation_error(string(spec, "name"), &spec["inputSchema"], &error)
        })
}

/// Normalize only documented aliases, before defaults and receipt hashing.
pub(crate) fn normalize_args(name: &str, args: &mut Value) -> Result<()> {
    let alias = match name {
        "git" | "git_write" => Some(("action", "operation")),
        "read" => Some(("limit", "lineCount")),
        _ => None,
    };
    if let Some((alias, canonical)) = alias {
        if let Some(value) = args.get(alias).cloned() {
            if args.get(canonical).is_some_and(|other| *other != value) {
                return Err(invalid_arguments(
                    name,
                    &format!("/{alias}"),
                    &format!("Must equal {canonical} when both are supplied."),
                ));
            }
            args.as_object_mut().unwrap().remove(alias);
            args[canonical] = value;
        }
    }
    if name == "search" && args["limit"].as_u64().is_some_and(|limit| limit > 50) {
        args["limit"] = json!(50);
    }
    Ok(())
}

fn signature(op: &Value) -> String {
    let schema = &op["inputSchema"];
    let mut names: Vec<Value> = op["guideParameters"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| {
            schema["properties"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(name, _)| json!(name))
                .collect()
        });
    for required in schema["required"].as_array().into_iter().flatten() {
        if !names.contains(required) {
            names.push(required.clone());
        }
    }
    let parameters: Vec<_> = names
        .iter()
        .map(|name| {
            let optional = if schema["required"]
                .as_array()
                .is_some_and(|r| r.contains(name))
            {
                ""
            } else {
                "?"
            };
            let property = &schema["properties"][name.as_str().unwrap()];
            let bound = property
                .get("maximum")
                .map(|max| format!("≤{max}"))
                .unwrap_or_default();
            format!("{}{optional}{bound}", name.as_str().unwrap())
        })
        .collect();
    let variants = schema
        .get("oneOf")
        .or_else(|| schema.get("anyOf"))
        .and_then(Value::as_array)
        .map(|branches| {
            branches
                .iter()
                .filter_map(|b| b["required"].as_array())
                .map(|names| {
                    names
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("+")
                })
                .collect::<Vec<_>>()
                .join(" | ")
        })
        .unwrap_or_default();
    format!(
        "{}({}){}",
        string(op, "name"),
        parameters.join(", "),
        if variants.is_empty() {
            String::new()
        } else {
            format!(" [{variants}]")
        }
    )
}

fn distance(a: &str, b: &str) -> usize {
    let b: Vec<_> = b.chars().collect();
    let mut row: Vec<_> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let old = row[j + 1];
            row[j + 1] = (row[j + 1] + 1)
                .min(row[j] + 1)
                .min(diagonal + usize::from(ca != *cb));
            diagonal = old;
        }
    }
    row[b.len()]
}

pub(crate) fn unknown_op(name: &str, ops: &[Value]) -> String {
    // Edit distance ranks current, enabled names without keeping old aliases.
    let mut candidates: Vec<_> = ops.iter().map(|op| string(op, "name")).collect();
    candidates.sort_by_key(|candidate| (distance(name, candidate), *candidate));
    candidates.truncate(3);
    json!({"code":"UNKNOWN_OP","op":name,"message":"Call guide for the enabled op index, then query({op: \"guide\", args: {op: \"<name>\"}}) for its schema (also works with a cached guide schema).","candidates":candidates}).to_string()
}

pub(crate) fn guide(origin: &Value, args: &Value, locale: &str, ops: &[Value]) -> Value {
    if let Some(name) = args["op"].as_str() {
        let spec = catalog()["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["name"] == name)
            .unwrap();
        return json!({"op":name,"via":via(spec),"description":spec["description"],"inputSchema":spec["inputSchema"],"signature":signature(spec),"example":example(spec)});
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
        .filter(|op| matches!(string(op, "name"), "codex_create" | "codex_wait" | "read"))
        .map(|op| {
            let mut call = example(op);
            if source == "claude" && matches!(string(op, "name"), "codex_create" | "codex_send") {
                call["arguments"]["args"]["notify"] =
                    json!({"channel":"claude-session","target":"<your cloud session ID or URL>"});
            }
            call
        })
        .collect();
    let index: Vec<_> = ops
        .iter()
        .map(|op| {
            let mut entry = json!({"op":op["name"],"via":via(op),"signature":signature(op)});
            if topic != "loop" {
                entry["description"] = json!(op["description"]
                    .as_str()
                    .unwrap_or("")
                    .split(['。', '\n'])
                    .next()
                    .unwrap_or(""));
            }
            entry
        })
        .collect();
    json!({"events":crate::claude_notify::subscriptions::guide(),"topic":topic,"controlSource":source,"content":format!("{}\n{}",body.as_str().unwrap_or(""),guides["common"].as_str().unwrap_or("")),"examples":examples,"ops":index})
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_tracks_visible_contract_not_internal_catalog_metadata() {
        let original = catalog().clone();
        let version = protocol_hash(&original);
        let mut changed = original.clone();
        changed["toolExposure"] = json!({"internal":"changed"});
        changed["domains"] = json!([]);
        assert_eq!(version, protocol_hash(&changed));
        changed["ops"].as_array_mut().unwrap().reverse();
        assert_eq!(version, protocol_hash(&changed));
        for field in ["description", "inputSchema", "guideParameters", "example"] {
            let mut changed = original.clone();
            changed["ops"][0][field] = match field {
                "guideParameters" => json!(["op"]),
                "inputSchema" => json!({"type":"object","properties":{"new":{"type":"string"}}}),
                _ => json!("changed"),
            };
            assert_ne!(version, protocol_hash(&changed), "{field}");
        }
        let mut changed = original;
        changed["guides"]["en"]["common"] = json!("changed guide text");
        assert_ne!(version, protocol_hash(&changed));
    }

    #[test]
    fn only_dispatch_receipts_expose_notification_delivery_details() {
        for operation in [
            "create",
            "send",
            "agent_create",
            "agent_send",
            "codex_review",
            "interrupt",
            "codex_respond",
        ] {
            let out = receipt(
                json!({"requestId":"test","state":"completed","operation":operation,
                "notification":{"deliveries":[{"timing":{"queueMs":31000}}]},"notificationError":"detail"}),
            );
            assert_eq!(out.get("notification").is_some(), dispatch_receipt(&out));
            assert_eq!(
                out.get("notificationError").is_some(),
                dispatch_receipt(&out)
            );
        }
    }
}
