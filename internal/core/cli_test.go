package core

import (
	"strings"
	"testing"
)

func TestRuntimeFailureKeepsCommandUsageSeparate(t *testing.T) {
	// Recurring bug class: retry-replay a valid invocation must surface the runtime failure without prescribing argument changes.
	args := []string{"call", "relay.leave", "--stdin"}
	usage, invalid := cliUsage(args)
	if invalid != "" {
		t.Fatal(invalid)
	}
	message := "Relay challenge HTTP 404 Not Found"
	reply := cliErrorResponse(message, usage, args, false)
	detail := obj(reply["error"])
	if reply["ok"] != false || detail["code"] != "COMMAND_FAILED" || detail["message"] != message || detail["usage"] != nil {
		t.Errorf("runtime failure: %v", reply)
	}
	badArgs := cliErrorResponse("INVALID_ARGUMENT: read schema for relay.leave", usage, args, false)
	if field(badArgs["error"], "usage") != usage {
		t.Errorf("invalid invocation: %v", badArgs)
	}
}

func TestRevokedCLISourceOffersAuthorizationRecovery(t *testing.T) {
	// Contract: CLI authorization errors preserve the code, upstream identity and human recovery.
	for _, message := range []string{"SOURCE_REVOKED", "SOURCE_REVOKED: source example-source on ingress example-ingress"} {
		reply := cliErrorResponse(message, "cli app status", []string{"app", "status"}, false)
		detail, next := obj(reply["error"]), obj(reply["next"])
		if reply["schemaVersion"] != 1 || reply["ok"] != false || detail["code"] != "SOURCE_REVOKED" ||
			detail["usage"] != nil || strings.Contains(text(detail, "message"), "Correct usage") ||
			next["op"] != nil || text(next, "hint") == "" {
			t.Errorf("invalid CLI recovery for %q: %v", message, reply)
		}
		if strings.Contains(message, "example-source") && detail["message"] != message {
			t.Errorf("source evidence was lost: %v", detail)
		}
	}
}
