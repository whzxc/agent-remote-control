package core

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

func acceptsSSE(accept string) bool {
	for _, option := range strings.Split(accept, ",") {
		value, _, _ := strings.Cut(strings.TrimSpace(option), ";")
		if value == "text/event-stream" {
			return true
		}
	}
	return false
}

func isMCPWait(request object) bool {
	params := request["params"]
	return request["method"] == "tools/call" && field(params, "name") == "query" && isWaitOp(text(field(params, "arguments"), "op"))
}

func waitFrame(value object, sse bool) string {
	if sse {
		return "event: message\ndata: " + wire(value) + "\n\n"
	}
	return wire(value)
}

func waitHeartbeat(request object, progress uint64, sse bool) string {
	if !sse {
		return " \n"
	}
	token := field(field(request["params"], "_meta"), "progressToken")
	switch token.(type) {
	case string, json.Number:
		return waitFrame(object{"jsonrpc": "2.0", "method": "notifications/progress",
			"params": object{"progressToken": token, "progress": progress, "message": "Waiting for ARC events"}}, true)
	default:
		return ": keepalive\n\n"
	}
}

func serveWaitStream(w http.ResponseWriter, r *http.Request, request object, operation func(context.Context) (object, error)) {
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	sse := acceptsSSE(r.Header.Get("Accept"))
	if sse {
		w.Header().Set("Content-Type", "text/event-stream")
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	w.Header().Set("Cache-Control", "no-store, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	type result struct {
		value object
		err   error
	}
	finished := make(chan result, 1)
	go func() {
		value, err := operation(ctx)
		finished <- result{value, err}
	}()
	controller := http.NewResponseController(w)
	write := func(frame string) error {
		if _, err := io.WriteString(w, frame); err != nil {
			return err
		}
		return controller.Flush()
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	var count uint64
	for {
		if ctx.Err() != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case done := <-finished:
			value := done.value
			if done.err != nil {
				value = object{"jsonrpc": "2.0", "id": request["id"], "error": object{"code": -32603, "message": done.err.Error()}}
			}
			_ = write(waitFrame(value, sse))
			return
		case <-timer.C:
			count++
			if err := write(waitHeartbeat(request, count, sse)); err != nil {
				return
			}
			timer.Reset(30 * time.Second)
		}
	}
}

func forwardSSE(input io.Reader, output io.Writer) (object, error) {
	const limit = 16 * 1024 * 1024
	reader := bufio.NewReader(input)
	frame := make([]byte, 0, 4096)
	for {
		part, err := reader.ReadSlice('\n')
		if len(frame)+len(part) > limit {
			return nil, errors.New("MCP response too large")
		}
		frame = append(frame, part...)
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			if err == io.EOF {
				break
			}
			return nil, err
		}
		if len(frame) < 2 || frame[len(frame)-2] != '\n' {
			continue
		}
		for line := range strings.SplitSeq(string(frame), "\n") {
			payload, ok := strings.CutPrefix(line, "data: ")
			if !ok {
				continue
			}
			var message object
			if err := decodeObject([]byte(payload), &message); err != nil {
				return nil, err
			}
			if _, ok := message["id"]; ok {
				return message, nil
			}
			if message["method"] == "notifications/progress" {
				if err := outputLine(output, wire(message)); err != nil {
					return nil, err
				}
			}
		}
		frame = frame[:0]
	}
	return nil, errors.New("MCP stream closed before response")
}
