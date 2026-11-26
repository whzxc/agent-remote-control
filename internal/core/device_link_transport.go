package core

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"maps"
	"net"
	"net/http"
	"net/netip"
	"runtime"
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
	activeMu sync.Mutex
	active   map[net.Conn]context.CancelFunc
	allow    func(netip.Addr) bool
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
		active:   make(map[net.Conn]context.CancelFunc),
		allow:    deviceLANAddress,
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
		if !peer.allow(addr) || conn.SetKeepAliveConfig(net.KeepAliveConfig{
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
	peer.activeMu.Lock()
	peer.active[conn] = cancel
	peer.activeMu.Unlock()
	defer func() {
		peer.activeMu.Lock()
		defer peer.activeMu.Unlock()
		delete(peer.active, conn)
	}()
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

func (peer *devicePeerListener) closeConnections() {
	peer.activeMu.Lock()
	defer peer.activeMu.Unlock()
	for _, cancel := range peer.active {
		cancel()
	}
}

type devicePeerRuntime struct {
	listener *devicePeerListener
	cancel   context.CancelFunc
	stopped  chan struct{}
}

func (r *devicePeerRuntime) close() {
	r.cancel()
	<-r.stopped
}

type deviceInterfaceListener struct {
	listener *net.TCPListener
	cancel   context.CancelFunc
	deviceLANBinding
}

func (m *deviceManager) startPeerRuntime(identity *deviceIdentity, port uint16) (*devicePeerRuntime, error) {
	bindings, err := m.bindings(port)
	if err != nil {
		return nil, err
	}
	interfaces := map[netip.AddrPort]*deviceInterfaceListener{}
	closeAll := func() {
		for _, item := range interfaces {
			item.listener.Close()
		}
	}
	for _, binding := range bindings {
		if interfaces[binding.addr] != nil {
			continue
		}
		listener, err := net.ListenTCP("tcp", net.TCPAddrFromAddrPort(binding.addr))
		if err != nil {
			closeAll()
			return nil, fmt.Errorf("DEVICE_LISTEN_FAILED: Cannot bind %s: %v. Configure another peer port locally.", binding.addr, err)
		}
		interfaces[binding.addr] = &deviceInterfaceListener{listener: listener, deviceLANBinding: binding}
	}
	stopDNS, err := m.discovery(identity, port, bindings)
	if err != nil {
		closeAll()
		return nil, err
	}
	ctx, cancel := context.WithCancel(m.lifetime)
	peer := newDevicePeerListener(identity, m.acceptCertificate, func(id string) bool {
		_, err := m.controller(id)
		return err == nil
	}, m.servePeer)
	peer.allow = m.allow
	runtime := &devicePeerRuntime{listener: peer, cancel: cancel, stopped: make(chan struct{})}
	go func() {
		defer close(runtime.stopped)
		var workers sync.WaitGroup
		defer workers.Wait()
		defer func() { closeAll(); stopDNS() }()
		start := func(item *deviceInterfaceListener) {
			ctx, cancel := context.WithCancel(ctx)
			item.cancel = cancel
			workers.Go(func() { peer.listen(ctx, item.listener) })
		}
		for _, item := range interfaces {
			start(item)
		}
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			bindings, err := m.bindings(port)
			if err != nil {
				recordLog("WARN", err.Error(), nil)
				continue
			}
			next := map[netip.AddrPort]deviceLANBinding{}
			for _, binding := range bindings {
				next[binding.addr] = binding
			}
			changed := false
			for socket, item := range interfaces {
				if _, exists := next[socket]; !exists {
					item.cancel()
					delete(interfaces, socket)
					changed = true
				}
			}
			for socket, binding := range next {
				if interfaces[socket] != nil {
					continue
				}
				listener, err := net.ListenTCP("tcp", net.TCPAddrFromAddrPort(socket))
				if err != nil {
					recordLog("WARN", fmt.Sprintf("Device link cannot bind %s: %v", socket, err), nil)
					continue
				}
				item := &deviceInterfaceListener{listener: listener, deviceLANBinding: binding}
				interfaces[socket] = item
				start(item)
				changed = true
			}
			if changed {
				paired := make([]deviceLANBinding, 0, len(interfaces))
				for _, item := range interfaces {
					paired = append(paired, item.deviceLANBinding)
				}
				stopDNS()
				stopDNS = func() {}
				if stop, err := m.discovery(identity, port, paired); err != nil {
					recordLog("WARN", err.Error(), nil)
				} else {
					stopDNS = stop
				}
			}
		}
	}()
	return runtime, nil
}

var serveDeviceTransfer func(*deviceManager, http.ResponseWriter, *http.Request, string)

func (m *deviceManager) servePeer(w http.ResponseWriter, r *http.Request, id, key string) {
	path := r.URL.EscapedPath()
	if strings.HasPrefix(path, deviceReadPath+"transfer/") && serveDeviceTransfer != nil {
		serveDeviceTransfer(m, w, r, id)
		return
	}
	result, err := m.routePeer(w, r, id, key, path)
	devicePeerReply(w, result, err)
}

func (m *deviceManager) routePeer(w http.ResponseWriter, r *http.Request, id, key, path string) (any, error) {
	if !m.acceptCertificate(id) {
		return nil, errors.New("DEVICE_UNPAIRED: Create and approve a new member-local offer; read cli guide.")
	}
	if r.Method != http.MethodPost {
		return nil, errors.New("DEVICE_PEER_FORBIDDEN: Use peer protocol version 3 routes; read cli guide.")
	}
	switch path {
	case deviceReadPath + "pair", deviceReadPath + "request", deviceReadPath + "hello", deviceReadPath + "topology":
	default:
		return nil, errors.New("DEVICE_PEER_FORBIDDEN: Use peer protocol version 3 routes; read cli guide.")
	}
	body, err := devicePeerBody(w, r)
	if err != nil {
		return nil, err
	}
	ctx := r.Context()
	switch path {
	case deviceReadPath + "pair":
		return m.prove(ctx, id, key, body)
	case deviceReadPath + "hello":
		return m.hello()
	case deviceReadPath + "topology":
		if _, err := m.controller(id); err != nil {
			return nil, err
		}
		var visited []string
		if body["visited"] == nil || canonjson.Unmarshal([]byte(wire(body["visited"])), &visited) != nil {
			return nil, errors.New("INVALID_ARGUMENT: topology requires visited device IDs")
		}
		contains, err := m.containsDescendant(ctx, text(body, "deviceId"), visited)
		return object{"contains": contains}, err
	default:
		return m.business(ctx, id, body)
	}
}

func (m *deviceManager) hello() (object, error) {
	identity, err := m.currentIdentity()
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	port, name := m.stored.Port, m.name()
	m.mu.Unlock()
	addresses, err := m.addresses(port)
	if err != nil {
		return nil, err
	}
	platform, arch := operatingSystem, runtime.GOARCH
	if platform == "darwin" {
		platform = "macos"
	}
	switch arch {
	case "arm64":
		arch = "aarch64"
	case "amd64":
		arch = "x86_64"
	}
	return object{"version": deviceProtocolVersion, "deviceId": identity.id, "name": name, "platform": platform, "arch": arch,
		"arcVersion": buildVersion, "tunnelUrl": m.publicPeerURL(), "addresses": addresses,
		"capabilities": object{"tools": []string{"guide", "query", "act"}, "screen": platform == "macos", "forwarding": false}}, nil
}

func decodeDeviceRequest(body object, message string) (devicePeerRequest, error) {
	var request devicePeerRequest
	_, hasBody := body["body"]
	_, hasOrigin := body["origin"]
	if body["version"] == nil || body["tool"] == nil || !hasBody || !hasOrigin ||
		decodeDeviceStrict([]byte(wire(body)), &request) != nil {
		return request, errors.New(message)
	}
	return request, request.validate()
}

func (m *deviceManager) business(ctx context.Context, id string, body object) (any, error) {
	if _, err := m.controller(id); err != nil {
		return nil, err
	}
	request, err := decodeDeviceRequest(body, "INVALID_ARGUMENT: expected {version,tool,body,origin}")
	if err != nil {
		return nil, err
	}
	if source := text(request.Origin, "sourceId"); source != "" {
		reference := object{"sourceId": source, "sourceLabel": field(request.Origin, "sourceLabel"), "controlSource": field(request.Origin, "controlSource")}
		m.mu.Lock()
		stored := m.stored
		current, known := stored.UpstreamSources[source]
		if stored.Controller == nil || stored.Controller.DeviceID != id {
			m.mu.Unlock()
			return nil, errors.New("DEVICE_UNPAIRED: Pair and approve this controller locally; read cli guide.")
		}
		if (known || len(stored.UpstreamSources) < 128) && wire(current) != wire(reference) {
			stored.UpstreamSources = maps.Clone(stored.UpstreamSources)
			stored.UpstreamSources[source] = reference
			err = m.persist(stored)
		}
		m.mu.Unlock()
		if err != nil {
			return nil, err
		}
	}
	return m.control(ctx, id, body)
}

func (m *deviceManager) pair(ctx context.Context, offer deviceOffer) (object, error) {
	identity, err := m.currentIdentity()
	if err != nil {
		return nil, err
	}
	if identity.id == offer.DeviceID {
		return nil, errors.New("DEVICE_PAIRING_INVALID: Pair a different device; read cli guide.")
	}
	sockets, err := m.dialAddresses(offer.Addresses)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	if controller := m.stored.Controller; controller != nil && controller.DeviceID == offer.DeviceID {
		m.mu.Unlock()
		return nil, errors.New("DEVICE_PEER_FORBIDDEN: Pairing would create a controller/member cycle. Revoke the ancestor relationship locally; query guide with topic:device.")
	}
	if !m.enabled || m.identity != identity {
		m.mu.Unlock()
		return nil, errors.New("DEVICE_UNPAIRED: Pairing was disabled or revoked; read cli guide.")
	}
	epoch, name := m.epoch, m.name()
	wait, cancel := context.WithCancelCause(ctx)
	attempt := &devicePairingAttempt{cancel}
	if m.pairing != nil {
		m.pairing.cancel(errors.New("DEVICE_PAIRING_CANCELLED: Pairing was cancelled. Start a new attempt to pair the device."))
	}
	m.pairing = attempt
	m.mu.Unlock()
	defer cancel(nil)
	defer func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.pairing == attempt {
			m.pairing = nil
		}
	}()
	var session deviceSession
	defer session.close()
	channel, err := session.connect(wait, identity, offer.DeviceID, sockets)
	if context.Cause(wait) != nil {
		return nil, context.Cause(wait)
	}
	if err != nil {
		return nil, err
	}
	response, err := channel.request(wait, deviceReadPath+"pair", object{"version": deviceProtocolVersion, "secret": offer.Secret, "name": name}, deviceOfferTTL)
	if context.Cause(wait) != nil {
		return nil, context.Cause(wait)
	}
	if err != nil {
		return nil, err
	}
	member := devicePeer{}
	if field(response, "member") == nil || canonjson.Unmarshal([]byte(wire(field(response, "member"))), &member) != nil ||
		member.DeviceID == "" || member.PublicKey == "" || member.Name == "" || member.Addresses == nil {
		return nil, errors.New("DEVICE_PAIRING_INVALID: Member approval response is invalid; read cli guide.")
	}
	key, err := base64.StdEncoding.Strict().DecodeString(member.PublicKey)
	if err != nil {
		return nil, err
	}
	if uintOr(field(response, "version"), 0) != deviceProtocolVersion || member.DeviceID != offer.DeviceID || hash(key) != offer.DeviceID {
		return nil, errors.New("DEVICE_PAIRING_INVALID: Member approval does not match the pinned key; read cli guide.")
	}
	m.configuration.Lock()
	defer m.configuration.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.enabled || m.epoch != epoch || m.pairing != attempt {
		return nil, errors.New("DEVICE_UNPAIRED: Pairing was disabled or revoked; read cli guide.")
	}
	stored := m.stored
	stored.Members = maps.Clone(stored.Members)
	stored.Members[member.DeviceID] = member
	if err := m.persist(stored); err != nil {
		return nil, err
	}
	return object{"paired": true, "deviceId": member.DeviceID, "name": member.Name, "addresses": member.Addresses, "protocolVersion": deviceProtocolVersion}, nil
}
