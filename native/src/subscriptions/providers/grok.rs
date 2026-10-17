use super::*;
pub fn credential() -> std::result::Result<Credential, Failure> {
    let v = file(&home()?.join(".grok/auth.json"))?;
    let entries = v
        .as_object()
        .ok_or_else(|| Failure::from("invalid-response"))?;
    let token = entries
        .values()
        .find_map(|q| q["key"].as_str().filter(|s| !s.is_empty()))
        .ok_or(Failure::from("credentials-missing"))?;
    Credential::new(token.into(), "grok-login")
}
pub async fn read(
    client: &reqwest::Client,
    c: &Credential,
) -> std::result::Result<Reading, Failure> {
    let request = |url| {
        get(client
            .get(url)
            .bearer_auth(&c.secret)
            .header("x-xai-token-auth", "xai-grok-cli"))
    };
    let (credits, settings) = tokio::join!(
        request("https://grok.com/rest/grok/credits"),
        request("https://cli-chat-proxy.grok.com/v1/settings"),
    );
    let mut v = credits?;
    if !v["config"].is_object() {
        return Err("invalid-response".into());
    }
    if let Ok(settings) = settings {
        v["subscriptionTier"] = settings["subscription_tier_display"]
            .as_str()
            .or_else(|| settings["subscription_tier"].as_str())
            .map(|s| json!(s))
            .unwrap_or(Value::Null);
    }
    let q = &v["config"];
    let end = date(&q["currentPeriod"]["end"]).or_else(|| date(&q["billingPeriodEnd"]));
    let label = match q["currentPeriod"]["type"].as_str() {
        Some("USAGE_PERIOD_TYPE_WEEKLY") => "weekly",
        Some("USAGE_PERIOD_TYPE_MONTHLY") => "monthly",
        _ => "current-period",
    };
    let percent = number(&q["creditUsagePercent"]);
    Reading::new(
        window("current-period", "grok", label, percent, end)
            .into_iter()
            .collect(),
        v,
    )
}
