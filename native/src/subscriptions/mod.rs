//! One core-owned subscription scheduler. No dependency on ingress or desktop.
mod cache;
mod providers;
pub mod types;
use crate::{agents::AgentHost, control::Control, *};
use providers::REGISTRY;
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
}
impl SubscriptionService {
    pub fn new(control: Arc<Control>, agents: Arc<AgentHost>) -> Result<Arc<Self>> {
        let path = root().join("subscriptions/settings.json");
        let mut settings: Settings = if path.exists() {
            serde_json::from_value(load(&path)?).map_err(|_| "invalid subscription settings")?
        } else {
            Settings::default()
        };
        // Repair the former first-run defaults, which had no UI path to enable monitoring.
        if !settings.enabled && settings.providers.is_empty() {
            settings.enabled = true;
            settings.providers = Settings::default().providers;
            save(&path, &serde_json::to_value(&settings).unwrap())?;
        }
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
                            name: r.name.into(),
                            eligible: false,
                            selected: settings.providers.iter().any(|id| id == r.id),
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
                            pin_unavailable: false,
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
        for slot in slots.values_mut().filter(|slot| slot.view.selected) {
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
            loop {
                let Some(s) = weak.upgrade() else { return };
                if s.state.lock().await.stopped {
                    return;
                }
                if Instant::now() >= inventory_due {
                    let inventory = s.agents.ui_inventory(false).await;
                    s.inventory(&inventory).await;
                    inventory_due = Instant::now() + Duration::from_secs(180);
                } else if let Some(inventory) = s.agents.cached_subscription_inventory().await {
                    s.inventory(&inventory).await;
                }
                let (enabled, ids) = {
                    let mut state = s.state.lock().await;
                    let enabled = state.settings.enabled;
                    let mut ids = vec![];
                    for (id, slot) in &mut state.slots {
                        expire(slot);
                        if enabled && slot.view.selected && slot.view.eligible && slot.job.is_none()
                        {
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
                if enabled {
                    tokio::select! {_=s.wake.notified()=>{},_=tokio::time::sleep(Duration::from_secs(5))=>{}}
                } else {
                    s.wake.notified().await;
                }
            }
        });
    }
    pub async fn agent_enabled(&self, agent: &str, enabled: bool) -> Result<()> {
        let mut state = self.state.lock().await;
        let ids: Vec<String> = state
            .slots
            .iter()
            .filter(|(_, slot)| slot.view.agent_id == agent)
            .map(|(id, _)| id.clone())
            .collect();
        let mut settings = state.settings.clone();
        settings.providers.retain(|id| !ids.contains(id));
        for id in &ids {
            settings.pinned_windows.remove(id);
        }
        if enabled {
            settings.providers.extend(ids.iter().cloned());
        }
        save(
            &root().join("subscriptions/settings.json"),
            &serde_json::to_value(&settings).unwrap(),
        )?;
        state.settings = settings;
        for id in &ids {
            if let Some(slot) = state.slots.get_mut(id) {
                slot.view.selected = enabled;
                invalidate(slot);
                if !enabled {
                    cache::remove(id);
                }
            }
        }
        self.publish(&mut state);
        drop(state);
        self.wake.notify_one();
        Ok(())
    }
    pub async fn inventory(&self, inventory: &Value) {
        let mut state = self.state.lock().await;
        for slot in state.slots.values_mut() {
            let eligible = inventory["agents"].as_array().is_some_and(|rows| {
                rows.iter().any(|r| {
                    r["agent"] == slot.view.agent_id
                        && r["enabled"] == true
                        && (r["installed"] == true
                            || providers::standalone_available(&slot.view.provider_id))
                })
            });
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
        rows.sort_by_key(|p| {
            state
                .settings
                .providers
                .iter()
                .position(|id| *id == p.provider_id)
                .unwrap_or(usize::MAX)
        });
        for p in &mut rows {
            let pin = state.settings.pinned_windows.get(&p.provider_id);
            let valid: Vec<_> = p.windows.iter().filter(|w| active(w)).collect();
            let pinned = pin.and_then(|pin| valid.iter().find(|w| w.id == *pin).copied());
            p.pin_unavailable = pin.is_some() && pinned.is_none();
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
            p.display_window_id = pinned
                .or_else(|| {
                    valid
                        .iter()
                        .filter(|w| Some(w.pool_id.as_str()) == default)
                        .copied()
                        .min_by(|a, b| {
                            b.used_percent
                                .total_cmp(&a.used_percent)
                                .then(a.id.cmp(&b.id))
                        })
                })
                .map(|w| w.id.clone());
            p.windows.retain(active);
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
                    if interval_changed && slot.view.error.is_none() {
                        slot.due =
                            Instant::now() + Duration::from_secs(settings.refresh_minutes * 60);
                    }
                    let selected = settings.providers.contains(id);
                    if enabled_changed || selected != slot.view.selected {
                        invalidate(slot)
                    }
                    slot.view.selected = selected;
                    if !settings.enabled || !selected {
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
                        if !slot.view.eligible || !slot.view.selected {
                            return Err("provider is not selected or eligible".into());
                        }
                        vec![id.to_owned()]
                    } else {
                        state
                            .slots
                            .iter()
                            .filter(|(_, s)| s.view.selected && s.view.eligible)
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
    async fn refresh(self: &Arc<Self>, id: &str) {
        let mut state = self.state.lock().await;
        if state.stopped {
            return;
        }
        let Some(slot) = state.slots.get_mut(id) else {
            return;
        };
        if slot.job.is_some() || !slot.view.eligible || !slot.view.selected {
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
            let result =
                tokio::time::timeout(Duration::from_secs(120), providers::read(&id, &s.control))
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
                Ok((reading, source)) => {
                    slot.view.has_credential = true;
                    slot.view.credential_source = Some(source.into());
                    slot.view.source = Some(source.into());
                    slot.view.windows = reading.windows;
                    slot.view.raw_usage = reading.raw_usage;
                    slot.view.account_blocked = reading.account_blocked;
                    slot.view.blocked_pool_ids = reading.blocked_pool_ids;
                    slot.view.observed_at = Some(now());
                    slot.view.state = "ready".into();
                    slot.view.error = None;
                    slot.failures = 0;
                    cache::persist(slot);
                }
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
fn clear_reading(s: &mut Slot) {
    s.view.windows.clear();
    s.view.observed_at = None;
    s.view.raw_usage = Value::Null;
    s.view.account_blocked = None;
    s.view.blocked_pool_ids.clear();
    s.view.display_window_id = None;
}
fn invalidate(s: &mut Slot) {
    s.generation += 1;
    if let Some(job) = s.job.take() {
        job.abort()
    }
    clear_reading(s);
    s.view.refreshing = false;
    s.view.state = "idle".into();
    s.view.error = None;
    s.failures = 0;
    s.due = Instant::now();
    s.reset_seen.clear();
}
fn expire(s: &mut Slot) {
    let age = s
        .view
        .observed_at
        .as_ref()
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .map(|d| chrono::Utc::now().signed_duration_since(d).num_seconds());
    if age.is_some_and(|age| age >= 900) && s.view.state == "ready" {
        s.view.state = "stale".into();
    }
}

fn validate(s: &Settings) -> Result<()> {
    if ![1, 3, 5, 10].contains(&s.refresh_minutes) {
        return Err("invalid subscription refresh interval".into());
    }
    let mut seen = std::collections::HashSet::new();
    for id in &s.providers {
        if !REGISTRY.iter().any(|r| r.id == id) || !seen.insert(id) {
            return Err("invalid subscription provider selection".into());
        }
    }
    for (id, pin) in &s.pinned_windows {
        if !REGISTRY.iter().any(|r| r.id == id) || pin.is_empty() || pin.len() > 256 {
            return Err("invalid subscription pin".into());
        }
    }
    Ok(())
}
