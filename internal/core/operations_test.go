package core

import (
	"testing"
	"time"
)

func TestManagementWritesShareExecutionAndLostSubmissionProgress(t *testing.T) {
	// Recurring bug class: retry-replay interrupted management writes retain the original receipt and do not suggest another submission.
	start := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	receipt := object{"requestId": "original-management-request", "operation": "settings.patch", "instance": "owner",
		"state": "executing", "startedAt": start.Format(time.RFC3339), "nextAction": "old recovery"}
	for _, offset := range []time.Duration{45 * time.Second, 5 * time.Minute, time.Hour} {
		ms := start.Add(offset).UnixMilli()
		live := projectManagementReceipt(clone(receipt), "owner", ms)
		if live["state"] != "executing" || live["submissionState"] != "submitted" ||
			live["executionState"] != "executing" || live["progressStalled"] != false {
			t.Errorf("live receipt: %v", live)
		}
		lost := projectManagementReceipt(clone(receipt), "new-owner", ms)
		if lost["state"] != "unconfirmed" || lost["previousState"] != "executing" ||
			lost["requestId"] != receipt["requestId"] || lost["submissionState"] != "unconfirmed" ||
			lost["executionState"] != nil || lost["progressStalled"] != false ||
			wire(lost["next"]) != `{"arguments":{"id":"original-management-request"},"operation":"operations.get"}` ||
			lost["nextAction"] != nil {
			t.Errorf("lost receipt: %v", lost)
		}
	}
	receipt["state"] = "completed"
	if got := projectManagementReceipt(receipt, "new-owner", start.UnixMilli()); got["state"] != "completed" {
		t.Errorf("completed receipt after restart: %v", got)
	}
}
