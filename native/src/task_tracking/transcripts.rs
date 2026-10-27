//! Native transcript framing feeds the same entry converters as live streams.
use super::*;

impl Timeline {
    pub fn transcript_turn_start(&self) -> Option<(&str, &str)> {
        self.turn_started_at
            .as_deref()
            .map(|at| (self.turn.as_str(), at))
    }
    pub fn prompt_headline(&self) -> String {
        self.entries
            .iter()
            .filter(|row| row["type"] == "user")
            .map(|row| transcript_title_text(string(row, "text")))
            .find(|text| !text.is_empty())
            .unwrap_or_default()
    }
    fn transcript_metadata(&mut self, record: &Value) {
        if self.info.is_null() {
            self.info = json!({});
        }
        if self.info["startedAt"].is_null() && record["timestamp"].is_string() {
            self.info["startedAt"] = record["timestamp"].clone();
        }
        let payload = &record["payload"];
        if let Some(project) = record["cwd"].as_str().or_else(|| payload["cwd"].as_str()) {
            self.info["project"] = json!(project);
        }
        if let Some(id) = record["sessionId"].as_str().or_else(|| {
            (record["type"] == "session_meta")
                .then(|| payload["id"].as_str())
                .flatten()
        }) {
            self.info["id"] = json!(id);
        }
    }

    pub fn backfill_transcript(&mut self, agent: &str, records: &[Value]) {
        if agent == "claude" {
            self.backfill_claude(records);
        } else {
            self.backfill_codex_records(records);
        }
    }

    /// Rollout framing is translated to native item inputs, then uses codex_item
    /// just like app-server history and live item notifications.
    pub fn backfill_codex_records(&mut self, records: &[Value]) {
        for record in records {
            self.transcript_metadata(record);
            let at = string(record, "timestamp");
            let p = &record["payload"];
            if record["type"] == "turn_context" {
                if let Some(turn) = p["turn_id"].as_str() {
                    self.turn = turn.into();
                }
                continue;
            }
            if record["type"] == "event_msg" {
                match string(p, "type") {
                    "task_started" => {
                        self.codex("turn/started", &json!({"turn":{"id":p["turn_id"]}}), at);
                        self.transcript_activity = Some((at.into(), 90));
                    }
                    "task_complete" | "turn_aborted" => self.finish(
                        if p["type"] == "task_complete" {
                            "completed"
                        } else {
                            "cancelled"
                        },
                        at,
                    ),
                    "warning" => self.notice(None, "warning", "message", p, at),
                    "stream_error" => self.notice(None, "retry", "start", p, at),
                    "context_compacted" => self.notice(None, "compaction", "end", p, at),
                    _ => (),
                }
                continue;
            }
            if record["type"] == "compacted" {
                self.notice(None, "compaction", "end", p, at);
                continue;
            }
            if record["type"] != "response_item" {
                continue;
            }
            let generated_id = format!("rollout:{}", self.revision + 1);
            let id = p["id"]
                .as_str()
                .or_else(|| p["call_id"].as_str())
                .unwrap_or(&generated_id);
            match string(p, "type") {
                "message" => {
                    let role = string(p, "role");
                    if !matches!(role, "user" | "assistant") {
                        continue;
                    }
                    let raw = content(&p["content"]);
                    let text = if role == "user" {
                        transcript_user_text(record, &raw)
                    } else {
                        transcript_text(&raw)
                    };
                    if text.trim().is_empty() {
                        continue;
                    }
                    self.codex_item(&json!({"id":id,"type":if role == "user" {"userMessage"} else {"agentMessage"},"content":text,"text":text,"phase":p["phase"],"inputOrigin":if role == "user" { json!("human") } else { Value::Null }}), "completed", at);
                }
                "reasoning" => self.codex_item(
                    &json!({"id":id,"type":"reasoning","summary":p["summary"]}),
                    "completed",
                    at,
                ),
                "function_call" | "custom_tool_call" | "local_shell_call" => {
                    let input = if p["type"] == "local_shell_call" {
                        let command = p["action"]["command"].as_array().map(|parts| {
                            parts
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(" ")
                        });
                        json!({"command":command,"cwd":p["action"]["working_directory"]})
                    } else {
                        parsed_input(p.get("arguments").unwrap_or(&p["input"]))
                    };
                    self.tool(&json!({"toolCallId":p.get("call_id").unwrap_or(&json!(id)),"title":p["name"],"rawInput":input,"status":"unknown"}), at);
                    self.transcript_activity = Some((at.into(), 300));
                }
                "function_call_output" | "custom_tool_call_output" => {
                    self.tool(&json!({"toolCallId":p["call_id"],"rawOutput":p["output"],"status":"completed"}), at);
                    self.transcript_activity = Some((at.into(), 90));
                }
                "web_search_call" | "tool_search_call" => {
                    self.codex_item(&json!({"id":id,"type":"dynamicToolCall","tool":p["type"],"arguments":p["action"]}), "unknown", at);
                    self.transcript_activity = Some((at.into(), 300));
                }
                "tool_search_output" => {
                    self.transcript_activity = Some((at.into(), 90));
                }
                _ => self.partial = true,
            }
        }
    }

    pub fn transcript_active(
        &self,
        modified: std::time::SystemTime,
        now: std::time::SystemTime,
    ) -> bool {
        if self.entries.is_empty() && self.omitted_sidechain_records > 0 {
            return false;
        }
        if matches!(self.status.as_str(), "completed" | "failed" | "cancelled") {
            return false;
        }
        let (at, grace) = self
            .transcript_activity
            .as_ref()
            .map(|(at, grace)| {
                (
                    chrono::DateTime::parse_from_rfc3339(at)
                        .ok()
                        .map(|at| std::time::SystemTime::from(at.with_timezone(&chrono::Utc)))
                        .unwrap_or(modified),
                    *grace,
                )
            })
            .unwrap_or((modified, 30));
        now.duration_since(at).unwrap_or_default() <= std::time::Duration::from_secs(grace)
    }

    pub fn transcript_session(&self, id: &str, agent: &str) -> Value {
        let mut info = self.info.clone();
        if !info.is_object() {
            info = json!({});
        }
        info["id"] = json!(id);
        info["title"] = json!(self.prompt_headline());
        let mut row = self.session(&info, "transcript", None);
        // A transcript's user prompt represents thinking while native work starts.
        if row["phase"] == "idle" {
            row["phase"] = json!("thinking");
        }
        if agent == "codex" {
            if let Some(open) = crate::agents::driver::AgentDriver::CodexNative.navigation(id) {
                row["open"] = open;
            }
        }
        row
    }
    /// Local Claude history uses the same text/tool vocabulary, without approvals.
    pub fn backfill_claude(&mut self, records: &[Value]) {
        for record in records {
            if record["isSidechain"] == true {
                self.omitted_sidechain_records += 1;
                continue;
            }
            let at = string(record, "timestamp");
            self.transcript_metadata(record);
            if record["type"] == "system" && record["subtype"] == "compact_boundary" {
                self.notice(
                    record["uuid"].as_str(),
                    "compaction",
                    "end",
                    &record["compactMetadata"],
                    at,
                );
                continue;
            }
            let role = record["message"]["role"]
                .as_str()
                .unwrap_or_else(|| string(record, "type"));
            if !matches!(role, "user" | "assistant")
                || role == "assistant" && record["isMeta"] == true
            {
                continue;
            }
            if at.is_empty() {
                self.partial = true;
                continue;
            }
            let native_id = string(record, "uuid");
            let generated_id;
            let id = if native_id.is_empty() {
                // Missing identity must not discard native content. Keep the
                // fallback stable across tail/history reads, with partial coverage.
                self.partial = true;
                generated_id = format!("claude:{}", hash(record.to_string()));
                generated_id.as_str()
            } else {
                native_id
            };
            if record["cwd"].is_string() {
                self.info["project"] = record["cwd"].clone();
            }
            let raw = &record["message"]["content"];
            let blocks = if raw.is_string() {
                vec![json!({"type":"text","text":raw})]
            } else {
                raw.as_array().cloned().unwrap_or_default()
            };
            let user_text = blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .map(|b| transcript_user_text(record, string(b, "text")))
                .collect::<Vec<_>>()
                .join("\n");
            if role == "user"
                && user_text.trim().is_empty()
                && blocks.iter().any(|block| {
                    block["type"] == "text" && !string(block, "text").trim().is_empty()
                })
                && !blocks.iter().any(|block| block["type"] == "tool_result")
            {
                continue;
            }
            if role == "user" && !user_text.trim().is_empty() {
                self.turn = id.into();
                self.turn_started_at = Some(at.into());
                self.status.clear();
                self.start_turn(at);
            }
            if role == "assistant" && record["message"]["model"] != "<synthetic>" {
                if let Some(summary) = crate::egress::dispatch_summary(&json!({
                    "model": record["message"]["model"],
                    "effort": record.get("perTurnEffort").filter(|value| value.as_str().is_some_and(|s| !s.is_empty())).unwrap_or(&record["effort"])
                })) {
                    if !self.turn.is_empty() {
                        self.turn_dispatch_summaries
                            .insert(self.turn.clone(), summary);
                    }
                }
            }
            self.transcript_activity = Some((
                at.into(),
                if role == "assistant" && record["message"]["stop_reason"] == "tool_use" {
                    300
                } else {
                    90
                },
            ));
            for (index, block) in blocks.iter().enumerate() {
                match string(block, "type") {
                    "text" | "thinking" => {
                        let thinking = block["type"] == "thinking";
                        let raw = string(block, if thinking { "thinking" } else { "text" });
                        let text = if role == "user" {
                            transcript_user_text(record, raw)
                        } else {
                            transcript_text(raw)
                        };
                        if text.trim().is_empty() && !thinking {
                            continue;
                        }
                        let (text, truncated) = cut(&redact(&text), MAX_TEXT);
                        let mut row = json!({"id":format!("{id}:{index}"),"type":if role == "user" {"user"} else if thinking {"thinking"} else {"text"},"status":"completed","text":text,"truncated":truncated});
                        if role == "user" {
                            row["inputOrigin"] = json!("human");
                        }
                        self.put(row, at);
                    }
                    "tool_use" => {
                        self.tool(&json!({"toolCallId":block["id"],"title":block["name"],"rawInput":block["input"],"status":"unknown"}), at);
                        // A request alone does not establish execution or an end time.
                        if let Some(row) = self.entries.iter_mut().find(|r| r["id"] == block["id"])
                        {
                            row.as_object_mut().unwrap().remove("endedAt");
                        }
                    }
                    "tool_result" => {
                        if !self.entries.iter().any(|e| e["id"] == block["tool_use_id"]) {
                            self.partial = true;
                        }
                        self.tool(&json!({"toolCallId":block["tool_use_id"],"rawOutput":block["content"],"status":if block["is_error"] == true {"failed"} else {"completed"}}), at);
                    }
                    _ => self.partial = true,
                }
            }
            if role == "user" && user_text.contains("[Request interrupted by user") {
                self.finish("cancelled", at);
            }
            if role == "assistant"
                && matches!(
                    string(&record["message"], "stop_reason"),
                    "end_turn" | "stop_sequence"
                )
            {
                self.finish("completed", at);
            }
        }
    }
}

fn transcript_title_text(text: &str) -> String {
    use std::sync::LazyLock;
    static NOISE: LazyLock<Vec<regex::Regex>> = LazyLock::new(|| {
        [
        r"(?is)<(?:attached-file|image|file)\b[^>]*?/>",
        r"(?is)<(?:caveat|attached-file|file|image)(?:\s[^>]*)?>.*?(?:</(?:caveat|attached-file|file|image)>|\z)",
        r"(?i)\[(?:image(?:\s*#?\d+)?|attached[ -]?(?:file|image)(?:[^\]\n]*)|file:[^\]\n]*|image:[^\]\n]*)\]",
    ].into_iter().map(|pattern| regex::Regex::new(pattern).unwrap()).collect()
    });
    let mut text = text.to_owned();
    for pattern in NOISE.iter() {
        text = pattern.replace_all(&text, " ").into_owned();
    }
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect()
}

/// Native naming is independent of recent activity and timeline tail windows.
#[derive(Default)]
pub(crate) struct TranscriptTitle {
    custom: Option<String>,
    prompt: Option<String>,
    summary: Option<String>,
}
impl TranscriptTitle {
    pub(crate) fn observe(&mut self, record: &Value) {
        if record["isSidechain"] == true {
            return;
        }
        let explicit = match string(record, "type") {
            "custom-title" => record["customTitle"].as_str(),
            "session_info" => record["name"].as_str(),
            _ => None,
        };
        if let Some(text) = explicit.filter(|text| !text.trim().is_empty()) {
            self.custom = Some(
                text.split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(80)
                    .collect(),
            );
        }
        if record["type"] == "summary" {
            if let Some(text) = record["summary"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
            {
                let cleaned = transcript_title_text(&transcript_user_text(record, text));
                if !cleaned.is_empty() {
                    self.summary = Some(cleaned);
                }
            }
        }
        if self.prompt.is_none()
            && record["isMeta"] != true
            && record["isCompactSummary"] != true
            && (record["message"]["role"] == "user" || record["type"] == "user")
        {
            let raw = &record["message"]["content"];
            let text = if let Some(text) = raw.as_str() {
                text.to_owned()
            } else {
                raw.as_array()
                    .into_iter()
                    .flatten()
                    .filter(|b| b["type"] == "text")
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            let cleaned = transcript_title_text(&transcript_user_text(record, &text));
            if !cleaned.is_empty() {
                self.prompt = Some(cleaned);
            }
        }
    }
    pub(crate) fn value(&self) -> Option<&str> {
        self.custom
            .as_deref()
            .or(self.prompt.as_deref())
            .or(self.summary.as_deref())
    }
}
