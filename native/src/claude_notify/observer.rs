//! Reuse settled native observations until their evidence changes.
use super::*;

pub(super) struct TerminalWatch {
    pub path: PathBuf,
    pub stamp: Option<file_cache::Stamp>,
    pub execution: Option<file_cache::Stamp>,
    pub cursor: u64,
}

pub(super) fn execution_path(thread: &str) -> PathBuf {
    root().join("execution").join(format!("{thread}.json"))
}

pub(super) struct ThreadEvents {
    first: u64,
    pub cursor: u64,
    latest: std::collections::HashMap<String, u64>,
}
impl ThreadEvents {
    pub fn new(rows: &[Value], cursor: u64) -> Self {
        let mut latest = std::collections::HashMap::new();
        for row in rows {
            for key in ["threadId", "conversationId"] {
                if let Some(thread) = row["params"][key].as_str() {
                    latest.insert(thread.to_owned(), row["cursor"].as_u64().unwrap_or(0));
                }
            }
        }
        Self {
            first: rows
                .first()
                .and_then(|row| row["cursor"].as_u64())
                .unwrap_or(cursor),
            cursor,
            latest,
        }
    }
    pub fn changed_since(&self, cursor: u64, thread: &str) -> bool {
        // A buffer gap requires a fresh native read. Unrelated streams do not.
        self.first > cursor.saturating_add(1)
            || self
                .latest
                .get(thread)
                .is_some_and(|latest| *latest > cursor)
    }
}

pub(super) fn reusable(b: &Binding) -> bool {
    quiet_terminal(b)
        && b.observation["reconciliation"] == "reconciled"
        && !matches!(string(&b.retry, "status"), "scheduled" | "submitting")
}

impl TerminalWatch {
    pub fn unchanged(&self, b: &Binding, events: &ThreadEvents) -> Result<bool> {
        Ok(reusable(b)
            && self.stamp.is_some()
            && file_cache::Stamp::read(&self.path)? == self.stamp
            && file_cache::Stamp::read(&execution_path(&b.thread_id))? == self.execution
            && !events.changed_since(self.cursor, &b.thread_id))
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
    fn relevant_events_and_buffer_gaps_invalidate_terminal_evidence() {
        // Property: a terminal observation survives unrelated events but never a newer thread event or event-buffer gap.
        let mut rows = vec![json!({"cursor":10,"params":{"threadId":"other"}})];
        assert!(!ThreadEvents::new(&rows, 10).changed_since(9, "thread"));
        rows.push(json!({"cursor":11,"params":{"conversationId":"thread"}}));
        assert!(ThreadEvents::new(&rows, 11).changed_since(9, "thread"));
        assert!(!ThreadEvents::new(&rows, 11).changed_since(11, "thread"));
        assert!(ThreadEvents::new(&rows, 11).changed_since(1, "thread"));
        rows[1]["params"] = json!({"threadId":"thread"});
        assert!(ThreadEvents::new(&rows, 11).changed_since(10, "thread"));
    }
}
