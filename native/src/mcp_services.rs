//! Device-owned experimental downstream MCP configuration. Native profiles stay native.
use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Service {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub agents: Vec<String>,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub source: Option<Value>,
    #[serde(default)]
    pub check: Option<Value>,
}
fn lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    &LOCK
}
fn stored() -> Result<Vec<Service>> {
    let path = root().join("mcp-services.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    serde_json::from_value(load(&path)?)
        .map_err(|_| "MCP_CONFIG_INVALID: Inspect the device MCP service configuration".into())
}
fn store(services: &[Service]) -> Result<()> {
    save(&root().join("mcp-services.json"), &json!(services))
}
pub(crate) fn enabled() -> bool {
    crate::preferences::read()["mcp-services"] == "on"
}
fn public(service: &Service) -> Value {
    let endpoint = url::Url::parse(&service.url).ok().map(|mut url| {
        url.set_query(None);
        url.set_fragment(None);
        let _ = url.set_username("");
        let _ = url.set_password(None);
        url.to_string()
    });
    json!({"id":service.id,"name":service.name,"transport":service.transport,"command":service.command,
        "endpoint":endpoint,"argsConfigured":!service.args.is_empty(),"envNames":service.env.keys().collect::<Vec<_>>(),
        "headerNames":service.headers.keys().collect::<Vec<_>>(),"agents":service.agents,"revision":service.revision,
        "source":service.source.as_ref().map(|s| json!({"agent":s["agent"],"name":s["name"]})),
        "check":service.check.clone().unwrap_or(json!({"state":"unchecked","tools":[]}))})
}
pub(crate) fn legacy() -> Result<Value> {
    let path = root().join("agents/mcp.json");
    if !path.exists() {
        return Ok(json!({}));
    }
    load(&path)
        .map_err(|_| "INVALID_AGENT_MCP: Inspect agents/mcp.json without replacing it".into())
}
fn legacy_server<'a>(config: &'a Value, agent: &str, name: &str) -> Option<&'a Value> {
    config[agent]["mcpServers"]
        .as_array()?
        .iter()
        .find(|s| s["name"] == name)
}
pub(crate) fn read(support: Value, filter: Option<&str>) -> Result<Value> {
    let _guard = lock().lock().map_err(|_| "MCP_CONFIG_BUSY")?;
    let services = stored()?;
    let legacy = legacy()?;
    let mut candidates = vec![];
    for (agent, config) in legacy.as_object().into_iter().flatten() {
        for server in config["mcpServers"].as_array().into_iter().flatten() {
            if filter.is_some_and(|f| f != agent) {
                continue;
            }
            let adopted = services.iter().find(|s| {
                s.source
                    .as_ref()
                    .is_some_and(|o| o["agent"] == *agent && o["name"] == server["name"])
            });
            candidates.push(json!({"agent":agent,"name":server["name"],"command":server["command"],"adoptedBy":adopted.map(|s| &s.id)}));
        }
    }
    let mut rows: Vec<Value> = services
        .iter()
        .filter(|s| filter.is_none_or(|a| s.agents.iter().any(|v| v == a)))
        .map(public)
        .collect();
    for row in &mut rows {
        let service = services.iter().find(|s| s.id == row["id"]).unwrap();
        if let Some(source) = &service.source {
            row["sourceChanged"] = json!(
                legacy_server(&legacy, string(source, "agent"), string(source, "name"))
                    != source.get("configuration")
            );
        }
    }
    Ok(
        json!({"enabled":enabled(),"services":rows,"legacy":candidates,"support":support,
        "appliesTo":"new-acp-processes-and-session-loads","runningProcesses":"retain-launch-configuration",
        "contextProviderConfigured":crate::context_provider::configured()}),
    )
}
fn validate(service: &Service, support: &Value) -> Result<()> {
    if service.name.trim().is_empty()
        || service.name.chars().count() > 128
        || service.name == "context-provider"
    {
        return Err("MCP_INVALID_NAME: Use a nonempty name of at most 128 characters; context-provider is reserved".into());
    }
    if service.agents.iter().collect::<HashSet<_>>().len() != service.agents.len() {
        return Err("MCP_INVALID_AGENTS: Choose each Agent once".into());
    }
    for agent in &service.agents {
        if !support
            .as_array()
            .into_iter()
            .flatten()
            .any(|s| s["agent"] == *agent && s["configurable"] == true)
        {
            return Err(format!("MCP_AGENT_UNSUPPORTED: {agent} has no ARC session MCP assignment; use its native profile"));
        }
    }
    match service.transport.as_str() {
        "stdio" if !service.command.is_empty() && Path::new(&service.command).is_absolute()
            && !service.command.contains('\0') && !service.args.iter().any(|s| s.contains('\0')) => {},
        "stdio" => return Err("MCP_INVALID_COMMAND: Choose an absolute executable path and arguments without NUL characters".into()),
        "http" => {
            let url = url::Url::parse(&service.url).map_err(|_| "MCP_INVALID_URL: Enter a complete HTTP(S) MCP endpoint")?;
            if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
                return Err("MCP_INVALID_URL: Use an HTTP(S) endpoint without userinfo or fragments; put credentials in headers".into());
            }
            for (name, value) in &service.headers {
                if ["host","content-type","accept","mcp-session-id","mcp-protocol-version"].contains(&name.to_ascii_lowercase().as_str())
                    || reqwest::header::HeaderName::from_bytes(name.as_bytes()).is_err() || reqwest::header::HeaderValue::from_str(value).is_err() {
                    return Err("MCP_INVALID_HEADER: Use valid custom headers; ARC owns Host, Accept, Content-Type, session, and protocol headers".into());
                }
            }
        }
        _ => return Err("MCP_INVALID_TRANSPORT: Choose stdio or http (Streamable HTTP)".into()),
    }
    for (name, value) in &service.env {
        if name.is_empty() || name.contains(['=', '\0']) || value.contains('\0') {
            return Err(
                "MCP_INVALID_ENV: Correct the environment variable names and values".into(),
            );
        }
    }
    Ok(())
}
pub(crate) fn save_service(body: Value, support: &Value) -> Result<Value> {
    let _guard = lock().lock().map_err(|_| "MCP_CONFIG_BUSY")?;
    let mut services = stored()?;
    let existing = services.iter().position(|s| s.id == string(&body, "id"));
    if !string(&body, "id").is_empty() && existing.is_none() {
        return Err("MCP_SERVICE_NOT_FOUND: Refresh the service list".into());
    }
    let mut config = if let Some(i) = existing {
        if body["expectedRevision"].as_u64() != Some(services[i].revision) {
            return Err("MCP_CONFIG_CHANGED: Refresh before editing this service".into());
        }
        serde_json::to_value(&services[i]).unwrap()
    } else {
        json!({"id":id(),"name":"","transport":"stdio"})
    };
    let fields = body["configuration"]
        .as_object()
        .ok_or("MCP_CONFIG_INVALID: Provide configuration fields")?;
    if fields
        .get("transport")
        .is_some_and(|t| t != &config["transport"])
    {
        for (key, value) in [
            ("args", json!([])),
            ("env", json!({})),
            ("headers", json!({})),
            ("url", json!("")),
            ("command", json!("")),
        ] {
            config[key] = value;
        }
    }
    for (key, value) in fields {
        if ![
            "name",
            "transport",
            "command",
            "args",
            "env",
            "url",
            "headers",
            "agents",
        ]
        .contains(&key.as_str())
        {
            return Err("MCP_CONFIG_INVALID: Read the current management schema".into());
        }
        config[key] = value.clone();
    }
    let mut service: Service = serde_json::from_value(config)
        .map_err(|_| "MCP_CONFIG_INVALID: Read the current field types")?;
    validate(&service, support)?;
    if services
        .iter()
        .any(|s| s.id != service.id && s.name == service.name)
    {
        return Err("MCP_NAME_EXISTS: Edit the existing service or choose another name".into());
    }
    service.revision += 1;
    service.check = None;
    let result = public(&service);
    if let Some(i) = existing {
        services[i] = service;
    } else {
        services.push(service);
    }
    store(&services)?;
    Ok(result)
}
pub(crate) fn remove(body: &Value) -> Result<Value> {
    let _guard = lock().lock().map_err(|_| "MCP_CONFIG_BUSY")?;
    let mut services = stored()?;
    let i = services
        .iter()
        .position(|s| s.id == string(body, "id"))
        .ok_or("MCP_SERVICE_NOT_FOUND: Refresh the service list")?;
    if body["expectedRevision"].as_u64() != Some(services[i].revision) {
        return Err("MCP_CONFIG_CHANGED: Refresh before removing this service".into());
    }
    services.remove(i);
    store(&services)?;
    Ok(json!({"removed":true,"runningProcesses":"retain-launch-configuration"}))
}
pub(crate) fn adopt(body: &Value, support: &Value) -> Result<Value> {
    let _guard = lock().lock().map_err(|_| "MCP_CONFIG_BUSY")?;
    let mut services = stored()?;
    let legacy = legacy()?;
    let agent = string(body, "agent");
    let name = string(body, "name");
    let original = legacy_server(&legacy, agent, name)
        .ok_or("MCP_SOURCE_NOT_FOUND: Refresh the existing ACP configuration")?;
    if services.iter().any(|s| s.name == name) {
        return Err("MCP_NAME_EXISTS: Edit the existing experimental service".into());
    }
    let mut config = original.clone();
    config["transport"] = json!("stdio");
    config["id"] = json!(id());
    config["agents"] = json!([agent]);
    config["source"] = json!({"agent":agent,"name":name,"configuration":original});
    let mut service: Service = serde_json::from_value(config).map_err(|_| {
        "INVALID_AGENT_MCP: The selected server does not match the current stdio contract"
    })?;
    service.revision = 1;
    validate(&service, support)?;
    let result = public(&service);
    services.push(service);
    store(&services)?;
    Ok(result)
}
pub(crate) async fn check(body: &Value) -> Result<Value> {
    let service = {
        let _guard = lock().lock().map_err(|_| "MCP_CONFIG_BUSY")?;
        stored()?
            .into_iter()
            .find(|s| s.id == string(body, "id"))
            .ok_or("MCP_SERVICE_NOT_FOUND: Refresh the service list")?
    };
    let result = crate::mcp_transport::discover(&service).await;
    let _guard = lock().lock().map_err(|_| "MCP_CONFIG_BUSY")?;
    let mut services = stored()?;
    let current = services
        .iter_mut()
        .find(|s| s.id == service.id && s.revision == service.revision)
        .ok_or("MCP_CONFIG_CHANGED: Check the current configuration again")?;
    current.check = Some(result);
    let view = public(current);
    store(&services)?;
    Ok(view)
}
pub(crate) fn assigned(agent: &str) -> Result<Vec<Service>> {
    if !enabled() {
        return Ok(vec![]);
    }
    Ok(stored()?
        .into_iter()
        .filter(|s| s.agents.iter().any(|a| a == agent))
        .collect())
}
pub(crate) fn mount(service: &Service) -> Result<Value> {
    if service.transport == "stdio" {
        return Ok(
            json!({"name":service.name,"command":service.command,"args":service.args,
            "env":service.env.iter().map(|(name,value)| json!({"name":name,"value":value})).collect::<Vec<_>>()}),
        );
    }
    Ok(
        json!({"name":service.name,"command":crate::runtime::binary()?,"args":["mcp-service-stdio"],
        "env":[{"name":"ARC_STATE_DIR","value":root()},{"name":"ARC_MCP_SERVICE_CONFIG","value":json!({"name":service.name,"transport":"http","url":service.url,"headers":service.headers}).to_string()}]}),
    )
}

/// Known native profile owners are read without modifying them. Project files apply at dispatch cwd.
pub(crate) fn native_conflict(
    agent: &str,
    cwd: &Path,
    profile: Option<&str>,
    services: &[Service],
) -> Result<()> {
    if services.is_empty() {
        return Ok(());
    }
    let home = dirs::home_dir().ok_or("MCP_NATIVE_HOME_UNAVAILABLE")?;
    let mut paths = vec![];
    let keys: &[&str] = match agent {
        "claude" => {
            if let Some(profile) = profile {
                paths.push(crate::accounts::claude::config_dir(profile)?.join(".claude.json"));
            } else {
                paths.push(
                    std::env::var_os("CLAUDE_CONFIG_DIR")
                        .map(PathBuf::from)
                        .map(|p| p.join(".claude.json"))
                        .unwrap_or(home.join(".claude.json")),
                );
            }
            for dir in cwd.ancestors() {
                paths.push(dir.join(".mcp.json"));
            }
            &["mcpServers"]
        }
        "opencode" => {
            let base = std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .unwrap_or(home.join(".config"));
            paths.push(base.join("opencode/opencode.json"));
            paths.push(base.join("opencode/opencode.jsonc"));
            if let Some(path) = std::env::var_os("OPENCODE_CONFIG") {
                paths.push(path.into());
            }
            for dir in cwd.ancestors() {
                paths.push(dir.join("opencode.json"));
                paths.push(dir.join("opencode.jsonc"));
            }
            &["mcp"]
        }
        "cursor" => {
            paths.push(home.join(".cursor/mcp.json"));
            paths.push(cwd.join(".cursor/mcp.json"));
            &["mcpServers"]
        }
        "gemini" | "qwen" => {
            paths.push(home.join(format!(".{agent}/settings.json")));
            paths.push(cwd.join(format!(".{agent}/settings.json")));
            &["mcpServers"]
        }
        _ => &[],
    };
    for path in paths.into_iter().filter(|p| p.is_file()) {
        let text = std::fs::read_to_string(&path).map_err(|_| {
            "MCP_NATIVE_PROFILE_UNREADABLE: Inspect the selected Agent's native MCP profile"
        })?;
        // OpenCode accepts JSONC. Preserve strings while removing comments and trailing commas.
        let text = jsonc(&text);
        let config: Value = serde_json::from_str(&text).map_err(|_| "MCP_NATIVE_PROFILE_UNREADABLE: Correct the native MCP profile before assigning experimental services")?;
        let mut collections = keys
            .iter()
            .filter_map(|key| config[*key].as_object())
            .collect::<Vec<_>>();
        if agent == "claude" {
            if let Some(projects) = config["projects"].as_object() {
                for (dir, project) in projects {
                    if cwd.starts_with(dir) {
                        if let Some(mcp) = project["mcpServers"].as_object() {
                            collections.push(mcp);
                        }
                    }
                }
            }
        }
        for collection in collections {
            for (name, native) in collection {
                for service in services {
                    let empty = json!({});
                    let same_url = service.transport == "http"
                        && native["url"].as_str() == Some(service.url.as_str())
                        && native
                            .get("headers")
                            .or_else(|| native.get("http_headers"))
                            .unwrap_or(&empty)
                            == &json!(service.headers);
                    let same_command = service.transport == "stdio"
                        && native.get("env").unwrap_or(&empty) == &json!(service.env)
                        && ((native["command"] == service.command
                            && native.get("args").unwrap_or(&json!([])) == &json!(service.args))
                            || native["command"]
                                == json!(std::iter::once(service.command.clone())
                                    .chain(service.args.clone())
                                    .collect::<Vec<_>>()));
                    if name == &service.name || same_url || same_command {
                        return Err(format!("MCP_NATIVE_PROFILE_CONFLICT: {} is already configured in the native {agent} profile. Remove its experimental assignment and use the native service", service.name));
                    }
                }
            }
        }
    }
    Ok(())
}
fn jsonc(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    let mut quoted = false;
    let mut escaped = false;
    while let Some(c) = chars.next() {
        if quoted {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
            continue;
        }
        if c == '"' {
            quoted = true;
            out.push(c);
        } else if c == '/' && chars.peek() == Some(&'/') {
            for c in chars.by_ref() {
                if c == '\n' {
                    out.push('\n');
                    break;
                }
            }
        } else if c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            while let Some(c) = chars.next() {
                if c == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    let mut cleaned = String::new();
    let mut chars = out.chars().peekable();
    let mut quoted = false;
    let mut escaped = false;
    while let Some(c) = chars.next() {
        if quoted {
            cleaned.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
        } else if c == '"' {
            quoted = true;
            cleaned.push(c);
        } else if c != ','
            || !chars
                .clone()
                .find(|c| !c.is_whitespace())
                .is_some_and(|c| c == ']' || c == '}')
        {
            cleaned.push(c);
        }
    }
    cleaned
}

pub(crate) async fn native_list(control: &Arc<crate::control::Control>) -> Result<Value> {
    let mut rows = vec![];
    let mut cursor = Value::Null;
    let mut seen = HashSet::new();
    loop {
        let page = control
            .tool(
                "mcp",
                json!({"action":"list","params":{"cursor":cursor,"detail":"toolsAndAuthOnly"}}),
            )
            .await?;
        for row in page["data"].as_array().into_iter().flatten() {
            rows.push(json!({"name":row["name"],"authStatus":row["authStatus"],"runtimeStatus":row["runtimeStatus"],"tools":row["tools"],"owner":"codex-native"}));
        }
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
        if !seen.insert(cursor.to_string()) {
            return Err("MCP_NATIVE_CURSOR_REPEATED: Retry native discovery".into());
        }
    }
    Ok(json!({"services":rows,"checkedAt":now(),"owner":"codex-native"}))
}

pub(crate) fn operations() -> Vec<Value> {
    let fields = json!({"name":{"type":"string"},"transport":{"enum":["stdio","http"]},"command":{"type":"string"},
        "url":{"type":"string","writeOnly":true},"args":{"type":"array","items":{"type":"string"},"writeOnly":true},
        "env":{"type":"object","additionalProperties":{"type":"string"},"writeOnly":true},
        "headers":{"type":"object","additionalProperties":{"type":"string"},"writeOnly":true},"agents":{"type":"array","items":{"type":"string"}}});
    let id = json!({"type":"string"});
    let revision = json!({"type":"integer","minimum":1});
    let mut ops = vec![
        json!({"name":"mcp-services.list","method":"GET","route":"mcp-services","localOnly":true,
        "description":"Read redacted service configuration, observed tools, legacy ACP sources, and Agent support. No upstream request.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
    ];
    for (name, description, properties, required) in [
        ("save","Create or edit a device-owned MCP service. Omitted secret fields retain saved values. Edits require expectedRevision.",json!({"id":id,"expectedRevision":revision,"configuration":{"type":"object","properties":fields,"additionalProperties":false}}),vec!["configuration"]),
        ("remove","Remove experimental configuration. Existing processes keep their launch-time configuration.",json!({"id":id,"expectedRevision":revision}),vec!["id","expectedRevision"]),
        ("check","Connect, initialize, and paginate tools/list. Read state after uncertain outcomes; this check invokes no tools.",json!({"id":id}),vec!["id"]),
        ("adopt","Explicitly overlay a selected existing ACP stdio entry. The original configuration remains intact.",json!({"agent":{"type":"string"},"name":{"type":"string"}}),vec!["agent","name"]),
        ("native","Read Codex's real native MCP status and tool catalog through the existing mcp operation.",json!({}),vec![]),
        ("native-login","Start native Codex MCP OAuth. Follow the returned authorization URL, then refresh native status.",json!({"name":{"type":"string"}}),vec!["name"]),
    ] {
        ops.push(json!({"name":format!("mcp-services.{name}"),"method":"POST","route":format!("mcp-services/{name}"),"localOnly":true,"description":description,
            "inputSchema":{"type":"object","required":["body"],"properties":{"body":{"type":"object","properties":properties,"required":required,"additionalProperties":false}},"additionalProperties":false}}));
    }
    ops
}
