package core

import (
	"maps"
	"slices"
	"testing"
)

func TestTaskWaitCapsAndContinuationsFollowSourceMetadata(t *testing.T) {
	// Algorithmic core: task wait caps and continuations follow the authenticated source metadata.
	for _, preset := range append(slices.Clone(sourcePresets()), object{"id": "custom"}) {
		source := text(preset, "id")
		expected := uint64(1800000)
		if source == "claude" {
			expected = 170000
		}
		for _, op := range []string{"codex_wait", "agent_wait"} {
			for _, until := range []string{"terminal", "interaction-required", "terminal-or-interaction"} {
				args := object{"threadId": "thread", "agent": "pi", "taskId": "task", "turnId": "turn", "timeoutMs": 1800000, "until": until}
				cap := limitWait(object{"controlSource": source}, args)
				if uintOr(args["timeoutMs"], 0) != expected || (cap != nil) != (source == "claude") {
					t.Fatalf("%s %s %s: invalid cap %v with args %v", source, op, until, cap, args)
				}
				if cap != nil && (cap["capped"] != true || uintOr(cap["requestedTimeoutMs"], 0) != 1800000 || uintOr(cap["timeoutMs"], 0) != expected) {
					t.Fatalf("%s: invalid cap explanation %v", source, cap)
				}
				result := object{"state": "timeout", "snapshotHash": "opaque"}
				nextControl(result, op, args, false)
				next := obj(field(result["next"], "args"))
				if next["until"] != until || uintOr(next["timeoutMs"], 0) != expected || next["expectedHash"] != "opaque" {
					t.Fatalf("%s %s %s: invalid continuation %v", source, op, until, next)
				}
			}
		}
	}
	for _, args := range []object{{}, {"timeoutMs": 30000}, {"timeoutMs": 170000}} {
		original := maps.Clone(args)
		if cap := limitWait(object{"controlSource": "claude"}, args); cap != nil || !maps.Equal(args, original) {
			t.Fatalf("under-limit timeout changed: %v => %v", original, args)
		}
	}
}
