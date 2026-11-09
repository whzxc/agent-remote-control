//! Discovery preferences never confer execution authority.
use crate::*;

pub(crate) fn validate(source: &Value, profile: &Value) -> Result<()> {
    if profile.is_null() {
        return Ok(());
    }
    let valid = profile.as_object().is_some_and(|p| {
        p.len() == 2 && p.contains_key("hostAccess") && p.contains_key("waitMode")
    });
    let valid = valid
        && if crate::sources::is_local(source) {
            profile["hostAccess"] == "host" && profile["waitMode"] == "background-cli"
        } else {
            matches!(profile["hostAccess"].as_str(), Some("none" | "unknown"))
                && matches!(profile["waitMode"].as_str(), Some("push" | "poll"))
        };
    if !valid {
        return Err("INVALID_ARGUMENT: capabilityProfile must be null (derived from the source), {hostAccess:host,waitMode:background-cli} for built-in Local CLI, or {hostAccess:none|unknown,waitMode:push|poll} for MCP sources. Use cli source update <id> --stdin.".into());
    }
    Ok(())
}

/// The profile a source receives when it has no explicit setting.
fn derived(source: &Value, local: bool) -> Value {
    if local {
        return json!({"hostAccess":"host","waitMode":"background-cli"});
    }
    let push = matches!(string(source, "product"), "claude" | "chatgpt" | "gemini");
    json!({"hostAccess":if source["product"]=="custom"{"unknown"}else{"none"},"waitMode":if push{"push"}else{"poll"}})
}

pub(crate) fn offer(source: &Value) -> Value {
    let local = crate::sources::is_local(source);
    let choices = if local {
        json!(["derived", "local-code"])
    } else {
        json!(["derived", "remote-push", "remote-polling"])
    };
    json!({"recommended":derived(source, local),"choices":choices})
}

pub(crate) fn effective(origin: &Value) -> Value {
    let cli = origin["controlTransport"] == "cli";
    let source = crate::sources::authority(string(origin, "sourceId")).unwrap_or(Value::Null);
    let local = cli && crate::sources::is_local(&source);
    let explicit = !source["capabilityProfile"].is_null();
    let setting = if explicit {
        source["capabilityProfile"].clone()
    } else {
        derived(&source, local)
    };
    let name = if local {
        "local-code"
    } else if setting["waitMode"] == "push" {
        "remote-push"
    } else {
        "remote-polling"
    };
    json!({"name":name,"transport":if cli{"cli"}else{"mcp"},
        "hostAccess":if local{"host"}else if setting["hostAccess"]=="none"{"none"}else{"unknown"},
        "waitMode":if local{json!("background-cli")}else{setting["waitMode"].clone()},
        "provenance":if explicit{"source-override"}else{"derived"}})
}

pub(crate) fn guide(origin: &Value, args: &Value, ops: &[Value]) -> Value {
    let profile = effective(origin);
    let name = string(&profile, "name");
    let topic = args["topic"].as_str().unwrap_or("loop");
    let full = args["view"] == "full";
    let maintainer = crate::preferences::maintainer_mode();
    let catalog = catalog();
    let guides = &catalog["guides"]["en"];
    let key = match topic {
        "loop" => name,
        "notify" => "profile-notify",
        "coordination" => "profile-coordination",
        "src" => "profile-src",
        "context" => "profile-context",
        "review" => "profile-review",
        "approvals" => "profile-approvals",
        _ => name,
    };
    let mut content = format!("MUST means a requirement. SHOULD means the default unless a concrete task-specific reason justifies an exception. MAY means an option.\n{}", guides[key].as_str().unwrap_or(""));
    if topic == "loop" {
        if name == "remote-push" {
            content.push_str(guides["profile-notify"].as_str().unwrap_or(""));
        }
        if crate::context_provider::configured() {
            content.push_str(guides["contextProvider"].as_str().unwrap_or(""));
        }
        if crate::mcp_hub::enabled() {
            content.push_str(guides["mcpHub"].as_str().unwrap_or(""));
        }
        // Local Code keeps its character budget; users there report through the CLI.
        if maintainer || name != "local-code" {
            content.push('\n');
            content.push_str(
                guides[if maintainer { "axMaintainer" } else { "axUser" }]
                    .as_str()
                    .unwrap_or(""),
            );
        }
    }
    let preset = if topic == "loop" {
        name.to_owned()
    } else {
        format!("profile-{topic}")
    };
    let index: Vec<_> = ops
        .iter()
        .filter(|op| {
            let op_name = string(op, "name");
            if full {
                return true;
            }
            if topic == "loop" && maintainer && op_name.starts_with("ax_") {
                return true;
            }
            catalog["toolExposure"]["tools"][op_name]["presets"]
                .as_array()
                .is_some_and(|p| p.iter().any(|p| p == &preset))
        })
        .map(|op| {
            let mut entry = json!({"op":op["name"],"via":crate::egress::via(op)});
            if topic != "loop" || full {
                entry["signature"] = json!(crate::egress::signature(op));
                entry["retry"] = json!({"mode":crate::egress::retry_contract(op)["mode"]});
            }
            entry
        })
        .collect();
    let mut result = json!({"topic":topic,"profile":profile,"sourceId":origin["sourceId"],"content":content,
        "ops":index,"indexScope":if full{"full"}else if topic=="loop"{"common"}else{"topic"},
        "fullIndex":{"tool":"query","arguments":{"op":"guide","args":{"view":"full"}}}});
    if topic == "loop" {
        result["maintainerMode"] = json!(maintainer);
    }
    if (name == "remote-push" && full || topic == "notify") && origin["controlSource"] == "chatgpt"
    {
        result["events"] = crate::claude_notify::subscriptions::guide();
    }
    result
}
