package core

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestDesktopPermissionSelectionRequiresCurrentOwnerAndLocalAgreement(t *testing.T) {
	// Recurring bug class: security another Desktop owner or host cannot grant local full access.
	home := t.TempDir()
	full := object{"kind": "agent-mode", "agentMode": "full-access"}
	restricted := object{"kind": "agent-mode", "agentMode": "read-only"}
	err := save(filepath.Join(home, ".codex-global-state.json"), object{
		desktopPermissionOwner: "active", "electron-owner-atoms:previous": object{desktopPermissionMode: object{"local": "full-access"}},
		"electron-owner-atoms:active": object{desktopPermissionSelection: full},
		desktopPermissionShared:       object{"permission-selection-by-host-id:ssh": full},
	})
	if err != nil {
		t.Fatal(err)
	}
	permissions := func() object {
		t.Helper()
		atoms, err := readDesktopPermissionAtoms(t.Context(), home)
		if err != nil {
			t.Fatal(err)
		}
		return desktopSavedPermissions(atoms, true)
	}
	if value := permissions(); value != nil {
		t.Fatalf("previous owner or remote host supplied permissions: %s", wire(value))
	}
	db, err := sql.Open("sqlite", filepath.Join(home, ".codex-global-state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE settings(scope TEXT, key TEXT, value TEXT)"); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		scope, key string
		value      any
	}{
		{"global", desktopPermissionOwner, "active"},
		{"electron-owner-atoms:active", desktopPermissionSelection, full},
		{"electron-owner-atoms:active", desktopPermissionMode, object{"local": "full-access"}},
		{"atom", desktopPermissionSelection, restricted},
	} {
		if _, err := db.Exec("INSERT INTO settings VALUES(?1,?2,?3)", row.scope, row.key, wire(row.value)); err != nil {
			t.Fatal(err)
		}
	}
	if value := permissions(); value != nil {
		t.Fatalf("disagreeing choices supplied permissions: %s", wire(value))
	}
	if _, err := db.Exec("DELETE FROM settings WHERE scope='atom'"); err != nil {
		t.Fatal(err)
	}
	if value := permissions(); value["permissions"] != ":danger-full-access" || value["approvalPolicy"] != "never" || value["approvalsReviewer"] != "user" {
		t.Fatalf("agreed local selection = %s", wire(value))
	}
	if _, err := db.Exec("DELETE FROM settings WHERE key=?1", desktopPermissionSelection); err != nil {
		t.Fatal(err)
	}
	if value := permissions(); value != nil {
		t.Fatalf("legacy selection alone supplied permissions: %s", wire(value))
	}
}
