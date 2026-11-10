//! Dispatch association consumes registered identities and the pre-submission Git snapshot.
use super::*;

/// Pure association: titles, prompts, source labels and unregistered project arguments
/// cannot establish repository identity. Paths remain local and are never projected.
pub fn dispatch_association(baseline: &Value, registry: &Value) -> Value {
    let projects = registry["projects"].as_array();
    let complete = projects.is_some_and(|p| {
        p.len() <= 32
            && p.iter()
                .all(|p| p["roots"].as_array().is_some_and(|r| r.len() <= 8))
    });
    let mut matches = std::collections::BTreeSet::new();
    for project in projects.into_iter().flatten().take(32) {
        if types::identifier(string(project, "id")).is_err() {
            continue;
        }
        for root in project["roots"].as_array().into_iter().flatten().take(8) {
            let exact = baseline["root"].is_string() && root["path"] == baseline["root"];
            let common =
                baseline["commonDir"].is_string() && root["commonDir"] == baseline["commonDir"];
            if exact || common {
                matches.insert(string(project, "id"));
            }
        }
    }
    let project = if complete && matches.len() == 1 {
        matches.first().copied()
    } else {
        None
    };
    let mut resources = Vec::new();
    let mut lane = "unattributed";
    if let Some(project) = project {
        resources.push(ResourceKey::project(project).unwrap());
        if let Some(name) = baseline["ref"]
            .as_str()
            .and_then(|r| r.strip_prefix("refs/heads/wt/"))
        {
            if let Ok(key) = ResourceKey::lane(project, name) {
                resources.push(key);
                lane = "git-baseline";
            }
        } else if baseline["ref"].is_string() {
            lane = "not-a-lane";
        }
    }
    json!({"resources":resources,"project":if project.is_some(){"registered-root"}else if !complete{"registry-unavailable"}else if matches.len()>1{"ambiguous"}else{"unattributed"},"lane":lane,"registryObservedAt":registry["observedAt"]})
}

pub(crate) fn admission(origin: &Value, baseline: &Value) -> Value {
    let registry = crate::kernel::file_cache::load(&root().join("coordination/projects.json"))
        .unwrap_or(Value::Null);
    let mut association = dispatch_association(baseline, &registry);
    association["source"] = json!(if Principal::from_origin(origin).ok().flatten().is_some() {
        "observed"
    } else {
        "unattributed"
    });
    // Dispatch arguments do not carry an authenticated logical board-session handle.
    association["session"] = json!("unattributed");
    let resources: Vec<ResourceKey> =
        serde_json::from_value(association["resources"].clone()).unwrap_or_default();
    let mut advisory = warnings_for_source(&resources, None);
    if resources.is_empty() && advisory["conflictCoverage"] != "unknown" {
        advisory["conflictCoverage"] = json!("unattributed");
    }
    advisory["association"] = association;
    advisory["admissionBoardRevision"] = advisory["boardRevision"].clone();
    advisory["freshness"] = json!("admission");
    advisory
}

/// Replay refreshes advisory facts only; it does not submit work or derive another notice.
pub(crate) fn refresh(receipt: &mut Value) {
    if !receipt["coordination"].is_object() {
        return;
    }
    let resources = serde_json::from_value::<Vec<ResourceKey>>(
        receipt["coordination"]["association"]["resources"].clone(),
    )
    .unwrap_or_default();
    receipt["coordination"] = refreshed_advisory(receipt, warnings_for_source(&resources, None));
}

/// Pure replay projection preserves the admission revision and never touches dispatch identity.
pub fn refreshed_advisory(receipt: &Value, mut advisory: Value) -> Value {
    let association = receipt["coordination"]["association"].clone();
    let own_notice = format!("dispatch-{}", hash(string(receipt, "requestId")));
    if let Some(conflicts) = advisory["conflicts"].as_array_mut() {
        conflicts.retain(|c| c["noticeId"] != own_notice);
    }
    if association["resources"]
        .as_array()
        .is_some_and(Vec::is_empty)
        && advisory["conflictCoverage"] != "unknown"
    {
        advisory["conflictCoverage"] = json!("unattributed");
    }
    advisory["association"] = association;
    advisory["admissionBoardRevision"] = receipt["coordination"]["admissionBoardRevision"].clone();
    advisory["freshness"] = json!("refreshed");
    advisory
}
