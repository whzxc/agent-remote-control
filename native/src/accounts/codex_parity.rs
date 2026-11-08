//! Codex configuration policy. Credentials and runtime state never leave a home.
use super::{
    codex,
    parity::{self, Entry, Policy},
};
use crate::*;

static SYNC: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// An allowlist makes new upstream identity/runtime files private by default.
/// Every primary-home entry passes through this exhaustive classification.
pub fn classify(name: &str) -> (&'static str, &'static str) {
    match name {
        "config.toml" => ("generated", "Shared settings with private identity and runtime paths removed"),
        "AGENTS.md" | "AGENTS.override.md" => ("shared", "Global model instructions"),
        "hooks.json" | "rules" => ("shared", "User hooks and execution policy"),
        "skills" | "agents" | "prompts" => ("shared", "User skills, agent roles and reusable prompts"),
        "themes" | "keybindings.json" => ("shared", "User interface configuration"),
        "plugins" => ("private", "Mixed directory: only installed plugins/cache assets are shared; data, staging and processes are private"),
        "auth.json" | ".credentials.json" | "installation_id" => ("private", "Account credentials or installation identity"),
        "sessions" | "archived_sessions" | "history.jsonl" | "session_index.jsonl" => ("private", "Account conversation history"),
        "sqlite" | "state" | "log" | "cache" | "tmp" | ".tmp" | "shell_snapshots" => ("private", "Account databases, logs, caches or execution state"),
        _ if name.ends_with(".config.toml") => ("generated", "Named configuration profile with the same private-key filter"),
        _ => ("private", "Unknown entries stay private; this also covers credentials, databases, locks, backups and runtime extensions"),
    }
}

fn entry(name: &str) -> Entry {
    match classify(name).0 {
        "shared" => Entry::Shared,
        "generated" => Entry::Generated,
        _ => Entry::Private,
    }
}

fn absolute(value: &mut toml::Value, source: &Path) {
    if let Some(path) = value.as_str() {
        if !Path::new(path).is_absolute() && !path.starts_with('~') {
            *value = toml::Value::String(source.join(path).to_string_lossy().into_owned());
        }
    }
}

/// Source wins in full. No local stopgap setting survives this projection.
/// Apply the same exclusions to inline profiles so selecting one cannot cross homes.
pub fn merge_config(mut config: toml::Table, source: &Path, target: &Path) -> toml::Table {
    for key in [
        "forced_chatgpt_workspace_id",
        "cli_auth_credentials_store",
        "mcp_oauth_credentials_store",
        "sqlite_home",
        "log_dir",
    ] {
        config.remove(key);
    }
    config.insert("cli_auth_credentials_store".into(), "file".into());
    config.insert("mcp_oauth_credentials_store".into(), "file".into());
    for key in [
        "model_instructions_file",
        "experimental_instructions_file",
        "model_catalog_json",
        "compact_prompt_file",
    ] {
        if let Some(value) = config.get_mut(key) {
            absolute(value, source);
        }
    }
    if let Some(agents) = config.get_mut("agents").and_then(toml::Value::as_table_mut) {
        for role in agents
            .iter_mut()
            .filter_map(|(_, value)| value.as_table_mut())
        {
            if let Some(path) = role.get_mut("config_file") {
                absolute(path, source);
            }
        }
    }
    if let Some(skills) = config
        .get_mut("skills")
        .and_then(|v| v.get_mut("config"))
        .and_then(toml::Value::as_array_mut)
    {
        for skill in skills {
            if let Some(path) = skill.get_mut("path") {
                absolute(path, source);
            }
        }
    }
    if let Some(marketplaces) = config
        .get_mut("marketplaces")
        .and_then(toml::Value::as_table_mut)
    {
        for marketplace in marketplaces.iter_mut().map(|(_, value)| value) {
            if marketplace.get("source_type").and_then(toml::Value::as_str) == Some("local") {
                if let Some(path) = marketplace.get_mut("source") {
                    absolute(path, source);
                }
            }
        }
    }
    // Native hook trust includes the hook filename. Preserve the source entry and
    // authorize the identical linked file under this home's native filename too.
    if let Some(state) = config
        .get_mut("hooks")
        .and_then(|v| v.get_mut("state"))
        .and_then(toml::Value::as_table_mut)
    {
        let prefix = source.join("hooks.json").to_string_lossy().into_owned();
        let replacement = target.join("hooks.json").to_string_lossy().into_owned();
        let aliases: Vec<_> = state
            .iter()
            .filter_map(|(key, value)| {
                key.strip_prefix(&prefix)
                    .map(|suffix| (format!("{replacement}{suffix}"), value.clone()))
            })
            .collect();
        state.extend(aliases);
    }
    if let Some(profiles) = config
        .get_mut("profiles")
        .and_then(toml::Value::as_table_mut)
    {
        for profile in profiles
            .iter_mut()
            .filter_map(|(_, value)| value.as_table_mut())
        {
            *profile = merge_config(std::mem::take(profile), source, target);
        }
    }
    config
}

fn generate(source: &Path, target: &Path, name: &str) -> Result<Vec<u8>> {
    let path = source.join(name);
    let config = if path.exists() {
        std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())?
            .parse::<toml::Table>()
            // TOML errors can quote credentials. Expose the filename without source text.
            .map_err(|_| format!("Invalid primary {name}; correct its TOML and retry"))?
    } else {
        toml::Table::new()
    };
    Ok(format!(
        "# Generated by ARC from the Agent primary home. Edit the primary configuration.\n{}",
        toml::to_string(&merge_config(config, source, target)).map_err(|e| e.to_string())?
    )
    .into_bytes())
}

fn policy() -> Policy {
    Policy {
        classify: entry,
        generate,
        dependencies,
        shared_parts: &["plugins/cache"],
    }
}

// Files referenced outside the standard home trees can also affect a cached
// App Server's model instructions and roles. Track those without scanning MCP
// executables or arbitrary project working directories.
fn dependencies(source: &Path) -> Result<Vec<PathBuf>> {
    fn collect(config: &toml::Table, base: &Path, paths: &mut Vec<PathBuf>) {
        let resolve = |s: &str| {
            if let Some(suffix) = s.strip_prefix("~/") {
                dirs::home_dir().unwrap_or_default().join(suffix)
            } else if Path::new(s).is_absolute() {
                PathBuf::from(s)
            } else {
                base.join(s)
            }
        };
        for key in [
            "model_instructions_file",
            "experimental_instructions_file",
            "model_catalog_json",
            "compact_prompt_file",
        ] {
            if let Some(path) = config.get(key).and_then(toml::Value::as_str) {
                paths.push(resolve(path));
            }
        }
        if let Some(agents) = config.get("agents").and_then(toml::Value::as_table) {
            for (_, agent) in agents {
                if let Some(path) = agent.get("config_file").and_then(toml::Value::as_str) {
                    paths.push(resolve(path));
                }
            }
        }
        if let Some(profiles) = config.get("profiles").and_then(toml::Value::as_table) {
            for (_, profile) in profiles {
                if let Some(profile) = profile.as_table() {
                    collect(profile, base, paths);
                }
            }
        }
    }
    let mut paths = vec![];
    if source.exists() {
        for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if super::codex_parity::entry(&name) == Entry::Generated {
                let config = std::fs::read_to_string(entry.path())
                    .map_err(|e| e.to_string())?
                    .parse::<toml::Table>()
                    .map_err(|_| format!("Invalid primary {name}; correct its TOML and retry"))?;
                collect(&config, source, &mut paths);
            }
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn paths(id: &str) -> Result<(PathBuf, PathBuf, PathBuf)> {
    let source = codex::default_home()?;
    let target = codex::home(id)?;
    if source == target
        || source.starts_with(&target)
        || target.starts_with(&source)
        || source
            .canonicalize()
            .ok()
            .zip(target.canonicalize().ok())
            .is_some_and(|(s, t)| s == t)
    {
        return Err("Primary and isolated Codex homes must differ".into());
    }
    let record = target
        .parent()
        .ok_or("Invalid account home")?
        .join("parity.json");
    Ok((source, target, record))
}

fn failure(error: &str) -> String {
    json!({"code":"CODEX_PROFILE_PARITY_FAILED","message":format!("{error}. Correct the primary Codex home and retry; query accounts reports agentProfiles.parity."),"next":{"via":"query","op":"guide","args":{"op":"accounts"}}}).to_string()
}

pub(crate) fn sync_profile(id: &str) -> Result<Value> {
    if id == "codex-home" {
        let fingerprint =
            parity::fingerprint(&policy(), &codex::default_home()?).map_err(|e| failure(&e))?;
        return Ok(json!({"state":"primary","lastSyncAt":null,"fingerprint":fingerprint}));
    }
    let _lock = SYNC.lock().map_err(|e| failure(&e.to_string()))?;
    let (source, target, record) = paths(id).map_err(|e| failure(&e))?;
    parity::sync(&policy(), &source, &target, &record).map_err(|e| failure(&e))
}

pub(crate) fn inspect_profile(id: &str) -> Value {
    if id == "codex-home" {
        return json!({"state":"primary","lastSyncAt":null});
    }
    let result = paths(id)
        .and_then(|(source, target, record)| parity::inspect(&policy(), &source, &target, &record));
    match result {
        Ok(mut record) => {
            record.as_object_mut().map(|r| r.remove("entries"));
            record
        }
        Err(error) => json!({"state":"error","error":failure(&error),"lastSyncAt":null}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_preserves_shared_policy_without_account_overrides() {
        // Regression: Spare Codex accounts prompted for every command and lacked global features.
        let source = std::env::temp_dir().join("primary");
        let target = std::env::temp_dir().join("profile");
        let mut input: toml::Table = r#"
approval_policy = "never"
sandbox_mode = "danger-full-access"
forced_chatgpt_workspace_id = "primary-account"
sqlite_home = "/primary/state"
log_dir = "/primary/log"
cli_auth_credentials_store = "keyring"
[features]
multi_agent = true
hooks = true
[agents]
max_concurrent_threads_per_session = 9
[mcp_servers.context]
command = "context-provider"
[projects."/workspace"]
trust_level = "trusted"
[hooks.state."/primary/hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:example"
"#
        .parse()
        .unwrap();
        let source_key = format!("{}:pre_tool_use:0:0", source.join("hooks.json").display());
        let target_key = format!("{}:pre_tool_use:0:0", target.join("hooks.json").display());
        let state = input
            .get_mut("hooks")
            .unwrap()
            .get_mut("state")
            .unwrap()
            .as_table_mut()
            .unwrap();
        let trust = state
            .remove("/primary/hooks.json:pre_tool_use:0:0")
            .unwrap();
        state.insert(source_key, trust);
        let output = merge_config(input.clone(), &source, &target);
        for key in [
            "approval_policy",
            "sandbox_mode",
            "features",
            "agents",
            "mcp_servers",
            "projects",
        ] {
            assert_eq!(output[key], input[key]);
        }
        for key in ["forced_chatgpt_workspace_id", "sqlite_home", "log_dir"] {
            assert!(!output.contains_key(key));
        }
        assert_eq!(output["cli_auth_credentials_store"].as_str(), Some("file"));
        assert_eq!(
            output["hooks"]["state"][&target_key]["trusted_hash"].as_str(),
            Some("sha256:example")
        );
    }

    #[test]
    fn unknown_entries_are_private_and_projection_is_idempotent() {
        // Property: Unknown home entries never cross accounts and merging twice preserves configuration.
        for name in [
            "auth.json",
            "auth.json.bak",
            ".credentials.json",
            "state_5.sqlite",
            "sessions",
            "unknown-future-entry",
            "plugins",
        ] {
            assert_eq!(classify(name).0, "private");
        }
        for name in ["AGENTS.md", "skills", "agents", "rules", "hooks.json"] {
            assert_eq!(classify(name).0, "shared");
        }
        let config: toml::Table = "approval_policy='never'\n[profiles.work]\nsqlite_home='/private'\n[agents.worker]\nconfig_file='agents/worker.toml'".parse().unwrap();
        let source = std::env::temp_dir().join("primary");
        let target = std::env::temp_dir().join("account");
        let first = merge_config(config, &source, &target);
        assert_eq!(merge_config(first.clone(), &source, &target), first);
        assert!(first["profiles"]["work"].get("sqlite_home").is_none());
        assert_eq!(
            first["agents"]["worker"]["config_file"].as_str(),
            source.join("agents/worker.toml").to_str()
        );
    }
}
