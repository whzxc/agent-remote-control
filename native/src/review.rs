//! Outcome-only projection of recorded native turns. No command output is exposed.
use crate::*;
use std::collections::BTreeMap;
use std::sync::OnceLock;

fn checks() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(||regex::Regex::new(r"^\s*(?:rtk\s+)?(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|type-check|build)[\w:-]*|cargo\s+(?:test|check|clippy|fmt)|node\s+--test[\w=-]*|(?:npx\s+)?(?:tsc|eslint|vitest|jest)|(?:python3?\s+-m\s+)?(?:pytest|unittest)|go\s+test|dotnet\s+test|ctest)\b").unwrap())
}
// Preserve quoted arguments and redirections while recognizing shell clauses.
fn clauses(line: &str) -> Vec<&str> {
    let mut result = Vec::new();
    let mut start = 0;
    let mut quote = None;
    let mut escaped = false;
    for (offset, ch) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
        } else if Some(ch) == quote {
            quote = None;
        } else if quote.is_none() {
            if matches!(ch, '\'' | '"' | '`') {
                quote = Some(ch);
            } else if matches!(ch, ';' | '|')
                || (ch == '&'
                    && (line[offset..].starts_with("&&")
                        || (offset > 0 && line.as_bytes()[offset - 1] == b'&')))
            {
                result.push(line[start..offset].trim());
                start = offset + ch.len_utf8();
            }
        }
    }
    result.push(line[start..].trim());
    result
}
fn check_command(item: &Value) -> Option<String> {
    static HEREDOC: OnceLock<regex::Regex> = OnceLock::new();
    let heredoc = HEREDOC
        .get_or_init(|| regex::Regex::new(r#"<<-?\s*['"]?([A-Za-z_][A-Za-z_0-9]*)['"]?"#).unwrap());
    let actions: Vec<_> = item["commandActions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a["command"].as_str())
        .collect();
    let scripts = if actions.is_empty() {
        vec![string(item, "command")]
    } else {
        actions
    };
    let mut commands = Vec::new();
    for script in scripts {
        let mut delimiters = std::collections::VecDeque::<String>::new();
        for line in script.lines() {
            if let Some(delimiter) = delimiters.front() {
                if line.trim() == delimiter {
                    delimiters.pop_front();
                }
                continue;
            }
            // Native commandActions removes the shell wrapper. The fallback also
            // recognizes common wrappers when older native records omit actions.
            let line = line
                .trim()
                .strip_prefix("/bin/zsh -lc \"")
                .or_else(|| line.trim().strip_prefix("/bin/sh -lc \""))
                .unwrap_or(line);
            for command in clauses(line) {
                if checks().is_match(command) {
                    commands.push(command.to_owned());
                }
            }
            delimiters.extend(heredoc.captures_iter(line).map(|c| c[1].to_owned()));
        }
    }
    (!commands.is_empty()).then(|| commands.join("; "))
}
fn check_summary(item: &Value) -> String {
    let output = string(item, "aggregatedOutput");
    let lines: Vec<_> = output
        .lines()
        .map(str::trim)
        .filter(|line| {
            let line = line.trim_start_matches('ℹ').trim();
            line.starts_with("test result:")
                || line.starts_with("Test policy ")
                || [
                    "tests ",
                    "pass ",
                    "fail ",
                    "cancelled ",
                    "skipped ",
                    "todo ",
                ]
                .iter()
                .any(|p| {
                    line.strip_prefix(p)
                        .is_some_and(|n| n.starts_with(|c: char| c.is_ascii_digit()))
                })
        })
        .collect();
    if !lines.is_empty() {
        return lines.join("; ").chars().take(240).collect();
    }
    match item["exitCode"].as_i64() {
        Some(code) => format!("Process exited with code {code}; no test summary captured."),
        None => format!("Native command status: {}.", string(item, "status")),
    }
}
pub(crate) fn native_files(items: &[Value]) -> Value {
    if !items.iter().any(|i| i["type"] == "fileChange") {
        return Value::Null;
    }
    let mut files = BTreeMap::<String, (u64, u64, bool)>::new();
    for item in items.iter().filter(|i| {
        i["type"] == "fileChange" && i["status"] != "failed" && i["status"] != "declined"
    }) {
        for change in item["changes"].as_array().into_iter().flatten() {
            let Some(path) = change["path"].as_str() else {
                continue;
            };
            let counts = files.entry(path.into()).or_default();
            let mut hunk = false;
            let mut known = false;
            for line in string(change, "diff").lines() {
                if line.starts_with("@@ ") {
                    hunk = true;
                    known = true;
                } else if line.starts_with("diff --git ") {
                    hunk = false;
                } else if hunk && line.starts_with('+') {
                    counts.0 += 1;
                } else if hunk && line.starts_with('-') {
                    counts.1 += 1;
                }
            }
            counts.2 |= !known;
        }
    }
    json!(files
        .into_iter()
        .map(|(path, (added, removed, unknown))| json!({"path":path,"added":if unknown{None}else{Some(added)},"removed":if unknown{None}else{Some(removed)}}))
        .collect::<Vec<_>>())
}
pub(crate) async fn turn(_c: &control::Control, thread: &str, turn: &Value) -> Value {
    let items = turn["items"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let message = items
        .iter()
        .rev()
        .find(|i| i["type"] == "agentMessage" && i["phase"] != "commentary")
        .and_then(|i| i["text"].as_str());
    let evidence = crate::changes::review_evidence(thread, turn).await;
    let checks: Vec<_> = items
        .iter()
        .filter(|i| i["type"] == "commandExecution")
        .filter_map(|i| {
            let command = check_command(i)?;
            Some(json!({"command":command,"exitCode":i["exitCode"],"summary":check_summary(i)}))
        })
        .collect();
    let mut out = json!({"turnId":turn["id"],"recordedStatus":turn["status"],"finalResponse":message,"checks":checks});
    for key in ["files", "changeEvidence", "attribution", "reason", "next"] {
        if let Some(value) = evidence.get(key) {
            out[key] = value.clone();
        }
    }
    out
}

/// Compact native evidence for revisits; command exit codes retain their batch semantics.
pub fn progress_from_turn(turn: &Value, pending_count: Option<usize>) -> Value {
    let items = turn["items"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let message = items
        .iter()
        .rev()
        .find(|i| i["type"] == "agentMessage")
        .and_then(|i| i["text"].as_str());
    let mut checks: Vec<_> = items.iter().rev()
        .filter(|i| i["type"] == "commandExecution")
        .filter_map(|i| Some(json!({"command":check_command(i)?.chars().take(240).collect::<String>(),"exitCode":i["exitCode"],"status":i["status"],"summary":check_summary(i)})))
        .take(3).collect();
    checks.reverse();
    json!({"turnId":turn["id"],"latestAgentMessage":message.map(|s|s.chars().take(480).collect::<String>()),
        "messageTruncated":message.is_some_and(|s|s.chars().count()>480),"latestChecks":checks,
        "pendingInteractionCount":pending_count,"commits":null,"elapsedMs":null,"observedAt":now()})
}

pub(crate) async fn progress(c: &control::Control, thread: &str, metadata: &Value) -> Value {
    let read = c.request(
        "thread/turns/list",
        json!({"threadId":thread,"limit":1,"sortDirection":"desc","itemsView":"full"}),
        2000,
    );
    let mut result = match tokio::time::timeout(std::time::Duration::from_secs(2), read).await {
        Ok(Ok(page)) => {
            let events = c.events.lock().await;
            let turn = &page["data"][0];
            let pending: Vec<_> = events
                .pending
                .values()
                .filter(|r| r["params"]["threadId"] == thread)
                .cloned()
                .collect();
            let mut native = metadata.clone();
            native["turns"] = json!([turn]);
            let snapshot =
                crate::waiter::classify(&json!({"thread":native,"pending":pending}), &mut None);
            let mut progress = progress_from_turn(
                turn,
                snapshot["progress"]["pendingInteractionCount"]
                    .as_u64()
                    .map(|n| n as usize),
            );
            progress["pendingInteractions"] = snapshot["progress"]["pendingInteractions"].clone();
            progress["status"] = json!({"state":snapshot["state"],"reason":snapshot["reason"],"turnId":snapshot["turnId"],"recordedStatus":snapshot["recordedStatus"],"runtimeStatus":snapshot["runtimeStatus"]});
            progress
        }
        _ => {
            json!({"turnId":null,"latestAgentMessage":null,"latestChecks":[],"pendingInteractionCount":null,"commits":null,"elapsedMs":null,"observedAt":now(),"unavailable":"native-progress-read-timeout-or-unavailable"})
        }
    };
    enrich_progress(thread, &mut result).await;
    result
}

pub(crate) async fn enrich_progress(thread: &str, progress: &mut Value) {
    let turn = string(progress, "turnId").to_owned();
    let evidence = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        crate::changes::progress(thread, &turn),
    )
    .await;
    match evidence {
        Ok(evidence) => {
            progress["commits"] = evidence["commits"].clone();
            progress["elapsedMs"] = evidence["elapsedMs"].clone();
            progress["baseline"] = evidence["baseline"].clone();
            if let Some(reason) = evidence.get("unavailable") {
                progress["gitUnavailable"] = reason.clone();
            }
        }
        Err(_) => progress["gitUnavailable"] = json!("git-progress-timeout"),
    }
}

/// Pin explicit reads without assuming that the turn is on the newest page.
pub(crate) async fn turn_page(c: &control::Control, args: &Value) -> Result<Value> {
    let selected = args["turnId"].as_str();
    let mut cursor = args["cursor"].clone();
    loop {
        let page = c.request("thread/turns/list", json!({"threadId":args["threadId"],"cursor":cursor,
            "limit":if selected.is_some(){100}else{num(args,"limit",1)},"sortDirection":"desc","itemsView":"full"}),60000).await?;
        let Some(selected) = selected else {
            return Ok(page);
        };
        if let Some(turn) = page["data"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|t| t["id"] == selected)
        {
            return Ok(json!({"data":[turn],"nextCursor":null}));
        }
        let next = page["nextCursor"].clone();
        if next.is_null() {
            return Err(
                "TURN_NOT_FOUND: read codex_read without turnId to discover current turns".into(),
            );
        }
        if next == cursor {
            return Err("NATIVE_CURSOR_REPEATED: cannot resolve the requested turn".into());
        }
        cursor = next;
    }
}
