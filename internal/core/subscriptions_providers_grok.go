package core

// Native billing and renewal follow magpie-community's Grok plugin.
// See licenses/magpie-community-LICENSE.txt.

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

func grokSubscriptionCredential(ctx context.Context) (subscriptionCredential, *subscriptionFailure) {
	dir := os.Getenv("GROK_HOME")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return subscriptionCredential{}, subscriptionError("credentials-missing")
		}
		dir = filepath.Join(home, ".grok")
	}
	path := filepath.Join(dir, "auth.json")
	value, failure := subscriptionCredentialFile(path)
	for i := 0; i < 5 && failure != nil && failure.Code == "invalid-response"; i++ {
		select {
		case <-ctx.Done():
			return subscriptionCredential{}, subscriptionError("network-error")
		case <-time.After(100 * time.Millisecond):
		}
		value, failure = subscriptionCredentialFile(path)
	}
	if failure != nil {
		return subscriptionCredential{}, failure
	}
	entries := obj(value)
	if entries == nil {
		return subscriptionCredential{}, subscriptionError("invalid-response")
	}
	for _, key := range keys(entries) {
		if token := text(entries[key], "key"); token != "" {
			return newSubscriptionCredential(token, "grok-login")
		}
	}
	return subscriptionCredential{}, subscriptionError("credentials-missing")
}

func readGrokSubscription(ctx context.Context, client *http.Client, credential subscriptionCredential) (subscriptionReading, *subscriptionFailure) {
	reading, failure := readGrokQuota(ctx, client, credential)
	if failure == nil || failure.Code != "authentication-failed" {
		return reading, failure
	}
	current, failure := grokSubscriptionCredential(ctx)
	if failure != nil {
		return subscriptionReading{}, failure
	}
	if current.secret == credential.secret {
		result, failure := nativeSubscriptionCLI(ctx, "grok", "models")
		if failure != nil {
			return subscriptionReading{}, failure
		}
		current, failure = grokSubscriptionCredential(ctx)
		if failure != nil {
			return subscriptionReading{}, failure
		}
		if !result.success && current.secret == credential.secret {
			return subscriptionReading{}, &subscriptionFailure{Code: "authentication-failed", Message: "Grok Build could not renew its login. Run `grok login`, then refresh usage."}
		}
	}
	return readGrokQuota(ctx, client, current)
}

func grokPeriodLabel(value any) string {
	switch value {
	case "USAGE_PERIOD_TYPE_WEEKLY":
		return "weekly"
	case "USAGE_PERIOD_TYPE_MONTHLY":
		return "monthly"
	default:
		return "current-period"
	}
}

func readGrokQuota(ctx context.Context, client *http.Client, credential subscriptionCredential) (subscriptionReading, *subscriptionFailure) {
	request := func(path string) (any, *subscriptionFailure) {
		headers := make(http.Header)
		headers.Set("Accept", "application/json")
		headers.Set("x-xai-token-auth", "xai-grok-cli")
		return getSubscriptionJSON(ctx, client, "https://cli-chat-proxy.grok.com/v1/"+path, credential.secret, headers)
	}
	var settings any
	var settingsFailure *subscriptionFailure
	var calls sync.WaitGroup
	calls.Go(func() { settings, settingsFailure = request("settings") })
	credits, failure := request("billing?format=credits")
	calls.Wait()
	if failure != nil {
		return subscriptionReading{}, failure
	}
	raw := obj(credits)
	q := obj(raw["config"])
	if q == nil {
		return subscriptionReading{}, subscriptionError("invalid-response")
	}
	if settingsFailure == nil {
		var tier any
		if value, ok := field(settings, "subscription_tier_display").(string); ok {
			tier = value
		} else if value, ok := field(settings, "subscription_tier").(string); ok {
			tier = value
		}
		raw["subscriptionTier"] = tier
	}
	period := field(q, "currentPeriod")
	reset := subscriptionDate(field(period, "end"))
	if reset == nil {
		reset = subscriptionDate(q["billingPeriodEnd"])
	}
	windows := []quotaWindow{}
	if window, ok := newQuotaWindow("current-period", "grok", grokPeriodLabel(field(period, "type")), q["creditUsagePercent"], reset); ok {
		windows = append(windows, window)
	}
	return subscriptionReadingFrom(windows, raw)
}
