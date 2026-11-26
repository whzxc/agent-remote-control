package core

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

type attachHello struct {
	Version uint16 `json:"version"`
	Token   string `json:"token"`
}

func ipcEndpoint(owner string) string {
	state := root()
	if operatingSystem != "windows" {
		if canonical, err := filepath.EvalSymlinks(state); err == nil {
			if absolute, err := filepath.Abs(canonical); err == nil {
				state = absolute
			}
		}
	}
	return platform.IPCPath(strconv.Itoa(os.Geteuid()), hash([]byte(state))[:24], owner)
}

func ensureFrontDoorSecret() (string, error) {
	file := filepath.Join(root(), "app/front-door-secret.json")
	if _, err := os.Stat(file); errors.Is(err, os.ErrNotExist) {
		if err := save(file, object{"token": id() + id()}); err != nil {
			return "", err
		}
	}
	return frontDoorSecret()
}

func frontDoorSecret() (string, error) {
	value, err := load(filepath.Join(root(), "app/front-door-secret.json"))
	if err != nil {
		return "", err
	}
	token := text(value, "token")
	if token == "" {
		return "", errors.New("FRONT_DOOR_SECRET_MISSING")
	}
	return token, nil
}

func secureToken(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

type privateListener struct {
	mu sync.Mutex
	net.Listener
	path   string
	closed bool
	done   chan struct{}
}

func (l *privateListener) Accept() (net.Conn, error) {
	for {
		l.mu.Lock()
		listener := l.Listener
		l.mu.Unlock()
		conn, err := listener.Accept()
		if err == nil {
			return conn, nil
		}
		l.mu.Lock()
		rebound := !l.closed && listener != l.Listener
		l.mu.Unlock()
		if !rebound {
			return nil, err
		}
	}
}

func (l *privateListener) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil
	}
	l.closed = true
	close(l.done)
	err := l.Listener.Close()
	if operatingSystem != "windows" {
		_ = os.Remove(l.path)
		_ = os.Remove(filepath.Dir(l.path))
	}
	return err
}

func openPrivateListener(path string) (net.Listener, error) {
	listener, err := platform.ListenIPC(path)
	if local, ok := listener.(*net.UnixListener); ok {
		local.SetUnlinkOnClose(false)
	}
	return listener, err
}

func (l *privateListener) supervise(ctx context.Context) {
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-l.done:
			return
		case <-tick.C:
		}
		l.mu.Lock()
		if !l.closed {
			if _, err := os.Lstat(l.path); errors.Is(err, os.ErrNotExist) {
				rebound, err := openPrivateListener(l.path)
				if err == nil {
					old := l.Listener
					l.Listener = rebound
					_ = old.Close()
				} else {
					recordLog("ERROR", "Cannot rebind private ARC endpoint: "+err.Error(), nil)
				}
			}
		}
		l.mu.Unlock()
	}
}

func listenPrivate(ctx context.Context, endpoint, token string, core *inProcess, stop func()) (net.Listener, error) {
	path := ipcEndpoint(endpoint)
	socket, err := openPrivateListener(path)
	if err != nil {
		return nil, err
	}
	listener := &privateListener{Listener: socket, path: path, done: make(chan struct{})}
	if operatingSystem != "windows" {
		go listener.supervise(ctx)
	}
	connections := make(chan struct{}, maxInFlight)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			select {
			case connections <- struct{}{}:
				go func() {
					defer func() { <-connections }()
					defer conn.Close()
					defer context.AfterFunc(ctx, func() { conn.Close() })()
					servePrivate(ctx, core, token, conn, stop)
				}()
			default:
				conn.Close()
			}
		}
	}()
	return listener, nil
}

func servePrivate(parent context.Context, core *inProcess, token string, conn net.Conn, stop func()) {
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	var attach map[string]json.RawMessage
	if err := readFrame(conn, 4096, &attach); err != nil || len(attach) != 1 {
		return
	}
	if data, requested := attach["Stop"]; requested {
		var credentials struct {
			Token string `json:"token"`
		}
		if stop != nil && canonjson.Unmarshal(data, &credentials) == nil && secureToken(token, credentials.Token) {
			_ = writeFrame(conn, object{"Ok": object{"stopping": true}})
			stop()
		}
		return
	}
	var message attachHello
	if err := canonjson.Unmarshal(attach["Hello"], &message); err != nil || !secureToken(token, message.Token) {
		return
	}
	if stop != nil && fixtureIncompatibleFrontDoor != nil && fixtureIncompatibleFrontDoor() {
		message.Version = 0
	}
	hello, err := core.hello(message.Version)
	if err != nil {
		_ = writeFrame(conn, object{"Err": err.Error()})
		return
	}
	if err := writeFrame(conn, object{"Ok": hello}); err != nil {
		return
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var envelope map[string]json.RawMessage
	if err := readFrame(conn, maxRequestBytes+4096, &envelope); err != nil || len(envelope) != 1 {
		return
	}
	if frame, ok := envelope["Cancel"]; ok {
		var cancel frontDoorCancellation
		if err := canonjson.Unmarshal(frame, &cancel); err == nil {
			_ = core.cancel(cancel)
		}
		return
	}
	frame := envelope["Request"]
	stream := false
	if stop != nil {
		frame = envelope["Gateway"]
	} else if snapshot, ok := envelope["Stream"]; ok {
		frame, stream = snapshot, true
	}
	if len(frame) == 0 || len(frame) > maxRequestBytes {
		return
	}
	var request frontDoorRequest
	if err := canonjson.Unmarshal(frame, &request); err != nil {
		return
	}
	remaining, err := request.Deadline.remaining()
	if err != nil {
		return
	}
	_ = conn.SetWriteDeadline(time.Now().Add(remaining))
	_ = conn.SetReadDeadline(time.Now().Add(remaining))
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	go func() {
		var unexpected [1]byte
		_, _ = conn.Read(unexpected[:])
		cancel()
	}()
	if stream {
		err := core.snapshotStream(ctx, request, func(frame frontDoorStream) error {
			_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
			return writeFrame(conn, object{"Ok": frame})
		})
		if err != nil && ctx.Err() == nil {
			_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
			_ = writeFrame(conn, object{"Err": err.Error()})
		}
		return
	}
	value, err := core.admit(ctx, request)
	body := object{"Ok": value}
	if err != nil {
		body = object{"Err": err.Error()}
	}
	if privateFixtureResponse != nil {
		if err := privateFixtureResponse(ctx, request.ID); err != nil {
			return
		}
	}
	_ = writeFrame(conn, frontDoorResponse{Generation: core.generation, RequestID: request.ID, Body: body})
}

type privateOpenError struct {
	owner string
	cause error
}

func (e *privateOpenError) Error() string {
	code := "FRONT_DOOR_UNAVAILABLE"
	if e.owner == "core" {
		code = "FRONT_DOOR_CORE_UNAVAILABLE"
	}
	if platform.IPCBusy(e.cause) {
		return fmt.Sprintf("%s: The local %s named pipe is busy. Retry the connection. (%s)", code, e.owner, e.cause)
	}
	return fmt.Sprintf("%s: %s. Continuity is reduced; Core-bound fallback transports disconnect during Core replacement.", code, e.cause)
}

func missingPrivateEndpoint(err error) bool {
	var open *privateOpenError
	return errors.As(err, &open) && (errors.Is(open.cause, os.ErrNotExist) ||
		errors.Is(open.cause, syscall.ECONNREFUSED))
}

func attachPrivate(ctx context.Context, endpoint string) (net.Conn, frontDoorHello, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var hello frontDoorHello
	conn, err := platform.DialIPC(ctx, ipcEndpoint(endpoint))
	if err != nil {
		return nil, hello, &privateOpenError{owner: endpoint, cause: err}
	}
	token, err := frontDoorSecret()
	if err != nil {
		conn.Close()
		return nil, hello, err
	}
	if err := privateHello(ctx, conn, token, &hello); err != nil {
		conn.Close()
		return nil, hello, err
	}
	return conn, hello, nil
}

func privateHello(ctx context.Context, conn net.Conn, token string, hello *frontDoorHello) error {
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	deadline, _ := ctx.Deadline()
	_ = conn.SetDeadline(deadline)
	if err := writeFrame(conn, object{"Hello": attachHello{Version: frontDoorVersion, Token: token}}); err != nil {
		return err
	}
	var response map[string]json.RawMessage
	if err := readFrame(conn, 4096, &response); err != nil {
		return err
	}
	if failure := response["Err"]; failure != nil {
		var message string
		if canonjson.Unmarshal(failure, &message) == nil {
			return errors.New(message)
		}
	}
	if err := canonjson.Unmarshal(response["Ok"], hello); err != nil {
		return err
	}
	if hello.Version != frontDoorVersion {
		return errors.New("FRONT_DOOR_PROTOCOL_MISMATCH: Install a matching ARC build; run arc front-door-prepare before restarting Core.")
	}
	if hello.Readiness != "Ready" {
		return errors.New("FRONT_DOOR_CORE_DRAINING: Wait for Core readiness and read the original receipt before retrying a write.")
	}
	return nil
}

type privateManagement struct {
	Route  string `json:"route"`
	Method string `json:"method"`
}

func privateManagementOperation(route, method string) any {
	switch route {
	case "healthz":
		return "Health"
	case "cli/control":
		return "LocalControl"
	}
	return object{"Management": privateManagement{Route: route, Method: method}}
}

func privateRequest(ctx context.Context, conn net.Conn, hello frontDoorHello, route, method string, body object) (any, error) {
	if path, query, found := strings.Cut(route, "?"); found && method == http.MethodGet && strings.HasPrefix(path, "agents/timeline/") {
		body = maps.Clone(body)
		if body == nil {
			body = object{}
		}
		if err := parseTimelineQuery(query, body); err != nil {
			return nil, err
		}
		route = path
	}
	request := newPrivateRequest(ctx, privateManagementOperation(route, method), "Management", body)
	request.Generation = hello.Generation
	return exchangePrivate(ctx, conn, request, "Request")
}

func privateEnvelope(operationName any, body object) object {
	switch str(operationName) {
	case "Mcp":
		return obj(field(body["params"], "arguments"))
	case "PeerControl":
		return obj(body["body"])
	default:
		return body
	}
}

func newPrivateRequest(ctx context.Context, operationName any, authority any, body object) frontDoorRequest {
	body = maps.Clone(body)
	switch str(operationName) {
	case "Mcp":
		if params := maps.Clone(obj(body["params"])); params != nil {
			if args := obj(params["arguments"]); args != nil {
				params["arguments"] = maps.Clone(args)
			}
			body["params"] = params
		}
	case "PeerControl":
		body["body"] = maps.Clone(obj(body["body"]))
	}
	envelope := privateEnvelope(operationName, body)
	op, args := text(envelope, "op"), field(envelope, "args")
	spec := operation(op)
	requestID := text(args, "requestId")
	stampReceipt := retryContract(spec)["mode"] == "receipt"
	if op == "device" {
		innerOp := text(args, "op")
		if outerID := text(envelope, "requestId"); outerID != "" {
			requestID = outerID
		}
		if innerID := text(field(args, "args"), "requestId"); requestID == "" || innerOp == "receipt" && innerID != "" {
			requestID = innerID
		}
		innerSpec := operation(innerOp)
		stampReceipt = innerOp != "receipt" && innerSpec != nil && via(innerSpec) == "act"
	} else if op != "receipt" && text(args, "device") != "" && spec != nil && via(spec) == "act" {
		stampReceipt = true
	}
	if requestID == "" {
		requestID = text(envelope, "requestId")
	}
	if requestID == "" {
		requestID = id()
	}
	if _, supplied := envelope["requestId"]; !supplied && stampReceipt {
		switch str(operationName) {
		case "Mcp":
			if envelope != nil && body["method"] == "tools/call" && field(body["params"], "name") == "act" {
				envelope["requestId"] = requestID
			}
		case "LocalControl":
			envelope["requestId"] = requestID
		case "PeerControl":
			if envelope != nil && body["tool"] == "act" {
				envelope["requestId"] = requestID
			}
		}
	}
	timeout := 1830 * time.Second
	if field(authority, "Browser") != nil && field(operationName, "Snapshot") == nil {
		timeout = 30 * time.Second
	}
	deadline := time.Now().Add(timeout)
	if limit, ok := ctx.Deadline(); ok && limit.Before(deadline) {
		deadline = limit
	}
	return frontDoorRequest{Version: frontDoorVersion, ID: requestID, Deadline: frontDoorDeadline{UnixMS: uint64(deadline.UnixMilli())},
		Context: frontDoorContext{Authority: authority}, Operation: operationName, Body: body}
}

func isPrivateWrite(request frontDoorRequest) bool {
	body := obj(request.Body)
	envelope := privateEnvelope(request.Operation, body)
	args := envelope["args"]
	op := text(envelope, "op")
	if op == "device" {
		op, args = text(args, "op"), field(args, "args")
	}
	if op == "receipt" && (text(args, "action") == "" || text(args, "action") == "read") {
		return false
	}
	switch str(request.Operation) {
	case "Health":
		return false
	case "Mcp":
		return body["method"] == "tools/call" && field(body["params"], "name") == "act"
	case "PeerControl":
		return body["tool"] == "act"
	case "LocalControl":
		spec := operation(op)
		return spec != nil && via(spec) == "act"
	}
	if raw, ok := obj(request.Operation)["Management"]; ok {
		route, method := text(raw, "route"), text(raw, "method")
		if management, ok := raw.(privateManagement); ok {
			route, method = management.Route, management.Method
		}
		return method != http.MethodGet && !(method == http.MethodPost && route == "state/wait")
	}
	if raw, ok := obj(request.Operation)["Authority"]; ok {
		switch text(raw, "op") {
		case "get", "for_grant", "control_sources", "candidates", "grant_active", "validate_claim", "active_grants", "default_policy", "ingress_retired":
			return false
		}
		return true
	}
	return false
}

func lostPrivate(request frontDoorRequest, reason error) error {
	if !isPrivateWrite(request) {
		return fmt.Errorf("FRONT_DOOR_CORE_LOST: %s. Read failed; issue a new authorized read when Core is ready.", reason)
	}
	if next, target := forwardedDeviceReceipt(request); next != nil {
		return errors.New(wire(object{"code": -32603,
			"message": "Controller Core disconnected after a member write; outcome is uncertain. Do not resend the write.",
			"data":    object{"state": "unconfirmed", "requestId": target, "reason": reason.Error(), "next": next}}))
	}
	next := object{"via": "act", "op": "receipt", "args": object{"action": "read", "requestId": request.ID}}
	return errors.New(wire(object{"code": -32603,
		"message": "Core disconnected after write submission; outcome is uncertain. Do not repeat the write.",
		"data":    object{"state": "unconfirmed", "requestId": request.ID, "reason": reason.Error(), "next": next}}))
}

func notSentPrivate(request frontDoorRequest, code, reason string) error {
	return errors.New(wire(object{"code": -32603, "message": code + ": " + reason + " Request was not sent to Core.",
		"data": object{"requestId": request.ID, "next": object{"via": "query", "op": "guide", "args": object{"topic": "loop"}}}}))
}

func exchangePrivate(ctx context.Context, conn net.Conn, request frontDoorRequest, envelope string) (any, error) {
	if _, err := request.Deadline.remaining(); err != nil {
		return nil, notSentPrivate(request, "FRONT_DOOR_DEADLINE_EXPIRED", "The original admission deadline expired. Read current state before retrying with the same requestId.")
	}
	_ = conn.SetDeadline(time.UnixMilli(int64(request.Deadline.UnixMS)))
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	encoded, err := boundedPrivateJSON(request, maxRequestBytes)
	if err != nil {
		return nil, err
	}
	if err := writeFrame(conn, object{envelope: json.RawMessage(encoded)}); err != nil {
		return nil, lostPrivate(request, err)
	}
	var response frontDoorResponse
	if err := readFrame(conn, maxFrameBytes, &response); err != nil {
		return nil, lostPrivate(request, err)
	}
	if err := validatePrivateResponse(request, response); err != nil {
		return nil, lostPrivate(request, err)
	}
	if failure, ok := response.Body["Err"].(string); ok {
		if isPrivateWrite(request) && (strings.HasPrefix(failure, "FRONT_DOOR_DEADLINE_EXPIRED") || strings.HasPrefix(failure, "FRONT_DOOR_CANCELLED")) {
			return nil, lostPrivate(request, errors.New(failure))
		}
		return nil, errors.New(failure)
	}
	value, present := response.Body["Ok"]
	if !present || len(response.Body) != 1 {
		return nil, lostPrivate(request, errors.New("FRONT_DOOR_INVALID_RESPONSE"))
	}
	return value, nil
}

type privateIngress struct {
	ID        string `json:"ingress_id"`
	Principal object `json:"principal"`
	Header    any    `json:"header"`
}

type gatewayBridge struct {
	mu                             sync.Mutex
	waiting, bytes                 int
	current                        generation
	dialSequence, acceptedSequence uint64
	waitCalls                      waitCalls
	closing                        chan struct{}
	forwarded                      sync.WaitGroup
}

func (b *gatewayBridge) closingSignal() <-chan struct{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closing == nil {
		b.closing = make(chan struct{})
	}
	return b.closing
}

func (b *gatewayBridge) closeAdmission() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closing == nil {
		b.closing = make(chan struct{})
	}
	select {
	case <-b.closing:
	default:
		close(b.closing)
	}
}

func (b *gatewayBridge) admitForwarding(request frontDoorRequest) (func(), error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	select {
	case <-b.closing:
		return nil, unavailableBeforeSend(request)
	default:
		b.forwarded.Add(1)
		return b.forwarded.Done, nil
	}
}

func unavailableBeforeSend(request frontDoorRequest) error {
	return notSentPrivate(request, "FRONT_DOOR_UNAVAILABLE", "The front door is stopping.")
}

func (b *gatewayBridge) reserve(request frontDoorRequest) (func(), error) {
	data, err := boundedPrivateJSON(request, maxRequestBytes)
	if err != nil {
		return nil, err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	select {
	case <-b.closing:
		return nil, unavailableBeforeSend(request)
	default:
	}
	if b.waiting == maxQueued || b.bytes+len(data) > maxQueueBytes {
		return nil, notSentPrivate(request, "FRONT_DOOR_BUSY", "The Core admission queue is full.")
	}
	b.waiting++
	b.bytes += len(data)
	return func() {
		b.mu.Lock()
		b.waiting--
		b.bytes -= len(data)
		b.mu.Unlock()
	}, nil
}

func (b *gatewayBridge) ready(wait context.Context, request *frontDoorRequest) (net.Conn, error) {
	const deadlineMessage = "The original admission deadline expired. Read current state before retrying with the same requestId."
	if _, err := request.Deadline.remaining(); err != nil {
		return nil, notSentPrivate(*request, "FRONT_DOOR_DEADLINE_EXPIRED", deadlineMessage)
	}
	release, err := b.reserve(*request)
	if err != nil {
		return nil, err
	}
	defer release()
	closing := b.closingSignal()
	attach, cancel := context.WithCancel(wait)
	defer cancel()
	go func() {
		select {
		case <-closing:
			cancel()
		case <-attach.Done():
		}
	}()
	for {
		select {
		case <-closing:
			return nil, unavailableBeforeSend(*request)
		default:
		}
		b.mu.Lock()
		b.dialSequence++
		sequence := b.dialSequence
		b.mu.Unlock()
		conn, hello, err := attachPrivate(attach, "core")
		if err == nil {
			request.Generation = hello.Generation
			b.mu.Lock()
			if sequence > b.acceptedSequence {
				b.acceptedSequence, b.current = sequence, hello.Generation
			}
			current := b.current
			b.mu.Unlock()
			if request.Generation == current {
				select {
				case <-closing:
					_ = conn.Close()
					return nil, unavailableBeforeSend(*request)
				default:
					return conn, nil
				}
			}
			_ = conn.Close()
		} else if strings.HasPrefix(err.Error(), "FRONT_DOOR_PROTOCOL_MISMATCH") || strings.HasPrefix(err.Error(), "FRONT_DOOR_PEER_UNAUTHORIZED") {
			return nil, err
		}
		select {
		case <-closing:
			return nil, unavailableBeforeSend(*request)
		case <-wait.Done():
			if errors.Is(wait.Err(), context.Canceled) {
				return nil, errors.New(privateCancelled)
			}
			return nil, notSentPrivate(*request, "FRONT_DOOR_DEADLINE_EXPIRED", deadlineMessage)
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func (b *gatewayBridge) fence(frame generation) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return generationFence(b.current, frame)
}

func (b *gatewayBridge) call(ctx context.Context, request frontDoorRequest) (any, error) {
	release, err := b.admitForwarding(request)
	if err != nil {
		return nil, err
	}
	defer release()
	wait, cancel := context.WithDeadline(ctx, time.UnixMilli(int64(request.Deadline.UnixMS)))
	defer cancel()
	conn, err := b.ready(wait, &request)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	value, err := exchangePrivate(wait, conn, request, "Request")
	if fence := b.fence(request.Generation); fence != nil {
		return nil, lostPrivate(request, fence)
	}
	return value, err
}

func (b *gatewayBridge) snapshot(ctx context.Context, kind string, send func(string) error) error {
	return b.snapshotWithAuthority(ctx, kind, "Management", send)
}

func (b *gatewayBridge) snapshotWithAuthority(ctx context.Context, kind string, authority any, send func(string) error) error {
	request := newPrivateRequest(ctx, object{"Snapshot": object{"kind": kind}}, authority, object{})
	release, err := b.admitForwarding(request)
	if err != nil {
		return err
	}
	defer release()
	wait, cancel := context.WithDeadline(ctx, time.UnixMilli(int64(request.Deadline.UnixMS)))
	defer cancel()
	report := func(message string) error {
		return send("event: error\ndata: " + wire(object{"error": message}) + "\n\n")
	}
	for {
		err, retry := b.streamSnapshot(wait, &request, send)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !retry {
			return report(err.Error())
		}
		if err := report(err.Error()); err != nil {
			return err
		}
	}
}

func (b *gatewayBridge) streamSnapshot(ctx context.Context, request *frontDoorRequest, send func(string) error) (error, bool) {
	type readyResult struct {
		conn net.Conn
		err  error
	}
	handoff := make(chan readyResult)
	attach, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		conn, err := b.ready(attach, request)
		select {
		case handoff <- readyResult{conn, err}:
		case <-attach.Done():
			if conn != nil {
				_ = conn.Close()
			}
		}
	}()
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	var conn net.Conn
	for conn == nil {
		select {
		case ready := <-handoff:
			if ready.err != nil {
				return ready.err, false
			}
			conn = ready.conn
		case <-tick.C:
			if err := send(": keepalive\n\n"); err != nil {
				return err, false
			}
		case <-ctx.Done():
			return ctx.Err(), false
		}
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	_ = conn.SetDeadline(time.UnixMilli(int64(request.Deadline.UnixMS)))
	if err := writeFrame(conn, object{"Stream": *request}); err != nil {
		return err, false
	}
	for sequence := uint64(0); ; sequence++ {
		var wireFrame struct {
			OK    *frontDoorStream `json:"Ok"`
			Error string           `json:"Err"`
		}
		if err := readFrame(conn, maxFrameBytes, &wireFrame); err != nil {
			return fmt.Errorf("FRONT_DOOR_CORE_LOST: %s. Snapshot gap; reattaching to Core. Read a fresh snapshot if reattachment expires.", err), ctx.Err() == nil
		}
		if wireFrame.Error != "" {
			var failure object
			if decodeObject([]byte(wireFrame.Error), &failure) == nil && strings.HasPrefix(text(failure, "message"), "FRONT_DOOR_CORE_DRAINING:") {
				return errors.New(wireFrame.Error), false
			}
			if strings.HasPrefix(wireFrame.Error, "FRONT_DOOR_CORE_DRAINING") {
				return errors.New("FRONT_DOOR_CORE_DRAINING: Snapshot gap; reattaching after Core is ready. Read a fresh snapshot if reattachment expires."), true
			}
			return errors.New(wireFrame.Error + " Read current source authority and reconnect the snapshot stream."), false
		}
		frame := wireFrame.OK
		if frame == nil || frame.RequestID != request.ID || frame.Sequence != sequence {
			return errors.New("FRONT_DOOR_REQUEST_MISMATCH"), false
		}
		if err := generationFence(request.Generation, frame.Generation); err != nil {
			return err, false
		}
		if err := b.fence(frame.Generation); err != nil {
			return err, false
		}
		if err := send(snapshotMessage(frame.Body)); err != nil {
			return err, false
		}
	}
}

func snapshotMessage(body any) string {
	if body == nil {
		return ": keepalive\n\n"
	}
	return "event: snapshot\ndata: " + wire(body) + "\n\n"
}

func (b *gatewayBridge) management(ctx context.Context, route, method string, body object) (any, error) {
	return b.call(ctx, newPrivateRequest(ctx, privateManagementOperation(route, method), "Management", body))
}

func (b *gatewayBridge) mcp(ctx context.Context, ingress string, request object) (object, error) {
	if ingress == "" {
		ingress = "default"
	}
	key := ingress + "\x00" + wire(request["id"])
	if request["method"] == "notifications/cancelled" {
		b.waitCalls.cancel(ingress + "\x00" + wire(field(request["params"], "requestId")))
		return nil, nil
	}
	wait := ctx
	started := time.Now()
	if isMCPWait(request) {
		if _, present := request["id"]; !present {
			return nil, errors.New("wait requires a request id")
		}
		var done func()
		var err error
		wait, done, err = b.waitCalls.register(ctx, key)
		if err != nil {
			return object{"jsonrpc": "2.0", "id": request["id"], "error": mcpMethodFailure(err)}, nil
		}
		defer done()
	}
	authority := object{"Ingress": privateIngress{ingress, object{"type": "ingress", "ingressId": ingress}, nil}}
	payload, err := b.call(wait, newPrivateRequest(wait, "Mcp", authority, request))
	if isMCPWait(request) && wait.Err() != nil && ctx.Err() == nil {
		result := cancelledControlWait(field(request["params"], "arguments"), time.Since(started))
		result["resultType"] = "complete"
		return object{"jsonrpc": "2.0", "id": request["id"], "result": result}, nil
	}
	if err != nil {
		if id, present := request["id"]; present {
			var failure object
			if decodeObject([]byte(err.Error()), &failure) == nil && failure["code"] != nil && failure["message"] != nil {
				return object{"jsonrpc": "2.0", "id": id, "error": failure}, nil
			}
			if strings.HasPrefix(err.Error(), "FRONT_DOOR_") {
				return object{"jsonrpc": "2.0", "id": id, "error": object{"code": -32603, "message": err.Error(),
					"data": object{"arcVersion": arcVersion()}}}, nil
			}
		}
	}
	return obj(payload), err
}

func frontDoorInfoPath() string { return filepath.Join(root(), "app/front-door.json") }

func frontDoorLock(path string, shared bool) (*os.File, error) {
	if err := platform.PrivateDir(root()); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(root(), path), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	locked, err := platform.TryFileLock(file, shared)
	if err != nil || !locked {
		file.Close()
		return nil, err
	}
	return file, nil
}

func frontDoorStartupGuard() (*os.File, error) {
	guard, err := frontDoorLock("front-door-install.lock", true)
	if err == nil && guard == nil {
		err = errors.New("CORE_UNAVAILABLE: Installation holds the replacement path; retry after it finishes.")
	}
	return guard, err
}

func runFrontDoor(parent context.Context) error {
	guard, err := frontDoorLock("front-door.lock", false)
	if err != nil || guard == nil {
		return err
	}
	defer guard.Close()
	if err := recoverOwnedChildren(parent, "front-door-children"); err != nil {
		return err
	}
	secret, err := ensureFrontDoorSecret()
	if err != nil {
		return err
	}
	build, err := processBuildID()
	if err != nil {
		return err
	}
	httpListener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer httpListener.Close()
	port := httpListener.Addr().(*net.TCPAddr).Port
	ctx, stop := context.WithCancel(parent)
	defer stop()
	bridge := &gatewayBridge{}
	owner := &gatewayOwner{bridge: bridge, token: secret, port: uint64(port)}
	defer owner.close()
	if err := owner.start(ctx); err != nil {
		return err
	}
	admissions := newInProcess(owner)
	info := object{"pid": os.Getpid(), "processStart": platform.ProcessStart(os.Getpid()),
		"protocol": frontDoorVersion, "build": build, "port": port, "token": secret}
	path := frontDoorInfoPath()
	if err := save(path, info); err != nil {
		return err
	}
	defer os.Remove(path)
	privateLifetime, closePrivate := context.WithCancel(context.WithoutCancel(ctx))
	defer closePrivate()
	ipc, err := listenPrivate(privateLifetime, "front-door", secret, admissions, stop)
	if err != nil {
		return err
	}
	defer ipc.Close()
	httpServer := &http.Server{Handler: localHandler(bridge, port, secret), ReadHeaderTimeout: 5 * time.Second, MaxHeaderBytes: 16384}
	httpServer.SetKeepAlivesEnabled(false)
	result := make(chan error, 1)
	go func() { result <- httpServer.Serve(httpListener) }()
	select {
	case err := <-result:
		bridge.closeAdmission()
		return err
	case <-ctx.Done():
		bridge.closeAdmission()
		grace := drainTimeout
		if operatingSystem == "darwin" {
			grace = time.Second
		}
		shutdown, cancel := context.WithTimeout(context.Background(), grace)
		defer cancel()
		defer httpServer.Close()
		err := httpServer.Shutdown(shutdown)
		forwarded := make(chan struct{})
		go func() { bridge.forwarded.Wait(); close(forwarded) }()
		select {
		case <-forwarded:
		case <-shutdown.Done():
		}
		if errors.Is(err, context.DeadlineExceeded) {
			return nil
		}
		return err
	}
}

func stageFrontDoor(source, build string) (string, error) {
	return stageFrontDoorAt(frontDoorImages(), source, build)
}

func stageFrontDoorAt(images, source, build string) (string, error) {
	if !validBuildHash(build) {
		return "", errors.New("FRONT_DOOR_BUILD_CHANGED: invalid installed build identity")
	}
	image := frontDoorImageAt(images, build)
	dir := filepath.Dir(image)
	if err := platform.PrivateDir(dir); err != nil {
		return "", err
	}
	if hash, err := buildID(image); err == nil {
		if hash != build {
			return "", errors.New("FRONT_DOOR_BUILD_CHANGED: The staged image differs from the installed build.")
		}
		return image, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	file, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer file.Close()
	stage := filepath.Join(dir, "install-"+id())
	temp, err := os.OpenFile(stage, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o700)
	if err != nil {
		return "", err
	}
	defer os.Remove(stage)
	_, copyErr := io.Copy(temp, file)
	if err := errors.Join(copyErr, temp.Close()); err != nil {
		return "", err
	}
	if confirmed, err := buildID(stage); err != nil || confirmed != build {
		return "", errors.New("FRONT_DOOR_BUILD_CHANGED: The installed executable changed while copying; retry after installation finishes.")
	}
	if err := platform.ReplaceFile(stage, image); err != nil {
		return "", err
	}
	return image, nil
}

var fixtureIncompatibleFrontDoor func() bool
var privateFixtureResponse func(context.Context, string) error

type frontDoorAttachment struct {
	info  object
	hello frontDoorHello
}

func readFrontDoorInfo(ctx context.Context) (frontDoorAttachment, error) {
	conn, hello, err := attachPrivate(ctx, "front-door")
	if err != nil {
		return frontDoorAttachment{}, err
	}
	_ = conn.Close()
	value, err := load(frontDoorInfoPath())
	if err != nil {
		return frontDoorAttachment{}, err
	}
	info := obj(value)
	port := uintOr(info["port"], 0)
	if port == 0 || port > 65535 || uintOr(info["pid"], 0) == 0 || uintOr(info["protocol"], 0) != frontDoorVersion {
		return frontDoorAttachment{}, errors.New("FRONT_DOOR_PORT_MISSING")
	}
	return frontDoorAttachment{info, hello}, nil
}

func ensureFrontDoor(ctx context.Context, build string) (frontDoorAttachment, error) {
	if attachment, err := readFrontDoorInfo(ctx); !missingPrivateEndpoint(err) {
		return attachment, err
	}
	source, err := runtimeBinary()
	if err != nil {
		return frontDoorAttachment{}, err
	}
	image, err := stageFrontDoor(source, build)
	if err != nil {
		return frontDoorAttachment{}, err
	}
	if operatingSystem == "darwin" {
		update, _ := load(filepath.Join(root(), "app/front-door-update.json"))
		if text(update, "targetBuild") == build && text(update, "lastOutcome") != "updated" &&
			uintOr(field(update, "retryAt"), 0) > uint64(time.Now().UnixMilli()) {
			current := text(update, "currentBuild")
			if !validBuildHash(current) {
				return frontDoorAttachment{}, errors.New("FRONT_DOOR_START_FAILED: The current image build is unavailable.")
			}
			image = frontDoorImage(current)
		}
	}
	return launchFrontDoor(ctx, image)
}

func launchFrontDoor(ctx context.Context, image string) (frontDoorAttachment, error) {
	guard, err := frontDoorLock("front-door.lock", false)
	if err != nil {
		return frontDoorAttachment{}, err
	}
	if guard == nil {
		return frontDoorAttachment{}, errors.New("FRONT_DOOR_UNAVAILABLE: The front door still owns its lock. Inspect front-door.log; continuity is reduced until its endpoint recovers.")
	}
	defer guard.Close()
	build, err := buildID(image)
	if err != nil {
		return frontDoorAttachment{}, err
	}
	log, err := os.OpenFile(filepath.Join(root(), "front-door.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return frontDoorAttachment{}, err
	}
	defer log.Close()
	command := exec.Command(image, "front-door")
	command.Env = append(os.Environ(), "ARC_STATE_DIR="+root())
	command.Stderr = log
	platform.Detach(command)
	_ = guard.Close()
	if err := command.Start(); err != nil {
		return frontDoorAttachment{}, err
	}
	finished := make(chan error, 1)
	go func() { finished <- command.Wait() }()
	recordLog("INFO", fmt.Sprintf("Front door launched: pid %d", command.Process.Pid), nil)
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		attachment, readyErr := readFrontDoorInfo(wait)
		if readyErr == nil {
			if uintOr(attachment.info["pid"], 0) == uint64(command.Process.Pid) && text(attachment.info, "build") == build {
				return attachment, nil
			}
			_ = command.Process.Kill()
			<-finished
			return frontDoorAttachment{}, errors.New("FRONT_DOOR_START_FAILED: The ready peer does not match the staged image.")
		}
		select {
		case err := <-finished:
			return frontDoorAttachment{}, fmt.Errorf("FRONT_DOOR_START_FAILED: %v; inspect front-door.log", err)
		case <-wait.Done():
			_ = command.Process.Kill()
			<-finished
			recordLog("WARN", fmt.Sprintf("Front door readiness: %v", readyErr), nil)
			return frontDoorAttachment{}, errors.New("FRONT_DOOR_START_TIMEOUT: Inspect front-door.log.")
		case <-tick.C:
		}
	}
}

func frontDoorImages() string {
	return filepath.Join(root(), "front-door-bin", fmt.Sprintf("v%d", frontDoorVersion))
}

func frontDoorImage(build string) string {
	return frontDoorImageAt(frontDoorImages(), build)
}

func frontDoorImageAt(images, build string) string {
	name := "arc"
	if operatingSystem == "windows" {
		name += ".exe"
	}
	return filepath.Join(images, build, name)
}

func validBuildHash(value string) bool {
	return len(value) == 64 && strings.IndexFunc(value, func(c rune) bool {
		return (c < '0' || c > '9') && (c < 'a' || c > 'f')
	}) == -1
}

func pruneFrontDoorImages(current string) error {
	return pruneFrontDoorImagesAt(frontDoorImages(), current)
}

func pruneFrontDoorImagesAt(dir, current string) error {
	if !validBuildHash(current) {
		return errors.New("FRONT_DOOR_BUILD_CHANGED: invalid installed build identity")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() != current && entry.IsDir() && validBuildHash(entry.Name()) {
			if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

func stopFrontDoor(ctx context.Context) error {
	token, err := frontDoorSecret()
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, err := platform.DialIPC(wait, ipcEndpoint("front-door"))
	if err != nil {
		lock, lockErr := frontDoorLock("front-door.lock", false)
		if lockErr != nil {
			return lockErr
		}
		if lock != nil {
			lock.Close()
			return nil
		}
		return err
	}
	defer conn.Close()
	deadline, _ := wait.Deadline()
	_ = conn.SetDeadline(deadline)
	if err := writeFrame(conn, object{"Stop": object{"token": token}}); err != nil {
		return err
	}
	var response object
	if err := readFrame(conn, 4096, &response); err != nil {
		return err
	}
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		lock, err := frontDoorLock("front-door.lock", false)
		if err != nil {
			return err
		}
		if lock != nil {
			lock.Close()
			return nil
		}
		select {
		case <-wait.Done():
			return errors.New("FRONT_DOOR_STOP_TIMEOUT")
		case <-tick.C:
		}
	}
}

func prepareFrontDoorInstall(ctx context.Context) (*os.File, error) {
	guard, err := frontDoorLock("front-door-install.lock", false)
	if err != nil {
		return nil, err
	}
	if guard == nil {
		return nil, errors.New("CORE_UNAVAILABLE: Another installer or Core startup holds the replacement path.")
	}
	failure := func(err error) (*os.File, error) {
		_ = guard.Close()
		return nil, err
	}
	unlocked, err := coreUnlocked()
	if err != nil {
		return failure(err)
	}
	if !unlocked {
		return failure(errors.New("CORE_UNAVAILABLE: Stop Desktop and Core before preparing front-door replacement."))
	}
	if _, err := readFrontDoorInfo(ctx); err != nil {
		if incompatibleFrontDoor(err) {
			if err := stopFrontDoor(ctx); err != nil {
				return failure(err)
			}
		} else {
			isFree, lockErr := frontDoorLock("front-door.lock", false)
			if lockErr != nil {
				return failure(lockErr)
			}
			if isFree == nil {
				return failure(err)
			}
			_ = isFree.Close()
		}
	}
	return guard, nil
}

func prepareFrontDoorCommand(ctx context.Context, input io.Reader, output io.Writer, hold bool) error {
	guard, err := prepareFrontDoorInstall(ctx)
	if err != nil {
		return err
	}
	defer guard.Close()
	if !hold {
		return nil
	}
	if err := outputLine(output, "ready"); err != nil {
		return err
	}
	_, err = bufio.NewReader(input).ReadByte()
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}
