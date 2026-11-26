package core

import (
	"fmt"
	"testing"
)

func recoveryTestBlocker() object {
	return object{"id": "blocker", "revision": 2, "state": "cleared", "resources": []string{"app:installed"},
		"openedAt": coordinationTimestamp(1000), "clearedAt": coordinationTimestamp(4000), "clearedBy": object{"sourceId": "owner"}}
}
func recoveryTestEvent(kind, source, thread, turn string, at int64) object {
	return object{"eventId": kind + "-" + thread + "-" + turn, "kind": kind, "origin": object{"sourceId": source}, "resources": []string{"app:installed"},
		"observedAt": coordinationTimestamp(at), "timeBasis": "observed", "threadRefs": []coordinationThreadRef{{thread, &turn}}}
}
func recoveryTestAffected(source, thread string) []object {
	accepted := recoveryTestEvent("dispatch.accepted", source, thread, "old", 1200)
	notice := recoveryTestEvent("notice.changed", source, thread, "old", 1500)
	notice["observation"] = object{"sessionId": "session-" + source}
	terminal := recoveryTestEvent("turn.terminal", source, thread, "old", 2000)
	terminal["status"] = "failed"
	return []object{accepted, notice, terminal}
}
func TestCoordinationRecoveryNeedsClearanceAndBoundOwnerEvidence(t *testing.T) {
	// Contract: recovery advice uses retained dispatch owner and logical session evidence without resuming the task.
	blocker := recoveryTestBlocker()
	events := append(recoveryTestAffected("peer", "peer-thread"), recoveryTestAffected("owner", "own-thread")...)
	result := selectCoordinationRecovery(blocker, events, false)
	recipients := result["recipients"].([]object)
	if len(recipients) != 1 || recipients[0]["sourceId"] != "peer" || result["automaticResume"] != false {
		t.Fatalf("selection = %v", result)
	}
	if missing := selectCoordinationRecovery(blocker, []object{events[0], events[2]}, false); len(missing["unresolved"].([]object)) != 1 {
		t.Fatalf("missing binding = %v", missing)
	}
	blocker["state"] = "active"
	if suppressed := selectCoordinationRecovery(blocker, events, false); suppressed["reason"] != "not-cleared" {
		t.Fatalf("uncleared = %v", suppressed)
	}
}
func TestCoordinationRecoverySuppressesSuccessorsAndNewerUnrelatedDispatch(t *testing.T) {
	// Recurring bug class: lifecycle recovered mail cannot advise an obsolete turn after a successor or unrelated dispatch.
	for _, kind := range []string{"turn.terminal", "dispatch.accepted"} {
		events := recoveryTestAffected("peer", "thread")
		event := recoveryTestEvent(kind, "peer", "thread", "new", 3000)
		if kind == "turn.terminal" {
			successor := recoveryTestEvent("turn.successor", "peer", "thread", "old", 2500)
			successor["threadRefs"] = append(coordinationRefs(successor), coordinationThreadRef{"thread", new("new")})
			events = append(events, successor)
			event["status"] = "completed"
		}
		result := selectCoordinationRecovery(recoveryTestBlocker(), append(events, event), false)
		if len(result["recipients"].([]object)) != 0 {
			t.Fatalf("%s remains actionable: %v", kind, result)
		}
	}
}
func TestCoordinationRecoveryCapsCandidatesAcrossPages(t *testing.T) {
	// Algorithmic core: recovery selection scans candidates across the retained window and caps the result.
	var events []object
	for index := range 1002 {
		terminal := recoveryTestEvent("turn.terminal", "peer", fmt.Sprintf("thread-%d", index), "old", 2000)
		terminal["status"] = "failed"
		events = append(events, terminal)
	}
	result := selectCoordinationRecovery(recoveryTestBlocker(), events, false)
	if result["scanned"] != 1000 || result["truncated"] != true || result["coverage"] != "partial" || len(result["unresolved"].([]object)) != 1000 {
		t.Fatalf("unexpected recovery bounds: %v", selectFields(result, "scanned", "truncated", "coverage"))
	}
}
