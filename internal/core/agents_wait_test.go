package core

import "testing"

func TestNativeAgentWaitResponseNeedsTerminalOrCompletedMessage(t *testing.T) {
	// Algorithmic core: only completed Pi messages are released before a terminal observation.
	for _, agent := range []string{"pi", "opencode"} {
		task := object{"agent": agent, "output": "partial"}
		if response := nativeAgentWaitResponse(task, "running"); response != nil {
			t.Fatalf("%s leaked incomplete output: %s", agent, wire(response))
		}
		for _, state := range []string{"completed", "failed", "cancelled", "interaction-required"} {
			if response := nativeAgentWaitResponse(task, state); response != "partial" {
				t.Fatalf("%s %s response = %s", agent, state, wire(response))
			}
		}
		task["lastMessage"], task["output"] = object{"role": "assistant"}, "completed message"
		if response := nativeAgentWaitResponse(task, "running"); (response == "completed message") != (agent == "pi") {
			t.Fatalf("%s confirmed message projection = %s", agent, wire(response))
		}
	}
}
