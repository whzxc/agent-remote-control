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
	ctx     context.Context
	drafts  map[string]*ingressDraft
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
	oauth                   *ingressOAuth
	server                  *http.Server
	managedHealth           object
	managedURLs             []string
	providerStatus          object
	officialTunnel          *officialTunnel
	tunnelDependency        object
	providerStop            func()
	draft, starting         bool
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
	oauth, err := newIngressOAuth(directory, owner.bridge)
	if err != nil {
		return nil, err
	}
	return &networkIngress{owner: owner, id: ingressID, directory: directory, entry: entry, verification: obj(verification), oauth: oauth}, nil
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
	verification := object{"binding": i.verification["binding"], "endpoint": i.verification["endpoint"], "code": id(), "verifiedAt": nil}
	if err := save(filepath.Join(i.directory, "verification.json"), verification); err != nil {
		return err
	}
	i.verification = verification
	return nil
}

func (i *networkIngress) resetVerificationResult() (object, error) {
	if err := i.resetVerification(); err != nil {
		return nil, err
	}
	i.mu.RLock()
	defer i.mu.RUnlock()
	return object{"code": i.verification["code"], "verifiedAt": nil}, nil
}

func (i *networkIngress) status() object {
	i.refreshOfficialTunnel()
	i.mu.RLock()
	entry, verification := i.entry, clone(i.verification)
	running, resource, failure := i.running, i.url, i.failure
	lastError, lastErrorAt := i.lastError, i.lastErrorAt
	provider, dependency, official := i.providerStatus, i.tunnelDependency, i.officialTunnel != nil
	health, urls := i.managedHealth, i.managedURLs
	active := i.providerStop != nil || i.starting
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
	if health != nil && health["state"] == "degraded" {
		state, failure = "degraded", text(health, "error")
	} else if running {
		state = "ready"
	} else if provider["state"] == "rejected" {
		state, failure = "error", localized(locale(), "setup.runtime-key-rejected")
	} else if official || active && health == nil {
		state = "starting"
	} else if provider["state"] == "connecting" || provider["state"] == "reconnecting" {
		state, failure = "starting", text(provider, "error")
	} else if failure != "" {
		state = "error"
	}
	if urls == nil {
		urls = []string{}
	}
	installed, _ := load(filepath.Join(root(), "app/native.json"))
	return object{
		"frontDoor": frontDoorStatus(text(installed, "build")), "discoveredUrls": urls, "requests": i.requests.snapshot(),
		"core":       object{"chatgpt": chat, "transport": object{"state": state, "error": failure}},
		"connection": object{"running": running || active, "updateAvailable": false, "mcpUrl": resource},
		"config":     config,
		"tunnel": object{"state": state, "error": failure, "health": health, "controlPlane": provider, "dependency": dependency,
			"lastError": lastError, "lastErrorAt": lastErrorAt},
		"connector": object{"state": state}, "logs": recentLogs(&i.id),
		"version": buildVersion, "platform": runtimePlatform(), "deviceName": deviceDisplayName(),
		"chatgptUrl": "https://chatgpt.com/plugins",
	}
}

func (i *networkIngress) summary(ctx context.Context) (object, error) {
	status := i.status()
	i.mu.RLock()
	entry, draft := i.entry, i.draft
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
	if entry["auth"] == "oauth" {
		i.oauth.mu.Lock()
		snapshot, err := i.oauth.snapshot(ctx)
		i.oauth.mu.Unlock()
		if err != nil {
			return nil, err
		}
		result["oauth"] = snapshot
	}
	if !draft && entry["auth"] != "oauth" && sourceAuthorityHandlers["ensure_ingress"] != nil {
		if _, err := requestSourceAuthority(ctx, i.owner.bridge, "ensure_ingress", object{"entry": entry}); err != nil {
			return nil, err
		}
	}
	if !draft && sourceAuthorityHandlers["connection_state"] != nil {
		if _, err := requestSourceAuthority(ctx, i.owner.bridge, "connection_state", object{"ingress": i.id, "connected": result["running"]}); err != nil {
			return nil, err
		}
	}
	sources := []any{}
	if !draft && sourceAuthorityHandlers["control_sources"] != nil {
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

// Provider implementations are owned by their transport module.
var startManagedIngress func(context.Context, *networkIngress, object) error

func (i *networkIngress) start(ctx context.Context) (err error) {
	i.mu.Lock()
	if i.retired {
		i.mu.Unlock()
		return errors.New("ingress removed or replaced")
	}
	entry, running := i.entry, i.running || i.providerStop != nil
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
	case config["connectionMode"] == "relay":
		return startRelayIngress(i, config)
	case config["connectionMode"] == "tunnel":
		return startOpenAITunnel(ctx, i, config)
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
	i.server, i.providerStop, i.providerStatus, i.officialTunnel = nil, nil, nil, nil
	i.mu.Unlock()
	if stop != nil {
		stop()
	}
	if server != nil {
		_ = server.Close()
	}
	i.mu.Lock()
	i.running, i.url, i.failure, i.lastError, i.lastErrorAt, i.providerStatus = false, "", "", "", nil, nil
	i.managedHealth, i.managedURLs = nil, nil
	i.mu.Unlock()
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
	draftCtx, cancelDrafts := context.WithCancel(ctx)
	g := &ingressGateway{ctx: draftCtx, owner: owner, entries: make(map[string]*networkIngress), drafts: make(map[string]*ingressDraft)}
	for _, row := range index {
		id := str(row)
		entry, err := loadIngressEntry(id)
		if err != nil {
			cancelDrafts()
			return fmt.Errorf("Load ingress %s: %w", id, err)
		}
		entry, err = normalizeIngressEntry(ctx, owner.bridge, entry)
		if err != nil {
			cancelDrafts()
			return fmt.Errorf("Normalize ingress %s: %w", id, err)
		}
		if g.entries[id], err = newNetworkIngress(owner, entry); err != nil {
			cancelDrafts()
			return err
		}
	}
	networkGateways.Store(owner, g)
	done := make(chan struct{})
	go func() {
		defer close(done)
		g.expireDrafts(draftCtx)
	}()
	owner.cleanup = append(owner.cleanup, func() {
		networkGateways.Delete(owner)
		cancelDrafts()
		<-done
		g.mu.Lock()
		for name, draft := range g.drafts {
			g.discardDraft(name, draft)
		}
		g.mu.Unlock()
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
