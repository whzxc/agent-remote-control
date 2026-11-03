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

pub(super) fn servers(agent: &str) -> Result<Vec<Value>> {
    let path = root().join("agents/mcp.json");
    let mut configs: BTreeMap<String, Config> = if path.exists() {
        serde_json::from_value(load(&path)?).map_err(|e| format!("INVALID_AGENT_MCP: {e}"))?
    } else {
        BTreeMap::new()
    };
    let config = configs.remove(agent).unwrap_or_default();
    let mut names = HashSet::new();
    let mut servers = Vec::new();
    for server in config.mcp_servers {
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
    Ok(servers)
}
