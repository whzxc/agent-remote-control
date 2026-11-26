package core

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

const appUnavailable = "Cannot connect to local Core. Run the CLI again or open Agent Remote Control."

func decodeObject(data []byte, object *object) error { return canonjson.Unmarshal(data, object) }

func httpReply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if status != http.StatusNoContent {
		_, _ = io.WriteString(w, wire(value))
	}
}

type transportTarget interface {
	management(context.Context, string, string, object) (any, error)
	mcp(context.Context, string, object) (object, error)
}

func localHandler(target transportTarget, port int, token string) http.Handler {
	host := "127.0.0.1:" + strconv.Itoa(port)
	localhost := "localhost:" + strconv.Itoa(port)
	admissions := make(chan struct{}, maxInFlight)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != host && !strings.EqualFold(r.Host, localhost) ||
			subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 ||
			r.Header.Get("Origin") != "" && r.Header.Get("Origin") != "http://"+host {
			httpReply(w, http.StatusForbidden, object{"error": "unauthorized"})
			return
		}
		select {
		case admissions <- struct{}{}:
			defer func() { <-admissions }()
		default:
			httpReply(w, http.StatusServiceUnavailable, object{"error": "FRONT_DOOR_BUSY: Wait for an admitted request to finish."})
			return
		}
		var limit int64 = 16 * 1024 * 1024
		if r.URL.Path == "/api/pets/import" {
			limit = 35 * 1024 * 1024
		}
		request := http.NewResponseController(w)
		_ = request.SetReadDeadline(time.Now().Add(5 * time.Second))
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
		_ = request.SetReadDeadline(time.Time{})
		if err != nil {
			httpReply(w, http.StatusBadRequest, object{"error": "invalid request body"})
			return
		}
		body := object{}
		if len(data) != 0 {
			if err := decodeObject(data, &body); err != nil || body == nil {
				httpReply(w, http.StatusBadRequest, object{"error": "invalid JSON"})
				return
			}
		}
		var result any
		var failure error
		switch {
		case r.Method == http.MethodPost && (r.URL.Path == "/mcp" || strings.HasPrefix(r.URL.Path, "/mcp/")):
			ingress := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/mcp"), "/")
			if _, hasID := body["id"]; hasID && isMCPWait(body) {
				serveWaitStream(w, r, body, func(ctx context.Context) (object, error) {
					return target.mcp(ctx, ingress, body)
				})
				return
			}
			value, err := target.mcp(r.Context(), ingress, body)
			if err == nil && value == nil {
				httpReply(w, http.StatusAccepted, nil)
				return
			}
			result, failure = value, err
		case r.Method == http.MethodGet && r.URL.Path == "/healthz":
			result, failure = target.management(r.Context(), "healthz", http.MethodGet, body)
		case strings.HasPrefix(r.URL.Path, "/api/"):
			route := strings.TrimPrefix(r.URL.Path, "/api/")
			if r.URL.RawQuery != "" && r.Method == http.MethodGet && strings.HasPrefix(route, "agents/timeline/") {
				if err := parseTimelineQuery(r.URL.RawQuery, body); err != nil {
					httpReply(w, http.StatusBadRequest, object{"error": err.Error()})
					return
				}
			}
			result, failure = target.management(r.Context(), route, r.Method, body)
		default:
			httpReply(w, http.StatusNotFound, object{"error": "UNKNOWN_ROUTE"})
			return
		}
		if failure != nil {
			httpReply(w, http.StatusBadRequest, object{"error": failure.Error()})
			return
		}
		httpReply(w, http.StatusOK, result)
	})
}

func parseTimelineQuery(query string, body object) error {
	for _, item := range strings.Split(query, "&") {
		key, val, _ := strings.Cut(item, "=")
		key, _ = url.QueryUnescape(key)
		val, _ = url.QueryUnescape(val)
		switch key {
		case "after":
			num, err := strconv.ParseUint(val, 10, 64)
			if err != nil {
				return errors.New("INVALID_TIMELINE_CURSOR")
			}
			body["after"] = num
		case "recent":
			if val == "1" {
				body["recent"] = true
			}
		}
	}
	return nil
}

var loopbackHTTP = &http.Client{Transport: &http.Transport{
	DialContext:       (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
	DisableKeepAlives: true,
}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}

func sendLocal(ctx context.Context, port uint64, token, route, method string, body object) (any, error) {
	return sendLocalWithSSE(ctx, port, token, route, method, body, nil)
}

func sendLocalWithSSE(ctx context.Context, port uint64, token, route, method string, body object, sse io.Writer) (any, error) {
	var input io.Reader
	if method != http.MethodGet {
		input = bytes.NewBufferString(wire(body))
	}
	address := fmt.Sprintf("http://127.0.0.1:%d/%s", port, route)
	req, err := http.NewRequestWithContext(ctx, method, address, input)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if sse != nil {
		req.Header.Set("Accept", "application/json, text/event-stream")
	}
	response, err := loopbackHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if sse != nil && response.Header.Get("Content-Type") == "text/event-stream" {
		return forwardSSE(response.Body, sse)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxFrameBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxFrameBytes {
		return nil, errors.New(frontDoorFrameTooLarge)
	}
	if len(data) == 0 && response.StatusCode/100 == 2 {
		return nil, nil
	}
	var value any
	if err := canonjson.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	if response.StatusCode/100 != 2 {
		return nil, errors.New(text(value, "error"))
	}
	return value, nil
}

func discoverLocal(ctx context.Context) (object, object, error) {
	metadata, err := load(filepath.Join(root(), "app/native.json"))
	port := uintOr(field(metadata, "port"), 0)
	if err != nil || port == 0 || port > 65535 {
		return nil, nil, errors.New(appUnavailable)
	}
	healthContext, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	health, err := sendLocal(healthContext, port, text(metadata, "token"), "healthz", http.MethodGet, nil)
	if err != nil || field(health, "instance") != field(metadata, "instance") {
		return nil, nil, errors.New(appUnavailable)
	}
	return obj(metadata), obj(health), nil
}

func forwardRequest(ctx context.Context, route, method string, body object) (any, error) {
	metadata, health, err := discoverLocal(ctx)
	if err != nil {
		return nil, err
	}
	build, err := processBuildID()
	if err != nil {
		return nil, err
	}
	if health["build"] != metadata["build"] || health["owner"] != "core" || health["version"] != buildVersion ||
		(health["build"] != build && health["runtime"] != "go") {
		return nil, errors.New(coreBuildMismatch)
	}
	if conn, hello, attachErr := attachPrivate(ctx, "core"); attachErr == nil {
		defer conn.Close()
		return privateRequest(ctx, conn, hello, route, method, body)
	}
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	address := "api/" + route
	if route == "healthz" {
		address = route
	}
	return sendLocal(ctx, uintOr(metadata["port"], 0), text(metadata, "token"), address, method, body)
}

func stdioProxy(ctx context.Context, input io.Reader, output io.Writer) error {
	rawPort, exists := os.LookupEnv("ARC_NATIVE_PORT")
	if !exists {
		return errors.New("MCP must be launched by Agent Remote Control")
	}
	port, err := strconv.ParseUint(rawPort, 10, 16)
	if err != nil {
		return errors.New("invalid port")
	}
	token, exists := os.LookupEnv("ARC_NATIVE_TOKEN")
	if !exists {
		return errors.New("missing connector token")
	}
	ingress, exists := os.LookupEnv("ARC_INGRESS_ID")
	if !exists {
		return errors.New("missing ingress id")
	}
	return stdioConnection(ctx, port, token, ingress, input, output)
}

func stdioConnection(ctx context.Context, port uint64, token, ingress string, input io.Reader, output io.Writer) error {
	return serveJSONLines(input, output, func(request object) (any, error) {
		timeout := 120 * time.Second
		if isMCPWait(request) {
			timeout = 1830 * time.Second
		} else {
			switch text(field(request["params"], "arguments"), "op") {
			case "context_amend", "context_check":
				timeout = 150 * time.Second
			}
		}
		wait, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		result, err := sendLocalWithSSE(wait, port, token, "mcp/"+url.PathEscape(ingress), http.MethodPost, request, output)
		id, exists := request["id"]
		if !exists {
			return nil, nil
		}
		if err != nil {
			return object{"jsonrpc": "2.0", "id": id, "error": object{"code": -32603, "message": err.Error()}}, nil
		}
		return result, nil
	})
}

func unmarshalJSON(data []byte, value any) error { return canonjson.Unmarshal(data, value) }

func serveJSONLines(input io.Reader, output io.Writer, dispatch func(object) (any, error)) error {
	reader := bufio.NewScanner(input)
	reader.Buffer(make([]byte, 8192), 16*1024*1024)
	for reader.Scan() {
		var request object
		if err := unmarshalJSON(reader.Bytes(), &request); err != nil {
			return err
		}
		value, err := dispatch(request)
		if err != nil {
			return err
		}
		if value != nil {
			if err := outputLine(output, wire(value)); err != nil {
				return err
			}
		}
	}
	return reader.Err()
}
