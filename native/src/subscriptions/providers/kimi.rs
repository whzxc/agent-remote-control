use super::*;
fn quota(q: &Value, id: &str, label: &str) -> Option<QuotaWindow> {
    let limit = number(&q["limit"])?;
    if limit <= 0. {
        return None;
    }
    let used = if q.get("used").is_some_and(|v| !v.is_null()) {
        number(&q["used"])?
    } else {
        limit - number(&q["remaining"])?
    };
    window(
        id,
        "coding",
        label,
        Some(used / limit * 100.),
        date(&q["resetTime"]),
    )
}
pub async fn read(
    client: &reqwest::Client,
    c: &Credential,
) -> std::result::Result<Reading, Failure> {
    let v = get(client
        .get("https://api.kimi.com/coding/v1/usages")
        .bearer_auth(&c.secret))
    .await?;
    let mut windows = vec![];
    if let Some(limits) = v["limits"].as_array() {
        for (i, q) in limits.iter().enumerate() {
            let unit = match q["window"]["timeUnit"].as_str() {
                Some("TIME_UNIT_SECOND") => 1,
                Some("TIME_UNIT_MINUTE") => 60,
                Some("TIME_UNIT_HOUR") => 3600,
                Some("TIME_UNIT_DAY") => 86400,
                _ => continue,
            };
            let Some(duration) = q["window"]["duration"]
                .as_u64()
                .or_else(|| q["window"]["duration"].as_str()?.parse::<u64>().ok())
                .filter(|v| *v > 0)
                .and_then(|v| v.checked_mul(unit))
            else {
                continue;
            };
            if let Some(w) = quota(
                &q["detail"],
                &format!("limit/{duration}/{i}"),
                &format!("{duration} s"),
            ) {
                windows.push(w)
            }
        }
    }
    if let Some(w) = quota(&v["usage"], "weekly", "weekly") {
        windows.push(w)
    }
    Reading::new(windows, v)
}
