package core

import (
	"strings"
	"testing"
)

func TestDeviceManagementRestoresCompletePeerJSON(t *testing.T) {
	// Contract: management readers receive the complete device task snapshot across MCP output pages.
	snapshot := object{"observedAt": "2026-01-01T00:00:00Z",
		"agents":          object{"codex": object{"sessions": []any{object{"id": "example", "headline": strings.Repeat("x", 30000)}}}},
		"availableAgents": []any{}, "records": []any{}, "omittedRecords": 0}
	encoded := wire(snapshot)
	envelope := egressTool(object{"outputId": "example-output", "nextAction": "control_output",
		"text": encoded[:2048], "nextOffset": 2048}, false)
	complete, err := readDeviceManagementResult(envelope, func(args object) (any, error) {
		offset := int(uintOr(args["offset"], 0))
		if args["outputId"] != "example-output" || offset >= len(encoded) {
			t.Fatalf("unexpected continuation: %v", args)
		}
		end := min(offset+4096, len(encoded))
		page := object{"text": encoded[offset:end]}
		if end < len(encoded) {
			page["nextOffset"] = end
		}
		return egressTool(page, false), nil
	})
	if err != nil || wire(complete) != encoded {
		t.Fatalf("paged response did not restore the snapshot: %v", err)
	}
	direct, err := readDeviceManagementResult(egressTool(clone(snapshot), false), func(args object) (any, error) {
		t.Fatalf("direct reply requested a continuation: %v", args)
		return nil, nil
	})
	if err != nil || wire(field(direct, "agents")) != wire(snapshot["agents"]) {
		t.Fatalf("direct response changed the snapshot: %v", err)
	}
}
