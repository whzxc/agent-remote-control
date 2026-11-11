//! Bounded member events and the controller's single ordinary-request long poll.
use super::*;
use std::collections::{HashMap, VecDeque};
use std::sync::LazyLock;

pub(crate) const OP: &str = "peer_task_events";
pub(crate) const CAP: usize = 256;
const BATCH: usize = 60;
const EVENT_BYTES: usize = 64 * 1024;
const WAIT_MS: u64 = 15_000;
#[derive(Default)]
struct Queue {
    cursor: u64,
    rows: VecDeque<Value>,
    dropped: u64,
}
struct Events {
    epoch: String,
    queues: HashMap<String, Queue>,
}
static EVENTS: LazyLock<StdMutex<Events>> = LazyLock::new(|| {
    StdMutex::new(Events {
        epoch: id(),
        queues: HashMap::new(),
    })
});
static WAKE: Notify = Notify::const_new();

impl Queue {
    fn push(&mut self, event: Value) {
        self.cursor += 1;
        if event.to_string().len() > EVENT_BYTES {
            self.dropped = self.cursor;
            self.rows.clear();
            return;
        }
        while self.rows.len() >= CAP {
            self.dropped = self.rows.pop_front().unwrap()["cursor"].as_u64().unwrap();
        }
        self.rows
            .push_back(json!({"cursor":self.cursor,"event":event}));
    }
    fn read(&self, epoch: &str, args: &Value) -> Value {
        let cursor = args["cursor"].as_u64();
        let baseline = cursor.is_none() || args["epoch"] != epoch;
        let gap = cursor.is_some_and(|c| c < self.dropped || c > self.cursor)
            || cursor.is_some() && args["epoch"] != epoch;
        let rows = if baseline || gap {
            vec![]
        } else {
            self.rows
                .iter()
                .filter(|row| row["cursor"].as_u64().unwrap() > cursor.unwrap())
                .take(BATCH)
                .cloned()
                .collect::<Vec<_>>()
        };
        json!({"epoch":epoch,"cursor":rows.last().map(|r|r["cursor"].clone()).unwrap_or(json!(self.cursor)),"gap":gap,"events":rows})
    }
}
/// There is one paired controller. Changing its peer source drops the old queue.
pub(crate) fn publish(controller_source: &str, event: Value) {
    let mut events = EVENTS.lock().unwrap();
    events
        .queues
        .retain(|source, _| source == controller_source);
    events
        .queues
        .entry(controller_source.into())
        .or_default()
        .push(event);
    WAKE.notify_waiters();
}
pub(crate) async fn read(controller_source: &str, args: &Value) -> Result<Value> {
    let wait = args["waitMs"].as_u64().unwrap_or(0);
    if wait > WAIT_MS
        || (!args["cursor"].is_null() && !args["cursor"].is_u64())
        || (!args["epoch"].is_null() && !args["epoch"].is_string())
        || args.get("waitMs").is_some_and(|wait| !wait.is_u64())
    {
        return Err("INVALID_ARGUMENT: peer_task_events expects cursor:uint|null, epoch:string and waitMs <= 15000".into());
    }
    let deadline = tokio::time::Instant::now() + Duration::from_millis(wait);
    loop {
        let wake = WAKE.notified();
        tokio::pin!(wake);
        wake.as_mut().enable();
        let result = {
            let mut events = EVENTS.lock().unwrap();
            let epoch = events.epoch.clone();
            events
                .queues
                .retain(|source, _| source == controller_source);
            events
                .queues
                .entry(controller_source.into())
                .or_default()
                .read(&epoch, args)
        };
        if result["gap"] == true
            || args["cursor"].is_null()
            || result["epoch"] != args["epoch"]
            || !result["events"].as_array().unwrap().is_empty()
            || tokio::time::Instant::now() >= deadline
        {
            return Ok(result);
        }
        if tokio::time::timeout_at(deadline, wake).await.is_err() {
            return Ok(result);
        }
    }
}
pub(super) fn dispatch(op: &str) -> bool {
    matches!(
        op,
        "codex_create" | "codex_send" | "codex_resume" | "agent_create" | "agent_send"
    )
}
pub(super) fn binding_args(op: &str, args: &Value) -> Result<Value> {
    if !dispatch(op) {
        return Ok(Value::Null);
    }
    if let Some(notify) = args.get("notify") {
        let op_spec = crate::catalog()["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|spec| spec["name"] == op);
        let schema = op_spec
            .map(|spec| &spec["inputSchema"]["properties"]["notify"])
            .filter(|schema| schema.is_object())
            .ok_or_else(|| {
                format!("INVALID_ARGUMENT: {op} does not accept notify; query guide for this op.")
            })?;
        crate::validator("device-notify", op, schema)?
            .validate(notify)
            .map_err(|e| crate::egress::validation_error("notify", schema, &e))?;
    }
    let mut args = args.clone();
    crate::claude_notify::normalize(&mut args)?;
    // Keep binding inputs, never a second copy of task input or native history.
    let mut binding = json!({"agent":args["agent"],"title":crate::control::dispatch_title(&args),"purpose":args["purpose"],"previousTurnId":args["turnId"]});
    if let Some(notify) = args.get("notify") {
        binding["notify"] = notify.clone();
    }
    Ok(binding)
}

impl Controller {
    pub(super) async fn event_request(
        &self,
        member: &Member,
        op: &str,
        args: Value,
        _source: &str,
    ) -> Result<Value> {
        let response = self
            .send(
                &member.peer.device_id,
                "query",
                json!({"op":op,"args":args}),
                Duration::from_secs(23),
            )
            .await?;
        let value = crate::egress::tool_value(&response)?;
        if response["isError"] == true {
            return Err(value.to_string());
        }
        Ok(value)
    }
    pub(super) async fn bind_result(
        &self,
        member: &Member,
        request: &str,
        result: &Value,
    ) -> Result<()> {
        let forward = self
            .records
            .lock()
            .unwrap()
            .forwards
            .iter()
            .find(|f| f.device_id == member.peer.device_id && f.request_id == request)
            .cloned();
        if let Some(forward) = forward.filter(|f| !f.notification.is_null()) {
            let mut result = result.clone();
            result["requestId"] = json!(request);
            let bound = crate::claude_notify::device::bind_forward(
                &member.peer.device_id,
                &member.peer.name,
                &forward.source_id,
                &forward.op,
                &forward.notification,
                &result,
            )
            .await?;
            if bound {
                let mut records = self.records.lock().unwrap();
                if let Some(record) = records
                    .forwards
                    .iter_mut()
                    .find(|f| f.device_id == member.peer.device_id && f.request_id == request)
                {
                    record.notification = Value::Null;
                    records.save(&self.directory)?;
                }
            }
        }
        Ok(())
    }
    async fn receive_event(&self, member: &Member, event: &Value) -> Result<()> {
        let task = event["threadId"]
            .as_str()
            .or_else(|| event["taskId"].as_str())
            .unwrap_or("");
        let request = string(&event["causedBy"], "requestId");
        // A fast observer may beat the dispatch response. Attribute by its retained receipt.
        if !crate::claude_notify::device::has_binding(
            &member.peer.device_id,
            task,
            string(event, "turnId"),
        )? {
            {
                let mut records = self.records.lock().unwrap();
                if records.associate_receipt(&member.peer.device_id, request, event) {
                    records.save(&self.directory)?;
                }
            }
            self.bind_result(member, request, event).await?;
        }
        let source = self
            .records
            .lock()
            .unwrap()
            .task_source(&member.peer.device_id, task)
            .map(str::to_owned);
        if let Some(source) = source {
            crate::claude_notify::device::receive(&member.peer.device_id, &source, event).await?;
        }
        Ok(())
    }
    pub(super) async fn reconcile_events(&self, member: &Member) -> Result<()> {
        for binding in crate::claude_notify::device::open(&member.peer.device_id)? {
            if !member.status.lock().unwrap().online {
                break;
            }
            let task = string(&binding, "taskId");
            let source = self
                .records
                .lock()
                .unwrap()
                .task_source(&member.peer.device_id, task)
                .map(str::to_owned);
            let Some(source) = source.filter(|s| binding["sourceId"] == *s) else {
                continue;
            };
            let result = self
                .event_request(
                    member,
                    string(&binding, "op"),
                    binding["args"].clone(),
                    &source,
                )
                .await;
            match result {
                Ok(value) => {
                    crate::claude_notify::device::reconcile(
                        &member.peer.device_id,
                        &source,
                        &binding,
                        &value,
                    )
                    .await?
                }
                Err(_) => {
                    crate::claude_notify::device::unconfirmed(
                        &member.peer.device_id,
                        Some(&binding),
                    )
                    .await?
                }
            }
        }
        Ok(())
    }
    pub(super) async fn poll_events(self: Arc<Self>, member: Arc<Member>) {
        let mut cursor = Value::Null;
        let mut epoch = Value::Null;
        let mut unavailable = false;
        loop {
            if !member.status.lock().unwrap().online {
                if !unavailable {
                    let _ = crate::claude_notify::device::unconfirmed(&member.peer.device_id, None)
                        .await;
                    unavailable = true;
                }
                cursor = Value::Null;
                self.changed.notified().await;
                continue;
            }
            let request = self.event_request(
                &member,
                OP,
                json!({"epoch":epoch,"cursor":cursor,"waitMs":if cursor.is_null(){0}else{WAIT_MS}}),
                "",
            );
            tokio::pin!(request);
            let result = loop {
                let changed = self.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if !member.status.lock().unwrap().online {
                    break Err("DEVICE_OFFLINE: Member is unavailable".into());
                }
                tokio::select! {
                    result = &mut request => break result,
                    _ = changed => {},
                }
            };
            let result = match result {
                Ok(result) => result,
                Err(error) => {
                    crate::logs::record("WARN", &format!("Member events: {error}"), None);
                    if !unavailable {
                        let _ =
                            crate::claude_notify::device::unconfirmed(&member.peer.device_id, None)
                                .await;
                        unavailable = true;
                    }
                    cursor = Value::Null;
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };
            unavailable = false;
            if cursor.is_null() || result["gap"] == true || epoch != result["epoch"] {
                if let Err(error) = self.reconcile_events(&member).await {
                    crate::logs::record("WARN", &error, None);
                }
            }
            let mut failed = false;
            for row in result["events"].as_array().into_iter().flatten() {
                if let Err(error) = self.receive_event(&member, &row["event"]).await {
                    crate::logs::record("WARN", &error, None);
                    failed = true;
                }
            }
            cursor = if failed {
                Value::Null
            } else {
                result["cursor"].clone()
            };
            epoch = result["epoch"].clone();
        }
    }
}

#[cfg(test)]
#[path = "events/tests.rs"]
mod tests;
