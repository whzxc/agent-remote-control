package main

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/whzxc/agent-remote-control/internal/core"
)

func launchAgentPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", bundleID+".plist")
}

func launchAgentXML(exe, state string) []byte {
	var data bytes.Buffer
	text := func(value string) { _ = xml.EscapeText(&data, []byte(value)) }
	data.WriteString(`<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>`)
	text(bundleID)
	data.WriteString(`</string><key>ProgramArguments</key><array><string>`)
	text(exe)
	data.WriteString(`</string></array><key>EnvironmentVariables</key><dict><key>ARC_STATE_DIR</key><string>`)
	text(state)
	data.WriteString(`</string></dict><key>RunAtLoad</key><true/></dict></plist>`)
	return data.Bytes()
}

func loginDisabled(ctx context.Context) any {
	if bundleID != productionID {
		return false
	}
	data, err := exec.CommandContext(ctx, "/bin/launchctl", "print-disabled", "gui/"+strconv.Itoa(os.Getuid())).Output()
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.Contains(line, `"`+bundleID+`"`) && strings.Contains(line, "true") {
			return true
		}
	}
	return false
}

func autostartEnabled(ctx context.Context) bool {
	exe, err := os.Executable()
	if err != nil || loginDisabled(ctx) != false {
		return false
	}
	program, err := exec.CommandContext(ctx, "/usr/bin/plutil", "-extract", "ProgramArguments.0", "raw", "-o", "-", launchAgentPath()).Output()
	if err != nil || strings.TrimSpace(string(program)) != exe {
		return false
	}
	state, err := exec.CommandContext(ctx, "/usr/bin/plutil", "-extract", "EnvironmentVariables.ARC_STATE_DIR", "raw", "-o", "-", launchAgentPath()).Output()
	return err == nil && strings.TrimSpace(string(state)) == core.DesktopStateDir()
}

func setAutostart(ctx context.Context, enabled bool) error {
	path := launchAgentPath()
	if !enabled {
		if err := os.Remove(path); !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if err := writePrivate(path, launchAgentXML(exe, core.DesktopStateDir())); err != nil {
		return err
	}
	if bundleID != productionID {
		return nil
	}
	return runCommand(ctx, "/bin/launchctl", "enable", "gui/"+strconv.Itoa(os.Getuid())+"/"+bundleID)
}

func autostartReadiness(ctx context.Context) object {
	_, err := os.Stat(launchAgentPath())
	registered, disabled := err == nil, loginDisabled(ctx)
	state := "missing"
	switch {
	case registered && disabled == nil:
		state = "unknown"
	case registered && disabled == false && autostartEnabled(ctx):
		state = "granted"
	}
	return object{"id": "login-start", "process": "Desktop", "registered": registered, "disabled": disabled, "state": state}
}
