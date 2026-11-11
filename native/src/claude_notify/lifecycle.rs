//! Notification adapters retain scoped evidence; all verdicts come from advance.
use super::*;
use crate::turn_lifecycle::{
    adapters, advance, Evidence, LiveState, LossReason, Transition, TurnKey, TurnState,
};

impl Binding {
    pub(super) fn key(&self) -> TurnKey {
        TurnKey::new(
            if self.agent.is_empty() {
                "codex"
            } else {
                &self.agent
            },
            &self.thread_id,
            &self.turn_id,
        )
    }
    pub(super) fn lifecycle(&self) -> Transition {
        if let Some(turn) = adapters::restore(&self.lifecycle).filter(|t| t.key() == &self.key()) {
            return turn;
        }
        // Old persisted projections contribute only their native recorded status.
        observed(&self.key(), &self.observation, 0)
    }
    pub(super) fn terminal(&self) -> bool {
        matches!(self.lifecycle().state(), TurnState::Terminal(_))
    }
    pub(super) fn turn_state(&self) -> TurnState {
        self.lifecycle().state()
    }
}

pub(super) fn same_key(key: &TurnKey, value: &Value) -> bool {
    adapters::restore(&value["_turnLifecycle"]).is_none_or(|turn| turn.key() == key)
        && value["threadId"]
            .as_str()
            .or_else(|| value["taskId"].as_str())
            .is_none_or(|id| id == key.native_session)
        && value["turnId"].as_str().is_none_or(|id| id == key.turn_id)
        && value["agent"]
            .as_str()
            .is_none_or(|agent| agent == key.agent)
}

pub(super) fn observed(key: &TurnKey, value: &Value, revision: u64) -> Transition {
    let captured = adapters::restore(&value["_turnLifecycle"]);
    let has_native_checkpoint = captured.is_some();
    let mut turn = captured.unwrap_or_else(|| Transition::new(key.clone()));
    if !same_key(key, value) || turn.key() != key {
        return Transition::new(key.clone());
    }
    // Codex wait/read supplies recordedStatus. A bare cancelled projection, an
    // interrupt request, or a process exit is never native terminal evidence.
    let status = value["recordedStatus"].as_str().unwrap_or("");
    if !has_native_checkpoint {
        if let Some(evidence) =
            adapters::codex_terminal(key.clone(), status, value["nativeSequence"].as_u64())
        {
            turn = advance(&turn, &evidence);
        }
    }
    let evidence = match adapters::WaitState::from_wire(string(value, "state")) {
        Some(adapters::WaitState::Running) => {
            Evidence::owner_live(key.clone(), LiveState::Active, revision)
        }
        Some(adapters::WaitState::InteractionRequired) => {
            Evidence::owner_live(key.clone(), LiveState::AwaitingInteraction, revision)
        }
        _ => Evidence::loss(key.clone(), LossReason::OwnerUnavailable, revision),
    };
    advance(&turn, &evidence)
}

pub(super) fn merge(b: &mut Binding, value: &Value) {
    let mut turn = b.lifecycle();
    let incoming = observed(&b.key(), value, turn.revision().saturating_add(1));
    for evidence in incoming.evidence() {
        turn = advance(&turn, &evidence);
    }
    let mut checkpoint = adapters::checkpoint(&turn);
    let previous = adapters::checkpoint(&b.lifecycle());
    // Repeated observations do not create durable writes or reset idle caches.
    let mut comparable = checkpoint.clone();
    for field in ["owner", "lastLive"] {
        if comparable[field].is_object() && previous[field].is_object() {
            comparable[field]["revision"] = previous[field]["revision"].clone();
        }
    }
    if comparable == previous {
        checkpoint = previous;
    }
    b.lifecycle = checkpoint;
}

pub(super) fn loss(b: &mut Binding) {
    merge(b, &json!({"state":"unconfirmed"}));
}

pub(super) fn project(b: &Binding, value: &mut Value) {
    let state = b.turn_state();
    let (wait, reason) = adapters::wait(&state);
    value["state"] = json!(wait.as_wire());
    value["reason"] = json!(reason);
    if let TurnState::Conflict(records) = state {
        value["conflict"] = json!({"threadId":b.thread_id,"turnId":b.turn_id,"records":records.iter().map(|r| json!({"status":adapters::push_outcome(r.outcome),"sequence":r.sequence})).collect::<Vec<_>>()});
    } else if let Some(object) = value.as_object_mut() {
        object.remove("conflict");
    }
}

pub(super) fn admits(state: &TurnState, d: &Delivery) -> bool {
    if matches!(state, TurnState::Conflict(_)) {
        return false;
    }
    if matches!(d.task_state.as_str(), "handoff" | "recovered") {
        return true;
    }
    match state {
        TurnState::Terminal(_) => {
            d.key == "terminal"
                && adapters::WaitState::from_wire(&d.task_state) == Some(adapters::wait(state).0)
        }
        TurnState::AwaitingInteraction => d.task_state == "interaction-required",
        TurnState::Active => d.state == "stalled",
        _ => false,
    }
}
