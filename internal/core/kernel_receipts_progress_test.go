package core

import "testing"

func TestProgressSeparatesExecutionFromSubmissionAndOwnerLoss(t *testing.T) {
	// Algorithmic core: receipt transitions preserve settled outcomes, fence owner loss and stall only reservations.
	states := []receiptState{receiptReserved, receiptExecuting, receiptAwaitingApproval, receiptCompleted, receiptFailed,
		receiptRejected, receiptNotExecuted, receiptCancelled, receiptRolledBack, receiptUnconfirmed}
	events := []struct {
		event   receiptEvent
		failure receiptState
	}{
		{event: receiptBegin}, {event: receiptComplete}, {receiptFail, receiptFailed}, {receiptFail, receiptUnconfirmed},
		{receiptFail, receiptRejected}, {event: receiptAwaitApproval}, {event: receiptApprove}, {event: receiptReject}, {event: receiptOwnerLost},
	}
	for _, state := range states {
		wasSettled := state == receiptCompleted || state == receiptFailed || state == receiptCancelled || state == receiptRolledBack
		for _, event := range events {
			next := advanceReceipt(state, event.event, event.failure)
			if advanceReceipt(next, event.event, event.failure) != next || wasSettled && next != state {
				t.Errorf("%q with event %v: unstable or changed settled state %q", state, event, next)
			}
			for _, age := range []int64{0, 29_999, 30_000, 45_001} {
				projected := projectReceipt(object{"state": string(next), "createdAt": "2000-01-01T00:00:00Z"}, true, 946684800000+age)
				if projected["progressStalled"] != (next == receiptReserved && age >= 30_000) {
					t.Errorf("wrong stalled state at age %d: %v", age, projected)
				}
				if next == receiptExecuting && projected["submissionState"] != "submitted" {
					t.Errorf("execution without confirmed submission: %v", projected)
				}
			}
		}
		lost := readReceiptState(string(state), false)
		active := state == receiptReserved || state == receiptExecuting
		if (lost == receiptUnconfirmed) != (active || state == receiptUnconfirmed) || lost == receiptUnconfirmed && advanceReceipt(lost, receiptBegin, "") != lost {
			t.Errorf("owner loss for %q projected %q", state, lost)
		}
		row := object{"requestId": "original-request", "state": string(state), "createdAt": "2000-01-01T00:00:00Z"}
		projected := projectReceipt(row, false, 946684845000)
		if projected["requestId"] != "original-request" || wire(projectReceipt(clone(projected), false, 946684845000)) != wire(projected) {
			t.Errorf("owner-loss projection changed identity or repeated outcome: %v", projected)
		}
	}
	absent := object{"requestId": "original-request", "state": "not-found", "executionState": "no-reservation"}
	before := wire(absent)
	if wire(projectReceipt(absent, false, 946684845000)) != before {
		t.Fatalf("receipt without reservation changed: %v", absent)
	}
}
