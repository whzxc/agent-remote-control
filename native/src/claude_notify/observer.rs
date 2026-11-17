//! Reuse settled or exhausted observations until their evidence changes.
use super::*;

pub(super) struct TerminalWatch {
    pub path: Option<PathBuf>,
    pub stamp: Option<file_cache::Stamp>,
    pub execution: Option<file_cache::Stamp>,
    pub writer: String,
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
pub(super) fn execution_path(thread: &str) -> PathBuf {
    root().join("execution").join(format!("{thread}.json"))
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
        Self::from_path(b, path)
    }
    pub fn from_path(b: &Binding, path: Option<PathBuf>) -> Self {
        let stamp = path
            .as_ref()
            .and_then(|p| file_cache::Stamp::read(p).ok().flatten());
        Self {
            path,
            stamp,
            execution: file_cache::Stamp::read(&execution_path(&b.thread_id))
                .ok()
                .flatten(),
            writer: string(&crate::writer::probe(&b.thread_id), "state").into(),
        }
    }
    pub fn changed(&self, b: &Binding) -> Result<bool> {
        Ok(self
            .path
            .as_ref()
            .map(|path| file_cache::Stamp::read(path))
            .transpose()?
            .flatten()
            != self.stamp
            || file_cache::Stamp::read(&execution_path(&b.thread_id))? != self.execution
            || string(&crate::writer::probe(&b.thread_id), "state") != self.writer)
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
}
