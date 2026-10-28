//! Core-owned control-source identity. Credentials anchor identity; names never do.
use crate::*;
use std::collections::BTreeMap;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

struct Cache {
    current: Value,
    persisted: Value,
    last_seen_writes: BTreeMap<String, Instant>,
}
const MIGRATION_VERSION: u64 = 2;
static CACHE: OnceLock<RwLock<Cache>> = OnceLock::new();
static WRITER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn path() -> PathBuf {
    root().join("sources.json")
}
fn read() -> Result<Value> {
    if path().exists() {
        load(&path())
    } else {
        Ok(json!({"version":0,"sources":[]}))
    }
}
fn cache() -> Result<&'static RwLock<Cache>> {
    CACHE
        .get()
        .ok_or_else(|| "Source store is not initialized".into())
}
/// Called once after the state lock, before serving requests.
pub fn initialize() -> Result<()> {
    let mut store = migrate()?;
    let previous = store.clone();
    reconcile(
        store["sources"]
            .as_array_mut()
            .ok_or("Invalid source store")?,
    )?;
    if store != previous {
        save(&path(), &store)?;
    }
    let last_seen_writes = store["sources"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| !s["lastSeenAt"].is_null())
        .map(|s| (string(s, "id").to_owned(), Instant::now()))
        .collect();
    CACHE
        .set(RwLock::new(Cache {
            current: store.clone(),
            persisted: store,
            last_seen_writes,
        }))
        .map_err(|_| "Source store is already initialized".into())
}
/// Commit only after every startup migration, including notification decoding, succeeds.
pub async fn complete_migration() -> Result<()> {
    let _writer = WRITER.lock().await;
    let mut store = cache()?.read().map_err(|e| e.to_string())?.current.clone();
    if store["version"] == MIGRATION_VERSION {
        return Ok(());
    }
    store["version"] = json!(MIGRATION_VERSION);
    let snapshot = store.clone();
    tokio::task::spawn_blocking(move || save(&path(), &snapshot))
        .await
        .map_err(|e| e.to_string())??;
    let mut cache = cache()?.write().map_err(|e| e.to_string())?;
    cache.current = store.clone();
    cache.persisted = store;
    Ok(())
}
async fn change<T: Send + 'static>(
    f: impl FnOnce(&mut Vec<Value>) -> Result<T> + Send + 'static,
) -> Result<T> {
    transaction(false, f).await
}
async fn transaction<T: Send + 'static>(
    activity: bool,
    f: impl FnOnce(&mut Vec<Value>) -> Result<T> + Send + 'static,
) -> Result<T> {
    // Own the transaction so request cancellation cannot separate a disk commit
    // from its cache update. The async writer gate never blocks executor threads.
    tokio::spawn(async move {
        let _writer = WRITER.lock().await;
        let (mut current, persisted, mut last_seen_writes) = {
            let cache = cache()?.read().map_err(|e| e.to_string())?;
            (
                cache.current.clone(),
                cache.persisted.clone(),
                cache.last_seen_writes.clone(),
            )
        };
        let previous = current.clone();
        let result = f(current["sources"]
            .as_array_mut()
            .ok_or("Invalid source store")?)?;
        if current == previous && !activity {
            return Ok(result);
        }
        let mut disk = current.clone();
        let at = Instant::now();
        let mut seen_changes = vec![];
        for source in disk["sources"].as_array_mut().unwrap() {
            let id = string(source, "id").to_owned();
            let old = persisted["sources"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["id"] == id);
            let old_seen = old.map(|s| s["lastSeenAt"].clone()).unwrap_or(Value::Null);
            if source["lastSeenAt"] != old_seen {
                if last_seen_writes
                    .get(&id)
                    .is_some_and(|t| at.duration_since(*t) < Duration::from_secs(60))
                {
                    source["lastSeenAt"] = old_seen;
                } else {
                    seen_changes.push(id);
                }
            }
        }
        if disk != persisted {
            let snapshot = disk.clone();
            tokio::task::spawn_blocking(move || save(&path(), &snapshot))
                .await
                .map_err(|e| e.to_string())??;
        }
        // Measure the throttle from completed persistence, not queue time.
        for id in seen_changes {
            last_seen_writes.insert(id, Instant::now());
        }
        let mut cache = cache()?.write().map_err(|e| e.to_string())?;
        // Activity may advance while the disk snapshot is being saved.
        for source in current["sources"].as_array_mut().unwrap() {
            if let Some(live) = cache.current["sources"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["id"] == source["id"])
            {
                source["lastSeenAt"] = live["lastSeenAt"].clone();
            }
        }
        cache.current = current;
        cache.persisted = disk;
        cache.last_seen_writes = last_seen_writes;
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// The reserved ingress and local credential identify shared CLI/panel authority.
pub fn is_local(source: &Value) -> bool {
    source["ingressId"] == "local-cli" && source["credential"]["type"] == "local"
}
pub fn require_control_source(source: &Value) -> Result<()> {
    if is_local(source) {
        return Err("LOCAL_SOURCE_PROTECTED: Built-in Local CLI and panel authority cannot be disconnected, revoked or moved.".into());
    }
    Ok(())
}
/// Repair legacy local lifecycle state without changing identity or history.
pub fn repair_local(source: &mut Value, transport: &str) -> bool {
    if transport != "local"
        || !is_local(source)
        || (source["state"] != "revoked" && source["connectionRemoved"] != true)
    {
        return false;
    }
    source["state"] = json!("connected");
    for key in ["connectionRemoved", "connectionName", "pendingSwitch"] {
        source.as_object_mut().unwrap().remove(key);
    }
    true
}
pub fn revoke(source: &mut Value) -> Result<()> {
    require_control_source(source)?;
    source["state"] = json!("revoked");
    clear_switch(source);
    Ok(())
}
/// Source identity remains available internally for historical attribution.
pub fn control_sources() -> Result<Vec<Value>> {
    Ok(list()?
        .into_iter()
        .filter(|source| !is_local(source))
        .collect())
}
pub fn list() -> Result<Vec<Value>> {
    let cache = cache()?.read().map_err(|e| e.to_string())?;
    let mut rows = cache.current["sources"]
        .as_array()
        .ok_or("Invalid source store")?
        .clone();
    for source in &mut rows {
        source["accountId"] = json!(crate::accounts::source_account(source)?);
        source["identityResolution"] = if is_local(source) {
            json!({"state":"not-applicable"})
        } else {
            crate::accounts::source_resolution(string(source, "id"))?
        };
        if source["capabilityProfileOffer"] == true {
            source["capabilityProfileOffer"] = crate::control_profiles::offer(source);
        }
        if !switch_live(source) {
            clear_switch(source);
        }
    }
    Ok(rows)
}
pub fn get(id: &str) -> Result<Value> {
    list()?
        .into_iter()
        .find(|s| s["id"] == id)
        .ok_or("SOURCE_NOT_FOUND".into())
}
/// One cached source snapshot per coordination query; the caller validates it before reading.
/// Never resolve accounts per event.
pub(crate) fn coordination_source(origin: &Value) -> Result<Value> {
    let cache = cache()?.read().map_err(|e| e.to_string())?;
    let source = cache.current["sources"]
        .as_array()
        .ok_or("Invalid source store")?
        .iter()
        .find(|source| source["id"] == origin["sourceId"])
        .ok_or("SOURCE_NOT_FOUND")?;
    Ok(source.clone())
}
/// Cached authority-only snapshot; never resolve accounts while maintaining notices.
pub(crate) fn coordination_revoked() -> Result<Vec<String>> {
    let cache = cache()?.read().map_err(|e| e.to_string())?;
    Ok(cache.current["sources"]
        .as_array()
        .ok_or("Invalid source store")?
        .iter()
        .filter(|s| !is_local(s) && (s["state"] == "revoked" || s["connectionRemoved"] == true))
        .filter_map(|s| s["id"].as_str().map(str::to_owned))
        .collect())
}
fn product(id: &str) -> Result<Value> {
    crate::control_sources::presets()
        .iter()
        .find(|p| p["id"] == id)
        .cloned()
        .ok_or("UNKNOWN_PRODUCT: read ingress presets".into())
}
fn normalized(id: &str) -> &str {
    if crate::control_sources::presets()
        .iter()
        .any(|p| p["id"] == id)
    {
        id
    } else {
        "custom"
    }
}
pub fn match_product(name: &str) -> String {
    let name = name.to_lowercase();
    // Product inference is a correctable default, never an identity match.
    for p in crate::control_sources::presets().iter().rev() {
        if p["id"] == "custom" || p["id"] == "local-cli" {
            continue;
        }
        if [string(p, "id"), string(p, "displayName")]
            .iter()
            .any(|s| !s.is_empty() && name.contains(&s.to_lowercase()))
        {
            return string(p, "id").into();
        }
    }
    for p in crate::control_sources::presets() {
        if !["custom", "local"].contains(&string(p, "platform"))
            && name.contains(string(p, "platform"))
        {
            return string(p, "id").into();
        }
    }
    "custom".into()
}
fn make(
    rows: &[Value],
    ingress: &Value,
    credential: Value,
    product_id: &str,
    connected: Value,
) -> Value {
    let product_id = normalized(product_id);
    let p = crate::control_sources::preset(product_id);
    let names = rows
        .iter()
        .map(|s| string(s, "label").to_owned())
        .collect::<Vec<_>>();
    json!({"id":id(),"ingressId":ingress["id"],"credential":credential,
        "product":product_id,"platform":p["platform"],"label":crate::control_sources::default_name(product_id,&names),
        "createdAt":now(),"connectedAt":connected,"lastSeenAt":null,"state":"disconnected","capabilityProfileOffer":true})
}
fn switch_live(s: &Value) -> bool {
    s["pendingSwitch"]["expiresAt"]
        .as_i64()
        .is_some_and(|at| at > chrono::Utc::now().timestamp())
}
fn clear_switch(s: &mut Value) {
    s.as_object_mut().unwrap().remove("pendingSwitch");
}
/// One owner-initiated expectation per source and per target connection.
pub async fn begin_switch(source_id: &str, entry: &Value) -> Result<Value> {
    let source_id = source_id.to_owned();
    let entry = entry.clone();
    change(move |rows| {
        let source = rows.iter().find(|s| s["id"] == source_id).ok_or("SOURCE_NOT_FOUND")?;
        require_control_source(source)?;
        if source["state"] == "revoked" || source["switchSourceId"].is_string() {
            return Err("SOURCE_NOT_SWITCHABLE: select a connected or disconnected source".into());
        }
        if source["ingressId"] == entry["id"] {
            return Err("SAME_CONNECTION: select another connection".into());
        }
        let preset = crate::control_sources::preset(string(source, "product"));
        if entry["transport"] == "local"
            || (entry["transport"] == "openai-tunnel" && source["product"] != "chatgpt")
            || !preset["supportedAuth"].as_array().is_some_and(|auth| auth.contains(&entry["auth"]))
        {
            return Err("INCOMPATIBLE_CONNECTION: select a connection supported by this product".into());
        }
        if rows.iter().any(|s| switch_live(s) && (s["id"] == source_id || s["pendingSwitch"]["ingressId"] == entry["id"])) {
            return Err("SWITCH_PENDING: cancel the existing switch first".into());
        }
        if entry["auth"] != "oauth" && rows.iter().any(|s| s["ingressId"] == entry["id"] || s["retiredIngressIds"].as_array().is_some_and(|ids| ids.contains(&entry["id"]))) {
            return Err("CONNECTION_OCCUPIED: non-OAuth connections carry exactly one source; select another connection".into());
        }
        let source = rows.iter_mut().find(|s| s["id"] == source_id).unwrap();
        source["pendingSwitch"] = json!({"ingressId":entry["id"],"expiresAt":chrono::Utc::now().timestamp()+300});
        Ok(source.clone())
    }).await
}
pub async fn cancel_switch(source_id: &str) -> Result<Value> {
    let source_id = source_id.to_owned();
    change(move |rows| {
        let source = rows
            .iter_mut()
            .find(|s| s["id"] == source_id)
            .ok_or("SOURCE_NOT_FOUND")?;
        clear_switch(source);
        Ok(source.clone())
    })
    .await
}
/// Removal preserves established identities, including those already disconnected.
pub async fn remove_connection(entry: &Value, pending: Vec<String>) -> Result<()> {
    if entry["id"] == "local-cli" && entry["transport"] == "local" {
        return Err("LOCAL_SOURCE_PROTECTED: Built-in local authority cannot be removed.".into());
    }
    let entry = entry.clone();
    change(move |rows| {
        for s in rows {
            if s["ingressId"] == entry["id"] {
                require_control_source(s)?;
            }
            if s["pendingSwitch"]["ingressId"] == entry["id"] || s["ingressId"] == entry["id"] {
                clear_switch(s);
            }
            if s["ingressId"] == entry["id"] && s["state"] != "revoked" {
                if pending.iter().any(|id| s["credential"]["grantId"] == *id) {
                    s["state"] = json!("revoked");
                } else {
                    s["state"] = json!("disconnected");
                    s["connectionRemoved"] = json!(true);
                    s["connectionName"] = entry["name"].clone();
                }
            }
        }
        Ok(())
    })
    .await
}
fn move_connection(source: &mut Value, ingress: &Value, credential: Value) {
    if source["credential"]["type"] != "oauth-grant" {
        let old = source["ingressId"].clone();
        if !source["retiredIngressIds"].is_array() {
            source["retiredIngressIds"] = json!([]);
        }
        source["retiredIngressIds"]
            .as_array_mut()
            .unwrap()
            .push(old);
    }
    source["ingressId"] = ingress.clone();
    source["credential"] = credential;
    source.as_object_mut().unwrap().remove("connectionRemoved");
    source.as_object_mut().unwrap().remove("connectionName");
    clear_switch(source);
}
/// The source anchor is also the revocation boundary for access, refresh and event grants.
pub fn ingress_retired(ingress: &str) -> bool {
    list().map_or(true, |rows| {
        rows.iter().any(|s| {
            s["retiredIngressIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id == ingress))
        })
    })
}
pub fn grant_active(ingress: &str, grant: &str) -> bool {
    for_grant(ingress, grant)
        .is_ok_and(|s| s["state"] != "revoked" && s["connectionRemoved"] != true)
}
pub async fn ensure_ingress(entry: &Value) -> Result<Value> {
    ensure_ingress_inner(entry, false).await
}
pub async fn connect_ingress(entry: &Value) -> Result<Value> {
    ensure_ingress_inner(entry, true).await
}
async fn ensure_ingress_inner(entry: &Value, observed: bool) -> Result<Value> {
    let entry = entry.clone();
    let (source, repaired) = change(move |rows| {
        if let Some(s) = rows
            .iter_mut()
            .find(|s| s["ingressId"] == entry["id"] && s["credential"]["type"] != "oauth-grant")
        {
            let repaired = repair_local(s, string(&entry, "transport"));
            return Ok((s.clone(), repaired));
        }
        if let Some(source) = rows.iter().find(|s| s["retiredIngressIds"].as_array().is_some_and(|ids| ids.contains(&entry["id"]))) {
            if !observed { return Ok((source.clone(), false)); }
            return Err("CONNECTION_RETIRED: the source changed connection; remove this connection and create a new one".into());
        }
        let credential = json!({"type":if entry["transport"] == "local" { "local" } else { "ingress" }});
        if let Some(source) = rows.iter_mut().find(|s| switch_live(s) && s["pendingSwitch"]["ingressId"] == entry["id"]) {
            if !observed { return Ok((source.clone(), false)); }
            move_connection(source, &entry["id"], credential);
            source["state"] = json!("connected");
            return Ok((source.clone(), false));
        }
        let source = make(
            rows,
            &entry,
            credential,
            string(&entry, "controlSource"),
            Value::Null,
        );
        rows.push(source.clone());
        Ok((source, false))
    })
    .await?;
    if repaired {
        crate::logs::record(
            "info",
            &format!(
                "Restored built-in local source {} to connected",
                string(&source, "id")
            ),
            Some(string(&source, "ingressId")),
        );
    }
    Ok(source)
}
pub async fn pending(entry: &Value, grant: &str, client: &str, name: &str) -> Result<Value> {
    let entry = entry.clone();
    let grant = grant.to_owned();
    let client = client.to_owned();
    let name = name.to_owned();
    change(move |rows| {
        if let Some(s) = rows
            .iter()
            .find(|s| s["ingressId"] == entry["id"] && s["credential"]["grantId"] == grant)
        {
            return Ok(s.clone());
        }
        let product = if entry["transport"] == "relay" {
            match_product(&name)
        } else {
            normalized(string(&entry, "controlSource")).into()
        };
        let expected = rows.iter_mut().find(|s| {
            switch_live(s)
                && s["pendingSwitch"]["ingressId"] == entry["id"]
                && s["pendingSwitch"]["requestId"].is_null()
        });
        let claim = expected.map(|source| {
            source["pendingSwitch"]["requestId"] = json!(grant);
            (
                source["id"].clone(),
                source["product"].clone(),
                source["platform"].clone(),
            )
        });
        let mut s = make(
            rows,
            &entry,
            json!({"type":"oauth-grant","grantId":grant,"clientId":client}),
            &product,
            Value::Null,
        );
        if let Some((id, product, platform)) = claim {
            s["switchSourceId"] = id;
            s["product"] = product;
            s["platform"] = platform;
        }
        rows.push(s.clone());
        Ok(s)
    })
    .await
}
pub fn for_grant(ingress: &str, grant: &str) -> Result<Value> {
    list()?
        .into_iter()
        .find(|s| s["ingressId"] == ingress && s["credential"]["grantId"] == grant)
        .ok_or("SOURCE_NOT_FOUND".into())
}
pub async fn update(id: &str, body: &Value) -> Result<Value> {
    let id = id.to_owned();
    let body = body.clone();
    if !body.is_object()
        || body.as_object().unwrap().keys().any(|k| {
            !["label", "product", "minimalText", "capabilityProfile"].contains(&k.as_str())
        })
    {
        return Err("Expected label, product, minimalText, and/or capabilityProfile".into());
    }
    if body.get("minimalText").is_some_and(|v| !v.is_boolean()) {
        return Err("minimalText must be a boolean".into());
    }
    let p = body
        .get("product")
        .map(|v| product(v.as_str().unwrap_or("")))
        .transpose()?;
    if let Some(label) = body.get("label") {
        if !label.as_str().is_some_and(|v| {
            !v.trim().is_empty() && v.len() <= 120 && !v.chars().any(char::is_control)
        }) {
            return Err("Invalid source label".into());
        }
    }
    change(move |rows| {
        let s = rows
            .iter_mut()
            .find(|s| s["id"] == id)
            .ok_or("SOURCE_NOT_FOUND")?;
        if let Some(profile) = body.get("capabilityProfile") {
            crate::control_profiles::validate(s, profile)?;
            s["capabilityProfile"] = profile.clone();
            s.as_object_mut().unwrap().remove("capabilityProfileOffer");
        }
        if let Some(p) = p {
            s["product"] = p["id"].clone();
            s["platform"] = p["platform"].clone();
        }
        if let Some(label) = body.get("label") {
            s["label"] = label.clone();
        }
        if let Some(value) = body.get("minimalText") {
            s["minimalText"] = value.clone();
        }
        Ok(s.clone())
    })
    .await
}
pub fn candidates(source: &Value, grants: &[String]) -> Result<Vec<Value>> {
    Ok(list()?
        .into_iter()
        .filter(|s| {
            s["id"] != source["id"]
                && !s["switchSourceId"].is_string()
                && s["ingressId"] == source["ingressId"]
                && s["product"] == source["product"]
                && s["credential"]["type"] == "oauth-grant"
                && (s["state"] == "revoked"
                    || !s["connectedAt"].is_null()
                    || grants.iter().any(|g| *g == s["credential"]["grantId"]))
        })
        .collect())
}
pub fn validate_claim(pending: &Value, target: &str, grants: &[String]) -> Result<()> {
    if let Some(expected) = pending["switchSourceId"].as_str() {
        let source = get(expected)?;
        return if target == expected
            && switch_live(&source)
            && source["pendingSwitch"]["ingressId"] == pending["ingressId"]
            && source["pendingSwitch"]["requestId"] == pending["credential"]["grantId"]
            && source["state"] != "revoked"
            && pending["state"] != "revoked"
        {
            Ok(())
        } else {
            Err("INVALID_SWITCH_CLAIM: this request can only claim its expected source; restart source switch if canceled or expired".into())
        };
    }
    if target == "new" {
        return Ok(());
    }
    if candidates(pending, grants)?
        .iter()
        .any(|s| s["id"] == target)
    {
        Ok(())
    } else {
        Err("INVALID_SOURCE_CLAIM: select new or an existing source of the same product on this connection".into())
    }
}
/// Move the anchor only after PKCE succeeds. The caller removes the returned old grant before issuing tokens.
pub async fn connect(
    ingress: &str,
    grant: &str,
    target: &str,
    grants: &[String],
) -> Result<Option<String>> {
    let pending = for_grant(ingress, grant)?;
    validate_claim(&pending, target, grants)?;
    let target = target.to_owned();
    change(move |rows| {
        let current = rows
            .iter()
            .find(|s| s["id"] == pending["id"])
            .ok_or("SOURCE_NOT_FOUND")?;
        if current["credential"] != pending["credential"]
            || current["product"] != pending["product"]
            || current["state"] == "revoked"
        {
            return Err("SOURCE_CHANGED: retry consent".into());
        }
        let chosen = if target == "new" {
            string(&pending, "id")
        } else {
            &target
        };
        let s = rows
            .iter_mut()
            .find(|s| s["id"] == chosen)
            .ok_or("SOURCE_NOT_FOUND")?;
        let switching = pending["switchSourceId"] == target;
        if switching {
            if !switch_live(s)
                || s["state"] == "revoked"
                || s["pendingSwitch"]["ingressId"] != pending["ingressId"]
                || s["pendingSwitch"]["requestId"] != pending["credential"]["grantId"]
            {
                return Err("SWITCH_CHANGED: restart source switch".into());
            }
        } else if s["product"] != pending["product"]
            || s["ingressId"] != pending["ingressId"]
            || s["credential"]["type"] != "oauth-grant"
        {
            return Err("SOURCE_CHANGED: retry consent".into());
        }
        let old = (target != "new" && s["ingressId"] == pending["ingressId"])
            .then(|| string(&s["credential"], "grantId").to_owned());
        if switching {
            move_connection(s, &pending["ingressId"], pending["credential"].clone());
        } else {
            s["credential"] = pending["credential"].clone();
        }
        if s["connectedAt"].is_null() {
            s["connectedAt"] = json!(chrono::Utc::now().timestamp());
        }
        s["state"] = json!("connected");
        if target != "new" {
            rows.retain(|s| s["id"] != pending["id"]);
        }
        Ok(old)
    })
    .await
}
pub async fn revoke_grants(ingress: &str, grants: &[String]) -> Result<()> {
    if grants.is_empty() {
        return Ok(());
    }
    let ingress = ingress.to_owned();
    let grants = grants.to_vec();
    change(move |rows| {
        for s in rows {
            if s["pendingSwitch"]["ingressId"] == ingress
                && grants.iter().any(|g| s["pendingSwitch"]["requestId"] == *g)
            {
                clear_switch(s);
            }
            if s["ingressId"] == ingress
                && s["connectionRemoved"] != true
                && grants.iter().any(|g| s["credential"]["grantId"] == *g)
            {
                revoke(s)?;
            }
        }
        Ok(())
    })
    .await
}
pub async fn disconnect(id: &str) -> Result<Value> {
    let id = id.to_owned();
    change(move |rows| {
        let s = rows
            .iter_mut()
            .find(|s| s["id"] == id)
            .ok_or("SOURCE_NOT_FOUND")?;
        revoke(s)?;
        Ok(s.clone())
    })
    .await
}
pub async fn connection_state(ingress: &str, connected: bool) -> Result<()> {
    let ingress = ingress.to_owned();
    change(move |rows| {
        for s in rows {
            if s["ingressId"] == ingress
                && s["state"] != "revoked"
                && s["connectionRemoved"] != true
                && (s["credential"]["type"] != "oauth-grant" || !s["connectedAt"].is_null())
            {
                s["state"] = json!(if connected {
                    "connected"
                } else {
                    "disconnected"
                });
            }
        }
        Ok(())
    })
    .await
}
pub fn origin(source: &Value, auth: &str) -> Value {
    json!({"ingressId":source["ingressId"],"sourceId":source["id"],"accountId":crate::accounts::source_account(source).ok().flatten(),"controlSource":source["product"],"authType":auth,"sourceLabel":source["label"]})
}
/// Preserve the rejected source and recovery instructions across string transports.
pub fn authorization_error(source: &Value) -> String {
    let reason = if source["connectionRemoved"] == true {
        "connection removed"
    } else if source["state"] == "revoked" {
        "authorization revoked"
    } else {
        "credentials or connection superseded"
    };
    let recovery = if is_local(source) {
        "Restart the upgraded ARC app and retry the local command; built-in local authority repairs automatically."
    } else {
        "Open ARC Remote link. For a revoked source, add and authorize a new control source. For a removed connection, select the disconnected source and Change connection, then authorize it. Retry from the restored connection."
    };
    format!(
        "SOURCE_REVOKED: Source {} on ingress {} is not authorized ({reason}). {recovery}",
        source["id"], source["ingressId"]
    )
}
pub async fn touch(source: &Value, auth: &str) -> Result<Value> {
    let source_id = string(source, "id");
    let (result, persist) = {
        let mut cache = cache()?.write().map_err(|e| e.to_string())?;
        let due = cache
            .last_seen_writes
            .get(source_id)
            .is_none_or(|t| t.elapsed() >= Duration::from_secs(60));
        let s = cache.current["sources"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|s| s["id"] == source_id)
            .ok_or("SOURCE_NOT_FOUND")?;
        if s["state"] == "revoked"
            || s["connectionRemoved"] == true
            || s["ingressId"] != source["ingressId"]
            || s["credential"] != source["credential"]
        {
            return Err(authorization_error(s));
        }
        // Telemetry is immediately visible, even while a durable mutation is in flight.
        s["lastSeenAt"] = json!(chrono::Utc::now().timestamp());
        (
            origin(s, auth),
            due || s["state"] != "connected" || s["connectedAt"].is_null(),
        )
    };
    if !persist {
        return Ok(result);
    }
    let source = source.clone();
    let auth = auth.to_owned();
    transaction(true, move |rows| {
        let s = rows
            .iter_mut()
            .find(|s| s["id"] == source["id"])
            .ok_or("SOURCE_NOT_FOUND")?;
        if s["state"] == "revoked"
            || s["connectionRemoved"] == true
            || s["ingressId"] != source["ingressId"]
            || s["credential"] != source["credential"]
        {
            return Err(authorization_error(s));
        }
        s["state"] = json!("connected");
        if s["connectedAt"].is_null() {
            s["connectedAt"] = s["lastSeenAt"].clone();
        }
        Ok(origin(s, &auth))
    })
    .await
}
pub async fn local_origin() -> Result<Value> {
    let s =
        ensure_ingress(&json!({"id":"local-cli","transport":"local","controlSource":"local-cli"}))
            .await?;
    touch(&s, "local").await
}
/// The local panel and CLI share local authority and a durable source identity.
pub async fn panel_origin() -> Result<Value> {
    let mut origin = local_origin().await?;
    origin["controlSource"] = json!("ARC");
    origin["sourceLabel"] = json!("ARC");
    origin["ingressId"] = json!("local-ui");
    Ok(origin)
}
/// Labels are read from the current store, including retained revoked sources.
pub fn decorate(value: &mut Value) {
    let Ok(cache) = cache().and_then(|cache| cache.read().map_err(|e| e.to_string())) else {
        return;
    };
    let Some(rows) = cache.current["sources"].as_array().cloned() else {
        return;
    };
    drop(cache);
    decorate_labels(value, &rows);
    crate::accounts::decorate(value);
}

/// Project current labels without reconciling identities or reading account stores.
/// One response shares one source snapshot, even when it contains many receipts.
pub fn decorate_labels(value: &mut Value, rows: &[Value]) {
    let labels: BTreeMap<_, _> = rows
        .iter()
        .filter_map(|source| Some((source["id"].as_str()?, &source["label"])))
        .collect();
    fn visit(v: &mut Value, labels: &BTreeMap<&str, &Value>) {
        match v {
            Value::Object(o) => {
                if let Some(label) = o
                    .get("sourceId")
                    .filter(|_| o.contains_key("authType"))
                    .and_then(Value::as_str)
                    .and_then(|id| labels.get(id))
                {
                    o.insert("sourceLabel".into(), (*label).clone());
                }
                for (key, v) in o.iter_mut() {
                    if ![
                        "arguments",
                        "args",
                        "input",
                        "output",
                        "metadata",
                        "items",
                        "finalResponse",
                        "externalUserInputs",
                    ]
                    .contains(&key.as_str())
                    {
                        visit(v, labels);
                    }
                }
            }
            Value::Array(a) => {
                for v in a {
                    visit(v, labels);
                }
            }
            _ => {}
        }
    }
    visit(value, &labels);
}

#[cfg(test)]
mod label_tests {
    use super::*;

    #[test]
    fn receipt_batch_labels_fit_one_poll_budget_without_identity_reconciliation() {
        // Regression: idle status polls resolved every source account for each of 3008 historical receipts.
        let mut sources: Vec<_> = (0..7)
            .map(|n| {
                json!({"id":format!("source-{n}"),"label":format!("label-{n}"),
                "authorizationFacts":{"email":"same@example.test"}})
            })
            .collect();
        let mut accounts: Vec<_> = (0..15)
            .map(|n| json!({"id":format!("account-{n}"),"alias":format!("alias-{n}")}))
            .collect();
        let opaque = json!({"origin":{"sourceId":"source-0","authType":"oauth","sourceLabel":"recorded"},
            "agentAccountId":"account-0","agentAccountAlias":"recorded"});
        let mut response = json!({"records":(0..3008).map(|n| json!({
            "origin":{"sourceId":format!("source-{}",n%7),"authType":"oauth","accountId":"recorded-account"},
            "agentAccountId":format!("account-{}",n%15),"arguments":opaque
        })).collect::<Vec<_>>()});
        let started = Instant::now();
        decorate_labels(&mut response, &sources);
        crate::accounts::decorate_labels(&mut response, &accounts);
        // A complete batch must fit the existing two-second status polling period.
        assert!(started.elapsed() < Duration::from_secs(2));
        for (n, receipt) in response["records"].as_array().unwrap().iter().enumerate() {
            assert_eq!(receipt["origin"]["sourceLabel"], sources[n % 7]["label"]);
            assert_eq!(receipt["agentAccountAlias"], accounts[n % 15]["alias"]);
            assert_eq!(receipt["origin"]["accountId"], "recorded-account");
            assert_eq!(receipt["arguments"], opaque);
        }
        // The next poll uses fresh labels without changing historical identity or input.
        sources[0]["label"] = json!("renamed-source");
        accounts[0]["alias"] = json!("renamed-account");
        accounts[0]["removedAt"] = json!("2026-01-01T00:00:00Z");
        decorate_labels(&mut response, &sources);
        crate::accounts::decorate_labels(&mut response, &accounts);
        assert_eq!(
            response["records"][0]["origin"]["sourceLabel"],
            sources[0]["label"]
        );
        assert_eq!(
            response["records"][0]["agentAccountAlias"],
            accounts[0]["alias"]
        );
        assert_eq!(response["records"][0]["agentAccountRemoved"], true);
        assert_eq!(response["records"][0]["agentAccountId"], accounts[0]["id"]);
        assert_eq!(response["records"][0]["arguments"], opaque);
    }
}

fn migration_label(source: &Value) -> String {
    format!(
        "{} {}",
        string(
            &crate::control_sources::preset(string(source, "product")),
            "displayName"
        ),
        source["connectedAt"]
            .as_i64()
            .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
            .map(|t| t.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|| "unknown date".into())
    )
}
fn disambiguate_migration_labels(rows: &mut [Value]) {
    // Version 1 had no label provenance flag. Only the exact legacy generated
    // default is eligible; renamed and already suffixed labels are reserved.
    let defaults = rows
        .iter()
        .map(|s| {
            rows.iter()
                .filter(|other| other["ingressId"] == s["ingressId"])
                .count()
                > 1
                && s["label"] == migration_label(s)
        })
        .collect::<Vec<_>>();
    let mut used = rows
        .iter()
        .zip(&defaults)
        .filter(|(_, default)| !**default)
        .map(|(s, _)| {
            (
                string(s, "ingressId").to_owned(),
                string(s, "label").to_owned(),
            )
        })
        .collect::<std::collections::BTreeSet<_>>();
    for (source, default) in rows.iter_mut().zip(defaults) {
        if !default {
            continue;
        }
        let ingress = string(source, "ingressId").to_owned();
        let base = migration_label(source);
        let mut label = base.clone();
        let mut suffix = 2;
        while used.contains(&(ingress.clone(), label.clone())) {
            label = format!("{base} {suffix}");
            suffix += 1;
        }
        used.insert((ingress, label.clone()));
        source["label"] = json!(label);
    }
}

/// Restartable one-time conversion. Persist identities before rewriting references.
fn migrate() -> Result<Value> {
    let mut store = read()?;
    if store["version"] == MIGRATION_VERSION {
        return Ok(store);
    }
    let pref_path = root().join("ui-preferences.json");
    let mut prefs = if pref_path.exists() {
        load(&pref_path)?
    } else {
        json!({"values":{}})
    };
    let raw = &prefs["values"]["arc.approved-source-labels"];
    let labels: Value = if let Some(s) = raw.as_str() {
        serde_json::from_str(s).map_err(|e| e.to_string())?
    } else {
        raw.clone()
    };
    if store["sources"].as_array().is_some_and(Vec::is_empty) {
        let index = root().join("ingresses/index.json");
        let ids = if index.exists() {
            load(&index)?
        } else {
            json!([])
        };
        let mut rows = vec![];
        for id in ids.as_array().ok_or("Invalid ingress index")? {
            let dir = root()
                .join("ingresses")
                .join(id.as_str().ok_or("Invalid ingress ID")?);
            let entry = load(&dir.join("config.json"))?;
            let start = rows.len();
            if entry["auth"] == "oauth" {
                let oauth = if dir.join("oauth.json").exists() {
                    load(&dir.join("oauth.json"))?
                } else {
                    json!({})
                };
                for grant in oauth["grants"].as_array().into_iter().flatten() {
                    let product = if let Some(p) = labels[string(grant, "id")].as_str() {
                        normalized(p).into()
                    } else if entry["transport"] != "relay" {
                        normalized(string(&entry, "controlSource")).into()
                    } else {
                        match_product(string(&oauth["clients"][string(grant, "client")], "name"))
                    };
                    let mut s = make(
                        &rows,
                        &entry,
                        json!({"type":"oauth-grant","grantId":grant["id"],"clientId":grant["client"]}),
                        &product,
                        grant["connected_at"].clone(),
                    );
                    s["label"] = json!(migration_label(&s));
                    rows.push(s);
                }
            } else {
                rows.push(make(
                    &rows,
                    &entry,
                    json!({"type":if entry["transport"] == "local" {"local"} else {"ingress"}}),
                    string(&entry, "controlSource"),
                    Value::Null,
                ));
            }
            if rows.len() == start + 1 {
                rows[start]["label"] = entry["name"].clone();
            }
        }
        rows.push(make(
            &rows,
            &json!({"id":"local-cli"}),
            json!({"type":"local"}),
            "local-cli",
            Value::Null,
        ));
        for source in &mut rows {
            source
                .as_object_mut()
                .unwrap()
                .remove("capabilityProfileOffer");
        }
        store["sources"] = json!(rows);
        save(&path(), &store)?;
    }
    let before_labels = store.clone();
    disambiguate_migration_labels(
        store["sources"]
            .as_array_mut()
            .ok_or("Invalid source store")?,
    );
    if store != before_labels {
        save(&path(), &store)?;
    }
    let rows = store["sources"].as_array().ok_or("Invalid source store")?;
    // Explicit owned stores only: never rewrite upstream task/user content.
    for dir in [
        "notifications",
        "respond-tokens",
        "send-queue",
        "dispatches",
        "agents/requests",
        "agents/tasks",
    ] {
        migrate_files(&root().join(dir), rows)?;
    }
    // Codex operation receipts live directly under the state root.
    for e in std::fs::read_dir(root()).map_err(|e| e.to_string())? {
        let p = e.map_err(|e| e.to_string())?.path();
        if p.extension().is_some_and(|e| e == "json")
            && p.file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
        {
            migrate_file(&p, rows)?;
        }
    }
    migrate_notification_keys()?;
    migrate_dispatch_origins()?;
    if let Some(values) = prefs["values"].as_object_mut() {
        values.remove("arc.approved-source-labels");
    }
    if pref_path.exists() {
        save(&pref_path, &prefs)?;
    }
    Ok(store)
}
fn unique<'a>(rows: &'a [Value], ingress: &str) -> Option<&'a Value> {
    let mut matches = rows.iter().filter(|s| s["ingressId"] == ingress);
    let one = matches.next()?;
    if matches.next().is_some() {
        None
    } else {
        Some(one)
    }
}
fn migrate_files(dir: &Path, rows: &[Value]) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for e in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let p = e.map_err(|e| e.to_string())?.path();
        if p.is_dir() {
            migrate_files(&p, rows)?;
        } else if p.extension().is_some_and(|e| e == "json") {
            migrate_file(&p, rows)?;
        }
    }
    Ok(())
}
fn legacy_record(path: &Path) -> Result<Option<Value>> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    match serde_json::from_slice(&bytes) {
        Ok(value) => Ok(Some(value)),
        Err(_) => {
            crate::logs::record(
                "WARN",
                "Ignored malformed legacy source-scoped record",
                None,
            );
            Ok(None)
        }
    }
}
fn migrate_file(path: &Path, rows: &[Value]) -> Result<()> {
    let Some(mut value) = legacy_record(path)? else {
        return Ok(());
    };
    fn visit(v: &mut Value, rows: &[Value]) {
        match v {
            Value::Object(o) => {
                let old = o.remove("ingress");
                let ingress = old
                    .as_ref()
                    .and_then(Value::as_str)
                    .or_else(|| o.get("ingressId").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_owned();
                if (old.is_some() || o.contains_key("ingressId") || o.contains_key("authType"))
                    && !o.contains_key("sourceId")
                {
                    o.insert("ingressId".into(), json!(ingress));
                    if let Some(s) = (!ingress.is_empty())
                        .then(|| unique(rows, &ingress))
                        .flatten()
                    {
                        o.insert("sourceId".into(), s["id"].clone());
                        if o.contains_key("controlSource") {
                            o.insert("controlSource".into(), s["product"].clone());
                            o.insert("sourceLabel".into(), s["label"].clone());
                        }
                    } else {
                        o.insert("sourceId".into(), json!(""));
                    }
                }
                for (k, v) in o.iter_mut() {
                    if ![
                        "arguments",
                        "args",
                        "prompt",
                        "input",
                        "output",
                        "result",
                        "request",
                        "finalResponse",
                        "externalUserInputs",
                        "metadata",
                    ]
                    .contains(&k.as_str())
                    {
                        visit(v, rows);
                        if k == "origin" {
                            if let Some(origin) = v.as_object_mut() {
                                if !origin.get("sourceId").is_some_and(Value::is_string) {
                                    origin.insert("sourceId".into(), json!(""));
                                }
                            }
                        }
                    }
                }
            }
            Value::Array(a) => {
                for v in a {
                    visit(v, rows);
                }
            }
            _ => {}
        }
    }
    visit(&mut value, rows);
    let parent = path.parent().unwrap_or(Path::new(""));
    if parent.ends_with("notifications/tasks")
        || parent.ends_with("notifications")
        || parent.ends_with("respond-tokens")
    {
        if let Some(o) = value.as_object_mut() {
            if !o.get("sourceId").is_some_and(Value::is_string) {
                o.insert("sourceId".into(), json!(""));
            }
        }
    }
    if parent.ends_with("respond-tokens") && string(&value, "sourceId").is_empty() {
        // An unattributable response capability must never become usable again.
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if parent.ends_with("send-queue") && value.is_object() {
        if !value["origin"].is_object() {
            value["origin"] = json!({});
        }
        if !value["origin"]["sourceId"].is_string() {
            value["origin"]["sourceId"] = json!("");
        }
        if string(&value["origin"], "sourceId").is_empty()
            && matches!(
                string(&value, "state"),
                "queued" | "blocked" | "dispatching"
            )
        {
            value["state"] = json!("failed");
            value["reason"] = json!("source-unattributed");
        }
    }
    // Inbox filenames were keyed by ingress; only unambiguous histories can move.
    if path.parent().is_some_and(|p| p.ends_with("inboxes")) {
        for s in rows {
            if unique(rows, string(s, "ingressId")).is_some()
                && path.file_stem().and_then(|s| s.to_str())
                    == Some(hash(string(s, "ingressId")).as_str())
            {
                let target = path.with_file_name(format!("{}.json", hash(string(s, "id"))));
                if !target.exists() {
                    save(&target, &value)?;
                }
                std::fs::remove_file(path).map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
    }
    if path.parent().is_some_and(|p| p.ends_with("respond-tokens"))
        && !string(&value, "sourceId").is_empty()
    {
        let request = &value["request"];
        let digest = hash(
            json!([
                value["sourceId"],
                request["owner"],
                request["id"],
                if request["owner"] == "desktop" {
                    Value::Null
                } else {
                    request["backendSession"].clone()
                }
            ])
            .to_string(),
        );
        let target = path.with_file_name(format!("{digest}.json"));
        if target != path {
            if !target.exists() {
                save(&target, &value)?;
            }
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    save(path, &value)
}

fn reconcile(rows: &mut Vec<Value>) -> Result<()> {
    for s in rows {
        clear_switch(s); // OAuth pending requests do not survive a Core restart.
        if s["credential"]["type"] == "oauth-grant"
            && s["state"] != "revoked"
            && s["connectionRemoved"] != true
        {
            let path = root()
                .join("ingresses")
                .join(string(s, "ingressId"))
                .join("oauth.json");
            let oauth = if path.exists() {
                load(&path)?
            } else {
                json!({})
            };
            if !oauth["grants"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|g| g["id"] == s["credential"]["grantId"])
            {
                s["state"] = json!("revoked");
            } else {
                s["state"] = json!("disconnected");
            }
        }
    }
    Ok(())
}

pub fn task_origin(thread: &str, turn: Option<&str>) -> Value {
    let mut origin = crate::dispatch_policy::records(thread)
        .ok()
        .and_then(|rows| {
            rows.into_iter()
                .rev()
                .find(|r| turn.is_none_or(|turn| r["turnId"] == turn))
        })
        .map(|r| r["origin"].clone())
        .unwrap_or(Value::Null);
    decorate(&mut origin);
    origin
}

fn migrate_dispatch_origins() -> Result<()> {
    let dir = root().join("dispatches");
    if !dir.exists() {
        return Ok(());
    }
    for folder in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let folder = folder.map_err(|e| e.to_string())?.path();
        if !folder.is_dir() {
            continue;
        }
        for e in std::fs::read_dir(folder).map_err(|e| e.to_string())? {
            let p = e.map_err(|e| e.to_string())?.path();
            if p.extension().is_none_or(|e| e != "json") {
                continue;
            }
            let Some(mut row) = legacy_record(&p)? else {
                continue;
            };
            if !row.is_object() {
                continue;
            }
            if row["origin"].is_object() {
                continue;
            }
            let request = string(&row, "requestId");
            if uuid::Uuid::parse_str(request).is_err() {
                continue;
            }
            for base in ["", "agents/requests"] {
                let receipt = root().join(base).join(format!("{request}.json"));
                if receipt.exists() {
                    row["origin"] = load(&receipt)?["origin"].clone();
                    save(&p, &row)?;
                    break;
                }
            }
        }
    }
    Ok(())
}
fn migrate_notification_keys() -> Result<()> {
    let dir = root().join("notifications");
    let path = dir.join("subscriptions/state.json");
    if !path.exists() {
        return Ok(());
    }
    let mut state = load(&path)?;
    if !state.is_object() {
        return Err("Invalid notification state".into());
    }
    let mut tasks = vec![];
    if dir.join("tasks").exists() {
        for e in std::fs::read_dir(dir.join("tasks")).map_err(|e| e.to_string())? {
            let path = e.map_err(|e| e.to_string())?.path();
            if path.extension().is_some_and(|e| e == "json") {
                if let Some(row) = legacy_record(&path)?.filter(Value::is_object) {
                    tasks.push((path.clone(), row));
                }
            }
        }
    }
    let mut ids = std::collections::BTreeMap::new();
    for sub in state["subscriptions"].as_array_mut().into_iter().flatten() {
        if string(sub, "sourceId").is_empty() {
            continue;
        }
        let old = string(sub, "id").to_owned();
        let new = if sub["channel"] == "claude-session" {
            tasks
                .iter()
                .find(|(_, b)| {
                    b["sourceId"] == sub["sourceId"]
                        && b["turnId"] == sub["turn"]
                        && (sub["args"]["threadId"] == b["threadId"]
                            || sub["args"]["taskId"] == b["threadId"])
                })
                .map(|(_, b)| {
                    format!(
                        "sub_{}",
                        hash(
                            json!([
                                "claude-session",
                                b["sourceId"],
                                b["agent"],
                                b["threadId"],
                                b["turnId"]
                            ])
                            .to_string()
                        )
                    )
                })
        } else {
            Some(format!("sub_{}",hash(json!([sub["sourceId"],sub["webhook"]["principal"],"notification",{"op":sub["op"],"args":sub["args"]},sub["webhook"]["url"]]).to_string())))
        };
        if let Some(new) = new {
            let legacy = if sub["channel"] == "claude-session" {
                tasks
                    .iter()
                    .find(|(_, b)| {
                        b["sourceId"] == sub["sourceId"]
                            && b["turnId"] == sub["turn"]
                            && (sub["args"]["threadId"] == b["threadId"]
                                || sub["args"]["taskId"] == b["threadId"])
                    })
                    .map(|(_, b)| {
                        format!(
                            "sub_{}",
                            hash(
                                json!([
                                    "claude-session",
                                    b["ingressId"],
                                    b["agent"],
                                    b["threadId"],
                                    b["turnId"]
                                ])
                                .to_string()
                            )
                        )
                    })
            } else {
                Some(format!("sub_{}",hash(json!([sub["ingressId"],sub["webhook"]["principal"],"notification",{"op":sub["op"],"args":sub["args"]},sub["webhook"]["url"]]).to_string())))
            };
            if let Some(legacy) = legacy {
                ids.insert(legacy, new.clone());
            }
            if sub["target"] == old {
                sub["target"] = json!(new);
            }
            sub["id"] = json!(new);
            ids.insert(old, new);
        }
    }
    // Missing scope never grants ownership, including legacy global buckets.
    for field in ["subscriptions", "targets", "threads"] {
        if let Some(items) = state[field].as_array_mut() {
            items.retain(|row| !string(row, "sourceId").is_empty());
        }
    }
    for target in state["targets"].as_array_mut().into_iter().flatten() {
        if let Some(new) = ids.get(string(target, "target")) {
            target["target"] = json!(new);
        }
    }
    save(&path, &state)?;
    for (path, mut task) in tasks {
        for delivery in task["deliveries"].as_array_mut().into_iter().flatten() {
            if let Some(new) = ids.get(string(delivery, "subscription")) {
                delivery["subscription"] = json!(new);
            }
            if let Some(new) = ids.get(string(delivery, "target")) {
                delivery["target"] = json!(new);
            }
        }
        save(&path, &task)?;
    }
    Ok(())
}

/// Opt-in only; absent fields on existing and future sources mean full text.
pub(crate) fn minimal_text(source: &str) -> bool {
    list().is_ok_and(|rows| {
        rows.iter()
            .any(|s| s["id"] == source && s["minimalText"] == true)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local() -> Value {
        json!({"id":"example-local","ingressId":"local-cli","credential":{"type":"local"},"product":"local-cli","state":"connected","connectedAt":123})
    }

    #[test]
    fn local_authority_refuses_revocation() {
        // Regression: disconnecting Local CLI revoked the shared CLI and panel authority.
        let mut source = local();
        let before = source.clone();
        assert_eq!(
            crate::management::error_code(&revoke(&mut source).unwrap_err()),
            "LOCAL_SOURCE_PROTECTED"
        );
        assert_eq!(source, before);
        source["product"] = json!("custom");
        assert!(require_control_source(&source).is_err());
    }

    #[test]
    fn local_authority_repairs_legacy_lifecycle_once() {
        // Regression: ensure_ingress returned revoked or removed local rows forever after disconnect.
        for (state, removed) in [
            ("revoked", false),
            ("connected", true),
            ("disconnected", true),
            ("revoked", true),
        ] {
            let mut source = local();
            source["state"] = json!(state);
            source["connectionRemoved"] = json!(removed);
            source["connectionName"] = json!("Old local connection");
            assert!(repair_local(&mut source, "local"));
            assert_eq!(source["id"], local()["id"]);
            assert_eq!(source["credential"], local()["credential"]);
            assert_eq!(source["connectedAt"], local()["connectedAt"]);
            assert_eq!(source["state"], "connected");
            assert!(source["connectionRemoved"].is_null());
            assert!(source["connectionName"].is_null());
            assert!(!repair_local(&mut source, "local"));
        }
    }

    #[test]
    fn external_sources_still_revoke_and_never_self_heal() {
        // Regression: local recovery must not resurrect external grants or configured local transports.
        for credential in ["ingress", "oauth-grant", "local"] {
            let mut source = local();
            source["ingressId"] = json!("example-external");
            source["credential"]["type"] = json!(credential);
            revoke(&mut source).unwrap();
            assert_eq!(source["state"], "revoked");
            let revoked = source.clone();
            assert!(!repair_local(&mut source, "local"));
            assert_eq!(source, revoked);
        }
        let mut source = local();
        source["state"] = json!("revoked");
        assert!(!repair_local(&mut source, "https"));
    }
}
