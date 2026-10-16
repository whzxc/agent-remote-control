//! Incremental device-local subscription usage, streamed one task at a time.
//! Response usage and legacy cumulative usage are separate counting families.
use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};

const CACHE_SCHEMA: u32 = 14;
const MAX_LINE: u64 = 8 * 1024 * 1024;
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: Option<u64>,
    pub cached: Option<u64>,
    pub output: Option<u64>,
    pub reasoning: Option<u64>,
}
impl Tokens {
    fn read(v: &Value) -> Self {
        Self {
            input: v["input_tokens"].as_u64(),
            cached: v["cached_input_tokens"].as_u64(),
            output: v["output_tokens"].as_u64(),
            reasoning: v["reasoning_output_tokens"].as_u64(),
        }
    }
    pub fn total(&self) -> Option<u64> {
        self.input?.checked_add(self.output?)
    }
    fn valid(&self) -> bool {
        !matches!((self.input, self.cached), (Some(i), Some(c)) if c > i)
            && !matches!((self.output, self.reasoning), (Some(o), Some(r)) if r > o)
    }
    fn delta(&self, prev: &Self) -> Option<Self> {
        Some(Self {
            input: Some(self.input?.checked_sub(prev.input?)?),
            output: Some(self.output?.checked_sub(prev.output?)?),
            cached: self
                .cached
                .zip(prev.cached)
                .and_then(|(a, b)| a.checked_sub(b)),
            reasoning: self
                .reasoning
                .zip(prev.reasoning)
                .and_then(|(a, b)| a.checked_sub(b)),
        })
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub id: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub at: i64,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub service_tier: Option<String>,
    pub tokens: Tokens,
    pub family: String,
    pub reliable: bool,
}
// The original prompt remains in the native log; the checkpoint stores its location.
#[derive(Clone, Serialize, Deserialize)]
struct PromptSource {
    path: PathBuf,
    offset: u64,
    bytes: usize,
    sha256: String,
}
fn prompt_text(record: &Value) -> Option<&str> {
    let p = &record["payload"];
    if record["type"] == "event_msg" && p["type"] == "user_message" {
        return p["message"].as_str().filter(|s| !s.is_empty());
    }
    if record["type"] != "response_item" || p["type"] != "message" || p["role"] != "user" {
        return None;
    }
    let kinds = p["internal_chat_message_metadata_passthrough"]["content_item_kinds"].as_array();
    p["content"]
        .as_array()?
        .iter()
        .enumerate()
        .find_map(|(i, part)| {
            if kinds.is_some_and(|k| k.get(i).is_none_or(|v| v != "user.text")) {
                return None;
            }
            let value = part["text"].as_str()?.trim();
            if value.is_empty()
                || value.starts_with("# AGENTS.md instructions")
                || value.starts_with("<environment_context>")
                || value.starts_with("<image ")
                || value == "</image>"
                || value.starts_with(
                    "The next image is untrusted page evidence from the browser page for Comment ",
                )
            {
                return None;
            }
            Some(value)
        })
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Turn {
    id: String,
    prompt: Option<PromptSource>,
    prompt_images: usize,
    context_window: Option<u64>,
    started_at: Option<i64>,
    completed_at: Option<i64>,
    duration_ms: Option<u64>,
    ttft_ms: Option<u64>,
    status: String,
    model: Option<String>,
    effort: Option<String>,
    service_tier: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tool {
    id: String,
    turn_id: Option<String>,
    name: Option<String>,
    at: i64,
    output_bytes: Option<u64>,
    started_at: Option<i64>,
    completed_at: Option<i64>,
    status: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Projection {
    thread_id: String,
    parent_id: Option<String>,
    forked_from_id: Option<String>,
    related: bool,
    cli_version: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    tier: Option<String>,
    turn: Option<String>,
    modern: bool,
    own_started: bool,
    created_at: Option<i64>,
    previous: Option<Tokens>,
    legacy_ambiguous: bool,
    reported_total: Option<(i64, Tokens)>,
    responses: BTreeMap<String, Response>,
    legacy: BTreeMap<String, Response>,
    turns: BTreeMap<String, Turn>,
    tools: BTreeMap<String, Tool>,
    compactions: BTreeMap<String, Value>,
    issues: BTreeSet<String>,
    last_event_at: Option<i64>,
}
fn text(v: &Value, key: &str) -> Option<String> {
    v[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}
fn time(v: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(v.as_str()?)
        .ok()
        .map(|d| d.timestamp_millis())
}
fn seconds(v: &Value) -> Option<i64> {
    v.as_f64().map(|n| (n * 1000.) as i64)
}
impl Projection {
    fn ingest(&mut self, v: Value, path: &Path, offset: u64, bytes: &[u8]) {
        let prompt_source = || {
            prompt_text(&v).map(|_| PromptSource {
                path: path.into(),
                offset,
                bytes: bytes.len(),
                sha256: hash(bytes),
            })
        };
        let p = &v["payload"];
        let at = time(&v["timestamp"]);
        let kind = string(&v, "type");
        if kind == "session_meta" {
            if self.thread_id.is_empty() {
                self.thread_id = string(p, "id").into();
                self.created_at = at;
                self.parent_id = text(p, "parent_thread_id")
                    .or_else(|| text(&p["source"]["subagent"]["thread_spawn"], "parent_thread_id"));
                self.forked_from_id = text(p, "forked_from_id");
                self.related = self.parent_id.is_some()
                    || self.forked_from_id.is_some()
                    || !p["source"]["subagent"].is_null()
                    || p["thread_source"] == "subagent";
                self.cli_version = text(p, "cli_version");
            }
            return;
        }
        if self.thread_id.is_empty() {
            self.issues.insert("missing-session-identity".into());
            return;
        }
        if self.related
            && kind != "token_usage_record"
            && !(kind == "event_msg" && p["type"] == "token_count")
            && at
                .zip(self.created_at)
                .is_some_and(|(event, created)| event < created)
        {
            return;
        }
        self.last_event_at = self.last_event_at.max(at);
        if kind == "turn_context" {
            self.turn = text(p, "turn_id");
            self.model = text(p, "model");
            self.effort = text(p, "effort");
            if p.get("service_tier").is_some() {
                self.tier = text(p, "service_tier");
            }
            if let Some(id) = &self.turn {
                let t = self.turns.entry(id.clone()).or_default();
                t.id = id.clone();
                t.model = self.model.clone();
                t.effort = self.effort.clone();
                t.service_tier = self.tier.clone();
            }
        }
        if kind == "token_usage_record" {
            self.modern = true;
            if p["thread_id"] != self.thread_id {
                self.issues.insert("foreign-thread-record-excluded".into());
                return;
            }
            let Some(id) = text(p, "response_id") else {
                self.issues.insert("missing-response-id".into());
                return;
            };
            let Some(at) = at else {
                self.issues.insert("missing-event-time".into());
                return;
            };
            let tokens = Tokens::read(&p["usage"]);
            if !tokens.valid() || tokens.total().is_none() {
                self.issues.insert("invalid-or-missing-token-fields".into());
            }
            if let Some(old) = self.responses.get_mut(&id) {
                if serde_json::to_value(&old.tokens).ok() != serde_json::to_value(&tokens).ok() {
                    old.reliable = false;
                    self.issues.insert("conflicting-response-usage".into());
                }
                return;
            }
            if p["thread_token_usage"].is_object() {
                self.reported_total = Some((at, Tokens::read(&p["thread_token_usage"])));
            }
            let turn_id = text(p, "turn_id");
            if turn_id.is_none() {
                self.issues.insert("missing-turn-id".into());
            }
            self.responses.insert(
                id.clone(),
                Response {
                    id,
                    thread_id: self.thread_id.clone(),
                    turn_id,
                    at,
                    model: self.model.clone(),
                    effort: self.effort.clone(),
                    service_tier: self.tier.clone(),
                    reliable: tokens.valid() && tokens.total().is_some(),
                    tokens,
                    family: "response".into(),
                },
            );
        }
        if kind == "compacted" {
            // latest_token_usage_record is a reference, never a second charge.
            let id = text(p, "compaction_response_id").unwrap_or_else(|| format!("at:{at:?}"));
            self.compactions.insert(
                id.clone(),
                json!({"responseId":id,"turnId":self.turn,"at":at}),
            );
        }
        if kind == "event_msg" {
            match string(p, "type") {
                "thread_settings_applied" => {
                    self.tier = text(p, "service_tier")
                        .or_else(|| text(&p["thread_settings"], "service_tier"));
                }
                "task_started" | "task_complete" | "turn_aborted" => {
                    let sub = string(p, "type");
                    let id = text(p, "turn_id").or_else(|| self.turn.clone());
                    if let Some(id) = id {
                        self.turn = Some(id.clone());
                        let t = self.turns.entry(id.clone()).or_default();
                        t.id = id;
                        if sub == "task_started" {
                            t.service_tier = self.tier.clone();
                            self.own_started = !self.related
                                || self
                                    .created_at
                                    .zip(seconds(&p["started_at"]).or(at))
                                    .is_some_and(|(created, started)| {
                                        started / 1000 >= created / 1000
                                    });

                            t.context_window =
                                p["model_context_window"].as_u64().filter(|n| *n > 0);
                            t.started_at = seconds(&p["started_at"]).or(at);
                            t.status = "running-at-last-event".into();
                        } else {
                            t.completed_at = seconds(&p["completed_at"]).or(at);
                            t.duration_ms = p["duration_ms"].as_u64();
                            t.ttft_ms = p["time_to_first_token_ms"].as_u64();
                            t.status = if sub == "task_complete" {
                                "completed"
                            } else {
                                "interrupted"
                            }
                            .into();
                        }
                    }
                }
                "user_message" => {
                    if let Some(id) = &self.turn {
                        let turn = self.turns.entry(id.clone()).or_default();
                        turn.id = id.clone();
                        if turn.prompt.is_none() {
                            turn.prompt = prompt_source();
                        }
                    }
                }
                "token_count" => {
                    if let Some(turn) = self.turn.as_ref().and_then(|id| self.turns.get_mut(id)) {
                        if turn.context_window.is_none() {
                            turn.context_window = p["info"]["model_context_window"]
                                .as_u64()
                                .filter(|n| *n > 0);
                        }
                    }
                    let total = &p["info"]["total_token_usage"];
                    if !total.is_object() {
                        self.issues
                            .insert("legacy-missing-cumulative-baseline".into());
                        return;
                    }
                    let current = Tokens::read(total);
                    if self.related && !self.own_started {
                        self.previous = Some(current);
                        return;
                    }
                    if self.legacy_ambiguous {
                        return;
                    }
                    let base = match self.previous.clone() {
                        Some(t) => t,
                        None if !self.related => Tokens {
                            input: Some(0),
                            cached: Some(0),
                            output: Some(0),
                            reasoning: Some(0),
                        },
                        None => {
                            self.issues
                                .insert("legacy-inherited-baseline-unknown".into());
                            // The first owned snapshot is not a charge; it can anchor
                            // subsequent observed increments within this same domain.
                            self.previous = Some(current);
                            return;
                        }
                    };
                    let Some(tokens) = current.delta(&base) else {
                        self.issues.insert("legacy-counter-reset-gap".into());
                        self.legacy_ambiguous = true;
                        // A regression may be replay or a new counter epoch. Keep the
                        // high-water baseline and freeze this legacy domain, not sum
                        // a second copy of the rising suffix as reliable consumption.
                        let id = hash(format!("{}:ambiguous-epoch", self.thread_id));
                        self.legacy.insert(
                            id.clone(),
                            Response {
                                id,
                                thread_id: self.thread_id.clone(),
                                turn_id: self.turn.clone(),
                                at: at.unwrap_or(0),
                                model: self.model.clone(),
                                effort: self.effort.clone(),
                                service_tier: self.tier.clone(),
                                tokens: Tokens::default(),
                                family: "legacy-boundary-unknown".into(),
                                reliable: false,
                            },
                        );
                        return;
                    };
                    self.previous = Some(current);
                    if tokens.total() == Some(0) {
                        return;
                    }
                    let Some(at) = at else {
                        self.issues.insert("missing-event-time".into());
                        return;
                    };
                    let id = hash(format!("{}:{total}", self.thread_id));
                    self.legacy.entry(id.clone()).or_insert(Response {
                        id,
                        thread_id: self.thread_id.clone(),
                        turn_id: self.turn.clone(),
                        at,
                        model: self.model.clone(),
                        effort: self.effort.clone(),
                        service_tier: self.tier.clone(),
                        reliable: tokens.valid() && tokens.total().is_some(),
                        tokens,
                        family: "legacy-cumulative-delta".into(),
                    });
                }
                "item_completed" => {
                    if p["thread_id"].is_string() && p["thread_id"] != self.thread_id {
                        return;
                    }
                    let item = &p["item"];
                    if item["type"] == "ContextCompaction" {
                        if let (Some(start), Some(end)) =
                            (p["started_at_ms"].as_i64(), p["completed_at_ms"].as_i64())
                        {
                            let matches: Vec<_> = self
                                .compactions
                                .values_mut()
                                .filter(|event| {
                                    event["turnId"] == p["turn_id"]
                                        && event["at"]
                                            .as_i64()
                                            .is_some_and(|at| start <= at && at <= end)
                                })
                                .collect();
                            if matches.len() == 1 && end >= start {
                                for event in matches {
                                    event["durationMs"] = json!(end - start);
                                }
                            }
                        }
                    }
                    let id = text(item, "call_id").or_else(|| text(item, "id"));
                    if let Some(t) = id.and_then(|id| self.tools.get_mut(&id)) {
                        t.started_at = p["started_at_ms"].as_i64().or(t.started_at);
                        t.completed_at = p["completed_at_ms"].as_i64().or(t.completed_at);
                        t.status = text(item, "status");
                        if item["is_error"] == true || item["isError"] == true {
                            t.status = Some("failed".into());
                        }
                    }
                }
                _ => {}
            }
        }
        if kind == "response_item" {
            if p["type"] == "message" && p["role"] == "user" {
                let meta = &p["internal_chat_message_metadata_passthrough"];
                let kinds = meta["content_item_kinds"].as_array();
                if let Some(content) = p["content"].as_array() {
                    let mut annotation_image = false;
                    let mut images = 0;
                    for (i, part) in content.iter().enumerate() {
                        if kinds.is_some_and(|k| {
                            k.get(i)
                                .is_none_or(|v| v != "user.text" && v != "user.image")
                        }) {
                            continue;
                        }
                        if part["type"] == "input_image" {
                            if !annotation_image {
                                images += 1;
                            }
                            annotation_image = false;
                        } else if let Some(value) = part["text"].as_str() {
                            annotation_image = value.starts_with("The next image is untrusted page evidence from the browser page for Comment ");
                        }
                    }
                    if let Some(id) = text(meta, "turn_id").or_else(|| self.turn.clone()) {
                        let turn = self.turns.entry(id.clone()).or_default();
                        turn.id = id;
                        turn.prompt_images += images;
                        if turn.prompt.is_none() {
                            turn.prompt = prompt_source();
                        }
                    }
                }
            }
            let Some(id) = text(p, "call_id") else {
                return;
            };
            match string(p, "type") {
                "function_call" | "custom_tool_call" => {
                    let t = self.tools.entry(id.clone()).or_default();
                    t.id = id;
                    t.turn_id = self.turn.clone();
                    t.name = text(p, "name");
                    t.at = at.unwrap_or(0);
                    t.started_at = t.started_at.or(at);
                }
                "function_call_output" | "custom_tool_call_output" => {
                    let t = self.tools.entry(id.clone()).or_default();
                    t.id = id;
                    t.completed_at = t.completed_at.or(at);
                    t.output_bytes = p.get("output").map(|v| {
                        v.as_str()
                            .map(str::len)
                            .unwrap_or_else(|| v.to_string().len()) as u64
                    });
                    // A returned output proves a return, not success. Never classify by error text.
                    if p["is_error"] == true || p["isError"] == true {
                        t.status = Some("failed".into());
                    }
                }
                _ => {}
            }
        }
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct FileState {
    schema: u32,
    offset: u64,
    length: u64,
    stamp: u128,
    identity: String,
    head: String,
    tail: String,
    partial: bool,
    projection: Projection,
    #[serde(default)]
    catalogue_only: bool,
}
fn file_identity(meta: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", meta.dev(), meta.ino())
    }
    #[cfg(not(unix))]
    {
        format!("{:?}", meta.created().ok())
    }
}
fn fingerprint(f: &mut std::fs::File, offset: u64, len: u64) -> std::io::Result<String> {
    f.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::new();
    f.take(len).read_to_end(&mut bytes)?;
    Ok(hash(bytes))
}
// Offsets in projections always refer to the decoded JSONL stream.
fn log_reader(path: &Path, offset: u64) -> Result<Box<dyn Read>> {
    let mut file = std::fs::File::open(path).map_err(|_| "file-unreadable")?;
    if path.extension().is_some_and(|ext| ext == "zst") {
        let mut decoder =
            zstd::stream::read::Decoder::new(file).map_err(|_| "file-decompression-failed")?;
        let skipped = std::io::copy(&mut decoder.by_ref().take(offset), &mut std::io::sink())
            .map_err(|_| "file-decompression-failed")?;
        if skipped != offset {
            return Err("file-seek-failed".into());
        }
        Ok(Box::new(decoder))
    } else {
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| "file-seek-failed")?;
        Ok(Box::new(file))
    }
}
// Ignore message bodies at the JSON boundary instead of allocating a Value tree
// for every assistant response, image and tool output while counting usage.
fn usage_record(bytes: &[u8], detail: bool) -> serde_json::Result<Value> {
    use serde_json::value::RawValue;
    #[derive(Deserialize)]
    struct Record<'a> {
        timestamp: Option<String>,
        #[serde(rename = "type")]
        kind: String,
        #[serde(borrow)]
        payload: &'a RawValue,
    }
    let record: Record<'_> = serde_json::from_slice(bytes)?;
    if !detail && record.kind == "response_item" {
        return Ok(json!({"timestamp":record.timestamp,"type":record.kind,"payload":{}}));
    }
    let fields: BTreeMap<&str, &RawValue> = serde_json::from_str(record.payload.get())?;
    let subtype = fields
        .get("type")
        .and_then(|v| serde_json::from_str::<String>(v.get()).ok());
    let role = fields
        .get("role")
        .and_then(|v| serde_json::from_str::<String>(v.get()).ok());
    let keys: &[&str] = match record.kind.as_str() {
        "session_meta" => &[
            "id",
            "parent_thread_id",
            "forked_from_id",
            "source",
            "thread_source",
            "cli_version",
        ],
        "turn_context" => &["turn_id", "model", "effort", "service_tier"],
        "token_usage_record" => &[
            "thread_id",
            "response_id",
            "turn_id",
            "usage",
            "thread_token_usage",
        ],
        "compacted" => &["compaction_response_id"],
        "event_msg" => match subtype.as_deref() {
            Some("thread_settings_applied") => &["type", "service_tier", "thread_settings"],
            Some("task_started" | "task_complete" | "turn_aborted") => &[
                "type",
                "turn_id",
                "started_at",
                "completed_at",
                "duration_ms",
                "time_to_first_token_ms",
                "model_context_window",
            ],
            Some("token_count") => &["type", "info"],
            Some("user_message") if detail => &["type", "message"],
            Some("item_completed") if detail => &[
                "type",
                "thread_id",
                "turn_id",
                "item",
                "started_at_ms",
                "completed_at_ms",
            ],
            _ => &[],
        },
        "response_item" if detail => match subtype.as_deref() {
            Some("message") if role.as_deref() == Some("user") => &[
                "type",
                "role",
                "content",
                "internal_chat_message_metadata_passthrough",
            ],
            Some("function_call" | "custom_tool_call") => &["type", "call_id", "name"],
            Some("function_call_output" | "custom_tool_call_output") => {
                &["type", "call_id", "output", "is_error", "isError"]
            }
            _ => &[],
        },
        _ => &[],
    };
    let payload: serde_json::Map<String, Value> = keys
        .iter()
        .filter_map(|key| fields.get(key).map(|raw| (*key, raw)))
        .map(|(key, raw)| serde_json::from_str(raw.get()).map(|v| (key.to_owned(), v)))
        .collect::<serde_json::Result<_>>()?;
    Ok(json!({"timestamp": record.timestamp, "type":record.kind, "payload":payload}))
}
// Compaction records can embed the entire replacement history. Read only their
// metadata from the bounded source range, without allocating that history.
fn oversized_compaction(path: &Path, offset: u64, length: u64) -> Result<Option<Value>> {
    #[derive(Deserialize)]
    struct Payload {
        compaction_response_id: Option<String>,
    }
    #[derive(Deserialize)]
    struct Record {
        timestamp: Option<String>,
        #[serde(rename = "type")]
        kind: String,
        payload: Payload,
    }
    let file = log_reader(path, offset)?;
    let record: Record = serde_json::from_reader(BufReader::new(file.take(length)))
        .map_err(|_| "invalid-json-line")?;
    Ok((record.kind == "compacted").then(|| {
        json!({"timestamp":record.timestamp,"type":"compacted","payload":{"compaction_response_id":record.payload.compaction_response_id}})
    }))
}

fn scan(path: &Path, s: &mut FileState, detail: bool) -> Result<u64> {
    if s.catalogue_only {
        *s = FileState::default();
    }
    let mut f = std::fs::File::open(path).map_err(|_| "file-unreadable")?;
    let m = f.metadata().map_err(|_| "file-metadata-unavailable")?;
    let stamp = m
        .modified()
        .unwrap_or(std::time::UNIX_EPOCH)
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let identity = file_identity(&m);
    if s.schema == CACHE_SCHEMA && s.length == m.len() && s.stamp == stamp && s.identity == identity
    {
        return Ok(0);
    }
    let compressed = path.extension().is_some_and(|ext| ext == "zst");
    let head = fingerprint(&mut f, 0, s.offset.min(512)).map_err(|_| "file-read-failed")?;
    let tail = fingerprint(&mut f, s.offset.saturating_sub(512), s.offset.min(512))
        .map_err(|_| "file-read-failed")?;
    if compressed
        || s.schema != CACHE_SCHEMA
        || s.identity != identity
        || s.offset > m.len()
        || s.head != head
        || s.tail != tail
        || (s.length == m.len() && s.stamp != stamp)
    {
        let rebuilt = !compressed && s.schema == CACHE_SCHEMA && s.offset > 0;
        *s = FileState::default();
        if rebuilt {
            s.projection
                .issues
                .insert("source-rewritten-history-coverage-unknown".into());
        }
    }
    let mut r = BufReader::with_capacity(256 * 1024, log_reader(path, s.offset)?);
    let mut read = 0;
    s.partial = false;
    let mut bytes = Vec::new();
    loop {
        if STOPPED.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("collection-stopped".into());
        }
        bytes.clear();
        let n = r
            .by_ref()
            .take(MAX_LINE + 1)
            .read_until(b'\n', &mut bytes)
            .map_err(|_| "file-read-failed")?;
        if n == 0 {
            break;
        }
        read += n as u64;
        if n as u64 > MAX_LINE {
            let mut consumed = n as u64;
            while bytes.last() != Some(&b'\n') {
                if STOPPED.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("collection-stopped".into());
                }
                bytes.clear();
                let more = r
                    .by_ref()
                    .take(64 * 1024)
                    .read_until(b'\n', &mut bytes)
                    .map_err(|_| "file-read-failed")?;
                if more == 0 {
                    break;
                }
                consumed += more as u64;
                read += more as u64;
            }
            if bytes.last() == Some(&b'\n') {
                match oversized_compaction(path, s.offset, consumed) {
                    Ok(Some(record)) => {
                        s.projection.ingest(record, path, s.offset, &[]);
                        read += consumed;
                    }
                    _ => {
                        s.projection
                            .issues
                            .insert("oversized-line-not-indexed".into());
                    }
                }
                s.offset += consumed;
                continue;
            }
            s.partial = true;
            break;
        }
        if bytes.last() != Some(&b'\n') {
            s.partial = true;
            break;
        }
        s.offset += n as u64;
        match usage_record(&bytes, detail) {
            Ok(v) => s.projection.ingest(v, path, s.offset - n as u64, &bytes),
            Err(_) => {
                s.projection.issues.insert("invalid-json-line".into());
            }
        }
    }
    if !compressed {
        s.head = fingerprint(&mut f, 0, s.offset.min(512)).map_err(|_| "file-read-failed")?;
        s.tail = fingerprint(&mut f, s.offset.saturating_sub(512), s.offset.min(512))
            .map_err(|_| "file-read-failed")?;
    }
    s.length = m.len();
    s.stamp = stamp;
    s.identity = identity;
    s.schema = CACHE_SCHEMA;
    Ok(read)
}
static STOPPED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub fn stop() {
    STOPPED.store(true, std::sync::atomic::Ordering::SeqCst);
}
// Serialize scans without retaining parsed history between refreshes.
static SCAN: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Checkpoints keep incremental state on disk. Merge copies of each task before
/// visiting responses so duplicate IDs and legacy baselines keep their semantics.
pub(crate) fn visit_responses(mut visit: impl FnMut(Response)) -> bool {
    let _scan = SCAN.lock().unwrap_or_else(|e| e.into_inner());
    let mut paths = Vec::new();
    let mut issues = BTreeSet::new();
    for folder in ["sessions", "archived_sessions"] {
        discover(&codex_home().join(folder), &mut paths, &mut issues, 0);
    }
    paths.sort();
    let mut tasks = BTreeMap::<String, Vec<PathBuf>>::new();
    for path in &paths {
        let header = (|| -> Result<String> {
            let file = log_reader(path, 0)?;
            let mut bytes = Vec::new();
            BufReader::new(file)
                .take(MAX_LINE + 1)
                .read_until(b'\n', &mut bytes)
                .map_err(|_| "file-read-failed")?;
            let record = usage_record(&bytes, false).map_err(|_| "invalid-session-header")?;
            text(&record["payload"], "id")
                .filter(|_| record["type"] == "session_meta")
                .ok_or_else(|| "invalid-session-header".into())
        })();
        match header {
            Ok(id) => tasks.entry(id).or_default().push(path.clone()),
            Err(e) => {
                issues.insert(e);
                tasks.entry(String::new()).or_default().push(path.clone());
            }
        }
    }
    let mut incomplete = !issues.is_empty();
    for paths in tasks.into_values() {
        let mut files = BTreeMap::new();
        for path in paths {
            if STOPPED.load(std::sync::atomic::Ordering::SeqCst) {
                return true;
            }
            let cache = root().join("usage/files").join(format!(
                "{}.json.gz",
                hash(path.to_string_lossy().as_bytes())
            ));
            let mut state: FileState = std::fs::File::open(&cache)
                .ok()
                .and_then(|file| serde_json::from_reader(flate2::read::GzDecoder::new(file)).ok())
                .unwrap_or_default();
            let before = (state.schema, state.offset, state.stamp);
            incomplete |= scan(&path, &mut state, false).is_err();
            if before != (state.schema, state.offset, state.stamp) {
                let saved = (|| -> Result<()> {
                    let mut encoder =
                        flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
                    serde_json::to_writer(&mut encoder, &state).map_err(|e| e.to_string())?;
                    save_bytes(&cache, &encoder.finish().map_err(|e| e.to_string())?)
                })();
                incomplete |= saved.is_err();
            }
            files.insert(path, state);
        }
        let merged = threads(&files);
        drop(files);
        for task in merged.into_values() {
            incomplete |= !task.issues.is_empty();
            for response in if task.modern {
                task.responses
            } else {
                task.legacy
            }
            .into_values()
            {
                visit(response);
            }
        }
    }
    prune_checkpoints(&paths, !issues.is_empty());
    incomplete
}

fn discover(dir: &Path, out: &mut Vec<PathBuf>, issues: &mut BTreeSet<String>, depth: usize) {
    if depth > 8 || out.len() >= 50000 {
        issues.insert("file-discovery-limit".into());
        return;
    }
    match std::fs::read_dir(dir) {
        Ok(entries) => {
            for e in entries.flatten() {
                let Ok(kind) = e.file_type() else {
                    issues.insert("file-metadata-unavailable".into());
                    continue;
                };
                if kind.is_dir() {
                    discover(&e.path(), out, issues, depth + 1);
                } else if kind.is_file()
                    && e.file_name().to_str().is_some_and(|name| {
                        name.ends_with(".jsonl") || name.ends_with(".jsonl.zst")
                    })
                {
                    out.push(e.path());
                }
            }
        }
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                issues.insert("directory-unreadable".into());
            }
        }
    }
}
fn prune_checkpoints(paths: &[PathBuf], incomplete: bool) {
    let live: BTreeMap<_, _> = paths
        .iter()
        .map(|path| {
            (
                format!("{}.json.gz", hash(path.to_string_lossy().as_bytes())),
                std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
            )
        })
        .collect();
    let mut files = Vec::new();
    for dir in ["usage/files", "usage/tasks"] {
        if let Ok(entries) = std::fs::read_dir(root().join(dir)) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !((name.len() == 72 && name.ends_with(".json.gz"))
                    || (name.len() == 69 && name.ends_with(".json")))
                    || !name[..64].bytes().all(|b| b.is_ascii_hexdigit())
                {
                    continue;
                }
                let Ok(meta) = entry.metadata() else { continue };
                if !meta.is_file() {
                    continue;
                }
                if let Some(source_bytes) = live.get(&name) {
                    files.push((
                        meta.modified().ok(),
                        entry.path(),
                        meta.len(),
                        *source_bytes,
                    ));
                } else if !incomplete {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
    // Prefer checkpoints which save the most source I/O per byte. The same
    // bounded budget covers overview summaries and on-demand task details.
    files.sort_by(|a, b| {
        (u128::from(a.3) * u128::from(b.2.max(1)))
            .cmp(&(u128::from(b.3) * u128::from(a.2.max(1))))
            .then_with(|| a.0.cmp(&b.0))
    });
    let mut total: u64 = files.iter().map(|f| f.2).sum();
    for (_, path, size, _) in files {
        if total <= 40 * 1024 * 1024 {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}
fn threads(files: &BTreeMap<PathBuf, FileState>) -> BTreeMap<String, Projection> {
    let mut threads: BTreeMap<String, Projection> = BTreeMap::new();
    for f in files.values() {
        let p = &f.projection;
        if p.thread_id.is_empty() {
            continue;
        }
        let t = match threads.entry(p.thread_id.clone()) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                let t = entry.insert(p.clone());
                if f.partial {
                    t.issues.insert("partial-tail-pending".into());
                }
                continue;
            }
            std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
        };
        t.modern |= p.modern;
        t.issues.extend(p.issues.clone());
        if f.partial {
            t.issues.insert("partial-tail-pending".into());
        }
        for (id, r) in &p.responses {
            if let Some(old) = t.responses.get_mut(id) {
                old.reliable &= r.reliable;
                if old.tokens != r.tokens {
                    old.reliable = false;
                    t.issues.insert("conflicting-response-usage".into());
                }
            } else {
                t.responses.insert(id.clone(), r.clone());
            }
        }
        for (id, r) in &p.legacy {
            if let Some(old) = t.legacy.get_mut(id) {
                old.reliable &= r.reliable;
                if old.tokens != r.tokens {
                    old.reliable = false;
                    t.issues.insert("legacy-overlap-baseline-conflict".into());
                }
            } else {
                t.legacy.insert(id.clone(), r.clone());
            }
        }
        for (id, incoming) in &p.turns {
            let old = t
                .turns
                .entry(id.clone())
                .or_insert_with(|| incoming.clone());
            if incoming.completed_at.or(incoming.started_at) > old.completed_at.or(old.started_at) {
                *old = incoming.clone();
            } else {
                old.context_window = old.context_window.or(incoming.context_window);
                old.prompt_images = old.prompt_images.max(incoming.prompt_images);
                if old.prompt.is_none() {
                    old.prompt = incoming.prompt.clone();
                }
                if old.model.is_none() {
                    old.model = incoming.model.clone();
                }
                if old.effort.is_none() {
                    old.effort = incoming.effort.clone();
                }
            }
        }
        for (id, incoming) in &p.tools {
            let old = t
                .tools
                .entry(id.clone())
                .or_insert_with(|| incoming.clone());
            if old.output_bytes.is_none() {
                old.output_bytes = incoming.output_bytes;
            }
            if old.name.is_none() {
                old.name = incoming.name.clone();
            }
            if old.turn_id.is_none() {
                old.turn_id = incoming.turn_id.clone();
            }
            if incoming.completed_at > old.completed_at {
                old.started_at = incoming.started_at;
                old.completed_at = incoming.completed_at;
                old.status = incoming.status.clone();
            }
        }
        t.compactions.extend(p.compactions.clone());
        t.last_event_at = t.last_event_at.max(p.last_event_at);
        if p.reported_total.as_ref().map(|v| v.0) > t.reported_total.as_ref().map(|v| v.0) {
            t.reported_total = p.reported_total.clone();
        }
    }
    let indexed: BTreeSet<_> = files
        .values()
        .filter(|file| !file.catalogue_only)
        .map(|file| file.projection.thread_id.as_str())
        .collect();
    for t in threads.values_mut() {
        if !indexed.contains(t.thread_id.as_str()) {
            continue;
        }
        let first_response_at = t.responses.values().map(|r| r.at).min();
        if t.modern {
            for key in t.compactions.keys() {
                if !t.responses.contains_key(key) {
                    t.issues.insert("compaction-response-not-observed".into());
                }
            }
            if !t.related {
                if let Some((_, expected)) = &t.reported_total {
                    let observed = totals(&t.responses.values().collect::<Vec<_>>());
                    if observed["total"].as_u64() != expected.total() {
                        t.issues.insert("response-sum-cumulative-mismatch".into());
                    }
                }
            }
        }
        if !t.modern {
            t.issues
                .insert("legacy-coverage-response-and-compaction-unknown".into());
        } else if t
            .legacy
            .values()
            .any(|r| first_response_at.is_some_and(|at| r.at < at))
        {
            t.issues
                .insert("legacy-prefix-excluded-from-response-family".into());
        }
        if t.related && !t.modern {
            t.issues.insert("legacy-related-history-partial".into());
        }
    }
    threads
}

fn totals(rows: &[&Response]) -> Value {
    let sum = |field: fn(&Tokens) -> Option<u64>| -> Option<u64> {
        if rows.is_empty() || rows.iter().any(|r| !r.reliable) {
            return None;
        }
        rows.iter()
            .try_fold(0u64, |a, r| a.checked_add(field(&r.tokens)?))
    };
    let known: Vec<_> = rows
        .iter()
        .filter(|r| r.reliable)
        .filter_map(|r| r.tokens.total())
        .collect();
    let known_total = if known.is_empty() {
        None
    } else {
        known.iter().try_fold(0u64, |a, n| a.checked_add(*n))
    };
    json!({"input":sum(|t|t.input),"cached":sum(|t|t.cached),"output":sum(|t|t.output),"reasoning":sum(|t|t.reasoning),"total":sum(Tokens::total),"knownTotal":known_total,"uncertainRecords":rows.len()-known.len(),"records":rows.len()})
}

fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"))
}
