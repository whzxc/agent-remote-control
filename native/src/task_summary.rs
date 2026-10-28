//! Bounded outcomes with an explicit field allowlist; no inbox or other task data.
use crate::*;

pub(crate) fn requested(name: &str, args: &Value) -> bool {
    args["view"] == "summary"
        && matches!(
            name,
            "codex_read" | "codex_wait" | "agent_read" | "agent_wait"
        )
}

pub(crate) async fn evidence(
    control: &control::Control,
    name: &str,
    args: &Value,
    value: &mut Value,
) -> Result<()> {
    if name.starts_with("codex_") && value["turnId"].is_string() {
        let pinned = json!({"threadId":args["threadId"],"turnId":value["turnId"]});
        match crate::review::turn_page(control, &pinned).await {
            Ok(page) => {
                let turn = &page["data"][0];
                value["files"] = crate::review::native_files(
                    turn["items"].as_array().map(Vec::as_slice).unwrap_or(&[]),
                );
                let terminal = matches!(
                    value["state"].as_str(),
                    Some("completed" | "failed" | "cancelled")
                );
                if terminal || value["finalResponse"]["itemId"].is_string() {
                    let item_id = value["finalResponse"]["itemId"].clone();
                    value["finalResponse"] = turn["items"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .rev()
                        .find(|i| {
                            i["type"] == "agentMessage"
                                && if terminal {
                                    i["phase"] != "commentary"
                                } else {
                                    i["id"] == item_id
                                }
                        })
                        .map(|i| i["text"].clone())
                        .unwrap_or(Value::Null);
                }
            }
            Err(error) => {
                if value["finalResponse"]["textTruncated"] == true {
                    return Err(error);
                }
                value["files"] = Value::Null;
            }
        }
    }
    if name.starts_with("codex_") && value["turnId"].is_string() {
        let thread = string(args, "threadId");
        let turn = string(value, "turnId");
        let git =
            crate::changes::query(control, &json!({"threadId":thread,"turnId":turn,"limit":1}))
                .await;
        if let Ok(git) = git {
            if git["fallback"] == false {
                value["files"] = json!(git["files"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|f| json!({"path":f["path"],"added":f["added"],"removed":f["removed"]}))
                    .collect::<Vec<_>>());
                value["changeEvidence"] = git["changeEvidence"].clone();
                value["attribution"] = git["attribution"].clone();
            } else if !value["files"].is_array() {
                value["changeEvidence"] = json!(format!("unavailable: {}", string(&git, "reason")));
                value["changeCorrection"] = git["next"].clone();
            }
        }
    }
    if value["state"].is_null() && value["status"].is_string() {
        value["state"] = value["status"].clone();
        value["recordedStatus"] = value["status"].clone();
    }
    if name.starts_with("agent_")
        && value["outputTruncated"] == true
        && value["finalResponse"].is_string()
    {
        let mut selected = false;
        let mut found = false;
        let mut text = String::new();
        crate::kernel::event_store::visit(string(value, "taskId"), |row| {
            if row["method"] == "arc/user" {
                selected = row["params"]["turnId"] == value["turnId"];
                found |= selected;
            }
            let update = &row["params"]["params"]["update"];
            if selected
                && row["method"] == "session/update"
                && update["sessionUpdate"] == "agent_message_chunk"
                && update["content"]["type"] == "text"
            {
                text.push_str(string(&update["content"], "text"));
            }
            Ok(())
        })?;
        if !found || !text.ends_with(string(value, "finalResponse")) {
            return Err("FINAL_RESPONSE_UNAVAILABLE: The selected turn's complete message could not be recovered from its event archive".into());
        }
        value["finalResponse"] = json!(text);
    }
    let text = value["finalResponse"]
        .as_str()
        .or_else(|| value["finalResponse"]["text"].as_str());
    if let Some(text) = text.filter(|text| text.chars().count() > 800) {
        value["finalResponseNext"] = crate::kernel::results::text_continuation(text)?;
    }
    Ok(())
}

pub(crate) fn project(name: &str, args: &Value, value: &Value) -> Value {
    let mut out = json!({});
    for key in [
        "agent",
        "taskId",
        "threadId",
        "turnId",
        "state",
        "stateScope",
        "recordedStatus",
        "runtimeStatus",
        "reason",
        "conditionMet",
        "snapshotHash",
        "changed",
        "elapsedMs",
        "observedAt",
        "waitLimit",
        "error",
        "next",
        "finalResponseUnchanged",
        "finalResponseNext",
        "attribution",
        "changeCorrection",
    ] {
        if let Some(v) = value.get(key) {
            out[key] = v.clone();
        }
    }
    for key in ["agent", "taskId", "threadId", "turnId"] {
        if out[key].is_null() && args[key].is_string() {
            out[key] = args[key].clone();
        }
    }
    if !out["threadId"].is_string() && !out["taskId"].is_string() {
        return out;
    }
    let text = value["finalResponse"]
        .as_str()
        .or_else(|| value["finalResponse"]["text"].as_str());
    out["finalResponse"] = text
        .map(|s| json!(s.chars().take(800).collect::<String>()))
        .unwrap_or(Value::Null);
    out["finalResponseTruncated"] = json!(text.is_some_and(|s| s.chars().count() > 800
        || value["finalResponse"]["truncated"] == true
        || value["finalResponse"]["textTruncated"] == true
        || value["outputTruncated"] == true));
    let files = value["files"].as_array();
    out["files"] = files
        .map(|f| json!(f.iter().take(50).collect::<Vec<_>>()))
        .unwrap_or(Value::Null);
    out["filesTruncated"] = json!(files.is_some_and(|f| f.len() > 50));
    out["diffstat"] = files
        .map(|files| {
            json!({"files":files.len(),
        "added":files.iter().filter_map(|f|f["added"].as_u64()).sum::<u64>(),
        "removed":files.iter().filter_map(|f|f["removed"].as_u64()).sum::<u64>(),
        "unknown":files.iter().filter(|f|f["added"].is_null() || f["removed"].is_null()).count()})
        })
        .unwrap_or(Value::Null);
    out["changeEvidence"] = value.get("changeEvidence").cloned().unwrap_or_else(|| {
        json!(if files.is_some() {
            "native-file-changes"
        } else {
            "unavailable: no attributed native file-change evidence"
        })
    });
    out["completeEvidence"] = if name.starts_with("codex_") {
        let mut pinned = json!({"threadId":out["threadId"],"view":"review"});
        if out["turnId"].is_string() {
            pinned["turnId"] = out["turnId"].clone();
        }
        json!({"via":"query","op":"codex_read","args":pinned})
    } else {
        json!({"via":"query","op":"agent_read","args":{"agent":out["agent"],"taskId":out["taskId"]}})
    };
    if matches!(
        out["next"]["op"].as_str(),
        Some("codex_wait" | "agent_wait" | "codex_read" | "agent_read")
    ) {
        out["next"]["args"]["view"] = json!("summary");
        if out["next"]["op"] == "codex_read" && out["turnId"].is_string() {
            out["next"]["args"]["turnId"] = out["turnId"].clone();
        }
    }
    if out["next"].is_null() {
        out["next"] = out["completeEvidence"].clone();
    }
    out
}
