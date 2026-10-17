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
    "setup next --goal <goal>",
    "setup apply <stepId> --stdin",
    "setup wait",
    "setup wait --timeout <sec>",
    "setup playbook <id>",
    "setup reset",
    "skill install --target <target>",
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

const GUIDE: &str = include_str!("../../docs/reference/cli.md");

pub(crate) fn onboarding(ingress: &Value) -> Value {
    json!({"ingressId":ingress["id"],"controlSource":ingress["controlSource"],
        "stage":if ingress["config"]["configured"]!=true {"configure"}else if ingress["state"]!="ready" {"start"}else if ingress["verification"]["challengeVerifiedAt"].is_string(){"inbound_verified"}else{"client_setup_or_verify"},
        "transport":ingress["transport"],"authentication":ingress["auth"],"url":ingress["url"],"tunnelId":ingress["config"]["tunnelId"],
        "verification":ingress["verification"],"diagnostics":crate::diagnostics::ingress(ingress),
        "preset":crate::control_sources::preset(string(ingress,"controlSource")),
        "verificationPrompt":format!("调用 connector_verify，code 为 {}。只验证连接，不创建任务。",string(&ingress["verification"],"code")),
        "executionPrompt":"创建一个无害 Agent 任务：不调用工具，不读取或修改文件，只回复 ARC_ONBOARDING_OK。使用唯一 UUID requestId，读取回执、taskId、turnId，再用默认 30 秒的 agent_wait/codex_wait；timeout 后沿用原 ID 和上一轮 snapshotHash 作为 expectedHash 继续 wait 至终态或交互，读取最终输出。timeout 不终止任务，不重新创建。未知状态回读原 requestId，不重复创建。",
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

async fn execute(args: &[String]) -> crate::Result<Value> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["setup"] | ["setup", "next"] => crate::management::call("setup.next",json!({})).await,
        ["setup", "--goal", goal] | ["setup", "next", "--goal", goal] => crate::management::call("setup.next",json!({"body":{"goal":goal}})).await,
        ["setup", "apply", step, "--stdin"] => crate::management::call("setup.apply",json!({"body":{"stepId":step,"input":stdin_json()?}})).await,
        ["setup", "wait"] => crate::management::call("setup.wait",json!({})).await,
        ["setup", "wait", "--timeout", seconds] => crate::management::call("setup.wait",json!({"body":{"timeout":seconds.parse::<u64>().map_err(|_|"INVALID_ARGUMENT: timeout must be seconds")?}})).await,
        ["skill", "install", "--target", target] => crate::skills::install(target),
        ["setup", "playbook", id] => crate::setup::playbook(id),
        ["setup", "reset"] => forward_request("setup/reset","DELETE",json!({})).await,
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
            "usage":"<应用可执行文件> cli <command> [--json]",
            "capabilities":crate::management::catalog(),
            "commands":COMMANDS,
            "subscriptionsInput":{"enabled":"boolean; required","refreshMinutes":"1/3/5/10; defaults to 3"},
            "subscriptionsNote":"get reads memory only. set replaces enabled and refreshMinutes: read get.settings first. Providers participate automatically with their Agent; home rings use weekly quota. refresh requests an online read for an eligible provider, or all eligible providers when omitted; accepted is not fresh-data success. Read observedAt/state/error afterwards. open activates the target instance's Agent detail panel, or the Agents panel when omitted.",
            "controlSourcePresets":crate::control_sources::presets(),
            "ingressInput":{"id":"optional on add; immutable","name":"optional display name; defaults to preset name with an available numeric suffix","controlSource":"see ingress presets; any other client label remains valid","transport":"openai-tunnel | https","auth":"openai for OpenAI Tunnel; none | bearer | oauth for HTTPS","bearerToken":"32+ printable ASCII characters, stdin only; never returned by list/status","enabled":true,"toolPolicy":"all or {allowlist:[connector_verify,agents,agent_create,agent_read,agent_wait,...]}","config":{"httpsProvider":"cloudflare | ngrok | pinggy | localxpose | custom","cloudflareMode":"quick | named","cloudflareAuth":"token (default) | login (setup-managed local credentials)","cloudflareTunnelId":"locally-managed Tunnel UUID; setup-managed","httpsUrl":"https://hostname/mcp; required for named/custom, optional fixed ngrok address","httpsHost":"127.0.0.1 default; custom only","httpsPort":"8787 default; choose distinct ports for named/custom and match the external route","cloudflareToken":"named Tunnel token; stdin only","ngrokAuthtoken":"ngrok credential; stdin only","pinggyMode":"quick | named","pinggyToken":"Pinggy named domain token; stdin only","localxposeMode":"named; quick is unavailable because the first request is redirected","localxposeAccessToken":"LocalXpose credential; stdin only","localxposeRegion":"us | eu | ap","tunnelId":"official Tunnel ID","apiKey":"official Tunnel runtime key; stdin only","tunnelBinary":"optional executable path"}},
            "waitContract":"create/send → wait(30s default; 20–30s recommended) → timeout → same taskId/threadId and turnId, previous snapshotHash as expectedHash → wait again until terminal/interaction. Event-driven slices, not read/sleep polling. Timeout/cancelling wait never stops or recreates the task; unconfirmed is not failure. Ordinary Chat/general MCP clients should not block for minutes by default. codex_wait maximum 90000ms leaves remote gateway headroom; agent_wait maximum 300000ms requires upstream support; stdio forwarding budget remains 330s.",
            "update":"Partial merge; running ingresses are stopped, updated and restarted by the shared backend. Other ingresses remain online. Changes reset only this ingress verification.",
            "oauthDecisionInput":{"id":"pending request id from oauth list","allow":"boolean; true approves, false denies"},
            "oauthReadback":"oauth request returns pending/approved/denied/completed/expired; approved is not token exchange or task acceptance. Keep the client authorization page open for callback.",
            "authNote":"none exposes allowed tools to anyone with network access. Prefer a fixed URL with OAuth (local app consent via agent-remote-control:// or authenticated CLI consent, PKCE, DCR or preregistration) or bearer for clients that support it.",
            "tokenDelivery":"token rotate returns the new secret once in stdout. Redirect to a protected local file (umask 077); do not capture it into chat/logs. Supply an initial bearerToken via stdin when adding.",
            "configureInput":{"tunnelId":"可选；省略保留原值","apiKey":"可选；空字符串保留原值"},
            "networkInput":{"proxyMode":"system | direct | custom","proxyUrl":"自定义 HTTP/HTTPS 地址，其余为空"},
            "note":"所有命令输出 JSON。help、guide、capabilities、schema、ingress presets 和 logs --offline 无需运行 Core；app start 可启动安装版，cli mcp 支持离线能力发现和启动。其他操作按所属 Core/Desktop 报告可用状态。凭据仅从 stdin 输入，禁止放入命令参数或聊天。"})),
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
