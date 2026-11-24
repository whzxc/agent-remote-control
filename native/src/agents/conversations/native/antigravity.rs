//! Read-only Antigravity transcript and summary projection.
use super::*;
use std::{borrow::Cow, io::BufRead};

#[derive(Default)]
pub(in crate::agents::conversations) struct Summaries {
    stamp: Option<(Stamp, Option<Stamp>)>,
    rows: HashMap<String, Summary>,
}

struct Summary {
    title: String,
    preview: String,
    project: Option<PathBuf>,
    parent: String,
    name: String,
    status: String,
    updated: Option<String>,
}

impl Summaries {
    pub(in crate::agents::conversations) fn refresh(&mut self, path: &Path) {
        let wal = path.with_extension("db-wal");
        let stamps = || Some((Stamp::read(path).ok()??, Stamp::read(&wal).ok()?));
        let Some(stamp) = stamps() else {
            *self = Self::default();
            return;
        };
        if self.stamp.as_ref() == Some(&stamp) {
            return;
        }
        let rows = if stamp.1.as_ref().is_some_and(|wal| wal.size() != 0) {
            // SQLite WAL readers can write shared-memory read marks. Replay a
            // stable copy in a private directory instead.
            snapshot(path, &wal, || stamps().as_ref() == Some(&stamp))
        } else {
            summaries(path, true)
        };
        if let Some(rows) = rows.filter(|_| stamps().as_ref() == Some(&stamp)) {
            self.stamp = Some(stamp);
            self.rows = rows;
        }
    }

    pub(in crate::agents::conversations) fn enrich(&self, row: &mut Value) {
        let Some(summary) = self.rows.get(string(row, "id")) else {
            return;
        };
        if !summary.parent.trim().is_empty() {
            row["parentSessionId"] = json!(summary.parent);
            row["relationKind"] = json!("subagent");
        }
        let role = if row["relationKind"] == "subagent" && summary.title.trim().is_empty() {
            if summary.name.trim().is_empty() {
                crate::agents::antigravity::cached_role(string(row, "id"))
            } else {
                Some(summary.name.clone())
            }
        } else {
            None
        };
        if let Some(title) = nonempty(&summary.title).or(role.as_deref()) {
            row["title"] = json!(short(title, 120));
        }
        if let Some(preview) = nonempty(&summary.preview) {
            row["preview"] = json!(short(preview, 240));
        }
        row["project"] = json!(summary.project);
        if let Some(name) = nonempty(&summary.name) {
            row["agentName"] = json!(name);
        }
        if let Some(status) = nonempty(&summary.status) {
            row["nativeStatus"] = json!(status);
            let native_status = status.strip_prefix("CASCADE_RUN_STATUS_").unwrap_or(status);
            row["status"] = json!(match native_status.to_ascii_lowercase().as_str() {
                "done" | "completed" | "finished" => "completed",
                "failed" | "error" => "failed",
                "running" | "active" => "running",
                "cancelled" | "canceled" | "interrupted" => "interrupted",
                "idle" => "idle",
                _ => status,
            });
        }
        if let Some(updated) = summary.updated.as_ref() {
            let updated = json!(updated);
            if super::super::conversation_time(&json!({"at":updated}), "at")
                > super::super::conversation_time(row, "updatedAt")
            {
                row["updatedAt"] = updated;
            }
        }
    }
}

fn snapshot(
    path: &Path,
    wal: &Path,
    unchanged: impl Fn() -> bool,
) -> Option<HashMap<String, Summary>> {
    struct SnapshotDir(PathBuf);
    impl Drop for SnapshotDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let dir = std::env::temp_dir().join(format!("arc-antigravity-{}", uuid::Uuid::new_v4()));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&dir).ok()?;
    let dir = SnapshotDir(dir);
    let copied = dir.0.join("summaries.db");
    std::fs::copy(path, &copied).ok()?;
    std::fs::copy(wal, copied.with_extension("db-wal")).ok()?;
    unchanged().then(|| summaries(&copied, false)).flatten()
}

fn summaries(path: &Path, immutable: bool) -> Option<HashMap<String, Summary>> {
    use rusqlite::{Connection, OpenFlags};
    let mut uri = url::Url::from_file_path(path).ok()?;
    if immutable {
        uri.set_query(Some("immutable=1"));
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_URI;
    let db = Connection::open_with_flags(uri.as_str(), flags).ok()?;
    db.busy_timeout(Duration::ZERO).ok()?;
    let mut query = db.prepare(
        "SELECT conversation_id, title, preview, workspace_uris, parent_conversation_id, agent_name, status, last_modified_time FROM conversation_summaries"
    ).ok()?;
    let rows = query
        .query_map([], |row| {
            let uris: Option<String> = row.get(3)?;
            let project = uris
                .and_then(|uris| serde_json::from_str::<Vec<String>>(&uris).ok())
                .into_iter()
                .flatten()
                .filter_map(|uri| url::Url::parse(&uri).ok())
                .find_map(|uri| uri.to_file_path().ok());
            let updated: Option<String> = row.get(7).unwrap_or_default();
            Ok((
                row.get(0)?,
                Summary {
                    title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    preview: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    project,
                    parent: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    name: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    status: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    updated: updated.and_then(|value| normalized_time(&json!(value))),
                },
            ))
        })
        .ok()?;
    Some(rows.filter_map(std::result::Result::ok).collect())
}

fn nonempty(text: &str) -> Option<&str> {
    let text = text.trim();
    (!text.is_empty()).then_some(text)
}

fn clean_user_input(raw: &str) -> String {
    const START: &str = "<USER_REQUEST>";
    const END: &str = "</USER_REQUEST>";
    let request = raw
        .split_once(START)
        .and_then(|(_, tail)| tail.split_once(END))
        .map_or(raw, |(request, _)| request);
    let mut clean = request.replace(START, "").replace(END, "");
    for (open, close) in [
        ("<ADDITIONAL_METADATA>", "</ADDITIONAL_METADATA>"),
        ("<USER_SETTINGS_CHANGE>", "</USER_SETTINGS_CHANGE>"),
        ("<CONTEXT_SUMMARY>", "</CONTEXT_SUMMARY>"),
        ("<SYSTEM_MESSAGE>", "</SYSTEM_MESSAGE>"),
        ("<EPHEMERAL_MESSAGE>", "</EPHEMERAL_MESSAGE>"),
        ("<GRILL_ME>", "</GRILL_ME>"),
    ] {
        while let Some(start) = clean.find(open) {
            let end_start = start + open.len();
            let Some(end) = clean[end_start..].find(close) else {
                break;
            };
            clean.replace_range(start..end_start + end + close.len(), "");
        }
    }
    clean.trim().to_owned()
}

fn text(record: &Value) -> Cow<'_, str> {
    let text = string(record, "content").trim();
    if record["type"] == "USER_INPUT" {
        Cow::Owned(clean_user_input(text))
    } else {
        Cow::Borrowed(text)
    }
}

fn dispatch(record: &Value) -> Option<Value> {
    let model = record["model"]
        .as_str()
        .filter(|model| !model.trim().is_empty())?;
    if let Some((base, effort)) = model.rsplit_once('-').filter(|(base, effort)| {
        !base.is_empty() && crate::agents::antigravity::EFFORTS.contains(effort)
    }) {
        Some(json!({"model":base, "effort":effort}))
    } else {
        Some(json!({"model":model}))
    }
}

#[derive(Default)]
struct Turn {
    start: Option<chrono::DateTime<chrono::FixedOffset>>,
    end: Option<chrono::DateTime<chrono::FixedOffset>>,
    dispatch: Option<Value>,
}

impl Turn {
    fn observe(&mut self, record: &Value) {
        if let Ok(at) = chrono::DateTime::parse_from_rfc3339(string(record, "created_at")) {
            self.start.get_or_insert(at);
            self.end = Some(at);
        }
        if record["type"] == "PLANNER_RESPONSE" {
            if let Some(summary) = dispatch(record) {
                self.dispatch = Some(summary);
            }
        }
    }

    fn timing(&self) -> Option<Value> {
        let start = self.start?;
        let end = self.end?;
        Some(
            json!({"startedAt":start.to_rfc3339(), "endedAt":end.to_rfc3339(),
            "durationMs":(end - start).num_milliseconds().max(0)}),
        )
    }
}

pub(super) fn derive(path: &Path, modified: SystemTime) -> Option<Value> {
    let id = path.parent()?.parent()?.parent()?.file_name()?.to_str()?;
    uuid::Uuid::parse_str(id).ok()?;
    if path.file_name()? != "transcript.jsonl" {
        return None;
    }
    let mut prompt = None;
    let mut reply = None;
    let mut created = None;
    let mut turn = Turn::default();
    let mut latest_dispatch = None;
    let mut users = 0;
    let mut replies = 0;
    let mut partial = false;
    for line in BufReader::new(File::open(path).ok()?).lines() {
        let line = line.ok()?;
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            partial |= !line.trim().is_empty();
            continue;
        };
        match string(&record, "type") {
            "USER_INPUT" => {
                users += 1;
                turn = Turn::default();
                if let Some(text) = nonempty(&text(&record)).filter(|_| prompt.is_none()) {
                    prompt = Some(short(text, 240));
                }
            }
            "PLANNER_RESPONSE" => {
                replies += 1;
                if let Some(text) = nonempty(&text(&record)).filter(|_| reply.is_none()) {
                    reply = Some(short(text, 240));
                }
            }
            _ => {}
        }
        turn.observe(&record);
        if let Some(summary) = turn.dispatch.as_ref() {
            latest_dispatch = Some(summary.clone());
        }
        if created.is_none() {
            created = normalized_time(&record["created_at"]);
        }
    }
    let updated = chrono::DateTime::<chrono::Utc>::from(modified)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let preview = prompt.or(reply).unwrap_or_default();
    let timing = turn.timing().unwrap_or(Value::Null);
    Some(
        json!({"agent":"antigravity","id":id,"nativeSessionId":id,"source":"native",
        "title":short(&preview, 120),"preview":preview,"project":null,"status":null,
        "createdAt":created.unwrap_or_else(|| updated.clone()),"updatedAt":updated,
        "dispatchSummary":latest_dispatch,"turnCount":users.max(usize::from(replies > 0)),
        "turnStartedAt":timing["startedAt"],"turnEndedAt":timing["endedAt"],
        "turnDurationMs":timing["durationMs"],"messageCount":users + replies,"metadataPartial":partial}),
    )
}

pub(in crate::agents::conversations) fn timeline(
    id: &str,
    records: &[Value],
    truncated: bool,
) -> Value {
    let mut timeline = crate::task_tracking::Timeline::default();
    timeline.info = json!({"id":id,"agent":"antigravity"});
    timeline.partial = truncated;
    let mut groups = records.iter().peekable();
    let mut turn_count = 0;
    let mut latest_dispatch = None;
    while let Some(first) = groups.next() {
        let turn_records = std::iter::once(first)
            .chain(std::iter::from_fn(|| {
                groups.next_if(|row| row["type"] != "USER_INPUT")
            }))
            .collect::<Vec<_>>();
        let is_user = first["type"] == "USER_INPUT";
        turn_count += usize::from(is_user);
        let turn_id = if is_user {
            first["step_index"].to_string()
        } else {
            "native-initial".into()
        };
        if !is_user {
            timeline.turn.clone_from(&turn_id);
        }
        let last_text = turn_records
            .iter()
            .rposition(|record| record["type"] == "PLANNER_RESPONSE" && !text(record).is_empty());
        let mut turn = Turn::default();
        for (index, record) in turn_records.into_iter().enumerate() {
            turn.observe(record);
            append_step(&mut timeline, record, index, last_text);
        }
        if let Some(timing) = turn.timing() {
            timeline.turn_timings.insert(turn_id.clone(), timing);
        }
        if let Some(summary) = turn.dispatch {
            latest_dispatch = Some(summary.clone());
            timeline.turn_dispatch_summaries.insert(turn_id, summary);
        }
    }
    let mut result = timeline.response(id, 0);
    if result["dispatchSummary"].is_null() {
        result["dispatchSummary"] = json!(latest_dispatch);
    }
    result["turnCount"] = json!(turn_count.max(usize::from(
        records.iter().any(|row| row["type"] == "PLANNER_RESPONSE")
    )));
    result["status"] = Value::Null;
    result["readOnly"] = json!(true);
    result
}

fn append_step(
    timeline: &mut crate::task_tracking::Timeline,
    record: &Value,
    index: usize,
    last_text: Option<usize>,
) {
    let at = string(record, "created_at");
    let revision = timeline.revision;
    let text = text(record);
    let calls = record["tool_calls"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    match string(record, "type") {
        "USER_INPUT" => timeline.agent(
            "arc/user",
            &json!({"turnId":record["step_index"].to_string(),"text":text}),
            at,
        ),
        "PLANNER_RESPONSE" => {
            let mut content = Vec::new();
            if let Some(thinking) = nonempty(string(record, "thinking")) {
                content.push(json!({"type":"thinking","thinking":thinking}));
            }
            if !text.is_empty() {
                content.push(json!({"type":"text","text":text}));
            }
            for call in calls {
                content.push(json!({"type":"toolCall","id":call["id"],"name":call["name"],"arguments":call["arguments"]}));
            }
            timeline.agent(
                "message_end",
                &json!({"message":{"role":"assistant","content":content}}),
                at,
            );
        }
        _ => {}
    }
    // Timeline bounds can evict old entries while appending. Select the new
    // rows by revision as well as by their position.
    for entry in timeline
        .entries
        .iter_mut()
        .rev()
        .take_while(|entry| entry["cursor"].as_u64().unwrap_or(0) > revision)
    {
        entry["stepIndex"] = record["step_index"].clone();
        entry["source"] = record["source"].clone();
        entry["nativeStatus"] = record["status"].clone();
        if let Some(status) = match string(record, "status") {
            "DONE" | "COMPLETED" => Some("completed"),
            "ERROR" | "FAILED" => Some("failed"),
            "ACTIVE" | "RUNNING" => Some("running"),
            _ => None,
        } {
            entry["status"] = json!(status);
        }
        match string(entry, "type") {
            "user" => entry["role"] = json!("user"),
            "text" => {
                entry["role"] = json!("assistant");
                if calls.is_empty() || last_text == Some(index) {
                    entry["phase"] = json!("final_answer");
                }
            }
            "thinking" => entry["role"] = json!("assistant"),
            _ => {}
        }
    }
}
