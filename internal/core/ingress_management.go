package core

import (
	"context"
	"errors"
	"maps"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

func (g *ingressGateway) update(ctx context.Context, i *networkIngress, patch object, rotate bool) (object, error) {
	i.lifecycle.Lock()
	defer i.lifecycle.Unlock()
	i.mu.RLock()
	previous, running, retired := i.entry, i.running, i.retired
	i.mu.RUnlock()
	if retired {
		return nil, errors.New("ingress removed or replaced")
	}
	entry := clone(previous)
	if rotate {
		if entry["auth"] != "bearer" {
			return nil, errors.New("token rotation requires auth=bearer")
		}
		entry["bearerToken"] = id() + id()
	} else {
		for key, value := range patch {
			if key != "config" {
				entry[key] = value
				continue
			}
			if config := obj(value); config != nil {
				maps.Copy(obj(entry["config"]), config)
			} else {
				return nil, errors.New("config must be an object")
			}
		}
	}
	if entry["id"] != i.id {
		return nil, errors.New("cannot change ingress id")
	}
	entry, err := normalizeIngressEntry(ctx, g.owner.bridge, entry)
	if err != nil {
		return nil, err
	}
	oldConfig, newConfig := obj(previous["config"]), obj(entry["config"])
	oldRuntime, newRuntime := maps.Clone(oldConfig), maps.Clone(newConfig)
	delete(oldRuntime, "autoStart")
	delete(newRuntime, "autoStart")
	changed := !maps.Equal(oldRuntime, newRuntime)
	for _, key := range []string{"transport", "enabled", "auth", "bearerToken"} {
		changed = changed || previous[key] != entry[key]
	}
	if changed {
		i.stop()
	}
	if err := saveIngressEntry(entry); err != nil {
		if changed && running {
			_ = i.start(ctx)
		}
		return nil, err
	}
	i.mu.Lock()
	i.entry = entry
	i.mu.Unlock()
	if changed {
		if entry["enabled"] != true {
			if err := rememberConnection(i.id, false); err != nil {
				return nil, err
			}
		}
		if entry["auth"] != previous["auth"] || entry["transport"] != previous["transport"] {
			i.oauth.mu.Lock()
			err := i.oauth.reset(ctx)
			i.oauth.mu.Unlock()
			if err != nil {
				return nil, err
			}
		}
		if ingressBinding(oldConfig) != ingressBinding(newConfig) ||
			entry["controlSource"] != previous["controlSource"] || entry["auth"] != previous["auth"] ||
			entry["transport"] != previous["transport"] || entry["bearerToken"] != previous["bearerToken"] {
			if err := i.resetVerification(); err != nil {
				return nil, err
			}
		}
		if running && entry["enabled"] == true {
			if err := i.start(ctx); err != nil {
				return nil, err
			}
		}
	}
	if rotate {
		return object{"id": i.id, "token": entry["bearerToken"], "delivery": "secret; store locally, do not paste into chat"}, nil
	}
	return i.summary(ctx)
}

func (g *ingressGateway) remove(ctx context.Context, i *networkIngress) (object, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	i.lifecycle.Lock()
	defer i.lifecycle.Unlock()
	if g.entries[i.id] != i {
		return nil, errors.New("ingress removed or replaced")
	}
	i.stop()
	if err := rememberConnection(i.id, false); err != nil {
		return nil, err
	}
	i.mu.Lock()
	i.retired = true
	entry := i.entry
	i.mu.Unlock()
	i.oauth.mu.Lock()
	defer i.oauth.mu.Unlock()
	pending := oauthIDValues(i.oauth.pendingIDs())
	if _, err := requestSourceAuthority(ctx, i.owner.bridge, "remove_connection", object{"entry": entry, "pending": pending}); err != nil {
		return nil, err
	}
	if err := i.oauth.reset(ctx); err != nil {
		return nil, err
	}
	ids := slices.DeleteFunc(g.ids(), func(id string) bool { return id == i.id })
	if err := save(filepath.Join(root(), "ingresses/index.json"), ids); err != nil {
		return nil, err
	}
	delete(g.entries, i.id)
	if err := os.RemoveAll(i.directory); err != nil {
		return nil, err
	}
	return object{"removed": i.id}, nil
}

func (g *ingressGateway) manage(ctx context.Context, method, route string, body object) (any, error) {
	if route == "ingress-drafts" || strings.HasPrefix(route, "ingress-drafts/") {
		return g.draftRoute(ctx, method, route, body)
	}
	if route == "_restore" || route == "_autostart" {
		return object{}, g.restore(ctx, route == "_autostart")
	}
	if route == "_network" {
		for _, i := range g.snapshot() {
			if err := i.changeNetworkPreferences(body); err != nil {
				return nil, err
			}
		}
		return object{"ok": true}, nil
	}
	if route == "_entries" {
		g.mu.RLock()
		defer g.mu.RUnlock()
		return g.ids(), nil
	}
	if action, primary := strings.CutPrefix(route, "_primary_request/"); primary {
		g.mu.RLock()
		ids := g.ids()
		g.mu.RUnlock()
		if len(ids) == 0 {
			switch method + " " + action {
			case "PUT config":
				return g.manage(ctx, method, "_initial_config", body)
			case "POST stop":
				return object{"ok": true}, nil
			default:
				return nil, errors.New("no ingresses; run cli ingress add --stdin")
			}
		}
		id := ids[0]
		if slices.Contains(ids, "default") {
			id = "default"
		}
		return g.manage(ctx, method, "_ingress_request/"+id+"/"+action, body)
	}
	if route == "_initial_config" {
		if len(g.snapshot()) != 0 {
			return nil, errors.New("ingress was created; refresh configuration")
		}
		transport, auth := "openai-tunnel", "openai"
		if body["connectionMode"] == "https" {
			transport, auth = "https", "none"
		}
		_, err := g.add(ctx, object{"id": "default", "name": "ChatGPT", "controlSource": "chatgpt", "transport": transport, "auth": auth, "config": body})
		return object{"ok": true}, err
	}
	if route == "ingress" {
		if method == http.MethodPost {
			return g.add(ctx, body)
		}
		entries := g.snapshot()
		rows := make([]object, 0, len(entries))
		for _, i := range entries {
			current, err := i.summary(ctx)
			if err != nil {
				return nil, err
			}
			rows = append(rows, current)
		}
		return rows, nil
	}
	if route == "ingress/start-all" || route == "ingress/stop-all" {
		start := route == "ingress/start-all"
		entries := g.snapshot()
		results := make([]object, len(entries))
		var jobs sync.WaitGroup
		for index, i := range entries {
			i.mu.RLock()
			enabled := i.entry["enabled"] == true
			i.mu.RUnlock()
			if start && !enabled {
				continue
			}
			jobs.Go(func() {
				err := i.setConnection(ctx, start)
				var message any
				if err != nil {
					message = err.Error()
				}
				results[index] = object{"id": i.id, "ok": err == nil, "error": message}
			})
		}
		jobs.Wait()
		return object{"results": slices.DeleteFunc(results, func(row object) bool { return row == nil })}, nil
	}
	prefix, path, _ := strings.Cut(route, "/")
	id, action, _ := strings.Cut(path, "/")
	i, err := g.get(id)
	if err != nil {
		return nil, err
	}
	switch prefix {
	case "_status":
		return i.status(), nil
	case "_relay_ready":
		wait, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		tick := time.NewTicker(100 * time.Millisecond)
		defer tick.Stop()
		for {
			i.mu.RLock()
			status, running := i.providerStatus, i.providerStop != nil
			i.mu.RUnlock()
			if status["state"] == "ready" {
				return object{}, nil
			}
			if !running {
				return nil, errors.New("Relay connection stopped")
			}
			select {
			case <-wait.Done():
				return nil, errors.New("Relay connection not ready: " + text(status, "error"))
			case <-tick.C:
			}
		}
	case "_entry":
		i.mu.RLock()
		defer i.mu.RUnlock()
		return object{"entry": i.entry, "connected": i.running, "url": i.url}, nil
	case "_verified":
		return object{}, i.observe("verifiedAt", now(), true)
	case "_event_active":
		i.mu.RLock()
		resource := i.url
		i.mu.RUnlock()
		return i.oauth.eventGrantActive(ctx, text(body, "principal"), resource), nil
	case "_connector_verify":
		i.mu.Lock()
		defer i.mu.Unlock()
		if body["code"] != i.verification["code"] {
			return nil, errors.New("Verification code does not match")
		}
		v := clone(i.verification)
		v["challengeVerifiedAt"] = now()
		v["verifiedAt"] = v["challengeVerifiedAt"]
		if err := save(filepath.Join(i.directory, "verification.json"), v); err != nil {
			return nil, err
		}
		i.verification = v
		return object{"code": body["code"], "received": true}, nil
	case "_ingress_request":
		return i.manageLegacy(ctx, method, action, body)
	}

	switch method + " " + action {
	case "GET ":
		return i.summary(ctx)
	case "PUT ", "POST token":
		return g.update(ctx, i, body, action == "token")
	case "DELETE ":
		return g.remove(ctx, i)
	case "POST start", "POST stop":
		return object{"ok": true}, i.setConnection(ctx, action == "start")
	case "POST restart":
		i.lifecycle.Lock()
		defer i.lifecycle.Unlock()
		i.mu.RLock()
		enabled, retired := i.entry["enabled"] == true, i.retired
		i.mu.RUnlock()
		if retired {
			return nil, errors.New("ingress removed or replaced")
		}
		if !enabled {
			return nil, errors.New("ingress disabled")
		}
		if err := rememberConnection(i.id, true); err != nil {
			return nil, err
		}
		i.stop()
		if err := i.start(ctx); err != nil {
			return nil, err
		}
		return i.summary(ctx)
	case "POST credentials":
		i.mu.RLock()
		defer i.mu.RUnlock()
		return object{"apiKey": field(i.entry["config"], "apiKey"), "bearerToken": i.entry["bearerToken"]}, nil
	case "POST verification/reset":
		return i.resetVerificationResult()
	case "POST probe":
		summary, err := i.summary(ctx)
		if err != nil {
			return nil, err
		}
		return probeIngress(ctx, summary, func(_ context.Context, field string, value object) error {
			return i.observe(field, value, false)
		})
	case "POST install":
		return i.installTunnel(ctx, body)
	default:
		return nil, errors.New("UNKNOWN_ROUTE")
	}
}

func (i *networkIngress) installTunnel(ctx context.Context, body object) (object, error) {
	if body["component"] != "tunnel" {
		return nil, errors.New("Install the official Codex Desktop")
	}
	i.lifecycle.Lock()
	defer i.lifecycle.Unlock()
	i.mu.RLock()
	config, running := obj(i.entry["config"]), i.running || i.providerStop != nil
	i.mu.RUnlock()
	i.stop()
	if _, err := i.prepareOfficialTunnel(ctx, config, true); err != nil {
		return nil, err
	}
	if running {
		if err := i.start(ctx); err != nil {
			return nil, err
		}
	}
	return object{"ok": true}, nil
}

func describeIngressDependency(ctx context.Context, binary string) object {
	if binary == "" {
		return object{"source": "missing", "path": nil, "version": "unknown"}
	}
	source := "external"
	if relative, err := filepath.Rel(root(), binary); err == nil &&
		relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		source = "managed"
	}
	version, _ := commandOutput(ctx, binary, "--version")
	return object{"source": source, "path": binary, "version": strings.TrimSpace(version)}
}

func (i *networkIngress) changeNetworkPreferences(body object) error {
	i.lifecycle.Lock()
	defer i.lifecycle.Unlock()
	i.mu.Lock()
	defer i.mu.Unlock()
	config := clone(obj(i.entry["config"]))
	mode, address := text(body, "proxyMode"), strings.TrimSpace(text(body, "proxyUrl"))
	if err := ingressValidateProxy(mode, address); err != nil {
		return err
	}
	config["proxyMode"], config["proxyUrl"] = mode, address
	next := clone(i.entry)
	next["config"] = config
	if err := saveIngressEntry(next); err != nil {
		return err
	}
	i.entry = next
	return nil
}

func (i *networkIngress) manageLegacy(ctx context.Context, method, action string, body object) (any, error) {
	switch method + " " + action {
	case "GET status":
		return i.status(), nil
	case "GET core":
		return i.status()["core"], nil
	case "GET config/credentials":
		i.mu.RLock()
		defer i.mu.RUnlock()
		config := i.entry["config"]
		result := object{"bearerToken": i.entry["bearerToken"]}
		for _, name := range ingressSecretFields() {
			result[name] = field(config, name)
		}
		return result, nil
	case "PUT network":
		return object{"ok": true}, i.changeNetworkPreferences(body)
	case "PUT config", "PATCH config/tunnel":
		return i.updateLegacyConfig(method, body)
	case "POST verification/reset":
		return i.resetVerificationResult()
	case "POST start", "POST stop":
		return object{"ok": true}, i.setConnection(ctx, action == "start")
	case "GET dependencies":
		i.mu.RLock()
		configured := text(i.entry["config"], "tunnelBinary")
		i.mu.RUnlock()
		tunnel, _ := exec.LookPath(configured)
		return object{"codex": describeIngressDependency(ctx, installedCodexCLI()),
			"tunnel": describeIngressDependency(ctx, tunnel), "observedAt": now()}, nil
	case "POST install":
		return i.installTunnel(ctx, body)
	default:
		return nil, errors.New("UNKNOWN_ROUTE")
	}
}

func (i *networkIngress) updateLegacyConfig(method string, body object) (object, error) {
	i.lifecycle.Lock()
	defer i.lifecycle.Unlock()
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.running || i.providerStop != nil {
		return nil, errors.New("Disconnect first")
	}
	previous := obj(i.entry["config"])
	var settings object
	if method == http.MethodPatch {
		settings = clone(previous)
		settings["connectionMode"] = "tunnel"
		for key, value := range body {
			if key != "tunnelId" && key != "apiKey" {
				return nil, errors.New("Only tunnelId and apiKey are accepted")
			}
			settings[key] = value
		}
	} else {
		settings = clone(body)
	}
	for _, raw := range obj(ingressDescriptor()["fields"]) {
		if flag := text(raw, "savedFlag"); flag != "" {
			delete(settings, flag)
		}
	}
	delete(settings, "configured")
	if err := ingressValidateConfig(settings); err != nil {
		return nil, err
	}
	for _, key := range ingressSecretFields() {
		if settings[key] == "" {
			settings[key] = previous[key]
		}
	}
	if !ingressConfigured(settings) {
		return nil, errors.New("Complete the selected connection method's settings")
	}
	next := clone(i.entry)
	next["config"] = settings
	switch settings["connectionMode"] {
	case "https", "relay":
		next["transport"] = settings["connectionMode"]
		if next["auth"] == "openai" {
			next["auth"] = "none"
		}
	default:
		next["transport"], next["auth"] = "openai-tunnel", "openai"
	}
	if err := saveIngressEntry(next); err != nil {
		return nil, err
	}
	i.entry = next
	if binding := ingressBinding(settings); binding != i.verification["binding"] {
		verification := object{"binding": binding, "code": id(), "verifiedAt": nil}
		if err := save(filepath.Join(i.directory, "verification.json"), verification); err != nil {
			return nil, err
		}
		i.verification = verification
	}
	return object{"ok": true}, nil
}

func gatewayIngressRoutes() {
	const ingress = `ingress/([A-Za-z0-9_-]{1,64})`
	definitions := map[string][]string{
		"GET": {`ingress`, `ingress-drafts/[A-Za-z0-9_-]{1,64}`, ingress,
			`_entries`, `_(?:entry|status|relay_ready|event_active)/[A-Za-z0-9_-]{1,64}`, `_ingress_request/[A-Za-z0-9_-]{1,64}/.+`},
		"POST": {`ingress`, `ingress-drafts`, `ingress-drafts/[A-Za-z0-9_-]{1,64}/commit`, `ingress/(?:start-all|stop-all)`, ingress + `/(?:start|stop|restart|token|credentials|verification/reset|probe|install)`,
			`_(?:restore|autostart|initial_config|network)`, `_(?:verified|connector_verify)/[A-Za-z0-9_-]{1,64}`, `_ingress_request/[A-Za-z0-9_-]{1,64}/.+`},
		"PUT":    {ingress, `_initial_config`, `_ingress_request/[A-Za-z0-9_-]{1,64}/.+`},
		"PATCH":  {`_ingress_request/[A-Za-z0-9_-]{1,64}/.+`},
		"DELETE": {ingress, `ingress-drafts/[A-Za-z0-9_-]{1,64}`},
	}
	for method, routes := range definitions {
		for _, pattern := range routes {
			// Capture the entire route for the owner. Core routes use the same names.
			registerGatewayRoute(method, "("+pattern+")", func(ctx context.Context, owner *gatewayOwner, body object, params []string) (any, error) {
				state, ok := networkGateways.Load(owner)
				if !ok {
					return nil, errors.New("core shutting down")
				}
				return state.(*ingressGateway).manage(ctx, method, params[0], body)
			})
			if strings.HasPrefix(pattern, "ingress") {
				registerRoutePattern(method, "("+pattern+")", func(ctx context.Context, _ *service, body object, params []string) (any, error) {
					return gatewayRequest(ctx, params[0], method, body)
				})
			}
		}
	}
}

func init() {
	gatewayIngressRoutes()
	for method, pattern := range map[string]string{
		http.MethodGet: "(config/credentials|dependencies)", http.MethodPut: "(config)", http.MethodPatch: "(config/tunnel)",
		http.MethodPost: "(start|stop|verification/reset|install)",
	} {
		registerGatewayRoute(method, "_primary_request/"+pattern, func(ctx context.Context, owner *gatewayOwner, body object, params []string) (any, error) {
			state, ok := networkGateways.Load(owner)
			if !ok {
				return nil, errors.New("core shutting down")
			}
			return state.(*ingressGateway).manage(ctx, method, "_primary_request/"+params[0], body)
		})
		registerRoutePattern(method, pattern, func(ctx context.Context, _ *service, body object, params []string) (any, error) {
			return gatewayRequest(ctx, "_primary_request/"+params[0], method, body)
		})
	}
	readIngressStatuses = func(ctx context.Context, _ *service) ([]object, error) {
		reply, err := gatewayRequest(ctx, "ingress", http.MethodGet, object{})
		if err != nil {
			return nil, err
		}
		rows := []object{}
		for _, item := range arr(reply) {
			rows = append(rows, obj(item))
		}
		return rows, nil
	}
	restoreRemoteConnections = func(ctx context.Context, _ *service) error {
		if _, err := gatewayRequest(ctx, "_peer_reconcile", http.MethodPost, object{}); err != nil {
			return err
		}
		_, err := gatewayRequest(ctx, "_restore", http.MethodPost, object{})
		return err
	}
	applyIngressNetworkPreferences = func(ctx context.Context, _ *service, body object) error {
		_, err := gatewayRequest(ctx, "_network", http.MethodPost, body)
		return err
	}
	registerServiceStartup(func(ctx context.Context, s *service) error {
		if s.metadata["daemon"] != true {
			return nil
		}
		_, err := gatewayRequest(ctx, "_autostart", http.MethodPost, object{})
		return err
	})
}
