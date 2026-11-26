package core

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http2"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

const (
	deviceProtocolVersion = 3
	deviceDefaultPort     = 7143
	deviceOfferTTL        = 600 * time.Second
	deviceReadPath        = "/arc-peer/3/"
)

type devicePeerRequest struct {
	Version uint16 `json:"version"`
	Tool    string `json:"tool"`
	Body    any    `json:"body"`
	Origin  any    `json:"origin"`
}

func (r devicePeerRequest) validate() error {
	if r.Version != deviceProtocolVersion {
		return deviceProtocolError()
	}
	switch r.Tool {
	case "guide", "query", "act":
	default:
		return errors.New("DEVICE_PEER_FORBIDDEN: Peers may call guide, query or act only; read query guide.")
	}
	op := text(r.Body, "op")
	args := obj(field(r.Body, "args"))
	if _, hasDevice := args["device"]; hasDevice || devicePeerForbidden(op) || op == "guide" && devicePeerForbidden(text(args, "op")) {
		return errors.New("DEVICE_PEER_FORBIDDEN: Peer-origin Device link and local management calls are unavailable; read query guide.")
	}
	if len(wire(r.Origin)) > 4096 {
		return errors.New("INVALID_ARGUMENT: origin must fit 4096 bytes")
	}
	return nil
}

func devicePeerForbidden(op string) bool {
	return op == "devices" || op == "device" || strings.HasPrefix(op, "device_") ||
		strings.HasPrefix(op, "device.") || strings.HasPrefix(op, "device/")
}

func deviceProtocolError() error {
	return errors.New("DEVICE_PROTOCOL_MISMATCH: Use peer protocol version 3; read cli guide.")
}

type deviceHandshakeBudget struct {
	mu        sync.Mutex
	addresses map[netip.Addr]*deviceAddressBudget
}

type deviceAddressBudget struct {
	since, used       time.Time
	remaining, active int
}

func (budget *deviceHandshakeBudget) admit(addr netip.Addr, now time.Time) (func(), bool) {
	addr = addr.Unmap().WithZone("")
	budget.mu.Lock()
	defer budget.mu.Unlock()
	if budget.addresses == nil {
		budget.addresses = make(map[netip.Addr]*deviceAddressBudget)
	}
	entry := budget.addresses[addr]
	if entry == nil {
		if len(budget.addresses) >= 256 {
			var oldest netip.Addr
			var stamp time.Time
			for key, entry := range budget.addresses {
				if entry.active == 0 && (!oldest.IsValid() || entry.used.Before(stamp) ||
					entry.used.Equal(stamp) && key.Compare(oldest) < 0) {
					oldest, stamp = key, entry.used
				}
			}
			if !oldest.IsValid() {
				return nil, false
			}
			delete(budget.addresses, oldest)
		}
		entry = &deviceAddressBudget{since: now, remaining: 32}
		budget.addresses[addr] = entry
	}
	entry.used = now
	if now.Sub(entry.since) >= time.Minute {
		entry.since, entry.remaining = now, 32
	}
	if entry.remaining == 0 || entry.active >= 2 {
		return nil, false
	}
	entry.remaining--
	entry.active++
	return func() {
		budget.mu.Lock()
		defer budget.mu.Unlock()
		entry.active--
	}, true
}

type devicePeerListener struct {
	tls      *tls.Config
	budget   deviceHandshakeBudget
	paired   deviceConnections
	unpaired chan struct{}
	isPaired func(string) bool
	serve    func(http.ResponseWriter, *http.Request, string, string)
	h2       http2.Server
}

func newDevicePeerListener(identity *deviceIdentity, authorize, isPaired func(string) bool,
	handler func(http.ResponseWriter, *http.Request, string, string)) *devicePeerListener {
	return &devicePeerListener{
		tls:      deviceServerTLS(identity, authorize),
		unpaired: make(chan struct{}, deviceConnectionSlots),
		isPaired: isPaired,
		serve:    handler,
		h2: http2.Server{
			ReadIdleTimeout: 10 * time.Second, PingTimeout: 5 * time.Second,
			MaxUploadBufferPerStream: 2 << 20, MaxUploadBufferPerConnection: 4 << 20,
			MaxReadFrameSize: 256 << 10, MaxConcurrentStreams: 128,
		},
	}
}

func (peer *devicePeerListener) listen(ctx context.Context, listener *net.TCPListener) {
	defer listener.Close()
	stop := context.AfterFunc(ctx, func() { listener.Close() })
	defer stop()
	ctx, cancel := context.WithCancel(ctx)
	var connections sync.WaitGroup
	defer connections.Wait()
	defer cancel()
	for {
		conn, err := listener.AcceptTCP()
		if err != nil {
			return
		}
		addr := conn.RemoteAddr().(*net.TCPAddr).AddrPort().Addr()
		if !deviceLANAddress(addr) || conn.SetKeepAliveConfig(net.KeepAliveConfig{
			Enable: true, Idle: 10 * time.Second, Interval: 5 * time.Second, Count: 3,
		}) != nil {
			conn.Close()
			continue
		}
		release, ok := peer.budget.admit(addr, time.Now())
		if !ok {
			conn.Close()
			continue
		}
		connections.Go(func() { peer.accept(ctx, conn, release) })
	}
}

func (peer *devicePeerListener) accept(ctx context.Context, conn net.Conn, releaseHandshake func()) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()

	tlsConn := tls.Server(conn, peer.tls)
	handshake, cancelHandshake := context.WithTimeout(ctx, 5*time.Second)
	err := tlsConn.HandshakeContext(handshake)
	cancelHandshake()
	releaseHandshake()
	if err != nil {
		return
	}
	state := tlsConn.ConnectionState()
	if state.NegotiatedProtocol != deviceALPN || len(state.PeerCertificates) != 1 {
		return
	}
	key := state.PeerCertificates[0].Raw
	_, fingerprint, publicKey, err := deviceCertificateIdentity(key)
	if err != nil {
		return
	}
	var connection *deviceConnection
	if peer.isPaired(fingerprint) {
		connection = peer.paired.admit(fingerprint, cancel)
		if connection == nil {
			return
		}
		defer connection.close()
	} else {
		select {
		case peer.unpaired <- struct{}{}:
			defer func() { <-peer.unpaired }()
		default:
			return
		}
		expiry := time.AfterFunc(deviceOfferTTL, cancel)
		defer expiry.Stop()
	}
	peer.h2.ServeConn(tlsConn, &http2.ServeConnOpts{
		Context:    ctx,
		BaseConfig: &http.Server{MaxHeaderBytes: 32768},
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if connection != nil {
				release, ok := connection.request()
				if !ok {
					devicePeerReply(w, nil, errors.New("DEVICE_BUSY: Peer connection was replaced; reconnect and query devices."))
					return
				}
				defer release()
				// Keep admission active while HTTP/2 writes the final buffered bytes.
				defer http.NewResponseController(w).Flush()
			}
			peer.serve(w, r, fingerprint, publicKey)
		}),
	})
}

func devicePeerBody(w http.ResponseWriter, r *http.Request) (object, error) {
	limit := int64(16384)
	if strings.HasSuffix(r.URL.Path, "/request") {
		limit = maxRequestBytes
	}
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(10 * time.Second))
	defer controller.SetReadDeadline(time.Time{})
	data, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		return nil, errors.New("INVALID_ARGUMENT: peer body deadline expired")
	}
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("INVALID_ARGUMENT: peer body exceeds its bound")
	}
	var value any
	if err := canonjson.Unmarshal(data, &value); err != nil {
		return nil, errors.New("INVALID_ARGUMENT: peer body must be JSON")
	}
	if uintOr(field(value, "version"), 0) != deviceProtocolVersion {
		return nil, deviceProtocolError()
	}
	return obj(value), nil
}

func devicePeerReply(w http.ResponseWriter, result any, err error) {
	value := object{"ok": true, "result": result}
	if err != nil {
		msg := err.Error()
		code := managementErrorCode(msg)
		value = object{"ok": false, "error": object{
			"code": code, "message": msg, "next": object{"via": "query", "op": "guide", "args": object{}},
		}}
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, wire(value))
}
