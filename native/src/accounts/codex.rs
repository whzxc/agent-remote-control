//! Isolated native Codex accounts and provider-neutral imported credentials.
use super::*;
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
pub(crate) fn default_home() -> Result<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|p| p.join(".codex")))
        .ok_or_else(|| "CODEX_HOME_UNAVAILABLE".into())
}
pub(crate) fn home(id: &str) -> Result<PathBuf> {
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
    home(&thread_profile(thread)?)
}
fn persist(profile: &Profile) -> Result<()> {
    private_dir(&home(&profile.id)?)?;
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
    let mut combined = load(&home(profile)?.join("auth.json"))
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
        // Existing Agent defaults are preserved. An isolated profile never replaces codex-home.
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
    let existing = profiles()?
        .into_iter()
        .find(|p| p.account_id.is_some() && p.account_id == account_id);
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
        save(&home(&p.id)?.join("auth.json"), &auth)?;
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
        let auth_path = home(&p.id)?.join("auth.json");
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
        .spawn()
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
pub(crate) async fn tokens(profile_id: &str, request: Option<&Value>) -> Result<Value> {
    let p = profile(profile_id)?;
    let path = profile_path(profile_id)?
        .parent()
        .unwrap()
        .join("access.json");
    let tokens = if let Some(request) = request {
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
    if request.is_some() {
        save(&path, &safe)?;
    }
    Ok(safe)
}
