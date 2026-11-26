package core

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"
)

func cliExecutable() any {
	exe, err := os.Executable()
	if err != nil {
		return nil
	}
	canonical, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return nil
	}
	return canonical
}

func appBundle(exe string) string {
	for {
		if filepath.Ext(exe) == ".app" {
			return exe
		}
		parent := filepath.Dir(exe)
		if parent == exe {
			return ""
		}
		exe = parent
	}
}

func installShim(ctx context.Context) (object, error) {
	if runtime.GOOS != "darwin" {
		return nil, errors.New("NOT_SUPPORTED: install-shim is macOS only")
	}
	app := appBundle(str(cliExecutable()))
	if app == "" {
		return nil, errors.New("INVALID_ARGUMENT: run the CLI bundled in the App")
	}
	target, err := filepath.EvalSymlinks(filepath.Join(app, "Contents/Resources/bin/arc"))
	if err != nil {
		return nil, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, errors.New("home unavailable")
	}
	path := filepath.Join(home, ".local/bin/arc")
	hint := shimPathHint(ctx, filepath.Dir(path))
	if _, err := os.Lstat(path); err == nil {
		if link, err := os.Readlink(path); err == nil && link == target {
			return object{"path": path, "target": target, "created": false, "pathHint": hint}, nil
		}
		return nil, errors.New("SHIM_EXISTS: ~/.local/bin/arc already exists; nothing overwritten")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if err := os.Symlink(target, path); err != nil {
		return nil, err
	}
	if err := save(filepath.Join(root(), "app/cli-shim.json"), object{"path": path, "target": target}); err != nil {
		os.Remove(path)
		return nil, err
	}
	return object{"path": path, "target": target, "created": true, "pathHint": hint}, nil
}

func ownedShim(executable string) (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}
	path := filepath.Join(home, ".local/bin/arc")
	record, err := load(filepath.Join(root(), "app/cli-shim.json"))
	if err != nil || field(record, "path") != path {
		return "", false
	}
	target, err := os.Readlink(path)
	app := appBundle(executable)
	if err != nil || app == "" || target != text(record, "target") || target != app && !strings.HasPrefix(target, app+string(filepath.Separator)) {
		return "", false
	}
	return path, true
}

func shimPathHint(parent context.Context, directory string) object {
	shell, exists := os.LookupEnv("SHELL")
	if !exists {
		shell = "/bin/zsh"
	}
	const baseline = "/usr/bin:/bin:/usr/sbin:/sbin"
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, shell, "-c", `printf '\036%s' "$PATH"`)
	command.Env = append(os.Environ(), "PATH="+baseline)
	data, err := command.Output()
	var inPath, fix any
	message := "Could not inspect non-interactive shell PATH; shell configuration was not changed"
	if index := strings.LastIndexByte(string(data), 0x1e); err == nil && index >= 0 {
		inPath = slices.Contains(filepath.SplitList(string(data[index+1:])), directory)
		if inPath == true {
			message = "Available in non-interactive shell PATH"
		} else {
			message = "Add ~/.local/bin to non-interactive shell startup; shell configuration was not changed"
		}
	}
	if inPath != true && filepath.Base(shell) == "zsh" {
		fix = `printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"' >> "${ZDOTDIR:-$HOME}/.zshenv"`
	}
	return object{"shell": shell, "inPath": inPath, "baselinePath": baseline, "command": fix, "message": message}
}
