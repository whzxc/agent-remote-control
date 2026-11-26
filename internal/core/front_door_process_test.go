package core

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestPrivateHelloFrameRoundTrip(t *testing.T) {
	// Contract: v3 IPC frames carry serde-compatible generation bytes and preserve the negotiated limits.
	value := frontDoorHello{Version: frontDoorVersion, Generation: generation{7}, Readiness: "Ready", MaxRequestBytes: maxRequestBytes, MaxFrameBytes: maxFrameBytes}
	var stream bytes.Buffer
	if err := writeFrame(&stream, value); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(stream.Bytes(), []byte(`"generation":[7,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]`)) {
		t.Fatalf("generation is not a byte array: %s", stream.Bytes())
	}
	var decoded frontDoorHello
	if err := readFrame(&stream, 4096, &decoded); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decoded, value) {
		t.Fatalf("hello = %+v, want %+v", decoded, value)
	}
}

func privateErrorObject(t *testing.T, err error) object {
	t.Helper()
	var value object
	if err == nil {
		t.Fatal("expected a private request error")
	}
	if decodeErr := decodeObject([]byte(err.Error()), &value); decodeErr != nil {
		t.Fatalf("private error = %v, cannot decode: %v", err, decodeErr)
	}
	return value
}

func TestAdmissionQueueRetainsIdentityAndRestoresCapacity(t *testing.T) {
	// Algorithmic core: queue count and encoded bytes are independent admission bounds.
	ctx := context.Background()
	queue := &gatewayBridge{}
	request := newPrivateRequest(ctx, "LocalControl", "Management", object{"op": "ax_report", "requestId": "original-request", "args": object{}})
	var accepted []func()
	for range maxQueued {
		release, err := queue.reserve(request)
		if err != nil {
			t.Fatal(err)
		}
		accepted = append(accepted, release)
	}
	_, err := queue.reserve(request)
	data := privateErrorObject(t, err)["data"]
	if field(data, "requestId") != "original-request" || text(field(data, "next"), "op") != "guide" ||
		checkSchema("op", "guide", "guide", operation("guide")["inputSchema"], field(field(data, "next"), "args")) != nil {
		t.Fatalf("queue rejection lost recovery information: %v", data)
	}
	for _, release := range accepted {
		release()
	}
	request.Body = strings.Repeat("x", maxQueueBytes/3)
	first, err := queue.reserve(request)
	if err != nil {
		t.Fatal(err)
	}
	defer first()
	second, err := queue.reserve(request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := queue.reserve(request); err == nil || !strings.Contains(err.Error(), "FRONT_DOOR_BUSY") {
		t.Fatalf("byte budget accepted a third request: %v", err)
	}
	second()
	release, err := queue.reserve(request)
	if err != nil {
		t.Fatal(err)
	}
	release()
}

func TestWaitingRequestExpiresWithOriginalIdentity(t *testing.T) {
	// Recurring bug class: retry-replay waiting for Core lost or extended an admitted request's identity and deadline.
	ctx := context.Background()
	queue := &gatewayBridge{}
	request := newPrivateRequest(ctx, "LocalControl", "Management", object{"op": "ax_report", "requestId": "original-request", "args": object{}})
	request.Deadline = afterDeadline(0)
	original := request.Deadline
	_, err := queue.ready(ctx, &request)
	data := privateErrorObject(t, err)["data"]
	if field(data, "requestId") != "original-request" || text(field(data, "next"), "via") != "query" || request.Deadline != original {
		t.Fatalf("expired request = %v, %v", request, data)
	}
	request.Deadline = afterDeadline(time.Minute)
	queue.closeAdmission()
	_, err = queue.ready(ctx, &request)
	stopping := privateErrorObject(t, err)
	if !strings.HasPrefix(text(stopping, "message"), "FRONT_DOOR_UNAVAILABLE:") ||
		field(stopping["data"], "requestId") != "original-request" {
		t.Fatalf("stopping request = %v", stopping)
	}
}

func TestStagedFrontDoorUsesCurrentInstalledBuild(t *testing.T) {
	// Recurring bug class: lifecycle compatible installations kept launching the first staged build indefinitely.
	if operatingSystem == "windows" {
		t.Skip("this executable fixture uses a Unix shell")
	}
	state := t.TempDir()
	images := filepath.Join(state, "images")
	source := filepath.Join(state, "installed")
	var first string
	for _, version := range []string{"build-A", "build-B"} {
		if err := os.WriteFile(source, []byte("#!/bin/sh\nprintf '%s\\n' "+version+"\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		build, err := buildID(source)
		if err != nil {
			t.Fatal(err)
		}
		image, err := stageFrontDoorAt(images, source, build)
		if err != nil {
			t.Fatal(err)
		}
		data, err := exec.Command(image, "--version").Output()
		if err != nil || strings.TrimSpace(string(data)) != version {
			t.Fatalf("%s launched %q, %v", image, data, err)
		}
		if first == "" {
			first = image
		} else if err := pruneFrontDoorImagesAt(images, build); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(first); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("previous incompatible image still exists: %v", err)
	}
}

func TestLostPrivateResponseRetainsWriteReceiptButFailsRead(t *testing.T) {
	// Contract: sent reads can be repeated after a disconnect, while writes retain the original receipt ID.
	ctx := context.Background()
	for _, writes := range []bool{false, true} {
		body := object{"method": "ping", "id": 1}
		if writes {
			body = object{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": object{"name": "act",
				"arguments": object{"op": "codex_send", "requestId": "original-request", "args": object{}}}}
		}
		request := newPrivateRequest(ctx, "Mcp", "Management", body)
		client, core := net.Pipe()
		done := make(chan error, 1)
		go func() {
			var received object
			err := readFrame(core, maxRequestBytes, &received)
			_ = core.Close()
			done <- err
		}()
		_, err := exchangePrivate(ctx, client, request, "Request")
		_ = client.Close()
		if received := <-done; received != nil {
			t.Fatal(received)
		}
		if !writes {
			if err == nil || !strings.HasPrefix(err.Error(), "FRONT_DOOR_CORE_LOST:") {
				t.Fatalf("lost read = %v", err)
			}
			continue
		}
		value := privateErrorObject(t, err)
		data := value["data"]
		next := field(data, "next")
		if wire(value["code"]) != "-32603" || field(data, "state") != "unconfirmed" || field(data, "requestId") != "original-request" ||
			wire(next) != `{"args":{"action":"read","requestId":"original-request"},"op":"receipt","via":"act"}` {
			t.Fatalf("lost write = %v", value)
		}
	}
}

func TestPrivateWriteUsesSameGeneratedReceiptID(t *testing.T) {
	// Recurring bug class: retry-replay a lost transport response exposed an ID different from the original receipt.
	ctx := context.Background()
	request := newPrivateRequest(ctx, "Mcp", "Management", object{"method": "tools/call",
		"params": object{"name": "act", "arguments": object{"op": "codex_send", "args": object{}}}})
	if _, err := uuid.Parse(request.ID); err != nil {
		t.Fatal(err)
	}
	if sent := privateEnvelope(request.Operation, obj(request.Body)); sent["requestId"] != request.ID {
		t.Fatalf("transmitted request = %v", sent)
	}
	for _, mode := range []string{"Mcp", "LocalControl"} {
		for _, op := range []string{"receipt", "logs", "codex_account"} {
			body := object{"op": op, "args": object{"action": "read", "requestId": "target"}}
			if mode == "Mcp" {
				body = object{"method": "tools/call", "params": object{"name": "act", "arguments": body}}
			}
			read := newPrivateRequest(ctx, mode, "Management", body)
			if sent := privateEnvelope(mode, obj(read.Body)); sent["requestId"] != nil || op == "receipt" && isPrivateWrite(read) {
				t.Fatalf("read allocated a write receipt: %v", sent)
			}
		}
	}
}

func TestPrivateFrameRejectsLengthBeforeReadingBody(t *testing.T) {
	// Contract: untrusted encoded lengths beyond the negotiated limit are rejected before body allocation.
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], 4097)
	var reply object
	if err := readFrame(bytes.NewReader(header[:]), 4096, &reply); err == nil || !strings.HasPrefix(err.Error(), "FRONT_DOOR_FRAME_TOO_LARGE:") {
		t.Fatalf("oversized header returned %v", err)
	}
}
