package core

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestSubmissionHistorySkipsFreshThreads(t *testing.T) {
	// Recurring bug class: lifecycle fresh threads could be unmaterialized until their first user message.
	ctx := context.Background()
	fresh, err := controlSubmissionHistory(ctx, true, func(context.Context, any) (object, error) {
		return nil, errors.New("thread is not materialized yet")
	})
	if err != nil || len(fresh) != 0 {
		t.Fatalf("fresh history = %v, %v", fresh, err)
	}
	established, err := controlSubmissionHistory(ctx, false, func(_ context.Context, cursor any) (object, error) {
		if cursor == nil {
			return object{"data": []any{object{"id": "newer"}}, "nextCursor": "older"}, nil
		}
		return object{"data": []any{object{"id": "older"}}, "nextCursor": nil}, nil
	})
	if err != nil || wire(established) != `[{"id":"older"},{"id":"newer"}]` {
		t.Fatalf("existing history = %v, %v", established, err)
	}
}

func TestNativeCleanupIgnoresOnlyUnmaterializedThreads(t *testing.T) {
	// Algorithmic core: cleanup distinguishes a thread that never materialized from unknown archive outcomes.
	result, err := nativeCleanupResult(errors.New("NATIVE_RPC_ERROR: thread example is not materialized yet; thread/archive is unavailable before first user message"))
	if err != nil || wire(result) != wire(object{"archived": false, "reason": "thread-not-materialized"}) {
		t.Fatalf("unmaterialized cleanup = %v, %v", result, err)
	}
	result, err = nativeCleanupResult(nil)
	if err != nil || wire(result) != wire(object{"archived": true}) {
		t.Fatalf("native cleanup = %v, %v", result, err)
	}
	timeout := errors.New("RPC_TIMEOUT: thread/archive")
	if _, err := nativeCleanupResult(timeout); !errors.Is(err, timeout) {
		t.Fatalf("timeout lost: %v", err)
	}
}

func TestDesktopCursorIsBoundToReadSelection(t *testing.T) {
	// Algorithmic core: a desktop cursor resumes the same thread, turn, operation and sort direction.
	args := object{"threadId": "thread", "turnId": "turn", "sortDirection": "desc", "limit": 1}
	data := []any{object{"id": "one"}, object{"id": "two"}}
	first, err := desktopControlPage("thread/items/list", args, data)
	if err != nil {
		t.Fatal(err)
	}
	args["cursor"] = first["nextCursor"]
	second, err := desktopControlPage("thread/items/list", args, data)
	if err != nil || wire(second["data"]) != `[{"id":"two"}]` {
		t.Fatalf("following page = %v, %v", second, err)
	}
	args["threadId"] = "other"
	_, err = desktopControlPage("thread/items/list", args, data)
	if err == nil || !strings.HasPrefix(err.Error(), "DESKTOP_CURSOR_MISMATCH:") || !strings.Contains(err.Error(), "omit cursor") {
		t.Fatalf("changed read = %v", err)
	}
}
