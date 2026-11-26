package core

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

func setupClipboardCommand(ctx context.Context, write bool) *exec.Cmd {
	switch operatingSystem {
	case "darwin":
		if write {
			return nativeCommand(ctx, "/usr/bin/pbcopy")
		}
		return nativeCommand(ctx, "/usr/bin/pbpaste")
	case "windows":
		script := "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Get-Clipboard -Raw"
		if write {
			script = "Set-Clipboard -Value ([Console]::In.ReadToEnd())"
		}
		return nativeCommand(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	default:
		if _, wayland := os.LookupEnv("WAYLAND_DISPLAY"); wayland {
			if write {
				return nativeCommand(ctx, "wl-copy")
			}
			return nativeCommand(ctx, "wl-paste", "--no-newline")
		}
		direction := "-out"
		if write {
			direction = "-in"
		}
		return nativeCommand(ctx, "xclip", "-selection", "clipboard", direction)
	}
}

var setupClipboardFixture func(bool) (string, bool, error)

func readSetupClipboard(ctx context.Context) (string, error) {
	if setupClipboardFixture != nil {
		if value, handled, err := setupClipboardFixture(false); handled {
			return value, err
		}
	}
	out, err := setupClipboardCommand(ctx, false).Output()
	var exit *exec.ExitError
	switch {
	case errors.As(err, &exit):
		return "", errors.New("Cannot read clipboard")
	case err != nil:
		return "", errors.New("Clipboard unavailable on this machine")
	case !utf8.Valid(out):
		return "", errors.New("Clipboard must contain text")
	default:
		return string(out), nil
	}
}

func clearSetupClipboard(ctx context.Context) error {
	if setupClipboardFixture != nil {
		if _, handled, err := setupClipboardFixture(true); handled {
			return err
		}
	}
	cmd := setupClipboardCommand(ctx, true)
	cmd.Stdin = strings.NewReader("")
	if err := startOwnedChild(cmd); err != nil {
		return errors.New("Cannot clear clipboard")
	}
	if err := cmd.Wait(); err != nil {
		return errors.New("Cannot clear clipboard")
	}
	return nil
}

type setupSecretRule struct {
	name    string
	pattern *regexp.Regexp
	prefix  string
	length  int
}

// Rust regex's Unicode whitespace class includes these Unicode separators and controls.
const setupSpace = `[\p{Z}\t\n\x0B\f\r\x{0085}]`
const setupToken = `["']?([A-Za-z0-9_./+=:-]+)`

var setupSecretRules = map[string]setupSecretRule{
	"apiKey":                {"OpenAI runtime key", regexp.MustCompile(`(?:OPENAI_API_KEY=|Authorization:` + setupSpace + `*Bearer` + setupSpace + `+)` + setupToken), "sk-", 32},
	"cloudflareToken":       {"Cloudflare Tunnel Token", regexp.MustCompile(`(?:--token(?:=|` + setupSpace + `+)|service` + setupSpace + `+install` + setupSpace + `+)` + setupToken), "eyJ", 64},
	"ngrokAuthtoken":        {"ngrok Authtoken", regexp.MustCompile(`(?:config` + setupSpace + `+add-authtoken` + setupSpace + `+|NGROK_AUTHTOKEN=)` + setupToken), "", 20},
	"pinggyToken":           {"Pinggy Token", regexp.MustCompile(`(?:^|` + setupSpace + `)` + setupToken + `@(?:[a-z0-9.-]+\.)?pinggy\.io`), "", 16},
	"localxposeAccessToken": {"LocalXpose Access Token", regexp.MustCompile(`(?:--token(?:=|` + setupSpace + `+)|LX_ACCESS_TOKEN=)` + setupToken), "", 20},
}
var setupSecretCharacters = regexp.MustCompile(`^[A-Za-z0-9_./+=:-]+$`)

func extractSetupSecret(name, input string) (string, error) {
	candidate := strings.TrimSpace(input)
	rule := setupSecretRules[name]
	var value any
	if err := canonjson.Unmarshal([]byte(candidate), &value); err == nil {
		for _, key := range []string{name, "token", "apiKey", "api_key", "authtoken"} {
			if s, ok := field(value, key).(string); ok {
				candidate = s
				break
			}
		}
	} else if rule.pattern != nil {
		if groups := rule.pattern.FindStringSubmatch(candidate); len(groups) != 0 {
			candidate = groups[1]
		}
	}
	token := strings.Trim(strings.TrimSpace(candidate), "'\"")
	if rule.name != "" && len(token) >= rule.length && len(token) <= 4096 && strings.HasPrefix(token, rule.prefix) && setupSecretCharacters.MatchString(token) {
		return token, nil
	}
	label := rule.name
	if label == "" {
		label = "credential"
	}
	return "", errors.New(strings.ReplaceAll(localized(locale(), "setup.clipboard-invalid"), "{credential}", label))
}
