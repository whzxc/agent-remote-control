package core

import (
	"context"
	"errors"
	"time"
)

func accountLoginProgress(progress object) object {
	progress["loginId"] = progress["id"]
	delete(progress, "id")
	if profile, ok := progress["accountId"].(string); ok {
		if rows, err := readAccounts(); err == nil {
			if row := ownerOfAccountProfile(rows, profile); row != nil {
				progress["accountId"] = row["id"]
			}
		}
	}
	progress["kind"] = "claude"
	return progress
}

func (manager *accountManager) loginOperation(ctx context.Context, name string, args object) (object, error) {
	if name == "account_login" {
		action := text(args, "action")
		if action != "code" && action != "cancel" {
			return nil, errors.New("INVALID_LOGIN_ACTION: Use code or cancel")
		}
		result, err := manager.claude.request(ctx, "profiles/login/"+action, "POST", args)
		if _, ok := result["id"].(string); err == nil && ok {
			result = accountLoginProgress(result)
		}
		return result, err
	}
	manager.claude.mu.Lock()
	active := manager.claude.login.active()
	manager.claude.mu.Unlock()
	if active {
		return nil, errors.New("ACCOUNT_LOGIN_IN_PROGRESS: Complete or cancel the active login")
	}
	kind := text(args, "kind")
	body := object{}
	if name == "account_reauth" {
		row, err := resolveAccount(text(args, "id"))
		if err != nil {
			return nil, err
		}
		if !liveAccount(row) {
			return nil, errors.New("ACCOUNT_REMOVED")
		}
		if args["agent"] != "claude" {
			return nil, errors.New("ACCOUNT_AGENT_UNSUPPORTED: Only Claude L1 notification profiles support reauthentication")
		}
		profile := find(accountProfiles(row), "agent", "claude")
		if profile == nil {
			return nil, errors.New("ACCOUNT_AGENT_MISSING")
		}
		kind, body["accountId"] = "claude", profile["profileId"]
	}
	if browser, ok := args["browserId"]; ok {
		body["browserId"] = browser
	}
	switch kind {
	case "claude":
		result, err := manager.claude.request(ctx, "profiles/login", "POST", body)
		if err != nil {
			return nil, err
		}
		if err := reconcileAccounts(); err != nil {
			return nil, err
		}
		return accountLoginProgress(result), nil
	case "detect":
		failures := []string{}
		if findAccountAgent("claude") != "" {
			if _, err := manager.claude.request(ctx, "profiles/import-system", "POST", object{}); err != nil {
				failures = append(failures, err.Error())
			}
		}
		manager.refresh.Lock()
		manager.lastRefresh = time.Time{}
		manager.refresh.Unlock()
		if err := manager.refreshAccounts(ctx); err != nil {
			return nil, err
		}
		return object{"loginId": id(), "kind": kind, "state": "completed", "errors": failures}, nil
	default:
		return nil, errors.New("ACCOUNT_KIND_UNSUPPORTED: Use claude for L1 notification profiles or detect")
	}
}
