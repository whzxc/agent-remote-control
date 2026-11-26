package core

import (
	"bufio"
	"errors"
	"io"
)

func nativePersistedTurnMetadata(thread object, turn string) (timing, configuration object) {
	_, home, err := codexInputs()
	if err != nil {
		return nil, nil
	}
	file, err := openNativeHistory(home, thread)
	if err != nil {
		return nil, nil
	}
	defer file.Close()

	var transcript taskCodexTranscript
	var tier taskCodexThreadTier
	var activeTurn string
	var turnTier any = "unknown"
	var matched, oversized bool
	reader := bufio.NewReaderSize(file, (1<<20)+2)
	for {
		data, issue := reader.ReadSlice('\n')
		if errors.Is(issue, bufio.ErrBufferFull) {
			oversized = true
			continue
		}
		skip := oversized || len(data) > (1<<20)+1
		oversized = false
		if len(data) == 0 || (issue != nil && !errors.Is(issue, io.EOF)) {
			break
		}
		var record object
		if skip || decodeObject(data, &record) != nil || !transcript.include(record) {
			continue
		}
		payload, at := field(record, "payload"), text(record, "timestamp")
		if record["type"] == "session_meta" {
			matched = field(payload, "id") == thread["id"]
		}
		if !matched {
			continue
		}
		if field(payload, "type") != "thread_settings_applied" || field(payload, "thread_id") == thread["id"] {
			if tier.observe(record) == turn {
				turnTier = nonemptyTaskText(str(tier.Current), "unknown")
				if configuration != nil {
					configuration["threadServiceTier"] = turnTier
				}
			}
		}
		switch record["type"] {
		case "event_msg":
			switch field(payload, "type") {
			case "task_started":
				if found := text(payload, "turn_id"); found != "" {
					activeTurn = found
					if activeTurn == turn {
						turnTier = nonemptyTaskText(str(tier.Current), "unknown")
						if timing == nil {
							timing = object{}
						}
						if at != "" {
							timing["startedAt"] = at
						}
					}
				}
			case "task_complete", "turn_aborted":
				if nonemptyTaskText(text(payload, "turn_id"), activeTurn) == turn && at != "" {
					if timing == nil {
						timing = object{}
					}
					timing["endedAt"] = at
				}
			}
		case "turn_context":
			if field(payload, "cwd") != thread["cwd"] || field(payload, "turn_id") != turn {
				continue
			}
			value := func(row any, key string) any {
				if existing, ok := obj(row)[key]; ok {
					return existing
				}
				return "unknown"
			}
			sandbox := field(payload, "sandbox_policy")
			configuration = object{"scope": "turn", "source": "native-persisted-turn-context", "turnId": turn, "model": value(payload, "model"),
				"effort": value(payload, "effort"), "mode": value(sandbox, "type"), "networkAccess": value(sandbox, "network_access"),
				"serviceTier": value(payload, "service_tier"), "threadServiceTier": turnTier, "approvalPolicy": value(payload, "approval_policy"), "observedAt": now()}
		}
	}
	return timing, configuration
}
