package core

import (
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

func desktopSignal(t *testing.T, messages <-chan struct{}) {
	t.Helper()
	select {
	case <-messages:
	case <-time.After(2 * time.Second):
		t.Fatal("desktop request did not acknowledge activity")
	}
}

func connectDesktopTest(t *testing.T, endpoint object, method, route string) net.Conn {
	t.Helper()
	port := strconv.FormatUint(uintOr(endpoint["port"], 0), 10)
	sock, err := net.DialTimeout("tcp4", "127.0.0.1:"+port, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sock.Close() })
	_, err = fmt.Fprintf(sock, "%s /api/%s HTTP/1.1\r\nHost: 127.0.0.1:%s\r\nAuthorization: Bearer %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
		method, route, port, endpoint["token"])
	if err != nil {
		t.Fatal(err)
	}
	return sock
}

func TestDesktopAdmissionAndDisconnectCancellation(t *testing.T) {
	// Recurring bug class: concurrency excess Desktop requests and abandoned snapshots exhausted request admission.
	started, finished := make(chan struct{}, 32), make(chan struct{}, 32)
	release := make(chan struct{})
	transport, err := listenDesktop(func(ctx context.Context, route, method string, body object) (any, error) {
		if route == "app" {
			build, err := processBuildID()
			return object{"build": build}, err
		}
		started <- struct{}{}
		defer func() { finished <- struct{}{} }()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-release:
			return object{"completed": true}, nil
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer transport.close()
	sockets := []net.Conn{}
	for range 16 {
		sockets = append(sockets, connectDesktopTest(t, transport.endpoint, "GET", "permissions/desktop"))
		desktopSignal(t, started)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := forwardDesktop(ctx, transport.endpoint, "app", "GET", nil); err == nil || !strings.HasPrefix(err.Error(), "DESKTOP_BUSY:") {
		t.Fatalf("desktop admission overflow = %v", err)
	}
	_ = sockets[0].Close()
	desktopSignal(t, finished)
	health, err := forwardDesktop(ctx, transport.endpoint, "app", "GET", nil)
	expected, _ := processBuildID()
	if err != nil || field(health, "build") != expected {
		t.Fatalf("desktop after cancellation = %v, %v", health, err)
	}
	for _, socket := range sockets[1:] {
		_ = socket.Close()
		desktopSignal(t, finished)
	}
	snapshot := connectDesktopTest(t, transport.endpoint, "POST", "app/snapshot")
	desktopSignal(t, started)
	_ = snapshot.Close()
	desktopSignal(t, finished)
	write := connectDesktopTest(t, transport.endpoint, "POST", "permissions/notify")
	desktopSignal(t, started)
	close(release)
	_ = write.SetReadDeadline(time.Now().Add(2 * time.Second))
	response, err := io.ReadAll(write)
	if err != nil || !strings.HasPrefix(string(response), "HTTP/1.1 200") || !strings.HasSuffix(string(response), `{"completed":true}`) {
		t.Fatalf("forwarded write = %q, %v", response, err)
	}
	desktopSignal(t, finished)
	ip := net.JoinHostPort("127.0.0.1", strconv.FormatUint(uintOr(transport.endpoint["port"], 0), 10))
	for range 32 {
		conn, err := net.DialTimeout("tcp4", ip, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
	}
	overflow, err := net.DialTimeout("tcp4", ip, time.Second)
	if err != nil {
		return
	}
	defer overflow.Close()
	_ = overflow.SetReadDeadline(time.Now().Add(2 * time.Second))
	var responseByte [1]byte
	if n, err := overflow.Read(responseByte[:]); n != 0 || err == nil {
		t.Fatalf("extra idle connection retained an active socket: %d bytes, %v", n, err)
	}
}
