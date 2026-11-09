//! Bounded live enrichment of a native task page; never resumes tasks on reads.
use crate::*;
use std::collections::HashMap;
use tokio::time::{timeout_at, Duration, Instant};

pub(crate) fn list_records(
    codex: &[Value],
    agents: &[Value],
    host: &crate::agents::AgentHost,
) -> Vec<Value> {
    let mut records = Vec::with_capacity(codex.len() + agents.len());
    records.extend(codex.iter().chain(agents).cloned());
    for record in &mut records {
        let agent = record["agent"].as_str().unwrap_or("codex");
        let task = record["taskId"]
            .as_str()
            .or(record["threadId"].as_str())
            .or(record["task"]["threadId"].as_str())
            .unwrap_or("");
        if let Some(open) = host.task_navigation(agent, task) {
            record["open"] = open;
        }
    }
    records.sort_by(|a, b| {
        string(b, "createdAt")
            .cmp(string(a, "createdAt"))
            .then_with(|| string(a, "requestId").cmp(string(b, "requestId")))
    });
    records
}

#[derive(Default)]
pub(crate) struct Feed {
    inputs: Option<FeedInputs>,
    revision: String,
    records: Value,
    previous: Option<(String, Value)>,
}

struct FeedInputs {
    codex: Arc<Vec<Value>>,
    agents: Arc<Vec<Value>>,
    sources: Vec<Value>,
    accounts: Option<Arc<Value>>,
    desktop: bool,
}

impl FeedInputs {
    fn same(&self, next: &Self) -> bool {
        Arc::ptr_eq(&self.codex, &next.codex)
            && (Arc::ptr_eq(&self.agents, &next.agents)
                || (self.agents.is_empty() && next.agents.is_empty()))
            && self.sources == next.sources
            && match (&self.accounts, &next.accounts) {
                (None, None) => true,
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                _ => false,
            }
            && self.desktop == next.desktop
    }
}

impl Feed {
    pub(crate) fn read(
        &mut self,
        codex: Arc<Vec<Value>>,
        agents: Arc<Vec<Value>>,
        host: &crate::agents::AgentHost,
        revision: Option<&str>,
    ) -> Value {
        let inputs = FeedInputs {
            codex,
            agents,
            sources: crate::sources::labels(),
            accounts: crate::accounts::label_snapshot(),
            desktop: !cfg!(target_os = "linux") && crate::desktop::installation().is_some(),
        };
        if self.inputs.as_ref().is_none_or(|old| !old.same(&inputs)) {
            let mut next = json!(list_records(&inputs.codex, &inputs.agents, host));
            crate::sources::decorate_labels(&mut next, &inputs.sources);
            if let Some(accounts) = inputs.accounts.as_deref().and_then(Value::as_array) {
                crate::accounts::decorate_labels(&mut next, accounts);
            }
            if next != self.records {
                let previous = std::mem::replace(&mut self.revision, id());
                self.previous = self.records.as_array().and_then(|old| {
                    let mut old: HashMap<_, _> = old
                        .iter()
                        .map(|row| (string(row, "requestId"), row))
                        .collect();
                    let records: Vec<_> = next
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|row| old.remove(string(row, "requestId")) != Some(*row))
                        .collect();
                    let mut removed: Vec<_> = old.into_keys().collect();
                    removed.sort_unstable();
                    if records.len() + removed.len() > 256 {
                        return None;
                    }
                    Some((
                        previous,
                        json!({"revision":self.revision,"records":records,"removed":removed}),
                    ))
                });
                self.records = next;
            }
            self.inputs = Some(inputs);
        }
        if revision == Some(self.revision.as_str()) {
            return json!({"revision":self.revision});
        }
        if let Some((_, delta)) = self
            .previous
            .as_ref()
            .filter(|(previous, _)| revision == Some(previous.as_str()))
        {
            return delta.clone();
        }
        json!({"revision":self.revision,"records":self.records})
    }
}

/// List rows carry display metadata. Prompts, attachments and receipt evidence
/// remain with their owners and are read through the selected task's timeline.
pub(crate) fn display_record(record: &Value) -> Value {
    fn fields(value: &Value, names: &[&str]) -> Value {
        Value::Object(
            names
                .iter()
                .filter_map(|name| value.get(*name).map(|v| ((*name).to_owned(), v.clone())))
                .collect(),
        )
    }
    let mut row = fields(
        record,
        &[
            "requestId",
            "agent",
            "agentAccountId",
            "taskId",
            "threadId",
            "turnId",
            "origin",
            "state",
            "createdAt",
            "updatedAt",
            "approval",
            "executionOwner",
            "open",
            "error",
        ],
    );
    if record["runtime"].is_object() {
        row["runtime"] = fields(
            &record["runtime"],
            &[
                "runtimeStatus",
                "title",
                "project",
                "observedAt",
                "stale",
                "archived",
            ],
        );
        if record["runtime"]["ownership"].is_object() {
            row["runtime"]["ownership"] = fields(
                &record["runtime"]["ownership"],
                &["owner", "currentOwner", "state", "observedAt"],
            );
        }
    }
    let task = &record["task"];
    row["task"] = fields(
        task,
        &[
            "origin",
            "agentAccountId",
            "detailsRecorded",
            "kind",
            "title",
            "project",
            "directory",
            "threadId",
            "model",
            "effort",
        ],
    );
    let prompt = string(task, "prompt");
    let preview: String = prompt
        .lines()
        .next()
        .unwrap_or("")
        .chars()
        .take(256)
        .collect();
    row["task"]["promptTruncated"] = json!(preview != prompt);
    row["task"]["prompt"] = json!(preview);
    row
}
pub(crate) async fn list(c: &Arc<control::Control>, args: &Value) -> Result<Value> {
    let full = args["view"] == "full";
    let enrich = args["enrich"].as_bool().unwrap_or(args["archived"] != true);
    let mut params = args.clone();
    params.as_object_mut().unwrap().remove("project");
    params.as_object_mut().unwrap().remove("view");
    params.as_object_mut().unwrap().remove("enrich");
    params["sortKey"] = json!("updated_at");
    params["sortDirection"] = json!("desc");
    if params.get("limit").is_none() {
        params["limit"] = json!(20);
    }
    if let Some(p) = args["project"].as_str() {
        params["cwd"] = json!([crate::projects::resolve(c, p).await?["root"]]);
    }
    let indexed = if crate::accounts::codex::profiles()?.is_empty()
        && args["archived"] == true
        && !enrich
        && args["cursor"]
            .as_str()
            .is_none_or(|s| s.starts_with("archive-index:"))
    {
        let params = params.clone();
        tokio::task::spawn_blocking(move || crate::archive_index::list(&params))
            .await
            .map_err(|e| e.to_string())??
    } else {
        None
    };
    let page = match indexed {
        Some(page) => page,
        None => c.profile_task_page(params).await?,
    };
    let rows = page["data"].as_array().ok_or("NATIVE_TASKS_MISSING")?;
    if !enrich {
        let tasks: Vec<_> = rows.iter().map(|row| {
            let mut task = if full {control::summary(row)} else {json!({"threadId":row["id"],"title":row["name"],"project":row["cwd"],"updatedAt":row["updatedAt"]})};
            task["archived"] = args["archived"].clone();
            task["runtimeStatus"] = Value::Null;
            task["status"] = json!(if args["archived"] == true {"archived"} else {"not-observed"});
            task["runtimeSource"] = json!("not-requested");
            task["enriched"] = json!(false);
            task
        }).collect();
        return Ok(
            json!({"tasks":tasks,"nextCursor":page["nextCursor"],"enriched":false,"metadataSource":page["metadataSource"].as_str().unwrap_or("native-app-server"),"observedAt":now()}),
        );
    }
    let queues = crate::dispatch_queue::counts().await?;
    let deadline = Instant::now() + Duration::from_secs(8);
    let slots = Arc::new(tokio::sync::Semaphore::new(32));
    let mut jobs = tokio::task::JoinSet::new();
    for (index, row) in rows.iter().cloned().enumerate() {
        let c = c.clone();
        let slots = slots.clone();
        let queue = queues
            .get(string(&row, "id"))
            .cloned()
            .unwrap_or(json!({"pending":0,"blocked":0}));
        jobs.spawn(async move {
            let id=string(&row,"id");
            // History has no ownership side effects. Keep its latest turn even
            // when the Desktop owner probe cannot finish within the page budget.
            let recorded=timeout_at(deadline,async {
                let rpc=c.thread_rpc(id).await?;
                rpc.call("thread/turns/list",json!({"threadId":id,"limit":1,"sortDirection":"desc","itemsView":"notLoaded"}),3000).await
            }).await.ok().and_then(Result::ok).and_then(|p|p["data"].as_array().and_then(|a|a.first()).cloned()).unwrap_or(Value::Null);
            let read=timeout_at(deadline, async {
                let _permit=slots.acquire().await.map_err(|e|e.to_string())?;
                let metadata=c.request("thread/read",json!({"threadId":id,"includeTurns":false}),5000).await?;
                let turns=c.request("thread/turns/list",json!({"threadId":id,"limit":1,"sortDirection":"desc","itemsView":"notLoaded"}),5000).await?;
                let turns=turns["data"].as_array().ok_or("NATIVE_TURNS_MISSING")?;
                Ok::<_,String>((metadata["thread"].clone(),turns.first().cloned().unwrap_or(Value::Null)))
            }).await.map_err(|_|"live-status-timeout (8s page budget)".to_owned()).and_then(|r|r);
            let pending=c.events.lock().await.pending.values().any(|r|r["params"]["threadId"]==id);
            let (native,turn,error)=match read {
                Ok((t,turn)) if t["id"]==row["id"] => (t,turn,None),
                Ok(_) => (row.clone(),recorded.clone(),Some("native-thread-id-mismatch".to_owned())),
                Err(e) => (row.clone(),recorded,Some(e)),
            };
            let retry=crate::claude_notify::retry_status(id,string(&turn,"id")).unwrap_or(Value::Null);
            (index,compact(&row,&native,&turn,pending,&retry,&queue,error.as_deref(),full))
        });
    }
    let mut results = Vec::new();
    while let Some(r) = jobs.join_next().await {
        results.push(r.map_err(|e| e.to_string())?);
    }
    results.sort_by_key(|(i, _)| *i);
    Ok(
        json!({"observedAt":now(),"view":if full{"full"}else{"compact"},"tasks":results.into_iter().map(|(_,v)|v).collect::<Vec<_>>(),"nextCursor":page["nextCursor"]}),
    )
}
fn compact(
    row: &Value,
    t: &Value,
    turn: &Value,
    pending: bool,
    retry: &Value,
    queue: &Value,
    error: Option<&str>,
    full: bool,
) -> Value {
    let runtime = string(&t["status"], "type");
    let flags = &t["status"]["activeFlags"];
    let waiting = pending
        || flags.as_array().is_some_and(|fs| {
            fs.iter()
                .any(|f| matches!(f.as_str(), Some("waitingOnApproval" | "waitingOnUserInput")))
        });
    let retrying = matches!(string(retry, "status"), "scheduled" | "submitting");
    let (status, reason) = if error.is_some() {
        ("unconfirmed", error.unwrap())
    } else if waiting {
        ("needs-input", "")
    } else if retrying {
        ("retrying", "")
    } else if runtime == "active" {
        ("running", "")
    } else if runtime == "notLoaded" || runtime.is_empty() || runtime == "unknown" {
        ("unconfirmed","persisted-history-only: no live owner confirmed; recorded turn is not proof of current runtime")
    } else if runtime == "systemError" || turn["status"] == "failed" {
        ("failed", "")
    } else if runtime != "idle" {
        ("unconfirmed", "unsupported-native-runtime-status")
    } else if turn["status"] == "inProgress" {
        (
            "unconfirmed",
            "native runtime idle but latest turn still in progress",
        )
    } else if queue["pending"].as_u64().unwrap_or(0) > 0 {
        (
            "queued",
            if queue["blocked"].as_u64().unwrap_or(0) > 0 {
                "queue paused after failure or interruption"
            } else {
                ""
            },
        )
    } else {
        ("idle", "")
    };
    let turn_model = turn
        .get("model")
        .filter(|v| v.as_str().is_some_and(|s| !s.is_empty() && s != "unknown"));
    let model = turn_model.or_else(|| {
        t.get("model")
            .filter(|v| v.as_str().is_some_and(|s| !s.is_empty() && s != "unknown"))
    });
    let title = t
        .get("name")
        .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
        .or_else(|| row.get("name"));
    let mut out = if full {
        crate::control::summary(t)
    } else {
        json!({})
    };
    out["title"] = title.cloned().unwrap_or(Value::Null);
    out["threadId"] = row["id"].clone();
    out["origin"] = crate::sources::task_origin(string(row, "id"), None);
    out["srcConversation"] =
        crate::src_conversations::task_ref("codex", string(row, "id")).unwrap_or(Value::Null);
    out["agentAccountId"] = json!(crate::accounts::codex_dispatch_account(
        &crate::dispatch_policy::records(string(row, "id")).unwrap_or_default(),
        turn["id"].as_str(),
        &row["agentAccountId"],
    ));
    out["project"] = t["cwd"].clone();
    out["status"] = json!(status);
    out["updatedAt"] = t.get("updatedAt").unwrap_or(&row["updatedAt"]).clone();
    out["currentTurn"] = if turn.is_null() {
        Value::Null
    } else {
        json!({"turnId":turn["id"],"status":turn["status"],"source":if error.is_some() || runtime=="notLoaded" {"persisted-history"}else{"native-owner"}})
    };
    out["model"] = model.cloned().unwrap_or(Value::Null);
    out["modelSource"] = json!(if model.is_none() {
        "not-reported-by-owner"
    } else if turn_model.is_some() {
        "latest-turn"
    } else {
        "thread-settings"
    });
    if !reason.is_empty() {
        out["statusReason"] = json!(reason);
    }
    if queue["pending"].as_u64().unwrap_or(0) > 0 {
        out["queue"] = queue.clone();
    }
    if retrying {
        out["retry"] = retry.clone();
    }
    if full {
        out["preview"] = row["preview"].clone();
        out["reviews"] = crate::dispatch_policy::reviews(string(row, "id"))
            .map(|rows| json!(rows))
            .unwrap_or_else(|error| json!({"unavailable":error}));
        out["dispatches"] = crate::dispatch_policy::records(string(row, "id"))
            .map(|rows| json!(rows))
            .unwrap_or_else(|error| json!({"unavailable":error}));
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn statuses_are_evidence_based_and_compact_does_not_copy_prompts() {
        // Property: statuses are evidence based and compact does not copy prompts.
        let mut t = json!({"id":"t","name":"Title","cwd":"/project","preview":"large prompt","status":{"type":"active"},"model":"m"});
        let turn = json!({"id":"turn","status":"inProgress"});
        let q = json!({"pending":2,"blocked":0});
        let render = |t: &Value, turn: &Value, pending, retry: &Value, error, full| {
            compact(t, t, turn, pending, retry, &q, error, full)
        };
        let v = render(&t, &turn, false, &Value::Null, None, false);
        assert_eq!(v["status"], "running");
        assert!(v.get("preview").is_none());
        assert_eq!(v["queue"]["pending"], 2);
        assert_eq!(
            render(&t, &turn, true, &Value::Null, None, false)["status"],
            "needs-input"
        );
        t["status"]["type"] = json!("idle");
        let done = json!({"id":"turn","status":"completed"});
        assert_eq!(
            render(&t, &done, false, &Value::Null, None, false)["status"],
            "queued"
        );
        assert_eq!(
            render(
                &t,
                &done,
                false,
                &json!({"status":"scheduled"}),
                None,
                false
            )["status"],
            "retrying"
        );
        assert_eq!(
            render(
                &t,
                &json!({"id":"turn","status":"failed"}),
                false,
                &Value::Null,
                None,
                false
            )["status"],
            "failed"
        );
        assert_eq!(
            compact(
                &t,
                &t,
                &done,
                false,
                &Value::Null,
                &json!({"pending":0}),
                None,
                false
            )["status"],
            "idle"
        );
        assert_eq!(
            render(&t, &turn, false, &Value::Null, None, false)["status"],
            "unconfirmed"
        );
        t["status"]["type"] = json!("notLoaded");
        let v = render(&t, &done, false, &Value::Null, None, false);
        assert_eq!(v["status"], "unconfirmed");
        assert!(v["statusReason"]
            .as_str()
            .unwrap()
            .contains("no live owner"));
        assert_eq!(
            render(&t, &done, false, &Value::Null, Some("timeout"), true)["preview"],
            "large prompt"
        );
    }
}
