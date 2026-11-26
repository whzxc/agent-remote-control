package core

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func TestWaitStreamProgressAndFinalResponse(t *testing.T) {
	// Contract: wait transport emits progress only with a token and preserves the final MCP reply.
	result := object{"jsonrpc": "2.0", "id": 7, "result": object{"events": []any{}, "state": "timeout"}}
	for _, token := range []any{nil, "caller-token", json.Number("42")} {
		request := object{"id": 7, "params": object{"_meta": object{"progressToken": token}}}
		response := func(accept string) []byte {
			t.Helper()
			var payload []byte
			synctest.Test(t, func(t *testing.T) {
				req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/mcp", nil)
				req.Header.Set("Accept", accept)
				rec := httptest.NewRecorder()
				serveWaitStream(rec, req, request, func(context.Context) (object, error) {
					time.Sleep(61 * time.Second)
					return result, nil
				})
				payload = rec.Body.Bytes()
			})
			return payload
		}
		frame := response("text/event-stream")
		var progress bytes.Buffer
		message, err := forwardSSE(bytes.NewReader(frame), &progress)
		if err != nil || wire(message) != wire(result) {
			t.Fatalf("reply after token %v: %v (%v)", token, message, err)
		}
		if token == nil {
			if progress.Len() != 0 || bytes.Count(frame, []byte(": keepalive\n\n")) != 3 {
				t.Fatalf("unexpected progress without a token: %s", frame)
			}
		} else {
			decoder := json.NewDecoder(&progress)
			decoder.UseNumber()
			for index := uint64(1); index <= 3; index++ {
				var notification object
				if err := decoder.Decode(&notification); err != nil ||
					notification["method"] != "notifications/progress" ||
					field(notification["params"], "progressToken") != token ||
					uintOr(field(notification["params"], "progress"), 0) != index {
					t.Fatalf("progress %d = %v (%v)", index, notification, err)
				}
			}
			if err := decoder.Decode(new(object)); err != io.EOF {
				t.Fatalf("unexpected extra progress: %v", err)
			}
		}
		var decoded object
		if err := decodeObject(response("application/json"), &decoded); err != nil || wire(decoded) != wire(result) {
			t.Fatalf("JSON response %v (%v)", decoded, err)
		}
	}
}

func TestWaitStreamCancelsWhenTheClientDisconnects(t *testing.T) {
	// Recurring bug class: lifecycle a dropped response body or disconnected socket left a wait running.
	for _, raw := range []bool{false, true} {
		finished := make(chan struct{})
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			serveWaitStream(w, r, object{"id": 1}, func(ctx context.Context) (object, error) {
				defer close(finished)
				<-ctx.Done()
				return nil, ctx.Err()
			})
		}))
		result, err := server.Client().Get(server.URL)
		if err != nil {
			server.Close()
			t.Fatal(err)
		}
		if raw {
			server.CloseClientConnections()
		} else {
			_ = result.Body.Close()
		}
		select {
		case <-finished:
		case <-time.After(time.Second):
			_ = result.Body.Close()
			server.Close()
			t.Fatalf("disconnected wait remained active (socket closed by server=%v)", raw)
		}
		_ = result.Body.Close()
		server.Close()
	}
}

func TestStdioWaitsCancelAtEOFDespiteConcurrentRequests(t *testing.T) {
	// Recurring bug class: lifecycle the stdio reader must reach EOF while all response slots are occupied.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	reader, writer := io.Pipe()
	defer writer.Close()
	started := make(chan struct{}, maxInFlight+1)
	finished := make(chan error, 1)
	go func() {
		finished <- parallelJSONLines(ctx, reader, io.Discard, 4096, true,
			func(ctx context.Context, _ io.Writer, _ object) (any, error) {
				started <- struct{}{}
				<-ctx.Done()
				return nil, nil
			})
	}()
	if _, err := io.WriteString(writer, strings.Repeat("{\"id\":1}\n", cap(started))); err != nil {
		t.Fatal(err)
	}
	for range cap(started) {
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatal("pending waits prevented the reader from accepting the last request")
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("stdio waits remained active after EOF")
	}
}
