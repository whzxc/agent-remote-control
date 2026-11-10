//! Bounded, read-only waiting. Notifications are hints; only fresh owner reads decide state.
use crate::turn_lifecycle::{
    adapters::{self, WaitState},
    advance, Transition, TurnKey,
};
use crate::{control::Control, desktop::Ipc, rpc::Rpc, *};
use std::{future::Future, time::Duration};
use tokio::{
    sync::{watch, Notify},
    time::Instant,
};

/// Agent adapters provide a fresh observation and a cheap connection health check.
/// No registry/global mutex is held while this engine waits or reads the owner.
pub(crate) trait WaitSource {
    fn observe(&mut self) -> impl Future<Output = Result<Value>> + Send;
    fn alive(&self) -> bool;
    fn classify(&mut self, observation: &Value, selected: &mut Option<String>) -> Value;
    fn deadline_is_timeout(&self) -> bool {
        false
    }
}

pub(crate) async fn wait(
    source: &mut impl WaitSource,
    wake: Arc<Notify>,
    mut shutdown: watch::Receiver<u64>,
    args: &Value,
    started: Instant,
) -> Value {
    let deadline = started + Duration::from_millis(args["timeoutMs"].as_u64().unwrap_or(30000));
    let mut last = json!({"threadId":args["threadId"],"turnId":args["turnId"],"recordedStatus":null,"runtimeStatus":"unknown","interaction":[],"finalResponse":null});
    let mut baseline = args["expectedHash"].as_str().map(str::to_owned);
    let mut selected = args["turnId"].as_str().map(str::to_owned);
    let mut reason = crate::runtime_metrics::cost::Reason::Poll;
    loop {
        if !source.alive() {
            return finish(
                last,
                "unconfirmed",
                "connection-closed",
                started,
                baseline.as_deref(),
            );
        }
        if shutdown.has_changed().unwrap_or(true) {
            return finish(
                last,
                "unconfirmed",
                "connector-shutdown",
                started,
                baseline.as_deref(),
            );
        }
        if Instant::now() >= deadline {
            return deadline_result(last, started, baseline.as_deref());
        }
        let observation = tokio::select! {
            biased;
            _ = shutdown.changed() => return finish(last, "unconfirmed", "connector-shutdown", started, baseline.as_deref()),
            result = tokio::time::timeout_at(deadline.min(Instant::now()+Duration::from_secs(10)), crate::runtime_metrics::cost::scope(crate::runtime_metrics::cost::Owner::ScopedWait, reason, async {
                crate::runtime_metrics::cost::scan_set(1);
                crate::runtime_metrics::cost::rows(1);
                source.observe().await
            })) => result,
        };
        let observed = match observation {
            Ok(result) => result,
            Err(_)
                if Instant::now() >= deadline
                    && (source.deadline_is_timeout() || !last["observedAt"].is_null()) =>
            {
                return deadline_result(last, started, baseline.as_deref());
            }
            Err(_) => Err("native-read-timeout".into()),
        };
        if !source.alive() {
            return finish(
                last,
                "unconfirmed",
                "connection-closed",
                started,
                baseline.as_deref(),
            );
        }
        match observed {
            Ok(observed) => {
                last = source.classify(&observed, &mut selected);
                baseline.get_or_insert_with(|| snapshot_hash(&last));
                let state = string(&last, "state").to_owned();
                // Terminal and interaction states always break a wait; until only
                // determines conditionMet. Content changes do not end the wait.
                if WaitState::from_wire(&state) != Some(WaitState::Running) {
                    let reason = string(&last, "reason").to_owned();
                    return finish(last, &state, &reason, started, baseline.as_deref());
                }
            }
            Err(error)
                if matches!(
                    error.as_str(),
                    "native-read-timeout"
                        | "DESKTOP_SNAPSHOT_TIMEOUT"
                        | "RPC_TIMEOUT: thread/read"
                        | "RPC_TIMEOUT: thread/turns/list"
                ) =>
            {
                // A read timeout is not the wait deadline. Keep the last observation
                // and its timestamp, but do not claim its state is still confirmed.
                last["state"] = json!("unconfirmed");
                last["reason"] = json!(error);
            }
            Err(error) => return finish(last, "unconfirmed", &error, started, baseline.as_deref()),
        }
        // Register after the read: Desktop reads themselves publish snapshots. Do not
        // let these self-generated hints cause a read/notification feedback loop.
        // A missed/coalesced hint (including buffer gap/reset) is repaired in 2 seconds.
        let notified = wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        tokio::select! {
            biased;
            _ = shutdown.changed() => return finish(last, "unconfirmed", "connector-shutdown", started, baseline.as_deref()),
            _ = tokio::time::sleep_until(deadline) => return deadline_result(last, started, baseline.as_deref()),
            _ = notified => {
                reason = crate::runtime_metrics::cost::Reason::Event;
                // Coalesce streaming deltas; cap reads at four/second even under load.
                tokio::select! {
                    biased;
                    _ = shutdown.changed() => return finish(last, "unconfirmed", "connector-shutdown", started, baseline.as_deref()),
                    _ = tokio::time::sleep_until(deadline.min(Instant::now()+Duration::from_millis(250))) => {},
                }
            },
            _ = tokio::time::sleep(Duration::from_secs(2)) => reason = crate::runtime_metrics::cost::Reason::Timer,
        }
    }
}
fn deadline_result(last: Value, started: Instant, baseline: Option<&str>) -> Value {
    if WaitState::from_wire(string(&last, "state")) == Some(WaitState::Unconfirmed) {
        let reason = string(&last, "reason").to_owned();
        finish(last, "unconfirmed", &reason, started, baseline)
    } else {
        finish(last, "timeout", "deadline", started, baseline)
    }
}
fn snapshot_hash(v: &Value) -> String {
    let snapshot = hash(json!({"turnId":v["turnId"],"recordedStatus":v["recordedStatus"],"runtimeStatus":v["runtimeStatus"],"interaction":v["interaction"],"finalResponse":v["finalResponse"],"error":v["error"],"externalUserInputs":v["externalUserInputs"]}).to_string());
    format!("{snapshot}:{}", response_text_hash(v))
}

fn response_text_hash(v: &Value) -> String {
    v["finalResponse"]["textHash"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            hash(
                v["finalResponse"]
                    .as_str()
                    .or_else(|| v["finalResponse"]["text"].as_str())
                    .unwrap_or(""),
            )
        })
}

/// Apply only at the control-source boundary, after notification/inbox reads.
/// The opaque snapshot token carries the text digest so no cache or new input is needed.
pub(crate) fn compact_response(v: &mut Value, args: &Value) {
    let Some(expected) = args["expectedHash"].as_str() else {
        return;
    };
    if WaitState::from_wire(string(v, "state")).is_some_and(WaitState::keeps_response) {
        return;
    }
    let text_hash = response_text_hash(v);
    let unchanged = v["snapshotHash"] == expected
        || expected
            .split_once(':')
            .is_some_and(|(_, text)| text == text_hash);
    if unchanged {
        v["finalResponseUnchanged"] = json!(true);
        if let Some(response) = v["finalResponse"].as_object_mut() {
            response.remove("text");
        } else if v["finalResponse"].is_string() {
            v.as_object_mut().unwrap().remove("finalResponse");
        }
    }
}
fn finish(
    mut v: Value,
    state: &str,
    reason: &str,
    started: Instant,
    baseline: Option<&str>,
) -> Value {
    let digest = snapshot_hash(&v);
    v["state"] = json!(state);
    v["reason"] = json!(reason);
    v["changed"] = json!(baseline.is_some_and(|h| h != digest));
    v["snapshotHash"] = json!(digest);
    v["textHash"] = json!(response_text_hash(&v));
    v["observedAt"] = v.get("observedAt").cloned().unwrap_or(Value::Null);
    v["returnedAt"] = json!(now());
    v["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
    v
}
pub(crate) fn classify(observation: &Value, selected: &mut Option<String>) -> Value {
    classify_with_lifecycle(observation, selected).0
}
pub(crate) fn classify_with_lifecycle(
    observation: &Value,
    selected: &mut Option<String>,
) -> (Value, Transition) {
    let t = &observation["thread"];
    let turns = t["turns"].as_array().cloned().unwrap_or_default();
    if selected.is_none() {
        *selected = turns
            .iter()
            .rev()
            .find(|t| adapters::codex_active(string(t, "status")))
            .or_else(|| turns.last())
            .and_then(|t| t["id"].as_str())
            .map(str::to_owned);
    }
    let turn = turns
        .iter()
        .find(|t| t["id"].as_str() == selected.as_deref())
        .cloned()
        .unwrap_or(Value::Null);
    let runtime = t["status"]["type"].as_str().unwrap_or("unknown");
    let latest = turns
        .last()
        .is_some_and(|t| t["id"].as_str() == selected.as_deref());
    let mut interactions: Vec<_> = observation["pending"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            r["params"]["threadId"] == t["id"]
                && ((r["params"]["turnId"].is_null() && latest)
                    || r["params"]["turnId"].as_str() == selected.as_deref())
        })
        .cloned()
        .map(|mut r| {
            if r["responseId"].is_null() {
                r["responseId"] = json!(r["id"].to_string());
            }
            r["questionSummary"] = crate::egress::interaction_preview(&r);
            r
        })
        .collect();
    interactions.sort_by(|a, b| string(a, "responseId").cmp(string(b, "responseId")));
    let flags = if latest {
        &t["status"]["activeFlags"]
    } else {
        &Value::Null
    };
    let blocked = flags.as_array().is_some_and(|a| {
        a.iter()
            .any(|f| matches!(f.as_str(), Some("waitingOnApproval" | "waitingOnUserInput")))
    });
    let key = TurnKey::new("codex", string(t, "id"), selected.as_deref().unwrap_or(""));
    let mut lifecycle = advance(
        &Transition::new(key.clone()),
        &adapters::codex_owner(
            key.clone(),
            (!turn.is_null()).then(|| string(&turn, "status")),
            runtime,
            !interactions.is_empty() || blocked,
            0,
        ),
    );
    // Read all records for the selected key. Contradictory native records must
    // reconcile instead of allowing array order to pick a terminal outcome.
    for native in turns
        .iter()
        .filter(|t| t["id"].as_str() == selected.as_deref())
    {
        if let Some(evidence) = (!native["_terminalUnconfirmed"].as_bool().unwrap_or(false))
            .then(|| {
                adapters::codex_terminal(
                    key.clone(),
                    string(native, "status"),
                    native["nativeSequence"].as_u64(),
                )
            })
            .flatten()
        {
            lifecycle = advance(&lifecycle, &evidence);
        }
    }
    let (state, reason) = adapters::wait(&lifecycle.state());
    let assistant = turn["items"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .find(|i| {
            i["type"] == "agentMessage"
                && (state.keeps_response()
                    || i["status"] == "completed"
                    || turn["completedItemIds"][string(i, "id")] == true
                    || turn["agentMessageCompletedAtMsById"][string(i, "id")].is_number())
        })
        .map(|i| crate::control::item(i, 0, 6000));
    let mut progress = crate::review::progress_from_turn(
        &turn,
        if blocked && interactions.is_empty() {
            None
        } else {
            Some(interactions.len())
        },
    );
    progress["pendingInteractions"] = json!(interactions
        .iter()
        .take(5)
        .map(|r| r["questionSummary"].clone())
        .collect::<Vec<_>>());
    (
        json!({"state":state.as_wire(),"reason":reason,"title":t["name"],"threadId":t["id"],"turnId":selected,"recordedStatus":turn["status"],"runtimeStatus":runtime,
        "runtimeSource":t["runtimeSource"],"archived":crate::control::summary(t)["archived"],"externalUserInputs":observation["externalUserInputs"].as_array().into_iter().flatten().filter(|r| r["turnId"].as_str()==selected.as_deref() || (r["answeredTurnId"].is_string() && r["answeredTurnId"].as_str()==selected.as_deref())).collect::<Vec<_>>(),"finalResponse":assistant,"error":turn["error"],"interaction":interactions,
        "activeFlags":flags,"interactionAction":if blocked && interactions.is_empty(){Some("Inspect Codex Desktop for the pending interaction; this owner exposes no callback ID to Agent Remote Control")}else if !interactions.is_empty(){Some("Use codex_respond with id=responseId and backendSession; do not resend the task")}else{None},
        "progress":progress,"observedAt":now()}),
        lifecycle,
    )
}

enum CodexOwner {
    Background(Arc<Rpc>),
    Desktop(Arc<Ipc>),
}
struct CodexSource {
    owner: CodexOwner,
    thread: String,
    turn: Option<String>,
    desktop_owner: Option<String>,
    events: SharedEvents,
    lifecycle: Option<Transition>,
}
impl WaitSource for CodexSource {
    fn classify(&mut self, observation: &Value, selected: &mut Option<String>) -> Value {
        let (mut result, lifecycle) = classify_with_lifecycle(observation, selected);
        self.lifecycle = Some(lifecycle);
        if WaitState::from_wire(string(&result, "state")).is_some_and(WaitState::is_terminal) {
            let turns = observation["thread"]["turns"].as_array();
            if let Some(turns) = turns {
                if let Some(index) = turns.iter().position(|t| t["id"] == result["turnId"]) {
                    result["nextTurnId"] = turns
                        .get(index + 1)
                        .map(|t| t["id"].clone())
                        .unwrap_or(Value::Null);
                    result["nativeContinuation"] = crate::claude_notify::continuation::evidence(
                        &observation["thread"],
                        string(&result, "turnId"),
                        turns.get(index + 1),
                    );
                }
            }
        }

        self.turn = selected.clone();
        result
    }
    fn alive(&self) -> bool {
        match &self.owner {
            CodexOwner::Background(r) => r.alive(),
            CodexOwner::Desktop(i) => i.alive(),
        }
    }
    async fn observe(&mut self) -> Result<Value> {
        let mut value = match &self.owner {
            CodexOwner::Background(r) => {
                let mut v = r
                    .call(
                        "thread/read",
                        json!({"threadId":self.thread,"includeTurns":false}),
                        10000,
                    )
                    .await?;
                // Paginated threads do not support the legacy full-history read.
                // Keep newer turns for latest/next-turn semantics, stopping once
                // the selected turn is found instead of loading all history.
                let mut turns = Vec::new();
                let mut cursor = Value::Null;
                loop {
                    let page = r.call("thread/turns/list", json!({"threadId":self.thread,"cursor":cursor,"limit":100,"sortDirection":"desc","itemsView":"full"}), 10000).await?;
                    turns.extend(
                        page["data"]
                            .as_array()
                            .ok_or("native-turns-missing")?
                            .iter()
                            .cloned(),
                    );
                    let next = page["nextCursor"].clone();
                    if next.is_null()
                        || self
                            .turn
                            .as_ref()
                            .is_none_or(|id| turns.iter().any(|t| t["id"] == *id))
                    {
                        break;
                    }
                    if next == cursor {
                        return Err("native-turn-cursor-repeated".into());
                    }
                    cursor = next;
                }
                turns.reverse();
                v["thread"]["turns"] = json!(turns);
                v["thread"]["runtimeSource"] = json!("connector-app-server");
                v
            }
            CodexOwner::Desktop(i) => {
                let owner = i.owner(&self.thread).await?;
                if self.desktop_owner.as_ref().is_some_and(|o| *o != owner) {
                    return Err("runtime-owner-changed".into());
                }
                self.desktop_owner = Some(owner.clone());
                let state = i.read_owned(&self.thread, true, &owner).await?;
                json!({"thread":crate::control::thread(&state, true)?})
            }
        };
        if value["thread"]["id"] != self.thread {
            return Err("native-thread-id-mismatch".into());
        }
        let selected = self
            .turn
            .as_deref()
            .or_else(|| value["thread"]["turns"].as_array()?.last()?["id"].as_str());
        if let Some(turn) = selected.filter(|turn| {
            value["thread"]["turns"].as_array().is_some_and(|turns| {
                turns.iter().any(|t| {
                    t["id"] == *turn
                        && matches!(
                            string(t, "status"),
                            "completed" | "interrupted" | "cancelled"
                        )
                })
            })
        }) {
            // A detached reader can reconstruct an interrupted snapshot while the
            // owning server has completed the turn. Verify the exact native key
            // before that snapshot can produce a terminal event or wake.
            let turn = turn.to_owned();
            let history = crate::control::persisted_history(&value["thread"]);
            reconcile_interruption(&mut value, &turn, history.as_deref().ok());
        }
        let events = self.events.lock().await;
        // App-server agent messages may omit status. Only an explicit completion
        // event for this exact turn/item/text can confirm such a message.
        for turn in value["thread"]["turns"]
            .as_array_mut()
            .into_iter()
            .flatten()
        {
            let turn_id = turn["id"].clone();
            for item in turn["items"].as_array_mut().into_iter().flatten() {
                if item["type"] == "agentMessage"
                    && item["status"].is_null()
                    && events.rows.iter().rev().any(|event| {
                        let params = &event["params"];
                        event["method"] == "item/completed"
                            && params["threadId"] == self.thread
                            && params["turnId"] == turn_id
                            && params["item"]["id"] == item["id"]
                            && params["item"]["text"] == item["text"]
                    })
                {
                    item["status"] = json!("completed");
                }
            }
        }
        let mut pending = events
            .pending
            .values()
            .filter(|r| r["params"]["threadId"] == self.thread)
            .cloned()
            .collect::<Vec<_>>();
        drop(events);
        let origin = crate::kernel::origin::current_origin();
        for request in &mut pending {
            crate::claude_notify::routing::observe("codex", &self.thread, request)?;
            crate::respond_tokens::issue(string(&origin, "ingressId"), request)?;
        }
        crate::external_inputs::observe(
            &self.thread,
            value["thread"]["turns"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            Some(&pending),
        )?;
        value["externalUserInputs"] = crate::external_inputs::inputs(&self.thread, None)?;
        value["pending"] = json!(pending);
        Ok(value)
    }
}

pub(crate) fn reconcile_interruption(value: &mut Value, selected: &str, history: Option<&str>) {
    let key = TurnKey::new("codex", string(&value["thread"], "id"), selected);
    let terminal = history
        .and_then(|text| {
            adapters::codex_rollout_terminal(key.clone(), text)
                .ok()
                .flatten()
        })
        .map(|evidence| advance(&Transition::new(key), &evidence).state());
    for turn in value["thread"]["turns"]
        .as_array_mut()
        .into_iter()
        .flatten()
        .filter(|turn| {
            turn["id"] == selected
                && matches!(
                    string(turn, "status"),
                    "completed" | "interrupted" | "cancelled"
                )
        })
    {
        if turn["status"] == "completed"
            && terminal.as_ref().and_then(adapters::push) != Some("completed")
        {
            continue;
        }
        if let Some(crate::turn_lifecycle::TurnState::Terminal(record)) = &terminal {
            turn["status"] = json!(adapters::push_outcome(record.outcome));
            turn["nativeSequence"] = json!(record.sequence);
        } else {
            // Preserve the upstream status for diagnosis without promoting an
            // incomplete/missing rollout into native terminal evidence.
            turn["_terminalUnconfirmed"] = json!(true);
        }
    }
}
async fn codex_source(control: &Arc<Control>, args: &Value) -> Result<CodexSource> {
    let thread = string(args, "threadId");
    let background = control.effective_background(thread).await?;
    let owner = if background {
        CodexOwner::Background(control.thread_rpc(string(args, "threadId")).await?)
    } else {
        CodexOwner::Desktop(control.ipc().await?)
    };
    Ok::<_, String>(CodexSource {
        owner,
        thread: string(args, "threadId").into(),
        turn: args["turnId"].as_str().map(str::to_owned),
        desktop_owner: None,
        events: control.events.clone(),
        lifecycle: None,
    })
}

/// One fresh read using the same owner and classifier as codex_wait.
pub(crate) async fn codex_observe(control: &Arc<Control>, args: &Value) -> Result<Value> {
    Ok(codex_observe_with_path(control, args).await?.0)
}

pub(crate) async fn codex_observe_with_path(
    control: &Arc<Control>,
    args: &Value,
) -> Result<(Value, Option<PathBuf>, Transition)> {
    let mut source = codex_source(control, args).await?;
    let _ = crate::runtime_metrics::OBSERVATION
        .try_with(|sample| sample.lock().unwrap().history_reads += 1);
    let observation = source.observe().await?;
    if !source.alive() {
        return Err("connection-closed".into());
    }
    let result = source.classify(
        &observation,
        &mut args["turnId"].as_str().map(str::to_owned),
    );
    let path = observation["thread"]["path"].as_str().map(PathBuf::from);
    Ok((
        result,
        path,
        source
            .lifecycle
            .take()
            .expect("classified native observation"),
    ))
}

/// Historical notification reconciliation uses a read-only app-server, without
/// probing every historical thread's Desktop owner. Active turns still use it.
pub(crate) async fn codex_notification_observe(
    control: &Arc<Control>,
    args: &Value,
    discover_owner: bool,
) -> Result<(Value, Option<PathBuf>)> {
    if discover_owner {
        let (mut value, path, turn) = codex_observe_with_path(control, args).await?;
        value["_turnLifecycle"] = adapters::checkpoint(&turn);
        return Ok((value, path));
    }
    let mut source = CodexSource {
        owner: CodexOwner::Background(control.thread_rpc(string(args, "threadId")).await?),
        thread: string(args, "threadId").into(),
        turn: args["turnId"].as_str().map(str::to_owned),
        desktop_owner: None,
        events: control.events.clone(),
        lifecycle: None,
    };
    let _ = crate::runtime_metrics::OBSERVATION
        .try_with(|sample| sample.lock().unwrap().history_reads += 1);
    let observation = source.observe().await?;
    let mut result = source.classify(
        &observation,
        &mut args["turnId"].as_str().map(str::to_owned),
    );
    result["_turnLifecycle"] = adapters::checkpoint(
        source
            .lifecycle
            .as_ref()
            .expect("classified native observation"),
    );
    if adapters::codex_active(string(&result, "recordedStatus"))
        || WaitState::from_wire(string(&result, "state")) == Some(WaitState::InteractionRequired)
    {
        let (mut value, path, turn) = codex_observe_with_path(control, args).await?;
        value["_turnLifecycle"] = adapters::checkpoint(&turn);
        return Ok((value, path));
    }
    Ok((
        result,
        observation["thread"]["path"].as_str().map(PathBuf::from),
    ))
}

pub async fn codex_wait(control: &Arc<Control>, args: &Value) -> Result<Value> {
    let started = Instant::now();
    let mut shutdown = control.shutdown.subscribe();
    let wake = control.events.lock().await.wake.clone();
    let setup = codex_source(control, args);
    let source = tokio::select! {
        biased;
        _ = shutdown.changed() => Err("connector-shutdown".into()),
        r = tokio::time::timeout(Duration::from_millis(args["timeoutMs"].as_u64().unwrap_or(30000).min(10000)), setup) => r.unwrap_or_else(|_| Err("native-connect-timeout".into())),
    };
    let mut result = match source {
        Ok(mut source) => {
            let wake = match &source.owner {
                CodexOwner::Desktop(ipc) => ipc.changes.clone(),
                CodexOwner::Background(_) => wake,
            };
            let result = wait(&mut source, wake, shutdown, args, started).await;
            if let Some(lifecycle) = &source.lifecycle {
                crate::claude_notify::record_conflict(&result, lifecycle).await;
            }
            result
        }
        Err(e) => finish(
            json!({"threadId":args["threadId"],"turnId":args["turnId"],"recordedStatus":null,"runtimeStatus":"unknown","finalResponse":null,"interaction":[]}),
            "unconfirmed",
            &e,
            started,
            None,
        ),
    };
    condition(&mut result, args);
    if WaitState::from_wire(string(&result, "state")) == Some(WaitState::Timeout)
        && result["progress"].is_object()
    {
        crate::review::enrich_progress(string(args, "threadId"), &mut result["progress"]).await;
    }
    Ok(result)
}
pub(crate) fn condition(result: &mut Value, args: &Value) {
    let state = WaitState::from_wire(string(result, "state"));
    let terminal = state.is_some_and(WaitState::is_terminal);
    let interaction = state == Some(WaitState::InteractionRequired);
    result["conditionMet"] = json!(match string(args, "until") {
        "terminal" => terminal,
        "interaction-required" => interaction,
        _ => terminal || interaction,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct Source {
        reads: VecDeque<(u64, Result<Value>)>,
        alive: bool,
    }
    impl WaitSource for Source {
        async fn observe(&mut self) -> Result<Value> {
            let Some((delay, result)) = self.reads.pop_front() else {
                return std::future::pending().await;
            };
            tokio::time::sleep(Duration::from_millis(delay)).await;
            if result.as_ref().is_err_and(|e| e == "DESKTOP_DISCONNECTED") {
                self.alive = false;
            }
            result
        }
        fn alive(&self) -> bool {
            self.alive
        }
        fn classify(&mut self, value: &Value, selected: &mut Option<String>) -> Value {
            if value["thread"].is_object() {
                classify(value, selected)
            } else {
                value.clone()
            }
        }
    }
    fn snapshot(state: &str, text: &str) -> Value {
        json!({"state":state,"reason":"native-turn-state","turnId":"turn",
            "recordedStatus":if state == "running" {"inProgress"} else {state},
            "runtimeStatus":"active","finalResponse":text,"observedAt":"last-success"})
    }
    async fn run(reads: Vec<(u64, Result<Value>)>, timeout: u64) -> Value {
        let (_tx, rx) = watch::channel(0);
        let args = json!({"threadId":"thread","turnId":"turn","timeoutMs":timeout,"until":"terminal","expectedHash":"previous"});
        let mut value = wait(
            &mut Source {
                reads: reads.into(),
                alive: true,
            },
            Arc::new(Notify::new()),
            rx,
            &args,
            Instant::now(),
        )
        .await;
        condition(&mut value, &args);
        value
    }

    #[tokio::test(start_paused = true)]
    async fn native_wait_results_preserve_wire_states_and_reasons() {
        // Contract: wait results preserve state, reason and recorded status wire strings.
        for (recorded, runtime, blocked, state, reason) in [
            (
                Some("completed"),
                "unknown",
                false,
                "completed",
                "native-turn-terminal",
            ),
            (
                Some("failed"),
                "notLoaded",
                false,
                "failed",
                "native-turn-terminal",
            ),
            (
                Some("interrupted"),
                "active",
                false,
                "cancelled",
                "native-turn-terminal",
            ),
            (
                Some("cancelled"),
                "idle",
                false,
                "cancelled",
                "native-turn-terminal",
            ),
            (
                Some("inProgress"),
                "unknown",
                true,
                "unconfirmed",
                "runtime-ownership-unknown",
            ),
            (
                Some("inProgress"),
                "active",
                true,
                "interaction-required",
                "native-interaction",
            ),
            (Some("inProgress"), "active", false, "timeout", "deadline"),
            (
                Some("inProgress"),
                "idle",
                false,
                "unconfirmed",
                "inconsistent-native-state",
            ),
            (None, "active", true, "unconfirmed", "turn-not-found"),
        ] {
            let turns = recorded
                .map(|status| vec![json!({"id":"turn","status":status})])
                .unwrap_or_default();
            let observation = json!({"thread":{"id":"thread","status":{"type":runtime,"activeFlags":if blocked {vec!["waitingOnApproval"]}else{vec![]}},"turns":turns}});
            let result = run(vec![(0, Ok(observation))], 1000).await;
            assert_eq!(result["state"], state);
            assert_eq!(result["reason"], reason);
            assert_eq!(result["recordedStatus"], json!(recorded));
            assert_eq!(result["runtimeStatus"], runtime);
            assert_eq!(
                result["conditionMet"],
                matches!(state, "completed" | "failed" | "cancelled")
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn conflicting_selected_records_do_not_choose_a_terminal_by_array_order() {
        // Regression: contradictory selected native records must return unconfirmed rather than an arbitrary terminal.
        for statuses in [["completed", "failed"], ["failed", "completed"]] {
            let observation = json!({"thread":{"id":"thread","status":{"type":"active"},"turns":[
                {"id":"turn","status":statuses[0]}, {"id":"turn","status":statuses[1]},
                {"id":"other","status":"interrupted"}
            ]}});
            let result = run(vec![(0, Ok(observation))], 1000).await;
            assert_eq!(result["state"], "unconfirmed");
            assert_eq!(result["reason"], "inconsistent-native-state");
            assert_eq!(result["conditionMet"], false);
            assert_eq!(result["turnId"], "turn");
        }
    }

    #[test]
    fn response_deduplication_preserves_metadata_and_terminal_bodies() {
        // Property: response deduplication preserves metadata and terminal bodies.
        for body in [
            json!("same reply"),
            json!({"text":"same reply","textHash":hash("same reply"),"itemId":"message","nextOffset":null}),
        ] {
            let mut original = snapshot("running", "");
            original["finalResponse"] = body.clone();
            let expected = snapshot_hash(&original);
            for changed in [false, true] {
                let mut observation = original.clone();
                if changed {
                    observation["runtimeStatus"] = json!("busy");
                }
                let mut result = finish(
                    observation,
                    "timeout",
                    "deadline",
                    Instant::now(),
                    Some(&expected),
                );
                let before = result.clone();
                compact_response(&mut result, &json!({"expectedHash":expected}));
                assert_eq!(result["changed"], changed);
                assert_eq!(result["finalResponseUnchanged"], true);
                assert_eq!(result["textHash"], hash("same reply"));
                assert!(result["finalResponse"].as_str().is_none());
                assert!(result["finalResponse"].get("text").is_none());
                for key in [
                    "snapshotHash",
                    "textHash",
                    "state",
                    "reason",
                    "observedAt",
                    "returnedAt",
                    "elapsedMs",
                ] {
                    assert_eq!(result[key], before[key]);
                }
                if body.is_object() {
                    assert_eq!(result["finalResponse"]["itemId"], "message");
                }
                let mut without_expected = before.clone();
                compact_response(&mut without_expected, &json!({}));
                assert_eq!(without_expected, before);
                for state in ["completed", "failed", "cancelled", "interaction-required"] {
                    let mut terminal = before.clone();
                    terminal["state"] = json!(state);
                    compact_response(&mut terminal, &json!({"expectedHash":expected}));
                    assert_eq!(terminal["finalResponse"], body);
                    assert!(terminal.get("finalResponseUnchanged").is_none());
                }
            }
            let mut changed_text = original.clone();
            changed_text["finalResponse"] = json!("new reply");
            let mut result = finish(
                changed_text,
                "timeout",
                "deadline",
                Instant::now(),
                Some(&expected),
            );
            compact_response(&mut result, &json!({"expectedHash":expected}));
            assert_eq!(result["finalResponse"], "new reply");
            assert!(result.get("finalResponseUnchanged").is_none());
        }
    }

    #[test]
    fn nonterminal_messages_require_completion_but_terminal_and_interaction_keep_body() {
        // Property: nonterminal messages require completion but terminal and interaction keep body.
        let mut observation = json!({"thread":{"id":"thread","status":{"type":"active"},"turns":[{"id":"turn","status":"inProgress","items":[
            {"id":"done","type":"agentMessage","status":"completed","text":"complete"},
            {"id":"stream","type":"agentMessage","status":"inProgress","text":"half sentence"}
        ]}]}});
        let selected = &mut Some("turn".into());
        let first = classify(&observation, selected);
        assert_eq!(first["finalResponse"]["text"], "complete");
        observation["thread"]["turns"][0]["items"][1]["text"] = json!("more streaming");
        assert_eq!(
            snapshot_hash(&first),
            snapshot_hash(&classify(&observation, selected))
        );
        observation["thread"]["turns"][0]["items"][0]["status"] = Value::Null;
        assert!(classify(&observation, selected)["finalResponse"].is_null());
        for (field, marker) in [
            ("completedItemIds", json!(true)),
            ("agentMessageCompletedAtMsById", json!(1234)),
        ] {
            observation["thread"]["turns"][0][field] = json!({"done":marker});
            assert_eq!(
                classify(&observation, selected)["finalResponse"]["text"],
                "complete"
            );
            observation["thread"]["turns"][0]
                .as_object_mut()
                .unwrap()
                .remove(field);
        }
        for status in ["completed", "failed", "interrupted"] {
            observation["thread"]["turns"][0]["status"] = json!(status);
            observation["thread"]["status"]["type"] = json!("idle");
            assert_eq!(
                classify(&observation, selected)["finalResponse"]["text"],
                "more streaming"
            );
        }
        observation["thread"]["turns"][0]["status"] = json!("inProgress");
        observation["thread"]["status"] =
            json!({"type":"active","activeFlags":["waitingOnApproval"]});
        assert_eq!(
            classify(&observation, selected)["finalResponse"]["text"],
            "more streaming"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn long_wait_retries_reads_past_ninety_seconds() {
        // Regression: dbb25cf; long wait retries reads past ninety seconds.
        let mut reads = vec![(0, Ok(snapshot("running", "partial")))];
        reads.extend((0..10).map(|_| (11000, Ok(snapshot("running", "late")))));
        reads.push((0, Err("RPC_TIMEOUT: thread/turns/list".into())));
        reads.push((0, Ok(snapshot("completed", "final"))));
        let result = run(reads, 300000).await;
        assert_eq!(result["state"], "completed");
        assert!(result["elapsedMs"].as_u64().unwrap() > 90000);
        assert!(result["elapsedMs"].as_u64().unwrap() < 300000);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_deadline_during_read_does_not_invent_read_failure() {
        // Regression: dbb25cf; wait deadline during read does not invent read failure.
        let reads = (0..599)
            .map(|_| (1000, Ok(snapshot("running", "partial"))))
            .chain(std::iter::once((9000, Ok(snapshot("running", "late")))))
            .collect();
        let result = run(reads, 1800000).await;
        assert_eq!(result["state"], "timeout");
        assert_eq!(result["reason"], "deadline");
        assert_eq!(result["elapsedMs"], 1800000);
        let result = run(vec![(0, Ok(snapshot("running", "partial")))], 1800000).await;
        assert_eq!(result["state"], "unconfirmed");
        assert_eq!(result["reason"], "native-read-timeout");
        assert_eq!(result["elapsedMs"], 1800000);
    }

    #[test]
    fn old_turn_does_not_inherit_latest_interaction() {
        // Property: old turn does not inherit latest interaction.
        let observation = json!({"thread":{"id":"thread","status":{"type":"active","activeFlags":["waitingOnApproval"]},"turns":[{"id":"old","status":"inProgress"},{"id":"new","status":"inProgress"}]},"pending":[{"id":1,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread"}}]});
        let old = classify(&observation, &mut Some("old".into()));
        assert_eq!(old["state"], "running");
        assert_eq!(old["interaction"], json!([]));
        let new = classify(&observation, &mut Some("new".into()));
        assert_eq!(new["state"], "interaction-required");
        assert_eq!(new["interaction"][0]["id"], 1);
    }

    #[tokio::test(start_paused = true)]
    async fn read_timeouts_and_changed_content_wait_for_terminal() {
        // Regression: 2a880bc; read timeouts and changed content wait for terminal.
        let result = run(
            vec![
                (0, Ok(snapshot("running", "first"))),
                (0, Err("DESKTOP_SNAPSHOT_TIMEOUT".into())),
                (11000, Ok(snapshot("running", "too late"))),
                (0, Err("RPC_TIMEOUT: thread/read".into())),
                (0, Ok(snapshot("running", "changed"))),
                (0, Ok(snapshot("completed", "final"))),
            ],
            90000,
        )
        .await;
        assert_eq!(result["state"], "completed");
        assert_eq!(result["conditionMet"], true);
        assert_eq!(result["changed"], true);
        assert_eq!(result["finalResponse"], "final");
        assert!(result["elapsedMs"].as_u64().unwrap() >= 20000);
    }

    #[tokio::test(start_paused = true)]
    async fn deadline_preserves_read_failure_and_last_observation() {
        // Regression: 2a880bc; deadline preserves read failure and last observation.
        for (delay, error, reason) in [
            (0, "DESKTOP_SNAPSHOT_TIMEOUT", "DESKTOP_SNAPSHOT_TIMEOUT"),
            (0, "RPC_TIMEOUT: thread/read", "RPC_TIMEOUT: thread/read"),
            (11000, "unused", "native-read-timeout"),
        ] {
            let result = run(
                vec![
                    (0, Ok(snapshot("running", "partial"))),
                    (delay, Err(error.into())),
                ],
                if delay == 0 { 3000 } else { 15000 },
            )
            .await;
            assert_eq!(result["state"], "unconfirmed");
            assert_eq!(result["reason"], reason);
            assert_eq!(result["recordedStatus"], "inProgress");
            assert_eq!(result["observedAt"], "last-success");
            assert_eq!(result["conditionMet"], false);
            assert!(result["elapsedMs"].as_u64().unwrap() >= if delay == 0 { 3000 } else { 15000 });
        }
        let result = run(vec![], 1000).await;
        assert_eq!(result["state"], "unconfirmed");
        assert_eq!(result["observedAt"], Value::Null);
    }

    #[tokio::test(start_paused = true)]
    async fn recovered_running_read_reaches_normal_deadline() {
        // Regression: 2a880bc; recovered running read reaches normal deadline.
        let result = run(
            vec![
                (0, Err("DESKTOP_SNAPSHOT_TIMEOUT".into())),
                (0, Ok(snapshot("running", "recovered"))),
            ],
            3000,
        )
        .await;
        assert_eq!(result["state"], "timeout");
        assert_eq!(result["reason"], "deadline");
        assert_eq!(result["elapsedMs"], 3000);
    }

    #[tokio::test(start_paused = true)]
    async fn failures_disconnect_and_interaction_still_return_immediately() {
        // Regression: 2a880bc; failures disconnect and interaction still return immediately.
        for state in ["failed", "cancelled", "interaction-required", "unconfirmed"] {
            let result = run(vec![(0, Ok(snapshot(state, "")))], 90000).await;
            assert_eq!(result["state"], state);
            assert!(result["elapsedMs"].as_u64().unwrap() < 100);
            assert_eq!(
                result["conditionMet"],
                matches!(state, "failed" | "cancelled")
            );
        }
        for error in [
            "DESKTOP_DISCONNECTED",
            "runtime-owner-changed",
            "native-thread-id-mismatch",
        ] {
            let result = run(vec![(0, Err(error.into()))], 90000).await;
            assert_eq!(result["state"], "unconfirmed");
            assert_eq!(
                result["reason"],
                if error == "DESKTOP_DISCONNECTED" {
                    "connection-closed"
                } else {
                    error
                }
            );
            assert!(result["elapsedMs"].as_u64().unwrap() < 100);
        }
    }
}
