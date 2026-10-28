//! Native display metadata and discovery snapshots; dispatch reads the native session.
use super::*;

static SNAPSHOTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn path(agent: &str) -> PathBuf {
    root().join("agents/catalogs").join(format!("{agent}.json"))
}

pub(in crate::agents) fn remember_catalog(agent: &str, facts: &Value) -> Result<()> {
    if !facts["models"].is_array() || !facts["observedAt"].is_string() {
        return Ok(());
    }
    let catalog = snapshot(facts);
    let _guard = SNAPSHOTS.lock().map_err(|e| e.to_string())?;
    let file = path(agent);
    if !catalog_update_needed(load(&file).ok().as_ref(), &catalog) {
        return Ok(());
    }
    save(&file, &catalog)
}

/// Decide whether a snapshot contains newer, usable information before writing it.
pub(super) fn catalog_update_needed(old: Option<&Value>, candidate: &Value) -> bool {
    let Some(old) = old else {
        return true;
    };
    if (candidate["models"].as_array().is_some_and(Vec::is_empty)
        && old["models"]
            .as_array()
            .is_some_and(|models| !models.is_empty()))
        || timestamp(old) > timestamp(candidate)
    {
        return false;
    }
    let mut previous = old.clone();
    let mut next = candidate.clone();
    for catalog in [&mut previous, &mut next] {
        if let Some(object) = catalog.as_object_mut() {
            object.remove("observedAt");
        }
    }
    previous != next
}

pub(super) fn snapshot(facts: &Value) -> Value {
    let mut catalog = facts.clone();
    let object = catalog.as_object_mut().unwrap();
    object.insert("authoritative".into(), json!(false));
    object.remove("taskId");
    object.remove("modelConfigId");
    if let Some(model) = object.remove("currentModel") {
        object.insert("optionsForModel".into(), model);
    }
    object.insert("scope".into(), json!("catalog"));
    for option in catalog["options"].as_array_mut().into_iter().flatten() {
        if let Some(value) = option.as_object_mut().unwrap().remove("currentValue") {
            option["lastObservedValue"] = value;
        }
    }
    catalog
}

fn timestamp(facts: &Value) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(string(facts, "observedAt")).ok()
}

pub(super) fn sessionless_catalog(agent: &str) -> Result<Value> {
    // Native file reads are request-driven and never start an Agent.
    let native = native_catalog(agent);
    if let Some(facts) = &native {
        remember_catalog(agent, facts)?;
    }
    if let Ok(mut facts) = load(&path(agent)) {
        if native
            .as_ref()
            .is_some_and(|n| timestamp(n) >= timestamp(&facts))
        {
            return Ok(native.unwrap());
        }
        facts["authoritative"] = json!(false);
        facts["catalogSource"] = facts["source"].clone();
        facts["source"] = json!("persistent-snapshot");
        return Ok(facts);
    }
    Ok(json!({
        "authoritative":false,"unavailable":"needs-session",
        "nextAction":"No native catalog or saved snapshot; agent_create without prompt once, then dispatch_policy with agent and taskId"
    }))
}

// Native locations and chat filtering follow magpie's grokOwnOptions and
// piRegistry (Copyright (c) 2026 yetone), see licenses/magpie-LICENSE.txt.
fn native_catalog(agent: &str) -> Option<Value> {
    match agent {
        "grok" => grok_catalog(),
        "pi" => pi_catalog(),
        _ => None,
    }
}

fn native_home(variable: &str, fallback: &str) -> Option<PathBuf> {
    std::env::var_os(variable)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(fallback)))
}

fn file_observed(path: &std::path::Path) -> Option<chrono::DateTime<chrono::Utc>> {
    Some(std::fs::metadata(path).ok()?.modified().ok()?.into())
}

fn grok_catalog() -> Option<Value> {
    let file = native_home("GROK_HOME", ".grok")?.join("models_cache.json");
    let value = load(&file).ok()?;
    let models = grok_models(&value)?;
    if models.is_empty() {
        return None;
    }
    Some(json!({
        "source":"grok-models-cache","observedAt":value.get("fetched_at").cloned()
            .unwrap_or(json!(file_observed(&file)?.to_rfc3339())),
        "scope":"catalog","authoritative":false,"executionEvidence":false,
        "models":models,"options":[],
        "optionsAvailability":"model-specific; see models[].options"
    }))
}

pub(super) fn grok_models(value: &Value) -> Option<Vec<Value>> {
    Some(
        value["models"]
            .as_object()?
            .iter()
            .filter(|(_, m)| m["info"]["hidden"] != true)
            .map(|(id, model)| {
                let info = &model["info"];
                let efforts: Vec<_> = info["reasoning_efforts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|e| e["value"].is_string())
                    .map(|e| json!({"value":e["value"],"name":e["label"]}))
                    .collect();
                let mut row = json!({
                    "model":id,"name":info["name"],
                    "options":[{"id":"reasoning_effort","values":efforts}]
                });
                display_metadata(&mut row, info, "name");
                row
            })
            .collect(),
    )
}

fn pi_catalog() -> Option<Value> {
    let home = native_home("PI_CODING_AGENT_DIR", ".pi/agent")?;
    let auth = home.join("auth.json");
    let providers = load(&auth).ok()?;
    let binary = std::fs::canonicalize(driver::discover("pi")?).ok()?;
    let modules = binary
        .ancestors()
        .find(|p| p.file_name().is_some_and(|n| n == "node_modules"))?;
    let mut observed = file_observed(&auth)?;
    let mut models = Vec::new();
    for provider in providers.as_object()?.keys() {
        if provider.is_empty()
            || provider == "."
            || provider == ".."
            || provider.contains(['/', '\\', ':'])
        {
            continue;
        }
        for package in [
            "@earendil-works/pi-coding-agent",
            "@mariozechner/pi-coding-agent",
        ] {
            for base in [
                modules.join(package).join("node_modules"),
                modules.to_path_buf(),
            ] {
                for ai in ["@earendil-works/pi-ai", "@mariozechner/pi-ai"] {
                    let file = base
                        .join(ai)
                        .join("dist/providers/data")
                        .join(format!("{provider}.json"));
                    let Ok(value) = load(&file) else {
                        continue;
                    };
                    observed = observed.max(file_observed(&file)?);
                    for group in value.as_object().into_iter().flat_map(|v| v.values()) {
                        for model in group.as_object().into_iter().flat_map(|v| v.values()) {
                            let id = string(model, "id");
                            if id.is_empty() || model["type"].as_str().is_some_and(|t| t != "chat")
                            {
                                continue;
                            }
                            let id = format!("{provider}/{id}");
                            if !models.iter().any(|m: &Value| m["model"] == id) {
                                models.push(pi_model(model, provider));
                            }
                        }
                    }
                }
            }
        }
    }
    if models.is_empty() {
        return None;
    }
    Some(json!({
        "source":"pi-installed-registry","observedAt":observed.to_rfc3339(),
        "scope":"catalog","authoritative":false,"executionEvidence":false,"models":models,"options":[],
        "coverage":"installed registry for providers named in native auth.json",
        "optionsAvailability":"needs-session"
    }))
}

/// Copy explicitly named native metadata. IDs and human labels are never parsed.
pub(super) fn display_metadata(row: &mut Value, native: &Value, name_key: &str) {
    if let Some(name) = native[name_key].as_str().filter(|s| !s.is_empty()) {
        row["displayName"] = json!(name);
    }
    for data in [native, &native["_meta"]] {
        if row.get("provider").is_none() {
            if let Some(provider) = native_provider(data) {
                row["provider"] = provider;
            }
        }
        if row.get("contextWindow").is_none() {
            // A list is retained as a list: neither its first nor largest entry is a default.
            for key in [
                "contextWindow",
                "totalContextTokens",
                "context_window",
                "contextWindows",
                "context_windows",
            ] {
                let value = &data[key];
                if value.as_u64().is_some_and(|n| n > 0)
                    || value.as_array().is_some_and(|a| {
                        !a.is_empty() && a.iter().all(|v| v.as_u64().is_some_and(|n| n > 0))
                    })
                {
                    row["contextWindow"] = value.clone();
                    break;
                }
            }
        }
    }
}

fn native_provider(data: &Value) -> Option<Value> {
    let provider = &data["provider"];
    let id = provider["id"]
        .as_str()
        .or(provider.as_str())
        .or(data["providerId"].as_str())?;
    if id.is_empty() {
        return None;
    }
    let name = provider["name"]
        .as_str()
        .or(data["providerName"].as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(id);
    Some(json!({"id":id,"name":name}))
}

pub(super) fn pi_model(model: &Value, provider: &str) -> Value {
    let mut row = json!({"model":format!("{provider}/{}",string(model,"id")),"name":model["name"]});
    display_metadata(&mut row, model, "name");
    if !provider.is_empty() && row["provider"]["id"] != provider {
        // The registry key / RPC provider field is an explicit native identifier.
        row["provider"] = json!({"id":provider,"name":provider});
    }
    row
}

pub(super) fn acp_model(native: &Value, id_key: &str, group: Option<&Value>, agent: &str) -> Value {
    let mut row = json!({"model":native[id_key],"name":native["name"]});
    display_metadata(&mut row, native, "name");
    if let Some(group) = group {
        row["group"] = group["group"].clone();
        // DSH's model selector groups are provider records. Generic ACP groups
        // (for example Recommended) have no provider semantics without metadata.
        if row.get("provider").is_none() {
            let provider = native_provider(group).or_else(|| native_provider(&group["_meta"]));
            if let Some(provider) = provider {
                row["provider"] = provider;
            } else if agent == "dsh"
                || group["category"] == "provider"
                || group["_meta"]["category"] == "provider"
            {
                if let Some(id) = group["group"].as_str().filter(|s| !s.is_empty()) {
                    row["provider"] = json!({"id":id,"name":group["name"].as_str().filter(|s| !s.is_empty()).unwrap_or(id)});
                }
            }
        }
    }
    row
}

pub(super) fn acp_models(options: &Value, agent: &str) -> Vec<Value> {
    options
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|option| {
            if let Some(values) = option["options"].as_array() {
                values
                    .iter()
                    .map(|v| acp_model(v, "value", Some(option), agent))
                    .collect::<Vec<_>>()
            } else {
                vec![acp_model(option, "value", None, agent)]
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_metadata_never_infers_from_ids_or_brands() {
        // Property: opaque identities and brand-like names cannot supply absent native metadata.
        for id in [
            "vendor/model-128k",
            "[\"profile\", \"gpt-model\"]",
            " GPT-6-Astra ",
        ] {
            for agent in ["claude", "cursor", "grok", "dsh"] {
                let native = json!({"value":id});
                let row = acp_models(&json!([native]), agent).remove(0);
                assert_eq!(row["model"], id);
                for field in ["displayName", "provider", "contextWindow"] {
                    assert!(row.get(field).is_none());
                }
                let named = json!({"value":id,"name":"Claude GPT · Provider 128k"});
                let row = acp_models(&json!([named.clone()]), agent).remove(0);
                assert_eq!(row["displayName"], named["name"]);
                assert!(row.get("provider").is_none());
                assert!(row.get("contextWindow").is_none());
            }
        }
    }

    #[test]
    fn catalog_metadata_dsh_groups_keep_native_provider_and_opaque_id() {
        // Regression: DSH provider groups and names were dropped while clients parsed JSON-array model IDs.
        let id = "[\"profile\", \"upstream/model\"]";
        let group = json!({"group":"profile","name":"Native profile","options":[{"value":id,"name":"Native · model"}]});
        let rows = acp_models(&json!([group.clone()]), "dsh");
        assert_eq!(rows[0]["model"], id);
        assert_eq!(rows[0]["displayName"], group["options"][0]["name"]);
        assert_eq!(
            rows[0]["provider"],
            json!({"id":group["group"],"name":group["name"]})
        );
        assert_eq!(rows[0]["group"], group["group"]);
    }

    #[test]
    fn catalog_metadata_acp_only_promotes_provider_groups_with_semantics() {
        // Property: generic ACP grouping never implies a provider, while explicit provider metadata survives.
        for agent in ["claude", "cursor", "grok"] {
            let mut group = json!({"group":"recommended","name":"Recommended","options":[{"value":"opaque","name":"Native name","_meta":{"contextWindows":[64000,128000]}}]});
            let rows = acp_models(&json!([group.clone()]), agent);
            assert!(rows[0].get("provider").is_none());
            assert_eq!(rows[0]["contextWindow"], json!([64000, 128000]));
            group["_meta"] = json!({"category":"provider"});
            let rows = acp_models(&json!([group.clone()]), agent);
            assert_eq!(
                rows[0]["provider"],
                json!({"id":group["group"],"name":group["name"]})
            );
            group["_meta"] = json!({"provider":{"id":"native-provider","name":"Native provider"}});
            let rows = acp_models(&json!([group.clone()]), agent);
            assert_eq!(rows[0]["provider"], group["_meta"]["provider"]);
        }
    }

    #[test]
    fn catalog_metadata_pi_registry_and_rpc_use_explicit_fields() {
        // Regression: Pi catalog rows discarded provider, human name and registry context size.
        let native = json!({"id":"opaque/model","provider":"native-key","name":"Native model","contextWindow":131072});
        let row = pi_model(&native, string(&native, "provider"));
        assert_eq!(row["model"], "native-key/opaque/model");
        assert_eq!(row["displayName"], native["name"]);
        assert_eq!(
            row["provider"],
            json!({"id":native["provider"],"name":native["provider"]})
        );
        assert_eq!(row["contextWindow"], native["contextWindow"]);
        let named_provider =
            json!({"id":"opaque","provider":"native-key","providerName":"Native provider"});
        assert_eq!(
            pi_model(&named_provider, "native-key")["provider"]["name"],
            named_provider["providerName"]
        );
        let facts = catalog_facts(
            &json!({"agent":"pi"}),
            &json!({"availableModels":[native]}),
            Value::Null,
            "pi-rpc",
            Value::Null,
        );
        assert_eq!(facts["models"][0], row);
        assert_eq!(facts["authoritative"], true);
        let absent = pi_model(&json!({"id":"claude-128k"}), "native-key");
        assert!(absent.get("displayName").is_none());
        assert!(absent.get("contextWindow").is_none());
    }

    #[test]
    fn catalog_metadata_grok_cache_preserves_explicit_capacity_and_options() {
        // Regression: Grok model-cache human names and context windows were lost in display metadata.
        let cache = json!({"models":{
            "opaque":{"info":{"name":"Grok native name","context_window":256000,"reasoning_efforts":[{"value":"high","label":"High"}]}},
            "brand-128k":{"info":{"model_family":"xai"}},
            "hidden":{"info":{"hidden":true,"name":"Hidden"}}
        }});
        let rows = grok_models(&cache).unwrap();
        assert_eq!(rows.len(), 2);
        let row = rows.iter().find(|r| r["model"] == "opaque").unwrap();
        assert_eq!(
            row["displayName"],
            cache["models"]["opaque"]["info"]["name"]
        );
        assert_eq!(row["contextWindow"], 256000);
        assert_eq!(row["options"][0]["values"][0]["value"], "high");
        assert!(row.get("provider").is_none());
        let absent = rows.iter().find(|r| r["model"] == "brand-128k").unwrap();
        for field in ["displayName", "provider", "contextWindow"] {
            assert!(absent.get(field).is_none());
        }
    }

    #[test]
    fn catalog_metadata_session_snapshots_preserve_fields_without_authority() {
        // Property: snapshots preserve every model field but cannot establish current catalog completeness.
        let metadata = json!({"models":{"availableModels":[{"modelId":"opaque","name":"Native", "_meta":{"provider":{"id":"p","name":"Provider"},"totalContextTokens":128000}}]}});
        let task = json!({"agent":"grok","taskId":"fixture"});
        let live = catalog_facts(
            &task,
            &metadata,
            json!("2026-01-01T00:00:00Z"),
            "live-session-snapshot",
            Value::Null,
        );
        assert_eq!(live["authoritative"], true);
        assert_eq!(live["models"][0]["contextWindow"], 128000);
        let saved = snapshot(&live);
        assert_eq!(saved["models"], live["models"]);
        assert_eq!(saved["authoritative"], false);
        let persisted = catalog_facts(
            &task,
            &metadata,
            Value::Null,
            "persisted-session-snapshot",
            Value::Null,
        );
        assert_eq!(persisted["models"], live["models"]);
        assert_eq!(persisted["authoritative"], false);
        let empty_group = json!({"configOptions":[{"id":"model","options":[{"group":"unavailable","options":[]}]}]});
        let partial = catalog_facts(
            &json!({"agent":"dsh"}),
            &empty_group,
            Value::Null,
            "live-session-snapshot",
            Value::Null,
        );
        assert_eq!(partial["authoritative"], false);
    }

    #[test]
    fn catalog_metadata_review_preserves_nonempty_snapshot_on_empty_observation() {
        // Regression: review of 136285a8 found a newer empty session catalog could erase a saved nonempty catalog.
        let previous = snapshot(
            &json!({"models":[{"model":"opaque","displayName":"Native"}],"observedAt":"2026-01-01T00:00:00Z"}),
        );
        let empty = snapshot(&json!({"models":[],"observedAt":"2026-01-02T00:00:00Z"}));
        assert!(!catalog_update_needed(Some(&previous), &empty));
        assert!(catalog_update_needed(None, &empty));
        let mut populated = previous.clone();
        populated["observedAt"] = json!("2026-01-03T00:00:00Z");
        assert!(catalog_update_needed(Some(&empty), &populated));
    }

    #[test]
    fn catalog_metadata_review_ignores_observation_time_for_unchanged_snapshots() {
        // Regression: review of 136285a8 found observedAt defeated snapshot deduplication on every observation.
        let previous = snapshot(
            &json!({"models":[{"model":"opaque","displayName":"Native"}],"observedAt":"2026-01-01T00:00:00Z"}),
        );
        let mut next = previous.clone();
        next["observedAt"] = json!("2026-01-02T00:00:00Z");
        assert!(!catalog_update_needed(Some(&previous), &next));
        next["models"][0]["contextWindow"] = json!(131072);
        assert!(catalog_update_needed(Some(&previous), &next));
        next["observedAt"] = previous["observedAt"].clone();
        assert!(catalog_update_needed(Some(&previous), &next));
        next["observedAt"] = json!("2025-12-31T00:00:00Z");
        assert!(!catalog_update_needed(Some(&previous), &next));
    }
}
