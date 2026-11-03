//! Metadata-only AX owner. Source snapshots and evidence reads precede AX locking;
//! journal projection runs after releasing AX. No owner/discovery/network locks inside AX.
mod import;
mod issue;
mod store;
use super::*;
use std::sync::{LazyLock, Mutex};
use store::Store;

static AX: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
const RECEIPTS: crate::kernel::receipts::ReceiptStore =
    crate::kernel::receipts::ReceiptStore::new("");
fn with_store<T>(f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
    let _guard = AX
        .lock()
        .map_err(|_| "COORDINATION_STORAGE: AX lock unavailable")?;
    f(&mut Store::open(root().join("coordination/ax"))?)
}
fn actor() -> Result<(Value, String)> {
    let origin = crate::kernel::origin::current_origin();
    let source = crate::sources::coordination_source(&origin)?;
    let reader = super::reader(&origin, &source)?;
    Ok((json!(reader.principal), reader.revision))
}
fn actor_identity(actor: &Value) -> Value {
    if actor["type"] == "source" {
        json!({"type":"source","sourceId":actor["sourceId"]})
    } else {
        actor.clone()
    }
}
fn request_digest(op: &str, args: &Value, actor: &Value) -> String {
    let mut normalized = args.clone();
    if op == "ax_report" && normalized["kind"].is_null() {
        normalized["kind"] = json!("friction");
    }
    for field in [
        "resources",
        "receiptIds",
        "requestIds",
        "threadIds",
        "evidenceIds",
    ] {
        if let Some(values) = normalized[field].as_array_mut() {
            values.sort_by_key(Value::to_string);
        }
    }
    hash(json!([op, normalized, actor_identity(actor)]).to_string())
}
fn validate(op: &str, args: &Value) -> Result<()> {
    let catalog = catalog();
    let spec = catalog["ops"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == op)
        .ok_or("INVALID_ARGUMENT: unknown AX operation")?;
    crate::egress::validate_op(spec, args)?;
    if op == "ax_report" && args["kind"] != "idea" && !args["severity"].is_string() {
        return Err("INVALID_ARGUMENT: friction requires severity".into());
    }
    if op == "ax_issue_draft" {
        return Ok(());
    }
    for field in ["receiptIds", "requestIds", "threadIds", "evidenceIds"] {
        for reference in args[field].as_array().into_iter().flatten() {
            super::types::identifier(reference.as_str().unwrap_or(""))?;
        }
    }
    for resource in args["resources"].as_array().into_iter().flatten() {
        let key = ResourceKey::parse(resource.as_str().unwrap_or(""))?;
        if key.shorthand().is_some() {
            return Err(
                "INVALID_ARGUMENT: qualify lane resources with their registered project ID".into(),
            );
        }
    }
    Ok(())
}
fn failure(message: String, op: &str, args: &Value) -> Value {
    let code = message.split(':').next().unwrap_or("COORDINATION_STORAGE");
    let next = match code {
        "AX_REVISION_CONFLICT" | "AX_NOT_FOUND" | "AX_MERGED" | "AX_STATE_CONFLICT" => {
            json!({"via":"query","op":"ax_list","args":{"id":args["id"]},"hint":"Read the entry and use its current revision"})
        }
        "AX_FORBIDDEN" => {
            let mut local = args.clone();
            if let Some(fields) = local.as_object_mut() {
                fields.remove("requestId");
            }
            json!({"via":"cli","op":null,"command":format!("arc cli control {op} --stdin"),"stdin":local,"hint":format!("Imported entries require local authority. Read the current revision with arc cli control ax_list --stdin locally, then run arc cli control {op} --stdin with id, expectedRevision, action and reason. Omit the source requestId; local authority must reserve its own request.")})
        }
        "AX_CURSOR_EXPIRED" => {
            let mut reset = args.clone();
            reset.as_object_mut().map(|a| a.remove("cursor"));
            json!({"via":"query","op":"ax_list","args":reset,"hint":"Restart pagination; the AX snapshot or authority changed"})
        }
        "MAINTAINER_MODE_REQUIRED" => {
            json!({"op":null,"hint":"Ask the user to enable Maintainer mode under Settings > Experimental, or locally run cli config set --stdin with {\"maintainerMode\":true}. Authenticated local authority may also triage/import without enabling the mode."})
        }
        "INVALID_ARGUMENT" => {
            json!({"via":"query","op":"guide","args":{"op":op},"hint":"Use the current AX schema; include metadata only"})
        }
        "COORDINATION_RATE_LIMIT" => {
            json!({"via":"act","op":op,"args":args,"hint":"Wait one minute; retry with the same requestId"})
        }
        _ => {
            json!({"op":null,"hint":"Use local AX management to resolve authority or storage capacity. Export closed records with cli ax export --to <path>; preserve readable state and retry the original requestId."})
        }
    };
    let mut result = json!({"state":"failed","error":{"code":code,"message":message},"next":next});
    if code == "AX_REVISION_CONFLICT" {
        result["currentRevision"] = message
            .split("current revision ")
            .nth(1)
            .and_then(|s| s.split(';').next())
            .and_then(|s| s.parse::<u64>().ok())
            .map_or(Value::Null, |v| json!(v));
    }
    result
}
/// Pending descriptors remain durable on failure. Bounded reconciliation also runs
/// on reads and retries, so a response lost after commit never duplicates an entry.
fn reconcile() -> Result<()> {
    for input in with_store(|s| Ok(s.pending()))? {
        let transition = input.transition_id.clone();
        crate::coordination::emit(input)?;
        with_store(|s| s.projected(&transition))?;
    }
    if with_store(|s| Ok(s.pending().is_empty()))? {
        Ok(())
    } else {
        Err(
            "COORDINATION_PROJECTION_PENDING: read ax_list to continue bounded reconciliation"
                .into(),
        )
    }
}
fn evidence(args: &Value, actor: &Value) -> Vec<Value> {
    let mut refs = vec![];
    for field in ["receiptIds", "requestIds", "threadIds", "evidenceIds"] {
        for reference in args[field]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let local = actor["type"] == "local-authority";
            let mut fact = json!({"kind":if field=="threadIds" {"thread"}else{"receipt"},"id":reference,"availability":"unavailable","observedAt":now()});
            if field == "threadIds" {
                let origin = crate::sources::task_origin(reference, None);
                if !origin.is_null() && (local || origin["sourceId"] == actor["sourceId"]) {
                    fact["availability"] = json!("available");
                }
            } else if let Ok(path) = RECEIPTS.path(reference) {
                // Bounded direct reference lookup; never scan transcripts or copy a receipt body.
                if std::fs::metadata(&path).is_ok_and(|m| m.len() <= 1024 * 1024) {
                    if let Ok(receipt) = load(&path) {
                        if local || receipt["origin"]["sourceId"] == actor["sourceId"] {
                            fact["availability"] = json!("available");
                            fact["state"] = receipt["state"].clone();
                            let op = string(&receipt, "operation");
                            if op.len() <= 64 {
                                fact["operation"] = json!(op);
                            }
                        }
                    }
                }
            }
            refs.push(fact);
        }
    }
    refs.push(json!({"kind":"observation","observedAt":now(),"coreBuild":crate::runtime::process_build_id().ok(),"desktopBuild":null}));
    refs
}
pub(crate) async fn call(op: &str, mut args: Value, session: &str) -> Result<Value> {
    let result = async {
        validate(op,&args)?;
        let (actor, revision)=actor()?;
        require_maintainer(op, &actor, crate::preferences::maintainer_mode())?;
        if op == "ax_issue_draft" { return Ok(issue::draft(&args)); }
        // Feed failure cannot undo a durable AX mutation. Readback exposes pending projection.
        let projection = reconcile().err();
        if op=="ax_list" {
            let mut result=with_store(|s|s.list(&args,&actor,&revision,chrono::Utc::now().timestamp_millis()))?;
            result["projectionPending"]=json!(projection.is_some());
            return Ok(result);
        }
        if args["requestId"].is_null() { args["requestId"]=json!(id()); }
        let request=string(&args,"requestId").to_owned();
        let locks=crate::kernel::receipts::RequestLocks;
        let _request=locks.lock(&request).await;
        let digest=request_digest(op,&args,&actor);
        let mut receipt=match RECEIPTS.replay(&request,&digest,session)? {
            Some(r) if r["state"]=="completed" || r["state"]=="failed" => {
                let mut result=r["result"].clone(); result["receipt"]=r; return Ok(result);
            }
            Some(r) => r,
            None => {
                let r=json!({"requestId":request,"origin":crate::kernel::origin::current_origin(),"backendSession":session,"digest":digest,"operation":op,"state":"reserved","createdAt":now()});
                RECEIPTS.reserve(&r)?; r
            }
        };
        let facts=evidence(&args,&actor);
        let outcome=with_store(|s|s.mutate(op,&args,&actor,facts,chrono::Utc::now().timestamp_millis()));
        let mut result=match outcome {
            Ok(mut result) => { result["projectionPending"]=json!(reconcile().is_err()); receipt["state"]=json!("completed"); result }
            Err(error) => {
                // Capacity/storage failures are retryable with the same durable reservation.
                if error.starts_with("COORDINATION_") { return Err(error); }
                receipt["state"]=json!("failed"); failure(error,op,&args)
            }
        };
        // Persist only the safe entry projection. Owner-only detail lives in AX, not receipts.
        let mut saved=result.clone();
        if let Some(entry)=saved.get_mut("entry").and_then(Value::as_object_mut) { entry.remove("reproductionHints"); entry.remove("evidence"); entry.remove("history"); }
        receipt["result"]=saved;
        RECEIPTS.checkpoint(&mut receipt)?;
        result["receipt"]=receipt;
        Ok(result)
    }.await;
    Ok(result.unwrap_or_else(|message| failure(message, op, &args)))
}
/// AX part of board attention for the authenticated reader. Reading resolves nothing.
pub(crate) fn attention() -> Result<Vec<Value>> {
    let (actor, _) = actor()?;
    let triage = crate::preferences::maintainer_mode() || actor["type"] == "local-authority";
    with_store(|s| Ok(s.attention(&actor, triage)))
}
fn require_maintainer(op: &str, actor: &Value, enabled: bool) -> Result<()> {
    if matches!(op, "ax_triage" | "import") && !enabled && actor["type"] != "local-authority" {
        return Err("MAINTAINER_MODE_REQUIRED: AX triage/import requires Maintainer mode or authenticated local authority".into());
    }
    Ok(())
}
/// Local management only. Core remains the sole writer even when import is invoked by CLI.
pub(crate) fn local(action: &str, body: &Value) -> Result<Value> {
    require_maintainer(
        action,
        &json!({"type":"local-authority"}),
        crate::preferences::maintainer_mode(),
    )?;
    let result = match action {
        "import" => {
            let path = Path::new(string(body, "from"));
            if !path.is_absolute() {
                return Err("INVALID_ARGUMENT: import requires an absolute local path".into());
            }
            if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > 256 * 1024 {
                return Err("COORDINATION_CAPACITY: import is limited to 256 KiB".into());
            }
            let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            with_store(|s| s.import_queue(&text, chrono::Utc::now().timestamp_millis()))?
        }
        "export" => {
            let path = Path::new(string(body, "to"));
            if !path.is_absolute() || path.starts_with(root()) {
                return Err(
                    "INVALID_ARGUMENT: export to a new absolute path outside ARC state".into(),
                );
            }
            let parent = path
                .parent()
                .ok_or("INVALID_ARGUMENT: export requires a file path")?
                .canonicalize()
                .map_err(|_| "INVALID_ARGUMENT: export parent directory must exist")?;
            let state = root()
                .canonicalize()
                .map_err(|_| "COORDINATION_STORAGE: cannot resolve ARC state directory")?;
            if parent.starts_with(state) {
                return Err("INVALID_ARGUMENT: export outside ARC state".into());
            }
            let destination = parent.join(
                path.file_name()
                    .ok_or("INVALID_ARGUMENT: export requires a file name")?,
            );
            with_store(|s| s.export(&destination))?
        }
        _ => return Err("INVALID_ARGUMENT: use cli ax import or export".into()),
    };
    let mut result = result;
    result["projectionPending"] = json!(reconcile().is_err());
    Ok(result)
}

#[derive(Clone, Copy)]
pub enum Friction {
    StalledReceipt,
    OwnerDiscoveryTimeout,
    DeliveryFailure,
}
impl Friction {
    fn signature(self) -> &'static str {
        match self {
            Self::StalledReceipt => "receipt-stalled",
            Self::OwnerDiscoveryTimeout => "owner-discovery-timeout",
            Self::DeliveryFailure => "delivery-failed",
        }
    }
    fn symptom(self) -> &'static str {
        match self {
            Self::StalledReceipt => "Receipt progress stalled",
            Self::OwnerDiscoveryTimeout => "Thread owner discovery timed out",
            Self::DeliveryFailure => "Notification delivery failed",
        }
    }
}
/// Owner integration uses only typed metadata and a stable observation ID. Call after
/// releasing owner locks. No candidate or AX event generates delivery-failure alerts.
pub fn observe(
    kind: Friction,
    observation: &str,
    source: Option<Principal>,
    references: Vec<EvidenceRef>,
) -> Result<Value> {
    super::types::identifier(observation)?;
    if references.len() > 16 {
        return Err("COORDINATION_CAPACITY: at most 16 candidate references".into());
    }
    for r in &references {
        super::types::identifier(&r.id)?;
    }
    let build = crate::runtime::process_build_id()?.to_owned();
    let result = with_store(|s| {
        s.candidate(
            kind,
            observation,
            source,
            references,
            &build,
            chrono::Utc::now().timestamp_millis(),
        )
    })?;
    let _ = reconcile();
    Ok(result)
}
/// Feed owners already capture the receipt/delivery identity. Do not inspect arbitrary
/// error messages or task output. AX events are excluded to prevent recursive candidates.
pub(super) fn from_event(input: &EventInput) -> Result<()> {
    let kind = match input.kind {
        EventKind::ReceiptStalled => Friction::StalledReceipt,
        EventKind::NotificationDeliveryFailed => Friction::DeliveryFailure,
        _ => return Ok(()),
    };
    observe(
        kind,
        &input.transition_id,
        input.origin.clone(),
        input.evidence_refs.clone(),
    )?;
    Ok(())
}
/// Inspect only control-operation errors, never histories, command output or prompts.
pub(crate) fn observe_control_result(op: &str, args: &Value, result: &Result<Value>) {
    if !matches!(
        op,
        "codex_read" | "codex_resume" | "codex_owner" | "codex_send" | "receipt"
    ) {
        return;
    }
    const TIMEOUT: &str = "DESKTOP_REQUEST_TIMEOUT: thread-owner-discovery";
    let failed = match result {
        Err(error) => error == TIMEOUT,
        Ok(value) => [value, &value["result"], &value["lastResult"]]
            .iter()
            .any(|v| {
                v["error"].as_str() == Some(TIMEOUT)
                    || v["error"]["message"].as_str() == Some(TIMEOUT)
            }),
    };
    if !failed {
        return;
    }
    let caller = crate::kernel::origin::current_origin();
    let origin = result
        .as_ref()
        .ok()
        .filter(|v| v["operation"].is_string() && v["requestId"].is_string())
        .and_then(|v| v.get("origin"))
        .unwrap_or(&caller);
    let source = Principal::from_origin(origin).ok().flatten();
    let request = result
        .as_ref()
        .ok()
        .and_then(|v| v["requestId"].as_str())
        .or(args["requestId"].as_str());
    let thread = args["threadId"]
        .as_str()
        .filter(|v| uuid::Uuid::parse_str(v).is_ok());
    let observation = request.map(str::to_owned).unwrap_or_else(|| {
        hash(json!([op, thread, source, chrono::Utc::now().timestamp() / 600]).to_string())
    });
    let mut refs = vec![];
    if let Some(request) = request {
        refs.push(EvidenceRef {
            kind: EvidenceKind::Receipt,
            id: request.into(),
        });
    }
    if let Some(thread) = thread {
        refs.push(EvidenceRef {
            kind: EvidenceKind::Thread,
            id: thread.into(),
        });
    }
    let _ = observe(Friction::OwnerDiscoveryTimeout, &observation, source, refs);
}
#[cfg(test)]
mod tests;
