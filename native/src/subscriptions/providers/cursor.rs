// Native login and merged-plan usage follow magpie-community's Cursor plugin.
// See licenses/magpie-community-LICENSE.txt.
use super::*;
use base64::Engine;
fn claims(token: &str) -> Option<Value> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.split('.').nth(1)?.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}
pub async fn credential() -> std::result::Result<Credential, Failure> {
    #[cfg(target_os = "macos")]
    if let Ok(Ok(out)) = tokio::time::timeout(
        Duration::from_secs(4),
        tokio::process::Command::new("security")
            .args([
                "find-generic-password",
                "-s",
                "cursor-access-token",
                "-a",
                "cursor-user",
                "-w",
            ])
            .kill_on_drop(true)
            .output(),
    )
    .await
    {
        if out.status.success() {
            if let Ok(token) = String::from_utf8(out.stdout) {
                if !token.trim().is_empty() {
                    return Credential::new(token.trim().into(), "cursor-login");
                }
            }
        }
    }
    // cursor-agent stores its native login here when Keychain is unavailable.
    #[cfg(target_os = "macos")]
    let auth = home()?.join(".cursor/auth.json");
    #[cfg(target_os = "windows")]
    let auth = dirs::config_dir()
        .ok_or(Failure::from("credentials-missing"))?
        .join("Cursor/auth.json");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let auth = dirs::config_dir()
        .ok_or(Failure::from("credentials-missing"))?
        .join("cursor/auth.json");
    if let Ok(saved) = file(&auth) {
        if let Some(token) = saved["accessToken"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
        {
            return Credential::new(token.into(), "cursor-login");
        }
    }
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
    Credential::new(
        sqlite.ok_or(Failure::from("credentials-missing"))?,
        "cursor-login",
    )
}

pub async fn read(
    client: &reqwest::Client,
    c: &Credential,
) -> std::result::Result<Reading, Failure> {
    let token = &c.secret;
    let cookie = session_cookie(token);
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
        windows = parse_usage(&v["planUsage"], &v, plan.as_ref().ok(), "totalSpend");
        raw["usage"] = v;
    }
    if let Ok(v) = plan {
        raw["plan"] = v;
    }
    if windows.is_empty() && cookie.is_some() {
        match get(client
            .get("https://cursor.com/api/usage-summary")
            .header("Cookie", cookie.as_deref().unwrap()))
        .await
        {
            Ok(v) => {
                windows = parse_usage(
                    &v["individualUsage"]["plan"],
                    &v,
                    Some(&raw["plan"]),
                    "used",
                );
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
                    if windows.is_empty() {
                        windows.push(w);
                    }
                }
                raw["sharedUsage"] = v;
            }
            Err(e) => raw["sharedUsageError"] = json!(e.code),
            _ => {}
        }
    }
    Reading::new(windows, raw)
}
fn session_cookie(token: &str) -> Option<String> {
    let claims = claims(token)?;
    let account = claims["sub"].as_str()?.rsplit('|').next()?;
    let session = format!("{account}::{token}");
    let encoded: String = url::form_urlencoded::byte_serialize(session.as_bytes()).collect();
    Some(format!("WorkosCursorSessionToken={encoded}"))
}

pub(super) fn parse_usage(
    quota: &Value,
    usage: &Value,
    plan: Option<&Value>,
    spend_field: &str,
) -> Vec<QuotaWindow> {
    let plan = plan.unwrap_or(&Value::Null);
    let reset = timestamp(&usage["billingCycleEnd"])
        .or_else(|| timestamp(&usage["billingCycleEndDate"]))
        .or_else(|| timestamp(&plan["planInfo"]["includedUsageResetsAt"]));
    let total = number(&quota["totalPercentUsed"]).or_else(|| {
        let limit = number(&quota["limit"]).filter(|n| *n > 0.)?;
        number(&quota[spend_field]).map(|n| n / limit * 100.)
    });
    if plan["isMerged"] == true {
        let label = match plan["planInfo"]["includedUsagePeriod"].as_str() {
            Some("INCLUDED_USAGE_PERIOD_WEEKLY") => "weekly",
            Some("INCLUDED_USAGE_PERIOD_MONTHLY") => "monthly",
            _ => match plan["planInfo"]["includedUsagePeriod"].as_u64() {
                Some(2) => "weekly",
                Some(1) => "monthly",
                _ => "current-period",
            },
        };
        return window("cursorModels", "cursorModels", label, total, reset)
            .into_iter()
            .collect();
    }
    [
        ("plan", total),
        ("cursorModels", number(&quota["autoPercentUsed"])),
        ("otherModels", number(&quota["apiPercentUsed"])),
    ]
    .into_iter()
    .filter_map(|(id, percent)| window(id, id, id, percent, reset.clone()))
    .collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merged_plan_reports_one_included_window_with_its_period_and_reset() {
        // Regression: Cursor Premium's merged weekly allowance was parsed as unlabeled monthly model pools.
        let usage = json!({"billingCycleEnd":"1800000000000"});
        let quota = json!({"totalPercentUsed":12.5,"autoPercentUsed":12.5,"apiPercentUsed":0});
        for (period, label) in [
            (json!("INCLUDED_USAGE_PERIOD_WEEKLY"), "weekly"),
            (json!(2), "weekly"),
            (json!("INCLUDED_USAGE_PERIOD_MONTHLY"), "monthly"),
            (json!(1), "monthly"),
        ] {
            let plan = json!({"isMerged":true,"planInfo":{"includedUsagePeriod":period}});
            let windows = parse_usage(&quota, &usage, Some(&plan), "totalSpend");
            assert_eq!(windows.len(), 1);
            assert_eq!(windows[0].pool_id, "cursorModels");
            assert_eq!(windows[0].label, label);
            assert_eq!(windows[0].used_percent, 12.5);
            assert_eq!(
                windows[0].resets_at.as_deref(),
                Some("2027-01-15T08:00:00+00:00")
            );
        }
    }
}
