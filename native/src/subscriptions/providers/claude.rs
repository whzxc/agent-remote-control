use super::*;
pub async fn credential() -> std::result::Result<Credential, Failure> {
    #[cfg(target_os = "macos")]
    let v = {
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            crate::command("/usr/bin/security")
                .args([
                    "find-generic-password",
                    "-s",
                    "Claude Code-credentials",
                    "-w",
                ])
                .output(),
        )
        .await
        .map_err(|_| Failure::from("credential-access-denied"))?
        .map_err(|_| Failure::from("credential-access-denied"))?;
        if result.status.success() {
            serde_json::from_slice::<Value>(&result.stdout)
                .map_err(|_| Failure::from("invalid-response"))?
        } else if result.status.code() == Some(44) {
            // CLI file is the same login source when no Keychain item exists.
            // Access denial/timeout does not fall through to another source.
            file(
                &std::env::var_os("CLAUDE_CONFIG_DIR")
                    .map(PathBuf::from)
                    .unwrap_or(home()?.join(".claude"))
                    .join(".credentials.json"),
            )?
        } else {
            return Err("credential-access-denied".into());
        }
    };
    #[cfg(not(target_os = "macos"))]
    let v = file(
        &std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or(home()?.join(".claude"))
            .join(".credentials.json"),
    )?;
    let oauth = &v["claudeAiOauth"];
    Credential::new(
        oauth["accessToken"].as_str().unwrap_or("").into(),
        "claude-login",
    )
}
pub async fn read(
    client: &reqwest::Client,
    c: &Credential,
) -> std::result::Result<Reading, Failure> {
    // Reset grants are opt-in and gated on the native CLI client version.
    let version = tokio::time::timeout(
        Duration::from_secs(5),
        crate::command("claude")
            .arg("--version")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()
    .and_then(|r| r.ok())
    .filter(|r| r.status.success())
    .and_then(|r| String::from_utf8(r.stdout).ok())
    .and_then(|s| s.split_whitespace().next().map(str::to_owned));
    let mut request = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .query(&[("cedar_ember", "1")])
        .bearer_auth(&c.secret)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("x-app", "cli");
    if let Some(version) = version {
        request = request.header(
            "User-Agent",
            format!("claude-cli/{version} (external, cli) agent-remote-control"),
        );
    }
    let v = get(request).await?;
    let mut windows = vec![];
    if let Some(limits) = v["limits"].as_array() {
        for q in limits {
            let kind = q["kind"].as_str().unwrap_or("");
            if !["session", "weekly_all", "weekly_scoped"].contains(&kind) {
                continue;
            }
            let scope = q["scope"]["model"]["display_name"].as_str();
            let pool = scope.unwrap_or("subscription");
            if let Some(mut w) = window(
                &format!("{kind}/{pool}"),
                pool,
                kind,
                number(&q["percent"]),
                date(&q["resets_at"]),
            ) {
                w.scope = scope.map(str::to_owned);
                w.exhausted = if q.get("locked_reason").is_some_and(|v| !v.is_null()) {
                    Some(true)
                } else {
                    None
                };
                windows.push(w)
            }
        }
    }
    if windows.is_empty() {
        for id in [
            "five_hour",
            "seven_day",
            "seven_day_sonnet",
            "seven_day_opus",
            "seven_day_oauth_apps",
        ] {
            let q = &v[id];
            let pool = if ["five_hour", "seven_day"].contains(&id) {
                "subscription"
            } else {
                id
            };
            if let Some(mut w) = window(
                id,
                pool,
                id,
                number(&q["utilization"]),
                date(&q["resets_at"]),
            ) {
                if pool != "subscription" {
                    w.scope = Some(id.into())
                }
                windows.push(w)
            }
        }
    }
    Reading::new(windows, v)
}
