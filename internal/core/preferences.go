package core

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
)

var preferenceLock sync.Mutex

func preferenceDefaults() object {
	return object{"maintainer-mode": "off", "mcp-services": "off", "device-link": "off", "theme": "system", "theme-color": "arc", "language": "auto", "notifications": "on", "update-skipped-version": "", "update-last-check": "0", "quota-display": "remaining", "quota-reset-display": "countdown", "agents-max-visible": "4"}
}

func storedPreferences(path string) object {
	if value, err := load(path); err == nil {
		return obj(value)
	}
	return object{"values": object{}, "imported": false}
}

func effectivePreferences(stored object) object {
	values := preferenceDefaults()
	for key, value := range obj(stored["values"]) {
		values[key] = value
	}
	return values
}

func readPreferences() object {
	preferenceLock.Lock()
	defer preferenceLock.Unlock()
	return effectivePreferences(storedPreferences(filepath.Join(root(), "ui-preferences.json")))
}

func changePreferences(body object, importing bool) (object, error) {
	preferenceLock.Lock()
	defer preferenceLock.Unlock()
	path := filepath.Join(root(), "ui-preferences.json")
	stored := storedPreferences(path)
	if importing && stored["imported"] == true {
		return effectivePreferences(stored), nil
	}
	values := obj(stored["values"])
	if values == nil {
		return nil, errors.New("invalid preference store")
	}
	patch := obj(body["values"])
	if patch == nil {
		return nil, errors.New("values must be an object")
	}
	for _, key := range keys(patch) {
		value := patch[key]
		if (key == "maintainer-mode" || key == "device-link") && value != nil && value != "on" && value != "off" {
			return nil, errors.New("INVALID_ARGUMENT: Experimental preferences must be on or off")
		}
		serialized, valid := value.(string)
		if len(key) > 128 || value != nil && (!valid || len(serialized) > 16384) {
			return nil, errors.New("invalid preference")
		}
		if _, exists := values[key]; importing && exists {
			continue
		}
		if value == nil {
			delete(values, key)
		} else {
			values[key] = value
		}
	}
	if importing {
		stored["imported"] = true
	}
	if err := save(path, stored); err != nil {
		return nil, err
	}
	return effectivePreferences(stored), nil
}

var preferenceChanges []func(context.Context, object, object) error

func registerPreferenceChange(change func(context.Context, object, object) error) {
	preferenceChanges = append(preferenceChanges, change)
}

func updatePreferences(ctx context.Context, body object, importing bool) (object, error) {
	before := readPreferences()
	after, err := changePreferences(body, importing)
	if err != nil {
		return nil, err
	}
	for _, change := range preferenceChanges {
		if err := change(ctx, before, after); err != nil {
			return nil, err
		}
	}
	return after, nil
}

func init() {

	registerManagementCatalog(func(result object) { result["preferenceDefaults"] = preferenceDefaults() })
	registerRoute("GET", "preferences", func(_ context.Context, _ *service, _ object, _ []string) (any, error) { return readPreferences(), nil })
	registerRoute("PUT", "preferences", func(ctx context.Context, _ *service, body object, _ []string) (any, error) {
		return updatePreferences(ctx, body, false)
	})
	registerRoute("POST", "preferences/import", func(ctx context.Context, _ *service, body object, _ []string) (any, error) {
		return updatePreferences(ctx, body, true)
	})
}
