//! Evidence-only advisory recovery. Selection and delivery never dispatch a task.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

fn at(row: &Value) -> i64 {
    row["occurredAt"]
        .as_str()
        .or(row["observedAt"].as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map_or(i64::MIN, |t| t.timestamp_millis())
}
fn time(row: &Value, key: &str) -> i64 {
    row[key]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map_or(i64::MIN, |t| t.timestamp_millis())
}
fn refs(row: &Value) -> impl Iterator<Item = &Value> {
    row["threadRefs"].as_array().into_iter().flatten()
}
fn same(a: &Value, b: &Value) -> bool {
    a["threadId"] == b["threadId"] && a["turnId"].is_string() && a["turnId"] == b["turnId"]
}
fn overlaps(a: &Value, b: &Value) -> bool {
    a["resources"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|r| b["resources"].as_array().is_some_and(|rs| rs.contains(r)))
}
/// A completed descendant or a newer unrelated dispatch makes old advice obsolete.
/// Pending replacement continuations retain their existing request and configuration.
pub(super) fn obsolete(reference: &Value, events: &[Value]) -> bool {
    let mut edges: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for e in events.iter().filter(|e| e["kind"] == "turn.successor") {
        let pair: Vec<_> = refs(e).collect();
        if pair.len() == 2
            && pair[0]["threadId"] == reference["threadId"]
            && pair[1]["threadId"] == reference["threadId"]
        {
            edges
                .entry(string(pair[0], "turnId"))
                .or_default()
                .push(string(pair[1], "turnId"));
        }
    }
    let mut turns = BTreeSet::new();
    let mut pending = vec![string(reference, "turnId")];
    while let Some(turn) = pending.pop() {
        if turns.insert(turn) {
            pending.extend(edges.get(turn).into_iter().flatten().copied());
        }
    }
    events.iter().any(|e| {
        let thread = |r: &&Value| r["threadId"] == reference["threadId"];
        (e["kind"] == "turn.terminal"
            && e["status"] == "completed"
            && refs(e)
                .filter(thread)
                .any(|r| turns.contains(string(r, "turnId"))))
            || (e["kind"] == "dispatch.accepted"
                && at(e) > reference["interruptedAt"].as_i64().unwrap_or(i64::MAX)
                && refs(e)
                    .filter(thread)
                    .any(|r| !turns.contains(string(r, "turnId"))))
            || (e["kind"] == "app.replace"
                && matches!(string(e, "status"), "running" | "completed")
                && refs(e).any(|r| same(r, reference)))
    })
}
/// Exported pure selection boundary: only retained journal metadata can nominate a recipient.
pub(crate) fn select(blocker: &Value, events: &[Value], retained_gap: bool) -> Value {
    if blocker["state"] != "cleared" {
        return json!({"state":"suppressed","reason":"not-cleared","recipients":[],"unresolved":[],"automaticResume":false});
    }
    let opened = time(blocker, "openedAt");
    let cleared = time(blocker, "clearedAt");
    let clearing = blocker["clearedBy"]["sourceId"].as_str();
    let mut groups: BTreeMap<(String, String), Vec<Value>> = BTreeMap::new();
    let mut unresolved = Vec::new();
    let mut seen = BTreeSet::new();
    let mut scanned = 0;
    let mut truncated = false;
    // Paging is over candidates, not all feed events: no early-page-only recipient loss.
    for page in events.chunks(100) {
        for event in page.iter().filter(|e| {
            e["kind"] == "turn.terminal"
                && matches!(string(e, "status"), "interrupted" | "failed" | "cancelled")
        }) {
            if at(event) < opened || at(event) > cleared {
                continue;
            }
            for reference in refs(event) {
                let resource_evidence = overlaps(event, blocker)
                    || events.iter().any(|e| {
                        e["kind"] == "notice.changed"
                            && at(e) <= at(event)
                            && overlaps(e, blocker)
                            && refs(e).any(|r| same(r, reference))
                    });
                if !resource_evidence {
                    continue;
                }
                if !reference["turnId"].is_string()
                    || !seen.insert((string(reference, "threadId"), string(reference, "turnId")))
                {
                    continue;
                }
                if scanned == 1000 {
                    truncated = true;
                    continue;
                }
                scanned += 1;
                let mut reference = reference.clone();
                reference["interruptedAt"] = json!(at(event));
                reference["timeBasis"] = event["timeBasis"].clone();
                reference["evidenceId"] = event["eventId"].clone();
                if obsolete(&reference, events) {
                    continue;
                }
                let owners: BTreeSet<_> = events
                    .iter()
                    .filter(|e| {
                        e["kind"] == "dispatch.accepted" && refs(e).any(|r| same(r, &reference))
                    })
                    .filter_map(|e| e["origin"]["sourceId"].as_str())
                    .collect();
                if owners.len() != 1 {
                    unresolved.push(reference);
                    continue;
                }
                let owner = *owners.first().unwrap();
                if clearing == Some(owner) {
                    continue;
                }
                let bindings: BTreeSet<_> = events
                    .iter()
                    .filter(|e| {
                        e["kind"] == "notice.changed"
                            && e["origin"]["sourceId"] == owner
                            && at(e) <= at(event)
                            && refs(e).any(|r| same(r, &reference))
                    })
                    .filter(|e| overlaps(e, blocker) || overlaps(event, blocker))
                    .filter_map(|e| e["observation"]["sessionId"].as_str())
                    .collect();
                if bindings.len() != 1 {
                    unresolved.push(reference);
                    continue;
                }
                let session = bindings.first().unwrap();
                let generations: BTreeSet<_> = events
                    .iter()
                    .filter(|e| {
                        e["kind"] == "notice.changed"
                            && e["origin"]["sourceId"] == owner
                            && e["observation"]["sessionId"] == *session
                            && at(e) <= at(event)
                            && refs(e).any(|r| same(r, &reference))
                    })
                    .map(|e| e["observation"]["sessionBindingId"].as_str())
                    .collect();
                if generations.len() == 1 {
                    reference["sessionBindingId"] = json!(generations.first().unwrap());
                }
                groups
                    .entry((owner.into(), session.to_string()))
                    .or_default()
                    .push(reference);
            }
        }
    }
    let recipients: Vec<_> = groups.into_iter().map(|((source,session),threads)|json!({"sourceId":source,"sessionId":session,"threadRefs":threads})).collect();
    let replacements: BTreeSet<_> = events
        .iter()
        .filter(|e| {
            e["kind"] == "app.replace"
                && overlaps(e, blocker)
                && at(e) >= opened
                && at(e) <= cleared
        })
        .flat_map(|e| e["evidenceRefs"].as_array().into_iter().flatten())
        .filter(|r| r["kind"] == "replacement")
        .filter_map(|r| r["id"].as_str())
        .collect();
    json!({"state":"selected","recipients":recipients,"unresolved":unresolved,"scanned":scanned,"truncated":truncated,"coverage":if retained_gap || truncated {"partial"}else{"retained-events-only"},"replacementIds":replacements,"automaticResume":false})
}
pub(super) fn public_selection(plan: &Value) -> Value {
    if plan.is_null() {
        return json!({"state":"pending","automaticResume":false});
    }
    json!({"state":plan["state"],"reason":plan["reason"],"recipientSessions":plan["recipients"].as_array().map_or(0,Vec::len),"unresolvedRecipients":plan["unresolved"].as_array().map_or(0,Vec::len),"scanned":plan["scanned"],"truncated":plan["truncated"],"coverage":plan["coverage"],"automaticResume":false})
}
pub(super) fn events() -> Result<(Vec<Value>, bool)> {
    super::with_journal(|j| j.recovery_events())
}
pub(super) fn broadcast(id: &str) -> Result<()> {
    let Some(blocker) = bulletin::recovery_blocker(id)? else {
        return Ok(());
    };
    if blocker["state"] != "cleared" {
        return Ok(());
    }
    let plan = if blocker["recoverySelection"].is_null() {
        let (events, gap) = events()?;
        bulletin::recovery_plan(id, select(&blocker, &events, gap))?
    } else {
        blocker["recoverySelection"].clone()
    };
    // Outbox retention cannot resurrect old advice after a long projection outage.
    if time(&blocker, "clearedAt") < chrono::Utc::now().timestamp_millis() - 86400_000 {
        return Ok(());
    }
    for recipient in plan["recipients"].as_array().into_iter().flatten() {
        messages::recovery(&blocker, recipient)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn blocker() -> Value {
        json!({"id":"blocker","revision":2,"state":"cleared","resources":["app:installed"],"openedAt":timestamp(1000),"clearedAt":timestamp(4000),"clearedBy":{"sourceId":"owner"}})
    }
    fn event(kind: &str, source: &str, thread: &str, turn: &str, at: i64) -> Value {
        json!({"eventId":format!("{kind}-{thread}-{turn}"),"kind":kind,"origin":{"sourceId":source},"resources":["app:installed"],"observedAt":timestamp(at),"timeBasis":"observed","threadRefs":[{"threadId":thread,"turnId":turn}]})
    }
    fn affected(source: &str, thread: &str) -> Vec<Value> {
        let mut binding = event("notice.changed", source, thread, "old", 1500);
        binding["observation"] = json!({"sessionId":format!("session-{source}")});
        let mut terminal = event("turn.terminal", source, thread, "old", 2000);
        terminal["status"] = json!("failed");
        vec![
            event("dispatch.accepted", source, thread, "old", 1200),
            binding,
            terminal,
        ]
    }
    #[test]
    // Contract: blocker_clear selects only evidenced other-source sessions and omits completed successors.
    fn recovery_selection_ownership_and_successors() {
        let mut events = affected("owner", "own");
        events.extend(affected("peer", "affected"));
        events.extend(affected("peer", "done"));
        let mut next = event("turn.successor", "peer", "done", "old", 2500);
        next["threadRefs"]
            .as_array_mut()
            .unwrap()
            .push(json!({"threadId":"done","turnId":"next"}));
        events.push(next);
        let mut done = event("turn.terminal", "peer", "done", "next", 3000);
        done["status"] = json!("completed");
        events.push(done);
        let selected = select(&blocker(), &events, false);
        assert_eq!(selected["recipients"].as_array().unwrap().len(), 1);
        assert_eq!(
            selected["recipients"][0]["threadRefs"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            selected["recipients"][0]["threadRefs"][0]["threadId"],
            "affected"
        );
        assert_eq!(selected["automaticResume"], false);
    }
    #[test]
    // Contract: stale blockers, missing session evidence and unrelated resources never broadcast recovery.
    fn recovery_selection_requires_clearance_and_binding_evidence() {
        let events = affected("peer", "affected");
        let mut stale = blocker();
        stale["state"] = json!("stale");
        assert_eq!(select(&stale, &events, false)["recipients"], json!([]));
        assert_eq!(
            select(&blocker(), &[events[0].clone(), events[2].clone()], false)["unresolved"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mut other = blocker();
        other["resources"] = json!(["host:other"]);
        assert_eq!(select(&other, &events, false)["recipients"], json!([]));
    }
    #[test]
    // Contract: recovery scans later pages, coalesces a session, and reports its bounded evidence coverage.
    fn recovery_selection_pages_and_cap() {
        let mut events = vec![];
        for i in 0..1002 {
            events.extend(affected("peer", &format!("thread-{i}")));
        }
        let selected = select(&blocker(), &events, true);
        assert_eq!(selected["recipients"].as_array().unwrap().len(), 1);
        assert_eq!(
            selected["recipients"][0]["threadRefs"]
                .as_array()
                .unwrap()
                .len(),
            1000
        );
        assert_eq!(selected["truncated"], true);
        assert_eq!(selected["coverage"], "partial");
    }
    #[test]
    // Contract: pending replacement continuation and unrelated newer content suppress recovery without dispatching another turn.
    fn recovery_selection_respects_existing_continuation() {
        for kind in ["app.replace", "dispatch.accepted"] {
            let mut events = affected("peer", "affected");
            let mut next = event(
                kind,
                "peer",
                "affected",
                if kind == "app.replace" {
                    "old"
                } else {
                    "unrelated"
                },
                3000,
            );
            next["status"] = json!("running");
            events.push(next);
            assert_eq!(select(&blocker(), &events, false)["recipients"], json!([]));
        }
    }
}
