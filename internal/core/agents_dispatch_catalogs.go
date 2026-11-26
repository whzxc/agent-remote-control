package core

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

var nativeAgentCatalogLock sync.Mutex

func nativeAgentCatalogPath(agent string) string {
	return filepath.Join(root(), "agents", "catalogs", agent+".json")
}

func nativeAgentCatalogSnapshot(facts object) object {
	catalog := clone(facts)
	catalog["authoritative"], catalog["scope"] = false, "catalog"
	delete(catalog, "taskId")
	delete(catalog, "modelConfigId")
	if model, ok := catalog["currentModel"]; ok {
		delete(catalog, "currentModel")
		catalog["optionsForModel"] = model
	}
	for _, row := range arr(catalog["options"]) {
		item := obj(row)
		if value, ok := item["currentValue"]; ok {
			delete(item, "currentValue")
			item["lastObservedValue"] = value
		}
	}
	return catalog
}

func nativeAgentCatalogTime(facts object) time.Time {
	value, _ := time.Parse(time.RFC3339Nano, text(facts, "observedAt"))
	return value
}

func nativeAgentCatalogChanged(old, candidate object) bool {
	if old == nil {
		return true
	}
	if len(arr(candidate["models"])) == 0 && len(arr(old["models"])) > 0 || nativeAgentCatalogTime(old).After(nativeAgentCatalogTime(candidate)) {
		return false
	}
	old, candidate = clone(old), clone(candidate)
	delete(old, "observedAt")
	delete(candidate, "observedAt")
	return wire(old) != wire(candidate)
}

func rememberNativeAgentCatalog(agent string, facts object) error {
	if _, ok := facts["models"].([]any); !ok || text(facts, "observedAt") == "" {
		return nil
	}
	candidate := nativeAgentCatalogSnapshot(facts)
	nativeAgentCatalogLock.Lock()
	defer nativeAgentCatalogLock.Unlock()
	path := nativeAgentCatalogPath(agent)
	stored, _ := cachedLoad(path)
	if nativeAgentCatalogChanged(obj(stored), candidate) {
		return save(path, candidate)
	}
	return nil
}

func nativeAgentSessionlessCatalog(ctx context.Context, agent string) (object, error) {
	var native object
	switch agent {
	case "grok":
		native = nativeGrokCatalog()
	case "pi":
		native = nativePiCatalog(ctx)
	}
	if native != nil {
		if err := rememberNativeAgentCatalog(agent, native); err != nil {
			return nil, err
		}
	}
	if stored, err := cachedLoad(nativeAgentCatalogPath(agent)); err == nil {
		catalog := obj(stored)
		if native != nil && !nativeAgentCatalogTime(catalog).After(nativeAgentCatalogTime(native)) {
			return native, nil
		}
		catalog = clone(catalog)
		catalog["authoritative"], catalog["catalogSource"], catalog["source"] = false, catalog["source"], "persistent-snapshot"
		return catalog, nil
	}
	return object{"authoritative": false, "unavailable": "needs-session",
		"nextAction": "No native catalog or saved snapshot; agent_create without prompt once, then dispatch_policy with agent and taskId"}, nil
}

func nativeCatalogHome(variable, fallback string) string {
	if path := os.Getenv(variable); path != "" {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, fallback)
}

func nativeGrokCatalog() object {
	home := nativeCatalogHome("GROK_HOME", ".grok")
	if home == "" {
		return nil
	}
	path := filepath.Join(home, "models_cache.json")
	value, err := cachedLoad(path)
	if err != nil {
		return nil
	}
	models := []any{}
	stored := obj(field(value, "models"))
	for _, id := range keys(stored) {
		info := field(stored[id], "info")
		if field(info, "hidden") == true {
			continue
		}
		efforts := []any{}
		for _, effort := range arr(field(info, "reasoning_efforts")) {
			if _, ok := field(effort, "value").(string); ok {
				efforts = append(efforts, object{"value": field(effort, "value"), "name": field(effort, "label")})
			}
		}
		row := object{"model": id, "name": field(info, "name"), "options": []any{object{"id": "reasoning_effort", "values": efforts}}}
		nativeAgentModelMetadata(row, info)
		models = append(models, row)
	}
	if len(models) == 0 {
		return nil
	}
	observed := text(value, "fetched_at")
	if observed == "" {
		stat, err := os.Stat(path)
		if err != nil {
			return nil
		}
		observed = stat.ModTime().UTC().Format(time.RFC3339Nano)
	}
	return object{"source": "grok-models-cache", "observedAt": observed, "scope": "catalog", "authoritative": false, "executionEvidence": false,
		"models": models, "options": []any{}, "optionsAvailability": "model-specific; see models[].options"}
}

func nativePiCatalog(ctx context.Context) object {
	home := nativeCatalogHome("PI_CODING_AGENT_DIR", ".pi/agent")
	if home == "" {
		return nil
	}
	auth := filepath.Join(home, "auth.json")
	providers, err := cachedLoad(auth)
	if err != nil {
		return nil
	}
	stat, err := os.Stat(auth)
	if err != nil {
		return nil
	}
	driver, _ := nativeAgentDriverByID("pi")
	binary := driver.discover(ctx).binary
	if binary == "" {
		return nil
	}
	binary, err = filepath.EvalSymlinks(binary)
	if err != nil {
		return nil
	}
	modules := filepath.Dir(binary)
	for filepath.Base(modules) != "node_modules" {
		parent := filepath.Dir(modules)
		if parent == modules {
			return nil
		}
		modules = parent
	}
	observed := stat.ModTime()
	models, seen := []any{}, map[string]bool{}
	for _, provider := range keys(obj(providers)) {
		if provider == "" || provider == "." || provider == ".." || strings.ContainsAny(provider, "/\\:") {
			continue
		}
		for _, pkg := range []string{"@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"} {
			for _, base := range []string{filepath.Join(modules, pkg, "node_modules"), modules} {
				for _, ai := range []string{"@earendil-works/pi-ai", "@mariozechner/pi-ai"} {
					file := filepath.Join(base, ai, "dist", "providers", "data", provider+".json")
					value, err := cachedLoad(file)
					if err != nil {
						continue
					}
					stat, err := os.Stat(file)
					if err != nil {
						return nil
					}
					if stat.ModTime().After(observed) {
						observed = stat.ModTime()
					}
					for _, group := range keys(obj(value)) {
						data := obj(field(value, group))
						for _, key := range keys(data) {
							model := data[key]
							id, kind := text(model, "id"), text(model, "type")
							if id != "" && (kind == "" || kind == "chat") && !seen[provider+"/"+id] {
								models = append(models, nativePiModel(model, provider))
								seen[provider+"/"+id] = true
							}
						}
					}
				}
			}
		}
	}
	if len(models) == 0 {
		return nil
	}
	return object{"source": "pi-installed-registry", "observedAt": observed.UTC().Format(time.RFC3339Nano),
		"scope": "catalog", "authoritative": false, "executionEvidence": false, "models": models, "options": []any{},
		"coverage": "installed registry for providers named in native auth.json", "optionsAvailability": "needs-session"}
}

func nativeCatalogProvider(data any) object {
	provider := field(data, "provider")
	id := str(dispatchFirstString(field(provider, "id"), provider, field(data, "providerId")))
	if id == "" {
		return nil
	}
	return object{"id": id, "name": dispatchFirstString(field(provider, "name"), field(data, "providerName"), id)}
}

func nativeAgentModelMetadata(row object, native any) {
	if name := text(native, "name"); name != "" {
		row["displayName"] = name
	}
	for _, data := range []any{native, field(native, "_meta")} {
		if row["provider"] == nil {
			if provider := nativeCatalogProvider(data); provider != nil {
				row["provider"] = provider
			}
		}
		if row["contextWindow"] != nil {
			continue
		}
		for _, key := range []string{"contextWindow", "totalContextTokens", "context_window", "contextWindows", "context_windows"} {
			value := field(data, key)
			entries := arr(value)
			if uintOr(value, 0) > 0 || len(entries) > 0 && !slices.ContainsFunc(entries, func(item any) bool { return uintOr(item, 0) == 0 }) {
				row["contextWindow"] = value
				break
			}
		}
	}
}

func nativePiModel(model any, provider string) object {
	row := object{"model": provider + "/" + text(model, "id"), "name": field(model, "name")}
	nativeAgentModelMetadata(row, model)
	if provider != "" && field(row["provider"], "id") != provider {
		row["provider"] = object{"id": provider, "name": provider}
	}
	return row
}

func nativeACPModel(model any, key string, group any, agent string) object {
	row := object{"model": field(model, key), "name": field(model, "name")}
	nativeAgentModelMetadata(row, model)
	if group != nil {
		row["group"] = field(group, "group")
		if row["provider"] == nil {
			meta := field(group, "_meta")
			provider := nativeCatalogProvider(group)
			if provider == nil {
				provider = nativeCatalogProvider(meta)
			}
			if provider == nil && (agent == "dsh" || field(group, "category") == "provider" || field(meta, "category") == "provider") {
				if id := text(group, "group"); id != "" {
					provider = object{"id": id, "name": dispatchFirstString(field(group, "name"), id)}
				}
			}
			if provider != nil {
				row["provider"] = provider
			}
		}
	}
	return row
}
