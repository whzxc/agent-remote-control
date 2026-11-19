//! Presentation only. Dispatch validation and native configuration stay with their owners.
use crate::*;
use std::collections::BTreeMap;

fn criteria(row: &mut Value, text: &str, key: &str, args: &Value) {
    let digest = hash(text);
    row["criteriaHash"] = json!(digest);
    if args["knownCriteriaHash"].as_str() == Some(digest.as_str())
        || args["knownCriteriaHash"][key] == digest
    {
        row.as_object_mut().unwrap().remove("criteria");
        row["criteriaUnchanged"] = json!(true);
    } else {
        row["criteria"] = json!(text);
    }
}

// Providers mark stale cached quotas themselves. Catalog snapshots have no TTL contract.
// A persisted catalog is explicitly historical, so retain its observation timestamp.
fn clean(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let stale = map.get("state").is_some_and(|v| v == "stale")
                || map.get("stale") == Some(&json!(true))
                || map.get("source").is_some_and(|v| {
                    v == "persistent-snapshot" || v == "persisted-session-snapshot"
                });
            map.retain(|key, value| {
                if key == "quality" {
                    return true;
                }
                if key == "models" {
                    if let Some(models) = value.as_array_mut() {
                        // Compact strings may themselves be opaque IDs such as "unknown".
                        models.iter_mut().for_each(clean);
                        return true;
                    }
                }
                clean(value);
                // Native identities and labels are data, even when their literal
                // text equals a presentation sentinel. Empty model lists are facts.
                (value.is_string()
                    && matches!(
                        key.as_str(),
                        "model" | "displayName" | "name" | "id" | "value" | "coverage"
                    ))
                    || !(key == "observedAt" && !stale || empty(value))
            });
        }
        Value::Array(values) => {
            values.iter_mut().for_each(clean);
            values.retain(|v| !empty(v));
        }
        _ => {}
    }
}
fn empty(value: &Value) -> bool {
    value.is_null()
        || value
            .as_str()
            .is_some_and(|s| s.is_empty() || s == "unknown")
        || value.as_array().is_some_and(Vec::is_empty)
        || value.as_object().is_some_and(serde_json::Map::is_empty)
}
fn model_list(models: &Value) -> Vec<String> {
    let mut grouped = BTreeMap::<(String, String, String), Vec<String>>::new();
    for m in models.as_array().into_iter().flatten() {
        let mut parts = vec![];
        let efforts: Vec<_> = m["efforts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let order = [
            "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ];
        if !efforts.is_empty() {
            let contiguous = order.windows(efforts.len()).any(|v| v == efforts);
            parts.push(if contiguous && efforts.len() > 2 {
                format!("{}-{}", efforts[0], efforts[efforts.len() - 1])
            } else {
                efforts.join("/")
            });
        }
        for tier in m["serviceTiers"].as_array().into_iter().flatten() {
            parts.push(format!(
                "{}={}",
                string(tier, "name").to_lowercase(),
                string(tier, "id")
            ));
        }
        for option in m["options"].as_array().into_iter().flatten() {
            let values = option["values"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().or(v["value"].as_str()))
                .collect::<Vec<_>>()
                .join("/");
            if !values.is_empty() {
                parts.push(format!("{}={values}", string(option, "id")));
            }
        }
        let id = string(m, "model");
        let name = string(m, "displayName");
        let label = if name.is_empty() || name == id {
            id.to_owned()
        } else {
            format!("{name} ({id})")
        };
        // Use only explicit native metadata; model IDs remain opaque.
        let provider = string(&m["provider"], "name");
        let provider = if provider == id || provider == name {
            ""
        } else {
            provider
        };
        let provider_id = if provider.is_empty() {
            ""
        } else {
            string(&m["provider"], "id")
        };
        grouped
            .entry((provider_id.into(), provider.into(), parts.join(", ")))
            .or_default()
            .push(label);
    }
    grouped
        .into_iter()
        .map(|((_, provider, settings), ids)| {
            let labels = if provider.is_empty() {
                ids.join(",")
            } else {
                format!("[{provider}] {}", ids.join(","))
            };
            if settings.is_empty() {
                labels
            } else {
                format!("{labels}: {settings}")
            }
        })
        .collect()
}
fn history(row: &Value) -> Value {
    if row["history"]["unavailable"].is_string() {
        return row["history"].clone();
    }
    let groups = row["history"]["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|g| {
            let mut label = ["model", "effort"]
                .iter()
                .filter_map(|k| g[k].as_str())
                .filter(|v| !v.is_empty() && *v != "unknown")
                .collect::<Vec<_>>()
                .join("/");
            match g["serviceTier"].as_str() {
                Some("default" | "") | None => {}
                Some("unknown") => label.push_str("/?"),
                Some(tier) => label.push_str(&format!("/{tier}")),
            }
            for (k, v) in g["options"].as_object().into_iter().flatten() {
                label.push_str(&format!(" {k}={}", v.as_str().unwrap_or("")));
            }
            let mut s = format!("{label}: n{}", g["dispatches"]);
            if let Some(ms) = g["medianObservedDurationMs"].as_f64() {
                s.push_str(&format!(" med{:.1}m", ms / 60000.0));
            }
            s.push_str(&format!(
                " pass{} rework{} unrev{}",
                g["pass"], g["rework"], g["unreviewed"]
            ));
            if let Some(n) = g["external"]["reviews"].as_u64() {
                s.push_str(&format!(
                    " ext{n} pass{} rework{}",
                    g["external"]["pass"], g["external"]["rework"]
                ));
            }
            for (k, short) in [("failed", "fail"), ("interrupted", "int")] {
                if g[k].as_u64().unwrap_or(0) > 0 {
                    s.push_str(&format!(" {short}{}", g[k]));
                }
            }
            if let Some(cost) = g["usage"]["costUsd"].as_f64() {
                if let Some(n) = g["usage"]["samples"].as_u64().filter(|n| *n > 0) {
                    s.push_str(&format!(" ${:.2}({n})", cost));
                }
            }
            s
        })
        .collect::<Vec<_>>();
    if groups.is_empty()
        && row["history"]["quality"]["externalReviews"]["reviews"]
            .as_u64()
            .unwrap_or(0)
            == 0
        && row["history"]["quality"]["selfTests"]["count"]
            .as_u64()
            .unwrap_or(0)
            == 0
    {
        return Value::Null;
    }
    json!({"groups":groups,"quality":row["history"]["quality"],"coverage":row["history"]["coverage"]})
}
fn quota_summary(windows: Vec<(String, f64)>) -> String {
    windows
        .into_iter()
        .map(|(name, percent)| format!("{name} {percent}%"))
        .collect::<Vec<_>>()
        .join(", ")
}
fn quotas(row: &Value) -> Vec<(String, Value)> {
    let q = &row["quota"];
    let mut result = vec![];
    for pool in q["pools"].as_array().into_iter().flatten() {
        let windows = ["primary", "secondary"]
            .iter()
            .filter_map(|k| {
                let w = &pool[k];
                let used = w["usedPercent"].as_f64()?;
                let name = match w["windowDurationMins"].as_u64() {
                    Some(10080) => "weekly".into(),
                    Some(300) => "5h".into(),
                    Some(n) => format!("{n}m"),
                    None => (*k).into(),
                };
                Some((name, used))
            })
            .collect();
        let mut v = json!({"summary":quota_summary(windows)});
        if q["source"].as_str() == Some("local-gateway") {
            v["source"] = q["source"].clone();
            if q["gateway"].is_string() {
                v["gateway"] = q["gateway"].clone();
            }
        }
        for k in [
            "rateLimitReachedType",
            "spendControlReached",
            "accountsTotal",
            "accountsWithRoom",
            "accountsWithCredits",
        ] {
            if !pool[k].is_null() && pool[k] != false {
                v[k] = pool[k].clone();
            }
        }
        if let Some(best) = pool["primary"]["bestAccountUsedPercent"].as_f64() {
            v["bestAccountUsedPercent"] = json!(best);
        }
        if pool["credits"].is_object() {
            v["credits"] = pool["credits"].clone();
        }
        if q["ordinaryUsageAllowed"] == false {
            v["ordinaryUsageAllowed"] = json!(false);
        }
        result.push((format!("codex/{}", string(pool, "id")), v));
    }
    for p in q["providers"].as_array().into_iter().flatten() {
        let mut pools = BTreeMap::<String, Vec<(String, f64)>>::new();
        for w in p["windows"].as_array().into_iter().flatten() {
            if let Some(used) = w["usedPercent"].as_f64() {
                pools
                    .entry(string(w, "poolId").into())
                    .or_default()
                    .push((string(w, "label").replace("weekly_all", "weekly"), used));
            }
        }
        // Preserve failures even when there are no windows.
        if pools.is_empty() {
            pools.insert(String::new(), vec![]);
        }
        for (pool, windows) in pools {
            let mut v = json!({"summary":quota_summary(windows)});
            if p["state"] != "ready" {
                v["state"] = p["state"].clone();
                v["observedAt"] = p["observedAt"].clone();
            }
            for k in ["error", "accountBlocked", "blockedPoolIds"] {
                if p[k] != false {
                    v[k] = p[k].clone();
                }
            }
            result.push((format!("{}/{}", string(p, "providerId"), pool), v));
        }
    }
    result
}

// Only explicit field/value statements are machine-readable. Other prose stays with the controller.
fn tier_mismatches(global: &str, policy: &Value) -> Vec<Value> {
    let pattern =
        regex::Regex::new(r#"(?i)\bserviceTier[`\"']*\s*(?:[:=]\s*)?[`\"']*(default|priority)\b"#)
            .unwrap();
    let mut mismatches = vec![];
    for (scope, text) in [("global", global), ("codex", string(policy, "criteria"))] {
        let tiers = pattern
            .captures_iter(text)
            .map(|c| c[1].to_lowercase())
            .collect::<std::collections::BTreeSet<_>>();
        if tiers.len() != 1 {
            continue;
        }
        let tier = tiers.first().unwrap();
        for (model, configured) in policy["serviceTiers"].as_object().into_iter().flatten() {
            if configured.as_str().is_some_and(|value| value != tier) {
                mismatches.push(json!({"code":"CRITERIA_SERVICE_TIER_MISMATCH", "criteriaScope":scope,
                    "criteriaServiceTier":tier,"model":model,"overrideServiceTier":configured,
                    "nextAction":"Pass serviceTier explicitly to codex_create/codex_send to follow the criteria. Reconcile the criteria and per-model override before relying on omitted defaults."}));
            }
        }
    }
    mismatches
}

pub(super) fn present(mut facts: Value, args: &Value) -> Value {
    let pack_agents = facts
        .as_object_mut()
        .and_then(|f| f.remove("packAgents"))
        .unwrap_or(Value::Null);
    let global = string(&facts, "criteria").to_owned();
    for row in facts["agents"].as_array_mut().into_iter().flatten() {
        if row["agent"] == "codex" {
            row["policyMismatches"] = json!(tier_mismatches(&global, &row["policy"]));
        }
    }
    criteria(&mut facts, &global, "global", args);
    if args["view"] == "full" {
        for row in facts["agents"].as_array_mut().into_iter().flatten() {
            let agent = string(row, "agent").to_owned();
            let text = string(&row["policy"], "criteria").to_owned();
            criteria(&mut row["policy"], &text, &agent, args);
        }
        clean(&mut facts);
        return facts;
    }
    let mut seen = BTreeMap::<String, String>::new();
    let mut rows = vec![];
    let mut others = vec![];
    for row in facts["agents"].as_array().into_iter().flatten() {
        let agent = string(row, "agent");
        let available = &row["availability"];
        let status = if available["installed"] != true {
            "not installed"
        } else if available["enabled"] != true {
            "disabled"
        } else if available["available"] == true {
            "available"
        } else {
            "unavailable"
        };
        let policy = &row["policy"];
        let text = string(policy, "criteria");
        let history = history(row);
        let no_policy = text.is_empty() && history.is_null();
        // Unconfigured, unused Agents cost a full row without informing a selection.
        let referenced = pack_agents
            .as_array()
            .is_some_and(|a| a.iter().any(|a| a == agent));
        if no_policy && !configured(policy) && !referenced && !args["agent"].is_string() {
            let state = row["capabilities"]["unavailable"]
                .as_str()
                .filter(|_| status == "available")
                .unwrap_or(status);
            others.push(format!("{agent}: {state}"));
            continue;
        }
        let mut out = json!({"agent":agent,"policyMismatches":row["policyMismatches"],"availability":if no_policy { format!("{status}, no policy") } else {status.into()}});
        if available["discoveryError"].is_string() {
            out["error"] = available["discoveryError"].clone();
        }
        criteria(&mut out, text, agent, args);
        let mut defaults = json!({});
        for k in ["model", "effort", "options", "serviceTier", "serviceTiers"] {
            defaults[k] = policy[k].clone();
        }
        out["defaults"] = defaults;
        // Restrictions still matter when there is no prose guidance or history.
        for k in [
            "allowModels",
            "denyModels",
            "allowEfforts",
            "denyEfforts",
            "allowOptions",
            "denyOptions",
        ] {
            out[k] = policy[k].clone();
        }
        let catalog = if agent == "codex" {
            row
        } else {
            &row["capabilities"]
        };
        out["authoritative"] = json!(!no_policy && catalog["authoritative"] == true);
        for key in ["source", "observedAt", "omittedModels", "unavailable"] {
            out[key] = catalog[key].clone();
        }
        if !no_policy {
            out["history"] = history;
            out["models"] = if catalog["models"].is_array() {
                json!(model_list(&catalog["models"]))
            } else {
                catalog["models"].clone()
            };
            let options: Vec<_> = row["capabilities"]["options"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|o| {
                    let values = o["values"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|v| v["value"].as_str())
                        .filter(|v| !v.is_empty())
                        .collect::<Vec<_>>()
                        .join("/");
                    format!("{}: {values}", string(o, "id"))
                })
                .collect();
            if !options.is_empty() {
                out["options"] = json!(options);
                out["optionsForModel"] = row["capabilities"]["optionsForModel"].clone();
                out["currentModel"] = row["capabilities"]["currentModel"].clone();
            }
        }
        let mut quota = vec![];
        for (id, value) in quotas(row) {
            if let Some(owner) = seen.get(&id) {
                quota.push(json!({"ref":format!("{owner}/{id}")}));
            } else {
                seen.insert(id.clone(), agent.into());
                let mut v = value;
                v["id"] = json!(id);
                quota.push(v);
            }
        }
        out["quota"] = if quota.is_empty() {
            row["quota"]["unavailable"].clone()
        } else {
            json!(quota)
        };
        rows.push(out);
    }
    if rows.iter().any(|r| !r["history"].is_null()) {
        facts["legend"] = json!("packs=name: summary [agent defaults] then 30d outcomes; 30d; no self-test; n=dispatches med=successful observed minutes unrev=unreviewed int=interrupted fail=failed ext=external reviews with own pass/rework; /tier omitted=default ?=unknown; other=mixed n<10; quota=% used");
    }
    facts["agents"] = json!(rows);
    if !others.is_empty() {
        facts["otherAgents"] = json!(others);
    }
    clean(&mut facts);
    facts
}

fn configured(policy: &Value) -> bool {
    [
        "model",
        "effort",
        "options",
        "serviceTier",
        "serviceTiers",
        "allowModels",
        "denyModels",
        "allowEfforts",
        "denyEfforts",
        "allowOptions",
        "denyOptions",
    ]
    .iter()
    .any(|k| !empty(&policy[*k]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn criteria_tier_conflicts_survive_full_compact_and_cached_reads() {
        // Recurring bug class: ax-9b7062e2 prose required default while the per-model override silently selected priority.
        let facts = json!({"agents":[{"agent":"codex","policy":{"criteria":"Pass `serviceTier` `default` on every create and send.","serviceTiers":{"model-a":"priority","model-b":"default"}}}]});
        for args in [
            json!({}),
            json!({"view":"full"}),
            json!({"knownCriteriaHash":hash("Pass `serviceTier` `default` on every create and send.")}),
        ] {
            let result = present(facts.clone(), &args);
            let conflicts = result["agents"][0]["policyMismatches"].as_array().unwrap();
            assert_eq!(conflicts.len(), 1);
            assert_eq!(conflicts[0]["model"], "model-a");
            assert_eq!(conflicts[0]["criteriaServiceTier"], "default");
            assert_eq!(conflicts[0]["overrideServiceTier"], "priority");
            assert_eq!(conflicts[0]["code"], "CRITERIA_SERVICE_TIER_MISMATCH");
        }
    }
}

#[cfg(test)]
mod catalog_metadata_tests {
    use super::*;
}

#[cfg(test)]
mod decision_budget_tests {
    use super::*;

    #[test]
    fn compact_history_keeps_six_configurations_and_merges_the_rest() {
        // Algorithmic core: compact history never exceeds six configuration groups plus other and preserves total dispatch counts.
        let now = chrono::Utc::now();
        let mut rows = vec![];
        for model in 0..9 {
            for turn in 0..(10 + model) {
                rows.push(json!({"agent":"codex","threadId":format!("t{model}"),"turnId":format!("u{turn}"),
                    "model":format!("m{model}"),"effort":"high","dispatchMode":"new-turn","submittedAt":now.to_rfc3339()}));
            }
        }
        let total = rows.len() as u64;
        let compact = crate::dispatch_policy::summarize_history(
            &rows,
            "codex",
            true,
            now - chrono::Duration::days(1),
        );
        let groups = compact["groups"].as_array().unwrap();
        assert!(groups.iter().filter(|g| g["model"] != "other").count() <= 6);
        assert_eq!(
            groups
                .iter()
                .map(|g| g["dispatches"].as_u64().unwrap())
                .sum::<u64>(),
            total
        );
        let full = crate::dispatch_policy::summarize_history(
            &rows,
            "codex",
            false,
            now - chrono::Duration::days(1),
        );
        assert_eq!(full["groups"].as_array().unwrap().len(), 9);
    }

    // Contract: dispatch policy decision view projects local-gateway pool quotas and policy constraints
    #[test]
    fn gateway_pool_quota_survives_projection_and_full_view_retains_detail() {
        let quota = json!({
            "source": "local-gateway",
            "gateway": "magpie",
            "ordinaryUsageAllowed": true,
            "state": "ready",
            "pools": [{
                "id": "codex",
                "accountsTotal": 3,
                "accountsWithRoom": 2,
                "accountsWithCredits": 1,
                "primary": {"usedPercent": 34.3, "bestAccountUsedPercent": 0.0, "windowDurationMins": 10080}
            }]
        });
        let facts = json!({"agents":[{"agent":"codex","quota":quota,
            "availability":{"installed":true,"enabled":true,"available":true},
            "policy":{"criteria":"Use current evidence.","denyModels":["denied"]}}]});
        let first = present(facts.clone(), &json!({}));
        let row = &first["agents"][0];
        assert!(row.get("accounts").is_none());
        assert_eq!(row["quota"][0]["source"], "local-gateway");
        assert_eq!(row["quota"][0]["accountsTotal"], 3);
        assert_eq!(row["quota"][0]["accountsWithRoom"], 2);
        assert_eq!(row["quota"][0]["bestAccountUsedPercent"], 0.0);
        assert_eq!(
            row["denyModels"],
            facts["agents"][0]["policy"]["denyModels"]
        );
        let full = present(facts, &json!({"view":"full"}));
        assert_eq!(full["agents"][0]["quota"]["source"], "local-gateway");
    }
}
