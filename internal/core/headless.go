package core

import (
	"context"
	"errors"
	"fmt"
	"github.com/whzxc/agent-remote-control/internal/platform"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
)

func frontDoorStatus(installed string) any {
	info, _ := load(filepath.Join(root(), "app/front-door.json"))
	var update object
	if operatingSystem == "darwin" {
		if value, err := load(filepath.Join(root(), "app/front-door-update.json")); err == nil {
			update = obj(value)
		}
		if update == nil {
			update = object{"state": "idle", "targetBuild": installed, "lastOutcome": nil, "rollback": false}
		}
		if target, ok := update["targetBuild"].(string); ok {
			installed = target
		}
	}
	if update == nil && info == nil {
		return nil
	}
	var matches any
	if build, ok := field(info, "build").(string); ok {
		matches = build == installed
	}
	result := object{"pid": field(info, "pid"), "protocol": field(info, "protocol"), "build": field(info, "build"), "installedBuild": installed, "matchesInstalledBuild": matches}
	if update != nil {
		update["currentBuild"] = result["build"]
		result["update"] = update
	}
	return result
}

func headlessStatus(ctx context.Context) (object, error) {
	build, err := processBuildID()
	if err != nil {
		return nil, err
	}
	status := object{"running": false, "stateDirectory": root(), "frontDoor": frontDoorStatus(build)}
	info, health, err := discoverLocal(ctx)
	if err != nil {
		return status, nil
	}
	if health["owner"] != "core" || health["version"] != buildVersion || health["build"] != build {
		return nil, errors.New("CORE_BUILD_MISMATCH: Close other local entry points. Reload Desktop and CLI from the same build.")
	}
	status["running"] = true
	for _, field := range []string{"pid", "daemon", "version"} {
		status[field] = info[field]
	}
	return status, nil
}

func startHeadless(ctx context.Context) (object, error) {
	status, err := headlessStatus(ctx)
	if err != nil {
		return nil, err
	}
	if status["running"] == true {
		if status["daemon"] != true {
			return nil, errors.New("CORE_NOT_DAEMON: a leased Core is already running; close its clients and run arc stop before start.")
		}
		return status, nil
	}
	if err := platform.PrivateDir(root()); err != nil {
		return nil, err
	}
	replacement, err := prepareFrontDoorInstall(ctx)
	if err != nil {
		return nil, err
	}
	defer replacement.Close()
	binary, err := runtimeBinary()
	if err != nil {
		return nil, err
	}
	log, err := os.OpenFile(filepath.Join(root(), "core.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	defer log.Close()
	cmd := exec.Command(binary, "daemon")
	cmd.Stderr = log
	platform.Detach(cmd)
	_ = replacement.Close()
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("Core start failed: %w", err)
	}
	finished := make(chan error, 1)
	go func() { finished <- cmd.Wait() }()
	wait, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		status, err := headlessStatus(wait)
		if err != nil || status["running"] == true {
			if err == nil && status["daemon"] != true {
				err = errors.New("CORE_NOT_DAEMON: another local entrypoint started a leased Core.")
			}
			return status, err
		}
		select {
		case err := <-finished:
			return nil, fmt.Errorf("Core exited (%v); inspect %s", err, filepath.Join(root(), "core.log"))
		case <-wait.Done():
			_ = cmd.Process.Kill()
			<-finished
			return nil, fmt.Errorf("Core startup timed out; inspect %s", filepath.Join(root(), "core.log"))
		case <-ticker.C:
		}
	}
}

func stopHeadless(ctx context.Context) (object, error) {
	status, err := headlessStatus(ctx)
	if err != nil || status["running"] != true {
		return status, err
	}
	binary, err := runtimeBinary()
	if err != nil {
		return nil, err
	}
	client, err := connectRuntimeClient(ctx, binary, "cli")
	if err != nil {
		return nil, err
	}
	err = client.shutdown(ctx)
	client.close(context.WithoutCancel(ctx))
	if err != nil {
		return nil, err
	}
	return headlessStatus(ctx)
}

func installSystemd() (object, error) {
	if operatingSystem != "linux" {
		return nil, errors.New("SYSTEMD_UNSUPPORTED: systemd --user is available on Linux only.")
	}
	quote := func(value string, exec bool) (string, error) {
		if strings.ContainsFunc(value, unicode.IsControl) {
			return "", errors.New("Invalid control character in systemd path/environment")
		}
		value = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "%", "%%").Replace(value)
		if exec {
			value = strings.ReplaceAll(value, "$", "$$")
		}
		return `"` + value + `"`, nil
	}
	config, err := os.UserConfigDir()
	if err != nil {
		return nil, errors.New("XDG config directory unavailable")
	}
	binary, err := os.Executable()
	if err != nil {
		return nil, err
	}
	command, err := quote(binary, true)
	if err != nil {
		return nil, err
	}
	state, err := quote("ARC_STATE_DIR="+root(), false)
	if err != nil {
		return nil, err
	}
	unit := fmt.Sprintf("[Unit]\nDescription=Agent Remote Control (headless)\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=%s daemon\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nKillMode=process\nUMask=0077\nEnvironment=%s\n", command, state)
	for _, key := range []string{"PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CODEX_HOME", "NVM_DIR", "BUN_INSTALL", "VOLTA_HOME"} {
		if value, exists := os.LookupEnv(key); exists {
			if key == "PATH" {
				seen := map[string]bool{}
				var unique []string
				for entry := range strings.SplitSeq(value, ":") {
					if !seen[entry] {
						unique = append(unique, entry)
						seen[entry] = true
					}
				}
				value = strings.Join(unique, ":")
			}
			option, err := quote(key+"="+value, false)
			if err != nil {
				return nil, err
			}
			unit += "Environment=" + option + "\n"
		}
	}
	env := filepath.Join(config, "agent-remote-control/environment")
	if !filepath.IsAbs(env) || !systemdEnvironmentPath.MatchString(env) {
		return nil, errors.New("Invalid EnvironmentFile path: set XDG_CONFIG_HOME to an absolute path using only ASCII letters, digits, / . _ - @ + (no spaces or special characters).")
	}
	unit += "EnvironmentFile=-" + env + "\n\n[Install]\nWantedBy=default.target\n"
	path := filepath.Join(config, "systemd/user/agent-remote-control.service")
	if err := saveBytes(path, []byte(unit)); err != nil {
		return nil, err
	}
	return object{"unit": path, "environmentFile": env, "next": "systemctl --user daemon-reload && systemctl --user enable --now agent-remote-control.service", "linger": "loginctl enable-linger USER"}, nil
}

var systemdEnvironmentPath = regexp.MustCompile(`^[A-Za-z0-9/._@+\-]+$`)
