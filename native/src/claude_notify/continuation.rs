//! Native retry provenance, bounded by the predecessor's persisted terminal time.
use super::*;

const WINDOW_SECONDS: i64 = 10 * 60;

// Native environment updates use role:user but are not user-authored task input.
// Exempt only a complete, standalone environment block; mixed/unknown content fails closed.
fn environment_update(p: &Value) -> bool {
    p["content"].as_array().is_some_and(|rows| {
        rows.len() == 1
            && rows[0]["type"] == "input_text"
            && rows[0]["text"].as_str().is_some_and(|text| {
                let text = text.trim();
                text.starts_with("<environment_context>\n")
                    && text.ends_with("\n</environment_context>")
                    && text.matches("</environment_context>").count() == 1
            })
    })
}

pub(crate) fn evidence(thread: &Value, previous: &str, next: Option<&Value>) -> Value {
    let Some(next) = next else { return Value::Null };
    control::persisted_history(thread)
        .and_then(|text| evidence_from_history(thread, previous, next, &text))
        .unwrap_or(Value::Null)
}

pub(crate) fn evidence_from_history(
    thread: &Value,
    previous: &str,
    next: &Value,
    text: &str,
) -> Result<Value> {
    if next["items"]
        .as_array()
        .is_some_and(|items| items.iter().any(|i| i["type"] == "userMessage"))
    {
        return Ok(
            json!({"excluded":true,"reason":"new-user-content","successorTurnId":next["id"]}),
        );
    }
    let mut matched = false;
    let mut active = String::new();
    let mut ended = None;
    let mut successor = Value::Null;
    let mut input = false;
    let mut configuration = Value::Null;
    for line in text.lines() {
        let event: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
        let p = &event["payload"];
        if event["type"] == "session_meta" {
            matched = p["id"] == thread["id"];
        }
        if !matched {
            continue;
        }
        if event["type"] == "event_msg" && p["type"] == "task_started" {
            if !successor.is_null() {
                break;
            }
            if active == previous && p["turn_id"] != previous {
                successor = p.clone();
            }
            active = string(p, "turn_id").into();
        }
        if event["type"] == "event_msg"
            && p["turn_id"] == previous
            && matches!(string(p, "type"), "task_complete" | "turn_aborted")
        {
            ended = p["completed_at"].as_i64().or_else(|| {
                chrono::DateTime::parse_from_rfc3339(string(&event, "timestamp"))
                    .ok()
                    .map(|t| t.timestamp())
            });
        }
        if ended.is_none() {
            continue;
        }
        if (event["type"] == "response_item" && p["role"] == "user" && !environment_update(p))
            || (event["type"] == "event_msg" && p["type"] == "user_message")
        {
            input = true;
        }
        if event["type"] == "turn_context"
            && p["turn_id"] == successor["turn_id"]
            && p["cwd"] == thread["cwd"]
            && p["model"].is_string()
            && p["effort"].is_string()
            && p.get("service_tier").is_some()
        {
            configuration = json!({"model":p["model"],"effort":p["effort"],"serviceTier":p["service_tier"],"source":"native-persisted-turn-context"});
        }
    }
    let Some(ended) = ended else {
        return Ok(Value::Null);
    };
    let deadline = ended.saturating_add(WINDOW_SECONDS);
    let mut result = json!({"until":deadline,"successorTurnId":next["id"],"reason":"continuation-evidence-incomplete"});
    if input {
        result["excluded"] = json!(true);
        result["reason"] = json!("new-user-content");
        return Ok(result);
    }
    let trigger = string(&successor["turn_attribution"], "turn_trigger");
    let started = successor["started_at"].as_i64();
    // Eligibility uses native event time, not observation time: downtime must not
    // expire a continuation that already started inside the native window.
    if next["id"] == successor["turn_id"]
        && started
            .is_some_and(|t| t >= ended && (trigger == "resume_interrupted_task" || t <= deadline))
        && matches!(
            trigger,
            "capacity_retry_automatic" | "capacity_retry_manual" | "resume_interrupted_task"
        )
        && next["items"]
            .as_array()
            .is_some_and(|items| items.iter().all(|i| i["type"] != "userMessage"))
        && configuration.is_object()
    {
        result["reason"] = json!("native-continuation");
        result["retry"] = json!({"turnId":next["id"],"trigger":trigger,"startedAt":started,"configuration":configuration,"state":notice_state(&lifecycle::observed(&crate::turn_lifecycle::TurnKey::new("codex",string(thread,"id"),string(next,"id")), &json!({"recordedStatus":next["status"],"state":if next["status"]=="inProgress" {"running"}else{"unconfirmed"}}), 0).state())});
    } else if !matches!(
        trigger,
        "capacity_retry_automatic" | "capacity_retry_manual" | "resume_interrupted_task"
    ) {
        result["excluded"] = json!(true);
        result["reason"] = json!("unknown-native-trigger");
    } else if started
        .is_some_and(|t| t < ended || (trigger != "resume_interrupted_task" && t > deadline))
    {
        result["excluded"] = json!(true);
        result["reason"] = json!("outside-continuation-window");
    }
    Ok(result)
}

fn retry_observation(thread: &str, retry: &Value) -> Value {
    json!({"threadId":thread,"turnId":retry["turnId"],"recordedStatus":retry["state"],
        "state":match string(retry,"state") {"running" | "inProgress"=>"running", "needs-input" | "interaction-required"=>"interaction-required", _=>"unconfirmed"}})
}

fn notice_state(state: &TurnState) -> &'static str {
    turn_adapter::push(state).unwrap_or(if *state == TurnState::Active {
        "running"
    } else {
        "unknown"
    })
}

pub(super) fn notice(b: &Binding, observation: &Value, all: &[Binding]) -> Value {
    if b.successor["inherited"] != true {
        return Value::Null;
    }
    let Some(mut turn) = b.successor["turnId"].as_str() else {
        return Value::Null;
    };
    let mut state = "unknown";
    let retry = &observation["nativeContinuation"]["retry"];
    if retry["turnId"] == turn {
        let key = crate::turn_lifecycle::TurnKey::new(&b.key().agent, &b.thread_id, turn);
        let native = retry_observation(&b.thread_id, retry);
        state = notice_state(&lifecycle::observed(&key, &native, 0).state());
    }
    // Follow only confirmed continuations owned by this source. Bound the walk
    // even if a damaged record links back to an earlier turn.
    for _ in 0..all.len() {
        let Some(next) = all.iter().find(|next| {
            next.thread_id == b.thread_id && next.turn_id == turn && next.source_id == b.source_id
        }) else {
            break;
        };
        let mut successor = next.clone();
        if retry["turnId"] == turn {
            lifecycle::merge(&mut successor, &retry_observation(&b.thread_id, retry));
        }
        state = notice_state(&successor.turn_state());
        if next.successor["inherited"] != true {
            break;
        }
        let Some(successor) = next.successor["turnId"].as_str() else {
            break;
        };
        if successor == turn {
            break;
        }
        turn = successor;
        state = "unknown";
    }
    json!({"turnId":turn,"state":state})
}

// Called under the notification lock; record-first writes are restart-idempotent.
fn close_scope(dir: &Path, b: &mut Binding, reason: &str) -> Result<()> {
    let start = |b: &Binding| {
        if b.scope_started_at == 0 {
            b.created_at.saturating_mul(1000)
        } else {
            b.scope_started_at
        }
    };
    for mut member in index::thread(dir, &b.thread_id)?
        .into_iter()
        .filter(|member| {
            member.thread_id == b.thread_id
                && member.source_id == b.source_id
                && start(member) == start(b)
        })
    {
        member.scope_end = Some(reason.into());
        persist(dir, &member)?;
    }
    b.scope_end = Some(reason.into());
    Ok(())
}

pub(super) fn adopt(dir: &Path, b: &mut Binding, observation: &Value) -> Result<()> {
    if !lifecycle::same_key(&b.key(), observation)
        || matches!(b.turn_state(), TurnState::Conflict(_))
    {
        return Ok(());
    }
    if observation["archived"] == true {
        close_scope(dir, b, "thread-archived")?;
    }
    if b.scope_end.is_some() || (!b.agent.is_empty() && b.agent != "codex") {
        return Ok(());
    }
    if let Some(next) = observation["nextTurnId"].as_str() {
        if uuid::Uuid::parse_str(&b.thread_id).is_ok()
            && crate::dispatch_policy::records(&b.thread_id)?
                .iter()
                .any(|row| row["turnId"] == next && row["dispatchSource"] != "native-retry")
        {
            // ARC records accepted dispatches before binding. Do not close an
            // origin scope in that gap; bind owns explicit scope replacement.
            return Ok(());
        }
        if turn_adapter::push(&b.turn_state()) == Some("completed") && !b.continuation_bound {
            b.successor = json!({"turnId":next,"inherited":false,"reason":"predecessor-completed"});
            close_scope(dir, b, "unrelated-native-turn")?;
            persist(dir, b)?;
            return Ok(());
        }
    }
    if matches!(
        turn_adapter::push(&b.turn_state()),
        Some("interrupted" | "failed")
    ) && !b.continuation_bound
    {
        if observation["nextTurnId"].is_string()
            && !observation["nativeContinuation"]["retry"].is_object()
            && observation["nativeContinuation"]["excluded"] != true
        {
            b.successor = json!({"turnId":observation["nextTurnId"],"inherited":false,
                "reason":"pending-native-provenance"});
            persist(dir, b)?;
        }
        if observation["nativeContinuation"]["excluded"] == true {
            b.successor = json!({"turnId":observation["nextTurnId"],"inherited":false,"reason":observation["nativeContinuation"]["reason"]});
            close_scope(dir, b, "unrelated-native-content")?;
            b.continuation_bound = true;
            persist(dir, b)?;
            return Ok(());
        }
        // Allow a bounded re-read if terminal history has not flushed yet. Adoption
        // still requires the native deadline; reads/restarts never extend this grace.
        let until = if turn_adapter::push(&b.turn_state()) == Some("interrupted") {
            i64::MAX
        } else {
            observation["nativeContinuation"]["until"]
                .as_i64()
                .unwrap_or_else(|| {
                    if b.continuation_until == 0 {
                        chrono::Utc::now().timestamp() + WINDOW_SECONDS
                    } else {
                        b.continuation_until
                    }
                })
        };
        if b.continuation_until != until {
            b.continuation_until = until;
            persist(dir, b)?;
        }
        let retry = &observation["nativeContinuation"]["retry"];
        if let Some(next) = retry["turnId"].as_str().filter(|s| !s.is_empty()) {
            if !crate::dispatch_policy::record_native_retry(&b.thread_id, &b.turn_id, retry)? {
                // An independently ARC-dispatched successor keeps its own origin/binding.
                b.continuation_bound = true;
                b.successor =
                    json!({"turnId":next,"inherited":false,"reason":"independent-dispatch"});
                persist(dir, b)?;
            } else {
                let mut successor = binding(dir, &b.thread_id, next)?.unwrap_or_else(|| {
                    let mut next_binding = b.clone();
                    next_binding.turn_id = next.into();
                    next_binding.scope_started_at = if b.scope_started_at == 0 {
                        b.created_at.saturating_mul(1000)
                    } else {
                        b.scope_started_at
                    };
                    next_binding.created_at = chrono::Utc::now().timestamp();
                    next_binding.lifecycle = Value::Null;
                    next_binding.waiting.clear();
                    next_binding.deliveries.clear();
                    next_binding.explicit = false;
                    next_binding.continuation_bound = false;
                    next_binding.continuation_until = 0;
                    next_binding.successor = Value::Null;
                    next_binding.observation = Value::Null;
                    next_binding.retry = json!({"status":"skipped","reason":"native-retry-owned"});
                    next_binding.caused_by["retryOf"] = json!(b.turn_id);
                    next_binding
                });
                if !successor.explicit {
                    successor.target = b.target.clone();
                    successor.channel = b.channel;
                    for d in &mut successor.deliveries {
                        if d.status == "pending" && d.target.is_empty() {
                            d.target = b.target.clone().unwrap_or_default();
                            d.channel = b.channel;
                        }
                    }
                    persist(dir, &successor)?;
                }
                b.continuation_bound = true;
                b.successor = json!({"turnId":next,"inherited":!successor.explicit,"reason":"native-continuation"});
                persist(dir, b)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history(trigger: &str, input: Option<Value>) -> String {
        let mut rows = vec![
            json!({"type":"session_meta","payload":{"id":"thread"}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"old"}}),
            json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"old","completed_at":1000}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"next","started_at":1018,"turn_attribution":{"turn_trigger":trigger}}}),
            json!({"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<environment_context>\n  <current_date>2000-01-01</current_date>\n</environment_context>"}]}}),
            json!({"type":"turn_context","payload":{"turn_id":"next","cwd":"/project","model":"model","effort":"high","service_tier":null}}),
        ];
        if let Some(input) = input {
            rows.push(input);
        }
        rows.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn native_resume_is_recognized_after_downtime_with_environment_scaffolding() {
        // Regression: restart recovery rejected native resume because environment context had role:user and recognition was late.
        for trigger in [
            "resume_interrupted_task",
            "capacity_retry_automatic",
            "capacity_retry_manual",
        ] {
            let proof = evidence_from_history(
                &json!({"id":"thread","cwd":"/project"}),
                "old",
                &json!({"id":"next","status":"completed","items":[]}),
                &history(trigger, None),
            )
            .unwrap();
            assert_eq!(proof["retry"]["turnId"], "next");
            assert_eq!(proof["retry"]["trigger"], trigger);
            assert_eq!(proof["retry"]["state"], "completed");
            assert_eq!(proof["until"], 1600);
        }
    }

    #[test]
    fn new_input_unknown_provenance_and_malformed_history_do_not_inherit() {
        // Regression: native continuation must never inherit across genuinely new user content or unproven provenance.
        let thread = json!({"id":"thread","cwd":"/project"});
        let next = json!({"id":"next","items":[]});
        for input in [
            json!({"type":"event_msg","payload":{"type":"user_message","message":"Continue"}}),
            json!({"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"New task"}]}}),
            json!({"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<environment_context>\n</environment_context>\nNew task"}]}}),
        ] {
            let proof = evidence_from_history(
                &thread,
                "old",
                &next,
                &history("resume_interrupted_task", Some(input)),
            )
            .unwrap();
            assert!(proof["retry"].is_null());
            assert_eq!(proof["excluded"], true);
        }
        assert!(
            evidence_from_history(&thread, "old", &next, &history("unknown", None)).unwrap()
                ["retry"]
                .is_null()
        );
        assert!(evidence_from_history(
            &thread,
            "old",
            &next,
            &(history("resume_interrupted_task", None) + "\n{partial")
        )
        .is_err());
        let late = history("capacity_retry_automatic", None).replace("1018", "1601");
        assert!(evidence_from_history(&thread, "old", &next, &late).unwrap()["retry"].is_null());
        assert!(evidence_from_history(
            &thread,
            "old",
            &json!({"id":"next","items":[{"type":"userMessage"}]}),
            &history("resume_interrupted_task", None)
        )
        .unwrap()["retry"]
            .is_null());
    }
}
