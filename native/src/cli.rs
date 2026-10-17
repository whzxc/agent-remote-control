use crate::{json, string, transport::forward_request, Value};
use std::io::Read;

const COMMANDS: &[&str] = &[
    "capabilities",
    "schema <operation>",
    "call <operation> [--stdin]",
    "mcp",
    "watch",
    "logs --stdin",
    "logs --follow",
    "logs --offline",
    "app start",
    "app status",
    "app quit",
    "app restart",
    "storage compact",
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
    "configure --stdin",
    "network --stdin",
    "connect",
    "disconnect",
    "verify",
    "verify --fresh",
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
        "verificationPrompt":format!("调用 act，参数为 {}。只验证连接，不创建任务。",json!({"op":"connector_verify","args":{"code":ingress["verification"]["code"]}})),
        "executionPrompt":"先调用 guide，按其中示例通过 act 的 codex_create 或 agent_create op 创建一个无害 Agent 任务：不调用工具，不读取或修改文件，只回复 ARC_ONBOARDING_OK。在 act 外层使用唯一 UUID requestId，通过 act({op:receipt,args:{requestId}}) 读取回执、taskId、turnId，再用 query({op:agent_wait 或 codex_wait,args:{任务标识}}) 默认 30 秒等待；timeout 后沿用原 ID 和上一轮 snapshotHash 作为 expectedHash 继续 wait 至终态或交互，通过 query 的 agent_read 或 codex_read op 读取最终输出。timeout 不终止任务，不重新创建。未知状态回读原 requestId，不重复创建。",
        "identityNote":"controlSource is a configured label, not an authenticated user identity. Bearer proves possession only.",
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
        json!({"permissions":forward_request("permissions", "GET", json!({})).await?,"ingresses":items,"summary":status["ingressSummary"],"desktop":status["core"]["desktop"],"appServer":status["core"]["appServer"],"executionVerified":false,"diagnostics":status["diagnostics"]}),
    )
}
// Keep help and argument validation on the same command grammar.
fn command_usage(args: &[&str]) -> Result<String, (String, String)> {
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
            "{prefix} <子命令>；可用子命令：{}；完整用法见 cli help",
            branches.join("、")
        );
        let Some(word) = args.get(depth) else {
            return Err(("缺少子命令".into(), usage));
        };
        if !branches.contains(word) {
            let message = if word.starts_with('-') {
                flag_error(word)
            } else {
                format!("未知子命令 {word:?}")
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
    let mut best_error = (0, "参数不匹配".to_owned());
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
                (Some(expected), None) => format!("缺少参数 {expected}"),
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
                        format!("缺少参数 {}（应放在 {arg} 之前）", slot.unwrap())
                    } else if slots.contains(&arg) {
                        format!("多余或重复的选项 {arg}")
                    } else {
                        flag_error(arg)
                    }
                }
                (Some(expected), Some(_)) => format!(
                    "cli 后第 {} 个参数应为 {expected}，实际为多余的位置参数",
                    index + 1
                ),
                (None, Some(_)) => format!("多余的位置参数（cli 后第 {} 个参数）", index + 1),
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
        best_error.1.push_str("；id 必须放在 update 后的命令参数里；若 stdin 含 id，请移到参数里，stdin 只传需要修改的补丁字段");
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
            "检测到 stdin 中的 id={}，请把它移到命令参数，stdin 只传需要修改的补丁字段",
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
        format!("不接受命令行密钥选项 {flag}：密钥可能泄露到 shell 历史或进程列表；请使用 --stdin 传入 JSON")
    } else {
        format!("未知选项 {flag}；请使用用法中列出的选项")
    }
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "布尔值（boolean）",
        Value::Number(_) => "数字（number）",
        Value::String(_) => "字符串（string）",
        Value::Array(_) => "数组（array）",
        Value::Object(_) => "对象（object）",
    }
}

fn expect_type(field: &str, value: &Value, expected: &Value) -> crate::Result<()> {
    if json_type(value) != json_type(expected) {
        return Err(format!(
            "字段 {field} 类型错误：期望 {}，实际为 {}",
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
            "未知字段：{}；允许字段：{}",
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
            "补丁中不能包含 id：请将 id 放在 update 后的命令参数里，stdin 只传需要修改的补丁字段"
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
                        "字段 toolPolicy 期望字符串 \"all\" 或对象（object），实际为 {}",
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

fn print_error(message: &str, usage: &str, args: &[&str]) -> i32 {
    let code = crate::management::error_code(message);
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
        message = format!("未找到入口{id}；请运行 cli ingress list 查看可用入口");
    } else if message == "UNKNOWN_OPERATION" {
        message = format!(
            "未知操作 {}；请运行 cli capabilities 查看可用操作",
            json!(args.get(1))
        );
    }
    message.push_str(&format!("；正确用法：{usage}"));
    let mut error = json!({"code":code,"message":message,"usage":usage});
    if args.starts_with(&["ingress", "update"]) {
        error["message"] = json!(format!(
            "{}；stdin 最小合法示例：{{\"enabled\":false}}",
            error["message"].as_str().unwrap()
        ));
        error["example"] = json!({"enabled":false});
    }
    print_output(json!({"schemaVersion":1,"ok":false,"error":error}));
    1
}

fn stdin_json() -> crate::Result<Value> {
    let mut input = String::new();
    std::io::stdin()
        .take(16385)
        .read_to_string(&mut input)
        .map_err(|_| "无法读取标准输入".to_string())?;
    if input.len() > 16384 {
        return Err("输入超过 16 KiB".into());
    }
    // Never echo malformed input: it may contain a credential.
    let value: Value = serde_json::from_str(&input).map_err(|error| {
        format!(
            "标准输入 JSON 语法错误：第 {} 行，第 {} 列；请检查 JSON 语法",
            error.line(),
            error.column()
        )
    })?;
    if !value.is_object() {
        return Err(format!(
            "标准输入必须是 JSON 对象，实际为 {}",
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
        ["capabilities"] => Ok(crate::management::catalog()),
        ["schema", name] => crate::management::catalog()["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["name"] == *name)
            .cloned()
            .ok_or("UNKNOWN_OPERATION".into()),
        ["call", name] => crate::management::call(name, json!({})).await,
        ["call", name, "--stdin"] => crate::management::call(name, stdin_json()?).await,

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
            "usage":"arc cli <command>",
            "groups":[
                {"commands":"setup next|apply|wait|playbook|reset; skill install --target codex|claude-code","description":"Configure ARC with an Agent; follow the returned step and nextAction."},
                {"commands":"status; doctor; onboarding; context --stdin","description":"Read current state, diagnostics and onboarding evidence."},
                {"commands":"ingress list|presets|add|update|remove|start|stop|restart|probe|doctor|verify","description":"Manage and diagnose a selected connection; add/update accept JSON on stdin."},
                {"commands":"ingress oauth list|request|decision|register|revoke; ingress token rotate","description":"Manage this connection's OAuth access and bearer token."},
                {"commands":"app start|status|quit|restart; uninstall [--purge]","description":"Control the installed application; uninstall to Trash, or permanently with --purge."},
                {"commands":"subscriptions get|set|refresh|open","description":"Read or refresh subscription usage; set accepts JSON on stdin."},
                {"commands":"logs [--stdin|--follow|--offline]; watch; storage compact","description":"Inspect logs, watch changes or compact local storage."},
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
        _ => Err("命令参数不匹配，请检查用法".into()),
    }
}

pub async fn run(args: Vec<String>) -> i32 {
    crate::init_crypto();
    let args: Vec<String> = args.into_iter().filter(|arg| arg != "--json").collect();
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    let usage = match command_usage(&words) {
        Ok(usage) => usage,
        Err((message, usage)) => {
            let (message, usage) = stdin_id_hint(&words).unwrap_or((message, usage));
            return print_error(&message, &usage, &words);
        }
    };
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
        Ok(result) => print_output(json!({"schemaVersion":1,"ok":true,"result":result})),
        Err(message) => print_error(&message, &usage, &words),
    }
}
