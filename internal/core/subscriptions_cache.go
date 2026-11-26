package core

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

type cachedSubscriptionReading struct {
	ObservedAt     string        `json:"observedAt"`
	Source         *string       `json:"source"`
	Windows        []quotaWindow `json:"windows"`
	RawUsage       any           `json:"rawUsage"`
	AccountBlocked *bool         `json:"accountBlocked"`
	BlockedPoolIDs []string      `json:"blockedPoolIds"`
}

func subscriptionCachePath(id string) string {
	return filepath.Join(root(), "subscriptions/readings", id+".json")
}

func removeSubscriptionReading(id string) {
	if err := os.Remove(subscriptionCachePath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(os.Stderr, "could not remove subscription cache (%s): %v\n", id, err)
	}
}

func restoreSubscriptionReading(view *subscriptionProviderSnapshot) {
	data, err := os.ReadFile(subscriptionCachePath(view.ProviderID))
	if err != nil {
		return
	}
	var reading cachedSubscriptionReading
	if err := canonjson.Unmarshal(data, &reading); err != nil || reading.ObservedAt == "" || reading.Windows == nil || reading.BlockedPoolIDs == nil {
		return
	}
	view.Source, view.Windows, view.RawUsage = reading.Source, reading.Windows, reading.RawUsage
	view.ObservedAt, view.AccountBlocked, view.BlockedPoolIDs = &reading.ObservedAt, reading.AccountBlocked, reading.BlockedPoolIDs
	delete(obj(view.RawUsage), "history")
	view.State = "stale"
}

func persistSubscriptionReading(view subscriptionProviderSnapshot) {
	if view.ObservedAt == nil {
		return
	}
	// Rust saves a serde_json::Value, whose object keys are sorted even for nested structs.
	reading := cachedSubscriptionReading{*view.ObservedAt, view.Source, view.Windows, view.RawUsage, view.AccountBlocked, view.BlockedPoolIDs}
	var value object
	if err := canonjson.Unmarshal([]byte(wire(reading)), &value); err != nil {
		panic(err)
	}
	if err := save(subscriptionCachePath(view.ProviderID), value); err != nil {
		fmt.Fprintf(os.Stderr, "could not save subscription cache (%s): %v\n", view.ProviderID, err)
	}
}
