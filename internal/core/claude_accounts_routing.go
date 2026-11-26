package core

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

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

func runClaudeNotification(ctx context.Context, profile string, args []string) ([]byte, error) {
	wait, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd, err := claudeAccountCommand(wait, profile, args...)
	if err != nil {
		return nil, err
	}
	output, err := cmd.Output()
	if errors.Is(wait.Err(), context.DeadlineExceeded) {
		return nil, errors.New("CLAUDE_SEND_TIMEOUT")
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		if notificationSessionNotFound(string(output)) || notificationSessionNotFound(string(exit.Stderr)) {
			return nil, errors.New("CLAUDE_SESSION_NOT_FOUND: Session not found")
		}
		stderr := []rune(string(exit.Stderr))
		return nil, fmt.Errorf("CLAUDE_SEND_FAILED: exit %d; %s", exit.ExitCode(), string(stderr[:min(len(stderr), 2000)]))
	}
	if err != nil {
		return nil, fmt.Errorf("CLAUDE_SEND_FAILED: %w", err)
	}
	return output, nil
}

func claudeNotificationIdentity(ctx context.Context, profile string) (object, error) {
	facts, err := refreshClaudeAccount(ctx, profile)
	if err != nil {
		return nil, nil
	}
	if err := reconcileAccounts(); err != nil {
		return nil, err
	}
	if facts["loggedIn"] != true || accountIdentityKey("anthropic", facts) == "" {
		return nil, nil
	}
	rows, err := readAccounts()
	if err != nil {
		return nil, err
	}
	account := ownerOfAccountProfile(rows, profile)
	if account == nil {
		return nil, errors.New("ACCOUNT_PROFILE_NOT_FOUND")
	}
	return object{"kind": "claude-session-handshake", "profileId": profile, "accountId": account["id"],
		"identityKey": account["identityKey"], "orgId": facts["orgId"]}, nil
}

func init() {
	normalizeClaudeNotificationTarget = notificationSessionID
	notificationClaudeProfile = accountClaudeProfile
	notificationClaudePublicAccount = func(profile string) object {
		accounts, _ := readAccounts()
		return ownerOfAccountProfile(accounts, profile)
	}
	notificationClaudeProfiles = notificationProviderAccounts
	notificationClaudeCandidates = func(ctx context.Context, target string) ([]any, error) {
		profiles, err := claudeVisibilityCandidates(ctx, target)
		candidates := make([]any, len(profiles))
		for i, profile := range profiles {
			candidates[i] = profile
		}
		return candidates, err
	}
	notificationClaudeLegacyRoute = func(target string) (string, error) {
		routes, err := claudeNotificationRoutes()
		return routes[target], err
	}
	notificationLegacyVerifiedAccount = legacyClaudeNotificationAccount
	notificationClaudeIdentity = claudeNotificationIdentity
	notificationClaudeIdentityStatus = claudeAccountIdentity
	notificationConfirmIdentity = confirmControlSourceAccount
	notificationSourceRows = liveSourceAccounts
	notificationClaudeRun = runClaudeNotification
	notificationAccountBind = func(_ context.Context, target, profile string) error {
		_, err := bindClaudeNotificationRoute(target, profile, false)
		return err
	}
}
