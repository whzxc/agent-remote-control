//go:build arcfixture

package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"
)

func init() {
	useFixtureAgentTransport = true
	registerIndexPreparation(5, func(ctx context.Context, s *service) error {
		if s.fixtureIngress == nil || os.Getenv("ARC_FIXTURE_INDEX_GATE") != "" || os.Getenv("ARC_FIXTURE_SCRIPT") == "" {
			return nil
		}
		// The fixture's restart helper can write canonical receipts while Core
		// is stopped. Mark them through the same repair path as an interrupted write.
		for _, owner := range []string{coreReceiptStore().base, agentReceiptStore().base} {
			if _, err := indexCurrent(owner); err != nil {
				continue
			}
			entries, err := os.ReadDir(owner)
			if err != nil {
				return err
			}
			for _, entry := range entries {
				if err := ctx.Err(); err != nil {
					return err
				}
				path := filepath.Join(owner, entry.Name())
				if !entry.IsDir() && isReceiptPath(path) {
					if err := indexMark(path); err != nil {
						return err
					}
				}
			}
		}
		return nil
	})
	waitFixtureTaskIndex = func(ctx context.Context, s *service) error {
		if s.fixtureIngress == nil || s.indexStartupDone == nil || os.Getenv("ARC_FIXTURE_INDEX_GATE") != "" {
			return nil
		}
		wait, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		select {
		case <-s.indexStartupDone:
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
	openFixtureDesktopURL = func(url string) error {
		path := os.Getenv("ARC_FIXTURE_OPEN_FILE")
		if !filepath.IsAbs(path) {
			return errors.New("DESKTOP_IPC_ENDPOINT_MISSING")
		}
		return os.WriteFile(path, []byte(url), 0o600)
	}
	fixtureUsesDesktop = func() bool {
		_, enabled := os.LookupEnv("ARC_FIXTURE_DESKTOP")
		return enabled
	}
}
