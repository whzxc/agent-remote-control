//! Local management contract. UI routes, CLI calls and local MCP share these operations.
use crate::*;

pub fn catalog() -> Value {
    let mut value: Value =
        serde_json::from_str(include_str!("management.json")).expect("management catalog");
    value["ingressConfiguration"] = crate::ingress::config::descriptor().clone();
    value["preferenceDefaults"] = crate::preferences::defaults();
    let mut fields = serde_json::Map::new();
    for (key, field) in crate::ingress::config::descriptor()["fields"]
        .as_object()
        .unwrap()
    {
        let mut schema = json!({"type":if field["default"].is_boolean() {"boolean"} else if field["default"].is_number() {"integer"} else {"string"},"default":field["default"]});
        if field["maxBytes"].is_number() {
            schema["maxLength"] = field["maxBytes"].clone();
        }
        if field["savedFlag"].is_string() {
            schema["writeOnly"] = json!(true);
        }
        fields.insert(key.clone(), schema);
    }
    for operation in value["operations"].as_array_mut().unwrap() {
        if operation["inputSchema"]["properties"]["body"]["properties"]
            .get("config")
            .is_some()
        {
            operation["inputSchema"]["properties"]["body"]["properties"]["config"] =
                json!({"type":"object","properties":fields,"additionalProperties":false});
        }
    }
    value
}
pub fn resolve(name: &str, args: &Value) -> Result<(String, String, Value)> {
    let catalog = catalog();
    let operation = catalog["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["name"] == name)
        .ok_or("UNKNOWN_OPERATION")?;
    let validator = crate::validator("management", name, &operation["inputSchema"])?;
    if !validator.is_valid(args) {
        return Err(format!("INVALID_ARGUMENT: read schema for {name}"));
    }
    let mut route = string(operation, "route").to_owned();
    for key in ["id", "requestId"] {
        if route.contains(&format!("{{{key}}}")) {
            let value = string(args, key);
            if value.is_empty()
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            {
                return Err(format!("INVALID_ARGUMENT: {key}"));
            }
            route = route.replace(&format!("{{{key}}}"), value);
        }
    }
    Ok((
        route,
        string(operation, "method").into(),
        args.get("body").cloned().unwrap_or(json!({})),
    ))
}
pub async fn call(name: &str, args: Value) -> Result<Value> {
    let (route, method, body) = resolve(name, &args)?;
    if name == "logs.query" && body["offline"] == true {
        return crate::logs::query(&body);
    }
    if name == "app.start" {
        return start_app().await;
    }
    crate::transport::forward_request(&route, &method, body).await
}
#[cfg(target_os = "linux")]
async fn start_app() -> Result<Value> {
    crate::headless::start().await
}
#[cfg(not(target_os = "linux"))]
async fn start_app() -> Result<Value> {
    if let Ok(status) = crate::transport::forward_request("app", "GET", json!({})).await {
        return Ok(status);
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let desktop = if exe
        .file_stem()
        .is_some_and(|s| s == "local-connector-desktop")
    {
        exe
    } else if cfg!(target_os = "macos") {
        exe.parent()
            .ok_or("invalid installation")?
            .join("../../MacOS/local-connector-desktop")
    } else {
        exe.parent()
            .ok_or("invalid installation")?
            .join("../local-connector-desktop.exe")
    };
    #[cfg(target_os = "macos")]
    {
        let desktop = desktop.canonicalize().map_err(|e| e.to_string())?;
        let bundle = desktop
            .ancestors()
            .nth(3)
            .ok_or("invalid application bundle")?;
        // LaunchServices owns the app, so it survives the launching shell or MCP client's exit.
        crate::output(
            "/usr/bin/open",
            &["-a", bundle.to_str().ok_or("invalid application path")?],
        )
        .await?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let mut launcher = command(desktop);
        launcher
            .kill_on_drop(false)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(unix)]
        launcher.process_group(0);
        #[cfg(windows)]
        launcher.creation_flags(0x00000008 | 0x00000200);
        launcher.spawn().map_err(|e| e.to_string())?;
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        if let Ok(status) = crate::transport::forward_request("app", "GET", json!({})).await {
            return Ok(status);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("APP_START_TIMEOUT".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}
/// Deliberately local: administrative authority is not inherited by public ingress toolPolicy=all.
pub async fn stdio() -> Result<()> {
    let mut input = tokio::io::BufReader::new(tokio::io::stdin());
    let output = Arc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
    let mut jobs = tokio::task::JoinSet::new();
    loop {
        let bytes = crate::line(&mut input, 1024 * 1024).await?;
        if bytes.is_empty() {
            while jobs.join_next().await.is_some() {}
            return Ok(());
        }
        let request: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid JSON")?;
        if request.get("id").is_none() {
            continue;
        }
        let output = output.clone();
        jobs.spawn(async move { respond(request, output).await });
        while jobs.try_join_next().is_some() {}
    }
}
async fn respond(request: Value, output: Arc<tokio::sync::Mutex<tokio::io::Stdout>>) -> Result<()> {
    let result: Result<Value> = match string(&request, "method") {
        "initialize" => Ok(
            json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"local-connector-management","version":env!("CLC_BUILD_VERSION")},"instructions":"Local authenticated administration. Discover operation schemas before calls; writes may stop this MCP host. Lifecycle acceptance must be read back after reconnect."}),
        ),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools":[
            {"name":"connector_capabilities","description":"Discover local management operations and exact input schemas.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
            {"name":"connector_call","description":"Execute a discovered local management operation; same contract as CLI and UI.","inputSchema":{"type":"object","required":["operation"],"properties":{"operation":{"type":"string"},"arguments":{"type":"object"}},"additionalProperties":false}}
        ]})),
        "tools/call" => {
            let args = &request["params"]["arguments"];
            let value = match string(&request["params"], "name") {
                "connector_capabilities" => Ok(catalog()),
                "connector_call" => {
                    call(
                        string(args, "operation"),
                        args.get("arguments").cloned().unwrap_or(json!({})),
                    )
                    .await
                }
                _ => Err("UNKNOWN_TOOL".into()),
            };
            Ok(match value {
                Ok(value) => {
                    json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":{"result":value},"isError":false})
                }
                Err(error) => {
                    json!({"content":[{"type":"text","text":error}],"structuredContent":{"error":{"code":error_code(&error),"message":error}},"isError":true})
                }
            })
        }
        _ => Err("method not found".into()),
    };
    let response = match result {
        Ok(value) => json!({"jsonrpc":"2.0","id":request["id"],"result":value}),
        Err(error) => {
            json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":error}})
        }
    };
    let mut output = output.lock().await;
    crate::output::async_line(&mut output, response).await
}

pub fn desktop_route(route: &str) -> bool {
    matches!(
        route,
        "appearance"
            | "app"
            | "app/quit"
            | "app/restart"
            | "updates"
            | "updates/check"
            | "updates/download"
            | "updates/install"
            | "updates/cancel"
    )
}

pub fn error_code(message: &str) -> &str {
    if message.contains("无法连接本机 Core") || message.contains("请先打开 Local Connector")
    {
        return "APP_UNAVAILABLE";
    }
    for code in [
        "INVALID_ARGUMENT",
        "UNKNOWN_OPERATION",
        "UNKNOWN_TOOL",
        "REQUEST_ID_CONFLICT",
        "UNSUPPORTED_OPERATION",
        "APP_START_TIMEOUT",
    ] {
        if message.starts_with(code) {
            return code;
        }
    }
    if message == "UNKNOWN_ROUTE" {
        "APP_VERSION_MISMATCH"
    } else {
        "COMMAND_FAILED"
    }
}
