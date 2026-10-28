//! User-owned dispatch choices; native capability and quota facts stay upstream.
use crate::kernel::file_cache::{self, load};
use crate::*;
use serde::{Deserialize, Serialize};
mod decision;
static POLICY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static RECORDS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Policy {
    model: Option<String>,
    effort: Option<String>,
    #[serde(default)]
    service_tier: Option<String>,
    #[serde(default)]
    service_tiers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    allow_models: Vec<String>,
    #[serde(default)]
    deny_models: Vec<String>,
    #[serde(default)]
    allow_efforts: Vec<String>,
    #[serde(default)]
    deny_efforts: Vec<String>,
    criteria: String,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct Policies {
    criteria: String,
    codex: Policy,
    #[serde(flatten)]
    agents: std::collections::BTreeMap<String, AgentPolicy>,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPolicy {
    pub model: Option<String>,
    pub options: std::collections::BTreeMap<String, String>,
    allow_models: Vec<String>,
    deny_models: Vec<String>,
    allow_options: std::collections::BTreeMap<String, Vec<String>>,
    deny_options: std::collections::BTreeMap<String, Vec<String>>,
    criteria: String,
}
pub(crate) fn agent_policy(agent: &str) -> Result<AgentPolicy> {
    Ok(read()?.agents.remove(agent).unwrap_or_default())
}
impl AgentPolicy {
    pub fn check_model(&self, model: Option<&str>) -> Result<()> {
        check_known(model, &self.allow_models, &self.deny_models, "model")
    }
    pub fn check(&self, model: Option<&str>, options: &Value) -> Result<()> {
        check_known(model, &self.allow_models, &self.deny_models, "model")?;
        for key in self.allow_options.keys().chain(self.deny_options.keys()) {
            check_known(
                options[key].as_str(),
                self.allow_options
                    .get(key)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                self.deny_options.get(key).map(Vec::as_slice).unwrap_or(&[]),
                key,
            )?;
        }
        Ok(())
    }
}
fn check_known(value: Option<&str>, allow: &[String], deny: &[String], field: &str) -> Result<()> {
    if let Some(value) = value {
        check(value, allow, deny, field)
    } else if !allow.is_empty() || !deny.is_empty() {
        Err(format!(
            "DISPATCH_CONFIGURATION_UNKNOWN: cannot check {field}"
        ))
    } else {
        Ok(())
    }
}
fn read() -> Result<Policies> {
    let _guard = POLICY_LOCK.lock().map_err(|e| e.to_string())?;
    read_locked().map(|(policies, _)| policies)
}
fn read_locked() -> Result<(Policies, Value)> {
    let path = root().join("dispatch-policy.json");
    if !path.exists() {
        let mut bytes =
            serde_json::to_vec_pretty(&Policies::default()).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        save_bytes(&path, &bytes)?;
    }
    let value = load(&path)?;
    let policies: Policies = serde_json::from_value(value.clone())
        .map_err(|e| format!("INVALID_DISPATCH_POLICY: dispatch-policy.json: {e}"))?;
    if policies
        .codex
        .model
        .as_ref()
        .is_some_and(|v| v.trim().is_empty())
        || policies
            .codex
            .effort
            .as_ref()
            .is_some_and(|v| v.trim().is_empty())
        || policies
            .agents
            .values()
            .any(|p| p.model.as_ref().is_some_and(|v| v.trim().is_empty()))
    {
        return Err("INVALID_DISPATCH_POLICY: model and effort must be nonempty or null".into());
    }
    Ok((policies, value))
}
/// Serialize criteria compare-and-replace with other policy operations in Core.
pub(crate) fn update(args: &Value) -> Result<Value> {
    let _guard = POLICY_LOCK.lock().map_err(|e| e.to_string())?;
    let (policies, previous) = read_locked()?;
    let scope = string(args, "scope");
    let current = match scope {
        "global" => policies.criteria.as_str(),
        "codex" => policies.codex.criteria.as_str(),
        agent => policies
            .agents
            .get(agent)
            .map(|p| p.criteria.as_str())
            .unwrap_or(""),
    };
    let current_hash = hash(current);
    if args["expectedCriteriaHash"] != current_hash {
        return Err(json!({
            "code":"DISPATCH_POLICY_CONFLICT","op":"dispatch_policy_update",
            "scope":scope,"currentCriteriaHash":current_hash,
            "message":"Criteria changed. Read dispatch_policy, review the current criteria, then retry dispatch_policy_update with expectedCriteriaHash set to currentCriteriaHash.",
            "next":{"via":"query","op":"dispatch_policy","args":if scope == "global" {json!({})} else {json!({"agent":scope,"all":true})},
                "hint":"Review the current criteria before retrying the full replacement with its criteriaHash."}
        }).to_string());
    }
    let path = root().join("dispatch-policy.json");
    let mut updated = previous.clone();
    let criteria = string(args, "criteria");
    if scope == "global" {
        updated["criteria"] = json!(criteria);
    } else {
        if updated.get(scope).is_none() {
            updated[scope] = json!({});
        }
        updated[scope]["criteria"] = json!(criteria);
    }
    let formatted = |value: &Value| -> Result<Vec<u8>> {
        let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        Ok(bytes)
    };
    let backup = root().join("dispatch-policy.json.bak");
    save_bytes(&backup, &formatted(&previous)?)?;
    save_bytes(&path, &formatted(&updated)?)?;
    Ok(json!({"scope":scope,"criteriaHash":hash(criteria),"policyPath":path,"backupPath":backup}))
}

fn check(value: &str, allow: &[String], deny: &[String], field: &str) -> Result<()> {
    if deny.iter().any(|v| v == value) || (!allow.is_empty() && !allow.iter().any(|v| v == value)) {
        return Err(format!("DISPATCH_POLICY_DENIED: {field}={value}; read query dispatch_policy for allowed choices"));
    }
    Ok(())
}
/// Omitted fields keep the latest explicit choice independently, never a later policy default.
pub fn inherited_configuration(state: &Value, records: &[Value]) -> Value {
    let mut result = json!({});
    for (field, latest) in [
        ("model", "latestModel"),
        ("effort", "latestReasoningEffort"),
    ] {
        let recorded = records.iter().rev().find_map(|row| {
            (row["dispatchMode"] != "steered"
                && matches!(
                    row["source"][field].as_str(),
                    Some("explicit" | "thread-inherited")
                ))
            .then(|| row[field].as_str())
            .flatten()
        });
        let native_field = if field == "effort" {
            "reasoningEffort"
        } else {
            field
        };
        let value = state["latestThreadSettings"][field]
            .as_str()
            .or_else(|| state[latest].as_str())
            .or_else(|| {
                (state["runtimeSource"] == "codex-desktop-owner")
                    .then(|| state[native_field].as_str())
                    .flatten()
            })
            .or(recorded)
            .or_else(|| state[native_field].as_str());
        if let Some(value) = value {
            result[field] = json!(value);
        }
    }
    result
}

pub(crate) fn resolve(args: &mut Value) -> Result<Value> {
    resolve_with_inheritance(args, &Value::Null)
}
pub(crate) fn resolve_with_inheritance(args: &mut Value, inherited: &Value) -> Result<Value> {
    let policy = read()?.codex;
    let mut selection = json!({"reason":args["reason"],"source":{}});
    for (field, mode_field, default, allow, deny) in [
        (
            "model",
            "model",
            &policy.model,
            &policy.allow_models,
            &policy.deny_models,
        ),
        (
            "effort",
            "reasoning_effort",
            &policy.effort,
            &policy.allow_efforts,
            &policy.deny_efforts,
        ),
    ] {
        // Collaboration settings take precedence in the native turn protocol.
        let explicit = args["turn"]["collaborationMode"]["settings"][mode_field]
            .as_str()
            .or_else(|| args["turn"][field].as_str())
            .or_else(|| args[field].as_str())
            .or_else(|| {
                if field == "model" {
                    args["thread"]["model"].as_str()
                } else {
                    None
                }
            });
        let inherited = inherited[field].as_str();
        let value = explicit.or(inherited).or(default.as_deref());
        check_known(value, allow, deny, field)?;
        selection["source"][field] = json!("native-default");
        let Some(value) = value.map(str::to_owned) else {
            continue;
        };
        selection["source"][field] = json!(if explicit.is_some() {
            "explicit"
        } else if inherited.is_some() {
            "thread-inherited"
        } else {
            "policy-default"
        });
        selection[field] = json!(value);
        args[field] = json!(value);
        if args["turn"].is_object() {
            args["turn"][field] = json!(value);
            if args["turn"]["collaborationMode"].is_object() {
                args["turn"]["collaborationMode"]["settings"][mode_field] = json!(value);
            }
        }
        if field == "model" && args["thread"].is_object() {
            args["thread"]["model"] = json!(value);
        }
    }
    let explicit = args["turn"]["serviceTierForTurn"]
        .as_str()
        .or_else(|| args["turn"]["serviceTier"].as_str())
        .or_else(|| args["serviceTier"].as_str())
        .or_else(|| args["thread"]["serviceTier"].as_str());
    let tier = explicit
        .or_else(|| {
            policy
                .service_tiers
                .get(string(&selection, "model"))
                .map(String::as_str)
        })
        .or(policy.service_tier.as_deref())
        .map(str::to_owned);
    selection["serviceTier"] = json!(tier);
    selection["source"]["serviceTier"] = json!(if explicit.is_some() {
        "explicit"
    } else if tier.is_some() {
        "policy-default"
    } else {
        "native-default"
    });
    if let Some(tier) = tier {
        // A one-turn native override must not change the thread's defaults.
        if !args["turn"]["serviceTierForTurn"].is_string() {
            args["serviceTier"] = json!(tier);
            if args["turn"].is_object() {
                args["turn"]["serviceTier"] = json!(tier);
            }
            if args["thread"].is_object() {
                args["thread"]["serviceTier"] = json!(tier);
            }
        }
    }
    Ok(selection)
}
async fn models(c: &control::Control) -> Result<Value> {
    let mut rows = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let page = c
            .request("model/list", json!({"cursor":cursor}), 15000)
            .await?;
        for model in page["data"].as_array().ok_or("NATIVE_MODELS_MISSING")? {
            rows.push(codex_model(model));
        }
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    Ok(json!(rows))
}
pub(super) fn codex_model(model: &Value) -> Value {
    let mut row = json!({
        "model":model["model"], "name":model["displayName"],
        "defaultServiceTier":model["defaultServiceTier"], "serviceTiers":model["serviceTiers"],
        "efforts":model["supportedReasoningEfforts"].as_array().into_iter().flatten()
            .map(|e| e["reasoningEffort"].clone()).collect::<Vec<_>>()
    });
    if model["displayName"].as_str().is_some_and(|s| !s.is_empty()) {
        row["displayName"] = model["displayName"].clone();
    }
    let provider = &model["provider"];
    if let Some(id) = provider["id"]
        .as_str()
        .or(provider.as_str())
        .or(model["providerId"].as_str())
        .filter(|s| !s.is_empty())
    {
        row["provider"] = json!({"id":id,"name":provider["name"].as_str().or(model["providerName"].as_str()).filter(|s| !s.is_empty()).unwrap_or(id)});
    }
    if model["contextWindow"].as_u64().is_some_and(|n| n > 0) {
        row["contextWindow"] = model["contextWindow"].clone();
    }
    row
}

/// Read labels only; recorded specs and dispatch defaults are not changed.
pub(crate) async fn catalog(
    c: &control::Control,
    agents: &agents::AgentHost,
    args: &Value,
) -> Result<Value> {
    if args["agent"] == "codex" {
        return Ok(
            json!({"source":"codex-model-list","authoritative":true,"models":models(c).await?}),
        );
    }
    let mut request = args.clone();
    request["all"] = json!(true);
    let rows = agents.dispatch_facts(&request).await?;
    Ok(rows
        .first()
        .map(|row| row["capabilities"].clone())
        .unwrap_or_else(
            || json!({"authoritative":false,"unavailable":"agent-catalog-unavailable"}),
        ))
}

async fn codex_facts(c: &control::Control, compact: bool) -> Result<Value> {
    let policy = read()?;
    let (models, quota) = tokio::join!(
        models(c),
        c.request("account/rateLimits/read", json!({}), 15000)
    );
    let quota = quota.map(|v| {
        let pools = if let Some(map) = v["rateLimitsByLimitId"].as_object() {
            map.iter().map(|(id, pool)| (id.clone(), pool.clone())).collect::<Vec<_>>()
        } else if v["rateLimits"].is_object() {
            vec![(v["rateLimits"]["limitId"].as_str().unwrap_or("codex").into(), v["rateLimits"].clone())]
        } else { vec![] };
        json!({"ordinaryUsageAllowed":v["ordinaryUsageAllowed"],"pools":pools.iter().map(|(id,p)| {
            let mut pool = json!({"id":id});
            for key in ["rateLimitReachedType","spendControlReached"] {
                if !p[key].is_null() { pool[key]=p[key].clone(); }
            }
            for key in ["primary","secondary"] {
                if p[key].is_object() {
                    pool[key]=json!({"usedPercent":p[key]["usedPercent"],"windowDurationMins":p[key]["windowDurationMins"],"resetsAt":p[key]["resetsAt"]});
                }
            }
            pool
        }).collect::<Vec<_>>()})
    });
    let authoritative = models.is_ok();
    Ok(json!({
        "observedAt":now(),"authoritative":authoritative,
        "models":models.unwrap_or_else(|error| json!({"unavailable":error})),
        "policy":policy,
        "quota":quota.unwrap_or_else(|error| json!({"unavailable":error})),
        "history":history_view("codex", compact).unwrap_or_else(|error| json!({"unavailable":error}))
    }))
}

pub(crate) async fn query(
    c: &control::Control,
    agents: &agents::AgentHost,
    subscriptions: &subscriptions::SubscriptionService,
    args: &Value,
) -> Result<Value> {
    let policies = read()?;
    let mut rows = agents.dispatch_facts(args).await?;
    let snapshot = subscriptions.snapshot().await;
    for row in &mut rows {
        let agent = string(row, "agent").to_owned();
        row["accounts"] = crate::accounts::dispatch_accounts(&agent)?;
        let providers = snapshot["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| {
                p["agentIds"]
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|id| id == &agent))
            })
            .map(|p| {
                json!({
                    "providerId":p["providerId"],"state":p["state"],"observedAt":p["observedAt"],
                    "source":p["source"],"windows":p["windows"],"error":p["error"],
                    "accountBlocked":p["accountBlocked"],"blockedPoolIds":p["blockedPoolIds"]
                })
            })
            .collect::<Vec<_>>();
        row["availability"]["authentication"] = json!({
            "inference":"unknown",
            "quotaAccess":providers.iter().map(|p| json!({
                "providerId":p["providerId"],"state":p["state"],"observedAt":p["observedAt"],
                "error":p["error"]
            })).collect::<Vec<_>>()
        });
        if agent == "codex" {
            let facts = codex_facts(c, args["view"] != "full").await?;
            for key in ["models", "authoritative", "quota", "history"] {
                row[key] = facts[key].clone();
            }
            row["policy"] = facts["policy"]["codex"].clone();
            row["selectionSupported"] = json!(true);
        } else {
            row["quota"] = if providers.is_empty() {
                json!({"unavailable":"provider-not-integrated"})
            } else {
                json!({"source":"subscriptions","providers":providers,"modelAssociation":"unknown"})
            };
            row["policy"] =
                serde_json::to_value(policies.agents.get(&agent).cloned().unwrap_or_default())
                    .map_err(|e| e.to_string())?;
            row["history"] = history_view(&agent, args["view"] != "full")
                .unwrap_or_else(|error| json!({"unavailable":error}));
            row["selectionSupported"] = json!(true);
        }
    }
    Ok(decision::present(
        json!({"observedAt":now(),"policyPath":root().join("dispatch-policy.json"),"criteria":policies.criteria,"agents":rows}),
        args,
    ))
}

fn history(agent: &str) -> Result<Value> {
    history_view(agent, false)
}

fn history_view(agent: &str, compact: bool) -> Result<Value> {
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    for kind in ["dispatches", "reviews"] {
        let dir = root().join(kind);
        if dir.exists() {
            for entry in file_cache::entries(&dir)?.iter() {
                rows.extend(read_rows(&entry.path)?);
            }
        }
    }
    Ok(summarize_history(
        &rows,
        agent,
        compact,
        chrono::Utc::now() - chrono::Duration::days(30),
    ))
}

pub(crate) fn summarize_history(
    rows: &[Value],
    agent: &str,
    compact: bool,
    cutoff: chrono::DateTime<chrono::Utc>,
) -> Value {
    #[derive(Default)]
    struct Group {
        dispatches: u64,
        pass: u64,
        rework: u64,
        failed: u64,
        interrupted: u64,
        durations: Vec<u64>,
        external_reviews: u64,
        external_pass: u64,
        external_rework: u64,
    }
    let mut groups = std::collections::BTreeMap::<(String, String, String, String), Group>::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let external = row["dispatchOrigin"] == "external";
        if row["agent"].as_str().unwrap_or("codex") != agent
            || (!external && agent != "codex" && row["submission"] != "accepted")
            || row["purpose"] == "self-test"
            || (!external && row["dispatchMode"] != "new-turn")
            || !chrono::DateTime::parse_from_rfc3339(string(
                if external { &row["review"] } else { row },
                if external {
                    "reviewedAt"
                } else {
                    "submittedAt"
                },
            ))
            .is_ok_and(|time| time >= cutoff)
            || !seen.insert((string(row, "threadId"), string(row, "turnId")))
        {
            continue;
        }
        let value = |field: &str| {
            row["turnEvidence"][field]
                .as_str()
                .or_else(|| row["effectiveConfiguration"][field].as_str())
                .filter(|v| !v.is_empty() && *v != "unknown")
                .unwrap_or_else(|| string(&row, field))
                .to_owned()
        };
        if external
            && ["model", "effort"].iter().any(|field| {
                let v = value(field);
                v.is_empty() || v == "unknown"
            })
        {
            continue;
        }
        let group = groups
            .entry((
                value("model"),
                if agent == "codex" {
                    value("effort")
                } else {
                    String::new()
                },
                {
                    let tier = value("serviceTier");
                    if tier.is_empty() {
                        "unknown".into()
                    } else {
                        tier
                    }
                },
                row.get("options").cloned().unwrap_or(json!({})).to_string(),
            ))
            .or_default();
        if external {
            group.external_reviews += 1;
            match string(&row["review"], "verdict") {
                "pass" => group.external_pass += 1,
                "rework" => group.external_rework += 1,
                _ => {}
            }
            continue;
        }
        group.dispatches += 1;
        match string(&row["terminal"], "state") {
            "failed" => {
                group.failed += 1;
                continue;
            }
            "interrupted" | "cancelled" => {
                group.interrupted += 1;
                continue;
            }
            _ => {}
        }
        match string(&row["review"], "verdict") {
            "pass" => group.pass += 1,
            "rework" => group.rework += 1,
            _ => {}
        }
        if let Some(ms) = row["terminal"]["observedDurationMs"].as_u64() {
            group.durations.push(ms);
        }
    }
    if compact {
        let mut other = Group::default();
        groups.retain(|_, group| {
            if group.dispatches >= 10 {
                return true;
            }
            other.external_reviews += group.external_reviews;
            other.external_pass += group.external_pass;
            other.external_rework += group.external_rework;
            other.dispatches += group.dispatches;
            other.pass += group.pass;
            other.rework += group.rework;
            other.failed += group.failed;
            other.interrupted += group.interrupted;
            other.durations.append(&mut group.durations);
            false
        });
        if other.dispatches + other.external_reviews > 0 {
            groups.insert(
                ("other".into(), String::new(), String::new(), "{}".into()),
                other,
            );
        }
    }
    let mut groups = groups
        .into_iter()
        .map(|((model, effort, tier, options), mut g)| {
            let mut row = json!({"agent":agent,"model":model,"options":serde_json::from_str::<Value>(&options).unwrap_or(json!({})),"effort":effort,"serviceTier":tier,"dispatches":g.dispatches,
            "pass":g.pass,"rework":g.rework,"failed":g.failed,"interrupted":g.interrupted,"unreviewed":g.dispatches-g.pass-g.rework-g.failed-g.interrupted});
            if g.external_reviews > 0 {
                row["external"] = json!({"reviews":g.external_reviews,"pass":g.external_pass,"rework":g.external_rework});
            }
            if !g.durations.is_empty() {
                g.durations.sort_unstable();
                let n = g.durations.len();
                row["medianObservedDurationMs"] =
                    json!((g.durations[(n - 1) / 2] as f64 + g.durations[n / 2] as f64) / 2.0);
                row["durationSamples"] = json!(n);
            }
            row
        })
        .collect::<Vec<_>>();
    // Keep the guide query small even after many model generations; disclose omitted groups.
    groups.sort_by_key(|g| {
        std::cmp::Reverse(
            g["dispatches"].as_u64().unwrap_or(0) + g["external"]["reviews"].as_u64().unwrap_or(0),
        )
    });
    let omitted = if compact {
        groups.len().saturating_sub(12)
    } else {
        0
    };
    if compact {
        groups.truncate(12);
    }
    let mut history = json!({"windowDays":30,"excludedPurpose":"self-test","groups":groups});
    if omitted > 0 {
        history["omittedGroups"] = json!(omitted);
    }
    history
}

/// Match the effective configuration; never substitute another model's duration.
pub(crate) fn revisit_minutes(receipt: &Value) -> Option<u64> {
    let selection = receipt
        .get("dispatch")
        .or_else(|| receipt.pointer("/result/dispatch"))?;
    let agent = receipt["agent"].as_str().unwrap_or("codex");
    let history = history(agent).ok()?;
    let groups = history["groups"].as_array()?;
    let candidates = groups.iter().filter(|g| {
        g["model"] == selection["model"]
            && g["effort"].as_str().unwrap_or("") == selection["effort"].as_str().unwrap_or("")
            && g["options"].as_object()
                == selection.get("options").unwrap_or(&json!({})).as_object()
    });
    // Service-tier history is separate. Without a known tier, do not guess among groups.
    let mut candidates: Vec<_> = candidates
        .filter(|g| {
            selection["serviceTier"]
                .as_str()
                .is_none_or(|tier| g["serviceTier"] == tier)
        })
        .collect();
    if candidates.len() != 1 {
        return None;
    }
    let ms = candidates.pop()?["medianObservedDurationMs"].as_f64()?;
    Some((ms / 60000.0).ceil().max(1.0) as u64)
}

fn directory(thread: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(thread).map_err(|_| "INVALID_THREAD_ID")?;
    Ok(root().join("dispatches").join(thread))
}
pub(crate) fn records(thread: &str) -> Result<Vec<Value>> {
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    read_records(thread)
}
fn read_records(thread: &str) -> Result<Vec<Value>> {
    read_rows(&directory(thread)?)
}
fn read_external_reviews(thread: &str) -> Result<Vec<Value>> {
    directory(thread)?;
    read_rows(&root().join("reviews").join(thread))
}
fn read_rows(dir: &Path) -> Result<Vec<Value>> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut rows = file_cache::entries(dir)?
        .iter()
        .filter(|entry| entry.path.extension().is_some_and(|v| v == "json"))
        .map(|entry| load(&entry.path))
        .collect::<Result<Vec<_>>>()?;
    rows.sort_by_key(|r| string(r, "submittedAt").to_owned());
    Ok(rows)
}
pub(crate) fn record(receipt: &Value) -> Result<()> {
    crate::src_conversations::record(receipt).map_err(|e| {
        format!("SUBMISSION_UNCONFIRMED: dispatch accepted; conversation record failed: {e}")
    })?;
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    let mut row = receipt["task"]["dispatch"].clone();
    for key in ["requestId", "threadId", "turnId", "dispatchMode"] {
        row[key] = receipt[key].clone();
    }
    row["title"] = json!(crate::control::dispatch_title(&receipt["task"]));
    row["origin"] = receipt["origin"].clone();
    if let Some(caller) = crate::dispatch_caller::validated(&receipt["caller"]) {
        row["caller"] = caller;
    }
    row["agentAccountId"] = receipt["agentAccountId"].clone();
    row["agent"] = receipt["agent"]
        .as_str()
        .map_or(json!("codex"), |v| json!(v));
    row["taskId"] = receipt
        .get("taskId")
        .unwrap_or(&receipt["threadId"])
        .clone();
    if row["options"].is_null() {
        row["options"] = json!({});
    }
    row["configurationEvidence"] = json!(if row["dispatchMode"] == "steered" {
        "active-turn-settings"
    } else {
        "submitted-to-native"
    });
    let write = || -> Result<()> {
        let dir = directory(string(receipt, "threadId"))?;
        uuid::Uuid::parse_str(string(receipt, "requestId")).map_err(|_| "INVALID_REQUEST_ID")?;
        let mut previous = read_records(string(receipt, "threadId"))?;
        row["purpose"] = receipt["arguments"]
            .get("purpose")
            .cloned()
            .or_else(|| previous.last().and_then(|r| r.get("purpose")).cloned())
            .unwrap_or(json!("task"));
        if row["dispatchMode"] == "new-turn" {
            previous.extend(read_external_reviews(string(receipt, "threadId"))?);
            let rework = previous
                .iter()
                .filter(|r| r["review"]["verdict"] == "rework")
                .filter(|r| {
                    !previous.iter().any(|next| {
                        next["dispatchMode"] == "new-turn"
                            && next.get("submission").is_none_or(|v| v == "accepted")
                            && string(next, "submittedAt") > string(&r["review"], "reviewedAt")
                    })
                })
                .max_by_key(|r| string(&r["review"], "reviewedAt"));
            if let Some(rework) = rework {
                row["reworkOf"] = rework["turnId"].clone();
            }
        }
        crate::coordination::observers::save_owner(
            &dir.join(format!("{}.json", string(receipt, "requestId"))),
            &row,
            crate::coordination::observers::Owner::Dispatch,
        )
    };
    let mut write = write;
    write().map_err(|e| format!("SUBMISSION_UNCONFIRMED: dispatch accepted; record failed: {e}"))
}
/// Register observed native work without pretending ARC submitted another request.
pub(crate) fn record_native_retry(thread: &str, previous: &str, retry: &Value) -> Result<bool> {
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    let rows = read_records(thread)?;
    let turn = string(retry, "turnId");
    if let Some(row) = rows.iter().find(|r| r["turnId"] == turn) {
        return Ok(row["dispatchSource"] == "native-retry" && row["retryOf"] == previous);
    }
    let Some(parent) = rows.iter().rev().find(|r| r["turnId"] == previous) else {
        return Ok(false);
    };
    uuid::Uuid::parse_str(turn).map_err(|_| "INVALID_TURN_ID")?;
    let started = retry["startedAt"]
        .as_i64()
        .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
        .ok_or("NATIVE_RETRY_START_MISSING")?;
    let config = &retry["configuration"];
    let evidence = config["source"]
        .as_str()
        .unwrap_or("native-persisted-turn-context");
    let row = json!({
        "agent":"codex","taskId":thread,"options":{},"requestId":turn,"threadId":thread,"turnId":turn,"dispatchMode":"new-turn",
        "origin":parent["origin"],"dispatchSource":"native-retry","retryOf":previous,"nativeTrigger":retry["trigger"],
        "model":config["model"],"effort":config["effort"],"serviceTier":config["serviceTier"],
        "source":{"model":evidence,"effort":evidence,"serviceTier":evidence},
        "configurationEvidence":evidence,"effectiveConfiguration":config,
        "submittedAt":started.to_rfc3339(),"observedAt":now(),
        "purpose":parent["purpose"],"reason":"Native retry of failed or interrupted ARC dispatch"
    });
    crate::coordination::observers::save_owner(
        &directory(thread)?.join(format!("{turn}.json")),
        &row,
        crate::coordination::observers::Owner::Dispatch,
    )?;
    Ok(true)
}
// Reconciliation time is an observation, never evidence of continued execution.
pub(crate) fn terminal_snapshot(
    row: &Value,
    state: &str,
    timing: &Value,
    last_activity: Option<&str>,
    reconciled: bool,
) -> Value {
    let observed = now();
    let native_end = timing["endedAt"].as_str();
    let ended = native_end
        .or(last_activity)
        .or((!reconciled).then_some(observed.as_str()));
    let start = timing["startedAt"]
        .as_str()
        .unwrap_or(string(row, "submittedAt"));
    let elapsed = ended.and_then(|end| {
        let start = chrono::DateTime::parse_from_rfc3339(start).ok()?;
        let end = chrono::DateTime::parse_from_rfc3339(end).ok()?;
        Some((end - start).num_milliseconds().max(0))
    });
    json!({"state":state,"observedAt":observed,"endedAt":ended,
        "observedDurationMs":elapsed,"reconciledAfterRestart":reconciled,
        "timeBasis":if native_end.is_some(){"native-terminal"}else if last_activity.is_some(){"last-observed-activity"}else if reconciled{"unknown"}else{"observed-terminal"}})
}

pub(crate) async fn complete(
    c: &control::Control,
    thread: &str,
    turn: &str,
    state: &str,
    last_activity: Option<&str>,
    reconciled: bool,
) -> Result<Value> {
    if !records(thread)?.iter().any(|r| r["turnId"] == turn) {
        return Ok(Value::Null);
    }
    let persisted = match c
        .request(
            "thread/read",
            json!({"threadId":thread,"includeTurns":false}),
            5000,
        )
        .await
    {
        Ok(t) => control::persisted_turns(&t["thread"]),
        Err(_) => control::PersistedTurns::default(),
    };
    // Re-read under the same lock as reviews; observation must never erase a later verdict.
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    let mut rows = read_records(thread)?
        .into_iter()
        .filter(|r| r["turnId"] == turn)
        .collect::<Vec<_>>();
    for row in &mut rows {
        if row["terminal"].is_null() {
            row["terminal"] = terminal_snapshot(
                row,
                state,
                persisted.timings.get(turn).unwrap_or(&Value::Null),
                last_activity,
                reconciled,
            );
        }
        if let Some(config) = persisted.configurations.get(turn) {
            row["effectiveConfiguration"] = json!({"model":config["model"],"effort":config["effort"],"serviceTier":config["serviceTier"],"threadServiceTier":config["threadServiceTier"],"source":config["source"]});
        }
        crate::coordination::observers::save_owner(
            &directory(thread)?.join(format!("{}.json", string(row, "requestId"))),
            row,
            crate::coordination::observers::Owner::Dispatch,
        )?;
    }
    Ok(json!(rows))
}

pub(crate) async fn review(c: &control::Control, args: &Value) -> Result<Value> {
    let thread = string(args, "threadId");
    directory(thread)?;
    let mut cursor = Value::Null;
    let selected = loop {
        let page = c.request("thread/turns/list",
            json!({"threadId":thread,"limit":20,"sortDirection":"desc","itemsView":"notLoaded","cursor":cursor}), 10000).await?;
        let turns = page["data"].as_array().ok_or("NATIVE_TURNS_MISSING")?;
        if let Some(turn) = select_review_turn(turns, args["turnId"].as_str())? {
            break turn.clone();
        }
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            return Err("REVIEW_TERMINAL_TURN_NOT_FOUND".into());
        }
    };
    let turn = string(&selected, "id");
    let state = match string(&selected, "status") {
        "interrupted" => "cancelled",
        other => other,
    };
    complete(c, thread, turn, state, None, false).await?;
    if records(thread)?.iter().any(|row| row["turnId"] == turn) {
        return save_review(thread, turn, args, &Value::Null);
    }
    let metadata = c
        .request(
            "thread/read",
            json!({"threadId":thread,"includeTurns":false}),
            10000,
        )
        .await
        .unwrap_or(Value::Null);
    let thread_metadata = &metadata["thread"];
    let persisted = control::persisted_turns(thread_metadata)
        .configurations
        .remove(turn)
        .unwrap_or(Value::Null);
    let configuration = review_configuration(&[&persisted, &selected, thread_metadata]);
    let external = json!({"agent":"codex","threadId":thread,"taskId":thread,"turnId":turn,
        "dispatchOrigin":"external","model":configuration["model"],"effort":configuration["effort"],
        "serviceTier":configuration["serviceTier"],"options":{},"terminal":{"state":state}});
    save_review(thread, turn, args, &external)
}

pub(crate) fn select_review_turn<'a>(
    turns: &'a [Value],
    requested: Option<&str>,
) -> Result<Option<&'a Value>> {
    let terminal = |turn: &Value| {
        matches!(
            string(turn, "status"),
            "completed" | "failed" | "interrupted" | "cancelled"
        )
    };
    let selected = turns
        .iter()
        .find(|turn| requested.map_or_else(|| terminal(turn), |id| turn["id"] == id));
    if selected.is_some_and(|turn| !terminal(turn)) {
        return Err("REVIEW_REQUIRES_TERMINAL_TURN".into());
    }
    Ok(selected)
}

pub(crate) fn review_configuration(metadata: &[&Value]) -> Value {
    let mut configuration = json!({});
    for (field, names) in [
        ("model", &["model"][..]),
        (
            "effort",
            &[
                "effort",
                "reasoningEffort",
                "reasoning_effort",
                "thinkingLevel",
            ][..],
        ),
        (
            "serviceTier",
            &["serviceTierForTurn", "serviceTier", "service_tier"][..],
        ),
    ] {
        configuration[field] = metadata
            .iter()
            .find_map(|m| {
                names
                    .iter()
                    .find_map(|key| m[key].as_str().filter(|v| !v.is_empty() && *v != "unknown"))
            })
            .map_or(Value::Null, |v| json!(v));
    }
    configuration
}

pub(crate) fn reviews(thread: &str) -> Result<Vec<Value>> {
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    let mut rows = read_records(thread)?;
    rows.extend(read_external_reviews(thread)?);
    let mut seen = std::collections::HashSet::new();
    Ok(rows
        .into_iter()
        .filter(|r| r["review"].is_object() && seen.insert(string(r, "turnId").to_owned()))
        .map(|r| json!({"turnId":r["turnId"],"review":r["review"]}))
        .collect())
}

pub(crate) fn local_review_matches(rows: &[Value], request: &str) -> bool {
    !rows.is_empty()
        && rows.iter().all(|r| {
            r["review"]["requestId"] == request
                && r["review"]["verdict"] == "pass"
                && r["review"]["reviewer"]["controlSource"] == "ARC"
        })
}

pub(crate) fn undo_local_review(thread: &str, turn: &str, request: &str) -> Result<Value> {
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    let mut rows = read_records(thread)?
        .into_iter()
        .filter(|r| r["turnId"] == turn)
        .collect::<Vec<_>>();
    let external = rows.is_empty();
    if external {
        rows = read_external_reviews(thread)?
            .into_iter()
            .filter(|r| r["turnId"] == turn)
            .collect();
    }
    if !local_review_matches(&rows, request) {
        return Err("REVIEW_CHANGED: reload the task before undoing a local pass review".into());
    }
    for mut row in rows {
        row.as_object_mut().unwrap().remove("review");
        let path = if external {
            root()
                .join("reviews")
                .join(thread)
                .join(format!("{}.json", hash(turn)))
        } else {
            directory(thread)?.join(format!("{}.json", string(&row, "requestId")))
        };
        save(&path, &row)?;
    }
    Ok(json!({"undone":true,"turnId":turn}))
}

pub(crate) fn review_record(
    args: &Value,
    origin: &Value,
    dispatch: Option<&Value>,
    external: &Value,
    reviewed_at: &str,
) -> Value {
    let mut review = json!({"verdict":args["verdict"],"note":args["note"],"reviewedAt":reviewed_at,"requestId":args["requestId"],
        "reviewer":{"sourceId":origin["sourceId"],"controlSource":origin["controlSource"],"sessionId":origin["sessionId"],"target":origin["target"]},
        "dispatchOrigin":if dispatch.is_some() {"arc"} else {"external"},
        "dispatchRequestId":dispatch.map(|r| &r["requestId"])});
    if dispatch.is_none() {
        for field in ["model", "effort", "serviceTier"] {
            review[field] = external[field].clone();
        }
    }
    review
}

fn save_review(thread: &str, turn: &str, args: &Value, external: &Value) -> Result<Value> {
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    let mut rows = read_records(thread)?
        .into_iter()
        .filter(|r| r["turnId"] == turn)
        .collect::<Vec<_>>();
    if !matches!(string(args, "verdict"), "pass" | "rework") {
        return Err("INVALID_REVIEW_VERDICT: use pass or rework".into());
    }
    let is_external = rows.is_empty();
    let dispatch = rows
        .iter()
        .find(|r| r["dispatchMode"] == "new-turn")
        .or(rows.first());
    let review = review_record(
        args,
        &crate::kernel::origin::current_origin(),
        dispatch,
        external,
        &now(),
    );
    if is_external {
        let mut row = external.clone();
        row["review"] = review.clone();
        save(
            &root()
                .join("reviews")
                .join(thread)
                .join(format!("{}.json", hash(turn))),
            &row,
        )?;
        return Ok(json!({"threadId":thread,"turnId":turn,"review":row["review"]}));
    }
    for row in &mut rows {
        row["review"] = review.clone();
        save(
            &directory(thread)?.join(format!("{}.json", string(row, "requestId"))),
            row,
        )?;
    }
    Ok(json!({"threadId":thread,"turnId":turn,"review":review}))
}

/// Snapshot at submission; later session changes never rewrite this turn's choices.
pub(crate) fn agent_record(task: &Value, args: &Value) -> Result<()> {
    let mut receipt = json!({"agentAccountId":task["agentAccountId"],"origin":crate::kernel::origin::current_origin(),"agent":task["agent"],"taskId":task["taskId"],"threadId":task["taskId"],
        "turnId":task["turnId"],"requestId":args["requestId"],"dispatchMode":"new-turn",
        "srcConversation":args["srcConversation"],"arguments":args,"task":{"dispatch":task["dispatch"]}});
    crate::dispatch_caller::attach_current(&mut receipt);
    record(&receipt)
}
/// The Agent transport has flushed the prompt frame; this is submission, not completion.
pub(crate) fn agent_submitted(task: &Value) -> Result<()> {
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    let task_id = string(task, "taskId");
    for mut row in read_records(task_id)?
        .into_iter()
        .filter(|r| r["turnId"] == task["turnId"] && r["agent"] == task["agent"])
    {
        row["submissionObserved"] = json!(true);
        crate::coordination::observers::save_owner(
            &directory(task_id)?.join(format!("{}.json", string(&row, "requestId"))),
            &row,
            crate::coordination::observers::Owner::Dispatch,
        )?;
    }
    Ok(())
}
pub(crate) fn agent_observe(task: &Value, submission: Option<&str>) -> Result<()> {
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    let task_id = string(task, "taskId");
    for mut row in read_records(task_id)?
        .into_iter()
        .filter(|r| r["turnId"] == task["turnId"] && r["agent"] == task["agent"])
    {
        if let Some(status) = submission {
            row["submission"] = json!(status);
        }
        let state = string(task, "status");
        if matches!(state, "completed" | "cancelled" | "failed")
            && row["terminal"].is_null()
            && row["submission"] == "accepted"
        {
            let end = chrono::Utc::now();
            let elapsed = chrono::DateTime::parse_from_rfc3339(string(&row, "submittedAt"))
                .ok()
                .map(|start| {
                    (end - start.with_timezone(&chrono::Utc))
                        .num_milliseconds()
                        .max(0)
                });
            row["terminal"] =
                json!({"state":state,"observedAt":end.to_rfc3339(),"observedDurationMs":elapsed});
        }
        if task["turnEvidence"].is_object() {
            row["turnEvidence"] = task["turnEvidence"].clone();
        }
        if task["agent"] == "pi"
            && task["lastMessage"]["model"].is_string()
            && task["lastMessage"]["provider"].is_string()
        {
            let message = &task["lastMessage"];
            row["turnEvidence"] = json!({"model":format!("{}/{}",string(message,"provider"),string(message,"model")),"source":"pi-assistant-message","scope":"turn","observedAt":now()});
        }
        crate::coordination::observers::save_owner(
            &directory(task_id)?.join(format!("{}.json", string(&row, "requestId"))),
            &row,
            crate::coordination::observers::Owner::Dispatch,
        )?;
    }
    Ok(())
}
pub(crate) fn agent_review(args: &Value, snapshot: &Value) -> Result<Value> {
    let task = string(args, "taskId");
    let mut rows = records(task)?;
    rows.extend(read_external_reviews(task)?);
    let row = select_agent_review(rows, args, snapshot)?;
    let mut result = save_review(task, string(&row, "turnId"), args, &row)?;
    result.as_object_mut().unwrap().remove("threadId");
    result["agent"] = args["agent"].clone();
    result["taskId"] = json!(task);
    Ok(result)
}

pub(crate) fn select_agent_review(
    mut rows: Vec<Value>,
    args: &Value,
    snapshot: &Value,
) -> Result<Value> {
    let task = string(args, "taskId");
    if snapshot["turnId"].is_string() && !rows.iter().any(|r| r["turnId"] == snapshot["turnId"]) {
        let configuration = review_configuration(&[
            &snapshot["turnEvidence"],
            snapshot,
            &snapshot["options"],
            &snapshot["metadata"],
        ]);
        rows.push(json!({"agent":snapshot["agent"],"taskId":task,"threadId":task,"turnId":snapshot["turnId"],
            "dispatchOrigin":"external","model":configuration["model"],"effort":configuration["effort"],
            "serviceTier":configuration["serviceTier"],"options":snapshot.get("options").cloned().unwrap_or(json!({})),"observedAt":snapshot["updatedAt"],
            "terminal":if matches!(string(snapshot,"status"),"completed"|"failed"|"cancelled") {json!({"state":snapshot["status"]})} else {Value::Null}}));
    }
    for (turn, status) in snapshot["tracking"]["turnStatuses"]
        .as_object()
        .into_iter()
        .flatten()
    {
        if rows.iter().any(|row| row["turnId"] == *turn) {
            continue;
        }
        let summary = &snapshot["tracking"]["turnDispatchSummaries"][turn];
        let configuration = review_configuration(&[summary]);
        rows.push(json!({"agent":snapshot["agent"],"taskId":task,"threadId":task,"turnId":turn,
            "dispatchOrigin":"external","model":configuration["model"],"effort":configuration["effort"],
            "serviceTier":configuration["serviceTier"],"options":{},
            "observedAt":snapshot["tracking"]["turnTimings"][turn]["endedAt"],
            "terminal":if matches!(status.as_str(),Some("completed"|"failed"|"cancelled")) {json!({"state":status})} else {Value::Null}}));
    }
    let row = rows
        .iter()
        .filter(|r| r["agent"] == args["agent"])
        .filter(|r| {
            if args["turnId"].is_string() {
                r["turnId"] == args["turnId"]
            } else {
                r["terminal"].is_object()
            }
        })
        .max_by_key(|r| {
            if r["turnId"] == snapshot["turnId"] {
                String::from("~")
            } else {
                r["submittedAt"]
                    .as_str()
                    .unwrap_or_else(|| string(r, "observedAt"))
                    .to_owned()
            }
        })
        .ok_or("REVIEW_TERMINAL_TURN_NOT_FOUND")?;
    if !row["terminal"].is_object() {
        return Err("REVIEW_REQUIRES_TERMINAL_TURN".into());
    }
    Ok(row.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dispatch_history_polls_read_only_changed_turns() {
        // Regression: notification and timeline polls repeatedly opened every dispatch in a thread.
        struct Sandbox(PathBuf);
        impl Drop for Sandbox {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let dir = Sandbox(std::env::temp_dir().join(format!("arc-dispatch-cache-{}", id())));
        for n in 0..338 {
            save(
                &dir.0.join(format!("{n}.json")),
                &json!({"turnId":n,"state":"completed"}),
            )
            .unwrap();
        }
        assert_eq!(read_rows(&dir.0).unwrap().len(), 338);
        let warm = file_cache::thread_io();
        for _ in 0..3 {
            assert_eq!(read_rows(&dir.0).unwrap().len(), 338);
        }
        assert_eq!(file_cache::thread_io(), warm);
        save(&dir.0.join("0.json"), &json!({"turnId":0,"state":"failed"})).unwrap();
        assert!(read_rows(&dir.0)
            .unwrap()
            .iter()
            .any(|r| r["turnId"] == 0 && r["state"] == "failed"));
        assert_eq!(file_cache::thread_io().file_opens - warm.file_opens, 1);
        assert_eq!(
            file_cache::thread_io().directory_reads,
            warm.directory_reads
        );
    }

    #[test]
    fn reconciled_terminal_snapshot_uses_execution_evidence() {
        // Regression: restart observation time inflated terminal dispatch duration by downtime.
        let row = json!({"submittedAt":"2026-01-01T00:00:00Z"});
        let timing = json!({"startedAt":"2026-01-01T00:00:00Z","endedAt":"2026-01-01T00:10:00Z"});
        let native = terminal_snapshot(
            &row,
            "cancelled",
            &timing,
            Some("2026-01-01T00:09:00Z"),
            true,
        );
        assert_eq!(native["observedDurationMs"], 600000);
        assert_eq!(native["timeBasis"], "native-terminal");
        let fallback = terminal_snapshot(
            &row,
            "cancelled",
            &Value::Null,
            Some("2026-01-01T00:09:00Z"),
            true,
        );
        assert_eq!(fallback["observedDurationMs"], 540000);
        assert_eq!(fallback["timeBasis"], "last-observed-activity");
        let unknown = terminal_snapshot(&row, "cancelled", &Value::Null, None, true);
        assert!(unknown["observedDurationMs"].is_null());
        assert!(unknown["endedAt"].is_null());
    }

    #[test]
    fn local_review_undo_rejects_changed_or_external_verdicts() {
        // Property: undo requires every targeted record to retain the exact local pass receipt.
        let local = json!({"review":{"requestId":"same","verdict":"pass","reviewer":{"controlSource":"ARC"}}});
        assert!(local_review_matches(&[local.clone()], "same"));
        assert!(!local_review_matches(&[], "same"));
        assert!(!local_review_matches(&[local.clone()], "different"));
        let mut external = local.clone();
        external["review"]["reviewer"]["controlSource"] = json!("external");
        assert!(!local_review_matches(&[local.clone(), external], "same"));
        let mut rework = local;
        rework["review"]["verdict"] = json!("rework");
        assert!(!local_review_matches(&[rework], "same"));
    }

    #[test]
    fn review_provenance_preserves_arc_verdict_and_marks_external_configuration() {
        // Regression: REVIEW_DISPATCH_NOT_FOUND rejected terminal turns started outside ARC.
        let args = json!({"verdict":"rework","note":"Check failed","requestId":"review-request"});
        let origin = json!({"sourceId":"source-id","controlSource":"claude","sessionId":"session","target":"target"});
        let dispatch = json!({"requestId":"dispatch-request"});
        let arc = review_record(&args, &origin, Some(&dispatch), &Value::Null, "timestamp");
        assert_eq!(arc["verdict"], "rework");
        assert_eq!(arc["note"], args["note"]);
        assert_eq!(arc["requestId"], args["requestId"]);
        assert_eq!(arc["reviewedAt"], "timestamp");
        assert_eq!(arc["dispatchOrigin"], "arc");
        assert_eq!(arc["dispatchRequestId"], "dispatch-request");
        assert_eq!(arc["reviewer"], origin);
        let external = review_record(
            &args,
            &origin,
            None,
            &json!({"model":"model","effort":"high"}),
            "timestamp",
        );
        assert_eq!(external["dispatchOrigin"], "external");
        assert!(external["dispatchRequestId"].is_null());
        assert_eq!(external["model"], "model");
        assert_eq!(external["effort"], "high");
        assert!(external["serviceTier"].is_null());
    }

    #[test]
    fn terminal_selection_rejects_unknown_and_running_turns_and_skips_active_latest() {
        // Regression: external review must retain native terminal-turn validation.
        let turns = vec![
            json!({"id":"running","status":"inProgress"}),
            json!({"id":"done","status":"completed"}),
        ];
        assert_eq!(
            select_review_turn(&turns, None).unwrap().unwrap()["id"],
            "done"
        );
        assert!(select_review_turn(&turns, Some("missing"))
            .unwrap()
            .is_none());
        assert_eq!(
            select_review_turn(&turns, Some("running")).unwrap_err(),
            "REVIEW_REQUIRES_TERMINAL_TURN"
        );
        for status in ["completed", "failed", "interrupted", "cancelled"] {
            assert!(
                select_review_turn(&[json!({"id":"turn","status":status})], Some("turn"))
                    .unwrap()
                    .is_some()
            );
        }
        let args = json!({"agent":"example","taskId":"task","turnId":"turn"});
        let mut snapshot = json!({"agent":"example","turnId":"turn","status":"completed","model":"model","options":{"effort":"high"}});
        let selected = select_agent_review(vec![], &args, &snapshot).unwrap();
        assert_eq!(selected["dispatchOrigin"], "external");
        assert_eq!(selected["model"], "model");
        assert_eq!(selected["effort"], "high");
        assert_eq!(selected["terminal"]["state"], "completed");
        snapshot["tracking"] = json!({"turnStatuses":{"older":"completed"},"turnTimings":{"older":{"endedAt":"2026-01-01T00:00:00Z"}}});
        let older = select_agent_review(
            vec![],
            &json!({"agent":"example","taskId":"task","turnId":"older"}),
            &snapshot,
        )
        .unwrap();
        assert_eq!(older["dispatchOrigin"], "external");
        assert!(older["model"].is_null());
        assert_eq!(older["terminal"]["state"], "completed");
        snapshot["status"] = json!("running");
        assert_eq!(
            select_agent_review(vec![], &args, &snapshot).unwrap_err(),
            "REVIEW_REQUIRES_TERMINAL_TURN"
        );
        assert_eq!(
            select_agent_review(
                vec![],
                &json!({"agent":"example","taskId":"task","turnId":"missing"}),
                &snapshot
            )
            .unwrap_err(),
            "REVIEW_TERMINAL_TURN_NOT_FOUND"
        );
    }

    #[test]
    fn external_configuration_prefers_turn_evidence_and_retains_missing_as_null() {
        // Property: native per-turn configuration takes precedence and missing configuration stays null.
        let configuration = review_configuration(&[
            &json!({"model":"turn-model","effort":"high","serviceTier":"unknown"}),
            &json!({"model":"thread-model","effort":"low","serviceTier":"priority"}),
        ]);
        assert_eq!(
            configuration,
            json!({"model":"turn-model","effort":"high","serviceTier":"priority"})
        );
        assert_eq!(
            review_configuration(&[&json!({})]),
            json!({"model":null,"effort":null,"serviceTier":null})
        );
    }

    #[test]
    fn external_history_uses_configuration_groups_with_separate_counts_and_no_durations() {
        // Regression: external reviews must not silently skew ARC dispatch outcomes or duration samples.
        let mut arc = json!({"agent":"codex","threadId":"thread","turnId":"arc","dispatchMode":"new-turn","submittedAt":now(),"model":"model","effort":"high","serviceTier":"priority","options":{},"review":{"verdict":"pass"},"terminal":{"state":"completed","observedDurationMs":60000}});
        let external = json!({"agent":"codex","threadId":"thread","turnId":"external","dispatchOrigin":"external","model":"model","effort":"high","serviceTier":"priority","options":{},"review":{"verdict":"rework","reviewedAt":now()},"terminal":{"state":"failed","observedDurationMs":1}});
        let mut unknown = external.clone();
        unknown["turnId"] = json!("unknown");
        unknown["effort"] = Value::Null;
        let mut other = external.clone();
        other["turnId"] = json!("other");
        other["model"] = json!("another-model");
        let rows = vec![
            arc.clone(),
            external.clone(),
            external.clone(),
            unknown,
            other,
        ];
        let cutoff = chrono::Utc::now() - chrono::Duration::days(30);
        let history = summarize_history(&rows, "codex", false, cutoff);
        let groups = history["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        let group = groups.iter().find(|r| r["model"] == "model").unwrap();
        assert_eq!(group["dispatches"], 1);
        assert_eq!(group["pass"], 1);
        assert_eq!(group["rework"], 0);
        assert_eq!(group["failed"], 0);
        assert_eq!(group["unreviewed"], 0);
        assert_eq!(group["external"], json!({"reviews":1,"pass":0,"rework":1}));
        assert_eq!(group["medianObservedDurationMs"], 60000.0);
        assert_eq!(group["durationSamples"], 1);
        let compact = summarize_history(&rows, "codex", true, cutoff);
        assert_eq!(compact["groups"][0]["model"], "other");
        assert_eq!(compact["groups"][0]["external"]["reviews"], 2);
        assert_eq!(compact["groups"][0]["durationSamples"], 1);
        arc["purpose"] = json!("self-test");
        assert!(summarize_history(&[arc], "codex", false, cutoff)["groups"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}

#[cfg(test)]
mod inheritance_tests {
    use super::*;
    #[test]
    fn latest_explicit_fields_survive_omission_independently() {
        // Regression: AX-09 omitted model and effort used policy defaults after an explicit thread dispatch.
        let records = vec![
            json!({"model":"chosen-model","effort":"high","source":{"model":"explicit","effort":"explicit"}}),
            json!({"model":"policy-model","effort":"low","source":{"model":"policy-default","effort":"policy-default"}}),
            json!({"effort":"medium","source":{"effort":"explicit"}}),
        ];
        assert_eq!(
            inherited_configuration(&Value::Null, &records),
            json!({"model":"chosen-model","effort":"medium"})
        );
        assert_eq!(
            inherited_configuration(
                &json!({"latestThreadSettings":{"model":"desktop-model","effort":"low"}}),
                &records
            ),
            json!({"model":"desktop-model","effort":"low"})
        );
        assert_eq!(inherited_configuration(&Value::Null, &[]), json!({}));
    }
}

#[cfg(test)]
mod catalog_metadata_tests {
    use super::*;

    #[test]
    fn catalog_metadata_codex_retains_only_native_display_fields() {
        // Regression: Codex model/list display metadata was omitted from catalog rows.
        let native = json!({"model":"opaque-id","displayName":"Native model","provider":{"id":"native","name":"Native provider"},"contextWindow":200000,"serviceTiers":[{"id":"priority"}],"supportedReasoningEfforts":[{"reasoningEffort":"high"}]});
        let row = codex_model(&native);
        for key in [
            "model",
            "displayName",
            "provider",
            "contextWindow",
            "serviceTiers",
        ] {
            assert_eq!(row[key], native[key]);
        }
        assert_eq!(row["efforts"], json!(["high"]));
        let absent = codex_model(&json!({"model":"openai/gpt-128k"}));
        for key in ["displayName", "provider", "contextWindow"] {
            assert!(absent.get(key).is_none());
        }
    }
}
