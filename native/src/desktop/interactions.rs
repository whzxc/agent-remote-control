//! Desktop-owned questions and server requests, observed and answered through its IPC owner.
use super::*;

fn route(method: &str) -> Option<(&'static str, &'static str)> {
    Some(match method {
        "item/commandExecution/requestApproval" => {
            ("thread-follower-command-approval-decision", "decision")
        }
        "item/fileChange/requestApproval" => ("thread-follower-file-approval-decision", "decision"),
        "item/permissions/requestApproval" => (
            "thread-follower-permissions-request-approval-response",
            "response",
        ),
        "item/tool/requestUserInput" => ("thread-follower-submit-user-input", "response"),
        "mcpServer/elicitation/request" => (
            "thread-follower-submit-mcp-server-elicitation-response",
            "response",
        ),
        _ => return None,
    })
}

pub(crate) fn pending(state: &Value, session: &str) -> Vec<Value> {
    let thread = &state["id"];
    let history = &state["turnHistory"]["history"]["entitiesByKey"];
    let turns: Vec<_> = history
        .as_object()
        .into_iter()
        .flat_map(|h| h.values())
        .collect();
    let mut answered = std::collections::HashSet::new();
    for turn in &turns {
        for item in turn["items"].as_array().into_iter().flatten() {
            let content = match string(item, "type") {
                "userMessage" => &item["content"],
                "steeringUserMessage" if item["status"] == "accepted" => &item["input"],
                _ => continue,
            };
            for part in content.as_array().into_iter().flatten() {
                let text = string(part, "text").trim();
                if let Some(body) = text
                    .strip_prefix("<send_user_message_question_reply>")
                    .and_then(|s| s.strip_suffix("</send_user_message_question_reply>"))
                {
                    if let Ok(reply) = serde_json::from_str::<Value>(body) {
                        let replies = reply.as_array().cloned().unwrap_or_else(|| vec![reply]);
                        for reply in replies {
                            if let Some(id) = reply["questionItemId"].as_str() {
                                answered.insert(id.to_owned());
                            }
                        }
                    }
                }
            }
        }
    }
    let mut requests = Vec::new();
    for request in state["requests"].as_array().into_iter().flatten() {
        let method = string(request, "method");
        if route(method).is_none()
            && !matches!(
                method,
                "item/tool/requestOptionPicker" | "item/plan/requestImplementation"
            )
            && !(method == "item/tool/call"
                && matches!(
                    string(&request["params"], "tool"),
                    "request_user_input"
                        | "request_onboarding_input"
                        | "request_environment_input"
                        | "request_option_picker"
                ))
        {
            continue;
        }
        let mut r = request.clone();
        r["nativeId"] = request["id"].clone();
        r["params"]["threadId"] = thread.clone();
        r["canRespond"] = json!(
            route(string(request, "method")).is_some()
                && request["params"]["mode"] != "openai/userVerification"
        );
        requests.push(r);
    }
    for turn in &turns {
        for item in turn["items"].as_array().into_iter().flatten() {
            if item["type"] != "agentMessage" {
                continue;
            }
            for (index, question) in item["questions"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
            {
                let question_id =
                    json!(["request_user_input_async", item["id"], index]).to_string();
                if answered.contains(&question_id) {
                    continue;
                }
                requests.push(json!({"nativeId":question_id,"method":"request_user_input_async","canRespond":true,
                    "params":{"threadId":thread,"turnId":turn["turnId"],"questionItemId":question_id,
                    "question":question["title"],"options":question["options"]}}));
            }
        }
    }
    for r in &mut requests {
        if let Some(turn) = turns
            .iter()
            .find(|turn| turn["turnId"] == r["params"]["turnId"])
        {
            r["turnStatus"] = turn["status"].clone();
        }
        r["id"] = json!(json!([
            "desktop",
            thread,
            r["params"]["turnId"],
            r["method"],
            r["nativeId"]
        ])
        .to_string());
        r["responseId"] = r["id"].clone();
        r["backendSession"] = json!(session);
        r["owner"] = json!("desktop");
        r["next"] = if r["canRespond"] == true {
            json!({"via":"act","op":"codex_respond","args":{"id":r["id"],"backendSession":session},
                "hint":if r["method"] == "request_user_input_async" {"Supply result: {answer: <chosen option or free text>}."} else {"Supply result using this native request's response schema; never invent approval."}})
        } else {
            json!({"hint":"Handle in Codex Desktop. No supported response path."})
        };
    }
    requests
}

pub(super) async fn sync(events: &SharedEvents, state: &Value, session: &str) {
    let requests = pending(state, session);
    if let Ok(turns) = turns(state) {
        if let Err(error) =
            crate::external_inputs::observe(string(state, "id"), &turns, Some(&requests))
        {
            crate::logs::record("WARN", &error, None);
        }
    }
    let mut events = events.lock().await;
    events
        .pending
        .retain(|_, r| r["owner"] != "desktop" || r["params"]["threadId"] != state["id"]);
    for mut r in requests {
        if let Err(error) =
            crate::claude_notify::routing::observe("codex", string(state, "id"), &mut r)
        {
            crate::logs::record("WARN", &error, None);
        }
        events.pending.insert(string(&r, "responseId").into(), r);
    }
}

impl Ipc {
    pub(crate) async fn respond(&self, key: &str, result: &Value) -> Result<Value> {
        let identity: Value = serde_json::from_str(key).map_err(|_| "STALE_INTERACTION")?;
        let thread = identity[1].as_str().ok_or("STALE_INTERACTION")?;
        let owner = self.owner(thread).await?;
        self.snapshots.lock().await.remove(thread);
        let state = self.read_owned(thread, true, &owner).await?;
        let request = pending(&state, &self.session)
            .into_iter()
            .find(|r| r["id"] == key)
            .ok_or("STALE_INTERACTION")?;
        if request["canRespond"] != true {
            return Err("DESKTOP_RESPONSE_UNSUPPORTED: Handle in Codex Desktop".into());
        }
        let mut next_turn = Value::Null;
        if request["method"] == "request_user_input_async" {
            let answer = result["answer"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or("result.answer must be nonempty text")?;
            let text = format!(
                "<send_user_message_question_reply>\n{}\n</send_user_message_question_reply>",
                json!([{"questionItemId":request["nativeId"],"question":request["params"]["question"],"answer":answer}])
            );
            let mut args = json!({"threadId":thread,"input":[{"type":"text","text":text}]});
            let active = turns(&state)?
                .into_iter()
                .rev()
                .find(|t| t["status"] == "inProgress");
            let token = crate::external_inputs::begin(
                thread,
                &turns(&state)?,
                &args["input"],
                &active
                    .as_ref()
                    .map(|t| t["id"].clone())
                    .unwrap_or(Value::Null),
            )?;
            let result = if let Some(turn) = active {
                args["expectedTurnId"] = turn["id"].clone();
                self.mutate("turn/steer", &args).await
            } else {
                self.mutate("turn/start", &args).await
            };
            crate::external_inputs::submitted(thread, &token, &result).map_err(|e| {
                format!("SUBMISSION_UNCONFIRMED: input provenance persistence failed: {e}")
            })?;
            next_turn = result?["turn"]["id"].clone();
        } else {
            let (method, field) =
                route(string(&request, "method")).ok_or("DESKTOP_RESPONSE_UNSUPPORTED")?;
            let mut params = json!({"conversationId":thread,"requestId":request["nativeId"]});
            params[field] = if field == "decision" {
                result
                    .get("decision")
                    .filter(|v| v.is_string() || v.is_object())
                    .cloned()
                    .ok_or("result.decision required")?
            } else {
                result.clone()
            };
            let reply = self.request(method, params, Some(&owner)).await?;
            if reply["result"]["ok"] != true {
                return Err("SUBMISSION_UNCONFIRMED: Desktop did not acknowledge response".into());
            }
        }
        // The follower ACK alone is not proof that the owner consumed a response.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            self.snapshots.lock().await.remove(thread);
            let state = self
                .read_owned(thread, true, &owner)
                .await
                .map_err(|e| format!("SUBMISSION_UNCONFIRMED: {e}"))?;
            sync(&self.events, &state, &self.session).await;
            if !pending(&state, &self.session)
                .iter()
                .any(|r| r["id"] == key)
            {
                return Ok(
                    json!({"responseSent":true,"resolved":true,"threadId":thread,"id":key,"backendSession":self.session,"nextTurnId":next_turn,"answeredTurnId":request["params"]["turnId"]}),
                );
            }
            if Instant::now() >= deadline {
                return Err("SUBMISSION_UNCONFIRMED: Desktop still exposes this interaction; read before retrying".into());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unanswered_async_questions_retain_terminal_evidence_until_the_owner_records_a_reply() {
        // Recurring bug class: Desktop history kept finished-turn async questions pending without exposing their terminal status.
        let mut state = json!({"id":"thread","turnHistory":{"history":{"entitiesByKey":{
            "old":{"turnId":"old","status":"completed","items":[{"id":"message","type":"agentMessage","questions":[{"title":"Choose","options":["A","B"]}]}]},
            "new":{"turnId":"new","status":"inProgress","items":[]}
        }}}});
        let requests = pending(&state, "session");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["owner"], "desktop");
        assert_eq!(requests[0]["turnStatus"], "completed");
        let mut events = Events::default();
        events
            .pending
            .insert("question".into(), requests[0].clone());
        events.timelines.entry("thread".into()).or_default().codex(
            "turn/started",
            &json!({"turn":{"id":"old"}}),
            "2026-01-01T00:00:00Z",
        );
        let surfaced = events.pending_interactions();
        assert_eq!(surfaced[0]["stale"], true);
        assert_eq!(surfaced[0]["canRespond"], true);
        assert_eq!(surfaced[0]["params"]["turnId"], "old");
        let reply = json!([{"questionItemId":requests[0]["nativeId"],"answer":"A"}]);
        state["turnHistory"]["history"]["entitiesByKey"]["new"]["items"] = json!([{"type":"userMessage","content":[{"type":"text","text":format!("<send_user_message_question_reply>{reply}</send_user_message_question_reply>")}]}]);
        assert!(pending(&state, "session").is_empty());
    }
}
