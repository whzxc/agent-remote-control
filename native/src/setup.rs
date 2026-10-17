//! A small, derived view over onboarding. Only the goal, choices and their start time persist.
use crate::{service::Service, *};
use std::time::Duration;

static APPLY: Mutex<()> = Mutex::const_new(());
fn path() -> PathBuf {
    root().join("setup.json")
}
fn state() -> Result<Value> {
    if path().exists() {
        load(&path())
    } else {
        Ok(json!({"choices":{}}))
    }
}
async fn call(s: &Arc<Service>, route: &str, method: &str, body: Value) -> Result<Value> {
    Box::pin(s.request(route, method, body)).await
}
fn goal(value: &str) -> Result<&str> {
    match value {
        "claude-loop" | "chatgpt-chat" => Ok(value),
        _ => Err("INVALID_ARGUMENT: goal must be claude-loop or chatgpt-chat".into()),
    }
}
fn choose_goal(state: &mut Value, value: &str) -> Result<()> {
    goal(value)?;
    if state["goal"] != value {
        *state = json!({"goal":value,"startedAt":now(),"choices":{}});
    }
    Ok(())
}
fn selected<'a>(state: &Value, ingresses: &'a Value) -> Option<&'a Value> {
    let claude = state["goal"] == "claude-loop";
    let id = format!("setup-{}", string(state, "goal"));
    let suitable = |i: &&Value| {
        if claude {
            i["controlSource"] == "claude"
                && i["transport"] == "https"
                && i["auth"] == "oauth"
                && if state["choices"]["choose-address"] == "fixed" {
                    crate::ingress::config::descriptor()["providers"]
                        [string(&i["config"], "httpsProvider")]["mode"]
                        .as_str()
                        .is_some_and(|mode| i["config"][mode] == "named")
                } else {
                    i["config"]["httpsProvider"] == "cloudflare"
                        && i["config"]["cloudflareMode"] == "quick"
                }
        } else {
            i["controlSource"] == "chatgpt" && i["transport"] == "openai-tunnel"
        }
    };
    let rows = ingresses.as_array()?;
    rows.iter()
        .filter(suitable)
        .find(|i| i["id"] == id)
        .or_else(|| rows.iter().find(suitable))
}
fn after(value: &Value, start: &Value) -> bool {
    value
        .as_str()
        .zip(start.as_str())
        .is_some_and(|(v, s)| v > s)
}
fn granted(items: &Value, id: &str) -> bool {
    items
        .as_array()
        .into_iter()
        .flatten()
        .any(|i| i["id"] == id && matches!(string(i, "state"), "granted" | "not-applicable"))
}
fn credential(i: &Value) -> (&str, &str) {
    match string(&i["config"], "httpsProvider") {
        "ngrok" => ("ngrokAuthtoken", "hasNgrokAuthtoken"),
        "pinggy" => ("pinggyToken", "hasPinggyToken"),
        "localxpose" => ("localxposeAccessToken", "hasLocalxposeAccessToken"),
        _ => ("cloudflareToken", "hasCloudflareToken"),
    }
}
fn edit_url(i: &Value, field: &str) -> String {
    format!(
        "agent-remote-control://ingress?id={}&field={field}",
        string(i, "id")
    )
}
fn step(
    locale: &str,
    id: &str,
    kind: &str,
    url: Option<String>,
    options: &[(&str, bool)],
) -> Value {
    let t = |suffix: &str| crate::i18n::text(locale, &format!("setup.{id}.{suffix}")).to_owned();
    json!({"id":id,"kind":kind,"title":t("title"),"explain":t("explain"),
        "options":options.iter().map(|(option,recommended)|json!({"id":option,"label":crate::i18n::text(locale,&format!("setup.option.{option}")),"recommended":recommended})).collect::<Vec<_>>(),
        "apply":if matches!(kind,"auto"|"decide") || !options.is_empty() || id == "codex-ready" {Some(format!("setup apply {id} --stdin"))}else{None},
        "openUrl":url,"doneWhen":t("done"),"playbook":id})
}
fn derive(state: &Value, data: &Value, locale: &str) -> Value {
    let goal = string(state, "goal");
    if goal.is_empty() {
        return json!({"schemaVersion":1,"goal":null,"progress":{"done":0,"total":1},"complete":false,
            "step":step(locale,"choose-goal","decide",None,&[("claude-loop",true),("chatgpt-chat",false)])});
    }
    let claude = goal == "claude-loop";
    let choices = &state["choices"];
    let i = selected(state, &data["ingresses"]).unwrap_or(&Value::Null);
    let items = &data["permissions"]["items"];
    let skip_claude = choices["claude-code-ready"] == "skip";
    let mut steps = vec![];
    steps.push((
        data["login"]["state"] == "authenticated",
        step(
            locale,
            "codex-ready",
            "authorize",
            Some("agent-remote-control://setup?target=codex-login".into()),
            &[],
        ),
    ));
    if claude {
        steps.push((
            granted(items, "claude-code") || skip_claude,
            step(
                locale,
                "claude-code-ready",
                "auto",
                None,
                &[("skip", false)],
            ),
        ));
    }
    let permissions = [
        "accessibility",
        "screen-recording",
        "full-disk-access",
        "command-full-disk-access",
        "notifications",
    ];
    steps.push((
        choices["permissions"] == "skip" || permissions.iter().all(|id| granted(items, id)),
        step(
            locale,
            "permissions",
            "authorize",
            Some("agent-remote-control://settings?section=permissions".into()),
            &[("skip", false)],
        ),
    ));
    if claude {
        steps.push((
            choices["choose-address"].is_string(),
            step(
                locale,
                "choose-address",
                "decide",
                None,
                &[("cf-quick", true), ("fixed", false)],
            ),
        ));
        if choices["choose-address"] == "fixed" {
            let (field, flag) = credential(i);
            let mut secret = step(
                locale,
                "address-secret",
                "secret",
                Some(edit_url(i, field)),
                &[],
            );
            secret["credentialUrl"] = crate::ingress::config::descriptor()["providers"]
                [string(&i["config"], "httpsProvider")]["help"]
                .clone();
            steps.push((i["config"][flag] == true, secret));
        }
    } else {
        steps.push((
            choices["chatgpt-prereq"] == "ready",
            step(
                locale,
                "chatgpt-prereq",
                "decide",
                None,
                &[("ready", true), ("claude-loop", false)],
            ),
        ));
        let has_id = !string(&i["config"], "tunnelId").is_empty();
        let mut credentials = step(
            locale,
            "tunnel-credentials",
            if has_id { "secret" } else { "remote-ui" },
            Some(if has_id {
                edit_url(i, "apiKey")
            } else {
                "https://platform.openai.com/settings/organization/tunnels".into()
            }),
            &[],
        );
        credentials["credentialUrl"] =
            json!("https://platform.openai.com/settings/organization/tunnels");
        credentials["secretUrl"] = json!(edit_url(i, "apiKey"));
        credentials["apply"] = json!("setup apply tunnel-credentials --stdin");
        steps.push((has_id && i["config"]["hasApiKey"] == true, credentials));
    }
    steps.push((
        i["running"] == true
            && i["state"] == "ready"
            && (!claude
                || i["verification"]["lastProbe"]["passed"] == true
                    && i["verification"]["lastProbe"]["url"] == i["url"]),
        step(locale, "create-ingress", "auto", None, &[]),
    ));
    if claude {
        let oauth = &data["oauth"];
        let pending = oauth["pending"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["status"] == "pending");
        let grants = oauth["grants"].as_array().is_some_and(|g| !g.is_empty());
        steps.push((
            i["verification"]["firstOAuthRequestAt"].is_string() || pending.is_some() || grants,
            step(
                locale,
                "add-connector",
                "remote-ui",
                Some("https://claude.ai/settings/connectors".into()),
                &[],
            ),
        ));
        let consent_url = pending
            .map(|p| format!("agent-remote-control://oauth?request={}", string(p, "id")))
            .unwrap_or_else(|| edit_url(i, "oauth"));
        steps.push((
            grants,
            step(locale, "consent", "authorize", Some(consent_url), &[]),
        ));
    } else {
        steps.push((
            i["verification"]["firstMcpRequestAt"].is_string(),
            step(
                locale,
                "enable-in-chatgpt",
                "remote-ui",
                Some("https://chatgpt.com/#settings/Connectors".into()),
                &[],
            ),
        ));
    }
    let client = if claude {
        "https://claude.ai/new"
    } else {
        "https://chatgpt.com/"
    };
    steps.push((
        after(
            &i["verification"]["challengeVerifiedAt"],
            &state["startedAt"],
        ),
        step(
            locale,
            "verify-connector",
            "remote-ui",
            Some(client.into()),
            &[],
        ),
    ));
    steps.push((
        data["loop"]["complete"] == true,
        step(locale, "loop-test", "remote-ui", Some(client.into()), &[]),
    ));
    let done = steps.iter().filter(|(done, _)| *done).count();
    let current = steps
        .iter()
        .find(|(done, _)| !done)
        .map(|(_, step)| step.clone());
    let mut result = json!({"schemaVersion":1,"goal":goal,"progress":{"done":done,"total":steps.len()},"complete":current.is_none(),"step":current,
        "ingressId":i["id"],"onboarding":if i.is_object(){crate::cli::onboarding(i)}else{Value::Null},"findings":i["diagnostics"]["findings"].as_array().cloned().unwrap_or_default()});
    for (active, key) in [
        (claude && skip_claude, "notification-skipped"),
        (
            data["loop"]["notificationFailed"] == true,
            "notification-failed",
        ),
    ] {
        if active {
            result["findings"].as_array_mut().unwrap().push(json!({"code":key,"severity":"warning","summary":crate::i18n::text(locale,&format!("setup.{key}"))}));
        }
    }
    if let Some(error) = data["loop"].get("error") {
        result["findings"]
            .as_array_mut()
            .unwrap()
            .push(json!({"code":"LOOP_READ_FAILED","severity":"warning","summary":error}));
    }
    result
}
fn loop_evidence(observed: &Value, notification: &Value, needs_notification: bool) -> Value {
    let mut result = json!({"complete":false});
    if observed["state"] != "completed" {
        return result;
    }
    if needs_notification {
        for delivery in notification["deliveries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|d| d["state"] == "完成")
        {
            if delivery["status"] == "delivered" {
                result["complete"] = json!(true);
            }
            if delivery["status"] == "failed" {
                result["notificationFailed"] = json!(true);
            }
        }
    } else {
        result["complete"] =
            json!(string(&observed["finalResponse"], "text").trim() == "ARC_ONBOARDING_OK");
    }
    result
}
async fn loop_status(s: &Arc<Service>, state: &Value, i: &Value) -> Result<Value> {
    let records = s.control.task_records().await?;
    let mut result = json!({"complete":false});
    let needs_notification =
        state["goal"] == "claude-loop" && state["choices"]["claude-code-ready"] != "skip";
    for r in records.iter().filter(|r| {
        r["origin"]["ingressId"] == i["id"] && after(&r["createdAt"], &state["startedAt"])
    }) {
        let thread = string(r, "threadId");
        let turn = string(r, "turnId");
        if thread.is_empty() || turn.is_empty() {
            continue;
        }
        let observed = match crate::waiter::codex_observe(
            &s.control,
            &json!({"threadId":thread,"turnId":turn}),
        )
        .await
        {
            Ok(value) => value,
            Err(error) => {
                result["error"] = json!(error);
                continue;
            }
        };
        let notification = if needs_notification {
            crate::claude_notify::read(thread, turn)?
        } else {
            Value::Null
        };
        let evidence = loop_evidence(&observed, &notification, needs_notification);
        if evidence["complete"] == true {
            return Ok(evidence);
        }
        if evidence["notificationFailed"] == true
            || needs_notification
                && observed["state"] == "completed"
                && r["claudeNotification"] == "bind-failed"
        {
            result["notificationFailed"] = json!(true);
        }
    }
    Ok(result)
}
async fn next(s: &Arc<Service>, preview_goal: Option<&str>) -> Result<Value> {
    let mut state = state()?;
    if let Some(value) = preview_goal {
        choose_goal(&mut state, value)?;
    }
    let locale = crate::i18n::locale();
    if state["goal"].is_null() {
        return Ok(derive(&state, &json!({}), &locale));
    }
    let login = call(s, "codex/login", "GET", json!({}))
        .await
        .unwrap_or_else(|e| json!({"state":"unavailable","error":e}));
    let permissions = call(s, "permissions", "GET", json!({})).await?;
    let ingresses = call(s, "ingress", "GET", json!({})).await?;
    let mut data = json!({"login":login,"permissions":permissions,"ingresses":ingresses});
    if let Some(i) = selected(&state, &data["ingresses"]).cloned() {
        if i["auth"] == "oauth" && !string(&i, "url").is_empty() {
            data["oauth"] = call(
                s,
                &format!("ingress/{}/oauth", string(&i, "id")),
                "GET",
                json!({}),
            )
            .await?;
        }
        if after(
            &i["verification"]["challengeVerifiedAt"],
            &state["startedAt"],
        ) {
            data["loop"] = loop_status(s, &state, &i)
                .await
                .unwrap_or_else(|e| json!({"error":e}));
        }
    }
    Ok(derive(&state, &data, &locale))
}
async fn ensure_ingress(s: &Arc<Service>, state: &Value, config: Value) -> Result<Value> {
    let ingresses = call(s, "ingress", "GET", json!({})).await?;
    if let Some(i) = selected(state, &ingresses) {
        return Ok(i.clone());
    }
    let claude = state["goal"] == "claude-loop";
    let mut entry = json!({"id":format!("setup-{}",string(state,"goal")),"controlSource":if claude{"claude"}else{"chatgpt"},"transport":if claude{"https"}else{"openai-tunnel"},"auth":if claude{"oauth"}else{"openai"},"config":config});
    let fixed = state["choices"]["choose-address"] == "fixed";
    if claude && entry["config"].get("httpsProvider").is_none() {
        entry["config"]["httpsProvider"] = json!("cloudflare");
    }
    if claude {
        let provider = string(&entry["config"], "httpsProvider").to_owned();
        if let Some(mode) =
            crate::ingress::config::descriptor()["providers"][&provider]["mode"].as_str()
        {
            entry["config"][mode] = json!(if fixed { "named" } else { "quick" });
        }
    }
    crate::cli::validate_ingress_input(&entry, false)?;
    if ingresses
        .as_array()
        .into_iter()
        .flatten()
        .any(|i| i["id"] == entry["id"])
    {
        let route = format!("ingress/{}", string(&entry, "id"));
        entry.as_object_mut().unwrap().remove("id");
        return call(s, &route, "PUT", entry).await;
    }
    call(s, "ingress", "POST", entry).await
}
async fn apply(s: &Arc<Service>, body: Value) -> Result<Value> {
    let _guard = APPLY.lock().await;
    let mut state = state()?;
    let id = string(&body, "stepId");
    let input = &body["input"];
    let option = string(input, "option");
    if id == "choose-goal" {
        choose_goal(&mut state, option)?;
        save(&path(), &state)?;
    } else {
        goal(string(&state, "goal"))?;
        match id {
            "codex-ready" => {
                if call(s, "codex/login", "GET", json!({}))
                    .await
                    .ok()
                    .is_none_or(|v| v["state"] != "authenticated")
                {
                    call(s, "codex/login", "POST", json!({})).await?;
                }
            }
            "claude-code-ready" | "permissions" if option == "skip" => {
                state["choices"][id] = json!("skip");
                save(&path(), &state)?;
            }
            "claude-code-ready" => {
                let ready = call(s, "permissions", "GET", json!({})).await?;
                if !granted(&ready["items"], "claude-code") {
                    call(s, "agents/open", "POST", json!({"agent":"claude"})).await?;
                }
            }
            "choose-address" => {
                if !["cf-quick", "fixed"].contains(&option) {
                    return Err("INVALID_ARGUMENT: option must be cf-quick or fixed".into());
                }
                state["choices"][id] = json!(option);
                // Publish the choice only after the existing ingress validation succeeds.
                ensure_ingress(s, &state, input.get("config").cloned().unwrap_or(json!({})))
                    .await?;
                save(&path(), &state)?;
            }
            "chatgpt-prereq" => {
                if option == "claude-loop" {
                    choose_goal(&mut state, option)?;
                } else if option == "ready" {
                    state["choices"][id] = json!(option);
                    ensure_ingress(s, &state, json!({})).await?;
                } else {
                    return Err("INVALID_ARGUMENT: option must be ready or claude-loop".into());
                }
                save(&path(), &state)?;
            }
            "tunnel-credentials" => {
                let i = ensure_ingress(s, &state, json!({})).await?;
                let patch = json!({"config":{"tunnelId":input["tunnelId"]}});
                crate::cli::validate_ingress_input(&patch, true)?;
                if i["config"]["tunnelId"] != input["tunnelId"] {
                    call(s, &format!("ingress/{}", string(&i, "id")), "PUT", patch).await?;
                }
            }
            "create-ingress" => {
                let i = ensure_ingress(s, &state, json!({})).await?;
                let prefix = format!("ingress/{}", string(&i, "id"));
                if i["enabled"] != true {
                    call(s, &prefix, "PUT", json!({"enabled":true})).await?;
                }
                if i["running"] != true {
                    call(s, &format!("{prefix}/start"), "POST", json!({})).await?;
                }
                if state["goal"] == "claude-loop" {
                    call(s, &format!("{prefix}/probe"), "POST", json!({})).await?;
                }
            }
            _ => return Err("INVALID_ARGUMENT: this step has no apply action".into()),
        }
    }
    next(s, None).await
}
pub async fn request(s: &Arc<Service>, route: &str, method: &str, body: Value) -> Result<Value> {
    match (method, route) {
        ("POST", "setup/next") => next(s, body["goal"].as_str()).await,
        ("POST", "setup/apply") => apply(s, body).await,
        ("DELETE", "setup/reset") => {
            let _guard = APPLY.lock().await;
            if path().exists() {
                std::fs::remove_file(path()).map_err(|e| e.to_string())?;
            }
            next(s, None).await
        }
        ("POST", "setup/wait") => {
            let mut current = next(s, None).await?;
            let initial = current["step"]["id"].clone();
            let deadline = tokio::time::Instant::now()
                + Duration::from_secs(body["timeout"].as_u64().unwrap_or(60));
            while current["complete"] != true
                && current["step"]["id"] == initial
                && tokio::time::Instant::now() < deadline
            {
                tokio::time::sleep_until(
                    deadline.min(tokio::time::Instant::now() + Duration::from_secs(1)),
                )
                .await;
                match tokio::time::timeout_at(deadline, next(s, None)).await {
                    Ok(value) => current = value?,
                    Err(_) => break,
                }
            }
            Ok(current)
        }
        _ => Err("UNKNOWN_ROUTE".into()),
    }
}
pub fn playbook(id: &str) -> Result<Value> {
    match id {
        "protocol" => Ok(
            json!({"id":id,"markdown":include_str!("../../skills/arc-setup/playbooks/protocol.md")}),
        ),
        "choose-goal" | "codex-ready" | "claude-code-ready" | "permissions" | "choose-address"
        | "address-secret" | "create-ingress" | "add-connector" | "consent"
        | "verify-connector" | "loop-test" | "chatgpt-prereq" | "tunnel-credentials"
        | "enable-in-chatgpt" => Ok(
            json!({"id":id,"markdown":include_str!("../../skills/arc-setup/playbooks/pending.md")}),
        ),
        _ => Err("INVALID_ARGUMENT: unknown setup playbook".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(goal: &str) -> (Value, Value) {
        let state = json!({"goal":goal,"startedAt":"2026-10-17T00:00:00.000Z","choices":{}});
        let data = json!({"login":{"state":"authenticated"},"permissions":{"items":[
            {"id":"claude-code","state":"granted"},{"id":"accessibility","state":"granted"},
            {"id":"screen-recording","state":"granted"},{"id":"full-disk-access","state":"granted"},
            {"id":"command-full-disk-access","state":"not-applicable"},{"id":"notifications","state":"granted"}]},"ingresses":[]});
        (state, data)
    }
    fn current(state: &Value, data: &Value) -> String {
        string(&derive(state, data, "en")["step"], "id").into()
    }
    fn claude() -> Value {
        json!({"id":"existing","controlSource":"claude","transport":"https","auth":"oauth","config":{"httpsProvider":"cloudflare","cloudflareMode":"quick"},"running":true,"state":"ready","url":"https://example.com/mcp","verification":{"lastProbe":{"passed":true,"url":"https://example.com/mcp"}}})
    }
    #[test]
    fn claude_sequence_requires_remote_challenge_and_delivery() {
        let (mut state, mut data) = fixture("claude-loop");
        assert_eq!(current(&state, &data), "choose-address");
        state["choices"]["choose-address"] = json!("cf-quick");
        assert_eq!(current(&state, &data), "create-ingress");
        data["ingresses"] = json!([claude()]);
        assert_eq!(
            selected(&state, &data["ingresses"]).unwrap()["id"],
            "existing"
        );
        assert_eq!(current(&state, &data), "add-connector");
        data["ingresses"][0]["verification"]["firstOAuthRequestAt"] =
            json!("2026-10-17T00:01:00.000Z");
        assert_eq!(current(&state, &data), "consent");
        data["oauth"] = json!({"grants":[{"id":"grant"}]});
        assert_eq!(current(&state, &data), "verify-connector");
        data["ingresses"][0]["verification"]["challengeVerifiedAt"] =
            json!("2026-10-16T23:59:00.000Z");
        assert_eq!(current(&state, &data), "verify-connector");
        data["ingresses"][0]["verification"]["challengeVerifiedAt"] =
            json!("2026-10-17T00:02:00.000Z");
        assert_eq!(current(&state, &data), "loop-test");
        data["loop"] = json!({"notificationFailed":true});
        let result = derive(&state, &data, "zh-CN");
        assert_eq!(result["complete"], false);
        assert!(result["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["code"] == "notification-failed"));
        let completed = json!({"state":"completed","finalResponse":{"type":"agentMessage","text":"ARC_ONBOARDING_OK"}});
        assert_eq!(
            loop_evidence(&completed, &Value::Null, true)["complete"],
            false
        );
        let notification = json!({"deliveries":[{"state":"完成","status":"delivered"}]});
        assert_eq!(
            loop_evidence(&json!({"state":"running"}), &notification, true)["complete"],
            false
        );
        data["loop"] = loop_evidence(&completed, &notification, true);
        assert_eq!(derive(&state, &data, "en")["complete"], true);
        data["ingresses"][0]["url"] = json!("https://changed.example/mcp");
        assert_eq!(current(&state, &data), "create-ingress");
    }
    #[test]
    fn fixed_address_waits_for_saved_credential() {
        let (mut state, mut data) = fixture("claude-loop");
        state["choices"]["choose-address"] = json!("fixed");
        let mut i = claude();
        i["config"]["cloudflareMode"] = json!("named");
        i["running"] = json!(false);
        data["ingresses"] = json!([i]);
        let result = derive(&state, &data, "en");
        assert_eq!(result["step"]["kind"], "secret");
        assert_eq!(
            result["step"]["openUrl"],
            "agent-remote-control://ingress?id=existing&field=cloudflareToken"
        );
        data["ingresses"][0]["config"]["hasCloudflareToken"] = json!(true);
        assert_eq!(current(&state, &data), "create-ingress");
    }
    #[test]
    fn chatgpt_sequence_separates_credentials_mcp_and_challenge() {
        let (mut state, mut data) = fixture("chatgpt-chat");
        assert_eq!(current(&state, &data), "chatgpt-prereq");
        state["choices"]["chatgpt-prereq"] = json!("ready");
        data["ingresses"] = json!([{"id":"default","controlSource":"chatgpt","transport":"openai-tunnel","config":{}}]);
        assert_eq!(derive(&state, &data, "en")["step"]["kind"], "remote-ui");
        data["ingresses"][0]["config"]["tunnelId"] = json!("tunnel");
        assert_eq!(derive(&state, &data, "en")["step"]["kind"], "secret");
        data["ingresses"][0]["config"]["hasApiKey"] = json!(true);
        assert_eq!(current(&state, &data), "create-ingress");
        data["ingresses"][0]["running"] = json!(true);
        data["ingresses"][0]["state"] = json!("ready");
        assert_eq!(current(&state, &data), "enable-in-chatgpt");
        data["ingresses"][0]["verification"] =
            json!({"firstMcpRequestAt":"2026-10-17T00:01:00.000Z"});
        assert_eq!(current(&state, &data), "verify-connector");
        data["ingresses"][0]["verification"]["challengeVerifiedAt"] =
            json!("2026-10-17T00:02:00.000Z");
        assert_eq!(current(&state, &data), "loop-test");
        assert_eq!(
            loop_evidence(
                &json!({"state":"completed","finalResponse":{"text":"not the expected reply"}}),
                &Value::Null,
                false
            )["complete"],
            false
        );
        data["loop"] = loop_evidence(
            &json!({"state":"completed","finalResponse":{"type":"agentMessage","text":"ARC_ONBOARDING_OK"}}),
            &Value::Null,
            false,
        );
        assert_eq!(derive(&state, &data, "en")["complete"], true);
    }
    #[test]
    fn decisions_and_login_are_not_inferred_from_other_readiness() {
        let (mut state, mut data) = fixture("claude-loop");
        assert_eq!(current(&json!({"choices":{}}), &data), "choose-goal");
        data["login"]["state"] = json!("unauthenticated");
        assert_eq!(current(&state, &data), "codex-ready");
        data["login"]["state"] = json!("authenticated");
        data["permissions"]["items"] = json!([]);
        assert_eq!(current(&state, &data), "claude-code-ready");
        state["choices"]["claude-code-ready"] = json!("skip");
        assert_eq!(current(&state, &data), "permissions");
        state["choices"]["permissions"] = json!("skip");
        assert_eq!(current(&state, &data), "choose-address");
        let start = state["startedAt"].clone();
        choose_goal(&mut state, "claude-loop").unwrap();
        assert_eq!(state["startedAt"], start);
        choose_goal(&mut state, "chatgpt-chat").unwrap();
        assert_eq!(state["choices"], json!({}));
    }
}
