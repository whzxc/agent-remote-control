package core

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net"
	"net/http"
	"path/filepath"
	"slices"
	"sync"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

var networkGateways sync.Map // *gatewayOwner -> *ingressGateway

type ingressGateway struct {
	owner   *gatewayOwner
	mu      sync.RWMutex
	entries map[string]*networkIngress
}

type networkIngress struct {
	owner                   *gatewayOwner
	id, directory           string
	lifecycle               sync.Mutex
	mu                      sync.RWMutex
	entry, verification     object
	server                  *http.Server
	providerStop            func()
	running, retired        bool
	url, failure, lastError string
	lastErrorAt             any
	requests                ingressCounters
	waits                   waitCalls
}

func newNetworkIngress(owner *gatewayOwner, entry object) (*networkIngress, error) {
	ingressID := text(entry, "id")
	directory := filepath.Join(root(), "ingresses", ingressID)
	if err := platform.PrivateDir(directory); err != nil {
		return nil, err
	}
	if err := migrateLogs(directory, ingressID); err != nil {
		return nil, err
	}
	path := filepath.Join(directory, "verification.json")
	verification, err := load(path)
	if err != nil {
		verification = object{"code": id(), "verifiedAt": nil}
		if err := save(path, verification); err != nil {
			return nil, err
		}
	}
	return &networkIngress{owner: owner, id: ingressID, directory: directory, entry: entry, verification: obj(verification)}, nil
}

func (i *networkIngress) observe(field string, value any, once bool) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if once && i.verification[field] != nil {
		return nil
	}
	verification := clone(i.verification)
	verification[field] = value
	if err := save(filepath.Join(i.directory, "verification.json"), verification); err != nil {
		return err
	}
	i.verification = verification
	return nil
}

func (i *networkIngress) resetVerification() error {
	i.mu.Lock()
	defer i.mu.Unlock()
	verification := object{"code": id(), "verifiedAt": nil}
	if err := save(filepath.Join(i.directory, "verification.json"), verification); err != nil {
		return err
	}
	i.verification = verification
	return nil
}

func (i *networkIngress) status() object {
	i.mu.RLock()
	entry, verification := i.entry, clone(i.verification)
	running, resource, failure := i.running, i.url, i.failure
	lastError, lastErrorAt := i.lastError, i.lastErrorAt
	i.mu.RUnlock()

	config := clone(obj(entry["config"]))
	config["configured"] = ingressConfigured(config)
	for _, key := range ingressSecretFields() {
		config[text(field(ingressDescriptor()["fields"], key), "savedFlag")] = text(config, key) != ""
		delete(config, key)
	}
	chat := object{"ingressId": i.id, "controlSource": entry["controlSource"]}
	for _, key := range []string{"code", "verifiedAt", "challengeVerifiedAt", "firstOAuthRequestAt", "firstMcpRequestAt", "lastProbe"} {
		chat[key] = verification[key]
	}
	state := "stopped"
	if running {
		state = "ready"
	} else if failure != "" {
		state = "error"
	}
	installed, _ := load(filepath.Join(root(), "app/native.json"))
	return object{
		"frontDoor": frontDoorStatus(text(installed, "build")), "discoveredUrls": []string{}, "requests": i.requests.snapshot(),
		"core":       object{"chatgpt": chat, "transport": object{"state": state, "error": failure}},
		"connection": object{"running": running, "updateAvailable": false, "mcpUrl": resource},
		"config":     config,
		"tunnel": object{"state": state, "error": failure, "health": nil, "controlPlane": nil, "dependency": nil,
			"lastError": lastError, "lastErrorAt": lastErrorAt},
		"connector": object{"state": state}, "logs": recentLogs(&i.id),
		"version": buildVersion, "platform": runtimePlatform(), "deviceName": deviceDisplayName(),
		"chatgptUrl": "https://chatgpt.com/plugins",
	}
}

func (i *networkIngress) summary(ctx context.Context) (object, error) {
	status := i.status()
	i.mu.RLock()
	entry := i.entry
	i.mu.RUnlock()
	config, tunnel, transport := status["config"], status["tunnel"], status["connection"]
	result := object{
		"frontDoor": status["frontDoor"], "health": field(tunnel, "health"), "controlPlane": field(tunnel, "controlPlane"),
		"tunnelDependency": field(tunnel, "dependency"), "tunnelError": field(tunnel, "lastError"),
		"lastTunnelError": field(tunnel, "lastError"), "lastTunnelErrorAt": field(tunnel, "lastErrorAt"),
		"requests": status["requests"], "discoveredUrls": status["discoveredUrls"], "provider": field(config, "httpsProvider"),
		"config": config, "running": field(transport, "running"), "state": field(tunnel, "state"), "error": field(tunnel, "error"),
		"url": field(transport, "mcpUrl"), "verification": field(status["core"], "chatgpt"), "logs": status["logs"],
	}
	for _, name := range []string{"id", "name", "controlSource", "transport", "enabled", "auth", "toolPolicy"} {
		result[name] = entry[name]
	}
	if result["state"] == "ready" {
		result["tunnelError"] = ""
	}
	if entry["auth"] == "oauth" && ingressOAuthSnapshot != nil {
		snapshot, err := ingressOAuthSnapshot(i)
		if err != nil {
			return nil, err
		}
		result["oauth"] = snapshot
	}
	if entry["auth"] != "oauth" && sourceAuthorityHandlers["ensure_ingress"] != nil {
		if _, err := requestSourceAuthority(ctx, i.owner.bridge, "ensure_ingress", object{"entry": entry}); err != nil {
			return nil, err
		}
	}
	if sourceAuthorityHandlers["connection_state"] != nil {
		if _, err := requestSourceAuthority(ctx, i.owner.bridge, "connection_state", object{"ingress": i.id, "connected": result["running"]}); err != nil {
			return nil, err
		}
	}
	sources := []any{}
	if sourceAuthorityHandlers["control_sources"] != nil {
		rows, err := requestSourceAuthority(ctx, i.owner.bridge, "control_sources", object{})
		if err != nil {
			return nil, err
		}
		for _, source := range arr(rows) {
			if field(source, "ingressId") == i.id {
				sources = append(sources, source)
			}
		}
	}
	result["sources"] = sources
	result["diagnostics"] = ingressDiagnostics(result)
	return result, nil
}

var ingressOAuthSnapshot func(*networkIngress) (any, error)
var ingressOAuthManagement func(context.Context, *networkIngress, string, string, object) (any, error)
var ingressOAuthReset func(context.Context, *networkIngress) error

// Provider implementations are owned by their transport module.
var startManagedIngress func(context.Context, *networkIngress, object) error

func (i *networkIngress) start(ctx context.Context) (err error) {
	i.mu.Lock()
	if i.retired {
		i.mu.Unlock()
		return errors.New("ingress removed or replaced")
	}
	entry, running := i.entry, i.running
	i.mu.Unlock()
	if entry["enabled"] != true {
		return errors.New("ingress disabled")
	}
	if running {
		return nil
	}
	defer func() {
		if err != nil {
			i.stop()
			if err.Error() == PortPending {
				return
			}
			i.mu.Lock()
			i.failure, i.lastError, i.lastErrorAt = err.Error(), err.Error(), now()
			i.mu.Unlock()
			recordLog("ERROR", err.Error(), &i.id)
		}
	}()
	config := obj(entry["config"])
	if !ingressConfigured(config) {
		return errors.New("Complete connection settings first")
	}
	switch {
	case config["connectionMode"] == "local":
		i.markRunning("")
	case config["connectionMode"] == "https" && config["httpsProvider"] == "custom":
		if _, err := listenHTTPSIngress(i, config); err != nil {
			return err
		}
		i.markRunning(text(config, "httpsUrl"))
		recordLog("INFO", "Local MCP listener started; verify public inbound access from the control source", &i.id)
	default:
		if startManagedIngress == nil {
			return errors.New(PortPending)
		}
		return startManagedIngress(ctx, i, config)
	}
	return nil
}

func (i *networkIngress) markRunning(url string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.running, i.url, i.failure = true, url, ""
}

func (i *networkIngress) stop() {
	i.mu.Lock()
	i.running, i.url, i.failure = false, "", ""
	server, stop := i.server, i.providerStop
	i.server, i.providerStop = nil, nil
	i.mu.Unlock()
	if stop != nil {
		stop()
	}
	if server != nil {
		_ = server.Close()
	}
}

func (i *networkIngress) setConnection(ctx context.Context, running bool) error {
	i.lifecycle.Lock()
	defer i.lifecycle.Unlock()
	i.mu.RLock()
	retired, enabled := i.retired, i.entry["enabled"] == true
	i.mu.RUnlock()
	if retired {
		return errors.New("ingress removed or replaced")
	}
	if running && !enabled {
		return errors.New("ingress disabled")
	}
	if err := rememberConnection(i.id, running); err != nil {
		return err
	}
	if running {
		return i.start(ctx)
	}
	i.stop()
	return nil
}

func (g *ingressGateway) ids() []string {
	names := slices.Collect(maps.Keys(g.entries))
	slices.Sort(names)
	return names
}

func (g *ingressGateway) snapshot() []*networkIngress {
	g.mu.RLock()
	defer g.mu.RUnlock()
	entries := make([]*networkIngress, 0, len(g.entries))
	for _, name := range g.ids() {
		entries = append(entries, g.entries[name])
	}
	return entries
}

func (g *ingressGateway) get(id string) (*networkIngress, error) {
	if err := validateIngressID(id); err != nil {
		return nil, err
	}
	g.mu.RLock()
	defer g.mu.RUnlock()
	if entry := g.entries[id]; entry != nil {
		return entry, nil
	}
	return nil, errors.New("ingress not found")
}

func (g *ingressGateway) add(ctx context.Context, entry object) (object, error) {
	entry = clone(entry)
	g.mu.Lock()
	if entry["id"] == nil {
		entry["id"] = id()
	}
	if entry["name"] == nil {
		names := make([]string, 0, len(g.entries))
		for _, i := range g.entries {
			i.mu.RLock()
			names = append(names, text(i.entry, "name"))
			i.mu.RUnlock()
		}
		entry["name"] = sourceDefaultName(text(entry, "controlSource"), names)
	}
	if entry["enabled"] == nil {
		entry["enabled"] = true
	}
	if entry["config"] == nil {
		entry["config"] = object{}
	}
	if config := obj(entry["config"]); entry["transport"] == "https" && config != nil && config["httpsPort"] == nil {
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			g.mu.Unlock()
			return nil, err
		}
		config["httpsPort"] = listener.Addr().(*net.TCPAddr).Port
		listener.Close()
	}
	if g.entries[text(entry, "id")] != nil {
		g.mu.Unlock()
		return nil, errors.New("ingress already exists")
	}
	normalized, err := normalizeIngressEntry(ctx, g.owner.bridge, entry)
	if err != nil {
		g.mu.Unlock()
		return nil, err
	}
	i, err := newNetworkIngress(g.owner, normalized)
	if err == nil {
		err = saveIngressEntry(normalized)
	}
	if err == nil {
		err = save(filepath.Join(root(), "ingresses/index.json"), append(g.ids(), i.id))
	}
	if err == nil {
		g.entries[i.id] = i
	}
	g.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return i.summary(ctx)
}

func (g *ingressGateway) restore(ctx context.Context, autostart bool) error {
	intent, err := connectionIntent()
	if err != nil {
		return err
	}
	var jobs sync.WaitGroup
	defer jobs.Wait()
	for _, i := range g.snapshot() {
		jobs.Go(func() {
			i.lifecycle.Lock()
			defer i.lifecycle.Unlock()
			i.mu.RLock()
			entry, retired := i.entry, i.retired
			i.mu.RUnlock()
			if retired || entry["enabled"] != true {
				return
			}
			if autostart {
				if field(entry["config"], "autoStart") != true {
					return
				}
				if err := rememberConnection(i.id, true); err != nil {
					recordLog("ERROR", err.Error(), &i.id)
					return
				}
			} else if entry["transport"] == "local" || !slices.Contains(intent, i.id) {
				return
			}
			if err := i.start(ctx); err != nil {
				recordLog("ERROR", err.Error(), &i.id)
			}
		})
	}
	return nil
}

func startIngressGateway(ctx context.Context, owner *gatewayOwner) error {
	raw, err := load(filepath.Join(root(), "ingresses/index.json"))
	if err != nil {
		return err
	}
	index := arr(raw)
	if index == nil {
		return errors.New("invalid ingress index")
	}
	g := &ingressGateway{owner: owner, entries: make(map[string]*networkIngress)}
	for _, row := range index {
		id := str(row)
		entry, err := loadIngressEntry(id)
		if err != nil {
			return fmt.Errorf("Load ingress %s: %w", id, err)
		}
		entry, err = normalizeIngressEntry(ctx, owner.bridge, entry)
		if err != nil {
			return fmt.Errorf("Normalize ingress %s: %w", id, err)
		}
		if g.entries[id], err = newNetworkIngress(owner, entry); err != nil {
			return err
		}
	}
	networkGateways.Store(owner, g)
	owner.cleanup = append(owner.cleanup, func() {
		networkGateways.Delete(owner)
		for _, i := range g.snapshot() {
			i.lifecycle.Lock()
			i.mu.Lock()
			i.retired = true
			i.mu.Unlock()
			i.stop()
			i.lifecycle.Unlock()
		}
	})
	return nil
}

func runtimePlatform() string {
	if operatingSystem == "windows" {
		return "win32"
	}
	return operatingSystem
}

func init() {
	gatewayStartup = append(gatewayStartup, startIngressGateway)
}
