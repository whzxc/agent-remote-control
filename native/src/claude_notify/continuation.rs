//! Native retry provenance, bounded by the predecessor's persisted terminal time.
use super::*;

const WINDOW_SECONDS: i64 = 10 * 60;

pub(crate) fn evidence(thread: &Value, previous: &str, next: Option<&Value>) -> Value {
    // Keep the existing owner observation cheap while waiting for a successor.
    // Only read persisted provenance when the snapshot actually has a candidate.
    let Some(next) = next else {
        return Value::Null;
    };
    if next["items"]
        .as_array()
        .is_some_and(|items| items.iter().any(|i| i["type"] == "userMessage"))
    {
        return json!({"excluded":true});
    }
    let read = || -> Result<Value> {
        let text = control::persisted_history(thread)?;
        let mut matched = false;
        let mut active = String::new();
        let mut ended = None;
        let mut successor = Value::Null;
        let mut input = false;
        let mut configuration = Value::Null;
        for line in text.lines() {
            // Partial/malformed history cannot prove the absence of new user input.
            let event: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
            let p = &event["payload"];
            if event["type"] == "session_meta" {
                matched = p["id"] == thread["id"];
            }
            if !matched {
                continue;
            }
            if event["type"] == "event_msg" && p["type"] == "task_started" {
                if active == previous && p["turn_id"] != previous {
                    successor = p.clone();
                }
                active = string(p, "turn_id").into();
            }
            if event["type"] == "event_msg"
                && p["turn_id"] == previous
                && matches!(string(p, "type"), "task_complete" | "turn_aborted")
            {
                ended = p["completed_at"].as_i64().or_else(|| {
                    chrono::DateTime::parse_from_rfc3339(string(&event, "timestamp"))
                        .ok()
                        .map(|t| t.timestamp())
                });
            }
            if successor["turn_id"].as_str() != Some(active.as_str()) {
                continue;
            }
            if (event["type"] == "response_item" && p["role"] == "user")
                || (event["type"] == "event_msg" && p["type"] == "user_message")
            {
                input = true;
            }
            if event["type"] == "turn_context"
                && p["turn_id"] == active
                && p["cwd"] == thread["cwd"]
                && p["model"].is_string()
                && p["effort"].is_string()
                && p.get("service_tier").is_some()
            {
                configuration = json!({"model":p["model"],"effort":p["effort"],
                    "serviceTier":p["service_tier"],"source":"native-persisted-turn-context"});
            }
        }
        let Some(ended) = ended else {
            return Ok(Value::Null);
        };
        let deadline = ended.saturating_add(WINDOW_SECONDS);
        let mut result = json!({"until":deadline});
        let trigger = string(&successor["turn_attribution"], "turn_trigger");
        let started = successor["started_at"].as_i64();
        if chrono::Utc::now().timestamp() <= deadline
            && next["id"] == successor["turn_id"]
            && started.is_some_and(|t| t >= ended && t <= deadline)
            && matches!(
                trigger,
                "capacity_retry_automatic" | "capacity_retry_manual" | "resume_interrupted_task"
            )
            && !input
            && next["items"]
                .as_array()
                .is_some_and(|items| items.iter().all(|i| i["type"] != "userMessage"))
            && configuration.is_object()
        {
            result["retry"] = json!({"turnId":next["id"],"trigger":trigger,
                "startedAt":started,"configuration":configuration});
        }
        Ok(result)
    };
    read().unwrap_or(Value::Null)
}

// Called under the notification lock; record-first writes are restart-idempotent.
pub(super) fn adopt(dir: &Path, b: &mut Binding, observation: &Value) -> Result<()> {
    if !b.agent.is_empty() && b.agent != "codex" {
        return Ok(());
    }
    if matches!(string(observation, "state"), "cancelled" | "failed") && !b.continuation_bound {
        if observation["nativeContinuation"]["excluded"] == true {
            b.continuation_bound = true;
            persist(dir, b)?;
            return Ok(());
        }
        // Allow a bounded re-read if terminal history has not flushed yet. Adoption
        // still requires the native deadline; reads/restarts never extend this grace.
        let until = observation["nativeContinuation"]["until"]
            .as_i64()
            .unwrap_or_else(|| {
                if !b.terminal && b.continuation_until == 0 {
                    chrono::Utc::now().timestamp() + WINDOW_SECONDS
                } else {
                    b.continuation_until
                }
            });
        if b.continuation_until != until {
            b.continuation_until = until;
            persist(dir, b)?;
        }
        let retry = &observation["nativeContinuation"]["retry"];
        if let Some(next) = retry["turnId"].as_str().filter(|s| !s.is_empty()) {
            if !crate::dispatch_policy::record_native_retry(&b.thread_id, &b.turn_id, retry)? {
                // An independently ARC-dispatched successor keeps its own origin/binding.
                b.continuation_bound = true;
                persist(dir, b)?;
            } else {
                let mut successor = binding(dir, &b.thread_id, next)?.unwrap_or_else(|| {
                    let mut next_binding = b.clone();
                    next_binding.turn_id = next.into();
                    next_binding.created_at = chrono::Utc::now().timestamp();
                    next_binding.terminal = false;
                    next_binding.waiting.clear();
                    next_binding.deliveries.clear();
                    next_binding.explicit = false;
                    next_binding.continuation_bound = false;
                    next_binding.continuation_until = 0;
                    next_binding.retry = json!({"status":"skipped","reason":"native-retry-owned"});
                    next_binding.caused_by["retryOf"] = json!(b.turn_id);
                    next_binding
                });
                if !successor.explicit {
                    successor.target = b.target.clone();
                    successor.channel = b.channel;
                    for d in &mut successor.deliveries {
                        if d.status == "pending" && d.target.is_empty() {
                            d.target = b.target.clone().unwrap_or_default();
                            d.channel = b.channel;
                        }
                    }
                    persist(dir, &successor)?;
                }
                b.continuation_bound = true;
                persist(dir, b)?;
            }
        }
    }
    Ok(())
}
