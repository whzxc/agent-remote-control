package core

import (
	"strconv"
	"time"
)

func decodeCodexSubscription(value any) (subscriptionReading, *subscriptionFailure) {
	var groups object
	if candidates := obj(field(value, "rateLimitsByLimitId")); candidates != nil {
		groups = candidates
	} else if group := obj(field(value, "rateLimits")); group != nil {
		pool, ok := group["limitId"].(string)
		if !ok {
			pool = "codex"
		}
		groups = object{pool: group}
	}
	windows := []quotaWindow{}
	blocked := []string{}
	for _, pool := range keys(groups) {
		group := groups[pool]
		if _, reached := field(group, "rateLimitReachedType").(string); reached || field(group, "spendControlReached") == true {
			blocked = append(blocked, pool)
		}
		for _, slot := range []string{"primary", "secondary"} {
			raw := field(group, slot)
			var reset *string
			if v, ok := field(raw, "resetsAt").(interface{ Int64() (int64, error) }); ok {
				if seconds, err := v.Int64(); err == nil && seconds >= -8334601228800 && seconds <= 8210266876799 {
					at := subscriptionTimestamp(time.Unix(seconds, 0))
					reset = &at
				}
			}
			label := slot
			if minutes, ok := uintValue(field(raw, "windowDurationMins")); ok {
				label = strconv.FormatUint(minutes, 10) + " min"
			}
			window, ok := newQuotaWindow(pool+"/"+slot, pool, label, field(raw, "usedPercent"), reset)
			if !ok {
				continue
			}
			if scope, ok := field(group, "limitName").(string); ok {
				window.Scope = &scope
			}
			windows = append(windows, window)
		}
	}
	reading, failure := subscriptionReadingFrom(windows, value)
	reading.blockedPoolIDs = blocked
	if allowed, ok := field(value, "ordinaryUsageAllowed").(bool); ok {
		b := !allowed
		reading.accountBlocked = &b
	}
	return reading, failure
}
