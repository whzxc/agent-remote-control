use super::*;
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, BufReader};
const NODE: &str = "v24.12.0";
const WRANGLER: &str = "4.151.3";
const SOURCE: &str = include_str!("../../../relay-worker/src/worker.ts");
const CONFIG: &str = include_str!("../../../relay-worker/wrangler.json");

struct ProcessTree(u32);
impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGTERM);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill.exe")
                .args(["/PID", &self.0.to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .output();
        }
    }
}
fn workspace(config: &Value) -> Result<PathBuf> {
    Ok(directory(string(config, "id"))?.join("deployment"))
}
async fn proxy() -> Result<crate::proxy::NetworkProxy> {
    crate::proxy::NetworkProxy::resolve_relay(
        &load(&root().join("app/preferences.json"))
            .unwrap_or_else(|_| crate::ingress::config::defaults()),
    )
    .await
}
async fn run_command(
    command: tokio::process::Command,
    status: &Mutex<Value>,
    login: bool,
    open_browser: bool,
) -> Result<String> {
    run_command_until(
        command,
        status,
        login,
        open_browser,
        Duration::from_secs(300),
    )
    .await
}
async fn run_command_until(
    mut command: tokio::process::Command,
    status: &Mutex<Value>,
    login: bool,
    open_browser: bool,
    timeout: Duration,
) -> Result<String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| {
        "Cannot start the managed deployment tool; check filesystem permissions and system tar availability."
    })?;
    let mut tree = Some(ProcessTree(
        child.id().ok_or("Deployment process not running")?,
    ));
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut stderr = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut out_done = false;
    let mut err_done = false;
    let mut output = String::new();
    let mut exit = None;
    let deadline = tokio::time::sleep(timeout);
    let link_deadline = tokio::time::sleep(Duration::from_secs(30).min(timeout));
    tokio::pin!(deadline);
    tokio::pin!(link_deadline);
    let mut link_received = false;
    while exit.is_none() || !out_done || !err_done {
        let line = tokio::select! {
            _ = &mut deadline => return Err(if login { "Cloudflare login timed out after 5 minutes; retry and complete authorization in the browser" } else { "Deployment step timed out; check network and Cloudflare account access" }.into()),
            _ = &mut link_deadline, if login && !link_received && exit.is_none() => return Err("Wrangler did not provide a Cloudflare login link within 30 seconds; check proxy and retry".into()),
            result = child.wait(), if exit.is_none() => {
                exit = Some(result.map_err(|_| "Cannot read deployment process status")?);
                // Reap promptly, even when a descendant inherited an output pipe.
                drop(tree.take());
                None
            },
            line = stdout.next_line(), if !out_done => match line.map_err(|_| "Cannot read deployment stdout")? { Some(line) => Some(line), None => {out_done=true;None} },
            line = stderr.next_line(), if !err_done => match line.map_err(|_| "Cannot read deployment stderr")? { Some(line) => Some(line), None => {err_done=true;None} },
        };
        if let Some(line) = line {
            if login {
                if let Some(url) = login_url(&line) {
                    let mut state = status.lock().await;
                    let first = state["loginUrl"].is_null();
                    state["loginUrl"] = json!(url);
                    link_received = true;
                    drop(state);
                    if first && open_browser {
                        open(&url).await;
                    }
                }
            }
            if output.len() < 256 * 1024 {
                output.push_str(&line);
                output.push('\n');
            }
        }
    }
    let exit = exit.ok_or("Deployment process status missing")?;
    if !exit.success() {
        if serde_json::from_str::<Value>(output.trim())
            .ok()
            .is_some_and(|v| v["loggedIn"] == false)
        {
            return Err("WRANGLER_LOGIN_REQUIRED".into());
        }
        let reason = if output.contains("EADDRINUSE") {
            "Cloudflare login callback port is already in use; close the other Wrangler login and retry"
        } else if output.contains("account") {
            "Check Cloudflare account selection and Workers permissions"
        } else if output.contains("ENOTFOUND")
            || output.contains("fetch failed")
            || output.contains("ECONN")
        {
            "Cannot reach Cloudflare; check the system or HTTPS_PROXY proxy"
        } else {
            "Check the managed deployment tools, Cloudflare authorization and Worker deployment permissions"
        };
        return Err(format!("Deployment tool exited with {exit}. {reason}."));
    }
    Ok(output)
}
fn login_url(line: &str) -> Option<String> {
    line.split_whitespace().find_map(|word| {
        let url = reqwest::Url::parse(word).ok()?;
        (url.scheme() == "https"
            && url.host_str() == Some("dash.cloudflare.com")
            && url.path() == "/oauth2/auth")
            .then(|| url.to_string())
    })
}
async fn open(url: &str) {
    #[cfg(target_os = "macos")]
    let mut cmd = command("/usr/bin/open");
    #[cfg(target_os = "linux")]
    let mut cmd = command("xdg-open");
    #[cfg(windows)]
    let mut cmd = {
        let mut cmd = command("rundll32.exe");
        cmd.arg("url.dll,FileProtocolHandler");
        cmd
    };
    cmd.arg(url).stdout(Stdio::null()).stderr(Stdio::null());
    let _ = tokio::time::timeout(Duration::from_secs(5), cmd.output()).await;
}
fn node_dir() -> PathBuf {
    root().join("dependencies/relay-deploy-node").join(NODE)
}
fn node_binary() -> PathBuf {
    node_dir().join(if cfg!(windows) {
        "node.exe"
    } else {
        "bin/node"
    })
}
fn node_command() -> Result<tokio::process::Command> {
    let binary = node_binary();
    let mut cmd = command(&binary);
    let mut paths = vec![binary.parent().unwrap().to_path_buf()];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    cmd.env(
        "PATH",
        std::env::join_paths(paths).map_err(|_| "Invalid deployment PATH")?,
    );
    Ok(cmd)
}
// Node is a managed deployment tool only. Normal relay connections are entirely native.
async fn ensure_node(status: &Mutex<Value>) -> Result<()> {
    if node_dir().join("ready").is_file() {
        return Ok(());
    }
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    let extension = if cfg!(windows) { "zip" } else { "tar.gz" };
    let name = format!("node-{NODE}-{platform}-{arch}.{extension}");
    let client = proxy()
        .await?
        .client(reqwest::Client::builder())
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let base = format!("https://nodejs.org/dist/{NODE}");
    let sums = client
        .get(format!("{base}/SHASUMS256.txt"))
        .send()
        .await
        .map_err(|_| "Cannot download Node.js checksums; check proxy")?
        .error_for_status()
        .map_err(|_| "Node.js checksums unavailable")?
        .text()
        .await
        .map_err(|_| "Cannot read Node.js checksums")?;
    let expected = sums
        .lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            (parts.next()? == name).then_some(hash)
        })
        .ok_or("Node.js package checksum missing")?;
    private_dir(&node_dir())?;
    let archive = node_dir().join(format!("download.{extension}"));
    let mut response = client
        .get(format!("{base}/{name}"))
        .send()
        .await
        .map_err(|_| "Cannot download deployment runtime; check proxy")?
        .error_for_status()
        .map_err(|_| "Deployment runtime package unavailable")?;
    let mut file = tokio::fs::File::create(&archive)
        .await
        .map_err(|e| e.to_string())?;
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;
    let mut digest = Sha256::new();
    let mut size = 0;
    while let Some(bytes) = response
        .chunk()
        .await
        .map_err(|_| "Deployment runtime download interrupted")?
    {
        size += bytes.len();
        if size > 120 * 1024 * 1024 {
            return Err("Deployment runtime download exceeded limit".into());
        }
        digest.update(&bytes);
        file.write_all(&bytes).await.map_err(|e| e.to_string())?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if crate::hex_encode(&digest.finalize()) != expected {
        return Err("Deployment runtime SHA256 mismatch".into());
    }
    let mut extract = command(if cfg!(windows) { "tar.exe" } else { "tar" });
    extract
        .arg("-xf")
        .arg(&archive)
        .arg("--strip-components=1")
        .arg("-C")
        .arg(node_dir());
    run_command(extract, status, false, false).await?;
    if !node_binary().is_file() {
        return Err("Deployment runtime extraction failed".into());
    }
    std::fs::remove_file(archive).map_err(|e| e.to_string())?;
    save_bytes(&node_dir().join("ready"), NODE.as_bytes())
}

async fn tool(config: &Value, status: &Mutex<Value>) -> Result<PathBuf> {
    ensure_node(status).await?;
    let install = root().join("dependencies/wrangler").join(WRANGLER);
    let script = install.join("node_modules/wrangler/bin/wrangler.js");
    if !install.join("ready").exists() {
        private_dir(&install)?;
        let mut cmd = node_command()?;
        cmd.arg(node_dir().join(if cfg!(windows) {
            "node_modules/npm/bin/npm-cli.js"
        } else {
            "lib/node_modules/npm/bin/npm-cli.js"
        }));
        proxy().await?.apply(&mut cmd);
        cmd.args(["install", "--prefix"]).arg(&install).args([
            "--no-audit",
            "--no-fund",
            "--save-exact",
            &format!("wrangler@{WRANGLER}"),
        ]);
        run_command(cmd, status, false, false).await?;
        save_bytes(&install.join("ready"), WRANGLER.as_bytes())?;
    }
    let dir = workspace(config)?;
    private_dir(&dir)?;
    save_bytes(&dir.join("worker.ts"), SOURCE.as_bytes())?;
    let mut wrangler: Value = serde_json::from_str(CONFIG).map_err(|e| e.to_string())?;
    wrangler["name"] = config["workerName"].clone();
    wrangler["main"] = json!("worker.ts");
    wrangler["vars"]["ARC_VERSION"] = json!(env!("ARC_BUILD_VERSION"));
    if let Some(account) = config.get("accountId") {
        wrangler["account_id"] = account.clone();
    }
    save(&dir.join("wrangler.json"), &wrangler)?;
    Ok(script)
}
async fn wrangler(
    script: &Path,
    dir: &Path,
    args: &[&str],
    status: &Mutex<Value>,
    open_browser: bool,
) -> Result<String> {
    let mut cmd = node_command()?;
    proxy().await?.apply(&mut cmd);
    // Wrangler owns its OAuth credentials; don't silently switch to shell API-token authority.
    for name in [
        "CLOUDFLARE_API_TOKEN",
        "CF_API_TOKEN",
        "CLOUDFLARE_API_KEY",
        "CF_API_KEY",
        "CLOUDFLARE_ACCOUNT_ID",
        "CF_ACCOUNT_ID",
    ] {
        cmd.env_remove(name);
    }
    cmd.env("WRANGLER_SEND_METRICS", "false")
        .env("NO_COLOR", "1")
        .env("CI", "true");
    cmd.arg(script).args(args).current_dir(dir);
    run_command(cmd, status, args.first() == Some(&"login"), open_browser).await
}
async fn ensure_subdomain(
    script: &Path,
    dir: &Path,
    account: &str,
    relay_id: &str,
    status: &Mutex<Value>,
) -> Result<String> {
    // Wrangler owns login/refresh/storage. The access token is used only in memory here.
    let credentials: Value = serde_json::from_str(
        &wrangler(script, dir, &["auth", "token", "--json"], status, false).await?,
    )
    .map_err(|_| "Cannot obtain Wrangler OAuth authorization")?;
    if credentials["type"] != "oauth" {
        return Err("Wrangler browser OAuth authorization is required".into());
    }
    let client = proxy()
        .await?
        .client(reqwest::Client::builder())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let endpoint =
        format!("https://api.cloudflare.com/client/v4/accounts/{account}/workers/subdomain");
    let response: Value = client
        .get(&endpoint)
        .bearer_auth(string(&credentials, "token"))
        .send()
        .await
        .map_err(|_| "Cannot read workers.dev registration; check proxy")?
        .json()
        .await
        .map_err(|_| "Invalid workers.dev response")?;
    if response["success"] == true {
        return response["result"]["subdomain"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "No workers.dev subdomain returned".into());
    }
    if !response["errors"]
        .as_array()
        .is_some_and(|errors| errors.iter().any(|e| e["code"] == 10007))
    {
        return Err(
            "Cannot read workers.dev registration; check Workers account permissions".into(),
        );
    }
    // Register only when Cloudflare explicitly reports absence; preserve existing account subdomains.
    let name = format!("arc-{}", relay_id.replace('-', ""));
    let response: Value = client
        .put(endpoint)
        .bearer_auth(string(&credentials, "token"))
        .json(&json!({"subdomain":name}))
        .send()
        .await
        .map_err(|_| "workers.dev registration interrupted; retry deployment")?
        .json()
        .await
        .map_err(|_| "Invalid workers.dev registration response")?;
    if response["success"] != true {
        return Err("Could not register a workers.dev subdomain; complete Workers onboarding in Cloudflare and redeploy".into());
    }
    response["result"]["subdomain"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "No workers.dev subdomain returned".into())
}

pub(super) async fn run(
    config: &Value,
    public_key: &str,
    status: &Mutex<Value>,
    open_browser: bool,
) -> Result<String> {
    step(status, "login").await;
    let script = tool(config, status).await?;
    let dir = workspace(config)?;
    let mut who = wrangler(&script, &dir, &["whoami", "--json"], status, false).await;
    if who
        .as_ref()
        .is_err_and(|error| error == "WRANGLER_LOGIN_REQUIRED")
    {
        // We open the printed link ourselves so lack of a browser does not kill the callback server.
        wrangler(
            &script,
            &dir,
            &["login", "--browser=false"],
            status,
            open_browser,
        )
        .await?;
        who = wrangler(&script, &dir, &["whoami", "--json"], status, false).await;
    }
    let who: Value =
        serde_json::from_str(&who?).map_err(|_| "Cannot read Wrangler account information")?;
    let accounts = who["accounts"]
        .as_array()
        .ok_or("No Cloudflare account available")?;
    let account = if let Some(id) = config["accountId"].as_str() {
        accounts
            .iter()
            .find(|a| a["id"] == id)
            .ok_or("Selected Cloudflare account is unavailable")?
    } else if accounts.len() == 1 {
        &accounts[0]
    } else {
        status.lock().await["accounts"] = json!(accounts);
        return Err("Select a Cloudflare accountId and call relay.redeploy".into());
    };
    step(status, "deploying").await;
    let subdomain = ensure_subdomain(
        &script,
        &dir,
        string(account, "id"),
        string(config, "id"),
        status,
    )
    .await?;
    let mut settings = load(&dir.join("wrangler.json"))?;
    settings["account_id"] = account["id"].clone();
    save(&dir.join("wrangler.json"), &settings)?;
    let mut saved = read(string(config, "id"))?;
    saved["accountId"] = account["id"].clone();
    saved["deploymentStarted"] = json!(true);
    save(
        &directory(string(config, "id"))?.join("config.json"),
        &saved,
    )?;
    status.lock().await["loginUrl"] = Value::Null;
    step(status, "deploying").await;
    // A single deployment installs the public management key atomically with the Worker.
    save(
        &dir.join("worker-secrets.json"),
        &json!({"MANAGEMENT_PUBLIC_KEY":public_key}),
    )?;
    let output = wrangler(
        &script,
        &dir,
        &["deploy", "--secrets-file", "worker-secrets.json"],
        status,
        false,
    )
    .await?;
    deployed_url(&output, string(config, "workerName")).or_else(|_| {
        identity::origin(&format!(
            "https://{}.{subdomain}.workers.dev",
            string(config, "workerName")
        ))
    })
}
fn deployed_url(output: &str, worker: &str) -> Result<String> {
    let pattern = regex::Regex::new(r"https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev").unwrap();
    let result = pattern.find_iter(output).map(|m|m.as_str()).find(|url|url.starts_with(&format!("https://{worker}.")))
        .map(str::to_owned).ok_or_else(|| "Deployment completed but no workers.dev address was returned; enable the account workers.dev subdomain and redeploy".into());
    result
}
pub(super) async fn delete(config: &Value, status: &Mutex<Value>) -> Result<()> {
    let script = tool(config, status).await?;
    wrangler(
        &script,
        &workspace(config)?,
        &["delete", "--force"],
        status,
        false,
    )
    .await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    fn script(source: &str) -> tokio::process::Command {
        let mut cmd = command("/bin/sh");
        cmd.args(["-c", source]);
        cmd
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn exited_children_are_reaped_without_waiting_for_the_deadline() {
        // Regression: 42f9056; exited children are reaped without waiting for the deadline.
        let state = Mutex::new(json!({}));
        let output = tokio::time::timeout(
            Duration::from_secs(2),
            run_command(
                script("printf stdout; printf stderr >&2"),
                &state,
                false,
                false,
            ),
        )
        .await
        .expect("EOF must end the output loop")
        .unwrap();
        assert!(output.contains("stdout") && output.contains("stderr"));
        let error = run_command(
            script("printf '{\"loggedIn\":false}'; exit 1"),
            &state,
            false,
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(error, "WRANGLER_LOGIN_REQUIRED");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn non_tty_login_exposes_link_and_reports_abnormal_exit() {
        // Regression: 42f9056; non tty login exposes link and reports abnormal exit.
        let state = Mutex::new(json!({"loginUrl":null}));
        let error = tokio::time::timeout(Duration::from_secs(2), run_command(
            script("test ! -t 0 && test ! -t 1 || exit 1; printf 'Visit this link to authenticate: https://dash.cloudflare.com/oauth2/auth?state=test'; exit 7"),
            &state, true, false,
        )).await.unwrap().unwrap_err();
        assert!(error.contains("7"), "{error}");
        assert_eq!(
            state.lock().await["loginUrl"],
            "https://dash.cloudflare.com/oauth2/auth?state=test"
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn silent_login_is_bounded_and_descendant_pipes_do_not_stall_exit() {
        // Regression: 42f9056; silent login is bounded and descendant pipes do not stall exit.
        let state = Mutex::new(json!({}));
        assert!(run_command_until(
            script("sleep 10"),
            &state,
            true,
            false,
            Duration::from_millis(30)
        )
        .await
        .is_err());
        tokio::time::timeout(
            Duration::from_secs(2),
            run_command(script("sleep 10 & exit 3"), &state, false, false),
        )
        .await
        .expect("inherited pipes must close")
        .unwrap_err();
    }
    #[test]
    fn extracts_only_cloudflare_login_and_exact_worker_address() {
        // Property: extracts only cloudflare login and exact worker address.
        assert!(login_url("Visit https://dash.cloudflare.com/oauth2/auth?state=test").is_some());
        assert!(login_url("https://evil.example/oauth2/auth").is_none());
        assert_eq!(
            deployed_url(
                "https://other.account.workers.dev\n https://arc-relay.account.workers.dev",
                "arc-relay"
            )
            .unwrap(),
            "https://arc-relay.account.workers.dev"
        );
        assert!(deployed_url("https://other.account.workers.dev", "arc-relay").is_err());
    }
}
