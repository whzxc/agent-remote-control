//! Durable, ingress-scoped aliases for one native interaction, not credentials.
use crate::*;
const TTL: i64 = 24 * 60 * 60;
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn directory() -> PathBuf {
    root().join("respond-tokens")
}
fn identity(ingress: &str, request: &Value) -> String {
    hash(
        json!([
            ingress,
            request["owner"],
            request["id"],
            if request["owner"] == "desktop" {
                Value::Null
            } else {
                request["backendSession"].clone()
            }
        ])
        .to_string(),
    )
}
fn issue_in(dir: &Path, ingress: &str, request: &mut Value, at: i64) -> Result<()> {
    if request["canRespond"] == false
        || request["backendSession"].is_null()
        || request["id"].is_null()
    {
        return Ok(());
    }
    let path = dir.join(format!("{}.json", identity(ingress, request)));
    let mut record = load(&path).unwrap_or(Value::Null);
    if record["expiresAt"].as_i64().unwrap_or(0) <= at {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        record = json!({"token":URL_SAFE_NO_PAD.encode(uuid::Uuid::new_v4().as_bytes()),"expiresAt":at+TTL,"ingress":ingress,"request":request});
        save(&path, &record)?;
    }
    if record["used"] != true {
        request["respondToken"] = record["token"].clone();
        request["respondTokenExpiresAt"] = record["expiresAt"].clone();
    }
    Ok(())
}
pub(crate) fn issue(ingress: &str, request: &mut Value) -> Result<()> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    issue_in(
        &directory(),
        ingress,
        request,
        chrono::Utc::now().timestamp(),
    )
}
fn resolve_in(
    dir: &Path,
    ingress: &str,
    token: &str,
    thread: Option<&str>,
    at: i64,
) -> Result<(PathBuf, Value)> {
    if token.len() != 22
        || !token
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("RESPOND_TOKEN_INVALID_OR_EXPIRED".into());
    }
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let record = load(&entry.path())?;
        if record["token"] != token {
            continue;
        }
        if record["ingress"] != ingress {
            return Err("RESPOND_TOKEN_SCOPE_MISMATCH".into());
        }
        if record["used"] == true || record["expiresAt"].as_i64().unwrap_or(0) <= at {
            return Err("RESPOND_TOKEN_EXPIRED_OR_RESOLVED".into());
        }
        let request = &record["request"];
        if thread.is_some_and(|t| request["params"]["threadId"] != t) {
            return Err("RESPOND_TOKEN_SCOPE_MISMATCH".into());
        }
        return Ok((entry.path(), record));
    }
    Err("RESPOND_TOKEN_INVALID_OR_EXPIRED".into())
}
pub(crate) fn resolve(args: &Value) -> Result<Value> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let origin = crate::kernel::origin::current_origin();
    let (_, record) = resolve_in(
        &directory(),
        string(&origin, "ingressId"),
        string(args, "respondToken"),
        args["threadId"].as_str(),
        chrono::Utc::now().timestamp(),
    )?;
    Ok(record["request"].clone())
}
pub(crate) fn consume(args: &Value) -> Result<()> {
    if args["respondToken"].is_null() {
        return Ok(());
    }
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let origin = crate::kernel::origin::current_origin();
    let (path, mut record) = resolve_in(
        &directory(),
        string(&origin, "ingressId"),
        string(args, "respondToken"),
        args["threadId"].as_str(),
        0,
    )?;
    record["used"] = json!(true);
    save(&path, &record)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tokens_survive_session_changes_but_reject_wrong_scope_expiry_and_reuse() {
        let dir = std::env::temp_dir().join(format!("arc-token-test-{}", id()));
        let mut request = json!({"owner":"desktop","id":"[desktop,thread,turn,question]","backendSession":"old","params":{"threadId":"thread","turnId":"turn"}});
        issue_in(&dir, "ingress", &mut request, 100).unwrap();
        let token = string(&request, "respondToken").to_owned();
        assert_eq!(token.len(), 22);
        request["backendSession"] = json!("new");
        issue_in(&dir, "ingress", &mut request, 101).unwrap();
        assert_eq!(request["respondToken"], token);
        assert!(resolve_in(&dir, "other", &token, None, 101).is_err());
        assert!(resolve_in(&dir, "ingress", &token, Some("other-thread"), 101).is_err());
        let (path, mut r) = resolve_in(&dir, "ingress", &token, Some("thread"), 101).unwrap();
        assert_eq!(r["request"]["backendSession"], "old");
        assert!(resolve_in(&dir, "ingress", &token, None, 100 + TTL).is_err());
        r["used"] = json!(true);
        save(&path, &r).unwrap();
        assert!(resolve_in(&dir, "ingress", &token, None, 101).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
