package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/whzxc/agent-remote-control/internal/core"
)

func terminalImport(t *testing.T, jobs *sourceJobs) object {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		for _, row := range jobs.metadata(nil)["containers"].([]object) {
			if row["accountId"] == "account" && row["status"] != "importing" {
				return row
			}
		}
		select {
		case <-deadline:
			t.Fatal("import did not reach a pollable terminal state")
		case <-time.After(time.Millisecond):
		}
	}
}

func TestKeychainImportTransitionsAndSameAccountDeduplication(t *testing.T) {
	// Recurring bug class: lifecycle an ongoing Keychain prompt remains pollable through import completion.
	for _, installed := range []bool{true, false} {
		ctx := t.Context()
		var jobs sourceJobs
		var keychain keychainRequest
		allow := make(chan struct{})
		initial := jobs.start(ctx, "account", "store", func(ctx context.Context) (object, error) {
			password, err := keychain.password(ctx, func() ([]byte, error) {
				<-allow
				return []byte("synthetic-keychain-password"), nil
			}, time.Second)
			clear(password)
			return core.DesktopSourceImportState("account", false, installed, nil), err
		})
		if initial["status"] != "importing" || objectValue(initial["next"])["op"] != "src_conversations" {
			t.Fatalf("unexpected initial state: %v", initial)
		}
		duplicate := jobs.start(ctx, "account", "store", func(context.Context) (object, error) {
			return nil, errors.New("unexpected-duplicate-import")
		})
		close(allow)
		if duplicate["status"] != "importing" {
			t.Fatalf("unexpected duplicate state: %v", duplicate)
		}
		expected := "not-imported"
		if installed {
			expected = "signed-in-pending"
		}
		complete := terminalImport(t, &jobs)
		if complete["status"] != expected || complete["reason"] != nil {
			t.Fatalf("unexpected completion: %v", complete)
		}
		view := object{"accountId": "account", "storeId": "store", "status": "signed-in", "open": true}
		if got := jobs.metadata([]object{view})["containers"].([]object)[0]["status"]; got != "signed-in" {
			t.Fatalf("expected signed-in observation, got %v", got)
		}
	}
}

func TestKeychainDenialAndTimeoutRemainPollableBlockers(t *testing.T) {
	// Recurring bug class: lifecycle denial and timeouts remain pollable while macOS owns the password prompt.
	for _, denied := range []bool{true, false} {
		var jobs sourceJobs
		var keychain keychainRequest
		release := make(chan struct{})
		fetchReturned := make(chan struct{})
		reason, timeout := "keychain-timeout", 10*time.Millisecond
		if denied {
			reason, timeout = "keychain-denied", time.Second
		}
		jobs.start(t.Context(), "account", "store", func(ctx context.Context) (object, error) {
			_, err := keychain.password(ctx, func() ([]byte, error) {
				defer close(fetchReturned)
				if !denied {
					<-release
				}
				return nil, errors.New("keychain-denied")
			}, timeout)
			return nil, err
		})
		blocked := terminalImport(t, &jobs)
		if !denied {
			_, err := keychain.password(t.Context(), func() ([]byte, error) { return nil, nil }, time.Second)
			if err == nil || err.Error() != "keychain-request-still-pending" {
				t.Errorf("concurrent lookup returned %v", err)
			}
		}
		close(release)
		<-fetchReturned
		hint := stringAt(blocked, "hint")
		if blocked["status"] != "import-blocked" || blocked["reason"] != reason ||
			!strings.Contains(hint, "macOS login password") || !strings.Contains(hint, "Always Allow") {
			t.Fatalf("unexpected blocker: %v", blocked)
		}
	}
}
