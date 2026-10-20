//! Bounded live enrichment of a native task page; never resumes tasks on reads.
use crate::*;
use tokio::time::{timeout_at, Duration, Instant};
pub(crate) async fn list(c: &Arc<control::Control>, args: &Value) -> Result<Value> {
    let full = args["view"] == "full";
    let mut params = args.clone();
    params.as_object_mut().unwrap().remove("project");
    params.as_object_mut().unwrap().remove("view");
    params["sortKey"] = json!("updated_at");
    params["sortDirection"] = json!("desc");
    if params.get("limit").is_none() {
        params["limit"] = json!(20);
    }
    if let Some(p) = args["project"].as_str() {
        params["cwd"] = json!([crate::projects::resolve(c, p).await?["root"]]);
    }
    let page = c.request("thread/list", params, 60000).await?;
    let rows = page["data"].as_array().ok_or("NATIVE_TASKS_MISSING")?;
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
                let rpc=c.utility().await?;
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
