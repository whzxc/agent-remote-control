//! Local Claude login profiles. Claude Code owns credentials and refreshes them in place.
use crate::*;
use serde::{Deserialize, Serialize};
use std::{ffi::OsString, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    sync::mpsc,
};
mod browsers;
pub(crate) mod routing;
mod system;
mod visibility;
pub use system::same_identity;
pub(crate) use visibility::candidates;

const OPENED_URL: &str = "ARC_CLAUDE_LOGIN_URL_FILE";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    id: String,
    identity: Value,
    observed_at: Option<String>,
    #[serde(default)]
    imported: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: String,
    account_id: String,
    browser_id: String,
    browser_name: String,
    state: String,
    login_url: Option<String>,
    browser_error: Option<String>,
    error: Option<String>,
}

struct Login {
    progress: Arc<Mutex<Progress>>,
    input: mpsc::Sender<String>,
    cancel: Option<tokio::sync::oneshot::Sender<()>>,
    job: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
pub(crate) struct Manager {
    // Serialize account mutations and logins. Separate profiles remain signed in concurrently.
    login: Mutex<Option<Login>>,
}

fn directory() -> PathBuf {
    root().join("claude-accounts")
}

pub(crate) fn observations() -> Result<Vec<Value>> {
    Ok(list_accounts()?
        .into_iter()
        .map(|a| json!({"profileId":a.id,"identity":a.identity,"observedAt":a.observed_at}))
        .collect())
}

/// Each transcript directory carries its native login/profile provenance.
/// A missing identity still permits transcript reads, with no account attribution.
pub(crate) fn transcript_roots() -> Vec<(PathBuf, Option<String>)> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let custom = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|value| !value.is_empty());
    let config = custom
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"));
    let metadata = if custom.is_some() {
        config.join(".claude.json")
    } else {
        home.join(".claude.json")
    };
    let rows = super::read().unwrap_or_default();
    let login: Value = crate::kernel::file_cache::load(&metadata).unwrap_or(Value::Null);
    let account = super::claude_transcript_account(&rows, &login["oauthAccount"]);
    let mut roots = vec![(config.join("projects"), account)];
    for profile in list_accounts().unwrap_or_default() {
        let Ok(config) = config_dir(&profile.id) else {
            continue;
        };
        let path = config.join("projects");
        let account = super::profile_account(&profile.id)
            .ok()
            .and_then(|row| row["id"].as_str().map(str::to_owned));
        if let Some(existing) = roots.iter_mut().find(|(root, _)| *root == path) {
            existing.1 = account;
        } else {
            roots.push((path, account));
        }
    }
    roots
}

pub(crate) async fn refresh_profile(id: &str) -> Result<Value> {
    let mut account = read_account(id)?;
    match account_identity(id).await {
        Ok(identity) => account.identity = identity,
        Err(error) => {
            account.identity["statusError"] = json!(error);
            account.observed_at = Some(now());
            save_account(&account)?;
            return Err(error);
        }
    }
    account.observed_at = Some(now());
    save_account(&account)?;
    Ok(account.identity)
}
fn account_dir(id: &str) -> Result<PathBuf> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("INVALID_CLAUDE_ACCOUNT: Select an account from accounts.list".into());
    }
    Ok(directory().join(id))
}
fn read_account(id: &str) -> Result<Account> {
    let account: Account = serde_json::from_value(load(&account_dir(id)?.join("account.json"))?)
        .map_err(|_| "INVALID_CLAUDE_ACCOUNT: Could not read this account")?;
    if account.id != id {
        return Err("INVALID_CLAUDE_ACCOUNT: Account identity mismatch".into());
    }
    Ok(account)
}
fn save_account(account: &Account) -> Result<()> {
    save(
        &account_dir(&account.id)?.join("account.json"),
        &json!(account),
    )
}
fn list_accounts() -> Result<Vec<Account>> {
    let path = directory();
    if !path.exists() {
        return Ok(vec![]);
    }
    let mut accounts = Vec::new();
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if uuid::Uuid::parse_str(&name).is_ok() && entry.path().join("account.json").exists() {
            accounts.push(read_account(&name)?);
        }
    }
    accounts.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(accounts)
}

/// Only allowlisted non-secret identity is visible to control sources.
pub(crate) fn profiles() -> Result<Vec<Value>> {
    Ok(list_accounts()?
        .into_iter()
        .filter(|a| crate::accounts::profile_account(&a.id).is_ok())
        .map(|a| json!({"accountId":a.id,"identity":safe_identity(&a.identity)}))
        .collect())
}
/// Remove inherited authentication and provider overrides only in ARC's CLI child.
pub fn isolated_environment(
    env: Vec<(OsString, OsString)>,
    config: Option<&Path>,
) -> Vec<(OsString, OsString)> {
    let blocked = [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_CUSTOM_HEADERS",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
        "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_SECURESTORAGE_CONFIG_DIR",
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_USE_GATEWAY",
        "CLAUDE_CODE_HOST_CREDS_FILE",
        "BROWSER",
        OPENED_URL,
    ];
    let host_config: Vec<_> = env
        .iter()
        .filter(|(key, _)| {
            config.is_none()
                && ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"]
                    .iter()
                    .any(|name| key.to_string_lossy().eq_ignore_ascii_case(name))
        })
        .cloned()
        .collect();
    let mut env: Vec<_> = env
        .into_iter()
        .filter(|(key, _)| {
            !blocked
                .iter()
                .any(|item| key.to_string_lossy().eq_ignore_ascii_case(item))
        })
        .collect();
    if let Some(config) = config {
        env.push(("CLAUDE_CONFIG_DIR".into(), config.as_os_str().to_owned()));
    } else {
        env.extend(host_config);
    }
    env
}

async fn cli(config: &Path) -> Result<tokio::process::Command> {
    command_for(Some(config)).await
}

async fn command_for(config: Option<&Path>) -> Result<tokio::process::Command> {
    let binary = crate::agents::driver::discover("claude")
        .ok_or("CLAUDE_NOT_FOUND: Install Claude Code before signing in")?;
    let mut cmd = command(binary);
    cmd.env_clear()
        .envs(isolated_environment(std::env::vars_os().collect(), config));
    if let Some(config) = config {
        cmd.current_dir(config);
    }
    cmd.env(
        "PATH",
        std::env::join_paths(crate::agents::driver::search_paths()).map_err(|e| e.to_string())?,
    );
    let mut settings = json!({"proxyMode":"system","proxyUrl":""});
    if let Ok(stored) = load(&root().join("app/preferences.json")) {
        for key in ["proxyMode", "proxyUrl"] {
            if let Some(value) = stored.get(key) {
                settings[key] = value.clone();
            }
        }
    }
    crate::proxy::NetworkProxy::resolve(&settings)
        .await?
        .apply(&mut cmd);
    Ok(cmd)
}

pub(crate) fn config_dir(account_id: &str) -> Result<PathBuf> {
    read_account(account_id).map_err(|_| "CLAUDE_ACCOUNT_NOT_FOUND: The assigned profile is missing or unreadable. Select an existing accountId with notify_control action:route for this source-owned target, or edit the host assignment in Accounts; ARC will not use another account automatically".to_owned())?;
    Ok(account_dir(account_id)?.join("config"))
}

pub(crate) async fn account_command(account_id: &str) -> Result<tokio::process::Command> {
    cli(&config_dir(account_id)?).await
}

pub(crate) async fn account_identity(account_id: &str) -> Result<Value> {
    identity_from_command(account_command(account_id).await?).await
}

fn safe_identity(value: &Value) -> Value {
    let mut result = json!({});
    if let Some(logged_in) = value["loggedIn"].as_bool() {
        result["loggedIn"] = json!(logged_in);
    }
    for key in [
        "authMethod",
        "email",
        "accountId",
        "orgId",
        "orgName",
        "subscriptionType",
    ] {
        if let Some(text) = value[key].as_str() {
            result[key] = json!(text.chars().take(320).collect::<String>());
        }
    }
    result
}

async fn identity(config: &Path) -> Result<Value> {
    identity_from_command(cli(config).await?).await
}

async fn identity_from_command(mut cmd: tokio::process::Command) -> Result<Value> {
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        cmd.args(["auth", "status", "--json"])
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "CLAUDE_STATUS_TIMEOUT: Retry checking this account")?
    .map_err(|_| "CLAUDE_STATUS_FAILED: Could not run Claude Code")?;
    let value: Value=serde_json::from_slice(&result.stdout).map_err(|_|"CLAUDE_STATUS_FAILED: Claude Code returned no authentication status; check its installation")?;
    if !value["loggedIn"].is_boolean() {
        return Err("CLAUDE_STATUS_FAILED: Claude Code returned an unsupported status".into());
    }
    Ok(safe_identity(&value))
}

/// Accept official authorization destinations without exposing their query values.
pub fn authorization_url(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    (url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(
            (url.host_str(), url.path()),
            (Some("claude.com"), "/cai/oauth/authorize")
                | (
                    Some("claude.ai" | "console.anthropic.com" | "platform.claude.com"),
                    "/oauth/authorize"
                )
        ))
    .then(|| url.to_string())
}

/// Claude Code invokes this executable as BROWSER. Capture only its official authorization URL.
pub fn capture_browser_url(args: &[String]) -> Option<Result<()>> {
    let path = std::env::var_os(OPENED_URL)?;
    Some((|| {
        if args.len() != 1 {
            return Err("INVALID_CLAUDE_LOGIN_URL".into());
        }
        let url = authorization_url(&args[0]).ok_or("INVALID_CLAUDE_LOGIN_URL")?;
        save_bytes(Path::new(&path), url.as_bytes())
    })())
}

pub(crate) async fn open_login_url(browser_id: &str, url: &str) -> Result<()> {
    if browser_id == "default" {
        return browsers::open(None, url).await;
    }
    let browser = browsers::discover()
        .await?
        .into_iter()
        .find(|b| b.id == browser_id)
        .ok_or("BROWSER_NOT_FOUND")?;
    browsers::open(Some(&browser), url).await
}

async fn read_login_output(reader: impl tokio::io::AsyncRead + Unpin, urls: mpsc::Sender<String>) {
    let mut reader = BufReader::new(reader);
    // Only URLs are retained. CLI output can contain authorization codes and must not enter logs.
    let pattern = regex::Regex::new(r#"https://[^\s\x1b<>\"']+"#).unwrap();
    loop {
        let Ok(bytes) = crate::line(&mut reader, 64 * 1024).await else {
            break;
        };
        if bytes.is_empty() {
            break;
        }
        for found in pattern.find_iter(&String::from_utf8_lossy(&bytes)) {
            if let Some(url) = authorization_url(found.as_str()) {
                let _ = urls.send(url).await;
            }
        }
    }
}

impl Manager {
    pub async fn stop(&self) {
        let mut current = self.login.lock().await;
        if let Some(login) = current.as_mut() {
            if let Some(cancel) = login.cancel.take() {
                let _ = cancel.send(());
            }
            let _ = (&mut login.job).await;
        }
    }

    pub async fn request(&self, route: &str, method: &str, body: Value) -> Result<Value> {
        if route == "profiles/system" && method == "GET" {
            return system::status().await;
        }
        if route == "profiles/routes" && method == "GET" {
            return Ok(json!({"routes":routing::list()?}));
        }
        if route == "profiles/routes" && method == "PUT" {
            return routing::bind(string(&body, "target"), string(&body, "accountId"), true).await;
        }
        if route == "profiles/browsers" && method == "GET" {
            return Ok(json!({"browsers":browsers::discover().await?}));
        }
        if route == "profiles/send" && method == "POST" {
            return crate::claude_notify::send_account_notification(&body).await;
        }
        let mut current = self.login.lock().await;
        if route == "profiles/import-system" && method == "POST" {
            if current.as_ref().is_some_and(|l| !l.job.is_finished()) {
                return Err(
                    "CLAUDE_LOGIN_IN_PROGRESS: Complete or cancel the current login first".into(),
                );
            }
            return system::import().await;
        }
        if route == "profiles" && method == "GET" {
            return Ok(
                json!({"accounts":list_accounts()?,"cliAvailable":crate::agents::driver::discover("claude").is_some(),
                "login":match current.as_ref() {Some(login)=>json!(*login.progress.lock().await),None=>Value::Null}}),
            );
        }
        if route == "profiles/login" && method == "POST" {
            if current.as_ref().is_some_and(|l| !l.job.is_finished()) {
                return Err(
                    "CLAUDE_LOGIN_IN_PROGRESS: Complete or cancel the current login first".into(),
                );
            }
            let browser_id = body["browserId"].as_str().unwrap_or("default");
            let browser = if browser_id == "default" {
                None
            } else {
                Some(browsers::discover().await?.into_iter().find(|b|b.id==browser_id).ok_or("BROWSER_NOT_FOUND: Refresh the browser list and choose an installed browser")?)
            };
            let mut account = if let Some(id) = body["accountId"].as_str() {
                read_account(id)?
            } else {
                Account {
                    id: id(),
                    identity: json!({}),
                    observed_at: None,
                    imported: false,
                }
            };
            let config = account_dir(&account.id)?.join("config");
            private_dir(&config)?;
            if account.imported {
                // Official login can revoke the previous grant. Detach the imported copy first.
                system::remove_credentials(&config).await?;
                account.identity = json!({"loggedIn":false});
                account.observed_at = Some(now());
            }
            save_account(&account)?;
            let mut cmd = cli(&config).await?;
            let opened = config.join(".arc-login-url");
            let _ = std::fs::remove_file(&opened);
            cmd.args(["auth", "login", "--claudeai"])
                .env("BROWSER", crate::runtime::binary()?)
                .env(OPENED_URL, &opened)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let child = cmd
                .spawn()
                .map_err(|_| "CLAUDE_LOGIN_START_FAILED: Could not start Claude Code login")?;
            let progress = Arc::new(Mutex::new(Progress {
                id: id(),
                account_id: account.id.clone(),
                browser_id: browser_id.to_owned(),
                browser_name: browser
                    .as_ref()
                    .map(|b| b.name.clone())
                    .unwrap_or_else(|| "System default browser".into()),
                state: "starting".into(),
                login_url: None,
                browser_error: None,
                error: None,
            }));
            let (input_tx, input_rx) = mpsc::channel(4);
            let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
            let view = progress.clone();
            let job = tokio::spawn(async move {
                let result = run_login(
                    child,
                    &config,
                    &opened,
                    browser,
                    view.clone(),
                    input_rx,
                    cancel_rx,
                )
                .await;
                let _ = std::fs::remove_file(opened);
                let mut view = view.lock().await;
                view.login_url = None;
                match result {
                    Ok(identity) => {
                        let account = Account {
                            identity,
                            observed_at: Some(now()),
                            imported: false,
                            ..account
                        };
                        match save_account(&account) {
                            Ok(()) => view.state = "completed".into(),
                            Err(error) => {
                                view.state = "failed".into();
                                view.error = Some(error);
                            }
                        }
                    }
                    Err(error) => {
                        view.state = if error == "CLAUDE_LOGIN_CANCELLED" {
                            "cancelled"
                        } else {
                            "failed"
                        }
                        .into();
                        view.error = Some(error);
                    }
                }
            });
            let result = json!(*progress.lock().await);
            *current = Some(Login {
                progress,
                input: input_tx,
                cancel: Some(cancel_tx),
                job,
            });
            return Ok(result);
        }
        if route == "profiles/login/code" && method == "POST" {
            let login = current.as_ref().ok_or("CLAUDE_LOGIN_NOT_ACTIVE")?;
            let progress = login.progress.lock().await;
            if body["loginId"] != progress.id || login.job.is_finished() {
                return Err("CLAUDE_LOGIN_NOT_ACTIVE: Start a new login".into());
            }
            let code = string(&body, "code").trim();
            if code.is_empty()
                || code.len() > 4096
                || code.chars().any(char::is_control)
                || code.contains("://")
            {
                return Err(
                    "INVALID_AUTHORIZATION_CODE: Paste the code shown by Claude, not a URL".into(),
                );
            }
            login
                .input
                .try_send(code.to_owned())
                .map_err(|_| "CLAUDE_LOGIN_BUSY: Wait for Claude Code before submitting again")?;
            return Ok(json!({"submitted":true}));
        }
        if route == "profiles/login/cancel" && method == "POST" {
            let login = current.as_mut().ok_or("CLAUDE_LOGIN_NOT_ACTIVE")?;
            if body["loginId"] != login.progress.lock().await.id {
                return Err("CLAUDE_LOGIN_NOT_ACTIVE".into());
            }
            if let Some(cancel) = login.cancel.take() {
                let _ = cancel.send(());
            }
            let _ = (&mut login.job).await;
            return Ok(json!(*login.progress.lock().await));
        }
        if let Some(tail) = route.strip_prefix("profiles/") {
            let (id, action) = tail.split_once('/').unwrap_or((tail, ""));
            let mut account = read_account(id)?;
            if current.as_ref().is_some_and(|l| !l.job.is_finished()) {
                return Err(
                    "CLAUDE_LOGIN_IN_PROGRESS: Complete or cancel the current login first".into(),
                );
            }
            let config = account_dir(id)?.join("config");
            if action == "refresh" && method == "POST" {
                account.identity = identity(&config).await?;
                account.observed_at = Some(now());
                save_account(&account)?;
                return Ok(json!(account));
            }
            if action.is_empty() && method == "DELETE" {
                if account.imported {
                    // A copied refresh token belongs to the original system authorization too.
                    system::remove_credentials(&config).await?;
                } else {
                    let mut cmd = cli(&config).await?;
                    let result = tokio::time::timeout(
                        Duration::from_secs(20),
                        cmd.args(["auth", "logout"]).stdin(Stdio::null()).output(),
                    )
                    .await
                    .map_err(|_| "CLAUDE_LOGOUT_TIMEOUT: Retry removing this account")?
                    .map_err(|_| "CLAUDE_LOGOUT_FAILED: Could not run Claude Code logout")?;
                    if !result.status.success() {
                        return Err(
                            "CLAUDE_LOGOUT_FAILED: Account retained; retry removing it".into()
                        );
                    }
                }
                std::fs::remove_dir_all(account_dir(id)?).map_err(|e| e.to_string())?;
                if let Some(login) = current.as_ref() {
                    if login.progress.lock().await.account_id == id {
                        *current = None;
                    }
                }
                return Ok(json!({"removed":true}));
            }
        }
        Err("UNKNOWN_ROUTE".into())
    }
}

async fn run_login(
    mut child: tokio::process::Child,
    config: &Path,
    opened: &Path,
    browser: Option<browsers::Browser>,
    progress: Arc<Mutex<Progress>>,
    mut input: mpsc::Receiver<String>,
    mut cancel: tokio::sync::oneshot::Receiver<()>,
) -> Result<Value> {
    let mut stdin = child.stdin.take().ok_or("CLAUDE_LOGIN_START_FAILED")?;
    let (url_tx, mut urls) = mpsc::channel(8);
    let mut readers = tokio::task::JoinSet::new();
    readers.spawn(read_login_output(
        child.stdout.take().unwrap(),
        url_tx.clone(),
    ));
    readers.spawn(read_login_output(child.stderr.take().unwrap(), url_tx));
    let deadline = tokio::time::sleep(Duration::from_secs(600));
    tokio::pin!(deadline);
    let mut tick = tokio::time::interval(Duration::from_millis(200));
    let mut did_open = false;
    let started = tokio::time::Instant::now();
    let mut fallback = None;
    loop {
        let url = tokio::select! {
            _=&mut cancel=>{let _=child.kill().await;return Err("CLAUDE_LOGIN_CANCELLED".into());},
            _=&mut deadline=>{let _=child.kill().await;return Err("CLAUDE_LOGIN_TIMEOUT: Start a new login and complete authorization within ten minutes".into());},
            status=child.wait()=>{
                if !status.map_err(|_|"CLAUDE_LOGIN_FAILED")?.success() {return Err("CLAUDE_LOGIN_FAILED: Claude Code could not complete authorization. Retry login and check the network settings".into());}
                let identity=identity(config).await?;
                if identity["loggedIn"]!=true || identity["authMethod"]!="claude.ai" {return Err("CLAUDE_LOGIN_UNCONFIRMED: Claude Code did not confirm a Claude account login; retry".into());}
                return Ok(identity);
            },
            Some(code)=input.recv()=>{stdin.write_all(format!("{code}\n").as_bytes()).await.map_err(|_|"CLAUDE_LOGIN_INPUT_FAILED: Start a new login")?;None},
            Some(url)=urls.recv(), if !did_open=>{fallback=Some((url,tokio::time::Instant::now()));None},
            _=tick.tick()=>{
                if !did_open && started.elapsed()>Duration::from_secs(45) {
                    let _=child.kill().await;
                    return Err("CLAUDE_LOGIN_NO_URL: Claude Code returned no supported authorization URL. Check the network and Claude Code installation, then retry login".into());
                }
                if did_open {None} else {
                    std::fs::read_to_string(opened).ok().and_then(|s|authorization_url(&s))
                        .or_else(||fallback.as_ref().filter(|(_,at)|at.elapsed()>=Duration::from_secs(3)).map(|(url,_)|url.clone()))
                }
            }
        };
        if let Some(url) = url.filter(|_| !did_open) {
            did_open = true;
            {
                let mut view = progress.lock().await;
                view.state = "waiting".into();
                view.login_url = Some(url.clone());
            }
            if let Err(error) = browsers::open(browser.as_ref(), &url).await {
                progress.lock().await.browser_error = Some(error);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_claude_authorization_destination_is_supported() {
        // Regression: Claude Code 2.1.310 login stayed in starting because claude.com/cai/oauth/authorize was rejected.
        assert!(authorization_url(
            "https://claude.com/cai/oauth/authorize?client_id=fixture&state=fixture"
        )
        .is_some());
    }
    #[test]
    fn authorization_links_cannot_open_unrelated_destinations() {
        // Property: authorization links require an official host, HTTPS, the authorization path, and no URL credentials.
        for url in [
            "https://claude.com.example.org/cai/oauth/authorize",
            "http://claude.com/cai/oauth/authorize",
            "https://user@claude.com/cai/oauth/authorize",
            "https://claude.com:444/cai/oauth/authorize",
            "https://claude.com/other",
        ] {
            assert!(authorization_url(url).is_none());
        }
    }
    #[test]
    fn host_keychain_namespace_is_preserved() {
        // Regression: Explicitly setting ~/.claude for the default account selected a different macOS Keychain entry and reported signed out.
        let original = vec![(OsString::from("PATH"), OsString::from("tools"))];
        assert_eq!(isolated_environment(original.clone(), None), original);
        let configured = vec![
            ("CLAUDE_CONFIG_DIR".into(), "custom".into()),
            ("CLAUDE_SECURESTORAGE_CONFIG_DIR".into(), "vault".into()),
        ];
        assert_eq!(isolated_environment(configured.clone(), None), configured);
        assert_eq!(
            isolated_environment(configured, Some(Path::new("profile"))),
            vec![("CLAUDE_CONFIG_DIR".into(), "profile".into())]
        );
    }
    #[test]
    fn child_environment_keeps_profiles_separate() {
        // Property: each child has exactly one explicit profile and no inherited authentication override.
        let env = vec![
            ("CLAUDE_CONFIG_DIR".into(), "old".into()),
            ("claude_config_dir".into(), "other".into()),
            ("ANTHROPIC_API_KEY".into(), "secret".into()),
            ("CLAUDE_CODE_USE_VERTEX".into(), "1".into()),
            ("CLAUDE_CODE_HOST_CREDS_FILE".into(), "other-account".into()),
            ("CLAUDE_CODE_USE_GATEWAY".into(), "1".into()),
            ("PATH".into(), "tools".into()),
        ];
        for profile in [Path::new("/profiles/a"), Path::new("/profiles/b")] {
            let actual = isolated_environment(env.clone(), Some(profile));
            assert_eq!(
                actual,
                vec![
                    (OsString::from("PATH"), OsString::from("tools")),
                    (
                        OsString::from("CLAUDE_CONFIG_DIR"),
                        profile.as_os_str().to_owned()
                    )
                ]
            );
        }
    }
}
