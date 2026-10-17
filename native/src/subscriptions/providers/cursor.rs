use super::*;
use base64::Engine;
fn claims(token: &str) -> Option<Value> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.split('.').nth(1)?.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}
pub async fn credential() -> std::result::Result<Credential, Failure> {
    let sqlite = tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        let dir = dirs::home_dir()?.join("Library/Application Support");
        #[cfg(not(target_os = "macos"))]
        let dir = dirs::config_dir()?;
        let db = rusqlite::Connection::open_with_flags(
            dir.join("Cursor/User/globalStorage/state.vscdb"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .ok()?;
        db.busy_timeout(Duration::from_secs(2)).ok()?;
        let value = |key: &str| -> Option<String> {
            let raw: Vec<u8> = db
                .query_row(
                    "SELECT value FROM ItemTable WHERE key=?1 LIMIT 1",
                    [key],
                    |r| Ok(r.get_ref(0)?.as_bytes()?.to_vec()),
                )
                .ok()?;
            if raw.len() % 2 == 0 && raw.get(1) == Some(&0) {
                String::from_utf16(
                    &raw.chunks_exact(2)
                        .map(|b| u16::from_le_bytes([b[0], b[1]]))
                        .collect::<Vec<_>>(),
                )
                .ok()
            } else {
                String::from_utf8(raw).ok()
            }
        };
        value("cursorAuth/accessToken")
    })
    .await
    .map_err(|_| Failure::from("credential-access-denied"))?;
    #[allow(unused_mut)]
    let mut keychain: Option<String> = None;
    #[cfg(target_os = "macos")]
    if sqlite.is_none() {
        if let Ok(Ok(out)) = tokio::time::timeout(
            Duration::from_secs(4),
            tokio::process::Command::new("security")
                .args(["find-generic-password", "-s", "cursor-access-token", "-w"])
                .kill_on_drop(true)
                .output(),
        )
        .await
        {
            if out.status.success() {
                keychain = String::from_utf8(out.stdout).ok().map(|s| s.trim().into());
            }
        }
    }
    let token = sqlite
        .or(keychain)
        .ok_or(Failure::from("credentials-missing"))?;
    let claims = claims(&token).ok_or(Failure::from("invalid-response"))?;
    let account = claims["sub"]
        .as_str()
        .and_then(|s| s.rsplit('|').next())
        .filter(|s| !s.is_empty())
        .ok_or(Failure::from("invalid-response"))?;
    Credential::new(
        format!("WorkosCursorSessionToken={account}%3A%3A{token}"),
        "cursor-login",
    )
}

pub async fn read(
    client: &reqwest::Client,
    c: &Credential,
) -> std::result::Result<Reading, Failure> {
    let token = c
        .secret
        .rsplit("%3A%3A")
        .next()
        .ok_or(Failure::from("credentials-missing"))?;
    let rpc = |method: &str| {
        client
            .post(format!(
                "https://api2.cursor.sh/aiserver.v1.DashboardService/{method}"
            ))
            .bearer_auth(token)
            .header("Connect-Protocol-Version", "1")
            .json(&json!({}))
    };
    let (usage, plan) = tokio::join!(get(rpc("GetCurrentPeriodUsage")), get(rpc("GetPlanInfo")));
    let mut raw = json!({});
    let mut windows = vec![];
    if let Ok(v) = usage {
        let q = &v["planUsage"];
        let reset =
            timestamp(&v["billingCycleEnd"]).or_else(|| timestamp(&v["billingCycleEndDate"]));
        for (field, id) in [
            ("totalPercentUsed", "plan"),
            ("autoPercentUsed", "cursorModels"),
            ("apiPercentUsed", "otherModels"),
        ] {
            let percent = number(&q[field]).or_else(|| {
                if id != "plan" {
                    return None;
                }
                let limit = number(&q["limit"]).filter(|n| *n > 0.)?;
                number(&q["totalSpend"]).map(|n| n / limit * 100.)
            });
            if let Some(w) = window(id, id, id, percent, reset.clone()) {
                windows.push(w);
            }
        }
        raw["usage"] = v;
    }
    if let Ok(v) = plan {
        raw["plan"] = v;
    }
    if windows.is_empty() {
        match get(client
            .get("https://cursor.com/api/usage-summary")
            .header("Cookie", &c.secret))
        .await
        {
            Ok(v) => {
                let q = &v["individualUsage"]["plan"];
                let reset = date(&v["billingCycleEnd"]);
                for (field, id) in [
                    ("totalPercentUsed", "plan"),
                    ("autoPercentUsed", "cursorModels"),
                    ("apiPercentUsed", "otherModels"),
                ] {
                    let percent = number(&q[field]).or_else(|| {
                        if id != "plan" {
                            return None;
                        }
                        let limit = number(&q["limit"]).filter(|n| *n > 0.)?;
                        number(&q["used"]).map(|n| n / limit * 100.)
                    });
                    if let Some(w) = window(id, id, id, percent, reset.clone()) {
                        windows.push(w);
                    }
                }
                raw["summary"] = v;
            }
            Err(e) if raw.as_object().is_none_or(|v| v.is_empty()) => return Err(e),
            Err(e) => {
                raw["quotaError"] = json!(e.code);
            }
        }
    }
    if raw["plan"]["isMerged"] == true {
        // Exchange the current Cursor login, never borrow another provider's login.
        let shared = async {
            let credential = get(client
                .post(
                    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetXaiCommerceBearerToken",
                )
                .bearer_auth(token)
                .header("Connect-Protocol-Version", "1")
                .json(&json!({"purpose":"XAI_COMMERCE_BEARER_PURPOSE_BROWSER_COMMERCE"})))
            .await?;
            let bearer = credential["credential"]["token"]
                .as_str()
                .ok_or(Failure::from("credentials-missing"))?;
            get(client
                .get("https://grok.com/rest/grok/credits")
                .bearer_auth(bearer)
                .header("User-Agent", "Mozilla/5.0 agent-remote-control"))
            .await
        }
        .await;
        match shared {
            Ok(v) if v["config"]["isUnifiedBillingUser"] == true => {
                let q = &v["config"];
                let label = match q["currentPeriod"]["type"].as_str() {
                    Some("USAGE_PERIOD_TYPE_WEEKLY") => "weekly",
                    Some("USAGE_PERIOD_TYPE_MONTHLY") => "monthly",
                    _ => "current-period",
                };
                if let Some(w) = window(
                    "cursorModels",
                    "cursorModels",
                    label,
                    number(&q["creditUsagePercent"]),
                    date(&q["currentPeriod"]["end"]),
                ) {
                    windows.retain(|w| w.id != "plan" && w.id != "cursorModels");
                    windows.insert(0, w);
                }
                raw["sharedUsage"] = v;
            }
            Err(e) => raw["sharedUsageError"] = json!(e.code),
            _ => {}
        }
    }
    Reading::new(windows, raw)
}
fn timestamp(v: &Value) -> Option<String> {
    date(v).or_else(|| {
        v.as_i64()
            .or_else(|| v.as_str()?.parse().ok())
            .and_then(|n| {
                chrono::DateTime::from_timestamp_millis(if n < 10_000_000_000 {
                    n * 1000
                } else {
                    n
                })
            })
            .map(|d| d.to_rfc3339())
    })
}
