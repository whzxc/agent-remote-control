//! Bounded native activity observations for running Codex turns.
use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Seek, SeekFrom};

pub(crate) const THRESHOLD_MS: i64 = 3 * 60 * 1000;
const HISTORY_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Activity {
    started_at: Option<i64>,
    last_activity_at: Option<i64>,
    last_item_at: Option<i64>,
    signal: String,
    tools: BTreeMap<String, (i64, bool)>,
    items: BTreeMap<String, String>,
    token_usage: Value,
    unchanged_token_counts: u64,
    last_token_count_at: Option<i64>,
    ended: bool,
}
fn timestamp(value: &Value) -> Option<i64> {
    value
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.timestamp_millis())
        .or_else(|| {
            value.as_i64().map(|n| {
                if n.abs() < 1_000_000_000_000 {
                    n * 1000
                } else {
                    n
                }
            })
        })
}
fn date(at: Option<i64>) -> Option<String> {
    at.and_then(chrono::DateTime::from_timestamp_millis)
        .map(|at| at.to_rfc3339())
}
fn tool(kind: &str) -> bool {
    matches!(
        kind,
        "commandExecution"
            | "mcpToolCall"
            | "dynamicToolCall"
            | "collabAgentToolCall"
            | "fileChange"
            | "function_call"
            | "custom_tool_call"
            | "local_shell_call"
            | "web_search_call"
            | "tool_search_call"
    )
}
impl Activity {
    fn touch(&mut self, at: i64, signal: &str) {
        self.started_at.get_or_insert(at);
        if self.last_activity_at.is_none_or(|previous| at >= previous) {
            self.last_activity_at = Some(at);
            self.signal = signal.into();
        }
    }
    fn usage(&mut self, usage: &Value, at: i64) {
        if !usage.is_object() {
            return;
        }
        if !self.token_usage.is_null() {
            if self.token_usage != *usage {
                self.touch(at, "token-count-change");
                self.unchanged_token_counts = 0;
            } else {
                self.unchanged_token_counts += 1;
            }
        }
        self.token_usage = usage.clone();
        self.last_token_count_at = Some(at);
    }
    fn item(&mut self, item: &Value, at: i64, completed: bool) {
        let id = item["call_id"]
            .as_str()
            .or(item["id"].as_str())
            .unwrap_or("");
        let kind = string(item, "type");
        let digest = hash(item.to_string());
        if self.items.get(id) != Some(&digest) {
            self.touch(at, "response-item");
            self.last_item_at = Some(at);
            self.items.insert(id.into(), digest);
        }
        if tool(kind) && !id.is_empty() {
            self.tools.insert(id.into(), (at, !completed));
        }
        if matches!(
            kind,
            "function_call_output" | "custom_tool_call_output" | "tool_search_output"
        ) {
            self.tools.insert(id.into(), (at, false));
        }
    }
    fn merge(&mut self, other: &Self) {
        self.ended |= other.ended;
        if other.last_token_count_at > self.last_token_count_at {
            self.token_usage = other.token_usage.clone();
            self.unchanged_token_counts = other.unchanged_token_counts;
            self.last_token_count_at = other.last_token_count_at;
        }
        self.started_at = self.started_at.into_iter().chain(other.started_at).min();
        if let Some(at) = other.last_activity_at {
            self.touch(at, &other.signal);
        }
        self.last_item_at = self
            .last_item_at
            .into_iter()
            .chain(other.last_item_at)
            .max();
        for (id, state) in &other.tools {
            if self
                .tools
                .get(id)
                .is_none_or(|previous| state.0 >= previous.0)
            {
                self.tools.insert(id.clone(), *state);
            }
        }
    }
    fn diagnostic(&self, thread: &str, turn: &str, time_ms: i64) -> Value {
        let Some(at) = self.last_activity_at else {
            return Value::Null;
        };
        if self.ended
            || self.tools.values().any(|(_, running)| *running)
            || time_ms.saturating_sub(at) < THRESHOLD_MS
        {
            return Value::Null;
        }
        json!({"progressStalled":true,"reason":"native-progress-stalled",
            "evidence":{"thresholdMs":THRESHOLD_MS,"startedAt":date(self.started_at),"lastActivityAt":date(Some(at)),
                "lastActivitySignal":self.signal,"lastItemAt":date(self.last_item_at),
                "unchangedTokenCounts":self.unchanged_token_counts,"lastTokenCountAt":date(self.last_token_count_at),"nativeTokenUsage":self.token_usage},
            "next":{"via":"act","op":"codex_interrupt","args":{"threadId":thread,"turnId":turn},
                "hint":"Interrupt this stalled turn. Confirm interruption with codex_read, then redispatch the authorized work with codex_send and a new requestId."}})
    }
}
fn history(text: &str, selected: &str) -> Activity {
    let mut activity = Activity::default();
    let mut current = String::new();
    let mut usage = Value::Null;
    let mut framing = crate::task_tracking::CodexTranscript::default();
    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !framing.include(&record) {
            continue;
        }
        let Some(at) = timestamp(&record["timestamp"]) else {
            continue;
        };
        let payload = &record["payload"];
        let kind = string(payload, "type");
        if record["type"] == "turn_context"
            || (record["type"] == "event_msg" && kind == "task_started")
        {
            if let Some(turn) = payload["turn_id"].as_str() {
                current = turn.into();
                if current == selected && activity.started_at.is_none() {
                    activity.token_usage = usage.clone();
                    activity.touch(at, "turn-start");
                } else if current != selected && activity.started_at.is_some() {
                    activity.ended = true;
                }
            }
        }
        if current == selected {
            if record["type"] == "response_item" {
                activity.touch(at, "response-item");
                activity.item(
                    payload,
                    at,
                    matches!(
                        string(payload, "status"),
                        "completed" | "failed" | "cancelled"
                    ),
                );
            }
            if record["type"] == "event_msg" {
                match kind {
                    "task_complete" | "turn_aborted" => activity.ended = true,
                    "agent_message" | "agent_reasoning" => activity.touch(at, "response-item"),
                    "token_count" => activity.usage(&payload["info"]["total_token_usage"], at),
                    _ => (),
                }
            }
        }
        if record["type"] == "event_msg" && kind == "token_count" {
            usage = payload["info"]["total_token_usage"].clone();
        }
    }
    activity
}
fn prune(states: &mut HashMap<(String, String), Activity>) {
    while states.len() > 2000 {
        let oldest = states
            .iter()
            .min_by_key(|(_, state)| state.last_activity_at)
            .map(|(key, _)| key.clone())
            .unwrap();
        states.remove(&oldest);
    }
}

pub(crate) fn observe_snapshot(
    states: &mut HashMap<(String, String), Activity>,
    metadata: &Value,
    at: &str,
) {
    let Some(at) = timestamp(&json!(at)) else {
        return;
    };
    for turn in metadata["turns"].as_array().into_iter().flatten() {
        let state = states
            .entry((string(metadata, "id").into(), string(turn, "id").into()))
            .or_default();
        state.started_at = state.started_at.or(timestamp(&turn["startedAt"]));
        state.ended |= matches!(
            string(turn, "status"),
            "completed" | "failed" | "interrupted" | "cancelled"
        );
        for item in turn["items"].as_array().into_iter().flatten() {
            state.item(
                item,
                at,
                matches!(string(item, "status"), "completed" | "failed" | "cancelled"),
            );
        }
    }
    prune(states);
}

pub(crate) fn observe(
    states: &mut HashMap<(String, String), Activity>,
    method: &str,
    params: &Value,
    at: &str,
) {
    let Some(at) = timestamp(&json!(at)) else {
        return;
    };
    if method == "desktop/thread-stream-state-changed" {
        if let Ok(turns) = crate::desktop::turns(&params["change"]["conversationState"]) {
            observe_snapshot(
                states,
                &json!({"id":params["conversationId"],"turns":turns}),
                &date(Some(at)).unwrap(),
            );
        }
    } else if let (Some(thread), Some(turn)) = (
        params["threadId"].as_str(),
        params["turnId"].as_str().or(params["turn"]["id"].as_str()),
    ) {
        let state = states.entry((thread.into(), turn.into())).or_default();
        match method {
            "turn/started" => {
                state.started_at = state.started_at.into_iter().chain(Some(at)).min();
                state.touch(at, "turn-start");
            }
            "turn/completed" => state.ended = true,
            "item/started" | "item/completed" => {
                state.touch(at, "response-item");
                state.item(&params["item"], at, method == "item/completed")
            }
            "thread/tokenUsage/updated" => state.usage(&params["tokenUsage"]["total"], at),
            _ if method.starts_with("item/")
                && method.to_ascii_lowercase().contains("delta")
                && params["delta"]
                    .as_str()
                    .is_some_and(|delta| !delta.is_empty()) =>
            {
                state.touch(at, "streaming-delta")
            }
            _ => (),
        }
    }
    prune(states);
}
pub(crate) fn attach(metadata: &mut Value, events: &Events, selected: Option<&str>) {
    let thread = string(metadata, "id");
    if let Some(((.., turn), state)) = events
        .codex_activity
        .iter()
        .filter(|((id, turn), _)| id == thread && selected.is_none_or(|selected| turn == selected))
        .max_by_key(|(_, state)| state.started_at)
    {
        metadata["_nativeProgress"] = json!({"turnId":turn,"activity":state});
    }
}
pub(crate) fn apply(result: &mut Value, metadata: &Value) {
    if result["state"] != "running" || result["progressStalled"].is_boolean() {
        return;
    }
    result["progressStalled"] = json!(false);
    let turn = string(result, "turnId");
    let mut activity = (|| -> Result<Activity> {
        let mut file = crate::control::open_persisted_history(metadata)?;
        let length = file.metadata().map_err(|e| e.to_string())?.len();
        file.seek(SeekFrom::Start(length.saturating_sub(HISTORY_BYTES)))
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(HISTORY_BYTES)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        crate::runtime_metrics::cost::bytes_read(bytes.len());
        Ok(history(&String::from_utf8_lossy(&bytes), turn))
    })()
    .unwrap_or_default();
    if metadata["_nativeProgress"]["turnId"] == turn {
        if let Ok(live) =
            serde_json::from_value::<Activity>(metadata["_nativeProgress"]["activity"].clone())
        {
            activity.merge(&live);
        }
    }
    if let Some(native) = metadata["turns"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|native| native["id"] == turn)
    {
        if activity.last_activity_at.is_none() {
            if let Some(at) = timestamp(&native["startedAt"]) {
                activity.touch(at, "turn-start");
            }
        }
        for item in native["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| tool(string(item, "type")))
        {
            let id = string(item, "id");
            match string(item, "status") {
                "inProgress" | "running"
                    if !activity.tools.get(id).is_some_and(|(_, running)| !running) =>
                {
                    activity.tools.insert(id.into(), (0, true));
                }
                "completed" | "failed" | "cancelled" => {
                    activity.tools.insert(id.into(), (0, false));
                }
                _ => (),
            }
        }
    }
    project(
        result,
        &activity.diagnostic(
            string(metadata, "id"),
            turn,
            chrono::Utc::now().timestamp_millis(),
        ),
    );
}

pub(crate) fn project(result: &mut Value, diagnostic: &Value) {
    if diagnostic["progressStalled"] != true {
        return;
    }
    result["progressStalled"] = json!(true);
    if !result["progress"].is_object() {
        result["progress"] = json!({});
    }
    for (key, value) in diagnostic.as_object().unwrap() {
        result["progress"][key] = value.clone();
    }
    result["reason"] = diagnostic["reason"].clone();
    result["next"] = diagnostic["next"].clone();
}

#[cfg(test)]
mod tests {
    use super::*;
    fn at(seconds: i64) -> i64 {
        1_767_225_600_000 + seconds * 1000
    }
    fn start() -> String {
        json!({"timestamp":date(Some(at(0))),"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}).to_string()
    }
    fn record(seconds: i64, kind: &str, payload: Value) -> String {
        format!(
            "\n{}",
            json!({"timestamp":date(Some(at(seconds))),"type":kind,"payload":payload})
        )
    }
    #[test]
    fn startup_and_midturn_silence_stall_after_three_minutes_without_token_samples() {
        // Regression: ax-c8588c1e silence required six minutes and repeated token samples and could never detect mid-turn stalls.
        let mut text = start();
        assert!(history(&text, "turn")
            .diagnostic("thread", "turn", at(179))
            .is_null());
        let diagnostic = history(&text, "turn").diagnostic("thread", "turn", at(180));
        assert_eq!(diagnostic["progressStalled"], true);
        assert_eq!(diagnostic["evidence"]["unchangedTokenCounts"], 0);
        text += &record(
            200,
            "response_item",
            json!({"id":"message","type":"message","role":"assistant","content":[]}),
        );
        assert!(history(&text, "turn")
            .diagnostic("thread", "turn", at(379))
            .is_null());
        assert_eq!(
            history(&text, "turn").diagnostic("thread", "turn", at(380))["progressStalled"],
            true
        );
        let mut receipt = json!({"state":"completed","requestId":"dispatch"});
        project(&mut receipt, &diagnostic);
        let public = crate::egress::receipt(receipt);
        assert_eq!(public["progressStalled"], true);
        assert_eq!(public["next"]["op"], "codex_interrupt");
    }
    #[test]
    fn changed_counters_and_live_deltas_reset_the_activity_clock() {
        // Regression: stalled native progress ignored streaming deltas and treated old output as a permanent exclusion.
        let mut text = start();
        for (seconds, total) in [(10, 100), (20, 100), (100, 101)] {
            text += &record(
                seconds,
                "event_msg",
                json!({"type":"token_count","info":{"total_token_usage":{"output_tokens":total}}}),
            );
        }
        let mut state = history(&text, "turn");
        assert!(state.diagnostic("thread", "turn", at(279)).is_null());
        assert_eq!(
            state.diagnostic("thread", "turn", at(280))["progressStalled"],
            true
        );
        let mut states = HashMap::new();
        observe(
            &mut states,
            "item/agentMessage/delta",
            &json!({"threadId":"thread","turnId":"turn","delta":"text"}),
            &date(Some(at(250))).unwrap(),
        );
        state.merge(&states[&("thread".into(), "turn".into())]);
        assert!(state.diagnostic("thread", "turn", at(429)).is_null());
        assert_eq!(
            state.diagnostic("thread", "turn", at(430))["evidence"]["lastActivitySignal"],
            "streaming-delta"
        );
    }
    #[test]
    fn unchanged_native_snapshots_preserve_the_clock_and_changed_items_reset_it() {
        // Property: repeated native snapshots preserve inactivity while item content or status changes reset it.
        let mut states = HashMap::new();
        let mut metadata = json!({"id":"thread","turns":[{"id":"turn","startedAt":date(Some(at(0))),"status":"inProgress","items":[{"id":"message","type":"agentMessage","text":"first"}]}]});
        observe_snapshot(&mut states, &metadata, &date(Some(at(10))).unwrap());
        observe_snapshot(&mut states, &metadata, &date(Some(at(180))).unwrap());
        assert_eq!(
            states[&("thread".into(), "turn".into())].diagnostic("thread", "turn", at(190))
                ["progressStalled"],
            true
        );
        metadata["turns"][0]["items"][0]["text"] = json!("more");
        observe_snapshot(&mut states, &metadata, &date(Some(at(200))).unwrap());
        assert!(states[&("thread".into(), "turn".into())]
            .diagnostic("thread", "turn", at(379))
            .is_null());
        assert_eq!(
            states[&("thread".into(), "turn".into())].diagnostic("thread", "turn", at(380))
                ["progressStalled"],
            true
        );
    }

    #[test]
    fn long_tools_suspend_stalls_and_completion_restarts_the_clock() {
        // Regression: command and tool executions with no output must not be reported as stalled during long builds.
        let mut text = start();
        text += &record(
            10,
            "response_item",
            json!({"type":"function_call","call_id":"build","name":"exec_command"}),
        );
        assert!(history(&text, "turn")
            .diagnostic("thread", "turn", at(3600))
            .is_null());
        text += &record(
            3600,
            "response_item",
            json!({"type":"function_call_output","call_id":"build","output":"done"}),
        );
        assert!(history(&text, "turn")
            .diagnostic("thread", "turn", at(3779))
            .is_null());
        assert_eq!(
            history(&text, "turn").diagnostic("thread", "turn", at(3780))["progressStalled"],
            true
        );
        for kind in ["commandExecution", "mcpToolCall", "dynamicToolCall"] {
            let mut states = HashMap::new();
            for (method, seconds) in [("item/started", 10), ("item/completed", 3600)] {
                observe(
                    &mut states,
                    method,
                    &json!({"threadId":"thread","turnId":"turn","item":{"id":"tool","type":kind}}),
                    &date(Some(at(seconds))).unwrap(),
                );
                assert!(states[&("thread".into(), "turn".into())]
                    .diagnostic("thread", "turn", at(seconds + 179))
                    .is_null());
            }
            assert_eq!(
                states[&("thread".into(), "turn".into())].diagnostic("thread", "turn", at(3780))
                    ["progressStalled"],
                true
            );
        }
    }
}
