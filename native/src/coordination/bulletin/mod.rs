//! Shared notices and blockers. Recovery uses the coordination message outbox.
mod store;
use super::*;
use std::sync::{LazyLock, Mutex};
use store::{Clock, Link, Store};
static STORE: LazyLock<Mutex<Option<Store>>> = LazyLock::new(|| Mutex::new(None));
static TIME: LazyLock<(i64, std::time::Instant)> = LazyLock::new(|| {
    (
        chrono::Utc::now().timestamp_millis(),
        std::time::Instant::now(),
    )
});
const RECEIPTS: crate::kernel::receipts::ReceiptStore =
    crate::kernel::receipts::ReceiptStore::new("");
fn clock() -> Clock {
    let utc = chrono::Utc::now().timestamp_millis();
    let elapsed = TIME.0 + TIME.1.elapsed().as_millis() as i64;
    Clock {
        utc,
        elapsed,
        certain: (utc - elapsed).abs() < 60_000,
    }
}
fn with_store<T>(f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
    let mut store = STORE
        .lock()
        .map_err(|_| "COORDINATION_STORAGE: bulletin lock unavailable")?;
    if store.is_none() {
        *store = Some(Store::open(root().join("coordination/state.json"))?);
    }
    let result = f(store.as_mut().unwrap());
    if result.as_ref().is_err_and(|e| {
        e.starts_with("COORDINATION_STORAGE") || e.starts_with("COORDINATION_CORRUPT")
    }) {
        // An atomic rename may have succeeded before directory sync failed. Reload
        // the durable replay ledger before admitting another mutation.
        *store = None;
    }
    result
}
fn ids(args: &Value, key: &str) -> Vec<String> {
    args[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
fn resources(args: &Value) -> Result<Vec<ResourceKey>> {
    ids(args, "resources")
        .iter()
        .map(|r| {
            let key = ResourceKey::parse(r)?;
            if key.shorthand().is_some() {
                let registry =
                    crate::kernel::file_cache::load(&root().join("coordination/projects.json"))
                        .unwrap_or(Value::Null);
                return Err(lane_resource_error(key.shorthand().unwrap(), &registry));
            }
            Ok(key)
        })
        .collect()
}
pub fn lane_resource_error(name: &str, registry: &Value) -> String {
    let examples: Vec<_> = registry["projects"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| ResourceKey::lane(string(p, "id"), name).ok())
        .take(8)
        .map(|key| key.as_str().to_owned())
        .collect();
    format!("INVALID_ARGUMENT: use lane:<project>/<name>; query projects for the registered project ID. Qualified examples: {}", if examples.is_empty() { format!("lane:<project>/{name}") } else { examples.join(", ") })
}
fn digest(op: &str, args: &Value, actor: &Principal) -> String {
    let owner = match actor {
        Principal::Source { source_id, .. } => json!({"sourceId":source_id}),
        _ => json!(actor),
    };
    hash(json!([op, args, owner]).to_string())
}
fn validate(op: &str, args: &Value) -> Result<()> {
    let catalog = catalog();
    let spec = catalog["ops"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == op)
        .ok_or("INVALID_ARGUMENT: unknown bulletin operation")?;
    crate::egress::validate_op(spec, args)?;
    for field in ["intent", "summary", "reason"] {
        if args[field]
            .as_str()
            .is_some_and(|s| s.trim().is_empty() || s.chars().any(char::is_control))
        {
            return Err(
                "INVALID_ARGUMENT: supply a single-line metadata summary, never prompt content"
                    .into(),
            );
        }
    }
    for field in ["threadIds", "evidenceIds"] {
        for id in ids(args, field) {
            types::identifier(&id)?;
        }
    }
    resources(args)?;
    Ok(())
}
fn actor() -> Result<journal::Reader> {
    let origin = crate::kernel::origin::current_origin();
    let source = crate::sources::coordination_source(&origin)?;
    super::reader(&origin, &source)
}
fn failure(message: String, op: &str) -> Value {
    let code = message.split(':').next().unwrap_or("COORDINATION_STORAGE");
    let next = if message.contains("lane:<project>/<name>") {
        json!({"via":"query","op":"projects","args":{},"hint":message})
    } else if matches!(
        code,
        "COORDINATION_NOT_FOUND"
            | "COORDINATION_REVISION_CONFLICT"
            | "COORDINATION_STATE_CONFLICT"
            | "COORDINATION_CURSOR_EXPIRED"
    ) {
        json!({"via":"query","op":"board","args":{},"hint":"Read the current board, restart pagination if needed, and retain the original mutation requestId"})
    } else if matches!(
        code,
        "INVALID_ARGUMENT" | "RESOURCE_UNKNOWN" | "RESOURCE_AMBIGUOUS"
    ) {
        json!({"via":"query","op":"guide","args":{"op":op},"hint":"Use the current metadata-only schema"})
    } else {
        json!({"op":null,"hint":"Restore source authority or local coordination storage. Preserve state.json and the original receipt; rate-limited writes may retry after one minute."})
    };
    json!({"state":"failed","error":{"code":code,"message":message},"next":next})
}
fn reconcile() -> Result<()> {
    let pending = with_store(|s| Ok(s.state.pending.iter().take(64).cloned().collect::<Vec<_>>()))?;
    for input in pending {
        let transition = input.transition_id.clone();
        super::emit(input.clone())?;
        if input.kind == EventKind::BlockerChanged
            && matches!(input.status, Some(EventStatus::Cleared))
        {
            for evidence in &input.evidence_refs {
                if matches!(evidence.kind, EvidenceKind::Blocker) {
                    super::recovery::broadcast(&evidence.id)?;
                }
            }
        }
        with_store(|s| s.projected(&transition, clock()))?;
    }
    Ok(())
}
fn maintain() -> Result<()> {
    // Snapshot authorization before the bulletin lock. No account resolution or disk scan.
    let revoked = crate::sources::coordination_revoked()?;
    with_store(|s| s.maintain(&revoked, clock()))
}
/// Called only after authenticated ingress has admitted the operation. Failed domain
/// work is still owner activity; an unauthorized caller never reaches this hook.
pub(crate) fn authenticated_activity() {
    let result = actor().and_then(|reader| {
        // Expire a scope before a returning owner can refresh it after downtime.
        maintain()?;
        with_store(|s| {
            s.activity(&reader.principal, clock());
            s.flush(clock())
        })
    });
    if result.is_err() {
        observers::gap("bulletin-activity", "activity-unavailable");
    }
}
fn linked(args: &Value, actor: &Principal) -> Result<Vec<Link>> {
    ids(args,"threadIds").into_iter().map(|thread| {
        let records = crate::dispatch_policy::records(&thread)?;
        let row = records.last().ok_or("COORDINATION_THREAD_UNAVAILABLE: link an evidenced thread dispatched by your source")?;
        let origin = Principal::from_origin(&row["origin"])?;
        let owns = match (actor, origin.as_ref()) {
            (Principal::LocalAuthority, Some(Principal::LocalAuthority)) => true,
            (Principal::Source {source_id:a,..},Some(Principal::Source {source_id:b,..})) => a == b,
            _ => false,
        };
        if !owns { return Err("COORDINATION_OWNER_REQUIRED: thread links require your own dispatch origin".into()); }
        let terminal = string(&row["terminal"],"state");
        Ok(Link { session_binding_id: super::messages::binding_id(&row["origin"]["sourceId"], &args["sessionId"] )?, thread_id: thread, observed_turn_id: row["turnId"].as_str().map(str::to_owned), scope_state: match terminal {"completed"|"failed" => "completed", "interrupted"|"cancelled" => "interrupted", _ => "unknown"}.into(), observed_at: None, terminals: Default::default() })
    }).collect()
}
fn apply_link_observations(
    links: &mut [Link],
    observed: &[(String, String, String)],
    clock: Clock,
) {
    for link in links {
        if let Some((_, turn, status)) = observed.iter().find(|(thread, turn, _)| {
            thread == &link.thread_id && link.observed_turn_id.as_deref() == Some(turn.as_str())
        }) {
            link.scope_state = match status.as_str() {
                "running" | "inProgress" | "pending" => "running",
                "completed" | "failed" => "completed",
                "interrupted" | "cancelled" => "interrupted",
                _ => "unknown",
            }
            .into();
            link.observed_turn_id = Some(turn.clone());
            if link.scope_state != "unknown" {
                link.observed_at = Some(clock.elapsed);
            }
        }
    }
}

async fn verify_fix(args: &Value) -> Result<()> {
    let Some(fix) = args.get("fixingCommit") else {
        return Ok(());
    };
    let projects = crate::kernel::file_cache::load(&root().join("coordination/projects.json"))?;
    verify_fix_in(fix, &projects).await
}
async fn verify_fix_in(fix: &Value, projects: &Value) -> Result<()> {
    let project = string(fix, "projectId");
    types::identifier(project)?;
    let oid = string(fix, "oid");
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("INVALID_ARGUMENT: fixingCommit requires a full Git object ID".into());
    }
    let project = projects["projects"].as_array().into_iter().flatten().find(|p| p["id"] == project).ok_or("COORDINATION_FIX_UNVERIFIED: refresh projects and select a registered local repository")?;
    let roots = project["roots"]
        .as_array()
        .ok_or("COORDINATION_FIX_UNVERIFIED: registered repository unavailable")?;
    // Bounded, serial, read-only local Git checks. Never fetch or infer deployment.
    for root in roots.iter().take(8) {
        let check = crate::projects::git(
            string(root, "path"),
            vec!["cat-file".into(), "-t".into(), oid.into()],
        );
        if tokio::time::timeout(std::time::Duration::from_secs(2), check)
            .await
            .is_ok_and(|r| r.is_ok_and(|kind| kind.trim() == "commit"))
        {
            return Ok(());
        }
    }
    Err("COORDINATION_FIX_UNVERIFIED: fixingCommit must exist as a commit in the registered local project; omit it only for an explicitly explained non-code recovery".into())
}
pub(crate) async fn call(
    op: &str,
    mut args: Value,
    control: &crate::control::Control,
) -> Result<Value> {
    let session = control.session.as_str();
    let result = async {
        validate(op,&args)?;
        let reader = actor()?;
        maintain()?;
        let projection = reconcile().err();
        if op == "board" {
            super::messages::migrate_routes()?;
            let mut value = with_store(|s| s.board(&args,&reader.revision,clock()))?;
            if let Some(sessions) = value["sessions"].as_array_mut() {
                for session in sessions { super::routing::session_projection(session)?; }
            }
            value["projectionPending"] = json!(projection.is_some() || with_store(|s| Ok(!s.state.pending.is_empty()))?);
            value["attention"] = attention(&reader.principal).await;
            let lines: Vec<String> = value["attention"]["items"].as_array().into_iter().flatten()
                .filter(|item| item["kind"] != "blocker")
                .map(|item| format!("attention {} {} {}", string(item,"kind"), string(item,"id"), item["summary"].as_str().or(item["reason"].as_str()).unwrap_or(""))).collect();
            if !lines.is_empty() {
                let summary = string(&value, "summary");
                value["summary"] = json!(if summary.is_empty() { lines.join("\n") } else { format!("{summary}\n{}", lines.join("\n")) });
            }
            if reader.principal == Principal::LocalAuthority && args["id"].is_string() {
                if let Some(blocker) = recovery_blocker(string(&args,"id"))? { value["localRecoverySelection"] = blocker["recoverySelection"].clone(); }
            }
            return Ok(value);
        }
        if args["requestId"].is_null() { args["requestId"] = json!(id()); }
        let request = string(&args,"requestId").to_owned();
        let locks = crate::kernel::receipts::RequestLocks;
        let _guard = locks.lock(&request).await;
        let digest = digest(op,&args,&reader.principal);
        let mut receipt = match RECEIPTS.replay(&request,&digest,session)? {
            Some(mut r) if matches!(string(&r,"state"),"completed"|"failed") => { let mut result = r["result"].clone(); session_result(op,&args,&mut result)?; r["result"]=result.clone(); result["receipt"] = r; return Ok(result); }
            Some(r) => r,
            None => { let r = json!({"requestId":request,"digest":digest,"operation":op,"origin":crate::kernel::origin::current_origin(),"backendSession":session,"state":"reserved","createdAt":now()}); RECEIPTS.reserve(&r)?; r }
        };
        // Recover an owner commit even when its receipt checkpoint was lost on restart.
        let replay = with_store(|s| s.replay(&request,&digest))?;
        let outcome = if let Some(result) = replay { Ok(result) } else {
            if receipt["replayed"] == true {
                let retained = receipt["createdAt"].as_str().and_then(|at|chrono::DateTime::parse_from_rfc3339(at).ok())
                    .and_then(|at|clock().age(at.timestamp_millis())).is_some_and(|age|age < 7 * 86400);
                if !retained { return Err("COORDINATION_REPLAY_EXPIRED: the original incomplete receipt exceeds bulletin retention; inspect board and the original receipt before explicitly starting a new work scope".into()); }
            }
            let mut links = linked(&args,&reader.principal)?;
            let threads = links.iter().map(|l| l.thread_id.clone()).collect::<Vec<_>>();
            let mut observed = control.coordination_observations(&threads).await;
            for thread in &threads {
                if observed.iter().any(|(id, _, state)| id == thread && state != "unknown") { continue; }
                let rows = crate::dispatch_policy::records(thread)?;
                if rows.last().is_none_or(|r| r["agent"] != "codex") { continue; }
                if let Ok(Ok(state)) = tokio::time::timeout(std::time::Duration::from_secs(2), control.dispatch_state(thread)).await {
                    if let Some(turn) = state["turns"].as_array().and_then(|v| v.first()) {
                        observed.retain(|(id, _, _)| id != thread);
                        observed.push((thread.clone(), string(turn,"id").into(), string(turn,"status").into()));
                    }
                }
            }
            apply_link_observations(&mut links, &observed, clock());
            if op == "blocker_clear" { verify_fix(&args).await?; }
            let route = if op == "coordination_session" && args["action"] == "register" {
                if let Some(target) = args["target"].as_str() {
                    let source = match &reader.principal { Principal::Source {source_id,..} => source_id, _ => return Err("SOURCE_REQUIRED: a notification target requires a control source".into()) };
                    Some(crate::claude_notify::coordination_delivery::verified_target(source,target)?)
                } else { None }
            } else { None };
            super::messages::migrate_routes()?;
            with_store(|s| if route.is_some() {s.mutate_routed(op,&args,&reader.principal,links,clock(),route)} else {s.mutate(op,&args,&reader.principal,links,clock())})
        };
        let mut value = match outcome {
            Ok(value) => { receipt["state"] = json!("completed"); value }
            Err(e) if e.starts_with("COORDINATION_STORAGE") || e.starts_with("COORDINATION_CAPACITY") || e.starts_with("COORDINATION_RATE_LIMIT") => return Err(e),
            Err(e) => { receipt["state"] = json!("failed"); failure(e,op) }
        };
        session_result(op,&args,&mut value)?;
        value["projectionPending"] = json!(reconcile().is_err() || with_store(|s| Ok(!s.state.pending.is_empty()))?);
        if op == "blocker_clear" {
            if let Some(blocker) = recovery_blocker(string(&args,"id"))? {
                value["recoverySelection"] = super::recovery::public_selection(&blocker["recoverySelection"]);
            }
        }
        receipt["result"] = value.clone();
        RECEIPTS.checkpoint(&mut receipt)?;
        value["receipt"] = receipt;
        Ok(value)
    }.await;
    Ok(result.unwrap_or_else(|e| failure(e, op)))
}
/// Matters waiting on the reader, referenced from their owners. Reading resolves nothing.
async fn attention(reader: &Principal) -> Value {
    let mut items = vec![];
    let mut coverage = json!({"bulletin":"observed","ax":"observed","notifications":"observed"});
    match with_store(|s| Ok(s.attention(reader))) {
        Ok(rows) => items.extend(rows),
        Err(_) => coverage["bulletin"] = json!("unavailable"),
    }
    match super::ax::attention() {
        Ok(rows) => items.extend(rows),
        Err(_) => coverage["ax"] = json!("unavailable"),
    }
    let mine = |id: &Value| match reader {
        Principal::Source { source_id, .. } => id == source_id.as_str(),
        _ => true,
    };
    match crate::claude_notify::coordination_attention().await {
        Ok(notifications) => {
            coverage["notifications"] = notifications["coverage"].clone();
            for problem in notifications["problems"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|p| mine(&p["sourceId"]))
                .take(20)
            {
                items.push(json!({"kind":"notification","id":problem["id"],"ownerSourceId":problem["sourceId"],"reason":problem["reason"],
                    "next":{"via":"query","op":"notify_status","args":{}}}));
            }
        }
        Err(_) => coverage["notifications"] = json!("unavailable"),
    }
    for item in &mut items {
        item["requiredActor"] = json!(match (reader, item["ownerSourceId"].is_string()) {
            (Principal::Source { .. }, _) => "you",
            (_, true) => "source",
            _ => "user",
        });
    }
    json!({"count":items.len(),"items":items,"coverage":coverage})
}
fn session_result(op: &str, args: &Value, value: &mut Value) -> Result<()> {
    if op != "coordination_session" || !value["session"].is_object() {
        return Ok(());
    }
    super::routing::session_projection(&mut value["session"])?;
    value["deliveryCapability"] = value["session"]["deliveryCapability"].clone();
    value["routing"] = value["session"]["routing"].clone();
    if args["action"] == "register" {
        value["next"] = registration_next(args, &value["session"]);
        value["hint"] = json!(if args["target"].is_null() {
            "Attach your verified target with message_route and keep this session open while you want push."
        } else {
            "Keep this session open while you want push."
        });
    }
    Ok(())
}
fn registration_next(args: &Value, session: &Value) -> Value {
    if args["target"].is_null() {
        json!({"via":"act","op":"message_route","args":{"sessionId":session["id"],"target":"<your verified Claude session ID or URL>"},"hint":"Replace target with your verified source-owned conversation target to enable push for this session."})
    } else if session["deliveryCapability"] == "pull-only" {
        json!({"via":"act","op":"notify_control","args":{"action":"bind","target":args["target"]},"sessionId":session["id"],"hint":"Bind and verify this source-owned conversation target, acknowledge the received code with notification_ack, then use message_route with this sessionId and target."})
    } else {
        json!({"via":"query","op":"messages","args":{}})
    }
}
/// Advisory only: callers append this object to successful operation receipts.
/// Failure is explicit unknown coverage, never an empty board claiming exclusivity.
pub(crate) fn warnings(resources: &[ResourceKey]) -> Value {
    let result = maintain().and_then(|_| with_store(|s| Ok(s.conflicts(resources, None, clock()))));
    match result {
        Ok(conflicts) => {
            json!({"conflictCoverage":if conflicts.len()==100 {"partial"}else{"observed"},"conflicts":conflicts})
        }
        Err(_) => json!({"conflicts":[],"conflictCoverage":"unknown"}),
    }
}
/// Journal projection supplies canonical terminal evidence, including Agent turns.
/// Replays never refresh activity; live caches supply freshness separately.
pub(super) fn from_event(input: &EventInput) -> Result<()> {
    if input.kind == EventKind::TurnSuccessor {
        if let ([previous, next], Some(owner)) =
            (input.thread_refs.as_slice(), input.origin.as_ref())
        {
            if previous.thread_id == next.thread_id {
                if let (Some(previous_turn), Some(next_turn)) = (&previous.turn_id, &next.turn_id) {
                    with_store(|s| {
                        s.successor(&previous.thread_id, previous_turn, next_turn, owner);
                        s.checkpoint_observation(clock())
                    })?;
                }
            }
        }
        return Ok(());
    }
    if input.kind != EventKind::TurnTerminal {
        return Ok(());
    }
    let state = match input.status {
        Some(EventStatus::Completed | EventStatus::Failed) => "completed",
        Some(EventStatus::Interrupted | EventStatus::Cancelled) => "interrupted",
        _ => return Ok(()),
    };
    with_store(|s| {
        for thread in &input.thread_refs {
            if let Some(turn) = &thread.turn_id {
                s.observe(&thread.thread_id, turn, state, clock(), false);
            }
        }
        s.checkpoint_observation(clock())
    })
}
/// Reuse already observed in-memory timelines, with no owner discovery or upstream
/// request. Disconnect/restart leaves unknown coverage and original timestamps.
pub(crate) async fn tick(control: &crate::control::Control, agents: &crate::agents::AgentHost) {
    let threads = match with_store(|s| Ok(s.linked_threads())) {
        Ok(t) => t,
        Err(_) => {
            observers::gap("bulletin", "storage-unavailable");
            return;
        }
    };
    if maintain().is_err() {
        observers::gap("bulletin", "maintenance-unavailable");
        return;
    }
    let mut observed = control.coordination_observations(&threads).await;
    observed.extend(agents.coordination_observations(&threads).await);
    let result = with_store(|s| {
        s.missing(
            &observed
                .iter()
                .map(|(thread, _, _)| thread.clone())
                .collect::<Vec<_>>(),
        );
        for (thread, turn, status) in &observed {
            let state = match status.as_str() {
                "running" | "inProgress" | "pending" => "running",
                "completed" | "failed" => "completed",
                "interrupted" | "cancelled" => "interrupted",
                _ => "unknown",
            };
            s.observe(thread, turn, state, clock(), true);
        }
        Ok(())
    })
    .and_then(|_| maintain())
    .and_then(|_| reconcile());
    if result.is_err() {
        observers::gap("bulletin", "projection-or-activity-unavailable");
    }
}
#[cfg(test)]
mod tests;

/// Registered-project mapping for observable local actions. This reads one cached
/// projection, never scans the filesystem for projects or treats a path as shared data.
pub(crate) fn repository_resources(repository: &str) -> Result<Vec<ResourceKey>> {
    let requested = Path::new(repository)
        .canonicalize()
        .map_err(|_| "COORDINATION_RESOURCE_UNKNOWN: repository unavailable")?;
    let registry = crate::kernel::file_cache::load(&root().join("coordination/projects.json"))?;
    let mut matches = vec![];
    let mut refs = super::git_watch::RefReader::default();
    let common = refs.common(&requested).ok();
    for project in registry["projects"]
        .as_array()
        .into_iter()
        .flatten()
        .take(32)
    {
        for root in project["roots"].as_array().into_iter().flatten().take(8) {
            let path = Path::new(string(root, "path"));
            let same_repository = common
                .as_ref()
                .is_some_and(|common| refs.common(path).is_ok_and(|p| p == *common));
            if same_repository || path.canonicalize().is_ok_and(|p| requested.starts_with(p)) {
                matches.push(ResourceKey::project(string(project, "id"))?);
                break;
            }
        }
    }
    matches.sort();
    matches.dedup();
    if matches.len() != 1 {
        return Err(
            "COORDINATION_RESOURCE_UNKNOWN: refresh projects or pull board before shared work"
                .into(),
        );
    }
    Ok(matches)
}
pub(crate) fn tooling_warnings(body: &Value) -> Value {
    let result = repository_resources(string(body, "repository")).and_then(|mut resources| {
        if let Some(lane) = body["lane"].as_str() {
            let project = resources[0]
                .as_str()
                .strip_prefix("project:")
                .unwrap()
                .strip_suffix("/main")
                .unwrap();
            resources.push(ResourceKey::lane(project, lane)?);
        }
        if let Some(instance) = body["instance"].as_str() {
            resources.push(ResourceKey::parse(&format!("isolated:{instance}"))?);
        }
        Ok(warnings(&resources))
    });
    result.unwrap_or_else(|_| json!({"conflicts":[],"conflictCoverage":"unknown"}))
}
/// Detect only explicit, simple Git push submissions. Shell scripts, aliases and
/// external processes remain unobserved; ref movement is not evidence of a push.
pub(crate) fn command_warnings(op: &str, args: &Value) -> Option<Value> {
    if op != "command" {
        return None;
    }
    let words: Vec<String> = if let Some(cmd) = args["cmd"].as_str() {
        if cmd.chars().any(|c| ";&|`$<>\\\n\"'".contains(c)) {
            return None;
        }
        cmd.split_whitespace().map(str::to_owned).collect()
    } else {
        args["params"]["command"]
            .as_array()?
            .iter()
            .map(|s| s.as_str().map(str::to_owned))
            .collect::<Option<_>>()?
    };
    if Path::new(words.first()?).file_stem()?.to_str()? != "git" {
        return None;
    }
    let mut index = 1;
    let mut cwd = args["cwd"]
        .as_str()
        .or(args["params"]["cwd"].as_str())
        .unwrap_or("");
    if words.get(index).is_some_and(|s| s == "-C") {
        cwd = words.get(index + 1)?;
        index += 2;
    }
    if words.get(index)? != "push" {
        return None;
    }
    Some(
        repository_resources(cwd)
            .map(|r| warnings(&r))
            .unwrap_or_else(|_| json!({"conflicts":[],"conflictCoverage":"unknown"})),
    )
}

/// Message routing consumes session ownership without reading the bulletin snapshot.
pub(crate) fn session_active(source: &str, id: &str) -> Result<bool> {
    with_store(|s| Ok(s.session_active(source, id)))
}
pub(crate) fn session_routes(
    source: &str,
) -> Result<
    Vec<(
        String,
        Option<crate::claude_notify::coordination_delivery::Route>,
        Option<String>,
    )>,
> {
    with_store(|s| Ok(s.session_routes(source)))
}
pub(crate) fn route(
    source: &str,
    session: &str,
) -> Result<Option<crate::claude_notify::coordination_delivery::Route>> {
    super::messages::migrate_routes()?;
    with_store(|s| Ok(s.route(source, session)))
}
pub(crate) fn bind_route(
    source: &str,
    session: &str,
    route: Option<crate::claude_notify::coordination_delivery::Route>,
) -> Result<()> {
    super::messages::migrate_routes()?;
    with_store(|s| s.bind(source, session, route, clock()))
}
pub(crate) fn import_routes(
    routes: &std::collections::BTreeMap<String, crate::claude_notify::coordination_delivery::Route>,
) -> Result<()> {
    with_store(|s| s.import_routes(routes, clock()))
}

pub(super) fn recovery_blocker(id: &str) -> Result<Option<Value>> {
    with_store(|s| Ok(s.recovery_blocker(id, clock())))
}
pub(super) fn recovery_plan(id: &str, plan: Value) -> Result<Value> {
    with_store(|s| s.recovery_plan(id, plan, clock()))
}
