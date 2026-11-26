package core

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"maps"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

const deviceTunnelRequestCap = 1024 * 1024
const deviceTunnelResponseCap = 4 * 1024 * 1024
const deviceTunnelDeadline = 25 * time.Second
const deviceTunnelWait = 15000
const deviceTunnelAuthCap = 32
const deviceChallengeTTL = 30 * time.Second
const deviceSessionTTL = 300 * time.Second

var deviceTunnelAuthError = errors.New("DEVICE_TUNNEL_AUTH: Request a fresh peer challenge and sign it with the paired device key; query guide for device.")
var deviceTunnelRevoked = errors.New("DEVICE_UNPAIRED: Peer was revoked or disabled; query guide for device.")

type deviceTunnelAuthorization struct {
	device  string
	expires time.Time
}
type deviceTunnelState struct {
	challenges map[string]deviceTunnelAuthorization
	tokens     map[string]deviceTunnelAuthorization
}

func deviceTunnelTranscript(member, controller, challenge string) string {
	return "arc-peer/3/session:" + member + ":" + controller + ":" + challenge
}

func deviceTunnelRandom() string {
	var b [32]byte
	rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func (m *deviceManager) tunnelChallenge(device string) (object, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.enabled || m.stored.Controller == nil || m.stored.Controller.DeviceID != device {
		return nil, deviceTunnelAuthError
	}
	now := time.Now()
	maps.DeleteFunc(m.tunnelState.challenges, func(_ string, entry deviceTunnelAuthorization) bool { return !entry.expires.After(now) })
	if len(m.tunnelState.challenges) >= deviceTunnelAuthCap {
		return nil, errors.New("DEVICE_BUSY: Peer challenge capacity reached; wait 30 seconds and retry.")
	}
	challenge := deviceTunnelRandom()
	m.tunnelState.challenges[challenge] = deviceTunnelAuthorization{device, now.Add(deviceChallengeTTL)}
	return object{"version": deviceProtocolVersion, "deviceId": m.identity.id, "challenge": challenge, "expiresInSeconds": 30}, nil
}

func (m *deviceManager) tunnelAuthenticate(body object) (object, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	device := text(body, "deviceId")
	peer := m.stored.Controller
	if !m.enabled || peer == nil || peer.DeviceID != device {
		return nil, deviceTunnelAuthError
	}
	nonce := text(body, "challenge")
	challenge, ok := m.tunnelState.challenges[nonce]
	delete(m.tunnelState.challenges, nonce)
	now := time.Now()
	if !ok || challenge.device != device || !challenge.expires.After(now) {
		return nil, deviceTunnelAuthError
	}
	der, err := base64.StdEncoding.Strict().DecodeString(peer.PublicKey)
	if err != nil {
		return nil, deviceTunnelAuthError
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	key, ok := parsed.(*ecdsa.PublicKey)
	if err != nil || !ok || key.Curve.Params().Name != "P-256" {
		return nil, deviceTunnelAuthError
	}
	sig, err := base64.StdEncoding.Strict().DecodeString(text(body, "signature"))
	digest := sha256.Sum256([]byte(deviceTunnelTranscript(m.identity.id, device, nonce)))
	if err != nil || !ecdsa.VerifyASN1(key, digest[:], sig) {
		return nil, deviceTunnelAuthError
	}
	maps.DeleteFunc(m.tunnelState.tokens, func(_ string, entry deviceTunnelAuthorization) bool { return !entry.expires.After(now) })
	if len(m.tunnelState.tokens) >= deviceTunnelAuthCap {
		return nil, errors.New("DEVICE_BUSY: Peer session capacity reached; wait for a session to expire.")
	}
	token := deviceTunnelRandom()
	m.tunnelState.tokens[token] = deviceTunnelAuthorization{device, now.Add(deviceSessionTTL)}
	return object{"version": deviceProtocolVersion, "token": token, "expiresInSeconds": 300}, nil
}

func (m *deviceManager) tunnelDevice(token string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	auth, ok := m.tunnelState.tokens[token]
	if !ok || !auth.expires.After(time.Now()) || !m.enabled || m.stored.Controller == nil || m.stored.Controller.DeviceID != auth.device {
		return "", deviceTunnelAuthError
	}
	return auth.device, nil
}

func (m *deviceManager) tunnelContext(ctx context.Context) (context.Context, func()) {
	m.mu.Lock()
	epoch := m.tunnelContextEpoch
	m.mu.Unlock()
	wait, cancel := context.WithCancel(ctx)
	if epoch.Err() != nil {
		cancel()
	}
	stop := context.AfterFunc(epoch, cancel)
	return wait, func() { stop(); cancel() }
}

func deviceTuneForTunnel(body object) {
	args := obj(body["args"])
	if args == nil {
		return
	}
	if ms, ok := uintValue(args["waitMs"]); ok && ms > deviceTunnelWait {
		args["waitMs"] = deviceTunnelWait
	}
	if strings.HasSuffix(text(body, "op"), "_wait") {
		if ms, ok := uintValue(args["timeoutMs"]); args["timeoutMs"] == nil || ok && ms > deviceTunnelWait {
			args["timeoutMs"] = deviceTunnelWait
		}
	}
}

func deviceValidateTunnelWait(body object) error {
	request := body["body"]
	args := obj(field(request, "args"))
	if uintOr(args["waitMs"], 0) > deviceTunnelWait ||
		strings.HasSuffix(text(request, "op"), "_wait") && uintOr(args["timeoutMs"], 30000) > deviceTunnelWait {
		return errors.New("DEVICE_TUNNEL_LIMIT: Tunnel waits must use segments of at most 15000 ms; query guide for device.")
	}
	return nil
}

var deviceTunnelTransfer func(context.Context, *deviceManager, string, object) (any, error)

func (m *deviceManager) serveTunnel(w http.ResponseWriter, r *http.Request) (any, error) {
	started := time.Now()
	if _, err := m.currentIdentity(); err != nil {
		return nil, err
	}
	ctx, release := m.tunnelContext(r.Context())
	defer release()
	if ctx.Err() != nil {
		return nil, deviceTunnelRevoked
	}
	path := r.URL.EscapedPath()
	if !strings.HasPrefix(path, deviceReadPath) {
		return nil, errors.New("DEVICE_PROTOCOL_MISMATCH: Use peer protocol version 3 routes; query guide for device.")
	}
	if r.Method != http.MethodPost || r.URL.RawQuery != "" || r.URL.ForceQuery {
		return nil, errors.New("DEVICE_PEER_FORBIDDEN: Use POST peer routes; query guide for device.")
	}
	token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	var device string
	limit, timeout := int64(16384), 5*time.Second
	if !strings.HasSuffix(path, "/challenge") && !strings.HasSuffix(path, "/session") {
		var err error
		device, err = m.tunnelDevice(token)
		if err != nil {
			return nil, err
		}
		limit, timeout = deviceTunnelRequestCap, deviceTunnelDeadline
	}
	body, err := readDeviceTunnelBody(ctx, w, r, limit, started.Add(timeout))
	if err != nil {
		return nil, err
	}
	if uintOr(body["version"], 0) != deviceProtocolVersion {
		return nil, errors.New("DEVICE_PROTOCOL_MISMATCH: Use peer protocol version 3; query guide for device.")
	}
	switch path {
	case deviceReadPath + "challenge":
		return m.tunnelChallenge(text(body, "deviceId"))
	case deviceReadPath + "session":
		return m.tunnelAuthenticate(body)
	}
	if _, err := m.tunnelDevice(token); err != nil {
		return nil, err
	}
	child, cancel := context.WithDeadline(ctx, started.Add(deviceTunnelDeadline))
	defer cancel()
	var result any
	switch path {
	case deviceReadPath + "hello":
		result, err = m.hello()
	case deviceReadPath + "transfer/control":
		if deviceTunnelTransfer == nil {
			return nil, errors.New(PortPending)
		}
		result, err = deviceTunnelTransfer(child, m, device, body)
	case deviceReadPath + "request":
		if err := deviceValidateTunnelWait(body); err != nil {
			return nil, err
		}
		select {
		case m.tunnelSlots <- struct{}{}:
			defer func() { <-m.tunnelSlots }()
		default:
			return nil, errors.New("DEVICE_BUSY: Peer request capacity reached; wait for a request to finish.")
		}
		result, err = m.business(child, device, body)
	default:
		return nil, errors.New("DEVICE_PEER_FORBIDDEN: Use peer hello or request routes; query guide for device.")
	}
	switch {
	case ctx.Err() != nil:
		return nil, deviceTunnelRevoked
	case errors.Is(child.Err(), context.DeadlineExceeded):
		return nil, errors.New("DEVICE_RESPONSE_LOST: Peer deadline expired; retain write receipt IDs and query guide for device.")
	default:
		return result, err
	}
}

func readDeviceTunnelBody(ctx context.Context, w http.ResponseWriter, r *http.Request, limit int64, deadline time.Time) (object, error) {
	control := http.NewResponseController(w)
	stop := context.AfterFunc(ctx, func() { _ = control.SetReadDeadline(time.Now()) })
	defer func() {
		stop()
		_ = control.SetReadDeadline(time.Time{})
	}()
	limited := io.LimitReader(r.Body, limit+1)
	data := []byte{}
	var buf [32768]byte
	for {
		if ctx.Err() != nil {
			return nil, deviceTunnelRevoked
		}
		next := time.Now().Add(5 * time.Second)
		if deadline.Before(next) {
			next = deadline
		}
		_ = control.SetReadDeadline(next)
		n, err := limited.Read(buf[:])
		data = append(data, buf[:n]...)
		if ctx.Err() != nil {
			return nil, deviceTunnelRevoked
		}
		if err == io.EOF {
			break
		}
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			return nil, errors.New("DEVICE_TUNNEL_LIMIT: Peer body deadline expired; query guide for device.")
		}
		if err != nil || int64(len(data)) > limit {
			return nil, errors.New("DEVICE_TUNNEL_LIMIT: Peer body exceeds its byte cap; use LAN.")
		}
	}
	if int64(len(data)) > limit {
		return nil, errors.New("DEVICE_TUNNEL_LIMIT: Peer body exceeds its byte cap; use LAN.")
	}
	var value any
	if err := canonjson.Unmarshal(data, &value); err != nil {
		return nil, errors.New("INVALID_ARGUMENT: peer body must be JSON")
	}
	return obj(value), nil
}

type deviceTunnelClient struct {
	mu         sync.Mutex
	url, token string
	expires    time.Time
}

func (c *deviceTunnelClient) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.url, c.token, c.expires = "", "", time.Time{}
}

func (c *deviceTunnelClient) prepare(ctx context.Context, identity *deviceIdentity, member, url string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.url == url && c.expires.After(time.Now()) {
		return c.token, nil
	}
	challenge, err := devicePostTunnel(ctx, url, "challenge", "", object{"version": deviceProtocolVersion, "deviceId": identity.id}, 4*time.Second)
	if err != nil {
		return "", err
	}
	if uintOr(field(challenge, "version"), 0) != deviceProtocolVersion || field(challenge, "deviceId") != member {
		return "", errors.New("DEVICE_PROTOCOL_MISMATCH: Peer challenge identity or protocol differs; query guide for device.")
	}
	nonce := text(challenge, "challenge")
	if len(nonce) != 64 {
		return "", deviceTunnelAuthError
	}
	sig, err := identity.sign([]byte(deviceTunnelTranscript(member, identity.id, nonce)))
	if err != nil {
		return "", err
	}
	result, err := devicePostTunnel(ctx, url, "session", "", object{"version": deviceProtocolVersion, "deviceId": identity.id, "challenge": nonce, "signature": sig}, 4*time.Second)
	if err != nil {
		return "", err
	}
	token := text(result, "token")
	if uintOr(field(result, "version"), 0) != deviceProtocolVersion || len(token) != 64 {
		return "", deviceTunnelAuthError
	}
	c.url, c.token, c.expires = url, token, time.Now().Add(270*time.Second)
	return token, nil
}

var doDeviceTunnelRequest = (*http.Client).Do

func devicePostTunnel(ctx context.Context, url, route, token string, body object, bound time.Duration) (any, error) {
	raw := wire(body)
	if len(raw) > deviceTunnelRequestCap {
		return nil, errors.New("DEVICE_TUNNEL_LIMIT: Peer request exceeds 1 MiB; use LAN.")
	}
	ctx, cancel := context.WithTimeout(ctx, min(bound, deviceTunnelDeadline))
	defer cancel()
	transport := &http.Transport{DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
		Proxy: http.ProxyFromEnvironment, DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url+"/"+route, strings.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.GetBody = nil
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := doDeviceTunnelRequest(client, req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, errors.New("DEVICE_RESPONSE_LOST: HTTPS peer deadline expired; retain write receipt IDs and query devices.")
		}
		return nil, fmt.Errorf("DEVICE_TUNNEL_UNAVAILABLE: %v; query devices.", err)
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return nil, fmt.Errorf("DEVICE_TUNNEL_UNAVAILABLE: HTTPS status %s; query devices.", res.Status)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, deviceTunnelResponseCap+1))
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, errors.New("DEVICE_RESPONSE_LOST: HTTPS peer deadline expired; retain write receipt IDs and query devices.")
	}
	if err != nil {
		return nil, err
	}
	if len(data) > deviceTunnelResponseCap {
		return nil, errors.New("DEVICE_TUNNEL_LIMIT: Peer response exceeds 4 MiB; use LAN or a bounded read.")
	}
	var value any
	if err := canonjson.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	if field(value, "ok") != true {
		return nil, errors.New(wire(field(value, "error")))
	}
	return field(value, "result"), nil
}

func serveDeviceTunnelIngress(w http.ResponseWriter, r *http.Request, i *networkIngress) {
	var result any
	err := errors.New(deviceUnavailableMessage)
	if current, ok := deviceGateways.Load(i.owner); ok {
		result, err = current.(*deviceManager).serveTunnel(w, r)
	}
	errorValue := func(code, message string) object {
		return object{"ok": false, "error": object{"code": code, "message": message, "next": deviceGuideAction()}}
	}
	reply := object{"ok": true, "result": result}
	if err != nil {
		reply = errorValue(managementErrorCode(err.Error()), err.Error())
	}
	if len(wire(reply)) > deviceTunnelResponseCap {
		reply = errorValue("DEVICE_TUNNEL_LIMIT", "Peer response exceeds 4 MiB; use LAN or a bounded read.")
	}
	httpsIngressReply(w, http.StatusOK, reply)
}

func (m *deviceManager) discoverPublicPeerURL(g *gatewayOwner) *string {
	state, ok := networkGateways.Load(g)
	if !ok {
		return nil
	}
	for _, i := range state.(*ingressGateway).snapshot() {
		i.mu.RLock()
		running, retired, transport, raw := i.running, i.retired, i.entry["transport"], i.url
		i.mu.RUnlock()
		if !running || retired || transport != "https" && transport != "relay" {
			continue
		}
		if base, ok := strings.CutSuffix(raw, "/mcp"); ok {
			if address := peerURL(base + "/arc-peer/3"); address != "" {
				return &address
			}
		}
	}
	return nil
}

func init() { ingressPeerTunnelHTTP = serveDeviceTunnelIngress }
