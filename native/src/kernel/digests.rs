//! Owner-specific metadata projections over immutable, authorized list snapshots.
use crate::*;
// Egress adds arcVersion after projection. Reserve its envelope space.
const BUDGET: usize = 8 * 1024 - 256;
const ROWS: usize = 20;

pub(crate) fn supports(op: &str, args: &Value) -> bool {
    match op {
        "codex_thread" => matches!(
            string(args, "action"),
            "search" | "timeline" | "backgroundTerminals/list"
        ),
        "notify_status" | "ax_list" | "codex_tasks" | "agent_tasks" | "board" | "messages"
        | "events" | "src_conversations" | "projects" | "mcp_tools" | "accounts" => true,
        _ => false,
    }
}
fn detail_read(op: &str, args: &Value) -> bool {
    matches!(op, "ax_list" | "board" | "accounts") && args["id"].is_string()
        || op == "mcp_tools" && args["tool"].is_string()
        || op == "messages" && args["recoveryMessageId"].is_string()
}
pub(crate) fn requested(op: &str, args: &Value, value: &Value) -> bool {
    supports(op, args)
        && !detail_read(op, args)
        && value.get("error").is_none()
        && (args["view"] == "digest"
            || (args["view"].is_null() && value.to_string().len() > 12 * 1024))
}
fn action(op: &str, args: Value) -> Value {
    json!({"via":"query","op":op,"args":args})
}
fn count(value: usize, kind: &str) -> Value {
    json!({"value":value,"kind":kind})
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("unknown")
}
fn line(s: String) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(180)
        .collect()
}
fn state(v: &Value) -> &str {
    v["state"]
        .as_str()
        .or(v["status"].as_str())
        .or(v["status"]["type"].as_str())
        .unwrap_or("unknown")
}
fn attention(s: &str) -> bool {
    matches!(
        s,
        "failed"
            | "error"
            | "attention"
            | "needs-input"
            | "interaction-required"
            | "systemError"
            | "waitingOnApproval"
            | "waitingOnUserInput"
            | "unconfirmed"
            | "unverified"
            | "blocked"
            | "stale"
            | "open"
            | "candidate"
            | "pending"
    )
}
struct Row {
    id: String,
    state: String,
    summary: String,
    actionable: bool,
    full: Value,
    detail: Option<Value>,
}
fn row(kind: &str, id: &Value, value: &Value, summary: String, actionable: bool) -> Row {
    let id = id
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| hash(value.to_string()));
    let id = format!("{kind}:{id}");
    Row {
        id: if id.len() > 512 { hash(&id) } else { id },
        state: state(value).into(),
        summary: line(summary),
        actionable,
        full: value.clone(),
        detail: None,
    }
}
fn array<'a>(value: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    value[key].as_array().into_iter().flatten()
}
fn project(op: &str, args: &Value, value: &Value) -> Vec<Row> {
    let mut rows = Vec::new();
    match op {
        "ax_list" => {
            for v in array(value, "entries") {
                let mut r = row(
                    "ax",
                    &v["id"],
                    v,
                    format!("{} {}", text(&v["severity"]), state(v)),
                    matches!(state(v), "open" | "triaged" | "candidate"),
                );
                r.id = text(&v["id"]).into();
                r.detail = Some(action(op, json!({"id":v["id"],"view":"full"})));
                rows.push(r);
            }
        }
        "codex_tasks" | "agent_tasks" => {
            for v in array(value, "tasks") {
                let id = v
                    .get("threadId")
                    .or(v.get("taskId"))
                    .or(v.get("id"))
                    .unwrap_or(&Value::Null);
                let turn = v
                    .get("currentTurn")
                    .or(v.get("latestTurn"))
                    .unwrap_or(&Value::Null);
                let interactions = v["pendingInteractions"]
                    .as_array()
                    .map(Vec::len)
                    .or(v["pending"].as_array().map(Vec::len));
                let mut r = row(
                    "task",
                    id,
                    v,
                    format!(
                        "{}; selected turn {}; interactions {}",
                        state(v),
                        turn["status"]
                            .as_str()
                            .or_else(|| (op == "agent_tasks" && v["turnId"].is_string())
                                .then(|| state(v)))
                            .unwrap_or("unknown"),
                        interactions
                            .map(|n| n.to_string())
                            .unwrap_or_else(|| "unknown".into())
                    ),
                    attention(state(v)) || interactions.is_some_and(|n| n > 0),
                );
                if id.is_string() {
                    let mut a = if op == "codex_tasks" {
                        json!({"threadId":id})
                    } else {
                        json!({"agent":args["agent"],"taskId":id})
                    };
                    if op == "codex_tasks" {
                        if let Some(turn) = turn["turnId"].as_str().or(v["turnId"].as_str()) {
                            a["turnId"] = json!(turn);
                        }
                    }
                    r.detail = Some(action(
                        if op == "codex_tasks" {
                            "codex_read"
                        } else {
                            "agent_read"
                        },
                        a,
                    ));
                }
                rows.push(r);
            }
        }
        "notify_status" => {
            for kind in [
                "targets",
                "threads",
                "subscriptions",
                "deliveries",
                "unboundPending",
            ] {
                for v in array(value, kind) {
                    let s = if kind == "targets" {
                        text(&v["reachability"])
                    } else if kind == "threads" {
                        if v["diagnosis"]["terminal"] == true {
                            "terminal"
                        } else if v["diagnosis"]["scope"]["active"] == false {
                            "ended"
                        } else {
                            "pending"
                        }
                    } else if kind == "subscriptions" {
                        if v["muted"] == true {
                            "muted"
                        } else if v["active"] == true {
                            "active"
                        } else {
                            "expired"
                        }
                    } else if kind == "unboundPending" {
                        "pending"
                    } else {
                        state(v)
                    };
                    // Route addresses only contribute to an opaque identity, never to display or actions.
                    let identity = match kind {
                        "targets" => json!([v["channel"], v["target"]]),
                        "threads" => v["threadId"].clone(),
                        "subscriptions" => v["id"].clone(),
                        _ => json!([
                            v["eventId"],
                            v["channel"],
                            v["target"],
                            v["subscriptionId"],
                            v["threadId"],
                            v["turnId"]
                        ]),
                    };
                    let pending = array(v, "pending").count();
                    let reasons = array(&v["diagnosis"], "reasons")
                        .filter_map(Value::as_str)
                        .take(3)
                        .collect::<Vec<_>>()
                        .join(",");
                    let active = reasons.contains("conflict")
                        || reasons.contains("unavailable")
                        || (if kind == "deliveries" {
                            matches!(s, "pending" | "sending")
                        } else {
                            attention(s) && (kind != "targets" || v["supersededBy"].is_null())
                        })
                        || pending > 0
                        || v["breaker"] == true
                        || v["escalated"] == true
                        || kind == "unboundPending";
                    let mut r = row(
                        kind,
                        &json!(hash(identity.to_string())),
                        v,
                        format!(
                            "{kind}: {s}; {reasons}; pending {pending}; breaker {}; escalated {}",
                            v["breaker"] == true,
                            v["escalated"] == true
                        ),
                        active,
                    );
                    r.state = s.into();
                    rows.push(r);
                }
            }
        }
        "board" => {
            for kind in ["blockers", "notices", "attention"] {
                for v in (if kind == "attention" {
                    &value["attention"]["items"]
                } else {
                    &value[kind]
                })
                .as_array()
                .into_iter()
                .flatten()
                {
                    let conflicts = v["conflictCount"]
                        .as_u64()
                        .map(|n| n as usize)
                        .unwrap_or_else(|| array(v, "conflicts").count());
                    let conflict_summary =
                        if v["conflicts"].is_array() || v["conflictCount"].is_number() {
                            conflicts.to_string()
                        } else {
                            "unknown".into()
                        };
                    let mut r = row(
                        kind,
                        &v["id"],
                        v,
                        format!("{kind}: {}; conflicts {conflict_summary}", state(v)),
                        kind != "notices" || conflicts > 0,
                    );
                    if kind != "attention" {
                        r.detail = Some(action(op, json!({"id":v["id"],"view":"full"})));
                    }
                    rows.push(r);
                }
            }
        }
        "messages" => {
            for v in array(value, "messages") {
                let s = text(&v["deliveryState"]);
                let mut r = row(
                    "message",
                    &v["messageId"],
                    v,
                    format!(
                        "{}; delivery {s}; unread unknown; escalated {}",
                        text(&v["type"]),
                        v["escalated"] == true
                    ),
                    v["escalated"] == true || attention(s),
                );
                r.state = s.into();
                rows.push(r);
            }
        }
        "events" => {
            for v in array(value, "events") {
                let kind = text(&v["kind"]);
                let resources = array(v, "resources")
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",");
                let mut r = row(
                    "event",
                    v.get("id").or(v.get("eventId")).unwrap_or(&Value::Null),
                    v,
                    format!("{kind}; resources {resources}"),
                    kind.contains("failed")
                        || kind.contains("stalled")
                        || kind.contains("unconfirmed"),
                );
                r.state = kind.into();
                rows.push(r);
            }
        }
        "accounts" => {
            for v in array(value, "accounts") {
                let profiles: Vec<_> = array(v, "agentProfiles")
                    .filter(|p| args["agent"].is_null() || p["agent"] == args["agent"])
                    .collect();
                let health = text(&v["health"]["state"]);
                let quota = text(&v["quota"]["state"]);
                let used = array(&v["quota"], "windows")
                    .filter_map(|w| w["usedPercent"].as_f64())
                    .reduce(f64::max);
                let quota_summary = used
                    .map(|n| format!("{quota} max-used {n}%"))
                    .unwrap_or_else(|| format!("{quota} usage unknown"));
                // One row per account and Agent keeps defaults interpretable across providers.
                let agents: std::collections::BTreeSet<_> = profiles
                    .iter()
                    .map(|p| text(&p["agent"]))
                    .chain(profiles.is_empty().then_some("none"))
                    .collect();
                for agent in agents {
                    let matching: Vec<_> =
                        profiles.iter().filter(|p| p["agent"] == agent).collect();
                    let default = matching.iter().any(|p| p["default"] == true);
                    let profile_attention = matching.iter().any(|p| p["state"] != "signed-in");
                    let mut r = row(
                        "account",
                        &json!(format!("{}:{agent}", text(&v["id"]))),
                        v,
                        format!(
                            "{agent}; health {health}; quota {quota_summary}; default {default}"
                        ),
                        attention(health)
                            || used.is_some_and(|n| n >= 100.0)
                            || matches!(quota, "exhausted" | "unavailable")
                            || profile_attention,
                    );
                    r.state = health.into();
                    r.detail = Some(action(op, json!({"id":v["id"],"view":"full"})));
                    rows.push(r);
                }
            }
        }
        "src_conversations" => {
            for v in array(value, "accounts") {
                let mut r = row(
                    "source-account",
                    &v["accountId"],
                    v,
                    format!(
                        "{}; conversations {}",
                        state(v),
                        array(v, "conversations").count()
                    ),
                    !matches!(state(v), "signed-in" | "unsupported"),
                );
                r.detail = Some(action(
                    op,
                    json!({"accountId":v["accountId"],"view":"full"}),
                ));
                rows.push(r);
                for c in array(v, "conversations") {
                    let mut r = row(
                        "conversation",
                        &json!(format!(
                            "{}:{}:{}",
                            text(&v["accountId"]),
                            text(&c["kind"]),
                            text(&c["id"])
                        )),
                        c,
                        format!(
                            "{}; linked tasks {}",
                            text(&c["kind"]),
                            array(c, "taskRefs").count()
                        ),
                        false,
                    );
                    r.state = "observed".into();
                    rows.push(r);
                }
            }
        }
        "projects" => {
            for v in array(value, "projects") {
                let mut r = row(
                    "project",
                    &v["id"],
                    v,
                    format!("registered; roots {}", array(v, "roots").count()),
                    false,
                );
                r.state = "registered".into();
                rows.push(r);
            }
        }
        "mcp_tools" => {
            let servers: Vec<_> = if value["servers"].is_array() {
                array(value, "servers").collect()
            } else {
                vec![value]
            };
            for v in servers {
                let mut r = row(
                    "server",
                    &v["name"],
                    v,
                    format!("{}; tools {}", state(v), array(v, "tools").count()),
                    !matches!(state(v), "ready" | "disabled"),
                );
                r.detail = Some(action(op, json!({"server":v["name"],"view":"full"})));
                rows.push(r);
                for t in array(v, "tools") {
                    let mut r = row(
                        "tool",
                        &json!(format!("{}:{}", text(&v["name"]), text(&t["name"]))),
                        t,
                        format!(
                            "{}; readOnly {}; destructive {}",
                            state(v),
                            t["readOnly"]
                                .as_bool()
                                .or(t["annotations"]["readOnlyHint"].as_bool())
                                .map(|v| v.to_string())
                                .unwrap_or_else(|| "unknown".into()),
                            t["destructive"]
                                .as_bool()
                                .or(t["annotations"]["destructiveHint"].as_bool())
                                .map(|v| v.to_string())
                                .unwrap_or_else(|| "unknown".into())
                        ),
                        false,
                    );
                    r.state = state(v).into();
                    r.detail = Some(action(
                        op,
                        json!({"server":v["name"],"tool":t["name"],"view":"full"}),
                    ));
                    rows.push(r);
                }
            }
        }
        "codex_thread" => {
            for v in array(value, "data") {
                let r = match string(args, "action") {
                    "search" => {
                        let thread = &v["thread"];
                        let mut r = row(
                            "thread",
                            &thread["id"],
                            v,
                            format!("search; {}", state(thread)),
                            attention(state(thread)),
                        );
                        r.state = state(thread).into();
                        r.detail = Some(action("codex_read", json!({"threadId":thread["id"]})));
                        r
                    }
                    "timeline" => {
                        let identity =
                            hash(json!([args["params"]["threadId"], v["position"]]).to_string());
                        let status = v["status"]
                            .as_str()
                            .or(v["item"]["status"].as_str())
                            .unwrap_or_else(|| text(&v["type"]));
                        let mut r = row(
                            "timeline",
                            &json!(identity),
                            v,
                            format!("{}; {status}", text(&v["type"])),
                            attention(status),
                        );
                        r.state = status.into();
                        r
                    }
                    _ => {
                        let identity = json!(format!(
                            "{}:{}",
                            text(&args["params"]["threadId"]),
                            text(&v["processId"])
                        ));
                        let cpu = v["cpuPercent"]
                            .as_f64()
                            .map(|n| n.to_string())
                            .unwrap_or_else(|| "unknown".into());
                        let rss = v["rssKb"]
                            .as_u64()
                            .map(|n| n.to_string())
                            .unwrap_or_else(|| "unknown".into());
                        let mut r = row(
                            "terminal",
                            &identity,
                            v,
                            format!("background terminal; CPU {cpu}%; RSS {rss} KiB"),
                            false,
                        );
                        r.state = "listed".into();
                        r
                    }
                };
                rows.push(r);
            }
        }
        _ => (),
    }
    rows.sort_by(|a, b| b.actionable.cmp(&a.actionable).then(a.id.cmp(&b.id)));
    rows
}
fn restart(op: &str, args: &Value) -> Value {
    let mut a = args.clone();
    if let Some(a) = a.as_object_mut() {
        for key in ["digestCursor", "cursor", "since", "offset"] {
            a.remove(key);
        }
    }
    if let Some(params) = a.get_mut("params").and_then(Value::as_object_mut) {
        params.remove("cursor");
    }
    a["view"] = json!("digest");
    action(op, a)
}
fn scope(origin: &Value) -> String {
    hash(origin["sourceId"].to_string())
}
fn cursor_action(op: &str, args: &Value, output: &str, offset: usize, full: bool) -> Value {
    // Only schema-required dispatch selectors accompany the opaque cursor.
    let mut a =
        json!({"view":if full{"full"}else{"digest"},"digestCursor":format!("{output}:{offset}")});
    if op == "agent_tasks" {
        a["agent"] = args["agent"].clone();
    }
    if op == "codex_thread" {
        a["action"] = args["action"].clone();
        if args["params"]["threadId"].is_string() {
            a["params"] = json!({"threadId":args["params"]["threadId"]});
        } else if args["action"] == "search" {
            a["params"] = json!({"searchTerm":""});
        }
    }
    action(op, a)
}
fn upstream(op: &str, args: &Value, value: &Value) -> Value {
    let mut a = args.clone();
    if value["hasMore"] != false && !value["nextCursor"].is_null() {
        if op == "codex_thread" {
            a["params"]["cursor"] = value["nextCursor"].clone();
        } else {
            a[if op == "events" { "since" } else { "cursor" }] = value["nextCursor"].clone();
        }
    } else if value["nextOffset"].is_number() {
        a["offset"] = value["nextOffset"].clone();
    } else {
        return Value::Null;
    }
    action(op, a)
}
pub(crate) fn present(op: &str, args: &Value, value: Value, origin: &Value) -> Result<Value> {
    let snapshot = json!({"op":op,"args":args,"scope":scope(origin),"value":value});
    let output = super::results::save_digest(&snapshot)?;
    render(&output, &snapshot, 0)
}
fn render(output: &str, snapshot: &Value, offset: usize) -> Result<Value> {
    let op = string(snapshot, "op");
    let args = &snapshot["args"];
    let value = &snapshot["value"];
    let rows = project(op, args, value);
    let upstream = upstream(op, args, value);
    let partial = !upstream.is_null()
        || matches!(op, "events" | "codex_tasks" | "codex_thread")
        || op == "notify_status"
            && value["summary"]["hidden"]
                .as_object()
                .is_some_and(|o| o.values().any(|n| n.as_u64().unwrap_or(0) > 0));
    let mut out = json!({"view":"digest","revision":output,"counts":{"rows":count(rows.len(),if partial{"bounded"}else{"exact"}),"actionable":count(rows.iter().filter(|r|r.actionable).count(),if partial{"bounded"}else{"exact"})},"rows":[],"omitted":{},"coverage":{"scope":"authorized-filtered-snapshot","ordering":"actionable-first-within-snapshot","countsScope":"snapshot-rows-unless-owner-total","owner":op,"extent":if partial{"bounded"}else{"complete"}},"next":null});
    if op == "agent_tasks" && value["total"].is_number() {
        out["counts"]["total"] = json!({"value":value["total"],"kind":"exact"});
    }
    // Owner diagnostics remain bounded metadata; bodies, addresses and credentials are excluded.
    if op == "notify_status" {
        out["coverage"]["history"] = json!(if args["all"] == true {
            "all"
        } else {
            "owner-window"
        });
    }
    if op == "messages" {
        out["counts"]["unread"] = json!({"value":null,"kind":"unknown"});
    }
    for field in ["activityCoverage", "conflictCoverage", "projectionPending"] {
        if value[field].is_boolean() || value[field].as_str().is_some_and(|s| s.len() < 64) {
            out["coverage"][field] = value[field].clone();
        }
    }
    if value["coverage"].is_object() {
        for (key, v) in value["coverage"].as_object().unwrap().iter().take(8) {
            if key.len() < 64 && (v.is_boolean() || v.as_str().is_some_and(|s| s.len() < 64)) {
                out["coverage"][key] = v.clone();
            }
        }
    }
    if op == "board" {
        out["coverage"]["attention"] = json!({
            "bulletin":text(&value["attention"]["coverage"]["bulletin"]),
            "ax":text(&value["attention"]["coverage"]["ax"]),
            "notifications":text(&value["attention"]["coverage"]["notifications"])
        });
    }
    if op == "notify_status" {
        for key in [
            "totalTargets",
            "totalThreads",
            "totalBindings",
            "totalDeliveries",
            "totalSubscriptions",
        ] {
            if value["summary"][key].is_u64() {
                out["counts"][key] = json!({"value":value["summary"][key],"kind":"exact"});
            }
        }
    }
    if op == "notify_status"
        && value["summary"]["hidden"]
            .as_object()
            .is_some_and(|o| o.values().any(|n| n.as_u64().unwrap_or(0) > 0))
    {
        out["coverage"]["expand"] = cursor_action(op, args, output, rows.len() + 1, false);
    }
    if op == "events" && value["oldestCursor"].is_string() {
        out["coverage"]["historyStart"] = cursor_action(op, args, output, rows.len() + 1, false);
    }
    let continuation = action("control_output", json!({"outputId":output,"offset":0}));
    let update = |out: &mut Value, n: usize| {
        let next = if n < rows.len() || !upstream.is_null() {
            cursor_action(op, args, output, n, false)
        } else {
            Value::Null
        };
        out["next"] = next.clone();
        out["omitted"] = json!({"rows":count(rows.len().saturating_sub(n),"exact"),"beyondSnapshot":if partial{"unknown"}else{"none"},"page":next,"full":continuation});
    };
    update(&mut out, offset);
    for (i, r) in rows.iter().enumerate().skip(offset).take(ROWS) {
        let detail = cursor_action(op, args, output, i, true);
        let mut projected = json!({"id":if r.id.len()>512 {hash(&r.id)}else{r.id.clone()},"state":line(r.state.clone()),"summary":r.summary,"actionable":r.actionable,"detail":detail});
        if let Some(read) = &r.detail {
            if read.to_string().len() < 1024 {
                projected["read"] = read.clone();
            }
        }
        if op == "ax_list" {
            let short: String = r.id.chars().take(11).collect();
            if rows.iter().filter(|row| row.id.starts_with(&short)).count() == 1 {
                projected["shortId"] = json!(short);
            }
        }
        // An unbounded upstream identifier/action can be represented by its stable opaque hash.
        if projected.to_string().len() > BUDGET / 2 {
            projected = json!({"id":hash(&r.id),"state":line(r.state.clone()),"detail":cursor_action(op,args,output,i,true),"actionable":r.actionable});
        }
        out["rows"].as_array_mut().unwrap().push(projected);
        update(&mut out, i + 1);
        if out.to_string().len() > BUDGET {
            out["rows"]
                .as_array_mut()
                .unwrap()
                .last_mut()
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove("summary");
            if out.to_string().len() > BUDGET {
                out["rows"].as_array_mut().unwrap().pop();
                update(&mut out, i);
                break;
            }
        }
    }
    Ok(out)
}
pub(crate) enum Resume {
    Value(Value),
    Owner(Value),
}
pub(crate) fn resume(op: &str, args: &Value, origin: &Value) -> Result<Resume> {
    let (output, offset) = string(args, "digestCursor")
        .split_once(':')
        .ok_or("INVALID_DIGEST_CURSOR")?;
    let offset = offset
        .parse::<usize>()
        .map_err(|_| "INVALID_DIGEST_CURSOR")?;
    let snapshot = super::results::load_digest(output)?;
    let Some((snapshot, expired)) = snapshot else {
        return Err(json!({"code":"DIGEST_CURSOR_EXPIRED","message":"Restart the list; this temporary snapshot was evicted","next":restart(op,args)}).to_string());
    };
    if snapshot["op"] != op || snapshot["scope"] != scope(origin) {
        return Err(json!({"code":"DIGEST_SCOPE_CHANGED","message":"Read with the original authorized source or restart the list","next":restart(op,args)}).to_string());
    }
    if expired {
        return Err(json!({"code":"DIGEST_CURSOR_EXPIRED","message":"Restart the list; the temporary snapshot expired","next":restart(op,&snapshot["args"])}).to_string());
    }
    if args["view"] == "full" {
        return project(op, &snapshot["args"], &snapshot["value"])
            .get(offset)
            .map(|r| Resume::Value(json!({"row":r.full})))
            .ok_or("INVALID_DIGEST_CURSOR".into());
    }
    let row_count = project(op, &snapshot["args"], &snapshot["value"]).len();
    if op == "notify_status" && offset == row_count + 1 {
        let mut next = snapshot["args"].clone();
        next["all"] = json!(true);
        return Ok(Resume::Owner(next));
    }
    if op == "events" && offset == row_count + 1 && snapshot["value"]["oldestCursor"].is_string() {
        let mut next = snapshot["args"].clone();
        next["since"] = snapshot["value"]["oldestCursor"].clone();
        return Ok(Resume::Owner(next));
    }
    if offset == row_count {
        let next = upstream(op, &snapshot["args"], &snapshot["value"]);
        if next.is_object() {
            return Ok(Resume::Owner(next["args"].clone()));
        }
    }
    render(output, &snapshot, offset).map(Resume::Value)
}
pub(super) fn output(snapshot: &Value) -> Result<Value> {
    if snapshot["scope"] != scope(&crate::kernel::origin::current_origin()) {
        return Err("DIGEST_SCOPE_CHANGED: read with the original authorized source".into());
    }
    Ok(snapshot["value"].clone())
}
pub(super) fn expired(snapshot: &Value) -> String {
    json!({"code":"OUTPUT_EXPIRED","next":restart(string(snapshot,"op"),&snapshot["args"])})
        .to_string()
}
