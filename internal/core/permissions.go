package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"
)

const sharedTCCDatabase = "/Library/Application Support/com.apple.TCC/TCC.db"

func fullDiskAccess() string {
	if operatingSystem != "darwin" {
		return "not-applicable"
	}
	paths := []string{sharedTCCDatabase}
	if home, err := os.UserHomeDir(); err == nil {
		paths = slices.Insert(paths, 0, filepath.Join(home, sharedTCCDatabase))
	}
	for _, path := range paths {
		f, err := os.Open(path)
		switch {
		case err == nil:
			_ = f.Close()
			return "granted"
		case errors.Is(err, os.ErrPermission), errors.Is(err, syscall.EPERM):
			return "missing"
		}
	}
	return "unknown"
}

func protectedPath(path string) bool {
	if operatingSystem != "darwin" {
		return false
	}
	path = filepath.Clean(path)
	home, _ := os.UserHomeDir()
	for _, subdir := range []string{"Desktop", "Documents", "Downloads", "Library/Mail", "Library/Messages", "Library/Safari"} {
		parent := filepath.Join(home, subdir)
		if path == parent || belowPath(path, parent) {
			return true
		}
	}
	return path == "/Volumes" || belowPath(path, "/Volumes")
}

func checkProtectedPath(path string) error {
	if protectedPath(path) && fullDiskAccess() != "granted" {
		return errors.New(wire(object{"code": "PERMISSION_REQUIRED", "permissionId": "full-disk-access",
			"message": "Open ARC Permissions & readiness to grant Full Disk Access."}))
	}
	return nil
}

func grantTarget() any {
	executable, err := os.Executable()
	if err != nil {
		return nil
	}
	if canonical, err := filepath.EvalSymlinks(executable); err == nil {
		executable = canonical
	}
	for directory := executable; ; directory = filepath.Dir(directory) {
		if filepath.Ext(directory) == ".app" {
			return directory
		}
		if filepath.Dir(directory) == directory {
			return executable
		}
	}
}

var permissionScreenStatus func(context.Context) (object, error)
var permissionCodexInstalled func() bool
var permissionClaudeStatus func(context.Context) (installed bool, login *bool)
var permissionAccountRead func(context.Context, *service) (object, error)
var permissionCommand func(context.Context, *service, object) (object, error)
var readIngressStatuses func(context.Context, *service) ([]object, error)

func commandDiskAccess(ctx context.Context, s *service) string {
	if operatingSystem != "darwin" {
		return "not-applicable"
	}
	home, err := os.UserHomeDir()
	if err != nil || permissionCommand == nil {
		return "unknown"
	}
	probe, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	value, err := permissionCommand(probe, s, object{
		"command": []string{"/bin/sh", "-c", "if [ -e \"$1\" ]; then exec 3<\"$1\"; else exec 3<\"" + sharedTCCDatabase + "\"; fi", "arc-fda-probe", filepath.Join(home, sharedTCCDatabase)},
		"cwd":     "/", "timeoutMs": 3000})
	if err != nil {
		return "unknown"
	}
	if code, ok := uintValue(value["exitCode"]); ok && code == 0 {
		return "granted"
	}
	for _, denied := range []string{"Operation not permitted", "Permission denied"} {
		if strings.Contains(text(value, "stderr"), denied) {
			return "missing"
		}
	}
	return "unknown"
}

func requireCommandAccess(state string) error {
	switch state {
	case "granted", "not-applicable":
		return nil
	}
	return errors.New(wire(object{"code": "PERMISSION_REQUIRED", "permissionId": "command-full-disk-access",
		"message": "Grant Full Disk Access to ARC App (the bundled Codex execution host). See ARC Permissions & readiness."}))
}

func permissionItems(ctx context.Context, s *service) []object {
	screen := object{"accessibility": "not-applicable", "screen-recording": "not-applicable"}
	if operatingSystem == "darwin" {
		screen = nil
		if permissionScreenStatus != nil {
			screen, _ = permissionScreenStatus(ctx)
		}
	}
	items := []object{}
	for _, id := range []string{"accessibility", "screen-recording"} {
		state, ok := screen[id].(string)
		if !ok {
			state = "unknown"
		}
		items = append(items, object{"id": id, "state": state, "process": "arc-screen"})
	}
	var executable any
	if path, err := os.Executable(); err == nil {
		executable = path
	}
	items = append(items, object{"id": "full-disk-access", "state": fullDiskAccess(), "process": "Core",
		"executable": executable, "grantTarget": grantTarget(), "heuristic": true})
	desktop, _ := desktopForward(ctx, s, "permissions/desktop")
	desktopItems := arr(field(desktop, "items"))
	if desktopItems == nil {
		desktopItems = []any{object{"id": "notifications", "state": "unknown", "process": "Desktop"},
			object{"id": "login-start", "state": "unknown", "process": "Desktop"}}
	}
	for _, raw := range desktopItems {
		item := clone(obj(raw))
		if item == nil {
			continue
		}
		if operatingSystem != "darwin" && item["id"] == "notifications" || operatingSystem == "linux" && item["id"] == "login-start" {
			item["state"] = "not-applicable"
		}
		items = append(items, item)
	}
	codex := "missing"
	if permissionCodexInstalled != nil && permissionCodexInstalled() {
		codex = "granted"
	}
	items = append(items, object{"id": "codex-desktop", "state": codex, "process": "Core",
		"detail": "installation; login is reported separately by existing account diagnostics"})
	claude, installed := "missing", false
	if permissionClaudeStatus != nil {
		status, cancel := context.WithTimeout(ctx, 5*time.Second)
		found, login := permissionClaudeStatus(status)
		cancel()
		installed = found
		switch {
		case login == nil:
			claude = "unknown"
		case *login:
			claude = "granted"
		}
	}
	return append(items, object{"id": "claude-code", "state": claude, "installed": installed, "process": "Claude CLI"})
}

func permissions(ctx context.Context, s *service, passive bool) (any, error) {
	items := permissionItems(ctx, s)
	if passive {
		for _, id := range []string{"codex-login", "command-full-disk-access"} {
			items = append(items, object{"id": id, "process": "Codex app-server", "state": "unknown", "reason": "not probed by passive diagnostics"})
		}
		return object{"observedAt": now(), "items": items}, nil
	}
	probe, cancel := context.WithTimeout(ctx, 5*time.Second)
	account, err := permissionAccountRead(probe, s)
	cancel()
	login := "unknown"
	if err == nil {
		login = "missing"
		if account["account"] != nil {
			login = "granted"
		}
	}
	items = append(items,
		object{"id": "command-full-disk-access", "process": "Codex app-server", "state": commandDiskAccess(ctx, s), "heuristic": true, "grantTarget": grantTarget()},
		object{"id": "codex-login", "process": "Codex app-server", "state": login})
	ingresses, err := readIngressStatuses(ctx, s)
	if err != nil {
		return nil, err
	}
	for _, ingress := range ingresses {
		state := "missing"
		if _, ok := field(ingress["verification"], "challengeVerifiedAt").(string); ok {
			state = "granted"
		}
		items = append(items, object{"id": "ingress:" + text(ingress, "id"), "process": "Core", "state": state, "diagnostics": ingressDiagnostics(ingress)})
	}
	return object{"observedAt": now(), "items": items}, nil
}

func init() {
	for _, route := range []string{"permissions", "permissions/passive"} {
		registerRoute("GET", route, func(ctx context.Context, s *service, _ object, _ []string) (any, error) {
			return permissions(ctx, s, route == "permissions/passive")
		})
	}
}
