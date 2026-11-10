//! Core-side operation authorization, task association and result projection.
use crate::service::Service;
use crate::transport::is_wait;
use crate::*;

// Both transports use this exact validator, dispatcher and output projection.
// Local CLI is an execution identity, never an ingress registry entry.
enum ControlSource<'a> {
    Ingress(&'a Arc<crate::ingress::Ingress>),
    Local(&'a Arc<crate::execution::Execution>),
}
impl ControlSource<'_> {
    fn execution(&self) -> &Arc<crate::execution::Execution> {
        match self {
            Self::Ingress(s) => s.execution.as_ref().expect("Core ingress execution"),
            Self::Local(s) => s,
        }
    }
    fn connected(&self) -> bool {
        match self {
            Self::Ingress(s) => s.connected.load(std::sync::atomic::Ordering::SeqCst),
            Self::Local(_) => true,
        }
    }
    async fn origin(&self) -> Value {
        match self {
            Self::Ingress(s) => s.origin().await,
            Self::Local(_) => crate::kernel::origin::current_origin(),
        }
    }
    async fn allows(&self, name: &str) -> bool {
        match self {
            Self::Ingress(s) => s.allows(name).await,
            Self::Local(s) => s.available(name).await,
        }
    }
    async fn call(&self, name: &str, args: Value) -> Result<Value> {
        match self {
            Self::Ingress(s) => s.call(name, args).await,
            Self::Local(s) => {
                if name == "connector_verify" {
                    let spec = catalog()["ops"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|o| o["name"] == name)
                        .unwrap();
                    crate::egress::validate_op(spec, &args)?;
                    return Ok(
                        json!({"received":true,"code":args["code"],"origin":self.origin().await}),
                    );
                }
                s.call(name, args, json!("all")).await
            }
        }
    }
}
pub(crate) async fn local_control(s: &Arc<Service>, body: Value) -> Result<Value> {
    let source = ControlSource::Local(&s.execution);
    let name = string(&body, "op");
    let tool = if name == "guide" {
        "query"
    } else {
        catalog()["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["name"] == name)
            .map(crate::egress::via)
            .unwrap_or("query")
    };
    let mut args = body.get("args").cloned().unwrap_or(json!({}));
    let mut origin = crate::sources::local_origin().await?;
    origin["controlTransport"] = json!("cli");
    if matches!(
        name,
        "codex_create" | "codex_send" | "agent_create" | "agent_send"
    ) {
        if let Some(fields) = args.as_object_mut() {
            fields.entry("purpose").or_insert(json!("self-test"));
            fields.entry("notify").or_insert(Value::Null);
        }
    }
    let envelope = if tool == "guide" {
        args
    } else {
        let mut envelope = json!({"op":name,"args":args});
        if let Some(request) = body.get("requestId") {
            envelope["requestId"] = request.clone();
        }
        envelope
    };
    crate::kernel::origin::ORIGIN
        .scope(
            origin,
            crate::dispatch_caller::CALLER.scope(
                crate::dispatch_caller::validated(&body["caller"]),
                call_tool(&source, tool, envelope, None),
            ),
        )
        .await
}
async fn enabled_ops(s: &ControlSource<'_>) -> Vec<Value> {
    let mut ops = Vec::new();
    for op in catalog()["ops"].as_array().unwrap() {
        if s.allows(string(op, "name")).await {
            ops.push(op.clone());
        }
    }
    ops
}

async fn call_tool(
    s: &ControlSource<'_>,
    tool: &str,
    envelope: Value,
    rpc_id: Option<&Value>,
) -> Result<Value> {
    let metric = crate::control_metrics::Call::new(&s.origin().await, tool, &envelope);
    let mut response = call_tool_inner(s, tool, envelope, rpc_id).await;
    if rpc_id.is_some() {
        if let Ok(result) = &mut response {
            result["resultType"] = json!("complete");
        }
    }
    metric.finish(&response).await;
    response
}

async fn call_tool_inner(
    s: &ControlSource<'_>,
    tool: &str,
    envelope: Value,
    rpc_id: Option<&Value>,
) -> Result<Value> {
    let name = if tool == "guide" {
        "guide"
    } else {
        string(&envelope, "op")
    };
    let mut args = if tool == "guide" {
        envelope.clone()
    } else {
        envelope["args"].clone()
    };
    let summary = crate::task_summary::requested(name, &args);
    let mut wait_limit = None;
    let mut digest_continuation = false;
    let mut default_list = false;
    let result = async {
        if !s.connected() {
            return Err("Connection closed".into());
        }
        let spec = catalog()["tools"].as_array().unwrap().iter().find(|t| t["name"] == tool)
            .ok_or("Unknown tool; call guide, query or act.")?;
        if let (true, Some(topic)) = (tool == "guide", envelope["topic"].as_str()) {
            let accepts = |schema: &Value| schema["properties"]["topic"]["enum"].as_array().is_some_and(|topics| topics.iter().any(|t| t == topic));
            let op = catalog()["ops"].as_array().unwrap().iter().find(|op| op["name"] == "guide").unwrap();
            if !accepts(&spec["inputSchema"]) && accepts(&op["inputSchema"]) {
                return Err(json!({"code":"WRONG_TOOL","op":"guide","field":"/topic","via":"query",
                    "message":"The frozen guide tool accepts only its original topics; read this topic through query guide.",
                    "next":{"via":"query","op":"guide","args":{"topic":topic},"hint":"Read this topic through query guide with the same topic."}}).to_string());
            }
        }
        crate::validator("tool", tool, &spec["inputSchema"])?
            .validate(&envelope)
            .map_err(|e| crate::egress::validation_error("", &spec["inputSchema"], &e))?;
        if tool != "guide" && name == "guide" {
            let spec = catalog()["ops"].as_array().unwrap().iter().find(|op| op["name"] == "guide").unwrap();
            if tool != "query" {
                return Err(json!({"code":"WRONG_TOOL","op":"guide","via":"query","example":crate::egress::example(spec)}).to_string());
            }
            crate::egress::validate_op(spec, &args)?;
        }
        let op_name = if name == "guide" { string(&args,"op") } else { name };
        if name != "guide" || args.get("op").is_some() {
            let op = catalog()["ops"].as_array().unwrap().iter().find(|op| op["name"] == op_name);
            let Some(op) = op else {
                return Err(crate::egress::unknown_op(op_name, &enabled_ops(s).await));
            };
            if !s.allows(op_name).await {
                return Err(json!({"code":"OP_UNAVAILABLE","op":op_name,"message":"This op is disabled by the ingress policy or unavailable on this device. Call guide for enabled ops."}).to_string());
            }
            if name != "guide" && tool != crate::egress::via(op) {
                return Err(json!({"code":"WRONG_TOOL","op":op_name,"message":"Use the op's assigned tool.","via":crate::egress::via(op),"example":crate::egress::example(op)}).to_string());
            }
        }
        crate::coordination::bulletin::authenticated_activity();
        if name == "guide" {
            return Ok(crate::egress::guide(&s.origin().await, &args, &crate::i18n::locale(), &enabled_ops(s).await));
        }
        let accepts_request_id = name == "receipt" || catalog()["ops"].as_array().unwrap().iter()
            .find(|op| op["name"] == name)
            .is_some_and(|op| crate::egress::retry_contract(op)["mode"] == "receipt");
        if accepts_request_id && args.get("requestId").is_none() {
            if let Some(request_id) = envelope.get("requestId") {
                args["requestId"] = request_id.clone();
            }
        }
        if matches!(name, "codex_wait" | "agent_wait" | "inbox_wait") {
            let op = catalog()["ops"].as_array().unwrap().iter().find(|op| op["name"] == name).unwrap();
            crate::egress::validate_op(op, &args)?;
            wait_limit = crate::control_sources::limit_wait(&s.origin().await, &mut args);
        }
        if name == "command" && args["cmd"].is_string() && args.get("waitMs").is_none()
            && matches!(s, ControlSource::Ingress(_))
        {
            args["waitMs"] = json!(args["timeoutMs"].as_u64().unwrap_or(60000).saturating_add(10000).min(45000));
        }
        if args["digestCursor"].is_string() && crate::kernel::digests::supports(name, &args) {
            let spec = catalog()["ops"].as_array().unwrap().iter().find(|op|op["name"]==name).unwrap();
            crate::egress::validate_op(spec, &args)?;
            match crate::kernel::digests::resume(name, &args, &s.origin().await, rpc_id)? {
                crate::kernel::digests::Resume::Value(value) => return Ok(value),
                crate::kernel::digests::Resume::Owner(next) => { args = next; digest_continuation = true; },
            }
        }
        #[cfg(feature = "test-fixture")]
        if let Ok(path) = std::env::var("ARC_FIXTURE_DIGESTS") {
            let fixtures = load(Path::new(&path))?;
            if let Some(value) = fixtures.get(name) {
                let spec = catalog()["ops"].as_array().unwrap().iter().find(|op|op["name"]==name).unwrap();
                crate::egress::validate_op(spec, &args)?;
                for (key, expected) in fixtures["expect"].as_object().into_iter().flatten() {
                    if args[key] != *expected { return Err(format!("FIXTURE_ARGUMENT_MISMATCH: {key}")); }
                }
                return Ok(value.clone());
            }
        }
        s.call(name, args.clone()).await
    }.await;
    let mut images = Vec::new();
    let mut reads = Vec::new();
    let (mut value, error) = match result {
        Ok(mut value) => {
            if matches!(
                name,
                "codex_read" | "codex_wait" | "agent_read" | "agent_wait"
            ) && value["state"].is_string()
                && value["operation"].is_null()
            {
                value["stateScope"] = json!("turn");
            }
            if let Some(limit) = wait_limit {
                value["waitLimit"] = limit;
            }
            match crate::claude_notify::read_turns(&s.execution().control, name, &args, &value)
                .await
            {
                Ok(turns) => reads = turns,
                Err(error) => crate::logs::record(
                    "WARN",
                    &format!("Inbox read tracking failed: {error}"),
                    None,
                ),
            }
            if matches!(name, "codex_wait" | "agent_wait") {
                crate::waiter::compact_response(&mut value, &args);
            }
            if matches!(name, "read" | "codex_read" | "codex_items" | "screen") {
                images = crate::images::take(&mut value);
            }
            let mut value = crate::egress::receipt(value);
            if args["includeOrigin"] != true {
                crate::egress::control_source(name, &mut value);
            }
            let outcome = crate::egress::outcome_error(&value);
            if let Some(reason) = &outcome {
                value["error"] = reason.clone();
            }
            default_list = outcome.is_none()
                && value["error"].is_null()
                && crate::kernel::digests::default_list(name, &args);
            let mut paged = if value["view"] == "digest"
                || summary
                || matches!(name, "guide" | "control_output")
            {
                value.clone()
            } else if (crate::kernel::digests::requested(name, &args, &value)
                || (digest_continuation && value["error"].is_null()))
                && args["digestCursor"].is_null()
            {
                crate::kernel::digests::present(
                    name,
                    &args,
                    value.clone(),
                    &s.origin().await,
                    rpc_id,
                )?
            } else if default_list || (args["digestCursor"].is_string() && args["view"] != "full") {
                value.clone()
            } else {
                crate::kernel::results::page_output(
                    value.clone(),
                    if args["view"] == "full" {
                        64 * 1024
                    } else {
                        12 * 1024
                    },
                )?
            };
            if outcome.is_some() && paged["outputId"].is_string() {
                for key in ["requestId", "state", "error", "threadId", "turnId"] {
                    if let Some(field) = value.get(key) {
                        paged[key] = field.clone();
                    }
                }
            }
            (paged, outcome.is_some())
        }
        Err(error) => (json!({"error":crate::egress::failure(&error)}), true),
    };
    crate::sources::decorate(&mut value);
    if !error {
        let task = value["threadId"]
            .as_str()
            .or_else(|| value["taskId"].as_str())
            .or_else(|| args["taskId"].as_str())
            .unwrap_or("")
            .to_owned();
        let turn = value["turnId"].as_str().unwrap_or("").to_owned();
        if crate::egress::dispatch_receipt(&value)
            && !task.is_empty()
            && !turn.is_empty()
            && value["notification"] != "bind-failed"
        {
            let since = if matches!(string(&value, "operation"), "send" | "create") {
                value["createdAt"].as_str()
            } else {
                None
            };
            match crate::claude_notify::read_since(&task, &turn, since) {
                Ok(notification) => value["notification"] = notification,
                Err(error) => {
                    value["notificationError"] = json!(error);
                }
            }
        }
        if !task.is_empty() && !turn.is_empty() {
            if let Ok(retry) = crate::claude_notify::retry_status(&task, &turn) {
                if !retry.is_null() {
                    value["retry"] = retry;
                }
            }
        }
        let available = crate::claude_notify::push_available(&value["notification"]);
        crate::egress::next(&mut value, name, &args, available);
    }
    if error {
        crate::egress::next(&mut value, name, &args, false);
        if summary {
            value = crate::task_summary::project(name, &args, &value);
        }
        return Ok(crate::egress::tool(value, true));
    }
    if summary {
        value = crate::task_summary::project(name, &args, &value);
    }
    let inbox = if value["view"] == "digest"
        || summary
        || (name == "dispatch_policy" && args["view"] != "full")
        || (name == "guide" && value["profile"]["name"] == "local-code")
        || name == "inbox_wait"
    {
        Value::Null
    } else {
        match crate::claude_notify::inbox(
            string(&s.origin().await, "sourceId"),
            &reads,
            s.origin().await["controlSource"] == "claude",
            args["notify"]["target"].as_str(),
        )
        .await
        {
            Ok(inbox) => inbox,
            Err(error) => {
                crate::logs::record("WARN", &format!("Inbox unavailable: {error}"), None);
                Value::Null
            }
        }
    };
    if !inbox.is_null() && !(name == "codex_read" && args["view"] == "review") {
        if !value.is_object() {
            value = json!({"value":value});
        }
        value["arcInbox"] = json!({"unread":inbox["unread"],"next":inbox["next"]});
    }
    let mut result = crate::egress::tool(value, error);
    // Measure the serialized text block, including JSON escaping and response framing.
    // Labels, next, arcInbox and arcVersion have all been added. Default lists must not
    // pass through generic paging first: that would hide the owner's full list shape.
    if default_list && crate::egress::wire_bytes(&result, rpc_id) > 12 * 1024 {
        let full = crate::egress::tool_value(&result)?;
        let digest = crate::kernel::digests::present(name, &args, full, &s.origin().await, rpc_id)?;
        result = crate::egress::tool(digest, false);
    }
    result["content"].as_array_mut().unwrap().extend(images);
    Ok(result)
}
pub(crate) async fn dispatch(s: &Arc<crate::ingress::Ingress>, request: Value) -> Result<Value> {
    if request["jsonrpc"] != "2.0" {
        return Err("invalid jsonrpc".into());
    }
    s.observe_request("firstMcpRequestAt").await?;
    let id = request.get("id").cloned();
    let method = string(&request, "method");
    if matches!(
        method,
        "server/discover"
            | "initialize"
            | "tools/list"
            | "events/list"
            | "events/subscribe"
            | "events/unsubscribe"
    ) {
        let version = string(&request["params"], "protocolVersion");
        let version = if [
            "2024-11-05",
            "2025-03-26",
            "2025-06-18",
            "2025-11-25",
            "2026-07-28",
        ]
        .contains(&version)
        {
            version
        } else {
            "unspecified"
        };
        s.log(
            "INFO",
            &format!("MCP protocol request: {method}; version={version}"),
        )
        .await;
    }
    let result = match method {
        "server/discover" => Ok(
            json!({"cacheScope":"private","ttlMs":0,"supportedVersions":["2026-07-28"],"capabilities":{"tools":{},"events":{}},"serverInfo":{"name":"arc","version":env!("ARC_BUILD_VERSION")},"instructions":catalog()["instructions"]}),
        ),
        "events/list" | "events/subscribe" | "events/unsubscribe" if id.is_some() => {
            let result =
                crate::claude_notify::mcp_events::request(s, method, &request["params"]).await;
            let outcome = match &result {
                Ok(_) => "accepted".to_owned(),
                Err(error) => serde_json::from_str::<Value>(error)
                    .ok()
                    .and_then(|v| v["data"]["reason"].as_str().map(str::to_owned))
                    .unwrap_or_else(|| "internal_error".into()),
            };
            s.log(
                "INFO",
                &format!("MCP event operation: {method}; result={outcome}"),
            )
            .await;
            result
        }
        "initialize" => {
            let protocol = request["params"]["protocolVersion"]
                .as_str()
                .unwrap_or("2025-03-26");
            Ok(
                json!({"protocolVersion":if ["2024-11-05","2025-03-26","2025-06-18","2025-11-25","2026-07-28"].contains(&protocol){protocol}else{"2025-03-26"},"capabilities":if protocol == "2026-07-28" {json!({"tools":{},"events":{}})} else {json!({"tools":{}})},"serverInfo":{"name":"arc","version":env!("ARC_BUILD_VERSION")},"instructions":catalog()["instructions"]}),
            )
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"cacheScope":"private","ttlMs":0,"tools":catalog()["tools"]})),
        "tools/call" if is_wait(&request) => {
            let key = id.as_ref().ok_or("wait requires a request id")?.to_string();
            let (guard, mut cancel) = s.wait_calls.register(key)?;
            let args = request["params"]
                .get("arguments")
                .cloned()
                .unwrap_or(json!({}));
            let op_args = &args["args"];
            let started = std::time::Instant::now();
            let source = ControlSource::Ingress(s);
            let response = tokio::select! {
                result = call_tool(&source, string(&request["params"], "name"), args.clone(), id.as_ref()) => result,
                _ = cancel.changed() => {
                    let mut value = json!({"state":"unconfirmed","reason":"wait-cancelled","threadId":op_args["threadId"],"turnId":op_args["turnId"],"runtimeStatus":"unknown","recordedStatus":null,"finalResponse":null,"interaction":[],"changed":false,"conditionMet":false,"observedAt":null,"returnedAt":now(),"elapsedMs":started.elapsed().as_millis() as u64});
                    if args["op"] == "inbox_wait" {
                        value = json!({"state":"unconfirmed","reason":"wait-cancelled","events":[],"unread":0});
                    }
                    if args["op"] == "agent_wait" {
                        value["agent"] = op_args["agent"].clone();
                        value["taskId"] = op_args["taskId"].clone();
                    }
                    Ok(crate::egress::tool(value, false))
                }
            };
            drop(guard);
            response
        }
        "tools/call" => {
            call_tool(
                &ControlSource::Ingress(s),
                string(&request["params"], "name"),
                request["params"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or(json!({})),
                id.as_ref(),
            )
            .await
        }
        "notifications/cancelled" => {
            s.wait_calls
                .cancel(&request["params"]["requestId"].to_string());
            return Ok(Value::Null);
        }
        "notifications/initialized" => return Ok(Value::Null),
        _ => Err("method not found".into()),
    };
    if id.is_none() {
        return Ok(Value::Null);
    }
    Ok(match result {
        Ok(mut v) => {
            v["resultType"] = json!("complete");
            json!({"jsonrpc":"2.0","id":id,"result":v})
        }
        Err(e) => {
            let error = serde_json::from_str::<Value>(&e).ok().filter(|e|e["code"].is_i64() && e["message"].is_string()).unwrap_or_else(||json!({"code":if e=="method not found"{-32601}else{-32603},"message":e,"data":{"arcVersion":crate::egress::arc_version()}}));
            json!({"jsonrpc":"2.0","id":id,"error":error})
        }
    })
}

// Stateless ingress has no MCP sessions. Active wait request IDs must be unique
// across callers; collisions are rejected rather than cancelling another wait.
#[derive(Default)]
pub(crate) struct WaitCalls(
    Arc<std::sync::Mutex<std::collections::HashMap<String, tokio::sync::watch::Sender<bool>>>>,
);
struct WaitCallGuard {
    calls:
        Arc<std::sync::Mutex<std::collections::HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    key: String,
}
impl Drop for WaitCallGuard {
    fn drop(&mut self) {
        self.calls.lock().unwrap().remove(&self.key);
    }
}
impl WaitCalls {
    fn register(&self, key: String) -> Result<(WaitCallGuard, tokio::sync::watch::Receiver<bool>)> {
        let mut calls = self.0.lock().unwrap();
        if calls.contains_key(&key) {
            return Err("duplicate active wait request id".into());
        }
        let (tx, rx) = tokio::sync::watch::channel(false);
        calls.insert(key.clone(), tx);
        Ok((
            WaitCallGuard {
                calls: self.0.clone(),
                key,
            },
            rx,
        ))
    }
    fn cancel(&self, key: &str) {
        if let Some(tx) = self.0.lock().unwrap().get(key) {
            let _ = tx.send(true);
        }
    }
}

impl crate::ingress::Ingress {
    pub async fn allows(&self, name: &str) -> bool {
        let meta = self.meta.lock().await;
        let allowed = crate::kernel::policy::allows(&meta["toolPolicy"], name);
        drop(meta);
        allowed
            && self
                .execution
                .as_ref()
                .expect("Core ingress execution")
                .available(name)
                .await
    }
    pub async fn call(self: &Arc<Self>, name: &str, args: Value) -> Result<Value> {
        if !self.connected.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Connection closed".into());
        }
        let result = if name == "connector_verify" && !cfg!(test) {
            let spec = catalog()["ops"]
                .as_array()
                .unwrap()
                .iter()
                .find(|op| op["name"] == name)
                .unwrap();
            crate::egress::validate_op(spec, &args)?;
            let mut value = crate::front_door::process::gateway_request(
                &format!("_connector_verify/{}", self.id),
                "POST",
                args,
            )
            .await?;
            value["origin"] = self.origin().await;
            Ok(value)
        } else if name == "connector_verify" {
            let spec = catalog()["ops"]
                .as_array()
                .unwrap()
                .iter()
                .find(|op| op["name"] == name)
                .unwrap();
            crate::egress::validate_op(spec, &args)?;
            let mut v = self.verification.lock().await;
            if args["code"] != v["code"] {
                return Err("Verification code does not match".into());
            }
            let mut next = v.clone();
            next["challengeVerifiedAt"] = json!(now());
            next["verifiedAt"] = next["challengeVerifiedAt"].clone();
            save(&self.dir.join("verification.json"), &next)?;
            *v = next;
            Ok(json!({"code":args["code"],"received":true,"origin":self.origin().await}))
        } else {
            let policy = self.meta.lock().await["toolPolicy"].clone();
            self.execution
                .as_ref()
                .expect("Core ingress execution")
                .call(name, args, policy)
                .await
        };
        if result.is_ok() && name != "connector_verify" && !cfg!(test) {
            let _ = crate::front_door::process::gateway_request(
                &format!("_verified/{}", self.id),
                "POST",
                json!({}),
            )
            .await;
        }
        if result.is_ok() && name != "connector_verify" && cfg!(test) {
            let mut v = self.verification.lock().await;
            if v["verifiedAt"].is_null() {
                v["verifiedAt"] = json!(now());
                save(&self.dir.join("verification.json"), &v)?;
            }
        }
        self.log(
            if result.is_ok() { "INFO" } else { "ERROR" },
            &format!(
                "{}: {name}",
                if result.is_ok() {
                    "Request processed"
                } else {
                    "Request failed"
                }
            ),
        )
        .await;
        result
    }
}

pub(crate) fn browser_allowed(route: &str, method: &str) -> bool {
    match method {
        "GET" => {
            matches!(
                route,
                "status"
                    | "source"
                    | "agents"
                    | "agents/activity"
                    | "subscriptions"
                    | "tasks"
                    | "preferences"
                    | "accounts"
                    | "events"
                    | "subscriptions/events"
                    | "agents/activity/events"
                    | "relay/list"
                    | "relay/progress"
            ) || route
                .strip_prefix("accounts/")
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
                || ["agents/timeline/", "tasks/runtime/"].iter().any(|prefix| {
                    route
                        .strip_prefix(prefix)
                        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
                })
        }
        "POST" => matches!(
            route,
            "agents/conversations"
                | "agents/conversations/timeline"
                | "coordination/board"
                | "coordination/events"
                | "coordination/ax_list"
                | "agents/dispatch-catalog"
                | "agents/dispatch-defaults/read"
                | "agents/resources"
                | "tasks/reviews"
                | "tasks/control"
                | "tasks/request-routing"
        ),
        _ => false,
    }
}

pub(crate) fn handle<'a>(
    target: crate::front_door::Target<'a>,
    request: &'a crate::front_door::Request,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + 'a>> {
    Box::pin(async move {
        use crate::front_door::{Operation, Snapshot, Target};
        // The private socket/pipe authenticates the peer before this context is decoded.
        request.context.validate()?;
        match (target, &request.operation) {
            (Target::Ingress(ingress), Operation::Mcp)
                if request.context.ingress_id() == Some(&ingress.id) =>
            {
                let origin = request
                    .context
                    .origin()
                    .ok_or("FRONT_DOOR_CONTEXT_MISMATCH")?;
                crate::kernel::origin::ORIGIN
                    .scope(origin.clone(), dispatch(ingress, request.body.clone()))
                    .await
            }
            (Target::Service(service, _), Operation::LocalControl)
                if request.context.is_management() =>
            {
                local_control(service, request.body.clone()).await
            }
            (Target::Service(service, desktop), Operation::Management { route, method }) => {
                if request.context.is_browser() {
                    authorize_browser(route, method, &request.body)?;
                } else if !request.context.is_management() {
                    return Err("FRONT_DOOR_CONTEXT_MISMATCH".into());
                }
                let route = if request.context.is_browser() {
                    match route.as_str() {
                        "status" => "browser/snapshot",
                        _ => route,
                    }
                } else {
                    route
                };
                management(service, desktop, route, method, request.body.clone()).await
            }
            (Target::Service(service, _), Operation::Snapshot { kind }) => {
                if !request.context.is_management() && !request.context.is_browser() {
                    return Err("FRONT_DOOR_CONTEXT_MISMATCH".into());
                }
                if request.context.is_browser() && matches!(kind, Snapshot::Status) {
                    return Err("FRONT_DOOR_BROWSER_FORBIDDEN".into());
                }
                match kind {
                    Snapshot::Status => service.status().await,
                    Snapshot::Browser => service.status().await.map(crate::browser::compact_status),
                    Snapshot::Subscriptions => {
                        Ok(json!(&*service.subscriptions.subscribe().borrow()))
                    }
                    Snapshot::Activity => Ok(service.agents.activity(&service.control).await),
                }
            }
            (Target::Service(service, _), Operation::Health) if request.context.is_management() => {
                Ok(
                    json!({"runtime":"rust","instance":service.control.session,"pid":std::process::id(),"owner":"core","version":env!("ARC_BUILD_VERSION"),"build":load(&root().join("app/native.json"))?["build"],"frontDoor":crate::front_door::process::status(crate::runtime::process_build_id()?)}),
                )
            }
            (Target::Service(_service, _), Operation::Authority { op })
                if request.context.is_management() =>
            {
                crate::front_door::authority::handle(op, request.body.clone()).await
            }
            (Target::Service(service, _), Operation::IngressContext { ingress_id })
                if request.context.is_management() =>
            {
                let ingress = service.ingress(ingress_id).await?;
                if !ingress.connected.load(std::sync::atomic::Ordering::SeqCst)
                    || ingress.meta.lock().await["enabled"] != true
                {
                    return Err("Connection closed".into());
                }
                serde_json::to_value(
                    crate::front_door::authenticated_context(
                        &ingress,
                        &request.body["principal"],
                        request.body["header"].as_str(),
                    )
                    .await?,
                )
                .map_err(|e| e.to_string())
            }
            _ => Err("FRONT_DOOR_CONTEXT_MISMATCH".into()),
        }
    })
}

pub(crate) fn authorize_browser(route: &str, method: &str, body: &Value) -> Result<()> {
    if !browser_allowed(route, method)
        || (route == "tasks/control" && body["op"] != "codex_queue")
        || (route == "tasks/request-routing" && body["action"] != "read")
        || (route == "agents/resources" && body["action"] != "image")
    {
        return Err("FRONT_DOOR_BROWSER_FORBIDDEN".into());
    }
    if method == "POST" {
        let catalog = crate::management::catalog();
        let operation = catalog["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["route"] == route && op["method"] == "POST")
            .ok_or("FRONT_DOOR_BROWSER_FORBIDDEN")?;
        crate::management::resolve(string(operation, "name"), &json!({"body":body}))
            .map_err(|_| "FRONT_DOOR_BROWSER_INVALID".to_owned())?;
    }
    Ok(())
}

async fn management(
    s: &Arc<Service>,
    desktop: Option<&Arc<dyn crate::transport::DesktopAccess>>,
    route: &str,
    method: &str,
    body: Value,
) -> Result<Value> {
    use crate::transport::DesktopRequest;
    if method != "GET" {
        if let Some(owner) = desktop {
            owner.check_write()?;
        }
    }
    let operation = match (route, method) {
        ("service", "GET") => Some(DesktopRequest::ServiceGet),
        ("service", "POST") => Some(DesktopRequest::ServiceSet(body.clone())),
        ("subscriptions/open", "POST") => Some(DesktopRequest::SubscriptionsOpen(body.clone())),
        _ if crate::management::desktop_route(route) => Some(DesktopRequest::Route(
            route.into(),
            method.into(),
            body.clone(),
        )),
        _ => None,
    };
    if let Some(operation) = operation {
        if let Some(desktop) = desktop {
            desktop.request(operation).await
        } else {
            s.runtime.desktop_request(operation).await
        }
    } else {
        s.request(route, method, body).await
    }
}

pub(crate) async fn stream(
    service: &Arc<Service>,
    request: &crate::front_door::Request,
    endpoint: &crate::front_door::InProcess,
    tx: &tokio::sync::mpsc::Sender<Result<crate::front_door::StreamFrame>>,
) {
    use crate::front_door::{Operation, Snapshot, Target};
    let Operation::Snapshot { kind } = request.operation else {
        return;
    };
    let subscriptions = matches!(kind, Snapshot::Subscriptions);
    let activity = matches!(kind, Snapshot::Activity);
    let browser = matches!(kind, Snapshot::Browser);
    let mut previous = Value::Null;
    let mut last_sent = tokio::time::Instant::now();
    let mut changes = service.subscriptions.subscribe();
    let mut sequence = 0;
    loop {
        if let Err(error) = request.validate() {
            let _ = tx.send(Err(error)).await;
            return;
        }
        let snapshot = match tokio::select! {
            _ = tx.closed() => return,
            value = handle(Target::Service(service, None), request) => value,
        } {
            Ok(value) => value,
            Err(error) => {
                let _ = tx.send(Err(error)).await;
                return;
            }
        };
        // Consume the same watch value whose revision is marked, so a concurrent
        // quota publication cannot be skipped between snapshot read and waiting.
        let snapshot = if subscriptions {
            json!(&*changes.borrow_and_update())
        } else {
            snapshot
        };
        let mut comparison = snapshot.clone();
        if activity {
            comparison.as_object_mut().unwrap().remove("observedAt");
        }
        if browser {
            comparison = crate::browser::status_comparison(&snapshot);
        }
        let body = if (!activity && !browser) || comparison != previous {
            previous = comparison;
            Some(snapshot)
        } else if last_sent.elapsed() >= std::time::Duration::from_secs(15) {
            Some(Value::Null)
        } else {
            None
        };
        if let Some(body) = body {
            let frame = endpoint.stream_frame(request, sequence, body);
            let failed = frame.is_err();
            if tx.send(frame).await.is_err() || failed {
                return;
            }
            sequence += 1;
            last_sent = tokio::time::Instant::now();
        }
        tokio::select! {
            _ = tx.closed() => return,
            result = changes.changed(), if subscriptions => if result.is_err() { return; },
            _ = tokio::time::sleep(std::time::Duration::from_secs(if subscriptions {15} else if activity {1} else {2})) => {},
        }
    }
}
