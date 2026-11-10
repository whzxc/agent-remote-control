//! Turn knowledge is scoped to a native key; wire spellings belong to adapters.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnKey {
    pub agent: String,
    pub native_session: String,
    pub turn_id: String,
}
impl TurnKey {
    pub fn new(agent: &str, native_session: &str, turn_id: &str) -> Self {
        Self {
            agent: agent.into(),
            native_session: native_session.into(),
            turn_id: turn_id.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Outcome {
    Completed,
    Failed,
    Interrupted,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct TerminalRecord {
    pub outcome: Outcome,
    /// Comparable only within this native turn's sequence domain. Never wall time.
    pub sequence: Option<u64>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum LiveState {
    Active,
    AwaitingInteraction,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum LossReason {
    TurnNotFound,
    InconsistentNativeState,
    OwnerUnavailable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct LiveRecord {
    pub revision: u64,
    pub state: LiveState,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TurnState {
    Unconfirmed(LossReason),
    Active,
    AwaitingInteraction,
    Terminal(TerminalRecord),
    /// Incomparable native outcomes require reconciliation before delivery.
    Conflict(Vec<TerminalRecord>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum OwnerState {
    Loss(LossReason),
    Live(LiveState),
}
#[derive(Clone, Debug, PartialEq, Eq)]
enum EvidenceKind {
    NativeTerminal(TerminalRecord),
    Owner { revision: u64, state: OwnerState },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Evidence {
    key: TurnKey,
    kind: EvidenceKind,
}
impl Evidence {
    /// Revision orders owner observations within the selected turn. A stale read
    /// must keep its old revision; ingestion time is not evidence of freshness.
    pub fn owner_live(key: TurnKey, state: LiveState, revision: u64) -> Self {
        Self {
            key,
            kind: EvidenceKind::Owner {
                revision,
                state: OwnerState::Live(state),
            },
        }
    }
    /// Connection/process loss cannot confirm a native turn outcome.
    pub fn loss(key: TurnKey, reason: LossReason, revision: u64) -> Self {
        Self {
            key,
            kind: EvidenceKind::Owner {
                revision,
                state: OwnerState::Loss(reason),
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transition {
    key: TurnKey,
    terminals: Vec<TerminalRecord>,
    owner: Option<(u64, OwnerState)>,
    last_live: Option<LiveRecord>,
}
impl Transition {
    pub fn new(key: TurnKey) -> Self {
        Self {
            key,
            terminals: vec![],
            owner: None,
            last_live: None,
        }
    }
    pub fn key(&self) -> &TurnKey {
        &self.key
    }
    pub fn last_live(&self) -> Option<LiveRecord> {
        self.last_live
    }
    pub fn state(&self) -> TurnState {
        if let Some(first) = self.terminals.first() {
            if self
                .terminals
                .iter()
                .any(|record| record.outcome != first.outcome)
            {
                return TurnState::Conflict(self.terminals.clone());
            }
            return TurnState::Terminal(*self.terminals.iter().max_by_key(|r| r.sequence).unwrap());
        }
        match self.owner.map(|(_, state)| state) {
            Some(OwnerState::Live(LiveState::Active)) => TurnState::Active,
            Some(OwnerState::Live(LiveState::AwaitingInteraction)) => {
                TurnState::AwaitingInteraction
            }
            Some(OwnerState::Loss(reason)) => TurnState::Unconfirmed(reason),
            None => TurnState::Unconfirmed(LossReason::TurnNotFound),
        }
    }
}

/// Merge authoritative knowledge without I/O. Terminal records dominate owner
/// observations. Only comparable native sequences supersede terminal records;
/// unsequenced contradictions remain conflicts regardless of arrival order.
/// At an equal owner revision, live evidence outranks loss; interaction outranks
/// activity. A newer loss invalidates current liveness but preserves last_live.
pub fn advance(previous: &Transition, evidence: &Evidence) -> Transition {
    if previous.key != evidence.key {
        return previous.clone();
    }
    let mut next = previous.clone();
    match evidence.kind {
        EvidenceKind::NativeTerminal(record) => {
            next.terminals.push(record);
            let newest = next.terminals.iter().filter_map(|r| r.sequence).max();
            next.terminals
                .retain(|r| r.sequence.is_none() || r.sequence == newest);
            next.terminals.sort_unstable();
            next.terminals.dedup();
        }
        EvidenceKind::Owner { revision, state } => {
            next.owner = next.owner.max(Some((revision, state)));
            if let OwnerState::Live(state) = state {
                next.last_live = next.last_live.max(Some(LiveRecord { revision, state }));
            }
        }
    }
    next
}

/// Explicit native-input and wait-output boundaries. No serde representation is
/// assigned to lifecycle types, so their variants cannot silently become wire values.
pub mod adapters {
    use super::*;

    pub fn codex_terminal(key: TurnKey, status: &str, sequence: Option<u64>) -> Option<Evidence> {
        let outcome = match status {
            "completed" => Outcome::Completed,
            "failed" => Outcome::Failed,
            "interrupted" | "cancelled" => Outcome::Interrupted,
            _ => return None,
        };
        Some(Evidence {
            key,
            kind: EvidenceKind::NativeTerminal(TerminalRecord { outcome, sequence }),
        })
    }

    pub fn codex_active(status: &str) -> bool {
        status == "inProgress"
    }

    /// One fresh read has one owner revision. Native turn status is handled
    /// independently so owner uncertainty cannot erase a native terminal.
    pub fn codex_owner(
        key: TurnKey,
        recorded: Option<&str>,
        runtime: &str,
        interaction: bool,
        revision: u64,
    ) -> Evidence {
        let loss = if recorded.is_none() {
            LossReason::TurnNotFound
        } else if matches!(runtime, "unknown" | "notLoaded" | "") {
            LossReason::OwnerUnavailable
        } else if interaction {
            return Evidence::owner_live(key, LiveState::AwaitingInteraction, revision);
        } else if recorded.is_some_and(codex_active) && runtime == "active" {
            return Evidence::owner_live(key, LiveState::Active, revision);
        } else {
            LossReason::InconsistentNativeState
        };
        Evidence::loss(key, loss, revision)
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum WaitState {
        Running,
        Completed,
        Failed,
        Cancelled,
        InteractionRequired,
        Unconfirmed,
        Timeout,
    }
    impl WaitState {
        pub fn from_wire(value: &str) -> Option<Self> {
            Some(match value {
                "running" => Self::Running,
                "completed" => Self::Completed,
                "failed" => Self::Failed,
                "cancelled" => Self::Cancelled,
                "interaction-required" => Self::InteractionRequired,
                "unconfirmed" => Self::Unconfirmed,
                "timeout" => Self::Timeout,
                _ => return None,
            })
        }
        pub fn as_wire(self) -> &'static str {
            match self {
                Self::Running => "running",
                Self::Completed => "completed",
                Self::Failed => "failed",
                Self::Cancelled => "cancelled",
                Self::InteractionRequired => "interaction-required",
                Self::Unconfirmed => "unconfirmed",
                Self::Timeout => "timeout",
            }
        }
        pub fn is_terminal(self) -> bool {
            matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
        }
        pub fn keeps_response(self) -> bool {
            self.is_terminal() || self == Self::InteractionRequired
        }
    }

    pub fn wait(state: &TurnState) -> (WaitState, &'static str) {
        match state {
            TurnState::Terminal(record) => (
                match record.outcome {
                    Outcome::Completed => WaitState::Completed,
                    Outcome::Failed => WaitState::Failed,
                    Outcome::Interrupted => WaitState::Cancelled,
                },
                "native-turn-terminal",
            ),
            TurnState::Active => (WaitState::Running, "native-turn-active"),
            TurnState::AwaitingInteraction => {
                (WaitState::InteractionRequired, "native-interaction")
            }
            TurnState::Unconfirmed(reason) => (
                WaitState::Unconfirmed,
                match reason {
                    LossReason::TurnNotFound => "turn-not-found",
                    LossReason::OwnerUnavailable => "runtime-ownership-unknown",
                    LossReason::InconsistentNativeState => "inconsistent-native-state",
                },
            ),
            // Keep conflict explicit internally without adding a wire value.
            TurnState::Conflict(_) => (WaitState::Unconfirmed, "inconsistent-native-state"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> TurnKey {
        TurnKey::new("codex", "thread", "turn")
    }
    fn terminal(status: &str, sequence: Option<u64>) -> Evidence {
        adapters::codex_terminal(key(), status, sequence).unwrap()
    }
    fn fold(evidence: &[Evidence]) -> Transition {
        evidence
            .iter()
            .fold(Transition::new(key()), |state, evidence| {
                advance(&state, evidence)
            })
    }
    fn permutations<T: Clone>(values: &[T]) -> Vec<Vec<T>> {
        if values.is_empty() {
            return vec![vec![]];
        }
        values
            .iter()
            .enumerate()
            .flat_map(|(index, value)| {
                let mut rest = values.to_vec();
                rest.remove(index);
                permutations(&rest).into_iter().map(move |mut permutation| {
                    permutation.push(value.clone());
                    permutation
                })
            })
            .collect()
    }

    #[test]
    fn native_terminal_dominates_loss_activity_and_stale_evidence_in_every_order() {
        // Property: native terminal knowledge is invariant under permutations of weaker evidence.
        for status in ["completed", "failed", "interrupted"] {
            let confirmed = terminal(status, Some(4));
            let expected = fold(&[confirmed.clone()]).state();
            for evidence in permutations(&[
                confirmed,
                Evidence::loss(key(), LossReason::OwnerUnavailable, 3),
                Evidence::owner_live(key(), LiveState::Active, 2),
                Evidence::owner_live(key(), LiveState::AwaitingInteraction, 1),
                terminal(status, Some(1)),
            ]) {
                assert_eq!(fold(&evidence).state(), expected);
            }
        }
    }

    #[test]
    fn duplicate_evidence_is_idempotent() {
        // Property: reapplying any observed evidence leaves the entire transition unchanged.
        let evidence = [
            Evidence::owner_live(key(), LiveState::Active, 1),
            Evidence::loss(key(), LossReason::OwnerUnavailable, 2),
            terminal("completed", Some(3)),
            terminal("failed", Some(3)),
            terminal("interrupted", None),
        ];
        for order in permutations(&evidence) {
            let mut state = Transition::new(key());
            for item in &order {
                state = advance(&state, item);
                assert_eq!(advance(&state, item), state);
            }
            for item in &order {
                assert_eq!(advance(&state, item), state);
            }
        }
    }

    #[test]
    fn evidence_cannot_cross_agent_thread_or_turn_boundaries() {
        // Property: every evidence kind is inert outside its exact native turn key.
        for state in [
            Transition::new(key()),
            fold(&[Evidence::owner_live(key(), LiveState::Active, 1)]),
            fold(&[terminal("completed", None)]),
        ] {
            for other in [
                TurnKey::new("other", "thread", "turn"),
                TurnKey::new("codex", "other", "turn"),
                TurnKey::new("codex", "thread", "other"),
            ] {
                for evidence in [
                    adapters::codex_terminal(other.clone(), "failed", None).unwrap(),
                    Evidence::owner_live(other.clone(), LiveState::AwaitingInteraction, 9),
                    Evidence::loss(other, LossReason::OwnerUnavailable, 9),
                ] {
                    assert_eq!(advance(&state, &evidence), state);
                }
            }
        }
    }

    #[test]
    fn owner_loss_preserves_last_live_without_confirming_interruption() {
        // Property: owner loss makes liveness unconfirmed until newer owner evidence or a native terminal.
        let live = Evidence::owner_live(key(), LiveState::Active, 1);
        let loss = Evidence::loss(key(), LossReason::OwnerUnavailable, 2);
        for order in permutations(&[live, loss]) {
            let lost = fold(&order);
            assert_eq!(
                lost.state(),
                TurnState::Unconfirmed(LossReason::OwnerUnavailable)
            );
            assert_eq!(
                lost.last_live(),
                Some(LiveRecord {
                    revision: 1,
                    state: LiveState::Active
                })
            );
            assert_eq!(
                advance(
                    &lost,
                    &Evidence::owner_live(key(), LiveState::AwaitingInteraction, 3)
                )
                .state(),
                TurnState::AwaitingInteraction
            );
            assert_eq!(
                advance(&lost, &terminal("interrupted", None)).state(),
                TurnState::Terminal(TerminalRecord {
                    outcome: Outcome::Interrupted,
                    sequence: None
                })
            );
        }
        for order in permutations(&[
            Evidence::owner_live(key(), LiveState::Active, 2),
            Evidence::loss(key(), LossReason::OwnerUnavailable, 2),
        ]) {
            assert_eq!(fold(&order).state(), TurnState::Active);
        }
        assert!(adapters::codex_terminal(key(), "cancelling", None).is_none());
    }

    #[test]
    fn contradictory_native_outcomes_require_ordering_or_remain_conflicted() {
        // Property: only a newer comparable native sequence resolves contradictory terminal records.
        for sequences in [(None, None), (Some(4), Some(4)), (None, Some(4))] {
            let evidence = [
                terminal("completed", sequences.0),
                terminal("failed", sequences.1),
            ];
            let expected = fold(&evidence);
            assert!(matches!(expected.state(), TurnState::Conflict(_)));
            assert_eq!(
                adapters::wait(&expected.state()),
                (
                    adapters::WaitState::Unconfirmed,
                    "inconsistent-native-state"
                )
            );
            for order in permutations(&evidence) {
                assert_eq!(fold(&order), expected);
            }
        }
        for order in permutations(&[
            terminal("completed", Some(4)),
            terminal("failed", Some(4)),
            terminal("interrupted", Some(5)),
        ]) {
            assert_eq!(
                fold(&order).state(),
                TurnState::Terminal(TerminalRecord {
                    outcome: Outcome::Interrupted,
                    sequence: Some(5)
                })
            );
        }
        for order in permutations(&[terminal("completed", None), terminal("completed", Some(4))]) {
            assert_eq!(
                fold(&order).state(),
                TurnState::Terminal(TerminalRecord {
                    outcome: Outcome::Completed,
                    sequence: Some(4)
                })
            );
        }
    }
}
