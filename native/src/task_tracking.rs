//! Bounded, protocol-independent task observations. Native events remain authoritative.
use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[cfg(test)]
mod projection_tests;
mod transcript_input;
mod transcripts;
pub(crate) use transcript_input::transcript_user_text;
pub(crate) use transcripts::TranscriptTitle;

const MAX_ENTRIES: usize = 2000;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_TEXT: usize = 256 * 1024;
const SUMMARY: usize = 1024;

pub(crate) fn file_change(change: &Value) -> Value {
    let mut row = json!({"path":cut(&redact(string(change,"path")),SUMMARY).0,
        "operation":match string(&change["kind"],"type") {"add"=>Some("create"),"update"=>Some("edit"),"delete"=>Some("delete"),_=>None}});
    if let Some(diff) = change["diff"].as_str().filter(|diff| !diff.is_empty()) {
        row["diff"] = summary(&json!(diff));
        let (mut hunk, mut known, mut added, mut removed) = (false, false, 0u64, 0u64);
        for line in diff.lines() {
            if line.starts_with("@@ ") {
                hunk = true;
                known = true;
            } else if line.starts_with("diff --git ") {
                hunk = false;
            } else if hunk && line.starts_with('+') {
                added += 1;
            } else if hunk && line.starts_with('-') {
                removed += 1;
            }
        }
        if known {
            row["added"] = json!(added);
            row["removed"] = json!(removed);
        }
    }
    row
}

pub(crate) fn redact(text: &str) -> String {
    use std::sync::OnceLock;
    static PATTERNS: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| [
        r"(?is)-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----.*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|\z)",
        r"(?i)\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+",
        r"\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b",
        r#"(?i)(?:[A-Z0-9_]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|cookie)[A-Z0-9_]*|token)\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)"#,
        r"(?i)https?://[^\s/@:]+:[^\s/@]+@",
    ].into_iter().map(|p| regex::Regex::new(p).unwrap()).collect());
    patterns.iter().fold(text.to_owned(), |s, re| {
        re.replace_all(&s, "[REDACTED]").into_owned()
    })
}
fn secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace(['-', '_'], "");
    [
        "password",
        "passwd",
        "secret",
        "token",
        "apikey",
        "authorization",
        "cookie",
        "privatekey",
        "credential",
    ]
    .iter()
    .any(|part| key.contains(part))
}
fn sanitize(value: &Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        if secret_key(k) {
                            json!("[REDACTED]")
                        } else {
                            sanitize(v)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(rows) => Value::Array(rows.iter().map(sanitize).collect()),
        Value::String(s) => json!(redact(s)),
        _ => value.clone(),
    }
}
fn cut(text: &str, limit: usize) -> (String, bool) {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), end < text.len())
}
pub(crate) fn transcript_text(text: &str) -> String {
    use std::sync::OnceLock;
    static BLOCKS: OnceLock<regex::Regex> = OnceLock::new();
    static TAGS: OnceLock<regex::Regex> = OnceLock::new();
    let text = text.trim();
    if text.starts_with("# AGENTS.md instructions") || text.starts_with("<INSTRUCTIONS>") {
        return String::new();
    }
    let blocks = BLOCKS.get_or_init(|| regex::Regex::new(
        r"(?is)<(?:system-reminder|system_reminder|environment_context|environment_details|image_resize_notice|total_tokens|token_budget|instructions|INSTRUCTIONS|app-context|permissions instructions|collaboration_mode|skills_instructions)(?:\s[^>]*)?>.*?(?:</(?:system-reminder|system_reminder|environment_context|environment_details|image_resize_notice|total_tokens|token_budget|instructions|INSTRUCTIONS|app-context|permissions instructions|collaboration_mode|skills_instructions)>|\z)"
    ).unwrap());
    let tags = TAGS.get_or_init(|| regex::Regex::new(r"^\s*(?:</?[A-Za-z_][^>]*>\s*)+$").unwrap());
    blocks
        .replace_all(text, "")
        .lines()
        .filter(|line| !tags.is_match(line))
        .collect::<Vec<_>>()
        .join("\n")
}
fn plain_headline(text: &str) -> String {
    use std::sync::OnceLock;
    static RULES: OnceLock<Vec<(regex::Regex, &'static str)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        [
            (r"!?\[([^]\n]+)\]\([^\n)]*(?:\([^\n)]*\)[^\n)]*)*\)", "$1"),
            (r"!?\[([^]\n]+)\]\[[^]\n]*\]", "$1"),
            (r"<((?:https?://|mailto:)[^>\s]+)>", "$1"),
            (r"(?m)^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|[0-9]+[.)]\s+)", ""),
            (r"(?m)\s+#+\s*$", ""),
            (r"\*\*|__|~~|`+", ""),
            (r"\*([^*\s][^*\n]*?)\*", "$1"),
            (
                r"(^|[\s(])_([^_\s][^_\n]*?)_($|[\s).,!?:;。！？])",
                "$1$2$3",
            ),
            (r"(?m)^\s*[*_]([^\s])", "$1"),
        ]
        .into_iter()
        .map(|(pattern, replacement)| (regex::Regex::new(pattern).unwrap(), replacement))
        .collect()
    });
    rules
        .iter()
        .fold(text.to_owned(), |text, (pattern, replacement)| {
            pattern.replace_all(&text, *replacement).into_owned()
        })
}
pub(crate) fn headline(kind: &str, text: &str) -> String {
    // Commands and paths are literal data, including underscores and shell syntax.
    let plain = if matches!(kind, "text" | "thinking") {
        plain_headline(text)
    } else {
        text.to_owned()
    };
    let text = plain.trim();
    let line = if kind == "text" {
        let punctuation = ['.', '!', '?', '。', '！', '？'];
        let prefix = text.trim_end_matches(punctuation);
        let start = prefix
            .char_indices()
            .rev()
            .find(|(i, c)| {
                *c == '\n'
                    || (punctuation.contains(c)
                        && (*c != '.'
                            || prefix[i + c.len_utf8()..].starts_with(char::is_whitespace)))
            })
            .map_or(0, |(i, c)| i + c.len_utf8());
        text[start..].trim()
    } else {
        text.lines()
            .rev()
            .find(|s| !s.trim().is_empty())
            .unwrap_or("")
    };
    cut(&redact(line), SUMMARY).0
}
fn summary(value: &Value) -> Value {
    let value = sanitize(value);
    crate::context::excerpt(value.as_str().unwrap_or(&value.to_string()))
}
fn content(value: &Value) -> String {
    if let Some(s) = value.as_str() {
        return s.into();
    }
    if let Some(rows) = value.as_array() {
        return rows
            .iter()
            .map(content)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
    }
    for key in ["text", "thinking", "content", "output", "summary"] {
        if !value[key].is_null() {
            return content(&value[key]);
        }
    }
    String::new()
}
fn exit_code(raw: &Value, output: &str) -> Option<i64> {
    for key in ["exitCode", "exit_code"] {
        if let Some(n) = raw[key].as_i64() {
            return Some(n);
        }
        if let Some(n) = raw["details"][key].as_i64() {
            return Some(n);
        }
    }
    // Only explicit, whole-line producer markers; never infer success from output or status.
    output.lines().rev().find_map(|line| {
        [
            "Process exited with code ",
            "Exit code: ",
            "exit code: ",
            "Exit Code: ",
        ]
        .iter()
        .find_map(|prefix| line.trim().strip_prefix(prefix)?.trim().parse::<i64>().ok())
    })
}
fn tool_kind(kind: &str, name: &str, input: &Value) -> (&'static str, Option<&'static str>) {
    match kind {
        "execute" => return ("command", None),
        "read" | "search" => return ("file", Some("read")),
        "edit" => return ("file", Some("edit")),
        "delete" | "move" => return ("file", None),
        "" | "other" => (),
        _ => return ("tool", None),
    }
    let name = name.to_ascii_lowercase();
    let leaf = name.rsplit(['/', '.', ':']).next().unwrap_or(&name);
    let leaf = leaf.rsplit("__").next().unwrap_or(leaf);
    if input["command"].is_string()
        || input["cmd"].is_string()
        || matches!(
            leaf,
            "bash" | "shell" | "exec_command" | "run_command" | "terminal"
        )
    {
        return ("command", None);
    }
    let operation = match leaf {
        "read" | "read_file" | "readfile" | "cat" | "glob" | "grep" => Some("read"),
        "write" | "write_file" | "writefile" => Some("write"),
        "create" | "create_file" => Some("create"),
        "edit" | "edit_file" | "editfile" | "apply_patch" | "str_replace" | "multiedit" => {
            Some("edit")
        }
        _ => None,
    };
    if operation.is_some() || input["file_path"].is_string() {
        ("file", operation)
    } else {
        ("tool", None)
    }
}

fn parsed_input(input: &Value) -> Value {
    input
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| input.clone())
}

fn normalize_tool_input(row: &mut Value, input: &Value, locations: &Value) {
    let input = parsed_input(input);
    for (target, keys) in [
        ("command", &["command", "cmd"][..]),
        ("cwd", &["cwd", "workdir"][..]),
        ("path", &["file_path", "path", "filePath"][..]),
    ] {
        if let Some(value) = keys.iter().find_map(|key| input[*key].as_str()) {
            row[target] = json!(cut(&redact(value), SUMMARY).0);
        }
    }
    let mut paths = Vec::new();
    if let Some(path) = row["path"].as_str() {
        paths.push(path.to_owned());
    }
    for path in input["paths"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .chain(
            locations
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|location| location["path"].as_str()),
        )
    {
        let path = cut(&redact(path), SUMMARY).0;
        if !paths.contains(&path) && paths.len() < 100 {
            paths.push(path);
        }
    }
    if !paths.is_empty() {
        row["path"] = json!(paths[0]);
        row["paths"] = json!(paths);
    }
    let edits: Vec<_> = input["edits"]
        .as_array()
        .map(|edits| edits.iter().collect())
        .unwrap_or_else(|| vec![&input]);
    let edits: Vec<_> = edits
        .into_iter()
        .take(100)
        .filter_map(|edit| {
            let old = edit.get("old_string").or_else(|| edit.get("oldText"));
            let new = edit
                .get("new_string")
                .or_else(|| edit.get("newText"))
                .or_else(|| {
                    (row["operation"] == "write" || row["operation"] == "create")
                        .then(|| edit.get("content"))
                        .flatten()
                });
            if old.is_none() && new.is_none() {
                return None;
            }
            let mut value = json!({});
            if let Some(old) = old {
                value["oldText"] = summary(old);
            }
            if let Some(new) = new {
                value["newText"] = summary(new);
            }
            Some(value)
        })
        .collect();
    if !edits.is_empty() {
        row["edits"] = json!(edits);
    }
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Timeline {
    pub entries: Vec<Value>,
    pub revision: u64,
    bytes: usize,
    pub partial: bool,
    pub observed_events: u64,
    pub tool_observed: bool,
    pub omitted_sidechain_records: u64,
    #[serde(skip)]
    transcript_activity: Option<(String, u64)>,
    pub info: Value,
    pub status: String,
    pub turn: String,
    pub turn_dispatch_summaries: HashMap<String, Value>,
    pub turn_timings: HashMap<String, Value>,
    turn_statuses: HashMap<String, String>,
    turn_started_at: Option<String>,
    #[serde(skip)]
    turn_status_observations: HashMap<String, u64>,
    #[serde(skip)]
    pub history_loaded: bool,
    #[serde(skip)]
    pub observation_lost: bool,
    #[serde(skip)]
    chunk: Option<(String, String, String)>,
    pi_message: u64,
    pi_stop_reason: String,
    pi_error: Value,
    #[serde(skip)]
    buffers: HashMap<String, String>,
}
impl Timeline {
    fn notice(&mut self, id: Option<&str>, kind: &str, stage: &str, native: &Value, at: &str) {
        // A lifecycle fact is complete as an observation, even when it describes
        // a retry/compaction starting. It never settles or reopens the turn.
        self.end_chunk(at);
        let id = id
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{}:notice:{}", self.turn, self.revision + 1));
        let mut row = self.entry(&id, "notice", "completed");
        if native["turnId"].is_string() {
            row["turnId"] = native["turnId"].clone();
        }
        let mut notice = row.get("notice").cloned().unwrap_or(json!({}));
        notice["kind"] = json!(kind);
        notice["stage"] = json!(stage);
        for (key, values) in [
            ("attempt", vec![&native["attempt"]]),
            ("maxAttempts", vec![&native["maxAttempts"]]),
            (
                "message",
                vec![
                    &native["errorMessage"],
                    &native["finalError"],
                    &native["message"],
                    &native["error"]["message"],
                    &native["description"],
                ],
            ),
            ("title", vec![&native["title"]]),
            ("severity", vec![&native["severity"]]),
            ("nativeStatus", vec![&native["status"]]),
            ("trigger", vec![&native["trigger"], &native["reason"]]),
            (
                "tokensBefore",
                vec![
                    &native["preTokens"],
                    &native["tokensBefore"],
                    &native["result"]["tokensBefore"],
                ],
            ),
            (
                "tokensAfter",
                vec![&native["tokensAfter"], &native["result"]["tokensAfter"]],
            ),
            ("success", vec![&native["success"]]),
            ("aborted", vec![&native["aborted"]]),
        ] {
            if let Some(value) = values.into_iter().find(|value| !value.is_null()) {
                notice[key] = if let Some(text) = value.as_str() {
                    let (text, truncated) = cut(&redact(text), SUMMARY);
                    if truncated {
                        row["truncated"] = json!(true);
                    }
                    json!(text)
                } else {
                    value.clone()
                };
            }
        }
        row["notice"] = notice;
        self.put(row, at);
    }
    pub fn turn_status(&self, turn: &str) -> Option<&str> {
        self.turn_statuses
            .get(turn)
            .map(String::as_str)
            .or_else(|| (!turn.is_empty() && self.turn == turn).then_some(self.status.as_str()))
    }
    pub fn lose_observation(&mut self) {
        self.observation_lost = true;
        self.history_loaded = false;
        self.status = "unknown".into();
    }
    fn record_turn_status(&mut self) {
        if self.turn.is_empty() {
            return;
        }
        self.turn_status_observations
            .insert(self.turn.clone(), self.observed_events);
        let status = match self.status.as_str() {
            "running" | "inProgress" => "running",
            "completed" => "completed",
            "failed" => "failed",
            "cancelled" | "interrupted" => "cancelled",
            _ => {
                self.turn_statuses.remove(&self.turn);
                return;
            }
        };
        self.turn_statuses.insert(self.turn.clone(), status.into());
    }
    fn put(&mut self, mut row: Value, at: &str) {
        self.partial |= row["truncated"] == true;
        let index = self.entries.iter().position(|r| r["id"] == row["id"]);
        let old = index.map(|i| self.entries[i].clone()).unwrap_or(json!({}));
        row["startedAt"] = old.get("startedAt").cloned().unwrap_or(json!(at));
        row["updatedAt"] = json!(at);
        row["position"] = row
            .get("position")
            .cloned()
            .or_else(|| old.get("position").cloned())
            .unwrap_or_else(|| json!(index.map_or(self.revision + 1, |i| i as u64)));
        if !row["turnId"].is_string() {
            row["turnId"] = json!(self.turn);
        }
        if matches!(string(&row, "status"), "running" | "pending")
            && self
                .turn_statuses
                .get(string(&row, "turnId"))
                .is_some_and(|status| {
                    matches!(status.as_str(), "completed" | "failed" | "cancelled")
                })
        {
            row["status"] = json!(
                if matches!(string(&row, "type"), "text" | "thinking" | "user") {
                    "completed"
                } else {
                    "unknown"
                }
            );
        }
        if matches!(
            string(&row, "status"),
            "completed" | "failed" | "cancelled" | "unknown"
        ) {
            row["endedAt"] = old.get("endedAt").cloned().unwrap_or(json!(at));
        }
        // Repeated native snapshots must not advance cursors or phaseSince.
        let mut comparison = row.clone();
        comparison["updatedAt"] = old["updatedAt"].clone();
        comparison["cursor"] = old["cursor"].clone();
        if comparison == old {
            return;
        }
        if self.bytes == 0 && !self.entries.is_empty() {
            self.bytes = self.entries.iter().map(|r| r.to_string().len()).sum();
        }
        self.revision += 1;
        row["cursor"] = json!(self.revision);
        self.bytes += row.to_string().len();
        if let Some(i) = index {
            self.bytes = self.bytes.saturating_sub(self.entries[i].to_string().len());
            self.entries[i] = row;
        } else {
            self.entries.push(row);
        }
        while self.entries.len() > MAX_ENTRIES || self.bytes > MAX_BYTES {
            let removed = self.entries.remove(0);
            self.bytes = self.bytes.saturating_sub(removed.to_string().len());
            self.buffers.remove(string(&removed, "id"));
            self.partial = true;
        }
    }
    fn entry(&self, id: &str, kind: &str, status: &str) -> Value {
        let mut row = self
            .entries
            .iter()
            .find(|r| r["id"] == id)
            .cloned()
            .unwrap_or_else(|| json!({"id":id,"type":kind}));
        row["status"] = json!(status);
        row
    }
    fn end_chunk(&mut self, at: &str) {
        if let Some((id, _, _)) = self.chunk.take() {
            let row = self.entry(&id, "text", "completed");
            self.put(row, at);
        }
    }
    fn chunk(&mut self, kind: &str, delta: &str, at: &str) {
        if self.chunk.as_ref().is_some_and(|(_, k, _)| k != kind) {
            self.end_chunk(at);
        }
        let (id, _, text) = self.chunk.get_or_insert_with(|| {
            (
                format!("{}:chunk:{}", self.turn, self.revision + 1),
                kind.into(),
                String::new(),
            )
        });
        text.push_str(delta);
        let (bounded, truncated) = cut(text, MAX_TEXT);
        *text = bounded;
        let id = id.clone();
        let mut row = json!({"id":id,"type":kind,"status":"running","text":redact(text),"truncated":truncated});
        if self
            .entries
            .iter()
            .any(|r| r["id"] == id && r["truncated"] == true)
        {
            row["truncated"] = json!(true);
        }
        self.partial |= row["truncated"] == true;
        self.put(row, at);
    }
    fn start_turn(&mut self, at: &str) {
        if self.turn.is_empty() {
            return;
        }
        let timing = self
            .turn_timings
            .entry(self.turn.clone())
            .or_insert(json!({}));
        if !timing["startedAt"].is_string() {
            timing["startedAt"] = json!(at);
        }
        timing.as_object_mut().unwrap().remove("endedAt");
    }
    pub fn finish(&mut self, status: &str, at: &str) {
        // A lost observation or a late settlement cannot replace a known outcome.
        let terminal = self
            .turn_status(&self.turn)
            .filter(|status| matches!(*status, "completed" | "failed" | "cancelled"))
            .map(str::to_owned);
        let status = terminal.as_deref().unwrap_or(status);
        if !self.turn.is_empty() {
            let timing = self
                .turn_timings
                .entry(self.turn.clone())
                .or_insert(json!({}));
            if !timing["startedAt"].is_string() {
                timing["startedAt"] = json!(self.turn_started_at);
            }
            if !timing["endedAt"].is_string() {
                timing["endedAt"] = json!(at);
            }
        }
        self.end_chunk(at);
        self.status = status.into();
        self.record_turn_status();
        self.buffers.clear();
        let ids: Vec<_> = self
            .entries
            .iter()
            .filter(|r| {
                matches!(string(r, "status"), "running" | "pending") && r["turnId"] == self.turn
            })
            .map(|r| string(r, "id").to_owned())
            .collect();
        for id in ids {
            // A turn ending does not prove a tool succeeded.
            let row = self.entry(
                &id,
                "tool",
                if status == "cancelled" {
                    "cancelled"
                } else {
                    "unknown"
                },
            );
            self.put(row, at);
        }
    }
    pub fn resolve(&mut self, request: &Value, at: &str) {
        let id = format!("interaction:{request}");
        if self.entries.iter().any(|r| r["id"] == id) {
            let row = self.entry(&id, "interaction", "completed");
            self.put(row, at);
        }
    }
    pub fn answered(&mut self, request: &Value, response: &Value) {
        let params = &request["params"];
        let live_id = format!("interaction:{}", request["id"]);
        let id = if self
            .entries
            .iter()
            .any(|entry| entry["id"] == live_id && entry["turnId"] == params["turnId"])
        {
            live_id
        } else {
            format!(
                "interaction:history:{}",
                hash(
                    json!([request["backendSession"], params["turnId"], request["id"]]).to_string()
                )
            )
        };
        let mut row = self.entry(&id, "interaction", "completed");
        if row["interaction"].is_null() {
            row["interaction"] = json!({"kind":if string(request,"method").contains("Approval") {"permission"} else {"question"},"method":request["method"],"summary":params["question"].as_str().or_else(||params["title"].as_str()).or_else(||params["questions"][0]["question"].as_str()).or_else(||params["command"].as_str()).unwrap_or("Interaction"),"questions":params["questions"]});
        }
        row["turnId"] = params["turnId"].clone();
        row["response"] = response.clone();
        self.put(row, string(response, "resolvedAt"));
    }
    pub fn enrich_permission(&self, msg: &mut Value) {
        let call_id = msg["params"]["toolCallId"].clone();
        let call = &mut msg["params"]["toolCall"];
        if !call.is_object() {
            *call = json!({});
        }
        if call["toolCallId"].is_null() && !call_id.is_null() {
            call["toolCallId"] = call_id;
        }
        if let Some(row) = self.entries.iter().find(|r| r["id"] == call["toolCallId"]) {
            for key in ["command", "path", "title"] {
                if call.get(key).is_none_or(Value::is_null) && !row[key].is_null() {
                    call[key] = row[key].clone();
                }
            }
        }
    }
    pub fn agent(&mut self, method: &str, msg: &Value, at: &str) {
        let terminal = self
            .turn_status(&self.turn)
            .filter(|status| matches!(*status, "completed" | "failed" | "cancelled"))
            .map(str::to_owned);
        if terminal.is_some()
            && matches!(
                method,
                "session/request_permission" | "extension_ui_request"
            )
        {
            return;
        }
        match method {
            "arc/user" => {
                self.end_chunk(at);
                self.turn = string(msg, "turnId").into();
                self.turn_started_at = Some(at.into());
                self.status = "running".into();
                self.pi_stop_reason.clear();
                self.pi_error = Value::Null;
                self.start_turn(at);
                self.record_turn_status();
                let (text, truncated) = cut(&redact(string(msg, "text")), MAX_TEXT);
                self.partial |= truncated;
                let row = json!({"id":format!("{}:user:{}",self.turn,self.revision+1),"type":"user","status":"completed","text":text,"truncated":truncated});
                self.put(row, at);
                return;
            }
            "arc/settled" => {
                if !msg["error"].is_null() {
                    self.error(&msg["error"], at);
                }
                self.finish(string(msg, "status"), at);
                return;
            }
            "arc/interaction-resolved" => {
                self.resolve(&msg["id"], at);
                return;
            }
            _ => self.observed_events += 1,
        }
        match method {
            "session/update" => {
                let u = &msg["params"]["update"];
                match string(u, "sessionUpdate") {
                    "notice" => self.notice(None, "warning", "message", u, at),
                    "compaction_update" => {
                        let id = format!("compaction:{}", string(u, "compactionId"));
                        self.notice(
                            Some(&id),
                            "compaction",
                            if u["status"] == "in_progress" {
                                "start"
                            } else {
                                "end"
                            },
                            u,
                            at,
                        );
                        let mut row = self.entry(&id, "notice", "completed");
                        for key in ["summary", "error"] {
                            if let Some(value) = u.get(key) {
                                row[key] = if value.is_null() {
                                    Value::Null
                                } else {
                                    summary(&json!(content(value)))
                                };
                            }
                        }
                        self.put(row, at);
                    }
                    "compaction_summary_chunk" => {
                        let id = format!("compaction:{}", string(u, "compactionId"));
                        let mut row = self.entry(&id, "notice", "completed");
                        if row["notice"].is_null() {
                            row["notice"] = json!({"kind":"compaction","stage":"start"});
                        }
                        let text = format!(
                            "{}{}",
                            string(&row["summary"], "text"),
                            content(&u["content"])
                        );
                        row["summary"] = summary(&json!(text));
                        self.put(row, at);
                    }
                    "agent_message_chunk" => self.chunk("text", &content(&u["content"]), at),
                    "agent_thought_chunk" => self.chunk("thinking", &content(&u["content"]), at),
                    "user_message_chunk" => self.chunk("user", &content(&u["content"]), at),
                    "tool_call" | "tool_call_update" => {
                        self.end_chunk(at);
                        self.tool(u, at);
                    }
                    "plan" => {
                        self.end_chunk(at);
                        self.put(json!({"id":format!("{}:plan",self.turn),"type":"plan","status":"completed","plan":self.plan(&u["entries"]),"truncated":u["entries"].as_array().is_some_and(|r|r.len()>100)}),at);
                    }
                    _ => (),
                }
            }
            "session/request_permission" | "extension_ui_request" => {
                if method == "extension_ui_request" && msg["method"] == "notify" {
                    self.notice(None, "warning", "message", msg, at);
                    return;
                }
                if method == "extension_ui_request"
                    && !matches!(
                        string(msg, "method"),
                        "select" | "confirm" | "input" | "editor"
                    )
                {
                    return;
                }
                self.end_chunk(at);
                let call = &msg["params"]["toolCall"];
                let kind = if method == "session/request_permission" || msg["method"] == "confirm" {
                    "permission"
                } else {
                    "question"
                };
                let title = [
                    string(call, "command"),
                    string(call, "path"),
                    string(call, "title"),
                    string(msg, "title"),
                    string(msg, "message"),
                ]
                .into_iter()
                .find(|s| !s.is_empty())
                .unwrap_or("Interaction required");
                self.put(json!({"id":format!("interaction:{}",msg["id"]),"type":"interaction","status":"pending","interaction":{"kind":kind,"summary":cut(&redact(title),SUMMARY).0,"method":msg["method"],"command":sanitize(&call["command"]),"path":sanitize(&call["path"]),"title":sanitize(&call["title"]),"options":sanitize(if method=="session/request_permission" {&msg["params"]["options"]} else {&msg["options"]}),"respond":{"via":"act","op":"agent_respond","args":{"interactionId":msg["id"]}}}}),at);
            }
            "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
                self.end_chunk(at);
                let output = if method == "tool_execution_update" {
                    &msg["partialResult"]
                } else {
                    &msg["result"]
                };
                let status = if method == "tool_execution_end" {
                    if msg["isError"] == true {
                        "failed"
                    } else {
                        "completed"
                    }
                } else {
                    "running"
                };
                let mut call =
                    json!({"toolCallId":msg["toolCallId"],"title":msg["toolName"],"status":status});
                if !msg["args"].is_null() {
                    call["rawInput"] = msg["args"].clone();
                }
                if !output.is_null() {
                    call["rawOutput"] = output.clone();
                    call["content"] = output["content"].clone();
                }
                self.tool(&call, at);
            }
            "message_update" => {
                let e = &msg["assistantMessageEvent"];
                let kind = match string(e, "type") {
                    "text_delta" => "text",
                    "thinking_delta" => "thinking",
                    _ => return,
                };
                let id = format!(
                    "{}:pi:{}:{}",
                    self.turn,
                    self.pi_message,
                    e["contentIndex"].as_u64().unwrap_or(0)
                );
                self.delta(&id, kind, string(e, "delta"), at);
            }
            "message_end" => {
                let m = &msg["message"];
                if m["role"] == "assistant" {
                    for (i, b) in m["content"].as_array().into_iter().flatten().enumerate() {
                        if b["type"] == "toolCall" {
                            if !self.entries.iter().any(|row| row["id"] == b["id"]) {
                                self.tool(&json!({"toolCallId":b["id"],"title":b["name"],"rawInput":b["arguments"],"status":"unknown"}), at);
                            }
                            continue;
                        }
                        let kind = match string(b, "type") {
                            "text" => "text",
                            "thinking" => "thinking",
                            _ => continue,
                        };
                        let id = format!("{}:pi:{}:{i}", self.turn, self.pi_message);
                        let (text, truncated) = cut(&redact(&content(b)), MAX_TEXT);
                        self.partial |= truncated;
                        self.buffers.remove(&id);
                        self.put(json!({"id":id,"type":kind,"status":"completed","text":text,"truncated":truncated}),at);
                    }
                    // A failed model attempt can be retried. Only agent_settled
                    // establishes the final outcome of the Pi turn.
                    if terminal.is_none() {
                        self.pi_stop_reason = string(m, "stopReason").into();
                        self.pi_error = summary(&m["errorMessage"])["text"].clone();
                    }
                    self.pi_message += 1;
                }
            }
            "agent_settled" => {
                let status = match self.pi_stop_reason.as_str() {
                    "error" => "failed",
                    "aborted" => "cancelled",
                    _ => "completed",
                };
                if terminal.is_none() && status == "failed" {
                    self.error(&self.pi_error.clone(), at);
                }
                self.finish(status, at);
            }
            "auto_retry_start" | "auto_retry_end" => self.notice(
                None,
                "retry",
                if method.ends_with("start") {
                    "start"
                } else {
                    "end"
                },
                msg,
                at,
            ),
            "auto_compaction_start"
            | "auto_compaction_end"
            | "compaction_start"
            | "compaction_end" => self.notice(
                None,
                "compaction",
                if method.ends_with("start") {
                    "start"
                } else {
                    "end"
                },
                msg,
                at,
            ),
            "error" if msg["willRetry"] == true => self.notice(None, "retry", "start", msg, at),
            "error" => self.error(msg, at),
            _ => (),
        }
    }
    fn plan(&self, rows: &Value) -> Value {
        json!(rows.as_array().into_iter().flatten().take(100).map(|r|json!({"content":summary(r.get("content").or_else(||r.get("step")).unwrap_or(&Value::Null)),"status":r["status"],"priority":r["priority"]})).collect::<Vec<_>>())
    }
    fn delta(&mut self, id: &str, kind: &str, delta: &str, at: &str) {
        let text = self.buffers.entry(id.into()).or_default();
        text.push_str(delta);
        let (bounded, truncated) = cut(text, MAX_TEXT);
        *text = bounded;
        let mut row = json!({"id":id,"type":kind,"status":"running","truncated":truncated});
        if kind == "command" {
            row["output"] = summary(&json!(text));
        } else {
            row["text"] = json!(redact(text));
        }
        self.partial |= truncated;
        if let Some(old) = self.entries.iter().find(|r| r["id"] == id) {
            let mut merged = old.clone();
            for (k, v) in row.as_object().unwrap() {
                merged[k] = v.clone();
            }
            if old["truncated"] == true {
                merged["truncated"] = json!(true);
            }
            row = merged;
        }
        self.put(row, at);
    }
    pub fn sync_interactions(&mut self, requests: &[Value], at: &str) {
        let mut ids = std::collections::HashSet::new();
        for req in requests {
            // Late asynchronous answers remain available through codex_pending,
            // but must not revive a finished turn as active input work.
            let status = self
                .turn_status(string(&req["params"], "turnId"))
                .unwrap_or_else(|| string(req, "turnStatus"));
            if matches!(status, "completed" | "failed" | "cancelled" | "interrupted") {
                continue;
            }
            let id = format!("interaction:{}", req["id"]);
            ids.insert(id.clone());
            let params = &req["params"];
            let item = self.entries.iter().find(|r| r["id"] == params["itemId"]);
            let summary_text = [
                string(params, "command"),
                string(params, "path"),
                string(params, "reason"),
                string(params, "title"),
                string(params, "question"),
            ]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or_else(|| {
                item.map(|r| string(r, "command"))
                    .unwrap_or("Interaction required")
            });
            let questions: Vec<_> = params["questions"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|question| {
                    let mut value = sanitize(question);
                    if question["isSecret"].is_boolean() {
                        value["isSecret"] = question["isSecret"].clone();
                    }
                    value
                })
                .collect();
            self.put(json!({"id":id,"type":"interaction","status":"pending","interaction":{"kind":if string(req,"method").contains("Approval") {"permission"} else {"question"},"summary":cut(&redact(summary_text),SUMMARY).0,"request":summary(params),"method":req["method"],"questions":if params["questions"].is_array() {json!(questions)} else {Value::Null},"options":sanitize(&params["options"]),"command":sanitize(&params["command"]),"path":sanitize(&params["path"]),"cwd":sanitize(&params["cwd"]),"reason":sanitize(&params["reason"]),"preview":sanitize(&params["diff"]),"respond":req["next"],"canRespond":req["canRespond"]}}),at);
        }
        let resolved: Vec<_> = self
            .entries
            .iter()
            .filter(|r| {
                r["type"] == "interaction"
                    && r["status"] == "pending"
                    && !ids.contains(string(r, "id"))
            })
            .map(|r| string(r, "id").to_owned())
            .collect();
        for id in resolved {
            let row = self.entry(&id, "interaction", "completed");
            self.put(row, at);
        }
    }
    fn error(&mut self, error: &Value, at: &str) {
        self.put(json!({"id":format!("{}:error:{}",self.turn,self.revision+1),"type":"error","status":"failed","text":summary(error)["text"]}),at);
    }
    fn tool(&mut self, u: &Value, at: &str) {
        let id = string(u, "toolCallId");
        if id.is_empty() {
            self.partial = true;
            return;
        }
        self.tool_observed = true;
        let status = match string(u, "status") {
            "pending" => "pending",
            "in_progress" | "inProgress" | "running" => "running",
            "completed" => "completed",
            "failed" => "failed",
            "cancelled" => "cancelled",
            "unknown" => "unknown",
            _ => self
                .entries
                .iter()
                .find(|r| r["id"] == id)
                .and_then(|r| r["status"].as_str())
                .unwrap_or("running"),
        };
        let mut row = self.entry(id, "tool", status);
        let input = &parsed_input(&u["rawInput"]);
        if !input.is_null() || !u["kind"].is_null() || !u["title"].is_null() {
            let name = u["title"].as_str().unwrap_or(string(u, "name"));
            let (kind, operation) = tool_kind(string(u, "kind"), name, input);
            if kind != "tool" || row["type"] == "tool" {
                row["type"] = json!(kind);
            }
            if let Some(op) = operation {
                row["operation"] = json!(op);
            }
            if !name.is_empty() {
                row["title"] = json!(cut(&redact(name), SUMMARY).0);
            }
            if !input.is_null() {
                row["input"] = summary(&u["rawInput"]);
            }
            normalize_tool_input(&mut row, input, &u["locations"]);
            if row["command"].is_null() && kind == "command" && !name.is_empty() {
                row["command"] = row["title"].clone();
            }
        }
        if row["type"] == "command" && row["cwd"].is_null() && self.info["project"].is_string() {
            row["cwd"] = json!(cut(&redact(string(&self.info, "project")), SUMMARY).0);
        }
        if !u["rawOutput"].is_null() || !u["content"].is_null() {
            let mut output = content(&u["content"]);
            if output.is_empty() {
                output = content(&u["rawOutput"]);
            }
            if output.is_empty() && !u["rawOutput"].is_null() {
                output = u["rawOutput"].to_string();
            }
            row["output"] = summary(&json!(output));
            if let Some(code) = exit_code(&u["rawOutput"], "") {
                row["exitCode"] = json!(code);
                row["exitCodeSource"] = json!("rawOutput");
            } else if row["exitCodeSource"] != "rawOutput" {
                if let Some(code) = exit_code(&Value::Null, &output) {
                    row["exitCode"] = json!(code);
                    row["exitCodeSource"] = json!("output");
                }
            }
        }
        self.put(row, at);
    }
    /// Project history first, then overlay observations made while the read was in flight.
    pub fn backfill_codex(&mut self, thread: &Value, baseline: u64, observed: u64, at: &str) {
        let persisted = crate::control::persisted_turns(thread);
        for (turn, timing) in persisted.timings {
            let current = self.turn_timings.entry(turn).or_insert(json!({}));
            for field in ["startedAt", "endedAt"] {
                if timing[field].is_string() {
                    current[field] = timing[field].clone();
                }
            }
        }
        for (turn, configuration) in persisted.configurations {
            if let Some(summary) = crate::egress::dispatch_summary(&configuration) {
                self.turn_dispatch_summaries.insert(turn, summary);
            }
        }
        let mut history = Timeline::default();
        let turns = thread["turns"].as_array();
        history.partial = turns.is_none();
        for turn in turns.into_iter().flatten() {
            history.turn = string(turn, "id").into();
            history.status = string(turn, "status").into();
            history.record_turn_status();
            history.partial |= !turn["items"].is_array();
            for item in turn["items"].as_array().into_iter().flatten() {
                let status = match string(item, "status") {
                    "failed" | "declined" => "failed",
                    "inProgress" | "running" => "running",
                    "completed" => "completed",
                    "cancelled" | "interrupted" => "cancelled",
                    _ if history.status == "inProgress"
                        && !matches!(
                            string(item, "type"),
                            "userMessage" | "steeringUserMessage"
                        ) =>
                    {
                        "running"
                    }
                    _ => "completed",
                };
                history.codex_item(item, status, at);
            }
        }
        let live = self.entries.clone();
        for row in &mut history.entries {
            if let Some(old) = live.iter().find(|old| old["id"] == row["id"]) {
                if old["cursor"].as_u64().unwrap_or(0) > baseline {
                    *row = old.clone();
                } else {
                    row["startedAt"] = old["startedAt"].clone();
                    if old.get("endedAt").is_some() {
                        row["endedAt"] = old["endedAt"].clone();
                    }
                }
            } else {
                // History supplies content and native duration, not an observed start/end.
                row["startedAt"] = Value::Null;
                row["endedAt"] = Value::Null;
            }
        }
        let historical_ids: std::collections::HashSet<_> = history
            .entries
            .iter()
            .map(|r| string(r, "id").to_owned())
            .collect();
        history.entries.extend(
            live.into_iter()
                .filter(|r| !historical_ids.contains(string(r, "id"))),
        );
        self.partial = history.partial || history.entries.iter().any(|r| r["truncated"] == true);
        self.tool_observed |= history.tool_observed;
        // Preserve lifecycle evidence that arrived after the history read began.
        for (turn, _) in history.turn_status_observations {
            if self
                .turn_status_observations
                .get(&turn)
                .is_none_or(|event| *event <= observed)
            {
                if let Some(status) = history.turn_statuses.remove(&turn) {
                    self.turn_statuses.insert(turn, status);
                } else {
                    self.turn_statuses.remove(&turn);
                }
            }
        }
        if self.observed_events == observed || self.status.is_empty() {
            self.status = history.status;
            if self.turn != history.turn {
                self.turn_started_at = None;
            }
            self.turn = history.turn;
        }
        for (position, mut row) in history.entries.into_iter().enumerate() {
            // Preserve explicit unknown times and ordering through the incremental API.
            let started = row["startedAt"].clone();
            let ended = row.get("endedAt").cloned();
            row["position"] = json!(position);
            let id = row["id"].clone();
            self.put(row, at);
            if let Some(row) = self.entries.iter_mut().find(|row| row["id"] == id) {
                row["startedAt"] = started;
                if let Some(ended) = ended {
                    row["endedAt"] = ended;
                }
            }
        }
        self.entries
            .sort_by_key(|row| row["position"].as_u64().unwrap_or(u64::MAX));
        self.bytes = self.entries.iter().map(|r| r.to_string().len()).sum();
        if self.info.is_null() {
            self.info = json!({"id":thread["id"],"title":thread["name"],"project":thread["cwd"]});
        }
        for row in &self.entries {
            if row["status"] == "running" && matches!(string(row, "type"), "text" | "thinking") {
                self.buffers
                    .entry(string(row, "id").into())
                    .or_insert_with(|| string(row, "text").to_owned());
            }
        }
        self.history_loaded = true;
    }
    pub fn codex_item(&mut self, item: &Value, status: &str, at: &str) {
        let id = string(item, "id");
        if id.is_empty() {
            self.partial = true;
            return;
        }
        let kind = match string(item, "type") {
            "userMessage" | "steeringUserMessage" => "user",
            "agentMessage" => "text",
            "reasoning" => "thinking",
            "commandExecution" => "command",
            "fileChange" => "file",
            "plan" => "plan",
            "error" => "error",
            "mcpToolCall"
            | "dynamicToolCall"
            | "webSearch"
            | "imageGeneration"
            | "collabAgentToolCall" => "tool",
            "contextCompaction" => "notice",
            "enteredReviewMode" | "exitedReviewMode" => return,
            _ => {
                self.partial = true;
                return;
            }
        };
        let mut row = self.entry(id, kind, status);
        row["type"] = json!(kind);
        if kind == "text" && item["phase"].is_string() {
            row["phase"] = item["phase"].clone();
        }
        if item["durationMs"].is_number() {
            row["durationMs"] = item["durationMs"].clone();
        }
        match kind {
            "notice" => {
                self.notice(
                    Some(id),
                    "compaction",
                    if status == "running" { "start" } else { "end" },
                    item,
                    at,
                );
                return;
            }
            "user" | "text" | "thinking" => {
                let text = if kind == "thinking" {
                    content(&item["summary"])
                } else if kind == "text" {
                    content(&item["text"])
                } else {
                    content(
                        item.get("content")
                            .or_else(|| item.get("input"))
                            .unwrap_or(&Value::Null),
                    )
                };
                let (text, truncated) = cut(&redact(&text), MAX_TEXT);
                row["text"] = json!(text);
                row["truncated"] = json!(truncated);
                self.partial |= truncated;
            }
            "command" => {
                self.tool_observed = true;
                for k in ["command", "cwd"] {
                    row[k] = json!(cut(&redact(string(item, k)), SUMMARY).0);
                }
                row["output"] = if item["aggregatedOutput"].is_null() {
                    summary(&json!(""))
                } else {
                    summary(&item["aggregatedOutput"])
                };
                if item["commandActions"].is_array() {
                    row["commandActions"] = sanitize(&item["commandActions"]);
                }
                if item["exitCode"].is_i64() {
                    row["exitCode"] = item["exitCode"].clone();
                }
            }
            "file" => {
                self.tool_observed = true;
                let changes: Vec<_> = item["changes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(file_change)
                    .collect();
                row["path"] = changes
                    .first()
                    .map(|c| c["path"].clone())
                    .unwrap_or(Value::Null);
                if let Some(operation) = changes.first().and_then(|c| c["operation"].as_str()) {
                    row["operation"] = json!(operation);
                }
                row["paths"] = json!(changes.iter().map(|c| &c["path"]).collect::<Vec<_>>());
                row["changes"] = json!(changes);
            }
            "plan" => {
                row["plan"] = if item["plan"].is_array() {
                    self.plan(&item["plan"])
                } else {
                    json!([{"content":summary(&item["text"]),"status":status}])
                };
            }
            "error" => {
                row["text"] = summary(item)["text"].clone();
            }
            _ => {
                self.tool_observed |= kind == "tool";
                row["title"] = json!(string(item, "tool"));
                row["input"] = summary(&item["arguments"]);
                let input = parsed_input(&item["arguments"]);
                let (tool_type, operation) = tool_kind("", string(item, "tool"), &input);
                row["type"] = json!(tool_type);
                if let Some(operation) = operation {
                    row["operation"] = json!(operation);
                }
                normalize_tool_input(&mut row, &input, &Value::Null);
                row["output"] = summary(&item["result"]);
            }
        }
        self.buffers.remove(id);
        self.put(row, at);
    }
    pub fn codex(&mut self, method: &str, params: &Value, at: &str) {
        self.observed_events += 1;
        match method {
            "turn/started" => {
                let turn = string(&params["turn"], "id");
                if self.turn != turn || self.turn_started_at.is_none() {
                    self.turn_started_at = Some(at.into());
                }
                self.turn = turn.into();
                self.status = "running".into();
                self.start_turn(at);
                self.record_turn_status();
            }
            "turn/completed" => {
                if let Some(turn) = params["turn"]["id"].as_str() {
                    self.turn = turn.into();
                }
                self.finish(match string(&params["turn"],"status") {"failed"=>"failed","interrupted"|"cancelled"=>"cancelled","completed"=>"completed",_=>"unknown"},at);
            }
            "item/started"|"item/completed" => {
                if let Some(turn) = params["turnId"].as_str() {
                    if self.turn != turn {
                        self.turn_started_at = None;
                    }
                    self.turn = turn.into();
                }
                let status=match string(&params["item"],"status") {"failed"|"declined"=>"failed",_ if method=="item/completed"=>"completed",_=>"running"};
                self.codex_item(&params["item"],status,at);
            }
            "item/agentMessage/delta"|"item/reasoning/summaryTextDelta"|"item/reasoning/textDelta"|"item/commandExecution/outputDelta" => {
                let kind=if method.contains("reasoning") {"thinking"} else if method.contains("commandExecution") {"command"} else {"text"};
                self.delta(string(params,"itemId"),kind,string(params,"delta"),at);
            }
            "turn/plan/updated" => self.put(json!({"id":format!("{}:plan",self.turn),"type":"plan","status":"completed","plan":self.plan(&params["plan"])}),at),
            "thread/compacted" => self.notice(None, "compaction", "end", params, at),
            "warning" => self.notice(None, "warning", "message", params, at),
            "error" if params["willRetry"] == true => self.notice(None, "retry", "start", params, at),
            "error" => self.error(params,at),
            _=>(),
        }
    }
    pub fn execution_evidence(&self) -> Value {
        if self.partial {
            json!("partial")
        } else {
            json!(self.tool_observed)
        }
    }
    pub fn evidence(&self, turn: Option<&str>) -> Value {
        json!(self
            .entries
            .iter()
            .filter(|r| matches!(string(r, "type"), "command" | "file")
                && turn.is_none_or(|t| r["turnId"] == t))
            .collect::<Vec<_>>())
    }
    pub fn response(&self, session: &str, after: u64) -> Value {
        let truncated = self.entries.iter().any(|row| {
            row["truncated"] == true
                || row["input"]["truncated"] == true
                || row["output"]["truncated"] == true
                || row["summary"]["truncated"] == true
                || row["error"]["truncated"] == true
        });
        let mut result = json!({"sessionId":session,"status":self.status,"entries":self.entries.iter().enumerate().filter(|(_,r)|r["cursor"].as_u64().unwrap_or(0)>after).map(|(i,r)| { let mut row=r.clone(); if row.get("position").is_none() { row["position"]=json!(i); } row }).collect::<Vec<_>>(),"cursor":self.revision,"coverage":{"state":if self.partial {"partial"} else {"complete"},"truncated":truncated},"executionEvidence":self.execution_evidence()});
        if self.omitted_sidechain_records > 0 {
            result["coverage"]["omittedSidechainRecords"] = json!(self.omitted_sidechain_records);
        }
        if self.observation_lost {
            result["coverage"]["state"] = json!("partial");
            result["coverage"]["reason"] = json!(
                "native-observation-lost; refreshed history does not restore a live subscription"
            );
        }
        let mut prompt_sources = HashMap::new();
        for mut record in crate::dispatch_policy::records(session).unwrap_or_default() {
            if record["dispatchMode"] != "new-turn" {
                continue;
            }
            crate::sources::decorate(&mut record["origin"]);
            if let Some(summary) = crate::egress::dispatch_summary(&record) {
                if summary["controlSource"].is_object() {
                    prompt_sources
                        .entry(string(&record, "turnId").to_owned())
                        .or_insert(summary["controlSource"].clone());
                }
            }
        }
        let first_prompts: HashMap<_, _> = self
            .entries
            .iter()
            .filter(|r| r["type"] == "user")
            .fold(HashMap::new(), |mut map, row| {
                map.entry(string(row, "turnId"))
                    .or_insert(string(row, "id"));
                map
            });
        for row in result["entries"].as_array_mut().into_iter().flatten() {
            let turn = string(row, "turnId");
            if first_prompts
                .get(turn)
                .is_some_and(|id| *id == string(row, "id"))
            {
                if let Some(source) = prompt_sources.get(turn) {
                    row["controlSource"] = source.clone();
                }
            }
        }
        let summaries = dispatch_summaries(session, &self.turn_dispatch_summaries);
        if let Some(summary) = summaries.get(&self.turn) {
            result["dispatchSummary"] = summary.clone();
        }
        if !summaries.is_empty() {
            result["turnDispatchSummaries"] = json!(summaries);
        }
        if !self.turn_statuses.is_empty() {
            result["turnStatuses"] = json!(self.turn_statuses);
        }
        if !self.turn_timings.is_empty() {
            result["turnTimings"] = json!(self.turn_timings);
        }
        result["snapshotHash"] = json!(hash(json!({"entries":self.entries,"status":self.status,"turnStatuses":self.turn_statuses,"turnTimings":self.turn_timings,"coverage":result["coverage"]}).to_string()));
        result
    }
    pub fn session(&self, id: &str, info: &Value, source: &str, pending: Option<Value>) -> Value {
        let recent: Vec<_> = self
            .entries
            .iter()
            .rev()
            .filter(|r| matches!(string(r, "type"), "thinking" | "text" | "command" | "file"))
            .map(entry_headline)
            .filter(|s| !s.trim().is_empty())
            .take(3)
            .collect();
        let title = headline("text", string(info, "title"));
        let fallback = recent.first().cloned().unwrap_or_else(|| {
            if !title.is_empty() {
                title
            } else {
                self.entries
                    .iter()
                    .rev()
                    .filter(|r| r["type"] == "user")
                    .map(entry_headline)
                    .find(|s| !s.is_empty())
                    .unwrap_or_default()
            }
        });
        let latest = self
            .entries
            .iter()
            .filter(|r| !matches!(string(r, "type"), "interaction" | "notice"))
            .max_by_key(|r| {
                (
                    matches!(string(r, "status"), "pending" | "running"),
                    r["cursor"].as_u64(),
                )
            });
        let interaction = pending.or_else(|| {
            self.entries
                .iter()
                .rev()
                .find(|r| r["type"] == "interaction" && r["status"] == "pending")
                .map(|r| r["interaction"].clone())
        });
        let mut row = json!({"id":id,"source":source,"title":redact(string(info,"title")),"project":info["project"],"phase":"idle","headline":"","startedAt":info["startedAt"],"phaseSince":info["startedAt"],"timeline":true});
        row["turnId"] = if self.turn.is_empty() {
            Value::Null
        } else {
            json!(self.turn)
        };
        row["turnStartedAt"] = json!(self.turn_started_at);
        let mut turns: std::collections::HashSet<&str> = self
            .entries
            .iter()
            .filter_map(|entry| entry["turnId"].as_str())
            .collect();
        turns.extend(self.turn_statuses.keys().map(String::as_str));
        turns.insert(&self.turn);
        turns.remove("");
        row["turnCount"] = json!(turns.len());
        // External tails have no ARC dispatch ownership. Their metadata clock
        // supplies native configuration without per-poll dispatch-store reads.
        if source != "transcript" {
            if let Some(summary) =
                dispatch_summaries(id, &self.turn_dispatch_summaries).get(&self.turn)
            {
                row["dispatchSummary"] = summary.clone();
            }
        }
        row["fallbackHeadline"] = json!(fallback);
        row["recentContent"] = json!(recent.iter().rev().collect::<Vec<_>>());
        // Entries already merge chunks and tool updates by stable id. Preserve
        // entry order (including native history backfill), not update cursors.
        let steps: Vec<_> = self
            .entries
            .iter()
            .rev()
            .map(|entry| string(entry, "type"))
            .filter(|kind| {
                matches!(
                    *kind,
                    "thinking" | "command" | "file" | "tool" | "text" | "interaction"
                )
            })
            .take(5)
            .collect();
        row["recentSteps"] = json!(steps.into_iter().rev().collect::<Vec<_>>());
        if let Some(item) = latest {
            let kind = string(item, "type");
            row["phase"] = json!(if matches!(
                kind,
                "thinking" | "command" | "file" | "tool" | "text"
            ) {
                kind
            } else {
                "idle"
            });
            row["headline"] = json!(entry_headline(item));
            row["phaseSince"] = item["startedAt"].clone();
        }
        if let Some(mut interaction) = interaction {
            if interaction["respond"]["op"] == "agent_respond" {
                interaction["respond"]["args"]["agent"] = info["agent"].clone();
                interaction["respond"]["args"]["taskId"] = json!(id);
            }
            row["phase"] = json!("interaction");
            row["headline"] = interaction["summary"].clone();
            if let Some(pending) = self
                .entries
                .iter()
                .rev()
                .find(|r| r["type"] == "interaction" && r["status"] == "pending")
            {
                row["phaseSince"] = pending["startedAt"].clone();
            }
            row["interaction"] = interaction;
        }
        if source == "codex-thread" {
            if let Some(open) = crate::agents::driver::AgentDriver::CodexNative.navigation(id) {
                row["open"] = open;
            }
        }
        row
    }
}

pub(crate) fn dispatch_summaries(
    session: &str,
    native: &HashMap<String, Value>,
) -> HashMap<String, Value> {
    let mut summaries = native.clone();
    for mut record in crate::dispatch_policy::records(session).unwrap_or_default() {
        let turn = string(&record, "turnId").to_owned();
        if turn.is_empty() {
            continue;
        }
        crate::sources::decorate(&mut record["origin"]);
        // A recorded dispatch owns its configuration. Do not fill missing fields
        // with a later session default or an unrelated persisted turn context.
        summaries.remove(&turn);
        if let Some(summary) = crate::egress::dispatch_summary(&record) {
            summaries.insert(turn, summary);
        }
    }
    summaries
}
fn entry_headline(item: &Value) -> String {
    let kind = string(item, "type");
    let text = match kind {
        "command" => string(item, "command"),
        "file" => string(item, "path"),
        "tool" => string(item, "title"),
        _ => string(item, "text"),
    };
    headline(kind, text)
}

/// Separate stream state, shared by the RPC readers; it never changes codex_* responses.
pub(crate) fn observe(
    timelines: &mut HashMap<String, Timeline>,
    session: &str,
    method: &str,
    params: &Value,
    at: &str,
    durable: bool,
) {
    if durable {
        timelines
            .entry(session.into())
            .or_default()
            .agent(method, params, at);
        return;
    }
    let thread = params["threadId"]
        .as_str()
        .or_else(|| params["conversationId"].as_str())
        .unwrap_or("");
    let Some(t) = timelines.get_mut(thread) else {
        return;
    };
    if method == "desktop/thread-stream-state-changed" {
        if params["change"]["type"] == "snapshot" {
            let state = &params["change"]["conversationState"];
            match crate::desktop::turns(state) {
                Ok(turns) => {
                    t.observed_events += 1;
                    for turn in turns {
                        t.turn = string(&turn, "id").into();
                        t.status = string(&turn, "status").into();
                        t.record_turn_status();
                        for item in turn["items"].as_array().into_iter().flatten() {
                            t.codex_item(
                                item,
                                if t.status == "inProgress" {
                                    "running"
                                } else {
                                    "completed"
                                },
                                at,
                            );
                        }
                    }
                }
                Err(_) => t.partial = true,
            }
        }
    } else {
        t.codex(method, params, at);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_stability_late_events_do_not_reopen_terminal_turns() {
        // Regression: reader EOF and late permission or Pi events overwrote terminal turn outcomes.
        for status in ["completed", "failed", "cancelled"] {
            let mut timeline = Timeline::default();
            let at = "2026-01-01T00:00:00Z";
            timeline.agent("arc/user", &json!({"turnId":"old","text":"fixture"}), at);
            timeline.finish(status, at);
            timeline.finish("unknown", "2026-01-01T00:00:01Z");
            timeline.agent(
                "session/request_permission",
                &json!({"id":"late","params":{"toolCall":{"title":"late"}}}),
                at,
            );
            timeline.agent("session/update", &json!({"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"late evidence"}}}}), at);
            timeline.agent("message_end", &json!({"message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"late failure"}}), at);
            timeline.agent("agent_settled", &json!({}), at);
            assert_eq!(timeline.turn_status("old"), Some(status));
            let response = timeline.response("fixture", 0);
            assert_eq!(response["status"], status);
            assert!(response["entries"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| !matches!(string(r, "status"), "pending" | "running")));
            assert!(response["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["text"] == "late evidence"));
            timeline.agent("arc/user", &json!({"turnId":"new","text":"next"}), at);
            assert_eq!(timeline.turn_status("new"), Some("running"));
            assert_eq!(timeline.turn_status("old"), Some(status));
        }
    }

    #[test]
    fn finished_async_questions_do_not_reactivate_input_work_or_move_to_a_new_turn() {
        // Regression: repeated pending sync revived a terminal turn as waiting for an asynchronous answer.
        let mut timeline = Timeline::default();
        let at = "2026-01-01T00:00:00Z";
        timeline.codex("turn/started", &json!({"turn":{"id":"old"}}), at);
        let question = json!({"id":"question","method":"request_user_input_async","params":{"threadId":"thread","turnId":"old","question":"Choose"}});
        timeline.sync_interactions(&[question.clone()], at);
        assert_eq!(
            timeline.session("thread", &json!({"id":"thread"}), "codex-thread", None)["phase"],
            "interaction"
        );
        timeline.codex(
            "turn/completed",
            &json!({"turn":{"id":"old","status":"completed"}}),
            at,
        );
        timeline.sync_interactions(&[question.clone()], at);
        assert_ne!(
            timeline.session("thread", &json!({"id":"thread"}), "codex-thread", None)["phase"],
            "interaction"
        );
        timeline.codex("turn/started", &json!({"turn":{"id":"new"}}), at);
        timeline.sync_interactions(&[question], at);
        let response = timeline.response("thread", 0);
        assert!(response["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["type"] != "interaction"
                || (row["status"] != "pending" && row["turnId"] == "old")));
        let active = json!({"id":"active-question","params":{"threadId":"thread","turnId":"new"}});
        timeline.sync_interactions(&[active], at);
        assert_eq!(
            timeline.session("thread", &json!({"id":"thread"}), "codex-thread", None)["phase"],
            "interaction"
        );
    }

    #[test]
    fn silent_command_output_is_empty_without_hiding_literal_null() {
        // Regression: silent native commands rendered a JSON null as the literal text null in task panels.
        for (output, expected) in [
            (None, ""),
            (Some(Value::Null), ""),
            (Some(json!("")), ""),
            (Some(json!("null")), "null"),
        ] {
            let mut timeline = Timeline::default();
            let mut item =
                json!({"id":"silent","type":"commandExecution","command":"sleep 1","exitCode":0});
            if let Some(output) = output {
                item["aggregatedOutput"] = output;
            }
            timeline.codex(
                "item/completed",
                &json!({"item":item}),
                "2026-01-01T00:00:00Z",
            );
            let response = timeline.response("example", 0);
            assert_eq!(response["entries"][0]["output"]["text"], expected);
            assert_eq!(response["entries"][0]["exitCode"], 0);
        }
    }
    const AT: &str = "2026-01-01T00:00:00.000Z";
    const LATER: &str = "2026-01-01T00:00:01.000Z";
    #[test]
    fn restored_answers_keep_distinct_native_sessions_and_turns() {
        // Regression: native request IDs restart at zero and must not overwrite answers from earlier turns.
        let mut timeline = Timeline::default();
        for (session, turn, answer) in [("first", "one", "A"), ("second", "two", "B")] {
            timeline.answered(&json!({"backendSession":session,"id":0,"method":"item/tool/requestUserInput","params":{"turnId":turn,"questions":[{"id":"q","question":"Choose"}]}}), &json!({"result":{"answer":answer},"origin":{"controlSource":"ARC"},"resolvedAt":"2026-01-01T00:00:00Z"}));
        }
        let result = timeline.response("task", 0);
        assert_eq!(result["entries"].as_array().unwrap().len(), 2);
        assert_eq!(result["entries"][0]["response"]["result"]["answer"], "A");
        assert_eq!(result["entries"][1]["response"]["result"]["answer"], "B");
        assert_ne!(result["entries"][0]["id"], result["entries"][1]["id"]);
    }

    #[test]
    fn native_diff_counts_only_hunk_lines() {
        // Property: diff headers do not contribute counts and missing hunks leave counts unknown.
        let row = file_change(
            &json!({"path":"example.txt","diff":"--- a/example.txt\n+++ b/example.txt\n@@ -1,1 +1,2 @@\n-old\n+new\n+extra\n"}),
        );
        assert_eq!(row["added"], 2);
        assert_eq!(row["removed"], 1);
        assert!(file_change(&json!({"path":"example.txt"}))["added"].is_null());
    }

    #[test]
    fn file_changes_preserve_native_operations() {
        // Property: native file-change operations remain explicit without guessing from diff counts.
        for (kind, operation) in [("add", "create"), ("update", "edit"), ("delete", "delete")] {
            let row = file_change(&json!({"path":"example.txt","kind":{"type":kind}}));
            assert_eq!(row["operation"], operation);
        }
        assert!(file_change(&json!({"path":"example.txt"}))["operation"].is_null());
    }

    #[test]
    fn recent_steps_merge_chunks_and_updates_and_keep_last_five_in_order() {
        // Property: recent steps merge chunks and updates and keep last five in order.
        let mut timeline = Timeline::default();
        let snapshot =
            |t: &Timeline| t.session("example", &json!({"id":"example"}), "arc-task", None);
        assert_eq!(snapshot(&timeline)["recentSteps"], json!([]));
        timeline.chunk("thinking", "First", AT);
        timeline.chunk("thinking", " second", AT);
        assert_eq!(snapshot(&timeline)["recentSteps"], json!(["thinking"]));
        timeline.end_chunk(AT);
        for (id, kind) in ["command", "file", "tool", "text", "interaction"]
            .iter()
            .enumerate()
        {
            timeline.put(
                json!({"id":id.to_string(),"type":kind,"status":"running"}),
                AT,
            );
        }
        timeline.put(json!({"id":"0","type":"command","status":"completed"}), AT);
        timeline.put(json!({"id":"user","type":"user","text":"Prompt"}), AT);
        timeline.put(json!({"id":"plan","type":"plan"}), AT);
        timeline.put(json!({"id":"error","type":"error"}), AT);
        assert_eq!(
            snapshot(&timeline)["recentSteps"],
            json!(["command", "file", "tool", "text", "interaction"])
        );
        timeline.put(json!({"id":"next","type":"command"}), AT);
        assert_eq!(
            snapshot(&timeline)["recentSteps"],
            json!(["file", "tool", "text", "interaction", "command"])
        );
    }
    #[test]
    fn empty_reasoning_keeps_phase_and_uses_recent_readable_content() {
        // Property: empty reasoning keeps phase and uses recent readable content.
        let mut t = Timeline::default();
        let info = json!({"id":"example","title":"Task title"});
        t.codex_item(
            &json!({"id":"u","type":"userMessage","content":[{"text":"User request"}]}),
            "completed",
            AT,
        );
        t.codex_item(
            &json!({"id":"r","type":"reasoning","summary":[]}),
            "running",
            LATER,
        );
        let row = t.session(string(&info, "id"), &info, "codex-thread", None);
        assert_eq!(row["phase"], "thinking");
        assert_eq!(row["headline"], "");
        assert_eq!(row["fallbackHeadline"], "Task title");
        assert_eq!(
            t.session("example", &json!({"id":"example"}), "codex-thread", None)
                ["fallbackHeadline"],
            "User request"
        );
        t.codex_item(
            &json!({"id":"c","type":"commandExecution","command":"printf example"}),
            "completed",
            LATER,
        );
        assert_eq!(
            t.session(string(&info, "id"), &info, "codex-thread", None)["fallbackHeadline"],
            "printf example"
        );
        t.codex_item(&json!({"id":"f","type":"fileChange","changes":[{"path":"src/example.rs","kind":{"type":"update"}}]}), "completed", LATER);
        assert_eq!(
            t.session(string(&info, "id"), &info, "codex-thread", None)["fallbackHeadline"],
            "src/example.rs"
        );
        t.codex_item(
            &json!({"id":"t","type":"agentMessage","text":"Latest readable text"}),
            "completed",
            LATER,
        );
        let row = t.session(string(&info, "id"), &info, "codex-thread", None);
        assert_eq!(row["fallbackHeadline"], "Latest readable text");
        assert_eq!(row["recentContent"].as_array().unwrap().len(), 3);
    }
    #[test]
    fn claude_transcript_projects_readonly_text_and_tool_results() {
        // Property: claude transcript projects readonly text and tool results.
        let records = vec![
            json!({"uuid":"meta","timestamp":AT,"isMeta":true,"message":{"role":"user","content":"Injected"}}),
            json!({"uuid":"u","timestamp":AT,"message":{"role":"user","content":"Read example"}}),
            json!({"uuid":"a","timestamp":AT,"message":{"role":"assistant","content":[
                {"type":"thinking","thinking":"Checking example"},
                {"type":"tool_use","id":"read","name":"Read","input":{"file_path":"src/example.rs"}},
                {"type":"tool_use","id":"cmd","name":"Bash","input":{"command":"printf example"}}
            ]}}),
            json!({"uuid":"r","timestamp":LATER,"message":{"role":"user","content":[
                {"type":"tool_result","tool_use_id":"read","content":"Example content"},
                {"type":"tool_result","tool_use_id":"cmd","is_error":true,"content":"Error"}
            ]}}),
            json!({"uuid":"answer","timestamp":LATER,"message":{"role":"assistant","content":[{"type":"text","text":"Done"}]}}),
        ];
        let mut t = Timeline::default();
        t.backfill_claude(&records);
        assert_eq!(t.entries.len(), 5);
        assert_eq!(t.entries[0]["type"], "user");
        assert_eq!(t.entries[1]["type"], "thinking");
        let read = &t.entries[2];
        assert_eq!(read["type"], "file");
        assert_eq!(read["operation"], "read");
        assert_eq!(read["status"], "completed");
        assert_eq!(read["output"]["text"], "Example content");
        assert_eq!(read["startedAt"], AT);
        assert_eq!(read["endedAt"], LATER);
        assert_eq!(t.entries[3]["status"], "failed");
        assert!(t.entries.iter().all(|e| e["interaction"].is_null()));
        assert!(!t.partial);
    }
    fn acp(t: &mut Timeline, update: Value, at: &str) {
        t.agent("session/update", &json!({"params":{"update":update}}), at);
    }
    fn fixture() -> Timeline {
        let rows: Vec<Value> =
            serde_json::from_str(include_str!("agents/fixtures/tracking-acp.json")).unwrap();
        let mut timeline = Timeline::default();
        for row in rows {
            timeline.agent(string(&row, "method"), &row["params"], AT);
        }
        timeline
    }
    #[test]
    fn codex_history_merges_by_item_and_preserves_inflight_updates() {
        // Property: codex history merges by item and preserves inflight updates.
        let mut t = Timeline::default();
        t.turn = "turn".into();
        t.status = "running".into();
        t.codex_item(
            &json!({"id":"reply","type":"agentMessage","text":"partial"}),
            "running",
            AT,
        );
        let baseline = t.revision;
        t.codex_item(
            &json!({"id":"reply","type":"agentMessage","text":"new live reply"}),
            "completed",
            LATER,
        );
        let history = json!({"id":"thread","turns":[{"id":"turn","status":"completed","items":[
            {"id":"request","type":"userMessage","content":[{"text":"Example request"}]},
            {"id":"cmd","type":"commandExecution","status":"completed","command":"printf example","aggregatedOutput":"example","durationMs":750,"exitCode":0},
            {"id":"reply","type":"agentMessage","text":"older snapshot"}
        ]}]});
        t.backfill_codex(&history, baseline, 0, LATER);
        assert_eq!(t.entries.len(), 3);
        assert_eq!(t.entries[0]["id"], "request");
        assert!(t.entries[0]["startedAt"].is_null());
        assert_eq!(t.entries[1]["durationMs"], 750);
        assert_eq!(t.entries[2]["text"], "new live reply");
        assert_eq!(t.entries[2]["startedAt"], AT);
        assert_eq!(t.entries[2]["endedAt"], LATER);
        assert!(!t.partial);
        assert!(t.history_loaded);
        assert_eq!(
            t.response("thread", baseline)["entries"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert!(t
            .entries
            .windows(2)
            .all(|rows| rows[0]["position"].as_u64() < rows[1]["position"].as_u64()));
        let revision = t.revision;
        t.codex_item(
            &json!({"id":"reply","type":"agentMessage","text":"new live reply"}),
            "completed",
            LATER,
        );
        assert_eq!(t.revision, revision);
        assert_eq!(t.entries.len(), 3);
    }
    #[test]
    fn codex_history_completes_unobserved_items_and_detects_missing_history() {
        // Property: codex history completes unobserved items and detects missing history.
        let mut t = Timeline::default();
        t.partial = true;
        t.codex_item(
            &json!({"id":"reply","type":"agentMessage","text":"partial"}),
            "running",
            AT,
        );
        t.backfill_codex(
            &json!({"turns":[{"id":"turn","status":"completed","items":[
                {"id":"reply","type":"agentMessage","text":"full reply"}
            ]}]}),
            t.revision,
            0,
            LATER,
        );
        assert!(!t.partial);
        assert_eq!(t.entries[0]["text"], "full reply");
        assert_eq!(t.entries[0]["status"], "completed");
        assert_eq!(t.entries[0]["startedAt"], AT);
        let mut missing = Timeline::default();
        missing.backfill_codex(&json!({"turns":[{"id":"turn"}]}), 0, 0, AT);
        assert!(missing.partial);
        let mut absent = Timeline::default();
        absent.backfill_codex(&json!({}), 0, 0, AT);
        assert!(absent.partial);
        let mut empty = Timeline::default();
        empty.backfill_codex(&json!({"turns":[]}), 0, 0, AT);
        assert!(!empty.partial);
        let mut running = Timeline::default();
        running.backfill_codex(
            &json!({"turns":[{"id":"turn","status":"inProgress","items":[
                {"id":"reply","type":"agentMessage","text":"Hello "}
            ]}]}),
            0,
            0,
            AT,
        );
        running.codex(
            "item/agentMessage/delta",
            &json!({"itemId":"reply","delta":"world"}),
            LATER,
        );
        assert_eq!(running.entries[0]["text"], "Hello world");
    }
    #[test]
    fn acp_fixture_projects_entries_evidence_and_snapshot() {
        // Property: acp fixture projects entries evidence and snapshot.
        let t = fixture();
        assert_eq!(
            t.entries
                .iter()
                .map(|r| string(r, "type"))
                .collect::<Vec<_>>(),
            ["user", "thinking", "command", "file", "plan", "text"]
        );
        assert_eq!(t.entries[1]["text"], "Inspecting the workspace");
        assert_eq!(t.entries[2]["id"], "cmd-example");
        assert_eq!(t.entries[2]["exitCode"], 0);
        assert_eq!(t.entries[2]["status"], "completed");
        assert_eq!(t.entries[3]["operation"], "read");
        assert_eq!(
            t.evidence(Some("turn-example")).as_array().unwrap().len(),
            2
        );
        assert_eq!(t.execution_evidence(), true);
        let snapshot = t.session(
            "task-example",
            &json!({"id":"task-example","title":"Example","startedAt":AT}),
            "arc-task",
            None,
        );
        assert_eq!(snapshot["phase"], "text");
        assert_eq!(snapshot["headline"], "Check complete.");
        assert_eq!(snapshot["timeline"], true);
        assert_eq!(
            headline("text", "First sentence. Last sentence."),
            "Last sentence."
        );
    }
    #[test]
    fn incremental_chunks_and_tool_updates_keep_identity_and_start_time() {
        // Property: incremental chunks and tool updates keep identity and start time.
        let mut t = Timeline::default();
        acp(
            &mut t,
            json!({"sessionUpdate":"agent_message_chunk","content":{"text":"Hello "}}),
            AT,
        );
        let cursor = t.revision;
        let id = t.entries[0]["id"].clone();
        acp(
            &mut t,
            json!({"sessionUpdate":"agent_message_chunk","content":{"text":"world"}}),
            LATER,
        );
        let delta = t.response("example", cursor);
        assert_eq!(delta["entries"][0]["id"], id);
        assert_eq!(delta["entries"][0]["text"], "Hello world");
        assert_eq!(delta["entries"][0]["startedAt"], AT);
        acp(
            &mut t,
            json!({"sessionUpdate":"tool_call","toolCallId":"shell","rawInput":{"command":"true"},"status":"in_progress"}),
            LATER,
        );
        acp(
            &mut t,
            json!({"sessionUpdate":"tool_call_update","toolCallId":"shell","status":"completed","content":[{"content":{"text":"Process exited with code 0"}}]}),
            LATER,
        );
        assert_eq!(t.entries[1]["exitCode"], 0);
        assert_eq!(t.entries[0]["endedAt"], LATER);
        assert!(t.response("example", t.revision)["entries"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    #[test]
    fn resolved_approval_restores_running_command_phase_and_start() {
        // Property: resolved approval restores running command phase and start.
        let mut t = Timeline::default();
        let info = json!({"id":"task","taskId":"task","agent":"example","startedAt":AT});
        acp(
            &mut t,
            json!({"sessionUpdate":"tool_call","toolCallId":"command","kind":"execute","rawInput":{"command":"printf example"},"status":"in_progress"}),
            AT,
        );
        let request = json!({"id":17,"params":{"toolCall":{"toolCallId":"command","command":"printf example"}}});
        t.agent("session/request_permission", &request, LATER);
        assert_eq!(
            t.session(string(&info, "id"), &info, "arc-task", None)["phase"],
            "interaction"
        );
        t.resolve(&json!(17), LATER);
        let snapshot = t.session(string(&info, "id"), &info, "arc-task", None);
        assert_eq!(snapshot["phase"], "command");
        assert_eq!(snapshot["headline"], "printf example");
        assert_eq!(snapshot["phaseSince"], AT);
        assert!(snapshot.get("interaction").is_none());
        // A command first observed after the approval is also selected.
        acp(
            &mut t,
            json!({"sessionUpdate":"tool_call","toolCallId":"next","kind":"execute","rawInput":{"command":"printf next"},"status":"in_progress"}),
            LATER,
        );
        t.resolve(&json!(17), "2026-01-01T00:00:02.000Z");
        let snapshot = t.session(string(&info, "id"), &info, "arc-task", None);
        assert_eq!(snapshot["headline"], "printf next");
        assert_eq!(snapshot["phaseSince"], LATER);
        let mut only_interaction = Timeline::default();
        only_interaction.agent("session/request_permission", &request, AT);
        only_interaction.resolve(&json!(17), LATER);
        assert_eq!(
            only_interaction.session(string(&info, "id"), &info, "arc-task", None)["phase"],
            "idle"
        );
    }
    #[test]
    fn running_command_wins_over_late_completed_file_updates() {
        // Property: running command wins over late completed file updates.
        let mut t = Timeline::default();
        let info = json!({"id":"task","taskId":"task","agent":"example","startedAt":AT});
        for (id, kind) in [("read", "read"), ("write", "edit")] {
            acp(
                &mut t,
                json!({"sessionUpdate":"tool_call","toolCallId":id,"kind":kind,"rawInput":{"file_path":"src/result.txt"},"status":"in_progress"}),
                AT,
            );
            acp(
                &mut t,
                json!({"sessionUpdate":"tool_call_update","toolCallId":id,"status":"completed"}),
                LATER,
            );
        }
        let command_start = "2026-01-01T00:00:02.000Z";
        acp(
            &mut t,
            json!({"sessionUpdate":"tool_call","toolCallId":"command","kind":"execute","rawInput":{"command":"printf example"},"status":"pending"}),
            command_start,
        );
        t.agent("session/request_permission", &json!({"id":17,"params":{"toolCall":{"toolCallId":"command","command":"printf example"}}}), command_start);
        assert_eq!(
            t.session(string(&info, "id"), &info, "arc-task", None)["phase"],
            "interaction"
        );
        t.resolve(&json!(17), "2026-01-01T00:00:03.000Z");
        for status in ["pending", "in_progress"] {
            acp(
                &mut t,
                json!({"sessionUpdate":"tool_call_update","toolCallId":"command","status":status}),
                "2026-01-01T00:00:04.000Z",
            );
            let revision = t.revision;
            acp(
                &mut t,
                json!({"sessionUpdate":"tool_call_update","toolCallId":"write","status":"completed","rawOutput":{"text":format!("late file output during {status}")}}),
                "2026-01-01T00:00:05.000Z",
            );
            assert!(t.revision > revision);
            let snapshot = t.session(string(&info, "id"), &info, "arc-task", None);
            assert_eq!(snapshot["phase"], "command");
            assert_eq!(snapshot["headline"], "printf example");
            assert_eq!(snapshot["phaseSince"], command_start);
            assert!(snapshot.get("interaction").is_none());
        }
        acp(
            &mut t,
            json!({"sessionUpdate":"tool_call_update","toolCallId":"command","status":"completed"}),
            "2026-01-01T00:00:06.000Z",
        );
        assert_eq!(
            t.session(string(&info, "id"), &info, "arc-task", None)["phase"],
            "command"
        );
        acp(
            &mut t,
            json!({"sessionUpdate":"tool_call_update","toolCallId":"write","status":"completed","rawOutput":{"text":"final file output"}}),
            "2026-01-01T00:00:07.000Z",
        );
        let snapshot = t.session(string(&info, "id"), &info, "arc-task", None);
        assert_eq!(snapshot["phase"], "file");
        assert_eq!(snapshot["phaseSince"], AT);
    }
    #[test]
    fn headlines_are_plain_text_without_changing_commands_or_paths() {
        // Property: headlines are plain text without changing commands or paths.
        for (source, expected) in [
            (
                "**Configuring session timing**",
                "Configuring session timing",
            ),
            ("**Configuring session timin…", "Configuring session timin…"),
            ("## **Session configuration**", "Session configuration"),
            ("First sentence. **Last sentence.**", "Last sentence."),
            (
                "Use `session_config` with *defaults* and _options_.",
                "Use session_config with defaults and options.",
            ),
            (
                "See [the guide](https://example.test/guide).",
                "See the guide.",
            ),
            (
                "Read [guide][reference] and ![diagram](image.png).",
                "Read guide and diagram.",
            ),
            (
                "Keep snake_case_name intact.",
                "Keep snake_case_name intact.",
            ),
            ("~~Old~~ **New**", "Old New"),
        ] {
            assert_eq!(headline("text", source), expected, "{source}");
        }
        assert_eq!(
            headline("thinking", "First line\n### **Last thought**"),
            "Last thought"
        );
        assert_eq!(
            headline("command", "printf '**example**' && echo `pwd`"),
            "printf '**example**' && echo `pwd`"
        );
        assert_eq!(
            headline("file", "/example/snake_case/file_name.rs"),
            "/example/snake_case/file_name.rs"
        );
    }
    #[test]
    fn permission_backfill_preserves_request_and_respond_identity() {
        // Property: permission backfill preserves request and respond identity.
        let mut t = Timeline::default();
        acp(
            &mut t,
            json!({"sessionUpdate":"tool_call","toolCallId":"read-1","title":"Read example","rawInput":{"file_path":"src/example.rs"}}),
            AT,
        );
        let mut req = json!({"id":17,"method":"session/request_permission","params":{"toolCall":{"toolCallId":"read-1"},"options":[{"optionId":"allow","kind":"allow_once"}]}});
        t.enrich_permission(&mut req);
        assert_eq!(req["params"]["toolCall"]["path"], "src/example.rs");
        assert_eq!(req["params"]["toolCall"]["title"], "Read example");
        assert_eq!(req["id"], 17);
        t.agent("session/request_permission", &req, LATER);
        let info = json!({"id":"task","taskId":"task","agent":"example","startedAt":AT});
        let snapshot = t.session(string(&info, "id"), &info, "arc-task", None);
        assert_eq!(snapshot["phase"], "interaction");
        assert_eq!(snapshot["headline"], "src/example.rs");
        assert_eq!(
            snapshot["interaction"]["respond"]["args"],
            json!({"agent":"example","taskId":"task","interactionId":17})
        );
        t.resolve(&json!(17), LATER);
        assert_eq!(t.entries.last().unwrap()["status"], "completed");
    }
    #[test]
    fn exit_code_is_conservative_and_raw_output_wins() {
        // Property: exit code is conservative and raw output wins.
        assert_eq!(exit_code(&json!({"exitCode":3}), "Exit code: 0"), Some(3));
        assert_eq!(
            exit_code(&Value::Null, "all tests passed: 0 failures"),
            None
        );
        assert_eq!(exit_code(&Value::Null, "example says Exit code: 2"), None);
        assert_eq!(exit_code(&Value::Null, "Exit code: 2 (example)"), None);
        let mut t = fixture();
        acp(
            &mut t,
            json!({"sessionUpdate":"tool_call_update","toolCallId":"cmd-example","content":[{"content":{"text":"Exit code: 7"}}]}),
            LATER,
        );
        assert_eq!(t.entries[2]["exitCode"], 0);
        assert_eq!(t.entries[2]["status"], "completed");
        // The fixture turn has ended; a running command requires a new turn.
        t.agent(
            "arc/user",
            &json!({"turnId":"next","text":"Run command"}),
            AT,
        );
        acp(
            &mut t,
            json!({"sessionUpdate":"tool_call","toolCallId":"pending-command","title":"Bash","status":"pending"}),
            AT,
        );
        acp(
            &mut t,
            json!({"sessionUpdate":"tool_call_update","toolCallId":"pending-command","status":"in_progress"}),
            LATER,
        );
        assert_eq!(t.entries.last().unwrap()["status"], "running");
        assert_eq!(
            tool_kind("other", "mcp__files__read_file", &json!({})),
            ("file", Some("read"))
        );
        t.agent(
            "arc/settled",
            &json!({"status":"failed","error":"Example error"}),
            LATER,
        );
        assert!(t
            .entries
            .iter()
            .any(|r| r["type"] == "error" && r["text"] == "Example error"));
    }
    #[test]
    fn secrets_redacted_before_summary_truncation_and_across_chunks() {
        // Property: secrets redacted before summary truncation and across chunks.
        let input = json!({"command":"echo example","nested":{"api_key":"fixture-only-value","refreshToken":"fixture-only-refresh"}});
        let out = summary(&input).to_string();
        assert!(!out.contains("fixture-only-value"));
        assert!(!out.contains("fixture-only-refresh"));
        for raw in [
            "Authorization: Bearer example-token",
            "API_KEY=example-secret",
            "password='example with spaces'",
            "https://example:password@example.test/",
            "-----BEGIN PRIVATE KEY-----\nexample-key\n-----END PRIVATE KEY-----",
        ] {
            assert!(redact(raw).contains("[REDACTED]"), "{raw}");
        }
        let mut t = Timeline::default();
        acp(
            &mut t,
            json!({"sessionUpdate":"agent_message_chunk","content":{"text":"Bearer example-"}}),
            AT,
        );
        acp(
            &mut t,
            json!({"sessionUpdate":"agent_message_chunk","content":{"text":"secret"}}),
            LATER,
        );
        assert_eq!(t.entries[0]["text"], "[REDACTED]");
        assert!(!serde_json::to_string(&t)
            .unwrap()
            .contains("example-secret"));
        let unicode_text = "字".repeat(1024);
        assert_eq!(summary(&json!(unicode_text))["truncated"], true);
    }
    #[test]
    fn bounded_window_and_text_report_partial_and_survive_persistence() {
        // Property: bounded window and text report partial and survive persistence.
        let mut t = Timeline::default();
        for i in 0..=MAX_ENTRIES {
            t.put(
                json!({"id":i.to_string(),"type":"command","status":"completed"}),
                AT,
            );
        }
        assert_eq!(t.entries.len(), MAX_ENTRIES);
        assert_eq!(t.response("example", 0)["coverage"]["state"], "partial");
        assert_eq!(t.execution_evidence(), "partial");
        let saved: Timeline = serde_json::from_value(serde_json::to_value(&t).unwrap()).unwrap();
        assert_eq!(saved.response("example", 0), t.response("example", 0));
        let mut text = Timeline::default();
        acp(
            &mut text,
            json!({"sessionUpdate":"agent_message_chunk","content":{"text":"a".repeat(MAX_TEXT+1)}}),
            AT,
        );
        assert_eq!(text.entries[0]["text"].as_str().unwrap().len(), MAX_TEXT);
        assert!(text.partial);
    }
    #[test]
    fn pi_streams_final_messages_tools_and_interactions_without_duplicates() {
        // Property: pi streams final messages tools and interactions without duplicates.
        let mut t = Timeline::default();
        t.agent("arc/user", &json!({"turnId":"turn","text":"Example"}), AT);
        for part in ["first ", "message"] {
            t.agent("message_update",&json!({"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":part}}),AT);
        }
        t.agent("message_end",&json!({"message":{"role":"assistant","content":[{"type":"text","text":"first message"}]}}),LATER);
        t.agent(
            "tool_execution_start",
            &json!({"toolCallId":"tool","toolName":"bash","args":{"command":"true"}}),
            LATER,
        );
        t.agent("tool_execution_end",&json!({"toolCallId":"tool","toolName":"bash","result":{"content":[{"type":"text","text":"Exit code: 0"}]},"isError":false}),LATER);
        t.agent("message_end",&json!({"message":{"role":"assistant","content":[{"type":"text","text":"second message"}]}}),LATER);
        t.agent("extension_ui_request",&json!({"id":"question","method":"select","title":"Choose an option","options":["A","B"]}),LATER);
        assert_eq!(t.entries.iter().filter(|r| r["type"] == "text").count(), 2);
        assert_eq!(t.evidence(None)[0]["exitCode"], 0);
        assert_eq!(t.entries.last().unwrap()["interaction"]["kind"], "question");
        t.resolve(&json!("question"), LATER);
        t.agent("agent_settled", &json!({}), LATER);
        assert_eq!(t.status, "completed");
    }
    #[test]
    fn codex_typed_items_deltas_and_pending_requests() {
        // Property: codex typed items deltas and pending requests.
        let mut t = Timeline::default();
        t.codex("turn/started", &json!({"turn":{"id":"turn"}}), AT);
        t.codex(
            "item/started",
            &json!({"turnId":"turn","item":{"id":"reason","type":"reasoning","summary":[]}}),
            AT,
        );
        t.codex(
            "item/reasoning/summaryTextDelta",
            &json!({"itemId":"reason","delta":"Inspect the example"}),
            LATER,
        );
        let cursor = t.revision;
        t.codex(
            "item/completed",
            &json!({"item":{"id":"reason","type":"reasoning","summary":["Inspect the example"]}}),
            LATER,
        );
        assert_eq!(
            t.response("example", cursor)["entries"][0]["text"],
            "Inspect the example"
        );
        let requests = vec![
            json!({"id":1,"method":"item/commandExecution/requestApproval","params":{"command":"printf example"},"canRespond":true,"next":{"via":"act","op":"codex_respond","args":{"id":"1","backendSession":"example"}}}),
        ];
        t.sync_interactions(&requests, LATER);
        let revision = t.revision;
        t.sync_interactions(&requests, "2026-01-01T00:00:02.000Z");
        assert_eq!(t.revision, revision);
        assert_eq!(
            t.session("example", &json!({"id":"example"}), "codex-thread", None)["interaction"]
                ["respond"]["op"],
            "codex_respond"
        );
        t.sync_interactions(&[], LATER);
        t.codex("item/completed",&json!({"item":{"id":"command","type":"commandExecution","command":"printf example","cwd":"/workspace/example","exitCode":0,"aggregatedOutput":"example"}}),LATER);
        t.codex(
            "turn/completed",
            &json!({"turn":{"status":"completed"}}),
            LATER,
        );
        assert_eq!(t.evidence(None)[0]["exitCode"], 0);
        assert_eq!(t.status, "completed");
    }
    #[tokio::test]
    async fn shared_codex_event_window_marks_only_observed_thread_partial() {
        // Regression: event eviction must not mark an unrelated thread as partial.
        let events: SharedEvents = Default::default();
        events
            .lock()
            .await
            .timelines
            .insert("example".into(), Timeline::default());
        crate::event(
            &events,
            "backend",
            "turn/started",
            json!({"threadId":"example","turn":{"id":"turn"}}),
        )
        .await;
        for _ in 0..2000 {
            crate::event(&events, "backend", "unrelated", json!({})).await;
        }
        let e = events.lock().await;
        assert!(e.timelines["example"].partial);
        assert_eq!(e.rows.len(), 2000);
    }
}
