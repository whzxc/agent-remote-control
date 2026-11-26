package core

import (
	"strings"
	"testing"
)

func TestNotificationAdmissionRequiresExactTurnWithoutConflict(t *testing.T) {
	// Recurring bug class: lifecycle late predecessor, owner loss and conflicting records could publish a terminal wake.
	b := object{"threadId": "task", "turnId": "current", "agent": "codex", "observation": object{"state": "unconfirmed"}}
	d := object{"key": "terminal", "taskState": "completed", "state": "completed"}
	if notificationObservationMatches(b, object{"threadId": "task", "turnId": "prior"}) || notificationAdmits(b, d) {
		t.Fatal("predecessor or unconfirmed loss became a terminal wake")
	}
	obj(b["observation"])["state"] = "completed"
	if !notificationAdmits(b, d) {
		t.Fatal("confirmed completion was dropped")
	}
	obj(b["observation"])["conflict"] = object{"records": []any{"failed", "completed"}}
	if notificationAdmits(b, d) {
		t.Fatal("conflicted wake was admitted")
	}
}

func TestNotificationDoorbellContainsOnlyGuideLabels(t *testing.T) {
	// Contract: Claude notification doorbell preserves guide vocabulary and fixed header.
	body := notificationDoorbell([]string{"✓ done", "✗ failed", "✓ done", "fixture private task output"})
	if body != notificationReceiptHeader+"\n✗ failed · ✓ done ×2" {
		t.Fatalf("doorbell = %q", body)
	}
	guide := wire(field(field(catalog()["guides"], "en"), "profile-notify"))
	for _, label := range notificationGlyphs {
		if !strings.Contains(guide, label) {
			t.Fatalf("label %q missing from guide", label)
		}
	}
}
