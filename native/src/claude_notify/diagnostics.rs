//! Explain notification gaps without inferring task completion or taking ownership.
use super::*;

pub(super) fn turn(b: &Binding) -> Value {
    let owner = ownership::read(&b.thread_id).unwrap_or(Value::Null);
    let mut reasons = Vec::new();
    if matches!(b.turn_state(), TurnState::Conflict(_)) {
        reasons.push(json!("terminal-conflict"));
    }
    if let Some(reason) = &b.scope_end {
        reasons.push(json!(reason));
    }
    if b.successor["turnId"].is_string() {
        reasons.push(json!(if b.successor["inherited"] == true {
            "superseded-turn-inherited"
        } else {
            "successor-not-inherited"
        }));
    }
    if owner["currentOwner"] == "desktop" {
        reasons.push(json!("ownership-moved-to-desktop"));
    }
    if b.observation["reconciliation"] == "pending-after-restart" {
        reasons.push(json!("pending-after-restart"));
    } else if observer::exhausted(b) {
        reasons.push(json!("unavailable-after-restart"));
    } else if !b.terminal() && b.observation.is_null() {
        reasons.push(json!("pending-observation"));
    }
    if b.terminal() && !b.deliveries.iter().any(|d| d.key == "terminal") {
        reasons.push(json!("no-terminal-delivery"));
    }
    if b.deliveries.is_empty() {
        reasons.push(json!(if b.terminal() {
            "no-terminal-delivery"
        } else {
            "awaiting-observable-transition"
        }));
    } else if b
        .deliveries
        .iter()
        .any(|d| matches!(d.status.as_str(), "pending" | "sending"))
    {
        reasons.push(json!("delivery-pending"));
    } else {
        reasons.push(json!("delivery-recorded"));
    }
    for reason in b
        .deliveries
        .iter()
        .filter(|d| d.status == "pending")
        .filter_map(|d| d.timing.queue_reason.as_ref())
    {
        let reason = json!(reason);
        if !reasons.contains(&reason) {
            reasons.push(reason);
        }
    }
    let next = if !b.device.is_null() {
        let request = super::device::read_request(b);
        json!({"via":"query","op":"device","args":{"device":b.device["id"],"op":request["op"],"args":request["args"]}})
    } else if matches!(b.turn_state(), TurnState::Conflict(_)) {
        let (op, args) = if b.key().agent == "codex" {
            (
                "codex_read",
                json!({"threadId":b.thread_id,"turnId":b.turn_id}),
            )
        } else {
            ("agent_read", json!({"agent":b.agent,"taskId":b.thread_id}))
        };
        json!({"via":"query","op":op,"args":args,"hint":"Reconcile the conflicting native records for this turn. New pushes remain held until authoritative ordering resolves the conflict."})
    } else if observer::exhausted(b) {
        let (op, args) = if b.agent.is_empty() || b.agent == "codex" {
            (
                "codex_read",
                json!({"threadId":b.thread_id,"turnId":b.turn_id}),
            )
        } else {
            ("agent_read", json!({"agent":b.agent,"taskId":b.thread_id}))
        };
        json!({"via":"query","op":op,"args":args,"hint":"Automatic reconciliation exhausted its bounded attempts. Read this task to retry. Native history, execution configuration, writer or thread-event changes also reactivate observation."})
    } else if owner["currentOwner"] == "desktop" {
        json!({"via":"query","op":"codex_owner","args":{"threadId":b.thread_id},"hint":"Inspect the current Desktop owner and handoff history. The notification scope remains bound across a proven resume."})
    } else {
        json!({"via":"query","op":"codex_read","args":{"threadId":b.thread_id,"statusOnly":true},"hint":"Read the current native turn. Unknown history remains pending; a new unrelated turn does not inherit this binding."})
    };
    json!({"reasons":reasons,"terminal":b.terminal(),"scope":{"threadId":b.thread_id,"sourceId":b.source_id,"active":b.scope_end.is_none(),"endedBy":b.scope_end},
        "successor":b.successor,"observation":b.observation,
        "retry":{"status":b.retry["status"],"reason":b.retry["reason"],"notBefore":b.retry["notBefore"],"successorTurnId":b.retry["successorTurnId"]},"next":next})
}
