//! Private addressed metadata. Source snapshots precede MESSAGES; projection and
//! notification IO run after releasing it. No prompts or automatic task actions.
mod store;
#[cfg(test)]
mod tests;
use super::*;
use crate::claude_notify::coordination_delivery::{deliver, Request, Route};
use std::sync::{LazyLock, Mutex};
use store::Store;
pub(crate) const SUMMARY_LIMIT: usize = 240;
static MESSAGES: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static REQUESTS: crate::kernel::receipts::RequestLocks = crate::kernel::receipts::RequestLocks;
const RECEIPTS: crate::kernel::receipts::ReceiptStore =
    crate::kernel::receipts::ReceiptStore::new("");
fn with_store<T>(f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
    with_store_at(root().join("coordination/messages/state.json"), |s| {
        s.migrate_routes()?;
        f(s)
    })
}
fn with_store_at<T>(path: PathBuf, f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
    let _guard = MESSAGES
        .lock()
        .map_err(|_| "COORDINATION_STORAGE: messages lock unavailable")?;
    f(&mut Store::open(path)?)
}
fn resources(args: &Value) -> Result<Vec<ResourceKey>> {
    let mut rows: Vec<_> = args["resources"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| {
            let key = ResourceKey::parse(v.as_str().unwrap_or(""))?;
            if key.shorthand().is_some() {
                return Err("INVALID_ARGUMENT: use qualified lane resource keys".into());
            }
            Ok(key)
        })
        .collect::<Result<_>>()?;
    rows.sort();
    rows.dedup();
    Ok(rows)
}
fn validate(op: &str, args: &Value) -> Result<()> {
    let catalog = catalog();
    let spec = catalog["ops"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == op)
        .ok_or("INVALID_ARGUMENT: unknown message operation")?;
    crate::egress::validate_op(spec, args)?;
    if op == "message_route" {
        if let Some(target) = args["target"].as_str() {
            crate::claude_notify::session_id(target).map_err(|_|"INVALID_ARGUMENT: message_route requires a complete registered Claude cloud-session ID or URL")?;
        }
    }
    for field in [
        "toSourceId",
        "sessionId",
        "toSessionId",
        "negotiationId",
        "inReplyTo",
    ] {
        if let Some(v) = args[field].as_str() {
            types::identifier(v)?;
        }
    }
    for v in args["relatedIds"].as_array().into_iter().flatten() {
        types::identifier(v.as_str().unwrap_or(""))?;
    }
    if args["summary"].as_str().is_some_and(|s| {
        s.trim().is_empty() || s.chars().count() > SUMMARY_LIMIT || s.chars().any(char::is_control)
    }) {
        return Err("INVALID_ARGUMENT: summary must be single-line metadata of 1 to 240 characters, never prompt content".into());
    }
    let keys = resources(args)?;
    for condition in args["conditions"].as_array().into_iter().flatten() {
        if !keys.contains(&ResourceKey::parse(string(condition, "resource"))?) {
            return Err("INVALID_ARGUMENT: condition must reference a message resource".into());
        }
    }
    Ok(())
}
fn failure(error: String, op: &str) -> Value {
    let code = error.split(':').next().unwrap_or("COORDINATION_STORAGE");
    let next = match code {
        "INVALID_ARGUMENT" => {
            json!({"via":"query","op":"guide","args":{"op":op},"hint":"Use the current metadata-only message schema"})
        }
        "MESSAGES_CURSOR_EXPIRED"
        | "NEGOTIATION_NOT_FOUND"
        | "NEGOTIATION_EXPIRED"
        | "NEGOTIATION_RESOLVED" => {
            json!({"via":"query","op":"messages","args":{},"hint":"Read messages again; retain the original requestId for retries"})
        }
        "NEGOTIATION_LIMIT" => {
            json!({"op":null,"hint":"Stop automatic replies on both sides. Ask the user to inspect and mediate through local messages management; a new negotiation or session cannot bypass this hold."})
        }
        _ => {
            json!({"op":null,"hint":"Inspect local ARC source authorization, message capacity and delivery diagnostics; retain the original requestId. No task was dispatched."})
        }
    };
    json!({"state":"failed","error":{"code":code,"message":error},"next":next})
}
fn authorized(source: &str) -> Result<Value> {
    let s = crate::sources::coordination_source(&json!({"sourceId":source}))?;
    if s["state"] == "revoked" || s["connectionRemoved"] == true || crate::sources::is_local(&s) {
        return Err("SOURCE_REVOKED: select an authorized control source".into());
    }
    Ok(s)
}
/// Bulletin owns logical sessions. Missing/closed handles never become a guessed
/// conversation. Source-only mail works before a logical session is registered.
fn session(source: &str, session: Option<&str>) -> Result<bool> {
    if let Some(id) = session {
        if !super::bulletin::session_active(source, id)? {
            return Err(
                "SESSION_NOT_FOUND: select an active logical session owned by that source".into(),
            );
        }
        Ok(false)
    } else {
        Ok(true)
    }
}
fn reconcile() -> Result<()> {
    for event in with_store(|s| Ok(s.pending()))? {
        let transition = event.transition_id.clone();
        super::emit(event)?;
        with_store(|s| s.projected(&transition))?;
    }
    Ok(())
}
pub(crate) async fn call(op: &str, mut args: Value, backend: &str) -> Result<Value> {
    let result=async {
        validate(op,&args)?;
        let origin=crate::kernel::origin::current_origin();
        let source=crate::sources::coordination_source(&origin)?;
        let reader=super::reader(&origin,&source)?;
        let actor=match &reader.principal {Principal::Source{source_id,..}=>source_id.as_str(),Principal::LocalAuthority=>"local-authority",_=>return Err("SOURCE_REQUIRED: control source required".into())};
        let projection=reconcile().err();
        if op=="messages" {refresh_recovery()?;let mut result=with_store(|s|s.list(&args,actor,&reader.revision,chrono::Utc::now().timestamp()))?; if actor!="local-authority" {result["coordinationDelivery"]=super::routing::status(actor)?;} result["projectionPending"]=json!(projection.is_some() || result["projectionPending"]==true); return Ok(result);}
        if actor=="local-authority" {return Err("SOURCE_REQUIRED: local authority mediates through messages management".into());}
        if op!="message_route" || !args["target"].is_null() {session(actor,args["sessionId"].as_str())?;}
        if op=="message_route" {
            let route=if args["target"].is_null(){None}else{Some(crate::claude_notify::coordination_delivery::verified_target(actor,string(&args,"target"))?.route.ok_or("MESSAGE_ROUTE_UNVERIFIED: bind and verify this source-owned target through notify_control first")?)};
            super::bulletin::bind_route(actor,string(&args,"sessionId"),route)?;
            let outcome=super::routing::resolve(actor,Some(string(&args,"sessionId")))?;
            let routing=super::routing::description(&outcome,actor,Some(string(&args,"sessionId")));
            return Ok(json!({"sessionId":args["sessionId"],"deliveryMode":routing["deliveryMode"],"deliveryCapability":routing["deliveryMode"],"routing":routing}));
        }
        let target=string(&args,"toSourceId"); authorized(target)?;
        session(target,args["toSessionId"].as_str())?;
        let outcome=super::routing::resolve(target,args["toSessionId"].as_str())?;
        let route=outcome.route;
        let reason=outcome.state;
        if args["requestId"].is_null(){args["requestId"]=json!(id());}
        let request=string(&args,"requestId").to_owned();
        let _request=REQUESTS.lock(&request).await;
        let digest=hash(json!([actor,args]).to_string());
        let mut receipt=match RECEIPTS.replay(&request,&digest,backend)? {
            Some(r) if r["state"]=="completed"=>{let mut result=r["result"].clone(); result["receipt"]=r; return Ok(result);},
            Some(r)=>r,
            None=>{let r=json!({"requestId":request,"origin":origin,"backendSession":backend,"digest":digest,"operation":op,"state":"reserved","createdAt":now()}); RECEIPTS.reserve(&r)?;r}
        };
        let mut value=with_store(|s|s.send(&args,actor,route,&reason,chrono::Utc::now().timestamp()))?;
        value["projectionPending"]=json!(reconcile().is_err());
        // Receipts are discoverable independently; private bodies stay in messages.
        receipt["state"]=json!("completed");
        receipt["result"]=json!({"stored":true,"pullable":true,"hint":value["hint"],"messageId":value["message"]["messageId"],"negotiationId":value["message"]["negotiationId"],"deliveryMode":value["deliveryMode"],"routing":value["routing"],"next":{"via":"query","op":"messages","args":{"direction":"outbox"}}});
        RECEIPTS.checkpoint(&mut receipt)?;value["receipt"]=receipt;Ok(value)
    }.await;
    Ok(result.unwrap_or_else(|e| failure(e, op)))
}
pub(crate) fn local(method: &str, args: &Value) -> Result<Value> {
    let result = if method == "GET" {
        validate("messages", args)?;
        with_store(|s| {
            s.list(
                args,
                "local-authority",
                "local",
                chrono::Utc::now().timestamp(),
            )
        })
    } else {
        if !matches!(string(args, "action"), "resolve" | "reopen")
            || args["reason"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty() || s.chars().count() > 240)
        {
            return Err("INVALID_ARGUMENT: local mediation requires action resolve|reopen, negotiationId, expectedLastMessageId and a reason of 1 to 240 characters".into());
        }
        with_store(|s| s.mediate(args, chrono::Utc::now().timestamp()))
    };
    let mut value = result?;
    value["projectionPending"] = json!(reconcile().is_err());
    Ok(value)
}
async fn flush() -> Result<()> {
    reconcile()?;
    refresh_recovery()?;
    let time = chrono::Utc::now().timestamp();
    for rows in with_store(|s| s.batches(time))? {
        let route = rows[0].route.clone().unwrap();
        let valid = rows
            .iter()
            .all(|r| authorized(string(&r.envelope, "fromSourceId")).is_ok())
            && authorized(&route.source_id).is_ok()
            && rows
                .iter()
                .all(|r| session(&route.source_id, r.envelope["toSessionId"].as_str()).is_ok());
        let mut current_bindings = true;
        for row in &rows {
            if let Some(id) = row.envelope["toSessionId"].as_str() {
                let current = super::bulletin::route(&route.source_id, id)?;
                current_bindings &= match current {
                    Some(current) => Some(&current) == row.route.as_ref(),
                    None => row.route.as_ref().is_some_and(|r| r.binding_id.is_none()),
                };
            } else if row.envelope["deliveryReason"] == "explicit-route" {
                let current = super::routing::resolve(&route.source_id, None)?;
                current_bindings &= current.route == row.route;
            }
        }
        if !valid
            || !current_bindings
            || rows
                .iter()
                .any(|r| r.route.as_ref().is_none_or(|r| !r.same_destination(&route)))
        {
            with_store(|s| s.mark(&rows, "cancelled", time))?;
            continue;
        }
        // Refresh after authority/binding checks and atomically reserve only rows
        // whose recovery advice is still relevant. Partial batches keep other mail.
        let (events, _) = super::recovery::events()?;
        let rows = with_store(|s| s.reserve(&rows, &events, time))?;
        if rows.is_empty() {
            continue;
        }
        let result = deliver(Request {
            route,
            messages: rows.iter().map(|r| r.envelope.clone()).collect(),
            escalated: rows.iter().any(|r| r.envelope["escalated"] == true),
            batch_id: string(&rows[0].envelope, "messageId").into(),
        })
        .await;
        let state = match result {
            Ok(r) => r.state,
            Err(_) => "unconfirmed".into(),
        };
        with_store(|s| s.mark(&rows, &state, chrono::Utc::now().timestamp()))?;
    }
    Ok(())
}
pub(crate) fn start(service: &Arc<crate::service::Service>) {
    let mut shutdown = service.control.shutdown.subscribe();
    tokio::spawn(async move {
        loop {
            tokio::select! {_=shutdown.changed()=>break,_=tokio::time::sleep(std::time::Duration::from_secs(5))=>{}}
            tokio::select! {_=shutdown.changed()=>break,result=flush()=>{if result.is_err(){observers::gap("messages","projection-or-delivery-unavailable");}}}
        }
    });
}

pub(super) fn binding_id(source: &Value, session: &Value) -> Result<Option<String>> {
    Ok(super::bulletin::route(
        source.as_str().unwrap_or(""),
        session.as_str().unwrap_or(""),
    )?
    .and_then(|r| r.binding_id))
}
pub(crate) fn migrate_routes() -> Result<()> {
    with_store(|_| Ok(()))
}
pub(super) fn recovery(blocker: &Value, recipient: &Value) -> Result<()> {
    let source = string(recipient, "sourceId");
    match authorized(source) {
        Ok(_) => {}
        Err(error) if error.starts_with("SOURCE_REVOKED") || error == "SOURCE_NOT_FOUND" => {
            return Ok(())
        }
        Err(error) => return Err(error),
    }
    if !super::bulletin::session_active(source, string(recipient, "sessionId"))? {
        return Ok(());
    }
    with_store(|s| s.recovery(blocker, recipient, chrono::Utc::now().timestamp()))?;
    Ok(())
}
fn refresh_recovery() -> Result<()> {
    let (events, _) = super::recovery::events()?;
    with_store(|s| s.refresh_recovery(&events))
}
