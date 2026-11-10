//! Coordination's terminal projection boundary. Event status is not a receipt phase.
use super::*;
use crate::turn_lifecycle::{adapters, Outcome, Transition, TurnKey, TurnState};

pub(super) fn status(turn: &Transition, spelling: &str) -> Option<EventStatus> {
    let TurnState::Terminal(record) = turn.state() else {
        return None;
    };
    Some(match record.outcome {
        Outcome::Completed => EventStatus::Completed,
        Outcome::Failed => EventStatus::Failed,
        Outcome::Interrupted if spelling == "cancelled" => EventStatus::Cancelled,
        Outcome::Interrupted => EventStatus::Interrupted,
    })
}
pub(super) fn event(key: TurnKey, status: Option<&EventStatus>) -> Transition {
    let wire = match status {
        Some(EventStatus::Completed) => "completed",
        Some(EventStatus::Failed) => "failed",
        Some(EventStatus::Interrupted | EventStatus::Cancelled) => "interrupted",
        _ => "unknown",
    };
    adapters::snapshot(key, wire, &Value::Null)
}
pub(super) fn journal(event: &Value) -> Transition {
    let reference = &event["threadRefs"][0];
    let key = TurnKey::new(
        "codex",
        string(reference, "threadId"),
        string(reference, "turnId"),
    );
    if event["kind"] != "turn.terminal" {
        return Transition::new(key);
    }
    adapters::snapshot(key, string(event, "status"), &event["_turnLifecycle"])
}
