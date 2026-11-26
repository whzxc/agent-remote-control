package core

import (
	"slices"
	"strings"
	"unicode"
)

var trackedTranscriptReminders = trackingRegex(`(?is)^(?:\s*<system[-_]reminder(?:\s[^>]*)?>.*?(?:</system[-_]reminder\s*>|\z)\s*)+`)

func trackedTranscriptUserText(record any, value string) string {
	kinds := []string{}
	for _, source := range []any{record, field(record, "message"), field(record, "payload")} {
		for _, key := range []string{"isMeta", "isCompactSummary", "isSynthetic", "isVisibleInTranscriptOnly"} {
			if field(source, key) == true {
				return ""
			}
		}
		for _, kind := range []any{field(field(source, "origin"), "kind"), field(field(source, "source"), "kind"), field(source, "source"), field(source, "promptSource"), field(source, "turnOrigin")} {
			if value, ok := kind.(string); ok {
				kinds = append(kinds, value)
			}
		}
	}
	for _, kind := range kinds {
		if slices.Contains([]string{"system", "harness", "task-notification", "task_notification", "tool", "compaction", "compact-summary", "hook", "hook-output", "local-command", "subagent-notification", "subagent_notification"}, kind) {
			return ""
		}
	}
	value = trackedTranscriptReminders.ReplaceAllString(value, "")
	for _, kind := range kinds {
		if slices.Contains([]string{"human", "user", "user-input", "user_input"}, kind) {
			return value
		}
	}
	if trackedTranscriptHarness(value) {
		return ""
	}
	value = cleanTaskTranscript(value)
	if trackedTranscriptHarness(value) {
		return ""
	}
	return value
}

func trackedTranscriptHarness(value string) bool {
	value = strings.ToLower(strings.TrimLeftFunc(value, unicode.IsSpace))
	rest, ok := strings.CutPrefix(value, "<")
	if !ok {
		return false
	}
	end := strings.IndexFunc(rest, func(r rune) bool { return unicode.IsSpace(r) || r == '>' || r == '/' })
	if end < 0 {
		end = len(rest)
	}
	tag := rest[:end]
	return strings.HasPrefix(tag, "local-command-") || slices.Contains([]string{"task-notification", "command-name", "command-message", "command-args",
		"bash-input", "bash-stdout", "bash-stderr", "subagent_notification", "subagent-notification", "teammate-message", "hook-output", "user-prompt-submit-hook",
		"ide_opened_file", "ide_selection", "turn_aborted", "external_codex_apps_open_page"}, tag) ||
		tag == "task-id" && (strings.Contains(value, "<tool-use-id>") || strings.Contains(value, "<output-file>"))
}
