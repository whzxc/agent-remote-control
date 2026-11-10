//! Bounded owner snapshot. Only typed metadata reaches the shared projection.
use super::*;
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
    pub terminals: BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    pub id: String,
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
        } else if self
            .thread_links
            .iter()
            .any(|l| l.scope_state == "unknown" || l.scope_state == "interrupted")
        {
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
            _ => result["localOrigin"] = json!(true),
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
        };
        // Persisted running is historical evidence, never a new heartbeat after restart.
        for n in &mut result.state.notices {
            for link in &mut n.thread_links {
                if link.scope_state == "running" {
                    link.scope_state = "unknown".into();
                }
            }
        }
        Ok(result)
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
        for row in self
            .state
            .notices
            .iter_mut()
            .chain(&mut self.state.blockers)
        {
            if row.live() && same_owner(&row.owner, owner) && clock.elapsed > row.last_active_at {
                row.last_active_at = clock.elapsed;
                row.fresh_activity = true;
                self.dirty = true;
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
        crate::runtime_metrics::cost::scan_set(self.state.notices.len());
        self.state
            .notices
            .iter()
            .inspect(|_| crate::runtime_metrics::cost::rows(1))
            .filter(|n| n.live())
            .flat_map(|n| &n.thread_links)
            .map(|l| l.thread_id.clone())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }
    pub fn missing(&mut self, observed: &[String]) {
        for notice in self
            .state
            .notices
            .iter_mut()
            .inspect(|_| crate::runtime_metrics::cost::rows(1))
            .filter(|n| n.live())
        {
            for link in &mut notice.thread_links {
                if link.scope_state == "running" && !observed.contains(&link.thread_id) {
                    link.scope_state = "unknown".into();
                    self.dirty = true;
                }
            }
        }
    }
    pub fn successor(&mut self, thread: &str, previous: &str, next: &str, owner: &Principal) {
        for notice in self
            .state
            .notices
            .iter_mut()
            .filter(|n| n.live() && same_owner(&n.owner, owner))
        {
            for link in notice.thread_links.iter_mut().filter(|l| {
                l.thread_id == thread && l.observed_turn_id.as_deref() == Some(previous)
            }) {
                link.observed_turn_id = Some(next.into());
                link.scope_state = link
                    .terminals
                    .get(next)
                    .cloned()
                    .unwrap_or_else(|| "unknown".into());
                self.dirty = true;
            }
        }
    }
    pub fn checkpoint_observation(&mut self, clock: Clock) -> Result<()> {
        if self.dirty {
            self.save(clock)?;
        }
        Ok(())
    }
    pub fn observe(&mut self, thread: &str, turn: &str, state: &str, clock: Clock, live: bool) {
        if types::identifier(turn).is_err() {
            return;
        }
        for notice in self
            .state
            .notices
            .iter_mut()
            .inspect(|_| crate::runtime_metrics::cost::rows(1))
            .filter(|n| n.live())
        {
            for link in notice
                .thread_links
                .iter_mut()
                .filter(|l| l.thread_id == thread)
            {
                // Retain bounded terminal evidence if a successor descriptor arrives later.
                if matches!(state, "completed" | "interrupted")
                    && link.terminals.get(turn).is_none_or(|old| old != state)
                {
                    if link.terminals.len() == 16 {
                        link.terminals
                            .remove(&link.terminals.keys().next().unwrap().clone());
                    }
                    link.terminals.insert(turn.into(), state.into());
                    self.dirty = true;
                }
                // Only a durable source-matched successor descriptor can advance the scope.
                if link.observed_turn_id.as_deref() != Some(turn) {
                    if link.scope_state == "running" {
                        link.scope_state = "unknown".into();
                        self.dirty = true;
                    }
                    continue;
                }
                if state == "running"
                    && link.scope_state == "completed"
                    && link.observed_turn_id.as_deref() == Some(turn)
                {
                    continue;
                }
                let changed =
                    link.observed_turn_id.as_deref() != Some(turn) || link.scope_state != state;
                if !changed && state != "running" {
                    continue;
                }
                link.observed_turn_id = Some(turn.into());
                link.scope_state = state.into();
                if clock.certain && live && state != "unknown" {
                    link.observed_at = Some(clock.elapsed);
                    notice.last_active_at = notice.last_active_at.max(clock.elapsed);
                    notice.fresh_activity = true;
                }
                self.dirty = true;
            }
        }
    }
    pub fn maintain(&mut self, revoked: &[String], clock: Clock) -> Result<()> {
        let mut updates = vec![];
        for (blocker, rows) in [(false, &self.state.notices), (true, &self.state.blockers)] {
            for (index, row) in rows.iter().enumerate().filter(|(_, n)| n.live()) {
                let revoked = matches!(&row.owner, Principal::Source { source_id, .. } if revoked.contains(source_id));
                let inactive = clock
                    .age(row.last_active_at)
                    .is_some_and(|age| age >= (INACTIVE_MS / 1000) as u64);
                let ended = !row.thread_links.is_empty()
                    && row
                        .thread_links
                        .iter()
                        .all(|l| l.scope_state == "completed");
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
        let removable = self
            .state
            .notices
            .iter()
            .chain(&self.state.blockers)
            .any(|n| {
                n.ended_at.is_some_and(|at| {
                    clock
                        .age(at)
                        .is_some_and(|age| age >= (RETENTION_MS / 1000) as u64)
                }) && !self
                    .state
                    .pending
                    .iter()
                    .any(|p| p.evidence_refs.iter().any(|e| e.id == n.id))
            });
        if updates.is_empty() && !removable {
            return self.flush(clock);
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
        self.state.notices.iter().filter(|n| n.state == "active" && Some(n.id.as_str()) != exclude)
            .flat_map(|n| n.resources.iter().filter(|r| resources.contains(r)).map(move |r| json!({"noticeId":n.id,"resource":r,"state":n.state,"lastActiveAt":timestamp(n.last_active_at),"inactivityAgeSeconds":clock.age(n.last_active_at)}))).collect()
    }
    pub fn lifecycle_conflicts(
        &self,
        resources: &[ResourceKey],
        source: Option<&str>,
        clock: Clock,
    ) -> Vec<Value> {
        let owned: std::collections::HashSet<_> = self.state.notices.iter()
            .filter(|n| matches!(&n.owner, Principal::Source { source_id, .. } if Some(source_id.as_str()) == source))
            .map(|n| n.id.as_str()).collect();
        self.conflicts(resources, None, clock)
            .into_iter()
            .filter(|n| !owned.contains(crate::string(n, "noticeId")))
            .collect()
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
