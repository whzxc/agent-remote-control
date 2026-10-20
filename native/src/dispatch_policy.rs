//! User-owned dispatch choices; native capability and quota facts stay upstream.
use crate::*;
use serde::{Deserialize, Serialize};
static RECORDS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Policy {
    model: Option<String>,
    effort: Option<String>,
    #[serde(default)]
    service_tier: Option<String>,
    #[serde(default)]
    service_tiers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    allow_models: Vec<String>,
    #[serde(default)]
    deny_models: Vec<String>,
    #[serde(default)]
    allow_efforts: Vec<String>,
    #[serde(default)]
    deny_efforts: Vec<String>,
    criteria: String,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct Policies {
    criteria: String,
    codex: Policy,
    #[serde(flatten)]
    agents: std::collections::BTreeMap<String, AgentPolicy>,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPolicy {
    pub model: Option<String>,
    pub options: std::collections::BTreeMap<String, String>,
    allow_models: Vec<String>,
    deny_models: Vec<String>,
    allow_options: std::collections::BTreeMap<String, Vec<String>>,
    deny_options: std::collections::BTreeMap<String, Vec<String>>,
    criteria: String,
}
pub(crate) fn agent_policy(agent: &str) -> Result<AgentPolicy> {
    Ok(read()?.agents.remove(agent).unwrap_or_default())
}
impl AgentPolicy {
    pub fn check_model(&self, model: Option<&str>) -> Result<()> {
        check_known(model, &self.allow_models, &self.deny_models, "model")
    }
    pub fn check(&self, model: Option<&str>, options: &Value) -> Result<()> {
        check_known(model, &self.allow_models, &self.deny_models, "model")?;
        for key in self.allow_options.keys().chain(self.deny_options.keys()) {
            check_known(
                options[key].as_str(),
                self.allow_options
                    .get(key)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                self.deny_options.get(key).map(Vec::as_slice).unwrap_or(&[]),
                key,
            )?;
        }
        Ok(())
    }
}
fn check_known(value: Option<&str>, allow: &[String], deny: &[String], field: &str) -> Result<()> {
    if let Some(value) = value {
        check(value, allow, deny, field)
    } else if !allow.is_empty() || !deny.is_empty() {
        Err(format!(
            "DISPATCH_CONFIGURATION_UNKNOWN: cannot check {field}"
        ))
    } else {
        Ok(())
    }
}
fn read() -> Result<Policies> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let path = root().join("dispatch-policy.json");
    if !path.exists() {
        let mut bytes =
            serde_json::to_vec_pretty(&Policies::default()).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        save_bytes(&path, &bytes)?;
    }
    let policies: Policies = serde_json::from_value(load(&path)?)
        .map_err(|e| format!("INVALID_DISPATCH_POLICY: dispatch-policy.json: {e}"))?;
    if policies
        .codex
        .model
        .as_ref()
        .is_some_and(|v| v.trim().is_empty())
        || policies
            .codex
            .effort
            .as_ref()
            .is_some_and(|v| v.trim().is_empty())
        || policies
            .agents
            .values()
            .any(|p| p.model.as_ref().is_some_and(|v| v.trim().is_empty()))
    {
        return Err("INVALID_DISPATCH_POLICY: model and effort must be nonempty or null".into());
    }
    Ok(policies)
}
fn check(value: &str, allow: &[String], deny: &[String], field: &str) -> Result<()> {
    if deny.iter().any(|v| v == value) || (!allow.is_empty() && !allow.iter().any(|v| v == value)) {
        return Err(format!("DISPATCH_POLICY_DENIED: {field}={value}; read query dispatch_policy for allowed choices"));
    }
    Ok(())
}
pub(crate) fn resolve(args: &mut Value) -> Result<Value> {
    let policy = read()?.codex;
    let mut selection = json!({"reason":args["reason"],"source":{}});
    for (field, mode_field, default, allow, deny) in [
        (
            "model",
            "model",
            &policy.model,
            &policy.allow_models,
            &policy.deny_models,
        ),
        (
            "effort",
            "reasoning_effort",
            &policy.effort,
            &policy.allow_efforts,
            &policy.deny_efforts,
        ),
    ] {
        // Collaboration settings take precedence in the native turn protocol.
        let explicit = args["turn"]["collaborationMode"]["settings"][mode_field]
            .as_str()
            .or_else(|| args["turn"][field].as_str())
            .or_else(|| args[field].as_str())
            .or_else(|| {
                if field == "model" {
                    args["thread"]["model"].as_str()
                } else {
                    None
                }
            });
        let value = explicit.or(default.as_deref());
        check_known(value, allow, deny, field)?;
        selection["source"][field] = json!("native-default");
        let Some(value) = value.map(str::to_owned) else {
            continue;
        };
        selection["source"][field] = json!(if explicit.is_some() {
            "explicit"
        } else {
            "policy-default"
        });
        selection[field] = json!(value);
        args[field] = json!(value);
        if args["turn"].is_object() {
            args["turn"][field] = json!(value);
            if args["turn"]["collaborationMode"].is_object() {
                args["turn"]["collaborationMode"]["settings"][mode_field] = json!(value);
            }
        }
        if field == "model" && args["thread"].is_object() {
            args["thread"]["model"] = json!(value);
        }
    }
    let explicit = args["turn"]["serviceTierForTurn"]
        .as_str()
        .or_else(|| args["turn"]["serviceTier"].as_str())
        .or_else(|| args["serviceTier"].as_str())
        .or_else(|| args["thread"]["serviceTier"].as_str());
    let tier = explicit
        .or_else(|| {
            policy
                .service_tiers
                .get(string(&selection, "model"))
                .map(String::as_str)
        })
        .or(policy.service_tier.as_deref())
        .map(str::to_owned);
    selection["serviceTier"] = json!(tier);
    selection["source"]["serviceTier"] = json!(if explicit.is_some() {
        "explicit"
    } else if tier.is_some() {
        "policy-default"
    } else {
        "native-default"
    });
    if let Some(tier) = tier {
        // A one-turn native override must not change the thread's defaults.
        if !args["turn"]["serviceTierForTurn"].is_string() {
            args["serviceTier"] = json!(tier);
            if args["turn"].is_object() {
                args["turn"]["serviceTier"] = json!(tier);
            }
            if args["thread"].is_object() {
                args["thread"]["serviceTier"] = json!(tier);
            }
        }
    }
    Ok(selection)
}
async fn models(c: &control::Control) -> Result<Value> {
    let mut rows = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let page = c
            .request("model/list", json!({"cursor":cursor}), 15000)
            .await?;
        for model in page["data"].as_array().ok_or("NATIVE_MODELS_MISSING")? {
            rows.push(json!({
                "model":model["model"],
                "defaultServiceTier":model["defaultServiceTier"],
                "serviceTiers":model["serviceTiers"],
                "efforts":model["supportedReasoningEfforts"].as_array().into_iter().flatten()
                    .map(|e| e["reasoningEffort"].clone()).collect::<Vec<_>>()
            }));
        }
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    Ok(json!(rows))
}
async fn codex_facts(c: &control::Control) -> Result<Value> {
    let policy = read()?;
    let (models, quota) = tokio::join!(
        models(c),
        c.request("account/rateLimits/read", json!({}), 15000)
    );
    let quota = quota.map(|v| {
        let pools = if let Some(map) = v["rateLimitsByLimitId"].as_object() {
            map.iter().map(|(id, pool)| (id.clone(), pool.clone())).collect::<Vec<_>>()
        } else if v["rateLimits"].is_object() {
            vec![(v["rateLimits"]["limitId"].as_str().unwrap_or("codex").into(), v["rateLimits"].clone())]
        } else { vec![] };
        json!({"ordinaryUsageAllowed":v["ordinaryUsageAllowed"],"pools":pools.iter().map(|(id,p)| {
            let mut pool = json!({"id":id});
            for key in ["rateLimitReachedType","spendControlReached"] {
                if !p[key].is_null() { pool[key]=p[key].clone(); }
            }
            for key in ["primary","secondary"] {
                if p[key].is_object() {
                    pool[key]=json!({"usedPercent":p[key]["usedPercent"],"windowDurationMins":p[key]["windowDurationMins"],"resetsAt":p[key]["resetsAt"]});
                }
            }
            pool
        }).collect::<Vec<_>>()})
    });
    Ok(json!({
        "observedAt":now(),
        "models":models.unwrap_or_else(|error| json!({"unavailable":error})),
        "policy":policy,
        "quota":quota.unwrap_or_else(|error| json!({"unavailable":error})),
        "history":history("codex").unwrap_or_else(|error| json!({"unavailable":error}))
    }))
}

pub(crate) async fn query(
    c: &control::Control,
    agents: &agents::AgentHost,
    subscriptions: &subscriptions::SubscriptionService,
    args: &Value,
) -> Result<Value> {
    let policies = read()?;
    let mut rows = agents.dispatch_facts(args).await?;
    let snapshot = subscriptions.snapshot().await;
    for row in &mut rows {
        let agent = string(row, "agent").to_owned();
        let providers = snapshot["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| p["agentId"] == agent)
            .map(|p| {
                json!({
                    "providerId":p["providerId"],"state":p["state"],"observedAt":p["observedAt"],
                    "source":p["source"],"windows":p["windows"],"error":p["error"],
                    "accountBlocked":p["accountBlocked"],"blockedPoolIds":p["blockedPoolIds"]
                })
            })
            .collect::<Vec<_>>();
        row["availability"]["authentication"] = json!({
            "inference":"unknown",
            "quotaAccess":providers.iter().map(|p| json!({
                "providerId":p["providerId"],"state":p["state"],"observedAt":p["observedAt"],
                "error":p["error"]
            })).collect::<Vec<_>>()
        });
        if agent == "codex" {
            let facts = codex_facts(c).await?;
            for key in ["models", "quota", "history"] {
                row[key] = facts[key].clone();
            }
            row["policy"] = facts["policy"]["codex"].clone();
            row["selectionSupported"] = json!(true);
        } else {
            row["quota"] = if providers.is_empty() {
                json!({"unavailable":"provider-not-integrated"})
            } else {
                json!({"source":"subscriptions","providers":providers,"modelAssociation":"unknown"})
            };
            row["policy"] =
                serde_json::to_value(policies.agents.get(&agent).cloned().unwrap_or_default())
                    .map_err(|e| e.to_string())?;
            row["history"] = history(&agent).unwrap_or_else(|error| json!({"unavailable":error}));
            row["selectionSupported"] = json!(true);
        }
    }
    Ok(json!({"observedAt":now(),"criteria":policies.criteria,"agents":rows}))
}

fn history(agent: &str) -> Result<Value> {
    #[derive(Default)]
    struct Group {
        dispatches: u64,
        pass: u64,
        rework: u64,
        failed: u64,
        interrupted: u64,
        durations: Vec<u64>,
    }
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    let mut groups = std::collections::BTreeMap::<(String, String, String, String), Group>::new();
    let cutoff = chrono::Utc::now() - chrono::Duration::days(30);
    let dir = root().join("dispatches");
    if dir.exists() {
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let thread = entry.file_name().to_string_lossy().into_owned();
            let mut seen = std::collections::HashSet::new();
            for row in read_records(&thread)? {
                if row["agent"].as_str().unwrap_or("codex") != agent
                    || (agent != "codex" && row["submission"] != "accepted")
                    || row["purpose"] == "self-test"
                    || row["dispatchMode"] != "new-turn"
                    || !chrono::DateTime::parse_from_rfc3339(string(&row, "submittedAt"))
                        .is_ok_and(|time| time >= cutoff)
                    || !seen.insert(string(&row, "turnId").to_owned())
                {
                    continue;
                }
                let value = |field: &str| {
                    row["turnEvidence"][field]
                        .as_str()
                        .or_else(|| row["effectiveConfiguration"][field].as_str())
                        .filter(|v| !v.is_empty() && *v != "unknown")
                        .unwrap_or_else(|| string(&row, field))
                        .to_owned()
                };
                let group = groups
                    .entry((
                        value("model"),
                        value("effort"),
                        {
                            let tier = value("serviceTier");
                            if tier.is_empty() {
                                "unknown".into()
                            } else {
                                tier
                            }
                        },
                        row.get("options").cloned().unwrap_or(json!({})).to_string(),
                    ))
                    .or_default();
                group.dispatches += 1;
                match string(&row["terminal"], "state") {
                    "failed" => {
                        group.failed += 1;
                        continue;
                    }
                    "interrupted" | "cancelled" => {
                        group.interrupted += 1;
                        continue;
                    }
                    _ => {}
                }
                match string(&row["review"], "verdict") {
                    "pass" => group.pass += 1,
                    "rework" => group.rework += 1,
                    _ => {}
                }
                if let Some(ms) = row["terminal"]["observedDurationMs"].as_u64() {
                    group.durations.push(ms);
                }
            }
        }
    }
    let mut groups = groups
        .into_iter()
        .map(|((model, effort, tier, options), mut g)| {
            let mut row = json!({"agent":agent,"model":model,"options":serde_json::from_str::<Value>(&options).unwrap_or(json!({})),"effort":effort,"serviceTier":tier,"dispatches":g.dispatches,
            "pass":g.pass,"rework":g.rework,"failed":g.failed,"interrupted":g.interrupted,"unreviewed":g.dispatches-g.pass-g.rework-g.failed-g.interrupted});
            if !g.durations.is_empty() {
                g.durations.sort_unstable();
                let n = g.durations.len();
                row["medianObservedDurationMs"] =
                    json!((g.durations[(n - 1) / 2] as f64 + g.durations[n / 2] as f64) / 2.0);
                row["durationSamples"] = json!(n);
            }
            row
        })
        .collect::<Vec<_>>();
    // Keep the guide query small even after many model generations; disclose omitted groups.
    groups.sort_by_key(|g| std::cmp::Reverse(g["dispatches"].as_u64().unwrap_or(0)));
    let omitted = groups.len().saturating_sub(12);
    groups.truncate(12);
    let mut history = json!({"windowDays":30,"excludedPurpose":"self-test","groups":groups});
    if omitted > 0 {
        history["omittedGroups"] = json!(omitted);
    }
    Ok(history)
}

fn directory(thread: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(thread).map_err(|_| "INVALID_THREAD_ID")?;
    Ok(root().join("dispatches").join(thread))
}
pub(crate) fn records(thread: &str) -> Result<Vec<Value>> {
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    read_records(thread)
}
fn read_records(thread: &str) -> Result<Vec<Value>> {
    let dir = directory(thread)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut rows = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter(|e| {
            e.as_ref()
                .map_or(true, |e| e.path().extension().is_some_and(|v| v == "json"))
        })
        .map(|e| e.map_err(|e| e.to_string()).and_then(|e| load(&e.path())))
        .collect::<Result<Vec<_>>>()?;
    rows.sort_by_key(|r| string(r, "submittedAt").to_owned());
    Ok(rows)
}
pub(crate) fn record(receipt: &Value) -> Result<()> {
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    let mut row = receipt["task"]["dispatch"].clone();
    for key in ["requestId", "threadId", "turnId", "dispatchMode"] {
        row[key] = receipt[key].clone();
    }
    row["agent"] = receipt["agent"]
        .as_str()
        .map_or(json!("codex"), |v| json!(v));
    row["taskId"] = receipt
        .get("taskId")
        .unwrap_or(&receipt["threadId"])
        .clone();
    if row["options"].is_null() {
        row["options"] = json!({});
    }
    row["configurationEvidence"] = json!(if row["dispatchMode"] == "steered" {
        "active-turn-settings"
    } else {
        "submitted-to-native"
    });
    let write = || -> Result<()> {
        let dir = directory(string(receipt, "threadId"))?;
        uuid::Uuid::parse_str(string(receipt, "requestId")).map_err(|_| "INVALID_REQUEST_ID")?;
        let previous = read_records(string(receipt, "threadId"))?;
        row["purpose"] = receipt["arguments"]
            .get("purpose")
            .cloned()
            .or_else(|| previous.last().and_then(|r| r.get("purpose")).cloned())
            .unwrap_or(json!("task"));
        if row["dispatchMode"] == "new-turn" {
            let rework = previous
                .iter()
                .filter(|r| r["review"]["verdict"] == "rework")
                .filter(|r| {
                    !previous.iter().any(|next| {
                        next["dispatchMode"] == "new-turn"
                            && next.get("submission").is_none_or(|v| v == "accepted")
                            && string(next, "submittedAt") > string(&r["review"], "reviewedAt")
                    })
                })
                .max_by_key(|r| string(&r["review"], "reviewedAt"));
            if let Some(rework) = rework {
                row["reworkOf"] = rework["turnId"].clone();
            }
        }
        save(
            &dir.join(format!("{}.json", string(receipt, "requestId"))),
            &row,
        )
    };
    let mut write = write;
    write().map_err(|e| format!("SUBMISSION_UNCONFIRMED: dispatch accepted; record failed: {e}"))
}
/// Register observed native work without pretending ARC submitted another request.
pub(crate) fn record_native_retry(thread: &str, previous: &str, retry: &Value) -> Result<bool> {
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    let rows = read_records(thread)?;
    let turn = string(retry, "turnId");
    if let Some(row) = rows.iter().find(|r| r["turnId"] == turn) {
        return Ok(row["dispatchSource"] == "native-retry" && row["retryOf"] == previous);
    }
    let Some(parent) = rows.iter().rev().find(|r| r["turnId"] == previous) else {
        return Ok(false);
    };
    uuid::Uuid::parse_str(turn).map_err(|_| "INVALID_TURN_ID")?;
    let started = retry["startedAt"]
        .as_i64()
        .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
        .ok_or("NATIVE_RETRY_START_MISSING")?;
    let config = &retry["configuration"];
    let row = json!({
        "agent":"codex","taskId":thread,"options":{},"requestId":turn,"threadId":thread,"turnId":turn,"dispatchMode":"new-turn",
        "dispatchSource":"native-retry","retryOf":previous,"nativeTrigger":retry["trigger"],
        "model":config["model"],"effort":config["effort"],"serviceTier":config["serviceTier"],
        "source":{"model":"native-persisted-turn-context","effort":"native-persisted-turn-context","serviceTier":"native-persisted-turn-context"},
        "configurationEvidence":"native-persisted-turn-context","effectiveConfiguration":config,
        "submittedAt":started.to_rfc3339(),"observedAt":now(),
        "purpose":parent["purpose"],"reason":"Native retry of failed or interrupted ARC dispatch"
    });
    save(&directory(thread)?.join(format!("{turn}.json")), &row)?;
    Ok(true)
}
pub(crate) async fn complete(
    c: &control::Control,
    thread: &str,
    turn: &str,
    state: &str,
) -> Result<Value> {
    if !records(thread)?.iter().any(|r| r["turnId"] == turn) {
        return Ok(Value::Null);
    }
    let configuration = match c
        .request(
            "thread/read",
            json!({"threadId":thread,"includeTurns":false}),
            5000,
        )
        .await
    {
        Ok(t) => control::turn_configurations(&t["thread"]).remove(turn),
        Err(_) => None,
    };
    // Re-read under the same lock as reviews; observation must never erase a later verdict.
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    let mut rows = read_records(thread)?
        .into_iter()
        .filter(|r| r["turnId"] == turn)
        .collect::<Vec<_>>();
    for row in &mut rows {
        if row["terminal"].is_null() {
            let end = chrono::Utc::now();
            let elapsed = chrono::DateTime::parse_from_rfc3339(string(row, "submittedAt"))
                .ok()
                .map(|start| {
                    (end - start.with_timezone(&chrono::Utc))
                        .num_milliseconds()
                        .max(0)
                });
            row["terminal"] =
                json!({"state":state,"observedAt":end.to_rfc3339(),"observedDurationMs":elapsed});
        }
        if let Some(config) = &configuration {
            row["effectiveConfiguration"] = json!({"model":config["model"],"effort":config["effort"],"serviceTier":config["serviceTier"],"threadServiceTier":config["threadServiceTier"],"source":config["source"]});
        }
        save(
            &directory(thread)?.join(format!("{}.json", string(row, "requestId"))),
            row,
        )?;
    }
    Ok(json!(rows))
}

pub(crate) async fn review(c: &control::Control, args: &Value) -> Result<Value> {
    let thread = string(args, "threadId");
    directory(thread)?;
    let mut cursor = Value::Null;
    let selected = loop {
        let page = c.request("thread/turns/list",
            json!({"threadId":thread,"limit":20,"sortDirection":"desc","itemsView":"notLoaded","cursor":cursor}), 10000).await?;
        let turns = page["data"].as_array().ok_or("NATIVE_TURNS_MISSING")?;
        if let Some(turn) = turns.iter().find(|t| {
            if args["turnId"].is_string() {
                t["id"] == args["turnId"]
            } else {
                matches!(
                    string(t, "status"),
                    "completed" | "failed" | "interrupted" | "cancelled"
                )
            }
        }) {
            if !matches!(
                string(turn, "status"),
                "completed" | "failed" | "interrupted" | "cancelled"
            ) {
                return Err("REVIEW_REQUIRES_TERMINAL_TURN".into());
            }
            break turn.clone();
        }
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            return Err("REVIEW_TERMINAL_TURN_NOT_FOUND".into());
        }
    };
    let turn = string(&selected, "id");
    let state = match string(&selected, "status") {
        "interrupted" => "cancelled",
        other => other,
    };
    complete(c, thread, turn, state).await?;
    save_review(thread, turn, args)
}
fn save_review(thread: &str, turn: &str, args: &Value) -> Result<Value> {
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    let mut rows = read_records(thread)?
        .into_iter()
        .filter(|r| r["turnId"] == turn)
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return Err("REVIEW_DISPATCH_NOT_FOUND: only ARC-dispatched turns can be reviewed".into());
    }
    let review = json!({"verdict":args["verdict"],"note":args["note"],"reviewedAt":now(),"requestId":args["requestId"]});
    for row in &mut rows {
        row["review"] = review.clone();
        save(
            &directory(thread)?.join(format!("{}.json", string(row, "requestId"))),
            row,
        )?;
    }
    Ok(json!({"threadId":thread,"turnId":turn,"review":review}))
}

/// Snapshot at submission; later session changes never rewrite this turn's choices.
pub(crate) fn agent_record(task: &Value, args: &Value) -> Result<()> {
    record(
        &json!({"agent":task["agent"],"taskId":task["taskId"],"threadId":task["taskId"],
        "turnId":task["turnId"],"requestId":args["requestId"],"dispatchMode":"new-turn",
        "arguments":args,"task":{"dispatch":task["dispatch"]}}),
    )
}
pub(crate) fn agent_observe(task: &Value, submission: Option<&str>) -> Result<()> {
    let _guard = RECORDS_LOCK.lock().map_err(|e| e.to_string())?;
    let task_id = string(task, "taskId");
    for mut row in read_records(task_id)?
        .into_iter()
        .filter(|r| r["turnId"] == task["turnId"] && r["agent"] == task["agent"])
    {
        if let Some(status) = submission {
            row["submission"] = json!(status);
        }
        let state = string(task, "status");
        if matches!(state, "completed" | "cancelled" | "failed")
            && row["terminal"].is_null()
            && row["submission"] == "accepted"
        {
            let end = chrono::Utc::now();
            let elapsed = chrono::DateTime::parse_from_rfc3339(string(&row, "submittedAt"))
                .ok()
                .map(|start| {
                    (end - start.with_timezone(&chrono::Utc))
                        .num_milliseconds()
                        .max(0)
                });
            row["terminal"] =
                json!({"state":state,"observedAt":end.to_rfc3339(),"observedDurationMs":elapsed});
        }
        if task["turnEvidence"].is_object() {
            row["turnEvidence"] = task["turnEvidence"].clone();
        }
        if task["agent"] == "pi"
            && task["lastMessage"]["model"].is_string()
            && task["lastMessage"]["provider"].is_string()
        {
            let message = &task["lastMessage"];
            row["turnEvidence"] = json!({"model":format!("{}/{}",string(message,"provider"),string(message,"model")),"source":"pi-assistant-message","scope":"turn","observedAt":now()});
        }
        save(
            &directory(task_id)?.join(format!("{}.json", string(&row, "requestId"))),
            &row,
        )?;
    }
    Ok(())
}
pub(crate) fn agent_review(args: &Value) -> Result<Value> {
    let task = string(args, "taskId");
    let rows = records(task)?;
    let row = rows
        .iter()
        .rev()
        .find(|r| {
            r["agent"] == args["agent"]
                && if args["turnId"].is_string() {
                    r["turnId"] == args["turnId"]
                } else {
                    r["terminal"].is_object()
                }
        })
        .ok_or("REVIEW_DISPATCH_NOT_FOUND")?;
    if !row["terminal"].is_object() {
        return Err("REVIEW_REQUIRES_TERMINAL_TURN".into());
    }
    let mut result = save_review(task, string(row, "turnId"), args)?;
    result.as_object_mut().unwrap().remove("threadId");
    result["agent"] = args["agent"].clone();
    result["taskId"] = json!(task);
    Ok(result)
}
