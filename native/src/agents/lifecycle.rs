//! Scoped Agent turn projections. Only native protocol adapters confirm outcomes.
use crate::turn_lifecycle::{
    adapters, advance, Evidence, LossReason, Transition, TurnKey, TurnState,
};
use crate::*;

pub(super) fn key(task: &Value) -> TurnKey {
    // The durable task handle identifies this adapter-owned session across host reattachment.
    TurnKey::new(
        string(task, "agent"),
        string(task, "taskId"),
        string(task, "turnId"),
    )
}
pub(crate) fn read(task: &Value) -> Transition {
    let key = key(task);
    adapters::snapshot(key, string(task, "status"), &task["_turnLifecycle"])
}
pub(super) fn apply(task: &mut Value, evidence: Evidence) {
    let turn = advance(&read(task), &evidence);
    task["status"] = json!(adapters::projection(&turn.state()));
    task["_turnLifecycle"] = adapters::checkpoint(&turn);
}
pub(super) fn owner(task: &mut Value, status: &str) {
    let turn = read(task);
    apply(
        task,
        Evidence::owner_live(
            key(task),
            if status == "waiting-permission" {
                crate::turn_lifecycle::LiveState::AwaitingInteraction
            } else {
                crate::turn_lifecycle::LiveState::Active
            },
            turn.revision().saturating_add(1),
        ),
    );
}
pub(super) fn loss(task: &mut Value) {
    let turn = read(task);
    apply(
        task,
        Evidence::loss(
            key(task),
            LossReason::OwnerUnavailable,
            turn.revision().saturating_add(1),
        ),
    );
}
pub(super) fn terminal(task: &Value) -> bool {
    adapters::terminal(&read(task).state())
}
pub(super) fn ready(task: &Value) -> bool {
    task["status"] == "idle" || terminal(task)
}
pub(super) fn active(task: &Value) -> bool {
    matches!(
        read(task).state(),
        TurnState::Active | TurnState::AwaitingInteraction
    )
}
pub(super) fn observation(task: &Value) -> Value {
    let turn = read(task);
    let (state, reason) = adapters::wait(&turn.state());
    json!({"agent":task["agent"],"taskId":task["taskId"],"turnId":task["turnId"],
        "state":state.as_wire(),"reason":reason,"recordedStatus":task["status"],
        "_turnLifecycle":adapters::checkpoint(&turn),"title":task["title"],
        "finalResponse":task["output"],"error":task["error"]})
}

pub(super) fn runtime(task: &Value) -> &'static str {
    if task["processState"] == "stopped" || task["processState"] == "exited" {
        return "unknown";
    }
    match read(task).state() {
        TurnState::Active => "active",
        TurnState::AwaitingInteraction => "waiting",
        TurnState::Terminal(_) => "idle",
        _ if task["status"] == "idle" => "idle",
        _ => "unknown",
    }
}
