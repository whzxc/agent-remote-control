package core

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

const desktopPermissionShared = "electron-persisted-atom-state"
const desktopPermissionOwner = "electron-renderer-content-owner"
const desktopPermissionSelection = "permission-selection-by-host-id:local"
const desktopPermissionMode = "agent-mode-by-host-id"
const desktopPermissionDerived = "config-derived-agent-mode-by-host-id"

var desktopPermissionAtoms = []string{desktopPermissionSelection, desktopPermissionMode, desktopPermissionDerived}

func readDesktopPermissionAtoms(ctx context.Context, home string) (object, error) {
	path := filepath.Join(home, ".codex-global-state.sqlite")
	if _, err := os.Stat(path); err == nil {
		uri := url.URL{Scheme: "file", Path: filepath.ToSlash(path), RawQuery: "mode=ro"}
		db, err := sql.Open("sqlite", uri.String())
		if err != nil {
			return nil, err
		}
		defer db.Close()
		tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		read := func(scope, key string) (any, bool, error) {
			var raw string
			err := tx.QueryRowContext(ctx, "SELECT value FROM settings WHERE scope=?1 AND key=?2", scope, key).Scan(&raw)
			if errors.Is(err, sql.ErrNoRows) {
				return nil, false, nil
			}
			if err != nil {
				return nil, false, err
			}
			var value any
			if err := unmarshalJSON([]byte(raw), &value); err != nil {
				return nil, false, errors.New("DESKTOP_SETTING_INVALID")
			}
			return value, true, nil
		}
		owner, _, err := read("global", desktopPermissionOwner)
		if err != nil {
			return nil, err
		}
		result := object{}
		for _, key := range desktopPermissionAtoms {
			value, found, err := read("atom", key)
			if err != nil {
				return nil, err
			}
			if !found {
				if id, ok := owner.(string); ok {
					value, _, err = read("electron-owner-atoms:"+id, key)
					if err != nil {
						return nil, err
					}
				}
			}
			result[key] = value
		}
		return result, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	path = filepath.Join(home, ".codex-global-state.json")
	read := func(path string) (object, error) {
		state, err := load(path)
		if err != nil {
			return nil, err
		}
		if state := obj(state); state != nil {
			return state, nil
		}
		return nil, errors.New("DESKTOP_SETTINGS_INVALID")
	}
	state, err := read(path)
	if err != nil {
		backup, backupErr := read(path + ".bak")
		if errors.Is(err, os.ErrNotExist) && errors.Is(backupErr, os.ErrNotExist) {
			return object{}, nil
		}
		if backupErr != nil {
			return nil, backupErr
		}
		state = backup
	}
	var owned object
	if owner, ok := state[desktopPermissionOwner].(string); ok {
		owned = obj(state["electron-owner-atoms:"+owner])
	}
	shared := obj(state[desktopPermissionShared])
	result := object{}
	for _, key := range desktopPermissionAtoms {
		if value, ok := shared[key]; ok {
			result[key] = value
		} else {
			result[key] = owned[key]
		}
	}
	return result, nil
}

func desktopSavedPermissions(atoms object, project bool) object {
	legacy, known := field(atoms[desktopPermissionMode], "local").(string)
	modern := obj(atoms[desktopPermissionSelection])
	mode, selected := modern["agentMode"].(string)
	if !known || !selected || field(atoms[desktopPermissionDerived], "local") == legacy || modern["kind"] != "agent-mode" {
		return nil
	}
	normalize := func(value string) string {
		if value == "auto" || value == "granular" {
			if project {
				return "auto"
			}
			return "granular"
		}
		return value
	}
	mode = normalize(mode)
	if mode != normalize(legacy) {
		return nil
	}
	result := object{"permissions": ":workspace", "approvalPolicy": "on-request", "approvalsReviewer": "user"}
	switch mode {
	case "read-only":
		result["permissions"] = ":read-only"
	case "full-access":
		result["permissions"], result["approvalPolicy"] = ":danger-full-access", "never"
	case "guardian-approvals":
		result["approvalsReviewer"] = "guardian_subagent"
	case "auto":
	case "granular":
		result["approvalPolicy"] = object{"granular": object{"sandbox_approval": false, "rules": false, "skill_approval": false,
			"request_permissions": true, "mcp_elicitations": true}}
	default:
		return nil
	}
	return result
}

func applyNativeDesktopPermissions(ctx context.Context, rpc *rpcConnection, args, seed object) error {
	if args["mode"] != nil || seed["permissions"] != nil || seed["sandbox"] != nil ||
		field(args["turn"], "permissions") != nil || field(args["turn"], "sandboxPolicy") != nil {
		return nil
	}
	config := obj(seed["config"])
	for _, key := range []string{"sandbox_mode", "default_permissions", "permissions"} {
		if config[key] != nil {
			return nil
		}
	}
	_, home, err := codexInputs()
	if err != nil {
		return err
	}
	atoms, err := readDesktopPermissionAtoms(ctx, home)
	if err != nil {
		return err
	}
	_, project := seed["cwd"].(string)
	saved := desktopSavedPermissions(atoms, project)
	if saved == nil {
		return nil
	}
	call := func(method string, args object) (any, error) { return rpc.call(ctx, method, args, 5*time.Second) }
	loaded, err := call("configRequirements/read", object{})
	if err != nil {
		return err
	}
	requirements := obj(field(loaded, "requirements"))
	if models := arr(field(requirements["autoReview"], "requiredOnModels")); len(models) != 0 {
		model := text(seed, "model")
		if model == "" {
			merged, err := call("config/read", object{"cwd": seed["cwd"], "includeLayers": false})
			if err != nil {
				return err
			}
			merged = field(merged, "config")
			active := field(field(merged, "profiles"), text(merged, "profile"))
			model = nonemptyTaskText(text(active, "model"), text(merged, "model"))
			if model == "" {
				page, err := call("model/list", object{})
				if err != nil {
					return err
				}
				for _, row := range arr(field(page, "data")) {
					if field(row, "isDefault") == true {
						model = text(row, "model")
						break
					}
				}
				if model == "" {
					return errors.New("DESKTOP_DEFAULT_MODEL_UNKNOWN")
				}
			}
		}
		if _, name, ok := strings.Cut(model, "/"); ok {
			model = name
		}
		if slices.Contains(models, any(model)) {
			saved = object{"permissions": ":workspace", "approvalPolicy": "on-request", "approvalsReviewer": "guardian_subagent"}
		}
	}
	var cursor any
	seen := map[string]bool{}
	for {
		page, err := call("permissionProfile/list", object{"cwd": seed["cwd"], "cursor": cursor})
		if err != nil {
			return err
		}
		rows := arr(field(page, "data"))
		if rows == nil {
			return errors.New("DESKTOP_PERMISSION_LIST_INVALID")
		}
		if profile := find(rows, "id", text(saved, "permissions")); profile != nil {
			if profile["allowed"] != true {
				return nil
			}
			break
		}
		cursor = field(page, "nextCursor")
		if cursor == nil {
			return nil
		}
		key := wire(cursor)
		if seen[key] {
			return errors.New("DESKTOP_PERMISSION_CURSOR_REPEATED")
		}
		seen[key] = true
	}
	policy := map[string]string{"approvalPolicy": "allowedApprovalPolicies", "approvalsReviewer": "allowedApprovalsReviewers"}
	for key, list := range policy {
		if choices := arr(requirements[list]); choices != nil && !slices.ContainsFunc(choices, func(value any) bool {
			return wire(value) == wire(saved[key])
		}) {
			return nil
		}
	}
	configKeys := map[string]string{"approvalPolicy": "approval_policy", "approvalsReviewer": "approvals_reviewer", "permissions": "default_permissions"}
	for key, value := range saved {
		if seed[key] == nil && config[configKeys[key]] == nil {
			seed[key] = value
		}
	}
	return nil
}
