//! Independent Codex credentials with shared native session storage.
pub(crate) use super::codex_config::{inspect_profile, shared_configuration};
use super::*;
use crate::owned_children::SpawnOwned;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::{process::Stdio, time::Duration};
use tokio::io::AsyncWriteExt;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Profile {
    pub id: String,
    pub refresh_owner: String,
    pub account_id: Option<String>,
    pub refresh_command: Option<RefreshCommand>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefreshCommand {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
}
fn directory() -> PathBuf {
    root().join("accounts/codex/profiles")
}
fn profile_path(id: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(id)
        .map_err(|_| "CODEX_PROFILE_INVALID: Read accounts for a valid profile")?;
    Ok(directory().join(id).join("profile.json"))
}
/// Credential helpers have a private CODEX_HOME; inheriting it must never
/// redirect a Core or execution process away from native session storage.
pub fn primary_home(
    configured: Option<&Path>,
    profiles: &Path,
    user_home: Option<&Path>,
) -> Option<PathBuf> {
    let managed = configured
        .and_then(|home| {
            let container = home.parent()?.parent()?;
            let managed_container = container == profiles
                || container.ends_with(Path::new("accounts").join("codex").join("profiles"));
            managed_container
                .then(|| home.strip_prefix(container).ok())
                .flatten()
        })
        .is_some_and(|relative| {
            let mut components = relative.components();
            let profile = components.next().and_then(|part| part.as_os_str().to_str());
            profile.is_some_and(|profile| uuid::Uuid::parse_str(profile).is_ok())
                && components
                    .next()
                    .is_some_and(|part| part.as_os_str() == "home")
                && components.next().is_none()
        });
    configured
        .filter(|_| !managed)
        .map(Path::to_path_buf)
        .or_else(|| user_home.map(|home| home.join(".codex")))
}
pub(crate) fn default_home() -> Result<PathBuf> {
    let configured = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .map(|path| path.canonicalize().unwrap_or(path));
    let profiles = directory();
    let profiles = profiles.canonicalize().unwrap_or(profiles);
    primary_home(
        configured.as_deref(),
        &profiles,
        dirs::home_dir().as_deref(),
    )
    .ok_or_else(|| "CODEX_HOME_UNAVAILABLE".into())
}
pub(crate) fn credential_home(id: &str) -> Result<PathBuf> {
    if id == "codex-home" {
        return default_home();
    }
    Ok(profile_path(id)?.parent().unwrap().join("home"))
}
pub(crate) fn profile(id: &str) -> Result<Profile> {
    serde_json::from_value(load(&profile_path(id)?)?)
        .map_err(|_| "CODEX_PROFILE_INVALID: Reimport this account".into())
}
pub(crate) fn profiles() -> Result<Vec<Profile>> {
    if !directory().exists() {
        return Ok(vec![]);
    }
    std::fs::read_dir(directory())
        .map_err(|e| e.to_string())?
        .map(|entry| {
            profile(
                &entry
                    .map_err(|e| e.to_string())?
                    .file_name()
                    .to_string_lossy(),
            )
        })
        .collect()
}
pub(crate) fn thread_profile(thread: &str) -> Result<String> {
    uuid::Uuid::parse_str(thread).map_err(|_| "INVALID_THREAD_ID")?;
    let path = root().join("execution").join(format!("{thread}.json"));
    if !path.exists() {
        return Ok("codex-home".into());
    }
    Ok(load(&path)?["agentProfileId"]
        .as_str()
        .unwrap_or("codex-home")
        .to_owned())
}
pub(crate) fn thread_home(thread: &str) -> Result<PathBuf> {
    let _ = thread_profile(thread)?;
    default_home()
}
/// Read only an explicit binding; an absent binding does not prove codex-home.
pub(crate) fn bound_account(thread: &str) -> Value {
    if uuid::Uuid::parse_str(thread).is_err() {
        return Value::Null;
    }
    let binding =
        load(&root().join("execution").join(format!("{thread}.json"))).unwrap_or(Value::Null);
    binding["agentProfileId"]
        .as_str()
        .and_then(|profile| super::profile_account(profile).ok())
        .map(|account| account["id"].clone())
        .unwrap_or_else(|| binding["agentAccountId"].clone())
}
pub(crate) fn observe_native_thread(
    thread: &str,
    creator: Option<&str>,
    parent: Option<&str>,
) -> Result<Value> {
    let bound = bound_account(thread);
    if !bound.is_null() {
        return Ok(bound);
    }
    let selected = if let Some(creator) = creator {
        profiles()?
            .into_iter()
            .find(|p| p.account_id.as_deref() == Some(creator))
            .map(|p| p.id)
    } else {
        None
    }
    .or_else(|| {
        parent.and_then(|id| {
            load(&root().join("execution").join(format!("{id}.json"))).ok()?["agentProfileId"]
                .as_str()
                .map(str::to_owned)
        })
    });
    if let Some(profile) = selected {
        observe_thread(&profile, thread)?;
        return Ok(if profile == "codex-home" {
            super::profile_account(&profile)
                .map(|a| a["id"].clone())
                .unwrap_or(Value::Null)
        } else {
            bound_account(thread)
        });
    }
    if parent.is_some() {
        return Ok(Value::Null);
    }
    Ok(super::profile_account("codex-home")
        .map(|a| a["id"].clone())
        .unwrap_or(Value::Null))
}
pub(crate) fn observe_history(thread: &Value) -> Result<Value> {
    let bound = bound_account(string(thread, "id"));
    if !bound.is_null() {
        return Ok(bound);
    }
    if !profiles()?.is_empty() {
        use std::io::{BufRead, Read};
        if let Ok(file) = crate::control::open_persisted_history(thread) {
            let mut header = String::new();
            let _ = std::io::BufReader::new(file.take(65536)).read_line(&mut header);
            if let Ok(meta) = serde_json::from_str::<Value>(&header) {
                let payload = &meta["payload"];
                let parent = payload["source"]["subagent"]["thread_spawn"]["parent_thread_id"]
                    .as_str()
                    .or_else(|| {
                        (payload["attached_thread"] == true)
                            .then(|| payload["forked_from_id"].as_str())
                            .flatten()
                    });
                return observe_native_thread(
                    string(thread, "id"),
                    payload["creator_account_id"].as_str(),
                    parent,
                );
            }
        }
    }
    observe_native_thread(string(thread, "id"), None, None)
}
/// Native child threads can be discovered without a thread/started notification.
pub(crate) fn observe_thread(profile: &str, thread: &str) -> Result<()> {
    if profile == "codex-home" {
        return Ok(());
    }
    uuid::Uuid::parse_str(thread).map_err(|_| "INVALID_THREAD_ID")?;
    let account = super::read()?
        .into_iter()
        .find(|a| super::profiles(a).any(|p| p["profileId"] == profile))
        .ok_or("ACCOUNT_PROFILE_NOT_FOUND")?;
    let path = root().join("execution").join(format!("{thread}.json"));
    let previous = if path.exists() {
        load(&path)?
    } else {
        json!({})
    };
    if previous["agentProfileId"]
        .as_str()
        .is_some_and(|p| p != profile)
    {
        return Err("CODEX_THREAD_PROFILE_MISMATCH: Inspect this thread's native home before changing its account binding".into());
    }
    let mut binding = previous.clone();
    binding["owner"] = json!("connector");
    binding["agentProfileId"] = json!(profile);
    binding["agentAccountId"] = account["id"].clone();
    if binding != previous {
        save(&path, &binding)?;
    }
    Ok(())
}
fn persist(profile: &Profile) -> Result<()> {
    private_dir(&credential_home(&profile.id)?)?;
    save(&profile_path(&profile.id)?, &json!(profile))
}
pub(crate) fn new_login() -> Result<Profile> {
    let p = Profile {
        id: id(),
        refresh_owner: "codex".into(),
        account_id: None,
        refresh_command: None,
    };
    persist(&p)?;
    Ok(p)
}
pub(super) async fn discard_login(control: &control::Control, profile: &str) -> Result<()> {
    control.close_profile(profile).await;
    let path = profile_path(profile)?;
    std::fs::remove_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())
}

pub(super) async fn finish_reauth(
    control: &control::Control,
    staging: &str,
    target: &str,
    account: &Value,
    native: &Value,
) -> Result<String> {
    let auth = load(&credential_home(staging)?.join("auth.json"))?;
    let mut facts = credential_facts(&auth);
    for (key, value) in native.as_object().into_iter().flatten() {
        if !value.is_null() {
            facts[key] = value.clone();
        }
    }
    confirm_reauth(account, "openai", &facts)?;
    if control.profile_running(target).await {
        return Err(
            "CODEX_PROFILE_IN_USE: Finish this profile's active tasks before reauthentication"
                .into(),
        );
    }
    control.close_profile(target).await;
    save(&credential_home(target)?.join("auth.json"), &auth)?;
    observe_profile(target, &facts, "signed-in")
}

fn claims(token: &Value) -> Value {
    token
        .as_str()
        .and_then(|t| t.split('.').nth(1))
        .and_then(|p| URL_SAFE_NO_PAD.decode(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}
pub(crate) fn credential_facts(auth: &Value) -> Value {
    let access = claims(&auth["tokens"]["access_token"]);
    let identity = claims(&auth["tokens"]["id_token"]);
    let namespace = "https://api.openai.com/auth";
    json!({"accountId":auth["tokens"]["account_id"].as_str().or(access[namespace]["chatgpt_account_id"].as_str()).or(identity[namespace]["chatgpt_account_id"].as_str()),
        "email":identity["email"].as_str().or(access["https://api.openai.com/profile"]["email"].as_str()).or(access["email"].as_str()),
        "planType":access[namespace]["chatgpt_plan_type"].as_str().or(identity[namespace]["chatgpt_plan_type"].as_str())})
}
pub(crate) fn observe_profile(profile: &str, facts: &Value, state: &str) -> Result<String> {
    let mut p = if profile == "codex-home" {
        None
    } else {
        Some(super::codex::profile(profile)?)
    };
    let mut combined = load(&credential_home(profile)?.join("auth.json"))
        .map(|auth| credential_facts(&auth))
        .unwrap_or(json!({}));
    for (key, value) in facts.as_object().into_iter().flatten() {
        if !value.is_null() {
            combined[key] = value.clone();
        }
    }
    if let (Some(p), Some(account_id)) = (p.as_mut(), combined["accountId"].as_str()) {
        p.account_id = Some(account_id.into());
        persist(p)?;
    }
    let refresh_owner = p
        .as_ref()
        .map(|p| p.refresh_owner.as_str())
        .unwrap_or("codex");
    let facts = &combined;
    change(|rows| {
        let account = observe(
            rows,
            "openai",
            facts,
            profile,
            Some(
                json!({"agent":"codex","profileId":profile,"kind":"codex-home","state":state,"default":false,"refreshOwner":refresh_owner}),
            ),
            None,
        );
        // Dispatch defaults are preserved. Secondary credentials never replace codex-home.
        Ok(account)
    })
}
pub(super) async fn import(control: &control::Control, args: &Value) -> Result<Value> {
    let owner = string(args, "refreshOwner");
    if !matches!(owner, "codex" | "external" | "none") {
        return Err("CODEX_REFRESH_OWNER_REQUIRED: Choose codex, external or none".into());
    }
    let mut auth = args["auth"].clone();
    let access = string(&auth["tokens"], "access_token");
    if access.is_empty() {
        return Err("CODEX_AUTH_INVALID: Import native auth.json with tokens.access_token".into());
    }
    if owner == "codex" && string(&auth["tokens"], "refresh_token").is_empty() {
        return Err(
            "CODEX_REFRESH_TOKEN_REQUIRED: Supply a refresh token or choose external or none"
                .into(),
        );
    }
    let command: Option<RefreshCommand> = args
        .get("refreshCommand")
        .map(|v| serde_json::from_value(v.clone()).map_err(|_| "CODEX_REFRESH_COMMAND_INVALID"))
        .transpose()?;
    if owner == "external" && command.is_none() {
        return Err("CODEX_REFRESH_COMMAND_REQUIRED: Configure a local refresh command for externally managed credentials".into());
    }
    if owner != "external" && command.is_some() {
        return Err(
            "CODEX_REFRESH_COMMAND_INVALID: A refresh command requires external ownership".into(),
        );
    }
    if let Some(command) = &command {
        if !Path::new(&command.program).is_absolute() {
            return Err("CODEX_REFRESH_COMMAND_INVALID: Use an absolute executable path and an argument array".into());
        }
        let origin = crate::kernel::origin::current_origin();
        if !matches!(origin["ingressId"].as_str(), Some("local-cli" | "local-ui")) {
            return Err("CODEX_REFRESH_COMMAND_LOCAL_ONLY: Configure executable refresh hooks through the local CLI or panel".into());
        }
    }
    let facts = credential_facts(&auth);
    let account_id = facts["accountId"].as_str().map(str::to_owned);
    if owner != "codex" && account_id.is_none() {
        return Err("CODEX_ACCOUNT_ID_REQUIRED: Supply tokens.account_id or a token with ChatGPT account claims".into());
    }
    let existing = if let Some(id) = args["accountId"].as_str() {
        let account = resolve(id)?;
        confirm_reauth(&account, "openai", &facts)?;
        let target = super::profiles(&account)
            .find(|p| p["agent"] == "codex" && p["profileId"] != "codex-home")
            .ok_or("ACCOUNT_AGENT_MISSING: Select a managed Codex account")?;
        Some(profile(string(target, "profileId"))?)
    } else {
        profiles()?.into_iter().find(|p| {
            p.account_id.is_some() && p.account_id == account_id && profile_account(&p.id).is_ok()
        })
    };
    let pid = existing.as_ref().map(|p| p.id.clone()).unwrap_or_else(id);
    if existing.is_some() && control.profile_running(&pid).await {
        return Err("CODEX_PROFILE_IN_USE: Finish this profile's active tasks before replacing its credentials".into());
    }
    if owner != "codex" {
        auth["tokens"]["refresh_token"] = Value::Null;
    }
    let p = Profile {
        id: pid,
        refresh_owner: owner.into(),
        account_id,
        refresh_command: command,
    };
    control.close_profile(&p.id).await;
    persist(&p)?;
    if owner == "codex" {
        save(&credential_home(&p.id)?.join("auth.json"), &auth)?;
        let access_path = profile_path(&p.id)?.parent().unwrap().join("access.json");
        if access_path.exists() {
            std::fs::remove_file(access_path).map_err(|e| e.to_string())?;
        }
    } else {
        let tokens = json!({"accessToken":auth["tokens"]["access_token"],"chatgptAccountId":facts["accountId"],"chatgptPlanType":facts["planType"]});
        save(
            &profile_path(&p.id)?.parent().unwrap().join("access.json"),
            &tokens,
        )?;
        let auth_path = credential_home(&p.id)?.join("auth.json");
        if auth_path.exists() {
            std::fs::remove_file(auth_path).map_err(|e| e.to_string())?;
        }
    }
    let native = control
        .profile_rpc(&p.id)
        .await?
        .call("account/read", json!({"refreshToken":false}), 10000)
        .await?;
    let mut facts = facts;
    if let Some(native) = native["account"].as_object() {
        for (key, value) in native {
            if !value.is_null() {
                facts[key] = value.clone();
            }
        }
    } else {
        return Err(
            "CODEX_LOGIN_UNCONFIRMED: Native Codex did not confirm this imported login".into(),
        );
    }
    let account = observe_profile(&p.id, &facts, "signed-in")?;
    if let Some(alias) = args.get("alias") {
        update(&json!({"id":account,"alias":alias}))?;
    }
    Ok(json!({"state":"completed","accountId":account,"profileId":p.id,"refreshOwner":owner}))
}
/// Refresh commands receive a JSON request on stdin and return one access-token JSON object.
/// They own their upstream authentication and credentials. ARC never invokes a shell.
async fn refresh_command(p: &Profile, request: &Value) -> Result<Value> {
    let hook = p
        .refresh_command
        .as_ref()
        .ok_or("CODEX_REAUTH_REQUIRED: Reimport credentials for this account")?;
    let mut child = command(&hook.program)
        .args(&hook.args)
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn_owned()
        .map_err(|_| "CODEX_REFRESH_COMMAND_FAILED: Check the configured executable")?;
    child
        .stdin
        .take()
        .ok_or("CODEX_REFRESH_COMMAND_FAILED")?
        .write_all(format!("{}\n", request).as_bytes())
        .await
        .map_err(|_| "CODEX_REFRESH_COMMAND_FAILED")?;
    let result = tokio::time::timeout(Duration::from_secs(8), child.wait_with_output())
        .await
        .map_err(|_| {
            "CODEX_REFRESH_COMMAND_TIMEOUT: Inspect the external credential manager before retrying"
        })?
        .map_err(|_| "CODEX_REFRESH_COMMAND_FAILED")?;
    if !result.status.success() || result.stdout.len() > 1024 * 1024 {
        return Err("CODEX_REFRESH_COMMAND_FAILED: Check the external credential manager".into());
    }
    serde_json::from_slice(&result.stdout).map_err(|_|"CODEX_REFRESH_RESPONSE_INVALID: Return accessToken, chatgptAccountId and optional chatgptPlanType as JSON".into())
}
pub(crate) fn tokens<'a>(
    profile_id: &'a str,
    request: Option<&'a Value>,
    binary: &'a Path,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + 'a>> {
    Box::pin(async move {
        let p = profile(profile_id)?;
        let path = profile_path(profile_id)?
            .parent()
            .unwrap()
            .join("access.json");
        let tokens = if p.refresh_owner == "codex" {
            if request.is_some() {
                static REFRESH: std::sync::LazyLock<crate::kernel::receipts::RequestLocks> =
                    std::sync::LazyLock::new(Default::default);
                let _guard = REFRESH.lock(profile_id).await;
                // Only the native credential process owns refresh tokens. Execution
                // processes receive access tokens and share the primary session home.
                let rpc =
                    crate::rpc::Rpc::start_auth(binary, Default::default(), &id(), profile_id)
                        .await?;
                let refreshed = rpc
                    .call("account/read", json!({"refreshToken":true}), 15000)
                    .await;
                rpc.close().await;
                refreshed?;
            }
            let auth = load(&credential_home(profile_id)?.join("auth.json"))?;
            let facts = credential_facts(&auth);
            json!({"accessToken":auth["tokens"]["access_token"],"chatgptAccountId":facts["accountId"],"chatgptPlanType":facts["planType"]})
        } else if let Some(request) = request {
            if p.refresh_owner != "external" {
                return Err("CODEX_REAUTH_REQUIRED: Reimport this account's credentials; ARC does not own token refresh".into());
            }
            refresh_command(&p, request).await?
        } else {
            load(&path)?
        };
        if tokens["chatgptAccountId"].as_str() != p.account_id.as_deref()
            || string(&tokens, "accessToken").is_empty()
        {
            return Err("CODEX_REFRESH_IDENTITY_MISMATCH: The external refresh response must retain this profile's account".into());
        }
        let safe = json!({"accessToken":tokens["accessToken"],"chatgptAccountId":tokens["chatgptAccountId"],"chatgptPlanType":tokens["chatgptPlanType"]});
        if request.is_some() && p.refresh_owner == "external" {
            save(&path, &safe)?;
        }
        Ok(safe)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherited_managed_home_never_becomes_primary_configuration() {
        // Regression: ARC launched from a spare Codex task inherited its CODEX_HOME and treated that account as the shared source.
        let profiles = Path::new("/state/accounts/codex/profiles");
        let managed = profiles.join("00000000-0000-4000-8000-000000000001/home");
        let user = Path::new("/user");
        assert_eq!(
            primary_home(Some(&managed), profiles, Some(user)),
            Some(user.join(".codex"))
        );
        let other_instance = Path::new(
            "/other-state/accounts/codex/profiles/00000000-0000-4000-8000-000000000002/home",
        );
        assert_eq!(
            primary_home(Some(other_instance), profiles, Some(user)),
            Some(user.join(".codex"))
        );
        let custom = Path::new("/custom-codex");
        assert_eq!(
            primary_home(Some(custom), profiles, Some(user)),
            Some(custom.to_path_buf())
        );
        assert_eq!(
            primary_home(None, profiles, Some(user)),
            Some(user.join(".codex"))
        );
    }
}
