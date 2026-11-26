package core

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

const rpcFrameLimit = 32 << 20
const rpcTransportClosed = "TRANSPORT_CLOSED: execution state unknown"

type rpcRole string

const (
	rpcConnector      rpcRole = "connector-app-server"
	rpcSharedDesktop  rpcRole = "desktop-shared-app-server"
	rpcPrivateDesktop rpcRole = "desktop-private-app-server"
)

// The Agent lane supplies verified detached-host identity and lifecycle hooks.
type rpcHost struct {
	socket, startedAt, processStart string
	pid                             int
	inheritedNoFile                 object
	adopted, outdated               bool
	running                         func() bool
	stop                            func(context.Context) error
}

var rpcDetachedHost func(context.Context, string, *launches) (*rpcHost, error)
var rpcDetachedRunning func() bool
var rpcDesktopAttached func(context.Context) bool
var rpcDesktopPeer func(string) (int, error)
var rpcFixtureArgs func() ([]string, error)

type rpcObserver struct {
	event        func(*rpcConnection, string, any)
	pending      func(*rpcConnection, string, object)
	resolved     func(*rpcConnection, string)
	subscription func(*rpcConnection, string, bool)
	disconnected func(*rpcConnection)
}

type rpcFrames interface {
	read(context.Context) ([]byte, error)
	write(context.Context, []byte) error
	close() error
}

type rpcLineFrames struct {
	input  io.WriteCloser
	output *bufio.Scanner
}

func (f *rpcLineFrames) read(_ context.Context) ([]byte, error) {
	if f.output.Scan() && len(f.output.Bytes()) != 0 {
		return f.output.Bytes(), nil
	}
	if err := f.output.Err(); err != nil {
		return nil, err
	}
	return nil, io.EOF
}
func (f *rpcLineFrames) write(ctx context.Context, data []byte) error {
	if pipe, ok := f.input.(*os.File); ok {
		deadline, _ := ctx.Deadline()
		if err := pipe.SetWriteDeadline(deadline); err == nil {
			defer pipe.SetWriteDeadline(time.Time{})
		}
	}
	_, err := f.input.Write(append(data, '\n'))
	return err
}
func (f *rpcLineFrames) close() error { return f.input.Close() }

type rpcSocketFrames struct{ socket *websocket.Conn }

func (f rpcSocketFrames) read(ctx context.Context) ([]byte, error) {
	_, data, err := f.socket.Read(ctx)
	return data, err
}
func (f rpcSocketFrames) write(ctx context.Context, data []byte) error {
	return f.socket.Write(ctx, websocket.MessageText, data)
}
func (f rpcSocketFrames) close() error { return f.socket.CloseNow() }

func rpcProxyHandshake(ctx context.Context, writer io.WriteCloser, reader io.ReadCloser) (*websocket.Conn, error) {
	clientPipe, processPipe := net.Pipe()
	go func() {
		defer processPipe.Close()
		_, _ = io.Copy(processPipe, reader)
	}()
	go func() {
		defer writer.Close()
		_, _ = io.Copy(writer, processPipe)
	}()
	var once atomic.Bool
	transport := &http.Transport{
		DialContext: func(context.Context, string, string) (net.Conn, error) {
			if !once.CompareAndSwap(false, true) {
				return nil, errors.New("proxy connection already used")
			}
			return clientPipe, nil
		},
		DisableCompression: true,
	}
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	socket, _, err := websocket.Dial(wait, "ws://localhost/", &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		_ = clientPipe.Close()
		_ = processPipe.Close()
		if errors.Is(wait.Err(), context.DeadlineExceeded) {
			return nil, errors.New("CODEX_HOST_HANDSHAKE_TIMEOUT")
		}
		return nil, fmt.Errorf("CODEX_HOST_HANDSHAKE_FAILED: %w", err)
	}
	socket.SetReadLimit(rpcFrameLimit)
	return socket, nil
}

type rpcResult struct {
	value any
	err   error
}

type rpcConnection struct {
	frames                                       rpcFrames
	child                                        *exec.Cmd
	host                                         *rpcHost
	observer                                     rpcObserver
	session, connection, processStart, startedAt string
	role                                         rpcRole
	pid                                          int
	inherited                                    object
	alive                                        atomic.Bool
	ioMu                                         sync.Mutex
	pendingMu                                    sync.Mutex
	pending                                      map[string]chan rpcResult
	exited, readDone                             chan struct{}
	closeOnce                                    sync.Once
	cancel                                       context.CancelFunc
}

func startRPC(ctx context.Context, binary, home, session string, observer rpcObserver) (*rpcConnection, error) {
	args := []string{"app-server"}
	if rpcFixtureArgs != nil {
		var err error
		args, err = rpcFixtureArgs()
		if err != nil {
			return nil, err
		}
	}
	args = append(args, "-c", "thread_unload_delay_secs=0")
	return openRPC(ctx, binary, home, session, args, rpcConnector, nil, observer)
}

func attachRPC(ctx context.Context, binary, home, session string, launches *launches, observer rpcObserver) (*rpcConnection, error) {
	check := func() error { return launches.run(func() error { return nil }) }
	if err := check(); err != nil {
		return nil, err
	}
	if rpcFixtureArgs == nil && rpcDetachedHost != nil {
		connection, err := rpcConnectHost(ctx, binary, home, session, launches, rpcConnector, observer)
		switch {
		case err == nil:
			return connection, nil
		case rpcDetachedRunning != nil && rpcDetachedRunning():
			return nil, err
		default:
			if err := check(); err != nil {
				return nil, err
			}
			recordLog("WARN", "Detached Codex app-server unavailable; using a Core-owned app-server: "+err.Error(), nil)
		}
	}
	return startRPC(ctx, binary, home, session, observer)
}

func rpcConnectHost(ctx context.Context, binary, home, session string, launches *launches, role rpcRole, observer rpcObserver) (*rpcConnection, error) {
	if rpcDetachedHost == nil {
		return nil, errors.New(PortPending)
	}
	for {
		host, err := rpcDetachedHost(ctx, binary, launches)
		if err != nil {
			return nil, err
		}
		var connection *rpcConnection
		for range 3 {
			if operatingSystem == "darwin" && rpcDesktopPeer != nil {
				pid, peerErr := rpcDesktopPeer(host.socket)
				if peerErr != nil {
					return nil, peerErr
				}
				if pid != host.pid {
					return nil, errors.New("CODEX_BACKEND_PEER_MISMATCH")
				}
			}
			connection, err = openRPC(ctx, binary, home, session, []string{"app-server", "proxy", "--sock", host.socket}, role, host, observer)
			if err == nil {
				break
			}
			select {
			case <-time.After(300 * time.Millisecond):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if err != nil {
			return nil, err
		}
		if !host.adopted {
			return connection, nil
		}
		if host.outdated && rpcDesktopAttached != nil && !connection.active(ctx) && !rpcDesktopAttached(ctx) {
			connection.stop(ctx)
			continue
		}
		if err := connection.resubscribe(ctx); err != nil {
			connection.close()
			return nil, err
		}
		return connection, nil
	}
}

func connectSharedDesktopRPC(ctx context.Context, binary, home, socket string, observer rpcObserver) (*rpcConnection, error) {
	return openRPC(ctx, binary, home, id(), []string{"app-server", "proxy", "--sock", socket}, rpcSharedDesktop, nil, observer)
}

func openRPC(ctx context.Context, binary, home, session string, args []string, role rpcRole, host *rpcHost, observer rpcObserver) (*rpcConnection, error) {
	child := exec.Command(binary, args...)
	child.Env = append(child.Environ(), "CODEX_HOME="+home)
	platform.OwnChild(child)
	input, err := child.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := child.StdoutPipe()
	if err != nil {
		_ = input.Close()
		return nil, err
	}
	stderr, err := child.StderrPipe()
	if err != nil {
		_ = input.Close()
		_ = output.Close()
		return nil, err
	}
	inherited := inheritedResourceLimits()
	if err := startOwnedChild(child); err != nil {
		_ = input.Close()
		_ = output.Close()
		_ = stderr.Close()
		return nil, err
	}
	pid := child.Process.Pid
	processStart := platform.ProcessStart(pid)
	sharing := role == rpcSharedDesktop || host != nil
	var frames rpcFrames
	go forwardRPCStderr(stderr)
	if sharing {
		socket, err := rpcProxyHandshake(ctx, input, output)
		if err != nil {
			_ = child.Process.Kill()
			_ = child.Wait()
			return nil, err
		}
		frames = rpcSocketFrames{socket}
	} else {
		reader := bufio.NewScanner(output)
		reader.Buffer(make([]byte, 16<<10), rpcFrameLimit)
		frames = &rpcLineFrames{input, reader}
	}
	lifetime, cancel := context.WithCancel(context.Background())
	connection := &rpcConnection{frames: frames, child: child, host: host, observer: observer, session: session,
		connection: id(), processStart: processStart, startedAt: now(), role: role, pid: pid, inherited: inherited,
		pending: make(map[string]chan rpcResult), exited: make(chan struct{}), readDone: make(chan struct{}), cancel: cancel}
	if role == rpcSharedDesktop {
		connection.connection = session
	}
	if host != nil {
		connection.pid, connection.startedAt, connection.inherited = host.pid, host.startedAt, host.inheritedNoFile
	} else if role == rpcSharedDesktop {
		connection.inherited = nil
	}
	connection.alive.Store(true)
	go connection.readLoop(lifetime)
	go func() {
		<-connection.readDone
		_ = child.Wait()
		close(connection.exited)
	}()
	timeout := 60 * time.Second
	if sharing {
		timeout = 5 * time.Second
	}
	value, err := connection.call(ctx, "initialize", object{"clientInfo": object{"name": "agent-remote-control", "version": buildVersion},
		"capabilities": object{"experimentalApi": true}}, timeout)
	if err == nil && (role == rpcSharedDesktop || operatingSystem == "darwin" && host != nil) {
		expected, expectedErr := filepath.EvalSymlinks(home)
		reported, reportedErr := filepath.EvalSymlinks(text(value, "codexHome"))
		if expectedErr != nil || reportedErr != nil || expected != reported {
			err = errors.New("DESKTOP_DAEMON_HOME_MISMATCH")
		}
	}
	if err == nil {
		initialized, stop := context.WithTimeout(ctx, timeout)
		err = connection.write(initialized, object{"method": "initialized"})
		stop()
	}
	if err != nil {
		connection.close()
		return nil, err
	}
	return connection, nil
}

func (c *rpcConnection) responseID(key any) string {
	if c.role == rpcConnector {
		return wire(key)
	}
	source := "private-desktop"
	if c.role == rpcSharedDesktop {
		source = "desktop-daemon"
	}
	return wire([]any{source, c.session, key})
}

func (c *rpcConnection) readLoop(ctx context.Context) {
	defer close(c.readDone)
	defer c.disconnected()
	for {
		data, err := c.frames.read(ctx)
		if err != nil {
			return
		}
		var message object
		if err := decodeObject(data, &message); err != nil {
			continue
		}
		key, hasID := message["id"]
		if method, ok := message["method"].(string); ok {
			params := message["params"]
			if hasID && c.observer.pending != nil {
				response := c.responseID(key)
				request := object{"id": key, "responseId": response, "method": method, "params": params, "backendSession": c.session,
					"connection": c.connection, "owner": string(c.role), "canRespond": true,
					"next": object{"via": "act", "op": "codex_respond", "args": object{"id": response, "backendSession": c.session},
						"hint": "Supply exactly one of result/error using the native response schema."}}
				c.observer.pending(c, response, request)
			}
			if method == "serverRequest/resolved" && c.observer.resolved != nil {
				c.observer.resolved(c, c.responseID(field(params, "requestId")))
			}
			if c.observer.event != nil {
				c.observer.event(c, method, params)
			}
		} else if hasID {
			c.pendingMu.Lock()
			requestID := wire(key)
			wait := c.pending[requestID]
			delete(c.pending, requestID)
			c.pendingMu.Unlock()
			if wait == nil {
				continue
			}
			if failure, exists := message["error"]; exists {
				wait <- rpcResult{err: errors.New("RPC_REJECTED:" + wire(failure))}
			} else {
				wait <- rpcResult{value: message["result"]}
			}
		}
	}
}

func (c *rpcConnection) disconnected() {
	c.pendingMu.Lock()
	c.alive.Store(false)
	for _, pending := range c.pending {
		pending <- rpcResult{err: errors.New(rpcTransportClosed)}
	}
	clear(c.pending)
	c.pendingMu.Unlock()
	if operatingSystem == "darwin" && (c.host != nil || c.role == rpcSharedDesktop) {
		path := "private-last-disconnect.json"
		if c.role == rpcSharedDesktop {
			path = "desktop-last-disconnect.json"
		}
		_ = save(filepath.Join(root(), path), object{"connection": c.connection, "observedAt": now()})
	}
	if c.observer.disconnected != nil {
		c.observer.disconnected(c)
	}
}

func (c *rpcConnection) write(ctx context.Context, value object) error {
	c.ioMu.Lock()
	defer c.ioMu.Unlock()
	if !c.alive.Load() {
		return errors.New("TRANSPORT_CLOSED")
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	data := []byte(wire(value))
	if len(data) > rpcFrameLimit {
		return errors.New("RPC_FRAME_TOO_LARGE")
	}
	return c.frames.write(ctx, data)
}

func (c *rpcConnection) call(ctx context.Context, method string, params any, timeout time.Duration) (any, error) {
	key := id()
	encoded := wire(key)
	response := make(chan rpcResult, 1)
	c.pendingMu.Lock()
	if !c.alive.Load() {
		c.pendingMu.Unlock()
		return nil, errors.New("TRANSPORT_CLOSED")
	}
	c.pending[encoded] = response
	c.pendingMu.Unlock()
	defer func() {
		c.pendingMu.Lock()
		delete(c.pending, encoded)
		c.pendingMu.Unlock()
	}()

	wait, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if err := c.write(wait, object{"id": key, "method": method, "params": params}); err != nil {
		return nil, rpcSubmissionError(method, err)
	}
	select {
	case value := <-response:
		if value.err == nil && c.observer.subscription != nil && (method == "thread/unsubscribe" || method == "thread/resume") {
			c.observer.subscription(c, text(params, "threadId"), method == "thread/resume")
		}
		return value.value, rpcSubmissionError(method, value.err)
	case <-wait.Done():
		return nil, rpcSubmissionError(method, fmt.Errorf("RPC_TIMEOUT: %s", method))
	}
}

func (c *rpcConnection) loadedThreads(ctx context.Context) ([]string, error) {
	var cursor any
	threads := []string{}
	seen := map[string]bool{}
	for {
		page, err := c.call(ctx, "thread/loaded/list", object{"cursor": cursor, "limit": 100}, 5*time.Second)
		if err != nil {
			return nil, err
		}
		entries := arr(field(page, "data"))
		if entries == nil {
			return nil, errors.New("CODEX_HOST_INVALID_LOADED_THREADS")
		}
		for _, value := range entries {
			thread, ok := value.(string)
			if !ok {
				return nil, errors.New("CODEX_HOST_INVALID_LOADED_THREAD")
			}
			threads = append(threads, thread)
		}
		cursor = field(page, "nextCursor")
		if cursor == nil {
			return threads, nil
		}
		key := wire(cursor)
		if seen[key] {
			return nil, errors.New("CODEX_HOST_REPEATED_CURSOR")
		}
		seen[key] = true
	}
}

func (c *rpcConnection) threadIdle(ctx context.Context, thread string) (bool, error) {
	value, err := c.call(ctx, "thread/read", object{"threadId": thread, "includeTurns": false}, 5*time.Second)
	state := text(field(field(value, "thread"), "status"), "type")
	return state == "idle" || state == "notLoaded", err
}

func (c *rpcConnection) active(ctx context.Context) bool {
	threads, err := c.loadedThreads(ctx)
	if err != nil {
		return true
	}
	for _, thread := range threads {
		if idle, err := c.threadIdle(ctx, thread); err != nil || !idle {
			return true
		}
	}
	return false
}

func (c *rpcConnection) resubscribe(ctx context.Context) error {
	threads, err := c.loadedThreads(ctx)
	if err != nil {
		return err
	}
	for _, thread := range threads {
		idle, err := c.threadIdle(ctx, thread)
		if err != nil {
			return err
		}
		if !idle {
			if _, err := c.call(ctx, "thread/resume", object{"threadId": thread, "excludeTurns": true}, 30*time.Second); err != nil {
				return err
			}
		}
	}
	return nil
}

func (c *rpcConnection) health() object {
	pid := 0
	if c.host != nil {
		if c.host.running != nil && c.host.running() {
			pid = c.host.pid
		}
	} else if c.processStart != "" && platform.ProcessStart(c.pid) == c.processStart {
		pid = c.pid
	}
	resources := childResourceStatus(pid, c.inherited, "process exited or could not be checked")
	if c.host == nil && pid != 0 && platform.ProcessStart(pid) != c.processStart {
		resources = childResourceStatus(0, c.inherited, "process exited or could not be checked")
	}
	status := "stopped"
	if c.alive.Load() {
		status = "ready"
	}
	value := object{"state": status, "pid": c.pid, "startedAt": c.startedAt, "observedAt": now(), "evidence": "native-connector",
		"stale": false, "resources": resources}
	if c.host != nil {
		value["detached"], value["adopted"] = true, c.host.adopted
	}
	return value
}

func (c *rpcConnection) close() {
	c.closeOnce.Do(func() {
		c.alive.Store(false)
		c.cancel()
		_ = c.frames.close()
		pid := c.child.Process.Pid
		if c.host != nil || c.role == rpcSharedDesktop {
			_ = c.child.Process.Kill()
		}
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		select {
		case <-c.exited:
		case <-timer.C:
			if c.host == nil && c.role != rpcSharedDesktop && c.processStart != "" && platform.ProcessStart(pid) == c.processStart {
				platform.SignalTree(pid, true)
			}
			_ = c.child.Process.Kill()
			<-c.exited
		}
		if c.host == nil && c.role != rpcSharedDesktop {
			platform.KillOwnedGroup(pid)
		}
	})
}

func (c *rpcConnection) stop(ctx context.Context) {
	c.close()
	if c.host != nil && c.host.stop != nil {
		if err := c.host.stop(ctx); err != nil {
			recordLog("WARN", err.Error(), nil)
		}
	}
}

func forwardRPCStderr(stderr io.Reader) {
	var bytes [4096]byte
	window, count := time.Now(), 0
	for {
		size, err := stderr.Read(bytes[:])
		if time.Since(window) >= time.Second {
			window, count = time.Now(), 0
		}
		if size > 0 && count < 8 {
			recordLog("WARN", "app-server: "+strings.ToValidUTF8(string(bytes[:size]), "�"), nil)
			count++
		}
		if err != nil {
			return
		}
	}
}

func rpcSubmissionError(method string, err error) error {
	if err == nil || strings.HasPrefix(err.Error(), "RPC_REJECTED") ||
		slices.Contains([]string{"initialize", "get_state", "get_commands", "get_available_models"}, method) ||
		strings.HasSuffix(method, "/read") || strings.HasSuffix(method, "/list") {
		return err
	}
	for _, domain := range obj(catalog()["domains"]) {
		for _, raw := range obj(field(domain, "actions")) {
			action := arr(raw)
			if len(action) >= 2 && action[0] == method && action[1] == true {
				return err
			}
		}
	}
	return fmt.Errorf("SUBMISSION_UNCONFIRMED: %w", err)
}
