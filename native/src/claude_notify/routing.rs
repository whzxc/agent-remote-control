//! Presence delays notification routing only. Native answers remain first-answer-wins.
use super::*;
use std::sync::{LazyLock, Mutex as SyncMutex};

static SESSION: LazyLock<String> = LazyLock::new(id);
static SERIAL: SyncMutex<()> = SyncMutex::new(());
static PRESENCE: SyncMutex<Option<(String, String, i64)>> = SyncMutex::new(None);

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Routing {
    state: String,
    defer_until: Option<i64>,
    paused_by: Option<String>,
    reason: String,
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    session: String,
    source_id: String,
    turn: Value,
    routing: Routing,
    remaining_ms: i64,
    resolved: bool,
    #[serde(default)]
    clock_id: String,
}
fn immediate(state: &str, reason: &str) -> Routing {
    Routing {
        state: state.into(),
        defer_until: None,
        paused_by: None,
        reason: reason.into(),
    }
}
pub(crate) fn initial(present: bool, routable: bool, now: i64, seconds: i64) -> Routing {
    if !routable {
        immediate("not-routable", "no-verified-push-path")
    } else if present && seconds > 0 {
        Routing {
            state: "deferred".into(),
            defer_until: Some(now + seconds * 1000),
            paused_by: None,
            reason: "user-present".into(),
        }
    } else {
        immediate(
            "routed",
            if present {
                "delay-disabled"
            } else {
                "user-absent"
            },
        )
    }
}
pub(crate) fn advance(entry: &mut Entry, session: &str, present: bool, routable: bool, now: i64) {
    let state = entry.routing.state.as_str();
    if matches!(state, "deferred" | "paused") && entry.session != session {
        entry.routing = immediate(
            if routable { "routed" } else { "not-routable" },
            "restart-recovery",
        );
    } else if matches!(state, "deferred" | "paused") && !routable {
        entry.routing = immediate("not-routable", "no-verified-push-path");
    } else if state == "not-routable" && routable {
        entry.routing = immediate("routed", "push-path-available");
    } else if state == "deferred"
        && (!present || entry.routing.defer_until.is_some_and(|at| now >= at))
    {
        entry.routing = immediate(
            "routed",
            if present {
                "countdown-elapsed"
            } else {
                "user-absent"
            },
        );
    }
    entry.session = session.into();
}
pub(crate) fn advance_environment(
    entry: &mut Entry,
    session: &str,
    env: &crate::app_env::Overrides,
    system_present: bool,
    routable: bool,
    real: i64,
) {
    if !entry.clock_id.is_empty()
        && entry.clock_id != "system"
        && entry.clock_id != env.clock_id()
        && matches!(entry.routing.state.as_str(), "deferred" | "paused")
    {
        entry.routing = immediate(
            if routable { "routed" } else { "not-routable" },
            "environment-reset",
        );
    }
    entry.clock_id = env.clock_id().into();
    advance(
        entry,
        session,
        env.presence(system_present),
        routable,
        env.clock_now(real),
    );
}
pub(crate) fn change(entry: &mut Entry, action: &str, actor: &str, now: i64) -> Result<()> {
    if entry.resolved {
        return Err("REQUEST_RESOLVED: read pending requests before routing".into());
    }
    match action {
        "read" => {}
        "handoff" if matches!(entry.routing.state.as_str(), "deferred" | "paused") => {
            entry.routing = immediate("routed", "handoff-now")
        }
        "pause" if entry.routing.state == "deferred" => {
            entry.remaining_ms = entry
                .routing
                .defer_until
                .unwrap_or(now)
                .saturating_sub(now)
                .max(0);
            entry.routing = Routing {
                state: "paused".into(),
                defer_until: None,
                paused_by: Some(actor.into()),
                reason: "explicit-or-dock-interaction".into(),
            };
        }
        "resume" if entry.routing.state == "paused" => {
            entry.routing = Routing {
                state: "deferred".into(),
                defer_until: Some(now + entry.remaining_ms),
                paused_by: None,
                reason: "resumed".into(),
            };
        }
        "handoff" | "pause" | "resume" => {}
        _ => return Err("INVALID_ROUTING_ACTION: use read, handoff, pause or resume".into()),
    }
    Ok(())
}
fn present(agent: &str, task: &str) -> bool {
    let now = chrono::Utc::now().timestamp_millis();
    PRESENCE
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|(a, t, at)| a == agent && t == task && now - at < 6000)
}
pub(crate) fn presence(args: &Value) -> Result<Value> {
    let agent = string(args, "agent");
    let task = string(args, "taskId");
    if agent.is_empty() || task.is_empty() {
        return Err("agent and taskId required".into());
    }
    let mut p = PRESENCE.lock().unwrap();
    let previous = p
        .as_ref()
        .map(|(agent, task, _)| (agent.clone(), task.clone()));
    if args["present"] == true {
        *p = Some((
            agent.into(),
            task.into(),
            chrono::Utc::now().timestamp_millis(),
        ));
    } else if p.as_ref().is_some_and(|(a, t, _)| a == agent && t == task) {
        *p = None;
    }
    let changed = previous
        != p.as_ref()
            .map(|(agent, task, _)| (agent.clone(), task.clone()));
    drop(p);
    if changed {
        if let Some((agent, task)) = previous {
            index::routing_changed(&agent, &task);
        }
        index::routing_changed(agent, task);
    }
    Ok(json!({"present":args["present"] == true}))
}
fn request_id(request: &Value) -> String {
    let value = request.get("responseId").unwrap_or(&request["id"]);
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}
fn path(dir: &Path, agent: &str, task: &str, request: &str) -> PathBuf {
    dir.join("request-routing").join(format!(
        "{}.json",
        hash(json!([agent, task, request]).to_string())
    ))
}
pub(super) fn paths(dir: &Path, b: &Binding) -> Vec<PathBuf> {
    let agent = if b.agent.is_empty() {
        "codex"
    } else {
        &b.agent
    };
    b.deliveries
        .iter()
        .filter(|d| matches!(d.status.as_str(), "pending" | "sending") && d.interaction.is_object())
        .map(|d| path(dir, agent, &b.thread_id, &request_id(&d.interaction)))
        .collect()
}
fn binding_for(dir: &Path, agent: &str, task: &str, turn: &Value) -> Result<Option<Binding>> {
    let matches = |b: &Binding| {
        b.thread_id == task
            && (b.agent == agent || b.agent.is_empty() && agent == "codex")
            && b.scope_end.is_none()
    };
    if let Some(turn) = turn.as_str() {
        return Ok(binding(dir, task, turn)?.filter(matches));
    }
    if !turn.is_null() {
        return Ok(None);
    }
    Ok(index::interested_thread(dir, task)?
        .into_iter()
        .filter(matches)
        .max_by_key(|b| b.created_at))
}

fn routable(dir: &Path, b: &Binding, now: i64) -> Result<bool> {
    if settings()?["notificationsEnabled"] == false {
        return Ok(false);
    }
    let mut state = State::load(dir)?;
    subscriptions::sync(&mut state, std::slice::from_ref(b));
    Ok(state.subscriptions.iter().any(|s| {
        s.matches(b)
            && s.active(now)
            && match s.channel {
                Channel::McpEvents => s.webhook.as_ref().is_some_and(|w| w.verified_until > 0),
                Channel::ClaudeSession | Channel::AntigravitySession => {
                    state.targets.iter().any(|t| {
                        t.source_id == b.source_id
                            && t.channel == s.channel
                            && t.target == s.target
                            && t.reachability.state == "verified"
                    })
                }
            }
    }))
}
static ENTRIES: LazyLock<SyncMutex<file_cache::Cache<Entry>>> = LazyLock::new(Default::default);
fn decode_entry(bytes: &[u8]) -> Result<Entry> {
    let value: Value = serde_json::from_slice(bytes).map_err(|e| format!("INVALID_JSON: {e}"))?;
    serde_json::from_value(value).map_err(|e| e.to_string())
}
fn load_entry(path: &Path) -> Result<Entry> {
    Ok(ENTRIES
        .lock()
        .map_err(|e| e.to_string())?
        .read_with(path, decode_entry)?
        .as_ref()
        .clone())
}
fn save_entry(path: &Path, entry: &Entry) -> Result<()> {
    let mut cache = ENTRIES.lock().map_err(|e| e.to_string())?;
    if cache
        .read_with(path, decode_entry)
        .is_ok_and(|old| old.as_ref() == entry)
    {
        return Ok(());
    }
    let before = file_cache::Stamp::read(path.parent().unwrap())?;
    save(
        path,
        &serde_json::to_value(entry).map_err(|e| e.to_string())?,
    )?;
    cache.written(path, before, entry.clone())
}

pub(crate) fn observe(agent: &str, task: &str, request: &mut Value) -> Result<()> {
    let dir = directory();
    observe_in(&dir, agent, task, request)
}
pub(super) fn observe_in(dir: &Path, agent: &str, task: &str, request: &mut Value) -> Result<()> {
    let _guard = SERIAL.lock().unwrap();
    let turn = request["params"]
        .get("turnId")
        .unwrap_or(&request["turnId"])
        .clone();
    let Some(b) = binding_for(dir, agent, task, &turn)? else {
        request["routing"] = json!(immediate("not-routable", "no-source-binding"));
        return Ok(());
    };
    let real = chrono::Utc::now().timestamp_millis();
    let env = crate::app_env::read()?;
    let now = env.clock_now(real);
    let available = routable(dir, &b, real)?;
    let p = path(dir, agent, task, &request_id(request));
    let mut entry = if p.exists() {
        Some(load_entry(&p)?)
    } else {
        None
    };
    if entry.as_ref().is_none_or(|e| e.turn != json!(b.turn_id)) {
        entry = Some(Entry {
            session: SESSION.clone(),
            source_id: b.source_id.clone(),
            turn: json!(b.turn_id),
            routing: initial(
                env.presence(present(agent, task)),
                available,
                now,
                settings()?["requestRoutingDelaySeconds"]
                    .as_i64()
                    .unwrap_or(15),
            ),
            remaining_ms: 0,
            resolved: false,
            clock_id: env.clock_id().into(),
        });
    }
    let mut entry = entry.unwrap();
    entry.source_id = b.source_id;
    advance_environment(
        &mut entry,
        &SESSION,
        &env,
        present(agent, task),
        available,
        real,
    );
    request["routing"] = json!(entry.routing);
    save_entry(&p, &entry)
}
pub(crate) fn control(args: &Value, local: bool) -> Result<Value> {
    control_in(&directory(), args, local)
}
pub(super) fn control_in(dir: &Path, args: &Value, local: bool) -> Result<Value> {
    let _guard = SERIAL.lock().unwrap();
    let agent = args["agent"].as_str().unwrap_or("codex");
    let task = string(args, "taskId");
    let p = path(&dir, agent, task, string(args, "id"));
    let mut entry =
        load_entry(&p).map_err(|_| "REQUEST_ROUTING_NOT_FOUND: read pending requests first")?;
    let origin = crate::kernel::origin::current_origin();
    let caller = string(&origin, "sourceId");
    if !local && (caller.is_empty() || caller != entry.source_id) {
        return Err(
            "REQUEST_SOURCE_MISMATCH: only the task's bound control source may change routing"
                .into(),
        );
    }
    let b = binding_for(&dir, agent, task, &entry.turn)?
        .ok_or("REQUEST_SOURCE_UNBOUND: read pending requests")?;
    if b.source_id != entry.source_id {
        return Err("REQUEST_SOURCE_MISMATCH: task binding changed".into());
    }
    let real = chrono::Utc::now().timestamp_millis();
    let env = crate::app_env::read()?;
    let now = env.clock_now(real);
    advance_environment(
        &mut entry,
        &SESSION,
        &env,
        present(agent, task),
        routable(&dir, &b, real)?,
        real,
    );
    change(
        &mut entry,
        args["action"].as_str().unwrap_or("read"),
        if local { "user" } else { caller },
        now,
    )?;
    save_entry(&p, &entry)?;
    index::routing_changed(agent, task);
    Ok(json!({"routing":entry.routing}))
}
pub(super) fn refresh(dir: &Path, b: &mut Binding) -> Result<()> {
    let agent = if b.agent.is_empty() {
        "codex"
    } else {
        &b.agent
    };
    for d in &mut b.deliveries {
        if !d.interaction.is_object() {
            continue;
        }
        if d.interaction["resolved"] == true {
            let _guard = SERIAL.lock().unwrap();
            let p = path(dir, agent, &b.thread_id, &request_id(&d.interaction));
            if p.exists() {
                let mut e = load_entry(&p)?;
                if e.turn.as_str() == Some(b.turn_id.as_str()) && !e.resolved {
                    e.resolved = true;
                    save_entry(&p, &e)?;
                }
            }
        } else {
            observe_in(dir, agent, &b.thread_id, &mut d.interaction)?;
        }
    }
    Ok(())
}
/// Deferred routing wakes on its countdown, override expiry, or presence lease expiry.
pub(super) fn deferred_deadline(b: &Binding, d: &Delivery, now: i64) -> Result<Option<i64>> {
    let real = now.saturating_mul(1000);
    let env = crate::app_env::read()?;
    let mut deadline = d.interaction["routing"]["deferUntil"]
        .as_i64()
        .and_then(|at| env.real_deadline(at, real));
    let mut due = |at: i64| {
        deadline = Some(deadline.map_or(at, |old| old.min(at)));
    };
    if let Some(at) = env.expires_at {
        due(at);
    }
    if env.presence.is_none() {
        let presence = PRESENCE.lock().unwrap();
        let agent = if b.agent.is_empty() {
            "codex"
        } else {
            &b.agent
        };
        due(presence
            .as_ref()
            .filter(|(a, t, _)| a == agent && t == &b.thread_id)
            .map_or(real, |(_, _, at)| at.saturating_add(6000)));
    } else if env.presence.as_deref() == Some("absent") {
        due(real);
    }
    Ok(deadline.map(|at| at.saturating_add(999) / 1000))
}

pub(super) fn held(d: &Delivery) -> bool {
    matches!(
        string(&d.interaction["routing"], "state"),
        "deferred" | "paused" | "not-routable"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(present: bool, routable: bool) -> Entry {
        Entry {
            session: "first".into(),
            source_id: "source-a".into(),
            turn: json!("turn"),
            routing: initial(present, routable, 1000, 15),
            remaining_ms: 0,
            resolved: false,
            clock_id: "system".into(),
        }
    }
    #[test]
    fn routing_app_env_freezes_advances_and_resets_without_focus() {
        // Property: virtual time and explicit presence control routing while clear cancels overridden delays.
        let env = crate::app_env::transition(
            &Default::default(),
            &json!({"action":"set","presence":"present","clock":{"freeze":true}}),
            1000,
        )
        .unwrap();
        let mut e = entry(true, true);
        advance_environment(&mut e, "first", &env, false, true, 100_000);
        assert_eq!(e.routing.state, "deferred");
        assert_eq!(e.routing.defer_until, Some(16000));
        let advanced = crate::app_env::transition(
            &env,
            &json!({"action":"set","clock":{"advanceMs":15000}}),
            100_000,
        )
        .unwrap();
        advance_environment(&mut e, "first", &advanced, false, true, 100_000);
        assert_eq!(e.routing.state, "routed");
        assert_eq!(e.routing.reason, "countdown-elapsed");
        let mut e = entry(true, true);
        advance_environment(&mut e, "first", &env, false, true, 2000);
        change(&mut e, "pause", "user", env.clock_now(2000)).unwrap();
        advance_environment(&mut e, "first", &Default::default(), true, true, 3000);
        assert_eq!(e.routing.state, "routed");
        assert_eq!(e.routing.reason, "environment-reset");
        let absent =
            crate::app_env::transition(&env, &json!({"action":"set","presence":"absent"}), 2000)
                .unwrap();
        let mut e = entry(true, true);
        advance_environment(&mut e, "first", &absent, true, true, 2000);
        assert_eq!(e.routing.reason, "user-absent");
    }
    #[test]
    fn routing_presence_only_delays_new_routable_requests() {
        // Property: presence gates only newly observed requests with a verified push path.
        let deferred = initial(true, true, 1000, 15);
        assert_eq!(deferred.state, "deferred");
        assert_eq!(deferred.defer_until, Some(16000));
        assert_eq!(initial(false, true, 1000, 15).state, "routed");
        assert_eq!(initial(true, false, 1000, 15).state, "not-routable");
        assert_eq!(initial(true, true, 1000, 0).state, "routed");
    }
    #[test]
    fn routing_presence_never_retroactively_delays() {
        // Property: a routed request remains routed when presence begins later.
        let mut e = entry(false, true);
        advance(&mut e, "first", true, true, 2000);
        assert_eq!(e.routing.state, "routed");
        assert_eq!(e.routing.defer_until, None);
    }
    #[test]
    fn routing_pause_preserves_remaining_time_and_actor() {
        // Property: pause freezes the remaining duration until explicit resume.
        let mut e = entry(true, true);
        change(&mut e, "pause", "user", 4000).unwrap();
        advance(&mut e, "first", true, true, 20000);
        assert_eq!(e.routing.state, "paused");
        assert_eq!(e.routing.paused_by.as_deref(), Some("user"));
        change(&mut e, "resume", "source-a", 21000).unwrap();
        assert_eq!(e.routing.defer_until, Some(33000));
        advance(&mut e, "first", true, true, 33000);
        assert_eq!(e.routing.state, "routed");
    }
    #[test]
    fn routing_handoff_is_immediate_and_idempotent() {
        // Property: explicit handoff removes either a running or paused delay exactly once.
        for paused in [false, true] {
            let mut e = entry(true, true);
            if paused {
                change(&mut e, "pause", "user", 2000).unwrap();
            }
            change(&mut e, "handoff", "source-a", 3000).unwrap();
            change(&mut e, "handoff", "source-a", 4000).unwrap();
            assert_eq!(e.routing.state, "routed");
            assert_eq!(e.routing.defer_until, None);
        }
        let mut e = entry(true, false);
        change(&mut e, "handoff", "source-a", 3000).unwrap();
        assert_eq!(e.routing.state, "not-routable");
    }
    #[test]
    fn routing_restart_and_absence_remove_defer() {
        // Property: recovery cancels deferred and paused timers; absence cancels a running timer.
        for paused in [false, true] {
            let mut e = entry(true, true);
            if paused {
                change(&mut e, "pause", "user", 2000).unwrap();
            }
            let encoded = serde_json::to_value(&e).unwrap();
            let mut recovered: Entry = serde_json::from_value(encoded).unwrap();
            advance(&mut recovered, "second", true, true, 3000);
            assert_eq!(recovered.routing.state, "routed");
            assert_eq!(recovered.routing.reason, "restart-recovery");
        }
        let mut e = entry(true, true);
        advance(&mut e, "first", false, true, 2000);
        assert_eq!(e.routing.state, "routed");
    }
    #[test]
    fn routing_resolved_requests_cannot_be_handed_off() {
        // Property: resolving a request during a countdown prevents later routing mutations.
        let mut e = entry(true, true);
        e.resolved = true;
        for action in ["pause", "resume", "handoff"] {
            assert!(change(&mut e, action, "source-a", 2000).is_err());
        }
    }
}
