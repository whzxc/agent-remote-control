package core

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

const taskMaxEntries = 2000
const taskMaxBytes = 8 * 1024 * 1024
const taskMaxText = 256 * 1024
const taskSummaryBytes = 1024

func firstTaskValue(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func firstTaskText(values ...any) string {
	for _, value := range values {
		if text, ok := value.(string); ok {
			return text
		}
	}
	return ""
}

func nonemptyTaskText(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func trackedCodexTitle(thread any) *string {
	spawn := field(field(field(thread, "source"), "subAgent"), "thread_spawn")
	for _, name := range []string{text(thread, "agentNickname"), text(spawn, "agent_nickname"), text(thread, "name")} {
		if name = strings.TrimSpace(name); name != "" {
			return &name
		}
	}
	return nil
}

const rustSpace = `\t-\r \x{85}\p{Z}`

// Rust regex uses Unicode whitespace. Keep its class semantics in RE2.
func trackingRegex(pattern string) *regexp.Regexp {
	var compiled strings.Builder
	inClass := false
	for i := 0; i < len(pattern); i++ {
		switch pattern[i] {
		case '\\':
			if i+1 < len(pattern) {
				i++
				if pattern[i] == 's' || pattern[i] == 'S' {
					if !inClass {
						compiled.WriteByte('[')
					}
					if pattern[i] == 'S' {
						compiled.WriteByte('^')
					}
					compiled.WriteString(rustSpace)
					if !inClass {
						compiled.WriteByte(']')
					}
				} else {
					compiled.WriteByte('\\')
					compiled.WriteByte(pattern[i])
				}
				continue
			}
		case '[':
			inClass = true
		case ']':
			inClass = false
		}
		compiled.WriteByte(pattern[i])
	}
	return regexp.MustCompile(compiled.String())
}

var taskPrivateKey = trackingRegex(`(?is)-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----.*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|\z)`)
var taskAuthorization = trackingRegex(`(?i)(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+`)
var taskTokens = trackingRegex(`(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)`)
var taskSecretAssignment = trackingRegex(`(?i)(?:[A-Z0-9_]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|cookie)[A-Z0-9_]*|token)\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)`)
var taskSecretURL = trackingRegex(`(?i)https?://[^\s/@:]+:[^\s/@]+@`)

func taskWord(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsMark(r) || unicode.IsDigit(r) || unicode.In(r, unicode.Other_Alphabetic, unicode.Pc, unicode.Join_Control, unicode.Nl)
}

func replaceTaskTokens(value string, pattern *regexp.Regexp, endBoundary bool) string {
	var result strings.Builder
	beginning := 0
	for _, position := range pattern.FindAllStringIndex(value, -1) {
		start, end := position[0], position[1]
		previous, _ := utf8.DecodeLastRuneInString(value[:start])
		next, _ := utf8.DecodeRuneInString(value[end:])
		last, _ := utf8.DecodeLastRuneInString(value[start:end])
		if taskWord(previous) || endBoundary && taskWord(last) == taskWord(next) {
			continue
		}
		result.WriteString(value[beginning:start])
		result.WriteString("[REDACTED]")
		beginning = end
	}
	result.WriteString(value[beginning:])
	return result.String()
}

func redactTaskOutput(value string) string {
	value = taskPrivateKey.ReplaceAllString(value, "[REDACTED]")
	value = replaceTaskTokens(value, taskAuthorization, false)
	value = replaceTaskTokens(value, taskTokens, true)
	value = taskSecretAssignment.ReplaceAllString(value, "[REDACTED]")
	return taskSecretURL.ReplaceAllString(value, "[REDACTED]")
}

func taskSecretKey(key string) bool {
	key = strings.NewReplacer("-", "", "_", "").Replace(strings.ToLower(key))
	return slices.ContainsFunc([]string{"password", "passwd", "secret", "token", "apikey", "authorization", "cookie", "privatekey", "credential"}, func(part string) bool { return strings.Contains(key, part) })
}

func sanitizeTaskValue(value any) any {
	switch v := value.(type) {
	case object:
		result := object{}
		for key, item := range v {
			if taskSecretKey(key) {
				result[key] = "[REDACTED]"
			} else {
				result[key] = sanitizeTaskValue(item)
			}
		}
		return result
	case []any:
		result := make([]any, len(v))
		for i, item := range v {
			result[i] = sanitizeTaskValue(item)
		}
		return result
	case string:
		return redactTaskOutput(v)
	default:
		return v
	}
}

func cutTaskText(value string, limit int) (string, bool) {
	end := min(len(value), limit)
	for end < len(value) && !utf8.RuneStart(value[end]) {
		end--
	}
	return value[:end], end < len(value)
}

func boundedTaskText(value string, limit int) string {
	text, _ := cutTaskText(redactTaskOutput(value), limit)
	return text
}

const transcriptBlockNames = `system-reminder|system_reminder|environment_context|environment_details|image_resize_notice|total_tokens|token_budget|instructions|INSTRUCTIONS|app-context|permissions instructions|collaboration_mode|skills_instructions`

var transcriptBlocks = trackingRegex(`(?is)<(?:` + transcriptBlockNames + `)(?:\s[^>]*)?>.*?(?:</(?:` + transcriptBlockNames + `)>|\z)`)
var transcriptTagLine = trackingRegex(`^\s*(?:</?[A-Za-z_][^>]*>\s*)+$`)

func cleanTaskTranscript(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "# AGENTS.md instructions") || strings.HasPrefix(value, "<INSTRUCTIONS>") {
		return ""
	}
	raw := transcriptBlocks.ReplaceAllString(value, "")
	lines := []string{}
	for line := range strings.Lines(raw) {
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if !transcriptTagLine.MatchString(line) {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "\n")
}

var taskHeadlineRules = []struct {
	pattern     *regexp.Regexp
	replacement string
}{
	{trackingRegex(`!?\[([^]\n]+)\]\([^\n)]*(?:\([^\n)]*\)[^\n)]*)*\)`), "$1"},
	{trackingRegex(`!?\[([^]\n]+)\]\[[^]\n]*\]`), "$1"},
	{trackingRegex(`<((?:https?://|mailto:)[^>\s]+)>`), "$1"},
	{trackingRegex(`(?m)^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|[0-9]+[.)]\s+)`), ""},
	{trackingRegex(`(?m)\s+#+\s*$`), ""},
	{regexp.MustCompile("\\*\\*|__|~~|`+"), ""},
	{trackingRegex(`\*([^*\s][^*\n]*?)\*`), "$1"},
	{trackingRegex(`(^|[\s(])_([^_\s][^_\n]*?)_($|[\s).,!?:;。！？])`), "${1}${2}${3}"},
	{trackingRegex(`(?m)^\s*[*_]([^\s])`), "$1"},
}

func taskHeadline(kind, value string) string {
	if kind == "text" || kind == "thinking" {
		for _, rule := range taskHeadlineRules {
			value = rule.pattern.ReplaceAllString(value, rule.replacement)
		}
	}
	value = strings.TrimSpace(value)
	line := ""
	if kind == "text" {
		const punctuation = ".!?。！？"
		prefix := strings.TrimRight(value, punctuation)
		start := 0
		for index, r := range prefix {
			width := utf8.RuneLen(r)
			next, _ := utf8.DecodeRuneInString(prefix[index+width:])
			if r == '\n' || strings.ContainsRune(punctuation, r) && (r != '.' || unicode.IsSpace(next)) {
				start = index + width
			}
		}
		line = strings.TrimSpace(value[start:])
	} else {
		for _, part := range slices.Backward(strings.Split(value, "\n")) {
			if strings.TrimSpace(part) != "" {
				line = part
				break
			}
		}
	}
	return boundedTaskText(line, taskSummaryBytes)
}

func summarizeTaskValue(value any) object {
	clean := sanitizeTaskValue(value)
	if text, ok := clean.(string); ok {
		return contextExcerpt(text)
	}
	return contextExcerpt(wire(clean))
}

func contentOfTaskValue(value any) string {
	switch raw := value.(type) {
	case string:
		return raw
	case []any:
		parts := []string{}
		for _, item := range raw {
			if text := contentOfTaskValue(item); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	case object:
		for _, key := range []string{"text", "thinking", "content", "output", "summary"} {
			if raw[key] != nil {
				return contentOfTaskValue(raw[key])
			}
		}
	}
	return ""
}

func taskInt(value any) (int64, bool) {
	switch value := value.(type) {
	case json.Number:
		n, err := value.Int64()
		return n, err == nil
	case int:
		return int64(value), true
	case int64:
		return value, true
	case uint64:
		if value <= 1<<63-1 {
			return int64(value), true
		}
	}
	return 0, false
}

func taskExitCode(raw any, output string) (int64, bool) {
	for _, key := range []string{"exitCode", "exit_code"} {
		for _, value := range []any{field(raw, key), field(field(raw, "details"), key)} {
			if code, ok := taskInt(value); ok {
				return code, true
			}
		}
	}
	for _, line := range slices.Backward(strings.Split(output, "\n")) {
		for _, marker := range []string{"Process exited with code ", "Exit code: ", "exit code: ", "Exit Code: "} {
			if raw, ok := strings.CutPrefix(strings.TrimSpace(line), marker); ok {
				if code, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64); err == nil {
					return code, true
				}
			}
		}
	}
	return 0, false
}

func trackedToolKind(kind, name string, input any) (string, string) {
	switch kind {
	case "execute":
		return "command", ""
	case "read", "search":
		return "file", "read"
	case "edit":
		return "file", "edit"
	case "delete", "move":
		return "file", ""
	case "", "other":
	default:
		return "tool", ""
	}
	name = strings.ToLower(name)
	if index := strings.LastIndexAny(name, "/.:"); index >= 0 {
		name = name[index+1:]
	}
	if index := strings.LastIndex(name, "__"); index >= 0 {
		name = name[index+2:]
	}
	_, command := field(input, "command").(string)
	_, cmd := field(input, "cmd").(string)
	if command || cmd || slices.Contains([]string{"bash", "shell", "exec_command", "run_command", "terminal"}, name) {
		return "command", ""
	}
	switch name {
	case "read", "read_file", "readfile", "cat", "glob", "grep":
		return "file", "read"
	case "write", "write_file", "writefile":
		return "file", "write"
	case "create", "create_file":
		return "file", "create"
	case "edit", "edit_file", "editfile", "apply_patch", "str_replace", "multiedit":
		return "file", "edit"
	}
	if _, ok := field(input, "file_path").(string); ok {
		return "file", ""
	}
	return "tool", ""
}

func parseTrackedInput(value any) any {
	if raw, ok := value.(string); ok {
		var result any
		if unmarshalJSON([]byte(raw), &result) == nil {
			return result
		}
	}
	return value
}

func normalizeTrackedInput(row object, value, locations any) {
	input := obj(parseTrackedInput(value))
	for _, keys := range [][]string{{"command", "command", "cmd"}, {"cwd", "cwd", "workdir"}, {"path", "file_path", "path", "filePath"}} {
		for _, key := range keys[1:] {
			if value, ok := input[key].(string); ok {
				row[keys[0]] = boundedTaskText(value, taskSummaryBytes)
				break
			}
		}
	}
	paths := []string{}
	addPath := func(value any) {
		if path, ok := value.(string); ok && len(paths) < 100 {
			path = boundedTaskText(path, taskSummaryBytes)
			if !slices.Contains(paths, path) {
				paths = append(paths, path)
			}
		}
	}
	addPath(row["path"])
	for _, path := range arr(input["paths"]) {
		addPath(path)
	}
	for _, location := range arr(locations) {
		addPath(field(location, "path"))
	}
	if len(paths) > 0 {
		row["path"], row["paths"] = paths[0], paths
	}
	edits := arr(input["edits"])
	if edits == nil {
		edits = []any{input}
	}
	changes := []object{}
	for _, edit := range edits[:min(100, len(edits))] {
		old := firstTaskValue(field(edit, "old_string"), field(edit, "oldText"))
		next := firstTaskValue(field(edit, "new_string"), field(edit, "newText"))
		if next == nil && (row["operation"] == "write" || row["operation"] == "create") {
			next = field(edit, "content")
		}
		if old == nil && next == nil {
			continue
		}
		change := object{}
		if old != nil {
			change["oldText"] = summarizeTaskValue(old)
		}
		if next != nil {
			change["newText"] = summarizeTaskValue(next)
		}
		changes = append(changes, change)
	}
	if len(changes) > 0 {
		row["edits"] = changes
	}
}

func trackedFileChange(change any) object {
	row := object{"path": boundedTaskText(text(change, "path"), taskSummaryBytes), "operation": nil}
	if op := map[string]string{"add": "create", "update": "edit", "delete": "delete"}[text(field(change, "kind"), "type")]; op != "" {
		row["operation"] = op
	}
	if diff := text(change, "diff"); diff != "" {
		row["diff"] = summarizeTaskValue(diff)
		hunk, known := false, false
		added, removed := 0, 0
		for line := range strings.Lines(diff) {
			switch {
			case strings.HasPrefix(line, "@@ "):
				hunk, known = true, true
			case strings.HasPrefix(line, "diff --git "):
				hunk = false
			case hunk && strings.HasPrefix(line, "+"):
				added++
			case hunk && strings.HasPrefix(line, "-"):
				removed++
			}
		}
		if known {
			row["added"], row["removed"] = added, removed
		}
	}
	return row
}

type taskTextChunk struct{ id, kind string }
type taskTimeline struct {
	Entries                 []object          `json:"entries"`
	Revision                uint64            `json:"revision"`
	Bytes                   int               `json:"bytes"`
	Partial                 bool              `json:"partial"`
	ObservedEvents          uint64            `json:"observedEvents"`
	ToolObserved            bool              `json:"toolObserved"`
	OmittedSidechainRecords uint64            `json:"omittedSidechainRecords"`
	Info                    object            `json:"info"`
	Status                  string            `json:"status"`
	Turn                    string            `json:"turn"`
	TurnDispatchSummaries   map[string]object `json:"turnDispatchSummaries"`
	TurnTimings             map[string]object `json:"turnTimings"`
	TurnStatuses            map[string]string `json:"turnStatuses"`
	TurnLifecycles          map[string]any    `json:"turnLifecycles"`
	TurnStartedAt           *string           `json:"turnStartedAt"`
	PiMessage               uint64            `json:"piMessage"`
	PiStopReason            string            `json:"piStopReason"`
	PiError                 any               `json:"piError"`
	HistoryLoaded           bool              `json:"-"`
	ObservationLost         bool              `json:"-"`
	Unsubscribed            bool              `json:"-"`
	chunk                   *taskTextChunk
	buffers                 map[string]string
	transcript              taskCodexTranscript
}

type taskTimelineWire taskTimeline

func (t taskTimeline) MarshalJSON() ([]byte, error) {
	t.init()
	return canonjson.Marshal(taskTimelineWire(t))
}

func (t *taskTimeline) init() {
	if t.Entries == nil {
		t.Entries = []object{}
	}
	if t.TurnDispatchSummaries == nil {
		t.TurnDispatchSummaries = map[string]object{}
	}
	if t.TurnTimings == nil {
		t.TurnTimings = map[string]object{}
	}
	if t.TurnLifecycles == nil {
		t.TurnLifecycles = map[string]any{}
	}
	if t.TurnStatuses == nil {
		t.TurnStatuses = map[string]string{}
	}
	if t.buffers == nil {
		t.buffers = map[string]string{}
	}
}

func (t *taskTimeline) lifecycle(turn string) any {
	if checkpoint := t.TurnLifecycles[turn]; checkpoint != nil {
		return checkpoint
	}
	if status := t.TurnStatuses[turn]; status != "" {
		return status
	}
	if t.Turn == turn {
		return t.Status
	}
	return nil
}

func trackedTurnStatus(checkpoint any) string {
	if cp := obj(checkpoint); cp != nil {
		terminal := coordinationCheckpointTerminal(cp)
		if terminal != "" {
			if terminal == "interrupted" {
				return "cancelled"
			}
			return terminal
		}
		if len(arr(cp["terminals"])) > 0 {
			return "unknown"
		}
		checkpoint = field(cp["owner"], "state")
	}
	switch str(checkpoint) {
	case "inProgress", "running", "in_progress", "active", "starting", "cancelling":
		return "running"
	case "waiting-permission", "interaction-required":
		return "waiting-permission"
	case "completed", "failed", "cancelled":
		return str(checkpoint)
	case "interrupted":
		return "cancelled"
	default:
		return "unknown"
	}
}

func trackedTurnEnded(checkpoint any) bool {
	if len(arr(field(checkpoint, "terminals"))) > 0 {
		return true
	}
	return slices.Contains([]string{"completed", "failed", "cancelled", "interrupted"}, str(checkpoint))
}
func (t *taskTimeline) turnStatus(turn string) string {
	if turn == "" || t.Turn != turn && t.TurnLifecycles[turn] == nil && t.TurnStatuses[turn] == "" {
		return ""
	}
	return trackedTurnStatus(t.lifecycle(turn))
}

func trackedCheckpoint(agent, thread, turn, status string, revision uint64) object {
	terminals := []any{}
	var owner, lastLive any
	switch normalized := trackedTurnStatus(status); normalized {
	case "completed", "failed", "cancelled", "interrupted":
		if normalized == "cancelled" {
			normalized = "interrupted"
		}
		terminals = append(terminals, object{"status": normalized, "sequence": nil})
	case "running", "waiting-permission":
		if normalized == "waiting-permission" {
			normalized = "interaction-required"
		}
		reason := "native-turn-active"
		if normalized == "interaction-required" {
			reason = "native-interaction"
		}
		owner = object{"revision": revision, "state": normalized, "reason": reason}
		lastLive = object{"revision": revision, "state": normalized}
	default:
		owner = object{"revision": revision, "state": "unconfirmed", "reason": "runtime-ownership-unknown"}
	}
	return object{"agent": agent, "threadId": thread, "turnId": turn, "terminals": terminals, "owner": owner, "lastLive": lastLive}
}

func (t *taskTimeline) recordStatus(status string, native object) {
	if t.Turn == "" {
		t.Status = status
		return
	}
	t.init()
	old := t.TurnLifecycles[t.Turn]
	if old == nil {
		old = t.TurnStatuses[t.Turn]
	}
	revision := max(t.ObservedEvents+1, uintOr(field(field(old, "owner"), "revision"), 0)+1)
	agent := nonemptyTaskText(text(t.Info, "agent"), "codex")
	incoming := native
	if incoming == nil {
		incoming = trackedCheckpoint(agent, text(t.Info, "id"), t.Turn, status, revision)
	}
	if checkpoint := obj(old); checkpoint != nil {
		link := bulletinLink{ThreadID: text(t.Info, "id"), ObservedTurnID: new(t.Turn), Terminals: map[string]any{t.Turn: old}}
		mergeBulletinLink(&link, t.Turn, status, incoming)
		incoming = obj(link.Terminals[t.Turn])
		if incoming["lastLive"] == nil {
			incoming["lastLive"] = checkpoint["lastLive"]
		}
	} else if trackedTurnEnded(old) {
		link := bulletinLink{ThreadID: text(t.Info, "id"), ObservedTurnID: new(t.Turn), Terminals: map[string]any{t.Turn: trackedCheckpoint(agent, text(t.Info, "id"), t.Turn, str(old), 0)}}
		mergeBulletinLink(&link, t.Turn, status, incoming)
		incoming = obj(link.Terminals[t.Turn])
	}
	t.TurnLifecycles[t.Turn] = incoming
	t.Status = trackedTurnStatus(incoming)
	if status == "inProgress" && t.Status == "running" {
		t.Status = status
	}
	t.TurnStatuses[t.Turn] = trackedTurnStatus(incoming)
}

func (t *taskTimeline) loseObservation() {
	t.ObservationLost = true
	t.HistoryLoaded = false
	t.recordStatus("unknown", nil)
}

func (t *taskTimeline) existing(id string) (int, object) {
	for index, row := range t.Entries {
		if row["id"] == id {
			return index, row
		}
	}
	return -1, nil
}

func (t *taskTimeline) entry(id, kind, status string) object {
	_, old := t.existing(id)
	row := maps.Clone(old)
	if row == nil {
		row = object{"id": id, "type": kind}
	}
	row["status"] = status
	return row
}

func (t *taskTimeline) put(row object, at string) {
	t.init()
	t.Partial = t.Partial || row["truncated"] == true
	index, old := t.existing(text(row, "id"))
	started, hasStart := old["startedAt"]
	if !hasStart {
		started = at
	}
	row["startedAt"], row["updatedAt"] = started, at
	if row["position"] == nil {
		row["position"] = old["position"]
		if row["position"] == nil {
			if index >= 0 {
				row["position"] = index
			} else {
				row["position"] = t.Revision + 1
			}
		}
	}
	if _, ok := row["turnId"].(string); !ok {
		row["turnId"] = t.Turn
	}
	if (row["status"] == "running" || row["status"] == "pending") && trackedTurnEnded(t.lifecycle(text(row, "turnId"))) {
		row["status"] = "unknown"
		if slices.Contains([]string{"text", "thinking", "user"}, text(row, "type")) {
			row["status"] = "completed"
		}
	}
	if slices.Contains([]string{"completed", "failed", "cancelled", "unknown"}, text(row, "status")) {
		ended, exists := old["endedAt"]
		if !exists {
			ended = at
		}
		row["endedAt"] = ended
	}
	if old != nil {
		comparison := maps.Clone(row)
		comparison["updatedAt"], comparison["cursor"] = old["updatedAt"], old["cursor"]
		if wire(comparison) == wire(old) {
			return
		}
	}
	if t.Bytes == 0 && len(t.Entries) > 0 {
		for _, row := range t.Entries {
			t.Bytes += len(wire(row))
		}
	}
	t.Revision++
	row["cursor"] = t.Revision
	t.Bytes += len(wire(row))
	if index >= 0 {
		t.Bytes = max(0, t.Bytes-len(wire(t.Entries[index])))
		t.Entries[index] = row
	} else {
		t.Entries = append(t.Entries, row)
	}
	for len(t.Entries) > taskMaxEntries || t.Bytes > taskMaxBytes {
		removed := t.Entries[0]
		t.Bytes = max(0, t.Bytes-len(wire(removed)))
		delete(t.buffers, text(removed, "id"))
		t.Entries[0] = nil
		t.Entries = t.Entries[1:]
		t.Partial = true
	}
}

func (t *taskTimeline) endChunk(at string) {
	if t.chunk == nil {
		return
	}
	row := t.entry(t.chunk.id, t.chunk.kind, "completed")
	delete(t.buffers, t.chunk.id)
	t.chunk = nil
	t.put(row, at)
}

func (t *taskTimeline) addChunk(kind, delta, at string) {
	if t.chunk != nil && t.chunk.kind != kind {
		t.endChunk(at)
	}
	if t.chunk == nil {
		t.chunk = &taskTextChunk{fmt.Sprintf("%s:chunk:%d", t.Turn, t.Revision+1), kind}
	}
	t.delta(t.chunk.id, kind, delta, at)
}

func (t *taskTimeline) delta(id, kind, delta, at string) {
	t.init()
	raw := t.buffers[id] + delta
	// Redact before clipping so an overlong value cannot leave a secret prefix.
	text, truncated := cutTaskText(redactTaskOutput(raw), taskMaxText)
	t.buffers[id], _ = cutTaskText(raw, taskMaxText)
	row := t.entry(id, kind, "running")
	row["type"], row["truncated"] = kind, truncated || len(raw) > taskMaxText || row["truncated"] == true
	if kind == "command" {
		row["output"] = summarizeTaskValue(text)
	} else {
		row["text"] = text
	}
	t.put(row, at)
}

func (t *taskTimeline) timing() object {
	t.init()
	if t.TurnTimings[t.Turn] == nil {
		t.TurnTimings[t.Turn] = object{}
	}
	return t.TurnTimings[t.Turn]
}
func (t *taskTimeline) startTurn(at string) {
	if t.Turn == "" || trackedTurnEnded(t.lifecycle(t.Turn)) {
		return
	}
	timing := t.timing()
	if _, ok := timing["startedAt"].(string); !ok {
		timing["startedAt"] = at
	}
	delete(timing, "endedAt")
}
func (t *taskTimeline) finish(status, at string) {
	t.recordStatus(status, nil)
	t.settle(at)
}
func (t *taskTimeline) settle(at string) {
	if t.Turn != "" {
		timing := t.timing()
		if _, ok := timing["startedAt"].(string); !ok {
			timing["startedAt"] = t.TurnStartedAt
		}
		if _, ok := timing["endedAt"].(string); !ok {
			timing["endedAt"] = at
		}
	}
	t.endChunk(at)
	clear(t.buffers)
	ids := []string{}
	for _, row := range t.Entries {
		if row["turnId"] == t.Turn && (row["status"] == "pending" || row["status"] == "running") {
			ids = append(ids, text(row, "id"))
		}
	}
	status := "unknown"
	if t.Status == "cancelled" {
		status = "cancelled"
	}
	for _, id := range ids {
		t.put(t.entry(id, "tool", status), at)
	}
}

func (t *taskTimeline) notice(id, kind, stage string, native any, at string) {
	t.endChunk(at)
	if id == "" {
		id = fmt.Sprintf("%s:notice:%d", t.Turn, t.Revision+1)
	}
	row := t.entry(id, "notice", "completed")
	if turn, ok := field(native, "turnId").(string); ok {
		row["turnId"] = turn
	}
	notice := maps.Clone(obj(row["notice"]))
	if notice == nil {
		notice = object{}
	}
	notice["kind"], notice["stage"] = kind, stage
	projection := selectFields(native, "attempt", "maxAttempts", "title", "severity", "success", "aborted")
	projection["message"] = firstTaskValue(field(native, "errorMessage"), field(native, "finalError"), field(native, "message"), field(field(native, "error"), "message"), field(native, "description"))
	projection["nativeStatus"] = field(native, "status")
	projection["trigger"] = firstTaskValue(field(native, "trigger"), field(native, "reason"))
	projection["tokensBefore"] = firstTaskValue(field(native, "preTokens"), field(native, "tokensBefore"), field(field(native, "result"), "tokensBefore"))
	projection["tokensAfter"] = firstTaskValue(field(native, "tokensAfter"), field(field(native, "result"), "tokensAfter"))
	for key, value := range projection {
		if value == nil {
			continue
		}
		if value, ok := value.(string); ok {
			bounded, truncated := cutTaskText(redactTaskOutput(value), taskSummaryBytes)
			if truncated {
				row["truncated"] = true
			}
			notice[key] = bounded
		} else {
			notice[key] = value
		}
	}
	row["notice"] = notice
	t.put(row, at)
}

func (t *taskTimeline) failure(err any, at string) {
	t.put(object{"id": fmt.Sprintf("%s:error:%d", t.Turn, t.Revision+1), "type": "error", "status": "failed", "text": summarizeTaskValue(err)["text"]}, at)
}

func taskPlan(value any) []object {
	entries := []object{}
	rows := arr(value)
	for _, row := range rows[:min(100, len(rows))] {
		entries = append(entries, object{"content": summarizeTaskValue(firstTaskValue(field(row, "content"), field(row, "step"))), "status": field(row, "status"), "priority": field(row, "priority")})
	}
	return entries
}

func (t *taskTimeline) tool(update any, at string) {
	id := text(update, "toolCallId")
	if id == "" {
		t.Partial = true
		return
	}
	t.ToolObserved = true
	status := text(update, "status")
	switch status {
	case "in_progress", "inProgress":
		status = "running"
	case "pending", "running", "completed", "failed", "cancelled", "unknown":
	default:
		_, prior := t.existing(id)
		status = nonemptyTaskText(text(prior, "status"), "running")
	}
	row := t.entry(id, "tool", status)
	raw := field(update, "rawInput")
	input := parseTrackedInput(raw)
	if input != nil || field(update, "kind") != nil || field(update, "title") != nil {
		name := firstTaskText(field(update, "title"), field(update, "name"))
		kind, op := trackedToolKind(text(update, "kind"), name, input)
		if kind != "tool" || row["type"] == "tool" {
			row["type"] = kind
		}
		if op != "" {
			row["operation"] = op
		}
		if name != "" {
			row["title"] = boundedTaskText(name, taskSummaryBytes)
		}
		if input != nil {
			row["input"] = summarizeTaskValue(raw)
		}
		normalizeTrackedInput(row, input, field(update, "locations"))
		if row["command"] == nil && kind == "command" && name != "" {
			row["command"] = row["title"]
		}
	}
	if row["type"] == "command" && row["cwd"] == nil {
		if cwd, ok := t.Info["project"].(string); ok {
			row["cwd"] = boundedTaskText(cwd, taskSummaryBytes)
		}
	}
	output := field(update, "rawOutput")
	if output != nil || field(update, "content") != nil {
		visible := nonemptyTaskText(contentOfTaskValue(field(update, "content")), contentOfTaskValue(output))
		if visible == "" && output != nil {
			visible = wire(output)
		}
		row["output"] = summarizeTaskValue(visible)
		if code, ok := taskExitCode(output, ""); ok {
			row["exitCode"], row["exitCodeSource"] = code, "rawOutput"
		} else if row["exitCodeSource"] != "rawOutput" {
			if code, ok := taskExitCode(nil, visible); ok {
				row["exitCode"], row["exitCodeSource"] = code, "output"
			}
		}
	}
	t.put(row, at)
}

func (t *taskTimeline) codexItem(item any, status, at string) {
	id := text(item, "id")
	if id == "" {
		t.Partial = true
		return
	}
	var kind string
	switch raw := text(item, "type"); raw {
	case "userMessage", "steeringUserMessage":
		kind = "user"
	case "agentMessage":
		kind = "text"
	case "reasoning":
		kind = "thinking"
	case "commandExecution":
		kind = "command"
	case "fileChange":
		kind = "file"
	case "plan", "error":
		kind = raw
	case "mcpToolCall", "dynamicToolCall", "webSearch", "imageGeneration", "collabAgentToolCall":
		kind = "tool"
	case "contextCompaction":
		stage := "end"
		if status == "running" {
			stage = "start"
		}
		t.notice(id, "compaction", stage, item, at)
		return
	case "enteredReviewMode", "exitedReviewMode":
		return
	default:
		t.Partial = true
		return
	}
	row := t.entry(id, kind, status)
	row["type"] = kind
	if phase, ok := field(item, "phase").(string); kind == "text" && ok {
		row["phase"] = phase
	}
	if _, ok := taskInt(field(item, "durationMs")); ok {
		row["durationMs"] = field(item, "durationMs")
	}
	switch kind {
	case "user", "text", "thinking":
		value := firstTaskValue(field(item, "content"), field(item, "input"))
		if kind == "text" {
			value = field(item, "text")
		} else if kind == "thinking" {
			value = field(item, "summary")
		}
		row["text"], row["truncated"] = cutTaskText(redactTaskOutput(contentOfTaskValue(value)), taskMaxText)
	case "command":
		t.ToolObserved = true
		for _, key := range []string{"command", "cwd"} {
			row[key] = boundedTaskText(text(item, key), taskSummaryBytes)
		}
		row["output"] = summarizeTaskValue(firstTaskValue(field(item, "aggregatedOutput"), ""))
		if actions := arr(field(item, "commandActions")); actions != nil {
			row["commandActions"] = sanitizeTaskValue(actions)
		}
		if code, ok := taskInt(field(item, "exitCode")); ok {
			row["exitCode"] = code
		}
	case "file":
		t.ToolObserved = true
		changes, paths := []object{}, []any{}
		for _, change := range arr(field(item, "changes")) {
			projected := trackedFileChange(change)
			changes, paths = append(changes, projected), append(paths, projected["path"])
		}
		row["path"] = nil
		if len(changes) > 0 {
			row["path"] = changes[0]["path"]
			if changes[0]["operation"] != nil {
				row["operation"] = changes[0]["operation"]
			}
		}
		row["paths"], row["changes"] = paths, changes
	case "plan":
		if arr(field(item, "plan")) != nil {
			row["plan"] = taskPlan(field(item, "plan"))
		} else {
			row["plan"] = []object{{"content": summarizeTaskValue(field(item, "text")), "status": status}}
		}
	case "error":
		row["text"] = summarizeTaskValue(item)["text"]
	case "tool":
		t.ToolObserved = true
		name := text(item, "tool")
		input := parseTrackedInput(field(item, "arguments"))
		kind, op := trackedToolKind("", name, input)
		row["title"], row["type"], row["input"] = name, kind, summarizeTaskValue(field(item, "arguments"))
		if op != "" {
			row["operation"] = op
		}
		normalizeTrackedInput(row, input, nil)
		row["output"] = summarizeTaskValue(field(item, "result"))
	}
	delete(t.buffers, id)
	t.put(row, at)
}

func (t *taskTimeline) codex(method string, params any, at string) {
	t.ObservedEvents++
	turn := firstTaskText(field(params, "turnId"), field(field(params, "turn"), "id"))
	selected, status, started := t.Turn, t.Status, t.TurnStartedAt
	if turn != "" {
		t.Status = nonemptyTaskText(t.turnStatus(turn), "unknown")
		t.Turn = turn
	}
	switch method {
	case "turn/started":
		if selected != turn || t.TurnStartedAt == nil {
			t.TurnStartedAt = &at
		}
		t.recordStatus("running", nil)
		t.startTurn(at)
	case "turn/completed":
		incoming := field(params, "turn")
		t.recordStatus(text(incoming, "status"), obj(field(incoming, "_turnLifecycle")))
		t.settle(at)
	case "item/started", "item/completed":
		item := field(params, "item")
		state := "running"
		if method == "item/completed" {
			state = "completed"
		}
		if value := text(item, "status"); value == "failed" || value == "declined" {
			state = "failed"
		}
		t.codexItem(item, state, at)
	case "item/agentMessage/delta", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/commandExecution/outputDelta":
		kind := "text"
		if strings.Contains(method, "reasoning") {
			kind = "thinking"
		} else if strings.Contains(method, "commandExecution") {
			kind = "command"
		}
		t.delta(text(params, "itemId"), kind, text(params, "delta"), at)
	case "turn/plan/updated":
		t.put(object{"id": t.Turn + ":plan", "type": "plan", "status": "completed", "plan": taskPlan(field(params, "plan"))}, at)
	case "thread/compacted":
		t.notice("", "compaction", "end", params, at)
	case "warning":
		t.notice("", "warning", "message", params, at)
	case "error":
		if field(params, "willRetry") == true {
			t.notice("", "retry", "start", params, at)
		} else {
			t.failure(params, at)
		}
	}
	if turn != "" && selected != "" && turn != selected && method != "turn/started" {
		t.Turn, t.Status, t.TurnStartedAt = selected, status, started
	}
}

func taskEntryHeadline(item object) string {
	kind := text(item, "type")
	key := map[string]string{"command": "command", "file": "path", "tool": "title"}[kind]
	if key == "" {
		key = "text"
	}
	return taskHeadline(kind, text(item, key))
}

func (t *taskTimeline) executionEvidence() any {
	if t.Partial {
		return "partial"
	}
	return t.ToolObserved
}

func (t *taskTimeline) evidence(turn *string) []any {
	rows := []any{}
	for _, row := range t.Entries {
		if (row["type"] == "command" || row["type"] == "file") && (turn == nil || row["turnId"] == *turn) {
			rows = append(rows, clone(row))
		}
	}
	return rows
}

var taskTrackingDispatchRecords func(string) ([]object, error)
var taskTrackingDecorateSource func(object)

func taskTrackingSummaries(session string, native map[string]object) map[string]object {
	summaries := maps.Clone(native)
	if summaries == nil {
		summaries = map[string]object{}
	}
	if taskTrackingDispatchRecords == nil {
		return summaries
	}
	rows, _ := taskTrackingDispatchRecords(session)
	for _, record := range rows {
		turn := text(record, "turnId")
		if turn == "" {
			continue
		}
		row := clone(record)
		if taskTrackingDecorateSource != nil {
			taskTrackingDecorateSource(obj(row["origin"]))
		}
		delete(summaries, turn)
		if summary := dispatchSummary(row); summary != nil {
			summaries[turn] = summary
		}
	}
	return summaries
}

func (t *taskTimeline) response(session string, after uint64) object {
	entries := []object{}
	truncated := false
	for index, raw := range t.Entries {
		truncated = truncated || raw["truncated"] == true
		for _, key := range []string{"input", "output", "summary", "error"} {
			truncated = truncated || field(raw[key], "truncated") == true
		}
		if uintOr(raw["cursor"], 0) > after {
			row := clone(raw)
			if _, exists := row["position"]; !exists {
				row["position"] = index
			}
			entries = append(entries, row)
		}
	}
	coverage := object{"state": "complete", "truncated": truncated}
	if t.Partial {
		coverage["state"] = "partial"
	}
	if t.OmittedSidechainRecords > 0 {
		coverage["omittedSidechainRecords"] = t.OmittedSidechainRecords
	}
	if t.ObservationLost {
		coverage["state"], coverage["reason"] = "partial", "native-observation-lost; refreshed history does not restore a live subscription"
	}
	value := object{"sessionId": session, "status": t.Status, "entries": entries, "cursor": t.Revision, "coverage": coverage, "executionEvidence": t.executionEvidence()}
	summaries := taskTrackingSummaries(session, t.TurnDispatchSummaries)
	if summary := summaries[t.Turn]; summary != nil {
		value["dispatchSummary"] = summary
	}
	if len(summaries) > 0 {
		value["turnDispatchSummaries"] = summaries
	}
	if len(t.TurnLifecycles) > 0 {
		statuses, conflicts := object{}, object{}
		for turn, checkpoint := range t.TurnLifecycles {
			statuses[turn] = t.turnStatus(turn)
			if len(arr(field(checkpoint, "terminals"))) > 0 && coordinationCheckpointTerminal(checkpoint) == "" {
				conflicts[turn] = checkpoint
			}
		}
		value["turnStatuses"] = statuses
		if len(conflicts) > 0 {
			value["conflicts"] = conflicts
		}
	}
	if len(t.TurnTimings) > 0 {
		value["turnTimings"] = t.TurnTimings
	}
	value["snapshotHash"] = hash([]byte(wire(object{"entries": t.Entries, "status": t.Status, "turnLifecycles": t.TurnLifecycles, "turnTimings": t.TurnTimings, "coverage": coverage})))
	if taskTrackingDecorateSource != nil {
		taskTrackingDecorateSource(value)
	}
	return value
}

func (t *taskTimeline) session(id string, info object, source string, pending object) object {
	recent := []string{}
	steps := []string{}
	turns := map[string]bool{}
	var latest object
	var currentPending object
	fallback := taskHeadline("text", text(info, "title"))
	for _, row := range slices.Backward(t.Entries) {
		kind := text(row, "type")
		if turn := text(row, "turnId"); turn != "" {
			turns[turn] = true
		}
		if len(recent) < 3 && slices.Contains([]string{"thinking", "text", "command", "file"}, kind) {
			if line := taskEntryHeadline(row); line != "" {
				recent = append(recent, line)
			}
		}
		if kind == "user" && fallback == "" {
			fallback = taskEntryHeadline(row)
		}
		if len(steps) < 5 && slices.Contains([]string{"thinking", "command", "file", "tool", "text", "interaction"}, kind) {
			steps = append(steps, kind)
		}
		if kind == "interaction" && row["status"] == "pending" && currentPending == nil {
			currentPending = row
		}
		if kind != "interaction" && kind != "notice" {
			live := row["status"] == "running" || row["status"] == "pending"
			latestLive := latest["status"] == "running" || latest["status"] == "pending"
			if latest == nil || live && !latestLive || live == latestLive && uintOr(row["cursor"], 0) > uintOr(latest["cursor"], 0) {
				latest = row
			}
		}
	}
	for turn := range t.TurnLifecycles {
		if turn != "" {
			turns[turn] = true
		}
	}
	var turn any
	if t.Turn != "" {
		turn = t.Turn
		turns[t.Turn] = true
	}
	if len(recent) > 0 {
		fallback = recent[0]
	}
	slices.Reverse(recent)
	slices.Reverse(steps)
	result := object{"id": id, "source": source, "title": redactTaskOutput(text(info, "title")), "project": info["project"], "phase": "idle", "headline": "",
		"startedAt": info["startedAt"], "phaseSince": info["startedAt"], "timeline": true, "turnId": turn, "turnStartedAt": t.TurnStartedAt, "turnCount": len(turns),
		"fallbackHeadline": fallback, "recentContent": recent, "recentSteps": steps}
	if source != "transcript" {
		if summary := taskTrackingSummaries(id, t.TurnDispatchSummaries)[t.Turn]; summary != nil {
			result["dispatchSummary"] = summary
		}
	}
	if latest != nil {
		kind := text(latest, "type")
		if slices.Contains([]string{"thinking", "command", "file", "tool", "text"}, kind) {
			result["phase"] = kind
		}
		result["headline"], result["phaseSince"] = taskEntryHeadline(latest), latest["startedAt"]
	}
	interaction := clone(pending)
	if interaction == nil {
		interaction = clone(obj(currentPending["interaction"]))
	}
	if interaction != nil {
		if respond := obj(interaction["respond"]); respond["op"] == "agent_respond" {
			if args := obj(respond["args"]); args != nil {
				args["agent"], args["taskId"] = info["agent"], id
			}
		}
		result["phase"], result["headline"], result["interaction"] = "interaction", interaction["summary"], interaction
		if currentPending != nil {
			result["phaseSince"] = currentPending["startedAt"]
		}
	}
	if source == "codex-thread" && taskTrackingNavigation != nil {
		if value := taskTrackingNavigation(id); value != nil {
			result["open"] = value
		}
	}
	return result
}

var taskTrackingNavigation func(string) any
var resolveTrackedConversation func(context.Context, *service, object) (object, error)

func readTaskTrackingTimeline(ctx context.Context, request operationRequest) (any, error) {
	if resolveTrackedConversation == nil {
		return nil, errors.New(PortPending)
	}
	result, err := resolveTrackedConversation(ctx, request.service, request.args)
	if err != nil {
		return nil, err
	}
	if expected, ok := request.args["expectedHash"].(string); ok && result["snapshotHash"] == expected {
		result = maps.Clone(result)
		result["entries"], result["unchanged"] = []object{}, true
	}
	return result, nil
}

func (t *taskTimeline) backfillCodex(thread any, timings, configurations map[string]object, baseline, observed uint64, at string) {
	t.init()
	for turn, timing := range timings {
		current := t.TurnTimings[turn]
		if current == nil {
			current = object{}
			t.TurnTimings[turn] = current
		}
		for _, key := range []string{"startedAt", "endedAt"} {
			if value, ok := timing[key].(string); ok {
				current[key] = value
			}
		}
	}
	for turn, config := range configurations {
		if summary := dispatchSummary(config); summary != nil {
			t.TurnDispatchSummaries[turn] = summary
		}
	}
	history := taskTimeline{Info: object{"id": field(thread, "id"), "agent": "codex", "title": trackedCodexTitle(thread), "project": field(thread, "cwd")}, ObservedEvents: observed}
	if t.Info == nil {
		t.Info = history.Info
	}
	turns := arr(field(thread, "turns"))
	history.Partial = turns == nil
	for _, turn := range turns {
		history.Turn = text(turn, "id")
		history.recordStatus(text(turn, "status"), obj(field(turn, "_turnLifecycle")))
		if history.Turn != "" {
			for _, pair := range [][2]string{{"startedAt", "startedAt"}, {"completedAt", "endedAt"}} {
				if seconds, ok := taskInt(field(turn, pair[0])); ok {
					timing := t.TurnTimings[history.Turn]
					if timing == nil {
						timing = object{}
						t.TurnTimings[history.Turn] = timing
					}
					if timing[pair[1]] == nil {
						timing[pair[1]] = time.Unix(seconds, 0).UTC().Format("2006-01-02T15:04:05+00:00")
					}
				}
			}
		}
		items := arr(field(turn, "items"))
		history.Partial = history.Partial || items == nil
		for _, item := range items {
			status := "completed"
			switch text(item, "status") {
			case "failed", "declined":
				status = "failed"
			case "inProgress", "running":
				status = "running"
			case "cancelled", "interrupted":
				status = "cancelled"
			case "completed":
			default:
				if trackedTurnStatus(history.Status) == "running" && field(item, "type") != "userMessage" && field(item, "type") != "steeringUserMessage" {
					status = "running"
				}
			}
			history.codexItem(item, status, at)
		}
	}
	historicalIDs := map[string]bool{}
	for index, row := range history.Entries {
		id := text(row, "id")
		historicalIDs[id] = true
		_, old := t.existing(id)
		if old == nil {
			row["startedAt"], row["endedAt"] = nil, nil
		} else if uintOr(old["cursor"], 0) > baseline {
			history.Entries[index] = clone(old)
		} else {
			row["startedAt"] = old["startedAt"]
			if ended, ok := old["endedAt"]; ok {
				row["endedAt"] = ended
			}
		}
	}
	for _, row := range t.Entries {
		if !historicalIDs[text(row, "id")] {
			history.Entries = append(history.Entries, clone(row))
		}
	}
	t.Partial = history.Partial
	t.ToolObserved = t.ToolObserved || history.ToolObserved
	active, liveStatus := t.Turn, t.Status
	for turn, checkpoint := range history.TurnLifecycles {
		if t.TurnLifecycles[turn] != nil && !trackedTurnEnded(checkpoint) {
			continue
		}
		t.Turn = turn
		t.recordStatus(trackedTurnStatus(checkpoint), obj(checkpoint))
	}
	t.Turn, t.Status = active, liveStatus
	if t.ObservedEvents == observed || liveStatus == "" {
		if active != history.Turn {
			t.TurnStartedAt = nil
		}
		t.Turn, t.Status = history.Turn, history.Status
	}
	if t.Turn != "" {
		status := trackedTurnStatus(t.lifecycle(t.Turn))
		if t.Status != "inProgress" || status != "running" {
			t.Status = status
		}
	}
	for position, row := range history.Entries {
		started, ended := row["startedAt"], row["endedAt"]
		id := text(row, "id")
		row["position"] = position
		t.put(row, at)
		if _, current := t.existing(id); current != nil {
			current["startedAt"] = started
			if _, ok := row["endedAt"]; ok {
				current["endedAt"] = ended
			}
			if current["status"] == "running" && (current["type"] == "text" || current["type"] == "thinking") {
				if _, ok := t.buffers[id]; !ok {
					t.buffers[id] = text(current, "text")
				}
			}
		}
	}
	slices.SortStableFunc(t.Entries, func(a, b object) int {
		return cmp.Compare(uintOr(a["position"], ^uint64(0)), uintOr(b["position"], ^uint64(0)))
	})
	t.Bytes = 0
	for _, row := range t.Entries {
		t.Bytes += len(wire(row))
	}
	t.HistoryLoaded = true
}

func (t *taskTimeline) resolve(request any, at string) {
	id := "interaction:" + wire(request)
	if _, row := t.existing(id); row != nil {
		t.put(t.entry(id, "interaction", "completed"), at)
	}
}

func (t *taskTimeline) answered(request, response any) {
	params := field(request, "params")
	id := "interaction:" + wire(field(request, "id"))
	if _, row := t.existing(id); row == nil || row["turnId"] != field(params, "turnId") {
		id = "interaction:history:" + hash([]byte(wire([]any{field(request, "backendSession"), field(params, "turnId"), field(request, "id")})))
	}
	row := t.entry(id, "interaction", "completed")
	if row["interaction"] == nil {
		kind := "question"
		if strings.Contains(text(request, "method"), "Approval") {
			kind = "permission"
		}
		questions := arr(field(params, "questions"))
		var question any
		if len(questions) > 0 {
			question = field(questions[0], "question")
		}
		title := firstTaskText(field(params, "question"), field(params, "title"), question, field(params, "command"), "Interaction")
		row["interaction"] = object{"kind": kind, "method": field(request, "method"), "summary": title, "questions": field(params, "questions")}
	}
	row["turnId"], row["response"] = field(params, "turnId"), response
	t.put(row, text(response, "resolvedAt"))
}
func (t *taskTimeline) enrichPermission(msg object) {
	params := obj(msg["params"])
	if params == nil {
		params = object{}
		msg["params"] = params
	}
	call := obj(params["toolCall"])
	if call == nil {
		call = object{}
		params["toolCall"] = call
	}
	if call["toolCallId"] == nil && params["toolCallId"] != nil {
		call["toolCallId"] = params["toolCallId"]
	}
	if _, row := t.existing(text(call, "toolCallId")); row != nil {
		for _, key := range []string{"command", "path", "title"} {
			if call[key] == nil && row[key] != nil {
				call[key] = row[key]
			}
		}
	}
}
func (t *taskTimeline) syncInteractions(requests []object, at string) {
	ids := map[string]bool{}
	for _, request := range requests {
		params := obj(request["params"])
		turn := text(params, "turnId")
		if trackedTurnEnded(t.lifecycle(turn)) || trackedTurnEnded(request["turnStatus"]) {
			continue
		}
		id := "interaction:" + wire(request["id"])
		ids[id] = true
		_, item := t.existing(text(params, "itemId"))
		title := nonemptyTaskText(text(params, "command"), text(params, "path"), text(params, "reason"), text(params, "title"), text(params, "question"))
		if title == "" {
			title = "Interaction required"
			if item != nil {
				title = text(item, "command")
			}
		}
		kind := "question"
		if strings.Contains(text(request, "method"), "Approval") {
			kind = "permission"
		}
		var questions any
		if list := arr(params["questions"]); list != nil {
			rows := []any{}
			for _, raw := range list {
				row := sanitizeTaskValue(raw)
				if flag, ok := field(raw, "isSecret").(bool); ok {
					obj(row)["isSecret"] = flag
				}
				rows = append(rows, row)
			}
			questions = rows
		}
		row := object{"kind": kind, "summary": boundedTaskText(title, taskSummaryBytes), "request": summarizeTaskValue(params),
			"method": request["method"], "questions": questions, "respond": request["next"], "canRespond": request["canRespond"], "preview": sanitizeTaskValue(params["diff"])}
		for _, key := range []string{"options", "command", "path", "cwd", "reason"} {
			row[key] = sanitizeTaskValue(params[key])
		}
		t.put(object{"id": id, "type": "interaction", "status": "pending", "turnId": turn, "interaction": row}, at)
	}
	for _, row := range slices.Clone(t.Entries) {
		id := text(row, "id")
		if row["type"] == "interaction" && row["status"] == "pending" && !ids[id] {
			t.put(t.entry(id, "interaction", "completed"), at)
		}
	}
}

func (t *taskTimeline) agent(method string, msg any, at string) {
	terminal := trackedTurnEnded(t.lifecycle(t.Turn))
	if terminal && (method == "session/request_permission" || method == "extension_ui_request") {
		return
	}
	switch method {
	case "arc/user":
		t.endChunk(at)
		t.Turn, t.TurnStartedAt = text(msg, "turnId"), &at
		t.PiStopReason, t.PiError = "", nil
		t.recordStatus("running", nil)
		t.startTurn(at)
		value, truncated := cutTaskText(redactTaskOutput(text(msg, "text")), taskMaxText)
		t.put(object{"id": fmt.Sprintf("%s:user:%d", t.Turn, t.Revision+1), "type": "user", "status": "completed", "text": value, "truncated": truncated}, at)
		return
	case "arc/settled":
		if failure := field(msg, "error"); failure != nil {
			t.failure(failure, at)
		}
		t.finish(text(msg, "status"), at)
		return
	case "arc/interaction-resolved":
		t.resolve(field(msg, "id"), at)
		return
	}
	t.ObservedEvents++
	switch method {
	case "step_update", "result":
		t.antigravity(method, msg, at)
	case "session/update":
		t.agentSessionUpdate(field(field(msg, "params"), "update"), at)
	case "session/request_permission", "extension_ui_request":
		t.agentInteraction(method, msg, at)
	case "tool_execution_start", "tool_execution_update", "tool_execution_end":
		t.endChunk(at)
		output := field(msg, "result")
		if method == "tool_execution_update" {
			output = field(msg, "partialResult")
		}
		status := "running"
		if method == "tool_execution_end" {
			status = "completed"
			if field(msg, "isError") == true {
				status = "failed"
			}
		}
		update := object{"toolCallId": field(msg, "toolCallId"), "title": field(msg, "toolName"), "status": status, "rawInput": field(msg, "args"), "rawOutput": output, "content": field(output, "content")}
		t.tool(update, at)
	case "message_update":
		event := field(msg, "assistantMessageEvent")
		kind := text(event, "type")
		switch kind {
		case "text_delta":
			kind = "text"
		case "thinking_delta":
			kind = "thinking"
		default:
			return
		}
		id := fmt.Sprintf("%s:pi:%d:%d", t.Turn, t.PiMessage, uintOr(field(event, "contentIndex"), 0))
		t.delta(id, kind, text(event, "delta"), at)
	case "message_end":
		message := field(msg, "message")
		if field(message, "role") != "assistant" {
			return
		}
		for index, block := range arr(field(message, "content")) {
			kind := text(block, "type")
			switch kind {
			case "toolCall":
				if _, row := t.existing(text(block, "id")); row == nil {
					t.tool(object{"toolCallId": field(block, "id"), "title": field(block, "name"), "rawInput": field(block, "arguments"), "status": "unknown"}, at)
				}
			case "text", "thinking":
				id := fmt.Sprintf("%s:pi:%d:%d", t.Turn, t.PiMessage, index)
				value, truncated := cutTaskText(redactTaskOutput(contentOfTaskValue(block)), taskMaxText)
				delete(t.buffers, id)
				t.put(object{"id": id, "type": kind, "status": "completed", "text": value, "truncated": truncated}, at)
			}
		}
		t.PiStopReason = text(message, "stopReason")
		t.PiError = summarizeTaskValue(field(message, "errorMessage"))["text"]
		t.PiMessage++
	case "agent_settled":
		status := "completed"
		switch t.PiStopReason {
		case "error":
			status = "failed"
		case "aborted":
			status = "cancelled"
		default:
		}
		t.finish(status, at)
		if t.Status == "failed" {
			t.failure(t.PiError, at)
		}
	case "auto_retry_start", "auto_retry_end", "auto_compaction_start", "auto_compaction_end", "compaction_start", "compaction_end":
		kind, stage := "compaction", "end"
		if strings.Contains(method, "retry") {
			kind = "retry"
		}
		if strings.HasSuffix(method, "start") {
			stage = "start"
		}
		t.notice("", kind, stage, msg, at)
	case "error":
		if field(msg, "willRetry") == true {
			t.notice("", "retry", "start", msg, at)
		} else {
			t.failure(msg, at)
		}
	}
}

func (t *taskTimeline) agentSessionUpdate(update any, at string) {
	switch text(update, "sessionUpdate") {
	case "notice":
		t.notice("", "warning", "message", update, at)
	case "compaction_update":
		id := "compaction:" + text(update, "compactionId")
		stage := "end"
		if field(update, "status") == "in_progress" {
			stage = "start"
		}
		t.notice(id, "compaction", stage, update, at)
		row := t.entry(id, "notice", "completed")
		for _, key := range []string{"summary", "error"} {
			if value, ok := obj(update)[key]; ok {
				row[key] = nil
				if value != nil {
					row[key] = summarizeTaskValue(contentOfTaskValue(value))
				}
			}
		}
		t.put(row, at)
	case "compaction_summary_chunk":
		id := "compaction:" + text(update, "compactionId")
		row := t.entry(id, "notice", "completed")
		if row["notice"] == nil {
			row["notice"] = object{"kind": "compaction", "stage": "start"}
		}
		row["summary"] = summarizeTaskValue(text(row["summary"], "text") + contentOfTaskValue(field(update, "content")))
		t.put(row, at)
	case "agent_message_chunk":
		t.addChunk("text", contentOfTaskValue(field(update, "content")), at)
	case "agent_thought_chunk":
		t.addChunk("thinking", contentOfTaskValue(field(update, "content")), at)
	case "user_message_chunk":
		t.addChunk("user", contentOfTaskValue(field(update, "content")), at)
	case "tool_call", "tool_call_update":
		t.endChunk(at)
		t.tool(update, at)
	case "plan":
		t.endChunk(at)
		list := field(update, "entries")
		t.put(object{"id": t.Turn + ":plan", "type": "plan", "status": "completed", "plan": taskPlan(list), "truncated": len(arr(list)) > 100}, at)
	}
}

func (t *taskTimeline) agentInteraction(method string, msg any, at string) {
	if method == "extension_ui_request" {
		name := text(msg, "method")
		if name == "notify" {
			t.notice("", "warning", "message", msg, at)
			return
		}
		if !slices.Contains([]string{"select", "confirm", "input", "editor"}, name) {
			return
		}
	}
	t.endChunk(at)
	params, kind := field(msg, "params"), "question"
	if method == "session/request_permission" || field(msg, "method") == "confirm" {
		kind = "permission"
	}
	call := field(params, "toolCall")
	title := nonemptyTaskText(text(call, "command"), text(call, "path"), text(call, "title"), text(msg, "title"), text(msg, "message"), "Interaction required")
	options := field(msg, "options")
	if method == "session/request_permission" {
		options = field(params, "options")
	}
	row := object{"kind": kind, "summary": boundedTaskText(title, taskSummaryBytes), "method": field(msg, "method"), "options": sanitizeTaskValue(options),
		"respond": object{"via": "act", "op": "agent_respond", "args": object{"interactionId": field(msg, "id")}}}
	for _, key := range []string{"command", "path", "title"} {
		row[key] = sanitizeTaskValue(field(call, key))
	}
	t.put(object{"id": "interaction:" + wire(field(msg, "id")), "type": "interaction", "status": "pending", "interaction": row}, at)
}

func trackedNativeEvents(e *nativeEvents, session, method string, params any, at string) {
	if e.durable {
		timeline := e.taskTrackingTimeline(session)
		timeline.agent(method, params, at)
		return
	}
	defer syncTrackedNativeInteractions(e, at)
	thread := firstTaskText(field(params, "threadId"), field(params, "conversationId"))
	timeline := e.taskTimelines[thread]
	if timeline == nil {
		return
	}
	if method == "desktop/thread-stream-state-changed" {
		change := field(params, "change")
		if field(change, "type") != "snapshot" {
			return
		}
		if coordinationNativeDesktopTurns == nil {
			timeline.Partial = true
			return
		}
		timeline.ObservedEvents++
		for _, turn := range coordinationNativeDesktopTurns(field(change, "conversationState")) {
			timeline.Turn = text(turn, "id")
			timeline.recordStatus(text(turn, "status"), obj(turn["_turnLifecycle"]))
			status := "completed"
			if trackedTurnStatus(timeline.lifecycle(timeline.Turn)) == "running" {
				status = "running"
			}
			for _, item := range arr(turn["items"]) {
				timeline.codexItem(item, status, at)
			}
		}
	} else {
		timeline.codex(method, params, at)
	}
}

func syncTrackedNativeInteractions(events *nativeEvents, at string) {
	if len(events.taskTimelines) == 0 {
		return
	}
	pending := map[string][]object{}
	for _, key := range slices.Sorted(maps.Keys(events.pending)) {
		request := events.pending[key]
		thread := text(request["params"], "threadId")
		pending[thread] = append(pending[thread], request)
	}
	for thread, timeline := range events.taskTimelines {
		timeline.syncInteractions(pending[thread], at)
	}
}

func (e *nativeEvents) taskTrackingTimeline(session string) *taskTimeline {
	if e.taskTimelines == nil {
		e.taskTimelines = make(map[string]*taskTimeline)
	}
	timeline := e.taskTimelines[session]
	if timeline == nil {
		info := object{"id": session}
		if !e.durable {
			info["agent"] = "codex"
		}
		timeline = &taskTimeline{Info: info}
		e.taskTimelines[session] = timeline
	}
	return timeline
}

func taskTimelineLiveTurns(_ context.Context, service *service, threads []string) []coordinationLiveTurn {
	events := &service.events
	events.Lock()
	live := []coordinationLiveTurn{}
	for _, thread := range threads {
		if timeline := events.taskTimelines[thread]; timeline != nil && timeline.Turn != "" {
			checkpoint := obj(timeline.lifecycle(timeline.Turn))
			live = append(live, coordinationLiveTurn{thread, timeline.Turn, timeline.Status, clone(checkpoint)})
		}
	}
	events.Unlock()
	if taskTrackingAgentTurns != nil {
		live = append(live, taskTrackingAgentTurns(threads)...)
	}
	return live
}

var taskTrackingAgentTurns func([]string) []coordinationLiveTurn

func init() {
	taskTrackingDispatchRecords = dispatchRecords
	sourceDispatchRecords = func(thread string) ([]any, error) {
		rows, err := dispatchRecords(thread)
		if err != nil {
			return nil, err
		}
		result := make([]any, len(rows))
		for i, row := range rows {
			result[i] = row
		}
		return result, nil
	}
	registerOperation("task_timeline", readTaskTrackingTimeline, nil)
	contextTrackingProjection = projectTaskContextTracking
	readRecordedInteractions = projectTrackedInteractions
	nativeEventObserved = append(nativeEventObserved, trackedNativeEvents)
	nativeEventEvicted = append(nativeEventEvicted, func(events *nativeEvents, session string, row object) {
		id := session
		if !events.durable {
			params := row["params"]
			id = firstTaskText(field(params, "threadId"), field(params, "conversationId"))
		}
		if timeline := events.taskTimelines[id]; timeline != nil && (events.durable || !timeline.HistoryLoaded) {
			timeline.Partial = true
		}
	})
	runtimeTimelineDiagnostics = func(events *nativeEvents) (int, int) {
		n := 0
		for _, timeline := range events.taskTimelines {
			n += len(timeline.Entries)
		}
		return len(events.taskTimelines), n
	}
	coordinationLiveTurns = taskTimelineLiveTurns
}

func projectTaskContextTracking(facts contextTaskEvidence) contextTaskEvidence {
	output := facts.RedactedOutput
	if raw, ok := facts.Task["output"].(string); ok {
		output = raw
	}
	facts.RedactedOutput = redactTaskOutput(output)
	if tracking := facts.Task["tracking"]; tracking != nil {
		var timeline taskTimeline
		if unmarshalJSON([]byte(wire(tracking)), &timeline) == nil {
			facts.Evidence = timeline.evidence(axOptional(facts.Task["turnId"]))
			facts.ExecutionEvidence = timeline.executionEvidence()
			facts.ObservedEvents = timeline.ObservedEvents
			facts.Partial = timeline.Partial
		}
	} else {
		turn := text(facts.Task, "turnId")
		projected := []any{}
		for _, raw := range facts.Evidence {
			kind := text(raw, "type")
			if (kind == "file" || kind == "command") && (turn == "" || field(raw, "turnId") == turn) {
				projected = append(projected, sanitizeTaskValue(raw))
			}
		}
		facts.Evidence = projected
	}
	return facts
}

// A owns the native answer records. B projects their scoped identities and history.
var readTaskTrackingAnswers func(context.Context, *service, string) ([]object, error)

func projectTrackedInteractions(ctx context.Context, s *service, thread string) ([]any, error) {
	if readTaskTrackingAnswers == nil {
		return nil, errors.New(PortPending)
	}
	answers, err := readTaskTrackingAnswers(ctx, s, thread)
	if err != nil {
		return nil, err
	}
	timeline := taskTimeline{}
	for _, row := range answers {
		timeline.answered(row["request"], row["response"])
	}
	entries := make([]any, len(timeline.Entries))
	for i, row := range timeline.Entries {
		entries[i] = row
	}
	return entries, nil
}
