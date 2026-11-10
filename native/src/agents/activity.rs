#[cfg(test)]
use crate::kernel::file_cache::Io;
use crate::kernel::file_cache::{Cache, Stamp};
use crate::task_tracking::Timeline;
use crate::*;
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    time::{Duration, Instant, SystemTime},
};

#[derive(Default)]
pub(super) struct Monitor {
    sampled: Option<Instant>,
    selected: Vec<String>,
    active: Vec<(String, Value)>,
    known: Vec<External>,
    scan: ScanCache,
}
#[derive(Default)]
pub(super) struct TurnClock {
    codex_transcript: crate::task_tracking::CodexTranscript,
    offset: u64,
    status: Option<String>,
    started_at: Value,
    turn_id: String,
    turns: HashSet<String>,
    dispatch_summary: Option<Value>,
    turn_dispatch_summaries: HashMap<String, Value>,
    thread_tier: crate::task_tracking::CodexThreadTier,
    turn_tier: Value,
    turn_configuration: Value,
    session_id: Option<String>,
    title: String,
    nickname: Option<String>,
    native_title: crate::task_tracking::TranscriptTitle,
    project: Option<String>,
    created_at: Value,
    parent_session_id: Option<String>,
    creator_account_id: Option<String>,
    relation_kind: Option<&'static str>,
}
#[derive(Clone)]
pub(super) struct External {
    pub agent: String,
    pub session: Value,
    pub path: PathBuf,
    pub turn_dispatch_summaries: HashMap<String, Value>,
}
impl Monitor {
    pub fn external(&self, id: &str) -> Option<External> {
        self.known.iter().find(|s| s.session["id"] == id).cloned()
    }
    pub async fn sample(&mut self, mut selected: Vec<String>) -> Vec<(String, Value)> {
        crate::runtime_metrics::cost::scope(
            crate::runtime_metrics::cost::Owner::Activity,
            crate::runtime_metrics::cost::Reason::Poll,
            async {
                selected.retain(|id| matches!(id.as_str(), "codex" | "claude"));
                selected.sort();
                selected.dedup();
                if self.selected != selected
                    || self
                        .sampled
                        .is_none_or(|at| at.elapsed() >= Duration::from_secs(2))
                {
                    self.selected = selected.clone();
                    let mut cache = std::mem::take(&mut self.scan);
                    let (scanned, cache) = tokio::task::spawn_blocking(
                        crate::runtime_metrics::cost::blocking(move || {
                            let scanned = scan(&selected, &mut cache);
                            (scanned, cache)
                        }),
                    )
                    .await
                    .unwrap_or_default();
                    self.scan = cache;
                    self.active = scanned
                        .iter()
                        .map(|s| (s.agent.clone(), s.session.clone()))
                        .collect();
                    for session in scanned {
                        self.known
                            .retain(|s| s.session["id"] != session.session["id"]);
                        self.known.push(session);
                    }
                    if self.known.len() > 128 {
                        self.known.drain(..self.known.len() - 128);
                    }
                    self.sampled = Some(Instant::now());
                }
                self.active.clone()
            },
        )
        .await
    }
}

#[derive(Default)]
struct ScanCache {
    directories: Cache<Value>,
    tails: HashMap<PathBuf, Tail>,
    titles: Option<(PathBuf, Stamp, HashMap<String, String>)>,
    file_opens: u64,
    discovery: Option<Discovery>,
}
struct Discovery {
    roots: Vec<(String, PathBuf)>,
    changes: Option<crate::kernel::file_cache::Changes>,
    revision: Option<u64>,
    scanned: Option<Instant>,
}
struct Tail {
    stamp: Stamp,
    timeline: Timeline,
    clock: TurnClock,
    clock_stamp: Option<Stamp>,
}
impl ScanCache {
    #[cfg(test)]
    fn io(&self) -> Io {
        Io {
            file_opens: self.file_opens,
            directory_reads: self.directories.io().directory_reads,
        }
    }
    fn tail(
        &mut self,
        path: &Path,
        agent: &str,
        stamp: Stamp,
        modified: SystemTime,
        now: SystemTime,
    ) -> Result<(&Tail, Option<Value>)> {
        let miss = self.tails.get(path).is_none_or(|tail| tail.stamp != stamp);
        crate::runtime_metrics::cost::cache(!miss);
        if miss {
            // At most 128 recent tails (128 KiB each) are retained. Older files are
            // discovered through metadata without reading their contents.
            if self.tails.len() >= 128 && !self.tails.contains_key(path) {
                self.tails.clear();
            }
            self.file_opens += 1;
            let file = File::open(path).map_err(|e| e.to_string())?;
            let (records, partial) = read_tail_prefix(file, stamp.size(), 128 * 1024)?;
            let mut timeline = Timeline::default();
            timeline.partial = partial;
            timeline.backfill_transcript(agent, &records);
            verify_prefix(path, &stamp)?;
            let (clock, clock_stamp) = self
                .tails
                .remove(path)
                .filter(|tail| stamp.appends_to(&tail.stamp))
                .map(|tail| (tail.clock, tail.clock_stamp))
                .unwrap_or_default();
            self.tails.insert(
                path.into(),
                Tail {
                    stamp,
                    timeline,
                    clock,
                    clock_stamp,
                },
            );
        }
        let tail = self.tails.get_mut(path).unwrap();
        // Codex lifecycle records can fall outside the bounded content tail.
        // Read the incremental clock even when a large output leaves no entries.
        if agent == "codex" && tail.clock_stamp.as_ref() != Some(&tail.stamp) {
            self.file_opens += 1;
            read_sample_clock(path, agent, tail)?;
            tail.clock_stamp = Some(tail.stamp.clone());
        }
        if agent == "codex" && !tail.clock.turn_id.is_empty() {
            tail.timeline.turn = tail.clock.turn_id.clone();
            tail.timeline.status = tail.clock.status.clone().unwrap_or_default();
        }
        // Codex can initialize a fork with user-role context before any
        // turn starts. Content alone is not evidence of running work.
        let active = tail.timeline.transcript_active(modified, now)
            && (agent != "codex"
                || matches!(tail.clock.status.as_deref(), Some("running" | "inProgress")));
        let session = active
            .then(|| {
                let id = tail
                    .clock
                    .session_id
                    .as_deref()
                    .or_else(|| tail.timeline.info["id"].as_str())
                    .map(str::to_owned)
                    .or_else(|| {
                        let stem = path.file_stem()?.to_str()?;
                        let tail = stem.get(stem.len().checked_sub(36)?..)?;
                        uuid::Uuid::parse_str(tail).ok().map(|_| tail.to_owned())
                    })?;
                Some(tail.timeline.transcript_session(&id, agent))
            })
            .flatten();
        // Completed or expired transcripts need only their tail, never a full
        // metadata walk. Time-dependent activity is evaluated even on cache hits.
        if session.is_some() && tail.clock_stamp.as_ref() != Some(&tail.stamp) {
            self.file_opens += 1;
            read_sample_clock(path, agent, tail)?;
            tail.clock_stamp = Some(tail.stamp.clone());
        }
        Ok((tail, session))
    }
    fn titles(&mut self, path: &Path) -> Result<&HashMap<String, String>> {
        let stamp = Stamp::read(path)?.ok_or("Session index not found")?;
        if self
            .titles
            .as_ref()
            .is_none_or(|(old_path, old_stamp, _)| old_path != path || old_stamp != &stamp)
        {
            self.file_opens += 1;
            let file = File::open(path).map_err(|e| e.to_string())?;
            let mut titles = HashMap::new();
            for line in BufReader::new(file).lines() {
                let line = line.map_err(|e| e.to_string())?;
                crate::runtime_metrics::cost::rows(1);
                crate::runtime_metrics::cost::bytes_read(line.len());
                crate::runtime_metrics::cost::bytes_parsed(line.len());
                let Ok(record) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let title = string(&record, "thread_name").trim();
                if !title.is_empty() {
                    titles.insert(
                        string(&record, "id").into(),
                        title.chars().take(240).collect(),
                    );
                }
            }
            if Stamp::read(path)?.as_ref() != Some(&stamp) {
                return Err("Session index changed during activity sampling".into());
            }
            self.titles = Some((path.into(), stamp, titles));
        }
        Ok(&self.titles.as_ref().unwrap().2)
    }
}
fn scan(selected: &[String], cache: &mut ScanCache) -> Vec<External> {
    let _scope = crate::runtime_metrics::Scope::new(crate::runtime_metrics::Work::Activity);
    let Ok(codex_home) = crate::accounts::codex::default_home() else {
        return Vec::new();
    };
    let claude_roots = if selected.iter().any(|agent| agent == "claude") {
        crate::accounts::claude::transcript_roots()
    } else {
        Vec::new()
    };
    let mut roots: Vec<_> = claude_roots
        .iter()
        .map(|(path, _)| ("claude".to_owned(), path.clone()))
        .collect();
    if selected.iter().any(|agent| agent == "codex") {
        roots.push(("codex".to_owned(), codex_home.join("sessions")));
    }
    let index = codex_home.join("session_index.jsonl");
    if cache.discovery.as_ref().is_none_or(|d| d.roots != roots) {
        let mut paths: Vec<_> = roots.iter().map(|(_, path)| path.clone()).collect();
        paths.push(index.clone());
        cache.discovery = Some(Discovery {
            roots: roots.clone(),
            changes: crate::kernel::file_cache::Changes::new(paths).ok(),
            revision: None,
            scanned: None,
        });
    }
    let discovery = cache.discovery.as_mut().unwrap();
    let revision = discovery.changes.as_ref().and_then(|c| c.revision());
    let discover = discovery.scanned.is_none()
        || discovery.revision != revision
        || revision.is_none()
            && discovery
                .scanned
                .is_some_and(|at| at.elapsed() >= Duration::from_secs(30));
    // A healthy watcher keeps historical directory discovery out of unchanged passes.
    // Selected recent/unfinished transcripts retain the ordinary two-second clock.
    let paths = if discover {
        discovery.revision = revision;
        discovery.scanned = Some(Instant::now());
        discover_paths(&roots, cache)
    } else {
        cache
            .tails
            .keys()
            .filter_map(|path| {
                roots
                    .iter()
                    .find(|(_, root)| path.starts_with(root))
                    .map(|(agent, _)| (agent.clone(), path.clone()))
            })
            .collect()
    };
    crate::runtime_metrics::cost::scan_set(paths.len());
    let mut sessions = scan_paths(paths, &index, SystemTime::now(), cache);
    for external in &mut sessions {
        if external.agent == "claude" {
            if let Some(account) = claude_roots
                .iter()
                .find(|(root, _)| external.path.starts_with(root))
                .and_then(|(_, account)| account.as_ref())
            {
                external.session["agentAccountId"] = json!(account);
            }
        }
        if external.agent == "codex" {
            match crate::accounts::codex::observe_native_thread(
                string(&external.session, "id"),
                external.session["creatorAccountId"].as_str(),
                external.session["parentSessionId"].as_str(),
            ) {
                Ok(account) => external.session["agentAccountId"] = account,
                Err(error) => crate::logs::record("WARN", &error, None),
            }
        }
    }
    sessions
}
#[cfg(test)]
fn scan_roots(
    roots: &[(String, PathBuf)],
    index: &Path,
    now: SystemTime,
    cache: &mut ScanCache,
) -> Vec<External> {
    let paths = discover_paths(roots, cache);
    scan_paths(paths, index, now, cache)
}
fn discover_paths(roots: &[(String, PathBuf)], cache: &mut ScanCache) -> Vec<(String, PathBuf)> {
    let mut paths = Vec::new();
    for (agent, root) in roots {
        let mut directories = vec![root.clone()];
        while let Some(dir) = directories.pop() {
            let Ok(entries) = cache.directories.entries(&dir) else {
                continue;
            };
            for entry in entries.iter() {
                crate::runtime_metrics::cost::rows(1);
                let path = &entry.path;
                if path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with('.'))
                    || entry.kind.is_symlink()
                {
                    continue;
                }
                if entry.kind.is_dir() {
                    directories.push(path.clone());
                    continue;
                }
                if !entry.kind.is_file() || path.extension().is_none_or(|ext| ext != "jsonl") {
                    continue;
                }
                if agent == "claude" && claude_sidechain(path, &[]) {
                    continue;
                }
                paths.push((agent.clone(), path.clone()));
            }
        }
    }
    paths
}
fn scan_paths(
    paths: Vec<(String, PathBuf)>,
    index: &Path,
    now: SystemTime,
    cache: &mut ScanCache,
) -> Vec<External> {
    let mut active = Vec::new();
    let mut recent = HashSet::new();
    for (agent, path) in paths {
        crate::runtime_metrics::cost::rows(1);
        let path = &path;
        let Ok(metadata) = std::fs::metadata(path) else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        // Keep already observed unfinished turns in the sample even when
        // compaction or a long tool stops writing to their transcript.
        let unfinished = cache
            .tails
            .get(path)
            .is_some_and(|tail| tail.timeline.transcript_active(modified, now));
        if !unfinished
            && now.duration_since(modified).unwrap_or_default() > Duration::from_secs(300)
        {
            continue;
        }
        recent.insert(path.clone());
        let Ok((tail, session)) =
            cache.tail(path, &agent, Stamp::from_metadata(&metadata), modified, now)
        else {
            continue;
        };
        if let Some(mut session) = session {
            let clock = &tail.clock;
            session["turnStartedAt"] = clock.started_at.clone();
            if !clock.title.is_empty() {
                session["title"] = json!(clock.title)
            }
            if session["project"].is_null() {
                session["project"] = json!(clock.project)
            }
            session["startedAt"] = clock.created_at.clone();
            if let Some(parent) = &clock.parent_session_id {
                session["parentSessionId"] = json!(parent);
                session["relationKind"] = json!(clock.relation_kind);
            }
            session["creatorAccountId"] = json!(clock.creator_account_id);
            session["turnCount"] = json!(clock.turns.len());
            if !clock.turn_id.is_empty() {
                session["turnId"] = json!(clock.turn_id)
            }
            if let Some(summary) = &clock.dispatch_summary {
                session["dispatchSummary"] = summary.clone()
            }
            active.push(External {
                agent: agent.clone(),
                session,
                path: path.clone(),
                turn_dispatch_summaries: clock.turn_dispatch_summaries.clone(),
            });
        }
    }
    if active.iter().any(|session| session.agent == "codex") {
        if let Ok(titles) = cache.titles(index) {
            for session in active.iter_mut().filter(|s| s.agent == "codex") {
                if let Some(title) = titles.get(string(&session.session, "id")) {
                    session.session["title"] = json!(title)
                }
            }
        }
    }
    for session in &mut active {
        if let Some(nickname) = cache
            .tails
            .get(&session.path)
            .and_then(|tail| tail.clock.nickname.as_deref())
        {
            session.session["title"] = json!(nickname);
        }
    }
    cache.tails.retain(|path, _| recent.contains(path));
    active
}

// List metadata is bounded independently from the active transcript clock.
#[derive(Default)]
pub(super) struct ConversationMetadata {
    stamp: Option<Stamp>,
    row: Value,
}

pub(super) fn conversation_metadata(
    thread: &Value,
    cached: &mut ConversationMetadata,
) -> Result<Value> {
    let mut file = crate::control::open_persisted_history(thread)?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    let stamp = Stamp::from_metadata(&metadata);
    if cached.stamp.as_ref() == Some(&stamp) {
        return Ok(cached.row.clone());
    }
    // Listing must never replay a whole rollout or build a detail timeline.
    // A partial tail can report explicit outcomes and the latest model, but
    // cannot claim an exact total turn count or an earlier thread setting.
    let offset = metadata.len().saturating_sub(128 * 1024);
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(128 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    crate::runtime_metrics::cost::bytes_read(bytes.len());
    let mut lines = bytes.split_inclusive(|byte| *byte == b'\n');
    if offset > 0 {
        lines.next();
    }
    let records: Vec<Value> = lines
        .filter(|line| line.last() == Some(&b'\n'))
        .filter_map(|line| {
            crate::runtime_metrics::cost::bytes_parsed(line.len());
            serde_json::from_slice(line).ok()
        })
        .collect();
    let row = conversation_projection(&records, offset > 0);
    cached.stamp = Some(stamp);
    cached.row = row.clone();
    Ok(row)
}

fn verify_prefix(path: &Path, stamp: &Stamp) -> Result<()> {
    // Appends preserve the sampled byte range. Replacements and truncations do not.
    if Stamp::read(path)?.is_some_and(|current| current == *stamp || current.appends_to(stamp)) {
        return Ok(());
    }
    Err("Transcript changed during activity sampling".into())
}

fn read_sample_clock(path: &Path, agent: &str, tail: &mut Tail) -> Result<()> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let clock = &mut tail.clock;
    file.seek(SeekFrom::Start(clock.offset))
        .map_err(|e| e.to_string())?;
    // The clock is byte-complete, unlike the recent-activity tail. Retain only
    // one line and its projection, and resume after the last complete record.
    let mut reader = BufReader::new(file.take(tail.stamp.size() - clock.offset));
    let mut line = Vec::new();
    loop {
        line.clear();
        let count = reader
            .read_until(b'\n', &mut line)
            .map_err(|e| e.to_string())?;
        if count == 0 || line.last() != Some(&b'\n') {
            break;
        }
        crate::runtime_metrics::cost::bytes_read(line.len());
        crate::runtime_metrics::cost::bytes_parsed(line.len());
        if let Ok(record) = serde_json::from_slice::<Value>(&line) {
            observe_clock(&record, agent, clock);
        }
        clock.offset += count as u64;
    }
    if let Err(error) = verify_prefix(path, &tail.stamp) {
        *clock = TurnClock::default();
        tail.clock_stamp = None;
        return Err(error);
    }
    Ok(())
}

fn observe_clock(record: &Value, agent: &str, clock: &mut TurnClock) {
    if agent == "codex" && !clock.codex_transcript.include(record) {
        return;
    }
    if agent == "codex" && record["type"] == "session_meta" {
        let payload = &record["payload"];
        clock.session_id = payload["id"].as_str().map(str::to_owned);
        clock.creator_account_id = payload["creator_account_id"].as_str().map(str::to_owned);
        clock.nickname = payload["agent_nickname"]
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|name| name.chars().take(240).collect());
        let (parent, kind) = if payload["attached_thread"] == true {
            (&payload["forked_from_id"], "side-chat")
        } else {
            (
                &payload["source"]["subagent"]["thread_spawn"]["parent_thread_id"],
                "subagent",
            )
        };
        clock.parent_session_id = parent
            .as_str()
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        clock.relation_kind = clock.parent_session_id.as_ref().map(|_| kind);
    }
    if record["isSidechain"] == true {
        return;
    }
    if clock.created_at.is_null() && record["timestamp"].is_string() {
        clock.created_at = record["timestamp"].clone();
    }
    if let Some(project) = record["cwd"]
        .as_str()
        .or_else(|| record["payload"]["cwd"].as_str())
    {
        clock.project = Some(project.into());
    }
    let mut projection = Timeline::default();
    projection.turn = clock.turn_id.clone();
    projection.backfill_transcript(agent, std::slice::from_ref(record));
    if agent == "claude" {
        clock.native_title.observe(record);
        clock.title = clock.native_title.value().unwrap_or_default().into();
    } else if clock.title.is_empty() {
        clock.title = projection.prompt_headline();
    }
    if let Some((turn, start)) = projection.transcript_turn_start() {
        clock.status = None;
        clock.started_at = json!(start);
        clock.turn_tier = clock.thread_tier.current.clone();
        if clock.turn_id != turn {
            clock.dispatch_summary = None;
            clock.turn_configuration = Value::Null;
        }
        clock.turn_id = turn.into();
        clock.turns.insert(turn.into());
    }
    if !projection.status.is_empty() {
        clock.status = Some(projection.status.clone());
    } else if !projection.prompt_headline().is_empty()
        && (agent != "codex" || !matches!(clock.status.as_deref(), Some("running" | "inProgress")))
    {
        clock.status = None;
    }
    if let Some(summary) = projection.turn_dispatch_summaries.get(&clock.turn_id) {
        clock.dispatch_summary = Some(summary.clone());
        clock
            .turn_dispatch_summaries
            .insert(clock.turn_id.clone(), summary.clone());
    }
    if agent != "codex" {
        return;
    }
    let late_tier = clock
        .thread_tier
        .observe(record)
        .is_some_and(|turn| turn == clock.turn_id);
    let context = &record["payload"];
    if let Some(turn) = (record["type"] == "turn_context")
        .then(|| context["turn_id"].as_str())
        .flatten()
    {
        if clock.turn_id != turn {
            clock.status = None;
            clock.turn_tier = clock.thread_tier.current.clone();
        }
        clock.turn_id = turn.into();
        clock.turns.insert(turn.into());
        clock.turn_configuration = json!({
            "model":context["model"],"effort":context["effort"],"serviceTier":context["service_tier"]
        });
    } else if late_tier {
        clock.turn_tier = clock.thread_tier.current.clone();
    } else {
        return;
    }
    if clock.turn_configuration.is_object() {
        clock.turn_configuration["threadServiceTier"] = clock.turn_tier.clone();
        clock.dispatch_summary = crate::egress::dispatch_summary(&clock.turn_configuration);
        if let Some(summary) = &clock.dispatch_summary {
            clock
                .turn_dispatch_summaries
                .insert(clock.turn_id.clone(), summary.clone());
        } else {
            clock.turn_dispatch_summaries.remove(&clock.turn_id);
        }
    }
}

pub(super) fn conversation_projection(records: &[Value], partial: bool) -> Value {
    let mut clock = TurnClock::default();
    for record in records {
        observe_clock(record, "codex", &mut clock);
    }
    json!({"dispatchSummary":clock.dispatch_summary,
        "turnCount":if partial { None } else { Some(clock.turns.len()) },
        "turnId":clock.turn_id,"status":clock.status,"metadataPartial":partial})
}

pub(super) fn agent_summary(state: &Value) -> Option<Value> {
    let facts = super::dispatch::catalog_facts(
        state,
        &state["metadata"],
        state["configurationObservedAt"].clone(),
        "persisted-session-snapshot",
        Value::Null,
    );
    let mut configuration = super::dispatch::current_configuration(&facts);
    if state["agent"] == "pi"
        && state["lastMessage"]["provider"].is_string()
        && state["lastMessage"]["model"].is_string()
    {
        configuration["model"] = json!(format!(
            "{}/{}",
            string(&state["lastMessage"], "provider"),
            string(&state["lastMessage"], "model")
        ));
    }
    crate::egress::dispatch_summary(&configuration)
}

pub(super) fn claude_sidechain<'a>(
    path: &Path,
    records: impl IntoIterator<Item = &'a Value>,
) -> bool {
    let mut sidechain = false;
    let mut main = false;
    for record in records {
        sidechain |= record["isSidechain"] == true;
        main |= record["isSidechain"] != true
            && matches!(string(&record["message"], "role"), "user" | "assistant");
    }
    path.file_stem()
        .is_some_and(|name| name.to_string_lossy().starts_with("agent-"))
        || path
            .components()
            .any(|part| part.as_os_str() == "subagents")
        || (sidechain && !main)
}

pub(super) fn read_tail(path: &Path, limit: u64) -> Result<(Vec<Value>, bool)> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    read_tail_prefix(file, size, limit)
}

fn read_tail_prefix(mut file: File, size: u64, limit: u64) -> Result<(Vec<Value>, bool)> {
    let start = size.saturating_sub(limit);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(size - start)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    crate::runtime_metrics::cost::bytes_read(bytes.len());
    let mut lines = bytes.split(|b| *b == b'\n');
    if start > 0 {
        lines.next();
    }
    let records = lines
        .filter_map(|line| {
            crate::runtime_metrics::cost::bytes_parsed(line.len());
            serde_json::from_slice(line).ok()
        })
        .collect();
    Ok((records, start > 0))
}
pub(super) fn claude_timeline(path: &Path, session: &str) -> Result<Value> {
    let (records, truncated) = read_tail(path, 8 * 1024 * 1024)?;
    let mut timeline = crate::task_tracking::Timeline::default();
    timeline.partial = truncated;
    timeline.backfill_claude(&records);
    let mut result = timeline.response(session, 0);
    result["readOnly"] = json!(true);
    Ok(result)
}
pub(super) fn insert(agents: &mut serde_json::Map<String, Value>, agent: &str, session: Value) {
    agents
        .entry(agent.to_owned())
        .or_insert_with(|| json!({"sessions":[]}))["sessions"]
        .as_array_mut()
        .unwrap()
        .push(session);
}

pub(super) fn codex_sessions(events: &Events) -> Vec<Value> {
    // Late answers remain available, but only current interactions imply activity.
    let pending = events.pending_interactions();
    events
        .timelines
        .iter()
        .filter(|(id, timeline)| {
            matches!(timeline.status.as_str(), "running" | "inProgress")
                || pending
                    .iter()
                    .any(|p| p["params"]["threadId"] == **id && p["stale"] != true)
        })
        .map(|(id, timeline)| timeline.session(id, &timeline.info, "codex-thread", None))
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_activity_ignores_terminal_questions_without_dropping_late_answers() {
        // Regression: an unanswered async question kept a completed Codex task Responding forever.
        for status in ["completed", "failed", "cancelled", "interrupted"] {
            let mut events = Events::default();
            let mut timeline = Timeline::default();
            let at = "2026-01-01T00:00:00Z";
            timeline.codex("turn/started", &json!({"turn":{"id":"old"}}), at);
            timeline.codex(
                "turn/completed",
                &json!({"turn":{"id":"old","status":status}}),
                at,
            );
            events.timelines.insert("thread".into(), timeline);
            events.pending.insert("question".into(), json!({"id":"question","method":"request_user_input_async","params":{"threadId":"thread","turnId":"old"}}));

            assert!(codex_sessions(&events).is_empty());
            assert_eq!(events.pending_interactions().len(), 1);
            assert_eq!(events.pending_interactions()[0]["stale"], true);

            let timeline = events.timelines.get_mut("thread").unwrap();
            timeline.lose_observation();
            assert!(codex_sessions(&events).is_empty());

            let timeline = events.timelines.get_mut("thread").unwrap();
            timeline.codex("turn/started", &json!({"turn":{"id":"new"}}), at);
            assert_eq!(codex_sessions(&events)[0]["turnId"], "new");

            let timeline = events.timelines.get_mut("thread").unwrap();
            timeline.lose_observation();
            events.pending.insert(
                "current".into(),
                json!({"id":"current","params":{"threadId":"thread","turnId":"new"}}),
            );
            assert_eq!(codex_sessions(&events).len(), 1);
            assert_eq!(events.pending_interactions().len(), 2);
        }
    }
    struct Sandbox(PathBuf);
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> (Sandbox, PathBuf, SystemTime, String) {
        let directory =
            Sandbox(std::env::temp_dir().join(format!("arc-clock-regression-{}", id())));
        std::fs::create_dir_all(&directory.0).unwrap();
        let path = directory
            .0
            .join("00000000-0000-4000-8000-000000000001.jsonl");
        let now = SystemTime::now();
        let timestamp = chrono::DateTime::<chrono::Utc>::from(now).to_rfc3339();
        (directory, path, now, timestamp)
    }
    fn append(path: &Path, records: &[Value]) {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        for record in records {
            writeln!(file, "{record}").unwrap();
        }
    }
    fn snapshot(directory: &Sandbox, agent: &str, now: SystemTime, cache: &mut ScanCache) -> Value {
        let rows = scan_roots(
            &[(agent.into(), directory.0.clone())],
            &directory.0.join("index.jsonl"),
            now,
            cache,
        );
        assert_eq!(rows.len(), 1);
        rows[0].session.clone()
    }
    fn prompt(agent: &str, turn: &str, text: &str, at: &str) -> Vec<Value> {
        if agent == "claude" {
            vec![
                json!({"uuid":turn,"timestamp":at,"type":"user","message":{"role":"user","content":text}}),
            ]
        } else {
            vec![
                json!({"timestamp":at,"type":"event_msg","payload":{"type":"task_started","turn_id":turn}}),
                json!({"timestamp":at,"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":text}]}}),
            ]
        }
    }
    fn large_tool_output(agent: &str, call: &str, at: &str) -> Vec<Value> {
        let output = "x".repeat(192 * 1024);
        if agent == "claude" {
            vec![
                json!({"uuid":format!("result-{call}"),"timestamp":at,"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":call,"content":output}]}}),
            ]
        } else {
            vec![
                json!({"timestamp":at,"type":"response_item","payload":{"type":"function_call_output","call_id":call,"output":output}}),
            ]
        }
    }
    fn tool_call(agent: &str, call: &str, at: &str) -> Vec<Value> {
        if agent == "claude" {
            vec![
                json!({"uuid":call,"timestamp":at,"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":call,"name":"Read","input":{"file_path":"src/example.rs"}}]}}),
            ]
        } else {
            vec![
                json!({"timestamp":at,"type":"response_item","payload":{"type":"function_call","call_id":call,"name":"exec_command","arguments":"{\"cmd\":\"cat src/example.rs\"}"}}),
            ]
        }
    }

    #[test]
    fn codex_subagent_nickname_survives_missing_prompt_and_tail_sampling() {
        // Regression: native subagent tasks arrived as agent_message records and displayed an empty title.
        let (directory, path, now, at) = fixture();
        let id = "00000000-0000-4000-8000-000000000001";
        let nickname = "Kepler";
        append(
            &path,
            &[json!({"type":"session_meta","timestamp":at,"payload":{
                "id":id,"agent_nickname":nickname,"subagent_history_start_ordinal":3,
                "source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent-thread"}}}
            }})],
        );
        append(
            &path,
            &prompt("codex", "parent-turn", "Inherited request", &at),
        );
        append(
            &path,
            &[
                json!({"type":"event_msg","timestamp":at,"payload":{"type":"task_started","turn_id":"child-turn"}}),
                json!({"type":"response_item","timestamp":at,"payload":{"type":"agent_message","author":"/root","recipient":"/root/review","content":[{"type":"input_text","text":"Message Type: NEW_TASK"}]}}),
            ],
        );
        append(&path, &tool_call("codex", "read-first", &at));
        append(&path, &large_tool_output("codex", "read-first", &at));
        append(&path, &tool_call("codex", "read-tail", &at));
        append(
            &directory.0.join("index.jsonl"),
            &[json!({"id":id,"thread_name":"Generated thread title"})],
        );
        let mut cache = ScanCache::default();
        let row = snapshot(&directory, "codex", now, &mut cache);
        assert_eq!(row["title"], nickname);
        assert_eq!(row["parentSessionId"], "parent-thread");
        assert_eq!(row["turnCount"], 1);
        append(&path, &tool_call("codex", "read-next", &at));
        assert_eq!(
            snapshot(&directory, "codex", now, &mut cache)["title"],
            nickname
        );
    }

    #[test]
    fn codex_subagent_parent_survives_tail_sampling() {
        // Regression: subagent sessions lost their native parent and appeared as independent Agent tasks.
        let (directory, path, now, at) = fixture();
        append(
            &path,
            &[
                json!({"type":"session_meta","timestamp":at,"payload":{"id":"00000000-0000-4000-8000-000000000001","subagent_history_start_ordinal":4,"source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent-thread"}}}}}),
                json!({"type":"session_meta","timestamp":at,"payload":{"id":"parent-thread","source":"vscode"}}),
            ],
        );
        append(
            &path,
            &prompt("codex", "parent-turn", "Inherited request", &at),
        );
        append(&path, &prompt("codex", "turn", "Review a module", &at));
        append(&path, &tool_call("codex", "read-first", &at));
        append(&path, &large_tool_output("codex", "read-first", &at));
        append(&path, &tool_call("codex", "read-tail", &at));
        let mut cache = ScanCache::default();
        assert_eq!(
            snapshot(&directory, "codex", now, &mut cache)["parentSessionId"],
            "parent-thread"
        );
        let row = snapshot(&directory, "codex", now, &mut cache);
        assert_eq!(row["id"], "00000000-0000-4000-8000-000000000001");
        assert_eq!(row["turnCount"], 1);
        assert_eq!(row["title"], "Review a module");
        assert_eq!(row["relationKind"], "subagent");
        append(&path, &tool_call("codex", "read-next", &at));
        assert_eq!(
            snapshot(&directory, "codex", now, &mut cache)["parentSessionId"],
            "parent-thread"
        );
    }

    #[test]
    fn codex_side_chat_keeps_its_relationship_after_tail_sampling() {
        // Regression: attached Codex side chats appeared as independent tasks with no relationship type.
        let (directory, path, now, at) = fixture();
        append(
            &path,
            &[json!({"type":"session_meta","timestamp":at,"payload":{
                "id":"00000000-0000-4000-8000-000000000001", "source":"vscode",
                "attached_thread":true, "forked_from_id":"parent-thread"
            }})],
        );
        append(&path, &prompt("codex", "turn", "Discuss the design", &at));
        append(&path, &tool_call("codex", "read-first", &at));
        append(&path, &large_tool_output("codex", "read-first", &at));
        append(&path, &tool_call("codex", "read-tail", &at));
        let mut cache = ScanCache::default();
        let row = snapshot(&directory, "codex", now, &mut cache);
        assert_eq!(row["parentSessionId"], "parent-thread");
        assert_eq!(row["relationKind"], "side-chat");
        append(&path, &tool_call("codex", "read-next", &at));
        let row = snapshot(&directory, "codex", now, &mut cache);
        assert_eq!(row["parentSessionId"], "parent-thread");
        assert_eq!(row["relationKind"], "side-chat");
    }

    #[test]
    fn first_prompt_survives_large_initial_transcripts_and_appends() {
        // Regression: f10de3bb selected a later prompt as the title after skipping the first 128 KiB of clock input.
        for agent in ["claude", "codex"] {
            let (directory, path, now, at) = fixture();
            append(&path, &prompt(agent, "first", "Original request", &at));
            append(&path, &tool_call(agent, "read-first", &at));
            append(&path, &large_tool_output(agent, "read-first", &at));
            append(&path, &prompt(agent, "second", "Later request", &at));
            append(&path, &tool_call(agent, "read-second", &at));
            let mut cache = ScanCache::default();
            let row = snapshot(&directory, agent, now, &mut cache);
            assert_eq!(row["title"], "Original request");
            assert_eq!(row["turnCount"], 2);
            append(&path, &large_tool_output(agent, "read-second", &at));
            append(&path, &prompt(agent, "third", "Newest request", &at));
            append(&path, &tool_call(agent, "read-third", &at));
            let row = snapshot(&directory, agent, now, &mut cache);
            assert_eq!(row["title"], "Original request");
            assert_eq!(row["turnCount"], 3);
            assert_eq!(row["turnId"], "third");
        }
    }

    #[test]
    fn claude_titles_use_first_prompt_and_native_names_across_compaction() {
        // Regression: multiline first prompts used their last line, and activity ignored custom titles and index cleaning.
        let (directory, path, now, at) = fixture();
        append(
            &path,
            &[
                json!({"type":"summary","summary":"Resumed summary","leafUuid":"prior"}),
                json!({"type":"user","uuid":"meta","timestamp":at,"isMeta":true,"message":{"role":"user","content":"Injected context"}}),
                json!({"type":"user","uuid":"command","timestamp":at,"message":{"role":"user","content":"<command-name>/clear</command-name>"}}),
                json!({"type":"user","uuid":"compact","timestamp":at,"isCompactSummary":true,"message":{"role":"user","content":"Compacted context"}}),
            ],
        );
        append(&path, &prompt("claude", "first", "<system-reminder>Context</system-reminder>Plan the service merger\n\nChoose the implementation", &at));
        append(&path, &large_tool_output("claude", "large", &at));
        append(&path, &prompt("claude", "later", "Later request", &at));
        let mut cache = ScanCache::default();
        assert_eq!(
            snapshot(&directory, "claude", now, &mut cache)["title"],
            "Plan the service merger Choose the implementation"
        );
        append(
            &path,
            &[json!({"type":"custom-title","customTitle":"Named conversation"})],
        );
        assert_eq!(
            snapshot(&directory, "claude", now, &mut cache)["title"],
            "Named conversation"
        );
        append(
            &path,
            &[json!({"type":"summary","summary":"Later compaction","leafUuid":"later"})],
        );
        assert_eq!(
            snapshot(&directory, "claude", now, &mut cache)["title"],
            "Named conversation"
        );
    }

    #[test]
    fn claude_history_retains_the_activity_dispatch_spec_for_each_turn() {
        // Regression: external Claude detail lost the activity model after the timeline response loaded.
        let (directory, path, now, at) = fixture();
        for (turn, model, effort) in [
            ("first", "model-one", "high"),
            ("second", "model-two", "low"),
        ] {
            append(&path, &prompt("claude", turn, "Inspect project", &at));
            append(
                &path,
                &[
                    json!({"type":"assistant","uuid":format!("reply-{turn}"),"timestamp":at,"perTurnEffort":effort,"message":{"role":"assistant","model":model,"content":[{"type":"thinking","thinking":"Inspecting"}]}}),
                ],
            );
        }
        let activity = snapshot(&directory, "claude", now, &mut ScanCache::default());
        let history = claude_timeline(&path, "external-fixture").unwrap();
        assert_eq!(history["dispatchSummary"], activity["dispatchSummary"]);
        assert_eq!(
            history["turnDispatchSummaries"]["first"]["model"],
            "model-one"
        );
        assert_eq!(history["turnDispatchSummaries"]["second"]["effort"], "low");
        append(
            &path,
            &[
                json!({"type":"assistant","uuid":"error","timestamp":at,"message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"Interrupted"}]}}),
            ],
        );
        assert_eq!(
            claude_timeline(&path, "external-fixture").unwrap()["dispatchSummary"],
            history["dispatchSummary"]
        );
    }

    #[test]
    fn codex_early_thread_tier_survives_large_rollouts_and_later_turns() {
        // Regression: f10de3bb skipped early thread_settings_applied and lost Fast tier from long Codex session summaries.
        let (directory, path, now, at) = fixture();
        append(
            &path,
            &[
                json!({"timestamp":at,"type":"session_meta","payload":{"id":"00000000-0000-4000-8000-000000000001","instructions":"fixture instructions ".repeat(10000)}}),
                json!({"timestamp":at,"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"service_tier":"priority"}}}),
            ],
        );
        let mut cache = ScanCache::default();
        for turn in ["first", "second"] {
            append(&path, &prompt("codex", turn, "Check files", &at));
            append(&path, &tool_call("codex", turn, &at));
            append(&path, &large_tool_output("codex", turn, &at));
            append(
                &path,
                &[
                    json!({"timestamp":at,"type":"turn_context","payload":{"turn_id":turn,"model":"fixture-model","effort":"high"}}),
                ],
            );
            append(&path, &tool_call("codex", &format!("next-{turn}"), &at));
            let row = snapshot(&directory, "codex", now, &mut cache);
            assert_eq!(row["dispatchSummary"]["serviceTier"], "priority");
            assert_eq!(row["dispatchSummary"]["model"], "fixture-model");
            assert_eq!(row["turnId"], turn);
        }
    }

    #[test]
    fn single_long_turn_keeps_session_and_turn_start_and_count() {
        // Regression: f10de3bb cleared turn clocks and omitted turnCount after a single turn grew beyond 128 KiB.
        for agent in ["claude", "codex"] {
            let (directory, path, now, at) = fixture();
            append(&path, &prompt(agent, "only-turn", "Inspect files", &at));
            let later =
                chrono::DateTime::<chrono::Utc>::from(now + Duration::from_secs(1)).to_rfc3339();
            let mut cache = ScanCache::default();
            for call in ["first-read", "second-read"] {
                append(&path, &tool_call(agent, call, &later));
                append(&path, &large_tool_output(agent, call, &later));
                append(&path, &tool_call(agent, &format!("next-{call}"), &later));
                let row = snapshot(&directory, agent, now, &mut cache);
                assert_eq!(row["startedAt"], at);
                assert_eq!(row["turnStartedAt"], at);
                assert_eq!(row["turnCount"], 1);
                assert_eq!(row["turnId"], "only-turn");
            }
        }
    }

    #[test]
    fn codex_activity_keeps_its_sample_while_the_rollout_grows() {
        // Regression: appends during activity sampling dropped the running turn from the snapshot.
        let (directory, path, now, at) = fixture();
        append(&path, &prompt("codex", "previous", "Inspect files", &at));
        let end = |turn: &str| json!({"timestamp":at,"type":"event_msg","payload":{"type":"task_complete","turn_id":turn}});
        append(&path, &[end("previous")]);
        append(&path, &prompt("codex", "current", "Continue work", &at));
        append(&path, &large_tool_output("codex", "large-output", &at));

        // Capture the file size used by scan_paths, then simulate a writer
        // appending a terminal event before the reader opens the file.
        let stamp = Stamp::read(&path).unwrap().unwrap();
        append(&path, &[end("current")]);
        let mut cache = ScanCache::default();
        let (_, session) = cache.tail(&path, "codex", stamp, now, now).unwrap();
        assert_eq!(session.unwrap()["turnId"], "current");
        let rows = scan_roots(
            &[("codex".into(), directory.0.clone())],
            &directory.0.join("index.jsonl"),
            now,
            &mut cache,
        );
        assert!(rows.is_empty());
    }

    #[test]
    fn activity_polls_preserve_unfinished_work_until_a_terminal_event() {
        // Regression: the two-second activity poll reopened every recent rollout and the entire title index.
        let dir = Sandbox(std::env::temp_dir().join(format!("arc-activity-cache-{}", id())));
        let sessions = dir.0.join("sessions");
        std::fs::create_dir_all(sessions.join("day")).unwrap();
        let index = dir.0.join("index.jsonl");
        let path = sessions.join("day/rollout.jsonl");
        let start = SystemTime::now();
        let timestamp = chrono::DateTime::<chrono::Utc>::from(start).to_rfc3339();
        let rollout = |session: &str, state: &str| {
            format!(
                "{}\n{}\n",
                json!({"type":"session_meta","payload":{"id":session}}),
                json!({"timestamp":timestamp,"type":"event_msg","payload":{"type":state,"turn_id":"turn"}})
            )
        };
        std::fs::write(&path, rollout("first", "task_started")).unwrap();
        std::fs::write(
            &index,
            format!("{}\n", json!({"id":"first","thread_name":"Initial"})),
        )
        .unwrap();
        let roots = vec![("codex".into(), sessions.clone())];
        let mut cache = ScanCache::default();
        let rows = scan_roots(&roots, &index, start, &mut cache);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session["title"], "Initial");
        let warm = cache.io();
        for second in [2, 4, 6, 8] {
            let rows = scan_roots(
                &roots,
                &index,
                start + Duration::from_secs(second),
                &mut cache,
            );
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].session["turnCount"], 1);
        }
        assert_eq!(cache.io(), warm);
        // Neither a silent tool nor the metadata age cutoff is terminal evidence.
        let silent = scan_roots(&roots, &index, start + Duration::from_secs(600), &mut cache);
        assert_eq!(silent[0].session["id"], "first");
        assert_eq!(silent[0].session["turnId"], "turn");
        assert_eq!(cache.io(), warm);
        std::fs::write(
            &index,
            format!("{}\n", json!({"id":"first","thread_name":"Renamed"})),
        )
        .unwrap();
        let rows = scan_roots(&roots, &index, start, &mut cache);
        assert_eq!(rows[0].session["title"], "Renamed");
        assert_eq!(cache.io().file_opens - warm.file_opens, 1);
        let changed = cache.io();
        std::fs::write(
            sessions.join("second.jsonl"),
            rollout("second", "task_started"),
        )
        .unwrap();
        assert_eq!(scan_roots(&roots, &index, start, &mut cache).len(), 2);
        assert_eq!(cache.io().directory_reads - changed.directory_reads, 1);
        assert_eq!(cache.io().file_opens - changed.file_opens, 2);
        // Replacement resets the turn clock even when the new file is longer.
        let replacement = sessions.join("replacement.tmp");
        std::fs::write(
            &replacement,
            rollout("first", "task_started")
                .replace("turn_id\":\"turn\"", "turn_id\":\"replacement-turn\""),
        )
        .unwrap();
        std::fs::rename(replacement, &path).unwrap();
        let rows = scan_roots(&roots, &index, start, &mut cache);
        let replaced = rows
            .iter()
            .find(|row| row.session["id"] == "first")
            .unwrap();
        assert_eq!(replaced.session["turnId"], "replacement-turn");
        assert_eq!(replaced.session["turnCount"], 1);
        std::fs::write(&path, rollout("first", "task_complete")).unwrap();
        let rows = scan_roots(&roots, &index, start, &mut cache);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session["id"], "second");
        std::fs::remove_file(sessions.join("second.jsonl")).unwrap();
        assert!(scan_roots(&roots, &index, start, &mut cache).is_empty());
    }
}
