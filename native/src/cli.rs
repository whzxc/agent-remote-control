use crate::{json, string, transport::forward_request, Value};
use std::io::Read;

const COMMANDS: &[&str] = &[
    "capabilities",
    "device offer",
    "device address <device> <host:port>",
    "device address <device> --clear",
    "device pair <string>",
    "device pending",
    "device approve",
    "device decline",
    "device revoke <deviceId>",
    "device configure --stdin",
    "control <op> [--stdin]",
    "install-shim",
    "schema <operation>",
    "call <operation> [--stdin]",
    "mcp",
    "local-mcp <id>",
    "watch",
    "logs --stdin",
    "logs --follow",
    "logs --offline",
    "stats control",
    "stats control --since <duration>",
    "app start",
    "app status",
    "app quit",
    "app restart",
    "storage compact",
    "ax import --from <path>",
    "ax export --to <path>",
    "subscriptions get",
    "subscriptions set --stdin",
    "subscriptions refresh [providerId]",
    "subscriptions open [providerId]",
    "help",
    "guide",
    "context --stdin",
    "status",
    "onboarding",
    "setup next",
    "setup next --locale <locale>",
    "setup next --goal <goal>",
    "setup next --goal <goal> --locale <locale>",
    "setup apply <stepId> --stdin",
    "setup apply <stepId> --stdin --locale <locale>",
    "setup wait",
    "setup wait --locale <locale>",
    "setup wait --timeout <sec>",
    "setup wait --timeout <sec> --locale <locale>",
    "setup playbook <id>",
    "setup reset",
    "skill install --target <target>",
    "uninstall [--purge]",
    "doctor",
    "logs",
    "config get",
    "config set --stdin",
    "configure --stdin",
    "network --stdin",
    "connect",
    "disconnect",
    "verify",
    "verify --fresh",
    "source list",
    "source update <id> --stdin",
    "source disconnect <id>",
    "source claim <pending-source-id> --stdin",
    "source switch <sourceId> <ingressId>",
    "source switch <sourceId> --cancel",
    "ingress list",
    "ingress presets",
    "ingress add --stdin",
    "ingress update <id> --stdin",
    "ingress remove <id>",
    "ingress start <id>",
    "ingress stop <id>",
    "ingress restart <id>",
    "ingress probe <id>",
    "ingress start-all",
    "ingress stop-all",
    "ingress token rotate <id>",
    "ingress oauth list <id>",
    "ingress oauth decision <id> --stdin",
    "ingress oauth request <id> <request-id>",
    "ingress oauth register <id> --stdin",
    "ingress oauth revoke <id> --stdin",
    "ingress doctor <id>",
    "ingress verify <id> [--fresh]",
];

pub(crate) fn command_line(args: &[&str], input: Option<&Value>) -> String {
    let quote = |text: &str| {
        if cfg!(windows) {
            format!("'{}'", text.replace('\'', "''"))
        } else {
            format!("'{}'", text.replace('\'', "'\"'\"'"))
        }
    };
    let binary = crate::runtime::binary().unwrap_or_else(|_| "arc".into());
    let executable = quote(&binary.to_string_lossy());
    let state = quote(&crate::root().to_string_lossy());
    let args = args
        .iter()
        .map(|arg| quote(arg))
        .collect::<Vec<_>>()
        .join(" ");
    let command = if cfg!(windows) {
        format!("& {{ $env:ARC_STATE_DIR = {state}; $input | & {executable} cli {args} }}")
    } else {
        format!("ARC_STATE_DIR={state} {executable} cli {args}")
    };
    match input {
        Some(input) if cfg!(windows) => format!("{} | {command}", quote(&input.to_string())),
        Some(input) => format!("printf '%s' {} | {command}", quote(&input.to_string())),
        None => command,
    }
}

const GUIDE: &str = include_str!("../../docs/reference/cli.md");

pub(crate) fn onboarding(ingress: &Value) -> Value {
    json!({"ingressId":ingress["id"],"controlSource":ingress["controlSource"],
        "stage":if ingress["config"]["configured"]!=true {"configure"}else if ingress["state"]!="ready" {"start"}else if ingress["verification"]["challengeVerifiedAt"].is_string(){"inbound_verified"}else{"client_setup_or_verify"},
        "transport":ingress["transport"],"authentication":ingress["auth"],"url":ingress["url"],"tunnelId":ingress["config"]["tunnelId"],
        "verification":ingress["verification"],"diagnostics":crate::diagnostics::ingress(ingress),
        "preset":crate::control_sources::preset(string(ingress,"controlSource")),
        "verificationPrompt":format!("Call act with {}. Verify the connection only. Do not create a task.",json!({"op":"connector_verify","args":{"code":ingress["verification"]["code"]}})),
        "executionPrompt":"Call guide first. Use codex_create for Codex. For an executable Agent, use agent_create with agent:\"antigravity\" or agent:\"pi\". Create one harmless task with purpose:\"self-test\" and notify:null. The task MUST NOT call tools or read or modify files. It MUST reply only ARC_ONBOARDING_OK. Omit requestId to have ARC generate it, then retain the returned receipt requestId. Read its taskId and turnId through act({op:receipt,args:{requestId}}). For an executable Agent, call query agent_wait with the same agent, taskId, and turnId, then query agent_read with that agent and taskId. Use codex_wait and codex_read for Codex. On timeout, retain the original IDs and previous snapshotHash as expectedHash. Continue until terminal or interaction. Timeout does not terminate the task. Do not create it again.",
        "identityNote":"Ingress controlSource is an initial product default. Authenticated calls resolve a credential-anchored sourceId; origin.controlSource is that source product. Bearer clients sharing one connection share one source.",
        "clientSetup":"Read preset.status, supportedAuth and caveat before connecting. Conditional paths require client verification; auth-limited paths must not silently fall back to none. A preset is not an installed integration.",
        "secretDelivery":"Supply credentials using stdin or a protected local file. Never paste tokens into chat or use command-line arguments."})
}
async fn ingresses() -> crate::Result<Value> {
    forward_request("ingress", "GET", json!({})).await
}
async fn doctor() -> crate::Result<Value> {
    let status = forward_request("status", "GET", json!({})).await?;
    let mut items = Vec::new();
    for ingress in status["ingresses"].as_array().into_iter().flatten() {
        items.push(json!({"id":ingress["id"],"configured":ingress["config"]["configured"],"state":ingress["state"],"error":ingress["error"],"verification":ingress["verification"],"diagnostics":crate::diagnostics::ingress(ingress),
        "preset":crate::control_sources::preset(string(ingress,"controlSource")),"onboarding":onboarding(ingress)}));
    }
    Ok(
        json!({"permissions":forward_request("permissions/passive", "GET", json!({})).await?,"ingresses":items,"summary":status["ingressSummary"],"desktop":status["core"]["desktop"],"appServer":status["core"]["appServer"],"resources":status["core"]["resources"],"executionVerified":false,"diagnostics":status["diagnostics"]}),
    )
}
// Keep help and argument validation on the same command grammar.
fn command_usage(args: &[&str]) -> Result<String, (String, String)> {
    if let Some(result) = crate::cli_acceptance::usage(args) {
        return result.map_err(|e| {
            (
                e,
                "cli help; cli schema wait; cli schema app.snapshot".into(),
            )
        });
    }
    if matches!(args, ["control", "guide", op] if !op.starts_with('-')) {
        return Ok("cli control guide [op]".into());
    }
    if args.first() == Some(&"setup") && args.contains(&"--locale") {
        let (normalized, _) = setup_locale(args)
            .map_err(|e| (e, "cli setup next|apply|wait [--locale zh-CN|en]".into()))?;
        return command_usage(&normalized).map(|usage| format!("{usage} [--locale zh-CN|en]"));
    }
    if args == ["setup"] {
        return command_usage(&["setup", "next"]);
    }
    if args.starts_with(&["setup", "--goal"]) {
        let mut normalized = vec!["setup", "next"];
        normalized.extend_from_slice(&args[1..]);
        return command_usage(&normalized);
    }
    if args.is_empty() || args == ["--help"] {
        return Ok("cli help".into());
    }
    let mut candidates = COMMANDS.to_vec();
    let mut depth = 0;
    loop {
        let mut branches: Vec<_> = candidates
            .iter()
            .filter_map(|command| command.split_whitespace().nth(depth))
            .filter(|word| !word.starts_with(['<', '[', '-']))
            .collect();
        if branches.is_empty() {
            break;
        }
        branches.sort_unstable();
        branches.dedup();
        let prefix = std::iter::once("cli")
            .chain(args[..depth].iter().copied())
            .collect::<Vec<_>>()
            .join(" ");
        let usage = format!(
            "{prefix} <subcommand>. Available subcommands: {}. See cli help for full usage.",
            branches.join("、")
        );
        let Some(word) = args.get(depth) else {
            return Err(("Missing subcommand".into(), usage));
        };
        if !branches.contains(word) {
            let message = if word.starts_with('-') {
                flag_error(word)
            } else {
                format!("Unknown subcommand {word:?}")
            };
            return Err((message, usage));
        }
        candidates.retain(|command| command.split_whitespace().nth(depth) == Some(word));
        depth += 1;
    }
    let usage = candidates
        .iter()
        .map(|s| format!("cli {s}"))
        .collect::<Vec<_>>()
        .join("；");
    let mut best_error = (0, "Arguments do not match".to_owned());
    let mut best_usage = usage.clone();
    for command in candidates {
        let slots: Vec<_> = command.split_whitespace().collect();
        let mut error = None;
        for index in depth..slots.len().max(args.len()) {
            let slot = slots.get(index).copied();
            let arg = args.get(index).copied();
            let optional = slot.is_some_and(|s| s.starts_with('['));
            let expected = slot.map(|s| s.trim_matches(['[', ']']));
            let message = match (expected, arg) {
                (Some(_), None) if optional => continue,
                (Some(expected), None) => format!("Missing argument {expected}"),
                (Some(expected), Some(arg)) if expected == arg => continue,
                (Some(expected), Some(arg))
                    if !arg.starts_with('-')
                        && (expected.starts_with('<')
                            || optional && !expected.starts_with('-')) =>
                {
                    continue
                }
                (_, Some(arg)) if arg.starts_with('-') => {
                    if slot.is_some_and(|s| s.starts_with('<')) && slots.contains(&arg) {
                        format!("Missing argument {} (required before {arg})", slot.unwrap())
                    } else if slots.contains(&arg) {
                        format!("Unexpected or duplicate option {arg}")
                    } else {
                        flag_error(arg)
                    }
                }
                (Some(expected), Some(_)) => format!(
                    "Argument {} after cli must be {expected}, not an extra positional argument",
                    index + 1
                ),
                (None, Some(_)) => format!(
                    "Unexpected positional argument (argument {} after cli)",
                    index + 1
                ),
                (None, None) => continue,
            };
            error = Some((index, message));
            break;
        }
        match error {
            None => return Ok(format!("cli {command}")),
            Some(error) if error.0 >= best_error.0 => {
                best_usage = if error.0 > depth {
                    format!("cli {command}")
                } else {
                    usage.clone()
                };
                best_error = error;
            }
            _ => {}
        }
    }
    if args.starts_with(&["ingress", "update"])
        && args.get(2).is_none_or(|arg| arg.starts_with('-'))
    {
        best_error.1.push_str(". id MUST be a command argument after update. Move id from stdin to the command arguments. stdin accepts only patch fields to change.");
    }
    Err((best_error.1, best_usage))
}

// Read stdin only when inserting <id> would make this a valid command.
fn stdin_id_hint(args: &[&str]) -> Option<(String, String)> {
    let slots = COMMANDS.iter().find_map(|command| {
        let slots: Vec<_> = command.split_whitespace().collect();
        (slots.contains(&"<id>")
            && slots.contains(&"--stdin")
            && slots
                .iter()
                .copied()
                .filter(|slot| *slot != "<id>")
                .eq(args.iter().copied()))
        .then_some(slots)
    })?;
    let body = stdin_json().ok()?;
    // Do not render objects or other fields: pasted input may contain credentials.
    let id = body.get("id")?.as_str()?;
    let argument = if !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_./:@+-".contains(&byte))
    {
        id.to_owned()
    } else {
        format!("'{}'", id.replace('\'', "'\"'\"'"))
    };
    let usage = std::iter::once("cli")
        .chain(slots.iter().map(|slot| {
            if *slot == "<id>" {
                argument.as_str()
            } else {
                slot
            }
        }))
        .collect::<Vec<_>>()
        .join(" ");
    Some((
        format!(
            "Found id={} in stdin. Move it to the command arguments. stdin accepts only patch fields to change.",
            json!(id)
        ),
        usage,
    ))
}

fn print_output(value: Value) -> i32 {
    match crate::output::line(value) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}

fn flag_error(arg: &str) -> String {
    let flag = arg.split('=').next().unwrap_or(arg);
    let normalized = flag
        .trim_start_matches('-')
        .replace(['-', '_'], "")
        .to_ascii_lowercase();
    if normalized == "bearertoken"
        || normalized == "clientsecret"
        || crate::ingress::config::secrets().any(|(key, _)| key.to_ascii_lowercase() == normalized)
    {
        format!("Command-line secret option {flag} is not accepted. Secrets could appear in shell history or process lists. Supply JSON through --stdin.")
    } else {
        format!("Unknown option {flag}. Use the listed options.")
    }
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn expect_type(field: &str, value: &Value, expected: &Value) -> crate::Result<()> {
    if json_type(value) != json_type(expected) {
        return Err(format!(
            "Invalid type for {field}: expected {}, got {}",
            json_type(expected),
            json_type(value)
        ));
    }
    Ok(())
}

fn known_fields(value: &Value, allowed: &[&str], prefix: &str) -> crate::Result<()> {
    let unknown: Vec<_> = value
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, _)| !allowed.contains(&key.as_str()))
        .map(|(key, _)| format!("{prefix}{key}"))
        .collect();
    if !unknown.is_empty() {
        return Err(format!(
            "Unknown fields: {}. Allowed fields: {}",
            unknown.join("、"),
            allowed
                .iter()
                .map(|key| format!("{prefix}{key}"))
                .collect::<Vec<_>>()
                .join("、")
        ));
    }
    Ok(())
}

pub(crate) fn validate_ingress_input(body: &Value, update: bool) -> crate::Result<()> {
    let mut fields = vec![
        "name",
        "controlSource",
        "transport",
        "auth",
        "bearerToken",
        "enabled",
        "toolPolicy",
        "config",
    ];
    if update && body.get("id").is_some() {
        return Err(
            "A patch cannot contain id. Put id in the command arguments after update. stdin accepts only patch fields to change."
                .into(),
        );
    }
    if !update {
        fields.push("id");
    }
    known_fields(body, &fields, "")?;
    for (field, value) in body.as_object().unwrap() {
        match field.as_str() {
            "enabled" => expect_type(field, value, &json!(false))?,
            "config" => {
                expect_type(field, value, &json!({}))?;
                let defaults = crate::ingress::config::defaults();
                let fields: Vec<_> = defaults
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(String::as_str)
                    .collect();
                known_fields(value, &fields, "config.")?;
                for (key, value) in value.as_object().unwrap() {
                    expect_type(&format!("config.{key}"), value, &defaults[key])?;
                }
            }
            "toolPolicy" if value == "all" => {}
            "toolPolicy" => {
                if !value.is_object() {
                    return Err(format!(
                        "toolPolicy must be the string \"all\" or an object, got {}",
                        json_type(value)
                    ));
                }
                known_fields(value, &["allowlist"], "toolPolicy.")?;
                expect_type("toolPolicy.allowlist", &value["allowlist"], &json!([]))?;
                for (index, item) in value["allowlist"].as_array().unwrap().iter().enumerate() {
                    expect_type(&format!("toolPolicy.allowlist[{index}]"), item, &json!(""))?;
                }
            }
            _ => expect_type(field, value, &json!(""))?,
        }
    }
    Ok(())
}

pub fn error_response(message: &str, usage: &str, args: &[&str]) -> Value {
    let code = crate::management::error_code(message);

    if matches!(
        code,
        "SOURCE_REVOKED" | "SOURCE_REMOVED" | "LOCAL_SOURCE_PROTECTED"
    ) {
        let recovery = if code == "LOCAL_SOURCE_PROTECTED" {
            "Local CLI and panel share built-in authority and cannot be disconnected. Select an external control source in ARC Remote link."
        } else {
            "Open ARC Remote link and inspect the source and ingress named in the error. Add and authorize a new control source if revoked; use Change connection if its connection was removed. For built-in Local CLI/panel, restart the upgraded ARC app and retry to repair local authority."
        };
        return json!({"schemaVersion":1,"ok":false,"error":{"code":code,"message":if message == code { format!("{code}: Source authorization is unavailable. {recovery}") } else { message.to_owned() }},"next":{"op":null,"hint":recovery}});
    }
    let mut message = message.to_owned();
    if message == "ingress not found" {
        let id = if args.first() != Some(&"ingress") {
            None
        } else if matches!(args.get(1), Some(&"oauth" | &"token")) {
            args.get(3)
        } else {
            args.get(2)
        };
        let id = id
            .map(|id| format!(" id={}", json!(id)))
            .unwrap_or_default();
        message = format!("Ingress{id} not found. Run cli ingress list for available ingresses.");
    } else if message == "UNKNOWN_OPERATION" {
        message = format!(
            "Unknown operation {}. Run cli capabilities for available operations.",
            json!(args.get(1))
        );
    }
    let argument_error = command_usage(args).is_err()
        || matches!(code, "INVALID_ARGUMENT" | "UNKNOWN_OPERATION")
        || [
            "Invalid stdin JSON",
            "Standard input must be",
            "Input exceeds",
            "Unknown fields:",
            "A patch cannot contain id",
            "Command arguments do not match",
        ]
        .iter()
        .any(|prefix| message.starts_with(prefix));
    if !argument_error {
        return json!({"schemaVersion":1,"ok":false,"error":{"code":code,"message":message},"next":{"via":"query","op":"guide","args":{},"hint":"Inspect the reported runtime failure, then retry the operation."}});
    }
    let separator = if message.ends_with('.') { " " } else { ". " };
    message.push_str(&format!("{separator}Correct usage: {usage}"));
    let mut error = json!({"code":code,"message":message,"usage":usage});
    if args.first() == Some(&"control") {
        let op = if args.get(1) == Some(&"guide") {
            args.get(2)
        } else {
            args.get(1)
        };
        error["cliHint"] = json!(crate::cli_acceptance::control_hint(
            op.copied().unwrap_or("")
        ));
    }
    if args.starts_with(&["ingress", "update"]) {
        error["message"] = json!(format!(
            "{}. Minimal valid stdin example: {{\"enabled\":false}}",
            error["message"].as_str().unwrap()
        ));
        error["example"] = json!({"enabled":false});
    }
    json!({"schemaVersion":1,"ok":false,"error":error,"next":{"via":"query","op":"guide","args":{},"hint":format!("Correct the command using {usage}, then retry.")}})
}
fn print_error(message: &str, usage: &str, args: &[&str]) -> i32 {
    print_output(error_response(message, usage, args));
    1
}

pub(crate) fn stdin_json() -> crate::Result<Value> {
    let mut input = String::new();
    std::io::stdin()
        .take(16385)
        .read_to_string(&mut input)
        .map_err(|_| "Cannot read standard input".to_string())?;
    if input.len() > 16384 {
        return Err("Input exceeds 16 KiB".into());
    }
    // Never echo malformed input: it may contain a credential.
    let value: Value = serde_json::from_str(&input).map_err(|error| {
        format!(
            "Invalid stdin JSON at line {}, column {}. Check JSON syntax.",
            error.line(),
            error.column()
        )
    })?;
    if !value.is_object() {
        return Err(format!(
            "Standard input must be a JSON object, got {}",
            json_type(&value)
        ));
    }
    Ok(value)
}

fn setup_locale<'a>(args: &[&'a str]) -> crate::Result<(Vec<&'a str>, Option<&'a str>)> {
    let mut args = args.to_vec();
    let mut locale = None;
    if args.first() == Some(&"setup") {
        if let Some(index) = args.iter().position(|arg| *arg == "--locale") {
            let value = args
                .get(index + 1)
                .copied()
                .ok_or("INVALID_ARGUMENT: --locale requires zh-CN or en")?;
            if !["zh-CN", "en"].contains(&value) {
                return Err("INVALID_ARGUMENT: --locale must be zh-CN or en".into());
            }
            args.drain(index..index + 2);
            if args.contains(&"--locale") || matches!(args.get(1), Some(&"reset" | &"playbook")) {
                return Err(
                    "INVALID_ARGUMENT: --locale is supported once on setup next/apply/wait".into(),
                );
            }
            locale = Some(value);
        }
    }
    Ok((args, locale))
}

async fn execute(args: &[String]) -> crate::Result<Value> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let (args, locale) = setup_locale(&args)?;
    let setup_body = |mut body: Value| {
        if let Some(locale) = locale {
            body["locale"] = json!(locale);
        }
        json!({"body":body})
    };
    match args.as_slice() {
        ["device", action @ ("offer" | "pending" | "approve" | "decline")] => crate::management::call(&format!("device.{action}"), json!({})).await,
        ["device", "pair", pairing] => crate::management::call("device.pair", json!({"body":{"pairingString":pairing}})).await,
        ["device", "revoke", device] => crate::management::call("device.revoke", json!({"body":{"deviceId":device}})).await,
        ["device","address",device,"--clear"] => crate::management::call("device.address",json!({"body":{"device":device,"address":null}})).await,
        ["device","address",device,address] => crate::management::call("device.address",json!({"body":{"device":device,"address":address}})).await,
        ["device", "configure", "--stdin"] => crate::management::call("device.configure", json!({"body":stdin_json()?})).await,
        ["stats", "control"] => crate::control_metrics::report("1d"),
        ["stats", "control", "--since", since] => crate::control_metrics::report(since),
        ["control", "guide", op] if *op != "--stdin" => crate::cli_acceptance::control("guide", json!({"op":op})).await,
        ["control", op] => crate::cli_acceptance::control(op, json!({})).await,
        ["control", op, "--stdin"] => crate::cli_acceptance::control(op, stdin_json()?).await,
        ["wait", ..] => crate::cli_acceptance::wait(&args).await,
        ["app", "snapshot", ..] => crate::cli_acceptance::snapshot(&args).await,
        ["install-shim"] => crate::cli_shim::install().await,
        ["schema", name] if crate::cli_acceptance::schemas().get(*name).is_some() => Ok(crate::cli_acceptance::schemas()[*name].clone()),
        ["setup"] | ["setup", "next"] => crate::management::call("setup.next",setup_body(json!({}))).await,
        ["setup", "--goal", goal] | ["setup", "next", "--goal", goal] => crate::management::call("setup.next",setup_body(json!({"goal":goal}))).await,
        ["setup", "apply", step, "--stdin"] => crate::management::call("setup.apply",setup_body(json!({"stepId":step,"input":stdin_json()?}))).await,
        ["setup", "wait"] => crate::management::call("setup.wait",setup_body(json!({}))).await,
        ["setup", "wait", "--timeout", seconds] => crate::management::call("setup.wait",setup_body(json!({"timeout":seconds.parse::<u64>().map_err(|_|"INVALID_ARGUMENT: timeout must be seconds")?}))).await,
        ["skill", "install", "--target", target] => crate::skills::install(target),
        ["setup", "playbook", id] => crate::setup::playbook(id),
        ["setup", "reset"] => forward_request("setup/reset","DELETE",json!({})).await,
        ["uninstall"] => crate::uninstall::run(false).await,
        ["uninstall", "--purge"] => crate::uninstall::run(true).await,
        ["capabilities"] => { let mut c = crate::management::catalog(); c["cliOnly"] = crate::cli_acceptance::schemas(); Ok(c) },
        ["schema", name] => crate::management::catalog()["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["name"] == *name)
            .cloned()
            .ok_or("UNKNOWN_OPERATION".into()),
        ["call", name] => crate::management::call(name, json!({})).await,
        ["call", name, "--stdin"] => crate::management::call(name, stdin_json()?).await,

        ["source", "list"] => forward_request("source", "GET", json!({})).await,
        ["source", "update", id, "--stdin"] => forward_request(&format!("source/{id}"), "PUT", stdin_json()?).await,
        ["source", "disconnect", id] => forward_request(&format!("source/{id}/disconnect"), "POST", json!({})).await,
        ["source", "switch", id, "--cancel"] => forward_request(&format!("source/{id}/switch"), "DELETE", json!({})).await,
        ["source", "switch", id, ingress] => forward_request(&format!("source/{id}/switch"), "POST", json!({"ingressId":ingress})).await,
        ["source", "claim", id, "--stdin"] => forward_request(&format!("source/{id}/claim"), "POST", stdin_json()?).await,
        ["ax", "import", "--from", path] => forward_request("ax/import", "POST", json!({"from":path})).await,
        ["ax", "export", "--to", path] => forward_request("ax/export", "POST", json!({"to":path})).await,
        ["storage", "compact"] => {
            // Refuse mixed old/new writers before changing the archive layout.
            let owner = crate::runtime::Client::connect(crate::runtime::binary()?, "cli").await?;
            let result = tokio::task::spawn_blocking(crate::kernel::event_store::compact_all)
                .await
                .map_err(|e| e.to_string())
                .and_then(|value| value);
            owner.close().await;
            result
        }
        [] | ["help"] | ["--help"] => Ok(json!({"version":env!("ARC_BUILD_VERSION"),
            "usage":"arc cli [--state-dir <absolute-directory>] <command>",
            "targeting":"--state-dir selects only that instance and never falls back to the installed app. Start a side-by-side development instance with npm run dev:isolated.",
            "groups":[
                {"commands":"control <op> [--stdin]; control guide [op]; wait --op <op> [--control] [--stdin] --until <condition> [--until <condition>] [--timeout <seconds>]","description":"Local-only control dispatch and bounded condition waiting. Read cli schema control and cli schema wait."},
                {"commands":"app snapshot [--out <directory>] [--stdin]; install-shim","description":"Export the live UI and a macOS WebView PNG; install the macOS CLI symlink."},
                {"commands":"setup next|apply|wait|playbook|reset; skill install --target codex|claude-code|antigravity","description":"Configure a Codex, Claude or Antigravity control source; follow step and nextAction. Configure executable Agents in Agent management, then use agent_* ops."},
                {"commands":"status; doctor; onboarding; context --stdin","description":"Read current state, diagnostics and onboarding evidence."},
                {"commands":"source list; source update <id> --stdin; source disconnect <id>; source claim <pending-source-id> --stdin; source switch <sourceId> <ingressId>; source switch <sourceId> --cancel","description":"Manage source identity; claim accepts sourceId=new or an existing source ID; a switch request can only claim its bound source."},
                {"commands":"ingress list|presets|add|update|remove|start|stop|restart|probe|doctor|verify","description":"Manage and diagnose a selected connection; add/update accept JSON on stdin."},
                {"commands":"ingress oauth list|request|decision|register|revoke; ingress token rotate","description":"Manage this connection's OAuth access and bearer token."},
                {"commands":"app start|status|quit|restart; uninstall [--purge]","description":"Control the installed application. Install local builds from an independent terminal with npm run desktop:install in the source checkout."},
                {"commands":"ax import --from <path>; ax export --to <path>","description":"Import the interim AX queue or export retained AX history through local Core management. Paths must be absolute; export requires a new file in an existing directory outside ARC state."},
                {"commands":"subscriptions get|set|refresh|open","description":"Read or refresh subscription usage; set accepts JSON on stdin."},
                {"commands":"stats control [--since <duration>]; logs [--stdin|--follow|--offline]; watch; storage compact","description":"Inspect logs, watch changes or compact local storage."},
                {"commands":"config get; config set --stdin","description":"Read or set device configuration. set accepts {maintainerMode:boolean}; default false, effective without restart."},
                {"commands":"configure --stdin; network --stdin; connect; disconnect; verify [--fresh]","description":"Configure and control the primary connection."},
                {"commands":"capabilities; schema <operation>; call <operation> [--stdin]; mcp","description":"Discover full operation schemas, execute an operation or serve local management MCP."},
                {"commands":"help; guide","description":"Show this compact index or the full CLI reference."}
            ],
            "note":"JSON output. Read cli schema <operation> for exact inputs and cli guide for command syntax. Credentials use stdin or ARC clipboard apply, never command arguments."})),
        ["subscriptions", "get"] => forward_request("subscriptions", "GET", json!({})).await,
        ["subscriptions", "set", "--stdin"] => {
            forward_request("subscriptions/settings", "PUT", stdin_json()?).await
        }
        ["subscriptions", action @ ("refresh" | "open")] => {
            forward_request(&format!("subscriptions/{action}"), "POST", json!({})).await
        }
        ["subscriptions", action @ ("refresh" | "open"), id] if !id.starts_with('-') => {
            forward_request(
                &format!("subscriptions/{action}"),
                "POST",
                json!({"providerId":id}),
            )
            .await
        }
        ["ingress", "oauth", "list", id] => {
            forward_request(&format!("ingress/{id}/oauth"), "GET", json!({})).await
        }
        ["ingress", "oauth", "request", id, request_id] => {
            forward_request(
                &format!("ingress/{id}/oauth/request/{request_id}"),
                "GET",
                json!({}),
            )
            .await
        }
        ["ingress", "oauth", "decision", id, "--stdin"] => {
            forward_request(
                &format!("ingress/{id}/oauth/decision"),
                "POST",
                stdin_json()?,
            )
            .await
        }
        ["ingress", "oauth", "register", id, "--stdin"] => {
            forward_request(
                &format!("ingress/{id}/oauth/register"),
                "POST",
                stdin_json()?,
            )
            .await
        }
        ["ingress", "oauth", "revoke", id, "--stdin"] => {
            forward_request(&format!("ingress/{id}/oauth/revoke"), "POST", stdin_json()?).await
        }
        ["guide"] => Ok(json!({"markdown":GUIDE})),
        ["doctor"] => doctor().await,
        ["context", "--stdin"] => forward_request("context", "POST", stdin_json()?).await,
        ["onboarding"] => Ok(
            json!({"ingresses":ingresses().await?.as_array().into_iter().flatten().map(onboarding).collect::<Vec<_>>()}),
        ),
        ["ingress", "presets"] => Ok(
            json!({"curated":crate::control_sources::presets(),"custom":crate::control_sources::preset("custom")}),
        ),
        ["ingress", "list"] => {
            let mut items = ingresses().await?;
            for item in items.as_array_mut().into_iter().flatten() {
                item["preset"] = crate::control_sources::preset(string(item, "controlSource"));
            }
            Ok(items)
        }
        ["ingress", "add", "--stdin"] => {
            let body = stdin_json()?;
            validate_ingress_input(&body, false)?;
            forward_request("ingress", "POST", body).await
        }
        ["ingress", "update", id, "--stdin"] => {
            let body = stdin_json()?;
            validate_ingress_input(&body, true)?;
            forward_request(&format!("ingress/{id}"), "PUT", body).await
        }
        ["ingress", "remove", id] => {
            forward_request(&format!("ingress/{id}"), "DELETE", json!({})).await
        }
        ["ingress", action @ ("start" | "stop" | "restart" | "probe"), id] => {
            forward_request(&format!("ingress/{id}/{action}"), "POST", json!({})).await
        }
        ["ingress", action @ ("start-all" | "stop-all")] => {
            forward_request(&format!("ingress/{action}"), "POST", json!({})).await
        }
        ["ingress", "token", "rotate", id] => {
            forward_request(&format!("ingress/{id}/token"), "POST", json!({})).await
        }
        ["ingress", "doctor", id] => {
            let status = forward_request("status", "GET", json!({})).await?;
            let i = status["ingresses"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|i| i["id"] == *id)
                .ok_or("ingress not found")?;
            let findings: Vec<_> = status["diagnostics"]["findings"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|f| f["scope"]["id"] == *id || f["scope"]["ingressId"] == *id)
                .cloned()
                .collect();
            Ok(json!({"ingress":i,"onboarding":onboarding(i),"findings":findings}))
        }
        ["ingress", "verify", id] => {
            let i = forward_request(&format!("ingress/{id}"), "GET", json!({})).await?;
            Ok(json!({"ingress":i,"onboarding":onboarding(&i)}))
        }
        ["ingress", "verify", id, "--fresh"] => {
            forward_request(
                &format!("ingress/{id}/verification/reset"),
                "POST",
                json!({}),
            )
            .await?;
            Ok(onboarding(
                &forward_request(&format!("ingress/{id}"), "GET", json!({})).await?,
            ))
        }
        ["status"] => forward_request("status", "GET", json!({})).await,
        ["logs"] => crate::management::call("logs.query", json!({})).await,
        ["logs", "--offline"] => crate::logs::query(&json!({})),
        ["logs", "--stdin"] => {
            crate::management::call("logs.query", json!({"body":stdin_json()?})).await
        }
        ["app", action @ ("start" | "quit" | "restart" | "status")] => {
            crate::management::call(&format!("app.{action}"), json!({})).await
        }
        ["config", "get"] => {
            let preferences = forward_request("preferences", "GET", json!({})).await?;
            Ok(json!({"maintainerMode":preferences["maintainer-mode"] == "on"}))
        }
        ["config", "set", "--stdin"] => {
            let body = stdin_json()?;
            known_fields(&body, &["maintainerMode"], "")?;
            let enabled = body["maintainerMode"].as_bool().ok_or("INVALID_ARGUMENT: maintainerMode must be a boolean")?;
            let preferences = forward_request("preferences", "PUT", json!({"values":{"maintainer-mode":if enabled {"on"} else {"off"}}})).await?;
            Ok(json!({"maintainerMode":preferences["maintainer-mode"] == "on"}))
        }
        ["configure", "--stdin"] => forward_request("config/tunnel", "PATCH", stdin_json()?).await,
        ["network", "--stdin"] => forward_request("network", "PUT", stdin_json()?).await,
        ["connect"] => forward_request("start", "POST", json!({})).await,
        ["disconnect"] => forward_request("stop", "POST", json!({})).await,
        ["verify"] => Ok(
            json!({"ingresses":ingresses().await?.as_array().into_iter().flatten().map(onboarding).collect::<Vec<_>>()}),
        ),
        ["verify", "--fresh"] => {
            for i in ingresses().await?.as_array().into_iter().flatten() {
                forward_request(
                    &format!("ingress/{}/verification/reset", string(i, "id")),
                    "POST",
                    json!({}),
                )
                .await?;
            }
            Ok(ingresses().await?)
        }
        _ => Err("Command arguments do not match. Check usage.".into()),
    }
}

pub async fn run(args: Vec<String>) -> i32 {
    crate::init_crypto();
    let mut args: Vec<String> = args.into_iter().filter(|arg| arg != "--json").collect();
    if args.first().is_some_and(|arg| arg == "--state-dir") {
        let target = args
            .get(1)
            .filter(|arg| std::path::Path::new(arg).is_absolute())
            .ok_or("--state-dir requires an existing absolute directory")
            .and_then(|arg| {
                std::fs::canonicalize(arg)
                    .map_err(|_| "--state-dir requires an existing absolute directory")
            })
            .and_then(|path| {
                if path.is_dir() {
                    Ok(path)
                } else {
                    Err("--state-dir requires an existing absolute directory")
                }
            });
        match target {
            Ok(path) => {
                std::env::set_var("ARC_STATE_DIR", path);
                args.drain(..2);
            }
            Err(error) => {
                return print_error(error, "cli --state-dir <absolute-directory> <command>", &[])
            }
        }
    }
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    if words.last() == Some(&"--help") && words.len() > 1 {
        let prefix = &words[..words.len() - 1];
        let extras = [
            "wait --op <operation> [--control] [--stdin] --until <condition> [--timeout <seconds>]",
            "app snapshot [--out <directory>] [--stdin]",
            "control guide [op] [--stdin]",
        ];
        let commands: Vec<_> = COMMANDS
            .iter()
            .chain(extras.iter())
            .filter(|command| {
                let slots: Vec<_> = command.split_whitespace().collect();
                prefix.iter().enumerate().all(|(index, arg)| {
                    slots
                        .get(index)
                        .is_some_and(|slot| *slot == *arg || slot.starts_with(['<', '[']))
                })
            })
            .map(|command| format!("cli {command}"))
            .collect();
        if commands.is_empty() {
            return print_error("Unknown command", "cli help", &words);
        }
        return print_output(
            json!({"schemaVersion":1,"ok":true,"result":{"commands":commands,"schema":"Use cli control guide <op> for control op arguments, or cli schema <operation> for management arguments. JSON arguments are read with --stdin."}}),
        );
    }
    let usage = match command_usage(&words) {
        Ok(usage) => usage,
        Err((message, usage)) => {
            let (message, usage) = stdin_id_hint(&words).unwrap_or((message, usage));
            return print_error(&message, &usage, &words);
        }
    };
    if let ["local-mcp", id] = words.as_slice() {
        return match crate::local_access::stdio(id).await {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{e}");
                1
            }
        };
    }
    if args.first().is_some_and(|a| a == "mcp") {
        return match crate::management::stdio().await {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{e}");
                1
            }
        };
    }
    if args.first().is_some_and(|a| {
        a == "watch" || (a == "logs" && args.get(1).is_some_and(|s| s == "--follow"))
    }) {
        let logs = args[0] == "logs";
        let mut cursor = String::new();
        loop {
            let result = crate::management::call(
                if logs { "logs.query" } else { "state.wait" },
                json!({"body":{"cursor":cursor}}),
            )
            .await;
            match result {
                Ok(value) => {
                    cursor = string(&value, "cursor").to_owned();
                    if !logs || value["rows"].as_array().is_some_and(|a| !a.is_empty()) {
                        if print_output(json!({"ok":true,"result":value})) != 0 {
                            return 1;
                        }
                    }
                }
                Err(e) => {
                    eprintln!("{e}");
                    return 1;
                }
            }
            if logs {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    }
    match execute(&args).await {
        Ok(mut result) => {
            if crate::egress::outcome_error(&result).is_some() {
                crate::egress::compact_failure(&mut result);
                if result["next"].is_null() && result["lastResult"]["next"].is_object() {
                    result["next"] = result["lastResult"]["next"].clone();
                }
                crate::egress::next(
                    &mut result,
                    words.get(1).copied().unwrap_or(""),
                    &json!({}),
                    false,
                );
                let error = result.as_object_mut().unwrap().remove("error").unwrap();
                let next = result.as_object_mut().unwrap().remove("next");
                print_output(
                    json!({"schemaVersion":1,"ok":false,"error":error,"next":next,"result":result}),
                );
                return 1;
            }
            print_output(json!({"schemaVersion":1,"ok":true,"result":result}))
        }
        Err(message) => {
            if matches!(words.first(), Some(&"control" | &"wait")) {
                if let Ok(error) = serde_json::from_str::<Value>(&message) {
                    let mut failure = json!({"error":error});
                    crate::egress::next(
                        &mut failure,
                        words.get(1).copied().unwrap_or(""),
                        &json!({}),
                        false,
                    );
                    crate::egress::compact_failure(&mut failure);
                    print_output(
                        json!({"schemaVersion":1,"ok":false,"error":failure["error"],"next":failure["next"]}),
                    );
                    return 1;
                }
            }
            print_error(&message, &usage, &words)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_failures_do_not_prescribe_argument_corrections() {
        // Regression: relay.leave challenge HTTP 404 appended usage to a valid cli call invocation.
        let args = ["call", "relay.leave", "--stdin"];
        let usage = command_usage(&args).unwrap();
        let message = "Relay challenge HTTP 404 Not Found";
        let failure = error_response(message, &usage, &args);
        assert_eq!(failure["ok"], false);
        assert_eq!(failure["error"]["code"], "COMMAND_FAILED");
        assert_eq!(failure["error"]["message"], message);
        assert!(failure["error"]["usage"].is_null());
        let invalid = error_response(
            "INVALID_ARGUMENT: read schema for relay.leave",
            &usage,
            &args,
        );
        assert_eq!(invalid["error"]["usage"], usage);
    }

    #[test]
    fn revoked_source_error_preserves_authorization_recovery() {
        // Contract: CLI authorization failures retain their error code and human recovery without syntax guidance.
        for removed in [false, true] {
            let source = json!({"id":"example-source","ingressId":"example-ingress","credential":{"type":"ingress"},"state":"revoked","connectionRemoved":removed});
            let message = crate::sources::authorization_error(&source);
            let failure = error_response(&message, "cli app status", &["app", "status"]);
            assert_eq!(failure["schemaVersion"], 1);
            assert_eq!(failure["ok"], false);
            assert_eq!(failure["error"]["code"], "SOURCE_REVOKED");
            assert!(failure["error"]["usage"].is_null());
            assert!(failure["error"]["message"]
                .as_str()
                .unwrap()
                .contains("example-source"));
            assert!(failure["error"]["message"]
                .as_str()
                .unwrap()
                .contains("example-ingress"));
            assert!(!failure.to_string().contains("Correct usage"));
            assert!(failure["next"]["op"].is_null());
            assert!(!string(&failure["next"], "hint").is_empty());
        }
        let legacy = error_response("SOURCE_REVOKED", "cli app status", &["app", "status"]);
        assert_eq!(legacy["error"]["code"], "SOURCE_REVOKED");
        assert!(!string(&legacy["next"], "hint").is_empty());
    }
}
