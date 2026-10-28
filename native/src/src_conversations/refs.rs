use serde_json::{json, Value};
use url::Url;

pub fn allowed(raw: &str) -> bool {
    Url::parse(raw).is_ok_and(|u| {
        u.scheme() == "https"
            && u.host_str() == Some("claude.ai")
            && u.port_or_known_default() == Some(443)
            && u.username().is_empty()
            && u.password().is_none()
    })
}

pub fn expired(raw: &str) -> bool {
    Url::parse(raw).is_ok_and(|u| {
        allowed(raw)
            && matches!(
                u.path().split('/').nth(1),
                Some("login" | "signin" | "sign-in" | "sign_in" | "auth")
            )
    })
}

pub fn conversation(raw: &str) -> Option<Value> {
    if !allowed(raw) {
        return None;
    }
    let u = Url::parse(raw).ok()?;
    let parts: Vec<_> = u.path().trim_end_matches('/').split('/').collect();
    match parts.as_slice() {
        ["", "chat", id] => uuid::Uuid::parse_str(id).ok().map(|id| {
            json!({"kind":"chat","id":id.to_string(),"url":format!("https://claude.ai/chat/{id}")})
        }),
        ["", "cowork", id]
            if id
                .strip_prefix("cse_")
                .is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_alphanumeric())) =>
        {
            Some(json!({"kind":"cowork", "id":id,
                "url":format!("https://claude.ai/cowork/{id}")}))
        }
        _ => None,
    }
}

pub fn notify_target(target: &str) -> Option<Value> {
    let suffix = target.strip_prefix("session_")?;
    if suffix.len() != 24 || !suffix.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    conversation(&format!("https://claude.ai/cowork/cse_{suffix}"))
}
pub fn open_url(raw: &str) -> Option<String> {
    let u = Url::parse(raw).ok()?;
    if !allowed(raw) || u.query().is_some() || u.fragment().is_some() {
        return None;
    }
    if u.path() == "/new" {
        return Some("https://claude.ai/new".into());
    }
    conversation(raw).map(|r| r["url"].as_str().unwrap().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_refs_remove_non_identity_url_data() {
        // Property: Parsed conversation identities contain only the allowed origin and canonical path.
        let base = "https://claude.ai/chat/550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(
            conversation(&format!("{base}?example=discard#discard")).unwrap()["url"],
            base
        );
        for raw in [
            "http://claude.ai/new",
            "https://claude.ai.example/new",
            "https://user:pass@claude.ai/new",
            "https://claude.ai:444/new",
            "https://claude.ai/chat/invalid",
        ] {
            assert!(open_url(raw).is_none());
        }
        assert!(open_url(&format!("{base}?example=discard")).is_none());
        assert!(expired("https://claude.ai/login?example=discard"));
        assert!(!expired("https://claude.ai/login-other"));
        assert_eq!(
            notify_target("session_010000000000000000000001").unwrap()["id"],
            "cse_010000000000000000000001"
        );
        assert!(notify_target("session_incomplete").is_none());
    }
}
