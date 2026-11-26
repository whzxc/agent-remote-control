package core

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

var skillSourceCheckout bool

func skillSource(name string) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(exe)
	candidates := []string{filepath.Join(dir, "skills", name), filepath.Join(dir, "../skills", name), filepath.Join(dir, "../Resources/skills", name)}
	if skillSourceCheckout || buildVersion == "0.0.0" {
		_, file, _, _ := runtime.Caller(0)
		if filepath.IsAbs(file) {
			candidates = append(candidates, filepath.Join(filepath.Dir(file), "../../skills", name))
		}
	}
	for _, path := range candidates {
		if skillFile(filepath.Join(path, "SKILL.md")) {
			return path, nil
		}
	}
	return "", errors.New("ARC skill resources not found beside the installed executable")
}

func skillFile(path string) bool {
	stat, err := os.Stat(path)
	return err == nil && stat.Mode().IsRegular()
}

func skillPlaybook(id string) (object, error) {
	var file string
	switch id {
	case "protocol", "choose-goal", "choose-address", "choose-provider", "cloudflare-tunnel", "chatgpt-fallback", "create-ingress":
		file = "protocol"
	case "add-connector", "consent", "verify-connector", "loop-test", "address-secret", "tunnel-credentials", "enable-in-chatgpt", "codex-ready", "permissions", "cloudflare-login", "claude-code-ready":
		file = id
	default:
		return nil, fmt.Errorf("INVALID_ARGUMENT: unknown playbook %s", id)
	}
	source, err := skillSource("arc-setup")
	if err != nil {
		return nil, err
	}
	markdown, err := os.ReadFile(filepath.Join(source, "playbooks", file+".md"))
	if err != nil {
		return nil, err
	}
	return object{"id": id, "markdown": string(markdown)}, nil
}

func copySkill(source, destination string) error {
	if err := os.MkdirAll(destination, 0o777); err != nil {
		return err
	}
	rows, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	for _, entry := range rows {
		from, to := filepath.Join(source, entry.Name()), filepath.Join(destination, entry.Name())
		if entry.IsDir() {
			if err := copySkill(from, to); err != nil {
				return err
			}
			continue
		}
		info, err := os.Stat(from)
		if err != nil {
			return err
		}
		bytes, err := os.ReadFile(from)
		if err != nil {
			return err
		}
		if err := os.WriteFile(to, bytes, info.Mode().Perm()); err != nil {
			return err
		}
		if err := os.Chmod(to, info.Mode().Perm()); err != nil {
			return err
		}
	}
	return nil
}

func installSkills(target string) (object, error) {
	agent := map[string]string{"codex": ".codex", "claude-code": ".claude", "antigravity": ".gemini"}[target]
	if agent == "" {
		return nil, errors.New("INVALID_ARGUMENT: target must be codex, claude-code or antigravity")
	}
	names := []string{"arc-setup", "arc-local-code"}
	paths := make([]string, len(names))
	for i, name := range names {
		var err error
		paths[i], err = skillSource(name)
		if err != nil {
			return nil, err
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, errors.New("home directory unavailable")
	}
	for i, name := range names {
		destination := filepath.Join(home, agent, "skills", name)
		if err := os.RemoveAll(destination); err != nil {
			return nil, err
		}
		if err := copySkill(paths[i], destination); err != nil {
			return nil, err
		}
		paths[i] = destination
	}
	return object{"target": target, "path": paths[0], "paths": paths}, nil
}

func init() {
	registerCLI("setup playbook", func(_ context.Context, args []string, _ object, _ io.Reader) (any, error) {
		return skillPlaybook(args[2])
	})
	registerCLI("skill install", func(_ context.Context, args []string, _ object, _ io.Reader) (any, error) {
		return installSkills(args[3])
	})
}
