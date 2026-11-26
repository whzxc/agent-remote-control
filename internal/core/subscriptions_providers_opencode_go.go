package core

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
)

func openCodeSubscriptionCredential() (subscriptionCredential, *subscriptionFailure) {
	home, err := os.UserHomeDir()
	if err != nil {
		return subscriptionCredential{}, subscriptionError("credentials-missing")
	}
	data := os.Getenv("XDG_DATA_HOME")
	if !filepath.IsAbs(data) {
		data = filepath.Join(home, ".local/share")
	}
	value, failure := subscriptionCredentialFile(filepath.Join(data, "opencode/auth.json"))
	if failure != nil {
		return subscriptionCredential{}, failure
	}
	return newSubscriptionCredential(text(field(value, "opencode-go"), "key"), "opencode-login")
}

func readOpenCodeSubscription(ctx context.Context, client *http.Client, credential subscriptionCredential) (subscriptionReading, *subscriptionFailure) {
	value, failure := getSubscriptionJSON(ctx, client, "https://opencode.ai/zen/go/v1/usage", credential.secret, nil)
	if failure != nil {
		return subscriptionReading{}, failure
	}
	windows := []quotaWindow{}
	for _, id := range []string{"rolling", "weekly", "monthly"} {
		row := field(field(value, "usage"), id)
		window, ok := newQuotaWindow(id, "go", id, field(row, "percent"), subscriptionDate(field(row, "resetsAt")))
		if !ok {
			continue
		}
		state := text(row, "status")
		if state == "ok" || state == "exhausted" || state == "blocked" {
			exhausted := state != "ok"
			window.Exhausted = &exhausted
		}
		windows = append(windows, window)
	}
	return subscriptionReadingFrom(windows, value)
}
