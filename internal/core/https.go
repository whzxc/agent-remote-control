package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

type ingressConnKey struct{}

type ingressConn struct {
	net.Conn
	id      string
	onClose func()
}

func (c *ingressConn) Close() error {
	c.onClose()
	return c.Conn.Close()
}

type ingressListener struct {
	net.Listener
	slots   chan struct{}
	ingress *networkIngress
}

func (listener *ingressListener) Accept() (net.Conn, error) {
	for {
		conn, err := listener.Listener.Accept()
		if err != nil {
			return nil, err
		}
		connection := id()
		select {
		case listener.slots <- struct{}{}:
			return &ingressConn{Conn: conn, id: connection, onClose: sync.OnceFunc(func() { <-listener.slots })}, nil
		default:
			conn.Close()
			listener.ingress.observeConnection(connection, "capacity_rejected", "CONNECTION_LIMIT")
		}
	}
}

func listenHTTPSIngress(ingress *networkIngress, config object) (string, error) {
	address := netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), 0)
	port := uint16(uintOr(config["httpsPort"], 0))
	if config["httpsProvider"] == "cloudflare" && config["cloudflareMode"] == "named" {
		address = netip.AddrPortFrom(address.Addr(), port)
	} else if config["httpsProvider"] == "custom" {
		ip, err := netip.ParseAddr(text(config, "httpsHost"))
		if err != nil {
			return "", err
		}
		address = netip.AddrPortFrom(ip, port)
	}
	listener, err := net.Listen("tcp", address.String())
	if err != nil {
		return "", fmt.Errorf("Cannot listen on MCP address %s: %w", address, err)
	}
	localAddress := listener.Addr().String()
	server := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			connection, _ := r.Context().Value(ingressConnKey{}).(string)
			request := observeIngressRequest(ingress, connection, r)
			observed := &ingressObservedWriter{ResponseWriter: w, observation: request}
			defer observed.finish(r)
			serveHTTPSIngress(observed, r, ingress, localAddress, request)
		}),
		ReadHeaderTimeout: 10 * time.Second,
		ConnContext: func(ctx context.Context, c net.Conn) context.Context {
			return context.WithValue(ctx, ingressConnKey{}, c.(*ingressConn).id)
		},
	}
	server.SetKeepAlivesEnabled(false)
	ingress.mu.Lock()
	ingress.server = server
	ingress.mu.Unlock()
	go func() {
		err := server.Serve(&ingressListener{Listener: listener, slots: make(chan struct{}, 128), ingress: ingress})
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			ingress.mu.Lock()
			if ingress.server == server {
				ingress.running, ingress.url, ingress.failure = false, "", "The connection process exited. Reconnect."
			}
			ingress.mu.Unlock()
		}
	}()
	return localAddress, nil
}

func httpsIngressReply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Cache-Control", "no-store")
	if status == http.StatusMethodNotAllowed {
		w.Header().Set("Allow", http.MethodPost)
	}
	if value != nil {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(status)
	if value != nil {
		_, _ = io.WriteString(w, wire(value))
	}
}

func httpsIngressError(w http.ResponseWriter, status int, message string) {
	httpsIngressReply(w, status, object{"error": message})
}

// Browser reads belong to A. OAuth routing and grant validation belong to D.
var ingressBrowserHTTP func(http.ResponseWriter, *http.Request, *networkIngress, string)
var ingressOAuthHTTP func(http.ResponseWriter, *http.Request, *networkIngress, string, *ingressObservation)
var ingressOAuthAuthenticate func(*networkIngress, string, string) object
var ingressOAuthValidate func(context.Context, string, object, string) error
var ingressPeerTunnelHTTP func(http.ResponseWriter, *http.Request, *networkIngress)

func ingressAllowsHeader(entry object, header string) bool {
	switch entry["auth"] {
	case "none":
		return true
	case "bearer":
		token := text(entry, "bearerToken")
		return token != "" && secureToken(hash([]byte(header)), hash([]byte("Bearer "+token)))
	default:
		return false
	}
}

func serveHTTPSIngress(w http.ResponseWriter, r *http.Request, i *networkIngress, local string, trace *ingressObservation) {
	i.mu.RLock()
	entry, resource, running, retired := i.entry, i.url, i.running, i.retired
	i.mu.RUnlock()
	path := r.URL.EscapedPath()
	if strings.HasPrefix(path, "/arc-peer/") {
		if !running || entry["transport"] != "https" && entry["transport"] != "relay" {
			httpsIngressReply(w, http.StatusServiceUnavailable, object{"ok": false, "error": object{
				"code": "DEVICE_TUNNEL_UNAVAILABLE", "message": "HTTPS ingress is stopped; query devices.",
				"next": object{"via": "query", "op": "guide", "args": object{"op": "device"}},
			}})
			return
		}
		if ingressPeerTunnelHTTP == nil {
			httpsIngressReply(w, http.StatusOK, object{"ok": false, "error": object{
				"code": "OP_UNAVAILABLE", "message": "OP_UNAVAILABLE: Enable the device-link preference locally; read cli guide for Device link commands.",
				"next": object{"via": "query", "op": "guide", "args": object{"op": "device"}},
			}})
			return
		}
		ingressPeerTunnelHTTP(w, r, i)
		return
	}
	discovery := strings.HasPrefix(path, "/.well-known/") || strings.HasPrefix(path, "/oauth/")
	if path != "/mcp" && !discovery {
		if ingressBrowserHTTP != nil {
			ingressBrowserHTTP(w, r, i, local)
		} else {
			httpsIngressReply(w, http.StatusNotFound, nil)
		}
		return
	}
	u, err := url.Parse(resource)
	if err != nil || !u.IsAbs() || u.Host == "" {
		httpsIngressError(w, http.StatusServiceUnavailable, "tunnel starting")
		return
	}
	origin := ingressURLOrigin(u)
	host := strings.TrimPrefix(origin, "https://")
	if r.Host != host && r.Host != host+":443" && r.Host != local {
		httpsIngressError(w, http.StatusForbidden, "invalid host")
		return
	}
	oauth := entry["auth"] == "oauth"
	if oauth && discovery {
		if !running {
			httpsIngressError(w, http.StatusServiceUnavailable, "connector stopped")
		} else if ingressOAuthHTTP == nil {
			httpsIngressError(w, http.StatusServiceUnavailable, PortPending)
		} else {
			ingressOAuthHTTP(w, r, i, resource, trace)
		}
		return
	}
	if path != "/mcp" || r.URL.RawQuery != "" || r.URL.ForceQuery {
		httpsIngressError(w, http.StatusNotFound, "not found")
		return
	}
	unauthorized := func() {
		header := "Bearer"
		if oauth {
			header = fmt.Sprintf(`Bearer resource_metadata="%s/.well-known/oauth-protected-resource%s", scope="mcp"`, origin, u.Path)
		}
		w.Header().Set("WWW-Authenticate", header)
		httpsIngressError(w, http.StatusUnauthorized, "unauthorized")
	}
	header := r.Header.Get("Authorization")
	var principal object
	if !retired && ingressAllowsHeader(entry, header) {
		principal = object{"type": "ingress", "ingressId": i.id}
	} else if !retired && oauth && ingressOAuthAuthenticate != nil {
		principal = ingressOAuthAuthenticate(i, header, resource)
	}
	if principal == nil {
		unauthorized()
		return
	}
	trace.authenticated(principal)
	if _, present := r.Header["Origin"]; present && r.Header.Get("Origin") != origin {
		httpsIngressError(w, http.StatusForbidden, "invalid origin")
		return
	}
	if r.Method != http.MethodPost {
		httpsIngressError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !running {
		httpsIngressError(w, http.StatusServiceUnavailable, "connector stopped")
		return
	}
	if !slices.ContainsFunc(strings.Split(r.Header.Get("Accept"), ","), func(part string) bool {
		mime, _, _ := strings.Cut(strings.TrimSpace(part), ";")
		return mime == "application/json" || mime == "*/*"
	}) {
		httpsIngressError(w, http.StatusNotAcceptable, "expected application/json in Accept")
		return
	}
	mime, _, _ := strings.Cut(r.Header.Get("Content-Type"), ";")
	if !strings.EqualFold(strings.TrimSpace(mime), "application/json") {
		httpsIngressError(w, http.StatusUnsupportedMediaType, "expected application/json")
		return
	}
	if _, present := r.Header["Mcp-Protocol-Version"]; present &&
		!slices.Contains([]string{"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"}, r.Header.Get("Mcp-Protocol-Version")) {
		httpsIngressError(w, http.StatusBadRequest, "unsupported protocol version")
		return
	}
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(15 * time.Second))
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16*1024*1024))
	_ = controller.SetReadDeadline(time.Time{})
	if err != nil {
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			httpsIngressError(w, http.StatusRequestTimeout, "request timeout")
		} else {
			httpsIngressError(w, http.StatusRequestEntityTooLarge, "invalid or oversized body")
		}
		return
	}
	var decoded any
	if err := canonjson.Unmarshal(body, &decoded); err != nil {
		httpsIngressReply(w, http.StatusBadRequest, object{"jsonrpc": "2.0", "id": nil, "error": object{"code": -32700, "message": "Parse error"}})
		return
	}
	request := obj(decoded)
	_, methodOK := request["method"].(string)
	rpcID, hasID := request["id"]
	_, idString := rpcID.(string)
	_, idNumber := rpcID.(json.Number)
	if request["jsonrpc"] != "2.0" || !methodOK || hasID && !idString && !idNumber {
		httpsIngressReply(w, http.StatusBadRequest, object{"jsonrpc": "2.0", "id": nil, "error": object{"code": -32600, "message": "Invalid Request"}})
		return
	}
	forward := func(ctx context.Context) (object, error) {
		reply, err := i.forwardMCP(ctx, request, principal, header)
		trace.result(reply, err)
		return reply, err
	}
	if !hasID {
		if request["method"] == "notifications/cancelled" || request["method"] == "notifications/initialized" {
			_, _ = i.forwardMCP(r.Context(), request, principal, header)
		}
		httpsIngressReply(w, http.StatusAccepted, nil)
		return
	}
	trace.dispatch(request)
	if isMCPWait(request) {
		serveWaitStream(w, r, request, forward)
		return
	}
	reply, err := forward(r.Context())
	if err == nil {
		httpsIngressReply(w, http.StatusOK, reply)
	} else if strings.HasPrefix(err.Error(), "CONNECTION_RETIRED:") ||
		oauth && (strings.HasPrefix(err.Error(), "SOURCE_REVOKED:") || err.Error() == "SOURCE_NOT_FOUND") {
		unauthorized()
	} else {
		httpsIngressError(w, http.StatusBadRequest, "invalid MCP request")
	}
}

func (i *networkIngress) forwardMCP(ctx context.Context, body, principal object, header string) (object, error) {
	if body["method"] == "notifications/cancelled" {
		i.waits.cancel(wire(field(body["params"], "requestId")))
		return nil, nil
	}
	if isMCPWait(body) {
		wait, release, err := i.waits.register(ctx, wire(body["id"]))
		if err != nil {
			return nil, err
		}
		defer release()
		ctx = wait
	}
	authority := object{"Ingress": privateIngress{ID: i.id, Principal: principal, Header: header}}
	result, err := i.owner.bridge.call(ctx, newPrivateRequest(ctx, "Mcp", authority, body))
	if err != nil {
		var rpcError object
		_ = decodeObject([]byte(err.Error()), &rpcError)
		if strings.HasPrefix(err.Error(), "FRONT_DOOR_") || strNumericEqual(rpcError["code"], "-32603") {
			if rpcError == nil {
				rpcError = object{"code": -32603, "message": err.Error(), "data": object{"arcVersion": arcVersion()}}
			}
			if body["id"] == nil {
				return nil, nil
			}
			return object{"jsonrpc": "2.0", "id": body["id"], "error": rpcError}, nil
		}
	}
	return obj(result), err
}

func strNumericEqual(value any, want string) bool {
	number, ok := value.(json.Number)
	return ok && number.String() == want
}

func ingressAuthenticatedSource(ctx context.Context, service *service, id string, principal object, header *string) (requestSource, error) {
	entry, err := loadIngressEntry(id)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) && id == "default" && header == nil &&
			principal["type"] == "ingress" && principal["ingressId"] == id {
			return service.source, nil
		}
		return requestSource{}, err
	}
	if entry["enabled"] != true {
		return requestSource{}, errors.New("Local connection disabled")
	}
	auth := text(entry, "auth")
	if principal["type"] == "oauth-grant" && auth == "oauth" && header != nil && ingressOAuthValidate != nil {
		if err := ingressOAuthValidate(ctx, id, principal, *header); err != nil {
			return requestSource{}, err
		}
	} else if principal["type"] != "ingress" || principal["ingressId"] != id || !(header != nil && ingressAllowsHeader(entry, *header) ||
		header == nil && (entry["transport"] == "local" || entry["transport"] == "openai-tunnel")) {
		return requestSource{}, errors.New(contextMismatch)
	}
	if service.fixtureIngress != nil && auth != "oauth" {
		return service.fixtureIngress(id)
	}
	if ingressSourceAuthority == nil {
		return requestSource{}, errors.New(PortPending)
	}
	return ingressSourceAuthority(ctx, entry, principal, header)
}

var ingressSourceAuthority func(context.Context, object, object, *string) (requestSource, error)

func init() {
	authenticateIngressPrincipal = ingressAuthenticatedSource
}
