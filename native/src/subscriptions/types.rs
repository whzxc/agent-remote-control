use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    #[serde(default = "default_refresh_minutes")]
    pub refresh_minutes: u64,
    pub providers: Vec<String>,
    pub pinned_windows: BTreeMap<String, String>,
}
fn default_refresh_minutes() -> u64 {
    3
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            refresh_minutes: default_refresh_minutes(),
            providers: super::providers::REGISTRY
                .iter()
                .map(|r| r.id.to_owned())
                .collect(),
            pinned_windows: BTreeMap::new(),
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub id: String,
    pub pool_id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub used_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exhausted: Option<bool>,
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<String>,
}
impl From<&'static str> for Failure {
    fn from(code: &'static str) -> Self {
        Self {
            code,
            message: None,
            retry_at: None,
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    pub provider_id: String,
    pub agent_id: String,
    pub name: String,
    pub eligible: bool,
    pub selected: bool,
    pub state: String,
    pub refreshing: bool,
    pub raw_usage: serde_json::Value,
    pub observed_at: Option<String>,
    pub last_attempt_at: Option<String>,
    pub windows: Vec<QuotaWindow>,
    pub display_window_id: Option<String>,
    pub account_blocked: Option<bool>,
    pub blocked_pool_ids: Vec<String>,
    pub source: Option<String>,
    pub error: Option<Failure>,
    pub has_credential: bool,
    pub accepts_key: bool,
    pub credential_source: Option<String>,
    pub pin_unavailable: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub instance_id: String,
    pub revision: u64,
    pub settings: Settings,
    pub providers: Vec<ProviderSnapshot>,
}
pub struct Reading {
    pub windows: Vec<QuotaWindow>,
    pub raw_usage: serde_json::Value,
    pub account_blocked: Option<bool>,
    pub blocked_pool_ids: Vec<String>,
}
impl Reading {
    pub fn new(windows: Vec<QuotaWindow>, raw_usage: serde_json::Value) -> Result<Self, Failure> {
        if windows.is_empty() && !raw_usage.is_object() {
            Err("no-limits-reported".into())
        } else {
            Ok(Self {
                windows,
                raw_usage,
                account_blocked: None,
                blocked_pool_ids: vec![],
            })
        }
    }
}
pub fn date(v: &serde_json::Value) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(v.as_str()?)
        .ok()
        .map(|v| v.with_timezone(&chrono::Utc).to_rfc3339())
}
pub fn number(v: &serde_json::Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str()?.parse().ok())
        .filter(|n| n.is_finite() && *n >= 0.)
}
pub fn window(
    id: &str,
    pool: &str,
    label: &str,
    percent: Option<f64>,
    reset: Option<String>,
) -> Option<QuotaWindow> {
    Some(QuotaWindow {
        id: id.into(),
        pool_id: pool.into(),
        label: label.into(),
        scope: None,
        used_percent: percent.filter(|n| n.is_finite() && *n >= 0.)?,
        resets_at: reset,
        exhausted: None,
    })
}
pub fn active(w: &QuotaWindow) -> bool {
    w.resets_at.as_ref().is_none_or(|v| {
        chrono::DateTime::parse_from_rfc3339(v).is_ok_and(|d| d > chrono::Utc::now())
    })
}
