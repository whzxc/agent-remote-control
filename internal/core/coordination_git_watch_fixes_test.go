package core

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoordinationLaterFixOverlapUsesOnlyBoundedEvidence(t *testing.T) {
	// Algorithmic core: later-fix correlations require timely change-path overlap and expose ambiguity as unknown.
	files := []any{object{"path": "listener.go"}}
	first := object{"threadId": "thread", "turnId": "turn", "commonDir": "/fixture/.git", "capturedAt": "2026-01-01T00:00:00Z", "endedAt": "2026-01-01T00:01:00Z", "dirty": false, "files": files}
	commit := object{"commit": "fix-object", "committedAt": "2026-01-02T00:00:00Z", "message": "fix(core): close listener", "files": files}
	for _, choice := range []struct {
		name       string
		rows       []object
		continuous bool
		coverage   string
	}{
		{"unique", []object{first}, true, "bounded"},
		{"offline", []object{first}, false, "unknown"},
		{"shared", []object{first, object{"threadId": "other", "turnId": "other", "commonDir": "/fixture/.git", "capturedAt": "2026-01-01T00:00:00Z", "files": files}}, true, "unknown"},
	} {
		rows := coordinationFixOverlap(choice.rows, commit, "/fixture/.git", "refs/heads/main", choice.continuous)
		if len(rows) == 0 || rows[0]["coverage"] != choice.coverage {
			t.Fatalf("%s = %v", choice.name, rows)
		}
	}
	commit["message"] = "docs: change phrasing"
	if rows := coordinationFixOverlap([]object{first}, commit, "/fixture/.git", "refs/heads/main", true); len(rows) != 0 {
		t.Fatalf("unrelated commit = %v", rows)
	}
	commit["message"] = "docs: change phrasing\n\nARC-Turn: turn"
	if rows := coordinationFixOverlap([]object{first}, commit, "/fixture/.git", "refs/heads/main", true); len(rows) != 1 {
		t.Fatalf("explicit turn trailer = %v", rows)
	}
	commit["committedAt"] = "2026-01-16T00:00:00Z"
	if rows := coordinationFixOverlap([]object{first}, commit, "/fixture/.git", "refs/heads/main", true); len(rows) != 0 {
		t.Fatalf("out of window = %v", rows)
	}
}

func TestCoordinationWatchedCommitRangeRetainsMatchingFixes(t *testing.T) {
	// Recurring bug class: persistence repeated watched ranges retain matching correlations without duplicating or attributing unrelated fixes.
	old := coordinationLocalGit
	t.Cleanup(func() { coordinationLocalGit = old })
	match, other := strings.Repeat("a", 40), strings.Repeat("b", 40)
	coordinationLocalGit = func(_ context.Context, _ string, args ...string) (string, error) {
		switch args[0] {
		case "log":
			return match + "\n" + other + "\n", nil
		case "show":
			path := "elsewhere.go"
			if args[len(args)-2] == match {
				path = "listener.go"
			}
			return "2026-01-02T00:00:00Z\x00fix(core): close listener\x00M\x00" + path + "\x00", nil
		default:
			return "", errors.New("unexpected Git operation")
		}
	}
	rows := []object{{"threadId": "thread", "turnId": "turn", "commonDir": "/fixture/.git", "capturedAt": "2026-01-01T00:00:00Z", "endedAt": "2026-01-01T00:01:00Z", "dirty": false, "files": []any{object{"path": "listener.go"}}}}
	path := filepath.Join(t.TempDir(), "quality-correlations.json")
	for range 2 {
		if err := observeCoordinationFixes(t.Context(), "/fixture", "/fixture/.git", "refs/heads/main", match, other, true, rows, path); err != nil {
			t.Fatal(err)
		}
	}
	summary := coordinationFixSummary(t.Context(), rows, path)
	if summary["matches"] != 1 || summary["retained"] != 1 || summary["coverage"] != "bounded" {
		t.Fatalf("summary = %v", summary)
	}
}
