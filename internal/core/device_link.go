package core

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

const deviceUnavailableMessage = "OP_UNAVAILABLE: Enable the device-link preference locally; read cli guide for Device link commands."

type deviceOffer struct {
	Version   uint16   `json:"version"`
	DeviceID  string   `json:"deviceId"`
	Addresses []string `json:"addresses"`
	TunnelURL *string  `json:"tunnelUrl"`
	Secret    string   `json:"secret"`
}

func (offer deviceOffer) encode() string {
	return "arc-device:3:" + base64.RawURLEncoding.EncodeToString([]byte(wire(offer)))
}

func decodeDeviceOffer(raw string, allow func(netip.Addr) bool) (deviceOffer, error) {
	invalid := errors.New("DEVICE_PAIRING_INVALID: Use a fresh member-local device offer.")
	mismatch := errors.New("DEVICE_PROTOCOL_MISMATCH: Use peer protocol version 3 on both devices; read cli guide.")
	offer := deviceOffer{}
	if len(raw) > 16384 {
		return offer, invalid
	}
	separate := strings.LastIndexByte(raw, ':')
	if separate < 0 {
		return offer, invalid
	}
	if raw[:separate] != "arc-device:3" {
		return offer, mismatch
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(raw[separate+1:])
	if err != nil || strings.ContainsAny(raw, "\r\n") || decodeDeviceStrict(data, &offer) != nil {
		return offer, invalid
	}
	fields := object{}
	if decodeObject(data, &fields) != nil || fields["version"] == nil {
		return offer, invalid
	}
	if offer.Version != deviceProtocolVersion {
		return offer, mismatch
	}
	if offer.TunnelURL != nil && peerURL(*offer.TunnelURL) == "" {
		return offer, invalid
	}
	fingerprint, err := hex.DecodeString(offer.DeviceID)
	if err != nil || len(fingerprint) != 32 || len(offer.Secret) != 64 || len(offer.Addresses) == 0 || len(offer.Addresses) > 64 {
		return offer, invalid
	}
	for _, candidate := range offer.Addresses {
		address, err := netip.ParseAddrPort(candidate)
		if err != nil || !allow(address.Addr()) || address.Port() == 0 {
			return offer, invalid
		}
		if zone := address.Addr().Zone(); zone != "" {
			if _, err := strconv.ParseUint(zone, 10, 32); err != nil {
				return offer, invalid
			}
		}
	}
	return offer, nil
}

func decodeDeviceStrict(data []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("invalid JSON")
	}
	return nil
}

type devicePeer struct {
	DeviceID        string   `json:"deviceId"`
	PublicKey       string   `json:"publicKey"`
	Name            string   `json:"name"`
	Addresses       []string `json:"addresses"`
	TunnelURL       *string  `json:"tunnelUrl"`
	AddressOverride *string  `json:"addressOverride"`
}

func (peer devicePeer) projection() object {
	return object{"deviceId": peer.DeviceID, "name": peer.Name, "addresses": peer.Addresses, "tunnelUrl": peer.TunnelURL, "addressOverride": peer.AddressOverride}
}

type deviceStored struct {
	IdentityID          *string               `json:"identityId"`
	Port                uint16                `json:"port"`
	Name                *string               `json:"name"`
	Controller          *devicePeer           `json:"controller"`
	Members             map[string]devicePeer `json:"members"`
	ShowUpstreamSources bool                  `json:"showUpstreamSources"`
	UpstreamSources     map[string]object     `json:"upstreamSources"`
}

func loadDeviceStored(directory string) (deviceStored, error) {
	state := deviceStored{Port: deviceDefaultPort, Members: make(map[string]devicePeer), UpstreamSources: make(map[string]object)}
	data, err := os.ReadFile(filepath.Join(directory, "peers.json"))
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if err := canonjson.Unmarshal(data, &state); err != nil {
		return state, err
	}
	if state.Port == 0 || state.Members == nil || state.UpstreamSources == nil {
		return state, errors.New("invalid device pairing state")
	}
	return state, nil
}

type devicePending struct {
	peer     devicePeer
	expires  time.Time
	ctx      context.Context
	decision chan deviceDecision
}
type deviceDecision struct {
	result object
	err    error
}
type devicePairingAttempt struct {
	cancel context.CancelCauseFunc
}

type deviceManager struct {
	directory     string
	lifetime      context.Context
	configuration sync.Mutex
	mu            sync.Mutex
	enabled       bool
	identity      *deviceIdentity
	stored        deviceStored
	offerHash     string
	offerExpiry   time.Time
	pending       *devicePending
	pairing       *devicePairingAttempt
	runtime       *devicePeerRuntime
	epoch         uint64
	authority     func(context.Context, string, object) (any, error)
	control       func(context.Context, string, object) (any, error)
	bindings      func(uint16) ([]deviceLANBinding, error)
	allow         func(netip.Addr) bool
	dialAddresses func([]string) ([]netip.AddrPort, error)
	discovery     func(*deviceIdentity, uint16, []deviceLANBinding) (func(), error)
	tunnelURL     func() *string
}

func newDeviceManager(ctx context.Context, directory string) (*deviceManager, error) {
	stored, err := loadDeviceStored(directory)
	if err != nil {
		return nil, err
	}
	return &deviceManager{directory: directory, lifetime: ctx, stored: stored,
		bindings: deviceLANBindings, allow: deviceLANAddress, dialAddresses: deviceConnectAddresses,
		discovery: advertiseDeviceDNS,
	}, nil
}

func (m *deviceManager) persist(stored deviceStored) error {
	// Rust persists via serde_json::to_value, which sorts every object.
	var value any
	if err := canonjson.Unmarshal([]byte(wire(stored)), &value); err != nil {
		return err
	}
	if err := save(filepath.Join(m.directory, "peers.json"), value); err != nil {
		return err
	}
	m.stored = stored
	return nil
}

func (m *deviceManager) currentIdentity() (*deviceIdentity, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.enabled || m.identity == nil {
		return nil, errors.New(deviceUnavailableMessage)
	}
	return m.identity, nil
}

func (m *deviceManager) acceptCertificate(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.enabled {
		return false
	}
	if _, member := m.stored.Members[id]; member {
		return false
	}
	if controller := m.stored.Controller; controller != nil {
		return controller.DeviceID == id
	}
	return m.offerExpiry.After(time.Now())
}

func (m *deviceManager) controller(id string) (devicePeer, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.enabled {
		return devicePeer{}, errors.New(deviceUnavailableMessage)
	}
	if controller := m.stored.Controller; controller != nil && controller.DeviceID == id {
		return *controller, nil
	}
	return devicePeer{}, errors.New("DEVICE_UNPAIRED: Pair and approve this controller locally; read cli guide.")
}

func (m *deviceManager) name() string {
	if m.stored.Name != nil {
		return *m.stored.Name
	}
	return "ARC device"
}

func (m *deviceManager) addresses(port uint16) ([]string, error) {
	bindings, err := m.bindings(port)
	if err != nil {
		return nil, err
	}
	addresses := make([]netip.AddrPort, 0, len(bindings))
	for _, binding := range bindings {
		addresses = append(addresses, netip.AddrPortFrom(binding.addr.Addr().WithZone(""), binding.addr.Port()))
	}
	result := make([]string, 0, len(addresses))
	for _, address := range deviceSortSockets(addresses) {
		result = append(result, address.String())
	}
	return result, nil
}

func (m *deviceManager) reconcile(enabled bool) error {
	m.configuration.Lock()
	defer m.configuration.Unlock()
	return m.reconcileLocked(enabled)
}

func (m *deviceManager) reconcileLocked(enabled bool) error {
	m.mu.Lock()
	old := m.cancelConnectionsLocked()
	m.runtime, m.pending, m.offerHash, m.offerExpiry = nil, nil, "", time.Time{}
	m.enabled = enabled
	m.mu.Unlock()
	if old != nil {
		old.close()
	}
	if !enabled {
		return nil
	}
	identity, err := loadDeviceIdentity(m.directory)
	if err != nil {
		return err
	}
	m.mu.Lock()
	stored := m.stored
	if stored.IdentityID != nil && *stored.IdentityID != identity.id {
		stored.Controller, stored.Members, stored.UpstreamSources = nil, make(map[string]devicePeer), make(map[string]object)
	}
	stored.IdentityID = &identity.id
	if err := m.persist(stored); err != nil {
		m.mu.Unlock()
		return err
	}
	m.identity = identity
	m.mu.Unlock()
	runtime, err := m.startPeerRuntime(identity, stored.Port)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.runtime = runtime
	m.mu.Unlock()
	return nil
}

func (m *deviceManager) cancelConnectionsLocked() *devicePeerRuntime {
	m.epoch++
	if pending := m.pending; pending != nil {
		pending.decision <- deviceDecision{err: errors.New("DEVICE_PAIRING_DECLINED: Create a fresh member-local offer after local approval is available.")}
		m.pending = nil
	}
	if m.pairing != nil {
		m.pairing.cancel(errors.New("DEVICE_UNPAIRED: Local pairing was revoked or disabled; read cli guide."))
		m.pairing = nil
	}
	return m.runtime
}

func validDeviceName(name string) bool {
	return len(name) > 0 && len(name) <= 120 && !strings.ContainsFunc(name, unicode.IsControl)
}

func (m *deviceManager) publicPeerURL() *string {
	if m.tunnelURL != nil {
		return m.tunnelURL()
	}
	return nil
}

func (m *deviceManager) offer() (object, error) {
	m.configuration.Lock()
	defer m.configuration.Unlock()
	identity, err := m.currentIdentity()
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	port := m.stored.Port
	m.mu.Unlock()
	addresses, err := m.addresses(port)
	if err != nil {
		return nil, err
	}
	if len(addresses) == 0 {
		return nil, errors.New("DEVICE_LAN_UNAVAILABLE: Connect a private LAN interface and retry device offer.")
	}
	tunnel := m.publicPeerURL()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stored.Controller != nil {
		return nil, errors.New("DEVICE_CONTROLLER_EXISTS: Revoke the existing controller locally before offering again.")
	}
	if m.pending != nil && m.pending.expires.After(time.Now()) {
		return nil, errors.New("DEVICE_PAIRING_PENDING: Read device pending, then approve or decline locally.")
	}
	var secret [32]byte
	rand.Read(secret[:])
	code := hex.EncodeToString(secret[:])
	m.offerHash, m.offerExpiry = hash([]byte(code)), time.Now().Add(deviceOfferTTL)
	offer := deviceOffer{deviceProtocolVersion, identity.id, addresses, tunnel, code}
	return object{"pairingString": offer.encode(), "deviceId": identity.id, "protocolVersion": deviceProtocolVersion, "expiresInSeconds": 600}, nil
}

var deviceOfferExpired = errors.New("DEVICE_OFFER_EXPIRED: Create a fresh member-local device offer.")

func (m *deviceManager) prove(ctx context.Context, id, key string, body object) (object, error) {
	if err := m.rejectCycle(ctx, id); err != nil {
		return nil, err
	}
	m.mu.Lock()
	if !m.enabled {
		m.mu.Unlock()
		return nil, errors.New(deviceUnavailableMessage)
	}
	if m.stored.Controller != nil {
		m.mu.Unlock()
		return nil, errors.New("DEVICE_CONTROLLER_EXISTS: Revoke the existing controller locally first.")
	}
	if _, member := m.stored.Members[id]; member {
		m.mu.Unlock()
		return nil, errors.New("DEVICE_PEER_FORBIDDEN: A member cannot control its controller. Read cli guide.")
	}
	if !m.offerExpiry.After(time.Now()) {
		m.offerHash, m.offerExpiry = "", time.Time{}
		m.mu.Unlock()
		return nil, deviceOfferExpired
	}
	if !secureToken(hash([]byte(text(body, "secret"))), m.offerHash) {
		m.mu.Unlock()
		return nil, errors.New("DEVICE_PAIRING_SECRET: Use the current member offer; read cli guide.")
	}
	name := text(body, "name")
	if !validDeviceName(name) {
		m.mu.Unlock()
		return nil, errors.New("INVALID_ARGUMENT: name must be a label of 1..120 bytes")
	}
	wait, cancel := context.WithDeadline(ctx, m.offerExpiry)
	pending := &devicePending{devicePeer{DeviceID: id, PublicKey: key, Name: name, Addresses: []string{}}, m.offerExpiry, wait, make(chan deviceDecision, 1)}
	m.pending, m.offerHash, m.offerExpiry = pending, "", time.Time{}
	m.mu.Unlock()
	defer cancel()
	defer func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.pending == pending {
			m.pending = nil
		}
	}()
	select {
	case <-wait.Done():
		return nil, deviceOfferExpired
	case decision := <-pending.decision:
		return decision.result, decision.err
	}
}

func (m *deviceManager) decide(ctx context.Context, approve bool) (result object, err error) {
	m.configuration.Lock()
	defer m.configuration.Unlock()
	m.mu.Lock()
	pending := m.pending
	m.pending = nil
	identity, port, name := m.identity, m.stored.Port, m.name()
	m.mu.Unlock()
	if pending == nil {
		return nil, errors.New("DEVICE_PAIRING_MISSING: Read device pending after the controller proves an offer.")
	}
	if pending.ctx.Err() != nil || !pending.expires.After(time.Now()) {
		return nil, deviceOfferExpired
	}
	if !approve {
		pending.decision <- deviceDecision{err: errors.New("DEVICE_PAIRING_DECLINED: The member declined. Create a new offer to try again.")}
		return object{"declined": true, "deviceId": pending.peer.DeviceID}, nil
	}
	defer func() {
		if err != nil {
			pending.decision <- deviceDecision{err: err}
		}
	}()
	ctx, cancel := context.WithDeadline(ctx, pending.expires)
	defer cancel()
	peer := pending.peer
	if err = m.rejectCycle(ctx, peer.DeviceID); err != nil {
		return nil, err
	}
	addresses, err := m.addresses(port)
	if err != nil {
		return nil, err
	}
	if pending.ctx.Err() != nil {
		return nil, deviceOfferExpired
	}
	member := devicePeer{DeviceID: identity.id, PublicKey: identity.publicKey, Name: name, Addresses: addresses, TunnelURL: m.publicPeerURL()}
	if _, err = m.authority(ctx, "peer_connect", object{"deviceId": peer.DeviceID, "publicKey": peer.PublicKey, "name": peer.Name}); err != nil {
		return nil, err
	}
	m.mu.Lock()
	stored := m.stored
	stored.Controller = &peer
	err = m.persist(stored)
	m.mu.Unlock()
	if err != nil {
		return nil, err
	}
	pending.decision <- deviceDecision{result: object{"paired": true, "version": deviceProtocolVersion, "member": member}}
	return object{"approved": true, "deviceId": peer.DeviceID, "name": peer.Name}, nil
}

func (m *deviceManager) revoke(ctx context.Context, id string) (object, error) {
	m.configuration.Lock()
	defer m.configuration.Unlock()
	m.mu.Lock()
	stored := m.stored
	controller := stored.Controller != nil && stored.Controller.DeviceID == id
	if controller {
		stored.Controller, stored.UpstreamSources = nil, make(map[string]object)
	} else if _, member := stored.Members[id]; member {
		stored.Members = maps.Clone(stored.Members)
		delete(stored.Members, id)
	} else {
		m.mu.Unlock()
		return nil, errors.New("DEVICE_UNPAIRED: Use the paired device ID; read cli guide.")
	}
	runtime := m.cancelConnectionsLocked()
	err := m.persist(stored)
	m.mu.Unlock()
	if runtime != nil {
		runtime.listener.closeConnections()
	}
	if err != nil {
		return nil, err
	}
	if controller {
		if _, err := m.authority(ctx, "peer_revoke", object{"deviceId": id}); err != nil {
			return nil, err
		}
	}
	return object{"revoked": true, "deviceId": id}, nil
}

func (m *deviceManager) configure(body object) (object, error) {
	m.configuration.Lock()
	defer m.configuration.Unlock()
	m.mu.Lock()
	stored := m.stored
	if raw, present := body["showUpstreamSources"]; present {
		show, ok := raw.(bool)
		if !ok {
			m.mu.Unlock()
			return nil, errors.New("INVALID_ARGUMENT: showUpstreamSources must be a boolean")
		}
		stored.ShowUpstreamSources = show
	}
	if raw, present := body["port"]; present {
		port := uintOr(raw, 0)
		if port == 0 || port > 65535 {
			m.mu.Unlock()
			return nil, errors.New("INVALID_ARGUMENT: port must be 1..65535")
		}
		stored.Port = uint16(port)
	}
	if raw, present := body["name"]; present {
		name := str(raw)
		if !validDeviceName(name) {
			m.mu.Unlock()
			return nil, errors.New("INVALID_ARGUMENT: name must be a label of 1..120 bytes")
		}
		stored.Name = &name
	}
	err := m.persist(stored)
	m.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if err := m.reconcileLocked(true); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return object{"deviceId": m.identity.id, "port": m.stored.Port, "name": m.name(), "showUpstreamSources": m.stored.ShowUpstreamSources}, nil
}

func (m *deviceManager) pendingProjection(snapshot bool) any {
	pending := m.pending
	if pending == nil || pending.ctx.Err() != nil || !pending.expires.After(time.Now()) {
		return nil
	}
	result := object{"deviceId": pending.peer.DeviceID, "name": pending.peer.Name}
	if snapshot {
		result["expiresInSeconds"] = int64(time.Until(pending.expires) / time.Second)
	} else {
		result["publicKey"] = pending.peer.PublicKey
	}
	return result
}

func (m *deviceManager) snapshot() object {
	m.mu.Lock()
	defer m.mu.Unlock()
	var controller, expires any
	if p := m.stored.Controller; p != nil {
		row := p.projection()
		row["showUpstreamSources"] = m.stored.ShowUpstreamSources
		sources := []object{}
		if m.stored.ShowUpstreamSources {
			for _, name := range slices.Sorted(maps.Keys(m.stored.UpstreamSources)) {
				sources = append(sources, m.stored.UpstreamSources[name])
			}
		}
		row["upstreamSources"] = sources
		controller = row
	}
	members := []object{}
	for _, name := range slices.Sorted(maps.Keys(m.stored.Members)) {
		members = append(members, m.stored.Members[name].projection())
	}
	if !m.offerExpiry.IsZero() {
		expires = int64(max(0, time.Until(m.offerExpiry)/time.Second))
	}
	return object{"deviceId": m.identity.id, "name": m.name(), "controller": controller,
		"members": members, "offerExpiresInSeconds": expires, "pending": m.pendingProjection(true)}
}

func deviceSelectMember(members map[string]devicePeer, selector string) (devicePeer, error) {
	var found devicePeer
	var count int
	for id, peer := range members {
		if id == selector || peer.Name == selector {
			found, count = peer, count+1
		}
	}
	if count != 1 {
		return devicePeer{}, errors.New("DEVICE_UNKNOWN: Use a device ID or unique paired member name; query devices with all:true.")
	}
	return found, nil
}

func (m *deviceManager) address(body object) (object, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	peer, err := deviceSelectMember(m.stored.Members, text(body, "device"))
	if err != nil {
		return nil, err
	}
	var override *string
	if body["address"] != nil {
		address := text(body, "address")
		_, port, err := net.SplitHostPort(address)
		portNumber, portErr := strconv.ParseUint(port, 10, 16)
		u, urlErr := url.Parse("https://" + address)
		if err != nil || portErr != nil || portNumber == 0 || urlErr != nil ||
			!ingressURLAllowed(u, "https", "/") || strings.ContainsAny(address, "/#?") {
			return nil, errors.New("INVALID_ARGUMENT: address must be host:port")
		}
		override = &address
	}
	stored := m.stored
	stored.Members = maps.Clone(stored.Members)
	peer.AddressOverride = override
	stored.Members[peer.DeviceID] = peer
	if err := m.persist(stored); err != nil {
		return nil, err
	}
	return object{"deviceId": peer.DeviceID, "address": override}, nil
}

func (m *deviceManager) dispatch(ctx context.Context, action string, body object) (any, error) {
	if _, err := m.currentIdentity(); err != nil {
		return nil, err
	}
	switch action {
	case "snapshot":
		return m.snapshot(), nil
	case "offer":
		return m.offer()
	case "pending":
		m.mu.Lock()
		defer m.mu.Unlock()
		return object{"pending": m.pendingProjection(false)}, nil
	case "approve", "decline":
		return m.decide(ctx, action == "approve")
	case "pair":
		offer, err := decodeDeviceOffer(text(body, "pairingString"), m.allow)
		if err != nil {
			return nil, err
		}
		return m.pair(ctx, offer)
	case "cancel-pair":
		m.mu.Lock()
		if m.pairing != nil {
			m.pairing.cancel(errors.New("DEVICE_PAIRING_CANCELLED: Pairing was cancelled. Start a new attempt to pair the device."))
			m.pairing = nil
		}
		m.mu.Unlock()
		return object{"cancelled": true}, nil
	case "address":
		return m.address(body)
	case "revoke":
		return m.revoke(ctx, text(body, "deviceId"))
	case "configure":
		return m.configure(body)
	default:
		return nil, errors.New("UNKNOWN_OPERATION: Read cli guide for Device link commands.")
	}
}

func peerURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil ||
		u.RawQuery != "" || u.ForceQuery || strings.Contains(raw, "#") || !strings.HasSuffix(u.EscapedPath(), "/arc-peer/3") {
		return ""
	}
	return u.String()
}

var deviceGateways sync.Map // *gatewayOwner -> *deviceManager

func startDeviceGateway(ctx context.Context, owner *gatewayOwner) error {
	m, err := newDeviceManager(ctx, filepath.Join(root(), "device-link"))
	if err != nil {
		return err
	}
	m.authority = func(ctx context.Context, op string, body object) (any, error) {
		return requestSourceAuthority(ctx, owner.bridge, op, body)
	}
	m.control = func(ctx context.Context, id string, body object) (any, error) {
		auth := object{"Peer": privatePeerAuthority{DeviceID: id}}
		return owner.bridge.call(ctx, newPrivateRequest(ctx, "PeerControl", auth, body))
	}
	deviceGateways.Store(owner, m)
	owner.cleanup = append(owner.cleanup, func() {
		deviceGateways.Delete(owner)
		_ = m.reconcile(false)
	})
	return nil
}

func deviceEnabled() bool { return readPreferences()["device-link"] == "on" }

func init() {
	gatewayStartup = append(gatewayStartup, startDeviceGateway)
	registerGatewayRoute(http.MethodPost, `_peer_reconcile`, func(_ context.Context, g *gatewayOwner, _ object, _ []string) (any, error) {
		if runtimeFixture {
			return object{"ok": true}, nil
		}
		instance, ok := deviceGateways.Load(g)
		if !ok {
			return nil, errors.New(deviceUnavailableMessage)
		}
		return object{"ok": true}, instance.(*deviceManager).reconcile(deviceEnabled())
	})
	registerGatewayRoute(http.MethodPost, `device/(snapshot|offer|pending|approve|decline|pair|cancel-pair|revoke|configure|address)`,
		func(ctx context.Context, g *gatewayOwner, body object, params []string) (any, error) {
			instance, ok := deviceGateways.Load(g)
			if !ok {
				return nil, errors.New(deviceUnavailableMessage)
			}
			return instance.(*deviceManager).dispatch(ctx, params[0], body)
		})
}
