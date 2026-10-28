//! Atomic bounded owner snapshot, including reply reservations and pending projections.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
const DAY: i64 = 86400;
const MAX_ROWS: usize = 2000;
const BYTES: usize = 4 * 1024 * 1024; // Snapshot plus atomic temporary fits 8 MiB.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Data {
    epoch: String,
    next: u64,
    floor: u64,
    messages: Vec<Row>,
    negotiations: Vec<Negotiation>,
    pending: Vec<EventInput>,
    last_push: BTreeMap<String, i64>,
    #[serde(default, rename = "routes", skip_serializing_if = "BTreeMap::is_empty")]
    pub legacy_routes: BTreeMap<String, Route>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Row {
    pub envelope: Value,
    sequence: u64,
    digest: String,
    pub route: Option<Route>,
    pub due: i64,
    pub attempts: u32,
    #[serde(default)]
    recovery_refs: Vec<Value>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Negotiation {
    id: String,
    participants: [String; 2],
    initiator: String,
    resources: Vec<ResourceKey>,
    state: String,
    automatic_reply_count: u32,
    reply_limit: u32,
    created_at: i64,
    expires_at: i64,
    last_message_id: String,
    escalation_id: Option<String>,
    decisions: Vec<Value>,
}
pub(super) struct Store {
    path: PathBuf,
    data: Data,
}
impl Store {
    pub fn open(path: PathBuf) -> Result<Self> {
        private_dir(
            path.parent()
                .ok_or("COORDINATION_STORAGE: invalid messages path")?,
        )?;
        let mut migrated = false;
        let data = if path.exists() {
            if std::fs::metadata(&path)
                .map_err(|_| "COORDINATION_STORAGE: cannot stat messages")?
                .len()
                > BYTES as u64
            {
                return Err("COORDINATION_CAPACITY: messages snapshot exceeds capacity".into());
            }
            let bytes =
                std::fs::read(&path).map_err(|_| "COORDINATION_STORAGE: cannot read messages")?;
            let mut value: Value = serde_json::from_slice(&bytes).map_err(|_| {
                "COORDINATION_CORRUPT: preserve messages snapshot for local recovery"
            })?;
            // Retire the replacement wake reservation without retaining a second router.
            if let Some(object) = value.as_object_mut() {
                migrated |= object.remove("recoveryWindows").is_some();
            }
            let mut data: Data = serde_json::from_value(value).map_err(|_| {
                "COORDINATION_CORRUPT: preserve messages snapshot for local recovery"
            })?;
            for row in &mut data.messages {
                if row.envelope["localOrigin"] == "arc"
                    && row.envelope["deliveryState"] == "pending"
                {
                    row.route = None;
                    row.envelope["deliveryState"] = json!("pull-only");
                    migrated = true;
                }
            }
            data
        } else {
            Data {
                epoch: id(),
                next: 1,
                ..Default::default()
            }
        };
        let store = Self { path, data };
        if !store.path.exists() || migrated {
            store.save()?;
        }
        Ok(store)
    }
    fn save(&self) -> Result<()> {
        let bytes = serde_json::to_vec(&self.data).map_err(|e| e.to_string())?;
        if bytes.len() > BYTES
            || self.data.messages.len() > MAX_ROWS
            || self.data.negotiations.len() > 128
            || self.data.pending.len() > MAX_ROWS
            || self.data.last_push.len() > 128
            || self.data.legacy_routes.len() > 128
        {
            return Err("COORDINATION_CAPACITY: use local messages management to resolve escalations; wait for closed history retention".into());
        }
        super::super::journal::atomic_bytes(&self.path, &bytes)
    }
    fn transaction<T>(&mut self, f: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        let before = self.data.clone();
        let result = f(self).and_then(|v| {
            if serde_json::to_vec(&self.data).map_err(|e| e.to_string())?
                != serde_json::to_vec(&before).map_err(|e| e.to_string())?
            {
                self.save()?;
            }
            Ok(v)
        });
        if result.is_err() {
            self.data = before;
        }
        result
    }
    fn event(&mut self, transition: String, kind: EventKind, resources: Vec<ResourceKey>) {
        for (index, resources) in resources.chunks(4).enumerate() {
            self.data.pending.push(EventInput::new(
                format!("{transition}-{index}"),
                kind.clone(),
                resources.to_vec(),
            ));
        }
    }
    pub fn migrate_routes(&mut self) -> Result<()> {
        if self.data.legacy_routes.is_empty() {
            return Ok(());
        }
        super::super::bulletin::import_routes(&self.data.legacy_routes)?;
        self.transaction(|s| {
            s.data.legacy_routes.clear();
            Ok(())
        })
    }
    pub fn pending(&self) -> Vec<EventInput> {
        self.data.pending.iter().take(64).cloned().collect()
    }
    pub fn projected(&mut self, id: &str) -> Result<()> {
        self.transaction(|s| {
            s.data.pending.retain(|e| e.transition_id != id);
            Ok(())
        })
    }
    fn maintain(&mut self, time: i64) {
        for n in &mut self.data.negotiations {
            if n.state == "open" && n.expires_at <= time {
                n.state = "expired".into();
                self.data.pending.push(EventInput::new(
                    format!("{}-expired", n.id),
                    EventKind::NegotiationChanged,
                    n.resources.clone(),
                ));
            }
        }
        for row in &mut self.data.messages {
            if row.envelope["deliveryState"] == "pending"
                && row.envelope["expiresAt"].as_i64().unwrap_or(0) <= time
            {
                row.envelope["deliveryState"] = json!("expired");
            }
            // A reserved send may have reached the peer before restart. Never wake it again.
            if row.envelope["deliveryState"] == "sending" {
                row.envelope["deliveryState"] = json!("unconfirmed");
            }
        }
        self.data.messages.retain(|r| {
            let keep = r.envelope["createdAt"].as_i64().unwrap_or(time) > time - 7 * DAY;
            if !keep {
                self.data.floor = self.data.floor.max(r.sequence);
            }
            keep
        });
        self.data
            .negotiations
            .retain(|n| n.state == "escalated" || n.expires_at > time - 7 * DAY);
        self.data.last_push.retain(|_, at| *at > time - DAY);
    }
    fn result(&self, row: &Row) -> Value {
        let n = self
            .data
            .negotiations
            .iter()
            .find(|n| row.envelope["negotiationId"] == n.id);
        json!({"stored":true,"pullable":true,"hint":"The message is stored and pullable through messages.","message":row.envelope,"negotiation":n,"deliveryMode":if row.route.is_some(){"proactive"}else{"pull-only"},"routing":super::super::routing::description(&crate::claude_notify::coordination_delivery::Outcome {route:row.route.clone(),state:row.envelope["deliveryReason"].as_str().unwrap_or("no-verified-target").into()}, string(&row.envelope,"toSourceId"), row.envelope["toSessionId"].as_str())})
    }
    pub fn send(
        &mut self,
        args: &Value,
        actor: &str,
        route: Option<Route>,
        reason: &str,
        time: i64,
    ) -> Result<Value> {
        let digest = hash(json!([actor, args]).to_string());
        if let Some(row) = self
            .data
            .messages
            .iter()
            .find(|r| r.envelope["messageId"] == args["requestId"])
        {
            if row.digest != digest {
                return Err("REQUEST_ID_CONFLICT: retain the original message arguments".into());
            }
            return Ok(self.result(row));
        }
        self.transaction(|s| s.insert(args, actor, route, reason, time, digest))
    }
    fn insert(
        &mut self,
        args: &Value,
        actor: &str,
        route: Option<Route>,
        reason: &str,
        time: i64,
        digest: String,
    ) -> Result<Value> {
        self.maintain(time);
        let target = string(args, "toSourceId");
        if target == actor {
            return Err("INVALID_ARGUMENT: address another control source".into());
        }
        let mut participants = [actor.to_owned(), target.to_owned()];
        participants.sort();
        let resources = resources(args)?;
        let negotiation = args["negotiationId"].as_str();
        // Source pairs deliberately outlive session/account changes. Partial overlap also holds.
        if self.data.negotiations.iter().any(|n| {
            n.state == "escalated"
                && n.participants == participants
                && n.resources.iter().any(|r| resources.contains(r))
        }) {
            return Err(limit());
        }
        let reply = args["inReplyTo"].as_str();
        let mut ni = None;
        if let Some(reference) = reply {
            let old = self.data.messages.iter().find(|r| r.envelope["messageId"] == reference)
                .ok_or("INVALID_ARGUMENT: inReplyTo must reference a retained message addressed to you; use relatedIds for other metadata links")?;
            if old.envelope["fromSourceId"] != target || old.envelope["toSourceId"] != actor {
                return Err("INVALID_ARGUMENT: inReplyTo must reference a message addressed to you by toSourceId; use relatedIds for other metadata links".into());
            }
            if args["type"] == "notice" {
                if negotiation.is_some() {
                    return Err("INVALID_ARGUMENT: notice replies must omit negotiationId; inReplyTo links the message without opening or advancing a negotiation".into());
                }
            } else {
                let n = self.data.negotiations.iter().position(|n| Some(n.id.as_str()) == negotiation)
                .ok_or("NEGOTIATION_NOT_FOUND: negotiation replies require negotiationId; use type:notice with inReplyTo for a notice reply, or relatedIds to link metadata")?;
                if old.envelope["negotiationId"] != self.data.negotiations[n].id
                    || self.data.negotiations[n].participants != participants
                    || self.data.negotiations[n].resources != resources
                {
                    return Err("INVALID_ARGUMENT: reply must reference this peer's message in the same negotiation and resource set".into());
                }
                if matches!(string(args, "type"), "grant" | "deny")
                    && !matches!(string(&old.envelope, "type"), "request" | "conditional")
                {
                    return Err(
                        "INVALID_ARGUMENT: grant or deny must answer a request or conditional"
                            .into(),
                    );
                }
                if self.data.negotiations[n].expires_at <= time {
                    return Err(
                        "NEGOTIATION_EXPIRED: inspect messages and start a new request".into(),
                    );
                }
                if self.data.negotiations[n].state == "resolved"
                    && self.data.negotiations[n]
                        .decisions
                        .last()
                        .is_some_and(|d| d["action"] == "resolve")
                {
                    return Err("NEGOTIATION_RESOLVED: the user resolved this exchange; inspect messages before starting a new request".into());
                }
                self.data.negotiations[n].automatic_reply_count += 1;
                ni = Some(n);
            }
        } else if args["type"] == "request" {
            if self
                .data
                .negotiations
                .iter()
                .any(|n| Some(n.id.as_str()) == negotiation)
            {
                return Err("INVALID_ARGUMENT: existing negotiation requires inReplyTo".into());
            }
            if self
                .data
                .negotiations
                .iter()
                .filter(|n| n.initiator == actor && n.created_at > time - 3600)
                .count()
                >= 10
                || participants.iter().any(|participant| {
                    self.data
                        .negotiations
                        .iter()
                        .filter(|n| n.participants.contains(participant) && n.state == "open")
                        .count()
                        >= 4
                })
            {
                return Err("COORDINATION_RATE_LIMIT: at most four open negotiations per source and ten initiations per hour".into());
            }
            self.data.negotiations.push(Negotiation {
                id: negotiation.map(str::to_owned).unwrap_or_else(id),
                participants,
                initiator: actor.into(),
                resources: resources.clone(),
                state: "open".into(),
                automatic_reply_count: 0,
                reply_limit: 3,
                created_at: time,
                expires_at: time + DAY,
                last_message_id: String::new(),
                escalation_id: None,
                decisions: vec![],
            });
            ni = Some(self.data.negotiations.len() - 1);
        } else if negotiation.is_some()
            || matches!(string(args, "type"), "grant" | "deny" | "conditional")
        {
            return Err("INVALID_ARGUMENT: replies require negotiationId and inReplyTo".into());
        }
        let mid = string(args, "requestId").to_owned();
        let mut escalated = false;
        if let Some(n) = ni {
            let n = &mut self.data.negotiations[n];
            if n.automatic_reply_count > n.reply_limit {
                return Err(limit());
            }
            n.last_message_id = mid.clone();
            n.state = if n.automatic_reply_count == n.reply_limit {
                escalated = true;
                n.escalation_id = Some(id());
                "escalated"
            } else if matches!(string(args, "type"), "grant" | "deny") {
                "resolved"
            } else {
                "open"
            }
            .into();
        }
        let envelope = json!({"messageId":mid,"negotiationId":ni.map(|n|&self.data.negotiations[n].id),"inReplyTo":args["inReplyTo"],"fromSourceId":actor,"fromSessionId":args["sessionId"],"toSourceId":target,"toSessionId":args["toSessionId"],"type":args["type"],"resources":resources,"summary":args["summary"],"conditions":args["conditions"],"relatedIds":args["relatedIds"],"automatic":true,"createdAt":time,"expiresAt":time+args["ttlSeconds"].as_i64().unwrap_or(DAY),"deliveryReason":reason,"deliveryState":if route.is_some(){"pending"}else{"pull-only"},"escalated":escalated,"dataOnly":true});
        if envelope.to_string().len() > 4096 {
            return Err("COORDINATION_CAPACITY: message envelope exceeds 4 KiB".into());
        }
        self.data.messages.push(Row {
            envelope,
            sequence: self.data.next,
            digest,
            route,
            due: time + 30,
            attempts: 0,
            recovery_refs: vec![],
        });
        self.data.next += 1;
        let result = self.result(self.data.messages.last().unwrap());
        self.event(
            format!("{mid}-created"),
            EventKind::MessageCreated,
            resources.clone(),
        );
        if ni.is_some() {
            self.event(
                format!("{mid}-negotiation"),
                EventKind::NegotiationChanged,
                resources.clone(),
            );
        }
        if escalated {
            let n = self.data.negotiations[ni.unwrap()].clone();
            for participant in &n.participants {
                let recipient = self
                    .data
                    .messages
                    .iter()
                    .rev()
                    .find(|r| {
                        r.envelope["toSourceId"] == *participant
                            && r.envelope["negotiationId"] == n.id
                    })
                    .cloned();
                let to_session = recipient
                    .as_ref()
                    .map(|r| r.envelope["toSessionId"].clone());
                let envelope = json!({"messageId":format!("{}-{}",n.escalation_id.as_ref().unwrap(),hash(participant)),"negotiationId":n.id,"fromSourceId":null,"localOrigin":"arc","toSourceId":participant,"toSessionId":to_session,"type":"notice","resources":resources,"summary":"Automatic reply budget exhausted. Ask the user to mediate; further automatic negotiation is stopped.","automatic":true,"createdAt":time,"expiresAt":time+DAY,"deliveryState":"pull-only","escalated":true,"dataOnly":true});
                self.data.messages.push(Row {
                    envelope,
                    sequence: self.data.next,
                    digest: String::new(),
                    route: None,
                    due: time + 30,
                    attempts: 0,
                    recovery_refs: vec![],
                });
                self.data.next += 1;
            }
        }
        Ok(result)
    }
    pub fn list(&mut self, args: &Value, actor: &str, revision: &str, time: i64) -> Result<Value> {
        self.transaction(|s| {
            s.maintain(time);
            Ok(())
        })?;
        if let Some(mid) = args["recoveryMessageId"].as_str() {
            let row = self
                .data
                .messages
                .iter()
                .find(|r| {
                    r.envelope["messageId"] == mid
                        && (actor == "local-authority" || r.envelope["toSourceId"] == actor)
                })
                .ok_or("MESSAGE_NOT_FOUND: read your addressed recovery messages")?;
            let offset = args["recoveryCursor"]
                .as_str()
                .unwrap_or("0")
                .parse::<usize>()
                .map_err(|_| "INVALID_ARGUMENT: use the recovery cursor returned by messages")?;
            if offset > row.recovery_refs.len() {
                return Err("MESSAGES_CURSOR_EXPIRED: reread the recovery message after successor suppression".into());
            }
            let end = (offset + 20).min(row.recovery_refs.len());
            return Ok(
                json!({"messageId":mid,"threadRefs":row.recovery_refs[offset..end],"nextRecoveryCursor":(end < row.recovery_refs.len()).then(||end.to_string()),"automaticResume":false}),
            );
        }
        let direction = args["direction"].as_str().unwrap_or("inbox");
        let scope = hash(
            json!([
                actor,
                revision,
                direction,
                args["sessionId"],
                args["negotiationId"]
            ])
            .to_string(),
        );
        let after = if let Some(cursor) = args["cursor"].as_str() {
            let v: Value = URL_SAFE_NO_PAD
                .decode(cursor)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .ok_or("MESSAGES_CURSOR_EXPIRED: restart messages pagination")?;
            let sequence = v["after"]
                .as_u64()
                .ok_or("MESSAGES_CURSOR_EXPIRED: invalid cursor")?;
            if v["epoch"] != self.data.epoch
                || v["scope"] != scope
                || sequence < self.data.floor
                || sequence >= self.data.next
            {
                return Err("MESSAGES_CURSOR_EXPIRED: restart pagination with current authority and filters".into());
            }
            sequence
        } else {
            self.data.floor
        };
        let limit = args["limit"].as_u64().unwrap_or(50) as usize;
        let matching: Vec<_> = self
            .data
            .messages
            .iter()
            .filter(|r| {
                r.sequence > after
                    && (actor == "local-authority"
                        || if direction == "outbox" {
                            r.envelope["fromSourceId"] == actor
                        } else {
                            r.envelope["toSourceId"] == actor
                        })
                    && args["negotiationId"]
                        .as_str()
                        .is_none_or(|n| r.envelope["negotiationId"] == n)
                    && args["sessionId"].as_str().is_none_or(|n| {
                        r.envelope[if direction == "outbox" {
                            "fromSessionId"
                        } else {
                            "toSessionId"
                        }] == n
                    })
            })
            .collect();
        let rows: Vec<_> = matching
            .iter()
            .take(limit)
            .map(|r| r.envelope.clone())
            .collect();
        let last = matching
            .iter()
            .take(limit)
            .last()
            .map_or(self.data.next - 1, |r| r.sequence);
        let cursor = URL_SAFE_NO_PAD
            .encode(json!({"epoch":self.data.epoch,"scope":scope,"after":last}).to_string());
        let negotiations: Vec<_> = self
            .data
            .negotiations
            .iter()
            .filter(|n| {
                (actor == "local-authority" || n.participants.contains(&actor.to_owned()))
                    && args["negotiationId"].as_str().is_none_or(|id| id == n.id)
            })
            .collect();
        Ok(
            json!({"messages":rows,"negotiations":negotiations,"nextCursor":cursor,"hasMore":matching.len()>limit,"dataOnly":true,"projectionPending":!self.data.pending.is_empty()}),
        )
    }
    pub fn batches(&mut self, time: i64) -> Result<Vec<Vec<Row>>> {
        self.transaction(|s| {
            s.maintain(time);
            Ok(())
        })?;
        let mut groups: BTreeMap<String, Vec<Row>> = BTreeMap::new();
        for row in &self.data.messages {
            if row.envelope["deliveryState"] != "pending" || row.due > time {
                continue;
            }
            if let Some(route) = &row.route {
                if self
                    .data
                    .last_push
                    .get(&route.key())
                    .is_none_or(|at| time - at >= 60)
                {
                    groups.entry(route.key()).or_default().push(row.clone());
                }
            }
        }
        // Include later arrivals in the same target's first due batch.
        for rows in groups.values_mut() {
            let key = rows[0].route.as_ref().unwrap().key();
            *rows = self
                .data
                .messages
                .iter()
                .filter(|r| {
                    r.envelope["deliveryState"] == "pending"
                        && r.route.as_ref().is_some_and(|t| t.key() == key)
                })
                .take(16)
                .cloned()
                .collect();
        }
        Ok(groups.into_values().take(16).collect())
    }
    pub fn mark(&mut self, rows: &[Row], state: &str, time: i64) -> Result<()> {
        self.transaction(|s| {
            for row in rows {
                if let Some(r) = s
                    .data
                    .messages
                    .iter_mut()
                    .find(|r| r.sequence == row.sequence)
                {
                    r.envelope["deliveryState"] = json!(state);
                    if state == "sending" {
                        r.attempts += 1;
                        s.data
                            .last_push
                            .insert(r.route.as_ref().unwrap().key(), time);
                    }
                    if state == "pending" {
                        r.due = time + 60;
                        r.attempts = r.attempts.saturating_sub(1);
                    }
                }
            }
            if !matches!(state, "sending" | "pending") {
                if let Some(row) = rows.first() {
                    s.event(
                        format!("{}-delivery-{}", string(&row.envelope, "messageId"), state),
                        EventKind::MessageDelivery,
                        resources(&row.envelope)?,
                    );
                }
            }
            Ok(())
        })
    }
    pub fn mediate(&mut self, args: &Value, time: i64) -> Result<Value> {
        self.transaction(|s| {
            let n=s.data.negotiations.iter_mut().find(|n|n.id==string(args,"negotiationId")).ok_or("NEGOTIATION_NOT_FOUND: inspect local messages")?;
            if n.last_message_id!=string(args,"expectedLastMessageId") {return Err("NEGOTIATION_CONFLICT: reread the local negotiation".into());}
            if n.decisions.len()>=64 {return Err("COORDINATION_CAPACITY: local decision history is full".into());}
            n.decisions.push(json!({"at":time,"actor":"local-authority","action":args["action"],"reason":args["reason"]}));
            n.state=if args["action"]=="reopen" {"open"}else{"resolved"}.into(); if args["action"]=="reopen" {n.automatic_reply_count=0; n.expires_at=time+DAY;} n.escalation_id=None;
            let result=json!(n); let resources=n.resources.clone();
            s.event(format!("{}-mediated-{}",string(args,"negotiationId"),id()),EventKind::NegotiationChanged,resources);
            Ok(json!({"negotiation":result}))
        })
    }
}
fn limit() -> String {
    "NEGOTIATION_LIMIT: three combined automatic replies exhausted; both participants must stop and ask the user to mediate in local ARC management".into()
}

impl Store {
    pub fn recovery(&mut self, blocker: &Value, recipient: &Value, time: i64) -> Result<Value> {
        let mid = hash(
            json!([
                "recovery",
                blocker["id"],
                blocker["revision"],
                recipient["sessionId"]
            ])
            .to_string(),
        );
        if let Some(row) = self
            .data
            .messages
            .iter()
            .find(|r| r.envelope["messageId"] == mid)
        {
            return Ok(self.result(row));
        }
        self.transaction(|s| {
            s.maintain(time);
            let source = string(recipient,"sourceId");
            let session = string(recipient,"sessionId");
            let threads = recipient["threadRefs"].as_array().cloned().unwrap_or_default();
            let envelope = json!({"messageId":mid,"localOrigin":"arc","fromSourceId":null,"toSourceId":source,"toSessionId":session,"type":"recovery","resources":blocker["resources"],"blockerId":blocker["id"],"clearRevision":blocker["revision"],"causeCode":blocker["causeCode"],"summary":blocker["summary"],"provenance":"source-reported","clearance":"claim","clearedBy":blocker["clearedBy"],"fixingCommit":blocker["fixingCommit"],"reason":blocker["reason"],"evidenceIds":blocker["evidenceIds"],"suggestedNextStep":"inspect","reportedNextStep":blocker["suggestedNextStep"],"impact":"candidate-co-occurrence","openedAt":blocker["openedAt"],"clearedAt":blocker["clearedAt"],"automatic":true,"dataOnly":true,"automaticResume":false,"createdAt":time,"expiresAt":time+DAY,"deliveryState":"pull-only"});
            let mut row = Row { envelope, sequence:s.data.next,digest:mid.clone(),route:None,due:time+30,attempts:0,recovery_refs:threads };
            recovery_page(&mut row)?;
            s.data.messages.push(row);
            s.data.next += 1;
            s.event(format!("{mid}-created"),EventKind::MessageCreated,resources(blocker)?);
            Ok(s.result(s.data.messages.last().unwrap()))
        })
    }
    pub fn refresh_recovery(&mut self, events: &[Value]) -> Result<()> {
        self.transaction(|s| {
            let mut changed = vec![];
            for row in &mut s.data.messages {
                if row.envelope["type"] != "recovery"
                    || !matches!(
                        string(&row.envelope, "deliveryState"),
                        "pending" | "pull-only"
                    )
                {
                    continue;
                }
                let before = row.recovery_refs.len();
                row.recovery_refs
                    .retain(|r| !super::super::recovery::obsolete(r, events));
                if row.recovery_refs.len() != before {
                    recovery_page(row)?;
                    if row.recovery_refs.is_empty() {
                        row.envelope["deliveryState"] = json!("suppressed");
                        changed.push((
                            string(&row.envelope, "messageId").to_owned(),
                            resources(&row.envelope)?,
                        ));
                    }
                }
            }
            for (id, resources) in changed {
                s.event(
                    format!("{id}-suppressed"),
                    EventKind::MessageDelivery,
                    resources,
                );
            }
            Ok(())
        })
    }
}
fn recovery_page(row: &mut Row) -> Result<()> {
    let mut count = row.recovery_refs.len().min(20);
    loop {
        row.envelope["threadRefs"] = json!(&row.recovery_refs[..count]);
        row.envelope["next"] = if row.recovery_refs.len() > count {
            json!({"via":"query","op":"messages","args":{"recoveryMessageId":row.envelope["messageId"],"recoveryCursor":count.to_string()}})
        } else {
            Value::Null
        };
        if row.envelope.to_string().len() <= 4096 {
            return Ok(());
        }
        if count <= 1 {
            return Err(
                "COORDINATION_CAPACITY: recovery metadata exceeds the 4 KiB message bound".into(),
            );
        }
        count -= 1;
    }
}
impl Store {
    pub fn reserve(&mut self, rows: &[Row], events: &[Value], time: i64) -> Result<Vec<Row>> {
        self.refresh_recovery(events)?;
        let selected: Vec<_> = self
            .data
            .messages
            .iter()
            .filter(|r| {
                r.envelope["deliveryState"] == "pending"
                    && rows.iter().any(|old| old.sequence == r.sequence)
            })
            .cloned()
            .collect();
        self.mark(&selected, "sending", time)?;
        Ok(selected)
    }
}
