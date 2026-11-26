package core

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
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
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, subscriptionError("network-error")
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
