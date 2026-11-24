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
    clocks: HashMap<PathBuf, activity::ConversationMetadata>,
    native_index: native::Index,
    native_sessions: Vec<native::Session>,
}

// Deserialize metadata from the reader without retaining tracking/output payloads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskMetadata {
    task_id: String,
    agent: String,
    #[serde(default)]
    agent_account_id: Value,
    title: Option<String>,
    cwd: Option<String>,
    created_at: String,
    updated_at: Option<String>,
    session_id: Option<String>,
    status: Option<String>,
    #[serde(default)]
    turn_id: Value,
    #[serde(default, rename = "_turnLifecycle")]
    lifecycle: Value,
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
        let mut projection = json!({"agent":task.agent,"taskId":task.task_id,"turnId":task.turn_id,"status":task.status,"_turnLifecycle":task.lifecycle});
        lifecycle::loss(&mut projection);
        rows.push(
            json!({"agent":task.agent,"agentAccountId":task.agent_account_id,"id":task.task_id,"title":task.title,"project":task.cwd,
            "createdAt":task.created_at,"updatedAt":task.updated_at.as_ref().unwrap_or(&task.created_at),"nativeSessionId":task.session_id,"source":"arc-task","status":projection["status"],"dispatchSummary":summary,"turnCount":turns.len()}),
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
            for field in ["updatedAt", "preview", "messageCount", "metadataPartial"] {
                if let Some(value) = row.get(field) {
                    task[field] = value.clone()
                }
            }
            if row["relationKind"] == "subagent" {
                task["relationKind"] = row["relationKind"].clone();
                task["parentSessionId"] = row["parentSessionId"].clone();
            }
            if row["agent"] == "antigravity" {
                for field in [
                    "title",
                    "project",
                    "turnCount",
                    "turnStartedAt",
                    "turnEndedAt",
                    "turnDurationMs",
                    "agentName",
                    "nativeStatus",
                ] {
                    if !row[field].is_null() && row[field] != "" {
                        task[field] = row[field].clone();
                    }
                }
                if let Some(native) = row["dispatchSummary"].as_object() {
                    let summary = &mut task["dispatchSummary"];
                    if let Some(stored) = summary.as_object_mut() {
                        stored.extend(native.clone());
                    } else {
                        *summary = Value::Object(native.clone());
                    }
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
            if let Some(home) = dirs::home_dir() {
                index
                    .refresh_summaries(&home.join(".gemini/antigravity/conversation_summaries.db"));
            }
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

type ConversationKey = (std::cmp::Reverse<Option<(i64, u32)>>, String, String);

fn conversation_time(row: &Value, field: &str) -> Option<(i64, u32)> {
    row[field]
        .as_str()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|at| (at.timestamp(), at.timestamp_subsec_nanos()))
}

fn conversation_key(row: &Value, field: &str) -> ConversationKey {
    (
        std::cmp::Reverse(conversation_time(row, field)),
        string(row, "agent").into(),
        string(row, "id").into(),
    )
}

#[derive(Deserialize, serde::Serialize)]
struct ConversationCursor {
    codex: Option<CodexCursor>,
    local: Option<ConversationKey>,
}

#[derive(Default, Deserialize, serde::Serialize)]
struct CodexCursor {
    cursor: Option<String>,
    consumed: usize,
}

fn conversation_page(
    mut local: Vec<Value>,
    upstream: Option<(Vec<Value>, Option<String>)>,
    cursor: &mut ConversationCursor,
    limit: usize,
    field: &str,
) -> (Vec<Value>, Option<String>) {
    local.sort_by_cached_key(|row| conversation_key(row, field));
    let mut local = local.into_iter().peekable();
    let (mut codex, next) = upstream.unwrap_or_default();
    // Preserve Codex's tie order across its opaque page boundaries.
    codex.sort_by_cached_key(|row| std::cmp::Reverse(conversation_time(row, field)));
    let mut codex = codex
        .into_iter()
        .skip(cursor.codex.as_ref().map_or(0, |c| c.consumed))
        .peekable();
    let mut rows = Vec::with_capacity(limit);
    while rows.len() < limit {
        let use_codex = match (local.peek(), codex.peek()) {
            (Some(local), Some(codex)) => {
                conversation_time(codex, field) >= conversation_time(local, field)
            }
            (None, Some(_)) => true,
            (Some(_), None) if next.is_none() => false,
            _ => break,
        };
        if use_codex {
            if let Some(position) = cursor.codex.as_mut() {
                position.consumed += 1;
            }
            rows.extend(codex.next());
        } else if let Some(row) = local.next() {
            cursor.local = Some(conversation_key(&row, field));
            rows.push(row);
        }
    }
    if codex.peek().is_none() {
        cursor.codex = next.map(|next| CodexCursor {
            cursor: Some(next),
            consumed: 0,
        });
    }
    let next = (cursor.codex.is_some() || local.peek().is_some())
        .then(|| serde_json::to_string(cursor).expect("conversation cursor serializes"));
    (rows, next)
}

impl AgentHost {
    pub(crate) async fn conversations(
        &self,
        control: &Arc<control::Control>,
        args: &Value,
    ) -> Result<Value> {
        let agent = string(args, "agent");
        if !agent.is_empty() && !self.drivers.contains_key(agent) {
            return Err("UNKNOWN_AGENT: read agents.list for registered IDs".into());
        }
        let limit = num(args, "limit", 20).clamp(1, 50);
        let updated = args["sort"] == "updated";
        let subagents = args["includeSubagents"] == true;
        let projects = async {
            tokio::time::timeout(Duration::from_secs(3), crate::projects::catalog(control))
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default()
        };
        if agent == "codex" && args["agents"].is_null() {
            let projects = projects.await;
            let (data, next) = self
                .codex_conversations(
                    control,
                    &projects,
                    limit,
                    args["cursor"].as_str(),
                    updated,
                    subagents,
                    60000,
                )
                .await?;
            return Ok(json!({"data":data,"nextCursor":next,"scope":"native-unarchived"}));
        }
        let selected = args["agents"].as_array();
        if selected.is_some_and(|ids| {
            ids.iter()
                .any(|id| id.as_str().is_none_or(|id| !self.drivers.contains_key(id)))
        }) {
            return Err("UNKNOWN_AGENT: read agents.list for registered IDs".into());
        }
        let disabled = self.disabled.lock().await.clone();
        let included: HashSet<_> = self
            .drivers
            .keys()
            .map(String::as_str)
            .filter(|id| {
                if let Some(ids) = selected {
                    ids.iter().any(|selected| selected.as_str() == Some(*id))
                        && agent_enabled(id, &disabled)
                } else if agent.is_empty() {
                    agent_enabled(id, &disabled)
                } else {
                    agent == *id
                }
            })
            .collect();
        let mut cursor: ConversationCursor = if let Some(cursor) = args["cursor"].as_str() {
            serde_json::from_str(cursor).map_err(|_| "INVALID_CONVERSATION_CURSOR")?
        } else {
            ConversationCursor {
                codex: included.contains("codex").then(CodexCursor::default),
                local: None,
            }
        };
        let field = if updated { "updatedAt" } else { "createdAt" };
        let local = async {
            let mut cache = self.conversations.lock().await;
            cache.refresh().await?;
            Ok::<_, String>(
                cache
                    .rows
                    .iter()
                    .filter(|row| {
                        included.contains(string(row, "agent"))
                            && (subagents || row["relationKind"] != "subagent")
                    })
                    .filter(|row| {
                        cursor
                            .local
                            .as_ref()
                            .is_none_or(|key| conversation_key(row, field) > *key)
                    })
                    .cloned()
                    .collect::<Vec<_>>(),
            )
        };
        let (local, projects) = tokio::join!(local, projects);
        let local = local?;
        let upstream =
            if let Some(codex) = cursor.codex.as_ref().filter(|_| included.contains("codex")) {
                self.codex_conversations(
                    control,
                    &projects,
                    50,
                    codex.cursor.as_deref(),
                    updated,
                    subagents,
                    3000,
                )
                .await
                .ok()
            } else {
                None
            };
        let (mut rows, next) = conversation_page(local, upstream, &mut cursor, limit, field);
        for row in rows
            .iter_mut()
            .filter(|row| row.get("projectName").is_none())
        {
            row["projectName"] = json!(crate::projects::display_name(
                &projects,
                string(row, "project"),
                None
            ));
        }
        let scope = if agent.is_empty()
            || included
                .iter()
                .any(|id| capabilities::for_agent(id).native_conversations)
        {
            "native-and-arc-tasks"
        } else {
            "arc-tasks"
        };
        Ok(json!({"data":rows,"nextCursor":next,"scope":scope}))
    }

    #[allow(clippy::too_many_arguments)]
    async fn codex_conversations(
        &self,
        control: &control::Control,
        projects: &[Value],
        limit: usize,
        cursor: Option<&str>,
        updated: bool,
        subagents: bool,
        timeout: u64,
    ) -> Result<(Vec<Value>, Option<String>)> {
        let sort_key = if updated { "updated_at" } else { "created_at" };
        let mut params =
            json!({"archived":false,"limit":limit,"sortKey":sort_key,"sortDirection":"desc"});
        if subagents {
            params["sourceKinds"] =
                json!(["cli", "vscode", "exec", "appServer", "subAgentThreadSpawn"]);
        }
        if let Some(cursor) = cursor {
            params["cursor"] = json!(cursor);
        }
        let page = tokio::time::timeout(
            Duration::from_millis(timeout),
            control.request("thread/list", params, timeout),
        )
        .await
        .map_err(|_| "NATIVE_CONVERSATIONS_TIMEOUT")??;
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
            let title = crate::task_tracking::codex_title(row).unwrap_or_else(|| string(row, "preview"));
            let mut item = json!({"agent":"codex","id":row["id"],"title":title.chars().take(240).collect::<String>(),
                "project":row["cwd"],"projectName":crate::projects::display_name(projects, string(row,"cwd"), row["projectId"].as_str()),
                "createdAt":timestamp(&row["createdAt"]),"updatedAt":timestamp(&row["updatedAt"]),
                "turnId":metadata["turnId"],"turnStartedAt":metadata["turnStartedAt"],"turnEndedAt":metadata["turnEndedAt"],
                "turnDurationMs":metadata["turnDurationMs"],
                "source":"codex-thread"});
            if let Some(parent) = row.pointer("/source/subAgent/thread_spawn/parent_thread_id").and_then(Value::as_str) {
                item["parentSessionId"] = json!(parent);
                item["relationKind"] = json!("subagent");
            } else if metadata["parentSessionId"].is_string() {
                item["parentSessionId"] = metadata["parentSessionId"].clone();
                item["relationKind"] = metadata["relationKind"].clone();
            }
            if let Some(preview) = row["preview"].as_str() {
                item["preview"] = json!(preview.chars().take(240).collect::<String>());
            }
            item["dispatchSummary"] = metadata["dispatchSummary"].clone();
            item["turnCount"] = metadata["turnCount"].clone();
            let native_status = row["status"].as_str().or_else(|| row["status"]["type"].as_str());
            item["runtimeStatus"] = native_status.map(|s| json!(s)).unwrap_or(Value::Null);
            let key = crate::turn_lifecycle::TurnKey::new("codex", string(row, "id"), metadata["turnId"].as_str().unwrap_or(""));
            let recorded = metadata["status"].as_str().unwrap_or("");
            let mut turn = crate::turn_lifecycle::Transition::new(key.clone());
            if let Some(evidence) = crate::turn_lifecycle::adapters::codex_terminal(key.clone(), recorded, None) {
                turn = crate::turn_lifecycle::advance(&turn, &evidence);
            }
            turn = crate::turn_lifecycle::advance(&turn, &crate::turn_lifecycle::adapters::codex_owner(key, Some(recorded), native_status.unwrap_or("unknown"), false, 0));
            item["status"] = json!(crate::turn_lifecycle::adapters::projection(&turn.state()));
            item["metadataPartial"] = metadata["metadataPartial"].clone();
            if let Some(open) = self.task_navigation("codex", string(row, "id")) {
                item["open"] = open;
            }
            item
        }).collect();
        Ok((data, page["nextCursor"].as_str().map(str::to_owned)))
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
            let recent = args["recent"] == true && args["after"].is_null();
            let external = self
                .activity
                .lock()
                .await
                .external(session)
                .filter(|external| external.agent == "codex");
            if recent {
                if let Some(external) = external.as_ref().cloned() {
                    let mut preview =
                        tokio::task::spawn_blocking(crate::runtime_metrics::cost::blocking(
                            move || activity::codex_preview(&external),
                        ))
                        .await
                        .map_err(|error| error.to_string())??;
                    preview["srcConversation"] =
                        crate::src_conversations::task_ref(agent, session)?;
                    return Ok(preview);
                }
            }
            let known = control.events.lock().await.timelines.contains_key(session)
                || control
                    .task_records()
                    .await?
                    .iter()
                    .any(|r| r["threadId"] == session || r["task"]["threadId"] == session);
            let preview = if recent {
                control
                    .recent_timeline(session, known)
                    .await
                    .unwrap_or(None)
            } else {
                None
            };
            let mut timeline = if let Some(preview) = preview {
                preview
            } else if known {
                control
                    .timeline(session, num(args, "after", 0) as u64)
                    .await?
            } else if let Some(external) = external {
                tokio::task::spawn_blocking(crate::runtime_metrics::cost::blocking(move || {
                    activity::codex_transcript_timeline(&external)
                }))
                .await
                .map_err(|error| error.to_string())??
            } else {
                control.external_timeline(session).await?
            };
            timeline["srcConversation"] = crate::src_conversations::task_ref(agent, session)?;
            return Ok(timeline);
        }
        if capabilities::for_agent(agent).native_conversations && !task_path(session)?.exists() {
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
        if task["runtimeSource"] == "antigravity-agentapi" {
            let mut cache = self.conversations.lock().await;
            cache.refresh().await?;
            let external = cache
                .native_sessions
                .iter()
                .find(|s| s.row["agent"] == agent && s.row["id"] == task["sessionId"])
                .cloned();
            drop(cache);
            if let Some(external) = external {
                return tokio::task::spawn_blocking(move || native::timeline(&external))
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        let mut timeline = self
            .timeline(control, session, num(args, "after", 0) as u64)
            .await?;
        timeline["status"] = json!(crate::turn_lifecycle::adapters::projection(
            &lifecycle::read(&task).state()
        ));
        timeline["srcConversation"] = task["srcConversation"].clone();
        if task["processState"] == "stopped" {
            timeline["readOnly"] = json!(true);
        }
        Ok(timeline)
    }
}
