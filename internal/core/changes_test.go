package core

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNativeChangeSnapshotRemainsBoundToTerminalWorkspace(t *testing.T) {
	// Recurring bug class: persistence a terminal turn keeps its original Git evidence after later workspace edits.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	repository := t.TempDir()
	ctx := t.Context()
	git := func(args ...string) {
		t.Helper()
		if _, err := projectGit(ctx, repository, args...); err != nil {
			t.Fatal(err)
		}
	}
	git("init")
	writeFixtureChangeFile(t, repository, "test.txt", "original\n")
	git("add", "test.txt")
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Initial")
	baseline := captureNativeChangeBaseline(ctx, repository)
	if err := recordNativeChangeBaseline("fixture-thread", "fixture-turn", baseline); err != nil {
		t.Fatal(err)
	}
	writeFixtureChangeFile(t, repository, "test.txt", "changed\n")
	captureTerminalNativeChanges(ctx, "fixture-thread", "fixture-turn")
	snapshot := nativeChangeEvidence(ctx, "fixture-thread", "fixture-turn", repository, true)
	if snapshot["changeEvidence"] != "terminal-git-snapshot" || field(snapshot["summary"], "files") == nil ||
		uintOr(field(snapshot["summary"], "added"), 0) != 1 {
		t.Fatalf("terminal evidence = %s", wire(snapshot))
	}
	writeFixtureChangeFile(t, repository, "later.txt", "must not be attributed\n")
	frozen := nativeChangeEvidence(ctx, "fixture-thread", "fixture-turn", repository, true)
	if wire(frozen) != wire(snapshot) {
		t.Fatalf("terminal evidence changed: %s", wire(frozen))
	}
	if result := nativeChangePage(ctx, frozen, object{"path": "test.txt"}); result["diff"] != nil || result["diffUnavailable"] == nil {
		t.Fatalf("retained statistics exposed an unfrozen patch: %s", wire(result))
	}
}

// These are fixture repository files. The test reads ARC evidence through the same functions as its operations.
func writeFixtureChangeFile(t *testing.T, repository, path, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(repository, path), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}
