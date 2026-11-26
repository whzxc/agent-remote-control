//go:build arcfixture

package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"
)

func fixtureTaskIndexSignal(s *service) chan struct{} {
	s.taskRecords.indexReady.Do(func() { s.taskRecords.indexReadySignal = make(chan struct{}) })
	return s.taskRecords.indexReadySignal
}

func init() {
	registerAfterIndexStartup(0, func(_ context.Context, s *service) error {
		close(fixtureTaskIndexSignal(s))
		return nil
	})
	waitFixtureTaskIndex = func(ctx context.Context, s *service) error {
		// Explicit index-startup fixtures must continue to observe pending reads.
		if s.fixtureIngress == nil || os.Getenv("ARC_FIXTURE_INDEX_GATE") != "" {
			return nil
		}
		wait, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		select {
		case <-fixtureTaskIndexSignal(s):
			return nil
		case <-wait.Done():
			return errors.New(indexPending)
		}
	}

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
