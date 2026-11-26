package core

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"maps"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var browserKeyWrite sync.Mutex

func browserKey() (string, bool) {
	data, _ := cachedLoad(filepath.Join(root(), "app/browser-access.json"))
	key, ok := field(data, "key").(string)
	return key, ok
}

func browserAccess(ctx context.Context, s *service, rotate bool) (object, error) {
	browserKeyWrite.Lock()
	defer browserKeyWrite.Unlock()
	key, found := browserKey()
	if !found || rotate {
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return nil, errors.New("Cannot generate browser access key")
		}
		key = "arc_" + hex.EncodeToString(raw)
		if err := save(filepath.Join(root(), "app/browser-access.json"), object{"key": key}); err != nil {
			return nil, err
		}
	}
	ingresses, err := s.ingressStatuses(ctx)
	if err != nil {
		return nil, err
	}
	links := []object{}
	for _, ingress := range ingresses {
		if transport := text(ingress, "transport"); transport != "https" && transport != "relay" {
			continue
		}
		address := text(ingress, "url")
		if address == "" {
			address = text(ingress["config"], "httpsUrl")
		}
		public, err := url.Parse(address)
		if err != nil || public.Scheme == "" || public.Host == "" {
			continue
		}
		base, ok := strings.CutSuffix(public.Path, "/mcp")
		if !ok {
			continue
		}
		public.Path, public.RawPath = base+"/", ""
		public.RawQuery = url.Values{"key": {key}}.Encode()
		links = append(links, object{"ingressId": ingress["id"], "name": ingress["name"], "url": public.String()})
	}
	return object{"key": key, "links": links}, nil
}

func browserSession(key string) string {
	return hash([]byte("arc-browser-session:" + key))
}

func browserAuthenticated(req *http.Request, key string) bool {
	matches := func(value, expected string) bool {
		return secureToken(hash([]byte(value)), hash([]byte(expected)))
	}
	var values []string
	for parameter := range strings.SplitSeq(req.URL.RawQuery, "&") {
		name, value, _ := strings.Cut(parameter, "=")
		if decoded, err := url.QueryUnescape(name); err == nil && decoded == "key" {
			decoded, err := url.QueryUnescape(value)
			if err != nil {
				return false
			}
			values = append(values, decoded)
		}
	}
	if len(values) != 0 {
		return len(values) == 1 && matches(values[0], key)
	}
	if headers := req.Header.Values("Authorization"); len(headers) != 0 {
		value, bearer := strings.CutPrefix(headers[0], "Bearer ")
		return bearer && matches(value, key)
	}
	expected := browserSession(key)
	for _, header := range req.Header.Values("Cookie") {
		for cookie := range strings.SplitSeq(header, ";") {
			if value, ok := strings.CutPrefix(strings.TrimSpace(cookie), "arc_browser="); ok && matches(value, expected) {
				return true
			}
		}
	}
	return false
}

func browserNotModified(validator, etag string) bool {
	for tag := range strings.SplitSeq(validator, ",") {
		tag = strings.TrimSpace(tag)
		if tag == "*" || strings.TrimPrefix(tag, "W/") == etag {
			return true
		}
	}
	return false
}

func compactBrowserStatus(ctx context.Context, s *service) (object, error) {
	status, err := s.status(ctx)
	if err != nil {
		return nil, err
	}
	delete(status, "logs")
	delete(obj(status["core"]), "logs")
	if ingresses, ok := status["ingresses"].([]object); ok {
		clean := make([]object, 0, len(ingresses))
		for _, value := range ingresses {
			ingress := maps.Clone(value)
			for _, key := range []string{"logs", "requests", "platformInfo"} {
				delete(ingress, key)
			}
			clean = append(clean, ingress)
		}
		status["ingresses"] = clean
	}
	status["sources"] = []any{}
	if sources, err := listControlSources(); err == nil {
		status["sources"] = sources
	}
	return status, nil
}

func compareBrowserStatus(value any) any {
	switch data := value.(type) {
	case object:
		result := make(object, len(data))
		for key, child := range data {
			switch key {
			case "observedAt", "sampledAt", "attemptedAt", "lastReadyAt", "requests", "logs":
				continue
			}
			result[key] = compareBrowserStatus(child)
		}
		return result
	case []any:
		result := make([]any, len(data))
		for index, child := range data {
			result[index] = compareBrowserStatus(child)
		}
		return result
	case []object:
		result := make([]any, len(data))
		for index, child := range data {
			result[index] = compareBrowserStatus(child)
		}
		return result
	default:
		return value
	}
}

// A split ingress supplies the gateway. A combined ingress supplies its
// in-process Core endpoint. Assets are the immutable browser build output.
type browserIngress struct {
	id, publicURL, localHost string
	connected                bool
	gateway                  *gatewayBridge
	core                     *inProcess
	assets                   fs.FS
}

func (i browserIngress) request(ctx context.Context, authority object, route, method string, body object) (any, error) {
	request := newPrivateRequest(ctx, object{"Management": object{"route": route, "method": method}}, authority, body)
	if i.gateway != nil {
		return i.gateway.call(ctx, request)
	}
	request.Generation = i.core.generation
	return i.core.admit(ctx, request)
}

func (i browserIngress) stream(ctx context.Context, authority object, kind string, send func(string) error) error {
	if i.gateway != nil {
		return i.gateway.snapshotWithAuthority(ctx, kind, authority, send)
	}
	request := newPrivateRequest(ctx, object{"Snapshot": object{"kind": kind}}, authority, object{})
	request.Generation = i.core.generation
	return i.core.snapshotStream(ctx, request, func(frame frontDoorStream) error {
		return send(snapshotMessage(frame.Body))
	})
}

func serveBrowser(w http.ResponseWriter, req *http.Request, ingress browserIngress) {
	header := w.Header()
	header.Set("Cache-Control", "no-store")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("X-Content-Type-Options", "nosniff")
	key, found := browserKey()
	if !found || !browserAuthenticated(req, key) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	public, err := url.Parse(ingress.publicURL)
	if err != nil || public.Scheme == "" || public.Host == "" {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	publicHost := public.Host
	if public.Scheme == "https" && public.Port() == "443" {
		publicHost = strings.TrimSuffix(publicHost, ":443")
	}
	origin := public.Scheme + "://" + publicHost
	host := ""
	if public.Scheme == "https" {
		host = publicHost
	}
	requestOrigins := req.Header.Values("Origin")
	if (req.Host != host && req.Host != host+":443" && req.Host != ingress.localHost) ||
		(len(requestOrigins) != 0 && requestOrigins[0] != origin) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if !ingress.connected || ingress.core == nil && ingress.gateway == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	requestPath := req.URL.EscapedPath()
	if route, ok := strings.CutPrefix(requestPath, "/view-api/"); ok {
		authority := object{"Browser": object{"ingress_id": ingress.id, "key_digest": hash([]byte(key))}}
		serveBrowserAPI(w, req, ingress, authority, route)
		return
	}
	if req.Method != http.MethodGet {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	serveBrowserAsset(w, ingress.assets, public, requestPath, key)
}

func serveBrowserAPI(w http.ResponseWriter, req *http.Request, ingress browserIngress, authority object, route string) {
	if !browserRouteAllowed(route, req.Method) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	body := object{}
	if req.Method == http.MethodPost {
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(time.Now().Add(5 * time.Second))
		data, err := io.ReadAll(io.LimitReader(req.Body, 16385))
		_ = controller.SetReadDeadline(time.Time{})
		if err != nil || len(data) > 16384 || decodeObject(data, &body) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
	}
	if err := authorizeBrowserRoute(route, req.Method, body); err != nil {
		writeBrowserAPIError(w, err)
		return
	}
	if strings.HasPrefix(route, "agents/timeline/") && parseTimelineQuery(req.URL.RawQuery, body) != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	switch route {
	case "events", "subscriptions/events", "agents/activity/events":
		kind := map[string]string{"events": "Browser", "subscriptions/events": "Subscriptions", "agents/activity/events": "Activity"}[route]
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Accel-Buffering", "no")
		controller := http.NewResponseController(w)
		if err := controller.Flush(); err != nil {
			return
		}
		_ = ingress.stream(req.Context(), authority, kind, func(frame string) error {
			_ = controller.SetWriteDeadline(time.Now().Add(2 * time.Second))
			if _, err := io.WriteString(w, frame); err != nil {
				return err
			}
			return controller.Flush()
		})
		return
	}
	value, err := ingress.request(req.Context(), authority, route, req.Method, body)
	if err != nil {
		writeBrowserAPIError(w, err)
		return
	}
	data := wire(value)
	etag := "\"" + hash([]byte(data)) + "\""
	if browserNotModified(req.Header.Get("If-None-Match"), etag) {
		switch {
		case req.Method == http.MethodGet, route == "agents/conversations", route == "agents/conversations/timeline", route == "tasks/reviews":
			w.Header().Set("Content-Type", "application/json")
		default:
			w.Header().Set("ETag", etag)
		}
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", etag)
	_, _ = io.WriteString(w, data)
}

func writeBrowserAPIError(w http.ResponseWriter, err error) {
	switch message := err.Error(); {
	case message == "FRONT_DOOR_BROWSER_FORBIDDEN":
		w.WriteHeader(http.StatusForbidden)
	case message == "FRONT_DOOR_BROWSER_INVALID":
		w.WriteHeader(http.StatusBadRequest)
	case message == "FRONT_DOOR_BROWSER_UNAUTHORIZED":
		w.WriteHeader(http.StatusUnauthorized)
	case strings.HasPrefix(message, "FRONT_DOOR_"):
		w.WriteHeader(http.StatusServiceUnavailable)
	default:
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, wire(object{"error": message}))
	}
}

func serveBrowserAsset(w http.ResponseWriter, assets fs.FS, public *url.URL, requestPath, key string) {
	page := requestPath == "/" || requestPath == "/browser.html"
	file := strings.TrimLeft(requestPath, "/")
	if page {
		file = "browser.html"
	}
	if assets == nil || !fs.ValidPath(file) || (!page && !strings.HasPrefix(file, "assets/")) {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	bytes, err := fs.ReadFile(assets, file)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	contentType := map[string]string{
		".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
		".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2",
	}[path.Ext(file)]
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'")
	if page {
		base, _ := strings.CutSuffix(public.EscapedPath(), "/mcp")
		w.Header().Set("Set-Cookie", "arc_browser="+browserSession(key)+"; Path="+base+"/; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict")
	}
	_, _ = w.Write(bytes)
}

func init() {
	currentBrowserKeyDigest = func(context.Context) (string, error) {
		if key, ok := browserKey(); ok {
			return hash([]byte(key)), nil
		}
		return "", nil
	}
	browserSnapshotComparison = compareBrowserStatus
	registerRoute("GET", "browser/access", func(ctx context.Context, s *service, _ object, _ []string) (any, error) {
		return browserAccess(ctx, s, false)
	})
	registerRoute("POST", "browser/access/rotate", func(ctx context.Context, s *service, _ object, _ []string) (any, error) {
		return browserAccess(ctx, s, true)
	})
	registerRoute("GET", "browser/snapshot", func(ctx context.Context, s *service, _ object, _ []string) (any, error) {
		return compactBrowserStatus(ctx, s)
	})
}
