//! Reuse settled or exhausted observations until their evidence changes.
use super::*;

/// History-wide maps used by a non-skipped pass. Keep the visit count explicit
/// so activity indexing can replace this cost boundary without hiding its slope.
pub(super) struct ScanSet {
    pub paths: std::collections::HashSet<PathBuf>,
    pub latest: std::collections::HashMap<(String, String), i64>,
    pub rows_visited: usize,
}
pub(super) fn scan_set(dir: &Path, all: &[Arc<Binding>]) -> ScanSet {
    let mut rows_visited = 0;
    let paths = all
        .iter()
        .map(|b| {
            rows_visited += 1;
            path_in(dir, &b.thread_id, &b.turn_id)
        })
        .collect();
    let mut latest = std::collections::HashMap::<(String, String), i64>::new();
    for b in all {
        rows_visited += 1;
        let created = latest
            .entry((b.source_id.clone(), b.thread_id.clone()))
            .or_default();
        *created = (*created).max(b.created_at);
    }
    ScanSet {
        paths,
        latest,
        rows_visited,
    }
}

pub(super) fn scan_for_pass(dir: &Path, all: &[Arc<Binding>]) -> ScanSet {
    let scan = scan_set(dir, all);
    crate::runtime_metrics::cost::scan_set(all.len());
    crate::runtime_metrics::cost::bindings(all.len(), 0, 0);
    crate::runtime_metrics::cost::rows(scan.rows_visited);
    scan
}

pub(super) struct TerminalWatch {
    pub path: Option<PathBuf>,
    pub stamp: Option<file_cache::Stamp>,
    pub execution: Option<file_cache::Stamp>,
    pub cursor: u64,
    pub writer: String,
}

#[derive(Default)]
pub(super) struct Idle {
    bindings: Option<Arc<Vec<Arc<Binding>>>>,
    cursor: u64,
    changes: Option<file_cache::Changes>,
    revision: Option<u64>,
    next_at: Option<i64>,
    writers: Vec<(String, String)>,
}
impl Idle {
    pub fn unchanged(&self, all: &Arc<Vec<Arc<Binding>>>, cursor: u64, now: i64) -> bool {
        self.bindings
            .as_ref()
            .is_some_and(|old| Arc::ptr_eq(old, all))
            && self.cursor == cursor
            && self.next_at.is_none_or(|at| now < at)
            && self
                .writers
                .iter()
                .all(|(thread, state)| string(&crate::writer::probe(thread), "state") == state)
            && self.revision.is_some()
            && self.changes.as_ref().and_then(|c| c.revision()) == self.revision
    }
    pub fn capture(
        &mut self,
        all: &Arc<Vec<Arc<Binding>>>,
        watches: &std::collections::HashMap<PathBuf, TerminalWatch>,
        events: &ThreadEvents,
        latest: &std::collections::HashMap<(String, String), i64>,
        now: i64,
    ) {
        self.bindings = None;
        let mut paths = vec![root().join("execution"), root().join("agents/tasks")];
        let mut next = None;
        let mut writers = Vec::new();
        for b in all
            .iter()
            .inspect(|_| crate::runtime_metrics::cost::rows(1))
            .filter(|b| !b.source_id.is_empty())
        {
            let closed = b.terminal()
                && b.observation["reconciliation"] != "pending-after-restart"
                && (b.scope_end.is_some() || b.continuation_bound);
            if !closed {
                let Some(watch) = watches.get(&path_in(&directory(), &b.thread_id, &b.turn_id))
                else {
                    return;
                };
                if !reusable(b) || watch.changed(b, events).unwrap_or(true) {
                    return;
                }
                if (b.agent.is_empty() || b.agent == "codex") && watch.writer != "unheld" {
                    let writer = (b.thread_id.clone(), watch.writer.clone());
                    if !writers.contains(&writer) {
                        writers.push(writer);
                    }
                }
                if let Some(path) = &watch.path {
                    paths.push(path.clone());
                }
                if let Ok(path) = crate::writer::lock_path(&b.thread_id) {
                    paths.push(path);
                }
            }
            if b.terminal()
                && (closed || superseded(b, latest))
                && !b
                    .deliveries
                    .iter()
                    .any(|d| matches!(d.status.as_str(), "pending" | "sending"))
            {
                let at = b
                    .created_at
                    .saturating_add(RETENTION_SECONDS)
                    .saturating_add(1);
                if at <= now {
                    return;
                }
                next = Some(next.map_or(at, |old: i64| old.min(at)));
            }
        }
        // Install watches before validating the observed stamps to cover changes during setup.
        let Ok(changes) = file_cache::Changes::new(paths) else {
            return;
        };
        let revision = changes.revision();
        for b in all
            .iter()
            .inspect(|_| crate::runtime_metrics::cost::rows(1))
            .filter(|b| {
                !b.source_id.is_empty()
                    && !(b.terminal() && (b.scope_end.is_some() || b.continuation_bound))
            })
        {
            if let Some(watch) = watches.get(&path_in(&directory(), &b.thread_id, &b.turn_id)) {
                if watch.changed(b, events).unwrap_or(true) {
                    return;
                }
            }
        }
        self.revision = revision;
        self.changes = Some(changes);
        self.next_at = next;
        self.writers = writers;
        self.cursor = events.cursor;
        self.bindings = Some(all.clone());
    }
}

pub(super) const RECONCILIATION_ATTEMPTS: u64 = 3;
pub(super) fn exhausted(b: &Binding) -> bool {
    b.observation["reconciliation"] == "unavailable-after-restart"
}
pub(super) fn unavailable(b: &mut Binding, reason: &str) -> Value {
    lifecycle::loss(b);
    let previous = &b.observation;
    let mut observation = if previous.is_object() {
        previous.clone()
    } else {
        json!({})
    };
    let attempts = previous["reconciliationAttempts"]
        .as_u64()
        .unwrap_or(0)
        .saturating_add(1)
        .min(RECONCILIATION_ATTEMPTS);
    observation["reconciliationAttempts"] = json!(attempts);
    observation["reconciliation"] = json!(if attempts >= RECONCILIATION_ATTEMPTS {
        "unavailable-after-restart"
    } else {
        "pending-after-restart"
    });
    observation["lastError"] = json!(reason);
    lifecycle::project(b, &mut observation);
    observation
}
pub(super) fn ownership_needed(b: &Binding, changed: bool) -> bool {
    b.scope_end.is_none()
        && (b.agent.is_empty() || b.agent == "codex")
        && (changed
            || !b.waiting.is_empty()
            || pending_interaction(b)
            || matches!(
                string(&b.observation, "state"),
                "running" | "interaction-required"
            ))
}
fn pending_interaction(b: &Binding) -> bool {
    b.deliveries.iter().any(|d| {
        !d.interaction.is_null()
            && d.interaction["resolved"] != true
            && matches!(d.status.as_str(), "pending" | "sending")
    })
}
pub(super) fn superseded(
    b: &Binding,
    latest: &std::collections::HashMap<(String, String), i64>,
) -> bool {
    latest
        .get(&(b.source_id.clone(), b.thread_id.clone()))
        .is_some_and(|created| *created > b.created_at)
}

pub(super) fn execution_path(thread: &str) -> PathBuf {
    root().join("execution").join(format!("{thread}.json"))
}

pub(super) struct ThreadEvents {
    forgotten: u64,
    pub cursor: u64,
    latest: std::collections::HashMap<String, u64>,
}
impl ThreadEvents {
    pub fn new(events: &Events) -> Self {
        Self {
            forgotten: events.forgotten_thread_sequence,
            cursor: events.sequence,
            latest: events.thread_sequences.clone(),
        }
    }
    pub fn changed_since(&self, cursor: u64, thread: &str) -> bool {
        // Payload eviction is unrelated to this thread. Only forgotten thread
        // identities require conservative repair, not a busy peer's large frames.
        self.latest
            .get(thread)
            .map_or(self.forgotten > cursor, |latest| *latest > cursor)
    }
    pub fn has_thread(&self, thread: &str) -> bool {
        self.latest.contains_key(thread)
    }
}

pub(super) fn reusable(b: &Binding) -> bool {
    ((quiet_terminal(b) && b.observation["reconciliation"] == "reconciled") || exhausted(b))
        && b.waiting.is_empty()
        && !pending_interaction(b)
        && !matches!(string(&b.retry, "status"), "scheduled" | "submitting")
}

impl TerminalWatch {
    pub async fn capture(
        control: &Arc<control::Control>,
        b: &Binding,
        previous: Option<&Self>,
        events: &ThreadEvents,
    ) -> Self {
        let path = if let Some(path) = previous.and_then(|p| p.path.clone()) {
            Some(path)
        } else if b.agent.is_empty() || b.agent == "codex" {
            // Metadata reads neither acquire a writer nor discover Desktop owners.
            let metadata = async {
                control
                    .thread_rpc(&b.thread_id)
                    .await?
                    .call(
                        "thread/read",
                        json!({"threadId":b.thread_id,"includeTurns":false}),
                        2000,
                    )
                    .await
            };
            match tokio::time::timeout(Duration::from_secs(3), metadata).await {
                Ok(Ok(value)) => value["thread"]["path"].as_str().map(PathBuf::from),
                _ => None,
            }
        } else {
            None
        };
        Self::from_path(b, path, events.cursor)
    }
    pub fn from_path(b: &Binding, path: Option<PathBuf>, cursor: u64) -> Self {
        let stamp = path
            .as_ref()
            .and_then(|p| file_cache::Stamp::read(p).ok().flatten());
        Self {
            path,
            stamp,
            execution: file_cache::Stamp::read(&execution_path(&b.thread_id))
                .ok()
                .flatten(),
            cursor,
            writer: string(&crate::writer::probe(&b.thread_id), "state").into(),
        }
    }
    pub fn changed(&self, b: &Binding, events: &ThreadEvents) -> Result<bool> {
        Ok(self
            .path
            .as_ref()
            .map(|path| file_cache::Stamp::read(path))
            .transpose()?
            .flatten()
            != self.stamp
            || file_cache::Stamp::read(&execution_path(&b.thread_id))? != self.execution
            || string(&crate::writer::probe(&b.thread_id), "state") != self.writer
            || events.changed_since(self.cursor, &b.thread_id))
    }
    pub fn unchanged(&self, b: &Binding, events: &ThreadEvents) -> Result<bool> {
        Ok(reusable(b) && !self.changed(b, events)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn retained_history_increases_observer_visits_with_fixed_active_work() {
        // Regression: ax-090844fd observer map construction revisits retained completed history beside a fixed active workload.
        use crate::runtime_metrics::cost::{self, Owner, Reason};
        let control = control::Control::new(PathBuf::new());
        let fixture = |completed: usize| {
            let mut active = binding();
            active.lifecycle = Value::Null;
            active.turn_id = "active".into();
            active.observation = json!({"state":"running"});
            let mut rows = vec![Arc::new(active)];
            rows.extend((0..completed).map(|n| {
                let mut row = binding();
                row.turn_id = format!("completed-{n}");
                Arc::new(row)
            }));
            rows
        };
        let before = control.tool("runtime_metrics", json!({})).await.unwrap();
        cost::scope(Owner::NotificationObserver, Reason::Timer, async {
            scan_for_pass(Path::new("fixture"), &fixture(4))
        })
        .await;
        let middle = control.tool("runtime_metrics", json!({})).await.unwrap();
        cost::scope(Owner::NotificationObserver, Reason::Event, async {
            scan_for_pass(Path::new("fixture"), &fixture(40))
        })
        .await;
        let after = control.tool("runtime_metrics", json!({})).await.unwrap();
        let metric =
            |v: &Value, key: &str| v["cost"]["notificationObserver"][key].as_u64().unwrap();
        let small_visits = metric(&middle, "rowsVisited") - metric(&before, "rowsVisited");
        let large_visits = metric(&after, "rowsVisited") - metric(&middle, "rowsVisited");
        assert!(small_visits > 0);
        assert!(large_visits > small_visits);
        assert_eq!(
            metric(&after, "recordsChanged"),
            metric(&before, "recordsChanged")
        );
        assert_eq!(metric(&after, "passes") - metric(&before, "passes"), 2);
        assert_eq!(metric(&middle, "scanSetSize"), 5);
        assert_eq!(metric(&after, "scanSetSize"), 41);
        println!(
            "runtime_metrics observer fixture: {}",
            json!({"small":middle["cost"]["notificationObserver"],"large":after["cost"]["notificationObserver"]})
        );
    }

    #[test]
    fn only_settled_terminal_observations_can_be_reused() {
        // Regression: completed and cancelled bindings repeatedly hydrated unchanged native histories at idle.
        let mut b: Binding = serde_json::from_value(json!({
            "threadId":"thread","turnId":"turn","target":null,"project":"",
            "terminal":true,"createdAt":0,"waiting":[],"deliveries":[],
            "observation":{"state":"completed","recordedStatus":"completed","reconciliation":"reconciled"}
        }))
        .unwrap();
        assert!(reusable(&b));
        b.observation["state"] = json!("cancelled");
        b.continuation_until = i64::MAX;
        assert!(reusable(&b));
        b.retry = json!({"status":"scheduled"});
        assert!(!reusable(&b));
        b.retry["status"] = json!("submitting");
        assert!(!reusable(&b));
        b.retry = Value::Null;
        b.observation["reconciliation"] = json!("pending-after-restart");
        assert!(!reusable(&b));
        b.observation["reconciliation"] = json!("reconciled");
        super::super::tests::fixture_state(&mut b, "running");
        assert!(!reusable(&b));
        super::super::tests::fixture_state(&mut b, "completed");
        b.waiting.push("approval".into());
        assert!(!reusable(&b));
    }

    #[test]
    fn unrelated_payload_eviction_does_not_invalidate_terminal_evidence() {
        // Regression: a busy peer's large Desktop frames evicted the payload buffer and invalidated every historical thread.
        let mut events = Events {
            sequence: 1000,
            thread_sequences: [("other".into(), 1000)].into(),
            ..Default::default()
        };
        assert!(!ThreadEvents::new(&events).changed_since(1, "thread"));
        events.thread_sequences.insert("thread".into(), 1001);
        events.sequence = 1001;
        assert!(ThreadEvents::new(&events).changed_since(1, "thread"));
        assert!(!ThreadEvents::new(&events).changed_since(1001, "thread"));
        events.thread_sequences.remove("thread");
        events.forgotten_thread_sequence = 1001;
        assert!(ThreadEvents::new(&events).changed_since(1, "thread"));
    }

    fn binding() -> Binding {
        serde_json::from_value(
            json!({"threadId":"thread","turnId":"turn","sourceId":"source","target":null,
            "project":"","terminal":true,"createdAt":1,"waiting":[],"deliveries":[],
            "observation":{"state":"completed","recordedStatus":"completed","reconciliation":"reconciled"}}),
        )
        .unwrap()
    }
    #[test]
    fn settled_history_needs_no_owner_discovery_until_evidence_changes() {
        // Regression: every open completed scope discovered its Desktop owner on every notification pass.
        let mut b = binding();
        assert!(!ownership_needed(&b, false));
        assert!(ownership_needed(&b, true));
        b.observation["state"] = json!("running");
        assert!(ownership_needed(&b, false));
        b.observation["state"] = json!("unconfirmed");
        b.waiting.push("approval".into());
        assert!(ownership_needed(&b, false));
        b.scope_end = Some("thread-archived".into());
        assert!(!ownership_needed(&b, true));
    }
    #[test]
    fn first_watch_detects_history_changes_without_a_previous_watch() {
        // Regression: initial TerminalWatch had no stamp and needed repeated full observations before it could reuse evidence.
        let b = binding();
        let path = std::env::temp_dir().join(format!("arc-watch-{}", id()));
        std::fs::write(&path, "before").unwrap();
        let watch = TerminalWatch::from_path(&b, Some(path.clone()), 0);
        let events = ThreadEvents::new(&Events::default());
        assert!(watch.unchanged(&b, &events).unwrap());
        std::fs::write(&path, "after replacement").unwrap();
        assert!(!watch.unchanged(&b, &events).unwrap());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn retention_preserves_latest_resume_scope_and_pending_delivery() {
        // Property: only settled older same-source turns gain superseded retention; the latest interrupted scope remains open.
        let mut b = binding();
        b.observation["state"] = json!("cancelled");
        b.continuation_until = i64::MAX;
        let mut latest = std::collections::HashMap::new();
        latest.insert(("other".into(), b.thread_id.clone()), 2);
        assert!(!superseded(&b, &latest));
        assert!(!super::super::expired(&b, RETENTION_SECONDS + 2, false));
        latest.insert((b.source_id.clone(), b.thread_id.clone()), 2);
        assert!(superseded(&b, &latest));
        assert!(super::super::expired(&b, RETENTION_SECONDS + 2, true));
        super::super::tests::fixture_state(&mut b, "running");
        assert!(!super::super::expired(&b, RETENTION_SECONDS + 2, true));
        super::super::tests::fixture_state(&mut b, "completed");
        let delivery: Delivery = serde_json::from_value(
            json!({"key":"terminal","target":"target","state":"completed","status":"pending"}),
        )
        .unwrap();
        b.deliveries.push(delivery);
        assert!(!super::super::expired(&b, RETENTION_SECONDS + 2, true));
    }
    #[test]
    fn reconciliation_exhaustion_preserves_unknown_task_state() {
        // Regression: unavailable startup histories remained pending-after-restart and retried forever.
        let mut b = binding();
        super::super::tests::fixture_state(&mut b, "running");
        b.observation = json!({"state":"unconfirmed"});
        for _ in 0..RECONCILIATION_ATTEMPTS {
            b.observation = unavailable(&mut b, "native-read-unavailable");
        }
        assert!(exhausted(&b));
        assert!(reusable(&b));
        assert_eq!(b.observation["state"], "unconfirmed");
        assert!(!b.terminal());
        assert_eq!(
            unavailable(&mut b, "still-unavailable")["reconciliationAttempts"],
            RECONCILIATION_ATTEMPTS
        );
    }
}
