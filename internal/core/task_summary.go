package core

import (
	"slices"
	"strings"
	"unicode/utf8"
)

func wantsTaskSummary(name string, args object) bool {
	return args["view"] == "summary" && slices.Contains([]string{"codex_read", "codex_wait", "agent_read", "agent_wait"}, name)
}

func summarizeTaskResult(name string, args, value object) object {
	summary := selectFields(value, "agent", "taskId", "threadId", "turnId", "state", "stateScope", "recordedStatus", "runtimeStatus",
		"readObservation", "reason", "conditionMet", "snapshotHash", "changed", "elapsedMs", "observedAt", "waitLimit", "error", "next",
		"finalResponseUnchanged", "finalResponseNext", "attribution", "changeCorrection")
	for _, key := range []string{"agent", "taskId", "threadId", "turnId"} {
		if _, ok := args[key].(string); ok && summary[key] == nil {
			summary[key] = args[key]
		}
	}
	thread, _ := summary["threadId"].(string)
	task, _ := summary["taskId"].(string)
	if thread == "" && task == "" {
		return summary
	}
	if turn, ok := summary["turnId"].(string); ok {
		if pack := dispatchTurnFact(nonemptyTaskText(thread, task), turn, "pack"); pack != nil {
			summary["pack"] = pack
		}
	}
	response, hasResponse := value["finalResponse"].(string)
	if !hasResponse {
		response, hasResponse = field(value["finalResponse"], "text").(string)
	}
	summary["finalResponse"] = nil
	if hasResponse {
		summary["finalResponse"] = runeExcerpt(response, 800)
	}
	summary["finalResponseTruncated"] = hasResponse && (utf8.RuneCountInString(response) > 800 ||
		field(value["finalResponse"], "truncated") == true || field(value["finalResponse"], "textTruncated") == true || value["outputTruncated"] == true)
	summary["files"], summary["filesTruncated"], summary["diffstat"] = nil, false, nil
	evidence := "unavailable: no attributed native file-change evidence"
	if files := decodedTaskList(value["files"]); files != nil {
		evidence = "native-file-changes"
		summary["files"], summary["filesTruncated"] = files[:min(len(files), 50)], len(files) > 50
		var added, removed uint64
		unknown := 0
		for _, row := range files {
			added += uintOr(field(row, "added"), 0)
			removed += uintOr(field(row, "removed"), 0)
			if field(row, "added") == nil || field(row, "removed") == nil {
				unknown++
			}
		}
		summary["diffstat"] = object{"files": len(files), "added": added, "removed": removed, "unknown": unknown}
	}
	changeEvidence, exists := value["changeEvidence"]
	if !exists {
		changeEvidence = evidence
	}
	summary["changeEvidence"] = changeEvidence
	complete := object{"via": "query", "op": "agent_read", "args": object{"agent": summary["agent"], "taskId": summary["taskId"]}}
	if strings.HasPrefix(name, "codex_") {
		pinned := object{"threadId": summary["threadId"], "view": "review"}
		if summary["turnId"] != nil {
			pinned["turnId"] = summary["turnId"]
		}
		complete = object{"via": "query", "op": "codex_read", "args": pinned}
	}
	summary["completeEvidence"] = complete
	if next := obj(summary["next"]); slices.Contains([]string{"codex_wait", "agent_wait", "codex_read", "agent_read"}, text(next, "op")) {
		next = clone(next)
		params := dispatchSetSection(next, "args")
		params["view"] = "summary"
		if next["op"] == "codex_read" && summary["turnId"] != nil {
			params["turnId"] = summary["turnId"]
		}
		summary["next"] = next
	}
	if summary["next"] == nil {
		summary["next"] = complete
	}
	return summary
}

func addCodexTaskSummaryEvidence(value object, turn any) error {
	items := arr(field(turn, "items"))
	value["files"] = nativeReviewFiles(items)
	state, _ := parseTurnWaitState(text(value, "state"))
	if current, resume := field(value["finalResponse"], "itemId").(string); state.terminal() || resume {
		value["finalResponse"] = nil
		for _, item := range slices.Backward(items) {
			if field(item, "type") != "agentMessage" || state.terminal() && field(item, "phase") == "commentary" ||
				!state.terminal() && field(item, "id") != current {
				continue
			}
			value["finalResponse"] = field(item, "text")
			break
		}
	}
	if response := waitResponseText(value); utf8.RuneCountInString(response) > 800 {
		next, err := textContinuation(response)
		if err != nil {
			return err
		}
		value["finalResponseNext"] = next
	}
	return nil
}

func init() {
	controlSummaryRequested = wantsTaskSummary
	projectControlSummary = summarizeTaskResult
}
