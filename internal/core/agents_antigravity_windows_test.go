package core

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestAntigravityDiscoveryFindsWindowsInstallations(t *testing.T) {
	// Contract: Windows Antigravity discovery resolves extensionless agentapi.bat and LocalAppData language_server.exe.
	home := t.TempDir()
	localAppData := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("LOCALAPPDATA", localAppData)
	t.Setenv("APPDATA", t.TempDir())
	t.Setenv("PATH", t.TempDir())
	t.Setenv("ARC_ANTIGRAVITY_BIN", "")

	driver, ok := nativeAgentDriverByID("antigravity")
	if !ok {
		t.Fatal("antigravity driver missing")
	}

	// Negative case: absent installation reports AGENT_NOT_INSTALLED.
	missing := driver.discover(context.Background())
	if missing.binary != "" || missing.err == nil || missing.err.Error() != "AGENT_NOT_INSTALLED" {
		t.Fatalf("missing antigravity = %+v", missing)
	}

	// Fallback to %LOCALAPPDATA%\Programs\antigravity\resources\bin\language_server.exe.
	langServer := filepath.Join(localAppData, "Programs", "antigravity", "resources", "bin", "language_server.exe")
	if err := os.MkdirAll(filepath.Dir(langServer), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(langServer, []byte("stub"), 0o644); err != nil {
		t.Fatal(err)
	}
	foundLS := driver.discover(context.Background())
	if foundLS.err != nil || foundLS.binary != langServer {
		t.Fatalf("language_server fallback = %+v, want %s", foundLS, langServer)
	}

	// Prefer %USERPROFILE%\.gemini\antigravity\bin\agentapi.bat via extensionless absolute lookup.
	agentAPI := filepath.Join(home, ".gemini", "antigravity", "bin", "agentapi.bat")
	if err := os.MkdirAll(filepath.Dir(agentAPI), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(agentAPI, []byte("@echo off\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	foundBat := driver.discover(context.Background())
	if foundBat.err != nil || foundBat.binary != agentAPI {
		t.Fatalf("agentapi.bat discovery = %+v, want %s", foundBat, agentAPI)
	}
}
