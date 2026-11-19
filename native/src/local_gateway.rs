//! Optional local LLM gateway integration (Magpie-compatible HTTP API).
//!
//! Strictly opt-in via loopback auto-detection; absent or unreachable gateways
//! fall back silently to ARC's native paths without introducing any hard
//! dependency.
use crate::subscriptions::types::{window, QuotaWindow, Reading};
use crate::*;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

const HELLO_TIMEOUT: Duration = Duration::from_millis(250);
const READ_TIMEOUT: Duration = Duration::from_millis(1500);
const DEFAULT_PORT: u16 = 3425;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Gateway {
    pub origin: String,
    pub name: String,
    pub version: Option<String>,
}

fn client(timeout: Duration) -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .build()
        .ok()
}

/// Normalize a loopback HTTP URL to `http://<host>:<port>`. Rejects non-loopback
/// or non-HTTP URLs so ARC never forwards local reads to remote hosts.
pub(crate) fn loopback_origin(raw: &str) -> Option<String> {
    let parsed = url::Url::parse(raw.trim()).ok()?;
    if parsed.scheme() != "http" {
        return None;
    }
    let host = parsed.host_str()?;
    let is_loopback = matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]");
    if !is_loopback {
        return None;
    }
    let port = parsed.port_or_known_default()?;
    let host_fmt = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    Some(format!("http://{host_fmt}:{port}"))
}

/// Extract the configured Codex gateway loopback origin from Codex's `config.toml`,
/// returning `None` when Codex talks directly to OpenAI or uses a remote host.
pub(crate) fn codex_configured_origin(config_toml: &str) -> Option<String> {
    let table: toml::Value = toml::from_str(config_toml).ok()?;
    if let Some(base) = table.get("openai_base_url").and_then(toml::Value::as_str) {
        if let Some(origin) = loopback_origin(base) {
            return Some(origin);
        }
    }
    let provider_name = table
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .unwrap_or("");
    if !provider_name.is_empty() {
        if let Some(base) = table
            .get("model_providers")
            .and_then(|m| m.get(provider_name))
            .and_then(|p| p.get("base_url"))
            .and_then(toml::Value::as_str)
        {
            if let Some(origin) = loopback_origin(base) {
                return Some(origin);
            }
        }
    }
    None
}

fn codex_config_path() -> Option<PathBuf> {
    let home = crate::accounts::codex::default_home().ok()?;
    Some(home.join("config.toml"))
}

fn magpie_settings_origin() -> Option<String> {
    if let Ok(explicit) = std::env::var("ARC_LOCAL_GATEWAY_URL") {
        return loopback_origin(&explicit);
    }
    let dir = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))?;
    let path = dir.join("magpie").join("settings.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let json: Value = serde_json::from_str(&raw).ok()?;
    let port = json["port"]
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_PORT);
    Some(format!("http://127.0.0.1:{port}"))
}

async fn probe(origin: &str) -> Option<Gateway> {
    let origin = loopback_origin(origin)?;
    let http = client(HELLO_TIMEOUT)?;
    let resp = http.get(format!("{origin}/api/hello")).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: Value = resp.json().await.ok()?;
    let name = body["name"].as_str()?.trim();
    if !name.eq_ignore_ascii_case("magpie") {
        return None;
    }
    Some(Gateway {
        origin,
        name: name.to_owned(),
        version: body["version"]
            .as_str()
            .filter(|v| !v.is_empty())
            .map(str::to_owned),
    })
}

/// Detect an active local Magpie gateway ONLY when Codex is configured to route
/// through it (or `ARC_LOCAL_GATEWAY_URL` is set for isolated verification).
pub(crate) async fn detect_for_codex() -> Option<Gateway> {
    if let Ok(explicit) = std::env::var("ARC_LOCAL_GATEWAY_URL") {
        return probe(&explicit).await;
    }
    let path = codex_config_path()?;
    let text = std::fs::read_to_string(path).ok()?;
    let origin = codex_configured_origin(&text)?;
    probe(&origin).await
}

/// Detect any active local Magpie gateway (Codex-configured first, then settings.json).
pub(crate) async fn detect_any() -> Option<Gateway> {
    if let Some(gw) = detect_for_codex().await {
        return Some(gw);
    }
    let origin = magpie_settings_origin()?;
    probe(&origin).await
}

fn parse_balance_positive(entry: &Value) -> bool {
    let Some(raw) = entry["balance"].as_str() else {
        return false;
    };
    raw.split_whitespace()
        .next()
        .and_then(|n| n.replace(',', "").parse::<f64>().ok())
        .is_some_and(|n| n.is_finite() && n > 0.0)
}

fn is_allowance_window(w: &Value) -> bool {
    if w["text"] == true || w["aside"] == true {
        return false;
    }
    if w["lane"]
        .as_str()
        .is_some_and(|l| !l.is_empty() && l != "text")
    {
        return false;
    }
    w["used"]
        .as_f64()
        .is_some_and(|n| n.is_finite() && n >= 0.0)
}

fn normalize_window_name(name: &str) -> (String, Option<u64>) {
    let lower = name.trim().to_lowercase();
    if lower.contains("7 day") || lower.contains("week") || lower == "7d" {
        ("weekly".into(), Some(10080))
    } else if lower.contains("5 hour") || lower == "5h" {
        ("5h".into(), Some(300))
    } else {
        (name.trim().to_owned(), None)
    }
}

/// Aggregate Magpie `/v1/magpie/quotas` entries for one provider (e.g. `"codex"`)
/// into both a `subscriptions::Reading` and a `dispatch_policy` quota projection.
pub(crate) fn aggregate_provider_quotas(
    body: &Value,
    provider_id: &str,
) -> Option<(Reading, Value)> {
    let entries: Vec<&Value> = body["data"]
        .as_array()?
        .iter()
        .filter(|e| {
            e["provider"]
                .as_str()
                .is_some_and(|p| p.eq_ignore_ascii_case(provider_id))
                && e["error"].is_null()
        })
        .collect();
    if entries.is_empty() {
        return None;
    }

    #[derive(Default)]
    struct Bucket {
        label: String,
        duration_mins: Option<u64>,
        used_values: Vec<f64>,
        earliest_reset: Option<String>,
    }

    let mut buckets: BTreeMap<String, Bucket> = BTreeMap::new();
    let mut accounts_with_room = 0usize;
    let mut accounts_with_credits = 0usize;
    let mut account_summaries = Vec::new();

    for entry in &entries {
        let mut acct_windows: Vec<&Value> = entry["windows"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|w| is_allowance_window(w))
            .collect();
        let has_credits = parse_balance_positive(entry);
        if has_credits {
            accounts_with_credits += 1;
        }
        let has_room = !acct_windows.is_empty()
            && acct_windows
                .iter()
                .all(|w| w["used"].as_f64().unwrap_or(100.0) < 100.0);
        if has_room {
            accounts_with_room += 1;
        }
        let mut worst_used = 0.0_f64;
        for w in acct_windows.drain(..) {
            let raw_name = w["name"].as_str().unwrap_or("window");
            let (norm, mins) = normalize_window_name(raw_name);
            let used = w["used"].as_f64().unwrap_or(0.0).clamp(0.0, 100.0);
            if used > worst_used {
                worst_used = used;
            }
            let reset = w["resetsAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&chrono::Utc).to_rfc3339());
            let b = buckets.entry(norm.clone()).or_insert_with(|| Bucket {
                label: norm,
                duration_mins: mins,
                ..Default::default()
            });
            b.used_values.push(used);
            if let Some(r) = reset {
                if b.earliest_reset.as_ref().is_none_or(|cur| r < *cur) {
                    b.earliest_reset = Some(r);
                }
            }
        }
        let mut summary = json!({
            "plan": entry["plan"],
            "usedPercent": (worst_used * 10.0).round() / 10.0,
            "hasRoom": has_room,
        });
        if has_credits {
            summary["credits"] = json!({"hasCredits": true, "balance": entry["balance"]});
        }
        account_summaries.push(summary);
    }

    let total = entries.len();
    let scope_label = if total == 1 {
        "Gateway pool (1 account)".to_owned()
    } else {
        format!("Gateway pool ({accounts_with_room}/{total} accounts ready)")
    };

    let mut reading_windows: Vec<QuotaWindow> = Vec::new();
    let mut dispatch_primary = Value::Null;
    let mut dispatch_secondary = Value::Null;

    // Order primary/weekly windows predictably: 5h first if present, then weekly, then others.
    let mut ordered: Vec<(String, Bucket)> = buckets.into_iter().collect();
    ordered.sort_by_key(|(k, _)| match k.as_str() {
        "5h" => (0, k.clone()),
        "weekly" => (1, k.clone()),
        _ => (2, k.clone()),
    });

    for (idx, (key, b)) in ordered.into_iter().enumerate() {
        if b.used_values.is_empty() {
            continue;
        }
        let avg = ((b.used_values.iter().sum::<f64>() / b.used_values.len() as f64) * 10.0).round()
            / 10.0;
        let min_used = b.used_values.iter().copied().fold(f64::INFINITY, f64::min);
        let reset_unix = b
            .earliest_reset
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp());
        if let Some(mut qw) = window(
            &format!("gateway/{provider_id}/{key}"),
            provider_id,
            &b.label,
            Some(avg),
            b.earliest_reset.clone(),
        ) {
            qw.scope = Some(scope_label.clone());
            qw.exhausted = Some(accounts_with_room == 0);
            reading_windows.push(qw);
        }
        let mut slot = json!({
            "usedPercent": avg,
            "bestAccountUsedPercent": (min_used * 10.0).round() / 10.0,
        });
        if let Some(mins) = b.duration_mins {
            slot["windowDurationMins"] = json!(mins);
        }
        if let Some(ts) = reset_unix {
            slot["resetsAt"] = json!(ts);
        }
        if idx == 0 {
            dispatch_primary = slot;
        } else if idx == 1 {
            dispatch_secondary = slot;
        }
    }

    let ordinary_allowed = accounts_with_room > 0;
    let blocked = accounts_with_room == 0 && accounts_with_credits == 0;

    let mut pool_obj = json!({
        "id": provider_id,
        "accountsTotal": total,
        "accountsWithRoom": accounts_with_room,
        "accountsWithCredits": accounts_with_credits,
    });
    if !dispatch_primary.is_null() {
        pool_obj["primary"] = dispatch_primary;
    }
    if !dispatch_secondary.is_null() {
        pool_obj["secondary"] = dispatch_secondary;
    }
    if accounts_with_credits > 0 {
        pool_obj["credits"] = json!({"hasCredits": true});
    }

    let dispatch_quota = json!({
        "source": "local-gateway",
        "gateway": "magpie",
        "ordinaryUsageAllowed": ordinary_allowed,
        "pools": [pool_obj],
        "poolAccounts": account_summaries,
        "state": "ready",
        "observedAt": now(),
    });

    let raw_usage = json!({
        "source": "local-gateway",
        "gateway": "magpie",
        "accountsTotal": total,
        "accountsWithRoom": accounts_with_room,
        "accountsWithCredits": accounts_with_credits,
        "ordinaryUsageAllowed": ordinary_allowed,
        "pools": [dispatch_quota["pools"][0].clone()],
        "poolAccounts": account_summaries,
    });

    let mut reading = Reading::new(reading_windows, raw_usage).ok()?;
    reading.account_blocked = Some(blocked);
    if blocked {
        reading.blocked_pool_ids = vec![provider_id.to_owned()];
    }
    Some((reading, dispatch_quota))
}

pub(crate) async fn fetch_codex_pool_quota() -> Option<(Reading, Value)> {
    let gw = detect_for_codex().await?;
    let http = client(READ_TIMEOUT)?;
    let resp = http
        .get(format!("{}/v1/magpie/quotas", gw.origin))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: Value = resp.json().await.ok()?;
    aggregate_provider_quotas(&body, "codex")
}

fn is_auxiliary_request(row: &Value) -> bool {
    if let Some(kind) = row["kind"].as_str() {
        if matches!(
            kind,
            "composer_predictions" | "title" | "auxiliary" | "warmup" | "cache_keepalive"
        ) {
            return true;
        }
    }
    if row["session_role"].as_str() == Some("unknown")
        && row["kind"].as_str().is_some_and(|k| !k.is_empty())
    {
        return true;
    }
    false
}

/// Filter and sum Magpie `/v1/magpie/usage/requests` rows for a single turn's
/// session and `[started_at, ended_at]` window. Returns `None` when no matching
/// gateway calls exist so ARC never fabricates zero totals.
pub(crate) fn aggregate_turn_usage(
    body: &Value,
    session_id: &str,
    started_at: Option<&str>,
    ended_at: Option<&str>,
) -> Option<Value> {
    let rows = body["rows"].as_array()?;
    let start_bound = started_at
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&chrono::Utc) - chrono::Duration::seconds(2));
    let end_bound = ended_at
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&chrono::Utc) + chrono::Duration::seconds(5));

    let mut calls = 0u64;
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    let mut cache_read_tokens = 0u64;
    let mut cache_write_tokens = 0u64;
    let mut reasoning_tokens = 0u64;
    let mut duration_ms = 0u64;
    let mut cost_usd = 0.0_f64;
    let mut priced_calls = 0u64;
    let mut served_models = BTreeSet::<String>::new();
    let mut served_providers = BTreeSet::<String>::new();

    for row in rows {
        let matched_session = row["native_session"].as_str() == Some(session_id)
            || row["session"].as_str() == Some(session_id);
        if !matched_session || is_auxiliary_request(row) {
            continue;
        }
        if start_bound.is_some() || end_bound.is_some() {
            let Some(ts) = row["t"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&chrono::Utc))
            else {
                continue;
            };
            if start_bound.is_some_and(|s| ts < s) || end_bound.is_some_and(|e| ts > e) {
                continue;
            }
        }
        calls += 1;
        input_tokens += row["in"].as_u64().unwrap_or(0);
        output_tokens += row["out"].as_u64().unwrap_or(0);
        cache_read_tokens += row["cache_read"].as_u64().unwrap_or(0);
        cache_write_tokens += row["cache_write"].as_u64().unwrap_or(0);
        reasoning_tokens += row["reasoning"].as_u64().unwrap_or(0);
        duration_ms += row["ms"].as_u64().unwrap_or(0);
        if row["priced"] == true {
            if let Some(c) = row["cost"].as_f64().filter(|c| c.is_finite() && *c >= 0.0) {
                cost_usd += c;
                priced_calls += 1;
            }
        }
        if let Some(m) = row["served"]
            .as_str()
            .or(row["model"].as_str())
            .filter(|s| !s.is_empty())
        {
            served_models.insert(m.to_owned());
        }
        if let Some(p) = row["provider"].as_str().filter(|s| !s.is_empty()) {
            served_providers.insert(p.to_owned());
        }
    }

    if calls == 0 {
        return None;
    }

    let mut out = json!({
        "source": "local-gateway",
        "gateway": "magpie",
        "calls": calls,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cacheReadTokens": cache_read_tokens,
        "cacheWriteTokens": cache_write_tokens,
        "reasoningTokens": reasoning_tokens,
        "durationMs": duration_ms,
        "servedModels": served_models.into_iter().collect::<Vec<_>>(),
        "servedProviders": served_providers.into_iter().collect::<Vec<_>>(),
    });
    if priced_calls > 0 {
        out["costUsd"] = json!((cost_usd * 1_000_000.0).round() / 1_000_000.0);
        out["pricedCalls"] = json!(priced_calls);
    }
    Some(out)
}

/// Optional per-turn usage backfill for a completed thread/session.
pub(crate) async fn fetch_turn_usage(
    agent: &str,
    session_id: &str,
    started_at: Option<&str>,
    ended_at: Option<&str>,
) -> Option<Value> {
    if session_id.trim().is_empty() {
        return None;
    }
    let gw = if agent == "codex" {
        detect_for_codex().await?
    } else {
        detect_any().await?
    };
    let http = client(READ_TIMEOUT)?;
    let resp = http
        .get(format!("{}/v1/magpie/usage/requests", gw.origin))
        .query(&[
            ("q", session_id),
            ("agent", agent),
            ("via", "gateway"),
            ("period", "30d"),
            ("limit", "200"),
        ])
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: Value = resp.json().await.ok()?;
    aggregate_turn_usage(&body, session_id, started_at, ended_at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // Contract: loopback-only gateway origin validation rejects remote hosts
    fn loopback_origin_rejects_remote_hosts() {
        assert_eq!(
            loopback_origin("http://127.0.0.1:3425/backend-api/codex"),
            Some("http://127.0.0.1:3425".into())
        );
        assert_eq!(
            loopback_origin("http://localhost:8080/v1"),
            Some("http://localhost:8080".into())
        );
        assert_eq!(loopback_origin("https://127.0.0.1:3425"), None);
        assert_eq!(loopback_origin("http://example.com:3425/v1"), None);
        assert_eq!(loopback_origin("not-a-url"), None);
    }

    #[test]
    // Contract: codex config detects local gateway only when wired to loopback
    fn codex_config_extracts_loopback_origin_only() {
        let wired = r#"
model = "auto/gpt-6.2-sol"
openai_base_url = "http://127.0.0.1:3425/backend-api/codex"
"#;
        assert_eq!(
            codex_configured_origin(wired),
            Some("http://127.0.0.1:3425".into())
        );
        let native = r#"model = "gpt-6.2-sol""#;
        assert_eq!(codex_configured_origin(native), None);
        let remote = r#"openai_base_url = "https://api.openai.com/v1""#;
        assert_eq!(codex_configured_origin(remote), None);
    }

    #[test]
    // Algorithmic core: multi-account gateway pool quota aggregation
    fn aggregates_codex_pool_quotas_without_leaking_emails() {
        let payload = json!({
            "data": [
                {
                    "provider": "codex",
                    "plan": "promax",
                    "user": "primary@example.com",
                    "balance": "38941.48 credits",
                    "windows": [
                        {"name": "7 days", "used": 100, "resetsAt": "2026-11-20T19:18:21Z"},
                        {"name": "Image generation", "used": 0, "text": true, "lane": "images"}
                    ]
                },
                {
                    "provider": "codex",
                    "plan": "prolite",
                    "user": "spare1@example.com",
                    "windows": [
                        {"name": "7 days", "used": 3, "resetsAt": "2026-11-23T02:40:10Z"}
                    ]
                },
                {
                    "provider": "codex",
                    "plan": "prolite",
                    "user": "spare2@example.com",
                    "windows": [
                        {"name": "7 days", "used": 0, "resetsAt": "2026-11-23T10:03:05Z"}
                    ]
                }
            ]
        });
        let (reading, dispatch) = aggregate_provider_quotas(&payload, "codex").unwrap();
        assert_eq!(reading.windows.len(), 1);
        assert_eq!(reading.windows[0].label, "weekly");
        assert_eq!(reading.windows[0].used_percent, 34.3);
        assert_eq!(reading.account_blocked, Some(false));
        assert_eq!(dispatch["ordinaryUsageAllowed"], json!(true));
        assert_eq!(dispatch["pools"][0]["accountsTotal"], json!(3));
        assert_eq!(dispatch["pools"][0]["accountsWithRoom"], json!(2));
        assert_eq!(dispatch["pools"][0]["accountsWithCredits"], json!(1));
        assert_eq!(
            dispatch["pools"][0]["primary"]["bestAccountUsedPercent"],
            json!(0.0)
        );
        assert!(!dispatch.to_string().contains("example.com"));
    }

    #[test]
    // Algorithmic core: per-turn gateway usage window filtering and summation
    fn aggregates_turn_usage_for_matching_session_and_window() {
        let payload = json!({
            "rows": [
                {
                    "t": "2026-11-19T18:04:05Z",
                    "native_session": "thread-1",
                    "provider": "codex",
                    "served": "gpt-6.2-sol",
                    "in": 900,
                    "out": 50,
                    "cache_read": 10000,
                    "cache_write": 0,
                    "reasoning": 10,
                    "ms": 4000,
                    "cost": 0.02,
                    "priced": true,
                    "session_role": "main"
                },
                {
                    "t": "2026-11-19T18:04:10Z",
                    "native_session": "thread-1",
                    "provider": "codex",
                    "served": "gpt-6.2-sol",
                    "in": 300,
                    "out": 200,
                    "cache_read": 20000,
                    "cache_write": 0,
                    "reasoning": 40,
                    "ms": 6000,
                    "cost": 0.03,
                    "priced": true,
                    "session_role": "main"
                },
                {
                    "t": "2026-11-19T18:04:12Z",
                    "native_session": "thread-1",
                    "provider": "codex",
                    "served": "gpt-6.2-sol",
                    "in": 1500,
                    "out": 300,
                    "kind": "composer_predictions",
                    "session_role": "unknown",
                    "cost": 0.04,
                    "priced": true
                },
                {
                    "t": "2026-11-19T18:09:00Z",
                    "native_session": "thread-1",
                    "provider": "codex",
                    "served": "gpt-6.2-sol",
                    "in": 9999,
                    "out": 9999,
                    "session_role": "main"
                }
            ]
        });
        let usage = aggregate_turn_usage(
            &payload,
            "thread-1",
            Some("2026-11-19T18:04:00Z"),
            Some("2026-11-19T18:04:20Z"),
        )
        .unwrap();
        assert_eq!(usage["calls"], json!(2));
        assert_eq!(usage["inputTokens"], json!(1200));
        assert_eq!(usage["outputTokens"], json!(250));
        assert_eq!(usage["cacheReadTokens"], json!(30000));
        assert_eq!(usage["reasoningTokens"], json!(50));
        assert_eq!(usage["durationMs"], json!(10000));
        assert_eq!(usage["costUsd"], json!(0.05));
        assert_eq!(usage["servedModels"], json!(["gpt-6.2-sol"]));
    }
}
