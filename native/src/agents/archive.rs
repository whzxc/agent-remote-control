//! Local archival retains upstream sessions, transcripts and readable task evidence.
use super::*;

pub(super) fn ensure_unarchived(task: &Value) -> Result<()> {
    if task["archived"] == true {
        return Err(json!({"code":"TASK_ARCHIVED","message":"This task is archived. Use agent_read for retained evidence or agent_create for new work.","next":{"via":"query","op":"agent_read","args":{"agent":task["agent"],"taskId":task["taskId"]}}}).to_string());
    }
    Ok(())
}

// A create receipt can precede its task record. Preserve that wait path while
// rejecting archived records before probing a stopped process.
pub(super) fn ensure_observable(agent: &str, task: &str) -> Result<()> {
    let path = task_path(task)?;
    if path.exists() {
        let snapshot = crate::kernel::file_cache::load(&path)?;
        if snapshot["agent"] != agent {
            return Err("AGENT_TASK_MISMATCH".into());
        }
        ensure_unarchived(&snapshot)?;
    }
    Ok(())
}

fn active_error(agent: &str, task: &str, pending: bool) -> String {
    json!({"code":"ARCHIVE_ACTIVE_TURN",
        "message":if pending {"The task has a pending interaction. Use agent_pending, then agent_respond with the user's decision before archiving."} else {"The task has an active or unconfirmed turn/dispatch. Wait for completion or use agent_interrupt explicitly, then read the task before archiving."},
        "next":{"via":"query","op":if pending {"agent_pending"} else {"agent_read"},"args":{"agent":agent,"taskId":task}}}).to_string()
}

impl AgentHost {
    pub(super) async fn archive(&self, agent: &str, task: &str) -> Result<Value> {
        // Serialize against process creation/resume; the dispatch lock also fences
        // sends that already obtained this process before archive took lifecycle.
        let _lifecycle = self.lifecycle.lock().await;
        let snapshot = self.task(agent, task).await?;
        let process = self.processes.lock().await.get(task).cloned();
        let _dispatch = if let Some(p) = &process {
            let pending = !p.events.lock().await.pending.is_empty();
            if pending {
                return Err(active_error(agent, task, true));
            }
            Some(
                p.dispatch
                    .try_lock()
                    .map_err(|_| active_error(agent, task, false))?,
            )
        } else {
            None
        };
        // Re-read after taking dispatch: a just-completed send may have changed state.
        let current = self.task(agent, task).await?;
        if current["archived"] != true
            && !matches!(
                string(&current, "status"),
                "idle" | "completed" | "failed" | "cancelled"
            )
        {
            return Err(active_error(
                agent,
                task,
                current["status"] == "waiting-permission",
            ));
        }
        if let Some(p) = &process {
            p.close().await;
        }
        // close joins the output reader and flushes its final state. Never overwrite
        // that evidence with the snapshot taken before close.
        let mut archived = if let Some(p) = &process {
            p.state.lock().await.clone()
        } else {
            load(&task_path(task)?)?
        };
        archived["archived"] = json!(true);
        archived["processState"] = json!("stopped");
        if archived["archivedAt"].is_null() {
            archived["archivedAt"] = json!(now());
            archived["updatedAt"] = archived["archivedAt"].clone();
        }
        save_task(&archived)?;
        if let Some(p) = &process {
            *p.state.lock().await = archived;
        }
        self.processes.lock().await.remove(task);
        self.conversations.lock().await.invalidate();
        crate::claude_notify::ownership::end_scope(task, "task-archived").await?;
        self.wake.notify_waiters();
        Ok(
            json!({"agent":agent,"taskId":task,"archived":true,"alreadyArchived":snapshot["archived"] == true}),
        )
    }
}

/// Hide a locally archived task's native projection without mutating upstream data.
pub(super) fn hidden_sessions() -> Result<HashSet<(String, String)>> {
    let directory = root().join("agents/tasks");
    let mut hidden = HashSet::new();
    if !directory.exists() {
        return Ok(hidden);
    }
    for entry in crate::kernel::file_cache::entries(&directory)?.iter() {
        if entry.path.extension().is_none_or(|s| s != "json") {
            continue;
        }
        let task = crate::kernel::file_cache::load(&entry.path)?;
        if task["archived"] == true && !string(&task, "sessionId").is_empty() {
            hidden.insert((
                string(&task, "agent").into(),
                string(&task, "sessionId").into(),
            ));
        }
    }
    Ok(hidden)
}
