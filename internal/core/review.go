package core

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const reviewSpace = `[\pZ\t\n\r\f\v\x{85}]`
const reviewWord = `[\pL\pM\p{Nd}\p{Pc}\x{200C}\x{200D}]`

var reviewCheck = regexp.MustCompile(`^` + reviewSpace + `*(?:rtk` + reviewSpace + `+)?(?:(?:npm|pnpm|yarn|bun)` +
	reviewSpace + `+(?:run` + reviewSpace + `+)?(?:test|check|lint|typecheck|type-check|build)(?:` + reviewWord + `|[:-])*|cargo` +
	reviewSpace + `+(?:test|check|clippy|fmt)|node` + reviewSpace + `+--test(?:` + reviewWord + `|[=-])*|(?:npx` +
	reviewSpace + `+)?(?:tsc|eslint|vitest|jest)|(?:python3?` + reviewSpace + `+-m` + reviewSpace + `+)?(?:pytest|unittest)|go` +
	reviewSpace + `+test|dotnet` + reviewSpace + `+test|ctest)`)
var reviewHeredoc = regexp.MustCompile(`<<-?` + reviewSpace + `*['"]?([A-Za-z_][A-Za-z_0-9]*)['"]?`)

func reviewWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsMark(r) || unicode.IsDigit(r) || unicode.Is(unicode.Pc, r) || r == '\u200c' || r == '\u200d'
}

func isReviewCheck(command string) bool {
	match := reviewCheck.FindStringIndex(command)
	if match == nil {
		return false
	}
	end := match[1]
	before, _ := utf8.DecodeLastRuneInString(command[:end])
	after, _ := utf8.DecodeRuneInString(command[end:])
	return reviewWordRune(before) != reviewWordRune(after)
}

func reviewShellClauses(line string) []string {
	result := []string{}
	start := 0
	var quote rune
	escaped := false
	for offset, character := range line {
		switch {
		case escaped:
			escaped = false
		case character == '\\' && quote != '\'':
			escaped = true
		case character == quote:
			quote = 0
		case quote != 0:
		case character == '\'' || character == '"' || character == '`':
			quote = character
		case character == ';' || character == '|' ||
			character == '&' && (strings.HasPrefix(line[offset:], "&&") || offset > 0 && line[offset-1] == '&'):
			result = append(result, strings.TrimSpace(line[start:offset]))
			start = offset + utf8.RuneLen(character)
		}
	}
	return append(result, strings.TrimSpace(line[start:]))
}

func reviewCommand(item any) string {
	scripts := []string{}
	for _, action := range arr(field(item, "commandActions")) {
		if command, found := field(action, "command").(string); found {
			scripts = append(scripts, command)
		}
	}
	if len(scripts) == 0 {
		scripts = append(scripts, text(item, "command"))
	}
	commands := []string{}
	for _, script := range scripts {
		var delimiters []string
		for _, line := range fileTextLines(script) {
			if len(delimiters) > 0 {
				if strings.TrimSpace(line) == delimiters[0] {
					delimiters = delimiters[1:]
				}
				continue
			}
			line = strings.TrimSpace(line)
			line = strings.TrimPrefix(strings.TrimPrefix(line, "/bin/zsh -lc \""), "/bin/sh -lc \"")
			for _, clause := range reviewShellClauses(line) {
				if isReviewCheck(clause) {
					commands = append(commands, clause)
				}
			}
			for _, match := range reviewHeredoc.FindAllStringSubmatch(line, -1) {
				delimiters = append(delimiters, match[1])
			}
		}
	}
	return strings.Join(commands, "; ")
}

func reviewCheckSummary(item any) string {
	lines := []string{}
	for _, line := range fileTextLines(text(item, "aggregatedOutput")) {
		line = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), "ℹ"))
		if strings.HasPrefix(line, "test result:") || strings.HasPrefix(line, "Test policy ") {
			lines = append(lines, line)
			continue
		}
		for _, label := range []string{"tests ", "pass ", "fail ", "cancelled ", "skipped ", "todo "} {
			if count, found := strings.CutPrefix(line, label); found && len(count) != 0 && count[0] >= '0' && count[0] <= '9' {
				lines = append(lines, line)
				break
			}
		}
	}
	if len(lines) != 0 {
		return runeExcerpt(strings.Join(lines, "; "), 240)
	}
	if code := field(item, "exitCode"); code != nil {
		var integer int64
		if unmarshalJSON([]byte(wire(code)), &integer) == nil {
			return fmt.Sprintf("Process exited with code %d; no test summary captured.", integer)
		}
	}
	return "Native command status: " + text(item, "status") + "."
}

func nativeReviewFiles(items []any) []object {
	hasChanges := false
	type count struct {
		added, removed uint64
		unknown        bool
	}
	files := map[string]count{}
	for _, item := range items {
		if field(item, "type") != "fileChange" {
			continue
		}
		hasChanges = true
		if state := field(item, "status"); state == "failed" || state == "declined" {
			continue
		}
		for _, change := range arr(field(item, "changes")) {
			path, found := field(change, "path").(string)
			if !found {
				continue
			}
			total := files[path]
			hunk, known := false, false
			for _, line := range fileTextLines(text(change, "diff")) {
				switch {
				case strings.HasPrefix(line, "@@ "):
					hunk, known = true, true
				case strings.HasPrefix(line, "diff --git "):
					hunk = false
				case hunk && strings.HasPrefix(line, "+"):
					total.added++
				case hunk && strings.HasPrefix(line, "-"):
					total.removed++
				}
			}
			total.unknown = total.unknown || !known
			files[path] = total
		}
	}
	if !hasChanges {
		return nil
	}
	names := make([]string, 0, len(files))
	for path := range files {
		names = append(names, path)
	}
	slices.Sort(names)
	result := make([]object, 0, len(names))
	for _, path := range names {
		total := files[path]
		row := object{"path": path, "added": nil, "removed": nil}
		if !total.unknown {
			row["added"], row["removed"] = total.added, total.removed
		}
		result = append(result, row)
	}
	return result
}

func progressFromCodexTurn(turn any, pendingCount any) object {
	items := arr(field(turn, "items"))
	var assistant any
	foundMessage := false
	checks := make([]object, 0, 3)
	for _, item := range slices.Backward(items) {
		switch field(item, "type") {
		case "agentMessage":
			if !foundMessage {
				assistant, foundMessage = field(item, "text"), true
			}
		case "commandExecution":
			if command := reviewCommand(item); command != "" && len(checks) < 3 {
				checks = append(checks, object{"command": runeExcerpt(command, 240), "exitCode": field(item, "exitCode"),
					"status": field(item, "status"), "summary": reviewCheckSummary(item)})
			}
		}
	}
	slices.Reverse(checks)
	var latest any
	cropped := false
	if text, known := assistant.(string); known {
		latest = runeExcerpt(text, 480)
		cropped = latest != text
	}
	return object{"turnId": field(turn, "id"), "latestAgentMessage": latest, "messageTruncated": cropped, "latestChecks": checks,
		"pendingInteractionCount": pendingCount, "commits": nil, "elapsedMs": nil, "observedAt": now()}
}

func readCodexTurnPage(ctx context.Context, s *service, args object) (object, error) {
	selected, pinned := args["turnId"].(string)
	cursor := args["cursor"]
	limit := uintOr(args["limit"], 1)
	if pinned {
		limit = 100
	}
	for {
		value, err := requestCodexNative(ctx, s, "thread/turns/list", object{"threadId": args["threadId"], "cursor": cursor,
			"limit": limit, "sortDirection": "desc", "itemsView": "full"}, time.Minute)
		if err != nil {
			return nil, err
		}
		page := obj(value)
		if !pinned {
			return page, nil
		}
		for _, turn := range arr(page["data"]) {
			if field(turn, "id") == selected {
				return object{"data": []any{turn}, "nextCursor": nil}, nil
			}
		}
		next := page["nextCursor"]
		if next == nil {
			return nil, errors.New("TURN_NOT_FOUND: read codex_read without turnId to discover current turns")
		}
		if wire(next) == wire(cursor) {
			return nil, errors.New("NATIVE_CURSOR_REPEATED: cannot resolve the requested turn")
		}
		cursor = next
	}
}
