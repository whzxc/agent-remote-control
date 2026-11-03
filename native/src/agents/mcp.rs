//! Device-owned ACP MCP servers. Secrets stay in local configuration.
use crate::*;
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    #[serde(default)]
    mcp_servers: Vec<Server>,
    include_context_provider: Option<bool>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Server {
    name: String,
    command: PathBuf,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

pub(super) fn servers(task: &Value) -> Result<(Vec<Value>, Value)> {
    let agent = string(task, "agent");
    let assigned = crate::mcp_services::assigned(agent)?;
    crate::mcp_services::native_conflict(
        agent,
        Path::new(string(task, "cwd")),
        task["agentProfileId"].as_str(),
        &assigned,
    )?;
    let original = crate::mcp_services::legacy()?;
    for service in &assigned {
        if let Some(source) = &service.source {
            let current = original[string(source, "agent")]["mcpServers"]
                .as_array()
                .and_then(|rows| rows.iter().find(|s| s["name"] == source["name"]));
            if current != source.get("configuration") {
                return Err("MCP_SOURCE_CHANGED: The adopted ACP entry changed externally. Remove its experimental overlay and adopt the current entry again".into());
            }
        }
    }
    let mut configs: BTreeMap<String, Config> =
        serde_json::from_value(original).map_err(|e| format!("INVALID_AGENT_MCP: {e}"))?;
    let config = configs.remove(agent).unwrap_or_default();
    let mut names = HashSet::new();
    let mut servers = Vec::new();
    for server in config.mcp_servers {
        if assigned.iter().any(|s| {
            s.source
                .as_ref()
                .is_some_and(|source| source["agent"] == agent && source["name"] == server.name)
        }) {
            continue;
        }
        if server.name.trim().is_empty()
            || !names.insert(server.name.clone())
            || !server.command.is_absolute()
        {
            return Err("INVALID_AGENT_MCP: unique names and absolute commands required".into());
        }
        servers.push(json!({"name":server.name,"command":server.command,"args":server.args,
            "env":server.env.into_iter().map(|(name,value)| json!({"name":name,"value":value})).collect::<Vec<_>>()}));
    }
    if config.include_context_provider.unwrap_or(true) {
        if let Some(server) = crate::context_provider::acp_server()? {
            if !names.insert("context-provider".into()) {
                return Err("INVALID_AGENT_MCP: context-provider is reserved while includeContextProvider is enabled".into());
            }
            servers.push(server);
        }
    }
    for service in &assigned {
        if !names.insert(service.name.clone()) {
            return Err(format!("MCP_NAME_CONFLICT: {} is already owned by the ACP configuration; explicitly adopt that entry or change the assignment",service.name));
        }
        servers.push(crate::mcp_services::mount(service)?);
    }
    let applied = json!({"scope":"process","appliedAt":now(),"experimentalEnabledAtStart":crate::mcp_services::enabled(),
        "services":assigned.iter().map(|s| json!({"id":s.id,"name":s.name,"transport":s.transport,"revision":s.revision,
            "delivery":if s.transport=="http" {"rust-http-stdio"} else {"stdio"}})).collect::<Vec<_>>(),
        "changesApplyTo":"new-acp-processes-and-supported-session-loads"});
    Ok((servers, applied))
}
