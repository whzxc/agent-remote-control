//go:build arcfixture

package core

import (
	"errors"
	"os"
	"path/filepath"
)

func init() {
	fixtureNativeCodexInputs = func() (string, string, error) {
		binary := os.Getenv("ARC_FIXTURE_BINARY")
		home := os.Getenv("CODEX_HOME")
		if !filepath.IsAbs(binary) || !filepath.IsAbs(home) || !filepath.IsAbs(os.Getenv("ARC_STATE_DIR")) ||
			!filepath.IsAbs(os.Getenv("ARC_FIXTURE_SCRIPT")) {
			return "", "", errors.New("fixture binary, script, state and Codex home are required")
		}
		return binary, home, nil
	}
	fixtureUsesDesktop = func() bool {
		_, enabled := os.LookupEnv("ARC_FIXTURE_DESKTOP")
		return enabled
	}
}
