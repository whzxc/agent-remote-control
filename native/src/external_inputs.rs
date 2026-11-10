//! Observe native user inputs without attributing ARC submissions to the user.
use crate::kernel::file_cache::load;
use crate::*;
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());
fn path(thread: &str) -> PathBuf {
    root()
        .join("external-inputs")
        .join(format!("{}.json", hash(thread)))
}
fn read(thread: &str) -> Result<Value> {
    let path = path(thread);
    if path.exists() {
        load(&path)
    } else {
        Ok(Value::Null)
    }
}
fn content(item: &Value) -> Option<String> {
    let parts = match string(item, "type") {
        "userMessage" => &item["content"],
        "steeringUserMessage" if item["status"] == "accepted" => &item["input"],
        _ => return None,
    };
    Some(text(parts))
}
fn text(parts: &Value) -> String {
    parts
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}
fn key(turn: &Value, item: &Value, index: usize) -> String {
    json!([turn["id"], item.get("id").cloned().unwrap_or(json!(index))]).to_string()
}

pub(crate) fn begin(thread: &str, turns: &[Value], input: &Value, turn: &Value) -> Result<String> {
    let _guard = LOCK.lock().unwrap();
    let mut state = read(thread)?;
    if state.is_null() {
        let mut seen = serde_json::Map::new();
        for turn in turns {
            for (index, item) in turn["items"].as_array().into_iter().flatten().enumerate() {
                if content(item).is_some() {
                    seen.insert(key(turn, item, index), json!(true));
                }
            }
        }
        state = json!({"seen":seen,"submissions":[],"inputs":[],"pending":{},"responses":{}});
    }
    let token = id();
    state["submissions"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":token,"hash":hash(text(input)),"turnId":turn,"at":now()}));
    save(&path(thread), &state)?;
    Ok(token)
}

pub(crate) fn submitted(thread: &str, token: &str, result: &Result<Value>) -> Result<()> {
    let _guard = LOCK.lock().unwrap();
    let mut state = read(thread)?;
    let submissions = state["submissions"]
        .as_array_mut()
        .ok_or("INPUT_PROVENANCE_MISSING")?;
    if let Some(row) = submissions.iter_mut().find(|s| s["id"] == token) {
        match result {
            Ok(result) => {
                if let Some(turn) = result["turn"]["id"]
                    .as_str()
                    .or_else(|| result["turnId"].as_str())
                {
                    row["turnId"] = json!(turn);
                }
            }
            Err(error)
                if crate::kernel::receipts::progress::failure(error)
                    != crate::kernel::receipts::progress::Failure::Unconfirmed =>
            {
                submissions.retain(|s| s["id"] != token);
            }
            _ => {}
        }
    }
    save(&path(thread), &state)
}

pub(crate) fn responding(thread: &str, request: &Value) -> Result<()> {
    let _guard = LOCK.lock().unwrap();
    let mut state = read(thread)?;
    if !state.is_null() {
        state["responses"][request["id"].to_string()] = json!(true);
        save(&path(thread), &state)?;
    }
    Ok(())
}

pub(crate) fn response_failed(thread: &str, request: &Value, error: &str) -> Result<()> {
    if crate::kernel::receipts::progress::failure(error)
        == crate::kernel::receipts::progress::Failure::Unconfirmed
    {
        return Ok(());
    }
    let _guard = LOCK.lock().unwrap();
    let mut state = read(thread)?;
    if !state.is_null() {
        state["responses"]
            .as_object_mut()
            .unwrap()
            .remove(&request["id"].to_string());
        save(&path(thread), &state)?;
    }
    Ok(())
}

/// Call only with complete native snapshots. Missing requests prove resolution,
/// not approval; the native owner may not expose the answer or decision.
pub(crate) fn observe(thread: &str, turns: &[Value], pending: Option<&[Value]>) -> Result<()> {
    let _guard = LOCK.lock().unwrap();
    let mut state = read(thread)?;
    if state.is_null() {
        return Ok(());
    }
    let before = state.clone();
    for turn in turns {
        for (index, item) in turn["items"].as_array().into_iter().flatten().enumerate() {
            let Some(text) = content(item) else { continue };
            let key = key(turn, item, index);
            if state["seen"].get(&key).is_some() {
                continue;
            }
            let digest = hash(&text);
            let own = state["submissions"]
                .as_array()
                .unwrap()
                .iter()
                .position(|s| {
                    s["hash"] == digest && (s["turnId"].is_null() || s["turnId"] == turn["id"])
                });
            state["seen"][&key] = json!(true);
            if let Some(index) = own {
                state["submissions"].as_array_mut().unwrap().remove(index);
                continue;
            }
            let answered_turn = text
                .trim()
                .strip_prefix("<send_user_message_question_reply>")
                .and_then(|s| s.strip_suffix("</send_user_message_question_reply>"))
                .and_then(|body| serde_json::from_str::<Value>(body).ok())
                .and_then(|replies| {
                    let reply = replies
                        .as_array()
                        .and_then(|r| r.first())
                        .unwrap_or(&replies);
                    let question: Value =
                        serde_json::from_str(reply["questionItemId"].as_str()?).ok()?;
                    turns
                        .iter()
                        .find(|t| {
                            t["items"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .any(|i| i["id"] == question[1])
                        })
                        .map(|t| t["id"].clone())
                })
                .unwrap_or(Value::Null);
            let observed = now();
            let timestamp = item
                .get("createdAt")
                .or_else(|| item.get("timestamp"))
                .cloned()
                .unwrap_or(json!(observed));
            state["inputs"].as_array_mut().unwrap().push(json!({"kind":if text.contains("<send_user_message_question_reply>") {"interactionResponse"} else {"userMessage"},
                "turnId":turn["id"],"answeredTurnId":answered_turn,"itemId":item["id"],"text":text.chars().take(1000).collect::<String>(),"truncated":text.chars().count()>1000,
                "timestamp":timestamp,"timeSource":if item.get("createdAt").or_else(|| item.get("timestamp")).is_some(){"native"}else{"first-observed"},"observedAt":observed}));
        }
    }
    if let Some(pending) = pending {
        let previous = state["pending"].as_object().cloned().unwrap_or_default();
        for (key, request) in previous {
            if pending.iter().any(|r| r["id"] == request["id"]) {
                continue;
            }
            if state["responses"].get(&key).is_none() {
                state["inputs"].as_array_mut().unwrap().push(json!({"kind":"interactionResolved","turnId":request["params"]["turnId"],
                    "requestId":request["id"],"method":request["method"],"text":"Native interaction resolved outside ARC; answer/decision unavailable.",
                    "timestamp":now(),"timeSource":"first-observed","outcome":"unknown"}));
            }
        }
        state["pending"] = json!({});
        for request in pending {
            state["pending"][request["id"].to_string()] = request.clone();
        }
    }
    if state != before {
        save(&path(thread), &state)?;
    }
    Ok(())
}

pub(crate) fn inputs(thread: &str, turn: Option<&str>) -> Result<Value> {
    let _guard = LOCK.lock().unwrap();
    Ok(json!(read(thread)?["inputs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| turn.is_none_or(|turn| r["turnId"] == turn || r["answeredTurnId"] == turn))
        .cloned()
        .collect::<Vec<_>>()))
}
