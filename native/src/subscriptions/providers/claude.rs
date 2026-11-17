// Native /usage strategy and line formats follow magpie (Copyright (c) 2026
// yetone). See licenses/magpie-LICENSE.txt. Authentication belongs to Claude Code.
use super::*;
use chrono::{Datelike, TimeZone};

pub async fn read() -> std::result::Result<Reading, Failure> {
    let output = native_cli(
        "claude",
        &[
            "-p",
            "/usage",
            "--output-format",
            "json",
            "--tools",
            "",
            "--strict-mcp-config",
            "--setting-sources",
            "",
            "--no-session-persistence",
        ],
    )
    .await?;
    parse_output(output)
}

pub(crate) async fn read_profile(profile: &str) -> std::result::Result<Reading, Failure> {
    let mut cmd = crate::accounts::claude::account_command(profile)
        .await
        .map_err(|message| Failure {
            code: "request-failed",
            message: Some(message),
            retry_at: None,
        })?;
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        cmd.kill_on_drop(true)
            .env("TZ", "UTC")
            .args([
                "-p",
                "/usage",
                "--output-format",
                "json",
                "--tools",
                "",
                "--strict-mcp-config",
                "--setting-sources",
                "",
                "--no-session-persistence",
            ])
            .stdin(std::process::Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| Failure::from("request-timeout"))?
    .map_err(|_| Failure::from("request-failed"))?;
    parse_output(output)
}
fn parse_output(output: std::process::Output) -> std::result::Result<Reading, Failure> {
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| Failure {
        code: "request-failed",
        message: Some("Claude Code did not return a /usage result. Check `claude auth status`, then refresh usage.".into()),
        retry_at: None,
    })?;
    let result = if let Some(messages) = value.as_array() {
        messages.iter().rev().find(|v| v["type"] == "result")
    } else {
        Some(&value)
    }
    .ok_or(Failure::from("invalid-response"))?;
    let text = result["result"]
        .as_str()
        .ok_or(Failure::from("invalid-response"))?;
    if !output.status.success() || result["is_error"] == true {
        return Err(Failure {
            code: "request-failed",
            message: Some(format!(
                "Claude Code /usage: {}",
                text.chars().take(400).collect::<String>()
            )),
            retry_at: None,
        });
    }
    parse_usage(text, chrono::Utc::now())
}

pub(super) fn parse_usage(
    text: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> std::result::Result<Reading, Failure> {
    let ansi = regex::Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").unwrap();
    let text = ansi.replace_all(text, "");
    let line = regex::Regex::new(
        r"^Current (session|week(?: \(([^)]+)\))?):\s*([0-9.]+)% used(?:\s*·\s*resets (.+))?$",
    )
    .unwrap();
    let mut windows = vec![];
    for row in text.lines() {
        let Some(captures) = line.captures(row.trim()) else {
            continue;
        };
        let session = &captures[1] == "session";
        let scope = captures
            .get(2)
            .map(|m| m.as_str())
            .filter(|s| !s.eq_ignore_ascii_case("all models"));
        let label = if session { "five_hour" } else { "seven_day" };
        let pool = scope.unwrap_or("subscription");
        let id = format!("{label}/{pool}");
        if windows.iter().any(|w: &QuotaWindow| w.id == id) {
            continue;
        }
        if let Some(mut w) = window(
            &id,
            pool,
            label,
            captures[3].parse().ok(),
            captures
                .get(4)
                .and_then(|m| reset_time(m.as_str(), now, if session { 5 } else { 168 })),
        ) {
            w.scope = scope.map(str::to_owned);
            windows.push(w);
        }
    }
    if windows.is_empty() {
        return Err(Failure {
            code: "no-limits-reported",
            message: Some("Claude Code /usage returned no quota windows. Open Claude Code and run /usage, then refresh here.".into()),
            retry_at: None,
        });
    }
    Reading::new(windows, json!({"cliUsage": text.as_ref()}))
}

// The child runs with TZ=UTC. Unknown zones stay unknown instead of being
// interpreted in the host's zone, including on Windows without a tz database.
fn reset_time(text: &str, now: chrono::DateTime<chrono::Utc>, hours: i64) -> Option<String> {
    let text = text.trim();
    let text = if text.ends_with(')') {
        let (text, zone) = text.rsplit_once(" (")?;
        if !["UTC)", "Etc/UTC)", "GMT)"].contains(&zone) {
            return None;
        }
        text
    } else {
        text
    };
    let text = text.replace("AM", "am").replace("PM", "pm");
    // Chrono requires minutes even when the CLI reports only an hour.
    let hour_only = regex::Regex::new(r"(^|[ ,])([0-9]{1,2})(am|pm)$").unwrap();
    let text = hour_only.replace(&text, "${1}${2}:00${3}");
    let earliest = now - chrono::Duration::days(1);
    let latest = now + chrono::Duration::hours(hours + 2);
    let mut dates = vec![];
    for format in ["%b %e, %Y at %I:%M%P", "%b %e, %Y, %I:%M%P"] {
        if let Ok(date) = chrono::NaiveDateTime::parse_from_str(&text, format) {
            return Some(chrono::Utc.from_utc_datetime(&date).to_rfc3339());
        }
    }
    for year in now.year() - 1..=now.year() + 1 {
        for format in ["%Y %b %e at %I:%M%P", "%Y %b %e, %I:%M%P"] {
            if let Ok(date) =
                chrono::NaiveDateTime::parse_from_str(&format!("{year} {text}"), format)
            {
                dates.push(chrono::Utc.from_utc_datetime(&date));
            }
        }
    }
    if let Ok(time) = chrono::NaiveTime::parse_from_str(&text, "%I:%M%P") {
        for day in -1..=1 {
            let date = now.date_naive() + chrono::Duration::days(day);
            dates.push(chrono::Utc.from_utc_datetime(&date.and_time(time)));
        }
    }
    dates.sort();
    dates
        .iter()
        .find(|date| **date >= now && **date <= latest)
        .or_else(|| {
            dates
                .iter()
                .rev()
                .find(|date| **date >= earliest && **date <= latest)
        })
        .map(chrono::DateTime::to_rfc3339)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_usage_preserves_reported_windows_and_reset_times() {
        // Recurring bug class: direct Claude quota requests returned 401 while the native CLI owned login renewal.
        let now = chrono::DateTime::parse_from_rfc3339("2025-12-31T23:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let reading = parse_usage("Current session: 13% used · resets 1am (UTC)\nCurrent week (all models): 4% used · resets Jan 3, 2pm (UTC)\nCurrent week (Sonnet): 9% used", now).unwrap_or_else(|_| panic!("native usage should parse"));
        assert_eq!(reading.windows.len(), 3);
        let session = &reading.windows[0];
        assert_eq!(session.used_percent, 13.);
        assert_eq!(
            session.resets_at.as_deref(),
            Some("2026-01-01T01:00:00+00:00")
        );
        assert_eq!(
            reading.windows[1].resets_at.as_deref(),
            Some("2026-01-03T14:00:00+00:00")
        );
        assert_eq!(reading.windows[2].scope.as_deref(), Some("Sonnet"));
        assert_eq!(reading.windows[2].resets_at, None);
        let with_minutes = parse_usage("Current session: 13% used · resets 1:30AM (UTC)", now)
            .unwrap_or_else(|_| panic!("minute precision should parse"));
        assert_eq!(
            with_minutes.windows[0].resets_at.as_deref(),
            Some("2026-01-01T01:30:00+00:00")
        );
    }

    #[test]
    fn native_usage_without_readings_stays_unknown() {
        // Recurring bug class: Claude /usage can succeed with a billing notice and no quota values.
        let reading = parse_usage(
            "You are currently using your subscription to power your Claude Code usage.",
            chrono::Utc::now(),
        );
        assert!(matches!(reading, Err(error) if error.code == "no-limits-reported"));
    }
}
