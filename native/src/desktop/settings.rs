//! Read the local Desktop's saved permission selection. The native backend
//! resolves the project config, requirements, account, plugins and MCP servers.
use crate::*;
use rusqlite::{Connection, OpenFlags, OptionalExtension};

const SHARED: &str = "electron-persisted-atom-state";
const OWNER: &str = "electron-renderer-content-owner";
const SELECTION: &str = "permission-selection-by-host-id:local";
const MODE: &str = "agent-mode-by-host-id";
const DERIVED: &str = "config-derived-agent-mode-by-host-id";

fn permission_atoms(home: &Path) -> Result<Value> {
    let db = home.join(".codex-global-state.sqlite");
    let mut atoms = json!({});
    if db.try_exists().map_err(|e| e.to_string())? {
        let mut db = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        let snapshot = db.transaction().map_err(|e| e.to_string())?;
        let read = |scope: &str, key: &str| -> Result<Option<Value>> {
            let encoded: Option<String> = snapshot
                .query_row(
                    "SELECT value FROM settings WHERE scope=?1 AND key=?2",
                    [scope, key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            encoded
                .map(|s| serde_json::from_str(&s).map_err(|_| "DESKTOP_SETTING_INVALID".to_owned()))
                .transpose()
        };
        let owner = read("global", OWNER)?
            .and_then(|v| v.as_str().map(|s| format!("electron-owner-atoms:{s}")));
        for key in [SELECTION, MODE, DERIVED] {
            atoms[key] = match read("atom", key)? {
                Some(value) => value,
                None => match owner.as_ref() {
                    Some(scope) => read(scope, key)?.unwrap_or_default(),
                    None => Value::Null,
                },
            };
        }
    } else {
        let path = home.join(".codex-global-state.json");
        let backup = home.join(".codex-global-state.json.bak");
        if !path.try_exists().map_err(|e| e.to_string())?
            && !backup.try_exists().map_err(|e| e.to_string())?
        {
            return Ok(atoms);
        }
        let read = |path: &Path| {
            let state = load(path)?;
            if state.is_object() {
                Ok(state)
            } else {
                Err("DESKTOP_SETTINGS_INVALID".to_owned())
            }
        };
        let state = read(&path).or_else(|_| read(&backup))?;
        let owned = state[OWNER]
            .as_str()
            .and_then(|id| state.get(format!("electron-owner-atoms:{id}")));
        for key in [SELECTION, MODE, DERIVED] {
            if let Some(value) = state[SHARED]
                .get(key)
                .or_else(|| owned.and_then(|v| v.get(key)))
            {
                atoms[key] = value.clone();
            }
        }
    }
    Ok(atoms)
}

/// A saved override requires agreement on the local host. Returning None
/// leaves thread/start to resolve permissions from native project configuration.
fn saved_permissions(atoms: &Value, project: bool) -> Option<Value> {
    let legacy = atoms[MODE]["local"].as_str()?;
    let modern = &atoms[SELECTION];
    if atoms[DERIVED]["local"] == legacy || modern["kind"] != "agent-mode" {
        return None;
    }
    fn normalize(mode: &str, project: bool) -> &str {
        match (mode, project) {
            ("auto" | "granular", true) => "auto",
            ("auto" | "granular", false) => "granular",
            _ => mode,
        }
    }
    let mode = normalize(modern["agentMode"].as_str()?, project);
    if mode != normalize(legacy, project) {
        return None;
    }
    let (profile, policy, reviewer) = match mode {
        "read-only" => (":read-only", json!("on-request"), "user"),
        "full-access" => (":danger-full-access", json!("never"), "user"),
        "guardian-approvals" => (":workspace", json!("on-request"), "guardian_subagent"),
        "auto" => (":workspace", json!("on-request"), "user"),
        "granular" => (
            ":workspace",
            json!({"granular":{"sandbox_approval":false,
            "rules":false,"skill_approval":false,"request_permissions":true,"mcp_elicitations":true}}),
            "user",
        ),
        _ => return None,
    };
    Some(json!({"permissions":profile,"approvalPolicy":policy,"approvalsReviewer":reviewer}))
}

pub(crate) async fn apply(rpc: &rpc::Rpc, dispatch: &Value, seed: &mut Value) -> Result<()> {
    if !dispatch["mode"].is_null()
        || ["permissions", "sandbox"]
            .iter()
            .any(|k| !seed[*k].is_null())
        || ["permissions", "sandboxPolicy"]
            .iter()
            .any(|k| !dispatch["turn"][*k].is_null())
        || ["sandbox_mode", "default_permissions", "permissions"]
            .iter()
            .any(|k| !seed["config"][*k].is_null())
    {
        return Ok(());
    }
    let home = accounts::codex::default_home()?;
    let atoms = permission_atoms(&home)?;
    let Some(mut saved) = saved_permissions(&atoms, seed["cwd"].is_string()) else {
        return Ok(());
    };
    let requirements = rpc.call("configRequirements/read", json!({}), 5000).await?;
    if let Some(models) = requirements
        .pointer("/requirements/autoReview/requiredOnModels")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty())
    {
        let model = match seed["model"].as_str() {
            Some(model) => model.to_owned(),
            None => {
                let config = rpc
                    .call(
                        "config/read",
                        json!({"cwd":seed["cwd"], "includeLayers":false}),
                        5000,
                    )
                    .await?;
                let config = &config["config"];
                let profile = string(config, "profile");
                if let Some(model) = config["profiles"][profile]["model"]
                    .as_str()
                    .or(config["model"].as_str())
                {
                    model.to_owned()
                } else {
                    let list = rpc.call("model/list", json!({}), 5000).await?;
                    list["data"]
                        .as_array()
                        .and_then(|rows| rows.iter().find(|m| m["isDefault"] == true))
                        .and_then(|m| m["model"].as_str())
                        .ok_or("DESKTOP_DEFAULT_MODEL_UNKNOWN")?
                        .to_owned()
                }
            }
        };
        let name = model
            .split_once('/')
            .map_or(model.as_str(), |(_, name)| name);
        if models.iter().any(|required| required == name) {
            saved = json!({"permissions":":workspace","approvalPolicy":"on-request","approvalsReviewer":"guardian_subagent"});
        }
    }
    let mut cursor = Value::Null;
    let mut seen = std::collections::HashSet::new();
    loop {
        let profiles = rpc
            .call(
                "permissionProfile/list",
                json!({"cwd":seed["cwd"],"cursor":cursor}),
                5000,
            )
            .await?;
        if let Some(profile) = profiles["data"]
            .as_array()
            .ok_or("DESKTOP_PERMISSION_LIST_INVALID")?
            .iter()
            .find(|p| p["id"] == saved["permissions"])
        {
            if profile["allowed"] != true {
                return Ok(());
            }
            break;
        }
        cursor = profiles["nextCursor"].clone();
        if cursor.is_null() {
            return Ok(());
        }
        if !seen.insert(cursor.to_string()) {
            return Err("DESKTOP_PERMISSION_CURSOR_REPEATED".into());
        }
    }
    for (field, allowed) in [
        ("approvalPolicy", "allowedApprovalPolicies"),
        ("approvalsReviewer", "allowedApprovalsReviewers"),
    ] {
        if let Some(choices) = requirements["requirements"][allowed].as_array() {
            if !saved[field].is_null() && !choices.contains(&saved[field]) {
                return Ok(());
            }
        }
    }
    for (key, value) in saved.as_object().unwrap() {
        let config_key = match key.as_str() {
            "approvalPolicy" => "approval_policy",
            "approvalsReviewer" => "approvals_reviewer",
            _ => "default_permissions",
        };
        if seed[key].is_null() && seed["config"][config_key].is_null() {
            seed[key] = value.clone();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_permission_selection_uses_only_current_owner_and_local_host() {
        // Recurring bug class: security changes of account or host must not inherit another scope's full access.
        let home = std::env::temp_dir().join(format!("arc-saved-permissions-{}", id()));
        std::fs::create_dir(&home).unwrap();
        let full = json!({"kind":"agent-mode","agentMode":"full-access"});
        let restricted = json!({"kind":"agent-mode","agentMode":"read-only"});
        let file = home.join(".codex-global-state.json");
        save(&file, &json!({OWNER:"active", "electron-owner-atoms:previous":{MODE:{"local":"full-access"}},
            "electron-owner-atoms:active":{SELECTION:full}, SHARED:{"permission-selection-by-host-id:ssh":full}})).unwrap();
        let permissions = || saved_permissions(&permission_atoms(&home).unwrap(), true);
        // Modern choice only: native configuration supplies the default.
        assert_eq!(permissions(), None);
        let db = Connection::open(home.join(".codex-global-state.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE settings(scope TEXT, key TEXT, value TEXT)")
            .unwrap();
        for (scope, key, value) in [
            ("global", OWNER, json!("active")),
            ("electron-owner-atoms:active", SELECTION, full),
            (
                "electron-owner-atoms:active",
                MODE,
                json!({"local":"full-access"}),
            ),
            ("atom", SELECTION, restricted),
        ] {
            db.execute(
                "INSERT INTO settings VALUES(?1,?2,?3)",
                [scope, key, &value.to_string()],
            )
            .unwrap();
        }
        // The shared read-only choice and the active owner’s full-access choice disagree.
        assert_eq!(permissions(), None);
        db.execute("DELETE FROM settings WHERE scope='atom'", [])
            .unwrap();
        assert_eq!(
            permissions(),
            Some(
                json!({"permissions":":danger-full-access","approvalPolicy":"never","approvalsReviewer":"user"})
            )
        );
        db.execute("DELETE FROM settings WHERE key=?1", [SELECTION])
            .unwrap();
        assert_eq!(permissions(), None);
        drop(db);
        std::fs::remove_dir_all(home).unwrap();
    }
}
