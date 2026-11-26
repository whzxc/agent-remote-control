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
	"sync"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

const appUnavailable = "Cannot connect to local Core. Run the CLI again or open Agent Remote Control."

func decodeObject(data []byte, object *object) error { return canonjson.Unmarshal(data, object) }

func httpReply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if status != http.StatusNoContent && status != http.StatusNotModified {
		_, _ = io.WriteString(w, wire(value))
	}
}

type transportTarget interface {
	management(context.Context, string, string, object) (any, error)
	mcp(context.Context, string, object) (object, error)
}

type snapshotTransport interface {
	snapshot(context.Context, string, func(string) error) error
}

func localHandler(target transportTarget, port int, token string) http.Handler {
	host := "127.0.0.1:" + strconv.Itoa(port)
	localhost := "localhost:" + strconv.Itoa(port)
	desktopAdmissions := make(chan struct{}, 16)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != host && !strings.EqualFold(r.Host, localhost) ||
			subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 ||
			r.Header.Get("Origin") != "" && r.Header.Get("Origin") != "http://"+host {
			httpReply(w, http.StatusForbidden, object{"error": "unauthorized"})
			return
		}
		if route, local := strings.CutPrefix(r.URL.Path, "/api/"); local &&
			(desktopRoute(route) || route == "service" || route == "subscriptions/open") {
			select {
			case desktopAdmissions <- struct{}{}:
				defer func() { <-desktopAdmissions }()
			default:
				httpReply(w, http.StatusServiceUnavailable, object{"error": desktopBusy})
				return
			}
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
			var timeout net.Error
			if errors.As(err, &timeout) && timeout.Timeout() {
				httpReply(w, http.StatusRequestTimeout, object{"error": "request timeout"})
			} else {
				httpReply(w, http.StatusBadRequest, object{"error": err.Error()})
			}
			return
		}
		body := object{}
		if len(data) != 0 {
			if err := decodeObject(data, &body); err != nil || body == nil {
				httpReply(w, http.StatusBadRequest, object{"error": "invalid JSON"})
				return
			}
		}
		if r.Method == http.MethodGet {
			if kind := snapshotKind(r.URL.Path); kind != "" {
				if provider, ok := target.(snapshotTransport); ok {
					serveSnapshotFrames(w, r, provider, kind)
					return
				}
			}
		}
		var result any
		var failure error
		switch {
		case r.Method == http.MethodPost && (r.URL.Path == "/mcp" || strings.HasPrefix(r.URL.Path, "/mcp/")):
			ingress := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/mcp"), "/")
			if isMCPWait(body) {
				serveWaitStream(w, r, body, func(ctx context.Context) (object, error) {
					return target.mcp(ctx, ingress, body)
				})
				return
			}
			value, err := target.mcp(r.Context(), ingress, body)
			result, failure = value, err
			if value == nil {
				result = nil
			}
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
			ctx := r.Context()
			if r.Method != http.MethodGet && route != "app/snapshot" && route != "cli/control" {
				ctx = context.WithoutCancel(ctx)
			}
			result, failure = target.management(ctx, route, r.Method, body)
		default:
			httpReply(w, http.StatusNotFound, object{"error": "UNKNOWN_ROUTE"})
			return
		}
		if failure != nil {
			httpReply(w, http.StatusBadRequest, object{"error": failure.Error()})
			return
		}
		status := http.StatusOK
		if strings.HasPrefix(r.URL.Path, "/api/") && (r.Method == http.MethodGet ||
			r.URL.Path == "/api/agents/conversations" || r.URL.Path == "/api/agents/conversations/timeline" || r.URL.Path == "/api/tasks/reviews") {
			data := wire(result)
			etag := "\"" + hash([]byte(data)) + "\""
			w.Header().Set("ETag", etag)
			for _, value := range strings.Split(r.Header.Get("If-None-Match"), ",") {
				tag := strings.TrimSpace(value)
				if tag == "*" || strings.TrimPrefix(tag, "W/") == etag {
					status = http.StatusNotModified
					break
				}
			}
		}
		httpReply(w, status, result)
	})
}

func snapshotKind(path string) string {
	switch path {
	case "/api/events":
		return "Status"
	case "/api/browser/events":
		return "Browser"
	case "/api/subscriptions/events":
		return "Subscriptions"
	case "/api/agents/activity/events":
		return "Activity"
	}
	return ""
}

func serveSnapshotHTTP(w http.ResponseWriter, r *http.Request, bridge *gatewayBridge, kind string) {
	serveSnapshotFrames(w, r, bridge, kind)
}

func serveSnapshotFrames(w http.ResponseWriter, r *http.Request, target snapshotTransport, kind string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	controller := http.NewResponseController(w)
	if err := controller.Flush(); err != nil {
		return
	}
	_ = target.snapshot(r.Context(), kind, func(frame string) error {
		_ = controller.SetWriteDeadline(time.Now().Add(2 * time.Second))
		if _, err := io.WriteString(w, frame); err != nil {
			return err
		}
		return controller.Flush()
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
	var health any
	if conn, hello, attachErr := attachPrivate(healthContext, "core"); attachErr == nil {
		health, err = privateRequest(healthContext, conn, hello, "healthz", http.MethodGet, nil)
		_ = conn.Close()
	} else {
		health, err = sendLocal(healthContext, port, text(metadata, "token"), "healthz", http.MethodGet, nil)
	}
	if err != nil || field(health, "instance") != field(metadata, "instance") {
		return nil, nil, errors.New(appUnavailable)
	}
	return obj(metadata), obj(health), nil
}

func forwardRequest(ctx context.Context, route, method string, body object) (any, error) {
	if conn, hello, err := attachPrivate(ctx, "core"); err == nil {
		defer conn.Close()
		return privateRequest(ctx, conn, hello, route, method, body)
	}
	metadata, _, err := discoverLocal(ctx)
	if err != nil {
		return nil, err
	}
	return forwardToCore(ctx, metadata, route, method, body)
}

func forwardToCore(ctx context.Context, metadata object, route, method string, body object) (any, error) {
	if conn, hello, attachErr := attachPrivate(ctx, "core"); attachErr == nil {
		return forwardToVerifiedCore(ctx, metadata, conn, hello, route, method, body)
	}
	ctx, cancel := context.WithTimeout(ctx, localRequestTimeout(route, body))
	defer cancel()
	address := "api/" + route
	if route == "healthz" {
		address = route
	}
	return sendLocal(ctx, uintOr(metadata["port"], 0), text(metadata, "token"), address, method, body)
}

func forwardToVerifiedCore(ctx context.Context, metadata object, conn net.Conn, hello frontDoorHello, route, method string, body object) (any, error) {
	defer conn.Close()
	if text(metadata, "build") == "" || text(metadata, "instance") == "" {
		return privateRequest(ctx, conn, hello, route, method, body)
	}
	probe, cancel := context.WithTimeout(ctx, 2*time.Second)
	health, err := privateRequest(probe, conn, hello, "healthz", http.MethodGet, nil)
	cancel()
	if err != nil {
		return nil, err
	}
	if field(health, "build") != metadata["build"] {
		return nil, errors.New(coreBuildMismatch)
	}
	if field(health, "instance") != metadata["instance"] {
		return nil, errors.New(appUnavailable)
	}
	owned, current, err := attachPrivate(ctx, "core")
	if err != nil {
		return nil, err
	}
	defer owned.Close()
	if current.Generation != hello.Generation {
		return nil, errors.New(appUnavailable)
	}
	return privateRequest(ctx, owned, current, route, method, body)
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

type synchronizedOutput struct {
	sync.Mutex
	writer io.Writer
}

func (o *synchronizedOutput) Write(data []byte) (int, error) {
	o.Lock()
	defer o.Unlock()
	return o.writer.Write(data)
}

func parallelJSONLines(parent context.Context, input io.Reader, output io.Writer, limit int, cancelOnEOF bool,
	dispatch func(context.Context, io.Writer, object) (any, error)) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	reader := bufio.NewReaderSize(input, 8192)
	locked := &synchronizedOutput{writer: output}
	slots := make(chan struct{}, maxInFlight)
	var active sync.WaitGroup
	var failure error
	var failureOnce sync.Once
	defer func() {
		if cancelOnEOF {
			cancel()
		}
		active.Wait()
	}()
	// While a process waits for another stdio request, allow a closed output
	// pipe to end the loop without waiting for the caller to send another line.
	closeInput := func() bool { return false }
	if closer, ok := input.(io.ReadCloser); ok {
		closeInput = context.AfterFunc(ctx, func() { _ = closer.Close() })
	}
	defer closeInput()
	var readErr error
	for {
		line, err := readProtocolLine(reader, limit)
		if err != nil {
			if err != io.EOF {
				readErr = err
				cancel()
			}
			break
		}
		var request object
		if err := decodeObject(line, &request); err != nil {
			cancel()
			active.Wait()
			return err
		}
		if ctx.Err() != nil {
			active.Wait()
			if failure != nil {
				return failure
			}
			return ctx.Err()
		}
		// The stdio MCP reader must be able to observe EOF even when all
		// active calls are long waits. EOF is what cancels those calls.
		if !cancelOnEOF {
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				active.Wait()
				if failure != nil {
					return failure
				}
				return ctx.Err()
			}
		}
		active.Add(1)
		go func() {
			defer active.Done()
			if !cancelOnEOF {
				defer func() { <-slots }()
			}
			response, err := dispatch(ctx, locked, request)
			if err == nil && response != nil {
				err = outputLine(locked, wire(response))
			}
			if err != nil {
				failureOnce.Do(func() {
					failure = err
					cancel()
				})
			}
		}()
	}
	if cancelOnEOF {
		closeInput()
		cancel()
	}
	active.Wait()
	if failure != nil {
		return failure
	}
	if parent.Err() != nil {
		return parent.Err()
	}
	return readErr
}

func stdioConnection(ctx context.Context, port uint64, token, ingress string, input io.Reader, output io.Writer) error {
	return parallelJSONLines(ctx, input, output, 16<<20, true, func(ctx context.Context, writer io.Writer, request object) (any, error) {
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
		result, err := sendLocalWithSSE(wait, port, token, "mcp/"+url.PathEscape(ingress), http.MethodPost, request, writer)
		if errors.Is(err, outputClosed) {
			return nil, err
		}
		id, exists := request["id"]
		if !exists || ctx.Err() != nil {
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

const desktopBusy = "DESKTOP_BUSY: Too many desktop requests are in flight. Wait for completion and read current state before retrying."

type desktopTransport struct {
	server   *http.Server
	listener net.Listener
	endpoint object
}

type desktopListener struct {
	net.Listener
	slots chan struct{}
}

type desktopConn struct {
	net.Conn
	release func()
	once    sync.Once
}

func (c *desktopConn) Close() error {
	c.once.Do(c.release)
	return c.Conn.Close()
}

func (l desktopListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		select {
		case l.slots <- struct{}{}:
			return &desktopConn{Conn: conn, release: func() { <-l.slots }}, nil
		default:
			_ = conn.Close()
		}
	}
}

func desktopOperation(route, method string) bool {
	return desktopRoute(route) || route == "service" && (method == http.MethodGet || method == http.MethodPost) ||
		route == "subscriptions/open" && method == http.MethodPost
}

func listenDesktop(owner func(context.Context, string, string, object) (any, error)) (*desktopTransport, error) {
	raw, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	listener := desktopListener{Listener: raw, slots: make(chan struct{}, 32)}
	port := raw.Addr().(*net.TCPAddr).Port
	token := id() + id()
	address := strconv.Itoa(port)
	admitted := make(chan struct{}, 16)
	server := &http.Server{
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       5 * time.Second,
		MaxHeaderBytes:    16 << 10,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if (r.Host != "127.0.0.1:"+address && !strings.EqualFold(r.Host, "localhost:"+address)) ||
				!secureToken(r.Header.Get("Authorization"), "Bearer "+token) || r.Header.Get("Origin") != "" {
				httpReply(w, http.StatusBadRequest, object{"error": "unauthorized"})
				return
			}
			route := strings.TrimPrefix(r.URL.Path, "/api/")
			if route == r.URL.Path || !desktopOperation(route, r.Method) {
				httpReply(w, http.StatusBadRequest, object{"error": "UNKNOWN_ROUTE"})
				return
			}
			select {
			case admitted <- struct{}{}:
				defer func() { <-admitted }()
			default:
				httpReply(w, http.StatusBadRequest, object{"error": desktopBusy})
				return
			}
			data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 65536))
			body := object{}
			if err == nil && len(data) > 0 {
				err = decodeObject(data, &body)
			}
			if err != nil {
				httpReply(w, http.StatusBadRequest, object{"error": err.Error()})
				return
			}
			_ = http.NewResponseController(w).SetReadDeadline(time.Time{})
			ctx := r.Context()
			if r.Method != http.MethodGet && route != "app/snapshot" {
				ctx = context.WithoutCancel(ctx)
			}
			value, err := owner(ctx, route, r.Method, body)
			if err != nil {
				httpReply(w, http.StatusBadRequest, object{"error": err.Error()})
				return
			}
			httpReply(w, http.StatusOK, value)
		}),
	}
	server.SetKeepAlivesEnabled(false)
	go func() { _ = server.Serve(listener) }()
	return &desktopTransport{server, listener, object{"port": port, "token": token}}, nil
}

func (t *desktopTransport) close() {
	_ = t.listener.Close()
	_ = t.server.Close()
}

func localRequestTimeout(route string, body object) time.Duration {
	switch {
	case route == "setup/wait":
		return time.Duration(min(uintOr(body["timeout"], 60), 86400)+30) * time.Second
	case route == "setup/apply", route == "start", strings.HasSuffix(route, "/start"),
		strings.HasSuffix(route, "/restart"), strings.HasSuffix(route, "/start-all"), strings.HasPrefix(route, "updates/"):
		return 360 * time.Second
	default:
		return 120 * time.Second
	}
}

func forwardDesktop(ctx context.Context, endpoint object, route, method string, body object) (any, error) {
	port := uintOr(endpoint["port"], 0)
	if port == 0 || port > 65535 {
		return nil, errors.New("invalid local endpoint")
	}
	wait, cancel := context.WithTimeout(ctx, localRequestTimeout(route, body))
	defer cancel()
	return sendLocal(wait, port, text(endpoint, "token"), "api/"+route, method, body)
}
