//! Operation progress is independent of the lifetime of a dispatched Agent turn.
use crate::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Progress {
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

impl Progress {
    pub fn read(state: &str, owner_live: bool) -> Self {
        let phase = match state {
            "reserved" => Self::Reserved,
            "executing" => Self::Executing,
            "awaiting-approval" => Self::AwaitingApproval,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "rejected" => Self::Rejected,
            "not-executed" => Self::NotExecuted,
            "cancelled" => Self::Cancelled,
            "rolled-back" => Self::RolledBack,
            // An obsolete or unknown nonterminal record cannot confirm submission.
            _ => Self::Unconfirmed,
        };
        if !owner_live && phase.active() {
            Self::Unconfirmed
        } else {
            phase
        }
    }
    pub fn active(self) -> bool {
        matches!(self, Self::Reserved | Self::Executing)
    }
    pub fn state(self) -> &'static str {
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
    pub fn submission(self) -> &'static str {
        match self {
            Self::Reserved | Self::AwaitingApproval => "reserved",
            Self::Unconfirmed => "unconfirmed",
            Self::Rejected | Self::NotExecuted => "not-executed",
            _ => "submitted",
        }
    }
    pub fn execution(self) -> Option<&'static str> {
        match self {
            Self::Executing => Some("executing"),
            Self::Completed => Some("completed"),
            Self::Failed => Some("failed"),
            Self::Cancelled => Some("cancelled"),
            Self::RolledBack => Some("rolled-back"),
            _ => None,
        }
    }
    pub fn stalled(self, age_ms: u64) -> bool {
        self == Self::Reserved && age_ms >= 30_000
    }
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
    receipt["submissionState"] = json!(phase.submission());
    receipt["executionState"] = json!(phase.execution());
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
    fn execution_duration_cannot_stall_submission_and_loss_cannot_settle_execution() {
        // Property: only an overdue reservation stalls; owner loss preserves settled outcomes and makes active receipts unconfirmed.
        let absent = json!({"requestId":"original-request","state":"not-found","executionState":"no-reservation"});
        assert_eq!(project(absent.clone(), false, i64::MAX), absent);
        for state in [
            "reserved",
            "executing",
            "awaiting-approval",
            "completed",
            "failed",
            "rejected",
            "not-executed",
            "cancelled",
            "rolled-back",
            "unconfirmed",
        ] {
            for elapsed in [0, 29_999, 30_000, 300_000, 3_600_000] {
                let row = json!({"requestId":"original-request","state":state,"createdAt":"2000-01-01T00:00:00Z"});
                let time = 946_684_800_000 + elapsed;
                let live = project(row.clone(), true, time);
                assert_eq!(live["state"], state);
                assert_eq!(
                    live["progressStalled"],
                    state == "reserved" && elapsed >= 30_000
                );
                if state == "executing" {
                    assert_eq!(live["submissionState"], "submitted");
                    assert_eq!(live["executionState"], "executing");
                }
                let lost = project(row, false, time);
                assert_eq!(lost["requestId"], "original-request");
                assert_eq!(
                    lost["state"],
                    if Progress::read(state, true).active() {
                        "unconfirmed"
                    } else {
                        state
                    }
                );
                assert_eq!(lost["progressStalled"], false);
                assert_eq!(project(lost.clone(), false, time), lost);
            }
        }
    }
}
