package core

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestProjectGitShowRejectsFileSelector(t *testing.T) {
	// Recurring bug class: security A commit metadata read must reject a file selector and point to the file-diff contract.
	_, err := queryProject(t.Context(), nil, "git", object{"operation": "show", "revision": "HEAD", "path": "file.txt"})
	if err == nil {
		t.Fatal("git show accepted a file selector")
	}
	failure := controlFailure(err)
	if failure["code"] != "INVALID_ARGUMENTS" || !strings.Contains(err.Error(), "operation:diff") || !strings.Contains(err.Error(), "baseRevision") {
		t.Fatalf("unexpected recovery: %v", failure)
	}
}

func TestRegisteredProjectGivesBasenameRecovery(t *testing.T) {
	// Recurring bug class: persistence A root basename that is not a project name must return registered project discovery.
	root := filepath.FromSlash("/fixture/workspace-repository")
	rows := []any{object{"id": "workspace-id", "name": "workspace", "roots": []any{object{"path": root}}}}
	_, err := selectRegisteredProject(rows, "workspace-repository")
	if err == nil {
		t.Fatal("unregistered basename resolved as a project")
	}
	failure := controlFailure(err)
	next := obj(failure["next"])
	if failure["code"] != "PROJECT_NOT_FOUND" || next["via"] != "query" || next["op"] != "projects" || wire(next["args"]) != "{}" ||
		!strings.Contains(text(next, "hint"), "workspace-id") || !strings.Contains(text(next, "hint"), wire(root)) {
		t.Fatalf("unexpected project recovery: %v", failure)
	}
	for _, id := range []string{"workspace", "workspace-id"} {
		got, err := selectRegisteredProject(rows, id)
		if err != nil || got["id"] != "workspace-id" || got["name"] != "workspace" {
			t.Fatalf("could not resolve %s: %v %v", id, got, err)
		}
	}
}

func TestRegisteredProjectAmbiguityRequiresID(t *testing.T) {
	// Contract: A duplicated project name requires an ID and points to query projects.
	rows := []any{object{"id": "first", "name": "workspace"}, object{"id": "second", "name": "workspace"}}
	_, err := selectRegisteredProject(rows, "workspace")
	if err == nil {
		t.Fatal("duplicated project name resolved")
	}
	failure := controlFailure(err)
	next := obj(failure["next"])
	if failure["code"] != "PROJECT_AMBIGUOUS" || next["op"] != "projects" || wire(next["args"]) != "{}" {
		t.Fatalf("unexpected discovery: %v", failure)
	}
	if second, err := selectRegisteredProject(rows, "second"); err != nil || second["id"] != "second" {
		t.Fatalf("explicit ID could not resolve: %v %v", second, err)
	}
}
