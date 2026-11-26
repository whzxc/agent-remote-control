package core

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

type ingressDraft struct {
	ingress *networkIngress
	last    time.Time
	cancel  context.CancelFunc
	done    chan struct{}
}

func (g *ingressGateway) createDraft(ctx context.Context, body object) (object, error) {
	config := clone(obj(body["config"]))
	if config == nil || !slices.Contains([]string{"cloudflare", "ngrok", "pinggy", "localxpose"}, text(config, "httpsProvider")) {
		return nil, errors.New("managed HTTPS provider required")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.drafts) >= 8 {
		return nil, errors.New("too many pending connections")
	}
	hold, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	config["httpsHost"], config["httpsPort"] = "127.0.0.1", hold.Addr().(*net.TCPAddr).Port
	hold.Close()
	if !(config["httpsProvider"] == "pinggy" && config["pinggyMode"] == "named" || config["httpsProvider"] == "localxpose") {
		config["httpsUrl"] = ""
	}
	entry, err := normalizeIngressEntry(ctx, g.owner.bridge, object{"id": "draft-" + id(), "name": "Pending connection",
		"controlSource": "custom", "transport": "https", "enabled": true, "auth": "bearer", "bearerToken": id() + id(),
		"toolPolicy": object{"allowlist": []any{}}, "config": config})
	if err != nil {
		return nil, err
	}
	i, err := newNetworkIngress(g.owner, entry)
	if err != nil {
		return nil, err
	}
	i.draft, i.starting = true, true
	wait, cancel := context.WithCancel(g.ctx)
	draft := &ingressDraft{ingress: i, last: time.Now(), cancel: cancel, done: make(chan struct{})}
	g.drafts[i.id] = draft
	go func() {
		defer close(draft.done)
		i.lifecycle.Lock()
		defer i.lifecycle.Unlock()
		_ = i.start(wait)
		i.mu.Lock()
		i.starting = false
		i.mu.Unlock()
	}()
	return i.summary(ctx)
}

func (g *ingressGateway) draftRoute(ctx context.Context, method, route string, body object) (any, error) {
	if route == "ingress-drafts" {
		return g.createDraft(ctx, body)
	}
	path, _ := strings.CutPrefix(route, "ingress-drafts/")
	name, action, _ := strings.Cut(path, "/")
	if err := validateIngressID(name); err != nil {
		return nil, err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	draft := g.drafts[name]
	if method == http.MethodDelete && action == "" {
		if draft != nil {
			g.discardDraft(name, draft)
		}
		return object{"removed": name}, nil
	}
	if draft == nil {
		return nil, errors.New("pending connection expired; obtain the MCP URL again")
	}
	draft.last = time.Now()
	i := draft.ingress
	if method == http.MethodGet && action == "" {
		return i.summary(ctx)
	}
	select {
	case <-draft.done:
	default:
		return nil, errors.New("MCP URL is not ready")
	}
	i.lifecycle.Lock()
	defer i.lifecycle.Unlock()
	i.mu.RLock()
	entry, health, resource, urls := clone(i.entry), i.managedHealth, i.url, i.managedURLs
	i.mu.RUnlock()
	for _, key := range []string{"name", "controlSource", "auth", "bearerToken"} {
		if value, ok := body[key]; ok {
			entry[key] = value
		}
	}
	if !slices.Contains([]string{"none", "bearer", "oauth"}, text(entry, "auth")) {
		return nil, errors.New("invalid authentication")
	}
	entry["toolPolicy"] = body["toolPolicy"]
	if entry["toolPolicy"] == nil {
		entry["toolPolicy"] = defaultPolicy()
	}
	address := text(body, "url")
	obj(entry["config"])["httpsUrl"] = address
	entry, err := normalizeIngressEntry(ctx, g.owner.bridge, entry)
	if err != nil {
		return nil, err
	}
	if health == nil {
		return nil, errors.New("MCP URL is not ready")
	}
	if health["state"] != "ready" || address == "" || address != resource && !slices.Contains(urls, address) {
		return nil, errors.New("MCP URL is no longer available; obtain it again")
	}
	if err := saveIngressEntry(entry); err != nil {
		return nil, err
	}
	if err := save(filepath.Join(root(), "ingresses/index.json"), append(g.ids(), name)); err != nil {
		return nil, err
	}
	draft.cancel()
	i.mu.Lock()
	i.entry, i.url, i.draft = entry, address, false
	i.mu.Unlock()
	g.entries[name] = i
	delete(g.drafts, name)
	return i.summary(ctx)
}

func (g *ingressGateway) discardDraft(name string, draft *ingressDraft) {
	delete(g.drafts, name)
	draft.cancel()
	<-draft.done
	i := draft.ingress
	i.lifecycle.Lock()
	defer i.lifecycle.Unlock()
	i.mu.Lock()
	i.retired = true
	i.mu.Unlock()
	i.stop()
	_ = os.RemoveAll(i.directory)
}

func (g *ingressGateway) expireDrafts(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			g.mu.Lock()
			for name, draft := range g.drafts {
				recordRuntimeWork(ctx, runtimeWorkCost{Owner: "draft-expiry", Reason: "timer", Rows: 1, ScanSet: 1})
				if time.Since(draft.last) >= 120*time.Second {
					g.discardDraft(name, draft)
				}
			}
			g.mu.Unlock()
		}
	}
}
