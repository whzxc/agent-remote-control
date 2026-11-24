//! Provider identities own sources, execution profiles and notification routes.
use crate::kernel::file_cache::load;
use crate::*;
#[path = "../claude_accounts/mod.rs"]
pub mod claude;
pub(crate) mod codex;
mod identity;
mod login;
mod merge;
pub use identity::link_source_identity;
pub use merge::merge_accounts;
static STORE: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn path() -> PathBuf {
    root().join("accounts/index.json")
}
/// The index is one file. Stamp each read, but decode and visit rows only when it changes.
#[derive(Default)]
struct Index {
    path: PathBuf,
    stamp: Option<crate::kernel::file_cache::Stamp>,
    rows: Arc<Vec<Value>>,
}
impl Index {
    fn read(&mut self, path: &Path) -> Result<Arc<Vec<Value>>> {
        use crate::runtime_metrics::cost::{self, Owner, Reason};
        let stamp = crate::kernel::file_cache::Stamp::read(path)?;
        if self.path == path && self.stamp == stamp {
            return Ok(self.rows.clone());
        }
        cost::sync(Owner::Accounts, Reason::Dirty, || {
            let rows = if stamp.is_some() {
                match load(path)? {
                    Value::Array(rows) => rows,
                    _ => return Err("ACCOUNTS_INVALID: expected an array".into()),
                }
            } else {
                Vec::new()
            };
            cost::scan_set(rows.len());
            cost::rows(rows.len());
            let previous: std::collections::HashMap<_, _> = self
                .rows
                .iter()
                .map(|row| (string(row, "id"), row))
                .collect();
            let current: std::collections::HashMap<_, _> =
                rows.iter().map(|row| (string(row, "id"), row)).collect();
            cost::changed(
                current
                    .iter()
                    .filter(|(id, row)| previous.get(*id) != Some(*row))
                    .count()
                    + previous
                        .keys()
                        .filter(|id| !current.contains_key(*id))
                        .count(),
            );
            let rows = Arc::new(rows);
            // A racing replacement must be read again on the next request.
            if crate::kernel::file_cache::Stamp::read(path)? == stamp {
                self.path = path.into();
                self.stamp = stamp;
                self.rows = rows.clone();
            }
            Ok(rows)
        })
    }
}
pub(crate) fn read() -> Result<Arc<Vec<Value>>> {
    static INDEX: std::sync::LazyLock<std::sync::Mutex<Index>> =
        std::sync::LazyLock::new(Default::default);
    INDEX.lock().map_err(|e| e.to_string())?.read(&path())
}

fn change<T>(f: impl FnOnce(&mut Vec<Value>) -> Result<T>) -> Result<T> {
    let _scope = crate::runtime_metrics::Scope::new(crate::runtime_metrics::Work::Accounts);
    let _lock = STORE.lock().map_err(|e| e.to_string())?;
    change_locked(f)
}
fn change_locked<T>(f: impl FnOnce(&mut Vec<Value>) -> Result<T>) -> Result<T> {
    let mut rows = read()?.as_ref().clone();
    let before = rows.clone();
    let result = f(&mut rows)?;
    if rows != before {
        save(&path(), &json!(rows))?;
    }
    Ok(result)
}

/// Only authorization facts or the CLI's own auth response may enter this function.
pub fn identity_key(provider: &str, facts: &Value) -> Option<String> {
    if let Some(id) = facts["accountId"].as_str().filter(|s| !s.trim().is_empty()) {
        return Some(format!("{provider}:id:{}", id.trim()));
    }
    let email = facts["email"].as_str()?.trim().to_lowercase();
    if email.is_empty() {
        return None;
    }
    let org = facts["orgId"]
        .as_str()
        .or(facts["orgName"].as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    Some(format!(
        "{provider}:email:{}",
        hash(format!("{email}\n{org}"))
    ))
}
fn confirm_reauth(account: &Value, provider: &str, facts: &Value) -> Result<()> {
    let matched = identity_key(provider, facts).is_some_and(|key| {
        string(account, "identityKey").contains(":unidentified:")
            || merge::matches_identity(account, &key)
    });
    if !live(account) || !matched {
        return Err("ACCOUNT_REAUTH_IDENTITY_MISMATCH: Sign in to the original account or add a separate account".into());
    }
    Ok(())
}
fn provider(platform: &str) -> &str {
    match platform {
        "claude" | "anthropic" => "anthropic",
        "chatgpt" | "codex" | "openai" => "openai",
        "dsh" | "deepseek" => "deepseek",
        "gemini" | "antigravity" | "google" => "google",
        "grok" | "grok-bot" | "xai" => "xai",
        "" | "custom" => "other",
        _ => platform,
    }
}
fn new_account(id: String, provider: &str, key: &str, facts: &Value) -> Value {
    json!({"id":id,"provider":provider,"identityKey":key,
        "alias":if key.contains(":unidentified:") {"Unidentified"} else {facts["orgName"].as_str().unwrap_or("Personal")},
        "email":facts["email"],"orgName":facts["orgName"],"plan":facts.get("planType").or(facts.get("subscriptionType")).or(facts.get("plan")),
        "createdAt":now(),"observedAt":now(),"sources":[],"agentProfiles":[],
        "quota":{"state":"unavailable","windows":[]},"notifications":{"state":"n/a","sessions":[]}})
}
fn live(a: &Value) -> bool {
    a["removedAt"].is_null()
}
fn profiles(a: &Value) -> impl Iterator<Item = &Value> {
    a["agentProfiles"].as_array().into_iter().flatten()
}
fn observe(
    rows: &mut Vec<Value>,
    provider: &str,
    facts: &Value,
    anchor: &str,
    profile: Option<Value>,
    source: Option<&str>,
) -> String {
    let first_profile = profile.as_ref().is_some_and(|p| {
        !rows
            .iter()
            .any(|a| profiles(a).any(|old| old["agent"] == p["agent"]))
    });
    let owns = |a: &Value| {
        source.is_some_and(|s| {
            a["sources"]
                .as_array()
                .is_some_and(|ss| ss.iter().any(|v| v == s))
        }) || profile.as_ref().is_some_and(|p| {
            profiles(a).any(|v| v["agent"] == p["agent"] && v["profileId"] == p["profileId"])
        })
    };
    let old = rows.iter().position(|a| live(a) && owns(a));
    // A removed anchor cannot be resurrected by polling. An explicit login can reattach it.
    if old.is_none() {
        if let Some(removed) = rows
            .iter()
            .find(|a| !live(a) && a["mergedInto"].is_null() && owns(a))
        {
            return string(removed, "id").into();
        }
    }
    let confirmed = identity_key(provider, facts);
    let key = confirmed
        .clone()
        .or_else(|| old.map(|i| string(&rows[i], "identityKey").to_owned()))
        .unwrap_or_else(|| format!("{provider}:unidentified:{anchor}"));
    let changed_identity = old.is_some_and(|i| {
        confirmed.is_some()
            && !string(&rows[i], "identityKey").contains(":unidentified:")
            && !merge::matches_identity(&rows[i], &key)
    });
    let matched = rows
        .iter()
        .position(|a| live(a) && merge::matches_identity(a, &key));
    let index = matched
        .or(old.filter(|_| !changed_identity))
        .unwrap_or_else(|| {
            let stable = if uuid::Uuid::parse_str(anchor).is_ok()
                && !rows.iter().any(|a| a["id"] == anchor)
            {
                anchor.into()
            } else {
                id()
            };
            let mut account = new_account(stable, provider, &key, facts);
            if source.is_none() && account["alias"] == "Unidentified" {
                account["alias"] = json!("Personal");
            }
            rows.push(account);
            rows.len() - 1
        });
    if let Some(old) = old.filter(|old| *old != index) {
        let previous = rows[old].clone();
        let moving_sources: Vec<_> = previous["sources"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| !changed_identity || source.is_some_and(|id| *s == id))
            .cloned()
            .collect();
        let moving_profiles: Vec<_> = profiles(&previous)
            .filter(|p| {
                !changed_identity
                    || profile.as_ref().is_some_and(|new| {
                        new["agent"] == p["agent"] && new["profileId"] == p["profileId"]
                    })
            })
            .cloned()
            .collect();
        rows[old]["sources"]
            .as_array_mut()
            .unwrap()
            .retain(|s| !moving_sources.contains(s));
        rows[old]["agentProfiles"]
            .as_array_mut()
            .unwrap()
            .retain(|p| !moving_profiles.contains(p));
        for source in moving_sources {
            if let Some(source_id) = source.as_str() {
                if let Some(evidence) = previous["sourceIdentities"].get(source_id) {
                    rows[index]["sourceIdentities"][source_id] = evidence.clone();
                    if let Some(map) = rows[old]["sourceIdentities"].as_object_mut() {
                        map.remove(source_id);
                    }
                }
            }
            if !rows[index]["sources"].as_array().unwrap().contains(&source) {
                rows[index]["sources"].as_array_mut().unwrap().push(source);
            }
        }
        for profile in moving_profiles {
            if !profiles(&rows[index])
                .any(|p| p["agent"] == profile["agent"] && p["profileId"] == profile["profileId"])
            {
                rows[index]["agentProfiles"]
                    .as_array_mut()
                    .unwrap()
                    .push(profile);
            }
        }
        if rows[old]["sources"].as_array().unwrap().is_empty()
            && profiles(&rows[old]).next().is_none()
        {
            rows[old]["removedAt"] = json!(now());
            if !changed_identity {
                rows[old]["mergedInto"] = rows[index]["id"].clone();
            }
        }
    }
    let row = &mut rows[index];
    let before = row.clone();
    if !merge::matches_identity(row, &key) {
        row["identityKey"] = json!(key);
    }
    if row["provider"] == "other" && provider != "other" {
        row["provider"] = json!(provider);
    }
    // Keep last confirmed identity on signed-out observations, but never fabricate an identity.
    for (field, names) in [
        ("email", vec!["email"]),
        ("orgName", vec!["orgName"]),
        ("plan", vec!["planType", "subscriptionType", "plan"]),
    ] {
        if let Some(value) = names
            .iter()
            .find_map(|name| facts.get(*name).filter(|v| v.is_string()))
        {
            row[field] = value.clone();
        }
    }
    if row["alias"] == "Unidentified" && identity_key(provider, facts).is_some() {
        row["alias"] = json!(facts["orgName"].as_str().unwrap_or("Personal"));
    }
    if let Some(source) = source {
        if !row["sources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s == source)
        {
            row["sources"].as_array_mut().unwrap().push(json!(source));
        }
    }
    if let Some(mut profile) = profile {
        let list = row["agentProfiles"].as_array_mut().unwrap();
        if let Some(old) = list
            .iter_mut()
            .find(|p| p["agent"] == profile["agent"] && p["profileId"] == profile["profileId"])
        {
            profile["default"] = old["default"].clone();
            *old = profile;
        } else {
            profile["default"] = json!(first_profile);
            list.push(profile);
        }
    }
    if *row != before {
        row["observedAt"] = json!(now());
    }
    row["id"].as_str().unwrap().into()
}
fn defaults(rows: &mut [Value]) {
    let mut seen = std::collections::HashSet::new();
    for a in rows.iter_mut().filter(|a| live(a)) {
        for p in a["agentProfiles"].as_array_mut().unwrap() {
            if p["default"] == true && !seen.insert(string(p, "agent").to_owned()) {
                p["default"] = json!(false);
            }
        }
    }
}
pub(crate) fn migrate() -> Result<()> {
    let observations = claude::observations()?;
    let sources = crate::sources::list()?;
    change(|rows| {
        for p in observations {
            let facts = &p["identity"];
            let state = if facts["statusError"].is_string() {
                "invalid"
            } else {
                match facts["loggedIn"].as_bool() {
                    Some(true) => "signed-in",
                    Some(false) => "signed-out",
                    None => "unfinished",
                }
            };
            observe(
                rows,
                "anthropic",
                facts,
                string(&p, "profileId"),
                Some(
                    json!({"agent":"claude","profileId":p["profileId"],"kind":"cli-profile","state":state,"default":false}),
                ),
                None,
            );
        }
        retire_local_accounts(rows, &sources, &now());
        for source in sources
            .into_iter()
            .filter(|source| !crate::sources::is_local(source))
        {
            // Client metadata, labels and platform guesses are deliberately excluded from facts.
            identity::observe_source(rows, &source);
        }
        defaults(rows);
        Ok(())
    })
}
pub(crate) fn source_account(source: &Value) -> Result<Option<String>> {
    if crate::sources::is_local(source) {
        return Ok(None);
    }
    let mut source = source.clone();
    project_sources(std::slice::from_mut(&mut source))?;
    Ok(source["accountId"].as_str().map(str::to_owned))
}
/// Project an entire source response in one account transaction, including
/// identity reconciliation. Do not decode and clone the index per source.
#[derive(Default)]
struct SourceProjection {
    stamp: Option<crate::kernel::file_cache::Stamp>,
    rows: std::collections::HashMap<String, (Value, Value, Value)>,
}
pub(crate) fn project_sources(sources: &mut [Value]) -> Result<()> {
    for source in sources.iter_mut().filter(|s| crate::sources::is_local(s)) {
        source["accountId"] = Value::Null;
        source["identityResolution"] = json!({"state":"not-applicable"});
    }
    if sources.iter().all(crate::sources::is_local) {
        return Ok(());
    }
    static PROJECTION: std::sync::LazyLock<std::sync::Mutex<SourceProjection>> =
        std::sync::LazyLock::new(Default::default);
    let inputs: Vec<_> = sources
        .iter()
        .map(|s| json!([s["platform"], s["authorizationFacts"]]))
        .collect();
    let mut projection = PROJECTION.lock().map_err(|e| e.to_string())?;
    let _owner = STORE.lock().map_err(|e| e.to_string())?;
    let stamp = crate::kernel::file_cache::Stamp::read(&path())?;
    if projection.stamp != stamp {
        projection.rows.clear();
        projection.stamp = stamp;
    }
    if sources
        .iter()
        .zip(&inputs)
        .filter(|(s, _)| !crate::sources::is_local(s))
        .all(|(s, input)| {
            projection
                .rows
                .get(string(s, "id"))
                .is_some_and(|(old, _, _)| old == input)
        })
    {
        for source in sources.iter_mut().filter(|s| !crate::sources::is_local(s)) {
            let (_, account, resolution) = &projection.rows[string(source, "id")];
            source["accountId"] = account.clone();
            source["identityResolution"] = resolution.clone();
        }
        return Ok(());
    }
    let _scope = crate::runtime_metrics::Scope::new(crate::runtime_metrics::Work::Accounts);
    change_locked(|rows| {
        for source in sources.iter_mut().filter(|s| !crate::sources::is_local(s)) {
            let account = identity::observe_source(rows, source);
            source["accountId"] = json!(account);
            source["identityResolution"] = rows
                .iter()
                .find(|a| a["id"] == account && live(a))
                .and_then(|a| a["sourceIdentities"].get(string(source, "id")))
                .cloned()
                .unwrap_or(json!({"state":"unresolved"}));
        }
        Ok(())
    })?;
    let after = crate::kernel::file_cache::Stamp::read(&path())?;
    if projection.stamp != after {
        projection.rows.clear();
        projection.stamp = after;
    }
    for (source, input) in sources
        .iter()
        .zip(inputs)
        .filter(|(s, _)| !crate::sources::is_local(s))
    {
        projection.rows.insert(
            string(source, "id").into(),
            (
                input,
                source["accountId"].clone(),
                source["identityResolution"].clone(),
            ),
        );
    }
    Ok(())
}

/// Detach legacy local memberships; retain empty account tombstones for history.
pub fn retire_local_accounts(rows: &mut [Value], sources: &[Value], at: &str) {
    let local: Vec<_> = sources
        .iter()
        .filter(|s| crate::sources::is_local(s))
        .map(|s| &s["id"])
        .collect();
    for row in rows {
        let Some(members) = row["sources"].as_array_mut() else {
            continue;
        };
        let before = members.len();
        members.retain(|id| !local.contains(&id));
        let changed = members.len() != before;
        let empty = members.is_empty();
        if !changed {
            continue;
        }
        if let Some(identities) = row["sourceIdentities"].as_object_mut() {
            for id in &local {
                if let Some(id) = id.as_str() {
                    identities.remove(id);
                }
            }
        }
        if empty && profiles(row).next().is_none() && live(row) {
            row["removedAt"] = json!(at);
        }
    }
}
pub(crate) fn source_resolution(source: &str) -> Result<Value> {
    let rows = read()?;
    let account = rows.iter().find(|a| {
        a["sources"]
            .as_array()
            .is_some_and(|ss| ss.iter().any(|s| s == source))
            && live(a)
    });
    Ok(account
        .and_then(|a| a["sourceIdentities"].get(source))
        .cloned()
        .unwrap_or(json!({"state":"unresolved"})))
}
pub(crate) fn confirm_source(source: &str, evidence: Value) -> Result<Value> {
    // Resolve authorization facts first; a delivery handshake cannot turn local authority into an account.
    if crate::sources::is_local(&crate::sources::get(source)?) {
        return Ok(json!({"state":"not-applicable"}));
    }
    change(|rows| link_source_identity(rows, source, evidence))
}

pub(crate) fn resolve(reference: &str) -> Result<Value> {
    resolve_rows(&read()?, reference)
}
fn resolve_rows(rows: &[Value], reference: &str) -> Result<Value> {
    let canonical = merge::canonical(rows, reference)?;
    if let Some(row) = rows.iter().find(|a| a["id"] == canonical) {
        let mut row = row.clone();
        row["mergedAccountIds"] = json!(rows
            .iter()
            .filter_map(|previous| {
                let id = previous["id"].as_str()?;
                (id != canonical && merge::canonical(&rows, id).ok()? == canonical)
                    .then(|| json!(id))
            })
            .collect::<Vec<_>>());
        return Ok(row);
    }
    let matches: Vec<_> = rows
        .iter()
        .filter(|a| live(a) && a["alias"] == reference)
        .collect();
    match matches.as_slice() {
        [row] => Ok((*row).clone()),
        [] => Err("ACCOUNT_NOT_FOUND: Read query accounts and use an account ID".into()),
        _ => Err("ACCOUNT_ALIAS_AMBIGUOUS: Use an account ID from query accounts".into()),
    }
}
pub(crate) fn profile_owner<'a>(rows: &'a [Value], profile: &str) -> Option<&'a Value> {
    rows.iter()
        .find(|a| live(a) && profiles(a).any(|p| p["profileId"] == profile))
}
pub(crate) fn profile_account(profile: &str) -> Result<Value> {
    profile_owner(&read()?, profile)
        .cloned()
        .ok_or("ACCOUNT_PROFILE_NOT_FOUND".into())
}

pub(crate) fn claude_default_signed_in_profile() -> Result<Option<String>> {
    let observations = claude::observations()?;
    Ok(select_signed_in_claude(&read()?, &observations))
}

fn select_signed_in_claude(rows: &[Value], observations: &[Value]) -> Option<String> {
    rows.iter()
        .filter(|row| live(row))
        .flat_map(|row| profiles(row).map(move |profile| (row, profile)))
        .filter(|(_, profile)| profile["agent"] == "claude" && profile["state"] == "signed-in")
        .filter_map(|(row, profile)| {
            let id = profile["profileId"].as_str().filter(|id| !id.is_empty())?;
            let observed = observations
                .iter()
                .find(|p| p["profileId"] == id)
                .and_then(|p| p["observedAt"].as_str())
                .or_else(|| row["observedAt"].as_str())
                .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok());
            Some((profile["default"] == true, observed, id))
        })
        .max()
        .map(|(_, _, id)| id.to_owned())
}

pub(crate) fn save_claude_quota(profile: &str, quota: Value) -> Result<()> {
    change(|rows| {
        if let Some(account) = profile_owner(rows, profile) {
            let id = account["id"].clone();
            if let Some(row) = rows.iter_mut().find(|row| row["id"] == id) {
                row["quota"] = quota;
            }
        }
        Ok(())
    })
}

pub(crate) fn claude_profile(account: &str) -> Result<String> {
    let row = resolve(account)?;
    if !live(&row) {
        return Err("ACCOUNT_REMOVED: Select an active account".into());
    }
    let result = profiles(&row)
        .find(|p| p["agent"] == "claude")
        .map(|p| string(p, "profileId").to_owned())
        .ok_or("ACCOUNT_AGENT_MISSING: This account has no Claude profile".into());
    result
}
fn update(args: &Value) -> Result<Value> {
    let account = resolve(string(args, "id"))?;
    if !live(&account) {
        return Err("ACCOUNT_REMOVED".into());
    }
    if let Some(alias) = args.get("alias") {
        if !alias.as_str().is_some_and(|s| {
            !s.trim().is_empty() && s.len() <= 120 && !s.chars().any(char::is_control)
        }) {
            return Err("INVALID_ACCOUNT_ALIAS: Use 1 to 120 characters".into());
        }
    }
    change(|rows| {
        let row = rows.iter_mut().find(|a| a["id"] == account["id"]).unwrap();
        if let Some(alias) = args.get("alias") {
            row["alias"] = json!(alias.as_str().unwrap().trim());
        }
        Ok(row.clone())
    })
}

#[derive(Default)]
pub(crate) struct Manager {
    claude: claude::Manager,
    refresh: Mutex<Option<std::time::Instant>>,
}
impl Manager {
    pub async fn stop(&self, _control: &control::Control) {
        self.claude.stop().await;
    }
    pub async fn refresh(
        &self,
        _control: &control::Control,
        _agents: &agents::AgentHost,
    ) -> Result<()> {
        let mut last = self.refresh.lock().await;
        migrate()?;
        if last.is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(15)) {
            return Ok(());
        }
        let observations = claude::observations()?;
        let accounts = read()?;
        for profile in observations {
            let id = string(&profile, "profileId");
            if profile_owner(&accounts, id).is_some() {
                let _ = claude::refresh_profile(id).await;
            }
        }
        migrate()?;
        // One-time cleanup: drop legacy non-Claude execution profiles from account rows.
        change(|rows| {
            let retired_at = now();
            for row in rows.iter_mut().filter(|r| live(r)) {
                let had_profiles = row["agentProfiles"]
                    .as_array()
                    .is_some_and(|p| !p.is_empty());
                if let Some(list) = row["agentProfiles"].as_array_mut() {
                    list.retain(|p| p["agent"] == "claude");
                }
                let no_sources = row["sources"].as_array().is_none_or(Vec::is_empty);
                let no_profiles = row["agentProfiles"].as_array().is_none_or(Vec::is_empty);
                if had_profiles && no_sources && no_profiles {
                    row["removedAt"] = json!(retired_at);
                }
            }
            defaults(rows);
            Ok(())
        })?;
        *last = Some(std::time::Instant::now());
        Ok(())
    }
    pub async fn query(&self, args: &Value) -> Result<Value> {
        let routes = claude::routing::list()?;
        let mut notifications = crate::claude_notify::account_sessions().await?;
        let snapshot = read()?;
        for session in &mut notifications {
            if let Some(profile) = session["accountId"].as_str() {
                if let Some(account) = profile_owner(&snapshot, profile) {
                    session["accountId"] = account["id"].clone();
                }
            }
        }
        let mut rows = snapshot.as_ref().clone();
        let canonical = rows
            .iter()
            .map(|row| {
                let id = string(row, "id");
                Ok((id.to_owned(), merge::canonical(&rows, id)?))
            })
            .collect::<Result<std::collections::BTreeMap<_, _>>>()?;
        for row in &mut rows {
            row["mergedAccountIds"] = json!(canonical
                .iter()
                .filter_map(|(id, owner)| {
                    (id != owner && row["id"] == owner.as_str()).then(|| json!(id))
                })
                .collect::<Vec<_>>());
            let ids: Vec<_> = profiles(row)
                .filter(|p| p["agent"] == "claude")
                .map(|p| p["profileId"].clone())
                .collect();
            let mut sessions: Vec<Value> = notifications
                .iter()
                .filter(|s| {
                    s["accountId"]
                        .as_str()
                        .and_then(|id| canonical.get(id))
                        .is_some_and(|id| row["id"] == id.as_str())
                        || ids.contains(&s["accountId"])
                        || row["sources"]
                            .as_array()
                            .is_some_and(|ss| ss.contains(&s["sourceId"]))
                })
                .cloned()
                .collect();
            for (target, profile) in &routes {
                if ids.iter().any(|id| id == profile)
                    && !sessions.iter().any(|s| s["target"] == *target)
                {
                    sessions.push(json!({"target":target,"state":"not-bound"}));
                }
            }
            let (sessions, historical_sessions) = partition_notification_sessions(sessions);
            let has_claude = row["provider"] == "anthropic"
                && (!row["sources"].as_array().unwrap().is_empty() || !sessions.is_empty());
            let state = if !live(row) {
                "removed"
            } else if has_claude {
                if sessions.iter().any(|s| s["verified"] == true) {
                    "verified"
                } else {
                    "not-bound"
                }
            } else if row["provider"] == "openai" && !row["sources"].as_array().unwrap().is_empty()
            {
                "mcp-events"
            } else {
                "n/a"
            };
            row["notifications"] = json!({"state":state,"reachable":sessions.iter().any(|s| s["verified"]==true || s["reachable"]==true),"sessions":sessions,"historicalSessions":historical_sessions});
            row["health"] = json!({"state":if !live(row) {"removed"} else if identity::has_conflict(row) || profiles(row).any(|p| p["state"] != "signed-in") {"attention"} else {"ready"}});
            if !live(row) {
                row["displayName"] = json!(format!("Removed account · {}", string(row, "alias")));
            }
        }
        if let Some(id) = args["id"].as_str() {
            let id = resolve_rows(&snapshot, id)?["id"].clone();
            return rows
                .into_iter()
                .find(|a| a["id"] == id)
                .ok_or("ACCOUNT_NOT_FOUND".into());
        }
        rows.retain(|a| {
            live(a)
                && args["agent"]
                    .as_str()
                    .is_none_or(|agent| profiles(a).any(|p| p["agent"] == agent))
        });
        for row in &mut rows {
            row.as_object_mut().unwrap().remove("email");
            row.as_object_mut().unwrap().remove("orgName");
        }
        let claude_login =
            self.claude.request("profiles", "GET", json!({})).await?["login"].clone();
        Ok(
            json!({"accounts":rows,"login":claude_login.is_object().then(|| login::progress(claude_login))}),
        )
    }
    pub async fn op(
        &self,
        control: &Arc<control::Control>,
        agents: &Arc<agents::AgentHost>,
        subscriptions: &Arc<crate::subscriptions::SubscriptionService>,
        name: &str,
        args: Value,
    ) -> Result<Value> {
        self.refresh(control, agents).await?;
        let force_quota = name == "account_refresh_quota";
        if force_quota || name == "accounts" && args["id"].is_string() {
            let account = resolve(string(&args, "id"))?;
            if live(&account) {
                let quota = if let Some(provider) = account["quotaProviderId"].as_str() {
                    if force_quota {
                        subscriptions
                            .request(
                                "subscriptions/refresh",
                                "POST",
                                json!({"providerId":provider}),
                            )
                            .await?;
                    }
                    subscriptions.snapshot().await["providers"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|row| row["providerId"] == provider)
                        .map(merge::shared_quota)
                } else if let Some(p) = profiles(&account).find(|p| string(p, "agent") == "claude")
                {
                    subscriptions
                        .refresh_claude_profile(string(p, "profileId"), force_quota)
                        .await?;
                    None
                } else {
                    None
                };
                if let Some(quota) = quota {
                    change(|rows| {
                        if let Some(row) = rows
                            .iter_mut()
                            .find(|row| row["id"] == account["id"] && live(row))
                        {
                            row["quota"] = quota;
                        }
                        Ok(())
                    })?;
                }
            }
        }
        match name {
            "account_browsers" => {
                self.claude
                    .request("profiles/browsers", "GET", json!({}))
                    .await
            }
            "account_notify" => {
                let profile = claude_profile(string(&args, "id"))?;
                if args["action"] == "bind" {
                    let mut result =
                        claude::routing::bind(string(&args, "target"), &profile, true).await?;
                    result["accountId"] = resolve(string(&args, "id"))?["id"].clone();
                    return Ok(result);
                }
                let account = resolve(string(&args, "id"))?;
                let mut body = args;
                body["accountId"] = json!(profile);
                if body["action"] == "test" && !body["message"].is_string() {
                    body["message"] = json!("ARC notification test");
                }
                let mut result = crate::claude_notify::send_account_notification(&body).await?;
                result["accountId"] = account["id"].clone();
                Ok(result)
            }
            "accounts" | "account_refresh_quota" => self.query(&args).await,
            "whoami" => {
                let origin = crate::kernel::origin::current_origin();
                let source = crate::sources::get(string(&origin, "sourceId"))?;
                let Some(account_id) = source_account(&source)? else {
                    return Ok(
                        json!({"id":null,"sourceId":source["id"],"platform":"local","authority":"local","identityResolution":{"state":"not-applicable"},"agentProfiles":[],"notifications":{"state":"n/a","sessions":[]}}),
                    );
                };
                let account = self.query(&json!({"id":account_id})).await?;
                let mut result = json!({"sourceId":source["id"],"platform":source["platform"],"identityResolution":source_resolution(string(&source,"id"))?});
                result["coordinationDelivery"] =
                    crate::coordination::routing::status(string(&source, "id"))?;
                for key in [
                    "id",
                    "alias",
                    "provider",
                    "email",
                    "orgName",
                    "plan",
                    "agentProfiles",
                    "notifications",
                ] {
                    result[key] = account[key].clone();
                }
                Ok(result)
            }
            "account_update" => {
                update(&args)?;
                self.query(&json!({"id":args["id"]})).await
            }
            "account_merge" => {
                let snapshot = subscriptions.snapshot().await;
                let account = change(|rows| merge_accounts(rows, &args, &snapshot, &now()))?;
                self.query(&json!({"id":account["id"]})).await
            }
            "account_add" | "account_login" | "account_reauth" => {
                self.login_op(control, agents, name, args).await
            }
            "account_remove" => {
                let row = resolve(string(&args, "id"))?;
                if !matches!(string(&args, "running"), "finish" | "cancel") {
                    return Err("INVALID_RUNNING_POLICY: Use finish or cancel".into());
                }
                change(|rows| {
                    let account = rows.iter_mut().find(|a| a["id"] == row["id"]).unwrap();
                    if let Some(agent) = args["agent"].as_str() {
                        let removable = account["sources"].as_array().is_some_and(Vec::is_empty)
                            && profiles(account).count() == 1
                            && profiles(account).any(|p| p["agent"] == agent);
                        if !removable {
                            return Err(
                                "ACCOUNT_PROFILE_NOT_REMOVABLE: This account has another role"
                                    .into(),
                            );
                        }
                    }
                    account["removedAt"] = json!(now());
                    for p in account["agentProfiles"].as_array_mut().unwrap() {
                        p["default"] = json!(false);
                    }
                    defaults(rows);
                    Ok(())
                })?;
                self.query(&json!({"id":row["id"]})).await
            }
            _ => Err("UNKNOWN_ACCOUNT_OP: Read guide for accounts".into()),
        }
    }
    pub async fn request(
        &self,
        control: &Arc<control::Control>,
        agents: &Arc<agents::AgentHost>,
        subscriptions: &Arc<crate::subscriptions::SubscriptionService>,
        route: &str,
        method: &str,
        body: Value,
    ) -> Result<Value> {
        if route == "accounts/browsers" && method == "GET" {
            return self.claude.request("profiles/browsers", "GET", body).await;
        }
        if route == "accounts" && method == "GET" {
            return self
                .op(control, agents, subscriptions, "accounts", body)
                .await;
        }
        if let Some(op) = route.strip_prefix("accounts/").filter(|op| {
            matches!(
                *op,
                "query"
                    | "whoami"
                    | "add"
                    | "login"
                    | "reauth"
                    | "refresh-quota"
                    | "update"
                    | "remove"
                    | "merge"
            )
        }) {
            if method == "POST" || op == "whoami" && method == "GET" {
                let name = match op {
                    "query" => "accounts".into(),
                    "whoami" => "whoami".into(),
                    "refresh-quota" => "account_refresh_quota".into(),
                    _ => format!("account_{op}"),
                };
                if op == "whoami" && crate::kernel::origin::current_origin()["sourceId"].is_null() {
                    return crate::kernel::origin::ORIGIN
                        .scope(
                            crate::sources::panel_origin().await?,
                            self.op(control, agents, subscriptions, &name, body),
                        )
                        .await;
                }
                return self.op(control, agents, subscriptions, &name, body).await;
            }
        }
        if route == "accounts/routes" && method == "PUT" {
            let account = resolve(string(&body, "accountId"))?;
            let mut body = body;
            body["accountId"] = json!(claude_profile(string(&body, "accountId"))?);
            let mut result = self.claude.request("profiles/routes", method, body).await?;
            result["accountId"] = account["id"].clone();
            return Ok(result);
        }
        if let Some(tail) = route.strip_prefix("accounts/") {
            let (id, action) = tail.split_once('/').unwrap_or((tail, ""));
            if action.is_empty() && method == "GET" {
                return self
                    .op(control, agents, subscriptions, "accounts", json!({"id":id}))
                    .await;
            }
            if matches!(action, "send" | "test") && method == "POST" {
                let mut body = body;
                body["accountId"] = json!(claude_profile(id)?);
                if action == "test" && !body["message"].is_string() {
                    body["message"] = json!("ARC notification test");
                }
                let mut result = crate::claude_notify::send_account_notification(&body).await?;
                result["accountId"] = resolve(id)?["id"].clone();
                return Ok(result);
            }
        }
        Err("UNKNOWN_ROUTE: Read accounts management operations".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_quota_prefers_the_default_signed_in_profile() {
        // Contract: Claude quota profile selection by sign-in state, default and observation time
        let account = |id, default, state| {
            json!({"id":id,"agentProfiles":[
                {"agent":"claude","profileId":id,"state":state,"default":default}
            ]})
        };
        let mut accounts = vec![
            account("first", true, "signed-in"),
            account("latest", false, "signed-in"),
        ];
        let observations = vec![
            json!({"profileId":"first","observedAt":"2026-01-01T00:00:00Z"}),
            json!({"profileId":"latest","observedAt":"2026-01-02T00:00:00Z"}),
        ];
        assert_eq!(
            select_signed_in_claude(&accounts, &observations).as_deref(),
            Some("first")
        );
        accounts[0]["agentProfiles"][0]["default"] = json!(false);
        assert_eq!(
            select_signed_in_claude(&accounts, &observations).as_deref(),
            Some("latest")
        );
        accounts[1]["agentProfiles"][0]["state"] = json!("signed-out");
        assert_eq!(
            select_signed_in_claude(&accounts, &observations).as_deref(),
            Some("first")
        );
    }

    #[test]
    fn legacy_local_accounts_retire_without_losing_agent_membership() {
        // Recurring bug class: Local CLI created a removable Unidentified provider account.
        let sources = vec![
            json!({"id":"example-local","ingressId":"local-cli","credential":{"type":"local"}}),
        ];
        let mut rows = vec![
            json!({"id":"local-only","sources":["example-local"],"agentProfiles":[],"sourceIdentities":{"example-local":{"state":"unresolved"}}}),
            json!({"id":"shared","sources":["example-local","example-external"],"agentProfiles":[{"agent":"codex"}]}),
            json!({"id":"agent-only","sources":["example-local"],"agentProfiles":[{"agent":"claude"}]}),
        ];
        retire_local_accounts(&mut rows, &sources, "2026-01-01T00:00:00Z");
        assert!(rows[0]["removedAt"].is_string());
        assert_eq!(rows[0]["sources"], json!([]));
        assert_eq!(rows[0]["sourceIdentities"], json!({}));
        assert_eq!(rows[1]["sources"], json!(["example-external"]));
        assert!(rows[1]["removedAt"].is_null());
        assert!(rows[2]["removedAt"].is_null());
        assert_eq!(rows[2]["agentProfiles"], json!([{"agent":"claude"}]));
        let repaired = rows.clone();
        retire_local_accounts(&mut rows, &sources, "2026-01-02T00:00:00Z");
        assert_eq!(rows, repaired);
        assert_eq!(source_account(&sources[0]).unwrap(), None);
    }
    #[test]
    fn identity_uses_provider_facts_and_normalized_email() {
        // Algorithmic core: unresolved identities never coalesce and normalized provider identities do.
        assert_eq!(
            identity_key(
                "openai",
                &json!({"email":" Person@Example.com ","orgName":" Example Org "})
            ),
            identity_key(
                "openai",
                &json!({"email":"person@example.com","orgName":"example org"})
            )
        );
        assert_ne!(
            identity_key("openai", &json!({"accountId":"one"})),
            identity_key("anthropic", &json!({"accountId":"one"}))
        );
        assert!(identity_key("openai", &json!({"name":"person@example.com"})).is_none());
    }
    #[test]
    fn source_profile_merge_and_single_default() {
        // Algorithmic core: equal identity keys share one live account and each Agent has at most one default.
        let mut rows = vec![];
        let facts = json!({"email":"person@example.com"});
        let source = observe(&mut rows, "openai", &facts, "source", None, Some("source"));
        observe(
            &mut rows,
            "openai",
            &facts,
            "profile",
            Some(
                json!({"agent":"codex","profileId":"home","kind":"codex-home","state":"signed-in","default":true}),
            ),
            None,
        );
        observe(
            &mut rows,
            "openai",
            &Value::Null,
            "other",
            Some(
                json!({"agent":"codex","profileId":"other","kind":"codex-home","state":"signed-out","default":true}),
            ),
            None,
        );
        defaults(&mut rows);
        assert_eq!(
            rows.iter().find(|a| a["id"] == source).unwrap()["sources"],
            json!(["source"])
        );
        assert_eq!(
            rows.iter()
                .flat_map(profiles)
                .filter(|p| p["default"] == true)
                .count(),
            1
        );
        assert_eq!(profiles(&rows[0]).count(), 1);
    }
}

pub(crate) fn notification_accounts() -> Result<Vec<Value>> {
    Ok(read()?.iter().filter(|a| live(a) && profiles(a).any(|p| p["agent"] == "claude")).map(|a| json!({"accountId":a["id"],"alias":a["alias"],"identity":{"email":a["email"],"orgName":a["orgName"]}})).collect())
}

/// Read-time labels preserve the recorded ID, including after account removal or merge.
pub(crate) fn label_snapshot() -> Option<Arc<Value>> {
    crate::kernel::file_cache::shared_load(&path()).ok()
}

pub(crate) fn decorate(value: &mut Value) {
    let Some(snapshot) = label_snapshot() else {
        return;
    };
    let Some(rows) = snapshot.as_array() else {
        return;
    };
    decorate_labels(value, rows);
}

/// Project a response from one account snapshot without changing recorded identities.
pub fn decorate_labels(value: &mut Value, rows: &[Value]) {
    let labels: std::collections::BTreeMap<_, _> = rows
        .iter()
        .filter_map(|account| {
            let id = account["id"].as_str()?;
            let canonical = merge::canonical(rows, id).ok()?;
            Some((id, rows.iter().find(|row| row["id"] == canonical)?))
        })
        .collect();
    fn visit(v: &mut Value, labels: &std::collections::BTreeMap<&str, &Value>) {
        match v {
            Value::Object(map) => {
                if let Some(account) = map
                    .get("agentAccountId")
                    .and_then(Value::as_str)
                    .and_then(|id| labels.get(id))
                {
                    map.insert("agentAccountAlias".into(), account["alias"].clone());
                    map.insert("agentAccountRemoved".into(), json!(!live(account)));
                    map.insert(
                        "agentAccountLabel".into(),
                        json!(if live(account) {
                            string(account, "alias").to_owned()
                        } else {
                            format!("Removed account · {}", string(account, "alias"))
                        }),
                    );
                }
                for (key, value) in map {
                    if ![
                        "arguments",
                        "args",
                        "input",
                        "output",
                        "metadata",
                        "items",
                        "finalResponse",
                    ]
                    .contains(&key.as_str())
                    {
                        visit(value, labels);
                    }
                }
            }
            Value::Array(values) => {
                for value in values {
                    visit(value, labels);
                }
            }
            _ => {}
        }
    }
    visit(value, &labels);
}

/// Presentation only: retain diagnostic rows without advertising them as active routes.
pub fn partition_notification_sessions(sessions: Vec<Value>) -> (Vec<Value>, Vec<Value>) {
    sessions.into_iter().partition(|s| {
        s["target"].as_str().is_some_and(|v| !v.trim().is_empty())
            && s["registered"] != false
            && !matches!(
                string(s, "state"),
                "failed" | "expired" | "unavailable" | "revoked" | "removed"
            )
    })
}

#[cfg(test)]
mod notification_projection_tests {
    use super::*;
    #[test]
    fn inactive_routes_remain_diagnostics() {
        // Recurring bug class: AX-13 whoami advertised empty routes and stale failed sessions as destinations.
        let rows = vec![
            json!({"target":"", "verified":true}),
            json!({"target":"old", "state":"failed"}),
            json!({"target":"revoked","registered":false}),
            json!({"target":"live","state":"verified","verified":true}),
            json!({"target":"new","state":"not-bound"}),
        ];
        let (active, historical) = partition_notification_sessions(rows);
        assert_eq!(
            active
                .iter()
                .map(|s| string(s, "target"))
                .collect::<Vec<_>>(),
            vec!["live", "new"]
        );
        assert_eq!(historical.len(), 3);
        assert_eq!(historical[1]["state"], "failed");
    }
}

/// Current source-account owners, excluding merged and removed tombstones.
pub(crate) fn source_rows() -> Result<Vec<Value>> {
    // Reconcile every current source before projecting account inventory.
    crate::sources::list()?;
    Ok(read()?
        .iter()
        .filter(|a| live(a) && a["sources"].as_array().is_some_and(|s| !s.is_empty()))
        .cloned()
        .collect())
}
