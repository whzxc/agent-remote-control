use super::*;
pub async fn read(control: &Control) -> std::result::Result<Reading, Failure> {
    let v = control
        .account_rate_limits()
        .await
        .map_err(|message| Failure {
            code: "request-failed",
            message: Some(message),
            retry_at: None,
        })?;
    let groups: Vec<(String, &Value)> = if let Some(map) = v["rateLimitsByLimitId"].as_object() {
        map.iter().map(|(k, v)| (k.clone(), v)).collect()
    } else if v["rateLimits"].is_object() {
        vec![(
            v["rateLimits"]["limitId"]
                .as_str()
                .unwrap_or("codex")
                .into(),
            &v["rateLimits"],
        )]
    } else {
        vec![]
    };
    let mut windows = vec![];
    let mut blocked = vec![];
    for (pool, g) in groups {
        if g["rateLimitReachedType"].as_str().is_some() || g["spendControlReached"] == true {
            blocked.push(pool.clone());
        }
        for slot in ["primary", "secondary"] {
            let q = &g[slot];
            let reset = q["resetsAt"]
                .as_i64()
                .and_then(|n| chrono::DateTime::from_timestamp(n, 0))
                .map(|d| d.to_rfc3339());
            let label = q["windowDurationMins"]
                .as_u64()
                .map(|n| format!("{n} min"))
                .unwrap_or(slot.into());
            if let Some(mut w) = window(
                &format!("{pool}/{slot}"),
                &pool,
                &label,
                number(&q["usedPercent"]),
                reset,
            ) {
                w.scope = g["limitName"].as_str().map(str::to_owned);
                windows.push(w)
            }
        }
    }
    let mut r = Reading::new(windows, v.clone())?;
    r.blocked_pool_ids = blocked;
    r.account_blocked = v["ordinaryUsageAllowed"].as_bool().map(|allowed| !allowed);
    Ok(r)
}
