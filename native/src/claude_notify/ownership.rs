//! Observed writer handoffs. Observation never loads, releases, or acquires a writer.
use super::*;

static ACQUISITION_SESSION: std::sync::LazyLock<String> = std::sync::LazyLock::new(id);

fn path(thread: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(thread).map_err(|_| "INVALID_THREAD_ID")?;
    Ok(root()
        .join("execution/handoffs")
        .join(format!("{thread}.json")))
}
fn stored(thread: &str) -> Result<Value> {
    let path = path(thread)?;
    if path.exists() {
        load(&path)
    } else {
        Ok(json!({"currentOwner":"unknown","history":[]}))
    }
}
pub(crate) fn read(thread: &str) -> Result<Value> {
    let mut state = stored(thread)?;
    state.as_object_mut().map(|state| {
        state.remove("enqueued");
        state.remove("acquisition");
    });
    Ok(state)
}
// Attribute only the acquisition bracketed by an explicit source operation.
pub(crate) async fn begin_acquisition(thread: &str) -> Result<String> {
    let source = string(&crate::kernel::origin::current_origin(), "sourceId").to_owned();
    if source.is_empty() {
        return Ok(String::new());
    }
    let _guard = LOCK.lock().await;
    let mut state = stored(thread)?;
    if state["currentOwner"] != "unheld" {
        return Ok(String::new());
    }
    let token = id();
    state["acquisition"] =
        json!({"id":token,"sourceId":source,"observerSession":*ACQUISITION_SESSION});
    save(&path(thread)?, &state)?;
    Ok(token)
}
pub(crate) async fn end_acquisition(thread: &str, token: &str) -> Result<()> {
    if token.is_empty() {
        return Ok(());
    }
    let _guard = LOCK.lock().await;
    let mut state = stored(thread)?;
    if state["acquisition"]["id"] == token {
        state.as_object_mut().unwrap().remove("acquisition");
        save(&path(thread)?, &state)?;
    }
    Ok(())
}
pub(crate) async fn observe(thread: &str, ownership: &Value) -> Result<Value> {
    let owner = ownership["owner"]
        .as_str()
        .unwrap_or(if ownership["state"] == "unheld" {
            "unheld"
        } else {
            "unknown"
        });
    let (mut state, bindings) = {
        let _guard = LOCK.lock().await;
        let mut state = stored(thread)?;
        let before = state.clone();
        let previous = state["currentOwner"]
            .as_str()
            .filter(|o| *o != "unknown")
            .map(str::to_owned)
            .or_else(|| state["lastKnownOwner"].as_str().map(str::to_owned))
            .or_else(|| {
                let p = root().join("execution").join(format!("{thread}.json"));
                (owner == "desktop")
                    .then(|| load(&p).ok())
                    .flatten()
                    .and_then(|v| v["owner"].as_str().map(str::to_owned))
            });
        if owner != "unknown" {
            if let Some(previous) = previous.filter(|p| p != owner) {
                let cause = if previous == "unheld"
                    && owner == "connector"
                    && state["acquisition"]["observerSession"] == *ACQUISITION_SESSION
                {
                    state["acquisition"]["sourceId"].clone()
                } else {
                    Value::Null
                };
                state.as_object_mut().unwrap().remove("acquisition");
                let history = state["history"]
                    .as_array_mut()
                    .ok_or("INVALID_HANDOFF_HISTORY")?;
                let id = hash(json!([thread, history.len(), previous, owner]).to_string());
                history.push(
                    json!({"eventId":id,"from":previous,"to":owner,"observedAt":now(),
                    "causedBySourceId":cause,"evidence":ownership["evidence"],"timeBasis":"observed-not-transition-time"}),
                );
            }
            state["currentOwner"] = json!(owner);
            state["lastKnownOwner"] = json!(owner);
        } else {
            state["currentOwner"] = json!("unknown");
        }
        state["state"] = ownership["state"].clone();
        state["observedAt"] = json!(now());
        if observation_changed(&before, &state) {
            save(&path(thread)?, &state)?;
        }
        let bindings = if state["history"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty())
        {
            matching_records(&directory(), |b| {
                b.thread_id == thread
                    && b.scope_end.is_none()
                    && !b.continuation_bound
                    && (b.agent.is_empty() || b.agent == "codex")
            })?
        } else {
            Vec::new()
        };
        (state, bindings)
    };
    // History is durable before events. Re-observation repairs an interrupted
    // enqueue using stable, source-scoped IDs across successor bindings.
    for mut b in bindings {
        let cursor = state["enqueued"][&b.source_id].as_u64().unwrap_or(0) as usize;
        let history = state["history"]
            .as_array()
            .ok_or("INVALID_HANDOFF_HISTORY")?;
        if cursor >= history.len() {
            continue;
        }
        process(
            &directory(),
            &LOCK,
            &mut b,
            &json!({"state":"unconfirmed","handoffs":history.iter().skip(cursor).collect::<Vec<_>>()}),
        )
        .await?;
        // This cursor outlives per-turn retention. Merge after enqueue so a
        // crash can repair the queue without ever replaying retired deliveries.
        let _guard = LOCK.lock().await;
        let mut current = stored(thread)?;
        if !current["enqueued"].is_object() {
            current["enqueued"] = json!({});
        }
        let enqueued = current["enqueued"][&b.source_id].as_u64().unwrap_or(0);
        current["enqueued"][&b.source_id] = json!(enqueued.max(history.len() as u64));
        save(&path(thread)?, &current)?;
    }
    state.as_object_mut().map(|state| {
        state.remove("enqueued");
        state.remove("acquisition");
    });
    state["ownership"] = ownership.clone();
    Ok(state)
}

pub(crate) async fn end_scope(thread: &str, reason: &str) -> Result<()> {
    let _guard = LOCK.lock().await;
    for mut b in records(&directory())?
        .into_iter()
        .filter(|b| b.thread_id == thread && b.scope_end.is_none())
    {
        b.scope_end = Some(reason.into());
        persist(&directory(), &b)?;
    }
    Ok(())
}
