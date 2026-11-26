package core

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

var uninstallStopCodexHosts func(context.Context) error
var uninstallStopTaskHosts func(context.Context) error

func uninstallExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func uninstallConfigDir(home string) string {
	switch operatingSystem {
	case "windows":
		return os.Getenv("APPDATA")
	case "darwin":
		return filepath.Join(home, "Library/Application Support")
	default:
		if dir := os.Getenv("XDG_CONFIG_HOME"); filepath.IsAbs(dir) {
			return dir
		}
		return filepath.Join(home, ".config")
	}
}

func uninstallDataDir(home string) string {
	if operatingSystem == "windows" {
		return os.Getenv("APPDATA")
	}
	if dir := os.Getenv("XDG_DATA_HOME"); filepath.IsAbs(dir) {
		return dir
	}
	return filepath.Join(home, ".local/share")
}

func uninstallAppPath(executable string) string {
	for parent := filepath.Dir(executable); parent != "." && parent != filepath.Dir(parent); parent = filepath.Dir(parent) {
		switch operatingSystem {
		case "darwin":
			if filepath.Ext(parent) == ".app" {
				return parent
			}
		case "windows":
			if skillFile(filepath.Join(parent, "agent-remote-control-desktop.exe")) && skillFile(filepath.Join(parent, "uninstall.exe")) {
				return parent
			}
		}
	}
	return ""
}

func stopUninstallAutostart(ctx context.Context, home string) (string, error) {
	switch operatingSystem {
	case "darwin":
		plist := filepath.Join(home, "Library/LaunchAgents/com.whzxc.agent-remote-control.plist")
		if !uninstallExists(plist) {
			return "", nil
		}
		state, err := commandOutput(ctx, "/usr/bin/plutil", "-extract", "EnvironmentVariables.ARC_STATE_DIR", "raw", "-o", "-", plist)
		if err != nil {
			return "", err
		}
		if filepath.Clean(strings.TrimSpace(state)) != filepath.Clean(root()) {
			return "", nil
		}
		uid, err := commandOutput(ctx, "/usr/bin/id", "-u")
		if err != nil {
			return "", err
		}
		label := "gui/" + strings.TrimSpace(uid) + "/com.whzxc.agent-remote-control"
		if _, err := commandOutput(ctx, "/bin/launchctl", "print", label); err == nil {
			if _, err := commandOutput(ctx, "/bin/launchctl", "bootout", label); err != nil {
				return "", err
			}
		}
		return plist, nil
	case "linux":
		unit := filepath.Join(uninstallConfigDir(home), "systemd/user/agent-remote-control.service")
		if !uninstallExists(unit) {
			return "", nil
		}
		_, err := commandOutput(ctx, "systemctl", "--user", "disable", "--now", "agent-remote-control.service")
		return unit, err
	case "windows":
		const removeRun = `$ErrorActionPreference = 'Stop'; $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'; if (Get-ItemProperty -LiteralPath $key -Name 'Agent Remote Control' -ErrorAction SilentlyContinue) { Remove-ItemProperty -LiteralPath $key -Name 'Agent Remote Control' }; exit 0`
		_, err := commandOutput(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", removeRun)
		return "", err
	default:
		return "", nil
	}
}

func quitDesktopForUninstall(ctx context.Context) error {
	desktop, err := forwardRequest(ctx, "app", "GET", object{})
	if err != nil {
		return nil
	}
	if _, err := forwardRequest(ctx, "app/quit", "POST", object{}); err != nil {
		return err
	}
	pid, ok := uintValue(field(desktop, "pid"))
	if !ok || pid == 0 || pid > 1<<31-1 {
		return errors.New("Desktop PID unavailable")
	}
	start := platform.ProcessStart(int(pid))
	wait, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	for start != "" && platform.ProcessStart(int(pid)) == start {
		select {
		case <-wait.Done():
			return errors.New("ARC did not quit; uninstall stopped")
		case <-tick.C:
		}
	}
	return nil
}

func removeStoppedFrontDoor(ctx context.Context) (*os.File, error) {
	if operatingSystem != "darwin" {
		return nil, stopFrontDoor(ctx)
	}
	guard, err := frontDoorLock("front-door-install.lock", false)
	if err != nil {
		return nil, err
	}
	if guard == nil {
		return nil, errors.New("CORE_UNAVAILABLE: Installation holds the replacement path.")
	}
	cleanup := func() error {
		if err := stopFrontDoor(ctx); err != nil {
			return err
		}
		if err := recoverOwnedChildren(ctx, "front-door-children"); err != nil {
			return err
		}
		for _, dir := range []string{filepath.Dir(frontDoorImages()), filepath.Dir(ipcEndpoint("front-door"))} {
			if err := os.RemoveAll(dir); err != nil {
				return err
			}
		}
		for _, file := range []string{frontDoorInfoPath(), filepath.Join(root(), "app/front-door-update.json")} {
			if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
		return nil
	}
	if err := cleanup(); err != nil {
		_ = guard.Close()
		return nil, err
	}
	return guard, nil
}

func uninstallOwnedLegacyTunnel(home string) (string, bool) {
	path := filepath.Join(home, ".local/bin/tunnel-client")
	recorded, _ := load(filepath.Join(root(), "dependencies/legacy-tunnel.json"))
	if text(recorded, "path") == path {
		return path, true
	}
	index, _ := load(filepath.Join(root(), "ingresses/index.json"))
	for _, raw := range arr(index) {
		id := str(raw)
		if !ingressIdentifier.MatchString(id) {
			continue
		}
		entry, _ := load(filepath.Join(root(), "ingresses", id, "config.json"))
		if text(field(entry, "config"), "tunnelBinary") == path {
			return path, true
		}
	}
	return "", false
}

func distinctUninstallPaths(paths []string) []string {
	paths = slices.DeleteFunc(paths, func(p string) bool { return !uninstallExists(p) })
	slices.Sort(paths)
	paths = slices.Compact(paths)
	parents := slices.Clone(paths)
	return slices.DeleteFunc(paths, func(p string) bool {
		return slices.ContainsFunc(parents, func(parent string) bool {
			if parent == p {
				return false
			}
			child, err := filepath.Rel(parent, p)
			return err == nil && child != "." && child != ".." && !strings.HasPrefix(child, ".."+string(os.PathSeparator)) && !filepath.IsAbs(child)
		})
	})
}

func runUninstall(ctx context.Context, purge bool) (object, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, errors.New("Home directory unavailable")
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return nil, err
	}
	paths := []string{}
	if shim, owned := ownedShim(executable); owned {
		paths = append(paths, shim)
	}
	if legacy, owned := uninstallOwnedLegacyTunnel(home); owned {
		paths = append(paths, legacy)
	}
	for _, agent := range []string{".codex", ".claude"} {
		paths = append(paths, filepath.Join(home, agent, "skills/arc-setup"))
	}
	// Keep state and the installed artifacts intact until each process owner confirms shutdown.
	autostart, err := stopUninstallAutostart(ctx, home)
	if err != nil {
		return nil, err
	}
	if autostart != "" {
		paths = append(paths, autostart)
	}
	if err := quitDesktopForUninstall(ctx); err != nil {
		return nil, err
	}
	if err := stopCoreForUninstall(ctx); err != nil {
		return nil, err
	}
	guard, err := removeStoppedFrontDoor(ctx)
	if err != nil {
		return nil, err
	}
	if guard != nil {
		defer guard.Close()
	}
	for _, stop := range []func(context.Context) error{uninstallStopCodexHosts, uninstallStopTaskHosts} {
		if stop != nil {
			if err := stop(ctx); err != nil {
				return nil, err
			}
		}
	}

	app := uninstallAppPath(executable)
	warnings := []any{}
	switch operatingSystem {
	case "darwin":
		if app != "" {
			bundle, err := packagePlist(ctx, app, "CFBundleIdentifier")
			if err != nil {
				return nil, err
			}
			for _, id := range []string{bundle, bundle + ".core", bundle + ".screen"} {
				if _, err := commandOutput(ctx, "/usr/bin/tccutil", "reset", "All", id); err != nil {
					warnings = append(warnings, object{"action": "tccutil reset All", "bundleId": id, "error": err.Error()})
				}
				for _, dir := range []string{"WebKit", "Caches", "Application Support", "HTTPStorages"} {
					paths = append(paths, filepath.Join(home, "Library", dir, id))
				}
				paths = append(paths, filepath.Join(home, "Library/Preferences", id+".plist"), filepath.Join(home, "Library/Saved Application State", id+".savedState"))
			}
		}
	case "windows":
		for _, dir := range []string{uninstallDataDir(home), os.Getenv("LOCALAPPDATA")} {
			if dir != "" {
				paths = append(paths, filepath.Join(dir, packageIdentifier))
			}
		}
		if app != "" {
			if data := uninstallDataDir(home); data != "" {
				paths = append(paths, filepath.Join(data, "Microsoft/Windows/Start Menu/Programs/Agent Remote Control.lnk"))
			}
			paths = append(paths, filepath.Join(home, "Desktop/Agent Remote Control.lnk"))
		}
	case "linux":
		cache := os.Getenv("XDG_CACHE_HOME")
		if !filepath.IsAbs(cache) {
			cache = filepath.Join(home, ".cache")
		}
		paths = append(paths, filepath.Join(cache, "agent-remote-control"), filepath.Join(uninstallConfigDir(home), "agent-remote-control"))
	}
	paths = append(paths, root())
	if app != "" {
		paths = append(paths, app)
	} else {
		paths = append(paths, filepath.Join(filepath.Dir(executable), "skills/arc-setup"), executable)
	}
	paths = distinctUninstallPaths(paths)
	if operatingSystem == "windows" {
		return scheduleWindowsUninstall(app, paths, purge, warnings)
	}
	removed, failures := []string{}, []object{}
	for _, path := range paths {
		var err error
		if purge {
			var info os.FileInfo
			info, err = os.Lstat(path)
			if err == nil {
				if info.IsDir() {
					err = os.RemoveAll(path)
				} else {
					err = os.Remove(path)
				}
			}
		} else {
			err = trashUninstallPath(ctx, home, path)
		}
		if err == nil {
			removed = append(removed, path)
		} else {
			failures = append(failures, object{"path": path, "error": err.Error()})
		}
	}
	if operatingSystem == "linux" && slices.ContainsFunc(removed, func(path string) bool { return filepath.Base(path) == "agent-remote-control.service" }) {
		if _, err := commandOutput(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
			warnings = append(warnings, object{"action": "systemctl --user daemon-reload", "error": err.Error()})
		}
	}
	state := "completed"
	if len(failures) > 0 || len(warnings) > 0 {
		state = "incomplete"
	}
	return object{"state": state, "purge": purge, "removed": removed, "errors": failures, "warnings": warnings}, nil
}

func trashUninstallPath(ctx context.Context, home, path string) error {
	if operatingSystem == "darwin" {
		if !utf8.ValidString(path) {
			return errors.New("Invalid uninstall path")
		}
		const script = `
ObjC.import('Foundation');
function run(argv) {
    var error = Ref();
    var ok = $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(
        $.NSURL.fileURLWithPath(argv[0]), null, error);
    if (!ok) throw Error(ObjC.unwrap(error[0].localizedDescription));
}
`
		_, err := commandOutput(ctx, "/usr/bin/osascript", "-l", "JavaScript", "-e", script, path)
		return err
	}
	base := filepath.Join(uninstallDataDir(home), "Trash")
	files, info := filepath.Join(base, "files"), filepath.Join(base, "info")
	for _, dir := range []string{files, info} {
		if err := platform.PrivateDir(dir); err != nil {
			return err
		}
	}
	name := filepath.Base(path) + "-" + id()
	infoFile := filepath.Join(info, name+".trashinfo")
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	encoded := url.URL{Scheme: "file", Path: absolute}
	content := fmt.Sprintf("[Trash Info]\nPath=%s\nDeletionDate=%s\n", encoded.EscapedPath(), time.Now().Format("2006-01-02T15:04:05"))
	if err := os.WriteFile(infoFile, []byte(content), 0o666); err != nil {
		return err
	}
	if err := os.Rename(path, filepath.Join(files, name)); err != nil {
		_ = os.Remove(infoFile)
		return fmt.Errorf("Could not move to Trash (source retained): %w", err)
	}
	return nil
}

var scheduleWindowsUninstall func(string, []string, bool, []any) (object, error)

func init() {
	registerCLI("uninstall", func(ctx context.Context, args []string, _ object, _ io.Reader) (any, error) {
		return runUninstall(ctx, len(args) == 2 && args[1] == "--purge")
	})
}
