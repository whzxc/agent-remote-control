//! Source linkage retains authorization, handshake and explicit ownership confirmation.
use super::*;

pub(super) fn has_conflict(account: &Value) -> bool {
    account["sourceIdentities"]
        .as_object()
        .is_some_and(|entries| entries.values().any(|r| r["state"] == "conflict"))
}

pub(super) fn observe_source(rows: &mut Vec<Value>, source: &Value) -> String {
    let source_id = string(source, "id");
    let provider = provider(string(source, "platform"));
    // An unidentified source-only account has no provider identity to preserve.
    // Reclassify its namespace after a product correction without changing its ID.
    if let Some(row) = rows.iter_mut().find(|row| {
        live(row)
            && row["sources"]
                .as_array()
                .is_some_and(|ids| ids.len() == 1 && ids[0] == source_id)
    }) {
        let unidentified = format!("{}:unidentified:{source_id}", string(row, "provider"));
        if row["provider"] != provider
            && row["identityKey"] == unidentified
            && profiles(row).next().is_none()
        {
            row["provider"] = json!(provider);
            row["identityKey"] = json!(format!("{provider}:unidentified:{source_id}"));
        }
    }
    let old = rows
        .iter()
        .find(|a| {
            live(a)
                && a["sources"]
                    .as_array()
                    .is_some_and(|ss| ss.iter().any(|s| s == source_id))
        })
        .cloned();
    let facts = &source["authorizationFacts"];
    let key = identity_key(provider, facts);
    let account_id = observe(rows, provider, facts, source_id, None, Some(source_id));
    if let Some(key) = key {
        let row = rows.iter_mut().find(|a| a["id"] == account_id).unwrap();
        let previous = old
            .as_ref()
            .map(|a| a["sourceIdentities"][source_id].clone())
            .unwrap_or(Value::Null);
        // Preserve the time of unchanged evidence and any unresolved disagreement.
        if previous["authorization"]["identityKey"] != key {
            let authorization =
                json!({"kind":"authorization","identityKey":key,"observedAt":now()});
            let conflict = previous["evidence"]["identityKey"]
                .as_str()
                .is_some_and(|k| {
                    k != key
                        && !(merge::matches_identity(row, k) && merge::matches_identity(row, &key))
                });
            row["sourceIdentities"][source_id] = json!({"state":if conflict {"conflict"} else {"resolved"},"accountId":account_id,"authorization":authorization});
            if !previous["evidence"].is_null() {
                row["sourceIdentities"][source_id]["evidence"] = previous["evidence"].clone();
            }
            if !previous["confirmation"].is_null() {
                row["sourceIdentities"][source_id]["confirmation"] =
                    previous["confirmation"].clone();
            }
            if conflict {
                row["sourceIdentities"][source_id]["code"] = json!("ACCOUNT_IDENTITY_CONFLICT");
                row["sourceIdentities"][source_id]["reason"] = json!("Authorization identity differs from the confirmed cloud-session identity; authorization takes precedence. Inspect accounts and verify the intended target again.");
            }
        }
    }
    account_id
}

/// Deterministic account transition for confirmed delivery evidence. No credentials enter this record.
/// The caller supplies the confirmation timestamp after validating a source-bound challenge.
pub fn link_source_identity(rows: &mut [Value], source: &str, evidence: Value) -> Result<Value> {
    let old = rows
        .iter()
        .position(|a| {
            live(a)
                && a["sources"]
                    .as_array()
                    .is_some_and(|ss| ss.iter().any(|s| s == source))
        })
        .ok_or("SOURCE_ACCOUNT_NOT_FOUND")?;
    let target = rows.iter().position(|a| {
        live(a)
            && a["id"] == evidence["accountId"]
            && merge::matches_identity(a, string(&evidence, "identityKey"))
            && profiles(a)
                .any(|p| p["agent"] == "claude" && p["profileId"] == evidence["profileId"])
    });
    let known = !string(&rows[old], "identityKey").contains(":unidentified:");
    let conflict = target.is_none()
        || known
            && !target.is_some_and(|target| {
                merge::matches_identity(&rows[target], string(&rows[old], "identityKey"))
            });
    let mut resolution = json!({"state":if conflict {"conflict"} else {"resolved"},"accountId":rows[old]["id"],"evidence":evidence});
    let previous = rows[old]["sourceIdentities"][source].clone();
    if !previous["authorization"].is_null() {
        resolution["authorization"] = previous["authorization"].clone();
    }
    if !previous["confirmation"].is_null() {
        resolution["confirmation"] = previous["confirmation"].clone();
    }
    if conflict {
        resolution["code"] = json!("ACCOUNT_IDENTITY_CONFLICT");
        resolution["reason"] = json!(if target.is_none() {
            "The sending profile identity changed or its account was removed. Inspect accounts and verify again."
        } else {
            "The confirmed cloud-session identity differs from this source's existing identity. The existing account is retained. Inspect accounts and verify the intended target again."
        });
        if !previous["evidence"].is_null() && previous["evidence"] != resolution["evidence"] {
            resolution["previousEvidence"] = previous["evidence"].clone();
        }
        rows[old]["sourceIdentities"][source] = resolution.clone();
        return Ok(resolution);
    }
    let target = target.unwrap();
    resolution["accountId"] = rows[target]["id"].clone();
    if old != target {
        rows[old]["sources"]
            .as_array_mut()
            .unwrap()
            .retain(|s| s != source);
        if let Some(entries) = rows[old]["sourceIdentities"].as_object_mut() {
            entries.remove(source);
        }
        rows[target]["sources"]
            .as_array_mut()
            .unwrap()
            .push(json!(source));
        if rows[old]["sources"].as_array().unwrap().is_empty()
            && profiles(&rows[old]).next().is_none()
        {
            rows[old]["removedAt"] = evidence["confirmedAt"].clone();
            rows[old]["mergedInto"] = rows[target]["id"].clone();
        }
    }
    rows[target]["sourceIdentities"][source] = resolution.clone();
    rows[target]["observedAt"] = evidence["confirmedAt"].clone();
    Ok(resolution)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_product_correction_reclassifies_only_its_unidentified_account() {
        // Regression: correcting a source from ChatGPT to Claude left its unidentified account under OpenAI.
        let mut rows = vec![];
        let mut source = json!({"id":"source-one","platform":"openai"});
        let account_id = observe_source(&mut rows, &source);
        rows[0]["alias"] = json!("Custom alias");
        let other_id = observe_source(&mut rows, &json!({"id":"source-two","platform":"openai"}));
        let other = rows
            .iter()
            .find(|row| row["id"] == other_id)
            .unwrap()
            .clone();
        source["platform"] = json!("anthropic");
        assert_eq!(observe_source(&mut rows, &source), account_id);
        let account = rows.iter().find(|row| row["id"] == account_id).unwrap();
        assert_eq!(account["provider"], "anthropic");
        assert_eq!(account["identityKey"], "anthropic:unidentified:source-one");
        assert_eq!(account["alias"], "Custom alias");
        assert_eq!(account["sources"], json!(["source-one"]));
        assert_eq!(
            *rows.iter().find(|row| row["id"] == other_id).unwrap(),
            other
        );
    }

    #[test]
    fn product_metadata_never_reclassifies_a_confirmed_account() {
        // Property: client product metadata cannot overwrite a confirmed provider identity or detach its source.
        let mut rows = vec![];
        let mut source = json!({"id":"source-confirmed","platform":"openai","authorizationFacts":{"accountId":"provider-account"}});
        let account_id = observe_source(&mut rows, &source);
        source["platform"] = json!("anthropic");
        source["authorizationFacts"] = Value::Null;
        assert_eq!(observe_source(&mut rows, &source), account_id);
        let account = rows.iter().find(|row| row["id"] == account_id).unwrap();
        assert_eq!(account["provider"], "openai");
        assert_eq!(account["identityKey"], "openai:id:provider-account");
        assert_eq!(account["sources"], json!(["source-confirmed"]));
    }

    #[test]
    fn confirmed_identity_never_overwrites_another_provider_identity() {
        // Property: conflicting handshake evidence preserves the authoritative source account and records the disagreement.
        let mut rows = vec![
            json!({"id":"source-account","identityKey":"anthropic:id:example-one","sources":["source"],"agentProfiles":[],"sourceIdentities":{"source":{"state":"resolved","authorization":{"kind":"authorization","identityKey":"anthropic:id:example-one"}}}}),
            json!({"id":"profile-account","identityKey":"anthropic:id:example-two","sources":[],"agentProfiles":[{"agent":"claude","profileId":"profile"}]}),
        ];
        let evidence = json!({"kind":"claude-session-handshake","sourceId":"source","profileId":"profile","accountId":"profile-account","identityKey":"anthropic:id:example-two","confirmedAt":"2026-01-01T00:00:00Z"});
        let result = link_source_identity(&mut rows, "source", evidence.clone()).unwrap();
        assert_eq!(result["state"], "conflict");
        assert_eq!(result["accountId"], "source-account");
        assert_eq!(result["evidence"], evidence);
        assert_eq!(
            result["authorization"]["identityKey"],
            "anthropic:id:example-one"
        );
        assert_eq!(rows[0]["sources"], json!(["source"]));
        assert_eq!(rows[1]["sources"], json!([]));
    }
    #[test]
    fn unidentified_source_links_only_to_the_proven_profile_identity() {
        // Property: confirmed evidence moves only its source and stale profile evidence never links an account.
        let mut rows = vec![
            json!({"id":"unknown","identityKey":"other:unidentified:source","sources":["source"],"agentProfiles":[]}),
            json!({"id":"owner","identityKey":"anthropic:id:example","sources":[],"agentProfiles":[{"agent":"claude","profileId":"profile"}]}),
        ];
        let evidence = json!({"kind":"claude-session-handshake","sourceId":"source","profileId":"wrong","accountId":"owner","identityKey":"anthropic:id:example","confirmedAt":"2026-01-01T00:00:00Z"});
        assert_eq!(
            link_source_identity(&mut rows, "source", evidence.clone()).unwrap()["state"],
            "conflict"
        );
        let mut evidence = evidence;
        evidence["profileId"] = json!("profile");
        let result = link_source_identity(&mut rows, "source", evidence.clone()).unwrap();
        assert_eq!(result["state"], "resolved");
        assert_eq!(result["accountId"], "owner");
        assert_eq!(result["evidence"]["confirmedAt"], evidence["confirmedAt"]);
        assert_eq!(rows[0]["mergedInto"], "owner");
        assert_eq!(rows[1]["sources"], json!(["source"]));
    }
}
