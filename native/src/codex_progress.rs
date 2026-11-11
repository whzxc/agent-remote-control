//! Bounded native evidence for a turn that has started without generating output.
use crate::*;
use std::io::{Read, Seek, SeekFrom};

pub(crate) const THRESHOLD_MS: i64 = 6 * 60 * 1000;
const SAMPLE_SPAN_MS: i64 = 5 * 60 * 1000;
const HISTORY_BYTES: u64 = 1024 * 1024;

pub(crate) fn diagnose(text: &str, thread: &str, turn: &str, time_ms: i64) -> Value {
    let mut current = String::new();
    let mut started = None;
    let mut last_item = Value::Null;
    let mut samples = Vec::new();
    let mut previous_usage = Value::Null;
    let mut generated = false;
    let mut ended = false;
    let mut framing = crate::task_tracking::CodexTranscript::default();
    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !framing.include(&record) {
            continue;
        }
        let payload = &record["payload"];
        let kind = string(payload, "type");
        let at = &record["timestamp"];
        let begins = record["type"] == "turn_context"
            || (record["type"] == "event_msg" && kind == "task_started");
        if begins {
            if let Some(id) = payload["turn_id"].as_str() {
                current = id.into();
                if current == turn && started.is_none() {
                    started = at
                        .as_str()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
                } else if current != turn && started.is_some() {
                    ended = true;
                }
            }
        }
        if record["type"] == "response_item" {
            last_item = at.clone();
            if current == turn
                && !matches!(string(payload, "role"), "user" | "developer" | "system")
            {
                generated = true;
            }
        }
        if record["type"] != "event_msg" {
            continue;
        }
        if current == turn
            && matches!(
                kind,
                "task_complete" | "turn_aborted" | "agent_message" | "agent_reasoning"
            )
        {
            ended = true;
        }
        if kind == "token_count" {
            let usage = &payload["info"]["total_token_usage"];
            if usage["output_tokens"].as_u64().is_none() {
                continue;
            }
            if current == turn && started.is_some() {
                if !previous_usage.is_null() && previous_usage != *usage {
                    generated = true;
                }
                if let Some(at) = at
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                {
                    samples.push(at);
                }
            }
            previous_usage = usage.clone();
        }
    }
    let Some(started) = started else {
        return Value::Null;
    };
    let (Some(first), Some(last)) = (samples.first(), samples.last()) else {
        return Value::Null;
    };
    if current != turn
        || generated
        || ended
        || samples.len() < 2
        || time_ms.saturating_sub(started.timestamp_millis()) < THRESHOLD_MS
        || (*last - *first).num_milliseconds() < SAMPLE_SPAN_MS
    {
        return Value::Null;
    }
    json!({"progressStalled":true,"reason":"native-progress-stalled",
        "evidence":{"thresholdMs":THRESHOLD_MS,"startedAt":started.to_rfc3339(),"lastItemAt":last_item,
            "unchangedTokenCounts":samples.len(),"firstEmptyTokenCountAt":first.to_rfc3339(),
            "lastEmptyTokenCountAt":last.to_rfc3339(),"unchangedTotalTokenUsage":previous_usage},
        "next":{"via":"act","op":"codex_interrupt","args":{"threadId":thread,"turnId":turn},
            "hint":"Interrupt this stalled turn. Confirm interruption with codex_read, then redispatch the authorized work with codex_send and a new requestId."}})
}

pub(crate) fn apply(result: &mut Value, metadata: &Value) {
    if result["state"] != "running" || result.get("progressStalled").is_some() {
        return;
    }
    let turn = string(result, "turnId");
    let native = metadata["turns"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|t| t["id"] == turn);
    if native.is_some_and(|t| {
        t["items"]
            .as_array()
            .is_some_and(|items| items.iter().any(|i| i["type"] != "userMessage"))
    }) {
        return;
    }
    let read = || -> Result<Value> {
        let mut file = crate::control::open_persisted_history(metadata)?;
        let length = file.metadata().map_err(|e| e.to_string())?.len();
        file.seek(SeekFrom::Start(length.saturating_sub(HISTORY_BYTES)))
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(HISTORY_BYTES)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        crate::runtime_metrics::cost::bytes_read(bytes.len());
        Ok(diagnose(
            &String::from_utf8_lossy(&bytes),
            string(metadata, "id"),
            turn,
            chrono::Utc::now().timestamp_millis(),
        ))
    };
    if let Ok(diagnostic) = read() {
        project(result, &diagnostic);
    }
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
    fn history() -> String {
        [
            json!({"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}),
            json!({"timestamp":"2026-01-01T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user"}}),
            json!({"timestamp":"2026-01-01T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"output_tokens":378,"total_tokens":900}}}}),
            json!({"timestamp":"2026-01-01T00:05:32Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"output_tokens":378,"total_tokens":900}}}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n")
    }
    #[test]
    fn empty_native_turn_reports_evidence_and_recovery_after_the_threshold() {
        // Regression: ax-c8588c1e repeated unchanged native counts left a fourteen-minute empty turn looking healthy.
        let at = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:06:00Z")
            .unwrap()
            .timestamp_millis();
        let diagnostic = diagnose(&history(), "thread", "turn", at);
        assert_eq!(diagnostic["progressStalled"], true);
        assert_eq!(diagnostic["evidence"]["unchangedTokenCounts"], 2);
        assert_eq!(diagnostic["evidence"]["lastItemAt"], "2026-01-01T00:00:01Z");
        assert_eq!(diagnostic["next"]["op"], "codex_interrupt");
        let mut receipt =
            json!({"state":"completed","requestId":"dispatch","threadId":"thread","turnId":"turn"});
        project(&mut receipt, &diagnostic);
        let public = crate::egress::receipt(receipt);
        assert_eq!(public["state"], "completed");
        assert_eq!(public["progressStalled"], true);
        assert_eq!(public["progress"]["evidence"], diagnostic["evidence"]);
        assert_eq!(public["next"]["op"], "codex_interrupt");
        assert!(diagnose(&history(), "thread", "turn", at - 1).is_null());
        for record in [
            json!({"timestamp":"2026-01-01T00:05:40Z","type":"response_item","payload":{"type":"message","role":"assistant"}}),
            json!({"timestamp":"2026-01-01T00:05:40Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"output_tokens":379,"total_tokens":901}}}}),
            json!({"timestamp":"2026-01-01T00:05:40Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn"}}),
        ] {
            assert!(diagnose(&format!("{}\n{record}", history()), "thread", "turn", at).is_null());
        }
        assert!(diagnose(&history(), "thread", "other-turn", at).is_null());
    }
}
