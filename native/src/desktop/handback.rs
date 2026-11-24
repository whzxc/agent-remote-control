//! Reconcile ARC's subscription after its recorded Desktop process exits.
use super::daemon;
use crate::{control::Control, kernel::file_cache, rpc::Rpc, *};
use futures_util::{stream, StreamExt};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

fn path(directory: &str, thread: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(thread).map_err(|_| "INVALID_THREAD_ID")?;
    Ok(root().join(directory).join(format!("{thread}.json")))
}

pub(crate) fn observation(thread: &str) -> Result<Option<Value>> {
    let p = path("desktop-handback", thread)?;
    if !p.try_exists().map_err(|e| e.to_string())? {
        return Ok(None);
    }
    file_cache::load(&p).map(Some)
}

fn publish(thread: &str, value: &Value) -> Result<()> {
    if observation(thread)?.as_ref() != Some(value) {
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

pub(crate) async fn check_send(thread: &str) -> Result<()> {
    let status = observation(thread)?;
    let restricted = if let Some(status) = status {
        status["ownHold"].is_object() || exited(&status["instance"])
    } else {
        let binding = path("execution", thread)?;
        binding.try_exists().map_err(|e| e.to_string())?
            && exited(&file_cache::load(&binding)?["desktopInstance"])
    };
    if !restricted {
        return Ok(());
    }
    let held = crate::writer::probe(thread)["state"] == "held";
    let message = if held && holder(thread).await["origin"] == "main-desktop" {
        "This task is in use in your main Desktop. ARC did not deliver the input."
    } else if held {
        "The task is in use after its Desktop instance exited. Inspect its owner before continuing."
    } else {
        "This task was returned to Desktop. Continue it there."
    };
    Err(
        json!({"code":"DESKTOP_TASK_HANDED_BACK","message":message,"threadId":thread,
        "next":{"via":"query","op":"codex_owner","args":{"threadId":thread}}})
        .to_string(),
    )
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
    let target = previous.get("instance").unwrap_or(target);
    let mut status = json!({"rootThreadId":parent,"instance":target});
    if !exited(target) {
        status["state"] = json!("in-instance");
        return Ok(status);
    }
    let prior_ack = &previous["ownHold"];
    let session = rpc
        .map(|r| r.session.as_str())
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
            "connection":rpc.session,"observedAt":now(),"reason":if previous["state"]=="running" {"turn-settled"} else {reason}});
        }
    } else if exited(proxy) {
        status["ownHold"] = json!({"state":"dropped","evidence":"connection-close","connection":session,
            "observedAt":now(),"reason":reason,"basis":"proxy-process-exited"});
    } else if !prior_ack.is_object() {
        return Err("DESKTOP_HANDBACK_CONNECTION_UNCONFIRMED".into());
    }
    if !prior_ack.is_object() && status["ownHold"]["nativeStatus"] != "unsubscribed" {
        if let Ok(closed) = file_cache::load(&root().join("desktop-last-disconnect.json")) {
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
    // Follow process ancestry, never infer a UI from a bundled CLI path.
    let rows = daemon::process_rows().await.unwrap_or_default();
    let desktop = daemon::instances().await.unwrap_or_default();
    for process in processes.as_array().into_iter().flatten() {
        let mut pid = process["pid"].as_u64().unwrap_or_default() as u32;
        while let Some((_, parent, executable)) = rows.iter().find(|(id, _, _)| *id == pid) {
            if let Some(instance) = desktop.iter().find(|i| i.pid == pid && i.running()) {
                let origin = if instance.profile.is_none() {
                    "main-desktop"
                } else {
                    "desktop-profile"
                };
                return json!({"origin":origin,"originPid":pid,"processes":processes});
            }
            if executable
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|s| matches!(s, "sshd" | "sshd-session"))
            {
                return json!({"origin":"ssh","originPid":pid,"processes":processes});
            }
            if *parent == pid || *parent <= 1 {
                break;
            }
            pid = *parent;
        }
    }
    json!({"origin":"external","processes":processes})
}

async fn reconcile(control: &Control, thread: &str, startup: bool) -> Result<bool> {
    let _guard = control.thread_lock(thread).await;
    let binding = file_cache::load(&path("execution", thread)?)?;
    let target = &binding["desktopInstance"];
    if !exited(target) {
        return Ok(false);
    }
    let proxy = &binding["desktopProxy"];
    let rpc = match control.shared_desktop_rpc().await {
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
        if value["state"] != "handed-back" {
            blockers.push(json!({"threadId":child,"state":value["state"]}));
        }
    }
    if !blockers.is_empty() {
        blockers.sort_by(|a, b| string(a, "threadId").cmp(string(b, "threadId")));
        if parent["state"] == "handed-back" {
            parent["state"] = json!("subtree-held");
        }
        parent["descendants"] = json!(blockers);
    }
    publish(thread, &parent)?;
    Ok(parent["state"] == "handed-back")
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
        if binding["transport"] != "local-daemon" {
            continue;
        }
        if binding["desktopInstance"].is_null() && recovery["target"]["start"].is_string() {
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
        if binding["desktopInstance"].is_object()
            && observation(thread)?.is_none_or(|v| v["state"] != "handed-back")
        {
            tasks.insert(thread.to_owned());
        }
    }
    Ok(tasks)
}

async fn watch(control: Arc<Control>, thread: String, startup: bool) -> String {
    let mut last_error = None;
    loop {
        match reconcile(&control, &thread, startup).await {
            Ok(true) => return thread,
            Ok(false) => last_error = None,
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
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

pub(crate) fn start(control: Arc<Control>) {
    let mut shutdown = control.shutdown.subscribe();
    tokio::spawn(async move {
        let mut workers = tokio::task::JoinSet::new();
        let mut watching = HashSet::new();
        let mut discover_at_start = true;
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        loop {
            tokio::select! {
                _ = shutdown.changed() => break,
                Some(result) = workers.join_next(), if !workers.is_empty() => {
                    if let Ok(thread) = result { watching.remove(&thread); }
                }
                _ = tick.tick() => {
                    let mut discovered = HashSet::new();
                    if discover_at_start {
                        match discover(&control).await {
                            Ok(tasks) => { discovered = tasks; discover_at_start = false; }
                            Err(error) => crate::logs::record("WARN",&format!("Desktop handback discovery: {error}"),None),
                        }
                    }
                    let mut pending = std::mem::take(&mut *control.handback_tasks.lock().await);
                    pending.extend(discovered.iter().cloned());
                    for thread in pending {
                        if watching.insert(thread.clone()) {
                            let at_start = discovered.contains(&thread) && path("execution",&thread)
                                .and_then(|p|file_cache::load(&p)).is_ok_and(|v|exited(&v["desktopInstance"]));
                            workers.spawn(watch(control.clone(),thread,at_start));
                        }
                    }
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
    let _gate = control.desktop_preparation.lock().await;
    let _thread = control.thread_lock(parent).await;
    let profile = daemon::independent_profile();
    if observation(thread)?.is_none_or(|v| v["state"] != "running") {
        return Err("DESKTOP_TASK_ALREADY_SETTLED".into());
    }
    let rpc = control.shared_desktop_rpc().await?;
    if !active(control, &rpc, thread).await? {
        return Err("DESKTOP_TASK_ALREADY_SETTLED".into());
    }
    let existing = daemon::instances()
        .await?
        .into_iter()
        .find(|i| i.profile.as_ref() == Some(&profile));
    match existing {
        Some(i) if !managed_instance(control, &i).await? => {
            return Err("DESKTOP_PROFILE_IN_USE".into())
        }
        Some(_) => {}
        None => daemon::launch(Some(&profile)).await?,
    }
    let instance = tokio::time::timeout(Duration::from_secs(24), async {
        loop {
            if let Some(i) = daemon::connected_profile(Some(&profile)).await? {
                if i.independent() {
                    return Ok::<_, String>(i);
                }
                return Err("DESKTOP_RECOVERY_TARGET_CHANGED".into());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .map_err(|_| "DESKTOP_RECOVERY_READY_TIMEOUT")??;
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
