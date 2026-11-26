package core

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

var claudeSessionFixtureEndpoint func() string

func accountHTTPClient(ctx context.Context, timeout time.Duration) (*http.Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if downstreamMCPProxy != nil {
		proxy, err := downstreamMCPProxy(ctx)
		if err != nil {
			return nil, err
		}
		transport.Proxy = proxy
	}
	return &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, nil
}

func claudeVisibilityCandidates(ctx context.Context, target string) ([]object, error) {
	profiles, err := claudeAccountProfiles()
	if err != nil {
		return nil, err
	}
	var probes sync.WaitGroup
	for _, profile := range profiles {
		probes.Go(func() {
			wait, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			visibility := "unknown"
			if visible, err := claudeSessionVisible(wait, text(profile, "accountId"), target); err == nil {
				if visible {
					visibility = "visible"
				} else {
					visibility = "not-visible"
				}
			}
			profile["visibility"] = visibility
		})
	}
	probes.Wait()
	return profiles, nil
}

func claudeSessionVisible(ctx context.Context, id, target string) (bool, error) {
	if _, err := claudeAccountIdentity(ctx, id); err != nil {
		return false, err
	}
	config, err := claudeProfileConfig(id)
	if err != nil {
		return false, err
	}
	credentials, err := readClaudeCredentials(ctx, config, config)
	if err != nil {
		return false, err
	}
	token, ok := field(credentials["claudeAiOauth"], "accessToken").(string)
	if !ok {
		return false, errors.New("CLAUDE_CREDENTIAL_UNAVAILABLE")
	}
	client, err := accountHTTPClient(ctx, 10*time.Second)
	if err != nil {
		return false, err
	}
	defer client.CloseIdleConnections()
	endpoint := "https://api.anthropic.com"
	if claudeSessionFixtureEndpoint != nil {
		if override := claudeSessionFixtureEndpoint(); override != "" {
			endpoint = override
		}
	}
	failed := errors.New("CLAUDE_SESSION_PROBE_FAILED")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/v1/code/sessions/"+target, nil)
	if err != nil {
		return false, failed
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-version", "2023-06-01")
	platform := operatingSystem
	if platform == "darwin" {
		platform = "macos"
	}
	req.Header.Set("anthropic-client-platform", platform)
	req.Header.Set("User-Agent", "ARC")
	res, err := client.Do(req)
	if err != nil {
		return false, failed
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if res.StatusCode != http.StatusOK {
		return false, failed
	}
	data, err := io.ReadAll(res.Body)
	var value object
	if err != nil || canonjson.Unmarshal(data, &value) != nil {
		return false, failed
	}
	session, ok := value["response_shape"]
	if !ok {
		session = value["session"]
	}
	if field(session, "id") != target {
		return false, errors.New("CLAUDE_SESSION_PROBE_UNCONFIRMED")
	}
	return true, nil
}
