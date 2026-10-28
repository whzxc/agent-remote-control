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
    offset: u64,
    status: Option<String>,
    started_at: Value,
    turn_id: String,
    turns: HashSet<String>,
    dispatch_summary: Option<Value>,
    turn_dispatch_summaries: HashMap<String, Value>,
    thread_tier: Value,
    turn_tier: Value,
    title: String,
    native_title: crate::task_tracking::TranscriptTitle,
    project: Option<String>,
    created_at: Value,
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
            let (scanned, cache) = tokio::task::spawn_blocking(move || {
                let scanned = scan(&selected, &mut cache);
                (scanned, cache)
            })
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
    }
}

#[derive(Default)]
struct ScanCache {
    directories: Cache<Value>,
    tails: HashMap<PathBuf, Tail>,
    titles: Option<(PathBuf, Stamp, HashMap<String, String>)>,
    file_opens: u64,
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
        if self.tails.get(path).is_none_or(|tail| tail.stamp != stamp) {
            // At most 128 recent tails (128 KiB each) are retained. Older files are
            // discovered through metadata without reading their contents.
            if self.tails.len() >= 128 && !self.tails.contains_key(path) {
                self.tails.clear();
            }
            let (clock, clock_stamp) = self
                .tails
                .remove(path)
                .filter(|tail| stamp.appends_to(&tail.stamp))
                .map(|tail| (tail.clock, tail.clock_stamp))
                .unwrap_or_default();
            self.file_opens += 1;
            let (records, partial) = read_tail(path, 128 * 1024)?;
            let mut timeline = Timeline::default();
            timeline.partial = partial;
            timeline.backfill_transcript(agent, &records);
            if Stamp::read(path)?.as_ref() != Some(&stamp) {
                return Err("Transcript changed during activity sampling".into());
            }
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
        let session = tail
            .timeline
            .transcript_active(modified, now)
            .then(|| {
                let id = tail.timeline.info["id"]
                    .as_str()
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
            turn_started_at(path, agent, &mut tail.clock)?;
            if Stamp::read(path)?.as_ref() != Some(&tail.stamp) {
                return Err("Transcript changed during activity sampling".into());
            }
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
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
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
    let mut sessions = scan_roots(
        &roots,
        &codex_home.join("session_index.jsonl"),
        SystemTime::now(),
        cache,
    );
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
    }
    sessions
}
fn scan_roots(
    roots: &[(String, PathBuf)],
    index: &Path,
    now: SystemTime,
    cache: &mut ScanCache,
) -> Vec<External> {
    let mut active = Vec::new();
    let mut recent = HashSet::new();
    for (agent, root) in roots {
        let mut directories = vec![root.clone()];
        while let Some(dir) = directories.pop() {
            let Ok(entries) = cache.directories.entries(&dir) else {
                continue;
            };
            for entry in entries.iter() {
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
                    cache.tail(path, agent, Stamp::from_metadata(&metadata), modified, now)
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
    let mut lines = bytes.split_inclusive(|byte| *byte == b'\n');
    if offset > 0 {
        lines.next();
    }
    let records: Vec<Value> = lines
        .filter(|line| line.last() == Some(&b'\n'))
        .filter_map(|line| serde_json::from_slice(line).ok())
        .collect();
    let row = conversation_projection(&records, offset > 0);
    cached.stamp = Some(stamp);
    cached.row = row.clone();
    Ok(row)
}

fn turn_started_at(path: &Path, agent: &str, clock: &mut TurnClock) -> Result<Value> {
    read_clock(File::open(path).map_err(|e| e.to_string())?, agent, clock)
}

fn read_clock(mut file: File, agent: &str, clock: &mut TurnClock) -> Result<Value> {
    if file.metadata().map_err(|e| e.to_string())?.len() < clock.offset {
        *clock = TurnClock::default();
    }
    file.seek(SeekFrom::Start(clock.offset))
        .map_err(|e| e.to_string())?;
    // The clock is byte-complete, unlike the recent-activity tail. Retain only
    // one line and its projection, and resume after the last complete record.
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        let count = reader
            .read_until(b'\n', &mut line)
            .map_err(|e| e.to_string())?;
        if count == 0 || line.last() != Some(&b'\n') {
            break;
        }
        if let Ok(record) = serde_json::from_slice::<Value>(&line) {
            observe_clock(&record, agent, clock);
        }
        clock.offset += count as u64;
    }
    Ok(clock.started_at.clone())
}

fn observe_clock(record: &Value, agent: &str, clock: &mut TurnClock) {
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
    if agent == "codex"
        && record["type"] == "event_msg"
        && record["payload"]["type"] == "thread_settings_applied"
    {
        clock.thread_tier = record["payload"]["thread_settings"]["service_tier"].clone();
    }
    if let Some((turn, start)) = projection.transcript_turn_start() {
        clock.status = None;
        clock.started_at = json!(start);
        clock.turn_tier = clock.thread_tier.clone();
        if clock.turn_id != turn {
            clock.dispatch_summary = None;
        }
        clock.turn_id = turn.into();
        clock.turns.insert(turn.into());
    }
    if !projection.status.is_empty() {
        clock.status = Some(projection.status.clone());
    } else if !projection.prompt_headline().is_empty() {
        clock.status = None;
    }
    if let Some(summary) = projection.turn_dispatch_summaries.get(&clock.turn_id) {
        clock.dispatch_summary = Some(summary.clone());
        clock
            .turn_dispatch_summaries
            .insert(clock.turn_id.clone(), summary.clone());
    }
    if agent == "codex" && record["type"] == "turn_context" {
        if let Some(turn) = record["payload"]["turn_id"].as_str() {
            if clock.turn_id != turn {
                clock.status = None;
                clock.turn_tier = clock.thread_tier.clone();
            }
            clock.turn_id = turn.into();
            clock.turns.insert(turn.into());
            let context = &record["payload"];
            clock.dispatch_summary = crate::egress::dispatch_summary(&json!({
                "model":context["model"],"effort":context["effort"],
                "serviceTier":context["service_tier"],"threadServiceTier":clock.turn_tier
            }));
            if let Some(summary) = &clock.dispatch_summary {
                clock
                    .turn_dispatch_summaries
                    .insert(turn.into(), summary.clone());
            }
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
        "status":clock.status,"metadataPartial":partial})
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
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let size = file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
    let start = size.saturating_sub(limit);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(limit)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let mut lines = bytes.split(|b| *b == b'\n');
    if start > 0 {
        lines.next();
    }
    let records = lines
        .filter_map(|line| serde_json::from_slice(line).ok())
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
#[cfg(test)]
mod tests {
    use super::*;
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
