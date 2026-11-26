package core

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

type antigravityQuotaEndpoint struct {
	scheme string
	port   uint16
	csrf   string
}

func antigravityQuotaEndpoints(home string) []antigravityQuotaEndpoint {
	var endpoints []antigravityQuotaEndpoint
	for _, root := range []string{".gemini/antigravity/daemon", ".gemini/antigravity-cli/daemon"} {
		dir := filepath.Join(home, root)
		entries, _ := os.ReadDir(dir)
		for _, entry := range entries {
			if !entry.Type().IsRegular() || filepath.Ext(entry.Name()) != ".json" {
				continue
			}
			daemon, err := load(filepath.Join(dir, entry.Name()))
			if err != nil {
				continue
			}
			pid := uintOr(field(daemon, "pid"), 0)
			csrf := text(daemon, "csrfToken")
			if pid == 0 || pid > 1<<31-1 || strings.TrimSpace(csrf) == "" || platform.ProcessStart(int(pid)) == "" {
				continue
			}
			for _, kind := range []struct{ scheme, key string }{{"http", "httpPort"}, {"https", "httpsPort"}} {
				port := uintOr(field(daemon, kind.key), 0)
				if port == 0 || port > 65535 {
					continue
				}
				endpoint := antigravityQuotaEndpoint{kind.scheme, uint16(port), csrf}
				if !slices.Contains(endpoints, endpoint) {
					endpoints = append(endpoints, endpoint)
				}
			}
		}
	}
	return endpoints
}

func antigravityQuotaWindows(raw any) []quotaWindow {
	groups := arr(field(raw, "groups"))
	if groups == nil {
		groups = arr(field(field(raw, "response"), "groups"))
	}
	windows := []quotaWindow{}
	for _, group := range groups {
		for _, bucket := range arr(field(group, "buckets")) {
			id := text(bucket, "bucketId")
			pool, label, scope := "gemini", "five_hour", "Gemini"
			switch id {
			case "gemini-5h":
			case "gemini-weekly":
				label = "weekly"
			case "3p-5h":
				pool, scope = "third-party", "Claude / Other"
			case "3p-weekly":
				pool, label, scope = "third-party", "weekly", "Claude / Other"
			default:
				continue
			}
			if slices.ContainsFunc(windows, func(w quotaWindow) bool { return w.ID == id }) {
				continue
			}
			fraction, ok := subscriptionNumber(field(bucket, "remainingFraction"))
			if !ok || fraction > 1 {
				continue
			}
			w, ok := newQuotaWindow(id, pool, label, (1-fraction)*100, subscriptionDate(field(bucket, "resetTime")))
			if ok {
				w.Scope = &scope
				windows = append(windows, w)
			}
		}
	}
	return windows
}

func legacyAntigravityWindows(value any) []quotaWindow {
	type model struct {
		name     string
		fraction float64
		reset    *string
	}
	models := []model{}
	var walk func(any)
	walk = func(value any) {
		quota := field(value, "quotaInfo")
		if fraction, ok := subscriptionNumber(field(quota, "remainingFraction")); ok && fraction <= 1 {
			for _, key := range []string{"label", "displayName", "model"} {
				if name, ok := field(value, key).(string); ok {
					if name != "" {
						models = append(models, model{name, fraction, subscriptionDate(field(quota, "resetTime"))})
					}
					break
				}
			}
		}
		switch value := value.(type) {
		case object:
			for _, key := range keys(value) {
				row := value[key]
				quota := field(row, "quotaInfo")
				if fraction, ok := subscriptionNumber(field(quota, "remainingFraction")); ok && fraction <= 1 && field(row, "label") == nil && field(row, "displayName") == nil && field(row, "model") == nil {
					models = append(models, model{key, fraction, subscriptionDate(field(quota, "resetTime"))})
				}
				walk(row)
			}
		case []any:
			for _, row := range value {
				walk(row)
			}
		}
	}
	walk(value)
	windows := []quotaWindow{}
	for _, group := range []struct {
		pool, scope string
		gemini      bool
	}{{"gemini", "Gemini", true}, {"third-party", "Claude / Other", false}} {
		var best *model
		for _, candidate := range models {
			if strings.Contains(strings.ToLower(candidate.name), "gemini") == group.gemini && (best == nil || candidate.fraction < best.fraction) {
				best = &candidate
			}
		}
		if best != nil {
			w, _ := newQuotaWindow(group.pool, group.pool, "five_hour", (1-best.fraction)*100, best.reset)
			w.Scope = &group.scope
			windows = append(windows, w)
		}
	}
	return windows
}

func readAntigravitySubscription(ctx context.Context) (subscriptionReading, *subscriptionFailure) {
	home, err := os.UserHomeDir()
	if err != nil {
		return subscriptionReading{}, subscriptionError("client-not-running")
	}
	// The discovered daemon listens on loopback and can use a self-signed certificate.
	// No proxy or redirect can move these requests or their CSRF header off loopback.
	transport := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	client := &http.Client{Transport: transport, Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	return queryAntigravitySubscription(ctx, client, antigravityQuotaEndpoints(home))
}

func queryAntigravitySubscription(ctx context.Context, client *http.Client, endpoints []antigravityQuotaEndpoint) (subscriptionReading, *subscriptionFailure) {
	responded := false
	for _, endpoint := range endpoints {
		call := func(method string) (any, *subscriptionFailure) {
			url := fmt.Sprintf("%s://127.0.0.1:%d/exa.language_server_pb.LanguageServerService/%s", endpoint.scheme, endpoint.port, method)
			headers := make(http.Header)
			headers.Set("x-codeium-csrf-token", endpoint.csrf)
			headers.Set("Connect-Protocol-Version", "1")
			return requestSubscriptionJSON(ctx, client, http.MethodPost, url, "", headers, object{"metadata": object{
				"ideName": "antigravity", "extensionName": "antigravity", "ideVersion": "unknown", "locale": "en",
			}})
		}
		var status any
		var statusFailure *subscriptionFailure
		var calls sync.WaitGroup
		calls.Go(func() { status, statusFailure = call("GetUserStatus") })
		summary, summaryFailure := call("RetrieveUserQuotaSummary")
		calls.Wait()
		raw := object{}
		if statusFailure == nil {
			responded = true
			if nested, ok := obj(status)["response"]; ok {
				status = nested
			}
			user, wrapped := obj(status)["userStatus"]
			if !wrapped {
				user = status
			}
			raw["plan"] = field(field(user, "userTier"), "name")
			if !wrapped && obj(field(status, "userTier")) != nil {
				status = object{"userStatus": status}
			}
			raw["status"] = status
		}
		var windows []quotaWindow
		if summaryFailure == nil {
			responded = true
			windows = antigravityQuotaWindows(summary)
			raw["quotaSummary"] = summary
		}
		if len(windows) == 0 && obj(raw["status"]) != nil {
			windows = legacyAntigravityWindows(raw["status"])
			if len(windows) == 0 {
				models, failure := call("GetCommandModelConfigs")
				if failure == nil {
					raw["models"] = models
					windows = legacyAntigravityWindows(models)
				}
			}
		}
		if len(windows) != 0 {
			return subscriptionReadingFrom(windows, raw)
		}
	}
	if responded {
		return subscriptionReading{}, subscriptionError("no-limits-reported")
	}
	return subscriptionReading{}, subscriptionError("client-not-running")
}
