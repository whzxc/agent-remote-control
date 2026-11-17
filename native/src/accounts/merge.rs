use super::*;

pub(super) fn canonical(rows: &[Value], reference: &str) -> Result<String> {
    let mut current = reference;
    for _ in 0..=rows.len() {
        let Some(row) = rows.iter().find(|row| row["id"] == current) else {
            return Ok(current.into());
        };
        match row["mergedInto"].as_str() {
            Some(next) => current = next,
            None => return Ok(current.into()),
        }
    }
    Err("ACCOUNT_MERGE_CYCLE: Inspect accounts before changing account ownership".into())
}

pub(super) fn matches_identity(account: &Value, key: &str) -> bool {
    account["identityKey"] == key
        || account["identityAliases"]
            .as_array()
            .is_some_and(|keys| keys.iter().any(|value| value == key))
}

/// Explicit user confirmation joins ownership, not credentials or immutable task records.
pub fn merge_accounts(
    rows: &mut [Value],
    args: &Value,
    snapshot: &Value,
    at: &str,
) -> Result<Value> {
    let into = canonical(rows, string(args, "into"))?;
    let target = rows
        .iter()
        .position(|row| row["id"] == into && live(row))
        .ok_or("ACCOUNT_MERGE_TARGET_MISSING: Select an active target account")?;
    let ids = args["ids"].as_array().filter(|ids| !ids.is_empty()).ok_or(
        "ACCOUNT_MERGE_MEMBERS_REQUIRED: Supply the account IDs confirmed to share this identity",
    )?;
    let mut members = Vec::new();
    for id in ids {
        let id = id
            .as_str()
            .ok_or("INVALID_ACCOUNT_ID: Account IDs must be strings")?;
        let id = canonical(rows, id)?;
        let index = rows
            .iter()
            .position(|row| row["id"] == id && live(row))
            .ok_or("ACCOUNT_MERGE_MEMBER_MISSING: Read accounts and select active account IDs")?;
        if index != target && !members.contains(&index) {
            members.push(index);
        }
    }
    if let Some(alias) = args.get("alias") {
        if !alias.as_str().is_some_and(|value| {
            !value.trim().is_empty() && value.len() <= 120 && !value.chars().any(char::is_control)
        }) {
            return Err("INVALID_ACCOUNT_ALIAS: Use 1 to 120 characters".into());
        }
    }
    let subscription = if let Some(id) = args["quotaProviderId"].as_str() {
        Some(
            snapshot["providers"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|provider| provider["providerId"] == id)
                .ok_or(
                    "ACCOUNT_QUOTA_PROVIDER_MISSING: Select a quota provider from subscriptions",
                )?
                .clone(),
        )
    } else {
        None
    };
    let mut combined = rows[target].clone();
    for index in members {
        let previous = rows[index].clone();
        for field in [
            "sources",
            "agentProfiles",
            "identityAliases",
            "mergedAccountIds",
        ] {
            if !combined[field].is_array() {
                combined[field] = json!([]);
            }
            for value in previous[field].as_array().into_iter().flatten() {
                let present = if field == "agentProfiles" {
                    profiles(&combined).any(|profile| {
                        profile["agent"] == value["agent"]
                            && profile["profileId"] == value["profileId"]
                    })
                } else {
                    combined[field].as_array().unwrap().contains(value)
                };
                if !present {
                    combined[field].as_array_mut().unwrap().push(value.clone());
                }
            }
        }
        for (field, value) in [
            ("identityAliases", &previous["identityKey"]),
            ("mergedAccountIds", &previous["id"]),
        ] {
            if value.is_string() && !combined[field].as_array().unwrap().contains(value) {
                combined[field].as_array_mut().unwrap().push(value.clone());
            }
        }
        if string(&combined, "identityKey").contains(":unidentified:")
            && previous["identityKey"]
                .as_str()
                .is_some_and(|key| !key.contains(":unidentified:"))
        {
            let provisional = combined["identityKey"].clone();
            if !combined["identityAliases"]
                .as_array()
                .unwrap()
                .contains(&provisional)
            {
                combined["identityAliases"]
                    .as_array_mut()
                    .unwrap()
                    .push(provisional);
            }
            combined["identityKey"] = previous["identityKey"].clone();
            combined["provider"] = previous["provider"].clone();
        }
        if let Some(evidence) = previous["sourceIdentities"].as_object() {
            for (source, evidence) in evidence {
                combined["sourceIdentities"][source] = evidence.clone();
                combined["sourceIdentities"][source]["accountId"] = json!(into);
            }
        }
        for field in ["email", "orgName", "plan", "quotaProviderId"] {
            if combined[field].is_null() && !previous[field].is_null() {
                combined[field] = previous[field].clone();
            }
        }
        if combined["quota"]["windows"]
            .as_array()
            .is_none_or(Vec::is_empty)
            && previous["quota"]["windows"]
                .as_array()
                .is_some_and(|windows| !windows.is_empty())
        {
            combined["quota"] = previous["quota"].clone();
        }
        rows[index]["sources"] = json!([]);
        rows[index]["agentProfiles"] = json!([]);
        rows[index]["sourceIdentities"] = json!({});
        rows[index]["removedAt"] = json!(at);
        rows[index]["mergedInto"] = json!(into);
    }
    if let Some(alias) = args["alias"].as_str() {
        combined["alias"] = json!(alias.trim());
    }
    for source in combined["sources"].as_array().cloned().unwrap_or_default() {
        if let Some(source) = source.as_str() {
            combined["sourceIdentities"][source]["state"] = json!("resolved");
            combined["sourceIdentities"][source]["accountId"] = json!(into);
            combined["sourceIdentities"][source]["confirmation"] =
                json!({"kind":"user-confirmed-merge","confirmedAt":at});
            if let Some(resolution) = combined["sourceIdentities"][source].as_object_mut() {
                resolution.remove("code");
                resolution.remove("reason");
            }
        }
    }
    if let Some(subscription) = subscription {
        combined["quotaProviderId"] = subscription["providerId"].clone();
        combined["provider"] = json!(provider(string(&subscription, "agentId")));
        combined["quota"] = shared_quota(&subscription);
        if subscription["rawUsage"]["config"]["isUnifiedBillingUser"] == true
            || subscription["rawUsage"]["sharedUsage"]["config"]["isUnifiedBillingUser"] == true
        {
            combined["provider"] = json!("xai");
            combined["plan"] = json!("X Pass");
        }
    } else if args.get("quotaProviderId").is_some_and(Value::is_null) {
        combined["quotaProviderId"] = Value::Null;
        combined["quota"] = json!({"state":"unavailable","windows":[]});
    }
    combined["observedAt"] = json!(at);
    rows[target] = combined;
    defaults(rows);
    Ok(rows[target].clone())
}

pub(super) fn shared_quota(subscription: &Value) -> Value {
    let mut quota = json!({"source":"subscription","state":subscription["state"],"windows":subscription["windows"],
        "observedAt":subscription["observedAt"],"accountBlocked":subscription["accountBlocked"],"blockedPoolIds":subscription["blockedPoolIds"]});
    if !subscription["error"].is_null() {
        quota["error"] = subscription["error"].clone();
    }
    quota
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmed_merge_retains_roles_history_and_retry_stability() {
        // Algorithmic core: explicit account merges retain all role memberships, identity evidence and old ID history, and replay without duplicating ownership.
        let mut rows = vec![
            json!({"id":"target","provider":"xai","identityKey":"xai:id:example","alias":"Example","sources":[],"agentProfiles":[{"agent":"grok","profileId":"grok-home","default":true}],"quota":{"state":"unavailable","windows":[]}}),
            json!({"id":"source-one","provider":"xai","identityKey":"xai:unidentified:source-one","sources":["source-one"],"agentProfiles":[]}),
            json!({"id":"source-two","provider":"xai","identityKey":"xai:unidentified:source-two","sources":["source-two"],"agentProfiles":[]}),
            json!({"id":"cursor","provider":"cursor","identityKey":"cursor:id:example","sources":[],"agentProfiles":[{"agent":"cursor","profileId":"cursor-home","default":true}]}),
        ];
        let snapshot = json!({"providers":[{"providerId":"grok","agentId":"grok","state":"ready","windows":[{"id":"weekly","poolId":"main","label":"weekly","usedPercent":20}],"rawUsage":{"config":{"isUnifiedBillingUser":true}}}]});
        let args = json!({"into":"target","ids":["source-one","source-two","cursor"],"quotaProviderId":"grok"});
        let account = merge_accounts(&mut rows, &args, &snapshot, "2026-01-01T00:00:00Z").unwrap();
        assert_eq!(account["sources"].as_array().unwrap().len(), 2);
        assert_eq!(account["agentProfiles"].as_array().unwrap().len(), 2);
        assert_eq!(account["mergedAccountIds"].as_array().unwrap().len(), 3);
        for old in ["source-one", "source-two", "cursor"] {
            assert_eq!(
                rows.iter().find(|row| row["id"] == old).unwrap()["mergedInto"],
                "target"
            );
        }
        let before = rows.clone();
        merge_accounts(&mut rows, &args, &snapshot, "2026-01-01T00:00:00Z").unwrap();
        assert_eq!(rows, before);
        assert!(rows[0]["identityAliases"]
            .as_array()
            .unwrap()
            .contains(&json!("cursor:id:example")));
        assert_eq!(rows[0]["identityKey"], "xai:id:example");
    }
}
