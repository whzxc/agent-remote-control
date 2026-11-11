//! One durable receipt per transfer; only explicit resume creates another attempt.
use super::*;
use crate::kernel::receipts::{ReceiptStore, RequestLocks};
use std::sync::OnceLock;
#[cfg(test)]
use tokio::sync::Notify;
static RECEIPTS: ReceiptStore = ReceiptStore::new("");
fn session() -> &'static str {
    static SESSION: OnceLock<String> = OnceLock::new();
    SESSION.get_or_init(id)
}
fn jobs() -> &'static Mutex<BTreeMap<String, tokio::task::JoinHandle<()>>> {
    static JOBS: OnceLock<Mutex<BTreeMap<String, tokio::task::JoinHandle<()>>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}
fn next(request: &str) -> Value {
    json!({"via":"act","op":"receipt","args":{"action":"read","requestId":request}})
}
fn read(request: &str) -> Result<Value> {
    let row = RECEIPTS.read(request, session())?;
    if row["operation"] != "device_transfer" {
        return Err("REQUEST_ID_CONFLICT: transfer belongs to another operation or source".into());
    }
    Ok(row)
}
pub(crate) async fn receipt(args: &Value) -> Result<Option<Value>> {
    let request = string(args, "requestId");
    let path = RECEIPTS.path(request)?;
    if !path.exists() || load(&path)?["operation"] != "device_transfer" {
        return Ok(None);
    }
    let mut args = args.clone();
    args["action"] = json!(args["action"].as_str().unwrap_or("read"));
    if args["action"] != "read" {
        return Err("INVALID_ARGUMENT: use device_transfer action:cancel or action:resume".into());
    }
    Ok(Some(read(request)?))
}
pub(crate) async fn call(controller: Arc<controller::Controller>, args: Value) -> Result<Value> {
    if !enabled() {
        return Err(unavailable());
    }
    let action = args["action"].as_str().unwrap_or("start");
    let request = args["requestId"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(id);
    uuid::Uuid::parse_str(&request).map_err(|_| "INVALID_REQUEST_ID: requestId must be a UUID")?;
    let _guard = RequestLocks.lock(&request).await;
    if ReceiptStore::new("agents/requests")
        .path(&request)?
        .exists()
    {
        return Err("REQUEST_ID_CONFLICT: requestId belongs to another operation".into());
    }
    let previous = if RECEIPTS.path(&request)?.exists() {
        Some(read(&request)?)
    } else {
        None
    };
    if action == "read" {
        return previous.ok_or_else(|| "RECEIPT_NOT_FOUND".into());
    }
    if previous.as_ref().is_some_and(|row| {
        row["origin"]["sourceId"] != crate::kernel::origin::current_origin()["sourceId"]
    }) {
        return Err("REQUEST_ID_CONFLICT: transfer mutation belongs to another source".into());
    }
    let mut admitted = None;
    let mut row = if let Some(row) = previous {
        if action == "start" {
            let mut plan = args.clone();
            for key in ["requestId", "waitMs", "action"] {
                plan.as_object_mut().unwrap().remove(key);
            }
            if row["plan"] != plan {
                return Err(
                    "REQUEST_ID_CONFLICT: transfer parameters differ; read the original receipt"
                        .into(),
                );
            }
            return Ok(row);
        }
        row
    } else {
        if action != "start" {
            return Err("RECEIPT_NOT_FOUND".into());
        }
        let from_device = args["from"]["device"].as_str();
        let to_device = args["to"]["device"].as_str();
        if from_device.is_some() == to_device.is_some() {
            return Err("INVALID_ARGUMENT: exactly one side must name a member device".into());
        }
        for side in ["from", "to"] {
            if string(&args[side], "path").is_empty() {
                return Err("INVALID_PATH: both endpoints require a path".into());
            }
        }
        // Liveness is checked before receipt reservation and before any file bytes.
        let (device, link, slot) = controller
            .admit_transfer(from_device.or(to_device).unwrap())
            .await?;
        admitted = Some((link, slot));
        let mut plan = args.clone();
        for key in ["requestId", "waitMs", "action"] {
            plan.as_object_mut().unwrap().remove(key);
        }
        let mut row = json!({"requestId":request,"operation":"device_transfer","state":"reserved","backendSession":session(),"origin":crate::kernel::origin::current_origin(),"createdAt":now(),"plan":plan,"device":device,"progress":{"bytes":0,"total":null,"path":args["to"]["path"],"rate":0},"next":next(&request)});
        RECEIPTS.reserve(&row)?;
        RECEIPTS.checkpoint(&mut row)?;
        row
    };
    if action == "cancel" {
        if row["state"] == "completed" || row["state"] == "cancelled" {
            return Ok(row);
        }
        if let Some(job) = jobs().lock().await.remove(&request) {
            job.abort();
            let _ = job.await;
        }
        let cleanup = if row["plan"]["to"]["device"].is_string() {
            match controller.transfer_link(string(&row, "device")).await {
                Ok((_, link)) => {
                    link.control(json!({"action":"cancel","requestId":request}))
                        .await
                }
                Err(e) => Err(e),
            }
        } else {
            let store = receiver::Store::default();
            match store
                .get(&root().join("device-link/transfer-receivers"), &request)
                .await
            {
                Ok(entry) => entry.lock().await.cancel(),
                Err(e) => {
                    if !root()
                        .join("device-link/transfer-receivers")
                        .join(format!("{request}.json"))
                        .exists()
                    {
                        Ok(json!({"state":"cancelled"}))
                    } else {
                        Err(e)
                    }
                }
            }
        };
        let meta = match cleanup {
            Ok(meta) => meta,
            Err(error) => {
                row["state"] = json!("failed");
                row["error"] = json!({"code":"TRANSFER_CANCEL_PENDING","message":error});
                RECEIPTS.checkpoint(&mut row)?;
                return Ok(row);
            }
        };
        row["state"] = json!(if meta["state"] == "completed" {
            "completed"
        } else {
            "cancelled"
        });
        if meta["state"] == "completed" {
            row["progress"]["bytes"] = meta["offset"].clone();
            row["result"] =
                json!({"path":meta["path"],"sizeBytes":meta["offset"],"sha256":meta["sha256"]});
        }
        row["error"] = Value::Null;
        RECEIPTS.checkpoint(&mut row)?;
        return Ok(row);
    }
    if !matches!(action, "start" | "resume") {
        return Err("INVALID_ARGUMENT: use start, read, resume or cancel".into());
    }
    if row["state"] == "completed" || row["state"] == "cancelled" {
        return Ok(row);
    }
    let mut active = jobs().lock().await;
    active.retain(|_, job| !job.is_finished());
    if active.contains_key(&request) {
        return Ok(row);
    }
    let (mut link, slot) = match admitted {
        Some(admitted) => admitted,
        None => {
            let (_, link, slot) = controller.admit_transfer(string(&row, "device")).await?;
            (link, slot)
        }
    };
    row["state"] = json!("reserved");
    row["backendSession"] = json!(session());
    row["error"] = Value::Null;
    let owner = RECEIPTS.begin(&mut row)?;
    let origin = crate::kernel::origin::current_origin();
    let mut worker_row = row.clone();
    let task=tokio::spawn(crate::kernel::origin::ORIGIN.scope(origin,async move {
        let _owner=owner;
        let _slot=slot;
        let result=run(&controller,&mut link,&mut worker_row).await;
        match result {
            Ok(result)=>{worker_row["state"]=json!("completed");worker_row["result"]=json!({"path":result["path"],"sizeBytes":result["offset"],"sha256":result["sha256"]});},
            Err(error)=>{worker_row["state"]=json!("failed");worker_row["error"]=failure(&error);worker_row["resume"]=json!({"via":"act","op":"device_transfer","args":{"action":"resume","requestId":worker_row["requestId"]}});},
        }
        if let Err(error)=RECEIPTS.checkpoint(&mut worker_row){crate::logs::record("ERROR",&error,None);}
    }));
    active.insert(request.clone(), task);
    drop(active);
    // Long operations return their normal receipt immediately; callers read it while running.
    Ok(row)
}
async fn run(
    controller: &controller::Controller,
    link: &mut wire::Link,
    row: &mut Value,
) -> Result<Value> {
    controller
        .refresh_transfer_link(string(row, "device"), link)
        .await?;
    let request = string(row, "requestId").to_owned();
    let plan = row["plan"].clone();
    let upload = plan["to"]["device"].is_string();
    let source = string(&plan["from"], "path");
    let local_source = if upload {
        Some(receiver::resolve(source)?)
    } else {
        None
    };
    let stamp = if let Some(path) = &local_source {
        receiver::fingerprint(path)?
    } else {
        link.control(json!({"action":"stat","path":source})).await?
    };
    if row["fingerprint"].is_object() && row["fingerprint"] != stamp {
        return Err("SOURCE_CHANGED: use a new requestId".into());
    }
    row["fingerprint"] = stamp.clone();
    let total = stamp["total"]
        .as_u64()
        .ok_or("INVALID_ARGUMENT: source length unavailable")?;
    row["progress"]["total"] = json!(total);
    RECEIPTS.checkpoint(row)?;
    let spec = json!({"path":plan["to"]["path"],"total":total,"overwrite":plan["overwrite"]==true,"expectedSha256":plan["expectedSha256"],"source":stamp,"from":plan["from"]});
    let store = receiver::Store::default();
    let directory = root().join("device-link/transfer-receivers");
    controller
        .refresh_transfer_link(string(row, "device"), link)
        .await?;
    let meta = if upload {
        link.control(json!({"action":"begin","requestId":request,"spec":spec}))
            .await?
    } else {
        store.begin(&directory, &request, spec).await?
    };
    if meta["state"] == "completed" {
        row["progress"]["bytes"] = json!(total);
        return Ok(meta);
    }
    if meta["state"] != "receiving" {
        return Err("TRANSFER_TERMINAL: receiver cannot resume".into());
    }
    let mut offset = meta["offset"].as_u64().ok_or("OFFSET_MISMATCH")?;
    let started = Instant::now();
    let mut checkpoint_at = Instant::now();
    let initial = offset;
    while offset < total {
        controller
            .refresh_transfer_link(string(row, "device"), link)
            .await?;
        let length = (total - offset).min(link.range());
        if let Some(path) = &local_source {
            if receiver::fingerprint(path)? != stamp {
                return Err("SOURCE_CHANGED: source changed during transfer".into());
            }
            let response = link.upload(&request, path, offset, length).await?;
            if response["offset"] != offset + length {
                return Err("OFFSET_MISMATCH: receiver acknowledgement differs".into());
            }
        } else {
            let entry = store.get(&directory, &request).await?;
            let mut receiver = entry.lock().await;
            link.download(&request, source, &stamp, &mut receiver, length)
                .await?;
        }
        offset += length;
        #[cfg(test)]
        pause_at_range_fixture(&request).await;
        row["progress"]["bytes"] = json!(offset);
        row["progress"]["rate"] = json!(
            ((offset - initial) as f64 / started.elapsed().as_secs_f64().max(0.000001)) as u64
        );
        if offset == total || checkpoint_at.elapsed() >= Duration::from_millis(250) {
            RECEIPTS.checkpoint(row)?;
            checkpoint_at = Instant::now();
        }
    }
    controller
        .refresh_transfer_link(string(row, "device"), link)
        .await?;
    let final_stamp = if let Some(path) = &local_source {
        receiver::fingerprint(path)?
    } else {
        link.control(json!({"action":"stat","path":source})).await?
    };
    if final_stamp != stamp {
        return Err("SOURCE_CHANGED: source changed during transfer".into());
    }
    controller
        .refresh_transfer_link(string(row, "device"), link)
        .await?;
    if upload {
        link.control(json!({"action":"commit","requestId":request}))
            .await
    } else {
        let entry = store.get(&directory, &request).await?;
        let mut receiver = entry.lock().await;
        receiver.commit()
    }
}

#[cfg(test)]
pub(super) async fn interrupt_fixture(request: &str) {
    if let Some(job) = jobs().lock().await.remove(request) {
        job.abort();
        let _ = job.await;
    }
}

#[cfg(test)]
fn pause_slot() -> &'static StdMutex<Option<(String, Arc<Notify>)>> {
    static SLOT: OnceLock<StdMutex<Option<(String, Arc<Notify>)>>> = OnceLock::new();
    SLOT.get_or_init(Default::default)
}
#[cfg(test)]
pub(super) fn pause_after_range_fixture(request: &str) -> Arc<Notify> {
    let ready = Arc::new(Notify::new());
    *pause_slot().lock().unwrap() = Some((request.into(), ready.clone()));
    ready
}
#[cfg(test)]
async fn pause_at_range_fixture(request: &str) {
    let pause = {
        let mut slot = pause_slot().lock().unwrap();
        if slot.as_ref().is_some_and(|(id, _)| id == request) {
            slot.take()
        } else {
            None
        }
    };
    if let Some((_, ready)) = pause {
        ready.notify_one();
        std::future::pending::<()>().await;
    }
}
