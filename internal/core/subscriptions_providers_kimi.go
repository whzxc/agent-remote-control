package core

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"strconv"
)

func kimiQuota(value any, id, label string) (quotaWindow, bool) {
	limit, valid := subscriptionNumber(field(value, "limit"))
	if !valid || limit <= 0 {
		return quotaWindow{}, false
	}
	used, ok := subscriptionNumber(field(value, "used"))
	if field(value, "used") == nil {
		var remaining float64
		remaining, ok = subscriptionNumber(field(value, "remaining"))
		used = limit - remaining
	}
	if !ok {
		return quotaWindow{}, false
	}
	return newQuotaWindow(id, "coding", label, used/limit*100, subscriptionDate(field(value, "resetTime")))
}

func readKimiSubscription(ctx context.Context, client *http.Client, credential subscriptionCredential) (subscriptionReading, *subscriptionFailure) {
	value, failure := getSubscriptionJSON(ctx, client, "https://api.kimi.com/coding/v1/usages", credential.secret, nil)
	if failure != nil {
		return subscriptionReading{}, failure
	}
	windows := []quotaWindow{}
	units := map[string]uint64{"TIME_UNIT_SECOND": 1, "TIME_UNIT_MINUTE": 60, "TIME_UNIT_HOUR": 3600, "TIME_UNIT_DAY": 86400}
	for i, row := range arr(field(value, "limits")) {
		window := field(row, "window")
		unit := units[text(window, "timeUnit")]
		raw := field(window, "duration")
		duration, ok := uintValue(raw)
		if !ok {
			duration, _ = strconv.ParseUint(str(raw), 10, 64)
		}
		if unit == 0 || duration == 0 || duration > math.MaxUint64/unit {
			continue
		}
		duration *= unit
		if q, ok := kimiQuota(field(row, "detail"), fmt.Sprintf("limit/%d/%d", duration, i), fmt.Sprintf("%d s", duration)); ok {
			windows = append(windows, q)
		}
	}
	if q, ok := kimiQuota(field(value, "usage"), "weekly", "weekly"); ok {
		windows = append(windows, q)
	}
	return subscriptionReadingFrom(windows, value)
}
