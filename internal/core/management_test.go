package core

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestDesktopAppStartReusesExistingDesktop(t *testing.T) {
	// Contract: app.start returns the running Desktop's status through the ordinary local management route.
	if operatingSystem == "linux" {
		t.Skip("Linux app.start owns the headless lifecycle")
	}
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	token, err := ensureFrontDoorSecret()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	want := object{"desktopPid": 1234, "bundleId": "fixture.app"}
	target := &service{desktop: func(_ context.Context, route, method string, _ object) (any, error) {
		if route != "app" || method != http.MethodGet {
			return nil, errors.New("unexpected Desktop request")
		}
		return want, nil
	}}
	listener, err := listenPrivate(ctx, "core", token, newInProcess(target), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	launch := func(context.Context) error { return errors.New("app.start attempted to launch a second Desktop") }
	if status, err := managementCallWithDesktopLauncher(ctx, "app.start", object{}, launch); err != nil || wire(status) != wire(want) {
		t.Fatalf("app.start status = %v, %v", status, err)
	}
}

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
