//! Pure advisory selection. Execution defaults and explicit dispatch authority stay unchanged.
use crate::*;
use std::collections::{BTreeMap, BTreeSet};

const CANDIDATES: usize = 3;
const EXCLUSIONS: usize = 3;
const DECISION_BYTES: usize = 8 * 1024;
const FULL_BYTES: usize = 128 * 1024;

fn list(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}
fn contains(values: &Value, value: &Value) -> bool {
    values.as_array().is_some_and(|v| v.contains(value))
}
fn permitted(policy: &Value, field: &str, value: &Value) -> bool {
    let allow = &policy[format!("allow{field}")];
    !contains(&policy[format!("deny{field}")], value)
        && (list(allow).is_empty() || contains(allow, value))
}
fn at(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        chrono::DateTime::parse_from_rfc3339(value.as_str()?)
            .ok()
            .map(|d| d.timestamp())
    })
}

#[derive(Default)]
struct Allowance {
    reasons: BTreeSet<&'static str>,
    unknown: BTreeSet<&'static str>,
    used: f64,
    reset: i64,
    credit_only: bool,
    pools: Vec<Value>,
}
impl Allowance {
    fn missing(&mut self, field: &'static str) {
        self.unknown.insert(field);
        self.reasons.insert("quota_unknown");
    }
}

// Every reported pool is a constraint. Never pick a less-used pool as a substitute
// for a blocked one: native model-to-pool applicability is not currently exposed.
fn allowance(account: &Value, quota: &Value, codex: bool) -> Allowance {
    let mut out = Allowance::default();
    if account["health"]["state"] != "ready" {
        out.reasons.insert("account_unhealthy");
        if account["health"]["state"].is_null() {
            out.unknown.insert("health");
        }
    }
    if quota["state"] != "ready" {
        out.reasons.insert("quota_unavailable");
    }
    let observed = at(&quota["observedAt"]);
    if observed.is_none() {
        out.missing("quota.observedAt");
    }
    if codex {
        match quota["ordinaryUsageAllowed"].as_bool() {
            Some(false) => out.credit_only = true,
            Some(true) => {}
            None => out.missing("ordinaryUsageAllowed"),
        }
    } else if quota["accountBlocked"] == true {
        out.reasons.insert("account_blocked");
    }
    let native = list(&quota["pools"]);
    let mut pools = BTreeMap::<String, Vec<Value>>::new();
    let mut native_facts = BTreeMap::<String, Value>::new();
    for pool in native {
        let id = string(&pool, "id").to_owned();
        for slot in ["primary", "secondary"] {
            if pool[slot].is_object() {
                pools
                    .entry(id.clone())
                    .or_default()
                    .push(pool[slot].clone());
            }
        }
        pools.entry(id.clone()).or_default();
        native_facts.insert(id, pool);
    }
    // Native pools take precedence over their normalized duplicate windows.
    if native_facts.is_empty() {
        for window in list(&quota["windows"]) {
            let id = string(&window, "poolId").to_owned();
            if id.is_empty() {
                out.missing("quota.poolId");
            }
            pools.entry(id).or_default().push(window);
        }
    }
    if pools.is_empty() {
        out.missing("quota.windows");
    }
    for id in list(&quota["blockedPoolIds"]) {
        if let Some(id) = id.as_str() {
            pools.entry(id.to_owned()).or_default();
        }
    }
    for (id, windows) in pools {
        let native = &native_facts.get(&id).cloned().unwrap_or(Value::Null);
        let mut credit_only = codex && quota["ordinaryUsageAllowed"] == false;
        let blocked = contains(&quota["blockedPoolIds"], &json!(id));
        if native["spendControlReached"] == true {
            out.reasons.insert("spend_control_reached");
        }
        if native["rateLimitReachedType"].is_string() || blocked {
            if codex && native.is_object() && native["spendControlReached"] == false {
                credit_only = true;
            } else {
                out.reasons.insert("pool_blocked");
            }
        }
        if windows.is_empty() {
            out.missing("quota.windows");
        }
        let mut evidence = vec![];
        for window in windows {
            match window["usedPercent"]
                .as_f64()
                .filter(|v| v.is_finite() && *v >= 0.)
            {
                Some(used) => {
                    out.used = out.used.max(used);
                    if used >= 100. {
                        if codex {
                            credit_only = true;
                        } else {
                            out.reasons.insert("quota_exhausted");
                        }
                    }
                }
                None => out.missing("quota.usedPercent"),
            }
            match at(&window["resetsAt"]) {
                Some(reset) => {
                    out.reset = out.reset.max(reset);
                    if observed.is_some_and(|observed| reset <= observed) {
                        out.missing("quota.resetRequiresRefresh");
                    }
                }
                None => out.missing("quota.resetsAt"),
            }
            evidence
                .push(json!({"usedPercent":window["usedPercent"],"resetsAt":window["resetsAt"]}));
        }
        // Shared subscription IDs are allowance identities, never dispatch account IDs.
        let scope = account["quotaProviderId"]
            .as_str()
            .filter(|_| account["quota"]["source"] == "subscription")
            .map(|id| format!("provider:{id}"))
            .unwrap_or_else(|| format!("account:{}", string(account, "id")));
        out.pools
            .push(json!({"scope":scope,"poolId":id,"windows":evidence,
            "credits":native["credits"],"spendControlReached":native["spendControlReached"]}));
        out.credit_only |= credit_only;
        if credit_only {
            if native["credits"]["hasCredits"] != true && native["credits"]["unlimited"] != true {
                if native["credits"]["hasCredits"].is_null()
                    && native["credits"]["unlimited"].is_null()
                {
                    out.missing("credits");
                } else {
                    out.reasons.insert("credits_unavailable");
                }
            }
            if native["spendControlReached"].is_null() {
                out.missing("spendControlReached");
            }
        }
    }
    out
}

fn option(model: &Value, catalog: &Value, keys: &[&str]) -> Option<Value> {
    let own = list(&model["options"]);
    // Session-level options are only comparable for their observed model.
    let global = if catalog["currentModel"] == model["model"]
        || catalog["optionsForModel"] == model["model"]
    {
        list(&catalog["options"])
    } else {
        vec![]
    };
    own.iter()
        .chain(global.iter())
        .find(|o| keys.contains(&string(o, "id")))
        .cloned()
}
fn option_values(model: &Value, catalog: &Value, keys: &[&str]) -> Vec<Value> {
    option(model, catalog, keys)
        .map(|o| {
            list(&o["values"])
                .into_iter()
                .map(|v| v.get("value").cloned().unwrap_or(v))
                .collect()
        })
        .unwrap_or_default()
}
fn preference(pack: &Value, policy: &Value, field: &str) -> Value {
    pack.get(field)
        .filter(|v| !v.is_null())
        .or_else(|| policy.get(field))
        .cloned()
        .unwrap_or(Value::Null)
}
fn diagnostic(
    account: &Value,
    model: &Value,
    reasons: &BTreeSet<&str>,
    unknown: &BTreeSet<&str>,
) -> Value {
    json!({"agentAccountId":account["id"],"model":model,"reasonCodes":reasons,"unknown":unknown,"quotaAt":account["quota"]["observedAt"]})
}

fn effective_accounts(row: &Value) -> Vec<Value> {
    let mut accounts = list(&row["accounts"]);
    // Accounts bound to one provider consume one allowance observation. Prefer the
    // latest evidence; contradictory observations at the same time stay unknown.
    let mut shared = BTreeMap::<String, Value>::new();
    for account in &accounts {
        if account["quota"]["source"] != "subscription" {
            continue;
        }
        if let Some(provider) = account["quotaProviderId"].as_str() {
            let quota = &account["quota"];
            match shared.get_mut(provider) {
                Some(previous) if at(&previous["observedAt"]) == at(&quota["observedAt"]) => {
                    if *previous != *quota {
                        previous["state"] = json!("conflict");
                    }
                }
                Some(previous) if at(&previous["observedAt"]) > at(&quota["observedAt"]) => {}
                _ => {
                    shared.insert(provider.to_owned(), quota.clone());
                }
            }
        }
    }
    for account in &mut accounts {
        if account["quota"]["source"] == "subscription" {
            if let Some(quota) = shared.get(string(account, "quotaProviderId")) {
                account["quota"] = quota.clone();
            }
        }
    }
    accounts
}

fn context(row: &Value, pack_name: Option<&str>, pack: &Value) -> Value {
    let codex = row["agent"] == "codex";
    let policy = &row["policy"];
    let catalog = if codex { row } else { &row["capabilities"] };
    let models = list(&catalog["models"]);
    let mut unknown = BTreeSet::new();
    let mut reasons = BTreeSet::new();
    if row["availability"]["installed"] != true
        || row["availability"]["enabled"] != true
        || row["availability"]["available"] != true
    {
        reasons.insert("agent_unavailable");
    }
    if catalog["authoritative"] != true || models.is_empty() {
        reasons.insert("capability_unavailable");
        unknown.insert("capabilities");
    }
    let mut preferred_model = preference(pack, policy, "model");
    if preferred_model.is_null() {
        let defaults: Vec<_> = models.iter().filter(|m| m["isDefault"] == true).collect();
        if defaults.len() == 1 {
            preferred_model = defaults[0]["model"].clone();
        } else if models.len() == 1 {
            preferred_model = models[0]["model"].clone();
        } else {
            unknown.insert("modelPreference");
        }
    }
    if at(&catalog["observedAt"]).is_none() {
        reasons.insert("capability_unknown");
        unknown.insert("capabilities.observedAt");
    }
    let accounts = effective_accounts(row);
    if accounts.is_empty() {
        unknown.insert("accounts");
        reasons.insert("account_unavailable");
    }
    let mut excluded = vec![];
    let mut eligible = vec![];
    let mut total_eligible: usize = 0;
    for account in &accounts {
        if !reasons.is_empty() {
            break;
        }
        let primary = list(&account["agentProfiles"])
            .iter()
            .any(|p| p["role"] == "primary");
        let quota = if codex && primary {
            &row["quota"]
        } else {
            &account["quota"]
        };
        let mut observed_account = account.clone();
        observed_account["quota"] = quota.clone();
        let account = &observed_account;
        let mut allowance = allowance(account, quota, codex);
        if allowance
            .pools
            .iter()
            .flat_map(|p| list(&p["windows"]))
            .any(|w| {
                at(&w["resetsAt"])
                    .zip(at(&row["availability"]["observedAt"]))
                    .is_some_and(|(reset, now)| reset <= now)
            })
        {
            allowance.missing("quota.resetRequiresRefresh");
        }
        if at(&row["availability"]["observedAt"])
            .zip(at(&quota["observedAt"]))
            .is_some_and(|(now, observed)| now - observed >= 900)
        {
            allowance.reasons.insert("quota_stale");
        }
        let credit = policy["accountCreditUse"][string(account, "id")]
            .as_str()
            .unwrap_or("unknown");
        if credit == "unknown" {
            allowance.unknown.insert("creditUse");
        }
        if allowance.credit_only && credit != "allowed" {
            allowance.reasons.insert(if credit == "never" {
                "credit_use_never"
            } else {
                "credit_use_unknown"
            });
        }
        if !allowance.reasons.is_empty() {
            excluded.push(diagnostic(
                account,
                &Value::Null,
                &allowance.reasons,
                &allowance.unknown,
            ));
            continue;
        }
        for (model_index, model) in models.iter().enumerate() {
            let mut why = BTreeSet::new();
            let mut missing = BTreeSet::new();
            if !permitted(policy, "Models", &model["model"]) {
                why.insert("model_denied");
            }
            if !codex {
                let scoped_options = model["options"].is_array()
                    || (catalog["options"].is_array()
                        && (catalog["currentModel"] == model["model"]
                            || catalog["optionsForModel"] == model["model"]));
                if !scoped_options {
                    why.insert("capability_unknown");
                    missing.insert("optionsForModel");
                }
                if catalog["modelSelectionUnavailable"].is_string()
                    && catalog["currentModel"] != model["model"]
                {
                    why.insert("capability_unsupported");
                }
            }
            let mut efforts = list(&model["efforts"]);
            let mut tiers: Vec<_> = list(&model["serviceTiers"])
                .into_iter()
                .map(|v| v.get("id").cloned().unwrap_or(v))
                .collect();
            let effort_option = option(
                model,
                catalog,
                &["effort", "reasoning_effort", "thinkingLevel"],
            );
            let tier_option = option(model, catalog, &["serviceTier", "service_tier"]);
            if !codex {
                efforts = option_values(
                    model,
                    catalog,
                    &["effort", "reasoning_effort", "thinkingLevel"],
                );
                tiers = option_values(model, catalog, &["serviceTier", "service_tier"]);
            }
            let mut effort = preference(pack, policy, "effort");
            if effort.is_null() && codex {
                effort = model["defaultReasoningEffort"].clone();
            }
            let mut tier = preference(pack, policy, "serviceTier");
            if pack["serviceTier"].is_null()
                && policy["serviceTiers"][string(model, "model")].is_string()
            {
                tier = policy["serviceTiers"][string(model, "model")].clone();
            }
            if tier.is_null() {
                tier = model["defaultServiceTier"].clone();
            }
            let mut not_exposed = vec![];
            let mut options = policy["options"].as_object().cloned().unwrap_or_default();
            options.extend(pack["options"].as_object().cloned().unwrap_or_default());
            if !codex {
                for (native, preferred, field) in [
                    (&effort_option, &mut effort, "effort"),
                    (&tier_option, &mut tier, "serviceTier"),
                ] {
                    if let Some(native) = native {
                        if let Some(value) = options.get(string(native, "id")) {
                            *preferred = value.clone();
                        } else if preferred.is_null() {
                            *preferred = native
                                .get("defaultValue")
                                .or_else(|| native.get("currentValue"))
                                .cloned()
                                .unwrap_or(Value::Null);
                        }
                    } else if preferred.is_null() {
                        not_exposed.push(field);
                    }
                }
            }
            for (values, preferred, field) in [
                (&mut efforts, &mut effort, "effort"),
                (&mut tiers, &mut tier, "serviceTier"),
            ] {
                if values.is_empty() {
                    if codex || !preferred.is_null() {
                        missing.insert(field);
                        why.insert("capability_unknown");
                    } else {
                        values.push(Value::Null);
                    }
                }
                if preferred.is_null() && values.len() == 1 {
                    *preferred = values[0].clone();
                }
                if preferred.is_null() && values.len() > 1 {
                    missing.insert(field);
                }
                if !preferred.is_null() && !values.contains(preferred) {
                    why.insert("capability_unsupported");
                }
            }
            // Other configured option constraints need native values for this model.
            for key in options
                .keys()
                .chain(
                    policy["allowOptions"]
                        .as_object()
                        .into_iter()
                        .flatten()
                        .map(|(k, _)| k),
                )
                .chain(
                    policy["denyOptions"]
                        .as_object()
                        .into_iter()
                        .flatten()
                        .map(|(k, _)| k),
                )
            {
                if !codex
                    && [&effort_option, &tier_option]
                        .iter()
                        .any(|o| o.as_ref().is_some_and(|o| o["id"] == key.as_str()))
                {
                    continue;
                }
                let values = option_values(model, catalog, &[key]);
                if values.is_empty() || !options.contains_key(key) {
                    why.insert("option_unknown");
                    missing.insert("options");
                } else if !values.contains(&options[key]) {
                    why.insert("capability_unsupported");
                }
                if contains(&policy["denyOptions"][key], &options[key])
                    || (!list(&policy["allowOptions"][key]).is_empty()
                        && !contains(&policy["allowOptions"][key], &options[key]))
                {
                    why.insert("option_denied");
                }
            }
            if !why.is_empty() {
                if model["model"] == preferred_model {
                    unknown.extend(missing.iter().copied());
                }
                excluded.push(diagnostic(account, &model["model"], &why, &missing));
                continue;
            }
            if model["model"] == preferred_model {
                unknown.extend(missing.iter().copied());
            }
            for (ei, e) in efforts.iter().enumerate() {
                if !permitted(policy, "Efforts", e) {
                    excluded.push(diagnostic(
                        account,
                        &model["model"],
                        &BTreeSet::from(["effort_denied"]),
                        &BTreeSet::new(),
                    ));
                    continue;
                }
                for (ti, t) in tiers.iter().enumerate() {
                    let mut candidate_options = options.clone();
                    if !codex {
                        for (native, value) in [(&effort_option, e), (&tier_option, t)] {
                            if let Some(native) = native {
                                candidate_options
                                    .insert(string(native, "id").to_owned(), value.clone());
                            }
                        }
                        if candidate_options.iter().any(|(key, value)| {
                            contains(&policy["denyOptions"][key], value)
                                || (!list(&policy["allowOptions"][key]).is_empty()
                                    && !contains(&policy["allowOptions"][key], value))
                        }) {
                            excluded.push(diagnostic(
                                account,
                                &model["model"],
                                &BTreeSet::from(["option_denied"]),
                                &BTreeSet::new(),
                            ));
                            continue;
                        }
                    }
                    let mut codes = vec!["quota_available"];
                    if model["model"] == preferred_model {
                        codes.push("preferred_model");
                    }
                    if *e == effort {
                        codes.push("preferred_effort");
                    }
                    if *t == tier {
                        codes.push("preferred_tier");
                    }
                    if allowance.credit_only {
                        codes.push("credit_use_allowed");
                    }
                    let history: Vec<_> = list(&row["history"]["groups"])
                        .into_iter()
                        .filter(|g| {
                            g["model"] == model["model"]
                                && g["effort"] == *e
                                && g["serviceTier"] == *t
                                && g["options"]
                                    .as_object()
                                    .is_some_and(|o| *o == candidate_options)
                        })
                        .collect();
                    let comparable = if history.len() == 1 {
                        let g = &history[0];
                        json!({"dispatches":g["dispatches"],"durationSamples":g["durationSamples"],"medianObservedDurationMs":g["medianObservedDurationMs"]})
                    } else {
                        Value::Null
                    };
                    let mut candidate_unknown = allowance.unknown.clone();
                    if allowance.pools.len() > 1 {
                        candidate_unknown.insert("modelPoolAssociation");
                    }
                    if account["observedAt"].is_null() {
                        candidate_unknown.insert("healthObservedAt");
                    }
                    candidate_unknown.extend(missing.iter().copied());
                    if comparable.is_null() {
                        candidate_unknown.insert("comparableHistory");
                    }
                    let candidate = json!({"agentAccountId":account["id"],"model":model["model"],"effort":e,"serviceTier":t,"options":candidate_options,"notExposed":not_exposed,
                        "creditUse":credit,"reasonCodes":codes,"unknown":candidate_unknown,"history":comparable,
                        "evidence":{"capabilitiesAt":catalog["observedAt"],"healthAt":account["observedAt"],"quotaAt":quota["observedAt"],"pools":allowance.pools}});
                    let rank = (
                        model["model"] != preferred_model,
                        model_index,
                        *e != effort,
                        ei,
                        *t != tier,
                        ti,
                        allowance.credit_only,
                        allowance.used.to_bits(),
                        allowance.reset,
                        account["default"] != true,
                        string(account, "id").to_owned(),
                    );
                    total_eligible += 1;
                    eligible.push((
                        rank,
                        candidate,
                        missing.is_empty()
                            && model["model"] == preferred_model
                            && *e == effort
                            && *t == tier,
                    ));
                    eligible.sort_by(|a, b| a.0.cmp(&b.0));
                    eligible.truncate(CANDIDATES);
                }
            }
        }
    }
    // A missing configured model must not silently fall through to another model.
    if !preferred_model.is_null() && !models.iter().any(|m| m["model"] == preferred_model) {
        reasons.insert("capability_unsupported");
    }
    let selected =
        if reasons.is_empty() && unknown.is_empty() && eligible.first().is_some_and(|c| c.2) {
            json!(0)
        } else {
            Value::Null
        };
    if selected.is_null() && reasons.is_empty() {
        reasons.insert("selection_unknown");
    }
    excluded.sort_by_key(Value::to_string);
    let excluded_count = excluded.len();
    excluded.truncate(EXCLUSIONS);
    let mut next = vec![];
    if selected.is_null() || excluded_count > 0 {
        next.push(json!({"via":"query","op":"dispatch_policy","args":{"agent":row["agent"],"view":"full"},"hint":"Read complete native capabilities and policy defaults; resolve the reported unknown fields before selecting."}));
        if selected.is_null() {
            next.push(json!({"via":"query","op":"accounts","args":{"agent":row["agent"],"view":"full"},"hint":"Read account IDs and quota evidence; use accounts/refresh-quota for unavailable or expired observations. Set accountCreditUse[accountId] to allowed or never in policyPath when credit use is unknown."}));
        }
    }
    json!({"agent":row["agent"],"pack":pack_name,"selected":selected,
        "candidates":eligible.into_iter().map(|(_,v,_)|v).collect::<Vec<_>>(),"eligibleCount":total_eligible,
        "omittedCandidates":total_eligible.saturating_sub(CANDIDATES),"reasonCodes":reasons,"unknown":unknown,
        "excluded":excluded,"omittedExclusions":excluded_count.saturating_sub(EXCLUSIONS),"next":next})
}

fn fields(value: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .map(|key| ((*key).to_owned(), value[*key].clone()))
            .collect(),
    )
}

fn quota_inputs(quota: &Value, inventory_at: &Value) -> Value {
    let mut inputs = fields(
        quota,
        &[
            "state",
            "source",
            "ordinaryUsageAllowed",
            "pools",
            "windows",
            "accountBlocked",
            "blockedPoolIds",
        ],
    );
    let observed = at(&quota["observedAt"]);
    let windows: Vec<_> = if list(&quota["pools"]).is_empty() {
        list(&quota["windows"])
    } else {
        list(&quota["pools"])
            .iter()
            .flat_map(|p| [p["primary"].clone(), p["secondary"].clone()])
            .filter(Value::is_object)
            .collect()
    };
    // Hash the resulting availability state, never absolute observation times.
    inputs["observationKnown"] = json!(observed.is_some());
    inputs["stale"] = json!(at(inventory_at)
        .zip(observed)
        .is_some_and(|(now, observed)| now - observed >= 900));
    inputs["resetRequiresRefresh"] = json!(windows.iter().any(|w| at(&w["resetsAt"])
        .is_some_and(|reset| observed.is_some_and(|observed| reset <= observed)
            || at(inventory_at).is_some_and(|now| reset <= now))));
    inputs
}

// Observation times describe evidence freshness, not a new allowance or capability.
// Keep only the policy and native inputs that this computation consumes.
fn decision_inputs(facts: &Value) -> Value {
    let agents: Vec<_> = list(&facts["agents"]).iter().map(|row| {
        let catalog = if row["agent"] == "codex" { row } else { &row["capabilities"] };
        let accounts: Vec<_> = effective_accounts(row).iter().map(|account| json!({
            "id":account["id"],"default":account["default"],"health":account["health"]["state"],"healthObservationKnown":!account["observedAt"].is_null(),
            "quotaProviderId":account["quotaProviderId"],
            "roles":list(&account["agentProfiles"]).iter().map(|p| p["role"].clone()).collect::<Vec<_>>(),
            "quota":quota_inputs(&account["quota"], &row["availability"]["observedAt"])
        })).collect();
        json!({"agent":row["agent"],
            "availability":fields(&row["availability"], &["installed","enabled","available"]),
            "policy":fields(&row["policy"], &["model","effort","serviceTier","serviceTiers","options","allowModels","denyModels","allowEfforts","denyEfforts","allowOptions","denyOptions","accountCreditUse"]),
            "capabilities":fields(catalog, &["authoritative","models","options","currentModel","optionsForModel","modelSelectionUnavailable"]),
            "capabilityObservationKnown":at(&catalog["observedAt"]).is_some(),
            "accounts":accounts,
            "quota":quota_inputs(&row["quota"], &row["availability"]["observedAt"]),
            "history":row["history"]["groups"]})
    }).collect();
    let packs: BTreeMap<_, _> = facts["packs"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(name, pack)| {
            (
                name,
                fields(
                    pack,
                    &["agent", "model", "effort", "serviceTier", "options"],
                ),
            )
        })
        .collect();
    json!({"agents":agents,"packs":packs})
}

fn decision_context(row: &Value) -> Value {
    let candidate = row["selected"]
        .as_u64()
        .and_then(|index| row["candidates"].get(index as usize));
    let strings = |values: &Value| {
        list(values)
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect::<BTreeSet<String>>()
    };
    let mut reasons = strings(&row["reasonCodes"]);
    let mut unknown = strings(&row["unknown"]);
    let details = candidate
        .map(|c| vec![c.clone()])
        .unwrap_or_else(|| list(&row["excluded"]));
    for detail in details {
        reasons.extend(strings(&detail["reasonCodes"]));
        unknown.extend(strings(&detail["unknown"]));
    }
    let next = if candidate.is_some() {
        Value::Null
    } else {
        let actions = list(&row["next"]);
        let account_read = reasons.iter().any(|r| {
            r.starts_with("quota_")
                || r.starts_with("credit")
                || r.starts_with("account_")
                || r == "pool_blocked"
                || r == "spend_control_reached"
        });
        actions
            .iter()
            .find(|a| account_read && a["op"] == "accounts")
            .or_else(|| actions.first())
            .cloned()
            .unwrap_or(Value::Null)
    };
    json!({"agent":row["agent"],"pack":row["pack"],
        "selected":candidate.map(|c| fields(c,&["agentAccountId","model","effort","serviceTier","options","creditUse","notExposed"])),
        "eligibleCount":row["eligibleCount"],"reasonCodes":reasons,"unknown":unknown,"next":next})
}

/// Identical structured inputs produce identical revisions, order and reasons.
/// Model order is native catalog order, never an inferred model-name quality score.
pub(crate) fn compute(facts: &Value, full: bool) -> Value {
    let criteria: BTreeMap<_, _> = list(&facts["agents"])
        .iter()
        .map(|a| {
            (
                string(a, "agent").to_owned(),
                a["policy"]["criteria"].clone(),
            )
        })
        .collect();
    let revision = hash(json!({"global":facts["criteria"],"agents":criteria}).to_string());
    let mut result = json!({"advisory":true,"judgment":"Prose criteria own risk, task complexity and judgment. Explicit authorized dispatch arguments win; recommendations do not change omitted-field dispatch defaults.",
        "inputsRevision":{"criteriaHash":revision,"factsRevision":hash(decision_inputs(facts).to_string())},"rows":[],"omitted":0});
    let mut rows = vec![];
    let agents = list(&facts["agents"]);
    // No-pack contexts precede each pack applied only to its declared Agents.
    for row in &agents {
        rows.push(context(row, None, &Value::Null));
    }
    for (name, pack) in facts["packs"].as_object().into_iter().flatten() {
        for row in &agents {
            if pack["agent"]
                .as_str()
                .is_none_or(|agent| row["agent"] == agent)
            {
                rows.push(context(row, Some(name), pack));
            }
        }
    }
    if !full {
        rows = rows.iter().map(decision_context).collect();
    }
    let budget = if full { FULL_BYTES } else { DECISION_BYTES };
    let total = rows.len();
    result["next"] = json!({"via":"query","op":"dispatch_policy","args":{"view":"full"},"hint":"Filter by agent for complete recommendation contexts and capability detail."});
    // Reserve the optional filtered next action before filling the byte budget.
    if full {
        if let Some(agent) = agents
            .iter()
            .map(|a| string(a, "agent"))
            .max_by_key(|id| id.len())
        {
            result["next"]["args"]["agent"] = json!(agent);
        }
    }
    let mut kept = vec![];
    for row in &rows {
        if !full && kept.len() == 20 {
            break;
        }
        kept.push(row.clone());
        result["rows"] = json!(kept);
        result["omitted"] = json!(total - kept.len());
        if result.to_string().len() > budget {
            kept.pop();
            break;
        }
    }
    if full && kept.len() < total {
        result["next"]["args"]["agent"] = rows[kept.len()]["agent"].clone();
    }
    result["rows"] = json!(kept);
    result["omitted"] = json!(total - kept.len());
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn facts() -> Value {
        json!({"criteria":"Use judgment for risk.","packs":{"review":{"model":"native-b","effort":"high"}},"agents":[{
            "agent":"codex","observedAt":"2026-01-01T00:00:00Z","authoritative":true,
            "availability":{"installed":true,"enabled":true,"available":true,"observedAt":"2026-01-01T00:00:00Z"},
            "policy":{"model":"native-a","effort":"low","serviceTier":"default","criteria":"Use native facts."},
            "models":[{"model":"native-b","efforts":["low","high"],"serviceTiers":[{"id":"default"},{"id":"priority"}]},
                      {"model":"native-a","efforts":["low","high"],"serviceTiers":[{"id":"default"},{"id":"priority"}]}],
            "accounts":[{"id":"account-b","default":true,"health":{"state":"ready"},"quota":{"state":"ready","observedAt":"2026-01-01T00:00:00Z","ordinaryUsageAllowed":true,
                "pools":[{"id":"shared","spendControlReached":false,"credits":{"hasCredits":true,"unlimited":false},"primary":{"usedPercent":40,"resetsAt":1767312000}}]}},
                {"id":"account-a","health":{"state":"ready"},"quota":{"state":"ready","observedAt":"2026-01-01T00:00:00Z","ordinaryUsageAllowed":true,
                "pools":[{"id":"shared","spendControlReached":false,"credits":{"hasCredits":true},"primary":{"usedPercent":20,"resetsAt":1767312000}}]}}],
            "history":{"groups":[{"model":"native-a","effort":"low","serviceTier":"default","options":{},"dispatches":12,"durationSamples":10,"medianObservedDurationMs":60000},
                {"model":"native-b","effort":"high","serviceTier":"default","options":{},"dispatches":100,"durationSamples":100,"medianObservedDurationMs":1}]}
        }]})
    }
    fn synthetic_installation() -> Value {
        let mut input = facts();
        let native = input["agents"][0].clone();
        for agent in ["pi", "grok", "claude"] {
            let mut row = native.clone();
            row["agent"] = json!(agent);
            row["policy"] =
                json!({"model":"native-a","options":{"effort":"low","serviceTier":"default"}});
            row["capabilities"] = json!({"authoritative":true,"observedAt":"2026-01-01T00:00:00Z","models":native["models"]});
            for model in row["capabilities"]["models"].as_array_mut().unwrap() {
                model["options"] = json!([{"id":"effort","values":["low","high"]},{"id":"serviceTier","values":["default","priority"]}]);
            }
            for account in row["accounts"].as_array_mut().unwrap() {
                account["id"] = json!(format!("{agent}-{}", string(account, "id")));
            }
            input["agents"].as_array_mut().unwrap().push(row);
        }
        input["packs"] =
            json!({"codex-only":{"agent":"codex"},"pi-only":{"agent":"pi"},"shared":{}});
        input
    }
    #[test]
    fn identical_inputs_keep_revisions_order_and_reasons() {
        // Property: observation-only refreshes preserve input revisions, order and reasons while changed allowance values revise facts.
        let input = facts();
        let first = compute(&input, true);
        for _ in 0..4 {
            assert_eq!(first, compute(&input, true));
        }
        let default = &first["rows"][0];
        assert_eq!(default["selected"], 0);
        assert_eq!(default["candidates"][0]["model"], "native-a");
        assert_eq!(default["candidates"][0]["agentAccountId"], "account-a");
        assert_eq!(
            default["candidates"][0]["history"]["medianObservedDurationMs"],
            60000
        );
        assert_eq!(first["rows"][1]["candidates"][0]["model"], "native-b");
        assert_eq!(first["rows"][1]["candidates"][0]["effort"], "high");
        for view in ["decision", "full"] {
            let recommendation = compute(&input, view == "full");
            let mut projected = input.clone();
            projected["recommendation"] = recommendation.clone();
            let output = super::super::decision::present(projected, &json!({"view":view}));
            assert_eq!(output["recommendation"], recommendation);
        }
        fn refresh_times(value: &mut Value) {
            match value {
                Value::Object(map) => {
                    for (key, value) in map {
                        if key == "observedAt" {
                            *value = json!("2026-01-01T00:01:00Z");
                        } else {
                            refresh_times(value);
                        }
                    }
                }
                Value::Array(values) => values.iter_mut().for_each(refresh_times),
                _ => {}
            }
        }
        fn without_evidence(value: &mut Value) {
            match value {
                Value::Object(map) => {
                    map.remove("evidence");
                    map.remove("quotaAt");
                    map.values_mut().for_each(without_evidence);
                }
                Value::Array(values) => values.iter_mut().for_each(without_evidence),
                _ => {}
            }
        }
        let installation = synthetic_installation();
        let mut refreshed = installation.clone();
        refresh_times(&mut refreshed);
        for full in [false, true] {
            let mut before = compute(&installation, full);
            let mut after = compute(&refreshed, full);
            assert_eq!(before["inputsRevision"], after["inputsRevision"]);
            without_evidence(&mut before);
            without_evidence(&mut after);
            assert_eq!(before, after);
        }
        refreshed["agents"][0]["accounts"][0]["quota"]["pools"][0]["primary"]["usedPercent"] =
            json!(41);
        assert_ne!(
            compute(&installation, true)["inputsRevision"]["factsRevision"],
            compute(&refreshed, true)["inputsRevision"]["factsRevision"]
        );
        let mut changed = input;
        changed["agents"][0]["policy"]["criteria"] = json!("Changed judgment.");
        assert_ne!(
            first["inputsRevision"],
            compute(&changed, true)["inputsRevision"]
        );
    }
    #[test]
    fn unavailable_quota_and_unsupported_capabilities_are_excluded() {
        // Property: advisory eligibility excludes unavailable quota and unsupported configured capabilities with explicit reasons.
        let mut input = facts();
        input["agents"][0]["accounts"][0]["quota"]["state"] = json!("unavailable");
        input["agents"][0]["accounts"][1]["quota"]["state"] = json!("unavailable");
        let result = compute(&input, true);
        assert!(result["rows"][0]["selected"].is_null());
        assert_eq!(result["rows"][0]["eligibleCount"], 0);
        assert!(contains(
            &result["rows"][0]["excluded"][0]["reasonCodes"],
            &json!("quota_unavailable")
        ));
        assert!(!list(&result["rows"][0]["next"]).is_empty());
        let mut input = facts();
        input["agents"][0]["policy"]["effort"] = json!("unsupported-effort");
        let result = compute(&input, true);
        assert!(result["rows"][0]["selected"].is_null());
        assert_eq!(result["rows"][0]["eligibleCount"], 0);
        assert!(contains(
            &result["rows"][0]["excluded"][0]["reasonCodes"],
            &json!("capability_unsupported")
        ));
    }
    #[test]
    fn absent_credit_permission_stays_unknown_and_never_selects_credit_only_work() {
        // Property: credit-only recommendations require structured per-account permission and available credits without spend control.
        let mut input = facts();
        for account in input["agents"][0]["accounts"].as_array_mut().unwrap() {
            account["quota"]["ordinaryUsageAllowed"] = json!(false);
        }
        input["agents"][0]["policy"]["criteria"] = json!("Credits are allowed for every account.");
        let denied = compute(&input, true);
        assert!(denied["rows"][0]["selected"].is_null());
        assert!(contains(
            &denied["rows"][0]["excluded"][0]["unknown"],
            &json!("creditUse")
        ));
        assert!(contains(
            &denied["rows"][0]["excluded"][0]["reasonCodes"],
            &json!("credit_use_unknown")
        ));
        input["agents"][0]["policy"]["accountCreditUse"] =
            json!({"account-a":"allowed","account-b":"never"});
        let allowed = compute(&input, true);
        assert_eq!(
            allowed["rows"][0]["candidates"][0]["agentAccountId"],
            "account-a"
        );
        assert_eq!(allowed["rows"][0]["selected"], 0);
        input["agents"][0]["accounts"][1]["quota"]["pools"][0]["spendControlReached"] = json!(true);
        let blocked = compute(&input, true);
        assert!(blocked["rows"][0]["selected"].is_null());
        assert!(list(&blocked["rows"][0]["excluded"])
            .iter()
            .any(|e| contains(&e["reasonCodes"], &json!("spend_control_reached"))));
    }
    #[test]
    fn shared_pools_all_constrain_selection_and_resets_require_fresh_evidence() {
        // Property: a blocked shared allowance cannot be replaced with another pool or reset by elapsed time without a quota read.
        let mut input = facts();
        input["agents"][0]["accounts"]
            .as_array_mut()
            .unwrap()
            .truncate(1);
        let account = &mut input["agents"][0]["accounts"][0];
        account["quotaProviderId"] = json!("provider-one");
        account["quota"]["source"] = json!("subscription");
        account["quota"]["pools"].as_array_mut().unwrap().push(json!({"id":"another","spendControlReached":true,"primary":{"usedPercent":1,"resetsAt":1767312000}}));
        let result = compute(&input, true);
        assert!(result["rows"][0]["selected"].is_null());
        input["agents"][0]["accounts"][0]["quota"]["pools"]
            .as_array_mut()
            .unwrap()
            .pop();
        let result = compute(&input, true);
        assert_eq!(
            result["rows"][0]["candidates"][0]["evidence"]["pools"][0]["scope"],
            "provider:provider-one"
        );
        input["agents"][0]["accounts"][0]["quota"]["pools"][0]["primary"]["resetsAt"] = json!(1);
        let result = compute(&input, true);
        assert!(result["rows"][0]["selected"].is_null());
        assert!(contains(
            &result["rows"][0]["excluded"][0]["unknown"],
            &json!("quota.resetRequiresRefresh")
        ));
        let mut shared = facts();
        for account in shared["agents"][0]["accounts"].as_array_mut().unwrap() {
            account["quotaProviderId"] = json!("provider-one");
            account["quota"]["source"] = json!("subscription");
        }
        let conflict = compute(&shared, true);
        assert!(conflict["rows"][0]["selected"].is_null());
        assert_eq!(conflict["rows"][0]["eligibleCount"], 0);
    }
    #[test]
    fn explicit_dispatch_arguments_win_over_pack_policy_and_advisory_choices() {
        // Property: explicit authorized dispatch arguments override pack and policy defaults regardless of the advisory recommendation.
        let input = facts();
        let recommendation = compute(&input, true);
        assert_eq!(
            recommendation["rows"][0]["candidates"][0]["model"],
            "native-a"
        );
        let policy: super::super::Policy =
            serde_json::from_value(input["agents"][0]["policy"].clone()).unwrap();
        let mut args = json!({"model":"native-b","effort":"high","serviceTier":"priority","agentAccountId":"account-b",
            "pack":{"defaults":{"model":"native-a","effort":"low","serviceTier":"default"}}});
        let resolved =
            super::super::resolve_configuration(&mut args, &Value::Null, &Value::Null, &policy)
                .unwrap();
        for field in ["model", "effort", "serviceTier"] {
            assert_eq!(resolved[field], args[field]);
            assert_eq!(resolved["source"][field], "explicit");
        }
        assert_eq!(args["agentAccountId"], "account-b");
    }
    #[test]
    fn native_options_and_per_model_tiers_constrain_advisory_choices() {
        // Property: native option values, allow/deny restrictions and per-model tier overrides constrain every eligible configuration.
        let mut input = facts();
        input["agents"][0]["policy"]["serviceTiers"] = json!({"native-a":"priority"});
        input["packs"]["review"]["serviceTier"] = json!("default");
        let result = compute(&input, true);
        assert_eq!(
            result["rows"][0]["candidates"][0]["serviceTier"],
            "priority"
        );
        assert_eq!(result["rows"][1]["candidates"][0]["serviceTier"], "default");
        input["packs"] = json!({});
        let row = &mut input["agents"][0];
        row["agent"] = json!("pi");
        row["policy"] = json!({"model":"native-a","options":{"thinkingLevel":"high","serviceTier":"priority"},"denyOptions":{"thinkingLevel":["low"]}});
        row["capabilities"] = json!({"authoritative":true,"observedAt":"2026-01-01T00:00:00Z",
            "models":[{"model":"native-a","options":[{"id":"thinkingLevel","values":["low","high"]},{"id":"serviceTier","values":["default","priority"]}]}]});
        for account in row["accounts"].as_array_mut().unwrap() {
            account["quota"] = json!({"source":"subscription","state":"ready","observedAt":"2026-01-01T00:00:00Z","windows":[{"poolId":"shared","usedPercent":20,"resetsAt":1767312000}]});
            account["quotaProviderId"] = json!("provider-one");
        }
        let result = compute(&input, true);
        assert_eq!(result["rows"][0]["selected"], 0);
        for candidate in list(&result["rows"][0]["candidates"]) {
            assert_eq!(candidate["effort"], "high");
            assert_eq!(candidate["options"]["thinkingLevel"], candidate["effort"]);
            assert_eq!(
                candidate["options"]["serviceTier"],
                candidate["serviceTier"]
            );
        }
        let mut unscoped = input.clone();
        unscoped["agents"][0]["capabilities"]["models"][0]
            .as_object_mut()
            .unwrap()
            .remove("options");
        let missing = compute(&unscoped, true);
        assert!(missing["rows"][0]["selected"].is_null());
        assert!(contains(
            &missing["rows"][0]["unknown"],
            &json!("optionsForModel")
        ));
        input["agents"][0]["capabilities"]["authoritative"] = json!(false);
        let stale = compute(&input, true);
        assert!(stale["rows"][0]["selected"].is_null());
        assert_eq!(stale["rows"][0]["eligibleCount"], 0);
        assert!(contains(
            &stale["rows"][0]["reasonCodes"],
            &json!("capability_unavailable")
        ));
    }
    #[test]
    fn native_credit_projection_supports_unlimited_primary_allowances() {
        // Property: the native quota projection preserves unlimited credits and primary account ownership for advisory eligibility.
        let mut input = facts();
        input["agents"][0]["accounts"]
            .as_array_mut()
            .unwrap()
            .truncate(1);
        input["agents"][0]["accounts"][0]["agentProfiles"] = json!([{"role":"primary"}]);
        input["agents"][0]["policy"]["accountCreditUse"] = json!({"account-b":"allowed"});
        let mut quota = crate::subscriptions::codex_dispatch_quota(
            &json!({"ordinaryUsageAllowed":false,"rateLimitsByLimitId":{"shared":{
            "spendControlReached":false,"credits":{"hasCredits":false,"unlimited":true},"primary":{"usedPercent":100,"resetsAt":1767312000}}}}),
        );
        quota["state"] = json!("ready");
        quota["observedAt"] = json!("2026-01-01T00:00:00Z");
        input["agents"][0]["quota"] = quota;
        let result = compute(&input, true);
        assert_eq!(result["rows"][0]["selected"], 0);
        assert!(contains(
            &result["rows"][0]["candidates"][0]["reasonCodes"],
            &json!("credit_use_allowed")
        ));
        input["agents"][0]["policy"]["model"] = Value::Null;
        let unknown = compute(&input, true);
        assert!(unknown["rows"][0]["selected"].is_null());
        assert!(contains(
            &unknown["rows"][0]["unknown"],
            &json!("modelPreference")
        ));
    }
    #[test]
    fn decision_contexts_keep_only_applicable_packs_and_selected_configuration() {
        // Property: decision contexts retain only selected configurations and applicable Agent packs, with detailed evidence available in full view.
        let input = synthetic_installation();
        let decision = compute(&input, false);
        let full = compute(&input, true);
        assert_eq!(decision["omitted"], 0);
        assert_eq!(decision["rows"].as_array().unwrap().len(), 10);
        for row in list(&decision["rows"]) {
            if row["pack"] == "codex-only" {
                assert_eq!(row["agent"], "codex");
            }
            if row["pack"] == "pi-only" {
                assert_eq!(row["agent"], "pi");
            }
            let detailed = full["rows"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["agent"] == row["agent"] && r["pack"] == row["pack"])
                .unwrap();
            assert_eq!(row["eligibleCount"], detailed["eligibleCount"]);
            assert_eq!(
                row["selected"]["agentAccountId"],
                detailed["candidates"][0]["agentAccountId"]
            );
            assert!(row.get("candidates").is_none());
            assert!(row.get("excluded").is_none());
            assert!(row["selected"].get("evidence").is_none());
            assert!(detailed["candidates"][0]["evidence"].is_object());
        }
        assert!(decision.to_string().len() <= DECISION_BYTES);
    }
    #[test]
    fn decision_budget_retains_valid_json_and_a_full_read() {
        // Property: bounded recommendations disclose omitted contexts and retain an actionable full read.
        let mut input = synthetic_installation();
        for n in 0..13 {
            input["packs"][format!("pack-{n}")] = json!({});
        }
        let result = compute(&input, false);
        assert!(result.to_string().len() <= DECISION_BYTES);
        assert!(result["omitted"].as_u64().unwrap() > 0);
        assert_eq!(result["next"]["op"], "dispatch_policy");
        let mut filtered = input.clone();
        filtered["agents"]
            .as_array_mut()
            .unwrap()
            .retain(|a| a["agent"] == "codex");
        let full = compute(&filtered, true);
        assert_eq!(full["omitted"], 0);
        assert!(full.to_string().len() <= FULL_BYTES);
        assert_eq!(
            full["rows"][0]["candidates"][0]["agentAccountId"],
            result["rows"][0]["selected"]["agentAccountId"]
        );
    }
    #[test]
    fn compact_missing_selection_keeps_actionable_credit_diagnostics() {
        // Property: a compact missing selection retains credit permission diagnostics and an actionable account read.
        let mut input = facts();
        for account in input["agents"][0]["accounts"].as_array_mut().unwrap() {
            account["quota"]["ordinaryUsageAllowed"] = json!(false);
        }
        let result = compute(&input, false);
        let row = &result["rows"][0];
        assert!(row["selected"].is_null());
        assert!(contains(&row["reasonCodes"], &json!("credit_use_unknown")));
        assert!(contains(&row["unknown"], &json!("creditUse")));
        assert_eq!(row["next"]["op"], "accounts");
    }
    #[test]
    fn native_pool_projection_retains_compact_allowance_fields() {
        // Regression: 848f7ea copied extra native window fields and null slots into public quota pool projections.
        let projected = crate::subscriptions::codex_dispatch_quota(
            &json!({"ordinaryUsageAllowed":true,"rateLimitsByLimitId":{"shared":{
            "primary":{"usedPercent":20,"windowDurationMins":300,"resetsAt":1767312000,"extraNativeField":true},
            "secondary":null,"credits":null,"spendControlReached":false}}}),
        );
        assert_eq!(
            projected,
            json!({"ordinaryUsageAllowed":true,"pools":[{"id":"shared","primary":{"usedPercent":20,"windowDurationMins":300,"resetsAt":1767312000},"spendControlReached":false}]})
        );
    }
}
