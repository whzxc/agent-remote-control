package core

import (
	"errors"
	"os"
	"path/filepath"
	"sync"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

var claudeRoutesWriter sync.Mutex
var claudeRouteMigration sync.Mutex
var normalizeClaudeNotificationTarget func(string) (string, error)

func claudeRoutePath() (string, error) {
	claudeRouteMigration.Lock()
	defer claudeRouteMigration.Unlock()
	path := filepath.Join(root(), "accounts/routes.json")
	old := filepath.Join(claudeAccountsDir(), "routes.json")
	if _, oldErr := os.Stat(old); oldErr == nil {
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			if err := platform.PrivateDir(filepath.Dir(path)); err != nil {
				return "", err
			}
			if err := os.Rename(old, path); err != nil {
				return "", err
			}
		}
	}
	return path, nil
}

func claudeNotificationRoutes() (map[string]string, error) {
	path, err := claudeRoutePath()
	if err != nil {
		return nil, err
	}
	routes := map[string]string{}
	value, err := load(path)
	if errors.Is(err, os.ErrNotExist) {
		return routes, nil
	}
	if err != nil {
		return nil, err
	}
	entries := obj(value)
	if entries == nil {
		return nil, errors.New("CLAUDE_ROUTES_INVALID: Repair the local Claude notification routes")
	}
	for target, raw := range entries {
		id, ok := raw.(string)
		if !ok {
			return nil, errors.New("CLAUDE_ROUTES_INVALID: Repair the local Claude notification routes")
		}
		routes[target] = id
	}
	return routes, nil
}

func legacyClaudeNotificationAccount(target string) (string, error) {
	routes, err := claudeNotificationRoutes()
	if err != nil {
		return "", err
	}
	if profile, ok := routes[target]; ok {
		return profile, nil
	}
	return initialClaudeAccount()
}

func bindClaudeNotificationRoute(target, account string, replace bool) (object, error) {
	if normalizeClaudeNotificationTarget == nil {
		return nil, errors.New(PortPending)
	}
	target, err := normalizeClaudeNotificationTarget(target)
	if err != nil {
		return nil, err
	}
	if _, err := claudeProfileConfig(account); err != nil {
		return nil, err
	}
	claudeRoutesWriter.Lock()
	defer claudeRoutesWriter.Unlock()
	routes, err := claudeNotificationRoutes()
	if err != nil {
		return nil, err
	}
	if old, ok := routes[target]; ok && old != account && !replace {
		return nil, errors.New("CLAUDE_ACCOUNT_ROUTE_CONFLICT: This target is assigned to another profile. Inspect accounts.routes and use accounts.route to explicitly change its account before sending")
	}
	routes[target] = account
	path, err := claudeRoutePath()
	if err != nil {
		return nil, err
	}
	if err := save(path, routes); err != nil {
		return nil, err
	}
	return object{"target": target, "accountId": account}, nil
}

func migrateDefaultClaudeRoute(account string) error {
	claudeRoutesWriter.Lock()
	defer claudeRoutesWriter.Unlock()
	routes, err := claudeNotificationRoutes()
	if err != nil {
		return err
	}
	changed := false
	for target, profile := range routes {
		if profile == "default" {
			routes[target], changed = account, true
		}
	}
	if !changed {
		return nil
	}
	path, err := claudeRoutePath()
	if err != nil {
		return err
	}
	return save(path, routes)
}
