package core

import (
	"fmt"
	"slices"
	"strings"
	"time"
)

type taskCodexTranscript struct {
	ordinal, historyStart uint64
}

func (transcript *taskCodexTranscript) include(record any) bool {
	ordinal := transcript.ordinal
	transcript.ordinal++
	if ordinal == 0 && field(record, "type") == "session_meta" {
		transcript.historyStart = uintOr(field(field(record, "payload"), "subagent_history_start_ordinal"), 0)
		return true
	}
	return ordinal >= transcript.historyStart
}

type taskCodexThreadTier struct {
	Current any
	at      time.Time
	turn    string
}

func (tier *taskCodexThreadTier) observe(record any) string {
	payload := field(record, "payload")
	at, err := time.Parse(time.RFC3339Nano, text(record, "timestamp"))
	previous, turn := tier.at, tier.turn
	tier.at, tier.turn = time.Time{}, ""
	switch {
	case field(record, "type") == "turn_context":
		if id, ok := field(payload, "turn_id").(string); ok && err == nil {
			tier.at, tier.turn = at, id
		}
	case field(record, "type") == "event_msg" && field(payload, "type") == "thread_settings_applied":
		tier.Current = field(field(payload, "thread_settings"), "service_tier")
		if delay := at.Sub(previous); err == nil && turn != "" && delay >= 0 && delay <= time.Millisecond {
			return turn
		}
	}
	return ""
}

func (t *taskTimeline) transcriptTurnStart() (string, string, bool) {
	return t.Turn, strPtr(t.TurnStartedAt), t.TurnStartedAt != nil
}
func (t *taskTimeline) promptHeadline() string {
	for _, row := range t.Entries {
		if row["type"] == "user" {
			if text := trackedTranscriptTitleText(text(row, "text")); text != "" {
				return text
			}
		}
	}
	return ""
}
func (t *taskTimeline) transcriptMetadata(record any) {
	if t.Info == nil {
		t.Info = object{}
	}
	if at, ok := field(record, "timestamp").(string); t.Info["startedAt"] == nil && ok {
		t.Info["startedAt"] = at
	}
	payload := field(record, "payload")
	if project, ok := firstTaskValue(field(record, "cwd"), field(payload, "cwd")).(string); ok {
		t.Info["project"] = project
	}
	session := field(record, "sessionId")
	if session == nil && field(record, "type") == "session_meta" {
		session = field(payload, "id")
	}
	if id, ok := session.(string); ok {
		t.Info["id"] = id
	}
}
func (t *taskTimeline) backfillTranscript(agent string, records []any) {
	if agent == "claude" {
		t.backfillClaude(records)
	} else {
		t.backfillCodexRecords(records)
	}
}

func (t *taskTimeline) backfillCodexRecords(records []any) {
	t.init()
	if t.Info == nil {
		t.Info = object{}
	}
	t.Info["agent"] = "codex"
	for _, record := range records {
		if !t.transcript.include(record) {
			continue
		}
		t.transcriptMetadata(record)
		at := text(record, "timestamp")
		payload := field(record, "payload")
		switch text(record, "type") {
		case "turn_context":
			if turn, ok := field(payload, "turn_id").(string); ok && t.Turn != turn {
				t.Status, t.TurnStartedAt, t.Turn = t.turnStatus(turn), nil, turn
			}
		case "event_msg":
			switch text(payload, "type") {
			case "task_started":
				t.codex("turn/started", object{"turn": object{"id": field(payload, "turn_id")}}, at)
			case "task_complete", "turn_aborted":
				id := firstTaskText(field(payload, "turn_id"), t.Turn)
				oldTurn, oldStatus, oldStart := t.Turn, t.Status, t.TurnStartedAt
				t.Turn = id
				status := "completed"
				if field(payload, "type") == "turn_aborted" {
					status = "interrupted"
				}
				checkpoint := trackedCheckpoint("codex", text(t.Info, "id"), id, status, 0)
				obj(arr(checkpoint["terminals"])[0])["sequence"] = t.transcript.ordinal - 1
				t.recordStatus(status, checkpoint)
				t.settle(at)
				if oldTurn != "" && oldTurn != id {
					t.Turn, t.Status, t.TurnStartedAt = oldTurn, oldStatus, oldStart
				}
			case "warning":
				t.notice("", "warning", "message", payload, at)
			case "stream_error":
				t.notice("", "retry", "start", payload, at)
			case "context_compacted":
				t.notice("", "compaction", "end", payload, at)
			}
		case "compacted":
			t.notice("", "compaction", "end", payload, at)
		case "response_item":
			t.codexTranscriptItem(record, payload, at)
		}
	}
}

func (t *taskTimeline) codexTranscriptItem(record, payload any, at string) {
	id := firstTaskText(field(payload, "id"), field(payload, "call_id"), fmt.Sprintf("rollout:%d", t.Revision+1))
	switch text(payload, "type") {
	case "message":
		role := text(payload, "role")
		if role != "user" && role != "assistant" {
			return
		}
		raw := contentOfTaskValue(field(payload, "content"))
		body := cleanTaskTranscript(raw)
		kind := "agentMessage"
		if role == "user" {
			body = trackedTranscriptUserText(record, raw)
			kind = "userMessage"
		}
		if strings.TrimSpace(body) == "" {
			return
		}
		t.codexItem(object{"id": id, "type": kind, "content": body, "text": body, "phase": field(payload, "phase")}, "completed", at)
	case "reasoning":
		t.codexItem(object{"id": id, "type": "reasoning", "summary": field(payload, "summary")}, "completed", at)
	case "function_call", "custom_tool_call", "local_shell_call":
		input := parseTrackedInput(firstTaskValue(field(payload, "arguments"), field(payload, "input")))
		if field(payload, "type") == "local_shell_call" {
			action := field(payload, "action")
			var command any
			if list := arr(field(action, "command")); list != nil {
				command = strings.Join(axStrings(list), " ")
			}
			input = object{"command": command, "cwd": field(action, "working_directory")}
		}
		t.tool(object{"toolCallId": firstTaskValue(field(payload, "call_id"), id), "title": field(payload, "name"), "rawInput": input, "status": "unknown"}, at)
	case "function_call_output", "custom_tool_call_output":
		t.tool(object{"toolCallId": field(payload, "call_id"), "rawOutput": field(payload, "output"), "status": "completed"}, at)
	case "web_search_call", "tool_search_call":
		t.codexItem(object{"id": id, "type": "dynamicToolCall", "tool": field(payload, "type"), "arguments": field(payload, "action")}, "unknown", at)
	case "tool_search_output":
	default:
		t.Partial = true
	}
}

func (t *taskTimeline) transcriptActive() bool {
	if len(t.Entries) == 0 && t.OmittedSidechainRecords > 0 || trackedTurnEnded(t.lifecycle(t.Turn)) {
		return false
	}
	return len(t.Entries) > 0 || t.Status == "running" || t.Status == "inProgress"
}
func (t *taskTimeline) transcriptSession(id, agent string) object {
	info := clone(t.Info)
	if info == nil {
		info = object{}
	}
	info["title"] = t.promptHeadline()
	result := t.session(id, info, "transcript", nil)
	if result["phase"] == "idle" {
		result["phase"] = "thinking"
	}
	if agent == "codex" && taskTrackingNavigation != nil {
		if open := taskTrackingNavigation(id); open != nil {
			result["open"] = open
		}
	}
	return result
}
func (t *taskTimeline) backfillClaude(records []any) {
	t.init()
	if t.Info == nil {
		t.Info = object{}
	}
	t.Info["agent"] = "claude"
	for _, record := range records {
		if field(record, "isSidechain") == true {
			t.OmittedSidechainRecords++
			continue
		}
		at := text(record, "timestamp")
		t.transcriptMetadata(record)
		if field(record, "type") == "system" && field(record, "subtype") == "compact_boundary" {
			t.notice(text(record, "uuid"), "compaction", "end", field(record, "compactMetadata"), at)
			continue
		}
		message := field(record, "message")
		role := firstTaskText(field(message, "role"), field(record, "type"))
		if (role != "user" && role != "assistant") || role == "assistant" && field(record, "isMeta") == true {
			continue
		}
		if at == "" {
			t.Partial = true
			continue
		}
		id := text(record, "uuid")
		if id == "" {
			t.Partial = true
			id = "claude:" + hash([]byte(wire(record)))
		}
		if cwd, ok := field(record, "cwd").(string); ok {
			t.Info["project"] = cwd
		}
		raw := field(message, "content")
		blocks := arr(raw)
		if value, ok := raw.(string); ok {
			blocks = []any{object{"type": "text", "text": value}}
		}
		userTexts := []string{}
		for _, block := range blocks {
			if field(block, "type") == "text" {
				userTexts = append(userTexts, trackedTranscriptUserText(record, text(block, "text")))
			}
		}
		userText := strings.Join(userTexts, "\n")
		if role == "user" && strings.TrimSpace(userText) == "" &&
			slices.ContainsFunc(blocks, func(block any) bool {
				return field(block, "type") == "text" && strings.TrimSpace(text(block, "text")) != ""
			}) &&
			!slices.ContainsFunc(blocks, func(block any) bool { return field(block, "type") == "tool_result" }) {
			continue
		}
		if role == "user" && strings.TrimSpace(userText) != "" {
			t.Turn, t.TurnStartedAt, t.Status = id, &at, ""
			t.startTurn(at)
		}
		if role == "assistant" && field(message, "model") != "<synthetic>" && t.Turn != "" {
			effort := field(record, "perTurnEffort")
			if str(effort) == "" {
				effort = field(record, "effort")
			}
			if summary := dispatchSummary(object{"model": field(message, "model"), "effort": effort}); summary != nil {
				t.TurnDispatchSummaries[t.Turn] = summary
			}
		}
		for index, block := range blocks {
			t.claudeTranscriptBlock(record, block, role, fmt.Sprintf("%s:%d", id, index), at)
		}
		if role == "user" && strings.Contains(userText, "[Request interrupted by user") {
			t.finish("cancelled", at)
		}
		if role == "assistant" && (field(message, "stop_reason") == "end_turn" || field(message, "stop_reason") == "stop_sequence") {
			t.finish("completed", at)
		}
	}
}

func (t *taskTimeline) claudeTranscriptBlock(record, block any, role, id, at string) {
	switch kind := text(block, "type"); kind {
	case "text", "thinking":
		raw := text(block, kind)
		body := cleanTaskTranscript(raw)
		if role == "user" {
			body = trackedTranscriptUserText(record, raw)
		}
		if strings.TrimSpace(body) == "" && kind != "thinking" {
			return
		}
		if role == "user" {
			kind = "user"
		}
		body, truncated := cutTaskText(redactTaskOutput(body), taskMaxText)
		t.put(object{"id": id, "type": kind, "status": "completed", "text": body, "truncated": truncated}, at)
	case "tool_use":
		t.tool(object{"toolCallId": field(block, "id"), "title": field(block, "name"), "rawInput": field(block, "input"), "status": "unknown"}, at)
		if _, row := t.existing(text(block, "id")); row != nil {
			delete(row, "endedAt")
		}
	case "tool_result":
		if _, row := t.existing(text(block, "tool_use_id")); row == nil {
			t.Partial = true
		}
		status := "completed"
		if field(block, "is_error") == true {
			status = "failed"
		}
		t.tool(object{"toolCallId": field(block, "tool_use_id"), "rawOutput": field(block, "content"), "status": status}, at)
	default:
		t.Partial = true
	}
}

var trackedTranscriptTitleNoise = []interface{ ReplaceAllString(string, string) string }{
	trackingRegex(`(?is)<(?:attached-file|image|file)\b[^>]*?/>`),
	trackingRegex(`(?is)<(?:caveat|attached-file|file|image)(?:\s[^>]*)?>.*?(?:</(?:caveat|attached-file|file|image)>|\z)`),
	trackingRegex(`(?i)\[(?:image(?:\s*#?\p{Nd}+)?|attached[ -]?(?:file|image)(?:[^\]\n]*)|file:[^\]\n]*|image:[^\]\n]*)\]`),
}

func trackedTranscriptTitleText(value string) string {
	for _, pattern := range trackedTranscriptTitleNoise {
		value = pattern.ReplaceAllString(value, " ")
	}
	return axClip(strings.Join(strings.Fields(value), " "), 80)
}

type taskTranscriptTitle struct{ custom, prompt, summary string }

func (title *taskTranscriptTitle) observe(record any) {
	if field(record, "isSidechain") == true {
		return
	}
	var explicit string
	switch text(record, "type") {
	case "custom-title":
		explicit = text(record, "customTitle")
	case "session_info":
		explicit = text(record, "name")
	}
	if strings.TrimSpace(explicit) != "" {
		title.custom = axClip(strings.Join(strings.Fields(explicit), " "), 80)
	}
	if field(record, "type") == "summary" {
		if value := trackedTranscriptTitleText(trackedTranscriptUserText(record, text(record, "summary"))); value != "" {
			title.summary = value
		}
	}
	message := field(record, "message")
	if title.prompt != "" || field(record, "isMeta") == true || field(record, "isCompactSummary") == true || field(message, "role") != "user" && field(record, "type") != "user" {
		return
	}
	raw := field(message, "content")
	value, ok := raw.(string)
	if !ok {
		values := []string{}
		for _, block := range arr(raw) {
			if item, ok := field(block, "text").(string); ok && field(block, "type") == "text" {
				values = append(values, item)
			}
		}
		value = strings.Join(values, " ")
	}
	title.prompt = trackedTranscriptTitleText(trackedTranscriptUserText(record, value))
}
func (title *taskTranscriptTitle) value() *string {
	for _, value := range []string{title.custom, title.prompt, title.summary} {
		if value != "" {
			return &value
		}
	}
	return nil
}
