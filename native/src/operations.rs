//! Durable management receipts. An interrupted write is unconfirmed, never replayed automatically.
use crate::*;
fn path(id: &str) -> Result<PathBuf> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    {
        return Err("invalid requestId".into());
    }
    Ok(root().join("operations").join(format!("{id}.json")))
}
pub fn read(id: &str, instance: &str) -> Result<Value> {
    let file = path(id)?;
    let mut receipt = load(&file)?;
    // Replace the retired management success spelling in the owning record once.
    if receipt["state"] == "succeeded" {
        receipt["state"] = json!("completed");
        save(&file, &receipt)?;
    }
    Ok(project(
        receipt,
        instance,
        chrono::Utc::now().timestamp_millis(),
    ))
}

pub fn project(receipt: Value, instance: &str, time_ms: i64) -> Value {
    let owner_live = receipt["instance"] == instance;
    let mut receipt = crate::kernel::receipts::progress::project(receipt, owner_live, time_ms);
    if receipt["state"] == "unconfirmed" {
        receipt["next"] = json!({"operation":"operations.get","arguments":{"id":receipt["requestId"]}});
        receipt.as_object_mut().unwrap().remove("nextAction");
    }
    receipt
}

pub fn submit(body: Value, instance: String) -> Result<Value> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let request = string(&body, "requestId");
    let file = path(request)?;
    let operation = string(&body, "operation").to_owned();
    if operation.starts_with("operations.")
        || [
            "app.start",
            "ingress.token",
            "ingress.credentials",
            "ingress.oauth.register",
        ]
        .contains(&operation.as_str())
    {
        return Err("operation cannot be submitted".into());
    }
    let args = body.get("arguments").cloned().unwrap_or(json!({}));
    crate::management::resolve(&operation, &args)?;
    let fingerprint = hash(body.to_string());
    if file.exists() {
        let receipt = read(request, &instance)?;
        if receipt["fingerprint"] != fingerprint {
            return Err("REQUEST_ID_CONFLICT".into());
        }
        return Ok(receipt);
    }
    private_dir(file.parent().unwrap())?;
    let receipt = json!({"requestId":request,"operation":operation,"state":"reserved","startedAt":now(),"instance":instance,"fingerprint":fingerprint});
    save(&file, &receipt)?;
    let response = project(receipt.clone(), &instance, chrono::Utc::now().timestamp_millis());
    let mut result = receipt;
    tokio::spawn(async move {
        result["state"] = json!("executing");
        result["updatedAt"] = json!(now());
        let outcome = match save(&file, &result) {
            Ok(()) => crate::management::call(&operation, args).await,
            Err(error) => Err(error),
        };
        result["completedAt"] = json!(now());
        match outcome {
            Ok(value) => {
                result["effectConfirmed"] =
                    json!(value["accepted"] != true && value["restarting"] != true);
                result["state"] = json!("completed");
                result["nextAction"]=json!("Read the affected resource. Secret-bearing operation outputs are never persisted in receipts.");
            }
            Err(error) => {
                result["state"] = json!(crate::kernel::receipts::failure_state(&error));
                result["error"] = json!(error);
            }
        }
        if let Err(error) = save(&file, &result) {
            crate::logs::record(
                "ERROR",
                &format!("Cannot save operation receipt: {error}"),
                None,
            );
        }
    });
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn management_writes_share_execution_and_lost_submission_progress() {
        // Regression: management writes used running/succeeded and suggested a new submission after Core loss.
        let row = json!({"requestId":"original-management-request","operation":"settings.patch","instance":"owner","state":"executing","startedAt":"2000-01-01T00:00:00Z","nextAction":"old recovery"});
        for elapsed in [45_000, 300_000, 3_600_000] {
            let live = project(row.clone(), "owner", 946_684_800_000 + elapsed);
            assert_eq!(live["state"], "executing");
            assert_eq!(live["progressStalled"], false);
            let lost = project(row.clone(), "new-owner", 946_684_800_000 + elapsed);
            assert_eq!(lost["state"], "unconfirmed");
            assert_eq!(lost["next"]["operation"], "operations.get");
            assert_eq!(lost["next"]["arguments"]["id"], row["requestId"]);
            assert!(lost.get("nextAction").is_none());
        }
        let mut completed = row;
        completed["state"] = json!("completed");
        assert_eq!(
            project(completed, "new-owner", 946_684_800_000)["state"],
            "completed"
        );
    }
}
