package core

import "time"

type receiptState string

const (
	receiptReserved         receiptState = "reserved"
	receiptExecuting        receiptState = "executing"
	receiptAwaitingApproval receiptState = "awaiting-approval"
	receiptCompleted        receiptState = "completed"
	receiptFailed           receiptState = "failed"
	receiptRejected         receiptState = "rejected"
	receiptNotExecuted      receiptState = "not-executed"
	receiptCancelled        receiptState = "cancelled"
	receiptRolledBack       receiptState = "rolled-back"
	receiptUnconfirmed      receiptState = "unconfirmed"
)

type receiptEvent int

const (
	receiptBegin receiptEvent = iota
	receiptComplete
	receiptFail
	receiptAwaitApproval
	receiptApprove
	receiptReject
	receiptAbortBeforeSubmit
	receiptOwnerLost
)

func readReceiptState(raw string, ownerLive bool) receiptState {
	state := receiptState(raw)
	switch state {
	case receiptReserved, receiptExecuting, receiptAwaitingApproval, receiptCompleted, receiptFailed, receiptRejected, receiptNotExecuted, receiptCancelled, receiptRolledBack, receiptUnconfirmed:
	default:
		state = receiptUnconfirmed
	}
	if !ownerLive {
		return advanceReceipt(state, receiptOwnerLost, "")
	}
	return state
}

func advanceReceipt(state receiptState, event receiptEvent, failure receiptState) receiptState {
	active := state == receiptReserved || state == receiptExecuting
	switch {
	case event == receiptAwaitApproval && state == receiptReserved:
		return receiptAwaitingApproval
	case event == receiptBegin && state == receiptReserved:
		return receiptExecuting
	case event == receiptApprove && state == receiptAwaitingApproval:
		return receiptReserved
	case event == receiptReject && state == receiptAwaitingApproval, event == receiptAbortBeforeSubmit && state == receiptReserved:
		return receiptNotExecuted
	case event == receiptComplete && (active || state == receiptUnconfirmed):
		return receiptCompleted
	case event == receiptFail && (active || state == receiptUnconfirmed):
		return failure
	case event == receiptOwnerLost && active:
		return receiptUnconfirmed
	default:
		return state
	}
}

func projectReceipt(row object, ownerLive bool, timeMS int64) object {
	raw := text(row, "state")
	if raw == "not-found" {
		return row
	}
	state := readReceiptState(raw, ownerLive)
	if raw != string(state) {
		row["previousState"] = row["state"]
	}
	row["state"] = string(state)
	submission := "submitted"
	switch state {
	case receiptReserved, receiptAwaitingApproval:
		submission = "reserved"
	case receiptUnconfirmed:
		submission = "unconfirmed"
	case receiptNotExecuted, receiptRejected:
		submission = "not-executed"
	}
	var execution any
	switch state {
	case receiptExecuting, receiptCompleted, receiptFailed, receiptCancelled, receiptRolledBack:
		execution = string(state)
	}
	var age int64
	for _, key := range []string{"updatedAt", "createdAt", "startedAt"} {
		if input, ok := row[key].(string); ok {
			if at, err := time.Parse(time.RFC3339Nano, input); err == nil {
				age = max(0, timeMS-at.UnixMilli())
				row["phaseAgeMs"] = age
			}
			break
		}
	}
	row["submissionState"] = submission
	row["executionState"] = execution
	row["progressStalled"] = state == receiptReserved && age >= 30_000 || field(row["progress"], "progressStalled") == true
	return row
}
