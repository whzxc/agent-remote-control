//! Experimental MCP hub: device-owned downstream servers exposed to every control source
//! through catalog ops. Control sources connect only ARC; ARC holds the downstream sessions.
use crate::mcp_transport::{Endpoint, Session};
use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

const CONNECT: Duration = Duration::from_secs(30);
const IDLE: Duration = Duration::from_secs(600);
const CALL_DEFAULT_MS: u64 = 120_000;
const CALL_MAX_MS: u64 = 600_000;
pub(crate) const OPS: [&str; 3] = ["mcp_tools", "mcp_call", "mcp_configure"];

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Server {
    pub name: String,
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
    #[serde(default)]
    pub tool_timeout_seconds: Option<u64>,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub added_by: Option<Value>,
}
fn enabled_default() -> bool {
    true
}
impl Server {
    fn endpoint(&self) -> Endpoint<'_> {
        Endpoint {
            transport: &self.transport,
            command: &self.command,
            args: &self.args,
            env: &self.env,
            cwd: self.cwd.as_deref(),
            url: &self.url,
            headers: &self.headers,
        }
    }
}

pub(crate) fn enabled() -> bool {
    crate::preferences::read()["mcp-services"] == "on"
}

fn lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    &LOCK
}
fn path() -> PathBuf {
    root().join("mcp-hub.json")
}
/// One-time migration of the per-Agent experiment store. Agent assignments are dropped.
fn migrate() -> Result<()> {
    let old = root().join("mcp-services.json");
    if path().exists() || !old.exists() {
        return Ok(());
    }
    let mut servers: Vec<Server> = vec![];
    for row in load(&old)?.as_array().into_iter().flatten() {
        let mut name = sanitize(string(row, "name"));
        while servers.iter().any(|s| s.name == name) {
            name.push('_');
        }
        let fields = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
        servers.push(Server {
            name,
            transport: string(row, "transport").into(),
            command: string(row, "command").into(),
            args: serde_json::from_value(fields("args")).unwrap_or_default(),
            env: serde_json::from_value(fields("env")).unwrap_or_default(),
            url: string(row, "url").into(),
            headers: serde_json::from_value(fields("headers")).unwrap_or_default(),
            enabled: true,
            revision: 1,
            added_by: Some(json!({"kind":"migration","from":"mcp-services","at":now()})),
            ..Default::default()
        });
    }
    save(&path(), &json!({"servers":servers}))?;
    std::fs::remove_file(old).map_err(|e| format!("MCP_HUB_STORAGE: {e}"))
}
fn stored() -> Result<Vec<Server>> {
    migrate()?;
    if !path().exists() {
        return Ok(vec![]);
    }
    serde_json::from_value(load(&path())?["servers"].clone()).map_err(|_| {
        "MCP_HUB_CONFIG_INVALID: Inspect mcp-hub.json in the ARC state directory".into()
    })
}
fn store(servers: &[Server]) -> Result<()> {
    save(&path(), &json!({"servers":servers}))
}
fn sanitize(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.') {
                c
            } else {
                '-'
            }
        })
        .take(64)
        .collect();
    if !out
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
    {
        out.insert(0, 'm');
        out.truncate(64);
    }
    out
}
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && sanitize(name) == name
}

fn validate(server: &Server) -> Result<()> {
    if !valid_name(&server.name) {
        return Err("MCP_INVALID_NAME: Use 1-64 characters from A-Z, a-z, 0-9, _, - and ., starting with a letter or digit".into());
    }
    match server.transport.as_str() {
        "stdio" if !server.command.trim().is_empty() && !server.command.contains('\0')
            && !server.args.iter().any(|a| a.contains('\0')) => {}
        "stdio" => return Err("MCP_INVALID_COMMAND: stdio servers need command (absolute path or a name on ARC's search path) and args without NUL characters".into()),
        "http" => {
            let url = url::Url::parse(&server.url).map_err(|_| "MCP_INVALID_URL: Use a complete HTTP(S) Streamable HTTP endpoint")?;
            if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
                return Err("MCP_INVALID_URL: Use an HTTP(S) endpoint without userinfo or fragments; put credentials in headers".into());
            }
            for (name, value) in &server.headers {
                if ["host", "content-type", "accept", "mcp-session-id", "mcp-protocol-version"].contains(&name.to_ascii_lowercase().as_str())
                    || reqwest::header::HeaderName::from_bytes(name.as_bytes()).is_err()
                    || reqwest::header::HeaderValue::from_str(value).is_err() {
                    return Err("MCP_INVALID_HEADER: Use valid custom headers; ARC owns Host, Accept, Content-Type, session and protocol headers".into());
                }
            }
        }
        _ => return Err("MCP_INVALID_TRANSPORT: Use stdio or http (Streamable HTTP)".into()),
    }
    if server
        .env
        .keys()
        .any(|k| k.is_empty() || k.contains(['=', '\0']))
        || server.env.values().any(|v| v.contains('\0'))
    {
        return Err("MCP_INVALID_ENV: Correct the environment variable names and values".into());
    }
    if server
        .cwd
        .as_deref()
        .is_some_and(|cwd| !Path::new(cwd).is_absolute())
    {
        return Err("MCP_INVALID_CWD: cwd must be an absolute directory".into());
    }
    if server
        .tool_timeout_seconds
        .is_some_and(|s| s == 0 || s > CALL_MAX_MS / 1000)
    {
        return Err("MCP_INVALID_TIMEOUT: toolTimeoutSeconds must be 1-600".into());
    }
    Ok(())
}

#[derive(Default)]
struct Live {
    revision: u64,
    session: Option<Arc<Session>>,
    tools: Vec<Value>,
    listed: bool,
    state: &'static str,
    error: Option<String>,
    observed_at: Option<String>,
    used: Option<Instant>,
}
type Entry = Arc<Mutex<Live>>;
static POOL: LazyLock<std::sync::Mutex<HashMap<String, Entry>>> = LazyLock::new(Default::default);
fn entry(name: &str) -> Entry {
    POOL.lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(name.into())
        .or_default()
        .clone()
}
async fn forget(name: &str) {
    let entry = POOL.lock().unwrap_or_else(|e| e.into_inner()).remove(name);
    if let Some(entry) = entry {
        if let Some(session) = entry.lock().await.session.take() {
            session.close().await;
        }
    }
}
fn sweeper() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        tokio::spawn(async {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let entries: Vec<Entry> = POOL
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .values()
                    .cloned()
                    .collect();
                for entry in entries {
                    let Ok(mut live) = entry.try_lock() else {
                        continue;
                    };
                    if live.used.is_some_and(|used| used.elapsed() > IDLE) {
                        if let Some(session) = live.session.take() {
                            session.close().await;
                        }
                        live.used = None;
                    }
                }
            }
        });
    });
}
fn reconnectable(error: &str) -> bool {
    [
        "MCP_STDIO_CLOSED",
        "MCP_SESSION_CLOSED",
        "MCP_HTTP_404",
        "MCP_CONNECTION_LOST",
    ]
    .iter()
    .any(|code| error.starts_with(code))
}
async fn list_tools(session: &Session) -> Result<Vec<Value>> {
    let mut tools = vec![];
    let mut cursor = Value::Null;
    let mut seen = std::collections::HashSet::new();
    loop {
        let params = if cursor.is_null() {
            json!({})
        } else {
            json!({"cursor":cursor})
        };
        let page = session.request("tools/list", params, CONNECT).await?;
        tools.extend(
            page["tools"]
                .as_array()
                .ok_or("MCP_INVALID_TOOLS: tools/list must return a tools array")?
                .iter()
                .cloned(),
        );
        cursor = page["nextCursor"].clone();
        if cursor.is_null() || tools.len() > 2000 {
            return Ok(tools);
        }
        if !seen.insert(cursor.to_string()) {
            return Err("MCP_CURSOR_REPEATED: The server repeated a tools/list cursor".into());
        }
    }
}
/// Connect lazily and keep the session warm; tools are re-listed on refresh or list_changed.
async fn ensure(server: &Server, refresh: bool) -> Result<Arc<Session>> {
    sweeper();
    let entry = entry(&server.name);
    let mut live = entry.lock().await;
    if live.revision != server.revision {
        if let Some(session) = live.session.take() {
            session.close().await;
        }
        *live = Live {
            revision: server.revision,
            ..Default::default()
        };
    }
    for attempt in 0..2 {
        let reused = live.session.as_ref().is_some_and(|s| s.alive());
        if !reused {
            live.session = None;
            match Session::open(&server.endpoint(), CONNECT).await {
                Ok(session) => live.session = Some(session),
                Err(error) => {
                    live.state = "failed";
                    live.error = Some(error.clone());
                    live.observed_at = Some(now());
                    return Err(error);
                }
            }
        }
        let session = live.session.clone().unwrap();
        if refresh || !live.listed || session.take_stale() {
            match list_tools(&session).await {
                Ok(tools) => {
                    live.tools = tools;
                    live.listed = true;
                    live.observed_at = Some(now());
                }
                Err(error) => {
                    session.close().await;
                    live.session = None;
                    if reused && attempt == 0 && reconnectable(&error) {
                        continue;
                    }
                    live.state = "failed";
                    live.error = Some(error.clone());
                    live.observed_at = Some(now());
                    return Err(error);
                }
            }
        }
        live.state = "ready";
        live.error = None;
        live.used = Some(Instant::now());
        return Ok(session);
    }
    Err("MCP_SESSION_CLOSED: Retry the request".into())
}

/// First sentence on one line, at most 160 characters.
fn short(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let first = line.split_once(". ").map(|(a, _)| a).unwrap_or(&line);
    let mut out: String = first.chars().take(160).collect();
    if first.chars().count() > 160 {
        out.push('…');
    }
    out
}
/// Compact index entry. readOnly and destructive repeat only explicit downstream annotations.
fn compact_tool(tool: &Value) -> Value {
    let mut row = json!({"name":tool["name"],"description":short(string(tool, "description"))});
    if tool["annotations"]["readOnlyHint"] == true {
        row["readOnly"] = json!(true);
    } else if tool["annotations"]["destructiveHint"] == true {
        row["destructive"] = json!(true);
    }
    row
}
fn public(server: &Server) -> Value {
    let endpoint = url::Url::parse(&server.url).ok().map(|mut url| {
        url.set_query(None);
        url.set_fragment(None);
        url.to_string()
    });
    json!({"name":server.name,"transport":server.transport,"enabled":server.enabled,"revision":server.revision,
        "command":(server.transport == "stdio").then_some(&server.command),"endpoint":endpoint,
        "envNames":server.env.keys().collect::<Vec<_>>(),"headerNames":server.headers.keys().collect::<Vec<_>>(),
        "addedBy":server.added_by})
}
/// Status never waits behind a connecting session and never starts one.
fn status(server: &Server, compact: bool) -> Value {
    let mut row = public(server);
    if !server.enabled {
        row["state"] = json!("disabled");
        return row;
    }
    let entry = entry(&server.name);
    let Ok(live) = entry.try_lock() else {
        row["state"] = json!("connecting");
        return row;
    };
    let current = live.revision == server.revision;
    row["state"] = json!(match (current, live.state) {
        (false, _) | (true, "") => "unchecked",
        (true, "ready") if live.session.as_ref().is_some_and(|s| s.alive()) => "ready",
        (true, "ready") => "idle",
        (true, state) => state,
    });
    if current {
        row["observedAt"] = json!(live.observed_at);
        row["error"] = json!(live.error);
        if live.listed {
            row["toolCount"] = json!(live.tools.len());
            row["tools"] = json!(live.tools.iter().map(|t| if compact {
                compact_tool(t)
            } else {
                json!({"name":t["name"],"title":t["title"],"description":t["description"],"annotations":t["annotations"]})
            }).collect::<Vec<_>>());
        }
    }
    row
}

fn fail(message: String, next: Value) -> Value {
    let (code, _) = message.split_once(':').unwrap_or((&message, ""));
    json!({"state":"failed","error":{"code":code,"message":message},"next":next})
}
fn find(name: &str) -> std::result::Result<Server, Value> {
    let servers = stored().map_err(|e| {
        fail(
            e,
            json!({"op":null,"hint":"Ask the user to inspect the ARC MCP hub configuration"}),
        )
    })?;
    servers.into_iter().find(|s| s.name == name).ok_or_else(|| {
        fail(
            format!("MCP_SERVER_UNKNOWN: No hub server named {name:?}"),
            json!({"via":"query","op":"mcp_tools","args":{}}),
        )
    })
}

async fn discover(servers: &[Server], refresh: bool) {
    let mut jobs = tokio::task::JoinSet::new();
    for server in servers.iter().filter(|s| s.enabled) {
        let listed = entry(&server.name)
            .try_lock()
            .is_ok_and(|l| l.listed && l.revision == server.revision);
        if refresh || !listed {
            let server = server.clone();
            jobs.spawn(async move { ensure(&server, refresh).await.map(|_| ()) });
        }
    }
    while jobs.join_next().await.is_some() {}
}

pub(crate) async fn restore() -> Result<()> {
    if enabled() {
        discover(&stored()?, false).await;
    }
    Ok(())
}

/// query mcp_tools: compact index, one server's full tool definitions, or one tool.
pub(crate) async fn tools(args: &Value) -> Result<Value> {
    let servers = stored()?;
    let refresh = args["refresh"] == true;
    let selected = match args["server"].as_str() {
        Some(name) => match servers.iter().find(|s| s.name == name) {
            Some(server) => std::slice::from_ref(server),
            None => {
                return Ok(fail(
                    format!("MCP_SERVER_UNKNOWN: No hub server named {name:?}"),
                    json!({"via":"query","op":"mcp_tools","args":{}}),
                ))
            }
        },
        None => &servers,
    };
    discover(selected, refresh).await;
    if let (Some(name), Some(tool)) = (args["server"].as_str(), args["tool"].as_str()) {
        let live = entry(name);
        let live = live.lock().await;
        return Ok(match live.tools.iter().find(|t| t["name"] == tool) {
            Some(definition) => {
                json!({"server":name,"tool":definition,"observedAt":live.observed_at,
                "next":{"via":"act","op":"mcp_call","args":{"server":name,"tool":tool,"arguments":{}}}})
            }
            None => fail(
                format!("MCP_TOOL_UNKNOWN: {name} has no tool {tool:?}"),
                json!({"via":"query","op":"mcp_tools","args":{"server":name,"refresh":true}}),
            ),
        });
    }
    if let Some(name) = args["server"].as_str() {
        let server = &selected[0];
        let mut row = status(server, false);
        let live = entry(name);
        let live = live.lock().await;
        if live.revision == server.revision && live.listed {
            row["tools"] = json!(live.tools);
        }
        return Ok(row);
    }
    let rows: Vec<Value> = selected.iter().map(|s| status(s, true)).collect();
    let first = rows.iter().find_map(|row| {
        let tool = row["tools"].as_array()?.first()?;
        Some(json!({"server":row["name"],"tool":tool["name"]}))
    });
    let next = match first {
        None if rows.is_empty() => {
            json!({"via":"act","op":"mcp_configure","args":{"action":"import","from":"codex"},"hint":"Import the user's existing MCP servers, or add one with action:add"})
        }
        None => {
            json!({"via":"query","op":"mcp_tools","args":{"refresh":true},"hint":"No tools discovered; inspect each server state and error"})
        }
        Some(args) => {
            json!({"via":"query","op":"mcp_tools","args":args,"hint":"Read a tool's inputSchema with server and tool before calling it with mcp_call"})
        }
    };
    Ok(json!({"servers":rows,"observedAt":now(),"next":next}))
}

/// act mcp_call: one downstream tools/call. Never replayed after an uncertain outcome.
pub(crate) async fn call(args: &Value) -> Result<Value> {
    let name = string(args, "server");
    let tool = string(args, "tool");
    let server = match find(name) {
        Ok(server) => server,
        Err(failure) => return Ok(failure),
    };
    if !server.enabled {
        return Ok(fail(
            format!("MCP_SERVER_DISABLED: {name} is disabled in the hub"),
            json!({"via":"act","op":"mcp_configure","args":{"action":"enable","name":name}}),
        ));
    }
    let retry = json!({"via":"query","op":"mcp_tools","args":{"server":name,"refresh":true}});
    let mut session = match ensure(&server, false).await {
        Ok(session) => session,
        Err(error) => return Ok(fail(error, retry)),
    };
    let known = |live: &Live| live.tools.iter().any(|t| t["name"] == tool);
    if !known(&*entry(name).lock().await) {
        session = match ensure(&server, true).await {
            Ok(session) => session,
            Err(error) => return Ok(fail(error, retry)),
        };
        if !known(&*entry(name).lock().await) {
            return Ok(fail(
                format!("MCP_TOOL_UNKNOWN: {name} has no tool {tool:?}"),
                json!({"via":"query","op":"mcp_tools","args":{"server":name}}),
            ));
        }
    }
    let timeout = args["timeoutMs"]
        .as_u64()
        .or(server.tool_timeout_seconds.map(|s| s * 1000))
        .unwrap_or(CALL_DEFAULT_MS)
        .min(CALL_MAX_MS);
    let arguments = if args["arguments"].is_object() {
        args["arguments"].clone()
    } else {
        json!({})
    };
    let outcome = session
        .request(
            "tools/call",
            json!({"name":tool,"arguments":arguments}),
            Duration::from_millis(timeout),
        )
        .await;
    {
        let live = entry(name);
        let mut live = live.lock().await;
        live.used = Some(Instant::now());
        if outcome.as_ref().is_err_and(|e| reconnectable(e)) {
            live.session = None;
        }
    }
    let result = match outcome {
        Ok(result) => result,
        Err(error) => {
            let hint = "The downstream outcome is unknown. Read downstream state before retrying a side effect";
            return Ok(fail(
                error,
                json!({"via":"query","op":"mcp_tools","args":{"server":name},"hint":hint}),
            ));
        }
    };
    let mut value = json!({"server":name,"tool":tool,"isError":result["isError"] == true,"content":result["content"],"observedAt":now()});
    for key in ["structuredContent", "_meta"] {
        if let Some(v) = result.get(key) {
            value[key] = v.clone();
        }
    }
    Ok(value)
}

/// act mcp_configure. Sources and local management share the same owner and validation.
pub(crate) async fn configure(args: &Value) -> Result<Value> {
    let action = string(args, "action");
    if action == "import" {
        return import(args).await;
    }
    let name = string(args, "name").to_owned();
    let (server, connect) = {
        let _guard = lock().lock().map_err(|_| "MCP_HUB_BUSY")?;
        let mut servers = stored()?;
        let index = servers.iter().position(|s| s.name == name);
        if let (Some(i), Some(expected)) = (index, args["expectedRevision"].as_u64()) {
            if servers[i].revision != expected {
                return Ok(fail(
                    format!(
                        "MCP_CONFIG_CHANGED: {name} is at revision {}",
                        servers[i].revision
                    ),
                    json!({"via":"query","op":"mcp_tools","args":{"server":name}}),
                ));
            }
        }
        match (action, index) {
            ("add", Some(_)) => {
                return Ok(fail(
                    format!("MCP_SERVER_EXISTS: {name} is already in the hub"),
                    json!({"via":"act","op":"mcp_configure","args":{"action":"update","name":name}}),
                ))
            }
            ("add", None) => {
                let mut server: Server = serde_json::from_value(fields(args, json!({"name":name})))
                    .map_err(|_| "MCP_CONFIG_INVALID: Read the current mcp_configure schema")?;
                server.revision = 1;
                server.added_by = Some(attribution());
                validate(&server)?;
                servers.push(server.clone());
                store(&servers)?;
                (server, true)
            }
            (_, None) => {
                return Ok(fail(
                    format!("MCP_SERVER_UNKNOWN: No hub server named {name:?}"),
                    json!({"via":"query","op":"mcp_tools","args":{}}),
                ))
            }
            ("update", Some(i)) => {
                let mut base = serde_json::to_value(&servers[i]).unwrap();
                if args
                    .get("transport")
                    .is_some_and(|t| t != &base["transport"])
                {
                    for key in ["command", "args", "env", "cwd", "url", "headers"] {
                        base.as_object_mut().unwrap().remove(key);
                    }
                }
                let mut server: Server = serde_json::from_value(fields(args, base))
                    .map_err(|_| "MCP_CONFIG_INVALID: Read the current mcp_configure schema")?;
                server.revision += 1;
                validate(&server)?;
                servers[i] = server.clone();
                store(&servers)?;
                (server, true)
            }
            ("enable" | "disable", Some(i)) => {
                servers[i].enabled = action == "enable";
                servers[i].revision += 1;
                store(&servers)?;
                (servers[i].clone(), action == "enable")
            }
            ("remove", Some(i)) => {
                let server = servers.remove(i);
                store(&servers)?;
                drop(_guard);
                forget(&name).await;
                return Ok(json!({"removed":server.name,"observedAt":now()}));
            }
            _ => return Err(
                "INVALID_ARGUMENT: action must be add, update, remove, enable, disable or import"
                    .into(),
            ),
        }
    };
    if !connect {
        forget(&name).await;
        return Ok(json!({"server":status(&server, true)}));
    }
    // Verify immediately so the caller sees discovered tools or an actionable failure.
    let checked = ensure(&server, true).await;
    let mut value = json!({"server":status(&server, true)});
    if let Err(error) = checked {
        value["next"] = json!({"via":"act","op":"mcp_configure","args":{"action":"update","name":name},"hint":format!("Saved but not connected: {error}")});
    }
    Ok(value)
}
fn fields(args: &Value, mut base: Value) -> Value {
    for key in [
        "transport",
        "command",
        "args",
        "env",
        "cwd",
        "url",
        "headers",
        "toolTimeoutSeconds",
    ] {
        if let Some(value) = args.get(key) {
            base[key] = value.clone();
        }
    }
    base
}
fn attribution() -> Value {
    let origin = crate::kernel::origin::current_origin();
    json!({"kind":if origin["sourceId"].is_string() {"source"} else {"local"},
        "sourceId":origin["sourceId"],"sourceLabel":origin["sourceLabel"],"at":now()})
}

/// Copy servers from a native Agent profile. Existing hub names are never replaced.
async fn import(args: &Value) -> Result<Value> {
    let from = string(args, "from");
    let found = match native_profile(from) {
        Ok(found) => found,
        Err(error) => {
            return Ok(fail(
                error,
                json!({"via":"query","op":"guide","args":{"op":"mcp_configure"}}),
            ))
        }
    };
    let wanted: Option<Vec<&str>> = args["names"]
        .as_array()
        .map(|v| v.iter().filter_map(Value::as_str).collect());
    let mut imported = vec![];
    let mut skipped = vec![];
    {
        let _guard = lock().lock().map_err(|_| "MCP_HUB_BUSY")?;
        let mut servers = stored()?;
        for (native, candidate) in found {
            if wanted
                .as_ref()
                .is_some_and(|w| !w.contains(&native.as_str()))
            {
                continue;
            }
            let mut server = match candidate {
                Ok(server) => server,
                Err(reason) => {
                    skipped.push(json!({"name":native,"reason":reason}));
                    continue;
                }
            };
            server.name = sanitize(&native);
            if servers.iter().any(|s| s.name == server.name) {
                skipped.push(json!({"name":native,"reason":"A hub server with this name exists"}));
                continue;
            }
            server.revision = 1;
            server.added_by =
                Some(json!({"kind":"import","from":from,"by":attribution(),"at":now()}));
            if let Err(reason) = validate(&server) {
                skipped.push(json!({"name":native,"reason":reason}));
                continue;
            }
            imported.push(server.name.clone());
            servers.push(server);
        }
        store(&servers)?;
    }
    Ok(
        json!({"from":from,"imported":imported,"skipped":skipped,"observedAt":now(),
        "next":{"via":"query","op":"mcp_tools","args":{},"hint":"Listing connects imported servers and discovers their tools"}}),
    )
}
type Candidate = std::result::Result<Server, String>;
fn native_profile(from: &str) -> Result<Vec<(String, Candidate)>> {
    let home = dirs::home_dir().ok_or("MCP_IMPORT_UNAVAILABLE: Home directory unavailable")?;
    let read = |path: PathBuf| -> Result<String> {
        std::fs::read_to_string(&path)
            .map_err(|_| format!("MCP_IMPORT_NOT_FOUND: {} is not readable", path.display()))
    };
    if from == "codex" {
        let dir = crate::accounts::codex::default_home()?;
        let config: toml::Table = toml::from_str(&read(dir.join("config.toml"))?)
            .map_err(|_| "MCP_IMPORT_INVALID: config.toml is not valid TOML")?;
        let servers = config
            .get("mcp_servers")
            .and_then(|v| v.as_table())
            .cloned()
            .unwrap_or_default();
        return Ok(servers
            .into_iter()
            .map(|(name, value)| {
                let value = serde_json::to_value(value).unwrap_or_default();
                (name, codex_server(&value))
            })
            .collect());
    }
    let (path, key) = match from {
        "claude" => (
            std::env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or(home.clone())
                .join(".claude.json"),
            "mcpServers",
        ),
        "cursor" => (home.join(".cursor/mcp.json"), "mcpServers"),
        "gemini" => (home.join(".gemini/settings.json"), "mcpServers"),
        _ => return Err("INVALID_ARGUMENT: from must be codex, claude, cursor or gemini".into()),
    };
    let config: Value = serde_json::from_str(&read(path)?)
        .map_err(|_| "MCP_IMPORT_INVALID: The profile is not valid JSON")?;
    Ok(config[key]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(name, value)| (name.clone(), json_server(from, value)))
        .collect())
}
fn strings<T: serde::de::DeserializeOwned + Default>(value: &Value) -> T {
    serde_json::from_value(value.clone()).unwrap_or_default()
}
fn codex_server(value: &Value) -> Candidate {
    let mut headers: BTreeMap<String, String> = strings(&value["http_headers"]);
    if let Some(var) = value["bearer_token_env_var"].as_str() {
        let token = std::env::var(var).map_err(|_| format!("{var} is not set in ARC's environment; add an Authorization header with mcp_configure update"))?;
        headers.insert("Authorization".into(), format!("Bearer {token}"));
    }
    let env_headers: BTreeMap<String, String> = strings(&value["env_http_headers"]);
    for (header, var) in env_headers {
        let resolved = std::env::var(&var).map_err(|_| format!("{var} is not set in ARC's environment; add the {header} header with mcp_configure update"))?;
        headers.insert(header, resolved);
    }
    Ok(Server {
        transport: if value["url"].is_string() {
            "http"
        } else {
            "stdio"
        }
        .into(),
        command: string(value, "command").into(),
        args: strings(&value["args"]),
        env: strings(&value["env"]),
        cwd: value["cwd"].as_str().map(str::to_owned),
        url: string(value, "url").into(),
        headers,
        enabled: value["enabled"] != false,
        tool_timeout_seconds: value["tool_timeout_sec"]
            .as_f64()
            .map(|s| s.ceil().clamp(1.0, 600.0) as u64),
        ..Default::default()
    })
}
fn json_server(from: &str, value: &Value) -> Candidate {
    // Gemini uses url for legacy SSE and httpUrl for Streamable HTTP.
    let legacy = value["type"] == "sse" || (from == "gemini" && value["url"].is_string());
    if legacy {
        return Err(
            "Legacy SSE servers are not supported; add the server's Streamable HTTP endpoint"
                .into(),
        );
    }
    let url = value["httpUrl"]
        .as_str()
        .or(value["url"].as_str())
        .unwrap_or("");
    Ok(Server {
        transport: if url.is_empty() { "stdio" } else { "http" }.into(),
        command: string(value, "command").into(),
        args: strings(&value["args"]),
        env: strings(&value["env"]),
        cwd: value["cwd"].as_str().map(str::to_owned),
        url: url.into(),
        headers: strings(&value["headers"]),
        enabled: value["disabled"] != true,
        ..Default::default()
    })
}

/// Local management read for the desktop workspace. Starts no connection.
pub(crate) fn overview() -> Result<Value> {
    let servers = stored()?;
    Ok(
        json!({"enabled":enabled(),"servers":servers.iter().map(|s| status(s, true)).collect::<Vec<_>>(),"observedAt":now()}),
    )
}
pub(crate) fn operations() -> Vec<Value> {
    vec![
        json!({"name":"mcp-hub.list","method":"GET","route":"mcp-hub","localOnly":true,
            "description":"Read hub servers with observed state and tool names. Starts no connection.",
            "inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"mcp-hub.configure","method":"POST","route":"mcp-hub/configure","localOnly":true,
            "description":"Enable, disable, remove or refresh one hub server with local authority.",
            "inputSchema":{"type":"object","required":["body"],"additionalProperties":false,"properties":{"body":{"type":"object","required":["action","name"],"additionalProperties":false,
                "properties":{"action":{"enum":["enable","disable","remove","refresh"]},"name":{"type":"string"}}}}}}),
    ]
}
/// Local desktop actions reuse the source-facing owner.
pub(crate) async fn local(body: &Value) -> Result<Value> {
    if body["action"] == "refresh" {
        return tools(&json!({"server":body["name"],"refresh":true})).await;
    }
    configure(body).await
}
