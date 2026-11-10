//! Operation submission and execution are independent of native Agent turn state.
use crate::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Submission {
    Accepted,
    Submitted,
    Unconfirmed,
    Failed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Execution {
    Pending,
    Executing,
    Completed,
    Failed,
}
/// Existing receipt spellings belong only to this persistence/wire adapter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Reserved,
    Executing,
    AwaitingApproval,
    Completed,
    Failed,
    Rejected,
    NotExecuted,
    Cancelled,
    RolledBack,
    Unconfirmed,
}
impl State {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Reserved => "reserved",
            Self::Executing => "executing",
            Self::AwaitingApproval => "awaiting-approval",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Rejected => "rejected",
            Self::NotExecuted => "not-executed",
            Self::Cancelled => "cancelled",
            Self::RolledBack => "rolled-back",
            Self::Unconfirmed => "unconfirmed",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress {
    state: State,
    submission: Submission,
    execution: Execution,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Unconfirmed,
    Rejected,
    Failed,
}
impl Failure {
    pub fn state(self) -> State {
        match self {
            Self::Unconfirmed => State::Unconfirmed,
            Self::Rejected => State::Rejected,
            Self::Failed => State::Failed,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Begin,
    Complete,
    Fail(Failure),
    AwaitApproval,
    Approve,
    Reject,
    OwnerLost,
}
impl Progress {
    fn new(state: State) -> Self {
        let submission = match state {
            State::Reserved | State::AwaitingApproval => Submission::Accepted,
            State::Unconfirmed => Submission::Unconfirmed,
            State::Rejected | State::NotExecuted => Submission::Failed,
            _ => Submission::Submitted,
        };
        let execution = match state {
            State::Executing => Execution::Executing,
            State::Completed => Execution::Completed,
            State::Failed | State::Cancelled | State::RolledBack => Execution::Failed,
            _ => Execution::Pending,
        };
        Self {
            state,
            submission,
            execution,
        }
    }
    pub fn decode(state: &str) -> Option<Self> {
        let state = match state {
            "reserved" => State::Reserved,
            "executing" => State::Executing,
            "awaiting-approval" => State::AwaitingApproval,
            "completed" => State::Completed,
            "failed" => State::Failed,
            "rejected" => State::Rejected,
            "not-executed" => State::NotExecuted,
            "cancelled" => State::Cancelled,
            "rolled-back" => State::RolledBack,
            "unconfirmed" => State::Unconfirmed,
            _ => return None,
        };
        Some(Self::new(state))
    }
    pub fn read(state: &str, owner_live: bool) -> Self {
        let progress = Self::decode(state).unwrap_or_else(|| Self::new(State::Unconfirmed));
        if owner_live {
            progress
        } else {
            advance(progress, Event::OwnerLost)
        }
    }
    pub fn submission(self) -> Submission {
        self.submission
    }
    pub fn execution(self) -> Execution {
        self.execution
    }
    pub fn is(self, state: State) -> bool {
        self.state == state
    }
    pub fn active(self) -> bool {
        self.is(State::Reserved) || self.execution == Execution::Executing
    }
    pub fn state(self) -> &'static str {
        self.state.wire()
    }
    fn submission_wire(self) -> &'static str {
        match self.submission {
            Submission::Accepted => "reserved",
            Submission::Submitted => "submitted",
            Submission::Unconfirmed => "unconfirmed",
            Submission::Failed => "not-executed",
        }
    }
    fn execution_wire(self) -> Option<&'static str> {
        match self.execution {
            Execution::Pending => None,
            _ => Some(self.state()),
        }
    }
    pub fn stalled(self, age_ms: u64) -> bool {
        self.is(State::Reserved) && age_ms >= 30_000
    }
}
/// Pure operation transition. Owner loss never invents an execution outcome.
pub fn advance(previous: Progress, event: Event) -> Progress {
    let state = match event {
        Event::AwaitApproval if previous.is(State::Reserved) => State::AwaitingApproval,
        Event::Begin if previous.is(State::Reserved) => State::Executing,
        Event::Approve if previous.is(State::AwaitingApproval) => State::Reserved,
        Event::Reject if previous.is(State::AwaitingApproval) => State::NotExecuted,
        Event::Complete if previous.active() || previous.is(State::Unconfirmed) => State::Completed,
        Event::Fail(state) if previous.active() || previous.is(State::Unconfirmed) => state.state(),
        Event::OwnerLost if previous.active() => State::Unconfirmed,
        _ => return previous,
    };
    Progress::new(state)
}
/// Decode upstream submission errors once; producers consume the typed outcome.
pub fn failure(error: &str) -> Failure {
    if error.starts_with("SUBMISSION_UNCONFIRMED:") {
        Failure::Unconfirmed
    } else if error.starts_with("RPC_REJECTED") || error.starts_with("DESKTOP_REJECTED") {
        Failure::Rejected
    } else {
        Failure::Failed
    }
}
pub fn apply(receipt: &mut Value, event: Event) {
    let progress = advance(Progress::read(string(receipt, "state"), true), event);
    receipt["state"] = json!(progress.state());
}

pub fn age_ms(receipt: &Value, time_ms: i64) -> Option<u64> {
    receipt["updatedAt"]
        .as_str()
        .or(receipt["createdAt"].as_str())
        .or(receipt["startedAt"].as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|at| time_ms.saturating_sub(at.timestamp_millis()).max(0) as u64)
}

/// Pure read projection, also used by management receipts and changed-key reads.
pub fn project(mut receipt: Value, owner_live: bool, time_ms: i64) -> Value {
    if receipt["state"] == "not-found" {
        return receipt;
    }
    let phase = Progress::read(string(&receipt, "state"), owner_live);
    if receipt["state"] != phase.state() {
        receipt["previousState"] = receipt["state"].clone();
    }
    receipt["state"] = json!(phase.state());
    receipt["submissionState"] = json!(phase.submission_wire());
    receipt["executionState"] = json!(phase.execution_wire());
    receipt["progressStalled"] = json!(phase.stalled(age_ms(&receipt, time_ms).unwrap_or(0)));
    if let Some(age) = age_ms(&receipt, time_ms) {
        receipt["phaseAgeMs"] = json!(age);
    }
    receipt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_transition_separates_submission_execution_and_owner_loss() {
        // Property: execution requires confirmed submission; only reservations stall; owner loss and duplicate events preserve settled outcomes.
        let states = [
            State::Reserved,
            State::Executing,
            State::AwaitingApproval,
            State::Completed,
            State::Failed,
            State::Rejected,
            State::NotExecuted,
            State::Cancelled,
            State::RolledBack,
            State::Unconfirmed,
        ];
        let events = [
            Event::Begin,
            Event::Complete,
            Event::Fail(Failure::Failed),
            Event::Fail(Failure::Unconfirmed),
            Event::Fail(Failure::Rejected),
            Event::AwaitApproval,
            Event::Approve,
            Event::Reject,
            Event::OwnerLost,
        ];
        for state in states {
            let previous = Progress::read(state.wire(), true);
            for event in events {
                let next = advance(previous, event);
                assert_eq!(advance(next, event), next);
                if next.execution == Execution::Executing {
                    assert_eq!(next.submission, Submission::Submitted);
                }
                if matches!(previous.execution, Execution::Completed | Execution::Failed) {
                    assert_eq!(next, previous);
                }
                for age in [0, 29_999, 30_000, 45_001, u64::MAX] {
                    assert_eq!(next.stalled(age), next.is(State::Reserved) && age >= 30_000);
                }
            }
            let lost = advance(previous, Event::OwnerLost);
            assert_eq!(
                lost.is(State::Unconfirmed),
                previous.active() || previous.is(State::Unconfirmed)
            );
            assert!(!lost.stalled(u64::MAX));
            if lost.is(State::Unconfirmed) {
                assert_eq!(advance(lost, Event::Begin), lost);
            }
            let row = json!({"requestId":"original-request","state":state.wire(),"createdAt":"2000-01-01T00:00:00Z"});
            let projected = project(row, false, i64::MAX);
            assert_eq!(projected["requestId"], "original-request");
            assert_eq!(project(projected.clone(), false, i64::MAX), projected);
        }
        let reserved = Progress::new(State::Reserved);
        assert_eq!(
            (reserved.submission, reserved.execution),
            (Submission::Accepted, Execution::Pending)
        );
        let executing = advance(reserved, Event::Begin);
        assert_eq!(
            (executing.submission, executing.execution),
            (Submission::Submitted, Execution::Executing)
        );
        let absent = json!({"requestId":"original-request","state":"not-found","executionState":"no-reservation"});
        assert_eq!(project(absent.clone(), false, i64::MAX), absent);
    }
}
