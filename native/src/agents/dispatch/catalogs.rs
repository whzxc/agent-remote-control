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
    if let Ok(mut facts) = load(&path(agent)) {
        facts["catalogSource"] = facts["source"].clone();
        facts["source"] = json!("persistent-snapshot");
        return Ok(facts);
    }
    Ok(json!({
        "unavailable":"needs-session",
        "nextAction":"No native catalog or saved snapshot; agent_create without prompt once, then dispatch_policy with agent and taskId"
    }))
}
