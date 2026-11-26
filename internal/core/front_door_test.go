package core

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func requestForEndpoint(endpoint *inProcess, operation any, body object) frontDoorRequest {
	r := newPrivateRequest(context.Background(), operation, "Management", body)
	r.Generation = endpoint.generation
	return r
}

func TestMaintenanceReopensOnlyAServiceThatIsNotShuttingDown(t *testing.T) {
	// Recurring bug class: lifecycle maintenance release reopened a Core that was already shutting down.
	endpoint := newInProcess(nil)
	first, err := endpoint.enterMaintenance()
	if err != nil {
		t.Fatal(err)
	}
	hello, err := endpoint.hello(frontDoorVersion)
	if err != nil || hello.Readiness != "Draining" {
		t.Fatalf("maintenance readiness = %v, %v", hello, err)
	}
	if ack, err := first.drain(context.Background()); err != nil || ack.Outstanding != 0 {
		t.Fatalf("drain = %v, %v", ack, err)
	}
	first.close()
	hello, _ = endpoint.hello(frontDoorVersion)
	if hello.Readiness != "Ready" {
		t.Fatal(hello)
	}
	second, err := endpoint.enterMaintenance()
	if err != nil {
		t.Fatal(err)
	}
	endpoint.drain()
	second.close()
	hello, _ = endpoint.hello(frontDoorVersion)
	if hello.Readiness != "Draining" {
		t.Fatal(hello)
	}
}

func TestMaintenanceCancelsReadsAndWaitsOnlyForWrites(t *testing.T) {
	// Recurring bug class: lifecycle open reads and snapshot streams prevented a compatible gateway replacement.
	endpoint := newInProcess(nil)
	ctx := context.Background()
	read := requestForEndpoint(endpoint, "Health", object{})
	reading, endRead, err := endpoint.begin(ctx, read, false)
	if err != nil {
		t.Fatal(err)
	}
	defer endRead()
	stream := requestForEndpoint(endpoint, object{"Snapshot": object{"kind": "Status"}}, object{})
	streaming, endStream, err := endpoint.begin(ctx, stream, true)
	if err != nil {
		t.Fatal(err)
	}
	defer endStream()
	write := requestForEndpoint(endpoint, "Mcp", object{"method": "tools/call", "params": object{"name": "act", "arguments": object{"op": "ax_report"}}})
	writing, endWrite, err := endpoint.begin(ctx, write, false)
	if err != nil {
		t.Fatal(err)
	}
	maintenance, err := endpoint.enterMaintenance()
	if err != nil {
		endWrite()
		t.Fatal(err)
	}
	defer maintenance.close()
	if maintenance.endedReads != 2 || maintenance.outstandingWrites() != 1 {
		endWrite()
		t.Fatalf("maintenance ended %d reads and retained %d writes", maintenance.endedReads, maintenance.outstandingWrites())
	}
	for _, item := range []struct {
		ctx context.Context
		id  string
	}{{reading, read.ID}, {streaming, stream.ID}} {
		value := privateErrorObject(t, privateOutcome(item.ctx))
		if field(value["data"], "requestId") != item.id || field(field(value["data"], "next"), "op") != "guide" {
			t.Fatalf("maintenance lost the original read: %v", value)
		}
	}
	if writing.Err() != nil {
		endWrite()
		t.Fatal("maintenance cancelled an admitted write")
	}
	now, stop := context.WithCancel(ctx)
	stop()
	_, err = maintenance.drain(now)
	if err == nil || !strings.HasPrefix(err.Error(), "FRONT_DOOR_DRAIN_DEADLINE:") || maintenance.outstandingWrites() != 1 {
		endWrite()
		t.Fatalf("write did not block the drain: %v", err)
	}
	endWrite()
	if ack, err := maintenance.drain(ctx); err != nil || ack.Outstanding != 0 || maintenance.outstandingWrites() != 0 {
		t.Fatalf("reads blocked a drained write: %v, %v", ack, err)
	}
}

func TestFramingBoundsCountEscapesAndMultibyteUTF8(t *testing.T) {
	// Algorithmic core: encoded-byte bounds cover JSON escaping and multibyte UTF-8.
	for body, size := range map[string]int{"abc": 5, "\n\"\\": 8, "🚀": 6} {
		data, err := boundedPrivateJSON(body, size)
		if err != nil || len(data) != size {
			t.Fatalf("frame of %d bytes at its bound: %q, %v", size, data, err)
		}
		if _, err := boundedPrivateJSON(body, size-1); err == nil || !strings.HasPrefix(err.Error(), "FRONT_DOOR_FRAME_TOO_LARGE:") {
			t.Fatalf("frame of %d bytes exceeded bound: %v", size, err)
		}
	}
}

func TestPrivateDeliveryRejectsStaleExpiredAndOversizedFrames(t *testing.T) {
	// Contract: private state cannot cross generations, expire silently or exceed negotiated frame limits.
	request := requestForEndpoint(newInProcess(nil), "Health", object{})
	reply := frontDoorResponse{Generation: request.Generation, RequestID: request.ID, Body: object{"Ok": object{"ok": true}}}
	if err := validatePrivateResponse(request, reply); err != nil {
		t.Fatal(err)
	}
	stale := reply
	stale.Generation = newInProcess(nil).generation
	if err := validatePrivateResponse(request, stale); err == nil || err.Error() != frontDoorStaleGeneration {
		t.Fatalf("stale generation result: %v", err)
	}
	request.Deadline = afterDeadline(0)
	if err := validatePrivateResponse(request, reply); err == nil || err.Error() != frontDoorDeadlineExpired {
		t.Fatalf("expired response result: %v", err)
	}
	request.Body = strings.Repeat("x", maxRequestBytes)
	if _, err := boundedPrivateJSON(request, maxRequestBytes); err == nil || err.Error() != frontDoorFrameTooLarge {
		t.Fatalf("oversized request result: %v", err)
	}
	reply.Body["Ok"] = strings.Repeat("x", maxFrameBytes)
	if _, err := boundedPrivateJSON(reply, maxFrameBytes); err == nil || err.Error() != frontDoorFrameTooLarge {
		t.Fatalf("oversized response result: %v", err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	endpoint := newInProcess(localWireTarget{})
	token := "test-private-token"
	for _, expired := range []bool{true, false} {
		request := requestForEndpoint(endpoint, "Health", object{})
		client, server := net.Pipe()
		stopped := make(chan struct{})
		go func() {
			defer close(stopped)
			defer server.Close()
			servePrivate(ctx, endpoint, token, server, nil)
		}()
		func() {
			defer func() { _ = client.Close(); <-stopped }()
			var hello frontDoorHello
			if err := privateHello(ctx, client, token, &hello); err != nil {
				t.Fatal(err)
			}
			_ = client.SetDeadline(time.Now().Add(2 * time.Second))
			if expired {
				request.Deadline = afterDeadline(0)
			} else {
				request.Body = strings.Repeat("x", maxRequestBytes)
			}
			if err := writeFrame(client, object{"Request": request}); err != nil {
				t.Fatal(err)
			}
			var discarded frontDoorResponse
			if err := readFrame(client, maxFrameBytes, &discarded); !errors.Is(err, io.EOF) {
				t.Fatalf("received rejected request (expired=%v): %v, %v", expired, discarded, err)
			}
		}()
	}
	client, server := net.Pipe()
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		defer server.Close()
		var envelope object
		if readFrame(server, maxRequestBytes, &envelope) == nil {
			var header [4]byte
			binary.BigEndian.PutUint32(header[:], maxFrameBytes+1)
			_, _ = server.Write(header[:])
		}
	}()
	defer func() { _ = client.Close(); <-stopped }()
	if _, err := exchangePrivate(ctx, client, requestForEndpoint(endpoint, "Health", object{}), "Request"); err == nil ||
		!strings.Contains(err.Error(), frontDoorFrameTooLarge) {
		t.Fatalf("oversized response delivery = %v", err)
	}
}

func TestPrivateCancellationAndDrainRetainGeneration(t *testing.T) {
	// Contract: only the matching private generation cancels a call, and admitted writes must finish before drain acknowledgment.
	endpoint := newInProcess(nil)
	if hello, err := endpoint.hello(frontDoorVersion); err != nil || hello.Readiness != "Ready" {
		t.Fatalf("initial private readiness = %v, %v", hello, err)
	}
	if _, err := endpoint.hello(frontDoorVersion + 1); err == nil || !strings.HasPrefix(err.Error(), "FRONT_DOOR_PROTOCOL_MISMATCH:") {
		t.Fatalf("incompatible hello = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	r := requestForEndpoint(endpoint, object{"Management": object{"route": "test", "method": "POST"}}, object{})
	admitted, release, err := endpoint.begin(ctx, r, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := endpoint.cancel(frontDoorCancellation{Generation: newInProcess(nil).generation, RequestID: r.ID}); err == nil || admitted.Err() != nil {
		release()
		t.Fatalf("wrong generation cancellation = %v, %v", err, admitted.Err())
	}
	if err := endpoint.cancel(frontDoorCancellation{Generation: r.Generation, RequestID: r.ID}); err != nil || !errors.Is(admitted.Err(), context.Canceled) {
		release()
		t.Fatalf("matching cancellation = %v, %v", err, admitted.Err())
	}
	if _, err := endpoint.drainRequests(admitted); err == nil || !strings.HasPrefix(err.Error(), "FRONT_DOOR_DRAIN_DEADLINE:") {
		release()
		t.Fatal("acknowledged drain before admitted request finished")
	}
	if hello, err := endpoint.hello(frontDoorVersion); err != nil || hello.Readiness != "Draining" {
		release()
		t.Fatalf("ordinary drain readiness = %v, %v", hello, err)
	}
	release()
	ack, err := endpoint.drainRequests(ctx)
	if err != nil || ack.Generation != r.Generation || ack.Outstanding != 0 {
		t.Fatalf("ack = %v, %v", ack, err)
	}
}

func TestCoreShutdownCancelsDesktopReadsWithoutWaitingForTheirWorkers(t *testing.T) {
	// Recurring bug class: lifecycle an outstanding Desktop read kept the last client's Core draining.
	endpoint := newInProcess(nil)
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	reads := []object{{"route": "agents/activity", "method": "GET"}, {"route": "state/wait", "method": "POST"}}
	var admitted []context.Context
	for _, route := range reads {
		read := requestForEndpoint(endpoint, object{"Management": route}, object{})
		reading, release, err := endpoint.begin(t.Context(), read, false)
		if err != nil {
			t.Fatal(err)
		}
		defer release()
		admitted = append(admitted, reading)
	}
	ack, err := endpoint.drainRequests(ctx)
	if err != nil || ack.Generation != endpoint.generation {
		t.Fatalf("Desktop reads held the shutdown drain open: %v, %v", ack, err)
	}
	for _, reading := range admitted {
		if err := context.Cause(reading); err == nil || !strings.HasPrefix(err.Error(), "FRONT_DOOR_CORE_DRAINING:") {
			t.Fatalf("admitted read was not cancelled for shutdown: %v", err)
		}
	}
}
