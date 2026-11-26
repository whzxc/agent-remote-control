package core

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
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

func listenPrivate(ctx context.Context, endpoint, token string, core *inProcess) (net.Listener, error) {
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
					servePrivate(ctx, core, token, conn)
				}()
			default:
				conn.Close()
			}
		}
	}()
	return listener, nil
}

func servePrivate(parent context.Context, core *inProcess, token string, conn net.Conn) {
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	var attach map[string]json.RawMessage
	if err := readFrame(conn, 4096, &attach); err != nil || len(attach) != 1 {
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
	deadline := time.Now().Add(120 * time.Second)
	if limit, ok := ctx.Deadline(); ok && limit.Before(deadline) {
		deadline = limit
	}
	_ = conn.SetDeadline(deadline)
	cancel := context.AfterFunc(ctx, func() { conn.Close() })
	defer cancel()
	var operationName any = object{"Management": privateManagement{Route: route, Method: method}}
	switch route {
	case "healthz":
		operationName = "Health"
	case "cli/control":
		operationName = "LocalControl"
	}
	requestID := text(field(body, "args"), "requestId")
	if requestID == "" {
		requestID = text(body, "requestId")
	}
	if requestID == "" {
		requestID = id()
	}
	request := frontDoorRequest{Version: hello.Version, Generation: hello.Generation, ID: requestID,
		Deadline: frontDoorDeadline{UnixMS: uint64(deadline.UnixMilli())}, Context: frontDoorContext{Authority: "Management"},
		Operation: operationName, Body: body}
	encoded, err := canonjson.Marshal(request)
	if err != nil {
		return nil, err
	}
	if len(encoded) > maxRequestBytes {
		return nil, errors.New(frontDoorFrameTooLarge)
	}
	isWrite := method != http.MethodGet && route != "app/snapshot"
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
