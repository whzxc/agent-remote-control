//! One core-owned subscription scheduler. No dependency on ingress or desktop.
mod cache;
mod providers;
pub mod types;
use crate::{agents::AgentHost, control::Control, *};
use providers::{claude, REGISTRY};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use types::*;
struct Slot {
    view: ProviderSnapshot,
    generation: u64,
    due: Instant,
    failures: u32,
    reset_seen: Vec<String>,
    job: Option<tokio::task::AbortHandle>,
}
struct State {
    settings: Settings,
    slots: BTreeMap<String, Slot>,
    revision: u64,
    stopped: bool,
}
pub struct SubscriptionService {
    state: Mutex<State>,
    control: Arc<Control>,
    agents: Arc<AgentHost>,
    changed: tokio::sync::watch::Sender<Snapshot>,
    wake: tokio::sync::Notify,
    permits: Arc<tokio::sync::Semaphore>,
    started: std::sync::atomic::AtomicBool,
    claude_read: Mutex<Option<(String, Reading, String)>>,
}
impl SubscriptionService {
    pub fn new(control: Arc<Control>, agents: Arc<AgentHost>) -> Result<Arc<Self>> {
        let path = root().join("subscriptions/settings.json");
        let settings: Settings = if path.exists() {
            serde_json::from_value(load(&path)?).map_err(|_| "invalid subscription settings")?
        } else {
            Settings::default()
        };
        validate(&settings)?;
        let mut slots: BTreeMap<String, Slot> = REGISTRY
            .iter()
            .map(|r| {
                (
                    r.id.into(),
                    Slot {
                        view: ProviderSnapshot {
                            provider_id: r.id.into(),
                            agent_id: r.agent.into(),
                            agent_ids: associated_agents(&settings, r.id),
                            name: r.name.into(),
                            eligible: false,
                            state: "idle".into(),
                            refreshing: false,
                            raw_usage: Value::Null,
                            observed_at: None,
                            last_attempt_at: None,
                            windows: vec![],
                            display_window_id: None,
                            account_blocked: None,
                            blocked_pool_ids: vec![],
                            source: None,
                            error: None,
                            has_credential: r.accepts_key
                                && providers::credential_path(r.id).is_file(),
                            accepts_key: r.accepts_key,
                            credential_source: if r.accepts_key
                                && providers::credential_path(r.id).is_file()
                            {
                                Some("saved-key".into())
                            } else {
                                None
                            },
                        },
                        generation: 0,
                        due: Instant::now(),
                        failures: 0,
                        reset_seen: vec![],
                        job: None,
                    },
                )
            })
            .collect();
        // Serve the last successful reading before potentially slow Agent discovery.
        // Inventory reconciles eligibility in the background; cached values remain stale.
        for slot in slots.values_mut() {
            cache::restore(slot);
            slot.view.eligible = slot.view.observed_at.is_some();
        }
        let initial = Snapshot {
            instance_id: id(),
            revision: 0,
            settings: settings.clone(),
            providers: vec![],
        };
        let service = Arc::new(Self {
            state: Mutex::new(State {
                settings,
                slots,
                revision: 0,
                stopped: false,
            }),
            control,
            agents,
            changed: tokio::sync::watch::channel(initial).0,
            wake: tokio::sync::Notify::new(),
            permits: Arc::new(tokio::sync::Semaphore::new(3)),
            started: false.into(),
            claude_read: Mutex::new(None),
        });
        Ok(service)
    }
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<Snapshot> {
        self.changed.subscribe()
    }
    pub fn start(self: &Arc<Self>) {
        if self.started.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut inventory_due = Instant::now();
            let mut reason = crate::runtime_metrics::cost::Reason::Startup;
            loop {
                let Some(s) = weak.upgrade() else { return };
                if s.state.lock().await.stopped {
                    return;
                }
                let enabled = crate::runtime_metrics::cost::scope(
                    crate::runtime_metrics::cost::Owner::Subscriptions,
                    reason,
                    async {
                        if Instant::now() >= inventory_due {
                            let inventory = s.agents.ui_inventory(false).await;
                            s.inventory(&inventory).await;
                            inventory_due = Instant::now() + Duration::from_secs(180);
                        } else if let Some(inventory) =
                            s.agents.cached_subscription_inventory().await
                        {
                            s.inventory(&inventory).await;
                        }
                        let (enabled, ids) = {
                            let mut state = s.state.lock().await;
                            let enabled = state.settings.enabled;
                            let mut ids = vec![];
                            crate::runtime_metrics::cost::scan_set(state.slots.len());
                            for (id, slot) in &mut state.slots {
                                crate::runtime_metrics::cost::rows(1);
                                expire(slot);
                                if enabled && slot.view.eligible && slot.job.is_none() {
                                    let reset = slot
                                        .view
                                        .windows
                                        .iter()
                                        .filter_map(|w| w.resets_at.as_ref())
                                        .find(|r| {
                                            chrono::DateTime::parse_from_rfc3339(r)
                                                .is_ok_and(|d| d <= chrono::Utc::now())
                                                && !slot.reset_seen.contains(r)
                                        })
                                        .cloned();
                                    if let Some(reset) = reset {
                                        slot.reset_seen.push(reset);
                                        slot.due = slot.due.min(Instant::now());
                                    }
                                    if slot.due <= Instant::now() {
                                        ids.push(id.clone())
                                    }
                                }
                            }
                            s.publish(&mut state);
                            (enabled, ids)
                        };
                        for id in ids {
                            s.refresh(&id).await;
                        }
                        enabled
                    },
                )
                .await;
                if enabled {
                    tokio::select! {_=s.wake.notified()=>reason = crate::runtime_metrics::cost::Reason::Event,_=tokio::time::sleep(Duration::from_secs(5))=>reason = crate::runtime_metrics::cost::Reason::Timer}
                } else {
                    s.wake.notified().await;
                    reason = crate::runtime_metrics::cost::Reason::Event;
                }
            }
        });
    }
    pub async fn inventory(&self, inventory: &Value) {
        let mut state = self.state.lock().await;
        for slot in state.slots.values_mut() {
            let agents = inventory["agents"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|r| slot.view.agent_ids.iter().any(|id| r["agent"] == *id))
                .collect::<Vec<_>>();
            let standalone = providers::standalone_available(&slot.view.provider_id);
            let eligible = if agents.is_empty() {
                standalone
            } else {
                agents
                    .into_iter()
                    .any(|r| r["enabled"] == true && (r["installed"] == true || standalone))
            };
            if slot.view.eligible != eligible {
                slot.view.eligible = eligible;
                invalidate(slot);
                if eligible {
                    cache::restore(slot);
                } else {
                    cache::remove(&slot.view.provider_id);
                }
            }
        }
        self.publish(&mut state);
    }
    fn publish(&self, state: &mut State) {
        let mut rows: Vec<_> = REGISTRY
            .iter()
            .map(|r| state.slots[r.id].view.clone())
            .collect();
        for p in &mut rows {
            p.windows.retain(active);
            let valid: Vec<_> = p
                .windows
                .iter()
                .filter(|w| {
                    matches!(
                        w.label.as_str(),
                        "weekly"
                            | "weekly_all"
                            | "weekly_scoped"
                            | "seven_day"
                            | "10080 min"
                            | "604800 s"
                    ) || w.label.starts_with("seven_day_")
                })
                .collect();
            let pool = REGISTRY
                .iter()
                .find(|r| r.id == p.provider_id)
                .unwrap()
                .default_pool;
            let default = if valid.iter().any(|w| w.pool_id == pool) {
                Some(pool)
            } else {
                valid.iter().map(|w| w.pool_id.as_str()).min()
            };
            p.display_window_id = valid
                .iter()
                .filter(|w| Some(w.pool_id.as_str()) == default)
                .copied()
                .min_by(|a, b| {
                    b.used_percent
                        .total_cmp(&a.used_percent)
                        .then(a.id.cmp(&b.id))
                })
                .map(|w| w.id.clone());
        }
        let previous = self.changed.borrow();
        if serde_json::to_value(&rows).ok() == serde_json::to_value(&previous.providers).ok()
            && state.settings == previous.settings
        {
            return;
        }
        let instance = previous.instance_id.clone();
        drop(previous);
        state.revision += 1;
        self.changed.send_replace(Snapshot {
            instance_id: instance,
            revision: state.revision,
            settings: state.settings.clone(),
            providers: rows,
        });
    }
    pub async fn snapshot(&self) -> Value {
        let mut state = self.state.lock().await;
        for slot in state.slots.values_mut() {
            expire(slot)
        }
        self.publish(&mut state);
        serde_json::to_value(self.changed.borrow().clone()).unwrap()
    }
    pub async fn stop(&self) {
        let mut state = self.state.lock().await;
        state.stopped = true;
        for s in state.slots.values_mut() {
            invalidate(s)
        }
        self.publish(&mut state);
        self.wake.notify_one();
    }
    pub async fn request(
        self: &Arc<Self>,
        route: &str,
        method: &str,
        body: Value,
    ) -> Result<Value> {
        match (route, method) {
            ("subscriptions", "GET") => Ok(self.snapshot().await),
            ("subscriptions/settings", "PUT") => {
                let settings: Settings =
                    serde_json::from_value(body).map_err(|_| "invalid subscription settings")?;
                validate(&settings)?;
                let mut state = self.state.lock().await;
                save(
                    &root().join("subscriptions/settings.json"),
                    &serde_json::to_value(&settings).unwrap(),
                )?;
                let enabled_changed = state.settings.enabled != settings.enabled;
                let interval_changed = state.settings.refresh_minutes != settings.refresh_minutes;
                for (id, slot) in &mut state.slots {
                    slot.view.agent_ids = associated_agents(&settings, id);
                    if interval_changed && slot.view.error.is_none() {
                        slot.due =
                            Instant::now() + Duration::from_secs(settings.refresh_minutes * 60);
                    }
                    if enabled_changed {
                        invalidate(slot)
                    }
                    if !settings.enabled {
                        cache::remove(id);
                    }
                }
                state.settings = settings;
                self.publish(&mut state);
                drop(state);
                self.wake.notify_one();
                Ok(self.snapshot().await)
            }
            ("subscriptions/refresh", "POST") => {
                let ids = {
                    let state = self.state.lock().await;
                    if let Some(id) = body["providerId"].as_str() {
                        let slot = state.slots.get(id).ok_or("unknown subscription provider")?;
                        if !slot.view.eligible {
                            return Err("provider is not eligible".into());
                        }
                        vec![id.to_owned()]
                    } else {
                        state
                            .slots
                            .iter()
                            .filter(|(_, s)| s.view.eligible)
                            .map(|(id, _)| id.clone())
                            .collect()
                    }
                };
                for id in ids {
                    self.refresh(&id).await;
                }
                Ok(json!({"accepted":true,"revision":self.changed.borrow().revision}))
            }
            ("subscriptions/credentials", "PUT") => {
                let id = string(&body, "providerId");
                if !REGISTRY.iter().any(|r| r.id == id && r.accepts_key) {
                    return Err("provider does not accept a key".into());
                }
                let mut state = self.state.lock().await;
                let path = providers::credential_path(id);
                match string(&body, "action") {
                    "set" => {
                        let key = string(&body, "key").trim();
                        if key.is_empty()
                            || key.len() > 8192
                            || !key.bytes().all(|b| b.is_ascii_graphic())
                        {
                            return Err("invalid subscription key".into());
                        }
                        save(&path, &json!({"key":key}))?;
                    }
                    "clear" => {
                        if path.exists() {
                            std::fs::remove_file(&path)
                                .map_err(|_| "could not clear subscription key")?;
                        }
                    }
                    _ => return Err("explicit set or clear required".into()),
                }
                let slot = state.slots.get_mut(id).unwrap();
                invalidate(slot);
                cache::remove(id);
                slot.view.has_credential = path.is_file();
                slot.view.credential_source = if slot.view.has_credential {
                    Some("saved-key".into())
                } else {
                    None
                };
                self.publish(&mut state);
                drop(state);
                self.wake.notify_one();
                Ok(self.snapshot().await)
            }
            _ => Err("unknown subscription route".into()),
        }
    }
    pub(crate) async fn refresh_claude_profile(&self, profile: &str, force: bool) -> Result<()> {
        let mut recent = self.claude_read.lock().await;
        let account = crate::accounts::profile_account(profile)?;
        if !force && is_recent(account["quota"]["observedAt"].as_str(), 180) {
            return Ok(());
        }
        let result = claude::read_profile(profile).await;
        let observed = now();
        crate::accounts::save_claude_quota(profile, profile_quota(&result, &observed))?;
        if crate::accounts::claude_default_signed_in_profile()?.as_deref() == Some(profile) {
            if let Ok(reading) = result {
                let mut state = self.state.lock().await;
                if !state.stopped {
                    let interval = state.settings.refresh_minutes;
                    let slot = state.slots.get_mut("claude-code").unwrap();
                    // A queued scheduler job must not replace this fresher reading.
                    slot.generation += 1;
                    if let Some(job) = slot.job.take() {
                        job.abort();
                    }
                    slot.view.refreshing = false;
                    slot.view.last_attempt_at = Some(observed.clone());
                    slot.due = Instant::now() + Duration::from_secs(interval * 60);
                    apply_reading(slot, reading.clone(), "claude-profile", observed.clone());
                    self.publish(&mut state);
                }
                *recent = Some((profile.into(), reading, observed));
            }
        }
        Ok(())
    }

    async fn read_claude(
        &self,
        recent: &mut Option<(String, Reading, String)>,
    ) -> std::result::Result<ResolvedReading, Failure> {
        let default = claude::read().await;
        resolve_claude(default, || async move {
            let profile = crate::accounts::claude_default_signed_in_profile().ok()??;
            if let Some((id, reading, observed)) = recent.as_ref() {
                if id == &profile && is_recent(Some(observed), 180) {
                    return Some(Ok((reading.clone(), "claude-profile", observed.clone())));
                }
            }
            let result = claude::read_profile(&profile).await;
            let observed = now();
            if let Err(error) =
                crate::accounts::save_claude_quota(&profile, profile_quota(&result, &observed))
            {
                crate::logs::record("WARN", &error, None);
            }
            Some(result.map(|reading| {
                *recent = Some((profile, reading.clone(), observed.clone()));
                (reading, "claude-profile", observed)
            }))
        })
        .await
    }

    async fn refresh(self: &Arc<Self>, id: &str) {
        let mut state = self.state.lock().await;
        if state.stopped {
            return;
        }
        let Some(slot) = state.slots.get_mut(id) else {
            return;
        };
        if slot.job.is_some() || !slot.view.eligible {
            return;
        }
        if slot
            .view
            .error
            .as_ref()
            .and_then(|e| e.retry_at.as_ref())
            .is_some_and(|r| {
                chrono::DateTime::parse_from_rfc3339(r).is_ok_and(|d| d > chrono::Utc::now())
            })
        {
            return;
        }
        let generation = slot.generation;
        slot.view.refreshing = true;
        slot.view.last_attempt_at = Some(now());
        let s = self.clone();
        let id = id.to_owned();
        let job = tokio::spawn(async move {
            let Ok(_permit) = s.permits.clone().acquire_owned().await else {
                return;
            };
            let mut claude = if id == "claude-code" {
                Some(s.claude_read.lock().await)
            } else {
                None
            };
            let result = tokio::time::timeout(Duration::from_secs(120), async {
                if let Some(recent) = claude.as_deref_mut() {
                    s.read_claude(recent).await
                } else {
                    providers::read(&id, &s.control)
                        .await
                        .map(|(reading, source)| (reading, source, now()))
                }
            })
            .await
            .unwrap_or_else(|_| Err("network-error".into()));
            let mut state = s.state.lock().await;
            let refresh_minutes = state.settings.refresh_minutes;
            let slot = state.slots.get_mut(&id).unwrap();
            if slot.generation != generation {
                return;
            }
            slot.job = None;
            slot.view.refreshing = false;
            slot.due = Instant::now() + Duration::from_secs(refresh_minutes * 60);
            match result {
                Ok((reading, source, observed)) => apply_reading(slot, reading, source, observed),
                Err(error) => {
                    slot.failures += 1;
                    slot.view.has_credential = error.code != "credentials-missing";
                    slot.view.state = if slot.view.windows.is_empty() {
                        "unavailable"
                    } else {
                        "stale"
                    }
                    .into();
                    slot.due = Instant::now()
                        + Duration::from_secs(
                            (60u64.saturating_mul(1 << slot.failures.min(5))).min(1800),
                        );
                    slot.view.error = Some(error);
                }
            }
            expire(slot);
            s.publish(&mut state);
        });
        slot.job = Some(job.abort_handle());
        self.publish(&mut state);
    }
}
type ResolvedReading = (Reading, &'static str, String);

async fn resolve_claude<F>(
    default: std::result::Result<Reading, Failure>,
    profile: impl FnOnce() -> F,
) -> std::result::Result<ResolvedReading, Failure>
where
    F: std::future::Future<Output = Option<std::result::Result<ResolvedReading, Failure>>>,
{
    let failure = match default {
        Ok(reading) if !reading.windows.is_empty() => return Ok((reading, "claude-login", now())),
        Ok(_) => Failure::from("no-limits-reported"),
        Err(error) if matches!(error.code, "no-limits-reported" | "credentials-missing") => error,
        Err(error) => return Err(error),
    };
    profile().await.unwrap_or(Err(failure))
}

fn is_recent(at: Option<&str>, seconds: i64) -> bool {
    at.and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .is_some_and(|at| chrono::Utc::now().signed_duration_since(at).num_seconds() < seconds)
}

fn profile_quota(result: &std::result::Result<Reading, Failure>, observed: &str) -> Value {
    match result {
        Ok(reading) => {
            json!({"state":"ready","source":"claude-profile","observedAt":observed,"windows":reading.windows,"accountBlocked":reading.account_blocked,"blockedPoolIds":reading.blocked_pool_ids})
        }
        Err(error) => {
            json!({"state":"unavailable","source":"claude-profile","observedAt":observed,"windows":[],"error":error})
        }
    }
}

fn apply_reading(slot: &mut Slot, reading: Reading, source: &str, observed: String) {
    slot.view.has_credential = true;
    slot.view.credential_source = Some(source.into());
    slot.view.source = Some(source.into());
    slot.view.windows = reading.windows;
    slot.view.raw_usage = reading.raw_usage;
    slot.view.account_blocked = reading.account_blocked;
    slot.view.blocked_pool_ids = reading.blocked_pool_ids;
    slot.view.observed_at = Some(observed);
    slot.view.state = "ready".into();
    slot.view.error = None;
    slot.failures = 0;
    cache::persist(slot);
}

fn clear_reading(view: &mut ProviderSnapshot) {
    view.windows.clear();
    view.observed_at = None;
    view.raw_usage = Value::Null;
    view.account_blocked = None;
    view.blocked_pool_ids.clear();
    view.display_window_id = None;
}
fn invalidate(s: &mut Slot) {
    s.generation += 1;
    if let Some(job) = s.job.take() {
        job.abort()
    }
    clear_reading(&mut s.view);
    s.view.refreshing = false;
    s.view.state = "idle".into();
    s.view.error = None;
    s.failures = 0;
    s.due = Instant::now();
    s.reset_seen.clear();
}
fn expire(slot: &mut Slot) {
    if expire_view(&mut slot.view, chrono::Utc::now()) {
        cache::remove(&slot.view.provider_id);
    }
}

fn expire_view(view: &mut ProviderSnapshot, now: chrono::DateTime<chrono::Utc>) -> bool {
    let age = view
        .observed_at
        .as_deref()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map(|at| now.signed_duration_since(at).num_seconds());
    if view.error.is_some() && age.is_some_and(|age| age >= 24 * 60 * 60) {
        clear_reading(view);
        view.state = "unavailable".into();
        return true;
    }
    if age.is_some_and(|age| age >= 900) && view.state == "ready" {
        view.state = "stale".into();
    }
    false
}

fn associated_agents(settings: &Settings, provider: &str) -> Vec<String> {
    let registration = REGISTRY.iter().find(|r| r.id == provider).unwrap();
    let mut agents: Vec<String> = settings
        .agent_providers
        .iter()
        .filter(|(_, providers)| providers.iter().any(|id| id == provider))
        .map(|(agent, _)| agent.clone())
        .collect();
    if !settings.agent_providers.contains_key(registration.agent)
        && crate::agents::capabilities::default_quota_provider(registration.agent) == Some(provider)
    {
        agents.push(registration.agent.into());
    }
    agents
}

fn validate(s: &Settings) -> Result<()> {
    for (agent, providers) in &s.agent_providers {
        if agent.trim().is_empty()
            || providers
                .iter()
                .any(|id| !REGISTRY.iter().any(|r| r.id == id))
        {
            return Err("invalid agent provider association".into());
        }
    }

    if ![1, 3, 5, 10].contains(&s.refresh_minutes) {
        return Err("invalid subscription refresh interval".into());
    }
    Ok(())
}

/// Preserve only native allowance facts needed for advisory dispatch decisions.
pub(crate) fn codex_dispatch_quota(value: &Value) -> Value {
    let pools: Vec<_> = if let Some(map) = value["rateLimitsByLimitId"].as_object() {
        map.iter().map(|(id, pool)| (id.as_str(), pool)).collect()
    } else if value["rateLimits"].is_object() {
        vec![(
            value["rateLimits"]["limitId"].as_str().unwrap_or("codex"),
            &value["rateLimits"],
        )]
    } else {
        vec![]
    };
    json!({"ordinaryUsageAllowed":value["ordinaryUsageAllowed"],"pools":pools.into_iter().map(|(id, pool)| {
        let mut projected = json!({"id":id});
        for key in ["rateLimitReachedType","spendControlReached","credits"] {
            if !pool[key].is_null() { projected[key] = pool[key].clone(); }
        }
        for slot in ["primary","secondary"] {
            if pool[slot].is_object() {
                let window = pool[slot].as_object().unwrap();
                projected[slot] = Value::Object(["usedPercent","windowDurationMins","resetsAt"].into_iter()
                    .filter_map(|key| window.get(key).filter(|v| !v.is_null()).map(|v| (key.to_owned(),v.clone()))).collect());
            }
        }
        projected
    }).collect::<Vec<_>>()})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn claude_uses_profile_when_native_default_has_no_quota() {
        // Contract: Claude fallback readings identify their signed-in profile source
        for code in ["credentials-missing", "no-limits-reported"] {
            let (reading, source, observed) = resolve_claude(Err(code.into()), || async {
                let reading = Reading::new(
                    vec![window("weekly", "subscription", "seven_day", Some(32.), None).unwrap()],
                    json!({}),
                )
                .unwrap();
                Some(Ok((reading, "claude-profile", now())))
            })
            .await
            .unwrap();
            let quota = profile_quota(&Ok(reading), &observed);
            assert_eq!(source, "claude-profile");
            assert_eq!(quota["state"], "ready");
            assert_eq!(quota["source"], source);
            assert_eq!(quota["windows"][0]["usedPercent"], 32.);
            assert_eq!(quota["observedAt"], observed);
        }
    }

    #[test]
    fn old_windows_expire_during_provider_errors() {
        // Recurring bug class: persistence expired weekly quota without a reset timestamp remained visible after provider failures.
        let now = chrono::Utc::now();
        let mut view = ProviderSnapshot {
            provider_id: "claude-code".into(),
            agent_id: "claude".into(),
            agent_ids: vec!["claude".into()],
            name: "Claude".into(),
            eligible: true,
            state: "stale".into(),
            refreshing: false,
            raw_usage: json!({"cliUsage":"Fixture"}),
            observed_at: Some((now - chrono::Duration::hours(23)).to_rfc3339()),
            last_attempt_at: None,
            windows: vec![window("weekly", "subscription", "seven_day", Some(23.), None).unwrap()],
            display_window_id: Some("weekly".into()),
            account_blocked: None,
            blocked_pool_ids: vec![],
            source: Some("claude-profile".into()),
            error: Some("request-failed".into()),
            has_credential: true,
            accepts_key: false,
            credential_source: None,
        };
        assert!(!expire_view(&mut view, now));
        assert_eq!(view.windows.len(), 1);
        assert!(expire_view(&mut view, now + chrono::Duration::hours(1)));
        assert!(view.windows.is_empty());
        assert!(view.display_window_id.is_none());
        assert_eq!(view.state, "unavailable");
        assert_eq!(view.error.unwrap().code, "request-failed");
    }
}
