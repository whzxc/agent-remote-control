//! Account-scoped, URL-only conversation registry. Remote page data never enters Core.
use crate::{json, string, Result, Value};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
};
pub mod identity;
pub mod import_state;
pub mod refs;
pub mod registry;
/// Stable SRC errors remain machine-readable through MCP and local management.
pub fn error_code(message: &str) -> Option<&str> {
    let code = message.split(':').next()?;
    (code.starts_with("SRC_") && code.bytes().all(|b| b.is_ascii_uppercase() || b == b'_'))
        .then_some(code)
}
pub const CORRELATION_SECONDS: i64 = 600;

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    containers: BTreeMap<String, Container>,
    conversations: Vec<Value>,
    bindings: BTreeMap<String, Value>,
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Container {
    store_id: String,
    safari_user_agent: bool,
    status: String,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    hint: Option<String>,
    #[serde(default)]
    detected_account_id: Option<String>,
}
#[derive(Clone, Default)]
struct Observation {
    current: Option<Value>,
    active_at: i64,
    seen_at: i64,
    open: bool,
}
#[derive(Default)]
struct State {
    store: Option<Store>,
    live: BTreeMap<String, Observation>,
    saved_at: i64,
    dirty: bool,
}
fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}
fn change<T>(
    f: impl FnOnce(&mut Store, &mut BTreeMap<String, Observation>) -> Result<T>,
    durable: bool,
) -> Result<T> {
    let mut state = state().lock().map_err(|_| "SRC_STORE_BUSY")?;
    let path = crate::root().join("src-conversations.json");
    if state.store.is_none() {
        state.store = Some(if path.exists() {
            serde_json::from_value(crate::load(&path)?).map_err(|_| "SRC_STORE_INVALID")?
        } else {
            Store::default()
        });
    }
    let previous = state.store.as_ref().unwrap();
    let mut store = previous.clone();
    let mut live = state.live.clone();
    let value = f(&mut store, &mut live)?;
    let now = chrono::Utc::now().timestamp();
    let transition = live.len() != state.live.len()
        || live.iter().any(|(id, observation)| {
            state
                .live
                .get(id)
                .is_none_or(|old| old.current != observation.current)
        });
    let changed = store != *previous;
    let identity_change = store.containers != previous.containers
        || store.bindings != previous.bindings
        || store.conversations.len() != previous.conversations.len();
    if (changed || state.dirty)
        && (durable || identity_change || transition || now - state.saved_at >= 30)
    {
        crate::save(&path, &json!(store))?;
        state.saved_at = now;
        state.dirty = false;
    } else {
        state.dirty |= changed;
    }
    state.store = Some(store);
    state.live = live;
    Ok(value)
}
fn read_account(reference: &str) -> Result<Value> {
    let a = crate::accounts::resolve(reference)?;
    if !a["removedAt"].is_null() {
        return Err("SRC_ACCOUNT_REMOVED: Select an active source account".into());
    }
    if a["sources"].as_array().is_none_or(|s| s.is_empty()) {
        return Err("SRC_ACCOUNT_REQUIRED: Select a source account".into());
    }
    Ok(a)
}
fn account(reference: &str) -> Result<Value> {
    let a = read_account(reference)?;
    let origin = crate::kernel::origin::current_origin();
    if !origin.is_null() && origin["authType"] != "local" {
        let owner = crate::accounts::resolve(string(&origin, "accountId"))?;
        if owner["id"] != a["id"] {
            return Err("SRC_ACCOUNT_SCOPE: Use the calling source account".into());
        }
    }
    Ok(a)
}
pub fn platform_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSOperatingSystemVersion, NSProcessInfo};
        NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(NSOperatingSystemVersion {
            majorVersion: 14,
            minorVersion: 0,
            patchVersion: 0,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}
fn supported(a: &Value) -> bool {
    platform_supported() && a["provider"] == "anthropic"
}
fn ensure(store: &mut Store, id: &str) -> Container {
    store
        .containers
        .entry(id.into())
        .or_insert_with(|| Container {
            store_id: crate::id(),
            safari_user_agent: false,
            status: "not-imported".into(),
            reason: None,
            hint: None,
            detected_account_id: None,
        })
        .clone()
}
fn upsert(
    store: &mut Store,
    account: &str,
    reference: &Value,
    basis: &str,
    at: &str,
    active: bool,
) {
    let canonical = registry::resolve(&store.conversations, account, string(reference, "id"));
    let reference = canonical.as_ref().unwrap_or(reference);
    if let Some(row) = store.conversations.iter_mut().find(|r| {
        r["accountId"] == account && r["kind"] == reference["kind"] && r["id"] == reference["id"]
    }) {
        row["lastSeenAt"] = json!(at);
        if active {
            row["lastActiveAt"] = json!(at);
        }
    } else {
        let mut row = reference.clone();
        row["accountId"] = json!(account);
        row["firstSeenAt"] = json!(at);
        row["lastSeenAt"] = json!(at);
        row["lastActiveAt"] = if active { json!(at) } else { Value::Null };
        row["basis"] = json!(basis);
        row["aliases"] = json!([]);
        store.conversations.push(row);
    }
}
fn apply_status(container: &mut Container, row: &Value) {
    let Some(status) = row["status"].as_str().filter(|s| {
        matches!(
            *s,
            "unsupported"
                | "not-imported"
                | "signed-in"
                | "expired"
                | "importing"
                | "signed-in-pending"
                | "import-blocked"
                | "import-mismatch"
                | "import-unverified"
        )
    }) else {
        return;
    };
    container.status = status.into();
    container.detected_account_id = None;
    if status == "import-mismatch" {
        let mismatch = import_state::ImportState::mismatch(string(row, "detectedAccountId").into());
        container.reason = mismatch.reason.map(str::to_owned);
        container.hint = mismatch.hint.map(str::to_owned);
        container.detected_account_id = mismatch.detected_account_id;
    } else if status == "import-unverified" {
        let unverified = import_state::ImportState::unverified();
        container.reason = unverified.reason.map(str::to_owned);
        container.hint = unverified.hint.map(str::to_owned);
    } else if status == "import-blocked" {
        let blocked = import_state::ImportState::blocked(string(row, "reason"));
        container.reason = blocked.reason.map(str::to_owned);
        container.hint = blocked.hint.map(str::to_owned);
    } else {
        container.reason = None;
        container.hint = (status == "importing").then(|| import_state::KEYCHAIN_HINT.to_owned());
    }
}
/// Accept only metadata from the authenticated Desktop management channel.
pub fn observe(body: &Value) -> Result<Value> {
    change(
        |store, live| {
            let at = crate::now();
            let now = chrono::Utc::now().timestamp();
            let mut next = BTreeMap::new();
            for row in body["containers"].as_array().into_iter().flatten() {
                let id = string(row, "accountId");
                let Some(c) = store.containers.get_mut(id) else {
                    continue;
                };
                if row["storeId"] != c.store_id {
                    continue;
                }
                apply_status(c, row);
                if row["open"] == false {
                    continue;
                }
                let current = row["url"].as_str().and_then(refs::conversation);
                let old = live.get(id).cloned().unwrap_or_default();
                let focused = row["active"] == true;
                let active_at = if focused {
                    now
                } else if old.current == current {
                    old.active_at
                } else {
                    0
                };
                if let Some(reference) = &current {
                    upsert(store, id, reference, "observed", &at, focused);
                }
                next.insert(
                    id.into(),
                    Observation {
                        current,
                        active_at,
                        seen_at: now,
                        open: true,
                    },
                );
            }
            for (id, c) in &mut store.containers {
                if matches!(c.status.as_str(), "importing" | "signed-in-pending")
                    && !body["containers"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|row| row["accountId"] == *id && row["storeId"] == c.store_id)
                {
                    apply_status(
                        c,
                        &json!(import_state::ImportState::blocked("import-interrupted")),
                    );
                }
            }
            *live = next;
            Ok(json!({"accepted":true}))
        },
        body["flush"] == true,
    )
}
pub fn task_ref(agent: &str, task: &str) -> Result<Value> {
    change(
        |s, _| {
            Ok(s.bindings
                .get(&format!("{agent}:{task}"))
                .cloned()
                .unwrap_or(Value::Null))
        },
        false,
    )
}
/// Synchronize verified notification evidence without replaying correlation on registry reads.
pub(crate) fn notify_target(
    account: &str,
    target: &str,
    confirmed_at: Option<&str>,
    tasks: &[(String, String)],
) -> Result<()> {
    let Some(reference) = refs::notify_target(target) else {
        return Ok(());
    };
    change(
        |store, _| {
            if let Some(at) = confirmed_at {
                registry::verified_target(
                    &mut store.conversations,
                    &mut store.bindings,
                    account,
                    &reference,
                    at,
                );
            }
            upsert(
                store,
                account,
                &reference,
                "notify-target",
                &crate::now(),
                false,
            );
            for (agent, task) in tasks {
                let previous = store.bindings.get(&format!("{agent}:{task}"));
                if previous.is_some_and(|b| b["basis"] == "manual") {
                    continue;
                }
                bind(
                    store,
                    account,
                    agent,
                    task,
                    Some(reference.clone()),
                    "notify-target",
                );
            }
            Ok(())
        },
        true,
    )
}
/// Pure correlation rule: only a fresh, still-open same-account Chat observation qualifies.
pub fn correlated(
    current: Option<&Value>,
    open: bool,
    seen_at: i64,
    active_at: i64,
    now: i64,
) -> Option<Value> {
    current
        .filter(|r| {
            r["kind"] == "chat"
                && open
                && (0..=2).contains(&(now - seen_at))
                && (0..=CORRELATION_SECONDS).contains(&(now - active_at))
        })
        .cloned()
}
fn bind(
    store: &mut Store,
    account: &str,
    agent: &str,
    task: &str,
    reference: Option<Value>,
    basis: &str,
) -> Value {
    let key = format!("{agent}:{task}");
    store.bindings.remove(&key);
    let Some(reference) = reference else {
        return Value::Null;
    };
    let reference = registry::resolve(&store.conversations, account, string(&reference, "id"))
        .unwrap_or(reference);
    let mut r = json!({"kind":reference["kind"],"id":reference["id"],"url":reference["url"]});
    r["accountId"] = json!(account);
    r["basis"] = json!(basis);
    store.bindings.insert(key, r.clone());
    r
}
/// Capture before submission so a slow dispatch cannot correlate to a later tab.
pub(crate) async fn capture(args: &Value) -> Result<Value> {
    let origin = crate::kernel::origin::current_origin();
    if origin["accountId"].is_null() {
        return Ok(Value::Null);
    }
    let a = account(string(&origin, "accountId"))?;
    if a["provider"] != "anthropic" {
        return Ok(Value::Null);
    }
    let id = string(&a, "id");
    let inherited = if args.get("notify").is_none() {
        let task = args["threadId"].as_str().unwrap_or("");
        if task.is_empty() {
            None
        } else {
            crate::claude_notify::conversation_target_for_send(string(&origin, "sourceId"), task)?
        }
    } else {
        None
    };
    let target = args["notify"]["target"].as_str().or(inherited.as_deref());
    let deterministic = target
        .filter(|t| {
            crate::claude_notify::verified_conversation_target(string(&origin, "sourceId"), t)
                .unwrap_or(false)
        })
        .and_then(refs::notify_target);
    // Confirm the current native window at dispatch time; failure stays unbound.
    if deterministic.is_none() && target.is_none() {
        let snapshot = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            crate::transport::forward_request("src-containers/status", "GET", json!({})),
        )
        .await;
        match snapshot {
            Ok(Ok(body)) => {
                observe(&body)?;
            }
            _ => return Ok(Value::Null),
        }
    }
    change(
        |store, live| {
            let (r, basis) = if let Some(r) = deterministic {
                (Some(r), "notify-target")
            } else if target.is_some() {
                (None, "correlated")
            } else {
                let obs = live.get(id).cloned().unwrap_or_default();
                (
                    correlated(
                        obs.current.as_ref(),
                        obs.open,
                        obs.seen_at,
                        obs.active_at,
                        chrono::Utc::now().timestamp(),
                    ),
                    "correlated",
                )
            };
            let Some(mut r) = r else {
                return Ok(Value::Null);
            };
            upsert(store, id, &r, basis, &crate::now(), false);
            r = registry::resolve(&store.conversations, id, string(&r, "id")).unwrap_or(r);
            r = json!({"kind":r["kind"],"id":r["id"],"url":r["url"]});
            r["accountId"] = json!(id);
            r["basis"] = json!(basis);
            Ok(r)
        },
        true,
    )
}
pub(crate) fn record(receipt: &Value) -> Result<()> {
    if receipt.get("srcConversation").is_none() {
        return Ok(());
    }
    let r = &receipt["srcConversation"];
    let origin = &receipt["origin"];
    if origin["accountId"].is_null() {
        return Ok(());
    }
    let account = crate::accounts::resolve(string(origin, "accountId"))?;
    let id = string(&account, "id");
    let agent = receipt["agent"].as_str().unwrap_or("codex");
    let task = receipt["taskId"]
        .as_str()
        .unwrap_or(string(receipt, "threadId"));
    change(
        |s, _| {
            bind(
                s,
                id,
                agent,
                task,
                (!r.is_null()).then(|| r.clone()),
                string(r, "basis"),
            );
            Ok(())
        },
        true,
    )
}
fn snapshot(a: &Value, store: &Store, live: &BTreeMap<String, Observation>) -> Value {
    let id = string(a, "id");
    let c = store.containers.get(id);
    let obs = live
        .get(id)
        .filter(|o| chrono::Utc::now().timestamp() - o.seen_at <= 2);
    let conversations: Vec<_> = store
        .conversations
        .iter()
        .filter(|r| r["accountId"] == id)
        .map(|r| {
            let mut r = r.clone();
            if !r["aliases"].is_array() {
                r["aliases"] = json!([]);
            }
            r["taskRefs"] = json!(store
                .bindings
                .iter()
                .filter(|(_, b)| b["accountId"] == id
                    && b["kind"] == r["kind"]
                    && b["id"] == r["id"])
                .filter_map(|(key, b)| key
                    .split_once(':')
                    .map(|(agent, id)| json!({"agent":agent,"id":id,"basis":b["basis"]})))
                .collect::<Vec<_>>());
            r
        })
        .collect();
    json!({"accountId":id,"storeId":c.map(|c|&c.store_id),"status":if supported(a){c.map(|c|c.status.as_str()).unwrap_or("not-imported")}else{"unsupported"},"reason":c.and_then(|c|c.reason.as_ref()),"hint":c.and_then(|c|c.hint.as_ref()),"detectedAccountId":c.and_then(|c|c.detected_account_id.as_ref()),"safariUserAgent":c.is_some_and(|c|c.safari_user_agent),"open":obs.is_some_and(|o|o.open),"currentConversation":obs.and_then(|o|o.current.clone()),"conversations":conversations})
}
pub async fn op(name: &str, mut args: Value) -> Result<Value> {
    args.as_object_mut().map(|a| a.remove("requestId"));
    let spec = crate::catalog()["ops"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["name"] == name)
        .ok_or("UNKNOWN_OPERATION")?;
    crate::egress::validate_op(spec, &args)?;
    if name == "src_chrome_profiles" {
        if !platform_supported() {
            return Ok(json!({"status":"unsupported","profiles":[]}));
        }
        return crate::transport::forward_request("src-containers/profiles", "GET", json!({}))
            .await;
    }
    if name == "src_conversations" {
        let rows = if let Some(id) = args["accountId"].as_str() {
            vec![read_account(id)?]
        } else {
            crate::accounts::source_rows()?
        };
        let mut targets = Vec::new();
        for a in &rows {
            let sources: Vec<String> = a["sources"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect();
            for target in crate::claude_notify::verified_conversation_targets(&sources)? {
                if let Some(r) = refs::notify_target(&target) {
                    targets.push((string(a, "id").to_owned(), r));
                }
            }
        }
        return change(
            |s, l| {
                for (account, r) in targets {
                    upsert(s, &account, &r, "notify-target", &crate::now(), false);
                }
                Ok(
                    json!({"accounts":rows.iter().map(|a|snapshot(a,s,l)).collect::<Vec<_>>(),"correlationSeconds":CORRELATION_SECONDS}),
                )
            },
            true,
        );
    }
    // Keep persistent UUID removal atomic with respect to the next mutation.
    static MUTATIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _mutation = MUTATIONS.lock().await;
    let a = account(string(&args, "accountId"))?;
    let id = string(&a, "id");
    if name == "src_conversation_bind" {
        let task = string(&args, "taskId");
        let agent = string(&args, "agent");
        let records = crate::dispatch_policy::records(task)?;
        let owner = records
            .iter()
            .rev()
            .find(|r| r["agent"] == agent)
            .ok_or("SRC_TASK_NOT_FOUND: Use a task dispatched by this source account")?;
        let owner_account = crate::accounts::resolve(string(&owner["origin"], "accountId"))?;
        if owner_account["id"] != a["id"] {
            return Err("SRC_TASK_SCOPE: Task belongs to another source account".into());
        }
        return change(
            |s, _| {
                let r = if args["conversationId"].is_null() {
                    None
                } else {
                    Some(
                        registry::resolve(&s.conversations, id, string(&args, "conversationId"))
                            .ok_or("SRC_CONVERSATION_NOT_FOUND")?,
                    )
                };
                Ok(json!({"conversation":bind(s,id,agent,task,r,"manual")}))
            },
            true,
        );
    }
    if !supported(&a) {
        return Ok(json!({"accountId":id,"status":"unsupported"}));
    }
    if name == "src_login_clear" {
        let container = change(|s, _| Ok(s.containers.get(id).cloned()), false)?;
        if let Some(container) = container {
            crate::transport::forward_request(
                "src-containers/clear",
                "POST",
                json!({"accountId":id,"storeId":container.store_id}),
            )
            .await?;
            change(
                |s, l| {
                    s.containers.remove(id);
                    l.remove(id);
                    Ok(())
                },
                true,
            )?;
        }
        return Ok(json!({"accountId":id,"status":"not-imported"}));
    }
    let url = if let Some(raw) = args["url"].as_str() {
        refs::open_url(raw).ok_or("SRC_URL_INVALID: Use https://claude.ai/new or a conversation URL without query or fragment")?
    } else if let Some(cid) = args["conversationId"].as_str() {
        change(
            |s, _| {
                registry::resolve(&s.conversations, id, cid)
                    .as_ref()
                    .map(|r| string(r, "url").to_owned())
                    .ok_or("SRC_CONVERSATION_NOT_FOUND".into())
            },
            false,
        )?
    } else {
        "https://claude.ai/new".into()
    };
    let c = change(
        |s, _| {
            ensure(s, id);
            if let Some(enabled) = args["safariUserAgent"].as_bool() {
                s.containers.get_mut(id).unwrap().safari_user_agent = enabled;
            }
            Ok(s.containers[id].clone())
        },
        true,
    )?;
    let known = if name == "src_login_import" {
        identity::org_accounts(
            &crate::accounts::source_rows()?,
            &crate::accounts::claude::observations()?,
        )
    } else {
        vec![]
    };
    let body = json!({"accountId":id,"storeId":c.store_id,"safariUserAgent":c.safari_user_agent,"title":format!("Claude · {}",string(&a,"alias")),"url":url,"profile":args["profile"],"allowUnverified":args["allowUnverified"]==true,"knownAccounts":known});
    let route = if name == "src_login_import" {
        "src-containers/import"
    } else {
        "src-containers/open"
    };
    let result = crate::transport::forward_request(route, "POST", body).await?;
    if name == "src_login_import" {
        change(
            |s, _| {
                if let Some(c) = s.containers.get_mut(id) {
                    apply_status(c, &result);
                }
                Ok(())
            },
            true,
        )?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn correlation_requires_open_fresh_chat_and_recent_activity() {
        // Property: Correlation never uses closed, stale, future-dated or non-Chat observations.
        let chat =
            refs::conversation("https://claude.ai/chat/550e8400-e29b-41d4-a716-446655440000")
                .unwrap();
        assert!(correlated(Some(&chat), true, 1000, 400, 1000).is_some());
        for (open, seen, active) in [
            (false, 1000, 1000),
            (true, 997, 1000),
            (true, 1000, 399),
            (true, 1001, 1000),
            (true, 1000, 1001),
        ] {
            assert!(correlated(Some(&chat), open, seen, active, 1000).is_none());
        }
        let cowork = refs::notify_target("session_010000000000000000000001").unwrap();
        assert!(correlated(Some(&cowork), true, 1000, 1000, 1000).is_none());
        assert!(correlated(None, true, 1000, 1000, 1000).is_none());
    }
}
