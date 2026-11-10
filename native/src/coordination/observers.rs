//! Owner-persisted descriptors; only Core projects them after releasing owner locks.
use super::*;
use crate::turn_lifecycle::{adapters as turn_adapter, Transition, TurnState};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

const MAX_PENDING: usize = 4096;
static DIRTY: LazyLock<Mutex<BTreeSet<PathBuf>>> = LazyLock::new(Default::default);
static COVERAGE: LazyLock<Mutex<BTreeMap<String, Value>>> = LazyLock::new(Default::default);
static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

pub(crate) fn gap(key: &str, state: &str) {
    let mut map = COVERAGE.lock().unwrap();
    if map.len() < 256 || map.contains_key(key) {
        let at = now();
        let previous = map.get(key).cloned().unwrap_or(Value::Null);
        let last_gap = if state != "observed" {
            json!({"state":state,"observedAt":at})
        } else {
            previous["lastGap"].clone()
        };
        map.insert(
            key.into(),
            json!({"state":state,"observedAt":at,"lastGap":last_gap,"headState":previous["headState"]}),
        );
    }
}
pub(super) const COVERAGE_BYTES: usize = 16 * 1024;
pub(super) fn coverage() -> Value {
    let map = COVERAGE.lock().unwrap();
    let mut result = json!({});
    let mut bytes = 64;
    for (key, value) in map.iter() {
        let size = key.len() + value.to_string().len() + 8;
        if bytes + size > COVERAGE_BYTES {
            result["truncated"] = json!(true);
            break;
        }
        result[key] = value.clone();
        bytes += size;
    }
    result
}
pub(super) fn head_state(key: &str, state: &str) {
    let mut map = COVERAGE.lock().unwrap();
    if map.len() < 256 || map.contains_key(key) {
        map.entry(key.into()).or_insert(json!({}))["headState"] = json!(state);
    }
}
pub(super) fn registry_age(at: Value) {
    COVERAGE.lock().unwrap().insert(
        "projectRegistry".into(),
        json!({"state":"last-upstream-read","observedAt":at}),
    );
}
fn dirty(path: &Path) {
    let mut pending = DIRTY.lock().unwrap();
    if pending.len() < MAX_PENDING {
        pending.insert(path.into());
    } else {
        gap("owners", "pending-capacity");
    }
    WAKE.notify_one();
}
pub(super) fn host() -> Result<ResourceKey> {
    static HOST: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    if let Some(host) = HOST.get() {
        return ResourceKey::parse(host);
    }
    let path = root().join("coordination/host.json");
    let value = if path.exists() {
        load(&path)?
    } else {
        let value = json!({"id":id()});
        durable(&path, &value)?;
        value
    };
    let key = format!("host:{}", types::identifier(string(&value, "id"))?);
    let _ = HOST.set(key.clone());
    ResourceKey::parse(&key)
}
// Completed producer checkpoints are not pruned with journal retention. At capacity,
// reject a new projection rather than forget dedupe and fabricate a later duplicate.
#[derive(Default)]
struct StorageBudget {
    initialized: bool,
    files: BTreeMap<PathBuf, u64>,
    bytes: u64,
    full: bool,
}
static STORAGE: LazyLock<Mutex<StorageBudget>> = LazyLock::new(Default::default);
pub(super) fn durable(path: &Path, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let coordination = root().join("coordination");
    let bounded = path.starts_with(&coordination) && !path.starts_with(coordination.join("events"));
    let mut storage = bounded.then(|| STORAGE.lock().unwrap());
    if let Some(storage) = storage.as_mut() {
        if !storage.initialized {
            for directory in ["observations", "checkpoints", "tooling", "ref-watch", ""] {
                if let Ok(entries) = std::fs::read_dir(coordination.join(directory)) {
                    for entry in entries.take(8193).flatten() {
                        // The bulletin owns its separate snapshot/temporary budget.
                        if entry.path() == coordination.join("state.json") {
                            continue;
                        }
                        if entry.file_type().is_ok_and(|v| v.is_file())
                            && entry.path().extension().is_some_and(|v| v == "json")
                        {
                            let size = entry
                                .metadata()
                                .map_err(|_| {
                                    "COORDINATION_STORAGE: observer inventory unavailable"
                                })?
                                .len();
                            if storage.files.len() >= 8192 {
                                storage.full = true;
                                break;
                            }
                            storage.bytes += size;
                            storage.files.insert(entry.path(), size);
                        }
                    }
                }
            }
            storage.initialized = true;
        }
        let total =
            storage.bytes - storage.files.get(path).copied().unwrap_or(0) + bytes.len() as u64;
        if storage.full
            || (!storage.files.contains_key(path) && storage.files.len() >= 8192)
            || total > 16 * 1024 * 1024
            || bytes.len() > 128 * 1024
        {
            gap("storage", "observer-capacity");
            return Err(
                "COORDINATION_CAPACITY: preserve producer checkpoints for local archive/recovery"
                    .into(),
            );
        }
    }
    private_dir(
        path.parent()
            .ok_or("COORDINATION_STORAGE: missing parent")?,
    )?;
    journal::atomic_bytes(path, &bytes)?;
    crate::kernel::file_cache::changed(path, None);
    crate::runtime_metrics::cost::changed(1);
    if let Some(storage) = storage.as_mut() {
        storage.bytes =
            storage.bytes - storage.files.get(path).copied().unwrap_or(0) + bytes.len() as u64;
        storage.files.insert(path.into(), bytes.len() as u64);
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub(crate) enum Owner {
    Dispatch,
    Receipt,
    Agent,
}
fn base(row: &Value, key: &str, kind: EventKind) -> Result<EventInput> {
    let resources = vec![host()?, ResourceKey::parse("app:installed")?];
    base_on(row, key, kind, resources)
}
fn base_on(
    row: &Value,
    key: &str,
    kind: EventKind,
    resources: Vec<ResourceKey>,
) -> Result<EventInput> {
    let mut input = EventInput::new(hash(key), kind, resources);
    input.origin = if matches!(
        input.kind,
        EventKind::ReceiptStalled | EventKind::ReceiptUnconfirmed
    ) {
        receipt_origin(&row["origin"])?
    } else {
        Principal::from_origin(&row["origin"])?
    };
    let thread = row["threadId"].as_str().or(row["taskId"].as_str());
    if let Some(thread) = thread.filter(|v| types::identifier(v).is_ok()) {
        input.thread_refs.push(ThreadRef {
            thread_id: thread.into(),
            turn_id: row["turnId"]
                .as_str()
                .filter(|v| types::identifier(v).is_ok())
                .map(str::to_owned),
        });
    }
    Ok(input)
}
// Historical receipts predate source IDs. Labels and ingress names cannot prove
// a principal; preserve unknown attribution without relaxing current wire types.
fn receipt_origin(origin: &Value) -> Result<Option<Principal>> {
    if origin.is_object()
        && (origin["sourceId"].is_null() || origin["sourceId"] == "")
        && !(origin["authType"] == "local"
            && matches!(string(origin, "ingressId"), "local-cli" | "local-ui"))
    {
        return Ok(None);
    }
    Principal::from_origin(origin)
}

fn evidence(input: &mut EventInput, kind: EvidenceKind, id: &str) {
    if types::identifier(id).is_ok() {
        input.evidence_refs.push(EvidenceRef {
            kind,
            id: id.into(),
        });
    }
}
pub(super) fn inputs(owner: Owner, row: &Value) -> Result<Vec<EventInput>> {
    let mut events = inputs_on(owner, row, host()?)?;
    for event in &mut events {
        event.resources.push(ResourceKey::parse("app:installed")?);
        if let Some(project) = row["projectId"]
            .as_str()
            .filter(|s| types::identifier(s).is_ok())
        {
            event.resources.push(ResourceKey::project(project)?);
        }
    }
    Ok(events)
}
pub(super) fn inputs_on(
    owner: Owner,
    row: &Value,
    resource: ResourceKey,
) -> Result<Vec<EventInput>> {
    let base =
        |row: &Value, key: &str, kind: EventKind| base_on(row, key, kind, vec![resource.clone()]);
    let request = string(row, "requestId");
    let mut events = vec![];
    match owner {
        Owner::Dispatch => {
            if row["dispatchSource"] != "native-retry"
                && (row["agent"].is_null()
                    || row["agent"] == "codex"
                    || row["submissionObserved"] == true
                    || row["submission"] == "accepted")
            {
                let mut input = base(
                    row,
                    &format!("dispatch:{request}"),
                    EventKind::DispatchAccepted,
                )?;
                input.status = Some(EventStatus::Submitted);
                input.observation = Some(Observation {
                    model: row["model"].as_str().map(str::to_owned),
                    effort: row["effort"].as_str().map(str::to_owned),
                    ..Default::default()
                });
                evidence(&mut input, EvidenceKind::Request, request);
                events.push(input);
            }
            if row["retryOf"].is_string() {
                let mut input = base(
                    row,
                    &format!("successor:{request}"),
                    EventKind::TurnSuccessor,
                )?;
                input.thread_refs.insert(
                    0,
                    ThreadRef {
                        thread_id: string(row, "threadId").into(),
                        turn_id: Some(string(row, "retryOf").into()),
                    },
                );
                input.status = Some(EventStatus::Submitted);
                evidence(&mut input, EvidenceKind::Request, request);
                events.push(input);
            }
            let turn = crate::dispatch_policy::turn_lifecycle(row);
            if let Some(status) = turns::status(&turn, string(&row["terminal"], "state")) {
                super::git_watch::terminal(string(row, "threadId"), string(row, "turnId"));
                let mut input = base(
                    row,
                    &format!(
                        "terminal:{}:{}",
                        string(row, "threadId"),
                        string(row, "turnId")
                    ),
                    EventKind::TurnTerminal,
                )?;
                input.status = Some(status);
                input.occurred_at = row["terminal"]["endedAt"].as_str().map(str::to_owned);
                events.push(input);
            }
        }
        Owner::Receipt => {
            use crate::kernel::receipts::progress::{Progress, State};
            let progress = Progress::read(string(row, "state"), true);
            if row["operation"] == "resume"
                && progress.is(State::Completed)
                && row["turnId"].is_string()
            {
                let mut input = base(
                    row,
                    &format!("successor:{request}"),
                    EventKind::TurnSuccessor,
                )?;
                input.thread_refs.insert(
                    0,
                    ThreadRef {
                        thread_id: string(row, "threadId").into(),
                        turn_id: Some(string(&row["arguments"], "turnId").into()),
                    },
                );
                input.status = Some(EventStatus::Submitted);
                evidence(&mut input, EvidenceKind::Receipt, request);
                events.push(input);
            }
            if progress.is(State::Unconfirmed) {
                let mut input = base(
                    row,
                    &format!("unconfirmed:{request}"),
                    EventKind::ReceiptUnconfirmed,
                )?;
                input.status = Some(EventStatus::Unconfirmed);
                evidence(&mut input, EvidenceKind::Receipt, request);
                events.push(input);
            }
        }
        Owner::Agent => {
            let turn = crate::agents::lifecycle::read(row);
            if let Some(status) =
                turns::status(&turn, "cancelled").filter(|_| row["turnId"].is_string())
            {
                let mut record = row.clone();
                record["threadId"] = row["taskId"].clone();
                super::git_watch::terminal(string(row, "taskId"), string(row, "turnId"));
                let mut input = base(
                    &record,
                    &format!(
                        "terminal:{}:{}",
                        string(row, "taskId"),
                        string(row, "turnId")
                    ),
                    EventKind::TurnTerminal,
                )?;
                input.status = Some(status);
                events.push(input);
            }
        }
    }
    Ok(events)
}
/// The descriptor and owner transition share one synced rename. This function never emits.
pub(crate) fn save_owner(path: &Path, row: &Value, owner: Owner) -> Result<()> {
    let mut next = row.clone();
    let previous = crate::kernel::file_cache::load(path).unwrap_or(Value::Null);
    let mut pending = previous["coordinationPending"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    match inputs(owner, &next) {
        Ok(events) => {
            for input in events {
                if !pending
                    .iter()
                    .any(|v| v["transitionId"] == input.transition_id)
                {
                    if pending.len() < 128 {
                        pending.push(json!(input));
                    } else {
                        gap("owners", "descriptor-capacity");
                    }
                }
            }
        }
        Err(_) => gap("owners", "invalid-metadata"),
    }
    let checkpoint = crate::kernel::file_cache::load(&checkpoint_path(path)).unwrap_or(Value::Null);
    let needs_projection = pending
        .iter()
        .any(|event| checkpoint.get(string(event, "transitionId")).is_none());
    next["coordinationPending"] = json!(pending);
    if needs_projection {
        durable(path, &next)?;
    } else {
        save(path, &next)?;
    }
    // Ordinary Agent text snapshots do not create projection work or extra fsyncs.
    if needs_projection || matches!(owner, Owner::Receipt) {
        dirty(path);
    }
    Ok(())
}
/// A derived observation has its own durable owner record, never rewrites a live receipt.
pub(super) fn persist(input: EventInput) -> Result<PathBuf> {
    static SEEN: LazyLock<Mutex<BTreeSet<String>>> = LazyLock::new(Default::default);
    let mut seen = SEEN.lock().unwrap();
    let transition = input.transition_id.clone();
    let path = root()
        .join("coordination/observations")
        .join(format!("{}.json", input.transition_id));
    if seen.contains(&transition) {
        return Ok(path);
    }
    if !path.exists() {
        durable(&path, &json!({"coordinationPending":[input]}))?;
    }
    if seen.len() >= MAX_PENDING {
        seen.clear();
    }
    seen.insert(transition);
    dirty(&path);
    Ok(path)
}
fn checkpoint_path(path: &Path) -> PathBuf {
    root()
        .join("coordination/checkpoints")
        .join(format!("{}.json", hash(path.to_string_lossy().as_bytes())))
}
pub(super) fn project(path: &Path, emit: impl Fn(EventInput) -> Result<Value>) -> Result<()> {
    project_using(path, &emit)
}
fn project_using(path: &Path, emit: &dyn Fn(EventInput) -> Result<Value>) -> Result<()> {
    project_at(path, &checkpoint_path(path), &|input| {
        if matches!(
            input.kind,
            EventKind::TurnTerminal | EventKind::ReceiptUnconfirmed
        ) && path.parent() != Some(root().join("coordination/observations").as_path())
        {
            let transition = input.transition_id.clone();
            let terminal_path = persist(input)?;
            project_using(&terminal_path, emit)?;
            Ok(
                crate::kernel::file_cache::load(&checkpoint_path(&terminal_path))?[&transition]
                    .clone(),
            )
        } else {
            emit(input)
        }
    })
}
pub(super) fn project_at(
    path: &Path,
    checkpoint: &Path,
    emit: &dyn Fn(EventInput) -> Result<Value>,
) -> Result<()> {
    use crate::kernel::file_cache::Stamp;
    static PROJECTED: LazyLock<Mutex<BTreeMap<(PathBuf, PathBuf), Vec<Option<Stamp>>>>> =
        LazyLock::new(Default::default);
    let key = (path.to_path_buf(), checkpoint.to_path_buf());
    let before = vec![Stamp::read(path)?, Stamp::read(checkpoint)?];
    if PROJECTED.lock().unwrap().get(&key) == Some(&before) {
        return Ok(());
    }
    let row = crate::kernel::file_cache::shared_load(path)?;
    let mut done = if checkpoint.exists() {
        crate::kernel::file_cache::load(checkpoint)?
    } else {
        json!({})
    };
    for descriptor in row["coordinationPending"].as_array().into_iter().flatten() {
        crate::runtime_metrics::cost::rows(1);
        let input: EventInput = serde_json::from_value(descriptor.clone())
            .map_err(|_| "COORDINATION_STORAGE: invalid owner descriptor")?;
        if done.get(&input.transition_id).is_some() {
            continue;
        }
        if input.kind == EventKind::TurnTerminal && row["_turnLifecycle"].is_object() {
            let Some(turn) = turn_adapter::restore(&row["_turnLifecycle"]) else {
                continue;
            };
            if turns::status(
                &turn,
                if matches!(input.status, Some(EventStatus::Cancelled)) {
                    "cancelled"
                } else {
                    "interrupted"
                },
            ) != input.status
            {
                continue;
            }
        }
        let transition = input.transition_id.clone();
        // No owner/discovery lock is held here. The checkpoint survives feed retention.
        done[&transition] = emit(input)?;
        durable(checkpoint, &done)?;
    }
    let after = vec![Stamp::read(path)?, Stamp::read(checkpoint)?];
    if after[0] == before[0] {
        let mut projected = PROJECTED.lock().unwrap();
        if projected.len() >= MAX_PENDING {
            projected.clear();
        }
        projected.insert(key, after);
    }

    Ok(())
}
fn discover(dir: &Path, depth: usize, paths: &mut BTreeSet<PathBuf>) {
    if paths.len() >= MAX_PENDING {
        gap("replay", "discovery-capacity");
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.take(MAX_PENDING).flatten() {
        crate::runtime_metrics::cost::rows(1);
        if paths.len() >= MAX_PENDING {
            gap("replay", "discovery-capacity");
            break;
        }
        let path = entry.path();
        if entry.file_type().is_ok_and(|t| t.is_dir()) && depth > 0 {
            discover(&path, depth - 1, paths);
        } else if path.extension().is_some_and(|v| v == "json") {
            paths.insert(path);
        }
    }
}
pub(crate) fn start(service: &Arc<crate::service::Service>) -> tokio::task::JoinHandle<()> {
    let service = Arc::downgrade(service);
    tokio::spawn(async move {
        let mut pending = BTreeSet::new();
        crate::runtime_metrics::cost::sync(
            crate::runtime_metrics::cost::Owner::CoordinationObservers,
            crate::runtime_metrics::cost::Reason::Startup,
            || {
                for (name, depth) in [
                    ("dispatches", 1),
                    ("agents/requests", 0),
                    ("agents/tasks", 0),
                    ("coordination/observations", 0),
                    ("coordination/tooling", 0),
                ] {
                    discover(&root().join(name), depth, &mut pending);
                }
                discover(&root(), 0, &mut pending);
            },
        );
        let mut reason = crate::runtime_metrics::cost::Reason::Startup;
        let mut receipts = ReceiptObserver::default();
        let receipt_directory = root();
        let agent_receipt_directory = receipt_directory.join("agents/requests");
        let mut watcher = super::git_watch::Watcher::default();
        let mut git_at = Instant::now() - Duration::from_secs(30);
        let mut slow_at = Instant::now() - Duration::from_secs(30);
        if let Ok(host) = host() {
            let mut restart = EventInput::new(id(), EventKind::AppRestarted, vec![host]);
            restart.origin = Some(Principal::Arc);
            if let Some(service) = service.upgrade() {
                restart.evidence_refs.push(EvidenceRef {
                    kind: EvidenceKind::CoreInstance,
                    id: service.control.session.clone(),
                });
            }
            restart.status = Some(EventStatus::Running);
            if persist(restart).is_err() {
                gap("restart", "persistence-failed");
            }
        }
        loop {
            let Some(service) = service.upgrade() else {
                break;
            };
            crate::runtime_metrics::cost::scope(
                crate::runtime_metrics::cost::Owner::CoordinationObservers,
                reason,
                async {
                    pending.extend(std::mem::take(&mut *DIRTY.lock().unwrap()));
                    if slow_at.elapsed() >= Duration::from_secs(5) {
                        for path in &receipts.waiting {
                            crate::runtime_metrics::cost::rows(1);
                            pending.insert(path.clone());
                        }
                        super::bulletin::tick(&service.control, &service.agents).await;
                        slow_at = Instant::now();
                    }
                    let batch = std::mem::take(&mut pending);
                    crate::runtime_metrics::cost::scan_set(batch.len());
                    for path in batch {
                        crate::runtime_metrics::cost::rows(1);
                        // Startup replay visits historical owners once. Do not fill the
                        // hot JSON cache with complete receipt payloads and checkpoints.
                        if let Ok(row) = crate::kernel::file_cache::shared_load(&path) {
                            let receipt_path = (path.parent() == Some(receipt_directory.as_path())
                                || path.parent() == Some(agent_receipt_directory.as_path()))
                                && path
                                    .file_stem()
                                    .and_then(|name| name.to_str())
                                    .is_some_and(|name| uuid::Uuid::parse_str(name).is_ok());
                            if receipt_path
                                || (row["requestId"].is_string() && row["operation"].is_string())
                            {
                                let session = if path.starts_with(&agent_receipt_directory) {
                                    service.agents.backend_session()
                                } else {
                                    &service.control.session
                                };
                                if let Ok(resource) = host() {
                                    if !receipts.observe(
                                        &path,
                                        &row,
                                        session,
                                        chrono::Utc::now().timestamp_millis(),
                                        resource,
                                        &|input| persist(input).map(|_| ()),
                                    ) {
                                        continue;
                                    }
                                }
                            }
                            if project(&path, super::emit).is_err() && pending.len() < MAX_PENDING {
                                pending.insert(path);
                                gap("projection", "pending-retry");
                            }
                        } else if path.exists() {
                            gap("projection", "owner-read-unavailable");
                            if pending.len() < MAX_PENDING {
                                pending.insert(path);
                            }
                        }
                    }
                    receipts.report();
                    if git_at.elapsed()
                        >= Duration::from_secs(if super::git_watch::active() { 5 } else { 30 })
                    {
                        crate::runtime_metrics::cost::scope(
                            crate::runtime_metrics::cost::Owner::CoordinationGit,
                            crate::runtime_metrics::cost::Reason::Timer,
                            watcher.poll(),
                        )
                        .await;
                        git_at = Instant::now();
                    }
                },
            )
            .await;
            drop(service);
            tokio::select! { _=WAKE.notified()=>reason = crate::runtime_metrics::cost::Reason::Dirty, _=tokio::time::sleep(Duration::from_secs(5))=>reason = crate::runtime_metrics::cost::Reason::Timer }
        }
    })
}

/// Known receipt paths only. Invalid records leave the age-poll set and are
/// retried only after an owner write; sampled invalid counts never exceed the cap.
#[derive(Default)]
pub(super) struct ReceiptObserver {
    waiting: BTreeSet<PathBuf>,
    invalid: BTreeSet<PathBuf>,
    invalid_capped: bool,
    failed: BTreeSet<PathBuf>,
    pending_capped: bool,
}
impl ReceiptObserver {
    pub(super) fn report(&self) {
        COVERAGE
            .lock()
            .unwrap()
            .insert("receipts".into(), self.coverage());
    }
    pub(super) fn coverage(&self) -> Value {
        json!({
            "state": if !self.failed.is_empty() { "persistence-failed" } else if self.pending_capped { "pending-capacity" } else { "observed" },
            "observedAt": now(),
            "skippedInvalidRecords": self.invalid.len(),
            "invalidCountCapped": self.invalid_capped,
        })
    }
    pub(super) fn observe(
        &mut self,
        path: &Path,
        row: &Value,
        session: &str,
        time: i64,
        resource: ResourceKey,
        persist: &dyn Fn(EventInput) -> Result<()>,
    ) -> bool {
        let result = receipt_inputs(row, session, time, resource);
        let (events, watch) = match result {
            Ok(value) => value,
            Err(_) => {
                self.waiting.remove(path);
                self.failed.remove(path);
                if self.invalid.len() < MAX_PENDING {
                    self.invalid.insert(path.into());
                } else if !self.invalid.contains(path) {
                    self.invalid_capped = true;
                }
                return false;
            }
        };
        self.invalid.remove(path);
        let mut persistence_failed = false;
        for input in events {
            if persist(input).is_err() {
                persistence_failed = true;
            }
        }
        if persistence_failed && self.failed.len() < MAX_PENDING {
            self.failed.insert(path.into());
        } else if !persistence_failed {
            self.failed.remove(path);
        }
        if watch || persistence_failed {
            if self.waiting.len() < MAX_PENDING {
                self.waiting.insert(path.into());
            } else {
                self.pending_capped = true;
            }
        } else {
            self.waiting.remove(path);
        }
        true
    }
}
fn receipt_inputs(
    row: &Value,
    session: &str,
    time: i64,
    resource: ResourceKey,
) -> Result<(Vec<EventInput>, bool)> {
    types::identifier(string(row, "requestId"))?;
    if string(row, "state").is_empty() || string(row, "operation").is_empty() {
        return Err("INVALID_RECEIPT: missing operation or state".into());
    }
    receipt_origin(&row["origin"])?;
    use crate::kernel::receipts::progress::{self, Progress};
    let phase = Progress::read(string(row, "state"), row["backendSession"] == session);
    if !phase.active() && !phase.is(progress::State::Unconfirmed) {
        return Ok((vec![], false));
    }
    // A malformed timestamp must not keep a record in the idle poll forever.
    let updated = row["updatedAt"]
        .as_str()
        .or(row["createdAt"].as_str())
        .ok_or("INVALID_RECEIPT: missing phase timestamp")?;
    chrono::DateTime::parse_from_rfc3339(updated)
        .map_err(|_| "INVALID_RECEIPT: invalid phase timestamp")?;
    let mut events = vec![];
    if phase.is(progress::State::Unconfirmed)
        && !Progress::read(string(row, "state"), true).is(progress::State::Unconfirmed)
    {
        let uncertain = progress::project(row.clone(), false, time);
        events.extend(inputs_on(Owner::Receipt, &uncertain, resource.clone())?);
    }
    let normalized = progress::project(row.clone(), !phase.is(progress::State::Unconfirmed), time);
    let stalled = stalled_input(&normalized, time, resource)?;
    let watch = phase.is(progress::State::Reserved) && stalled.is_none();
    events.extend(stalled);
    Ok((events, watch))
}

pub(crate) fn watch_receipt(path: &Path) {
    dirty(path);
}
pub(crate) fn unconfirmed(row: &Value) {
    if let Ok(events) = inputs(Owner::Receipt, row) {
        for input in events {
            if persist(input).is_err() {
                gap("receipts", "persistence-failed");
            }
        }
    }
}

/// Persist native terminal evidence independently of push bindings, after event-lock release.
pub(crate) async fn native_terminal(method: &str, params: &Value) {
    let thread = params["threadId"]
        .as_str()
        .or(params["conversationId"].as_str())
        .unwrap_or("");
    if types::identifier(thread).is_err() {
        return;
    }
    let turns = if method == "turn/completed" {
        vec![params["turn"].clone()]
    } else if method == "desktop/thread-stream-state-changed"
        && params["change"]["type"] == "snapshot"
    {
        crate::desktop::turns(&params["change"]["conversationState"]).unwrap_or_default()
    } else {
        return;
    };
    if turns.len() > 128 {
        gap("terminal", "snapshot-turn-capacity");
    }
    let mut native = BTreeMap::<String, Transition>::new();
    for turn in turns.into_iter().rev().take(128) {
        let id = string(&turn, "id");
        if types::identifier(id).is_err() {
            continue;
        }
        let incoming = turn_adapter::codex_turn(thread, &turn);
        let previous = native
            .entry(id.into())
            .or_insert_with(|| Transition::new(incoming.key().clone()));
        *previous = turn_adapter::observe(previous, &incoming);
    }
    for (turn_id, incoming) in native {
        if !matches!(
            incoming.state(),
            TurnState::Terminal(_) | TurnState::Conflict(_)
        ) {
            continue;
        }
        let row = json!({"threadId":thread,"turnId":turn_id});
        let Ok(mut input) = base(
            &row,
            &format!("terminal:{thread}:{turn_id}"),
            EventKind::TurnTerminal,
        ) else {
            continue;
        };
        input.origin = Some(Principal::Arc);
        let path = root()
            .join("coordination/observations")
            .join(format!("{}.json", input.transition_id));
        let previous = crate::kernel::file_cache::load(&path).unwrap_or(Value::Null);
        let mut known = turn_adapter::snapshot(
            incoming.key().clone(),
            "unknown",
            &previous["_turnLifecycle"],
        );
        if previous["_turnLifecycle"].is_null() {
            for descriptor in previous["coordinationPending"]
                .as_array()
                .into_iter()
                .flatten()
            {
                let legacy = turn_adapter::snapshot(
                    incoming.key().clone(),
                    string(descriptor, "status"),
                    &Value::Null,
                );
                known = turn_adapter::observe(&known, &legacy);
            }
        }
        let merged = turn_adapter::observe(&known, &incoming);
        if merged.state() == known.state() && previous["_turnLifecycle"].is_object() {
            continue;
        }
        let pending = if let Some(status) = turns::status(&merged, "interrupted") {
            input.status = Some(status);
            super::git_watch::terminal(thread, &turn_id);
            if let Some(capture) = crate::changes::terminal(thread, &turn_id) {
                let _ = capture.await;
            }
            vec![input]
        } else {
            vec![]
        };
        if durable(&path, &json!({"_turnLifecycle":turn_adapter::checkpoint(&merged),"coordinationPending":pending})).is_err() {
            gap("terminal", "persistence-failed");
        } else { dirty(&path); }
    }
}

pub(super) fn stalled_input(
    row: &Value,
    time: i64,
    resource: ResourceKey,
) -> Result<Option<EventInput>> {
    use crate::kernel::receipts::progress::{self, Progress};
    let phase = Progress::read(string(row, "state"), true);
    if !phase.stalled(progress::age_ms(row, time).unwrap_or(0)) {
        return Ok(None);
    }
    let updated = row["updatedAt"].as_str().or(row["createdAt"].as_str());
    let mut input = base_on(
        row,
        &format!(
            "stalled:{}:{}",
            string(row, "requestId"),
            updated.unwrap_or("")
        ),
        EventKind::ReceiptStalled,
        vec![resource],
    )?;
    evidence(&mut input, EvidenceKind::Receipt, string(row, "requestId"));
    Ok(Some(input))
}
