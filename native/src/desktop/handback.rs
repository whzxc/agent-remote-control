//! Reconcile ARC's subscription after its recorded Desktop process exits.
use super::daemon;
use crate::{control::Control, kernel::file_cache, rpc::Rpc, *};
use futures_util::{stream, StreamExt};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};
use tokio::time::Instant;

fn path(directory: &str, thread: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(thread).map_err(|_| "INVALID_THREAD_ID")?;
    Ok(root().join(directory).join(format!("{thread}.json")))
}

fn record(directory: &str, thread: &str) -> Result<Option<Value>> {
    let p = path(directory, thread)?;
    if !p.try_exists().map_err(|e| e.to_string())? {
        return Ok(None);
    }
    file_cache::load(&p).map(Some)
}

pub(crate) fn observation(thread: &str) -> Result<Option<Value>> {
    let previous = record("desktop-handback", thread)?;
    let binding = record("execution", thread)?.unwrap_or_default();
    // Route acquisition commits in one atomic execution record. Even after a
    // Core restart, an old release acknowledgement cannot override that owner.
    if let Some(from) = binding.get("continuedFrom") {
        let old = previous.as_ref().unwrap_or(&Value::Null);
        if old.is_null() || old["instance"] == *from {
            let mut current = old.clone();
            current["rootThreadId"] = binding["handbackRoot"].clone();
            if binding["transport"] == "local-daemon" {
                current = json!({"rootThreadId":binding["handbackRoot"],"state":"in-instance",
                    "instance":binding["desktopTarget"],"previousOwnHold":old["ownHold"]});
            } else {
                current["instance"] = from.clone();
                current["state"] = json!("continued");
            }
            return Ok(Some(current));
        }
    }
    Ok(previous)
}

fn publish(thread: &str, value: &Value) -> Result<()> {
    if record("desktop-handback", thread)?.as_ref() != Some(value) {
        save(&path("desktop-handback", thread)?, value)?;
    }
    Ok(())
}

// Missing proc_pidinfo alone can mean an inaccessible process.
fn exited(target: &Value) -> bool {
    let Some(pid) = target["pid"]
        .as_u64()
        .and_then(|p| i32::try_from(p).ok())
        .filter(|p| *p > 0)
    else {
        return false;
    };
    let Some(start) = target["start"].as_str().filter(|s| !s.is_empty()) else {
        return false;
    };
    if let Some(current) = crate::codex_host::process_start(pid as u32) {
        return current != start;
    }
    unsafe {
        libc::kill(pid, 0) != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
}

pub(crate) fn live_target(thread: &str) -> Option<Value> {
    let status = observation(thread).ok().flatten();
    let target = if let Some(status) = status {
        status["instance"].clone()
    } else {
        let binding = file_cache::load(&path("execution", thread).ok()?).ok()?;
        binding
            .get("desktopInstance")
            .or(binding.get("desktopTarget"))?
            .clone()
    };
    let pid = u32::try_from(target["pid"].as_u64()?).ok()?;
    (crate::codex_host::process_start(pid)? == target["start"].as_str()?).then_some(target)
}

pub(crate) fn returned_instance(thread: &str) -> Result<Option<Value>> {
    if uuid::Uuid::parse_str(thread).is_err() {
        return Ok(None);
    }
    if let Some(status) = observation(thread)? {
        if status["state"] == "continued" {
            return Ok(None);
        }
        return Ok(exited(&status["instance"]).then(|| status["instance"].clone()));
    }
    Ok(record("execution", thread)?
        .and_then(|r| exited(&r["desktopInstance"]).then(|| r["desktopInstance"].clone())))
}

async fn require_unheld(thread: &str) -> Result<()> {
    let mut lock = crate::writer::probe(thread);
    if lock["state"] == "unheld" {
        return Ok(());
    }
    if lock["state"] == "held" {
        let process = holder(thread).await;
        if process["origin"] == "main-desktop" {
            return Err(json!({"code":"DESKTOP_TASK_HANDED_BACK","message":"This task is in use in your main Desktop. ARC did not deliver the input.",
                "threadId":thread,"next":{"via":"query","op":"codex_owner","args":{"threadId":thread}}}).to_string());
        }
        include_holder(&mut lock, &process);
        lock["owner"] = json!("external");
    }
    Err(crate::writer::busy(thread, lock).to_string())
}

pub(crate) async fn check_send(thread: &str) -> Result<()> {
    if returned_instance(thread)?.is_some() {
        require_unheld(thread).await?;
    }
    Ok(())
}

async fn descendants(rpc: &Rpc, thread: &str) -> Result<Vec<(String, String)>> {
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = Value::Null;
    loop {
        let page = rpc
            .call(
                "thread/list",
                json!({"ancestorThreadId":thread,"sourceKinds":["subAgentThreadSpawn"],
            "modelProviders":[],"limit":100,"cursor":cursor}),
                5000,
            )
            .await?;
        for row in page["data"]
            .as_array()
            .ok_or("DESKTOP_HANDBACK_INVALID_THREAD_LIST")?
        {
            let id = string(row, "id");
            uuid::Uuid::parse_str(id).map_err(|_| "DESKTOP_HANDBACK_INVALID_DESCENDANT")?;
            if id == thread {
                return Err("DESKTOP_HANDBACK_INVALID_DESCENDANT".into());
            }
            let parent = row
                .pointer("/source/subAgent/thread_spawn/parent_thread_id")
                .and_then(Value::as_str)
                .ok_or("DESKTOP_HANDBACK_PARENT_MISSING")?;
            ids.push((id.to_owned(), parent.to_owned()));
        }
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
        if !seen.insert(cursor.to_string()) {
            return Err("DESKTOP_HANDBACK_CURSOR_REPEATED".into());
        }
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

// A newly spawned descendant inherits the instance of its nearest tracked
// ancestor. A reopened sibling never changes that assignment.
fn descendant_targets(
    root_id: &str,
    target: &Value,
    edges: Vec<(String, String)>,
) -> Result<Vec<(String, Value)>> {
    let parents: HashMap<_, _> = edges.into_iter().collect();
    let mut targets = HashMap::from([(root_id.to_owned(), target.clone())]);
    for id in parents.keys() {
        if let Some(state) = observation(id)? {
            targets.insert(id.clone(), state["instance"].clone());
        }
    }
    for id in parents.keys() {
        let mut path = Vec::new();
        let mut cursor = id;
        while !targets.contains_key(cursor) {
            if path.len() >= parents.len() {
                return Err("DESKTOP_HANDBACK_INVALID_SPAWN_TREE".into());
            }
            path.push(cursor.clone());
            cursor = parents
                .get(cursor)
                .ok_or("DESKTOP_HANDBACK_PARENT_MISSING")?;
        }
        let owner = targets[cursor].clone();
        for child in path {
            targets.insert(child, owner.clone());
        }
    }
    targets.remove(root_id);
    Ok(targets.into_iter().collect())
}

async fn active(control: &Control, rpc: &Rpc, thread: &str) -> Result<bool> {
    let native = rpc
        .call(
            "thread/read",
            json!({"threadId":thread,"includeTurns":false}),
            3000,
        )
        .await?;
    if native["thread"]["id"] != thread {
        return Err("DESKTOP_HANDBACK_THREAD_MISMATCH".into());
    }
    if control
        .events
        .lock()
        .await
        .pending
        .values()
        .any(|v| v["params"]["threadId"] == thread)
    {
        return Ok(true);
    }
    match native["thread"]["status"]["type"].as_str() {
        Some("active") => Ok(true),
        Some("idle" | "notLoaded") => Ok(false),
        Some("systemError") => {
            let last = rpc.call("thread/turns/list",json!({"threadId":thread,"limit":1,"sortDirection":"desc","itemsView":"notLoaded"}),3000).await?;
            match last["data"][0]["status"].as_str() {
                Some("failed" | "completed" | "interrupted") => Ok(false),
                _ => Err("DESKTOP_HANDBACK_ACTIVITY_UNKNOWN".into()),
            }
        }
        _ => Err("DESKTOP_HANDBACK_ACTIVITY_UNKNOWN".into()),
    }
}

async fn member(
    control: &Control,
    rpc: Option<&Rpc>,
    proxy: &Value,
    thread: &str,
    parent: &str,
    target: &Value,
    reason: &str,
) -> Result<Value> {
    let previous = observation(thread)?.unwrap_or_default();
    if previous["state"] == "continued" {
        return Ok(previous);
    }
    let target = previous.get("instance").unwrap_or(target);
    let mut status = json!({"rootThreadId":parent,"instance":target});
    if !exited(target) {
        status["state"] = json!("in-instance");
        return Ok(status);
    }
    let prior_ack = &previous["ownHold"];
    let session = rpc
        .map(|r| r.connection.as_str())
        .or_else(|| proxy["connection"].as_str());
    if let Some(rpc) = rpc {
        if previous["checkedConnection"].as_str() == session && prior_ack.is_object() {
            status["ownHold"] = prior_ack.clone();
        } else {
            if active(control, rpc, thread).await? {
                if prior_ack.is_object() {
                    status["state"] = json!("held");
                    status["ownHold"] = prior_ack.clone();
                } else {
                    status["state"] = json!("running");
                }
                return Ok(status);
            }
            let reply = rpc
                .call("thread/unsubscribe", json!({"threadId":thread}), 3000)
                .await?;
            if !matches!(
                reply["status"].as_str(),
                Some("unsubscribed" | "notLoaded" | "notSubscribed")
            ) {
                return Err("DESKTOP_HANDBACK_UNCONFIRMED".into());
            }
            status["ownHold"] = json!({"state":"dropped","evidence":"thread/unsubscribe","nativeStatus":reply["status"],
            "connection":rpc.connection,"observedAt":now(),"reason":if previous["state"]=="running" {"turn-settled"} else {reason}});
        }
    } else if exited(proxy) {
        status["ownHold"] = json!({"state":"dropped","evidence":"connection-close","connection":session,
            "observedAt":now(),"reason":reason,"basis":"proxy-process-exited"});
    } else if !prior_ack.is_object() {
        return Err("DESKTOP_HANDBACK_CONNECTION_UNCONFIRMED".into());
    }
    if !prior_ack.is_object() && status["ownHold"]["nativeStatus"] != "unsubscribed" {
        for closed in [
            "desktop-last-disconnect.json",
            "private-last-disconnect.json",
        ]
        .iter()
        .filter_map(|p| file_cache::load(&root().join(p)).ok())
        {
            if closed["connection"].is_string() && closed["connection"] == proxy["connection"] {
                status["ownHold"] = json!({"state":"dropped","evidence":"connection-close",
                    "connection":closed["connection"],"observedAt":closed["observedAt"],"reason":reason,
                    "confirmedAt":now(),"nativeStatus":status["ownHold"]["nativeStatus"]});
            }
        }
    }
    if prior_ack.is_object() && status["ownHold"]["nativeStatus"] != "unsubscribed" {
        status["ownHold"] = prior_ack.clone();
    }
    status["checkedConnection"] = json!(session);
    if status["ownHold"] != previous["ownHold"]
        || status["checkedConnection"] != previous["checkedConnection"]
    {
        status["state"] = json!("unconfirmed");
        publish(thread, &status)?;
    }
    let lock = crate::writer::probe(thread);
    status["state"] = json!(match lock["state"].as_str() {
        Some("unheld") => "handed-back",
        Some("held") => "held",
        _ => "unconfirmed",
    });
    Ok(status)
}

/// Resolve process evidence on diagnosis. A slow or permanently held foreign
/// writer must not delay unsubscribe for another task in the same subtree.
pub(crate) async fn diagnosis(thread: &str, mut status: Value, held: bool) -> Value {
    if held {
        status["holder"] = holder(thread).await;
    }
    if let Some(children) = status["descendants"].as_array_mut() {
        let held: Vec<_> = children
            .iter()
            .enumerate()
            .filter(|(_, v)| v["state"] == "held")
            .map(|(index, v)| (index, string(v, "threadId").to_owned()))
            .collect();
        for (index, evidence) in stream::iter(held)
            .map(|(index, id)| async move { (index, holder(&id).await) })
            .buffer_unordered(8)
            .collect::<Vec<_>>()
            .await
        {
            children[index]["holder"] = evidence;
        }
    }
    status
}

pub(crate) async fn holder(thread: &str) -> Value {
    let processes = crate::writer::processes(thread).await;
    let pids = processes
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["pid"].as_u64())
        .map(|pid| pid.to_string())
        .collect::<Vec<_>>()
        .join(",");
    if pids.is_empty() {
        return json!({"origin":"unknown","processes":processes});
    }
    // A daemon descriptor names the bound path; a client endpoint names its
    // peer. Diagnose this from open descriptors without connecting a client.
    let shared = if let Ok(socket) = daemon::socket() {
        let report = tokio::time::timeout(
            Duration::from_millis(800),
            output("/usr/sbin/lsof", &["-nP", "-a", "-p", &pids, "-U", "-Fn"]),
        )
        .await;
        matches!(report,Ok(Ok(ref rows)) if rows.lines().any(|row|row.strip_prefix('n')==socket.to_str()))
    } else {
        false
    };
    if shared {
        return json!({"origin":"shared-app-server","client":"unknown","processes":processes});
    }
    if let Some((pid, start)) = crate::codex_host::identity("codex-home") {
        if processes
            .as_array()
            .into_iter()
            .flatten()
            .any(|p| p["pid"] == pid)
            && crate::codex_host::process_start(pid).as_deref() == Some(&start)
        {
            return json!({"origin":"arc-app-server","client":"unknown","processes":processes});
        }
    }
    let rows = daemon::process_rows().await.unwrap_or_default();
    let desktop = daemon::instances_in(&rows).unwrap_or_default();
    let by_pid: HashMap<_, _> = rows.iter().map(|row| (row.pid, row)).collect();
    let mut terminal = None;
    let mut nearest_parent = None;
    for process in processes.as_array().into_iter().flatten() {
        let Some(pid) = process["pid"].as_u64().and_then(|p| u32::try_from(p).ok()) else {
            continue;
        };
        let mut current = by_pid.get(&pid).copied();
        let mut seen = HashSet::new();
        let mut tty = None;
        let mut app = None;
        while let Some(row) = current {
            if !seen.insert(row.pid) {
                break;
            }
            if let Some(instance) = desktop.iter().find(|i| i.pid == row.pid && i.running()) {
                let origin = if instance.profile.is_none() {
                    "main-desktop"
                } else {
                    "desktop-profile"
                };
                return json!({"origin":origin,"originPid":row.pid,"processes":processes});
            }
            if row
                .executable
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|s| matches!(s, "sshd" | "sshd-session"))
            {
                return json!({"origin":"ssh","originPid":row.pid,"processes":processes});
            }
            if row.pid != pid
                && nearest_parent.is_none()
                && row
                    .executable
                    .file_name()
                    .is_some_and(|name| name != "?" && name != "??")
            {
                nearest_parent = Some(row);
            }
            if tty.is_none() {
                tty = row.tty.as_deref().map(|name| (name, row.pid));
            }
            if app.is_none() {
                app = terminal_app(&row.executable);
            }
            current = by_pid.get(&row.parent).copied();
        }
        // An sshd ancestor can appear above a shell with a perfectly valid tty.
        // Defer this attribution until every candidate's ancestry has been checked.
        if let Some((name, origin_pid)) = tty {
            terminal.get_or_insert((name, origin_pid, app));
        }
    }
    if let Some((tty, pid, app)) = terminal {
        let mut evidence =
            json!({"origin":"terminal","originPid":pid,"tty":tty,"processes":processes});
        if let Some(app) = app {
            evidence["terminalApp"] = json!(app);
        }
        return evidence;
    }
    let mut evidence = json!({"origin":"unknown","processes":processes});
    if let Some(parent) = nearest_parent {
        evidence["parentPid"] = json!(parent.pid);
        evidence["parentExecutable"] = json!(parent.executable);
    }
    evidence
}

// Only name a recognizable terminal bundle in the process chain. Other .app
// bundles can contain a CLI (for example Python) that allocates its own pty.
fn terminal_app(executable: &Path) -> Option<&Path> {
    executable.ancestors().find(|p| {
        matches!(
            p.file_name().and_then(|s| s.to_str()),
            Some(
                "Terminal.app"
                    | "iTerm.app"
                    | "iTerm2.app"
                    | "Ghostty.app"
                    | "kitty.app"
                    | "Alacritty.app"
                    | "WezTerm.app"
                    | "Warp.app"
                    | "Hyper.app"
                    | "Tabby.app"
            )
        )
    })
}

pub(crate) fn include_holder(owner: &mut Value, holder: &Value) {
    if let (Some(owner), Some(fields)) = (owner.as_object_mut(), holder.as_object()) {
        owner.extend(fields.clone());
    }
}

enum Next {
    Complete,
    ProcessAlive,
    Unsettled,
    Writers(Vec<String>),
}

async fn reconcile(control: &Control, thread: &str, startup: bool) -> Result<Next> {
    let _guard = control.thread_lock(thread).await;
    let binding = file_cache::load(&path("execution", thread)?)?;
    let target = if binding["pendingPreviousSubtree"] == true {
        &binding["continuedFrom"]
    } else {
        &binding["desktopInstance"]
    };
    if target.is_null() {
        return Ok(Next::Complete);
    }
    if !exited(target) {
        return Ok(Next::ProcessAlive);
    }
    let proxy = binding
        .get("previousSubtreeProxy")
        .unwrap_or(&binding["desktopProxy"]);
    let rpc = match control
        .desktop_backend_rpc(
            binding
                .get("previousSubtreeBackend")
                .unwrap_or(&binding["backend"]),
        )
        .await
    {
        Ok(rpc) => Some(rpc),
        Err(_) if exited(proxy) => None,
        Err(error) => return Err(error),
    };
    let reason = if startup {
        "startup-reconciliation"
    } else {
        "instance-exit"
    };
    let parent_result = member(
        control,
        rpc.as_deref(),
        proxy,
        thread,
        thread,
        target,
        reason,
    )
    .await;
    let mut parent = match parent_result {
        Ok(parent) => parent,
        Err(error) => {
            let mut parent = observation(thread)?
                .unwrap_or_else(|| json!({"rootThreadId":thread,"instance":target}));
            parent["state"] = json!("unconfirmed");
            parent["reason"] = json!("activity-or-release-unconfirmed");
            crate::logs::record("WARN", &format!("Desktop handback {thread}: {error}"), None);
            publish(thread, &parent)?;
            parent
        }
    };
    // Check all descendants even when the parent is still active.
    if parent["state"] == "running" {
        publish(thread, &parent)?;
    }
    let targets = |edges| descendant_targets(thread, &parent["instance"], edges);
    let indexed = || crate::archive_index::spawned_descendants(thread).and_then(targets);
    let children = match &rpc {
        Some(rpc) => descendants(rpc, thread)
            .await
            .and_then(targets)
            .or_else(|_| indexed())?,
        None => indexed()?,
    };
    // Only enter lock-only observation after every member has cleared ARC's hold.
    let session = rpc
        .as_ref()
        .map(|r| r.connection.as_str())
        .or_else(|| proxy["connection"].as_str());
    let mut all_released = released(&parent, session);
    let mut held = Vec::new();
    if parent["state"] == "held" {
        held.push(thread.to_owned());
    }
    let mut blockers = Vec::new();
    for (child, result) in stream::iter(children)
        .map(|(child, target)| {
            let rpc = rpc.clone();
            async move {
                let _guard = control.thread_lock(&child).await;
                let value = member(
                    control,
                    rpc.as_deref(),
                    proxy,
                    &child,
                    thread,
                    &target,
                    reason,
                )
                .await
                .and_then(|value| {
                    publish(&child, &value)?;
                    Ok(value)
                });
                (child, value)
            }
        })
        .buffer_unordered(8)
        .collect::<Vec<_>>()
        .await
    {
        let value = match result {
            Ok(value) => value,
            Err(_) => {
                let mut value = observation(&child)?.unwrap_or_else(
                    || json!({"rootThreadId":thread,"instance":parent["instance"]}),
                );
                value["state"] = json!("unconfirmed");
                publish(&child, &value)?;
                value
            }
        };
        all_released &= released(&value, session);
        if value["state"] == "held" {
            held.push(child.clone());
        }
        if !matches!(value["state"].as_str(), Some("handed-back" | "continued")) {
            blockers.push(json!({"threadId":child,"state":value["state"]}));
        }
    }
    parent.as_object_mut().unwrap().remove("descendants");
    if !blockers.is_empty() {
        blockers.sort_by(|a, b| string(a, "threadId").cmp(string(b, "threadId")));
        if parent["state"] == "handed-back" {
            parent["state"] = json!("subtree-held");
        }
        parent["descendants"] = json!(blockers);
    }
    publish(thread, &parent)?;
    if binding["pendingPreviousSubtree"] == true && blockers.is_empty() {
        let mut binding = binding;
        binding
            .as_object_mut()
            .unwrap()
            .remove("pendingPreviousSubtree");
        binding
            .as_object_mut()
            .unwrap()
            .remove("previousSubtreeBackend");
        binding
            .as_object_mut()
            .unwrap()
            .remove("previousSubtreeProxy");
        save(&path("execution", thread)?, &binding)?;
    }
    if all_released && blockers.is_empty() && held.is_empty() {
        return Ok(Next::Complete);
    }
    if all_released && !held.is_empty() {
        return Ok(Next::Writers(held));
    }
    Ok(Next::Unsettled)
}

fn released(status: &Value, session: Option<&str>) -> bool {
    status["state"] == "continued"
        || (status["checkedConnection"].as_str() == session
            && status["ownHold"].is_object()
            && matches!(status["state"].as_str(), Some("held" | "handed-back")))
}

pub(crate) async fn managed_instance(
    control: &Control,
    instance: &daemon::Instance,
) -> Result<bool> {
    if instance.independent() {
        return Ok(true);
    }
    if instance.profile.as_ref() != Some(&daemon::independent_profile()) {
        return Ok(false);
    }
    // An instance launched before launch IDs were introduced can still be
    // recognized by its live private profile and exact historical receipt.
    if control.task_records().await?.iter().any(|r| {
        let recovery = &r["desktopRecovery"];
        r["operation"] == "create"
            && recovery["transport"] == "local-daemon"
            && recovery["independent"].is_null()
            && recovery["target"] == instance.identity()
    }) {
        daemon::adopt_legacy(instance)?;
    }
    Ok(instance.independent())
}

async fn discover(control: &Control) -> Result<HashSet<String>> {
    let mut tasks = HashSet::new();
    // Older creates recorded the exact target on the receipt. They did not
    // retain its profile. Reconcile only this Core's connection after that
    // exact target exits; never operate on the historical process.
    let mut instances = None;
    for row in control.task_records().await?.iter() {
        let recovery = &row["desktopRecovery"];
        if row["backendSession"] == control.session
            || row["operation"] != "create"
            || recovery["transport"] != "local-daemon"
            || recovery["independent"] == false
        {
            continue;
        }
        let Some(thread) = row["threadId"].as_str() else {
            continue;
        };
        let p = path("execution", thread)?;
        let Ok(mut binding) = file_cache::load(&p) else {
            continue;
        };
        if binding["transport"] != "local-daemon" && binding["pendingPreviousSubtree"] != true {
            continue;
        }
        if binding["continuedFrom"].is_null()
            && binding["desktopInstance"].is_null()
            && recovery["target"]["start"].is_string()
        {
            if !exited(&recovery["target"]) {
                if instances.is_none() {
                    instances = Some(daemon::instances().await?);
                }
                let Some(instance) = instances.as_ref().and_then(|rows| {
                    rows.iter().find(|i| {
                        i.identity() == recovery["target"]
                            && i.profile.as_ref() == Some(&daemon::independent_profile())
                    })
                }) else {
                    continue;
                };
                daemon::adopt_legacy(instance)?;
            }
            binding["desktopInstance"] = recovery["target"].clone();
            save(&p, &binding)?;
        }
        if (binding["desktopInstance"].is_object() || binding["continuedFrom"].is_object())
            && observation(thread)?.is_none_or(|v| v["state"] != "handed-back")
        {
            tasks.insert(thread.to_owned());
        }
    }
    Ok(tasks)
}

const QUICK: Duration = Duration::from_secs(2);
const RELEASE_WINDOW: Duration = Duration::from_secs(30);
const ACTIVITY_CHECK: Duration = Duration::from_secs(10);
const RETAINED_CHECK: Duration = Duration::from_secs(60);

async fn watch(control: Arc<Control>, thread: String, startup: bool) -> (String, Vec<String>) {
    let mut last_error = None;
    let mut since_exit = None;
    loop {
        match reconcile(&control, &thread, startup).await {
            Ok(Next::Complete) => return (thread, vec![]),
            Ok(Next::Writers(held)) => return (thread, held),
            Ok(Next::ProcessAlive) => {
                since_exit = None;
                tokio::time::sleep(ACTIVITY_CHECK).await;
                continue;
            }
            Ok(Next::Unsettled) => last_error = None,
            Err(error) => {
                if last_error.as_ref() != Some(&error) {
                    crate::logs::record(
                        "WARN",
                        &format!("Desktop handback {thread}: {error}"),
                        None,
                    );
                    last_error = Some(error);
                }
            }
        }
        let elapsed = since_exit.get_or_insert_with(Instant::now).elapsed();
        tokio::time::sleep(if elapsed < RELEASE_WINDOW {
            QUICK
        } else {
            ACTIVITY_CHECK
        })
        .await;
    }
}

struct RetainedWriters {
    threads: Vec<String>,
    since: Instant,
    next: Instant,
}

impl RetainedWriters {
    fn changed(&mut self, now: Instant) -> bool {
        if now < self.next {
            return false;
        }
        self.next = now
            + if now - self.since < RELEASE_WINDOW {
                QUICK
            } else {
                RETAINED_CHECK
            };
        self.threads
            .iter()
            .any(|thread| crate::writer::probe(thread)["state"] != "held")
    }
}

pub(crate) fn start(control: Arc<Control>) {
    let mut shutdown = control.shutdown.subscribe();
    tokio::spawn(async move {
        let mut workers = tokio::task::JoinSet::<(String, Vec<String>)>::new();
        let mut watching = HashSet::new();
        let mut retained = HashMap::<String, RetainedWriters>::new();
        let mut pending = HashSet::new();
        let mut discovered = HashSet::new();
        let mut discover_at_start = true;
        let mut tick = tokio::time::interval(QUICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = shutdown.changed() => break,
                Some(result) = workers.join_next(), if !workers.is_empty() => {
                    if let Ok((root,held)) = result {
                        watching.remove(&root);
                        if !held.is_empty() {
                            let now = Instant::now();
                            retained.insert(root,RetainedWriters{threads:held,since:now,next:now+QUICK});
                        }
                    }
                }
                _ = tick.tick() => {
                    if discover_at_start {
                        match discover(&control).await {
                            Ok(tasks) => { pending.extend(tasks.iter().cloned()); discovered=tasks; discover_at_start=false; }
                            Err(error) => crate::logs::record("WARN",&format!("Desktop handback discovery: {error}"),None),
                        }
                    }
                    pending.extend(std::mem::take(&mut *control.handback_tasks.lock().await));
                    let now = Instant::now();
                    retained.retain(|root,writers| {
                        if pending.contains(root) || writers.changed(now) {
                            pending.insert(root.clone());
                            false
                        } else { true }
                    });
                    pending.retain(|thread| {
                        if !watching.insert(thread.clone()) {return true;}
                        let startup = discovered.remove(thread) && path("execution",thread)
                            .and_then(|p|file_cache::load(&p)).is_ok_and(|v|exited(&v["desktopInstance"]));
                        workers.spawn(watch(control.clone(),thread.clone(),startup));
                        false
                    });
                }
            }
        }
        workers.shutdown().await;
    });
}

pub(crate) async fn reopen(control: &Control, thread: &str) -> Result<bool> {
    let Some(status) = observation(thread)? else {
        return Ok(false);
    };
    if status["state"] != "running" {
        return Ok(false);
    }
    let parent = string(&status, "rootThreadId");
    let _thread = control.thread_lock(parent).await;
    let _gate = control.desktop_preparation.lock().await;
    if observation(thread)?.is_none_or(|v| v["state"] != "running") {
        return Err("DESKTOP_TASK_ALREADY_SETTLED".into());
    }
    let backend = Control::desktop_backend(parent)?;
    let rpc = control.desktop_backend_rpc(&backend).await?;
    if !active(control, &rpc, thread).await? {
        return Err("DESKTOP_TASK_ALREADY_SETTLED".into());
    }
    let instance = independent_instance(control, &backend_socket(&backend)?).await?;
    if !active(control, &rpc, thread).await? {
        return Err("DESKTOP_TASK_ALREADY_SETTLED".into());
    }
    daemon::reveal(instance.clone(), thread).await?;
    publish(
        thread,
        &json!({"rootThreadId":parent,"instance":instance.identity(),"state":"in-instance"}),
    )?;
    Ok(true)
}

fn backend_socket(backend: &Value) -> Result<PathBuf> {
    if backend == "arc" {
        crate::codex_host::socket("codex-home")?
            .canonicalize()
            .map_err(|e| e.to_string())
    } else {
        daemon::socket()
    }
}

pub(super) async fn independent_instance(
    control: &Control,
    socket: &Path,
) -> Result<daemon::Instance> {
    let instances = daemon::instances().await?;
    let primary = daemon::independent_profile();
    let alternate = daemon::alternate_profile();
    let existing = instances.iter().find(|i| {
        i.profile
            .as_deref()
            .is_some_and(daemon::is_independent_profile)
            && i.uses(socket)
    });
    let profile = if let Some(i) = existing {
        if !managed_instance(control, i).await? {
            return Err("DESKTOP_PROFILE_IN_USE".into());
        }
        i.profile.clone().ok_or("DESKTOP_PROFILE_IN_USE")?
    } else {
        let profile = [primary, alternate]
            .into_iter()
            .find(|p| !instances.iter().any(|i| i.profile.as_ref() == Some(p)))
            .ok_or("DESKTOP_PROFILE_IN_USE")?;
        daemon::launch(Some(&profile), socket).await?;
        profile
    };
    tokio::time::timeout(Duration::from_secs(24), async {
        loop {
            if let Some(i) = daemon::connected_profile(Some(&profile), socket).await? {
                if i.independent() {
                    return Ok::<_, String>(i);
                }
                return Err("DESKTOP_RECOVERY_TARGET_CHANGED".into());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .map_err(|_| "DESKTOP_RECOVERY_READY_TIMEOUT")?
}

// Called only for an admitted explicit write, with the ARC thread lock held.
pub(crate) async fn prepare_followup(control: &Control, thread: &str) -> Result<()> {
    let Some(previous) = returned_instance(thread)? else {
        return Ok(());
    };
    require_unheld(thread).await?;
    let old = observation(thread)?.unwrap_or_default();
    let root_id = old["rootThreadId"].as_str().unwrap_or(thread);
    let mut binding;
    let mut independent = None;
    if crate::claude_notify::settings()?["desktopRecovery"] == "independent" {
        let _gate = control.desktop_preparation.lock().await;
        let backend = Control::desktop_backend(root_id)?;
        if backend != "arc" {
            daemon::start_daemon().await?;
        }
        let rpc = control.desktop_backend_rpc(&backend).await?;
        let instance = independent_instance(control, &backend_socket(&backend)?).await?;
        // Claim the unheld writer on ARC's own connection before opening the
        // window. A loaded thread on this shared server is not proof that the
        // selected Desktop acquired it.
        let state = rpc
            .call(
                "thread/read",
                json!({"threadId":thread,"includeTurns":false}),
                3000,
            )
            .await?;
        require_unheld(thread).await?;
        if state["thread"]["id"] != thread || state["thread"]["status"]["type"] != "notLoaded" {
            return Err("DESKTOP_OWNER_UNCONFIRMED".into());
        }
        let resumed = rpc
            .call(
                "thread/resume",
                json!({"threadId":thread,"excludeTurns":true}),
                10000,
            )
            .await;
        let resumed = match resumed {
            Ok(resumed) => resumed,
            Err(error) => {
                require_unheld(thread).await?;
                return Err(error);
            }
        };
        if resumed["thread"]["id"] != thread
            || resumed["thread"]["status"]["type"] != "idle"
            || holder(thread).await["origin"]
                != if backend == "arc" {
                    "arc-app-server"
                } else {
                    "shared-app-server"
                }
        {
            return Err(crate::writer::busy(thread, crate::writer::probe(thread)).to_string());
        }
        binding = json!({"owner":"desktop","transport":"local-daemon","desktopInstance":instance.identity(),"backend":backend,
            "desktopTarget":instance.identity(),"desktopProxy":rpc.proxy_identity().await});
        independent = Some(instance);
    } else {
        // The open is explicit. A silent discovery during launch can recover
        // before the deadline, but a final timeout cannot authorize fallback.
        if control.ipc().await.is_ok() || super::installation().is_some() {
            require_unheld(thread).await?;
            super::open_thread(thread).await?;
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let owner = match control.ipc().await {
                Ok(ipc) => ipc.owner(thread).await,
                Err(error) => Err(error),
            };
            match owner {
                Ok(_) => {
                    binding = json!({"owner":"desktop","transport":"ipc"});
                    break;
                }
                Err(error) if super::owner_missing(&error) || super::endpoint_missing(&error) => {
                    if Instant::now() >= deadline {
                        let rpc = control.utility().await?;
                        require_unheld(thread).await?;
                        rpc.call(
                            "thread/resume",
                            json!({"threadId":thread,"excludeTurns":true}),
                            60000,
                        )
                        .await?;
                        binding = json!({"owner":"connector","reason":"desktop-handback-no-owner"});
                        break;
                    }
                }
                Err(error)
                    if super::owner_discovery_pending(&error) && Instant::now() < deadline => {}
                Err(error) => return Err(error),
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    if binding["owner"] == "desktop" && binding["transport"] == "local-daemon" {
        if let Some(prior) = record("execution", root_id)? {
            if let Some(reason) = prior.get("backendReason") {
                binding["backendReason"] = reason.clone();
            }
        }
    }
    binding["continuedFrom"] = previous;
    binding["handbackRoot"] = json!(root_id);
    // The old root may still owe an unsubscribe to a running descendant.
    if root_id == thread
        && old["state"] != "handed-back"
        && (old["descendants"].as_array().is_some_and(|v| !v.is_empty())
            || !old["ownHold"].is_object())
    {
        binding["pendingPreviousSubtree"] = json!(true);
        if let Some(prior) = record("execution", thread)? {
            binding["previousSubtreeBackend"] = prior["backend"].clone();
            binding["previousSubtreeProxy"] = prior["desktopProxy"].clone();
            if binding["desktopProxy"].is_null() {
                binding["desktopProxy"] = prior["desktopProxy"].clone();
            }
        }
    }
    save(&path("execution", thread)?, &binding)?;
    if independent.is_some() || binding["pendingPreviousSubtree"] == true || root_id != thread {
        control
            .handback_tasks
            .lock()
            .await
            .insert(root_id.to_owned());
    }
    if let Some(instance) = independent {
        daemon::reveal(instance, thread).await?;
    }
    Ok(())
}
