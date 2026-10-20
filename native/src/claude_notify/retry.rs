//! Capacity-only continuation. Never replay the failed turn's original input or tools.
use super::*;
const CONTINUE: &str = "ARC 自动恢复：上一轮因模型容量暂时不足而结束。请在同一任务历史中从中断处继续；先核对已有结果、文件、提交和外部操作，跳过已经完成的步骤，不要重新执行已成功或结果不确定的副作用。不要重做原始任务；若无法确认某一步是否完成，先报告不确定性。";
fn safe_turn(turn: &Value) -> bool {
    turn["status"] == "failed"
        && turn["error"]["codexErrorInfo"] == "serverOverloaded"
        && turn["items"].as_array().is_some_and(|items| {
            items.iter().all(|i| {
                matches!(
                    string(i, "type"),
                    "userMessage" | "agentMessage" | "reasoning"
                )
            })
        })
}
fn delay(settings: &Value, attempt: u64) -> i64 {
    (settings["codexRetryInitialSeconds"]
        .as_u64()
        .unwrap_or(30)
        .clamp(1, 3600)
        .saturating_mul(1u64 << attempt.saturating_sub(1).min(10)))
    .min(3600) as i64
}
pub(super) async fn update(b: &mut Binding, retry: Value, terminal: bool) -> Result<()> {
    let _guard = LOCK.lock().await;
    let Some(mut current) = binding(&directory(), &b.thread_id, &b.turn_id)? else {
        return Err("RETRY_BINDING_MISSING".into());
    };
    current.retry = retry;
    if terminal {
        current.terminal = true;
        current.continuation_bound = true;
        current.waiting.clear();
    }
    persist(&directory(), &current)?;
    *b = current;
    Ok(())
}
pub(super) async fn handle(
    control: &Arc<control::Control>,
    b: &mut Binding,
    observed: &Value,
) -> Result<bool> {
    if observed["state"] != "failed"
        || (!b.agent.is_empty() && b.agent != "codex")
        || observed["error"]["codexErrorInfo"] != "serverOverloaded"
    {
        return Ok(false);
    }
    let mut retry = if b.retry.is_object() {
        b.retry.clone()
    } else {
        json!({})
    };
    if observed["nextTurnId"].is_string() && retry["status"] != "submitting" {
        if b.retry["status"] == "continued" {
            return Ok(true);
        }
        // Native continuation wins over a scheduled ARC retry, even after a restart.
        // An in-flight ARC submission must first resolve its durable receipt: the
        // visible successor may be its own accepted turn.
        // Let process publish the old failure and adopt only proven native retries.
        retry["status"] = json!("superseded");
        update(b, retry, false).await?;
        return Ok(false);
    }
    if matches!(
        string(&retry, "status"),
        "exhausted" | "skipped" | "stopped" | "superseded"
    ) {
        return Ok(false);
    }
    let settings = settings()?;
    if retry["status"] == "scheduled"
        && retry["nextAttempt"].as_u64().unwrap_or(0)
            > settings["codexRetryMaxAttempts"].as_u64().unwrap_or(3)
    {
        retry["status"] = json!("stopped");
        retry["reason"] = json!("retry-budget-disabled-or-reduced");
        update(b, retry, false).await?;
        return Ok(false);
    }
    if !matches!(string(&retry, "status"), "scheduled" | "submitting") {
        let attempts = retry["attempts"].as_u64().unwrap_or(0);
        let max = settings["codexRetryMaxAttempts"]
            .as_u64()
            .unwrap_or(3)
            .min(10);
        if attempts >= max {
            retry["status"] = json!("exhausted");
            update(b, retry, false).await?;
            return Ok(false);
        }
        if !retry["model"].is_string() {
            retry["status"] = json!("skipped");
            retry["reason"] = json!("model-not-confirmed");
            update(b, retry, false).await?;
            return Ok(false);
        }
        let page = control
            .request(
                "thread/turns/list",
                json!({"threadId":b.thread_id,"limit":1,"sortDirection":"desc","itemsView":"full"}),
                10000,
            )
            .await?;
        let turn = page["data"]
            .as_array()
            .and_then(|v| v.first())
            .ok_or("RETRY_HISTORY_UNAVAILABLE")?;
        if turn["id"] != b.turn_id {
            retry["status"] = json!("superseded");
            update(b, retry, false).await?;
            return Ok(false);
        }
        if !safe_turn(turn) {
            retry["status"] = json!("skipped");
            retry["reason"] = json!("tool-activity-or-incomplete-history");
            update(b, retry, false).await?;
            return Ok(false);
        }
        retry["nextAttempt"] = json!(attempts + 1);
        retry["requestId"] = json!(id());
        retry["notBefore"] = json!(chrono::Utc::now().timestamp() + delay(&settings, attempts + 1));
        retry["status"] = json!("scheduled");
        update(b, retry, false).await?;
        return Ok(true);
    }
    if chrono::Utc::now().timestamp() < retry["notBefore"].as_i64().unwrap_or(i64::MAX) {
        return Ok(true);
    }
    retry["status"] = json!("submitting");
    update(b, retry.clone(), false).await?;
    let mut args = json!({"threadId":b.thread_id,"prompt":CONTINUE,"model":retry["model"],"turn":retry["turn"],"requestId":retry["requestId"],"waitMs":0,"approval":"approved","_newTurn":true,"_expectedPreviousTurn":b.turn_id,"_retryAttempt":retry["nextAttempt"],"notify":if let Some(target)=&b.target {json!({"channel":b.channel,"target":target})}else{Value::Null}});
    if args["turn"].is_null() {
        args.as_object_mut().unwrap().remove("turn");
    }
    // Pin the actual model even when the original dispatch had a conflicting nested override.
    args["turn"]["model"] = retry["model"].clone();
    let origin = retry
        .get("origin")
        .cloned()
        .unwrap_or_else(|| json!({"ingressId":b.ingress}));
    let result = crate::kernel::origin::ORIGIN
        .scope(origin, control.mutate("send", args))
        .await;
    match result {
        Ok(r) if r["state"] == "completed" && r["turnId"].is_string() => {
            retry["status"] = json!("continued");
            retry["successorTurnId"] = r["turnId"].clone();
            update(b, retry, true).await?;
            Ok(true)
        }
        Ok(r)
            if matches!(
                string(&r, "state"),
                "pending" | "reserved" | "submitting" | "turn-submitting"
            ) =>
        {
            Ok(true)
        }
        other => {
            retry["status"] = json!("stopped");
            retry["attempts"] = retry["nextAttempt"].clone();
            retry["reason"] = json!(match other {
                Ok(r) => r["result"]["error"].to_string(),
                Err(e) => e,
            });
            update(b, retry, false).await?;
            Ok(false)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_confirmed_capacity_without_tool_activity_is_retried_with_backoff() {
        let mut t = json!({"status":"failed","error":{"codexErrorInfo":"serverOverloaded"},"items":[{"type":"userMessage"},{"type":"reasoning"}]});
        assert!(safe_turn(&t));
        t["items"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"commandExecution","status":"completed"}));
        assert!(!safe_turn(&t));
        t["items"] = Value::Null;
        assert!(!safe_turn(&t));
        t["items"] = json!([]);
        t["error"]["codexErrorInfo"] = json!("other");
        assert!(!safe_turn(&t));
        assert_eq!(
            (1..=3).map(|i| delay(&json!({}), i)).collect::<Vec<_>>(),
            vec![30, 60, 120]
        );
        assert_eq!(delay(&json!({"codexRetryInitialSeconds":5}), 3), 20);
    }
}
