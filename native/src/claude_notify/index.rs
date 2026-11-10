//! Derived activity and deadline index. Canonical bindings and retention stay file-owned.
use super::*;
use crate::kernel::file_changes::{physical, Watch};
use crate::runtime_metrics::cost::{self, Owner, Reason};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
type Key = PathBuf;
type Scope = (String, String);

#[derive(Default)]
struct Deadlines {
    times: BTreeSet<(i64, Key)>,
    keys: HashMap<Key, i64>,
}
impl Deadlines {
    fn set(&mut self, key: &Path, at: Option<i64>) {
        if let Some(old) = self.keys.remove(key) {
            self.times.remove(&(old, key.into()));
        }
        if let Some(at) = at {
            self.keys.insert(key.into(), at);
            self.times.insert((at, key.into()));
        }
    }
    fn take(&mut self, now: i64) -> Vec<Key> {
        let mut keys = Vec::new();
        while self.times.first().is_some_and(|(at, _)| *at <= now) {
            let (_, key) = self.times.pop_first().unwrap();
            self.keys.remove(&key);
            keys.push(key);
        }
        keys
    }
    fn next(&self) -> Option<i64> {
        self.times.first().map(|(at, _)| *at)
    }
}
struct Record {
    binding: Arc<Binding>,
    stamp: Option<file_cache::Stamp>,
}
#[derive(Default)]
struct Index {
    rows: BTreeMap<Key, Record>,
    scopes: HashMap<Scope, BTreeSet<(i64, Key)>>,
    threads: HashMap<String, HashSet<Key>>,
    interested: HashMap<String, HashSet<Key>>,
    observing: HashSet<Key>,
    reconciliation: HashSet<Key>,
    dormant: HashSet<Key>,
    pending: HashSet<Key>,
    destinations: HashMap<(String, Channel, String), HashSet<Key>>,
    sources: HashMap<String, HashSet<Key>>,
    controls: Option<Arc<governance::Data>>,
    observation: Deadlines,
    delivery: Deadlines,
    delivery_dirty: HashSet<Key>,
    retention: Deadlines,
    dirty: HashSet<Key>,
    evidence: HashMap<PathBuf, (Option<file_cache::Stamp>, HashSet<Key>)>,
    evidence_keys: HashMap<Key, Vec<PathBuf>>,
    exhausted: HashSet<Key>,
    resumable: HashMap<Scope, Key>,
    watch: Watch,
    repair_after: Option<Key>,
    repair_directory: Option<std::fs::ReadDir>,
    coverage_gap: bool,
    revision: u64,
}
static INDEXES: std::sync::LazyLock<std::sync::Mutex<HashMap<PathBuf, Index>>> =
    std::sync::LazyLock::new(Default::default);
pub(super) static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();
pub(super) static DELIVERY_WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();
fn clock() -> i64 {
    chrono::Utc::now().timestamp()
}
fn scope(b: &Binding) -> Scope {
    (b.source_id.clone(), b.thread_id.clone())
}
impl Index {
    fn seed(dir: &Path) -> Result<Self> {
        cost::sync(Owner::NotificationSeed, Reason::Startup, || {
            private_dir(&dir.join("tasks"))?;
            let mut index = Self::default();
            index.watch.add(&dir.join("tasks/.index-watch"));
            for entry in binding_paths(dir)?
                .iter()
                .filter(|e| e.path.extension().is_some_and(|e| e == "json"))
            {
                cost::rows(1);
                if let Some(b) = shared_binding(&entry.path)? {
                    index.put(dir, b, false);
                }
            }
            cost::scan_set(index.rows.len());
            Ok(index)
        })
    }
    fn latest(&self, b: &Binding) -> Option<&(i64, Key)> {
        self.scopes.get(&scope(b))?.last()
    }
    fn superseded(&self, b: &Binding) -> bool {
        self.latest(b).is_some_and(|(at, _)| *at > b.created_at)
    }
    fn classify(&mut self, key: &Path, at: i64) {
        let Some(row) = self.rows.get(key) else {
            return;
        };
        let b = &row.binding;
        let closed = b.terminal() && (b.scope_end.is_some() || b.continuation_bound);
        let dormant = b.source_id.is_empty() || closed || observer::reusable(b);
        for set in [
            &mut self.observing,
            &mut self.reconciliation,
            &mut self.dormant,
        ] {
            set.remove(key);
        }
        if dormant {
            self.dormant.insert(key.into());
        } else if b.observation["reconciliation"] == "pending-after-restart" {
            self.reconciliation.insert(key.into());
        } else {
            self.observing.insert(key.into());
        }
        self.observation.set(key, (!dormant).then_some(at));
        if observer::exhausted(b) {
            self.exhausted.insert(key.into());
        } else {
            self.exhausted.remove(key);
        }
        let scope_key = scope(b);
        if self.resumable.get(&scope_key).is_some_and(|old| old == key) {
            self.resumable.remove(&scope_key);
        }
        if !closed
            && turn_adapter::push(&b.turn_state()) == Some("interrupted")
            && self.latest(b).is_some_and(|(_, latest)| latest == key)
        {
            self.resumable.insert(scope_key, key.into());
        }
        self.retention.set(
            key,
            expired(
                b,
                b.created_at
                    .saturating_add(RETENTION_SECONDS)
                    .saturating_add(1),
                self.superseded(b),
            )
            .then_some(
                b.created_at
                    .saturating_add(RETENTION_SECONDS)
                    .saturating_add(1),
            ),
        );
        let watchable =
            !closed && (!b.terminal() || self.latest(b).is_some_and(|(_, latest)| latest == key));
        let interested = self.interested.entry(b.thread_id.clone()).or_default();
        if watchable {
            interested.insert(key.into());
        } else {
            interested.remove(key);
            self.unwatch(key);
        }
    }

    fn put(&mut self, dir: &Path, b: Arc<Binding>, changed: bool) {
        let key = path_in(dir, &b.thread_id, &b.turn_id);
        let old_latest = self.latest(&b).map(|(_, key)| key.clone());
        if let Some(old) = self.rows.get(&key) {
            if old.binding == b {
                self.rows.get_mut(&key).unwrap().stamp =
                    file_cache::Stamp::read(&key).ok().flatten();
                return;
            }
            if let Some(set) = self.scopes.get_mut(&scope(&old.binding)) {
                set.remove(&(old.binding.created_at, key.clone()));
            }
        }
        self.scopes
            .entry(scope(&b))
            .or_default()
            .insert((b.created_at, key.clone()));
        self.threads
            .entry(b.thread_id.clone())
            .or_default()
            .insert(key.clone());
        self.unindex_delivery(&key);
        self.rows.insert(
            key.clone(),
            Record {
                binding: b,
                stamp: file_cache::Stamp::read(&key).ok().flatten(),
            },
        );
        self.revision += 1;
        let b = &self.rows[&key].binding;
        let pending = !b.source_id.is_empty()
            && b.deliveries
                .iter()
                .any(|d| matches!(d.status.as_str(), "pending" | "sending"));
        if pending {
            self.pending.insert(key.clone());
            self.sources
                .entry(b.source_id.clone())
                .or_default()
                .insert(key.clone());
            for d in b
                .deliveries
                .iter()
                .filter(|d| matches!(d.status.as_str(), "pending" | "sending"))
            {
                self.destinations
                    .entry((b.source_id.clone(), d.channel, d.target.clone()))
                    .or_default()
                    .insert(key.clone());
            }
            self.delivery.set(&key, Some(0));
            if changed {
                DELIVERY_WAKE.notify_one();
            }
        } else {
            self.pending.remove(&key);
            self.delivery_dirty.remove(&key);
            self.delivery.set(&key, None);
        }
        self.classify(&key, clock());
        if let Some(old) = old_latest.filter(|old| old != &key) {
            self.classify(&old, clock());
            // A successor is evidence for an exhausted predecessor even when no native event arrives.
            if changed
                && self
                    .latest(&self.rows[&key].binding)
                    .is_some_and(|(_, latest)| latest == &key)
            {
                self.wake_key(&old);
            }
        }
        self.watch_base(&key);
        self.watch_paths(&key, routing::paths(dir, &self.rows[&key].binding));
        if changed {
            WAKE.notify_one();
        }
    }
    fn unindex_delivery(&mut self, key: &Path) {
        if let Some(row) = self.rows.get(key) {
            let b = &row.binding;
            if let Some(keys) = self.sources.get_mut(&b.source_id) {
                keys.remove(key);
                if keys.is_empty() {
                    self.sources.remove(&b.source_id);
                }
            }
            for d in &b.deliveries {
                let destination = (b.source_id.clone(), d.channel, d.target.clone());
                if let Some(keys) = self.destinations.get_mut(&destination) {
                    keys.remove(key);
                    if keys.is_empty() {
                        self.destinations.remove(&destination);
                    }
                }
            }
        }
    }
    fn wake_delivery(&mut self, key: &Path) {
        if self.pending.contains(key) {
            self.delivery_dirty.insert(key.into());
            self.delivery.set(key, Some(0));
            DELIVERY_WAKE.notify_one();
        }
    }
    fn watch_paths(&mut self, key: &Path, paths: Vec<PathBuf>) {
        for path in paths {
            self.watch.add(&path);
            let path = physical(&path);
            self.evidence
                .entry(path.clone())
                .or_insert_with(|| {
                    (
                        file_cache::Stamp::read(&path).ok().flatten(),
                        Default::default(),
                    )
                })
                .1
                .insert(key.into());
            let paths = self.evidence_keys.entry(key.into()).or_default();
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    fn watch_base(&mut self, key: &Path) {
        let Some(row) = self.rows.get(key) else {
            return;
        };
        let thread = row.binding.thread_id.clone();
        if !self
            .interested
            .get(&thread)
            .is_some_and(|keys| keys.contains(key))
        {
            return;
        }
        let mut paths = vec![
            observer::execution_path(&thread),
            root().join("agents/tasks").join(format!("{thread}.json")),
        ];
        if let Ok(path) = crate::writer::lock_path(&thread) {
            paths.push(path);
        }
        self.watch_paths(key, paths);
    }
    fn wake_key(&mut self, key: &Path) {
        if let Some(row) = self.rows.get(key) {
            if row.binding.scope_end.is_none() && !row.binding.continuation_bound {
                self.dirty.insert(key.into());
                self.observation.set(key, Some(clock()));
            }
        }
    }
    fn wake_thread(&mut self, thread: &str) {
        for key in self.interested.get(thread).cloned().unwrap_or_default() {
            self.wake_key(&key);
        }
    }
    fn unwatch(&mut self, key: &Path) {
        for path in self.evidence_keys.remove(key).unwrap_or_default() {
            if let Some((_, keys)) = self.evidence.get_mut(&path) {
                keys.remove(key);
                if keys.is_empty() {
                    self.evidence.remove(&path);
                    self.watch.remove(&path);
                }
            }
        }
    }
    fn remove(&mut self, key: &Path) {
        self.unindex_delivery(key);
        self.unwatch(key);
        self.exhausted.remove(key);
        if let Some(row) = self.rows.remove(key) {
            let b = row.binding;
            if self.resumable.get(&scope(&b)).is_some_and(|old| old == key) {
                self.resumable.remove(&scope(&b));
            }
            self.threads
                .entry(b.thread_id.clone())
                .or_default()
                .remove(key);
            self.interested
                .entry(b.thread_id.clone())
                .or_default()
                .remove(key);
            if let Some(set) = self.scopes.get_mut(&scope(&b)) {
                set.remove(&(b.created_at, key.into()));
            }
            for set in [
                &mut self.observing,
                &mut self.reconciliation,
                &mut self.dormant,
                &mut self.pending,
                &mut self.delivery_dirty,
                &mut self.dirty,
            ] {
                set.remove(key);
            }
            for queue in [
                &mut self.observation,
                &mut self.delivery,
                &mut self.retention,
            ] {
                queue.set(key, None);
            }
            let latest = self
                .scopes
                .get(&scope(&b))
                .and_then(|set| set.last())
                .map(|(_, key)| key.clone());
            if let Some(latest) = latest {
                self.classify(&latest, clock());
            } else {
                self.scopes.remove(&scope(&b));
            }
            self.revision += 1;
        }
    }
    fn refresh(&mut self, dir: &Path) -> Result<()> {
        let (paths, failed) = self.watch.drain();
        self.coverage_gap = failed;
        for path in paths {
            if path.parent() == Some(physical(&dir.join("tasks")).as_path())
                && path.extension().is_some_and(|e| e == "json")
            {
                let key = dir.join("tasks").join(path.file_name().unwrap());
                self.refresh_binding(dir, &key)?;
            }
            if let Some((stamp, keys)) = self.evidence.get_mut(&path) {
                let current = file_cache::Stamp::read(&path)?;
                if *stamp != current {
                    *stamp = current;
                    let keys = keys.clone();
                    for key in keys {
                        self.wake_delivery(&key);
                        self.wake_key(&key);
                    }
                }
            }
        }
        if failed {
            cost::sync(Owner::IndexRepair, Reason::Dirty, || -> Result<()> {
                // Explicit bounded repair; never hide a history sweep in a normal pass.
                use std::ops::Bound::{Excluded, Unbounded};
                let keys: Vec<_> = self
                    .rows
                    .range((
                        self.repair_after.clone().map_or(Unbounded, Excluded),
                        Unbounded,
                    ))
                    .take(32)
                    .map(|(key, _)| key.clone())
                    .collect();
                self.repair_after = keys.last().cloned();
                for key in keys {
                    cost::rows(1);
                    self.refresh_binding(dir, &key)?;
                    self.wake_key(&key);
                }
                for key in crate::kernel::file_changes::repair_paths(
                    &dir.join("tasks"),
                    &mut self.repair_directory,
                    32,
                )? {
                    cost::rows(1);
                    if key.extension().is_some_and(|ext| ext == "json") {
                        self.refresh_binding(dir, &key)?;
                    }
                }
                Ok(())
            })?;
        }
        Ok(())
    }
    fn refresh_binding(&mut self, dir: &Path, key: &Path) -> Result<()> {
        let stamp = file_cache::Stamp::read(key)?;
        if self.rows.get(key).is_some_and(|row| row.stamp == stamp) {
            return Ok(());
        }
        if stamp.is_none() {
            self.remove(key);
        } else if let Some(b) = shared_binding(key)? {
            self.put(dir, b, true);
            self.wake_key(key);
        } else {
            self.remove(key);
        }
        Ok(())
    }
}
fn with<T>(dir: &Path, f: impl FnOnce(&mut Index) -> Result<T>) -> Result<T> {
    let mut indexes = INDEXES.lock().map_err(|e| e.to_string())?;
    if !indexes.contains_key(dir) {
        indexes.insert(dir.into(), Index::seed(dir)?);
    }
    f(indexes.get_mut(dir).unwrap())
}
pub(super) fn updated(dir: &Path, b: &Binding) {
    if let Ok(mut indexes) = INDEXES.lock() {
        if let Some(index) = indexes.get_mut(dir) {
            index.put(dir, Arc::new(b.clone()), true);
        }
    }
}
pub(super) fn removed(dir: &Path, key: &Path) {
    if let Ok(mut indexes) = INDEXES.lock() {
        if let Some(index) = indexes.get_mut(dir) {
            index.remove(key);
        }
    }
}
pub(crate) fn native_changed(thread: &str) {
    if let Ok(mut indexes) = INDEXES.lock() {
        for index in indexes.values_mut() {
            index.wake_thread(thread);
        }
    }
    WAKE.notify_one();
}
pub(super) fn read_key(dir: &Path, thread: &str, turn: &str) -> Result<()> {
    with(dir, |index| {
        index.wake_key(&path_in(dir, thread, turn));
        Ok(())
    })?;
    WAKE.notify_one();
    Ok(())
}
pub(super) fn all(dir: &Path) -> Result<Arc<Vec<Arc<Binding>>>> {
    with(dir, |index| {
        index.refresh(dir)?;
        cost::rows(index.rows.len());
        Ok(Arc::new(
            index.rows.values().map(|row| row.binding.clone()).collect(),
        ))
    })
}
pub(super) fn thread(dir: &Path, thread: &str) -> Result<Vec<Binding>> {
    with(dir, |index| {
        Ok(index
            .threads
            .get(thread)
            .into_iter()
            .flatten()
            .filter_map(|key| index.rows.get(key))
            .map(|row| (*row.binding).clone())
            .collect())
    })
}
pub(super) fn observation_due(dir: &Path, now: i64) -> Result<Vec<(Arc<Binding>, bool, bool)>> {
    with(dir, |index| {
        index.refresh(dir)?;
        let keys: BTreeSet<_> = index
            .observation
            .take(now)
            .into_iter()
            .chain(index.retention.take(now))
            .collect();
        // Claim with a retry deadline: a persistence error must not strand the rest of this batch.
        for key in &keys {
            if index
                .rows
                .get(key)
                .is_some_and(|row| !row.binding.source_id.is_empty())
            {
                index.observation.set(key, Some(now.saturating_add(2)));
            }
        }
        cost::scan_set(keys.len());
        cost::bindings(
            index.rows.len(),
            index.observing.len() + index.reconciliation.len(),
            index.dormant.len(),
        );
        Ok(keys
            .into_iter()
            .filter_map(|key| {
                let row = index.rows.get(&key)?;
                cost::rows(1);
                Some((
                    row.binding.clone(),
                    index.dirty.remove(&key),
                    index.superseded(&row.binding),
                ))
            })
            .collect())
    })
}
pub(super) fn finish(
    dir: &Path,
    thread: &str,
    turn: &str,
    watch: Option<&observer::TerminalWatch>,
) -> Result<()> {
    with(dir, |index| {
        let key = path_in(dir, thread, turn);
        index.classify(&key, clock() + 2);
        if index.dirty.contains(&key) {
            index.observation.set(&key, Some(clock()));
        }
        if let Some(watch) = watch.filter(|_| {
            index
                .interested
                .get(thread)
                .is_some_and(|keys| keys.contains(&key))
        }) {
            index.watch_base(&key);
            if let Some(path) = &watch.path {
                index.watch_paths(&key, vec![path.clone()]);
            }
            // Install before validating the pre-read stamps, including the first native path.
            if let Some(row) = index.rows.get(&key) {
                if watch.changed(&row.binding)? {
                    index.wake_key(&key);
                }
            }
        }
        Ok(())
    })
}
pub(super) fn next(dir: &Path) -> Result<Option<i64>> {
    with(dir, |i| {
        Ok([
            i.observation.next(),
            i.retention.next(),
            i.coverage_gap.then_some(clock() + 2),
        ]
        .into_iter()
        .flatten()
        .min())
    })
}
pub(super) fn file_wake(dir: &Path) -> Result<Arc<tokio::sync::Notify>> {
    with(dir, |i| Ok(i.watch.wake.clone()))
}
pub(super) fn sample(dir: &Path) -> Result<(usize, usize, usize, usize, usize)> {
    with(dir, |index| {
        Ok((
            index.rows.len(),
            index.observing.len() + index.reconciliation.len(),
            index.dormant.len(),
            index.reconciliation.len(),
            index.exhausted.len(),
        ))
    })
}
pub(super) fn diagnostics(dir: &Path) -> Value {
    INDEXES.try_lock().ok().and_then(|indexes| indexes.get(dir).map(|i| json!({"retained":i.rows.len(),"observing":i.observing.len(),"reconciliationDue":i.reconciliation.len(),"dormant":i.dormant.len(),"deliveryDue":i.delivery.keys.len(),"retentionDue":i.retention.keys.len(),"latestScopes":i.scopes.len(),"latestResumable":i.resumable.len(),"reconciliationExhausted":i.exhausted.len(),"pendingBindings":i.pending.len(),"dirtyKeys":i.dirty.len(),"watchCoverage":if i.coverage_gap {"repairing"} else {"watched"},"revision":i.revision}))).unwrap_or(Value::Null)
}

pub(super) fn is_superseded(dir: &Path, b: &Binding) -> Result<bool> {
    with(dir, |i| Ok(i.superseded(b)))
}
pub(super) fn delivery_due(dir: &Path, now: i64) -> Result<Arc<Vec<Arc<Binding>>>> {
    with(dir, |i| {
        i.refresh(dir)?;
        let keys = i.delivery.take(now);
        // Persistence/transport setup errors retain a future retry, never an overdue key.
        for key in &keys {
            i.delivery_dirty.remove(key);
            i.delivery.set(key, Some(now.saturating_add(2)));
        }
        cost::rows(keys.len());
        Ok(Arc::new(
            keys.iter()
                .filter_map(|key| i.rows.get(key))
                .map(|row| row.binding.clone())
                .collect(),
        ))
    })
}
pub(super) fn wake_deliveries(dir: &Path, affected: impl Fn(&Binding) -> bool) -> Result<()> {
    with(dir, |i| {
        for key in &i.pending {
            if affected(&i.rows[key].binding) {
                i.delivery.set(key, Some(0));
            }
        }
        DELIVERY_WAKE.notify_one();
        Ok(())
    })
}
pub(super) fn delivery_prepared(dir: &Path, rows: &[Arc<Binding>]) -> Result<()> {
    with(dir, |i| {
        // Controls routed under the store lock have been handled. Changes arriving
        // while transport releases that lock must survive final rescheduling.
        for b in rows {
            i.delivery_dirty
                .remove(&path_in(dir, &b.thread_id, &b.turn_id));
        }
        Ok(())
    })
}
pub(super) fn schedule_deliveries(
    dir: &Path,
    rows: &[Arc<Binding>],
    settings: &Value,
    now: i64,
) -> Result<()> {
    let state = State::load(dir)?;
    with(dir, |i| {
        for original in rows {
            let key = path_in(dir, &original.thread_id, &original.turn_id);
            let Some(row) = i.rows.get(&key) else {
                continue;
            };
            let b = &row.binding;
            let mut routing_at = None;
            for d in b.deliveries.iter().filter(|d| {
                matches!(d.status.as_str(), "pending" | "sending")
                    && d.interaction["routing"]["state"] == "deferred"
            }) {
                if let Some(at) = routing::deferred_deadline(b, d, now)? {
                    routing_at = Some(routing_at.map_or(at, |old: i64| old.min(at)));
                }
            }
            let at = if i.pending.contains(&key) {
                scheduler::next_at(
                    &state,
                    std::slice::from_ref(b),
                    settings,
                    now,
                    routing_at,
                    delivery_source_active,
                )
            } else {
                None
            };
            let at = if i.pending.contains(&key) && i.delivery_dirty.contains(&key) {
                Some(now.saturating_add(1))
            } else {
                at
            };
            i.delivery.set(&key, at);
        }
        Ok(())
    })
}
pub(super) fn has_pending_target(
    dir: &Path,
    source: &str,
    channel: Channel,
    target: &str,
) -> Result<bool> {
    with(dir, |i| {
        Ok(i.destinations
            .get(&(source.into(), channel, target.into()))
            .is_some_and(|keys| !keys.is_empty()))
    })
}
pub(super) fn next_delivery(dir: &Path) -> Result<Option<i64>> {
    with(dir, |i| {
        i.refresh(dir)?;
        Ok(i.delivery.next())
    })
}

// Track effective controls, not store mtimes or transport bookkeeping. Owned writes
// and external readback use this same invalidation path, including writes during sends.
pub(super) fn controls_changed(dir: &Path, data: Arc<governance::Data>) {
    let Ok(mut indexes) = INDEXES.lock() else {
        return;
    };
    let Some(i) = indexes.get_mut(dir) else {
        return;
    };
    if i.controls
        .as_ref()
        .is_some_and(|old| Arc::ptr_eq(old, &data))
    {
        return;
    }
    let Some(old) = i.controls.replace(data.clone()) else {
        return;
    };
    let mut keys = HashSet::new();
    let target_key = |t: &governance::Target| (t.source_id.clone(), t.channel, t.target.clone());
    let old_targets: HashMap<_, _> = old.targets.iter().map(|t| (target_key(t), t)).collect();
    let new_targets: HashMap<_, _> = data.targets.iter().map(|t| (target_key(t), t)).collect();
    let target_control = |t: &&governance::Target| {
        (
            t.breaker,
            t.account_id.clone(),
            t.reachability.state.clone(),
        )
    };
    for key in old_targets.keys().chain(new_targets.keys()) {
        let old = old_targets.get(key);
        let new = new_targets.get(key);
        let changed = old.map(target_control) != new.map(target_control);
        let refilled = old.is_some_and(|t| t.tokens == 0) && new.is_some_and(|t| t.tokens > 0);
        if changed || refilled {
            keys.extend(
                i.destinations
                    .get(key)
                    .into_iter()
                    .flatten()
                    .filter(|key| {
                        changed
                            || i.rows[*key]
                                .binding
                                .deliveries
                                .iter()
                                .any(|d| d.timing.queue_reason.as_deref() == Some("token-wait"))
                    })
                    .cloned(),
            );
        }
    }
    let thread_key = |t: &governance::Thread| (t.source_id.clone(), t.thread_id.clone());
    let old_threads: HashMap<_, _> = old.threads.iter().map(|t| (thread_key(t), t)).collect();
    let new_threads: HashMap<_, _> = data.threads.iter().map(|t| (thread_key(t), t)).collect();
    for key in old_threads.keys().chain(new_threads.keys()) {
        let old = old_threads.get(key);
        let new = new_threads.get(key);
        if old.map_or("normal", |t| t.mode.as_str()) != new.map_or("normal", |t| t.mode.as_str())
            || old.and_then(|t| t.until) != new.and_then(|t| t.until)
            || old.and_then(|t| t.rebind.as_ref()) != new.and_then(|t| t.rebind.as_ref())
        {
            keys.extend(
                i.scopes
                    .get(key)
                    .into_iter()
                    .flatten()
                    .map(|(_, key)| key.clone()),
            );
        }
    }
    let old_subs: HashMap<_, _> = old.subscriptions.iter().map(|s| (&s.id, s)).collect();
    let new_subs: HashMap<_, _> = data.subscriptions.iter().map(|s| (&s.id, s)).collect();
    for sub in old.subscriptions.iter().chain(&data.subscriptions) {
        if old_subs.get(&sub.id) == new_subs.get(&sub.id) {
            continue;
        }
        let candidates = sub.args["threadId"]
            .as_str()
            .or_else(|| sub.args["taskId"].as_str())
            .and_then(|thread| i.threads.get(thread))
            .or_else(|| i.sources.get(&sub.source_id));
        keys.extend(
            candidates
                .into_iter()
                .flatten()
                .filter(|key| sub.matches(&i.rows[*key].binding))
                .cloned(),
        );
    }
    for key in keys {
        i.wake_delivery(&key);
    }
}

pub(super) fn routing_changed(agent: &str, thread: &str) {
    if let Ok(mut indexes) = INDEXES.lock() {
        for i in indexes.values_mut() {
            for key in i.threads.get(thread).cloned().unwrap_or_default() {
                let b = &i.rows[&key].binding;
                if (b.agent == agent || (b.agent.is_empty() && agent == "codex"))
                    && b.deliveries.iter().any(routing::held)
                {
                    i.wake_delivery(&key);
                }
            }
        }
    }
}

pub(super) fn successors(dir: &Path, b: &Binding) -> Result<Vec<Binding>> {
    with(dir, |index| {
        let mut rows = Vec::new();
        let mut current = b;
        let mut seen = HashSet::new();
        while current.successor["inherited"] == true {
            let Some(turn) = current.successor["turnId"].as_str() else {
                break;
            };
            if !seen.insert(turn.to_owned()) {
                break;
            }
            let Some(row) = index.rows.get(&path_in(dir, &b.thread_id, turn)) else {
                break;
            };
            if row.binding.source_id != b.source_id {
                break;
            }
            current = &row.binding;
            rows.push(current.clone());
        }
        Ok(rows)
    })
}

#[cfg(test)]
pub(super) fn forget(dir: &Path) {
    INDEXES.lock().unwrap().remove(dir);
}

pub(super) fn interested_thread(dir: &Path, thread: &str) -> Result<Vec<Binding>> {
    with(dir, |index| {
        Ok(index
            .interested
            .get(thread)
            .into_iter()
            .flatten()
            .filter_map(|key| index.rows.get(key))
            .map(|row| (*row.binding).clone())
            .collect())
    })
}
