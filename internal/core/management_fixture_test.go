//go:build arcfixture

package core

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestCodexLoginReadsNativeStatusAndDisclosesTheDesktopAction(t *testing.T) {
	// Contract: local Codex login routes report native login status and return the Desktop continuation.
	if operatingSystem == "windows" {
		t.Skip("the native login fixture uses a POSIX executable")
	}
	dir := t.TempDir()
	binary := filepath.Join(dir, "codex-fixture")
	priorFixture, priorInputs, priorDesktop, priorOpen := runtimeFixture, fixtureNativeCodexInputs, fixtureUsesDesktop, openFixtureDesktopURL
	t.Cleanup(func() {
		runtimeFixture, fixtureNativeCodexInputs, fixtureUsesDesktop, openFixtureDesktopURL = priorFixture, priorInputs, priorDesktop, priorOpen
	})
	runtimeFixture = true
	fixtureNativeCodexInputs = func() (string, string, error) { return binary, dir, nil }
	fixtureUsesDesktop = func() bool { return true }
	var opened string
	openFixtureDesktopURL = func(url string) error { opened = url; return nil }
	app := &service{}
	for _, expected := range []struct{ script, state string }{{"exit 0", "authenticated"}, {"exit 1", "unauthenticated"}} {
		if err := os.WriteFile(binary, []byte("#!/bin/sh\n[ \"$*\" = 'login status' ] || exit 2\n"+expected.script+"\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		status, err := app.managementRequest(t.Context(), "codex/login", http.MethodGet, nil)
		if err != nil || field(status, "state") != expected.state {
			t.Fatalf("native login = %v, %v", status, err)
		}
	}
	status, err := app.managementRequest(t.Context(), "codex/login", http.MethodPost, nil)
	if err != nil || field(status, "state") != "unauthenticated" || field(status, "message") != "Complete login in Codex Desktop" || opened != "codex://" {
		t.Fatalf("native login action = %v, opened %q, %v", status, opened, err)
	}
}
