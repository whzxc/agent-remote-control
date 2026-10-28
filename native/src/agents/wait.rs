//! Process-owned observations for the same bounded waiter used by Codex.
use super::*;
use crate::waiter::WaitSource;
use tokio::time::Instant;

struct AgentSource {
    host: Arc<AgentHost>,
    agent: String,
    task: String,
    process_session: Option<Value>,
}
impl WaitSource for AgentSource {
    // A process may still be initializing after the durable create receipt.
    // observe checks the actual child once it exists; it never starts/resumes one.
    fn alive(&self) -> bool {
        true
    }
    fn deadline_is_timeout(&self) -> bool {
        true
    }
    async fn observe(&mut self) -> Result<Value> {
        archive::ensure_observable(&self.agent, &self.task)?;
        let dispatches = self
            .host
            .operations
            .lock()
            .await
            .values()
            .filter(|op| op.task == self.task)
            .map(|op| op.previous_turn.clone())
            .collect::<Vec<_>>();
        // Dispatch removal happens after process insertion: read in that order so
        // a fast initialization cannot look like a missing owner between snapshots.
        let p = self.host.processes.lock().await.get(&self.task).cloned();
        let Some(p) = p else {
            if !dispatches.is_empty() && self.process_session.is_none() {
                return Ok(json!({"status":"starting","dispatching":true}));
            }
            return Err("process-ownership-unconfirmed".into());
        };
        if let Err(error) = p.check_alive().await {
            let previous = p.state.lock().await["turnId"].clone();
            if self.process_session.is_none() && dispatches.contains(&previous) {
                // An already authorized send may be restoring a confirmed old session.
                // Only its dispatch owns that restart; the waiter itself never resumes.
                return Ok(json!({"status":"starting","dispatching":true}));
            }
            return Err(error);
        }
        // ACP has no standard session/status RPC. Its live owned stream and final
        // prompt response are authoritative; child.try_wait verifies process health.
        let pending = !p.events.lock().await.pending.is_empty();
        let runtime = if p.pi && !pending {
            p.call("get_state", json!({}), 10000).await?
        } else {
            Value::Null
        };
        let mut task = p.state.lock().await.clone();
        if task["agent"] != self.agent {
            return Err("AGENT_TASK_MISMATCH".into());
        }
        if self
            .process_session
            .as_ref()
            .is_some_and(|s| *s != task["processSession"])
        {
            return Err("process-owner-changed".into());
        }
        self.process_session = Some(task["processSession"].clone());
        if p.pi && !runtime.is_null() && runtime["sessionId"] != task["sessionId"] {
            return Err("native-session-id-mismatch".into());
        }
        task["dispatching"] = json!(dispatches.contains(&task["turnId"]));
        let e = p.events.lock().await;
        let mut interactions = e
            .pending
            .values()
            .cloned()
            .map(|mut r| {
                r["interactionId"] = r["id"].clone();
                r["backendSession"] = task["processSession"].clone();
                r
            })
            .collect::<Vec<_>>();
        for request in &mut interactions {
            crate::claude_notify::routing::observe(&self.agent, &self.task, request)?;
        }
        interactions.sort_by_key(|r| r["interactionId"].to_string());
        task["interaction"] = json!(interactions);
        task["runtime"] = runtime;
        drop(e);
        p.check_alive().await?;
        Ok(task)
    }
    fn classify(&mut self, t: &Value, selected: &mut Option<String>) -> Value {
        let dispatching = t["dispatching"] == true;
        if selected.is_none() && !dispatching {
            *selected = t["turnId"].as_str().map(str::to_owned);
        }
        let status = string(t, "status");
        let (state, reason) = if selected.is_some() && t["turnId"].as_str() != selected.as_deref() {
            ("unconfirmed", "turn-changed-or-unavailable")
        } else if !t["interaction"].as_array().is_none_or(Vec::is_empty) {
            ("interaction-required", "agent-interaction")
        } else if dispatching {
            ("running", "agent-dispatching")
        } else if matches!(status, "completed" | "failed" | "cancelled") {
            if t["runtime"]["isStreaming"] == true
                || t["runtime"]["isCompacting"] == true
                || t["runtime"]["pendingMessageCount"].as_u64().unwrap_or(0) > 0
            {
                ("unconfirmed", "inconsistent-native-state")
            } else {
                (status, "agent-turn-terminal")
            }
        } else if matches!(status, "starting" | "running" | "cancelling") {
            ("running", "agent-turn-active")
        } else {
            ("unconfirmed", "agent-state-unknown-or-no-turn")
        };
        json!({"state":state,"reason":reason,"title":t["title"],"agent":self.agent,"taskId":self.task,
            "sessionId":t["sessionId"],"threadId":null,"turnId":selected,
            "recordedStatus":t["status"],"runtimeStatus":if state=="unconfirmed"{"unknown"}else{status},
            "runtimeSource":self.host.drivers[&self.agent].protocol(),"processSession":t["processSession"],
            "finalResponse":final_response(t, state, self.host.drivers[&self.agent].protocol()),
            "outputTruncated":t["outputTruncated"],"contextUsage":t["contextUsage"],
            "error":if t["error"].is_null(){&t["lastMessage"]["errorMessage"]}else{&t["error"]},
            "stopReason":if t["stopReason"].is_null(){&t["lastMessage"]["stopReason"]}else{&t["stopReason"]},
            "progress":{"pendingInteractions":t["interaction"].as_array().into_iter().flatten().take(5).map(crate::egress::interaction_preview).collect::<Vec<_>>()},
            "interaction":t["interaction"].as_array().cloned().unwrap_or_default(),
            "interactionAction":if state=="interaction-required"{Some("Use agent_pending or agent_respond with agent, taskId, interactionId and a new requestId; do not resend the task")}else{None},
            "observedAt":now()})
    }
}
pub(super) async fn agent_wait(
    host: &Arc<AgentHost>,
    native: &Arc<control::Control>,
    args: &Value,
) -> Result<Value> {
    let started = Instant::now();
    let task = string(args, "taskId");
    task_path(task)?;
    archive::ensure_observable(string(args, "agent"), task)?;
    let mut source = AgentSource {
        host: host.clone(),
        agent: string(args, "agent").into(),
        task: task.into(),
        process_session: None,
    };
    let mut result = crate::waiter::wait(
        &mut source,
        host.wake.clone(),
        native.shutdown.subscribe(),
        args,
        started,
    )
    .await;
    result["agent"] = args["agent"].clone();
    result["taskId"] = args["taskId"].clone();
    result["runtimeSource"] = json!(host.drivers[string(args, "agent")].protocol());
    crate::waiter::condition(&mut result, args);
    Ok(result)
}

pub(super) async fn observe(
    host: &Arc<AgentHost>,
    agent: &str,
    task: &str,
    turn: &str,
) -> Result<Value> {
    let mut source = AgentSource {
        host: host.clone(),
        agent: agent.into(),
        task: task.into(),
        process_session: None,
    };
    let observation = source.observe().await?;
    Ok(source.classify(&observation, &mut Some(turn.into())))
}

fn final_response(task: &Value, state: &str, protocol: &str) -> Value {
    if matches!(
        state,
        "completed" | "failed" | "cancelled" | "interaction-required"
    ) || (protocol == "pi-rpc" && task["lastMessage"]["role"] == "assistant")
    {
        task["output"].clone()
    } else {
        Value::Null
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_completed_pi_messages_are_available_before_terminal_or_interaction() {
        // Property: only completed pi messages are available before terminal or interaction.
        let mut task = json!({"output":"partial"});
        for protocol in ["pi-rpc", "acp-v1"] {
            assert!(final_response(&task, "running", protocol).is_null());
            for state in ["completed", "failed", "cancelled", "interaction-required"] {
                assert_eq!(final_response(&task, state, protocol), "partial");
            }
        }
        task["lastMessage"] = json!({"role":"assistant"});
        task["output"] = json!("completed message");
        assert_eq!(
            final_response(&task, "running", "pi-rpc"),
            "completed message"
        );
        assert!(final_response(&task, "running", "acp-v1").is_null());
    }
}
