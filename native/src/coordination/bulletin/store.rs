//! Bounded owner snapshot. Only typed metadata reaches the shared projection.
use super::*;
use crate::turn_lifecycle::{
    adapters as turn_adapter, advance, Evidence, LossReason, Outcome, Transition, TurnKey,
    TurnState,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(super) const INACTIVE_MS: i64 = 6 * 60 * 60 * 1000;
const RETENTION_MS: i64 = 7 * 86400 * 1000;
const SNAPSHOT_BYTES: usize = 2 * 1024 * 1024; // Plus one equal-size atomic temporary.

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct State {
    epoch: String,
    revision: u64,
    pub notices: Vec<Record>,
    pub blockers: Vec<Record>,
    sessions: Vec<Session>,
    applied: BTreeMap<String, Applied>,
    pub pending: Vec<EventInput>,
    budgets: BTreeMap<String, (i64, u32)>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Applied {
    digest: String,
    result: Value,
    at: i64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Session {
    id: String,
    owner: Principal,
    created_at: i64,
    last_active_at: i64,
    state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    route: Option<crate::claude_notify::coordination_delivery::Route>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    route_failure: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Link {
    pub thread_id: String,
    #[serde(default)]
    pub session_binding_id: Option<String>,
    pub observed_turn_id: Option<String>,
    pub scope_state: String,
    pub observed_at: Option<i64>,
    #[serde(default)]
    pub terminals: BTreeMap<String, Value>,
}
impl Link {
    fn turn(&self, id: &str) -> Transition {
        let stored = self.terminals.get(id).unwrap_or(&Value::Null);
        if let Some(turn) = turn_adapter::restore(stored) {
            return turn;
        }
        let key = self
            .terminals
            .values()
            .find_map(turn_adapter::restore)
            .map(|turn| TurnKey::new(&turn.key().agent, &self.thread_id, id))
            .unwrap_or_else(|| TurnKey::new("codex", &self.thread_id, id));
        let recorded = stored.as_str().unwrap_or_else(|| {
            if self.observed_turn_id.as_deref() == Some(id) {
                &self.scope_state
            } else {
                "unknown"
            }
        });
        turn_adapter::snapshot(key, recorded, &Value::Null)
    }
    pub(super) fn selected(&self) -> Transition {
        self.turn(self.observed_turn_id.as_deref().unwrap_or(""))
    }
    fn ended(&self) -> bool {
        matches!(
            self.selected().state(),
            TurnState::Terminal(crate::turn_lifecycle::TerminalRecord {
                outcome: Outcome::Completed | Outcome::Failed,
                ..
            })
        )
    }
    pub(super) fn merge(&mut self, incoming: &Transition) -> bool {
        let id = &incoming.key().turn_id;
        let previous = self
            .terminals
            .get(id)
            .filter(|v| v.is_object())
            .and_then(turn_adapter::restore)
            .unwrap_or_else(|| {
                let legacy = self
                    .terminals
                    .get(id)
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| {
                        if self.observed_turn_id.as_deref() == Some(id) {
                            &self.scope_state
                        } else {
                            "unknown"
                        }
                    });
                turn_adapter::snapshot(incoming.key().clone(), legacy, &Value::Null)
            });
        let next = turn_adapter::observe(&previous, incoming);
        if self.terminals.contains_key(id)
            && next.state() == previous.state()
            && next.last_live().map(|l| l.state) == previous.last_live().map(|l| l.state)
        {
            return false;
        }
        if !self.terminals.contains_key(id) && self.terminals.len() == 16 {
            if let Some(old) = self
                .terminals
                .keys()
                .find(|old| Some(old.as_str()) != self.observed_turn_id.as_deref())
                .cloned()
            {
                self.terminals.remove(&old);
            }
        }
        self.terminals
            .insert(id.clone(), turn_adapter::checkpoint(&next));
        true
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dispatch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    association: Option<DispatchAssociation>,
    pub revision: u64,
    pub owner: Principal,
    owner_session_id: Option<String>,
    pub resources: Vec<ResourceKey>,
    intent: Option<String>,
    expected_duration_seconds: Option<u64>,
    pub thread_links: Vec<Link>,
    cause_code: Option<String>,
    summary: Option<String>,
    evidence_ids: Vec<String>,
    fixing_commit: Option<Value>,
    reason: Option<String>,
    suggested_next_step: Option<String>,
    created_at: i64,
    pub last_active_at: i64,
    #[serde(skip)]
    fresh_activity: bool,
    pub state: String,
    closed_reason: Option<String>,
    ended_at: Option<i64>,
    #[serde(default)]
    recovery_selection: Option<Value>,
    #[serde(default)]
    cleared_by: Option<Principal>,
}
fn same_owner(a: &Principal, b: &Principal) -> bool {
    match (a, b) {
        (Principal::Source { source_id: a, .. }, Principal::Source { source_id: b, .. }) => a == b,
        (Principal::LocalAuthority, Principal::LocalAuthority) => true,
        _ => false,
    }
}
fn owner_key(owner: &Principal) -> String {
    match owner {
        Principal::Source { source_id, .. } => source_id.clone(),
        _ => "local-authority".into(),
    }
}
impl Record {
    fn live(&self) -> bool {
        !matches!(self.state.as_str(), "closed" | "withdrawn" | "cleared")
    }
    fn project(&self, clock: Clock, restarted: bool) -> Value {
        let age = clock.age(self.last_active_at);
        let coverage = if age.is_none() {
            "clock-uncertain"
        } else if self.thread_links.iter().any(|l| {
            matches!(
                l.selected().state(),
                TurnState::Unconfirmed(_)
                    | TurnState::Conflict(_)
                    | TurnState::Terminal(crate::turn_lifecycle::TerminalRecord {
                        outcome: Outcome::Interrupted,
                        ..
                    })
            )
        }) {
            "thread-observation-gap"
        } else if restarted && !self.fresh_activity {
            "restart-gap"
        } else {
            "observed"
        };
        let mut result = json!({"id":self.id,"revision":self.revision,"ownerSessionId":self.owner_session_id,
            "resources":self.resources,"createdAt":timestamp(self.created_at),"lastActiveAt":timestamp(self.last_active_at),
            "inactivityAgeSeconds":age,"observedAt":timestamp(clock.utc),"activityCoverage":coverage,"state":self.state});
        match &self.owner {
            Principal::Source { source_id, .. } => result["ownerSourceId"] = json!(source_id),
            Principal::LocalAuthority => result["localOrigin"] = json!(true),
            Principal::Arc => result["ownerSourceId"] = Value::Null,
        }
        if let Some(dispatch) = &self.dispatch_id {
            result["dispatchId"] = json!(dispatch);
            result["provenance"] = json!("dispatch-derived");
            result["association"] = json!(self.association);
        }
        if let Some(intent) = &self.intent {
            result["intent"] = json!(intent);
            result["expectedDurationSeconds"] = json!(self.expected_duration_seconds);
            result["threadLinks"] = json!(self.thread_links.iter().map(|l| json!({"threadId":l.thread_id,"observedTurnId":l.observed_turn_id,"scopeState":l.scope_state})).collect::<Vec<_>>());
            result["closedReason"] = json!(self.closed_reason);
        } else {
            result["causeCode"] = json!(self.cause_code);
            result["summary"] = json!(self.summary);
            result["provenance"] = json!("source-reported");
            result["openedAt"] = json!(timestamp(self.created_at));
            result["clearedAt"] = json!(self.ended_at.map(timestamp));
            result["fixingCommit"] = json!(self.fixing_commit);
            result["reason"] = json!(self.reason);
            result["evidenceIds"] = json!(self.evidence_ids);
            result["suggestedNextStep"] = json!(self.suggested_next_step);
            result["clearedBy"] = json!(self.cleared_by);
            result["recoverySelection"] =
                super::super::recovery::public_selection(&json!(self.recovery_selection));
        }
        result
    }
}
/// Injectable wall/elapsed clock. Runtime supplies monotonic-derived elapsed time;
/// UTC discontinuity makes age unknown and prevents automatic expiry.
#[derive(Clone, Copy)]
pub(super) struct Clock {
    pub utc: i64,
    pub elapsed: i64,
    pub certain: bool,
}
impl Clock {
    pub fn age(self, at: i64) -> Option<u64> {
        (self.certain && self.elapsed >= at)
            .then_some(self.elapsed.saturating_sub(at).max(0) as u64 / 1000)
    }
}
pub(super) struct Store {
    path: PathBuf,
    pub state: State,
    pub restarted: bool,
    dirty: bool,
    saved_at: i64,
    stamp: Option<crate::kernel::file_cache::Stamp>,
    live_notices: std::collections::BTreeSet<usize>,
    live_blockers: std::collections::BTreeSet<usize>,
    resource_notices: BTreeMap<ResourceKey, std::collections::BTreeSet<usize>>,
    resource_blockers: BTreeMap<ResourceKey, std::collections::BTreeSet<usize>>,
    dispatch_notices: BTreeMap<String, usize>,
    retention_at: Option<i64>,
    maintained: Option<(Vec<String>, i64, Option<i64>)>,
}
impl Store {
    pub fn session_routes(
        &self,
        source: &str,
    ) -> Vec<(
        String,
        Option<crate::claude_notify::coordination_delivery::Route>,
        Option<String>,
    )> {
        self.state
            .sessions
            .iter()
            .filter(|s| {
                s.state == "active"
                    && matches!(&s.owner, Principal::Source {source_id,..} if source_id == source)
            })
            .map(|s| (s.id.clone(), s.route.clone(), s.route_failure.clone()))
            .collect()
    }
    pub fn route(
        &self,
        source: &str,
        session: &str,
    ) -> Option<crate::claude_notify::coordination_delivery::Route> {
        self.session_routes(source)
            .into_iter()
            .find(|(id, _, _)| id == session)
            .and_then(|(_, route, _)| route)
    }
    pub fn bind(
        &mut self,
        source: &str,
        session: &str,
        route: Option<crate::claude_notify::coordination_delivery::Route>,
        clock: Clock,
    ) -> Result<()> {
        self.transaction(clock, |s| {
            let row = s.state.sessions.iter_mut().find(|s| s.id == session && s.state == "active" && matches!(&s.owner, Principal::Source {source_id,..} if source_id == source))
                .ok_or("SESSION_NOT_FOUND: select an active logical session owned by this source")?;
            let mut route = route;
            if let Some(route) = &mut route {
                route.binding_id = row.route.as_ref().filter(|r| r.same_destination(route)).and_then(|r|r.binding_id.clone()).or_else(||Some(id()));
            }
            row.route = route;
            row.route_failure = None;
            s.state.revision += 1;
            Ok(())
        })
    }
    /// One-time transfer from the old messages snapshot. Preserve binding IDs and
    /// never overwrite a route already edited in the session owner snapshot.
    pub fn import_routes(
        &mut self,
        routes: &BTreeMap<String, crate::claude_notify::coordination_delivery::Route>,
        clock: Clock,
    ) -> Result<()> {
        self.transaction(clock, |s| {
            for session in &mut s.state.sessions {
                if session.state != "active"
                    || session.route.is_some()
                    || session.route_failure.is_some()
                {
                    continue;
                }
                if let Principal::Source { source_id, .. } = &session.owner {
                    session.route = routes.get(&format!("{source_id}:{}", session.id)).cloned();
                }
            }
            s.state.revision += 1;
            Ok(())
        })
    }
    pub fn session_active(&self, source: &str, id: &str) -> bool {
        self.state.sessions.iter().any(|s| {
            s.id == id
                && s.state == "active"
                && matches!(&s.owner, Principal::Source {source_id,..} if source_id == source)
        })
    }

    pub fn open(path: PathBuf) -> Result<Self> {
        let exists = path.exists();
        let state: State = if exists {
            if std::fs::metadata(&path)
                .map_err(|_| "COORDINATION_STORAGE: cannot read bulletin")?
                .len()
                > SNAPSHOT_BYTES as u64
            {
                return Err("COORDINATION_CAPACITY: bulletin snapshot exceeds budget".into());
            }
            serde_json::from_value(load(&path)?).map_err(|_| {
                "COORDINATION_CORRUPT: preserve coordination/state.json for local recovery"
            })?
        } else {
            State {
                epoch: id(),
                ..Default::default()
            }
        };
        let valid_time = |at| chrono::DateTime::from_timestamp_millis(at).is_some();
        if state.notices.len() > 256
            || state.blockers.len() > 128
            || state.sessions.len() > 128
            || state.pending.len() > 512
            || state.applied.len() > 2048
            || state.notices.iter().chain(&state.blockers).any(|n| {
                !valid_time(n.created_at)
                    || !valid_time(n.last_active_at)
                    || n.ended_at.is_some_and(|at| !valid_time(at))
                    || n.resources.is_empty()
                    || n.resources.len() > 16
                    || n.thread_links.len() > 16
                    || n.thread_links.iter().any(|l| l.terminals.len() > 16)
            })
            || state
                .sessions
                .iter()
                .any(|s| !valid_time(s.created_at) || !valid_time(s.last_active_at))
        {
            return Err(
                "COORDINATION_CORRUPT: preserve coordination/state.json for local recovery".into(),
            );
        }
        let mut result = Self {
            path,
            state,
            restarted: exists,
            dirty: false,
            saved_at: 0,
            stamp: None,
            live_notices: Default::default(),
            live_blockers: Default::default(),
            resource_notices: Default::default(),
            resource_blockers: Default::default(),
            dispatch_notices: Default::default(),
            retention_at: None,
            maintained: None,
        };
        // Persisted running is historical evidence, never a new heartbeat after restart.
        for n in &mut result.state.notices {
            for link in &mut n.thread_links {
                let previous = link.selected();
                if matches!(
                    previous.state(),
                    TurnState::Active | TurnState::AwaitingInteraction
                ) {
                    let lost = advance(
                        &previous,
                        &Evidence::loss(
                            previous.key().clone(),
                            LossReason::OwnerUnavailable,
                            previous.revision().saturating_add(1),
                        ),
                    );
                    link.merge(&lost);
                    link.scope_state = turn_adapter::work_scope(&link.selected().state()).into();
                }
            }
        }
        result.stamp = crate::kernel::file_cache::Stamp::read(&result.path)?;
        result.reindex();
        Ok(result)
    }
    pub fn stale(&self) -> Result<bool> {
        Ok(crate::kernel::file_cache::Stamp::read(&self.path)? != self.stamp)
    }
    fn reindex(&mut self) {
        self.resource_notices.clear();
        self.resource_blockers.clear();
        self.dispatch_notices.clear();
        for (index, row) in self.state.notices.iter().enumerate() {
            if let Some(dispatch) = &row.dispatch_id {
                self.dispatch_notices.insert(dispatch.clone(), index);
            }
            if row.state == "active" {
                for resource in &row.resources {
                    self.resource_notices
                        .entry(resource.clone())
                        .or_default()
                        .insert(index);
                }
            }
        }
        for (index, row) in self.state.blockers.iter().enumerate() {
            if row.state != "cleared" {
                for resource in &row.resources {
                    self.resource_blockers
                        .entry(resource.clone())
                        .or_default()
                        .insert(index);
                }
            }
        }

        self.live_notices = self
            .state
            .notices
            .iter()
            .enumerate()
            .filter(|(_, n)| n.live())
            .map(|(i, _)| i)
            .collect();
        self.live_blockers = self
            .state
            .blockers
            .iter()
            .enumerate()
            .filter(|(_, row)| row.live())
            .map(|(i, _)| i)
            .collect();
        self.retention_at = self
            .state
            .notices
            .iter()
            .chain(&self.state.blockers)
            .filter(|n| {
                !self
                    .state
                    .pending
                    .iter()
                    .any(|p| p.evidence_refs.iter().any(|e| e.id == n.id))
            })
            .filter_map(|n| n.ended_at.map(|at| at.saturating_add(RETENTION_MS)))
            .min();
        self.maintained = None;
    }
    pub fn save(&mut self, clock: Clock) -> Result<()> {
        let bytes = serde_json::to_vec(&self.state)
            .map_err(|_| "COORDINATION_STORAGE: bulletin serialization failed")?;
        if bytes.len() > SNAPSHOT_BYTES {
            return Err(
                "COORDINATION_CAPACITY: bulletin is full; preserve state for local cleanup".into(),
            );
        }
        private_dir(self.path.parent().unwrap())?;
        super::super::journal::atomic_bytes(&self.path, &bytes)?;
        self.stamp = crate::kernel::file_cache::Stamp::read(&self.path)?;
        self.reindex();
        self.dirty = false;
        self.saved_at = clock.elapsed;
        Ok(())
    }
    fn transaction<T>(
        &mut self,
        clock: Clock,
        f: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<T> {
        let before = self.state.clone();
        match f(self).and_then(|value| self.save(clock).map(|_| value)) {
            Ok(value) => Ok(value),
            Err(error) => {
                self.state = before;
                Err(error)
            }
        }
    }
    pub fn flush(&mut self, clock: Clock) -> Result<()> {
        if self.dirty && clock.elapsed.saturating_sub(self.saved_at) >= 60_000 {
            self.save(clock)?;
        }
        Ok(())
    }
    fn event(&mut self, record: &Record, blocker: bool) -> Result<()> {
        if self.state.pending.len()
            + record
                .resources
                .len()
                .div_ceil(if record.thread_links.is_empty() { 4 } else { 2 })
                * record.thread_links.len().max(1)
            > 512
        {
            return Err("COORDINATION_CAPACITY: pull board to reconcile pending events".into());
        }
        let mut event = EventInput::new(
            format!("bulletin-{}-{}", record.id, record.revision),
            if blocker {
                EventKind::BlockerChanged
            } else {
                EventKind::NoticeChanged
            },
            record.resources.clone(),
        );
        event.origin = Some(record.owner.clone());
        // Journal observation time prevents late links from broadening a past window.
        if !blocker {
            event.observation = Some(Observation {
                session_id: record.owner_session_id.clone(),
                session_binding_id: record
                    .thread_links
                    .first()
                    .and_then(|l| l.session_binding_id.clone()),
                ..Default::default()
            });
            event.thread_refs = record
                .thread_links
                .iter()
                .map(|link| ThreadRef {
                    thread_id: link.thread_id.clone(),
                    turn_id: link.observed_turn_id.clone(),
                })
                .collect();
        }
        event.status = Some(match record.state.as_str() {
            "active" => EventStatus::Active,
            "uncertain" => EventStatus::Uncertain,
            "stale" => EventStatus::Stale,
            "cleared" => EventStatus::Cleared,
            "withdrawn" => EventStatus::Withdrawn,
            _ => EventStatus::Closed,
        });
        event.evidence_refs.push(EvidenceRef {
            kind: if blocker {
                EvidenceKind::Blocker
            } else {
                EvidenceKind::Notice
            },
            id: record.id.clone(),
        });
        // Four longest canonical keys plus typed identity fit the 2 KiB journal row.
        for (index, resources) in event
            .resources
            .chunks(if event.thread_refs.is_empty() { 4 } else { 2 })
            .enumerate()
        {
            let mut part = event.clone();
            part.resources = resources.to_vec();
            part.transition_id = format!("{}-{index}", event.transition_id);
            if part.thread_refs.is_empty() {
                self.state.pending.push(part);
            } else {
                for (batch, refs) in part.thread_refs.chunks(1).enumerate() {
                    let mut linked = part.clone();
                    linked.thread_refs = refs.to_vec();
                    linked.transition_id = format!("{}-{batch}", part.transition_id);
                    self.state.pending.push(linked);
                }
            }
        }

        self.state.revision += 1;
        Ok(())
    }
    pub fn projected(&mut self, transition: &str, clock: Clock) -> Result<()> {
        self.transaction(clock, |s| {
            s.state.pending.retain(|p| p.transition_id != transition);
            Ok(())
        })
    }
    pub fn activity(&mut self, owner: &Principal, clock: Clock) {
        if !clock.certain {
            return;
        }
        for (blocker, indices) in [(false, &self.live_notices), (true, &self.live_blockers)] {
            for index in indices {
                let row = if blocker {
                    &mut self.state.blockers[*index]
                } else {
                    &mut self.state.notices[*index]
                };
                if same_owner(&row.owner, owner) && clock.elapsed > row.last_active_at {
                    row.last_active_at = clock.elapsed;
                    row.fresh_activity = true;
                    self.dirty = true;
                }
            }
        }
        for session in &mut self.state.sessions {
            if session.state == "active" && same_owner(&session.owner, owner) {
                session.last_active_at = clock.elapsed;
                self.dirty = true;
            }
        }
    }
    pub fn linked_threads(&self) -> Vec<String> {
        crate::runtime_metrics::cost::scan_set(self.live_notices.len());
        self.live_notices
            .iter()
            .map(|index| &self.state.notices[*index])
            .inspect(|_| crate::runtime_metrics::cost::rows(1))
            .flat_map(|n| &n.thread_links)
            .map(|l| l.thread_id.clone())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }
    pub fn missing(&mut self, observed: &[String]) {
        for index in &self.live_notices {
            crate::runtime_metrics::cost::rows(1);
            let notice = &mut self.state.notices[*index];
            for link in &mut notice.thread_links {
                if !observed.contains(&link.thread_id) {
                    let previous = link.selected();
                    let lost = advance(
                        &previous,
                        &Evidence::loss(
                            previous.key().clone(),
                            LossReason::OwnerUnavailable,
                            previous.revision().saturating_add(1),
                        ),
                    );
                    self.dirty |= link.merge(&lost);
                    link.scope_state = turn_adapter::work_scope(&link.selected().state()).into();
                }
            }
        }
    }
    pub fn successor(&mut self, thread: &str, previous: &str, next: &str, owner: &Principal) {
        for index in &self.live_notices {
            let notice = &mut self.state.notices[*index];
            if !same_owner(&notice.owner, owner) {
                continue;
            }
            for link in notice.thread_links.iter_mut().filter(|l| {
                l.thread_id == thread && l.observed_turn_id.as_deref() == Some(previous)
            }) {
                let scope = turn_adapter::work_scope(&link.turn(next).state());
                link.observed_turn_id = Some(next.into());
                link.scope_state = scope.into();
                self.dirty = true;
                self.maintained = None;
            }
        }
    }
    pub fn checkpoint_observation(&mut self, clock: Clock) -> Result<()> {
        if self.dirty {
            self.save(clock)?;
        }
        Ok(())
    }
    pub fn observe_event(
        &mut self,
        thread: &str,
        id: &str,
        status: Option<&EventStatus>,
        clock: Clock,
    ) {
        let key = self
            .live_notices
            .iter()
            .flat_map(|index| &self.state.notices[*index].thread_links)
            .find(|link| link.thread_id == thread)
            .map(|link| link.turn(id).key().clone())
            .unwrap_or_else(|| TurnKey::new("codex", thread, id));
        let turn = super::super::turns::event(key, status);
        if turn_adapter::terminal(&turn.state()) {
            self.observe(thread, &turn, clock, false);
        }
    }
    pub fn observe(&mut self, thread: &str, incoming: &Transition, clock: Clock, live: bool) {
        let turn = &incoming.key().turn_id;
        if types::identifier(turn).is_err() || incoming.key().native_session != thread {
            return;
        }
        for index in &self.live_notices {
            crate::runtime_metrics::cost::rows(1);
            let notice = &mut self.state.notices[*index];
            for link in notice
                .thread_links
                .iter_mut()
                .filter(|l| l.thread_id == thread)
            {
                self.dirty |= link.merge(incoming);
                if link.observed_turn_id.as_deref() != Some(turn) {
                    if live {
                        let selected = link.selected();
                        let lost = advance(
                            &selected,
                            &Evidence::loss(
                                selected.key().clone(),
                                LossReason::OwnerUnavailable,
                                selected.revision().saturating_add(1),
                            ),
                        );
                        self.dirty |= link.merge(&lost);
                        link.scope_state =
                            turn_adapter::work_scope(&link.selected().state()).into();
                    }
                    continue;
                }
                let state = link.selected().state();
                let scope = turn_adapter::work_scope(&state);
                let changed = link.scope_state != scope;
                if changed && link.ended() {
                    self.maintained = None;
                }
                link.scope_state = scope.into();
                if !changed && !matches!(state, TurnState::Active | TurnState::AwaitingInteraction)
                {
                    continue;
                }
                if clock.certain
                    && live
                    && !matches!(state, TurnState::Unconfirmed(_) | TurnState::Conflict(_))
                {
                    link.observed_at = Some(clock.elapsed);
                    notice.last_active_at = notice.last_active_at.max(clock.elapsed);
                    notice.fresh_activity = true;
                }
                self.dirty = true;
            }
        }
    }
    pub fn maintain(&mut self, revoked: &[String], clock: Clock) -> Result<()> {
        if clock.certain
            && self.maintained.as_ref().is_some_and(|(old, at, next)| {
                old == revoked
                    && clock.elapsed >= *at
                    && next.is_none_or(|next| clock.elapsed < next)
            })
        {
            return self.flush(clock);
        }
        let mut updates = vec![];
        for (blocker, indices) in [(false, &self.live_notices), (true, &self.live_blockers)] {
            for index in indices.iter().copied() {
                crate::runtime_metrics::cost::rows(1);
                let row = if blocker {
                    &self.state.blockers[index]
                } else {
                    &self.state.notices[index]
                };
                let revoked = matches!(&row.owner, Principal::Source { source_id, .. } if revoked.contains(source_id));
                let inactive = clock
                    .age(row.last_active_at)
                    .is_some_and(|age| age >= (INACTIVE_MS / 1000) as u64);
                let ended =
                    !row.thread_links.is_empty() && row.thread_links.iter().all(Link::ended);
                let state = if blocker {
                    if revoked {
                        Some(("uncertain", "source-revoked"))
                    } else if inactive {
                        Some(("stale", "owner-inactive"))
                    } else {
                        None
                    }
                } else if revoked {
                    Some(("closed", "source-revoked"))
                } else if ended {
                    Some(("closed", "threads-ended"))
                } else if inactive {
                    Some(("withdrawn", "owner-inactive"))
                } else {
                    None
                };
                if let Some((state, reason)) = state.filter(|(state, _)| row.state != *state) {
                    updates.push((blocker, index, state, reason));
                }
            }
        }
        let removable = clock.certain && self.retention_at.is_some_and(|at| clock.elapsed >= at);
        if updates.is_empty() && !removable {
            self.flush(clock)?;
            let next = self
                .live_notices
                .iter()
                .map(|i| &self.state.notices[*i])
                .chain(self.live_blockers.iter().map(|i| &self.state.blockers[*i]))
                .map(|row| row.last_active_at.saturating_add(INACTIVE_MS))
                .chain(self.retention_at)
                .filter(|at| *at > clock.elapsed)
                .min();
            self.maintained = Some((revoked.to_vec(), clock.elapsed, next));
            return Ok(());
        }
        self.transaction(clock, |s| {
            for (blocker, index, state, reason) in updates {
                let row = if blocker {
                    &mut s.state.blockers[index]
                } else {
                    &mut s.state.notices[index]
                };
                row.state = state.into();
                if blocker && state == "stale" {
                    row.recovery_selection = Some(json!({"state":"suppressed","reason":"stale-blocker","recipients":[],"unresolved":[],"automaticResume":false}));
                }
                row.closed_reason = Some(reason.into());
                row.revision += 1;
                if !blocker {
                    row.ended_at = Some(clock.utc);
                }
                let row = row.clone();
                s.event(&row, blocker)?;
            }
            s.prune(clock);
            Ok(())
        })
    }
    pub fn conflicts(
        &self,
        resources: &[ResourceKey],
        exclude: Option<&str>,
        clock: Clock,
    ) -> Vec<Value> {
        self.lifecycle_conflicts(resources, None, clock)
            .into_iter()
            .filter(|c| c["id"].as_str() != exclude || exclude.is_none())
            .collect()
    }

    pub fn lifecycle_conflicts(
        &self,
        resources: &[ResourceKey],
        source: Option<&str>,
        clock: Clock,
    ) -> Vec<Value> {
        let mut result = Vec::new();
        for resource in resources {
            for (kind, indices) in [
                ("notice", self.resource_notices.get(resource)),
                ("blocker", self.resource_blockers.get(resource)),
            ] {
                for index in indices.into_iter().flatten() {
                    let row = if kind == "notice" {
                        &self.state.notices[*index]
                    } else {
                        &self.state.blockers[*index]
                    };
                    if matches!(&row.owner, Principal::Source { source_id, .. } if Some(source_id.as_str()) == source)
                    {
                        continue;
                    }
                    if result.len() == 100 {
                        return result;
                    }
                    let mut conflict = json!({"id":row.id,"kind":kind,"resource":resource,"state":row.state,"lastActiveAt":timestamp(row.last_active_at),"inactivityAgeSeconds":clock.age(row.last_active_at),"boardRead":{"via":"query","op":"board","args":{"id":row.id,"view":"full"}}});
                    conflict[if kind == "notice" {
                        "noticeId"
                    } else {
                        "blockerId"
                    }] = json!(row.id);
                    result.push(conflict);
                }
            }
        }
        result
    }
    pub fn advisory(&self, resources: &[ResourceKey], source: Option<&str>, clock: Clock) -> Value {
        let conflicts = self.lifecycle_conflicts(resources, source, clock);
        json!({"conflictCoverage":if conflicts.len()==100 {"partial"}else{"observed"},"conflicts":conflicts,"boardRevision":{"epoch":self.state.epoch,"revision":self.state.revision},"boardRead":{"via":"query","op":"board","args":{}},"observedAt":timestamp(clock.utc)})
    }
    /// The deterministic dispatch key and owner checkpoint make replays idempotent.
    /// A terminal notice is never reopened by a delayed acceptance projection.
    pub fn dispatch_notice(&mut self, input: &EventInput, clock: Clock) -> Result<()> {
        let Some(dispatch) = input
            .evidence_refs
            .iter()
            .find(|r| matches!(r.kind, EvidenceKind::Request))
            .map(|r| r.id.clone())
        else {
            return Ok(());
        };
        if self.dispatch_notices.contains_key(&dispatch) {
            return Ok(());
        }
        self.transaction(clock, |s| {
            s.prune(clock);
            if s.state.notices.len() >= 256 { return Err("COORDINATION_CAPACITY: retain dispatch projection until bulletin capacity is available".into()); }
            let owner = input.origin.clone().unwrap_or(Principal::Arc);
            let association = input.observation.as_ref().and_then(|o|o.dispatch_association.clone()).unwrap_or(DispatchAssociation {
                source: if input.origin.is_some(){"observed"}else{"unattributed"}.into(),
                session: "unattributed".into(), project: "unattributed".into(), lane: "unattributed".into(), ..Default::default()
            });
            let links = input.thread_refs.iter().filter_map(|thread| {
                let turn = thread.turn_id.as_ref()?;
                Some(Link { thread_id:thread.thread_id.clone(), session_binding_id:None, observed_turn_id:Some(turn.clone()), scope_state:"unknown".into(), observed_at:None, terminals:Default::default() })
            }).collect();
            let at = input.occurred_at.as_deref().and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok()).map(|at|at.timestamp_millis()).unwrap_or(clock.utc);
            let row = Record {
                id:format!("dispatch-{}", hash(&dispatch)), dispatch_id:Some(dispatch), association:Some(association), revision:1, owner, owner_session_id:None,
                resources:input.resources.clone(), intent:Some("ARC dispatch".into()), expected_duration_seconds:None, thread_links:links,
                cause_code:None, summary:None, evidence_ids:vec![], fixing_commit:None, reason:None, suggested_next_step:None,
                created_at:at, last_active_at:at, fresh_activity:false, state:"active".into(), closed_reason:None, ended_at:None, recovery_selection:None, cleared_by:None
            };
            s.event(&row, false)?;
            s.state.notices.push(row);
            Ok(())
        })
    }
    pub fn recipient_resources(&self, source: &str) -> Vec<ResourceKey> {
        self.state.notices.iter().filter(|n| n.state == "active")
            .chain(self.state.blockers.iter().filter(|b| b.state != "cleared"))
            .filter(|row| matches!(&row.owner, Principal::Source { source_id, .. } if source_id == source))
            .flat_map(|row| row.resources.iter().cloned()).collect()
    }
    pub fn replay(&self, request: &str, digest: &str) -> Result<Option<Value>> {
        self.state
            .applied
            .get(request)
            .map(|a| {
                if a.digest == digest {
                    Ok(a.result.clone())
                } else {
                    Err("REQUEST_ID_CONFLICT: retry the original arguments and requestId".into())
                }
            })
            .transpose()
    }
    pub fn mutate(
        &mut self,
        op: &str,
        args: &Value,
        actor: &Principal,
        links: Vec<Link>,
        clock: Clock,
    ) -> Result<Value> {
        self.mutate_routed(op, args, actor, links, clock, None)
    }
    pub fn mutate_routed(
        &mut self,
        op: &str,
        args: &Value,
        actor: &Principal,
        links: Vec<Link>,
        clock: Clock,
        route: Option<crate::claude_notify::coordination_delivery::Outcome>,
    ) -> Result<Value> {
        let request = string(args, "requestId");
        let digest = digest(op, args, actor);
        if let Some(result) = self.replay(request, &digest)? {
            return Ok(result);
        }
        self.transaction(clock, |s| {
            s.prune(clock);
            if s.state.applied.len() >= 2048 { return Err("COORDINATION_CAPACITY: retain original receipts; retry after closed history retention".into()); }
            let bucket = s.state.budgets.entry(owner_key(actor)).or_insert((clock.elapsed, 0));
            if clock.elapsed.saturating_sub(bucket.0) >= 60_000 { *bucket = (clock.elapsed, 0); }
            if bucket.1 >= 30 { return Err("COORDINATION_RATE_LIMIT: retry the same requestId after one minute".into()); }
            bucket.1 += 1;
            let result = s.apply(op, args, actor, links, clock, route)?;
            s.state.applied.insert(request.into(), Applied { digest, result: result.clone(), at: clock.utc });
            Ok(result)
        })
    }
    fn prune(&mut self, clock: Clock) {
        let before =
            self.state.notices.len() + self.state.blockers.len() + self.state.sessions.len();
        let pending = &self.state.pending;
        for rows in [&mut self.state.notices, &mut self.state.blockers] {
            rows.retain(|n| {
                n.ended_at.is_none_or(|at| {
                    clock
                        .age(at)
                        .is_none_or(|a| a < (RETENTION_MS / 1000) as u64)
                }) || pending
                    .iter()
                    .any(|p| p.evidence_refs.iter().any(|e| e.id == n.id))
            });
        }
        self.state.applied.retain(|_, a| {
            clock
                .age(a.at)
                .is_none_or(|age| age < (RETENTION_MS / 1000) as u64)
        });
        self.state
            .budgets
            .retain(|_, (at, _)| clock.elapsed.saturating_sub(*at) < 60_000);
        self.state.sessions.retain(|s| {
            s.state == "active"
                || clock
                    .age(s.last_active_at)
                    .is_none_or(|a| a < (RETENTION_MS / 1000) as u64)
        });
        if before
            != self.state.notices.len() + self.state.blockers.len() + self.state.sessions.len()
        {
            self.state.revision += 1;
        }
    }
    fn apply(
        &mut self,
        op: &str,
        args: &Value,
        actor: &Principal,
        links: Vec<Link>,
        clock: Clock,
        routing: Option<crate::claude_notify::coordination_delivery::Outcome>,
    ) -> Result<Value> {
        if op == "coordination_session" {
            self.state.revision += 1;
            if args["action"] == "register" {
                let own: Vec<_> = self
                    .state
                    .sessions
                    .iter()
                    .filter(|s| same_owner(&s.owner, actor))
                    .collect();
                if self.state.sessions.len() >= 128
                    || own.iter().filter(|s| s.state == "active").count() >= 8
                    || own
                        .iter()
                        .filter(|s| clock.age(s.created_at).is_none_or(|a| a < 3600))
                        .count()
                        >= 4
                {
                    return Err("COORDINATION_CAPACITY: close unused sessions; at most four registrations per hour and eight active sessions per source".into());
                }
                let (mut route, route_failure) = routing.map_or((None, None), |r| {
                    let reason = r.route.is_none().then_some(r.state);
                    (r.route, reason)
                });
                if let Some(route) = &mut route {
                    route.binding_id = Some(id());
                }
                self.state.sessions.push(Session {
                    id: id(),
                    owner: actor.clone(),
                    created_at: clock.utc,
                    last_active_at: clock.elapsed,
                    state: "active".into(),
                    route,
                    route_failure,
                });
                return Ok(
                    json!({"session":self.session_projection(self.state.sessions.last().unwrap())}),
                );
            }
            let row = self
                .state
                .sessions
                .iter_mut()
                .find(|s| s.id == string(args, "sessionId"))
                .ok_or("COORDINATION_NOT_FOUND: read board sessions")?;
            if !same_owner(&row.owner, actor) && *actor != Principal::LocalAuthority {
                return Err("COORDINATION_OWNER_REQUIRED: only the session owner or local authority may close it".into());
            }
            row.state = "closed".into();
            row.route = None;
            row.route_failure = None;
            let row = row.clone();
            return Ok(json!({"session":self.session_projection(&row)}));
        }
        let blocker = op.starts_with("blocker_");
        let posting = matches!(op, "notice_post" | "blocker_open");
        if posting {
            let session = args["sessionId"].as_str();
            if let Some(session) = session {
                if !self
                    .state
                    .sessions
                    .iter()
                    .any(|s| s.id == session && s.state == "active" && same_owner(&s.owner, actor))
                {
                    return Err("COORDINATION_OWNER_REQUIRED: register or select your active coordination session".into());
                }
            }
            let rows = if blocker {
                &self.state.blockers
            } else {
                &self.state.notices
            };
            if rows.len() >= if blocker { 128 } else { 256 }
                || rows
                    .iter()
                    .filter(|n| n.live() && same_owner(&n.owner, actor))
                    .count()
                    >= if blocker { 8 } else { 16 }
            {
                return Err("COORDINATION_CAPACITY: close completed work and retain terminal history for seven days".into());
            }
            let row = Record {
                id: id(),
                dispatch_id: None,
                association: None,
                revision: 1,
                owner: actor.clone(),
                owner_session_id: session.map(str::to_owned),
                resources: resources(args)?,
                intent: args["intent"].as_str().map(str::to_owned),
                expected_duration_seconds: args["expectedDurationSeconds"].as_u64(),
                thread_links: links,
                cause_code: args["causeCode"].as_str().map(str::to_owned),
                summary: args["summary"].as_str().map(str::to_owned),
                evidence_ids: ids(args, "evidenceIds"),
                fixing_commit: None,
                reason: None,
                suggested_next_step: None,
                created_at: clock.utc,
                last_active_at: clock.elapsed,
                fresh_activity: true,
                state: "active".into(),
                closed_reason: None,
                ended_at: None,
                recovery_selection: None,
                cleared_by: None,
            };
            self.event(&row, blocker)?;
            let conflicts = self.conflicts(&row.resources, Some(&row.id), clock);
            let projected = row.project(clock, false);
            if blocker {
                self.state.blockers.push(row);
            } else {
                self.state.notices.push(row);
            }
            return Ok(if blocker {
                json!({"blocker":projected,"conflictCoverage":if conflicts.len()==100 {"partial"}else{"observed"},"conflicts":conflicts})
            } else {
                json!({"notice":projected,"conflictCoverage":if conflicts.len()==100 {"partial"}else{"observed"},"conflicts":conflicts})
            });
        }
        let rows = if blocker {
            &mut self.state.blockers
        } else {
            &mut self.state.notices
        };
        let row = rows
            .iter_mut()
            .find(|n| n.id == string(args, "id"))
            .ok_or("COORDINATION_NOT_FOUND: read board for the current record")?;
        if !same_owner(&row.owner, actor) && *actor != Principal::LocalAuthority {
            return Err("COORDINATION_OWNER_REQUIRED: only the owner or local authority may change this record".into());
        }
        if matches!(op, "notice_close" | "blocker_clear") && !row.live() {
            return Ok(if blocker {
                json!({"blocker":row.project(clock,self.restarted)})
            } else {
                json!({"notice":row.project(clock,self.restarted)})
            });
        }
        if !row.live() {
            return Err(
                "COORDINATION_STATE_CONFLICT: post a new notice for a new work scope".into(),
            );
        }
        if op != "notice_close" && args["expectedRevision"].as_u64() != Some(row.revision) {
            return Err(
                "COORDINATION_REVISION_CONFLICT: read board and use the current revision".into(),
            );
        }
        match op {
            "notice_update" => {
                if let Some(intent) = args["intent"].as_str() {
                    row.intent = Some(intent.into());
                }
                if args["resources"].is_array() {
                    row.resources = resources(args)?;
                }
                if args["threadIds"].is_array() {
                    row.thread_links = links;
                }
                if let Some(seconds) = args["expectedDurationSeconds"].as_u64() {
                    row.expected_duration_seconds = Some(seconds);
                }
                if clock.certain {
                    row.last_active_at = clock.elapsed;
                }
            }
            "notice_close" => {
                row.state = "closed".into();
                row.closed_reason = Some(args["reason"].as_str().unwrap_or("owner-closed").into());
                row.ended_at = Some(clock.utc);
            }
            "blocker_clear" => {
                row.cleared_by = Some(actor.clone());
                if row.state == "stale" {
                    row.recovery_selection = Some(
                        json!({"state":"suppressed","reason":"stale-blocker","recipients":[],"unresolved":[],"automaticResume":false}),
                    );
                }
                row.state = "cleared".into();
                row.ended_at = Some(clock.utc);
                row.fixing_commit = args.get("fixingCommit").cloned();
                row.reason = args["reason"].as_str().map(str::to_owned);
                row.evidence_ids = ids(args, "evidenceIds");
                row.suggested_next_step = args["suggestedNextStep"].as_str().map(str::to_owned);
            }
            _ => return Err("INVALID_ARGUMENT: read guide for bulletin operations".into()),
        }
        row.revision += 1;
        let row = row.clone();
        self.event(&row, blocker)?;
        let conflicts = self.conflicts(&row.resources, Some(&row.id), clock);
        Ok(if blocker {
            json!({"blocker":row.project(clock,self.restarted),"recoverySelection":super::super::recovery::public_selection(&json!(row.recovery_selection))})
        } else {
            json!({"notice":row.project(clock,self.restarted),"conflictCoverage":if conflicts.len()==100 {"partial"}else{"observed"},"conflicts":conflicts})
        })
    }
    fn session_projection(&self, s: &Session) -> Value {
        json!({"id":s.id,"owner":s.owner,"state":s.state,"createdAt":timestamp(s.created_at),"lastActiveAt":timestamp(s.last_active_at)})
    }
    /// Live blockers the reader owns; local authority observes every owner.
    pub fn attention(&self, reader: &Principal) -> Vec<Value> {
        self.state
            .blockers
            .iter()
            .filter(|b| b.live() && (*reader == Principal::LocalAuthority || same_owner(&b.owner, reader)))
            .take(20)
            .map(|b| {
                let mut item = json!({"kind":"blocker","id":b.id,"revision":b.revision,"state":b.state,"resources":b.resources,
                    "summary":b.summary,"next":{"via":"query","op":"board","args":{"id":b.id,"view":"full"}}});
                if let Principal::Source { source_id, .. } = &b.owner {
                    item["ownerSourceId"] = json!(source_id);
                }
                item
            })
            .collect()
    }
    pub fn board(&self, args: &Value, actor_revision: &str, clock: Clock) -> Result<Value> {
        let resource = args["resource"]
            .as_str()
            .map(|r| {
                super::super::types::resolve_resource(
                    r,
                    self.state
                        .notices
                        .iter()
                        .chain(&self.state.blockers)
                        .flat_map(|n| &n.resources),
                )
            })
            .transpose()?;
        let mut filters = args.clone();
        filters.as_object_mut().unwrap().remove("cursor");
        let scope = hash(
            json!([
                self.state.epoch,
                self.state.revision,
                actor_revision,
                filters
            ])
            .to_string(),
        );
        let mut offset = 0;
        if let Some(cursor) = args["cursor"].as_str() {
            let decoded = URL_SAFE_NO_PAD
                .decode(cursor)
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                .ok_or("COORDINATION_CURSOR_EXPIRED: restart board pagination")?;
            if decoded["scope"] != scope
                || decoded["at"]
                    .as_i64()
                    .is_none_or(|at| clock.age(at).is_none_or(|a| a > 900))
            {
                return Err("COORDINATION_CURSOR_EXPIRED: restart board pagination".into());
            }
            offset = decoded["offset"]
                .as_u64()
                .ok_or("COORDINATION_CURSOR_EXPIRED: restart board pagination")?
                as usize;
        }
        let all: Vec<_> = self
            .state
            .notices
            .iter()
            .map(|n| (false, n))
            .chain(self.state.blockers.iter().map(|n| (true, n)))
            .filter(|(_, n)| resource.as_ref().is_none_or(|r| n.resources.contains(r)))
            .filter(|(_, n)| args["id"].as_str().is_none_or(|id| id == n.id))
            .filter(|(_, n)| {
                args["state"]
                    .as_str()
                    .map_or(n.live() || args["id"].is_string(), |state| {
                        state == "all" || state == n.state
                    })
            })
            .collect();
        let limit = args["limit"].as_u64().unwrap_or(50) as usize;
        let mut notices = vec![];
        let mut blockers = vec![];
        let mut lines = vec![];
        let sessions = if args["includeSessions"] == true {
            json!(self
                .state
                .sessions
                .iter()
                .map(|s| self.session_projection(s))
                .collect::<Vec<_>>())
        } else {
            Value::Null
        };
        let mut bytes = 512 + sessions.to_string().len();
        let mut count = 0;
        for (blocker, n) in all.iter().skip(offset).take(limit) {
            let mut projection = n.project(clock, self.restarted);
            if args["view"] != "full" {
                projection.as_object_mut().unwrap().retain(|key, _| {
                    matches!(
                        key.as_str(),
                        "id" | "revision"
                            | "dispatchId"
                            | "provenance"
                            | "association"
                            | "ownerSourceId"
                            | "localOrigin"
                            | "ownerSessionId"
                            | "lastActiveAt"
                            | "inactivityAgeSeconds"
                            | "observedAt"
                            | "activityCoverage"
                            | "state"
                    )
                });
            }
            if args["view"].is_null() || args["view"] == "digest" {
                projection["conflictCount"] =
                    json!(self.conflicts(&n.resources, Some(&n.id), clock).len());
            }
            let age = clock
                .age(n.last_active_at)
                .map(|age| format!("{age}s"))
                .unwrap_or_else(|| "unknown".into());
            let line = format!(
                "{} {} {} age={} {} {}",
                if *blocker { "blocker" } else { "notice" },
                n.id,
                n.state,
                age,
                n.resources
                    .iter()
                    .map(ResourceKey::as_str)
                    .collect::<Vec<_>>()
                    .join(","),
                n.intent
                    .as_ref()
                    .or(n.summary.as_ref())
                    .map(String::as_str)
                    .unwrap_or("")
            );
            bytes += projection.to_string().len() + line.len() + 8;
            if bytes > 120 * 1024 {
                break;
            }
            if *blocker {
                blockers.push(projection);
            } else {
                notices.push(projection);
            }
            lines.push(line);
            count += 1;
        }
        let next = (offset + count < all.len()).then(|| {
            URL_SAFE_NO_PAD
                .encode(json!({"scope":scope,"at":clock.utc,"offset":offset+count}).to_string())
        });
        let mut result = json!({"notices":notices,"blockers":blockers,"summary":lines.join("\n"),"nextCursor":next,"observedAt":timestamp(clock.utc),"activityCoverage":if clock.certain {"observed"}else{"clock-uncertain"}});
        if args["includeSessions"] == true {
            result["sessions"] = sessions;
        }
        Ok(result)
    }
}

impl Store {
    pub fn recovery_blocker(&self, id: &str, clock: Clock) -> Option<Value> {
        self.state.blockers.iter().find(|r| r.id == id).map(|r| {
            let mut value = r.project(clock, self.restarted);
            value["recoverySelection"] = json!(r.recovery_selection);
            value
        })
    }
    pub fn recovery_plan(&mut self, id: &str, plan: Value, clock: Clock) -> Result<Value> {
        self.transaction(clock, |s| {
            let row = s
                .state
                .blockers
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or("COORDINATION_NOT_FOUND: blocker unavailable")?;
            if row.recovery_selection.is_none() {
                row.recovery_selection = Some(plan);
            }
            Ok(row.recovery_selection.clone().unwrap())
        })
    }
}
