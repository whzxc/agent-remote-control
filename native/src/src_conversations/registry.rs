//! Pure account-scoped identity resolution for observed conversations and session aliases.
use crate::{json, string, Value};
use std::collections::BTreeMap;

pub fn resolve(conversations: &[Value], account: &str, id: &str) -> Option<Value> {
    conversations
        .iter()
        .find(|r| {
            r["accountId"] == account
                && (r["id"] == id
                    || r["aliases"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|a| a == id)))
        })
        .cloned()
}

/// Only a new confirmed handshake may infer an alias; inventory reads never correlate history.
pub fn verified_target(
    conversations: &mut Vec<Value>,
    bindings: &mut BTreeMap<String, Value>,
    account: &str,
    reference: &Value,
    at: &str,
) {
    let alias = string(reference, "id");
    if resolve(conversations, account, alias).is_some_and(|r| r["kind"] == "chat") {
        return;
    }
    let Some(handshake) = timestamp(at) else {
        return;
    };
    let candidates: Vec<_> = conversations
        .iter()
        .filter(|r| {
            r["accountId"] == account
                && r["kind"] == "chat"
                && timestamp(string(r, "lastActiveAt")).is_some_and(|active| {
                    (0..=super::CORRELATION_SECONDS * 1000).contains(&(handshake - active))
                })
        })
        .cloned()
        .collect();
    let [chat] = candidates.as_slice() else {
        return;
    };
    let mut chat = chat.clone();
    let mut aliases = chat["aliases"].as_array().cloned().unwrap_or_default();
    aliases.push(json!(alias));
    for cowork in conversations
        .iter()
        .filter(|r| r["accountId"] == account && r["kind"] == "cowork" && r["id"] == alias)
    {
        for key in ["firstSeenAt", "lastSeenAt", "lastActiveAt"] {
            if let Some(time) = timestamp(string(cowork, key)) {
                let previous = timestamp(string(&chat, key));
                if previous.is_none_or(|old| {
                    if key == "firstSeenAt" {
                        time < old
                    } else {
                        time > old
                    }
                }) {
                    chat[key] = cowork[key].clone();
                }
            }
        }
    }
    aliases.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    aliases.dedup();
    chat["aliases"] = json!(aliases);
    for binding in bindings
        .values_mut()
        .filter(|b| b["accountId"] == account && b["kind"] == "cowork" && b["id"] == alias)
    {
        for key in ["kind", "id", "url"] {
            binding[key] = chat[key].clone();
        }
    }
    conversations
        .retain(|r| !(r["accountId"] == account && r["kind"] == "cowork" && r["id"] == alias));
    let index = conversations
        .iter()
        .position(|r| r["accountId"] == account && r["id"] == chat["id"])
        .unwrap();
    conversations[index] = chat;
}

fn timestamp(at: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(at)
        .ok()
        .map(|t| t.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    const AT: &str = "2026-01-01T12:00:00.000Z";
    fn chat(id: &str, account: &str, active: Value) -> Value {
        json!({"accountId":account,"kind":"chat","id":id,"url":format!("https://claude.ai/chat/{id}"),"basis":"observed","firstSeenAt":AT,"lastSeenAt":AT,"lastActiveAt":active})
    }
    fn target() -> Value {
        super::super::refs::notify_target("session_010000000000000000000001").unwrap()
    }
    #[test]
    fn single_active_chat_keeps_canonical_identity_and_accumulates_aliases() {
        // Regression: AX ax-8b883850 created a separate Cowork record for one active Chat.
        let original = chat("chat-one", "owner", json!(AT));
        let mut rows = vec![original.clone(), chat("peer", "other", json!(AT))];
        let mut bindings = BTreeMap::new();
        for suffix in ["010000000000000000000001", "010000000000000000000002"] {
            let reference =
                super::super::refs::notify_target(&format!("session_{suffix}")).unwrap();
            verified_target(&mut rows, &mut bindings, "owner", &reference, AT);
            let resolved = resolve(&rows, "owner", string(&reference, "id")).unwrap();
            for key in ["id", "kind", "url", "basis"] {
                assert_eq!(resolved[key], original[key]);
            }
            assert!(resolve(&rows, "other", string(&reference, "id")).is_none());
        }
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["aliases"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn zero_or_multiple_recent_chats_do_not_infer_an_alias() {
        // Regression: ambiguous or missing active Chat evidence must leave the session separate.
        for mut rows in [
            vec![],
            vec![
                chat("one", "owner", json!(AT)),
                chat("two", "owner", json!(AT)),
            ],
            vec![
                chat("stale", "owner", json!("2026-01-01T11:49:59Z")),
                chat("inactive", "owner", Value::Null),
                chat("peer", "other", json!(AT)),
            ],
            vec![chat("future", "owner", json!("2026-01-01T12:00:01Z"))],
        ] {
            let before = rows.clone();
            verified_target(&mut rows, &mut BTreeMap::new(), "owner", &target(), AT);
            assert_eq!(rows, before);
        }
    }
    #[test]
    fn existing_cowork_merges_bindings_and_earliest_observation_only_for_this_session() {
        // Regression: pre-existing session records split taskRefs and lost earlier observation times.
        let mut cowork = target();
        cowork["accountId"] = json!("owner");
        cowork["firstSeenAt"] = json!("2025-12-01T00:00:00Z");
        cowork["lastSeenAt"] = json!(AT);
        let historical = json!({"accountId":"owner","kind":"cowork","id":"cse_historical","firstSeenAt":cowork["firstSeenAt"],"lastActiveAt":null});
        let mut rows = vec![
            cowork.clone(),
            chat("one", "owner", json!("2026-01-01T11:50:00Z")),
            historical.clone(),
        ];
        let mut bindings = BTreeMap::from([
            (
                "codex:one".into(),
                json!({"accountId":"owner","kind":"chat","id":"one","basis":"correlated"}),
            ),
            (
                "codex:two".into(),
                json!({"accountId":"owner","kind":"cowork","id":cowork["id"],"basis":"notify-target"}),
            ),
            (
                "agent:three".into(),
                json!({"accountId":"owner","kind":"cowork","id":cowork["id"],"basis":"manual"}),
            ),
        ]);
        verified_target(&mut rows, &mut bindings, "owner", &target(), AT);
        assert_eq!(rows.len(), 2);
        assert_eq!(
            resolve(&rows, "owner", "one").unwrap()["firstSeenAt"],
            cowork["firstSeenAt"]
        );
        assert!(rows.contains(&historical));
        assert!(bindings.values().all(|r| r["id"] == "one"));
        assert_eq!(bindings["codex:two"]["basis"], "notify-target");
        assert_eq!(bindings["agent:three"]["basis"], "manual");
    }
    #[test]
    fn persisted_alias_is_stable_after_new_chat_activity() {
        // Regression: rereading a verified target must not retarget a persisted alias to later activity.
        let mut rows = vec![chat("one", "owner", json!(AT))];
        let mut bindings = BTreeMap::new();
        verified_target(&mut rows, &mut bindings, "owner", &target(), AT);
        rows = serde_json::from_str(&serde_json::to_string(&rows).unwrap()).unwrap();
        rows.push(chat("two", "owner", json!("2026-01-01T13:00:00Z")));
        verified_target(
            &mut rows,
            &mut bindings,
            "owner",
            &target(),
            "2026-01-01T13:00:00Z",
        );
        assert_eq!(
            resolve(&rows, "owner", string(&target(), "id")).unwrap()["id"],
            "one"
        );
    }
}
