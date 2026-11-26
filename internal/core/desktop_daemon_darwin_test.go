package core

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSurvivingDesktopMatchesResolvedBackendSocket(t *testing.T) {
	// Recurring bug class: lifecycle a surviving Desktop keeps its launch URL when the restarted Core verifies the resolved socket.
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	private := filepath.Join(dir, "private.sock")
	shared := filepath.Join(dir, "shared.sock")
	for _, path := range []string{private, shared} {
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	alias := filepath.Join(dir, "codex-home.sock")
	if err := os.Symlink(private, alias); err != nil {
		t.Fatal(err)
	}
	survivor := nativeDesktopInstance{endpoint: nativeDesktopSocketURL(alias)}
	if !survivor.uses(private) {
		t.Fatal("the surviving Desktop was not eligible for its resolved backend")
	}
	if survivor.uses(shared) {
		t.Fatal("the surviving Desktop was eligible for a different backend")
	}
}
