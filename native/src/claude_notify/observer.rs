//! Reuse settled or exhausted observations until their evidence changes.
use super::*;

pub(super) struct TerminalWatch {
    pub path: Option<PathBuf>,
    pub stamp: Option<file_cache::Stamp>,
    pub execution: Option<file_cache::Stamp>,
    pub cursor: u64,
    pub writer: String,
}

pub(super) const RECONCILIATION_ATTEMPTS: u64 = 3;
pub(super) fn exhausted(b: &Binding) -> bool {
    b.observation["reconciliation"] == "unavailable-after-restart"
}
pub(super) fn unavailable(previous: &Value, reason: &str) -> Value {
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
                    .utility()
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

    #[test]
    fn only_settled_terminal_observations_can_be_reused() {
        // Regression: completed and cancelled bindings repeatedly hydrated unchanged native histories at idle.
        let mut b: Binding = serde_json::from_value(json!({
            "threadId":"thread","turnId":"turn","target":null,"project":"",
            "terminal":true,"createdAt":0,"waiting":[],"deliveries":[],
            "observation":{"state":"completed","reconciliation":"reconciled"}
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
        b.terminal = false;
        assert!(!reusable(&b));
        b.terminal = true;
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
            "observation":{"state":"completed","reconciliation":"reconciled"}}),
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
        b.terminal = false;
        assert!(!super::super::expired(&b, RETENTION_SECONDS + 2, true));
        b.terminal = true;
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
        b.terminal = false;
        b.observation = json!({"state":"unconfirmed"});
        for _ in 0..RECONCILIATION_ATTEMPTS {
            b.observation = unavailable(&b.observation, "native-read-unavailable");
        }
        assert!(exhausted(&b));
        assert!(reusable(&b));
        assert_eq!(b.observation["state"], "unconfirmed");
        assert!(!b.terminal);
        assert_eq!(
            unavailable(&b.observation, "still-unavailable")["reconciliationAttempts"],
            RECONCILIATION_ATTEMPTS
        );
    }
}
