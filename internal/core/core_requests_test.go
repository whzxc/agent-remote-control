package core

import (
	"context"
	"testing"
	"time"
)

func TestExplicitWaitCancellationPreservesTheOriginalMCPReply(t *testing.T) {
	// Recurring bug class: lifecycle forwarding an explicit cancellation dropped the response for the active wait.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	started, stopped := make(chan struct{}), make(chan struct{})
	const op = "codex_wait"
	before, present := registeredOperations[op]
	registeredOperations[op] = registeredOperation{handle: func(ctx context.Context, _ operationRequest) (any, error) {
		close(started)
		defer close(stopped)
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	defer func() {
		if present {
			registeredOperations[op] = before
		} else {
			delete(registeredOperations, op)
		}
	}()
	secret, err := ensureFrontDoorSecret()
	if err != nil {
		t.Fatal(err)
	}
	service := &service{source: requestSource{policy: "all"}}
	endpoint := newInProcess(service)
	listener, err := listenPrivate(ctx, "core", secret, endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	defer func() {
		cancel()
		endpoint.drain()
		// The cancelled read can still be writing its final metrics when the
		// client receives its reply. Join unary admissions before removing state.
		deadline := time.NewTimer(time.Second)
		defer deadline.Stop()
		for range cap(endpoint.slots) {
			select {
			case endpoint.slots <- struct{}{}:
			case <-deadline.C:
				t.Error("private requests remained active during fixture cleanup")
				return
			}
		}
	}()
	bridge := &gatewayBridge{}
	request := object{"jsonrpc": "2.0", "id": "first", "method": "tools/call", "params": object{"name": "query",
		"arguments": object{"op": op, "args": object{"threadId": "00000000-0000-4000-8000-000000000001", "timeoutMs": 10000}}}}
	type response struct {
		value object
		err   error
	}
	finished := make(chan response, 1)
	go func() {
		value, err := bridge.mcp(ctx, "default", request)
		finished <- response{value, err}
	}()
	select {
	case <-started:
	case result := <-finished:
		t.Fatalf("wait ended before cancellation: %v, %v", result.value, result.err)
	case <-ctx.Done():
		t.Fatal("Core did not admit the wait")
	}
	notification := object{"jsonrpc": "2.0", "method": "notifications/cancelled", "params": object{"requestId": "first"}}
	if result, err := bridge.mcp(ctx, "default", notification); result != nil || err != nil {
		t.Fatalf("cancellation notice = %v, %v", result, err)
	}
	select {
	case result := <-finished:
		tool := result.value["result"]
		body, err := egressToolValue(tool)
		if err != nil || result.err != nil || result.value["id"] != "first" || field(tool, "resultType") != "complete" ||
			text(body, "reason") != "wait-cancelled" || text(body, "state") != "unconfirmed" {
			t.Fatalf("cancelled wait reply = %v, %v, %v", result.value, result.err, err)
		}
	case <-ctx.Done():
		t.Fatal("gateway did not deliver the original wait reply")
	}
	select {
	case <-stopped:
	case <-ctx.Done():
		t.Fatal("Core continued the cancelled wait")
	}
}
