package core

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

type subscriptionRegistration struct {
	id, agent, name, defaultPool string
	acceptsKey                   bool
}

var subscriptionProviders = []subscriptionRegistration{
	{"antigravity", "antigravity", "Antigravity", "gemini", false},
	{"codex", "codex", "Codex", "codex", false},
	{"opencode-go", "opencode", "OpenCode Go", "go", true},
	{"claude-code", "claude", "Claude", "subscription", false},
	{"cursor", "cursor", "Cursor", "cursorModels", false},
	{"grok", "grok", "Grok", "grok", false},
	{"kimi-code", "kimi", "Kimi", "coding", true},
}

type subscriptionCredential struct{ secret, source string }

func newSubscriptionCredential(secret, source string) (subscriptionCredential, *subscriptionFailure) {
	if strings.TrimSpace(secret) == "" {
		return subscriptionCredential{}, subscriptionError("credentials-missing")
	}
	return subscriptionCredential{secret, source}, nil
}

func subscriptionCredentialFile(path string) (any, *subscriptionFailure) {
	data, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return nil, subscriptionError("credentials-missing")
	case err != nil:
		return nil, subscriptionError("credential-access-denied")
	}
	var value any
	if err := canonjson.Unmarshal(data, &value); err != nil {
		return nil, subscriptionError("invalid-response")
	}
	return value, nil
}

func subscriptionCredentialPath(id string) string {
	return filepath.Join(root(), "subscriptions/credentials", id+".json")
}

func getSubscriptionJSON(ctx context.Context, client *http.Client, url, token string, headers http.Header) (any, *subscriptionFailure) {
	return requestSubscriptionJSON(ctx, client, http.MethodGet, url, token, headers, nil)
}

func requestSubscriptionJSON(ctx context.Context, client *http.Client, method, url, token string, headers http.Header, body object) (any, *subscriptionFailure) {
	var input io.Reader
	if body != nil {
		input = bytes.NewReader([]byte(wire(body)))
	}
	request, err := http.NewRequestWithContext(ctx, method, url, input)
	if err != nil {
		return nil, subscriptionError("network-error")
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, values := range headers {
		request.Header[name] = values
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, subscriptionError("network-error")
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case 200:
	case 401:
		return nil, subscriptionError("authentication-failed")
	case 403:
		return nil, subscriptionError("request-forbidden")
	case 429:
		failure := subscriptionError("rate-limited")
		value := response.Header.Get("Retry-After")
		if n, err := strconv.ParseInt(value, 10, 64); err == nil && n <= int64((1<<63-1)/time.Second) {
			s := subscriptionTimestamp(time.Now().Add(time.Duration(max(0, n)) * time.Second))
			failure.RetryAt = &s
		} else if at, err := http.ParseTime(value); err == nil {
			s := subscriptionTimestamp(at)
			failure.RetryAt = &s
		}
		return nil, failure
	default:
		return nil, subscriptionError("network-error")
	}
	const limit = 1024 * 1024
	if response.ContentLength > limit {
		return nil, subscriptionError("invalid-response")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, subscriptionError("network-error")
	}
	var value any
	if len(data) > limit || canonjson.Unmarshal(data, &value) != nil {
		return nil, subscriptionError("invalid-response")
	}
	return value, nil
}

var launchSubscriptionAgent func(context.Context, string, []string) (*exec.Cmd, error)

type subscriptionProcessOutput struct {
	stdout, stderr []byte
	success        bool
}

type quotaOutputBuffer struct {
	data []byte
	full bool
}

func (b *quotaOutputBuffer) Write(data []byte) (int, error) {
	const limit = 1024 * 1024
	room := max(0, limit-len(b.data))
	b.data = append(b.data, data[:min(len(data), room)]...)
	b.full = b.full || len(data) > room
	return len(data), nil
}

func executeSubscriptionProcess(ctx context.Context, cmd *exec.Cmd, owned bool) (subscriptionProcessOutput, *subscriptionFailure) {
	var stdout, stderr quotaOutputBuffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	var err error
	if owned {
		err = startOwnedChild(cmd)
		if err == nil {
			err = cmd.Wait()
		}
	} else {
		err = cmd.Run()
	}
	if ctx.Err() != nil {
		return subscriptionProcessOutput{}, subscriptionError("request-timeout")
	}
	var exit *exec.ExitError
	if err != nil && !errors.As(err, &exit) {
		return subscriptionProcessOutput{}, subscriptionError("request-failed")
	}
	if stdout.full || stderr.full {
		return subscriptionProcessOutput{}, subscriptionError("invalid-response")
	}
	return subscriptionProcessOutput{stdout.data, stderr.data, err == nil}, nil
}

func nativeSubscriptionCLI(ctx context.Context, agent string, args ...string) (subscriptionProcessOutput, *subscriptionFailure) {
	binary := findAccountAgent(agent)
	if binary == "" {
		return subscriptionProcessOutput{}, &subscriptionFailure{Code: "credentials-missing", Message: fmt.Sprintf("Install %s and sign in with its native CLI, then refresh usage.", agent)}
	}
	wait, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	if launchSubscriptionAgent != nil {
		var err error
		cmd, err = launchSubscriptionAgent(wait, binary, args)
		if err != nil {
			return subscriptionProcessOutput{}, subscriptionError("request-failed")
		}
	} else {
		cmd = nativeCommand(wait, binary, args...)
	}
	if applyAccountCommandProxy != nil {
		if err := applyAccountCommandProxy(wait, cmd); err != nil {
			return subscriptionProcessOutput{}, subscriptionError("network-error")
		}
	}
	dir := filepath.Join(os.TempDir(), "arc-quota-"+id())
	if err := os.Mkdir(dir, 0o777); err != nil {
		return subscriptionProcessOutput{}, subscriptionError("request-failed")
	}
	defer os.RemoveAll(dir)
	cmd.Dir = dir
	if agent == "claude" {
		blocked := []string{"CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "NODE_OPTIONS", "BUN_OPTIONS"}
		env := slices.DeleteFunc(cmd.Environ(), func(entry string) bool {
			key, _, _ := strings.Cut(entry, "=")
			return slices.Contains(blocked, key)
		})
		cmd.Env = append(env, "TZ=UTC", "LC_ALL=C", "DISABLE_TELEMETRY=1", "DISABLE_ERROR_REPORTING=1", "DISABLE_AUTOUPDATER=1")
	}
	out, failure := executeSubscriptionProcess(wait, cmd, true)
	if failure != nil && failure.Code == "request-timeout" {
		failure.Code = "network-error"
	}
	return out, failure
}

func providerSubscriptionCredential(ctx context.Context, id string) (subscriptionCredential, *subscriptionFailure) {
	for _, provider := range subscriptionProviders {
		if provider.id != id || !provider.acceptsKey {
			continue
		}
		path := subscriptionCredentialPath(id)
		if _, err := os.Stat(path); err == nil {
			value, failure := subscriptionCredentialFile(path)
			if failure != nil {
				return subscriptionCredential{}, failure
			}
			return newSubscriptionCredential(text(value, "key"), "saved-key")
		}
		break
	}
	switch id {
	case "opencode-go":
		return openCodeSubscriptionCredential()
	case "grok":
		return grokSubscriptionCredential(ctx)
	case "cursor":
		return cursorSubscriptionCredential(ctx)
	case "kimi-code":
		return subscriptionCredential{}, subscriptionError("credentials-missing")
	default:
		return subscriptionCredential{}, subscriptionError("invalid-response")
	}
}

func standaloneSubscriptionAvailable(id string) bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	switch id {
	case "antigravity":
		rows, _ := os.ReadDir(filepath.Join(home, ".gemini"))
		return slices.ContainsFunc(rows, func(row os.DirEntry) bool { return strings.HasPrefix(row.Name(), "antigravity") })
	case "cursor":
		return skillFile(cursorSubscriptionDB(home))
	}
	return false
}

func readRegisteredSubscription(ctx context.Context, id string) (subscriptionReading, string, *subscriptionFailure) {
	switch id {
	case "codex":
		reading, failure := readCodexSubscription(ctx)
		return reading, "codex-account", failure
	case "antigravity":
		reading, failure := readAntigravitySubscription(ctx)
		return reading, "antigravity-daemon", failure
	}
	credential, failure := providerSubscriptionCredential(ctx, id)
	if failure != nil {
		return subscriptionReading{}, "", failure
	}
	client, err := accountHTTPClient(ctx, 15*time.Second)
	if err != nil {
		return subscriptionReading{}, "", subscriptionError("network-error")
	}
	defer client.CloseIdleConnections()
	reader := map[string]func(context.Context, *http.Client, subscriptionCredential) (subscriptionReading, *subscriptionFailure){
		"grok": readGrokSubscription, "opencode-go": readOpenCodeSubscription, "kimi-code": readKimiSubscription, "cursor": readCursorSubscription,
	}[id]
	if reader == nil {
		return subscriptionReading{}, "", subscriptionError("invalid-response")
	}
	reading, failure := reader(ctx, client, credential)
	return reading, credential.source, failure
}
