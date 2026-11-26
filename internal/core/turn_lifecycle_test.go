package core

import (
	"reflect"
	"slices"
	"testing"
)

var fixtureTurnKey = turnKey{"codex", "thread", "turn"}

func foldTurnEvidence(evidence []turnEvidence) turnTransition {
	turn := turnTransition{key: fixtureTurnKey}
	for _, item := range evidence {
		turn = turn.advance(item)
	}
	return turn
}

func permuteTurnEvidence(items []turnEvidence, check func([]turnEvidence)) {
	items = slices.Clone(items)
	var visit func(int)
	visit = func(index int) {
		if index == len(items) {
			check(items)
			return
		}
		for i := index; i < len(items); i++ {
			items[index], items[i] = items[i], items[index]
			visit(index + 1)
			items[index], items[i] = items[i], items[index]
		}
	}
	visit(0)
}

func TestCodexTerminalDominatesEveryOrderOfWeakerEvidence(t *testing.T) {
	// Algorithmic core: weaker or stale observations cannot change a confirmed native outcome.
	for status, want := range map[string]turnWaitState{"completed": waitCompleted, "failed": waitFailed, "interrupted": waitCancelled} {
		permuteTurnEvidence([]turnEvidence{
			codexTerminalEvidence(fixtureTurnKey, status, 4, true),
			{key: fixtureTurnKey, owner: turnOwner{3, turnUnavailable}},
			{key: fixtureTurnKey, owner: turnOwner{2, turnActive}},
			{key: fixtureTurnKey, owner: turnOwner{1, turnAwaitingInteraction}},
			codexTerminalEvidence(fixtureTurnKey, status, 1, true),
		}, func(items []turnEvidence) {
			if got, _ := foldTurnEvidence(items).wait(); got != want {
				t.Fatalf("native %s projected as %s", status, got)
			}
		})
	}
}

func TestAgentTerminalAdaptersShareTheSameFrontier(t *testing.T) {
	// Algorithmic core: Pi, ACP and Antigravity native terminals outrank owner or loss observations in every order.
	for _, row := range []struct {
		evidence turnEvidence
		want     turnWaitState
	}{
		{piSettledTurn(fixtureTurnKey, "aborted"), waitCancelled},
		{acpResponseTurn(fixtureTurnKey, object{"result": object{"stopReason": "end_turn"}}), waitCompleted},
		{antigravityResultTurn(fixtureTurnKey, object{"status": "SUCCESS"}), waitCompleted},
	} {
		permuteTurnEvidence([]turnEvidence{row.evidence,
			{key: fixtureTurnKey, owner: turnOwner{2, turnActive}},
			{key: fixtureTurnKey, owner: turnOwner{3, turnAwaitingInteraction}},
			{key: fixtureTurnKey, owner: turnOwner{4, turnUnavailable}},
		}, func(items []turnEvidence) {
			if got, _ := foldTurnEvidence(items).wait(); got != row.want {
				t.Fatalf("native state = %s, want %s", got, row.want)
			}
		})
	}
}

func TestRepeatedTurnEvidenceIsIdempotent(t *testing.T) {
	// Algorithmic core: replaying each native or owner observation leaves the frontier unchanged.
	permuteTurnEvidence([]turnEvidence{
		{key: fixtureTurnKey, owner: turnOwner{1, turnActive}},
		{key: fixtureTurnKey, owner: turnOwner{2, turnUnavailable}},
		codexTerminalEvidence(fixtureTurnKey, "completed", 3, true),
		codexTerminalEvidence(fixtureTurnKey, "failed", 3, true),
		codexTerminalEvidence(fixtureTurnKey, "interrupted", 0, false),
	}, func(items []turnEvidence) {
		turn := turnTransition{key: fixtureTurnKey}
		for _, evidence := range items {
			turn = turn.advance(evidence)
			if duplicate := turn.advance(evidence); !reflect.DeepEqual(duplicate.checkpoint(), turn.checkpoint()) {
				t.Fatalf("duplicate changed checkpoint: %v", duplicate.checkpoint())
			}
		}
		for _, evidence := range items {
			if duplicate := turn.advance(evidence); !reflect.DeepEqual(duplicate.checkpoint(), turn.checkpoint()) {
				t.Fatalf("replayed evidence changed checkpoint: %v", duplicate.checkpoint())
			}
		}
	})
}

func TestTurnEvidenceRespectsNativeIdentity(t *testing.T) {
	// Algorithmic core: terminal, loss and live evidence only apply to the same Agent, thread and turn.
	for _, turn := range []turnTransition{
		{key: fixtureTurnKey},
		foldTurnEvidence([]turnEvidence{{key: fixtureTurnKey, owner: turnOwner{1, turnActive}}}),
		foldTurnEvidence([]turnEvidence{codexTerminalEvidence(fixtureTurnKey, "completed", 0, false)}),
	} {
		for _, other := range []turnKey{{"other", "thread", "turn"}, {"codex", "other", "turn"}, {"codex", "thread", "other"}} {
			for _, evidence := range []turnEvidence{
				codexTerminalEvidence(other, "failed", 0, false),
				{key: other, owner: turnOwner{9, turnAwaitingInteraction}},
				{key: other, owner: turnOwner{9, turnUnavailable}},
			} {
				if got := turn.advance(evidence); !reflect.DeepEqual(got.checkpoint(), turn.checkpoint()) {
					t.Fatalf("foreign evidence altered checkpoint: %v", got.checkpoint())
				}
			}
		}
	}
}

func TestTurnOwnerLossPreservesLastLive(t *testing.T) {
	// Algorithmic core: owner loss makes current liveness unconfirmed and preserves the last live observation.
	live := turnEvidence{key: fixtureTurnKey, owner: turnOwner{1, turnActive}}
	loss := turnEvidence{key: fixtureTurnKey, owner: turnOwner{2, turnUnavailable}}
	permuteTurnEvidence([]turnEvidence{live, loss}, func(items []turnEvidence) {
		lost := foldTurnEvidence(items)
		if state, reason := lost.wait(); state != waitUnconfirmed || reason != "runtime-ownership-unknown" {
			t.Fatalf("lost owner = %s, %s", state, reason)
		}
		if last := lost.checkpoint()["lastLive"]; wire(last) != `{"revision":1,"state":"running"}` {
			t.Fatalf("lost last live observation: %v", last)
		}
		interaction := lost.advance(turnEvidence{key: fixtureTurnKey, owner: turnOwner{3, turnAwaitingInteraction}})
		if state, _ := interaction.wait(); state != waitInteraction {
			t.Fatalf("newer live owner = %s", state)
		}
		interrupted := lost.advance(codexTerminalEvidence(fixtureTurnKey, "interrupted", 0, false))
		if state, _ := interrupted.wait(); state != waitCancelled {
			t.Fatalf("native interruption = %s", state)
		}
	})
	live.owner.revision = 2
	permuteTurnEvidence([]turnEvidence{live, loss}, func(items []turnEvidence) {
		if state, _ := foldTurnEvidence(items).wait(); state != waitRunning {
			t.Fatalf("same-revision owner conflict = %s", state)
		}
	})
	if evidence := codexTerminalEvidence(fixtureTurnKey, "cancelling", 0, false); evidence.terminal.outcome != 0 {
		t.Fatal("interrupt intent confirmed a terminal outcome")
	}
}

func TestNativeTerminalContradictionsNeedComparableSequence(t *testing.T) {
	// Algorithmic core: only newer comparable native evidence can resolve conflicting terminal observations.
	for _, sequence := range [][2]bool{{false, false}, {true, true}, {false, true}} {
		permuteTurnEvidence([]turnEvidence{
			codexTerminalEvidence(fixtureTurnKey, "completed", 4, sequence[0]),
			codexTerminalEvidence(fixtureTurnKey, "failed", 4, sequence[1]),
		}, func(items []turnEvidence) {
			if state, reason := foldTurnEvidence(items).wait(); state != waitUnconfirmed || reason != "inconsistent-native-state" {
				t.Fatalf("unordered native terminals = %s, %s", state, reason)
			}
		})
	}
	permuteTurnEvidence([]turnEvidence{
		codexTerminalEvidence(fixtureTurnKey, "completed", 4, true),
		codexTerminalEvidence(fixtureTurnKey, "failed", 4, true),
		codexTerminalEvidence(fixtureTurnKey, "interrupted", 5, true),
	}, func(items []turnEvidence) {
		state, _ := foldTurnEvidence(items).wait()
		if state != waitCancelled {
			t.Fatalf("newer native terminal = %s", state)
		}
	})
	permuteTurnEvidence([]turnEvidence{
		codexTerminalEvidence(fixtureTurnKey, "completed", 0, false),
		codexTerminalEvidence(fixtureTurnKey, "completed", 4, true),
	}, func(items []turnEvidence) {
		if terminal, known := foldTurnEvidence(items).terminal(); !known || terminal.sequence != 4 || terminal.outcome != turnCompleted {
			t.Fatalf("consistent terminals = %v, %t", terminal, known)
		}
	})
}

func TestTurnCheckpointRoundTripPreservesTheFrontier(t *testing.T) {
	// Algorithmic core: saved notification checkpoints preserve scoped terminal evidence and current and last-live owner observations.
	turn := turnTransition{key: fixtureTurnKey}
	for _, item := range []turnEvidence{
		{key: fixtureTurnKey, owner: turnOwner{1, turnActive}},
		{key: fixtureTurnKey, owner: turnOwner{2, turnUnavailable}},
		codexTerminalEvidence(fixtureTurnKey, "completed", 3, true),
		codexTerminalEvidence(fixtureTurnKey, "interrupted", 0, false),
	} {
		turn = turn.advance(item)
		data := wire(turn.checkpoint())
		var value any
		if err := unmarshalJSON([]byte(data), &value); err != nil {
			t.Fatal(err)
		}
		if restored, ok := restoreTurnTransition(value); !ok || wire(restored.checkpoint()) != data {
			t.Fatalf("checkpoint round trip = %v, want %s", restored.checkpoint(), data)
		}
	}
}
