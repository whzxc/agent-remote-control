package core

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
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

func listenPrivate(ctx context.Context, endpoint, token string, core *inProcess, stop func()) (net.Listener, error) {
	listener, err := platform.ListenIPC(ipcEndpoint(endpoint))
	if err != nil {
		return nil, err
	}
	connections := make(chan struct{}, maxInFlight+maxQueued)
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
	if stop != nil {
		frame = envelope["Gateway"]
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
	value, err := core.admit(ctx, request)
	body := object{"Ok": value}
	if err != nil {
		body = object{"Err": err.Error()}
	}
	_ = writeFrame(conn, frontDoorResponse{Generation: core.generation, RequestID: request.ID, Body: body})
}

func attachPrivate(ctx context.Context, endpoint string) (net.Conn, frontDoorHello, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var hello frontDoorHello
	token, err := frontDoorSecret()
	if err != nil {
		return nil, hello, err
	}
	conn, err := platform.DialIPC(ctx, ipcEndpoint(endpoint))
	if err != nil {
		return nil, hello, err
	}
	if err := privateHello(ctx, conn, token, &hello); err != nil {
		conn.Close()
		return nil, hello, err
	}
	return conn, hello, nil
}

func privateHello(ctx context.Context, conn net.Conn, token string, hello *frontDoorHello) error {
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

func privateRequest(ctx context.Context, conn net.Conn, hello frontDoorHello, route, method string, body object) (any, error) {
	var operationName any = object{"Management": privateManagement{Route: route, Method: method}}
	switch route {
	case "healthz":
		operationName = "Health"
	case "cli/control":
		operationName = "LocalControl"
	}
	return exchangePrivate(ctx, conn, hello, operationName, "Management", body, route, method)
}

func exchangePrivate(ctx context.Context, conn net.Conn, hello frontDoorHello, operationName any, authority any, body object, route, method string) (any, error) {
	timeout := 120 * time.Second
	if str(operationName) == "Mcp" && isMCPWait(body) {
		timeout = 1830 * time.Second
	}
	deadline := time.Now().Add(timeout)
	if limit, ok := ctx.Deadline(); ok && limit.Before(deadline) {
		deadline = limit
	}
	_ = conn.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	requestID := text(field(body, "args"), "requestId")
	if requestID == "" {
		requestID = text(body, "requestId")
	}
	if requestID == "" {
		requestID = id()
	}
	request := frontDoorRequest{Version: hello.Version, Generation: hello.Generation, ID: requestID,
		Deadline: frontDoorDeadline{UnixMS: uint64(deadline.UnixMilli())}, Context: frontDoorContext{Authority: authority},
		Operation: operationName, Body: body}
	encoded, err := canonjson.Marshal(request)
	if err != nil {
		return nil, err
	}
	if len(encoded) > maxRequestBytes {
		return nil, errors.New(frontDoorFrameTooLarge)
	}
	isWrite := method != http.MethodGet && route != "app/snapshot"
	if str(operationName) == "Mcp" {
		params := body["params"]
		isWrite = body["method"] == "tools/call" && field(params, "name") == "act"
	}
	if route == "cli/control" {
		spec := operation(text(body, "op"))
		isWrite = spec != nil && via(spec) == "act" && (spec["name"] != "receipt" || field(field(body, "args"), "action") != "read" && field(field(body, "args"), "action") != nil)
	}
	lost := func(reason error) error {
		if isWrite {
			return errors.New(wire(object{"code": -32603, "message": "Core disconnected after write submission; outcome is uncertain. Do not repeat the write.",
				"data": object{"state": "unconfirmed", "requestId": requestID, "reason": reason.Error(),
					"next": object{"via": "act", "op": "receipt", "args": object{"action": "read", "requestId": requestID}}}}))
		}
		return fmt.Errorf("FRONT_DOOR_CORE_LOST: %s. Read failed; issue a new authorized read when Core is ready.", reason)
	}
	if err := writeFrame(conn, object{"Request": json.RawMessage(encoded)}); err != nil {
		return nil, lost(err)
	}
	var response frontDoorResponse
	if err := readFrame(conn, maxFrameBytes, &response); err != nil {
		return nil, lost(err)
	}
	if err := generationFence(hello.Generation, response.Generation); err != nil {
		return nil, lost(err)
	}
	if response.RequestID != requestID {
		return nil, lost(errors.New("FRONT_DOOR_REQUEST_MISMATCH"))
	}
	if err, ok := response.Body["Err"].(string); ok {
		return nil, errors.New(err)
	}
	return response.Body["Ok"], nil
}

type privateIngress struct {
	ID        string `json:"ingress_id"`
	Principal object `json:"principal"`
	Header    any    `json:"header"`
}

type gatewayBridge struct{}

func (gatewayBridge) management(ctx context.Context, route, method string, body object) (any, error) {
	conn, hello, err := attachPrivate(ctx, "core")
	if err != nil {
		return nil, fmt.Errorf("FRONT_DOOR_CORE_UNAVAILABLE: %w", err)
	}
	defer conn.Close()
	return privateRequest(ctx, conn, hello, route, method, body)
}

func (gatewayBridge) mcp(ctx context.Context, ingress string, request object) (object, error) {
	conn, hello, err := attachPrivate(ctx, "core")
	if err != nil {
		return nil, fmt.Errorf("FRONT_DOOR_CORE_UNAVAILABLE: %w", err)
	}
	defer conn.Close()
	if ingress == "" {
		ingress = "default"
	}
	authority := object{"Ingress": privateIngress{ingress, object{"type": "ingress", "ingressId": ingress}, nil}}
	payload, err := exchangePrivate(ctx, conn, hello, "Mcp", authority, request, "", "")
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
	bridge := gatewayBridge{}
	admissions := newInProcess(bridge)
	info := object{"pid": os.Getpid(), "processStart": platform.ProcessStart(os.Getpid()),
		"protocol": frontDoorVersion, "build": build, "port": port, "token": secret}
	path := frontDoorInfoPath()
	if err := save(path, info); err != nil {
		return err
	}
	defer os.Remove(path)
	ipc, err := listenPrivate(ctx, "front-door", secret, admissions, stop)
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
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), drainTimeout)
		defer cancel()
		defer httpServer.Close()
		return httpServer.Shutdown(shutdown)
	}
}

func stageFrontDoor(source, build string) (string, error) {
	dir := filepath.Join(root(), "front-door-bin", fmt.Sprintf("v%d", frontDoorVersion), build)
	if err := platform.PrivateDir(dir); err != nil {
		return "", err
	}
	name := "arc"
	if operatingSystem == "windows" {
		name += ".exe"
	}
	image := filepath.Join(dir, name)
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

func ensureFrontDoor(ctx context.Context, build string) (object, error) {
	readInfo := func(ctx context.Context) (object, error) {
		attach, _, err := attachPrivate(ctx, "front-door")
		if err != nil {
			return nil, err
		}
		attach.Close()
		value, err := load(frontDoorInfoPath())
		if err != nil {
			return nil, err
		}
		info := obj(value)
		if info["build"] != build {
			return nil, errors.New(coreBuildMismatch)
		}
		return info, nil
	}
	if info, err := readInfo(ctx); err == nil || err.Error() == coreBuildMismatch || strings.HasPrefix(err.Error(), "FRONT_DOOR_PROTOCOL_MISMATCH") {
		return info, err
	}
	guard, err := frontDoorLock("front-door.lock", false)
	if err != nil {
		return nil, err
	}
	if guard == nil {
		return nil, errors.New("FRONT_DOOR_UNAVAILABLE: The front door still owns its lock. Inspect front-door.log; continuity is reduced until its endpoint recovers.")
	}
	defer guard.Close()
	source, err := os.Executable()
	if err != nil {
		return nil, err
	}
	image, err := stageFrontDoor(source, build)
	if err != nil {
		return nil, err
	}
	log, err := os.OpenFile(filepath.Join(root(), "front-door.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	defer log.Close()
	command := exec.Command(image, "front-door")
	command.Env = append(os.Environ(), "ARC_STATE_DIR="+root())
	command.Stderr = log
	platform.Detach(command)
	guard.Close()
	if err := command.Start(); err != nil {
		return nil, err
	}
	finished := make(chan error, 1)
	go func() { finished <- command.Wait() }()
	recordLog("INFO", fmt.Sprintf("Front door launched: pid %d", command.Process.Pid), nil)
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		info, readyErr := readInfo(wait)
		if readyErr == nil {
			if uintOr(info["pid"], 0) == uint64(command.Process.Pid) {
				return info, nil
			}
			_ = command.Process.Kill()
			<-finished
			return nil, errors.New("FRONT_DOOR_START_FAILED: The ready peer does not match the staged image.")
		}
		select {
		case err := <-finished:
			return nil, fmt.Errorf("FRONT_DOOR_START_FAILED: %v; inspect front-door.log", err)
		case <-wait.Done():
			_ = command.Process.Kill()
			<-finished
			recordLog("WARN", fmt.Sprintf("Front door readiness: %v", readyErr), nil)
			return nil, errors.New("FRONT_DOOR_START_TIMEOUT: Inspect front-door.log.")
		case <-tick.C:
		}
	}
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

func prepareFrontDoorCommand(ctx context.Context, input io.Reader, output io.Writer, hold bool) error {
	guard, err := frontDoorLock("front-door-install.lock", false)
	if err != nil {
		return err
	}
	if guard == nil {
		return errors.New("CORE_UNAVAILABLE: Installation holds the replacement path; retry after it finishes.")
	}
	defer guard.Close()
	if !hold {
		return nil
	}
	if err := outputLine(output, "ready"); err != nil {
		return err
	}
	_, err = bufio.NewReader(input).ReadString('\n')
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}
