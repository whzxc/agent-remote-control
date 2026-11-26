package core

// Native login and merged-plan usage follow magpie-community's Cursor plugin.
// See licenses/magpie-community-LICENSE.txt.

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
	_ "modernc.org/sqlite"
)

func cursorSubscriptionDB(home string) string {
	return filepath.Join(uninstallConfigDir(home), "Cursor/User/globalStorage/state.vscdb")
}

func cursorCredentialFromDB(ctx context.Context, path string) string {
	rawPath := filepath.ToSlash(path)
	if !strings.HasPrefix(rawPath, "/") {
		rawPath = "/" + rawPath
	}
	dsn := url.URL{Scheme: "file", Path: rawPath}
	dsn.RawQuery = url.Values{"mode": {"ro"}, "_pragma": {"busy_timeout(2000)"}}.Encode()
	database, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return ""
	}
	defer database.Close()
	var raw []byte
	if err := database.QueryRowContext(ctx, "SELECT value FROM ItemTable WHERE key=?1 LIMIT 1", "cursorAuth/accessToken").Scan(&raw); err != nil {
		return ""
	}
	if len(raw) > 1 && len(raw)%2 == 0 && raw[1] == 0 {
		units := make([]uint16, len(raw)/2)
		for i := range units {
			units[i] = binary.LittleEndian.Uint16(raw[2*i:])
		}
		runes := utf16.Decode(units)
		for i, u := range units {
			if 0xd800 <= u && u <= 0xdbff && (i+1 == len(units) || units[i+1] < 0xdc00 || units[i+1] > 0xdfff) ||
				0xdc00 <= u && u <= 0xdfff && (i == 0 || units[i-1] < 0xd800 || units[i-1] > 0xdbff) {
				return ""
			}
		}
		return string(runes)
	}
	if !utf8.Valid(raw) {
		return ""
	}
	return string(raw)
}

func cursorSubscriptionCredential(ctx context.Context) (subscriptionCredential, *subscriptionFailure) {
	if operatingSystem == "darwin" {
		wait, cancel := context.WithTimeout(ctx, 4*time.Second)
		data, err := nativeCommand(wait, "security", "find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w").Output()
		cancel()
		if token := strings.TrimSpace(string(data)); err == nil && utf8.Valid(data) && token != "" {
			return newSubscriptionCredential(token, "cursor-login")
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return subscriptionCredential{}, subscriptionError("credentials-missing")
	}
	auth := filepath.Join(uninstallConfigDir(home), "cursor/auth.json")
	switch operatingSystem {
	case "darwin":
		auth = filepath.Join(home, ".cursor/auth.json")
	case "windows":
		auth = filepath.Join(uninstallConfigDir(home), "Cursor/auth.json")
	}
	if value, failure := subscriptionCredentialFile(auth); failure == nil {
		if token := text(value, "accessToken"); strings.TrimSpace(token) != "" {
			return newSubscriptionCredential(token, "cursor-login")
		}
	}
	return newSubscriptionCredential(cursorCredentialFromDB(ctx, cursorSubscriptionDB(home)), "cursor-login")
}

func cursorSessionCookie(token string) string {
	parts := strings.SplitN(token, ".", 3)
	if len(parts) < 2 {
		return ""
	}
	data, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return ""
	}
	var value any
	if canonjson.Unmarshal(data, &value) != nil {
		return ""
	}
	subject, ok := field(value, "sub").(string)
	if !ok {
		return ""
	}
	account := subject[strings.LastIndex(subject, "|")+1:]
	// WHATWG form encoding leaves '*' unescaped and escapes '~'.
	encoded := url.QueryEscape(account + "::" + token)
	encoded = strings.NewReplacer("%2A", "*", "~", "%7E").Replace(encoded)
	return "WorkosCursorSessionToken=" + encoded
}

func cursorSubscriptionTime(value any) *string {
	if reset := subscriptionDate(value); reset != nil {
		return reset
	}
	var n int64
	var err error
	switch value := value.(type) {
	case json.Number:
		n, err = value.Int64()
	case string:
		n, err = strconv.ParseInt(value, 10, 64)
	case int:
		n = int64(value)
	default:
		return nil
	}
	if err != nil {
		return nil
	}
	if n < 10000000000 {
		if n < math.MinInt64/1000 {
			return nil
		}
		n *= 1000
	}
	if n < -8334601228800000 || n > 8210266876799999 {
		return nil
	}
	reset := subscriptionTimestamp(time.UnixMilli(n))
	return &reset
}

func parseCursorUsage(quota, usage, plan any, spend string) []quotaWindow {
	info := field(plan, "planInfo")
	reset := cursorSubscriptionTime(field(usage, "billingCycleEnd"))
	if reset == nil {
		reset = cursorSubscriptionTime(field(usage, "billingCycleEndDate"))
	}
	if reset == nil {
		reset = cursorSubscriptionTime(field(info, "includedUsageResetsAt"))
	}
	var total any
	if value, ok := subscriptionNumber(field(quota, "totalPercentUsed")); ok {
		total = value
	} else {
		limit, hasLimit := subscriptionNumber(field(quota, "limit"))
		used, hasUsage := subscriptionNumber(field(quota, spend))
		if hasLimit && limit > 0 && hasUsage {
			total = used / limit * 100
		}
	}
	windows := []quotaWindow{}
	if field(plan, "isMerged") == true {
		period := field(info, "includedUsagePeriod")
		label := "current-period"
		switch {
		case period == "INCLUDED_USAGE_PERIOD_WEEKLY" || uintOr(period, 0) == 2:
			label = "weekly"
		case period == "INCLUDED_USAGE_PERIOD_MONTHLY" || uintOr(period, 0) == 1:
			label = "monthly"
		}
		if window, ok := newQuotaWindow("cursorModels", "cursorModels", label, total, reset); ok {
			windows = append(windows, window)
		}
		return windows
	}
	for _, row := range []struct {
		id      string
		percent any
	}{{"plan", total}, {"cursorModels", field(quota, "autoPercentUsed")}, {"otherModels", field(quota, "apiPercentUsed")}} {
		if window, ok := newQuotaWindow(row.id, row.id, row.id, row.percent, reset); ok {
			windows = append(windows, window)
		}
	}
	return windows
}

func readCursorSubscription(ctx context.Context, client *http.Client, credential subscriptionCredential) (subscriptionReading, *subscriptionFailure) {
	rpc := func(method string, body object) (any, *subscriptionFailure) {
		const base = "https://api2.cursor.sh/aiserver.v1.DashboardService/"
		headers := make(http.Header)
		headers.Set("Connect-Protocol-Version", "1")
		return requestSubscriptionJSON(ctx, client, http.MethodPost, base+method, credential.secret, headers, body)
	}
	var plan any
	var planFailure *subscriptionFailure
	var calls sync.WaitGroup
	calls.Go(func() { plan, planFailure = rpc("GetPlanInfo", object{}) })
	usage, usageFailure := rpc("GetCurrentPeriodUsage", object{})
	calls.Wait()
	raw := object{}
	windows := []quotaWindow{}
	if usageFailure == nil {
		if planFailure != nil {
			plan = nil
		}
		windows = parseCursorUsage(field(usage, "planUsage"), usage, plan, "totalSpend")
		raw["usage"] = usage
	}
	if planFailure == nil {
		raw["plan"] = plan
	}
	if cookie := cursorSessionCookie(credential.secret); len(windows) == 0 && cookie != "" {
		summary, failure := getSubscriptionJSON(ctx, client, "https://cursor.com/api/usage-summary", "", http.Header{"Cookie": {cookie}})
		switch {
		case failure == nil:
			windows = parseCursorUsage(field(field(summary, "individualUsage"), "plan"), summary, raw["plan"], "used")
			raw["summary"] = summary
		case len(raw) == 0:
			return subscriptionReading{}, failure
		default:
			raw["quotaError"] = failure.Code
		}
	}
	if field(raw["plan"], "isMerged") == true {
		shared, failure := readCursorSharedUsage(ctx, client, rpc)
		if failure != nil {
			raw["sharedUsageError"] = failure.Code
		} else if field(field(shared, "config"), "isUnifiedBillingUser") == true {
			q := field(shared, "config")
			period := field(q, "currentPeriod")
			if len(windows) == 0 {
				if window, ok := newQuotaWindow("cursorModels", "cursorModels", grokPeriodLabel(field(period, "type")), field(q, "creditUsagePercent"), subscriptionDate(field(period, "end"))); ok {
					windows = append(windows, window)
				}
			}
			raw["sharedUsage"] = shared
		}
	}
	return subscriptionReadingFrom(windows, raw)
}

func readCursorSharedUsage(ctx context.Context, client *http.Client, rpc func(string, object) (any, *subscriptionFailure)) (any, *subscriptionFailure) {
	value, failure := rpc("GetXaiCommerceBearerToken", object{"purpose": "XAI_COMMERCE_BEARER_PURPOSE_BROWSER_COMMERCE"})
	if failure != nil {
		return nil, failure
	}
	token, ok := field(field(value, "credential"), "token").(string)
	if !ok {
		return nil, subscriptionError("credentials-missing")
	}
	return getSubscriptionJSON(ctx, client, "https://grok.com/rest/grok/credits", token, http.Header{"User-Agent": {"Mozilla/5.0 agent-remote-control"}})
}
