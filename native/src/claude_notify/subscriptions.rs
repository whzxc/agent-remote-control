//! One subscription contract and router for every notification channel.
use super::*;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Webhook {
    pub principal: String,
    pub url: String,
    pub secret: String,
    pub previous_secret: Option<String>,
    pub rotate_until: i64,
    pub verified_until: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Subscription {
    pub id: String,
    pub source_id: String,
    pub channel: Channel,
    pub target: String,
    pub op: String,
    pub args: Value,
    pub turn: Option<String>,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub webhook: Option<Webhook>,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub until: Option<i64>,
}
impl Subscription {
    pub fn matches(&self, b: &Binding) -> bool {
        let agent = !b.agent.is_empty() && b.agent != "codex";
        !self.source_id.is_empty()
            && self.source_id == b.source_id
            && self.op == "task_status"
            && self.turn.as_ref().is_none_or(|t| *t == b.turn_id)
            && self.args["threadId"]
                .as_str()
                .is_none_or(|id| !agent && id == b.thread_id)
            && self.args["taskId"]
                .as_str()
                .is_none_or(|id| agent && id == b.thread_id)
    }
    pub fn active(&self, now_ms: i64) -> bool {
        self.expires_at.is_none_or(|at| at > now_ms)
    }
    pub fn muted(&self, now: i64) -> bool {
        self.muted && self.until.is_none_or(|at| now < at)
    }
    pub fn public(&self, now: i64) -> Value {
        json!({"id":self.id,"channel":self.channel,"target":self.target,"op":self.op,"args":self.args,"turnId":self.turn,"active":self.active(now.saturating_mul(1000)),"muted":self.muted(now),"until":self.until,"createdAt":self.created_at,"expiresAt":self.expires_at})
    }
}

pub(super) fn claude_id(b: &Binding) -> String {
    format!(
        "sub_{}",
        hash(
            json!([
                "claude-session",
                b.source_id,
                b.agent,
                b.thread_id,
                b.turn_id
            ])
            .to_string()
        )
    )
}

pub(crate) fn guide() -> Value {
    json!({"event":"notification","inputSchema":{"type":"object","properties":{"op":{"type":"string"},"args":{"type":"object"}},"required":["op","args"],"additionalProperties":false},"ops":[{"op":"task_status","description":"Task completed, failed (including interruption not automatically resumed), or needs execution input/approval; only tasks dispatched through this source. Lifecycle and ownership events remain inbox-only. Empty args watches all such tasks; both filters must match when supplied.","inputSchema":task_schema(),"example":{"name":"notification","arguments":{"op":"task_status","args":{}}}}]})
}
fn task_schema() -> Value {
    json!({"type":"object","properties":{"threadId":{"type":"string","minLength":1},"taskId":{"type":"string","minLength":1}},"additionalProperties":false})
}
pub(super) fn validate(arguments: &Value) -> Result<Value> {
    let error = |reason: &str| {
        json!({"code":-32602,"message":"Invalid notification subscription","data":{"reason":reason,"guide":{"tool":"guide","arguments":{"topic":"notify"}},"contract":guide()}}).to_string()
    };
    crate::validator("event", "notification", &guide()["inputSchema"])?
        .validate(arguments)
        .map_err(|_| error("invalid_arguments"))?;
    if arguments["op"] != "task_status" {
        return Err(error("unknown_op"));
    }
    crate::validator("event-op", "task_status", &task_schema())?
        .validate(&arguments["args"])
        .map_err(|_| error("invalid_op_arguments"))?;
    let mut args = serde_json::Map::new();
    for k in ["taskId", "threadId"] {
        if let Some(v) = arguments["args"].get(k) {
            args.insert(k.into(), v.clone());
        }
    }
    Ok(json!({"op":"task_status","args":args}))
}

pub(super) fn sync(state: &mut State, bindings: &[Binding]) {
    // Derive each persistent identity once. Historical bindings must not turn
    // every delivery tick into a subscription-by-binding hash scan.
    let bindings: Vec<_> = bindings
        .iter()
        .filter(|b| !b.source_id.is_empty() && b.target.is_some())
        .map(|b| (claude_id(b), b))
        .collect();
    let ids: std::collections::HashSet<_> = bindings.iter().map(|(id, _)| id.as_str()).collect();
    state.subscriptions.retain(|s| {
        !s.source_id.is_empty()
            && (s.channel != Channel::ClaudeSession || ids.contains(s.id.as_str()))
    });
    let mut positions = std::collections::HashMap::new();
    for (index, subscription) in state.subscriptions.iter().enumerate() {
        positions.entry(subscription.id.clone()).or_insert(index);
    }
    for (id, b) in bindings {
        let target = b.target.as_ref().unwrap();
        if let Some(index) = positions.get(&id) {
            state.subscriptions[*index].target = target.clone();
        } else {
            positions.insert(id.clone(), state.subscriptions.len());
            state.subscriptions.push(Subscription {
                id,
                source_id: b.source_id.clone(),
                channel: Channel::ClaudeSession,
                target: target.clone(),
                op: "task_status".into(),
                args: if b.agent.is_empty() || b.agent == "codex" {
                    json!({"threadId":b.thread_id})
                } else {
                    json!({"taskId":b.thread_id})
                },
                turn: Some(b.turn_id.clone()),
                created_at: b.created_at.saturating_mul(1000),
                expires_at: None,
                webhook: None,
                muted: false,
                until: None,
            });
        }
    }
}

pub(super) fn route(state: &State, bindings: &mut [Binding], now: i64) {
    for b in bindings {
        let source_count = b.deliveries.len();
        for sub in &state.subscriptions {
            if !sub.active(now.saturating_mul(1000)) || !sub.matches(b) {
                continue;
            }
            for source_index in 0..source_count {
                let source = &b.deliveries[source_index];
                // Only task outcomes and pending execution interactions may push.
                if !wakes(source)
                    || matches!(source.status.as_str(), "resolved" | "inbox-only")
                    || source.interaction["resolved"] == true
                {
                    continue;
                }
                if sub.channel == Channel::McpEvents
                    && source
                        .timing
                        .queued_at
                        .unwrap_or(source.created_at.saturating_mul(1000))
                        < sub.created_at
                {
                    continue;
                }
                if b.deliveries
                    .iter()
                    .any(|d| d.subscription == sub.id && d.event_id == source.event_id)
                {
                    continue;
                }
                // The original Claude delivery is also the persisted source event.
                if sub.channel == Channel::ClaudeSession {
                    if let Some(index) = b.deliveries.iter().position(|d| {
                        d.event_id == source.event_id && d.channel == Channel::ClaudeSession
                    }) {
                        b.deliveries[index].subscription = sub.id.clone();
                        continue;
                    }
                }
                let mut d = source.clone();
                d.subscription = sub.id.clone();
                d.channel = sub.channel;
                d.target = sub.target.clone();
                d.status = "pending".into();
                d.error = None;
                d.batch.clear();
                d.attempts.clear();
                d.attempted_at = 0;
                d.token_charged = false;
                d.failures = 0;
                d.next_attempt_at = 0;
                d.digest = false;
                d.timing = DeliveryTiming {
                    queued_at: source.timing.queued_at,
                    ..Default::default()
                };
                b.deliveries.push(d);
            }
        }
        for d in &mut b.deliveries {
            if d.channel == Channel::McpEvents
                && d.status == "pending"
                && !state
                    .subscriptions
                    .iter()
                    .any(|s| s.id == d.subscription && s.active(now.saturating_mul(1000)))
            {
                d.status = "subscription-ended".into();
            }
        }
    }
}
