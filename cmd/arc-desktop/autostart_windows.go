package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"unicode/utf16"

	"github.com/whzxc/agent-remote-control/internal/core"
	"golang.org/x/sys/windows/registry"
)

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`

func autostartCommand(exe string) string {
	quote := func(path string) string {
		trailing := len(path) - len(strings.TrimRight(path, `\`))
		return `"` + path + strings.Repeat(`\`, trailing) + `"`
	}
	return quote(exe) + " --state-dir " + quote(core.DesktopStateDir())
}

func autostartEnabled(context.Context) bool {
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	key, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	value, _, err := key.GetStringValue(appName)
	return err == nil && value == autostartCommand(exe)
}

func setAutostart(_ context.Context, enabled bool) error {
	if bundleID != productionID {
		return errors.New("Login startup is unsupported")
	}
	if enabled {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		command := autostartCommand(exe)
		if len(utf16.Encode([]rune(command))) > 260 {
			return errors.New("The login startup command exceeds the Windows limit of 260 characters")
		}
		key, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
		if err != nil {
			return err
		}
		defer key.Close()
		return key.SetStringValue(appName, command)
	}
	key, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err == nil {
		defer key.Close()
		err = key.DeleteValue(appName)
	}
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	return err
}

func autostartReadiness(ctx context.Context) object {
	state := "missing"
	if autostartEnabled(ctx) {
		state = "granted"
	}
	return object{"id": "login-start", "process": "Desktop", "state": state}
}
