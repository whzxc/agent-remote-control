package core

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
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

func TestCLIRejectsUnknownFieldsAndKeepsStdinCorrectionScoped(t *testing.T) {
	// Contract: CLI validation reports invalid input and only repeats the ID from a misplaced stdin patch.
	for _, input := range []struct {
		args []string
		json string
		want string
	}{
		{[]string{"config", "set", "--stdin"}, `{"maintainerMode":true,"unexpected":"secret-example"}`, "Unknown fields: unexpected"},
		{[]string{"ingress", "update", "--stdin"}, `{"id":"demo","bearerToken":"secret-example"}`, "cli ingress update demo --stdin"},
	} {
		var out bytes.Buffer
		if code := runCLI(t.Context(), input.args, strings.NewReader(input.json), &out, io.Discard); code != 1 {
			t.Fatalf("validation exit = %d (%s)", code, &out)
		}
		var result object
		if err := decodeObject(out.Bytes(), &result); err != nil || !strings.Contains(text(result["error"], "message"), input.want) ||
			strings.Contains(out.String(), "secret-example") {
			t.Fatalf("validation response = %s, %v", &out, err)
		}
	}
	if usage, invalid := cliUsage([]string{"setup", "--locale", "en", "next"}); invalid != "" || !strings.Contains(usage, "[--locale zh-CN|en]") {
		t.Fatalf("localized setup usage = %q, %q", usage, invalid)
	}
}

func TestRevokedCLISourceOffersAuthorizationRecovery(t *testing.T) {
	// Contract: CLI authorization errors preserve the code, upstream identity and human recovery.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	token, err := ensureFrontDoorSecret()
	if err != nil {
		t.Fatal(err)
	}
	errorsToReturn := make(chan error, 1)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	listener, err := listenPrivate(ctx, "core", token, newInProcess(cliAuthorizationTarget{errorsToReturn}), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	credential := object{"type": "ingress"}
	revoked := object{"id": "example-source", "ingressId": "example-ingress", "state": "revoked", "credential": credential}
	removed := clone(revoked)
	removed["state"], removed["connectionRemoved"] = "disconnected", true
	for _, failure := range []error{errors.New("SOURCE_REVOKED"), checkSourceAnchor(revoked, "example-ingress", credential),
		checkSourceAnchor(removed, "example-ingress", credential)} {
		if failure == nil {
			t.Fatal("invalid source retained authority")
		}
		errorsToReturn <- failure
		var output bytes.Buffer
		code := runCLI(ctx, []string{"app", "status"}, strings.NewReader(""), &output, io.Discard)
		var reply object
		if err := decodeObject(output.Bytes(), &reply); err != nil || code != 1 {
			t.Fatalf("CLI authorization exit=%d, response=%s, decode=%v", code, &output, err)
		}
		detail, next := obj(reply["error"]), obj(reply["next"])
		if uintOr(reply["schemaVersion"], 0) != 1 || reply["ok"] != false || detail["code"] != "SOURCE_REVOKED" ||
			detail["usage"] != nil || strings.Contains(text(detail, "message"), "Correct usage") ||
			next["op"] != nil || text(next, "hint") == "" || !strings.HasPrefix(text(detail, "message"), failure.Error()) {
			t.Errorf("invalid CLI recovery for %v: %v", failure, reply)
		}
	}
}

type cliAuthorizationTarget struct{ errors <-chan error }

func (c cliAuthorizationTarget) management(ctx context.Context, route, method string, _ object) (any, error) {
	if route != "app" || method != http.MethodGet {
		return nil, errors.New("unexpected CLI request")
	}
	select {
	case err := <-c.errors:
		return nil, err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (cliAuthorizationTarget) mcp(context.Context, string, object) (object, error) {
	return nil, errors.New("unexpected MCP request")
}
