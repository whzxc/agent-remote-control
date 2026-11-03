//! Durable operation receipts. Owners retain execution and task lifecycle semantics.
use super::file_cache::load;
use crate::*;

pub struct ReceiptStore {
    directory: &'static str,
}
impl ReceiptStore {
    pub const fn new(directory: &'static str) -> Self {
        Self { directory }
    }
    pub fn path(&self, request: &str) -> Result<PathBuf> {
        uuid::Uuid::parse_str(request).map_err(|_| "INVALID_REQUEST_ID")?;
        Ok(root().join(self.directory).join(format!("{request}.json")))
    }
    pub fn read(&self, request: &str, session: &str) -> Result<Value> {
        Self::normalize(load(&self.path(request)?)?, session)
    }
    /// Bulk task projections retain their own metadata snapshot, not full receipt
    /// payloads in the shared JSON cache.
    pub fn read_for_projection(&self, request: &str, session: &str) -> Result<Value> {
        Self::normalize(crate::load(&self.path(request)?)?, session)
    }
    fn normalize(mut receipt: Value, session: &str) -> Result<Value> {
        if !receipt.is_object() {
            return Err("INVALID_RECEIPT".into());
        }
        if receipt["backendSession"] != session
            && !matches!(
                string(&receipt, "state"),
                "completed"
                    | "failed"
                    | "rejected"
                    | "not-executed"
                    | "unconfirmed"
                    | "awaiting-approval"
            )
        {
            receipt["previousState"] = receipt["state"].clone();
            receipt["state"] = json!("unconfirmed");
            crate::coordination::observers::unconfirmed(&receipt);
        }
        // Labels belong to the response boundary. A task/status poll reads many
        // receipts; resolving accounts here repeats a store scan for every row.
        Ok(receipt)
    }
    // Callers serialize replay/reserve/launch per request ID. create_new also
    // prevents a second owner from reserving an existing ID; unknown writes are never replayed.
    pub fn replay(&self, request: &str, digest: &str, session: &str) -> Result<Option<Value>> {
        let other = if self.directory.is_empty() {
            "agents/requests"
        } else {
            ""
        };
        if ReceiptStore::new(other).path(request)?.exists() {
            return Err("REQUEST_ID_CONFLICT".into());
        }
        if !self.path(request)?.exists() {
            return Ok(None);
        }
        let mut receipt = self.read(request, session)?;
        if receipt["origin"]["sourceId"] != crate::kernel::origin::current_origin()["sourceId"]
            || receipt["digest"] != digest
        {
            return Err("REQUEST_ID_CONFLICT".into());
        }
        receipt["replayed"] = json!(true);
        Ok(Some(receipt))
    }
    pub fn reserve(&self, receipt: &Value) -> Result<()> {
        use std::io::Write;
        let path = self.path(string(receipt, "requestId"))?;
        let parent = path.parent().ok_or("INVALID_RECEIPT_PATH")?;
        let before = super::file_cache::Stamp::read(parent)?;
        private_dir(parent)?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|e| format!("RECEIPT_RESERVATION_FAILED:{e}"))?;
        file.write_all(receipt.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        super::file_cache::changed(&path, before);
        crate::coordination::observers::watch_receipt(&path);
        Ok(())
    }
    pub fn checkpoint(&self, receipt: &mut Value) -> Result<()> {
        receipt["updatedAt"] = json!(now());
        crate::coordination::observers::save_owner(
            &self.path(string(receipt, "requestId"))?,
            receipt,
            crate::coordination::observers::Owner::Receipt,
        )
    }
}

/// Only the lookup holds the map lock; independent requests can perform disk IO concurrently.
#[derive(Default)]
pub struct RequestLocks;
impl RequestLocks {
    pub async fn lock(&self, request: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            // All execution owners share UUID reservations, while retaining their own records.
            static LOCKS: std::sync::OnceLock<
                Mutex<std::collections::HashMap<String, std::sync::Weak<Mutex<()>>>>,
            > = std::sync::OnceLock::new();
            let mut locks = LOCKS.get_or_init(Default::default).lock().await;
            locks.retain(|_, v| v.strong_count() > 0);
            if let Some(lock) = locks.get(request).and_then(std::sync::Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(Mutex::new(()));
                locks.insert(request.into(), Arc::downgrade(&lock));
                lock
            }
        };
        lock.lock_owned().await
    }
}
pub fn failure_state(error: &str) -> &'static str {
    if error.starts_with("SUBMISSION_UNCONFIRMED:") {
        "unconfirmed"
    } else if error.starts_with("RPC_REJECTED") || error.starts_with("DESKTOP_REJECTED") {
        "rejected"
    } else {
        "failed"
    }
}
