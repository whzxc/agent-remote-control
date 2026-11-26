package core

// Native /usage line formats follow magpie (Copyright (c) 2026 yetone).
// See licenses/magpie-LICENSE.txt. Claude Code owns native authentication.

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

var claudeUsageArguments = []string{"-p", "/usage", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence"}

func readNativeClaudeSubscription(ctx context.Context) (subscriptionReading, *subscriptionFailure) {
	out, failure := nativeSubscriptionCLI(ctx, "claude", claudeUsageArguments...)
	if failure != nil {
		return subscriptionReading{}, failure
	}
	return decodeClaudeSubscription(out)
}

func readClaudeProfileSubscription(ctx context.Context, profile string) (subscriptionReading, *subscriptionFailure) {
	wait, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd, err := claudeAccountCommand(wait, profile, claudeUsageArguments...)
	if err != nil {
		return subscriptionReading{}, &subscriptionFailure{Code: "request-failed", Message: err.Error()}
	}
	cmd.Env = append(cmd.Env, "TZ=UTC")
	out, failure := executeSubscriptionProcess(wait, cmd, false)
	if failure != nil {
		return subscriptionReading{}, failure
	}
	return decodeClaudeSubscription(out)
}

func claudeUsageMissingLogin(text string) bool {
	text = asciiFold(text)
	return strings.Contains(text, "not logged in") || strings.Contains(text, "please run /login")
}

func decodeClaudeSubscription(output subscriptionProcessOutput) (subscriptionReading, *subscriptionFailure) {
	if !output.success && claudeUsageMissingLogin(string(output.stderr)) {
		return subscriptionReading{}, subscriptionError("credentials-missing")
	}
	var value any
	if canonjson.Unmarshal(output.stdout, &value) != nil {
		return subscriptionReading{}, &subscriptionFailure{Code: "request-failed", Message: "Claude Code did not return a /usage result. Check `claude auth status`, then refresh usage."}
	}
	result := value
	if list := arr(value); list != nil {
		result = nil
		for _, message := range slices.Backward(list) {
			if field(message, "type") == "result" {
				result = message
				break
			}
		}
	}
	usage, ok := field(result, "result").(string)
	if !ok {
		return subscriptionReading{}, subscriptionError("invalid-response")
	}
	if claudeUsageMissingLogin(usage) {
		return subscriptionReading{}, subscriptionError("credentials-missing")
	}
	if !output.success || field(result, "is_error") == true {
		runes := []rune(usage)
		return subscriptionReading{}, &subscriptionFailure{Code: "request-failed", Message: "Claude Code /usage: " + string(runes[:min(400, len(runes))])}
	}
	return parseClaudeUsage(usage, time.Now().UTC())
}

var claudeANSI = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
var claudeUsageLine = regexp.MustCompile(`^Current (session|week(?: \(([^)]+)\))?):` + setupSpace + `*([0-9.]+)% used(?:` + setupSpace + `*·` + setupSpace + `*resets (.+))?$`)
var claudeHourOnly = regexp.MustCompile(`(^|[ ,])([0-9]{1,2})(am|pm)$`)

func parseClaudeUsage(text string, now time.Time) (subscriptionReading, *subscriptionFailure) {
	text = claudeANSI.ReplaceAllString(text, "")
	windows := []quotaWindow{}
	for _, row := range strings.Split(text, "\n") {
		captures := claudeUsageLine.FindStringSubmatch(strings.TrimSpace(row))
		if len(captures) == 0 {
			continue
		}
		label, period := "seven_day", 168*time.Hour
		if captures[1] == "session" {
			label, period = "five_hour", 5*time.Hour
		}
		pool := captures[2]
		if pool == "" || asciiFold(pool) == "all models" {
			pool = "subscription"
		}
		id := label + "/" + pool
		if slices.ContainsFunc(windows, func(w quotaWindow) bool { return w.ID == id }) {
			continue
		}
		window, ok := newQuotaWindow(id, pool, label, captures[3], claudeResetTime(captures[4], now, period))
		if !ok {
			continue
		}
		if captures[2] != "" && asciiFold(captures[2]) != "all models" {
			window.Scope = &captures[2]
		}
		windows = append(windows, window)
	}
	if len(windows) == 0 {
		return subscriptionReading{}, &subscriptionFailure{Code: "no-limits-reported", Message: "Claude Code /usage returned no quota windows. Open Claude Code and run /usage, then refresh here."}
	}
	return subscriptionReadingFrom(windows, object{"cliUsage": text})
}

func claudeResetTime(text string, now time.Time, period time.Duration) *string {
	text = strings.TrimSpace(text)
	if strings.HasSuffix(text, ")") {
		index := strings.LastIndex(text, " (")
		if index < 0 || !slices.Contains([]string{"UTC)", "Etc/UTC)", "GMT)"}, text[index+2:]) {
			return nil
		}
		text = text[:index]
	}
	text = strings.NewReplacer("AM", "am", "PM", "pm").Replace(text)
	text = claudeHourOnly.ReplaceAllString(text, "${1}${2}:00${3}")
	format := func(at time.Time) *string { stamp := subscriptionTimestamp(at); return &stamp }
	for _, layout := range []string{"Jan _2, 2006 at 3:04pm", "Jan _2, 2006, 3:04pm"} {
		if at, err := time.Parse(layout, text); err == nil {
			return format(at)
		}
	}
	earliest, latest := now.Add(-24*time.Hour), now.Add(period+2*time.Hour)
	var dates []time.Time
	for year := now.Year() - 1; year <= now.Year()+1; year++ {
		for _, layout := range []string{"2006 Jan _2 at 3:04pm", "2006 Jan _2, 3:04pm"} {
			if at, err := time.Parse(layout, fmt.Sprintf("%d %s", year, text)); err == nil {
				dates = append(dates, at)
			}
		}
	}
	if at, err := time.Parse("3:04pm", text); err == nil {
		for day := -1; day <= 1; day++ {
			date := now.AddDate(0, 0, day)
			dates = append(dates, time.Date(date.Year(), date.Month(), date.Day(), at.Hour(), at.Minute(), 0, 0, time.UTC))
		}
	}
	slices.SortFunc(dates, time.Time.Compare)
	for _, at := range dates {
		if !at.Before(now) && !at.After(latest) {
			return format(at)
		}
	}
	for _, at := range slices.Backward(dates) {
		if !at.Before(earliest) && !at.After(latest) {
			return format(at)
		}
	}
	return nil
}
