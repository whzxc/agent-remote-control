//! AX owner snapshot. Atomic owner writes precede journal projection. No upstream IO.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const ENTRY_BYTES: usize = 16 * 1024;
// The other half of the 16 MiB budget is reserved for the atomic temporary.
const SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 1000;
const RETENTION: i64 = 180 * 86400 * 1000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Entry {
    pub id: String,
    pub revision: u64,
    pub kind: String,
    pub symptom: String,
    pub expected: String,
    pub reproduction_hints: String,
    pub severity: Option<String>,
    pub resources: Vec<ResourceKey>,
    pub source: Value,
    pub arc_version: Option<String>,
    pub evidence: Vec<Value>,
    pub first_seen_at: Option<String>,
    pub last_seen_at: Option<String>,
    pub occurrence_count: u64,
    pub candidate_state: Option<String>,
    pub status: String,
    pub resolution: Option<String>,
    pub merged_into: Option<String>,
    pub history: Vec<Value>,
    pub(super) fingerprint: String,
    pub(super) occurrences: BTreeSet<String>,
    pub(super) applied: BTreeSet<String>,
    pub(super) pending: Vec<EventInput>,
    pub(super) updated_ms: i64,
    pub(super) exported_revision: Option<u64>,
    pub(super) candidate_signature: Option<String>,
    pub(super) candidate_build: Option<String>,
}
impl Entry {
    pub(super) fn owns(&self, actor: &Value) -> bool {
        actor["type"] == "local-authority"
            || (actor["type"] == "source" && self.source["sourceId"] == actor["sourceId"])
    }
    fn projection(&self, actor: &Value) -> Value {
        let mut v = json!(self);
        let obj = v.as_object_mut().unwrap();
        for key in [
            "fingerprint",
            "occurrences",
            "applied",
            "pending",
            "updatedMs",
            "exportedRevision",
            "candidateSignature",
            "candidateBuild",
        ] {
            obj.remove(key);
        }
        if actor["type"] != "local-authority" {
            obj.insert(
                "evidence".into(),
                json!(self
                    .evidence
                    .iter()
                    .filter(
                        |e| e["source"].is_null() || e["source"]["sourceId"] == actor["sourceId"]
                    )
                    .collect::<Vec<_>>()),
            );
        }
        if !self.owns(actor) {
            obj.remove("reproductionHints");
            obj.remove("evidence");
            // Decisions remain visible, but free-form reasons and references are private.
            obj.insert("history".into(), json!(self.history.iter().map(|h| json!({"action":h["action"],"at":h["at"],"actor":h["actor"],"revision":h["revision"]})).collect::<Vec<_>>()));
        }
        v
    }
    fn event(&mut self, kind: EventKind) {
        let mut event = EventInput::new(
            format!("{}-{}", self.id, self.revision),
            kind,
            if self.resources.is_empty() {
                vec![ResourceKey::parse("app:installed").unwrap()]
            } else {
                self.resources.clone()
            },
        );
        event.origin = if self.candidate_signature.is_some() {
            Some(Principal::Arc)
        } else {
            serde_json::from_value(self.source.clone())
                .ok()
                .or(Some(Principal::Arc))
        };
        event.status = serde_json::from_value(json!(if self.candidate_state.as_deref()
            == Some("rejected")
        {
            "rejected"
        } else {
            &self.status
        }))
        .ok();
        event.evidence_refs.push(EvidenceRef {
            kind: EvidenceKind::Ax,
            id: self.id.clone(),
        });
        self.pending.push(event);
    }
    fn record(&mut self, action: &str, actor: &Value, detail: Value, time: i64) {
        self.revision += 1;
        self.updated_ms = time;
        self.history.push(json!({"action":action,"at":timestamp(time),"actor":actor,"revision":self.revision,"detail":detail}));
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    epoch: String,
    revision: u64,
    entries: BTreeMap<String, Entry>,
    report_buckets: BTreeMap<String, (i64, u32)>,
    candidate_bucket: (i64, u32),
    candidate_overflow: u64,
}
pub(super) struct Store {
    dir: PathBuf,
    data: Snapshot,
}
fn capacity() -> String {
    "COORDINATION_CAPACITY: export closed AX records with cli ax export --to <path>; preserve open records and required history".into()
}
fn corrupt() -> String {
    "COORDINATION_CORRUPT: preserve coordination/ax for explicit local recovery".into()
}
pub(super) fn tokens(text: &str) -> BTreeSet<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
pub(super) fn fingerprint(args: &Value) -> String {
    let resources: BTreeSet<_> = args["resources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|s| s.split(':').next().unwrap_or(s))
        .collect();
    hash(
        json!([
            args["kind"].as_str().unwrap_or("friction"),
            tokens(string(args, "symptom")),
            resources
        ])
        .to_string(),
    )
}
fn occurrence(args: &Value, request: &str) -> String {
    // receiptIds and requestIds name the same durable operation namespace.
    // A thread is contextual when a concrete receipt occurrence is supplied.
    let mut refs: BTreeSet<String> = ["receiptIds", "requestIds"]
        .into_iter()
        .flat_map(|key| {
            args[key]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
        })
        .map(|id| format!("receipt:{id}"))
        .collect();
    if refs.is_empty() {
        refs.extend(
            args["threadIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|id| format!("thread:{id}")),
        );
    }
    hash(if refs.is_empty() {
        request.to_owned()
    } else {
        json!(refs).to_string()
    })
}

impl Store {
    pub(super) fn open(dir: PathBuf) -> Result<Self> {
        private_dir(&dir)?;
        let path = dir.join("state.json");
        let data = if path.exists() {
            if std::fs::metadata(&path).map_err(|_| corrupt())?.len() > SNAPSHOT_BYTES as u64 {
                return Err(capacity());
            }
            serde_json::from_value(load(&path).map_err(|_| corrupt())?).map_err(|_| corrupt())?
        } else {
            Snapshot {
                epoch: id(),
                revision: 0,
                entries: BTreeMap::new(),
                report_buckets: BTreeMap::new(),
                candidate_bucket: (0, 0),
                candidate_overflow: 0,
            }
        };
        let store = Self { dir, data };
        store.validate()?;
        Ok(store)
    }
    fn validate(&self) -> Result<Vec<u8>> {
        if self.data.entries.len() > MAX_ENTRIES || self.data.report_buckets.len() > 1024 {
            return Err(capacity());
        }
        for entry in self.data.entries.values() {
            if serde_json::to_vec(entry).map_err(|_| corrupt())?.len() > ENTRY_BYTES {
                return Err(capacity());
            }
        }
        let bytes = serde_json::to_vec(&self.data).map_err(|_| corrupt())?;
        if bytes.len() > SNAPSHOT_BYTES {
            return Err(capacity());
        }
        Ok(bytes)
    }
    fn save(&self) -> Result<()> {
        super::super::journal::atomic_bytes(&self.dir.join("state.json"), &self.validate()?)
    }
    fn transaction<T>(&mut self, f: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        let before = self.data.clone();
        let result = f(self).and_then(|v| {
            self.save()?;
            Ok(v)
        });
        if result.is_err() {
            self.data = before;
        }
        result
    }
    fn prune(&mut self, time: i64) {
        self.data.entries.retain(|_, e| {
            !(matches!(e.status.as_str(), "closed" | "merged")
                && time - e.updated_ms > RETENTION
                && e.exported_revision == Some(e.revision)
                && e.pending.is_empty())
        });
        self.data
            .report_buckets
            .retain(|_, (at, _)| time.saturating_sub(*at) < 60_000);
    }
    fn canonical(&self, id: &str) -> Result<String> {
        let mut key = id;
        for _ in 0..=MAX_ENTRIES {
            let e = self
                .data
                .entries
                .get(key)
                .ok_or("AX_NOT_FOUND: query ax_list")?;
            match &e.merged_into {
                Some(next) => key = next,
                None => return Ok(key.into()),
            }
        }
        Err(corrupt())
    }
    pub(super) fn replay(&self, request: &str, actor: &Value) -> Option<Value> {
        self.data
            .entries
            .values()
            .find(|e| e.applied.contains(request))
            .map(|e| json!({"entry":e.projection(actor),"duplicateCandidates":[],"replayed":true}))
    }
    pub(super) fn mutate(
        &mut self,
        op: &str,
        args: &Value,
        actor: &Value,
        evidence: Vec<Value>,
        time: i64,
    ) -> Result<Value> {
        let request = string(args, "requestId");
        if let Some(result) = self.replay(request, actor) {
            return Ok(result);
        }
        self.transaction(|s| {
            s.prune(time);
            let result = match op {
                "ax_report" => {
                    let bucket = s
                        .data
                        .report_buckets
                        .entry(actor["sourceId"].as_str().unwrap_or("local").into())
                        .or_insert((time, 0));
                    if time.saturating_sub(bucket.0) >= 60_000 {
                        *bucket = (time, 0);
                    }
                    if bucket.1 >= 10 {
                        return Err(
                            "COORDINATION_RATE_LIMIT: wait one minute and retry the same requestId"
                                .into(),
                        );
                    }
                    bucket.1 += 1;
                    s.report(args, actor, evidence, time, None)?
                }
                "ax_candidate" | "ax_triage" => s.decision(op, args, actor, &evidence, time)?,
                _ => return Err("INVALID_ARGUMENT: read guide for AX operations".into()),
            };
            s.data.revision += 1;
            Ok(result)
        })
    }
    fn report(
        &mut self,
        args: &Value,
        actor: &Value,
        evidence: Vec<Value>,
        time: i64,
        import_id: Option<&str>,
    ) -> Result<Value> {
        let fp = fingerprint(args);
        let existing = self
            .data
            .entries
            .values()
            .find(|e| {
                e.fingerprint == fp
                    && e.status != "candidate"
                    && e.candidate_state.as_deref() != Some("rejected")
            })
            .map(|e| e.id.clone());
        let key = match existing {
            Some(key) => self.canonical(&key)?,
            None => import_id
                .map(str::to_owned)
                .unwrap_or_else(|| format!("ax-{}", id())),
        };
        let fresh = !self.data.entries.contains_key(&key);
        let occ = occurrence(args, string(args, "requestId"));
        if fresh {
            let kind = args["kind"].as_str().unwrap_or("friction").to_owned();
            self.data.entries.insert(
                key.clone(),
                Entry {
                    id: key.clone(),
                    revision: 0,
                    kind,
                    symptom: string(args, "symptom").into(),
                    expected: string(args, "expected").into(),
                    reproduction_hints: string(args, "reproductionHints").into(),
                    severity: args["severity"].as_str().map(str::to_owned),
                    resources: serde_json::from_value(
                        args.get("resources").cloned().unwrap_or(json!([])),
                    )
                    .map_err(|_| "INVALID_ARGUMENT: resources")?,
                    source: actor.clone(),
                    arc_version: import_id
                        .is_none()
                        .then(|| crate::egress::arc_version().into()),
                    evidence: vec![],
                    first_seen_at: import_id.is_none().then(|| timestamp(time)),
                    last_seen_at: import_id.is_none().then(|| timestamp(time)),
                    occurrence_count: 0,
                    candidate_state: None,
                    status: "open".into(),
                    resolution: None,
                    merged_into: None,
                    history: vec![],
                    fingerprint: fp,
                    occurrences: BTreeSet::new(),
                    applied: BTreeSet::new(),
                    pending: vec![],
                    updated_ms: time,
                    exported_revision: None,
                    candidate_signature: None,
                    candidate_build: None,
                },
            );
        }
        let entry = self.data.entries.get_mut(&key).unwrap();
        entry.applied.insert(string(args, "requestId").into());
        let severity = args["severity"].as_str().map(str::to_owned);
        let severity_changed =
            !fresh && entry.owns(actor) && severity.is_some() && entry.severity != severity;
        if severity_changed {
            let previous = entry.severity.clone();
            entry.severity = severity;
            entry.record(
                "severity-changed",
                actor,
                json!({"previous":previous,"severity":entry.severity}),
                time,
            );
            entry.event(EventKind::AxChanged);
        }
        if !fresh && entry.owns(actor) {
            let changed = entry.expected != string(args, "expected")
                || (args["reproductionHints"].is_string()
                    && entry.reproduction_hints != string(args, "reproductionHints"));
            if changed {
                entry.expected = string(args, "expected").into();
                if args["reproductionHints"].is_string() {
                    entry.reproduction_hints = string(args, "reproductionHints").into();
                }
                entry.record("enriched", actor, json!({}), time);
                entry.event(EventKind::AxChanged);
            }
        }
        if entry.occurrences.insert(occ) {
            if entry.kind == "friction" {
                entry.occurrence_count += 1;
            }
            entry.last_seen_at = import_id.is_none().then(|| timestamp(time));
            // Retain the first and the most recent representative observations.
            for mut item in evidence {
                item["source"] = actor.clone();
                if entry.evidence.len() >= 16 {
                    entry.evidence.remove(1);
                }
                entry.evidence.push(item);
            }
            let reopen = entry.status == "closed";
            if reopen {
                entry.status = "open".into();
                entry.resolution = None;
            }
            // Only lifecycle changes require history; each occurrence is in the count/keys.
            if fresh || reopen {
                entry.record(
                    if fresh { "reported" } else { "reopen" },
                    actor,
                    json!({"reportedOnly":import_id.is_some()}),
                    time,
                );
            } else {
                entry.revision += 1;
                entry.updated_ms = time;
            }
            entry.event(if fresh {
                EventKind::AxCreated
            } else {
                EventKind::AxChanged
            });
        }
        let projection = entry.projection(actor);
        let query_tokens = tokens(string(args, "symptom"));
        let mut candidates: Vec<_> = self
            .data
            .entries
            .values()
            .filter(|e| e.id != key && e.status != "merged" && e.status != "candidate")
            .filter_map(|e| {
                let other = tokens(&e.symptom);
                let score = query_tokens.intersection(&other).count() as f64
                    / query_tokens.union(&other).count().max(1) as f64;
                (score >= 0.35)
                    .then(|| json!({"id":e.id,"score":score,"reason":"symptom-token-overlap"}))
            })
            .collect();
        candidates.sort_by(|a, b| {
            b["score"]
                .as_f64()
                .unwrap()
                .total_cmp(&a["score"].as_f64().unwrap())
        });
        candidates.truncate(8);
        Ok(json!({"entry":projection,"duplicateCandidates":candidates}))
    }
    fn decision(
        &mut self,
        op: &str,
        args: &Value,
        actor: &Value,
        evidence: &[Value],
        time: i64,
    ) -> Result<Value> {
        let key = string(args, "id");
        let original = self
            .data
            .entries
            .get(key)
            .ok_or("AX_NOT_FOUND: query ax_list")?;
        if !original.owns(actor) {
            return Err(
                "AX_FORBIDDEN: only the reporting source or local authority may decide this entry"
                    .into(),
            );
        }
        if args["expectedRevision"].as_u64() != Some(original.revision) {
            return Err(format!(
                "AX_REVISION_CONFLICT: current revision {}; query ax_list before deciding",
                original.revision
            ));
        }
        if original.status == "merged" {
            return Err("AX_MERGED: triage the canonical entry from ax_list".into());
        }
        let action = string(args, "action");
        if op == "ax_candidate"
            && (original.status != "candidate" || !matches!(action, "confirm" | "reject"))
        {
            return Err(
                "AX_STATE_CONFLICT: only pending candidates may be confirmed or rejected".into(),
            );
        }
        if op == "ax_triage"
            && (original.status == "candidate"
                || original.candidate_state.as_deref() == Some("rejected"))
        {
            return Err("AX_STATE_CONFLICT: confirm the candidate first".into());
        }
        if action == "merged" {
            let target_key = self.canonical(string(args, "mergedInto"))?;
            if target_key == key {
                return Err("AX_MERGE_CYCLE: choose another canonical entry".into());
            }
            let source = original.clone();
            let target = self.data.entries.get_mut(&target_key).unwrap();
            if target.status == "candidate"
                || target.candidate_state.as_deref() == Some("rejected")
                || !target.owns(actor)
                || target.kind != source.kind
            {
                return Err("AX_FORBIDDEN: merge requires authority over a confirmed target of the same kind".into());
            }
            target.occurrences.extend(source.occurrences);
            target.occurrence_count = if target.kind == "idea" {
                0
            } else {
                target.occurrences.len() as u64
            };
            for sample in source.evidence {
                if target.evidence.len() >= 16 {
                    target.evidence.remove(1);
                }
                target.evidence.push(sample);
            }
            if target.status == "closed" {
                target.status = "open".into();
                target.resolution = None;
            }
            if source.first_seen_at < target.first_seen_at {
                target.first_seen_at = source.first_seen_at;
            }
            if source.last_seen_at > target.last_seen_at {
                target.last_seen_at = source.last_seen_at;
            }
            target.record("merged-from", actor, json!({"id":key}), time);
            target.event(EventKind::AxChanged);
            self.data.entries.get_mut(key).unwrap().merged_into = Some(target_key);
        }
        let entry = self.data.entries.get_mut(key).unwrap();
        match action {
            "confirm" => {
                entry.candidate_state = Some("confirmed".into());
                entry.status = "open".into();
                entry.occurrence_count = entry.occurrences.len() as u64;
            }
            "reject" => {
                entry.candidate_state = Some("rejected".into());
                entry.status = "closed".into();
            }
            "fix" | "document" => {
                entry.resolution = Some(action.into());
                // Both a change/document reference and explicit verification evidence are required.
                let change = if action == "fix" {
                    string(args, "commit")
                } else {
                    string(args, "document")
                };
                let verified = args["evidenceIds"].as_array().is_some_and(|ids| {
                    !ids.is_empty()
                        && ids.iter().all(|id| {
                            evidence.iter().any(|fact| {
                                fact["id"] == *id
                                    && fact["availability"] == "available"
                                    && fact["state"] == "completed"
                                    && matches!(
                                        fact["operation"].as_str(),
                                        Some("command" | "review" | "native" | "agent_review")
                                    )
                            })
                        })
                });
                entry.status = if !change.is_empty() && verified {
                    "closed"
                } else {
                    "triaged"
                }
                .into();
            }
            "wontfix" => {
                entry.resolution = Some(action.into());
                entry.status = "closed".into();
            }
            "merged" => {
                entry.resolution = Some(action.into());
                entry.status = "merged".into();
            }
            "reopen" => {
                entry.resolution = None;
                entry.status = "open".into();
            }
            _ => return Err("INVALID_ARGUMENT: read guide for ax_triage".into()),
        }
        entry.applied.insert(string(args, "requestId").into());
        let mut detail = args.clone();
        detail.as_object_mut().unwrap().remove("requestId");
        if matches!(action, "fix" | "document") {
            detail["verification"] = json!(evidence);
        }
        entry.record(action, actor, detail, time);
        entry.event(EventKind::AxChanged);
        Ok(json!({"entry":entry.projection(actor)}))
    }
    pub(super) fn pending(&self) -> Vec<EventInput> {
        self.data
            .entries
            .values()
            .flat_map(|e| e.pending.clone())
            .take(64)
            .collect()
    }
    pub(super) fn projected(&mut self, transition: &str) -> Result<()> {
        self.transaction(|s| {
            for entry in s.data.entries.values_mut() {
                entry.pending.retain(|p| p.transition_id != transition);
            }
            Ok(())
        })
    }
    pub(super) fn list(
        &self,
        args: &Value,
        actor: &Value,
        authority_revision: &str,
        time: i64,
    ) -> Result<Value> {
        let mut filters = args.clone();
        filters.as_object_mut().unwrap().remove("cursor");
        filters.as_object_mut().unwrap().remove("limit");
        let scope = hash(json!([actor_identity(actor), authority_revision, filters]).to_string());
        let mut after = String::new();
        if let Some(cursor) = args["cursor"].as_str() {
            let (payload, signature) = cursor
                .split_once('.')
                .ok_or("AX_CURSOR_EXPIRED: restart ax_list without cursor")?;
            if hash(format!("{}:{payload}", self.data.epoch)) != signature {
                return Err("AX_CURSOR_EXPIRED: restart ax_list without cursor".into());
            }
            let value: Value = serde_json::from_slice(
                &URL_SAFE_NO_PAD
                    .decode(payload)
                    .map_err(|_| "AX_CURSOR_EXPIRED")?,
            )
            .map_err(|_| "AX_CURSOR_EXPIRED")?;
            if value["scope"] != scope
                || value["revision"] != self.data.revision
                || value["expires"].as_i64().is_none_or(|at| at < time)
            {
                return Err("AX_CURSOR_EXPIRED: authority, filters or entries changed; restart ax_list without cursor".into());
            }
            after = string(&value, "after").into();
        }
        let limit = args["limit"].as_u64().unwrap_or(50) as usize;
        let since = args["since"]
            .as_str()
            .map(|v| {
                chrono::DateTime::parse_from_rfc3339(v)
                    .map(|v| v.timestamp_millis())
                    .map_err(|_| "INVALID_ARGUMENT: since must be RFC3339")
            })
            .transpose()?;
        let resource = args["resource"]
            .as_str()
            .map(|v| {
                super::super::types::resolve_resource(
                    v,
                    self.data.entries.values().flat_map(|e| e.resources.iter()),
                )
            })
            .transpose()?;
        let mut rows = vec![];
        let mut bytes = 0;
        let mut more = false;
        let start = after.clone();
        for e in self.data.entries.values().filter(|e| e.id > start) {
            if args["id"].as_str().is_some_and(|id| e.id != id)
                || args["status"]
                    .as_str()
                    .or(args["state"].as_str())
                    .is_some_and(|status| e.status != status)
                || args["severity"]
                    .as_str()
                    .is_some_and(|severity| e.severity.as_deref() != Some(severity))
                || since.is_some_and(|t| e.updated_ms < t)
                || resource.as_ref().is_some_and(|r| !e.resources.contains(r))
            {
                continue;
            }
            let row = e.projection(actor);
            let size = row.to_string().len();
            if rows.len() >= limit || bytes + size > 120 * 1024 {
                more = true;
                break;
            }
            after = e.id.clone();
            bytes += size;
            rows.push(row);
        }
        let next = if more {
            let payload = URL_SAFE_NO_PAD.encode(json!({"scope":scope,"revision":self.data.revision,"expires":time+900_000,"after":after}).to_string());
            Some(format!(
                "{payload}.{}",
                hash(format!("{}:{payload}", self.data.epoch))
            ))
        } else {
            None
        };
        let confirmed: Vec<_> = self
            .data
            .entries
            .values()
            .filter(|e| matches!(e.status.as_str(), "open" | "triaged"))
            .collect();
        let blocking = confirmed
            .iter()
            .filter(|e| e.severity.as_deref() == Some("blocking"))
            .count();
        Ok(
            json!({"entries":rows,"nextCursor":next,"triageDue":args["beforeRelease"]==true || confirmed.len()>=8 || blocking>0,"counts":{"open":confirmed.len(),"blocking":blocking,"candidates":self.data.entries.values().filter(|e| e.status=="candidate").count(),"candidateOverflow":self.data.candidate_overflow},"observedAt":timestamp(time)}),
        )
    }
    /// Reader-scoped matters for board attention: owned candidates and due triage.
    pub(super) fn attention(&self, actor: &Value, triage: bool) -> Vec<Value> {
        let mut items: Vec<Value> = self
            .data
            .entries
            .values()
            .filter(|e| e.status == "candidate" && e.owns(actor))
            .take(20)
            .map(|e| {
                json!({"kind":"ax-candidate","id":e.id,"revision":e.revision,"severity":e.severity,
                    "summary":e.symptom.chars().take(160).collect::<String>(),"occurrenceCount":e.occurrence_count,
                    "ownerSourceId":e.source["sourceId"],"next":{"via":"query","op":"ax_list","args":{"id":e.id}}})
            })
            .collect();
        let confirmed = self
            .data
            .entries
            .values()
            .filter(|e| matches!(e.status.as_str(), "open" | "triaged"));
        let (open, blocking) = confirmed.fold((0, 0), |(n, b), e| {
            (
                n + 1,
                b + usize::from(e.severity.as_deref() == Some("blocking")),
            )
        });
        if triage && (open >= 8 || blocking > 0) {
            items.push(
                json!({"kind":"ax-triage","id":"ax-triage","open":open,"blocking":blocking,
                "next":{"via":"query","op":"ax_list","args":{"status":"open"}}}),
            );
        }
        items
    }
    pub(super) fn export(&mut self, path: &Path) -> Result<Value> {
        if path.exists() {
            return Err("AX_EXPORT_EXISTS: choose a new export path".into());
        }
        private_dir(
            path.parent()
                .ok_or("INVALID_ARGUMENT: absolute export path required")?,
        )?;
        let bytes =
            serde_json::to_vec(&json!({"format":"arc-ax-export-v1","entries":self.data.entries}))
                .map_err(|_| corrupt())?;
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path).map_err(|_| {
            "COORDINATION_STORAGE: cannot create AX export; choose a new private path"
        })?;
        let persisted = file.write_all(&bytes).and_then(|_| file.sync_all());
        if persisted.is_err() {
            drop(file);
            let _ = std::fs::remove_file(path);
            return Err("COORDINATION_STORAGE: AX export incomplete; restore disk capacity and export again".into());
        }
        #[cfg(unix)]
        std::fs::File::open(path.parent().unwrap())
            .and_then(|dir| dir.sync_all())
            .map_err(|_| "COORDINATION_STORAGE: cannot sync AX export directory")?;
        self.transaction(|s| {
            for e in s.data.entries.values_mut() {
                e.exported_revision = Some(e.revision);
            }
            Ok(json!({"exported":s.data.entries.len(),"sha256":hash(bytes)}))
        })
    }
}
impl Store {
    pub(super) fn candidate(
        &mut self,
        kind: Friction,
        observation: &str,
        principal: Option<Principal>,
        refs: Vec<EvidenceRef>,
        build: &str,
        time: i64,
    ) -> Result<Value> {
        let source = principal
            .filter(|p| matches!(p, Principal::Source { .. } | Principal::LocalAuthority))
            .map(|p| json!(p))
            .unwrap_or(json!({"type":"arc"}));
        let signature = hash(kind.signature());
        self.transaction(|s| {
            s.prune(time);
            if let Some(e)=s.data.entries.values().find(|e|e.candidate_signature.as_deref()==Some(&signature) && e.candidate_build.as_deref()==Some(build) && e.candidate_state.as_deref()==Some("rejected") && time.saturating_sub(e.updated_ms)<86_400_000) {
                return Ok(json!({"suppressed":true,"reason":"recent-rejection","id":e.id}));
            }
            let existing=s.data.entries.values().filter(|e| e.candidate_state.as_deref()!=Some("rejected") && e.status!="merged")
                .filter(|e| e.candidate_signature.as_deref()==Some(&signature)
                    || e.evidence.iter().any(|v| v["friction"] == kind.signature()))
                .min_by_key(|e| (e.status == "candidate", e.id.clone())).map(|e|e.id.clone());
            let observation=hash(observation);
            if let Some(key)=&existing {
                let e=&s.data.entries[key];
                if e.occurrences.contains(&observation) {
                    return Ok(json!({"coalesced":true,"id":key,"candidate":e.status=="candidate"}));
                }
            }
            if time.saturating_sub(s.data.candidate_bucket.0)>=3_600_000 { s.data.candidate_bucket=(time,0); }
            if existing.is_none() && s.data.candidate_bucket.1>=20 {
                s.data.candidate_overflow=s.data.candidate_overflow.saturating_add(1);
                return Ok(json!({"suppressed":true,"reason":"candidate-rate-limit","overflow":s.data.candidate_overflow}));
            }
            if existing.is_none() { s.data.candidate_bucket.1+=1; }
            let key=existing.unwrap_or_else(||format!("ax-{}",id()));
            let fresh=!s.data.entries.contains_key(&key);
            if fresh {
                s.data.entries.insert(key.clone(), Entry {
                    id:key.clone(),revision:0,kind:"friction".into(),symptom:kind.symptom().into(),expected:"Inspect the referenced observation and confirm or reject this friction hypothesis".into(),reproduction_hints:String::new(),severity:Some("workaround".into()),resources:vec![],source:source.clone(),arc_version:Some(crate::egress::arc_version().into()),evidence:vec![],first_seen_at:Some(timestamp(time)),last_seen_at:Some(timestamp(time)),occurrence_count:0,candidate_state:Some("pending".into()),status:"candidate".into(),resolution:None,merged_into:None,history:vec![],fingerprint:hash(signature.as_bytes()),occurrences:BTreeSet::new(),applied:BTreeSet::new(),pending:vec![],updated_ms:time,exported_revision:None,candidate_signature:Some(signature),candidate_build:Some(build.into()),
                });
            }
            let e=s.data.entries.get_mut(&key).unwrap();
            e.occurrences.insert(observation);
            e.occurrence_count=e.occurrences.len() as u64;
            if e.status != "candidate" { if e.status=="closed" {e.status="open".into();e.resolution=None;e.record("reopen",&json!({"type":"arc"}),json!({}),time);} }
            if e.evidence.len()>=16 {e.evidence.remove(1);}
            e.evidence.push(json!({"kind":"candidate-observation","friction":kind.signature(),"references":refs,"coreBuild":build,"observedAt":timestamp(time),"source":source}));
            e.last_seen_at=Some(timestamp(time));
            if fresh {e.record("candidate-created",&json!({"type":"arc"}),json!({}),time);} else {e.revision+=1;e.updated_ms=time;}
            e.event(if fresh {EventKind::AxCreated}else{EventKind::AxChanged});
            s.data.revision+=1;
            Ok(json!({"entry":e.projection(&source),"confirmationNeeded":e.status=="candidate"}))
        })
    }
}
impl Store {
    pub(super) fn import_reports(&mut self, reports: Vec<Value>, time: i64) -> Result<Value> {
        self.transaction(|s| {
            s.prune(time);
            let actor=json!({"type":"local-authority"});
            let mut imported=0;
            let mut unchanged=0;
            let mut entries=vec![];
            for mut args in reports {
                let key=string(&args,"id").to_owned();
                let report_hash=hash(args.to_string());
                let import_request=format!("import-{report_hash}");
                args["requestId"]=json!(import_request);
                if let Some(e)=s.data.entries.get(&key) {
                    if e.applied.contains(&import_request) {unchanged+=1;entries.push(e.projection(&json!({"type":"local-authority"})));continue;}
                    // An edited migration row enriches its original imported entry without another occurrence.
                    let e=s.data.entries.get_mut(&key).unwrap();
                    e.applied.insert(import_request);
                    e.record("import-updated",&actor,json!({"reportedOnly":true,"queueReport":args["queueReport"]}),time);
                    e.event(EventKind::AxChanged);
                } else {
                    let evidence=vec![json!({"kind":"import","reportedOnly":true,"provisionalSeverity":true,"observedAt":null,"coreBuild":null,"queueReport":args["queueReport"]})];
                    s.report(&args,&actor,evidence,time,Some(&key))?;
                }
                imported+=1;
                if let Some(e)=s.data.entries.get(&key) {entries.push(e.projection(&json!({"type":"local-authority"})));}
            }
            if imported>0 {s.data.revision+=1;}
            Ok(json!({"imported":imported,"unchanged":unchanged,"entries":entries,"queueModified":false}))
        })
    }
}
