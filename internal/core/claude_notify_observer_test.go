package core

import "testing"

func TestNotificationObservationReusesSettledNativeEvidence(t *testing.T) {
	// Recurring bug class: lifecycle settled observations repeatedly hydrated unchanged native histories.
	b := object{"observation": object{"state": "completed", "reconciliation": "reconciled"}}
	if !notificationObservationReusable(b) {
		t.Fatal("settled observation requires another read")
	}
	obj(b["observation"])["state"] = "cancelled"
	if !notificationObservationReusable(b) {
		t.Fatal("settled interruption requires another read")
	}
	b["retry"] = object{"status": "scheduled"}
	if notificationObservationReusable(b) {
		t.Fatal("scheduled retry was parked")
	}
	delete(b, "retry")
	b["deliveries"] = []any{object{"status": "pending", "interaction": object{"id": "question"}}}
	if notificationObservationReusable(b) {
		t.Fatal("pending request was parked")
	}
}
