//! Persisted target buckets and reversible thread controls; no task decisions.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Batch {
    pub id: String,
    pub at: i64,
    pub kinds: std::collections::BTreeMap<String, usize>,
    pub threads: Vec<String>,
    pub status: String,
    pub charged: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Target {
    pub channel: Channel,
    pub target: String,
    pub tokens: u64,
    pub refilled_at: i64,
    pub breaker: bool,
    pub empty_since: Option<i64>,
    pub escalated: bool,
    pub escalation_error: Option<String>,
    pub batches: Vec<Batch>,
}
impl Target {
    pub fn refill(&mut self, now: i64, settings: &Value) {
        let capacity = capacity(settings);
        let interval = refill_seconds(settings);
        self.tokens = self.tokens.min(capacity);
        let ticks = now.saturating_sub(self.refilled_at).max(0) / interval;
        self.tokens = self.tokens.saturating_add(ticks as u64).min(capacity);
        if self.tokens == capacity {
            self.refilled_at = now;
        } else {
            self.refilled_at = self
                .refilled_at
                .saturating_add(ticks.saturating_mul(interval));
        }
        self.batches.retain(|b| b.at > now.saturating_sub(3600));
    }
    pub fn anomaly(&mut self, now: i64, waiting: bool, settings: &Value) -> Option<&'static str> {
        if self.tokens == 0 && waiting {
            self.empty_since.get_or_insert(now);
        } else {
            self.empty_since = None;
        }
        let reason = if self.breaker {
            Some("breaker")
        } else if self
            .empty_since
            .is_some_and(|since| now.saturating_sub(since) >= escalation_seconds(settings))
        {
            Some("token-wait")
        } else {
            None
        };
        if !self.breaker && self.empty_since.is_none() {
            self.escalated = false;
            self.escalation_error = None;
        }
        if reason.is_some() && !self.escalated {
            self.escalated = true;
            reason
        } else {
            None
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Rebind {
    pub channel: Channel,
    pub target: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Thread {
    pub thread_id: String,
    pub ingress: String,
    pub mode: String,
    pub until: Option<i64>,
    pub digest_at: i64,
    pub rebind: Option<Rebind>,
    pub last_delivered_at: Option<i64>,
    pub last_ack_at: Option<i64>,
}
impl Thread {
    pub fn mode(&self, now: i64) -> &str {
        if self.until.is_some_and(|until| now >= until) {
            "normal"
        } else {
            &self.mode
        }
    }
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct State {
    pub targets: Vec<Target>,
    pub threads: Vec<Thread>,
}
impl State {
    pub fn load(dir: &Path) -> Result<Self> {
        let path = dir.join("control/state.json");
        if !path.exists() {
            return Ok(Self::default());
        }
        serde_json::from_value(load(&path)?).map_err(|e| e.to_string())
    }
    pub fn save(&self, dir: &Path) -> Result<()> {
        save(
            &dir.join("control/state.json"),
            &serde_json::to_value(self).map_err(|e| e.to_string())?,
        )
    }
    pub fn target(
        &mut self,
        channel: Channel,
        target: &str,
        now: i64,
        settings: &Value,
    ) -> &mut Target {
        let index = self
            .targets
            .iter()
            .position(|t| t.channel == channel && t.target == target)
            .unwrap_or_else(|| {
                self.targets.push(Target {
                    channel,
                    target: target.into(),
                    tokens: capacity(settings),
                    refilled_at: now,
                    breaker: false,
                    empty_since: None,
                    escalated: false,
                    escalation_error: None,
                    batches: vec![],
                });
                self.targets.len() - 1
            });
        self.targets[index].refill(now, settings);
        &mut self.targets[index]
    }
    pub fn thread(&mut self, b: &Binding, now: i64) -> &mut Thread {
        let index = self
            .threads
            .iter()
            .position(|t| t.thread_id == b.thread_id && t.ingress == b.ingress)
            .unwrap_or_else(|| {
                self.threads.push(Thread {
                    thread_id: b.thread_id.clone(),
                    ingress: b.ingress.clone(),
                    mode: "normal".into(),
                    until: None,
                    digest_at: now,
                    rebind: None,
                    last_delivered_at: None,
                    last_ack_at: None,
                });
                self.threads.len() - 1
            });
        &mut self.threads[index]
    }
    pub fn rule(&self, b: &Binding) -> Option<&Thread> {
        self.threads
            .iter()
            .find(|t| t.thread_id == b.thread_id && t.ingress == b.ingress)
    }
}
pub(super) fn capacity(s: &Value) -> u64 {
    s["notificationBucketCapacity"]
        .as_u64()
        .unwrap_or(10)
        .max(1)
}
pub(super) fn refill_seconds(s: &Value) -> i64 {
    s["notificationRefillSeconds"]
        .as_u64()
        .unwrap_or(60)
        .clamp(1, 86400) as i64
}
pub(super) fn escalation_seconds(s: &Value) -> i64 {
    s["notificationEscalationSeconds"]
        .as_u64()
        .unwrap_or(900)
        .clamp(1, 86400) as i64
}
pub(super) fn retry_seconds(failures: u32) -> i64 {
    10i64
        .saturating_mul(1i64 << failures.saturating_sub(1).min(5))
        .min(300)
}
fn scope() -> Result<String> {
    let origin = crate::kernel::origin::current_origin();
    let ingress = string(&origin, "ingressId");
    if ingress.is_empty() {
        Err("INGRESS_REQUIRED".into())
    } else {
        Ok(ingress.into())
    }
}
pub(crate) async fn notify_status(args: &Value) -> Result<Value> {
    let ingress = scope()?;
    let mut args = args.clone();
    if let Some(target) = args["target"].as_str() {
        args["target"] = json!(session_id(target).unwrap_or_else(|_| target.into()));
    }
    let _guard = LOCK.lock().await;
    status_in(
        &directory(),
        &ingress,
        &args,
        chrono::Utc::now().timestamp(),
        &settings()?,
    )
}
pub(super) fn status_in(
    dir: &Path,
    ingress: &str,
    args: &Value,
    now: i64,
    settings: &Value,
) -> Result<Value> {
    let bindings = records(dir)?
        .into_iter()
        .filter(|b| {
            b.ingress == ingress
                && args["threadId"].as_str().is_none_or(|id| id == b.thread_id)
                && args["target"].as_str().is_none_or(|target| {
                    b.target.as_deref() == Some(target)
                        || b.deliveries.iter().any(|d| d.target == target)
                })
        })
        .collect::<Vec<_>>();
    let mut state = State::load(dir)?;
    let mut targets = Vec::new();
    let mut threads = Vec::new();
    let mut ranks = std::collections::BTreeMap::<String, usize>::new();
    for b in &bindings {
        let pairs = b
            .target
            .iter()
            .map(|target| (b.channel, target.clone()))
            .chain(
                b.deliveries
                    .iter()
                    .filter(|d| !d.target.is_empty())
                    .map(|d| (d.channel, d.target.clone())),
            )
            .collect::<Vec<_>>();
        for (channel, target) in pairs {
            if args["target"]
                .as_str()
                .is_some_and(|filter| filter != target)
            {
                continue;
            }
            if targets.iter().any(|v: &Value| {
                v["target"] == target && v["channel"] == serde_json::to_value(channel).unwrap()
            }) {
                continue;
            }
            let t = state.target(channel, &target, now, settings);
            let batches = t
                .batches
                .iter()
                .filter_map(|batch| {
                    let mut batch = batch.clone();
                    batch
                        .threads
                        .retain(|id| bindings.iter().any(|b| b.thread_id == *id));
                    (!batch.threads.is_empty()).then_some(batch)
                })
                .collect::<Vec<_>>();
            for batch in &batches {
                if batch.status == "cancelled" {
                    continue;
                }
                for id in &batch.threads {
                    *ranks.entry(id.clone()).or_default() += 1;
                }
            }
            let pending=bindings.iter().flat_map(|b|b.deliveries.iter().filter(|d|d.channel==channel && d.target==target && matches!(d.status.as_str(),"pending"|"sending")).map(|d|json!({"threadId":b.thread_id,"turnId":b.turn_id,"eventId":d.event_id,"kind":event(b,d)["kind"],"status":d.status,"createdAt":d.created_at,"nextAttemptAt":d.next_attempt_at,"timing":d.timing}))).collect::<Vec<_>>();
            targets.push(json!({"channel":channel,"target":target,"tokens":t.tokens,"capacity":capacity(settings),"refillSeconds":refill_seconds(settings),"nextTokenAt":if t.tokens<capacity(settings){Some(t.refilled_at+refill_seconds(settings))}else{None},"breaker":t.breaker,"emptySince":t.empty_since,"escalated":t.escalated,"escalationError":t.escalation_error,"pending":pending,"recentBatches":batches}));
        }
        if !threads.iter().any(|v: &Value| v["threadId"] == b.thread_id) {
            let rule = state.rule(b);
            let bs = bindings
                .iter()
                .filter(|other| other.thread_id == b.thread_id)
                .collect::<Vec<_>>();
            let latest = bs.iter().max_by_key(|b| b.created_at).unwrap();
            let historical = bs
                .iter()
                .flat_map(|b| &b.deliveries)
                .filter(|d| matches!(d.status.as_str(), "delivered" | "digested"))
                .filter_map(|d| d.timing.finished_at.map(|ms| ms / 1000))
                .max();
            threads.push(json!({"threadId":b.thread_id,"title":latest.title,"channel":latest.channel,"target":latest.target,"mode":rule.map(|r|r.mode(now)).unwrap_or("normal"),"until":rule.and_then(|r|r.until),"lastDeliveredAt":rule.and_then(|r|r.last_delivered_at).into_iter().chain(historical).max(),"lastAckAt":rule.and_then(|r|r.last_ack_at),"turns":bs.iter().map(|b|json!({"turnId":b.turn_id,"channel":b.channel,"target":b.target,"causedBy":b.caused_by})).collect::<Vec<_>>()}));
        }
    }
    let total_targets = targets.len();
    let total_threads = threads.len();
    let compact = args["all"] != true && args["target"].is_null() && args["threadId"].is_null();
    if compact {
        targets.retain(|t| {
            !t["recentBatches"].as_array().unwrap().is_empty()
                || !t["pending"].as_array().unwrap().is_empty()
                || t["breaker"] == true
                || !t["emptySince"].is_null()
                || t["escalated"] == true
        });
        threads.retain(|t| {
            t["mode"] != "normal"
                || ranks.contains_key(string(t, "threadId"))
                || bindings
                    .iter()
                    .filter(|b| b.thread_id == t["threadId"])
                    .any(|b| {
                        b.deliveries.iter().any(|d| {
                            matches!(d.status.as_str(), "pending" | "sending")
                                || d.attempted_at > now.saturating_sub(3600)
                                || d.timing
                                    .finished_at
                                    .is_some_and(|at| at / 1000 > now.saturating_sub(3600))
                        })
                    })
        });
        for t in &mut threads {
            let latest = bindings
                .iter()
                .filter(|b| b.thread_id == t["threadId"])
                .max_by_key(|b| b.created_at)
                .unwrap();
            t["turns"]
                .as_array_mut()
                .unwrap()
                .retain(|turn| turn["turnId"] == latest.turn_id);
        }
    }
    let shown_bindings: usize = threads
        .iter()
        .map(|t| t["turns"].as_array().unwrap().len())
        .sum();
    let summary = json!({"totalTargets":total_targets,"totalThreads":total_threads,"totalBindings":bindings.len(),"hidden":{"targets":total_targets-targets.len(),"threads":total_threads-threads.len(),"bindings":bindings.len()-shown_bindings}});
    let mut ranking = ranks
        .into_iter()
        .map(|(thread_id, wakes)| json!({"threadId":thread_id,"wakes":wakes}))
        .collect::<Vec<_>>();
    ranking.sort_by_key(|v| std::cmp::Reverse(v["wakes"].as_u64().unwrap_or(0)));
    let unbound_pending=bindings.iter().flat_map(|b|b.deliveries.iter().filter(|d|d.target.is_empty() && d.status=="pending").map(|d|json!({"threadId":b.thread_id,"turnId":b.turn_id,"eventId":d.event_id,"kind":event(b,d)["kind"],"timing":d.timing}))).collect::<Vec<_>>();
    Ok(
        json!({"mcpEvents":super::mcp_events::status(dir, ingress, args)?,"at":now,"summary":summary,"notificationsEnabled":settings["notificationsEnabled"]!=false,"unboundPending":unbound_pending,"recentWindowSeconds":3600,"targets":targets,"threads":threads,"mostWokenThreads":ranking}),
    )
}
pub(crate) async fn notify_control(args: &Value) -> Result<Value> {
    let ingress = scope()?;
    let _guard = LOCK.lock().await;
    control_in(
        &directory(),
        &ingress,
        args,
        chrono::Utc::now().timestamp(),
        &settings()?,
    )
}
pub(super) fn control_in(
    dir: &Path,
    ingress: &str,
    args: &Value,
    now: i64,
    settings: &Value,
) -> Result<Value> {
    let mut all = records(dir)?;
    let mut state = State::load(dir)?;
    let action = string(args, "action");
    if action == "breaker" {
        let raw = string(args, "target");
        let events = super::mcp_events::owns(dir, ingress, raw)?;
        let target = if events {
            raw.to_owned()
        } else {
            session_id(raw)?
        };
        if !events
            && !all.iter().any(|b| {
                b.ingress == ingress
                    && b.channel == Channel::ClaudeSession
                    && b.target.as_deref() == Some(&target)
            })
        {
            return Err("NOTIFICATION_TARGET_NOT_BOUND_TO_INGRESS".into());
        }
        let t = state.target(
            if events {
                Channel::McpEvents
            } else {
                Channel::ClaudeSession
            },
            &target,
            now,
            settings,
        );
        let previous = t.breaker;
        t.breaker = args["enabled"].as_bool().ok_or("enabled is required")?;
        if previous && !t.breaker {
            t.escalated = false;
            t.escalation_error = None;
            t.empty_since = None;
        }
        let result =
            json!({"action":action,"target":target,"enabled":t.breaker,"previous":previous});
        state.save(dir)?;
        return Ok(result);
    }
    let thread = string(args, "threadId");
    let b = all
        .iter()
        .find(|b| b.ingress == ingress && b.thread_id == thread)
        .ok_or("NOTIFICATION_THREAD_NOT_BOUND_TO_INGRESS")?
        .clone();
    let previous_target = b.target.clone();
    let rule = state.thread(&b, now);
    let previous = serde_json::to_value(&*rule).map_err(|e| e.to_string())?;
    match action {
        "mute" => {
            rule.mode = args["mode"].as_str().unwrap_or("mute").into();
            if !matches!(rule.mode.as_str(), "mute" | "digest") {
                return Err("mode must be mute or digest".into());
            }
            rule.until = if let Some(s) = args["until"].as_str() {
                Some(
                    chrono::DateTime::parse_from_rfc3339(s)
                        .map_err(|_| "until must be RFC3339")?
                        .timestamp(),
                )
            } else {
                None
            };
            if rule.until.is_some_and(|t| t <= now) {
                return Err("until must be in the future".into());
            }
            if previous["mode"] != rule.mode {
                rule.digest_at = now;
            }
        }
        "unmute" => {
            rule.mode = "normal".into();
            rule.until = None;
        }
        "rebind" => {
            let target = match args.get("target") {
                Some(Value::Null) => None,
                Some(Value::String(s)) => Some(session_id(s)?),
                _ => return Err("target must be a session or null".into()),
            };
            rule.rebind = Some(Rebind {
                channel: Channel::ClaudeSession,
                target: target.clone(),
            });
            // Persist the override first; the next flush also applies it after a crash.
            state.save(dir)?;
            for b in all
                .iter_mut()
                .filter(|b| b.thread_id == thread && b.ingress == ingress)
            {
                apply_rebind(b, state.rule(b).unwrap());
                persist(dir, b)?;
            }
        }
        _ => return Err("Unknown notification action".into()),
    }
    state.save(dir)?;
    Ok(
        json!({"action":action,"threadId":thread,"previous":previous,"previousTarget":previous_target,"control":state.rule(&b)}),
    )
}
pub(super) fn apply_rebind(b: &mut Binding, rule: &Thread) {
    if let Some(rebind) = &rule.rebind {
        b.target = rebind.target.clone();
        b.channel = rebind.channel;
        for d in &mut b.deliveries {
            if d.status == "pending"
                || (d.status == "failed"
                    && matches!(d.error.as_deref(), Some("unbound" | "binding-changed")))
            {
                let target = rebind.target.clone().unwrap_or_default();
                if d.target != target || d.channel != rebind.channel {
                    d.token_charged = false;
                    d.failures = 0;
                    d.next_attempt_at = 0;
                }
                d.target = target;
                d.channel = rebind.channel;
                d.status = "pending".into();
                d.error = None;
            }
        }
    }
}
