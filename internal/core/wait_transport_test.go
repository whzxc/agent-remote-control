package core

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestWaitStreamProgressAndFinalResponse(t *testing.T) {
	// Contract: wait transport emits progress only with a token and preserves the final MCP reply.
	result := object{"jsonrpc": "2.0", "id": 7, "result": object{"events": []any{}, "state": "timeout"}}
	for _, token := range []any{nil, "caller-token", json.Number("42")} {
		request := object{"id": 7, "params": object{"_meta": object{"progressToken": token}}}
		frame := waitHeartbeat(request, 1, true) + waitFrame(result, true)
		var progress bytes.Buffer
		message, err := forwardSSE(strings.NewReader(frame), &progress)
		if err != nil || wire(message) != wire(result) {
			t.Fatalf("reply after token %v: %v (%v)", token, message, err)
		}
		if token == nil {
			if progress.Len() != 0 || !strings.HasPrefix(frame, ": keepalive\n\n") {
				t.Fatalf("unexpected progress without a token: %s", progress.String())
			}
		} else {
			var notification object
			if err := decodeObject(progress.Bytes(), &notification); err != nil ||
				notification["method"] != "notifications/progress" ||
				field(notification["params"], "progressToken") != token {
				t.Fatalf("progress %v (%v)", notification, err)
			}
		}
		var decoded object
		payload := waitHeartbeat(request, 1, false) + waitFrame(result, false)
		if err := decodeObject([]byte(payload), &decoded); err != nil || wire(decoded) != wire(result) {
			t.Fatalf("JSON response %v (%v)", decoded, err)
		}
	}
}
