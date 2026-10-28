//! Import ownership compares local identity evidence; no page or provider API reads.
use super::import_state::ImportState;
use crate::{string, Value};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgAccount {
    pub account_id: String,
    pub org_ids: Vec<String>,
}
/// Only confirmed handshake evidence, or its unchanged cached profile, supplies org IDs.
pub fn org_accounts(accounts: &[Value], profiles: &[Value]) -> Vec<OrgAccount> {
    accounts
        .iter()
        .filter(|a| {
            a["provider"] == "anthropic"
                && a["removedAt"].is_null()
                && a["sources"].as_array().is_some_and(|s| !s.is_empty())
        })
        .map(|a| {
            let mut org_ids = Vec::new();
            for resolution in a["sourceIdentities"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.values())
            {
                let evidence = &resolution["evidence"];
                if resolution["state"] != "resolved"
                    || evidence["kind"] != "claude-session-handshake"
                {
                    continue;
                }
                let Some(key) = evidence["identityKey"]
                    .as_str()
                    .filter(|key| !key.is_empty())
                else {
                    continue;
                };
                let org = evidence["orgId"].as_str().or_else(|| {
                    profiles
                        .iter()
                        .find(|p| {
                            p["profileId"] == evidence["profileId"]
                                && crate::accounts::identity_key("anthropic", &p["identity"])
                                    .as_deref()
                                    == Some(key)
                        })
                        .and_then(|p| p["identity"]["orgId"].as_str())
                });
                if let Some(org) = org
                    .and_then(|org| uuid::Uuid::parse_str(org).ok())
                    .map(|org| org.to_string())
                {
                    if !org_ids.contains(&org) {
                        org_ids.push(org);
                    }
                }
            }
            OrgAccount {
                account_id: string(a, "id").into(),
                org_ids,
            }
        })
        .collect()
}
/// None permits installation. All returned states stop before any native cookie write.
pub fn import_guard(
    account: &str,
    org: Option<uuid::Uuid>,
    known: &[OrgAccount],
    allow_unverified: bool,
) -> Option<ImportState> {
    if let Some(org) = org {
        let matches = |a: &OrgAccount| {
            a.org_ids
                .iter()
                .any(|id| uuid::Uuid::parse_str(id).ok() == Some(org))
        };
        if known.iter().any(|a| a.account_id == account && matches(a)) {
            return None;
        }
        if let Some(other) = known.iter().find(|a| a.account_id != account && matches(a)) {
            return Some(ImportState::mismatch(other.account_id.clone()));
        }
    }
    (!allow_unverified).then(ImportState::unverified)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn imported_org_must_match_the_selected_source_account() {
        // Regression: a Chrome profile for another Claude account was silently installed into the selected SRC.
        let org = uuid::Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap();
        let other = uuid::Uuid::parse_str("550e8400-e29b-41d4-a716-446655440001").unwrap();
        let accounts = vec![
            OrgAccount {
                account_id: "selected".into(),
                org_ids: vec![org.to_string()],
            },
            OrgAccount {
                account_id: "other".into(),
                org_ids: vec![other.to_string()],
            },
        ];
        assert!(import_guard("selected", Some(org), &accounts, false).is_none());
        for allow in [false, true] {
            let state = import_guard("selected", Some(other), &accounts, allow).unwrap();
            assert_eq!(state.status, "import-mismatch");
            assert_eq!(state.detected_account_id.as_deref(), Some("other"));
        }
        for org in [None, Some(uuid::Uuid::nil())] {
            assert_eq!(
                import_guard("selected", org, &accounts, false)
                    .unwrap()
                    .status,
                "import-unverified"
            );
            assert!(import_guard("selected", org, &accounts, true).is_none());
        }
    }
    #[test]
    fn cached_org_is_read_only_from_the_profile_pinned_by_a_confirmed_handshake() {
        // Regression: handshake snapshots omitted orgId even though the pinned ARC profile retained it.
        let facts =
            json!({"accountId":"identity-one","orgId":"550e8400-e29b-41d4-a716-446655440000"});
        let accounts = vec![
            json!({"id":"selected","provider":"anthropic","sources":["source"],"sourceIdentities":{"source":{"state":"resolved","evidence":{"kind":"claude-session-handshake","profileId":"profile","identityKey":"anthropic:id:identity-one"}}}}),
        ];
        let known = org_accounts(
            &accounts,
            &[json!({"profileId":"profile","identity":facts})],
        );
        assert_eq!(known[0].org_ids.len(), 1);
        let changed = org_accounts(
            &accounts,
            &[
                json!({"profileId":"profile","identity":{"accountId":"identity-two","orgId":"550e8400-e29b-41d4-a716-446655440001"}}),
            ],
        );
        assert!(changed[0].org_ids.is_empty());
    }
}
