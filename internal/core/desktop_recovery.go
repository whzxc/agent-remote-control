package core

import (
	"context"
	"errors"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

var openFixtureDesktopURL func(string) error
var nativeWindowsCodexOpen func(string) error

func openNativeDesktopURL(ctx context.Context, url string) error {
	if fixtureUsesDesktop != nil {
		if openFixtureDesktopURL != nil {
			return openFixtureDesktopURL(url)
		}
		return errors.New("DESKTOP_IPC_ENDPOINT_MISSING")
	}
	if operatingSystem == "windows" && nativeWindowsCodexOpen != nil {
		return nativeWindowsCodexOpen(url)
	}
	if operatingSystem != "darwin" {
		return errors.New("DESKTOP_UNSUPPORTED: this operation requires Codex Desktop.")
	}
	binary := desktopCodexBinary()
	if binary == "" {
		return errors.New("Install Codex Desktop and ensure its bundled Codex CLI is available")
	}
	app := binary
	for !strings.HasSuffix(app, ".app") || filepath.Base(app) == "CodexCLI.app" {
		parent := filepath.Dir(app)
		if parent == app {
			return errors.New("Install Codex Desktop and ensure its bundled Codex CLI is available")
		}
		app = parent
	}
	args := []string{"-a", app}
	if url != "" {
		args = append(args, url)
	}
	return exec.CommandContext(ctx, "/usr/bin/open", args...).Run()
}

func revealNativeDesktopThread(ctx context.Context, d *nativeDesktopIPC, thread string) error {
	if err := openNativeDesktopURL(ctx, "codex://threads/"+thread); err != nil {
		return err
	}
	wait, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	for {
		owner, err := d.owner(wait, thread)
		if err == nil {
			return d.follow(wait, thread, owner)
		}
		if !desktopDiscoveryPending(err) || wait.Err() != nil {
			return err
		}
		select {
		case <-time.After(250 * time.Millisecond):
		case <-wait.Done():
			return wait.Err()
		}
	}
}

func prepareDesktopCodexCreate(ctx context.Context, s *service, row object, settings object) {
	row["submissionStage"] = "desktop-preparing"
	if prepareNativeDesktopBackend != nil {
		recovery, err := prepareNativeDesktopBackend(ctx, s, row, settings)
		if err != nil {
			row["failureStage"], row["state"] = "desktop-preparing", "not-executed"
			row["desktopRecovery"] = object{"state": "failed"}
			row["result"] = object{"error": controlFailure(err)}
			return
		}
		if recovery != nil {
			row["desktopRecovery"] = recovery
			if recovery["state"] == "waiting-for-local" {
				row["state"] = "awaiting-approval"
			}
			return
		}
	}
	if _, err := s.nativeDesktop(ctx); err == nil {
		row["desktopRecovery"] = object{"state": "ready", "transport": "ipc"}
	} else if desktopMissingEndpoint(err) || strings.Contains(strings.ToLower(err.Error()), "connection refused") {
		row["state"] = "awaiting-approval"
		row["desktopRecovery"] = object{"state": "waiting-for-local", "decisionId": id(), "reason": controlFailure(err)["code"], "target": nil}
	} else {
		row["failureStage"], row["state"] = "desktop-preparing", "not-executed"
		row["desktopRecovery"] = object{"state": "failed"}
		row["result"] = object{"error": controlFailure(err)}
	}
}

func prepareNativeCodexSend(ctx context.Context, s *service, thread string) (string, error) {
	if operatingSystem == "linux" || fixtureUsesDesktop != nil && !fixtureUsesDesktop() {
		return "connector", nil
	}
	if previous, err := returnedDesktopInstance(thread); err != nil {
		return "", err
	} else if previous != nil {
		return prepareReturnedDesktopThread(ctx, s, thread, previous)
	}
	if binding, err := codexExecutionRecord(thread); err != nil {
		return "", err
	} else if binding["transport"] == "local-daemon" {
		if _, err := s.desktopBackendRPC(ctx, text(binding, "backend")); err != nil {
			return "", err
		}
		return "desktop", nil
	}
	if codexBackground(thread) {
		_, home, err := codexInputs()
		if err != nil {
			return "", err
		}
		if s.nativeWriterOwnership(ctx, home, thread)["owner"] != "desktop" {
			return "connector", nil
		}
	}
	d, err := s.nativeDesktop(ctx)
	if err == nil {
		_, err = d.owner(ctx, thread)
		if err == nil {
			return "desktop", nil
		}
	}
	if !desktopMissingEndpoint(err) && !desktopDiscoveryPending(err) && !strings.Contains(strings.ToLower(err.Error()), "connection refused") {
		return "", err
	}
	_, home, inputErr := codexInputs()
	if inputErr != nil {
		return "", inputErr
	}
	if probeWriter(home, thread)["state"] != "unheld" {
		return "", writerFailure(ctx, s, home, thread, nil)
	}
	rpc, err := s.codexUtility(ctx)
	if err != nil {
		return "", err
	}
	value, err := rpc.call(ctx, "thread/resume", object{"threadId": thread, "excludeTurns": true}, time.Minute)
	if err != nil {
		if nativeWriterRejected(err) {
			return "", writerFailure(ctx, s, home, thread, err)
		}
		return "", err
	}
	if reported := text(field(value, "thread"), "id"); reported != "" && reported != thread {
		return "", errors.New("native-thread-id-mismatch")
	}
	if uuid.Validate(thread) == nil {
		if err := save(filepath.Join(root(), "execution", thread+".json"), object{"owner": "connector", "reason": "desktop-load-no-owner"}); err != nil {
			return "", err
		}
	}
	return "connector", nil
}

func init() {
	registerRoute(http.MethodPost, "tasks/decision", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		origin := object{"authType": "local", "ingressId": "local", "sourceId": "local"}
		return decideCodexReceipt(withOrigin(ctx, origin), operationRequest{name: "receipt", source: requestSource{local: true}, service: s, args: body}, true)
	})
}
