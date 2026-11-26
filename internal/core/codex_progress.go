package core

import (
	"context"
	"io"
	"maps"
	"slices"
	"strconv"
	"strings"
	"time"
)

const codexStallMs int64 = 3 * 60 * 1000
const codexProgressHistoryBytes int64 = 1 << 20

type codexToolActivity struct {
	at      int64
	running bool
}

type codexProgressActivity struct {
	started, observed, itemAt, tokenAt int64
	signal                             string
	tools                              map[string]codexToolActivity
	items                              map[string]string
	usage                              any
	unchanged                          uint64
	ended                              bool
}

func codexActivityTimestamp(value any) int64 {
	if at, err := time.Parse(time.RFC3339Nano, str(value)); err == nil {
		return at.UnixMilli()
	}
	n, err := strconv.ParseInt(wire(value), 10, 64)
	if err != nil {
		return 0
	}
	if n > -1_000_000_000_000 && n < 1_000_000_000_000 {
		n *= 1000
	}
	return n
}

func codexActivityDate(at int64) any {
	if at == 0 {
		return nil
	}
	return time.UnixMilli(at).UTC().Format("2006-01-02T15:04:05.999Z07:00")
}

func codexProgressTool(kind string) bool {
	return slices.Contains([]string{"commandExecution", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "fileChange",
		"function_call", "custom_tool_call", "local_shell_call", "web_search_call", "tool_search_call"}, kind)
}

func (a *codexProgressActivity) touch(at int64, signal string) {
	if a.started == 0 {
		a.started = at
	}
	if at >= a.observed {
		a.observed, a.signal = at, signal
	}
}

func (a *codexProgressActivity) tokens(usage any, at int64) {
	if obj(usage) == nil {
		return
	}
	if a.usage != nil {
		if wire(a.usage) != wire(usage) {
			a.touch(at, "token-count-change")
			a.unchanged = 0
		} else {
			a.unchanged++
		}
	}
	a.usage, a.tokenAt = usage, at
}

func (a *codexProgressActivity) tool(id string, at int64, running bool) {
	if a.tools == nil {
		a.tools = map[string]codexToolActivity{}
	}
	a.tools[id] = codexToolActivity{at, running}
}

func (a *codexProgressActivity) item(item any, at int64, completed bool) {
	id := str(dispatchFirstString(field(item, "call_id"), field(item, "id")))
	kind := text(item, "type")
	digest := hash([]byte(wire(item)))
	if a.items == nil {
		a.items = map[string]string{}
	}
	if a.items[id] != digest {
		a.touch(at, "response-item")
		a.itemAt = at
		a.items[id] = digest
	}
	if id != "" && codexProgressTool(kind) {
		a.tool(id, at, !completed)
	}
	if slices.Contains([]string{"function_call_output", "custom_tool_call_output", "tool_search_output"}, kind) {
		a.tool(id, at, false)
	}
}

func (a *codexProgressActivity) merge(other codexProgressActivity) {
	a.ended = a.ended || other.ended
	if other.tokenAt > a.tokenAt {
		a.usage, a.unchanged, a.tokenAt = other.usage, other.unchanged, other.tokenAt
	}
	if other.started != 0 && (a.started == 0 || other.started < a.started) {
		a.started = other.started
	}
	if other.observed != 0 {
		a.touch(other.observed, other.signal)
	}
	a.itemAt = max(a.itemAt, other.itemAt)
	for id, status := range other.tools {
		if previous, ok := a.tools[id]; !ok || status.at >= previous.at {
			a.tool(id, status.at, status.running)
		}
	}
}

func (a codexProgressActivity) diagnostic(thread, turn string, at int64) object {
	if a.observed == 0 || a.ended || at-a.observed < codexStallMs {
		return nil
	}
	for _, tool := range a.tools {
		if tool.running {
			return nil
		}
	}
	return object{"progressStalled": true, "reason": "native-progress-stalled",
		"evidence": object{"thresholdMs": codexStallMs, "startedAt": codexActivityDate(a.started), "lastActivityAt": codexActivityDate(a.observed),
			"lastActivitySignal": a.signal, "lastItemAt": codexActivityDate(a.itemAt), "unchangedTokenCounts": a.unchanged,
			"lastTokenCountAt": codexActivityDate(a.tokenAt), "nativeTokenUsage": a.usage},
		"next": object{"via": "act", "op": "codex_interrupt", "args": object{"threadId": thread, "turnId": turn},
			"hint": "Interrupt this stalled turn. Confirm interruption with codex_read, then redispatch the authorized work with codex_send and a new requestId."}}
}

func codexProgressHistory(history, selected string) codexProgressActivity {
	var activity codexProgressActivity
	var transcript taskCodexTranscript
	var usage any
	var current string
	for line := range strings.SplitSeq(history, "\n") {
		var row object
		if decodeObject([]byte(line), &row) != nil || !transcript.include(row) {
			continue
		}
		at := codexActivityTimestamp(row["timestamp"])
		if at == 0 {
			continue
		}
		p := row["payload"]
		kind := text(p, "type")
		if row["type"] == "turn_context" || row["type"] == "event_msg" && kind == "task_started" {
			if turn, ok := field(p, "turn_id").(string); ok {
				current = turn
				if current == selected && activity.started == 0 {
					activity.usage = usage
					activity.touch(at, "turn-start")
				} else if current != selected && activity.started != 0 {
					activity.ended = true
				}
			}
		}
		if current == selected {
			switch row["type"] {
			case "response_item":
				activity.touch(at, "response-item")
				activity.item(p, at, slices.Contains([]string{"completed", "failed", "cancelled"}, text(p, "status")))
			case "event_msg":
				switch kind {
				case "task_complete", "turn_aborted":
					activity.ended = true
				case "agent_message", "agent_reasoning":
					activity.touch(at, "response-item")
				case "token_count":
					activity.tokens(field(field(p, "info"), "total_token_usage"), at)
				}
			}
		}
		if row["type"] == "event_msg" && kind == "token_count" {
			usage = field(field(p, "info"), "total_token_usage")
		}
	}
	return activity
}

type codexProgressStates map[[2]string]codexProgressActivity

func (states codexProgressStates) store(key [2]string, activity codexProgressActivity) {
	states[key] = activity
	if len(states) > 2000 {
		oldest := key
		for candidate, state := range states {
			if state.observed < states[oldest].observed {
				oldest = candidate
			}
		}
		delete(states, oldest)
	}
}

func (states codexProgressStates) snapshot(metadata object, at int64) {
	for _, turn := range arr(metadata["turns"]) {
		key := [2]string{text(metadata, "id"), text(turn, "id")}
		if key[0] == "" || key[1] == "" {
			continue
		}
		a := states[key]
		if a.started == 0 {
			a.started = codexActivityTimestamp(field(turn, "startedAt"))
		}
		a.ended = a.ended || slices.Contains([]string{"completed", "failed", "interrupted", "cancelled"}, text(turn, "status"))
		for _, item := range arr(field(turn, "items")) {
			a.item(item, at, slices.Contains([]string{"completed", "failed", "cancelled"}, text(item, "status")))
		}
		states.store(key, a)
	}
}

func (states codexProgressStates) event(method string, params any, at int64) {
	if method == "desktop/thread-stream-state-changed" && controlDesktopTurns != nil {
		if turns, err := controlDesktopTurns(obj(field(field(params, "change"), "conversationState"))); err == nil {
			states.snapshot(object{"id": field(params, "conversationId"), "turns": turns}, at)
		}
		return
	}
	key := [2]string{text(params, "threadId"), str(dispatchFirstString(field(params, "turnId"), field(field(params, "turn"), "id")))}
	if key[0] == "" || key[1] == "" {
		return
	}
	a := states[key]
	switch {
	case method == "turn/started":
		if a.started == 0 || at < a.started {
			a.started = at
		}
		a.touch(at, "turn-start")
	case method == "turn/completed":
		a.ended = true
	case method == "item/started" || method == "item/completed":
		a.touch(at, "response-item")
		a.item(field(params, "item"), at, method == "item/completed")
	case method == "thread/tokenUsage/updated":
		a.tokens(field(field(params, "tokenUsage"), "total"), at)
	case strings.HasPrefix(method, "item/") && strings.Contains(strings.ToLower(method), "delta") && text(params, "delta") != "":
		a.touch(at, "streaming-delta")
	default:
		return
	}
	states.store(key, a)
}

func applyCodexProgress(ctx context.Context, events *nativeEvents, result, thread object) {
	if result["state"] != "running" || result["progressStalled"] != nil {
		return
	}
	result["progressStalled"] = false
	selected, id := text(result, "turnId"), text(thread, "id")
	at := time.Now().UnixMilli()
	activity := codexProgressActivity{}
	_, home, err := codexInputs()
	if err == nil {
		if file, err := openNativeHistory(home, thread); err == nil {
			if metadata, err := file.Stat(); err == nil {
				if _, err := file.Seek(max(0, metadata.Size()-codexProgressHistoryBytes), io.SeekStart); err == nil {
					if bytes, err := io.ReadAll(io.LimitReader(file, codexProgressHistoryBytes)); err == nil {
						if cost := currentRuntimeCost(ctx); cost != nil {
							cost.read.Add(uint64(len(bytes)))
						}
						activity = codexProgressHistory(string(bytes), selected)
					}
				}
			}
			_ = file.Close()
		}
	}
	events.Lock()
	if events.codexProgress == nil {
		events.codexProgress = codexProgressStates{}
	}
	events.codexProgress.snapshot(thread, at)
	activity.merge(events.codexProgress[[2]string{id, selected}])
	events.Unlock()

	if native := find(arr(thread["turns"]), "id", selected); native != nil {
		if !activity.ended && activity.observed == 0 {
			if started := codexActivityTimestamp(field(native, "startedAt")); started != 0 {
				activity.touch(started, "turn-start")
			}
		}
		for _, item := range arr(field(native, "items")) {
			if !codexProgressTool(text(item, "type")) {
				continue
			}
			id := text(item, "id")
			switch text(item, "status") {
			case "inProgress", "running":
				if tool, ok := activity.tools[id]; !ok || tool.running {
					activity.tool(id, 0, true)
				}
			case "completed", "failed", "cancelled":
				activity.tool(id, 0, false)
			}
		}
	}
	if diagnostic := activity.diagnostic(id, selected, at); diagnostic != nil {
		result["progressStalled"] = true
		maps.Copy(dispatchSetSection(result, "progress"), diagnostic)
		result["reason"], result["next"] = diagnostic["reason"], diagnostic["next"]
	}
}

func init() {
	nativeEventObserved = append(nativeEventObserved, func(events *nativeEvents, _, method string, params any, at string) {
		if events.codexProgress == nil {
			events.codexProgress = codexProgressStates{}
		}
		events.codexProgress.event(method, params, codexActivityTimestamp(at))
	})
}
