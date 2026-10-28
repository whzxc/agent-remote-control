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
        return Err("INVALID_ARGUMENT: capabilityProfile must be null (Legacy), {hostAccess:host,waitMode:background-cli} for built-in Local CLI, or {hostAccess:none|unknown,waitMode:push|poll} for MCP sources. Use cli source update <id> --stdin.".into());
    }
    Ok(())
}

pub(crate) fn offer(source: &Value) -> Value {
    if crate::sources::is_local(source) {
        json!({"recommended":{"hostAccess":"host","waitMode":"background-cli"},"choices":["legacy","local-code"]})
    } else {
        let push = matches!(string(source, "product"), "claude" | "chatgpt");
        json!({"recommended":{"hostAccess":if source["product"]=="custom"{"unknown"}else{"none"},"waitMode":if push{"push"}else{"poll"}},"choices":["legacy","remote-push","remote-polling"]})
    }
}

pub(crate) fn effective(origin: &Value) -> Value {
    let cli = origin["controlTransport"] == "cli";
    let source = crate::sources::get(string(origin, "sourceId")).unwrap_or(Value::Null);
    let local = cli && crate::sources::is_local(&source);
    let setting = &source["capabilityProfile"];
    let name = if setting.is_null() {
        "legacy"
    } else if local && setting["waitMode"] == "background-cli" {
        "local-code"
    } else if !local && setting["waitMode"] == "push" {
        "remote-push"
    } else if !local && setting["waitMode"] == "poll" {
        "remote-polling"
    } else {
        "legacy"
    };
    json!({"name":name,"transport":if cli{"cli"}else{"mcp"},
        "hostAccess":if local{"host"}else if setting["hostAccess"]=="none"{"none"}else{"unknown"},
        "waitMode":if name=="legacy"{Value::Null}else{setting["waitMode"].clone()},
        "provenance":if name=="legacy"{"legacy-default"}else{"source-override"}})
}

pub(crate) fn guide(origin: &Value, args: &Value, ops: &[Value]) -> Option<Value> {
    let profile = effective(origin);
    let name = string(&profile, "name");
    let topic = args["topic"].as_str().unwrap_or("loop");
    if (name == "legacy" && !matches!(topic, "coordination" | "src" | "context"))
        || args["op"].is_string()
    {
        return None;
    }
    let full = args["view"] == "full";
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
    if topic == "loop" && name == "remote-push" {
        content.push_str(guides["profile-notify"].as_str().unwrap_or(""));
    }
    if topic == "loop" && crate::preferences::maintainer_mode() {
        content.push_str("\nMaintainers SHOULD use guide({op:\"ax_list\"}) for AX triage.");
    }
    let preset = if topic == "loop" {
        name.to_owned()
    } else {
        format!("profile-{topic}")
    };
    let index: Vec<_> = ops
        .iter()
        .filter(|op| {
            full || catalog["toolExposure"]["tools"][string(op, "name")]["presets"]
                .as_array()
                .is_some_and(|p| p.iter().any(|p| p == &preset))
        })
        .map(|op| json!({"op":op["name"],"via":crate::egress::via(op)}))
        .collect();
    let mut result = json!({"topic":topic,"profile":profile,"sourceId":origin["sourceId"],"content":content,
        "ops":index,"indexScope":if full{"full"}else if topic=="loop"{"common"}else{"topic"},
        "fullIndex":{"tool":"query","arguments":{"op":"guide","args":{"view":"full"}}}});
    if (name == "remote-push" && full || topic == "notify") && origin["controlSource"] == "chatgpt"
    {
        result["events"] = crate::claude_notify::subscriptions::guide();
    }
    Some(result)
}
