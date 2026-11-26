package core

import (
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/http2"
)

func TestDevicePeerTLSRequiresPinnedKeysAndNegotiatesHTTP2(t *testing.T) {
	// Contract: arc-peer/3 requires TLS 1.3, explicit HTTP/2 peer ALPN, and key possession at both ends.
	member, err := loadDeviceIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	controller, err := loadDeviceIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	unpaired, err := loadDeviceIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	authorize := func(id string) bool { return id == controller.id }
	peer := newDevicePeerListener(member, authorize, authorize, func(w http.ResponseWriter, r *http.Request, id, key string) {
		devicePeerReply(w, object{"controller": id, "key": key, "version": r.TLS.Version}, nil)
	})

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connected := make(chan struct{})
	go func() {
		defer close(connected)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go peer.accept(ctx, conn, func() {})
		}
	}()
	defer func() { listener.Close(); <-connected }()

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://arc-peer.local/arc-peer/3/hello", strings.NewReader(`{"version":3}`))
	if err != nil {
		t.Fatal(err)
	}
	noCert := deviceClientTLS(controller, member.id)
	noCert.Certificates = nil
	noALPN := deviceClientTLS(controller, member.id)
	noALPN.NextProtos = nil
	tls12 := deviceClientTLS(controller, member.id)
	tls12.MinVersion, tls12.MaxVersion = tls.VersionTLS12, tls.VersionTLS12
	valid := deviceClientTLS(controller, member.id)
	for _, cfg := range []*tls.Config{
		deviceClientTLS(unpaired, member.id), deviceClientTLS(controller, unpaired.id), noCert, noALPN, tls12, valid,
	} {
		accepted := cfg == valid
		conn, err := (&tls.Dialer{Config: cfg}).DialContext(ctx, "tcp", listener.Addr().String())
		if err != nil {
			if accepted {
				t.Fatal(err)
			}
			continue
		}
		channel, err := (&http2.Transport{}).NewClientConn(conn)
		if err != nil {
			conn.Close()
			if accepted {
				t.Fatal(err)
			}
			continue
		}
		call := request.Clone(ctx)
		call.Body, err = request.GetBody()
		if err != nil {
			t.Fatal(err)
		}
		response, err := channel.RoundTrip(call)
		if err == nil {
			data, readErr := io.ReadAll(response.Body)
			response.Body.Close()
			if !accepted || readErr != nil || response.ProtoMajor != 2 ||
				string(data) != wire(object{"ok": true, "result": object{"controller": controller.id, "key": controller.publicKey, "version": tls.VersionTLS13}}) {
				t.Errorf("unexpected TLS/HTTP2 response %s: %v", data, readErr)
			}
		}
		channel.Close()
		if accepted && err != nil {
			t.Fatal(err)
		}
		if !accepted && err == nil {
			t.Fatal("inadmissible peer routed an HTTP request")
		}
	}
}

func TestPeerHandshakeBudgetUsesOneBucketPerSource(t *testing.T) {
	// Recurring bug class: security peer handshake throttling survives mapped addresses.
	var budget deviceHandshakeBudget
	stamp := time.Unix(0, 0)
	ip := netip.MustParseAddr("192.168.1.2")
	mapped := netip.MustParseAddr("::ffff:192.168.1.2")
	first, ok := budget.admit(ip, stamp)
	if !ok {
		t.Fatal("first handshake rejected")
	}
	second, ok := budget.admit(mapped, stamp)
	if !ok {
		t.Fatal("second handshake rejected")
	}
	if _, ok := budget.admit(mapped, stamp); ok {
		t.Fatal("accepted a third concurrent handshake")
	}
	first()
	second()
	for n := 2; n < 32; n++ {
		release, ok := budget.admit(ip, stamp)
		if !ok {
			t.Fatalf("rejected handshake %d within budget", n+1)
		}
		release()
	}
	if _, ok := budget.admit(mapped, stamp.Add(59*time.Second)); ok {
		t.Fatal("mapped address bypassed the per-minute limit")
	}
	release, ok := budget.admit(mapped, stamp.Add(time.Minute))
	if !ok {
		t.Fatal("per-minute limit did not reset")
	}
	release()
}
