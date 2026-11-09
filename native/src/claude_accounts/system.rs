//! Import the system CLI login once into a normal, independently stored ARC profile.
use super::*;
#[cfg(target_os = "macos")]
use crate::owned_children::SpawnOwned;

fn marker() -> PathBuf {
    directory().join("system-import.json")
}

pub(super) fn initial_account() -> Result<String> {
    load(&marker()).map_err(|_| "CLAUDE_SYSTEM_IMPORT_REQUIRED: Import the system login in Accounts or assign this target with accounts.route")?["accountId"].as_str().map(str::to_owned)
        .ok_or_else(|| "CLAUDE_SYSTEM_IMPORT_REQUIRED: Import the system login in Accounts or assign this target with accounts.route".into())
}

pub(super) async fn status() -> Result<Value> {
    let identity = identity_from_command(command_for(None).await?).await?;
    let matched = list_accounts()?
        .into_iter()
        .find(|a| same_identity(&a.identity, &identity));
    Ok(json!({"identity":identity,"accountId":matched.map(|a|a.id),
        "initialized":marker().exists(),"observedAt":now()}))
}

/// Compare upstream identity, including organization, without treating two missing IDs as equal.
pub fn same_identity(left: &Value, right: &Value) -> bool {
    if left["loggedIn"] != true
        || right["loggedIn"] != true
        || left["authMethod"] != "claude.ai"
        || right["authMethod"] != "claude.ai"
    {
        return false;
    }
    let same_user = match (left["accountId"].as_str(), right["accountId"].as_str()) {
        (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() => a == b,
        _ => {
            matches!((left["email"].as_str(), right["email"].as_str()), (Some(a), Some(b)) if !a.is_empty() && a.eq_ignore_ascii_case(b))
        }
    };
    same_user && left["orgId"] == right["orgId"]
}

pub(super) async fn import() -> Result<Value> {
    // Manager's login lock serializes import, profile removal, and interactive login.
    let host = identity_from_command(command_for(None).await?).await?;
    if host["loggedIn"] != true || host["authMethod"] != "claude.ai" {
        return Err("CLAUDE_SYSTEM_LOGIN_REQUIRED: Sign in to a Claude account with the system CLI, then import it in Accounts".into());
    }
    for mut account in list_accounts()? {
        if !same_identity(&account.identity, &host) {
            continue;
        }
        let observed = identity(&account_dir(&account.id)?.join("config")).await?;
        if same_identity(&observed, &host) {
            account.identity = observed;
            account.observed_at = Some(now());
            save_account(&account)?;
            finish(&account.id).await?;
            return Ok(json!({"account":account,"identity":host}));
        }
    }
    let account_id = id();
    let config = account_dir(&account_id)?.join("config");
    private_dir(&config)?;
    let result = async {
        let source_config = host_config();
        let source_metadata = if std::env::var_os("CLAUDE_CONFIG_DIR").is_some_and(|v| !v.is_empty()) {
            source_config.join(".claude.json")
        } else {
            dirs::home_dir().ok_or("HOME_UNAVAILABLE")?.join(".claude.json")
        };
        // Copy only Claude account metadata, never projects, MCP credentials, hooks, or settings.
        let metadata = load(&source_metadata)?;
        let credentials = read_credentials().await?;
        save(&config.join(".claude.json"), &json!({"oauthAccount":metadata["oauthAccount"],"hasCompletedOnboarding":true}))?;
        write_credentials(&config, &credentials).await?;
        let observed = identity(&config).await?;
        if !same_identity(&observed, &host) {
            return Err("CLAUDE_IMPORT_UNCONFIRMED: The isolated CLI did not confirm the system identity. Refresh the system login and retry import".into());
        }
        let account = Account { id: account_id.clone(), identity: observed, observed_at: Some(now()), imported: true };
        save_account(&account)?;
        Ok(account)
    }.await;
    let account = match result {
        Ok(account) => account,
        Err(error) => {
            // Delete only the new local copy; never run logout against a shared OAuth grant.
            let _ = remove_credentials(&config).await;
            let _ = std::fs::remove_dir_all(account_dir(&account_id)?);
            return Err(error);
        }
    };
    finish(&account.id).await?;
    Ok(json!({"account":account,"identity":host}))
}

async fn finish(account_id: &str) -> Result<()> {
    // Pin the original default permanently. Later imports must not reroute existing targets.
    let pinned = if marker().exists() {
        initial_account()?
    } else {
        account_id.into()
    };
    routing::migrate_default(&pinned).await?;
    if !marker().exists() {
        save(&marker(), &json!({"accountId":pinned}))?;
    }
    Ok(())
}

fn host_config() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().expect("home directory").join(".claude"))
}

fn host_storage() -> PathBuf {
    match std::env::var_os("CLAUDE_SECURESTORAGE_CONFIG_DIR") {
        Some(value) if value.is_empty() => {
            dirs::home_dir().expect("home directory").join(".claude")
        }
        Some(value) => PathBuf::from(value),
        None => host_config(),
    }
}

async fn read_credentials() -> Result<Value> {
    read_credentials_at(None, &host_storage()).await
}

pub(super) async fn profile_credentials(config: &Path) -> Result<Value> {
    read_credentials_at(Some(config), config).await
}

async fn read_credentials_at(config: Option<&Path>, storage: &Path) -> Result<Value> {
    #[cfg(not(target_os = "macos"))]
    let _ = config;
    #[cfg(target_os = "macos")]
    let bytes = {
        let output = security(&[
            "find-generic-password",
            "-a",
            &username(),
            "-s",
            &service(config),
            "-w",
        ])
        .await?;
        if output.status.success() {
            output.stdout
        } else if output.status.code() == Some(44) {
            std::fs::read(storage.join(".credentials.json"))
                .map_err(|_| "CLAUDE_IMPORT_CREDENTIALS_UNAVAILABLE: Sign in with the system CLI and retry import")?
        } else {
            return Err(
                "CLAUDE_IMPORT_KEYCHAIN_UNAVAILABLE: Unlock the login Keychain and retry import"
                    .into(),
            );
        }
    };
    #[cfg(not(target_os = "macos"))]
    let bytes = std::fs::read(storage.join(".credentials.json")).map_err(|_| {
        "CLAUDE_IMPORT_CREDENTIALS_UNAVAILABLE: Sign in with the system CLI and retry import"
    })?;
    let stored: Value = serde_json::from_slice(&bytes).map_err(|_| {
        "CLAUDE_IMPORT_CREDENTIALS_INVALID: Re-login with the system CLI and retry import"
    })?;
    if !stored["claudeAiOauth"].is_object() {
        return Err("CLAUDE_IMPORT_CREDENTIALS_INVALID: No Claude account credential was found; sign in with the system CLI".into());
    }
    Ok(json!({"claudeAiOauth":stored["claudeAiOauth"]}))
}

pub(super) async fn install_reauth(destination: &Path, staging: &Path) -> Result<()> {
    let staged = load(&staging.join(".claude.json"))?;
    let path = destination.join(".claude.json");
    let mut metadata = if path.exists() {
        load(&path)?
    } else {
        json!({})
    };
    if !staged["oauthAccount"].is_object() || !metadata.is_object() {
        return Err(
            "CLAUDE_LOGIN_UNCONFIRMED: Claude Code did not provide account metadata".into(),
        );
    }
    let credentials = profile_credentials(staging).await?;
    metadata["oauthAccount"] = staged["oauthAccount"].clone();
    metadata["hasCompletedOnboarding"] = json!(true);
    save(&path, &metadata)?;
    write_credentials(destination, &credentials).await
}

async fn write_credentials(config: &Path, credentials: &Value) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        // Match Claude Code's stdin-based Keychain write: secrets never appear in argv or logs.
        let hex: String = serde_json::to_vec(credentials)
            .map_err(|_| "CLAUDE_IMPORT_FAILED")?
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let input = format!(
            "add-generic-password -U -a \"{}\" -s \"{}\" -X \"{hex}\"\n",
            username(),
            service(Some(config))
        );
        let mut child = command("/usr/bin/security")
            .arg("-i")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn_owned()
            .map_err(|_| "CLAUDE_IMPORT_FAILED: Could not open Keychain")?;
        let mut stdin = child.stdin.take().ok_or("CLAUDE_IMPORT_FAILED")?;
        let result = tokio::time::timeout(Duration::from_secs(20), async {
            stdin.write_all(input.as_bytes()).await?;
            drop(stdin);
            child.wait().await
        })
        .await
        .map_err(|_| "CLAUDE_IMPORT_TIMEOUT: Unlock Keychain and retry import")?
        .map_err(|_| "CLAUDE_IMPORT_FAILED: Could not store the isolated credential")?;
        if !result.success() {
            return Err("CLAUDE_IMPORT_FAILED: Keychain rejected the isolated credential; unlock it and retry import".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    save(&config.join(".credentials.json"), credentials)
}

pub(super) async fn remove_credentials(config: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let output = security(&[
            "delete-generic-password",
            "-a",
            &username(),
            "-s",
            &service(Some(config)),
        ])
        .await?;
        if !output.status.success() && output.status.code() != Some(44) {
            return Err("CLAUDE_IMPORT_CLEANUP_FAILED".into());
        }
    }
    match std::fs::remove_file(config.join(".credentials.json")) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(_) => {
            return Err(
                "CLAUDE_IMPORT_CLEANUP_FAILED: Could not remove the isolated credential file"
                    .into(),
            )
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn service(config: Option<&Path>) -> String {
    use unicode_normalization::UnicodeNormalization;
    let path = config.map(|p| p.as_os_str().to_owned()).or_else(|| {
        std::env::var_os("CLAUDE_SECURESTORAGE_CONFIG_DIR")
            .or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR"))
    });
    let suffix = path
        .filter(|p| !p.is_empty())
        .map(|p| {
            format!(
                "-{}",
                &hash(p.to_string_lossy().nfc().collect::<String>())[..8]
            )
        })
        .unwrap_or_default();
    format!("Claude Code-credentials{suffix}")
}

#[cfg(target_os = "macos")]
fn username() -> String {
    let user = std::env::var("USER")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| dirs::home_dir()?.file_name()?.to_str().map(str::to_owned))
        .unwrap_or_default();
    if !user.is_empty()
        && user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        user
    } else {
        "claude-code-user".into()
    }
}

#[cfg(target_os = "macos")]
async fn security(args: &[&str]) -> Result<std::process::Output> {
    tokio::time::timeout(
        Duration::from_secs(20),
        command("/usr/bin/security")
            .args(args)
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "CLAUDE_IMPORT_TIMEOUT: Unlock Keychain and retry import".to_owned())?
    .map_err(|_| "CLAUDE_IMPORT_FAILED: Could not access Keychain".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_marker_matches_identity_not_profile_origin() {
        // Property: system identity matching requires a signed-in Claude identity and the same organization.
        let a = json!({"loggedIn":true,"authMethod":"claude.ai","accountId":"account-a","email":"a@example.com","orgId":"org-a"});
        assert!(same_identity(&a, &a));
        assert!(!same_identity(&json!({}), &json!({})));
        for patch in [
            json!({"accountId":"account-b"}),
            json!({"orgId":"org-b"}),
            json!({"loggedIn":false}),
        ] {
            let mut b = a.clone();
            for (key, value) in patch.as_object().unwrap() {
                b[key] = value.clone();
            }
            assert!(!same_identity(&a, &b));
        }
    }
}
