package core

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const downstreamFrameLimit = 32 * 1024 * 1024

// The native proxy module supplies the saved network policy through its own registration.
var downstreamMCPProxy func(context.Context) (func(*http.Request) (*url.URL, error), error)

func registerDownstreamMCPProxy(resolve func(context.Context) (func(*http.Request) (*url.URL, error), error)) {
	downstreamMCPProxy = resolve
}

type mcpSession struct {
	endpoint  object
	input     io.WriteCloser
	child     *exec.Cmd
	client    *http.Client
	mu        sync.Mutex
	writeLock sync.Mutex
	pending   map[uint64]chan object
	next      atomic.Uint64
	stale     atomic.Bool
	closed    chan struct{}
	closeOnce sync.Once
	sessionID string
	protocol  string
	info      object
}

func stringValues(value any) []string {
	if values, ok := value.([]string); ok {
		return values
	}
	result := make([]string, 0, len(arr(value)))
	for _, entry := range arr(value) {
		result = append(result, str(entry))
	}
	return result
}

func openMCP(ctx context.Context, endpoint object) (_ *mcpSession, err error) {
	s := &mcpSession{endpoint: endpoint, pending: make(map[uint64]chan object), closed: make(chan struct{})}
	defer func() {
		if err != nil {
			s.close()
		}
	}()
	if endpoint["transport"] == "stdio" {
		command := exec.Command(text(endpoint, "command"), stringValues(endpoint["args"])...)
		command.Dir = text(endpoint, "cwd")
		command.Env = os.Environ()
		for key, value := range obj(endpoint["env"]) {
			command.Env = append(command.Env, key+"="+str(value))
		}
		input, err := command.StdinPipe()
		if err != nil {
			return nil, err
		}
		output, err := command.StdoutPipe()
		if err != nil {
			input.Close()
			return nil, err
		}
		if err := startOwnedChild(command); err != nil {
			input.Close()
			output.Close()
			return nil, fmt.Errorf("MCP_STDIO_START_FAILED: %w", err)
		}
		s.input, s.child = input, command
		go func() { s.readStdio(output); s.reap() }()
	} else {
		proxy := http.ProxyFromEnvironment
		if downstreamMCPProxy != nil {
			var resolveErr error
			proxy, resolveErr = downstreamMCPProxy(ctx)
			if resolveErr != nil {
				return nil, errors.New("MCP_PROXY_FAILED: Inspect ARC network settings")
			}
		}
		s.client = &http.Client{Transport: &http.Transport{Proxy: proxy, DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	result, err := s.request(ctx, "initialize", object{"protocolVersion": "2025-11-25", "capabilities": object{}, "clientInfo": object{"name": "arc-mcp-hub", "version": buildVersion}})
	if err != nil {
		return nil, err
	}
	switch text(result, "protocolVersion") {
	case "2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25":
		s.protocol = text(result, "protocolVersion")
	default:
		return nil, errors.New("MCP_PROTOCOL_UNSUPPORTED: The server selected an unsupported protocol version")
	}
	if err := s.notify(ctx, "notifications/initialized", nil); err != nil {
		return nil, err
	}
	s.info = obj(result)
	return s, nil
}

func (s *mcpSession) readStdio(output io.Reader) {
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 8192), downstreamFrameLimit)
	for scanner.Scan() {
		var message object
		if err := decodeObject(scanner.Bytes(), &message); err != nil {
			continue
		}
		method := text(message, "method")
		if method == "notifications/tools/list_changed" {
			s.stale.Store(true)
		}
		if method != "" {
			if id, exists := message["id"]; exists {
				reply := object{"jsonrpc": "2.0", "id": id}
				if method == "ping" {
					reply["result"] = object{}
				} else {
					reply["error"] = object{"code": -32601, "message": "Client capability not supported"}
				}
				if err := s.write(reply); err != nil {
					return
				}
			}
			continue
		}
		id, ok := uintValue(message["id"])
		if !ok {
			continue
		}
		s.mu.Lock()
		ch := s.pending[id]
		if ch != nil {
			ch <- message
			delete(s.pending, id)
		}
		s.mu.Unlock()
	}
}

func (s *mcpSession) write(message object) error {
	s.writeLock.Lock()
	defer s.writeLock.Unlock()
	if _, err := io.WriteString(s.input, wire(message)+"\n"); err != nil {
		return fmt.Errorf("MCP_STDIO_CLOSED: %w", err)
	}
	return nil
}

func (s *mcpSession) request(ctx context.Context, method string, params object) (any, error) {
	if !s.alive() {
		return nil, errors.New("MCP_SESSION_CLOSED: Retry the request")
	}
	id := s.next.Add(1)
	msg := object{"jsonrpc": "2.0", "id": id, "method": method, "params": params}
	var response object
	if s.client != nil {
		value, err := s.httpRequest(ctx, http.MethodPost, msg, id)
		if err != nil {
			return nil, err
		}
		response = value
	} else {
		reply := make(chan object, 1)
		s.mu.Lock()
		s.pending[id] = reply
		s.mu.Unlock()
		defer func() { s.mu.Lock(); delete(s.pending, id); s.mu.Unlock() }()
		if err := s.write(msg); err != nil {
			return nil, err
		}
		select {
		case response = <-reply:
		case <-s.closed:
			return nil, errors.New("MCP_STDIO_CLOSED: The downstream process stopped")
		case <-ctx.Done():
			go func() {
				_ = s.notify(context.Background(), "notifications/cancelled", object{"requestId": id, "reason": "timeout"})
			}()
			return nil, fmt.Errorf("MCP_TIMEOUT: %s", method)
		}
	}
	if failure, exists := response["error"]; exists {
		return nil, fmt.Errorf("MCP_RPC_ERROR: %s", wire(failure))
	}
	if result, exists := response["result"]; exists {
		return result, nil
	}
	return nil, errors.New("MCP_INVALID_RESPONSE: Missing result")
}

func (s *mcpSession) notify(ctx context.Context, method string, params object) error {
	frame := object{"jsonrpc": "2.0", "method": method}
	if params != nil {
		frame["params"] = params
	}
	if s.client == nil {
		return s.write(frame)
	}
	_, err := s.httpRequest(ctx, http.MethodPost, frame, 0)
	return err
}

func (s *mcpSession) httpRequest(ctx context.Context, method string, payload object, id uint64) (object, error) {
	var input io.Reader
	if payload != nil {
		input = strings.NewReader(wire(payload))
	}
	req, err := http.NewRequestWithContext(ctx, method, text(s.endpoint, "url"), input)
	if err != nil {
		return nil, err
	}
	for key, v := range obj(s.endpoint["headers"]) {
		req.Header.Set(key, str(v))
	}
	req.Header.Set("Accept", "application/json, text/event-stream")
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	s.mu.Lock()
	if s.sessionID != "" {
		req.Header.Set("Mcp-Session-Id", s.sessionID)
	}
	if s.protocol != "" {
		req.Header.Set("MCP-Protocol-Version", s.protocol)
	}
	s.mu.Unlock()
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("MCP_CONNECTION_LOST: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("MCP_HTTP_%d: Downstream MCP request failed", resp.StatusCode)
	}
	if identifier := resp.Header.Get("Mcp-Session-Id"); identifier != "" {
		s.mu.Lock()
		s.sessionID = identifier
		s.mu.Unlock()
	}
	if id == 0 {
		return nil, nil
	}
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 8192), downstreamFrameLimit)
		var fields []string
		size := 0
		for scanner.Scan() {
			line := scanner.Text()
			if data, ok := strings.CutPrefix(line, "data:"); ok {
				fields = append(fields, strings.TrimPrefix(data, " "))
				size += len(data)
				if size > downstreamFrameLimit {
					return nil, errors.New("MCP_RESPONSE_TOO_LARGE")
				}
			}
			if line == "" && len(fields) != 0 {
				var result object
				err := decodeObject([]byte(strings.Join(fields, "\n")), &result)
				if err != nil {
					return nil, err
				}
				if uintOr(result["id"], 0) == id {
					return result, nil
				}
				fields = nil
				size = 0
			}
		}
		if err := scanner.Err(); err != nil {
			return nil, err
		}
		return nil, errors.New("MCP_CONNECTION_LOST: The response stream closed")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, downstreamFrameLimit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > downstreamFrameLimit {
		return nil, errors.New("MCP_RESPONSE_TOO_LARGE")
	}
	var result object
	if err := decodeObject(bytes.TrimSpace(data), &result); err != nil {
		return nil, err
	}
	if uintOr(result["id"], 0) != id {
		return nil, errors.New("MCP_INVALID_RESPONSE: Response ID does not match")
	}
	return result, nil
}

func (s *mcpSession) alive() bool {
	select {
	case <-s.closed:
		return false
	default:
		return true
	}
}

func (s *mcpSession) reap() {
	_ = s.child.Wait()
	s.closeOnce.Do(func() { close(s.closed) })
}

func (s *mcpSession) close() {
	s.closeOnce.Do(func() {
		close(s.closed)
		if s.child != nil {
			_ = s.input.Close()
			_ = s.child.Process.Kill()
		}
		if s.client != nil {
			s.mu.Lock()
			hasSession := s.sessionID != ""
			s.mu.Unlock()
			if hasSession {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				_, _ = s.httpRequest(ctx, http.MethodDelete, nil, 0)
			}
			s.client.CloseIdleConnections()
		}
	})
}
