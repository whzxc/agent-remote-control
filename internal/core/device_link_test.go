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

func TestUnresponsivePinnedPeerReleasesTheConnection(t *testing.T) {
	// Recurring bug class: lifecycle a pinned HTTP/2 connection must expire when the caller stops answering keepalive probes.
	ctx, cancel := context.WithTimeout(t.Context(), 19*time.Second)
	defer cancel()
	member, err := loadDeviceIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	controller, err := loadDeviceIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	socket, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	pin := func(candidate string) bool { return candidate == controller.id }
	server := newDevicePeerListener(member, pin, pin, func(w http.ResponseWriter, _ *http.Request, _, _ string) {
		devicePeerReply(w, object{}, nil)
	})
	server.allow = netip.Addr.IsLoopback
	exited := make(chan struct{})
	go func() { defer close(exited); server.listen(ctx, socket) }()
	defer func() { cancel(); <-exited }()
	raw, err := (&tls.Dialer{Config: deviceClientTLS(controller, member.id)}).DialContext(ctx, "tcp", socket.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = raw.SetDeadline(deadline)
	}
	if _, err := io.WriteString(raw, http2.ClientPreface); err != nil {
		t.Fatal(err)
	}
	framer := http2.NewFramer(raw, raw)
	if err := framer.WriteSettings(); err != nil {
		t.Fatal(err)
	}
	ping := false
	for {
		frame, err := framer.ReadFrame()
		if err != nil {
			if !ping || ctx.Err() != nil {
				t.Fatalf("peer did not enforce its keepalive bound: received ping=%v, %v", ping, err)
			}
			return
		}
		if frame, ok := frame.(*http2.SettingsFrame); ok && !frame.IsAck() {
			if err := framer.WriteSettingsAck(); err != nil {
				t.Fatal(err)
			}
		}
		if _, ok := frame.(*http2.PingFrame); ok {
			ping = true
		}
	}
}

func TestPairOfferCarriesOnlyAllowedAddressesAndVersion(t *testing.T) {
	// Contract: pairing keeps the pinned identity, LAN addresses and one-time secret and rejects unsupported versions.
	offer := deviceOffer{
		Version: deviceProtocolVersion, DeviceID: strings.Repeat("a", 64), Secret: strings.Repeat("b", 64),
		Addresses: []string{"192.168.2.3:7143", "[fe80::1%2]:7143"},
	}
	decoded, err := decodeDeviceOffer(offer.encode(), deviceLANAddress)
	if err != nil || wire(decoded) != wire(offer) {
		t.Fatalf("pairing wire %v: %v", decoded, err)
	}
	offer.Version++
	if _, err := decodeDeviceOffer(offer.encode(), deviceLANAddress); err == nil || managementErrorCode(err.Error()) != "DEVICE_PROTOCOL_MISMATCH" {
		t.Fatalf("unsupported version: %v", err)
	}
	offer.Version = deviceProtocolVersion
	offer.Addresses = append(offer.Addresses, "127.0.0.1:7143")
	if _, err := decodeDeviceOffer(offer.encode(), deviceLANAddress); err == nil || managementErrorCode(err.Error()) != "DEVICE_PAIRING_INVALID" {
		t.Fatalf("production pairing accepted a loopback offer: %v", err)
	}
}

func TestPairedConnectionCapacityPreservesActiveRequests(t *testing.T) {
	// Recurring bug class: concurrency admitting a replacement connection must preserve every active paired stream.
	var pool deviceConnections
	active := make([]func(), 0, deviceConnectionSlots)
	connections := make([]*deviceConnection, 0, deviceConnectionSlots)
	evicted := make(chan int, deviceConnectionSlots)
	for i := range deviceConnectionSlots {
		slot := pool.admit("controller", func() { evicted <- i })
		if slot == nil {
			t.Fatal("failed to allocate a paired slot")
		}
		connections = append(connections, slot)
		defer slot.close()
		done, ok := slot.request()
		if !ok {
			t.Fatal("failed to admit a request")
		}
		active = append(active, done)
	}
	if pool.admit("controller", func() {}) != nil {
		t.Fatal("all active slots must refuse replacement")
	}
	active[0]()
	if pool.admit("unrelated", func() {}) != nil {
		t.Fatal("another controller replaced an idle pinned connection")
	}
	replacement := pool.admit("controller", func() {})
	if replacement == nil {
		t.Fatal("the same controller could not replace its idle connection")
	}
	defer replacement.close()
	select {
	case got := <-evicted:
		if got != 0 {
			t.Fatalf("replacement evicted an active slot %d", got)
		}
	default:
		t.Fatal("replacement did not cancel the evicted connection")
	}
	for i := 1; i < len(connections); i++ {
		done, ok := connections[i].request()
		if !ok {
			t.Fatal("an active stream lost its connection")
		}
		done()
		active[i]()
	}
}
