//! Catalog snapshots are discovery hints; dispatch always reads the native session.
use super::*;

static SNAPSHOTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn path(agent: &str) -> PathBuf {
    root().join("agents/catalogs").join(format!("{agent}.json"))
}

pub(in crate::agents) fn remember_catalog(agent: &str, facts: &Value) -> Result<()> {
    if !facts["models"].as_array().is_some_and(|m| !m.is_empty())
        || !facts["observedAt"].is_string()
    {
        return Ok(());
    }
    let _guard = SNAPSHOTS.lock().map_err(|e| e.to_string())?;
    let file = path(agent);
    if let Ok(old) = load(&file) {
        if timestamp(&old) >= timestamp(facts) {
            return Ok(());
        }
    }
    let mut catalog = facts.clone();
    let object = catalog.as_object_mut().unwrap();
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
    save(&file, &catalog)
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
            .is_some_and(|n| timestamp(n) == timestamp(&facts))
        {
            facts["source"] = native.unwrap()["source"].clone();
            return Ok(facts);
        }
        facts["catalogSource"] = facts["source"].clone();
        facts["source"] = json!("persistent-snapshot");
        return Ok(facts);
    }
    Ok(json!({
        "unavailable":"needs-session",
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
    let models: Vec<_> = value["models"]
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
            json!({
                "model":id,"name":info["name"],
                "options":[{"id":"reasoning_effort","values":efforts}]
            })
        })
        .collect();
    if models.is_empty() {
        return None;
    }
    Some(json!({
        "source":"grok-models-cache","observedAt":value.get("fetched_at").cloned()
            .unwrap_or(json!(file_observed(&file)?.to_rfc3339())),
        "scope":"catalog","executionEvidence":false,
        "models":models,"options":[],
        "optionsAvailability":"model-specific; see models[].options"
    }))
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
                                models.push(json!({"model":id,"name":model["name"]}));
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
        "scope":"catalog","executionEvidence":false,"models":models,"options":[],
        "coverage":"installed registry for providers named in native auth.json",
        "optionsAvailability":"needs-session"
    }))
}
