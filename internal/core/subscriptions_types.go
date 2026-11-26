package core

import (
	"encoding/json"
	"math"
	"strconv"
	"time"
)

type subscriptionSettings struct {
	Enabled        bool                `json:"enabled"`
	RefreshMinutes uint64              `json:"refreshMinutes"`
	AgentProviders map[string][]string `json:"agentProviders"`
}

func defaultSubscriptionSettings() subscriptionSettings {
	return subscriptionSettings{Enabled: true, RefreshMinutes: 3, AgentProviders: map[string][]string{}}
}

type quotaWindow struct {
	ID          string  `json:"id"`
	PoolID      string  `json:"poolId"`
	Label       string  `json:"label"`
	Scope       *string `json:"scope,omitempty"`
	UsedPercent float64 `json:"usedPercent"`
	ResetsAt    *string `json:"resetsAt,omitempty"`
	Exhausted   *bool   `json:"exhausted,omitempty"`
}

type subscriptionFailure struct {
	Code    string  `json:"code"`
	Message string  `json:"message,omitempty"`
	RetryAt *string `json:"retryAt,omitempty"`
}

type subscriptionSnapshot struct {
	InstanceID string                         `json:"instanceId"`
	Revision   uint64                         `json:"revision"`
	Settings   subscriptionSettings           `json:"settings"`
	Providers  []subscriptionProviderSnapshot `json:"providers"`
}

type subscriptionProviderSnapshot struct {
	ProviderID       string               `json:"providerId"`
	AgentID          string               `json:"agentId"`
	AgentIDs         []string             `json:"agentIds"`
	Name             string               `json:"name"`
	Eligible         bool                 `json:"eligible"`
	State            string               `json:"state"`
	Refreshing       bool                 `json:"refreshing"`
	RawUsage         any                  `json:"rawUsage"`
	ObservedAt       *string              `json:"observedAt"`
	LastAttemptAt    *string              `json:"lastAttemptAt"`
	Windows          []quotaWindow        `json:"windows"`
	DisplayWindowID  *string              `json:"displayWindowId"`
	AccountBlocked   *bool                `json:"accountBlocked"`
	BlockedPoolIDs   []string             `json:"blockedPoolIds"`
	Source           *string              `json:"source"`
	Error            *subscriptionFailure `json:"error"`
	HasCredential    bool                 `json:"hasCredential"`
	AcceptsKey       bool                 `json:"acceptsKey"`
	CredentialSource *string              `json:"credentialSource"`
}

type subscriptionReading struct {
	windows        []quotaWindow
	rawUsage       any
	accountBlocked *bool
	blockedPoolIDs []string
}

func subscriptionReadingFrom(windows []quotaWindow, raw any) (subscriptionReading, *subscriptionFailure) {
	if len(windows) == 0 && obj(raw) == nil {
		return subscriptionReading{}, subscriptionError("no-limits-reported")
	}
	if windows == nil {
		windows = []quotaWindow{}
	}
	return subscriptionReading{windows: windows, rawUsage: raw, blockedPoolIDs: []string{}}, nil
}

func subscriptionError(code string) *subscriptionFailure { return &subscriptionFailure{Code: code} }

func subscriptionTimestamp(t time.Time) string {
	utc := t.UTC()
	layout := "2006-01-02T15:04:05"
	switch nanos := utc.Nanosecond(); {
	case nanos == 0:
	case nanos%1000000 == 0:
		layout += ".000"
	case nanos%1000 == 0:
		layout += ".000000"
	default:
		layout += ".000000000"
	}
	return utc.Format(layout + "-07:00")
}

func subscriptionDate(value any) *string {
	at, err := time.Parse(time.RFC3339Nano, str(value))
	if err != nil {
		return nil
	}
	s := subscriptionTimestamp(at)
	return &s
}

func subscriptionNumber(value any) (float64, bool) {
	var n float64
	var err error
	switch value := value.(type) {
	case json.Number:
		n, err = value.Float64()
	case string:
		n, err = strconv.ParseFloat(value, 64)
	case float64:
		n = value
	case int:
		n = float64(value)
	case uint64:
		n = float64(value)
	default:
		return 0, false
	}
	return n, err == nil && !math.IsInf(n, 0) && !math.IsNaN(n) && n >= 0
}

func newQuotaWindow(id, pool, label string, percent any, reset *string) (quotaWindow, bool) {
	n, ok := subscriptionNumber(percent)
	if !ok {
		return quotaWindow{}, false
	}
	return quotaWindow{ID: id, PoolID: pool, Label: label, UsedPercent: n, ResetsAt: reset}, true
}

func quotaWindowActive(window quotaWindow, now time.Time) bool {
	if window.ResetsAt == nil {
		return true
	}
	at, err := time.Parse(time.RFC3339Nano, *window.ResetsAt)
	return err == nil && at.After(now)
}
