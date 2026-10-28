//! Durable admission queue for dispatches held by a settling update.
use crate::*;
static LOCK: Mutex<()> = Mutex::const_new(());
fn path(id: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(id).map_err(|_| "INVALID_REQUEST_ID")?;
    Ok(root().join("update-queue").join(format!("{id}.json")))
}
fn public(row: &Value) -> Value {
    json!({"requestId":row["requestId"],"state":row["state"],"operation":row["operation"],"heldForUpdate":true,
        "message":"Dispatch held for the update. It starts after the terminal outcome.","next":{"op":"receipt","args":{"requestId":row["requestId"]}}})
}
pub(crate) async fn hold(name: &str, args: &mut Value, policy: &Value) -> Result<Option<Value>> {
    if !matches!(
        name,
        "codex_create" | "codex_send" | "codex_resume" | "agent_create" | "agent_send"
    ) && !(name == "codex_call"
        && matches!(
            string(args, "method"),
            "thread/start" | "turn/start" | "turn/steer"
        ))
    {
        return Ok(None);
    }
    if crate::app_replace::continuation_context(name, args)?.is_some() {
        return Ok(None);
    }
    if args["requestId"].is_null() {
        args["requestId"] = json!(id());
    }
    let _guard = LOCK.lock().await;
    let file = path(string(args, "requestId"))?;
    let origin = crate::kernel::origin::current_origin();
    let mut payload = args.clone();
    payload.as_object_mut().unwrap().remove("waitMs");
    let digest = hash(json!([name, payload, origin["sourceId"]]).to_string());
    if file.exists() {
        let row = load(&file)?;
        if row["digest"] != digest {
            return Err("REQUEST_ID_CONFLICT".into());
        }
        return Ok(if row["state"] == "held" {
            Some(public(&row))
        } else {
            None
        });
    }
    if crate::app_replace::check_dispatch().is_ok() {
        return Ok(None);
    }
    let spec = catalog()["ops"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == name)
        .unwrap();
    crate::egress::validate_op(spec, args)?;
    if crate::kernel::receipts::ReceiptStore::new("")
        .path(string(args, "requestId"))?
        .exists()
        || crate::kernel::receipts::ReceiptStore::new("agents/requests")
            .path(string(args, "requestId"))?
            .exists()
    {
        return Ok(None);
    }
    let mut row = json!({"requestId":args["requestId"],"state":"held","operation":name,"args":args,"policy":policy,"origin":origin,"digest":digest,"createdAt":now()});
    crate::dispatch_caller::attach_current(&mut row);
    save(&file, &row)?;
    Ok(Some(public(&row)))
}
pub(crate) async fn receipt(args: &Value) -> Result<Option<Value>> {
    let _guard = LOCK.lock().await;
    let file = path(string(args, "requestId"))?;
    if !file.exists() {
        return Ok(None);
    }
    let row = load(&file)?;
    let origin = crate::kernel::origin::current_origin();
    if origin["authType"] != "local" && origin["sourceId"] != row["origin"]["sourceId"] {
        return Err("REQUEST_NOT_FOUND".into());
    }
    Ok(if row["state"] == "held" {
        Some(public(&row))
    } else if row["state"] == "failed" {
        Some(row["result"].clone())
    } else {
        None
    })
}
pub(crate) fn start(execution: &Arc<crate::execution::Execution>) {
    let weak = Arc::downgrade(execution);
    tokio::spawn(async move {
        loop {
            let Some(execution) = weak.upgrade() else {
                break;
            };
            if crate::app_replace::check_dispatch().is_ok() {
                let entries = std::fs::read_dir(root().join("update-queue"));
                let mut rows: Vec<_> = entries
                    .into_iter()
                    .flatten()
                    .flatten()
                    .filter_map(|e| load(&e.path()).ok())
                    .filter(|r| r["state"] == "held")
                    .collect();
                rows.sort_by_key(|r| string(r, "createdAt").to_owned());
                for mut row in rows {
                    if crate::app_replace::check_dispatch().is_err() {
                        break;
                    }
                    let result = crate::kernel::origin::ORIGIN
                        .scope(
                            row["origin"].clone(),
                            crate::dispatch_caller::CALLER.scope(
                                crate::dispatch_caller::validated(&row["caller"]),
                                execution.call_inner(
                                    string(&row, "operation"),
                                    row["args"].clone(),
                                    row["policy"].clone(),
                                ),
                            ),
                        )
                        .await;
                    match result {
                        Ok(value) => {
                            row["state"] = json!("released");
                            row["result"] = value;
                        }
                        Err(error) if error.starts_with("REPLACE_PENDING") => continue,
                        Err(error) => {
                            row["state"] = json!("failed");
                            row["result"] = json!({"requestId":row["requestId"],"state":"failed","error":crate::egress::failure(&error)});
                        }
                    }
                    if let Ok(file) = path(string(&row, "requestId")) {
                        let _ = save(&file, &row);
                    }
                    // Owner receipts reserve the same ID before execution. A crash safely
                    // replays that reservation, never generates a second dispatch identity.
                }
            }
            drop(execution);
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
}
