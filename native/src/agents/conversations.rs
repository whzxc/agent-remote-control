//! Conversation metadata pages without building timelines or resuming an Agent.
mod native;
#[cfg(test)]
mod tests;
use super::*;
use serde::Deserialize;
use std::{
    fs::File,
    io::BufReader,
    time::{Duration, Instant},
};

#[derive(Default)]
pub(super) struct Cache {
    sampled: Option<Instant>,
    rows: Vec<Value>,
    clocks: HashMap<PathBuf, activity::TurnClock>,
    native_index: native::Index,
    native_sessions: Vec<native::Session>,
}

// Deserialize metadata from the reader without retaining tracking/output payloads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskMetadata {
    task_id: String,
    agent: String,
    title: Option<String>,
    cwd: Option<String>,
    created_at: String,
    updated_at: Option<String>,
    session_id: Option<String>,
    status: Option<String>,
    #[serde(default)]
    metadata: Value,
    #[serde(default)]
    last_message: Value,
    #[serde(default)]
    tracking: Option<TrackingMetadata>,
    #[serde(default)]
    archived: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct TrackingMetadata {
    turn: String,
    turn_dispatch_summaries: HashMap<String, Value>,
    turn_statuses: HashMap<String, String>,
    entries: Vec<TurnMetadata>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnMetadata {
    turn_id: Option<String>,
}

fn stored() -> Result<Vec<Value>> {
    let directory = root().join("agents/tasks");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut rows = Vec::new();
    for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let file = File::open(&path).map_err(|e| e.to_string())?;
        let task: TaskMetadata =
            serde_json::from_reader(BufReader::new(file)).map_err(|e| e.to_string())?;
        if task.archived {
            continue;
        }
        let tracking = task.tracking.unwrap_or_default();
        let summaries = crate::task_tracking::dispatch_summaries(
            &task.task_id,
            &tracking.turn_dispatch_summaries,
        );
        let summary = summaries.get(&tracking.turn).cloned().or_else(|| activity::agent_summary(
            &json!({"agent":task.agent,"metadata":task.metadata,"lastMessage":task.last_message})
        ));
        let mut turns: HashSet<&str> = tracking
            .entries
            .iter()
            .filter_map(|entry| entry.turn_id.as_deref())
            .collect();
        turns.extend(tracking.turn_statuses.keys().map(String::as_str));
        turns.extend(summaries.keys().map(String::as_str));
        turns.insert(&tracking.turn);
        turns.remove("");
        rows.push(
            json!({"agent":task.agent,"id":task.task_id,"title":task.title,"project":task.cwd,
            "createdAt":task.created_at,"updatedAt":task.updated_at.as_ref().unwrap_or(&task.created_at),"nativeSessionId":task.session_id,"source":"arc-task","status":task.status,"dispatchSummary":summary,"turnCount":turns.len()}),
        );
    }
    Ok(rows)
}

pub(super) fn merge(mut tasks: Vec<Value>, sessions: &[Value]) -> Vec<Value> {
    let native: HashMap<_, _> = sessions
        .iter()
        .map(|row| ((string(row, "agent"), string(row, "id")), row))
        .collect();
    // If several task records reference one native session, retain the newest task.
    tasks.sort_by(|a, b| {
        string(b, "createdAt")
            .cmp(string(a, "createdAt"))
            .then_with(|| string(a, "id").cmp(string(b, "id")))
    });
    let mut claimed = HashSet::new();
    tasks.retain_mut(|task| {
        let key = (
            string(task, "agent").to_owned(),
            string(task, "nativeSessionId").to_owned(),
        );
        if key.1.is_empty() {
            return true;
        }
        if let Some(row) = native.get(&(key.0.as_str(), key.1.as_str())) {
            if !claimed.insert(key.clone()) {
                return false;
            }
            for field in [
                "updatedAt",
                "preview",
                "messageCount",
                "metadataPartial",
                "agentAccountId",
            ] {
                if let Some(value) = row.get(field) {
                    task[field] = value.clone()
                }
            }
        }
        true
    });
    tasks.extend(
        sessions
            .iter()
            .filter(|row| {
                !claimed.contains(&(
                    string(row, "agent").to_owned(),
                    string(row, "id").to_owned(),
                ))
            })
            .cloned(),
    );
    for row in &mut tasks {
        if let Some(at) = row["updatedAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        {
            row["updatedAt"] = json!(at
                .with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        }
    }
    tasks.sort_by(|a, b| {
        string(b, "updatedAt")
            .cmp(string(a, "updatedAt"))
            .then_with(|| string(a, "id").cmp(string(b, "id")))
    });
    tasks
}

impl Cache {
    pub(super) fn invalidate(&mut self) {
        self.sampled = None;
    }
    async fn refresh(&mut self) -> Result<()> {
        if self
            .sampled
            .is_some_and(|at| at.elapsed() < Duration::from_secs(30))
        {
            return Ok(());
        }
        let mut index = std::mem::take(&mut self.native_index);
        let (result, index) = tokio::task::spawn_blocking(move || {
            let sessions = index.scan(&native::roots());
            let result = archive::hidden_sessions().and_then(|hidden| {
                stored().map(|tasks| {
                    let rows: Vec<_> = sessions
                        .iter()
                        .filter(|session| {
                            !hidden.contains(&(
                                string(&session.row, "agent").to_owned(),
                                string(&session.row, "id").to_owned(),
                            ))
                        })
                        .map(|session| (*session.row).clone())
                        .collect();
                    (merge(tasks, &rows), sessions)
                })
            });
            (result, index)
        })
        .await
        .map_err(|e| e.to_string())?;
        self.native_index = index;
        let (rows, sessions) = result?;
        self.rows = rows;
        self.native_sessions = sessions;
        self.sampled = Some(Instant::now());
        Ok(())
    }
}

fn timestamp(value: &Value) -> Value {
    value
        .as_i64()
        .and_then(|seconds| chrono::DateTime::from_timestamp(seconds, 0))
        .map(|at| json!(at.to_rfc3339()))
        .unwrap_or_else(|| value.clone())
}

impl AgentHost {
    pub(crate) async fn conversations(
        &self,
        control: &Arc<control::Control>,
        args: &Value,
    ) -> Result<Value> {
        let agent = string(args, "agent");
        if !self.drivers.contains_key(agent) {
            return Err("UNKNOWN_AGENT: read agents.list for registered IDs".into());
        }
        let limit = num(args, "limit", 20).clamp(1, 50);
        if agent == "codex" {
            let mut params = json!({"archived":false,"limit":limit,"sortKey":"created_at","sortDirection":"desc"});
            if let Some(cursor) = args.get("cursor") {
                params["cursor"] = cursor.clone();
            }
            let page = control.request("thread/list", params, 15000).await?;
            let projects = crate::projects::catalog(control).await.unwrap_or_default();
            let rows = page["data"]
                .as_array()
                .ok_or("NATIVE_CONVERSATIONS_MISSING")?;
            let mut cache = self.conversations.lock().await;
            let mut clocks = std::mem::take(&mut cache.clocks);
            let native_rows = rows.clone();
            let (metadata, clocks) = tokio::task::spawn_blocking(move || {
                if clocks.len() + native_rows.len() > 128 {
                    clocks.clear();
                }
                let metadata: Vec<_> = native_rows
                    .iter()
                    .map(|row| {
                        let clock = clocks
                            .entry(PathBuf::from(string(row, "path")))
                            .or_default();
                        activity::conversation_metadata(row, clock).unwrap_or(Value::Null)
                    })
                    .collect();
                (metadata, clocks)
            })
            .await
            .map_err(|e| e.to_string())?;
            cache.clocks = clocks;
            drop(cache);
            let data: Vec<_> = rows.iter().zip(metadata).map(|(row, metadata)| {
                let title = row["name"].as_str().filter(|s| !s.is_empty()).unwrap_or_else(|| string(row, "preview"));
                let mut item = json!({"id":row["id"],"title":title.chars().take(240).collect::<String>(),
                    "project":row["cwd"],"projectName":crate::projects::display_name(&projects, string(row,"cwd"), row["projectId"].as_str()),
                    "createdAt":timestamp(&row["createdAt"]),"source":"codex-thread"});
                item["dispatchSummary"] = metadata["dispatchSummary"].clone();
                item["turnCount"] = metadata["turnCount"].clone();
                item["status"] = row["status"].as_str().or_else(|| row["status"]["type"].as_str()).map(|s| json!(s)).unwrap_or(Value::Null);
                if let Some(open) = self.task_navigation(agent, string(row, "id")) {
                    item["open"] = open;
                }
                item
            }).collect();
            return Ok(
                json!({"data":data,"nextCursor":page["nextCursor"],"scope":"native-unarchived"}),
            );
        }
        let projects = crate::projects::catalog(control).await.unwrap_or_default();
        let mut cache = self.conversations.lock().await;
        cache.refresh().await?;
        let cursor: Option<(String, String)> = args["cursor"]
            .as_str()
            .map(|cursor| {
                serde_json::from_str(cursor).map_err(|_| "INVALID_CONVERSATION_CURSOR".to_owned())
            })
            .transpose()?;
        let mut rows = cache
            .rows
            .iter()
            .filter(|row| {
                row["agent"] == agent
                    && cursor.as_ref().is_none_or(|(updated, id)| {
                        string(row, "updatedAt") < updated.as_str()
                            || (string(row, "updatedAt") == updated
                                && string(row, "id") > id.as_str())
                    })
            })
            .take(limit + 1)
            .cloned()
            .collect::<Vec<_>>();
        let more = rows.len() > limit;
        rows.truncate(limit);
        let next = if more {
            rows.last()
                .map(|row| json!([row["updatedAt"], row["id"]]).to_string())
        } else {
            None
        };
        for row in &mut rows {
            row["projectName"] = json!(crate::projects::display_name(
                &projects,
                string(row, "project"),
                None
            ));
        }
        let scope = if matches!(agent, "claude" | "pi") {
            "native-and-arc-tasks"
        } else {
            "arc-tasks"
        };
        Ok(json!({"data":rows,"nextCursor":next,"scope":scope}))
    }

    pub(crate) async fn conversation_timeline(
        &self,
        control: &control::Control,
        args: &Value,
    ) -> Result<Value> {
        let agent = string(args, "agent");
        let session = string(args, "id");
        uuid::Uuid::parse_str(session).map_err(|_| "INVALID_SESSION_ID")?;
        if agent == "codex" {
            let known = control.events.lock().await.timelines.contains_key(session)
                || control
                    .task_records()
                    .await?
                    .iter()
                    .any(|r| r["threadId"] == session || r["task"]["threadId"] == session);
            let mut timeline = if known {
                control
                    .timeline(session, num(args, "after", 0) as u64)
                    .await
            } else {
                control.external_timeline(session).await
            }?;
            timeline["srcConversation"] = crate::src_conversations::task_ref(agent, session)?;
            return Ok(timeline);
        }
        if matches!(agent, "claude" | "pi") && !task_path(session)?.exists() {
            let mut cache = self.conversations.lock().await;
            cache.refresh().await?;
            let external = cache
                .native_sessions
                .iter()
                .find(|s| s.row["agent"] == agent && s.row["id"] == session)
                .cloned();
            drop(cache);
            if let Some(external) = external {
                // No process, activity subscription, task record or live timeline is registered.
                return tokio::task::spawn_blocking(move || native::timeline(&external))
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        let task = self.task(agent, session).await?;
        let mut timeline = self
            .timeline(control, session, num(args, "after", 0) as u64)
            .await?;
        timeline["status"] = task["status"].clone();
        timeline["srcConversation"] = task["srcConversation"].clone();
        if task["processState"] == "stopped" {
            timeline["readOnly"] = json!(true);
        }
        Ok(timeline)
    }
}
