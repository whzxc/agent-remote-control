package core

import (
	"cmp"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
)

type turnKey struct {
	agent, session, turn string
}

type turnOutcome uint8

const (
	turnCompleted turnOutcome = iota + 1
	turnFailed
	turnInterrupted
)

type turnTerminal struct {
	outcome   turnOutcome
	sequence  uint64
	sequenced bool
}

type turnOwnerState uint8

const (
	turnNotFound turnOwnerState = iota + 1
	turnInconsistent
	turnUnavailable
	turnActive
	turnAwaitingInteraction
)

type turnOwner struct {
	revision uint64
	state    turnOwnerState
}

type turnEvidence struct {
	key      turnKey
	terminal turnTerminal
	owner    turnOwner
}

type turnTransition struct {
	key       turnKey
	terminals []turnTerminal
	owner     turnOwner
	lastLive  turnOwner
}

func compareTurnOwner(a, b turnOwner) int {
	return cmp.Or(cmp.Compare(a.revision, b.revision), cmp.Compare(a.state, b.state))
}

func compareNativeSequence(a, b turnTerminal) int {
	if a.sequenced != b.sequenced {
		if a.sequenced {
			return 1
		}
		return -1
	}
	return cmp.Compare(a.sequence, b.sequence)
}

// Terminal evidence outranks owner observations. A newer sequence supersedes
// earlier sequences within the selected native turn. Unsequenced conflicts remain.
func (t turnTransition) advance(evidence turnEvidence) turnTransition {
	if t.key != evidence.key {
		return t
	}
	if record := evidence.terminal; record.outcome != 0 {
		t.terminals = append(slices.Clone(t.terminals), record)
		newest := slices.MaxFunc(t.terminals, compareNativeSequence)
		t.terminals = slices.DeleteFunc(t.terminals, func(value turnTerminal) bool {
			return value.sequenced && value.sequence != newest.sequence
		})
		slices.SortFunc(t.terminals, func(a, b turnTerminal) int {
			return cmp.Or(cmp.Compare(a.outcome, b.outcome), compareNativeSequence(a, b))
		})
		t.terminals = slices.Compact(t.terminals)
	} else if owner := evidence.owner; owner.state != 0 {
		if compareTurnOwner(owner, t.owner) > 0 {
			t.owner = owner
		}
		if owner.state >= turnActive && compareTurnOwner(owner, t.lastLive) > 0 {
			t.lastLive = owner
		}
	}
	return t
}

func (t turnTransition) evidence() []turnEvidence {
	result := make([]turnEvidence, 0, len(t.terminals)+2)
	for _, terminal := range t.terminals {
		result = append(result, turnEvidence{key: t.key, terminal: terminal})
	}
	for _, owner := range []turnOwner{t.lastLive, t.owner} {
		if owner.state != 0 {
			result = append(result, turnEvidence{key: t.key, owner: owner})
		}
	}
	return result
}

func (t turnTransition) terminal() (turnTerminal, bool) {
	if len(t.terminals) == 0 {
		return turnTerminal{}, false
	}
	for _, record := range t.terminals[1:] {
		if record.outcome != t.terminals[0].outcome {
			return turnTerminal{}, false
		}
	}
	return slices.MaxFunc(t.terminals, compareNativeSequence), true
}

type turnWaitState string

const (
	waitRunning     turnWaitState = "running"
	waitCompleted   turnWaitState = "completed"
	waitFailed      turnWaitState = "failed"
	waitCancelled   turnWaitState = "cancelled"
	waitInteraction turnWaitState = "interaction-required"
	waitUnconfirmed turnWaitState = "unconfirmed"
	waitTimeout     turnWaitState = "timeout"
)

func parseTurnWaitState(value string) (turnWaitState, bool) {
	state := turnWaitState(value)
	switch state {
	case waitRunning, waitCompleted, waitFailed, waitCancelled, waitInteraction, waitUnconfirmed, waitTimeout:
		return state, true
	default:
		return "", false
	}
}

func (s turnWaitState) terminal() bool {
	return s == waitCompleted || s == waitFailed || s == waitCancelled
}

func (s turnWaitState) keepsResponse() bool {
	return s.terminal() || s == waitInteraction
}

func (o turnOwner) wait() (turnWaitState, string) {
	switch o.state {
	case turnActive:
		return waitRunning, "native-turn-active"
	case turnAwaitingInteraction:
		return waitInteraction, "native-interaction"
	case turnUnavailable:
		return waitUnconfirmed, "runtime-ownership-unknown"
	case turnInconsistent:
		return waitUnconfirmed, "inconsistent-native-state"
	default:
		return waitUnconfirmed, "turn-not-found"
	}
}

func (t turnTransition) wait() (turnWaitState, string) {
	if confirmed, ok := t.terminal(); ok {
		state := turnWaitState(pushTurnOutcome(confirmed.outcome))
		if state == "interrupted" {
			state = waitCancelled
		}
		return state, "native-turn-terminal"
	}
	if len(t.terminals) != 0 {
		return waitUnconfirmed, "inconsistent-native-state"
	}
	return t.owner.wait()
}

func (t turnTransition) push() string {
	if confirmed, ok := t.terminal(); ok {
		return pushTurnOutcome(confirmed.outcome)
	}
	if state, _ := t.wait(); state == waitInteraction {
		return "needs-input"
	}
	return ""
}

func pushTurnOutcome(outcome turnOutcome) string {
	switch outcome {
	case turnCompleted:
		return "completed"
	case turnFailed:
		return "failed"
	case turnInterrupted:
		return "interrupted"
	default:
		return ""
	}
}

func (t turnTransition) workScope() string {
	state, _ := t.wait()
	switch state {
	case waitCompleted, waitFailed:
		return "completed"
	case waitCancelled:
		return "interrupted"
	case waitRunning, waitInteraction:
		return "running"
	default:
		return "unknown"
	}
}

func (t turnTransition) projection() string {
	state, _ := t.wait()
	switch state {
	case waitInteraction:
		return "waiting-permission"
	case waitUnconfirmed:
		return "unknown"
	default:
		return string(state)
	}
}

func (t turnTransition) checkpoint() object {
	terminals := make([]any, 0, len(t.terminals))
	for _, record := range t.terminals {
		var sequence any
		if record.sequenced {
			sequence = record.sequence
		}
		terminals = append(terminals, object{"status": pushTurnOutcome(record.outcome), "sequence": sequence})
	}
	var owner, live any
	if t.owner.state != 0 {
		state, reason := t.owner.wait()
		owner = object{"revision": t.owner.revision, "state": string(state), "reason": reason}
	}
	if t.lastLive.state != 0 {
		state, _ := t.lastLive.wait()
		live = object{"revision": t.lastLive.revision, "state": string(state)}
	}
	return object{"agent": t.key.agent, "threadId": t.key.session, "turnId": t.key.turn,
		"terminals": terminals, "owner": owner, "lastLive": live}
}

func restoreTurnTransition(value any) (turnTransition, bool) {
	agent, agentOK := field(value, "agent").(string)
	session, sessionOK := field(value, "threadId").(string)
	turnID, turnOK := field(value, "turnId").(string)
	terminals := arr(field(value, "terminals"))
	if !agentOK || !sessionOK || !turnOK || terminals == nil {
		return turnTransition{}, false
	}
	key := turnKey{agent, session, turnID}
	turn := turnTransition{key: key}
	for _, record := range terminals {
		sequence, sequenced := uintValue(field(record, "sequence"))
		terminal := codexTerminalEvidence(key, text(record, "status"), sequence, sequenced)
		if terminal.terminal.outcome == 0 {
			return turnTransition{}, false
		}
		turn = turn.advance(terminal)
	}
	for _, record := range []any{field(value, "lastLive"), field(value, "owner")} {
		if record == nil {
			continue
		}
		revision, ok := uintValue(field(record, "revision"))
		if !ok {
			return turnTransition{}, false
		}
		var owner turnOwnerState
		switch text(record, "state") {
		case "running":
			owner = turnActive
		case "interaction-required":
			owner = turnAwaitingInteraction
		case "unconfirmed":
			switch text(record, "reason") {
			case "turn-not-found":
				owner = turnNotFound
			case "inconsistent-native-state":
				owner = turnInconsistent
			case "runtime-ownership-unknown":
				owner = turnUnavailable
			}
		}
		if owner == 0 {
			return turnTransition{}, false
		}
		turn = turn.advance(turnEvidence{key: key, owner: turnOwner{revision, owner}})
	}
	return turn, true
}

func codexTerminalEvidence(key turnKey, status string, sequence uint64, sequenced bool) turnEvidence {
	var outcome turnOutcome
	switch status {
	case "completed":
		outcome = turnCompleted
	case "failed":
		outcome = turnFailed
	case "interrupted", "cancelled":
		outcome = turnInterrupted
	}
	return turnEvidence{key: key, terminal: turnTerminal{outcome, sequence, sequenced}}
}

func codexRolloutTerminal(key turnKey, contents string) (turnEvidence, error) {
	var terminal turnEvidence
	var active string
	var historyStart uint64
	var ordinal uint64
	for line := range strings.SplitSeq(strings.TrimSuffix(contents, "\n"), "\n") {
		if contents == "" {
			break
		}
		var record any
		if err := unmarshalJSON([]byte(line), &record); err != nil {
			return turnEvidence{}, fmt.Errorf("INVALID_NATIVE_HISTORY: %w", err)
		}
		payload := field(record, "payload")
		kind, event := text(record, "type"), text(payload, "type")
		if ordinal == 0 {
			if kind != "session_meta" || field(payload, "id") != key.session {
				return turnEvidence{}, errors.New("NATIVE_THREAD_ID_MISMATCH")
			}
			historyStart = uintOr(field(payload, "subagent_history_start_ordinal"), 0)
		}
		if ordinal >= historyStart {
			if kind == "turn_context" || kind == "event_msg" && event == "task_started" {
				active = text(payload, "turn_id")
			}
			turn, ok := field(payload, "turn_id").(string)
			if !ok {
				turn = active
			}
			if kind == "event_msg" && turn == key.turn {
				switch event {
				case "task_complete":
					terminal = codexTerminalEvidence(key, "completed", ordinal, true)
				case "turn_aborted":
					terminal = codexTerminalEvidence(key, "interrupted", ordinal, true)
				}
			}
		}
		ordinal++
	}
	return terminal, nil
}

// Decode status from the owning adapter. Intent and transport loss enter the
// frontier as owner observations without confirming a terminal state.
func recordedTurnEvidence(key turnKey, status string, revision uint64) turnEvidence {
	if evidence := codexTerminalEvidence(key, status, 0, false); evidence.terminal.outcome != 0 {
		return evidence
	}
	state := turnUnavailable
	switch status {
	case "running", "inProgress", "starting", "cancelling":
		state = turnActive
	case "waiting-permission", "interaction-required":
		state = turnAwaitingInteraction
	}
	return turnEvidence{key: key, owner: turnOwner{revision, state}}
}

func turnSnapshot(key turnKey, status string, checkpoint any) turnTransition {
	if turn, ok := restoreTurnTransition(checkpoint); ok && turn.key == key {
		return turn
	}
	return (turnTransition{key: key}).advance(recordedTurnEvidence(key, status, 0))
}

func (t turnTransition) observe(incoming turnTransition) turnTransition {
	if t.key != incoming.key {
		return t
	}
	revision := max(t.owner.revision, incoming.owner.revision)
	if revision < math.MaxUint64 {
		revision++
	}
	for _, evidence := range incoming.evidence() {
		t = t.advance(evidence)
	}
	if len(incoming.terminals) > 0 {
		return t
	}
	state := incoming.owner.state
	if state == 0 {
		state = turnNotFound
	}
	return t.advance(turnEvidence{key: t.key, owner: turnOwner{revision, state}})
}

func codexTurnSnapshot(thread string, turn any) turnTransition {
	return turnSnapshot(turnKey{"codex", thread, text(turn, "id")}, text(turn, "status"), field(turn, "_turnLifecycle"))
}

func codexTurnSnapshots(thread string, turns []any, selected string) turnTransition {
	result := turnTransition{key: turnKey{"codex", thread, selected}}
	for _, turn := range turns {
		if field(turn, "id") == selected {
			for _, evidence := range codexTurnSnapshot(thread, turn).evidence() {
				result = result.advance(evidence)
			}
		}
	}
	return result
}

func piSettledTurn(key turnKey, stopReason string) turnEvidence {
	status := "completed"
	switch stopReason {
	case "error":
		status = "failed"
	case "aborted":
		status = "cancelled"
	}
	return recordedTurnEvidence(key, status, 0)
}

func piPromptTurn(key turnKey, response object) turnEvidence {
	if response["error"] != nil || response["success"] != true {
		return codexTerminalEvidence(key, "failed", 0, false)
	}
	return turnEvidence{}
}

func acpResponseTurn(key turnKey, response object) turnEvidence {
	switch result, present := response["result"]; {
	case response["error"] != nil:
		return codexTerminalEvidence(key, "failed", 0, false)
	case !present:
		return turnEvidence{}
	case field(result, "stopReason") == "cancelled":
		return codexTerminalEvidence(key, "cancelled", 0, false)
	default:
		return codexTerminalEvidence(key, "completed", 0, false)
	}
}

func antigravityResultTurn(key turnKey, result object) turnEvidence {
	switch {
	case result["status"] == "SUCCESS":
		return recordedTurnEvidence(key, "completed", 0)
	case result["finished_reason"] == "interrupted":
		return recordedTurnEvidence(key, "cancelled", 0)
	default:
		return recordedTurnEvidence(key, "failed", 0)
	}
}

func codexOwnerEvidence(key turnKey, recorded *string, runtime string, interacting bool, revision uint64) turnEvidence {
	state := turnInconsistent
	switch {
	case recorded == nil:
		state = turnNotFound
	case runtime == "unknown" || runtime == "notLoaded" || runtime == "":
		state = turnUnavailable
	case interacting:
		state = turnAwaitingInteraction
	case *recorded == "inProgress" && runtime == "active":
		state = turnActive
	}
	return turnEvidence{key: key, owner: turnOwner{revision, state}}
}
