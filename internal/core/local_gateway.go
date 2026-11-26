package core

import (
	"context"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

const gatewayHelloTimeout = 250 * time.Millisecond
const gatewayReadTimeout = 1500 * time.Millisecond

type localGateway struct {
	origin, name string
	version      *string
}

func gatewayLoopbackOrigin(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "http" {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	if !slices.Contains([]string{"127.0.0.1", "localhost", "::1"}, host) {
		return ""
	}
	port := parsed.Port()
	if port == "" {
		port = "80"
	}
	value, err := strconv.ParseUint(port, 10, 16)
	if err != nil {
		return ""
	}
	return "http://" + net.JoinHostPort(host, strconv.FormatUint(value, 10))
}

func codexConfiguredGateway(config []byte) string {
	var table object
	if toml.Unmarshal(config, &table) != nil {
		return ""
	}
	if origin := gatewayLoopbackOrigin(text(table, "openai_base_url")); origin != "" {
		return origin
	}
	if provider := text(table, "model_provider"); provider != "" {
		return gatewayLoopbackOrigin(text(field(table["model_providers"], provider), "base_url"))
	}
	return ""
}

func gatewaySettingsOrigin() string {
	if explicit, ok := os.LookupEnv("ARC_LOCAL_GATEWAY_URL"); ok {
		return gatewayLoopbackOrigin(explicit)
	}
	config, ok := os.LookupEnv("XDG_CONFIG_HOME")
	if !ok {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		config = filepath.Join(home, ".config")
	}
	value, err := load(filepath.Join(config, "magpie/settings.json"))
	if err != nil {
		return ""
	}
	port := uintOr(field(value, "port"), 3425)
	if port == 0 || port > 65535 {
		port = 3425
	}
	return fmt.Sprintf("http://127.0.0.1:%d", port)
}

var gatewayTransport = &http.Transport{}

func gatewayJSON(ctx context.Context, endpoint string, timeout time.Duration) object {
	client := &http.Client{Transport: gatewayTransport, Timeout: timeout, CheckRedirect: func(request *http.Request, via []*http.Request) error {
		if len(via) >= 10 || gatewayLoopbackOrigin(request.URL.String()) == "" {
			return http.ErrUseLastResponse
		}
		return nil
	}}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil
	}
	response, err := client.Do(request)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil
	}
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return nil
	}
	var body object
	if canonjson.Unmarshal(data, &body) != nil {
		return nil
	}
	return body
}

func probeLocalGateway(ctx context.Context, origin string) *localGateway {
	origin = gatewayLoopbackOrigin(origin)
	if origin == "" {
		return nil
	}
	body := gatewayJSON(ctx, origin+"/api/hello", gatewayHelloTimeout)
	name := strings.TrimSpace(text(body, "name"))
	if !strings.EqualFold(name, "magpie") {
		return nil
	}
	gateway := &localGateway{origin: origin, name: name}
	if version := text(body, "version"); version != "" {
		gateway.version = &version
	}
	return gateway
}

func detectCodexGateway(ctx context.Context) *localGateway {
	if explicit, ok := os.LookupEnv("ARC_LOCAL_GATEWAY_URL"); ok {
		return probeLocalGateway(ctx, explicit)
	}
	home, err := nativeCodexHome()
	if err != nil {
		return nil
	}
	config, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		return nil
	}
	return probeLocalGateway(ctx, codexConfiguredGateway(config))
}

func detectLocalGateway(ctx context.Context) *localGateway {
	if gateway := detectCodexGateway(ctx); gateway != nil {
		return gateway
	}
	return probeLocalGateway(ctx, gatewaySettingsOrigin())
}

func gatewayNumber(value any) (float64, bool) {
	if _, ok := value.(string); ok {
		return 0, false
	}
	return subscriptionNumber(value)
}

func gatewayHasCredits(entry any) bool {
	words := strings.Fields(text(entry, "balance"))
	if len(words) == 0 {
		return false
	}
	n, err := strconv.ParseFloat(strings.ReplaceAll(words[0], ",", ""), 64)
	return err == nil && n > 0 && !math.IsInf(n, 0)
}

func gatewayAllowance(value any) (float64, bool) {
	if field(value, "text") == true || field(value, "aside") == true {
		return 0, false
	}
	if lane := text(value, "lane"); lane != "" && lane != "text" {
		return 0, false
	}
	return gatewayNumber(field(value, "used"))
}

func gatewayWindowName(name string) (string, uint64) {
	name = strings.TrimSpace(name)
	lower := strings.ToLower(name)
	switch {
	case strings.Contains(lower, "7 day") || strings.Contains(lower, "week") || lower == "7d":
		return "weekly", 10080
	case strings.Contains(lower, "5 hour") || lower == "5h":
		return "5h", 300
	default:
		return name, 0
	}
}

type gatewayBucket struct {
	minutes   uint64
	count     int
	sum, best float64
	reset     *string
}

func aggregateGatewayQuotas(body any, provider string) (subscriptionReading, object) {
	var total, withCredits, withRoom int
	summaries := []any{}
	buckets := make(map[string]*gatewayBucket)
	for _, entry := range arr(field(body, "data")) {
		if !strings.EqualFold(text(entry, "provider"), provider) || field(entry, "error") != nil {
			continue
		}
		total++
		var worst float64
		count := 0
		hasRoom := true
		for _, raw := range arr(field(entry, "windows")) {
			used, ok := gatewayAllowance(raw)
			if !ok {
				continue
			}
			count++
			hasRoom = hasRoom && used < 100
			used = min(used, 100)
			worst = max(worst, used)
			name, ok := field(raw, "name").(string)
			if !ok {
				name = "window"
			}
			label, duration := gatewayWindowName(name)
			bucket := buckets[label]
			if bucket == nil {
				bucket = &gatewayBucket{minutes: duration, best: used}
				buckets[label] = bucket
			}
			bucket.count++
			bucket.sum += used
			bucket.best = min(bucket.best, used)
			if reset := subscriptionDate(field(raw, "resetsAt")); reset != nil && (bucket.reset == nil || *reset < *bucket.reset) {
				bucket.reset = reset
			}
		}
		hasRoom = count != 0 && hasRoom
		if hasRoom {
			withRoom++
		}
		summary := object{"plan": field(entry, "plan"), "usedPercent": math.Round(worst*10) / 10, "hasRoom": hasRoom}
		if gatewayHasCredits(entry) {
			withCredits++
			summary["credits"] = object{"hasCredits": true, "balance": field(entry, "balance")}
		}
		summaries = append(summaries, summary)
	}
	if total == 0 {
		return subscriptionReading{}, nil
	}
	scope := fmt.Sprintf("Gateway pool (%d/%d accounts ready)", withRoom, total)
	if total == 1 {
		scope = "Gateway pool (1 account)"
	}
	pool := object{"id": provider, "accountsTotal": total, "accountsWithRoom": withRoom, "accountsWithCredits": withCredits}
	if withCredits > 0 {
		pool["credits"] = object{"hasCredits": true}
	}
	names := make([]string, 0, len(buckets))
	for label := range buckets {
		names = append(names, label)
	}
	priorities := map[string]int{"5h": -2, "weekly": -1}
	slices.SortFunc(names, func(a, b string) int {
		if diff := priorities[a] - priorities[b]; diff != 0 {
			return diff
		}
		return strings.Compare(a, b)
	})
	windows := []quotaWindow{}
	exhausted := withRoom == 0
	for i, name := range names {
		bucket := buckets[name]
		average := math.Round(bucket.sum/float64(bucket.count)*10) / 10
		q, _ := newQuotaWindow("gateway/"+provider+"/"+name, provider, name, average, bucket.reset)
		q.Scope, q.Exhausted = &scope, &exhausted
		windows = append(windows, q)
		if i >= 2 {
			continue
		}
		slot := object{"usedPercent": average, "bestAccountUsedPercent": math.Round(bucket.best*10) / 10}
		if bucket.minutes != 0 {
			slot["windowDurationMins"] = bucket.minutes
		}
		if bucket.reset != nil {
			if at, err := time.Parse(time.RFC3339Nano, *bucket.reset); err == nil {
				slot["resetsAt"] = at.Unix()
			}
		}
		pool[[]string{"primary", "secondary"}[i]] = slot
	}
	dispatch := object{"source": "local-gateway", "gateway": "magpie", "ordinaryUsageAllowed": withRoom > 0,
		"pools": []any{pool}, "poolAccounts": summaries, "state": "ready", "observedAt": now()}
	raw := object{"source": "local-gateway", "gateway": "magpie", "ordinaryUsageAllowed": withRoom > 0,
		"pools": []any{pool}, "poolAccounts": summaries, "accountsTotal": total, "accountsWithRoom": withRoom, "accountsWithCredits": withCredits}
	reading, _ := subscriptionReadingFrom(windows, raw)
	blocked := withRoom == 0 && withCredits == 0
	reading.accountBlocked = &blocked
	if blocked {
		reading.blockedPoolIDs = []string{provider}
	}
	return reading, dispatch
}

func fetchCodexGatewayQuota(ctx context.Context) (subscriptionReading, object) {
	gateway := detectCodexGateway(ctx)
	if gateway == nil {
		return subscriptionReading{}, nil
	}
	body := gatewayJSON(ctx, gateway.origin+"/v1/magpie/quotas", gatewayReadTimeout)
	return aggregateGatewayQuotas(body, "codex")
}

func isGatewayAuxiliary(row any) bool {
	kind := text(row, "kind")
	return slices.Contains([]string{"composer_predictions", "title", "auxiliary", "warmup", "cache_keepalive"}, kind) ||
		kind != "" && text(row, "session_role") == "unknown"
}

func aggregateGatewayTurnUsage(body any, session, started, ended string) object {
	start, startErr := time.Parse(time.RFC3339Nano, started)
	end, endErr := time.Parse(time.RFC3339Nano, ended)
	start = start.Add(-2 * time.Second)
	end = end.Add(5 * time.Second)
	var calls, priced uint64
	var cost float64
	inputs := map[string]string{"in": "inputTokens", "out": "outputTokens", "cache_read": "cacheReadTokens",
		"cache_write": "cacheWriteTokens", "reasoning": "reasoningTokens", "ms": "durationMs"}
	totals := make(map[string]uint64, len(inputs))
	models, providers := object{}, object{}
	for _, row := range arr(field(body, "rows")) {
		native, nativeOK := field(row, "native_session").(string)
		generic, genericOK := field(row, "session").(string)
		if !(nativeOK && native == session || genericOK && generic == session) || isGatewayAuxiliary(row) {
			continue
		}
		if startErr == nil || endErr == nil {
			at, err := time.Parse(time.RFC3339Nano, text(row, "t"))
			if err != nil || startErr == nil && at.Before(start) || endErr == nil && at.After(end) {
				continue
			}
		}
		calls++
		for key := range inputs {
			totals[key] += uintOr(field(row, key), 0)
		}
		if n, ok := gatewayNumber(field(row, "cost")); ok && field(row, "priced") == true {
			cost += n
			priced++
		}
		model, ok := field(row, "served").(string)
		if !ok {
			model = text(row, "model")
		}
		if model != "" {
			models[model] = true
		}
		if provider := text(row, "provider"); provider != "" {
			providers[provider] = true
		}
	}
	if calls == 0 {
		return nil
	}
	result := object{"source": "local-gateway", "gateway": "magpie", "calls": calls, "servedModels": keys(models), "servedProviders": keys(providers)}
	for name, target := range inputs {
		result[target] = totals[name]
	}
	if priced > 0 {
		result["costUsd"], result["pricedCalls"] = math.Round(cost*1000000)/1000000, priced
	}
	return result
}

func fetchGatewayTurnUsage(ctx context.Context, agent, session, started, ended string) object {
	if strings.TrimSpace(session) == "" {
		return nil
	}
	var gateway *localGateway
	if agent == "codex" {
		gateway = detectCodexGateway(ctx)
	} else {
		gateway = detectLocalGateway(ctx)
	}
	if gateway == nil {
		return nil
	}
	query := url.Values{"q": {session}, "agent": {agent}, "via": {"gateway"}, "period": {"30d"}, "limit": {"200"}}
	body := gatewayJSON(ctx, gateway.origin+"/v1/magpie/usage/requests?"+query.Encode(), gatewayReadTimeout)
	return aggregateGatewayTurnUsage(body, session, started, ended)
}
