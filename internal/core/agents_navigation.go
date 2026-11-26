package core

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

func nativeAgentNavigation(agent, task string) any {
	if agent == "codex" && uuid.Validate(task) == nil && operatingSystem != "linux" && desktopCodexBinary() != "" {
		return object{"taskId": task}
	}
	return nil
}

func openNativeAgentTask(ctx context.Context, s *service, body object) (any, error) {
	agent, task := text(body, "agent"), text(body, "taskId")
	if _, exists := nativeAgentDriverByID(agent); !exists {
		return nil, errors.New("UNKNOWN_AGENT")
	}
	if agent != "codex" || uuid.Validate(task) != nil {
		return nil, errors.New("AGENT_TASK_OPEN_UNSUPPORTED_OR_INVALID_ID")
	}
	url := "codex://threads/" + task
	if fixtureUsesDesktop == nil && reopenNativeDesktopTask != nil {
		status, err := desktopHandbackObservation(task)
		if err != nil {
			return nil, err
		}
		if reopened, err := reopenNativeDesktopTask(ctx, s, task, status); err != nil {
			return nil, err
		} else if reopened {
			return object{"state": "opened", "url": url}, nil
		}
	}
	if err := openNativeDesktopURL(ctx, url); err != nil {
		return nil, err
	}
	return object{"state": "opened", "url": url}, nil
}

func nativeLocalAgentLauncher(ctx context.Context, binary, suffix string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return errors.New("HOME_NOT_FOUND")
	}
	if operatingSystem == "windows" {
		return openWindowsNativeAgentLauncher(home, binary, suffix)
	}
	dir := filepath.Join(root(), "agents", "launchers")
	if err := platform.PrivateDir(dir); err != nil {
		return err
	}
	script := filepath.Join(dir, id()+".command")
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }
	content := "#!/bin/zsh -l\n/bin/rm -f -- " + quote(script) + "\ncd -- " + quote(home) + " || exit 1\n" + quote(binary) + suffix + "\n"
	if err := os.WriteFile(script, []byte(content), 0700); err != nil {
		return err
	}
	_, err = commandOutput(ctx, "/usr/bin/open", script)
	if err != nil {
		_ = os.Remove(script)
	}
	return err
}

func openNativeClaudeLogin(ctx context.Context) (any, error) {
	if operatingSystem == "linux" {
		return object{"command": "claude auth login"}, nil
	}
	binary := discoverAgentExecutable("claude")
	if binary == "" {
		return nil, errors.New("AGENT_NOT_INSTALLED")
	}
	if err := nativeLocalAgentLauncher(ctx, binary, " auth login"); err != nil {
		return nil, err
	}
	return object{"opened": true, "target": "terminal"}, nil
}

func init() {
	setupCodexNavigation = func(task string) any { return nativeAgentNavigation("codex", task) }
	setupReadNotification = func(thread, turn string) (any, error) {
		return readNotification(context.Background(), thread, turn, "")
	}
	setupOpenClaudeLogin = func(ctx context.Context, _ *service) error {
		_, err := openNativeClaudeLogin(ctx)
		return err
	}
	registerRoute(http.MethodPost, "tasks/open", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		return openNativeAgentTask(ctx, s, body)
	})
	registerRoute(http.MethodPost, "agents/open", func(ctx context.Context, _ *service, body object, _ []string) (any, error) {
		return openNativeAgentInteractive(ctx, text(body, "agent"))
	})
	registerOperation("task_open", func(ctx context.Context, request operationRequest) (any, error) {
		return openNativeAgentTask(ctx, request.service, object{"agent": request.args["agent"], "taskId": request.args["id"]})
	}, nil)
}

func openNativeAgentInteractive(ctx context.Context, agent string) (any, error) {
	if operatingSystem == "linux" {
		return nil, errors.New("TERMINAL_UNSUPPORTED: headless Linux cannot open a terminal or Codex Desktop; run the Agent CLI in your own terminal.")
	}
	if agent == "codex" {
		if err := openNativeDesktopURL(ctx, ""); err != nil {
			return nil, err
		}
		return object{"opened": true, "target": "desktop"}, nil
	}
	var binary string
	if agent == "claude" {
		binary = discoverAgentExecutable("claude")
	} else if driver, exists := nativeAgentDriverByID(agent); exists {
		binary = driver.discover(ctx).binary
	} else {
		return nil, errors.New("UNKNOWN_AGENT")
	}
	if binary == "" {
		return nil, errors.New("AGENT_NOT_INSTALLED")
	}
	if err := nativeLocalAgentLauncher(ctx, binary, ""); err != nil {
		return nil, err
	}
	return object{"opened": true, "target": "terminal"}, nil
}
