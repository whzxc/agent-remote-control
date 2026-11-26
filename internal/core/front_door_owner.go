package core

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"unicode"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

var ingressIdentifier = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
var connectionIntentMu sync.Mutex

// E owns provider defaults, validation and the transport lifecycle. The gateway
// owns its independent process, admissions and ingress record storage.
var ingressConfigDefaults func() object
var ingressConfigSecrets func() []string
var validateIngressConfig func(object) error
var gatewayStartup []func(context.Context, *gatewayOwner) error

type gatewayManagement func(context.Context, *gatewayOwner, object, []string) (any, error)

type gatewayRoute struct {
	pattern *regexp.Regexp
	handle  gatewayManagement
}

var gatewayRoutes = make(map[string][]gatewayRoute)
var gatewayRouteKeys = make(map[string]bool)

func registerGatewayRoute(method, pattern string, handle gatewayManagement) {
	key := method + " " + pattern
	if handle == nil || gatewayRouteKeys[key] {
		panic("Invalid or duplicate gateway route " + key)
	}
	gatewayRouteKeys[key] = true
	gatewayRoutes[method] = append(gatewayRoutes[method], gatewayRoute{regexp.MustCompile("^(?:" + pattern + ")$"), handle})
}

type gatewayOwner struct {
	bridge  *gatewayBridge
	token   string
	port    uint64
	cleanup []func()
}

func (g *gatewayOwner) start(ctx context.Context) error {
	path := filepath.Join(root(), "ingresses/index.json")
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		if err := save(path, []string{}); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	for _, start := range gatewayStartup {
		if err := start(ctx, g); err != nil {
			return err
		}
	}
	return nil
}

func (g *gatewayOwner) close() {
	for _, clean := range slices.Backward(g.cleanup) {
		clean()
	}
}

func (g *gatewayOwner) management(ctx context.Context, route, method string, body object) (any, error) {
	for _, registered := range gatewayRoutes[method] {
		if matches := registered.pattern.FindStringSubmatch(route); matches != nil {
			return registered.handle(ctx, g, body, matches[1:])
		}
	}
	if knownManagementRoute(method, route) || strings.HasPrefix(route, "_") {
		return nil, errors.New(PortPending)
	}
	return nil, errors.New("UNKNOWN_ROUTE")
}

func (g *gatewayOwner) mcp(context.Context, string, object) (object, error) {
	return nil, errors.New(contextMismatch)
}

func gatewayRequest(ctx context.Context, route, method string, body object) (any, error) {
	conn, hello, err := attachPrivate(ctx, "front-door")
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	request := newPrivateRequest(ctx, object{"Management": privateManagement{Route: route, Method: method}}, "Management", body)
	request.Generation = hello.Generation
	return exchangePrivate(ctx, conn, request, "Gateway")
}

func validateIngressID(id string) error {
	if id == "local-cli" || !ingressIdentifier.MatchString(id) {
		return errors.New("id must contain 1-64 ASCII letters, digits, - or _")
	}
	return nil
}

func connectionIntent() ([]string, error) {
	path := filepath.Join(root(), "desktop-session.json")
	value, err := cachedJSON(path)
	if errors.Is(err, os.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var ids []string
	if values := arr(value); values != nil {
		for _, entry := range values {
			id, ok := entry.(string)
			if !ok {
				return nil, errors.New("invalid desktop connection intent")
			}
			ids = append(ids, id)
		}
	} else {
		return nil, errors.New("invalid desktop connection intent")
	}
	slices.Sort(ids)
	return slices.Compact(ids), nil
}

func rememberConnection(id string, connected bool) error {
	if err := validateIngressID(id); err != nil {
		return err
	}
	connectionIntentMu.Lock()
	defer connectionIntentMu.Unlock()
	ids, err := connectionIntent()
	if err != nil {
		return err
	}
	at, found := slices.BinarySearch(ids, id)
	if connected && !found {
		ids = slices.Insert(ids, at, id)
	} else if !connected && found {
		ids = slices.Delete(ids, at, at+1)
	}
	if ids == nil {
		ids = []string{}
	}
	return save(filepath.Join(root(), "desktop-session.json"), ids)
}

func expectedRemote() ([]object, error) {
	ids, err := connectionIntent()
	if err != nil {
		return nil, err
	}
	rows := []object{}
	for _, id := range ids {
		if err := validateIngressID(id); err != nil {
			return nil, err
		}
		entry, err := cachedJSON(filepath.Join(root(), "ingresses", id, "config.json"))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if field(entry, "enabled") == true && field(entry, "transport") != "local" {
			rows = append(rows, object{"id": id, "name": field(entry, "name")})
		}
	}
	return rows, nil
}

func saveIngressEntry(entry object) error {
	if ingressConfigSecrets == nil {
		return errors.New(PortPending)
	}
	name := text(entry, "id")
	if err := validateIngressID(name); err != nil {
		return err
	}
	dir := filepath.Join(root(), "ingresses", name)
	if err := platform.PrivateDir(dir); err != nil {
		return err
	}
	public := clone(entry)
	config := obj(public["config"])
	if config == nil {
		return errors.New("config must be an object")
	}
	delete(config, "connectionMode")
	secret := object{"bearerToken": public["bearerToken"]}
	delete(public, "bearerToken")
	for _, key := range ingressConfigSecrets() {
		secret[key] = config[key]
		delete(config, key)
	}
	if err := save(filepath.Join(dir, "secrets.json"), secret); err != nil {
		return err
	}
	return save(filepath.Join(dir, "config.json"), public)
}

func loadIngressEntry(id string) (object, error) {
	if err := validateIngressID(id); err != nil {
		return nil, err
	}
	if ingressConfigSecrets == nil {
		return nil, errors.New(PortPending)
	}
	dir := filepath.Join(root(), "ingresses", id)
	row, err := load(filepath.Join(dir, "config.json"))
	if err != nil {
		return nil, err
	}
	entry := obj(row)
	if entry["id"] != id {
		return nil, errors.New("ingress id mismatch")
	}
	value, err := load(filepath.Join(dir, "secrets.json"))
	if err != nil {
		return nil, err
	}
	entry["bearerToken"] = field(value, "bearerToken")
	config := obj(entry["config"])
	if config == nil {
		return nil, errors.New("config must be an object")
	}
	for _, key := range ingressConfigSecrets() {
		if secret, exists := obj(value)[key]; exists {
			config[key] = secret
		} else {
			config[key] = ""
		}
	}
	return entry, nil
}

func normalizeIngressEntry(ctx context.Context, gateway *gatewayBridge, entry object) (object, error) {
	entry = clone(entry)
	for key := range entry {
		if !slices.Contains([]string{"id", "name", "controlSource", "transport", "auth", "bearerToken", "enabled", "toolPolicy", "config"}, key) {
			return nil, errors.New("unknown ingress field; see cli help")
		}
	}
	if err := validateIngressID(text(entry, "id")); err != nil {
		return nil, err
	}
	for _, label := range []string{"name", "controlSource"} {
		value, ok := entry[label].(string)
		if !ok {
			return nil, errors.New("name and controlSource are required")
		}
		if len(value) == 0 || len(value) > 120 || strings.ContainsFunc(value, unicode.IsControl) {
			return nil, errors.New("invalid ingress label")
		}
	}
	if _, ok := entry["enabled"].(bool); !ok {
		return nil, errors.New("enabled must be boolean")
	}
	transport, auth := text(entry, "transport"), text(entry, "auth")
	if !slices.Contains([]string{"openai-tunnel", "https", "relay", "local"}, transport) {
		return nil, errors.New("transport must be openai-tunnel, https, relay or local")
	}
	switch {
	case transport == "local" && auth != "none":
		return nil, errors.New("Local connections use authenticated IPC")
	case transport == "openai-tunnel" && auth != "openai":
		return nil, errors.New("OpenAI Tunnel requires auth=openai")
	case transport != "openai-tunnel" && !slices.Contains([]string{"none", "bearer", "oauth"}, auth):
		return nil, errors.New("HTTPS auth must be none, bearer or oauth")
	}
	if _, exists := entry["toolPolicy"]; !exists {
		policy, err := requestSourceAuthority(ctx, gateway, "default_policy", object{})
		if err != nil {
			return nil, err
		}
		entry["toolPolicy"] = policy
	}
	if entry["toolPolicy"] != "all" {
		allow := arr(field(entry["toolPolicy"], "allowlist"))
		if allow == nil {
			return nil, errors.New("toolPolicy must be all or {allowlist:[op names]}")
		}
		for _, name := range allow {
			if _, ok := name.(string); !ok {
				return nil, errors.New("toolPolicy allowlist must contain op names")
			}
		}
	}
	raw := obj(entry["config"])
	if raw == nil {
		return nil, errors.New("config must be an object")
	}
	if ingressConfigDefaults == nil || validateIngressConfig == nil {
		return nil, errors.New(PortPending)
	}
	config := ingressConfigDefaults()
	if value, err := load(filepath.Join(root(), "app/preferences.json")); err == nil {
		for _, key := range []string{"proxyMode", "proxyUrl"} {
			if v, ok := obj(value)[key]; ok {
				config[key] = v
			}
		}
	}
	delete(raw, "ngrokDomain")
	for key, value := range raw {
		config[key] = value
	}
	config["connectionMode"] = transport
	if transport == "openai-tunnel" {
		config["connectionMode"] = "tunnel"
	}
	if err := validateIngressConfig(config); err != nil {
		return nil, err
	}
	if auth == "bearer" {
		token := text(entry, "bearerToken")
		if len(token) < 32 || len(token) > 4096 || strings.ContainsFunc(token, func(r rune) bool { return r < 33 || r > 126 }) {
			return nil, errors.New("bearerToken requires 32-4096 printable ASCII characters; supply via stdin")
		}
	}
	entry["config"] = config
	return entry, nil
}

func init() {
	registerRoute(http.MethodGet, "runtime/remote", func(ctx context.Context, s *service, _ object, _ []string) (any, error) {
		expected, err := expectedRemote()
		if err != nil {
			return nil, err
		}
		status, err := s.ingressStatuses(ctx)
		if err != nil {
			return nil, err
		}
		return slices.DeleteFunc(expected, func(row object) bool {
			return slices.ContainsFunc(status, func(actual object) bool {
				return row["id"] == actual["id"] && actual["state"] == "ready"
			})
		}), nil
	})
}
