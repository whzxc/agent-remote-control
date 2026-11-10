//! Durable operation receipts. Owners retain execution and task lifecycle semantics.
use super::file_cache::load;
use crate::*;
mod projection;
pub mod progress;

pub struct ReceiptStore {
    directory: &'static str,
    #[cfg(test)]
    base: Option<PathBuf>,
}
/// Keeps a failed or cancelled execution owner from leaving a live phase behind.
#[must_use = "Keep the execution owner alive until its outcome is checkpointed."]
pub struct ExecutionOwner<'a> {
    store: &'a ReceiptStore,
    request: String,
}
impl Drop for ExecutionOwner<'_> {
    fn drop(&mut self) {
        if let Err(error) = self.store.abandon(&self.request) {
            crate::logs::record(
                "ERROR",
                &format!("Cannot record receipt owner loss: {error}"),
                None,
            );
        }
    }
}

impl ReceiptStore {
    #[cfg(test)]
    pub(crate) fn fixture(base: PathBuf) -> Self {
        Self {
            directory: "",
            base: Some(base),
        }
    }
    pub const fn new(directory: &'static str) -> Self {
        Self {
            directory,
            #[cfg(test)]
            base: None,
        }
    }
    pub fn path(&self, request: &str) -> Result<PathBuf> {
        uuid::Uuid::parse_str(request).map_err(|_| "INVALID_REQUEST_ID")?;
        #[cfg(test)]
        if let Some(base) = &self.base {
            return Ok(base.join(format!("{request}.json")));
        }
        Ok(root().join(self.directory).join(format!("{request}.json")))
    }
    pub fn read(&self, request: &str, session: &str) -> Result<Value> {
        Self::normalize(load(&self.path(request)?)?, session)
    }
    pub(crate) fn seed(&self) -> Result<()> {
        let path = self.path(&uuid::Uuid::nil().to_string())?;
        projection::seed(path.parent().unwrap())
    }
    /// Derived summaries remain resident independently of full receipt payload sizes.
    pub fn read_for_projection(&self, request: &str, session: &str) -> Result<Value> {
        crate::runtime_metrics::cost::sync(
            crate::runtime_metrics::cost::Owner::ReceiptProjection,
            crate::runtime_metrics::cost::Reason::Poll,
            || {
                let path = self.path(request)?;
                let row = projection::read(&path)?;
                Self::normalize(row, session)
            },
        )
    }
    pub(crate) fn projection_updates(
        &self,
        revision: Option<u64>,
        session: &str,
    ) -> Result<(u64, bool, Vec<(String, Option<Value>)>)> {
        let directory = self
            .path(&uuid::Uuid::nil().to_string())?
            .parent()
            .unwrap()
            .to_owned();
        crate::runtime_metrics::cost::sync(
            crate::runtime_metrics::cost::Owner::ReceiptProjection,
            crate::runtime_metrics::cost::Reason::Poll,
            || {
                let (revision, reset, rows) = projection::updates(&directory, revision)?;
                Ok((
                    revision,
                    reset,
                    rows.into_iter()
                        .map(|(key, row)| {
                            Ok((
                                key,
                                row.map(|row| Self::normalize(row, session)).transpose()?,
                            ))
                        })
                        .collect::<Result<_>>()?,
                ))
            },
        )
    }
    fn normalize(mut receipt: Value, session: &str) -> Result<Value> {
        if !receipt.is_object() {
            return Err("INVALID_RECEIPT".into());
        }
        let previous = receipt["state"].clone();
        let owner_live = receipt["backendSession"] == session;
        receipt = progress::project(receipt, owner_live, chrono::Utc::now().timestamp_millis());
        if receipt["state"] == "unconfirmed" && previous != "unconfirmed" {
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
        super::derived_index::change(&path, || {
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
            Ok(((), Some(projection::summary(receipt.clone())?)))
        })
    }
    /// The local execution owner has accepted the operation. Turn completion is separate.
    pub fn begin(&self, receipt: &mut Value) -> Result<ExecutionOwner<'_>> {
        receipt["state"] = json!("executing");
        self.checkpoint(receipt)?;
        Ok(ExecutionOwner {
            store: self,
            request: string(receipt, "requestId").into(),
        })
    }
    pub fn abandon(&self, request: &str) -> Result<()> {
        let path = self.path(request)?;
        let receipt = load(&path)?;
        if progress::Progress::read(string(&receipt, "state"), true).active() {
            let mut receipt =
                progress::project(receipt, false, chrono::Utc::now().timestamp_millis());
            self.checkpoint(&mut receipt)?;
        }
        Ok(())
    }
    pub async fn wait(
        &self,
        request: &str,
        session: &str,
        wait_ms: u64,
        response: tokio::sync::oneshot::Receiver<Result<Value>>,
    ) -> Result<Value> {
        match tokio::time::timeout(std::time::Duration::from_millis(wait_ms), response).await {
            Ok(Ok(result)) => result,
            Err(_) => self.read(request, session),
            Ok(Err(_)) => {
                self.abandon(request)?;
                self.read(request, session)
            }
        }
    }
    pub fn checkpoint(&self, receipt: &mut Value) -> Result<()> {
        for field in [
            "submissionState",
            "executionState",
            "progressStalled",
            "phaseAgeMs",
        ] {
            receipt.as_object_mut().unwrap().remove(field);
        }
        let path = self.path(string(receipt, "requestId"))?;
        if let Ok(previous) = load(&path) {
            let mut old = previous.clone();
            let mut next = receipt.clone();
            for value in [&mut old, &mut next] {
                if let Some(object) = value.as_object_mut() {
                    object.remove("updatedAt");
                    object.remove("coordinationPending");
                }
            }
            if old == next {
                *receipt = previous;
                return Ok(());
            }
        }
        receipt["updatedAt"] = json!(now());
        super::derived_index::change(&path, || {
            crate::coordination::observers::save_owner(
                &path,
                receipt,
                crate::coordination::observers::Owner::Receipt,
            )?;
            Ok(((), Some(projection::summary(receipt.clone())?)))
        })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::task_projection::TaskProjection;
    use crate::runtime_metrics::cost::{self, Owner, Reason};
    struct Sandbox {
        dir: PathBuf,
        store: ReceiptStore,
    }
    impl Sandbox {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("arc-receipt-index-{}", id()));
            Self {
                store: ReceiptStore {
                    directory: "",
                    base: Some(dir.clone()),
                },
                dir,
            }
        }
        fn receipt(&self, completed: bool) -> Value {
            let row = json!({"requestId":id(),"operation":"create","state":if completed {"completed"} else {"executing"},"backendSession":"fixture-session","createdAt":"2000-01-01T00:00:00Z","result":{"thread":{"id":"fixture-thread","name":"fixture","cwd":"/fixture"}}});
            self.store.reserve(&row).unwrap();
            row
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            projection::forget(&self.dir);
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    fn delta(before: &Value, after: &Value, owner: &str, key: &str) -> u64 {
        after["cost"][owner][key].as_u64().unwrap() - before["cost"][owner][key].as_u64().unwrap()
    }
    fn poll(projection: &mut TaskProjection, store: &ReceiptStore) -> Arc<Vec<Value>> {
        cost::sync(Owner::TaskRecords, Reason::Poll, || {
            projection
                .update(
                    store,
                    "fixture-session",
                    |_| Vec::new(),
                    |row| Ok(Some(row)),
                )
                .unwrap()
        })
    }
    #[tokio::test(start_paused = true)]
    async fn receipt_wait_returns_execution_progress_instead_of_a_pending_snapshot() {
        // Regression: AX-07 Control timeout and Agent waits returned pending snapshots after the execution owner had accepted the operation.
        let fixture = Sandbox::new();
        for operation in [
            "command",
            "create",
            "send",
            "agent_create",
            "agent_send",
            "write",
            "fs",
            "notice_post",
            "ax_report",
            "message_send",
        ] {
            let mut row = json!({"requestId":id(),"operation":operation,"state":"reserved","backendSession":"fixture-session","createdAt":"2000-01-01T00:00:00Z"});
            fixture.store.reserve(&row).unwrap();
            let _owner = fixture.store.begin(&mut row).unwrap();
            let (_sender, receiver) = tokio::sync::oneshot::channel();
            let read = fixture
                .store
                .wait(
                    string(&row, "requestId"),
                    "fixture-session",
                    45_000,
                    receiver,
                )
                .await
                .unwrap();
            assert_eq!(read["state"], "executing");
            assert_eq!(read["progressStalled"], false);
            assert_eq!(read["requestId"], row["requestId"]);
            let projected = fixture
                .store
                .read_for_projection(string(&row, "requestId"), "fixture-session")
                .unwrap();
            assert_eq!(projected["state"], read["state"]);
            assert_eq!(projected["submissionState"], "submitted");
        }
    }

    #[tokio::test]
    async fn lost_execution_owner_retains_the_original_receipt_across_reads() {
        // Regression: interrupted submission retained pending or task recovery advice instead of the original unconfirmed receipt.
        let fixture = Sandbox::new();
        let mut row = json!({"requestId":id(),"operation":"agent_send","taskId":"fixture-task","state":"reserved","backendSession":"fixture-session","createdAt":"2000-01-01T00:00:00Z"});
        fixture.store.reserve(&row).unwrap();
        let request = string(&row, "requestId").to_owned();
        let restarted = fixture.store.read(&request, "new-session").unwrap();
        assert_eq!(restarted["state"], "unconfirmed");
        assert_eq!(restarted["requestId"], request);
        let _owner = fixture.store.begin(&mut row).unwrap();
        drop(_owner);
        assert_eq!(fixture.store.read(&request, "fixture-session").unwrap()["state"], "unconfirmed");
        let _owner = fixture.store.begin(&mut row).unwrap();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        drop(sender);
        let lost = fixture
            .store
            .wait(&request, "fixture-session", 45_000, receiver)
            .await
            .unwrap();
        let mut public = crate::egress::receipt(lost);
        crate::egress::next(&mut public, "receipt", &json!({"requestId":request}), false);
        assert_eq!(public["state"], "unconfirmed");
        assert_eq!(public["progressStalled"], false);
        assert_eq!(public["next"]["op"], "receipt");
        assert_eq!(
            public["next"]["args"],
            json!({"requestId":request,"action":"read"})
        );
        assert_eq!(
            fixture
                .store
                .read_for_projection(&request, "fixture-session")
                .unwrap()["state"],
            "unconfirmed"
        );
        row["state"] = json!("completed");
        fixture.store.checkpoint(&mut row).unwrap();
        assert_eq!(
            fixture.store.read(&request, "new-session").unwrap()["state"],
            "completed"
        );
    }

    #[tokio::test]
    async fn receipt_and_task_polls_read_only_changed_summaries_after_warmup() {
        // Regression: task-record invalidations revisited every retained receipt and could evict unchanged summaries by payload size.
        let control = control::Control::new(PathBuf::new());
        let mut counts = Vec::new();
        for history in [4, 40] {
            let fixture = Sandbox::new();
            for _ in 0..history {
                fixture.receipt(true);
            }
            let mut active = fixture.receipt(false);
            let before_seed = control.tool("runtime_metrics", json!({})).await.unwrap();
            fixture.store.seed().unwrap();
            let seeded = control.tool("runtime_metrics", json!({})).await.unwrap();
            assert_eq!(
                delta(&before_seed, &seeded, "receiptSeed", "rowsVisited"),
                history + 1
            );
            let mut projection = TaskProjection::default();
            assert_eq!(
                poll(&mut projection, &fixture.store).len() as u64,
                history + 1
            );
            let before_idle = control.tool("runtime_metrics", json!({})).await.unwrap();
            assert_eq!(
                poll(&mut projection, &fixture.store).len() as u64,
                history + 1
            );
            let idle = control.tool("runtime_metrics", json!({})).await.unwrap();
            for owner in ["receiptProjection", "taskRecords"] {
                assert_eq!(delta(&before_idle, &idle, owner, "rowsVisited"), 0);
                assert_eq!(delta(&before_idle, &idle, owner, "bytesParsed"), 0);
            }
            active["state"] = json!("completed");
            fixture.store.checkpoint(&mut active).unwrap();
            let before = control.tool("runtime_metrics", json!({})).await.unwrap();
            let rows = poll(&mut projection, &fixture.store);
            assert_eq!(
                rows.iter()
                    .find(|r| r["requestId"] == active["requestId"])
                    .unwrap()["state"],
                "completed"
            );
            let after = control.tool("runtime_metrics", json!({})).await.unwrap();
            let cost = (
                delta(&before, &after, "receiptProjection", "rowsVisited"),
                delta(&before, &after, "receiptProjection", "bytesParsed"),
                delta(&before, &after, "taskRecords", "rowsVisited"),
            );
            println!("receipt-index history={history} changed=1 receiptRows={} parsed={} taskRows={} idleRows=0", cost.0,cost.1,cost.2);
            counts.push(cost);
            projection::forget(&fixture.dir);
            assert_eq!(
                fixture
                    .store
                    .read_for_projection(string(&active, "requestId"), "new-session")
                    .unwrap()["state"],
                "completed"
            );
            assert_eq!(
                fixture
                    .store
                    .read(string(&active, "requestId"), "new-session")
                    .unwrap()["state"],
                "completed"
            );
        }
        assert_eq!(counts[0], counts[1]);
        assert_eq!(counts[0].2, 1);
    }
    #[tokio::test]
    async fn restart_adopts_receipts_and_repairs_only_the_interrupted_key() {
        // Regression: D2b reparsed every retained receipt at each Core restart and lost an interrupted projection update.
        let control = control::Control::new(PathBuf::new());
        for history in [4, 40] {
            let fixture = Sandbox::new();
            for _ in 0..history {
                let row = json!({"requestId":id(),"state":"completed","backendSession":"fixture-session","result":{"payload":"x".repeat(8192)}});
                fixture.store.reserve(&row).unwrap();
            }
            let mut active = fixture.receipt(false);
            let before = control.tool("runtime_metrics", json!({})).await.unwrap();
            fixture.store.seed().unwrap();
            let cold = control.tool("runtime_metrics", json!({})).await.unwrap();
            projection::forget(&fixture.dir);
            fixture.store.seed().unwrap();
            let adopted = control.tool("runtime_metrics", json!({})).await.unwrap();
            assert_eq!(delta(&cold, &adopted, "receiptSeed", "bytesParsed"), 0);
            assert_eq!(delta(&cold, &adopted, "receiptSeed", "rowsVisited"), 0);
            assert_eq!(
                delta(&cold, &adopted, "receiptAdopt", "rowsVisited"),
                history + 1
            );
            assert!(
                delta(&cold, &adopted, "receiptAdopt", "bytesParsed")
                    < delta(&before, &cold, "receiptSeed", "bytesParsed")
            );
            active["state"] = json!("completed");
            let path = fixture.store.path(string(&active, "requestId")).unwrap();
            crate::kernel::derived_index::interrupt(&path, &serde_json::to_vec(&active).unwrap())
                .unwrap();
            projection::forget(&fixture.dir);
            fixture.store.seed().unwrap();
            let repaired = control.tool("runtime_metrics", json!({})).await.unwrap();
            assert_eq!(delta(&adopted, &repaired, "indexRepair", "rowsVisited"), 1);
            assert_eq!(delta(&adopted, &repaired, "receiptSeed", "bytesParsed"), 0);
            assert_eq!(
                fixture
                    .store
                    .read_for_projection(string(&active, "requestId"), "another-session")
                    .unwrap()["state"],
                "completed"
            );
            println!("receipt restart history={history} rebuildBytes={} adoptBytes={} seedBytes=0 repairRows=1 repairBytes={}", delta(&before,&cold,"receiptSeed","bytesParsed"), delta(&cold,&adopted,"receiptAdopt","bytesParsed"), delta(&adopted,&repaired,"indexRepair","bytesParsed"));
            projection::forget(&fixture.dir);
            fixture.store.seed().unwrap();
            let again = control.tool("runtime_metrics", json!({})).await.unwrap();
            assert_eq!(delta(&repaired, &again, "indexRepair", "rowsVisited"), 0);
        }
    }
    #[tokio::test]
    async fn invalid_receipt_index_rebuilds_once_and_partial_migration_is_not_adopted() {
        // Regression: D2c index publication must recover missing, corrupt, incompatible and interrupted generations before reads.
        let fixture = Sandbox::new();
        let active = fixture.receipt(false);
        let control = control::Control::new(PathBuf::new());
        crate::kernel::derived_index::interrupt_next_rebuild();
        assert!(fixture.store.seed().is_err());
        fixture.store.seed().unwrap();
        assert_eq!(
            fixture
                .store
                .read_for_projection(string(&active, "requestId"), "new-session")
                .unwrap()["state"],
            "unconfirmed"
        );
        for mode in ["missing", "corrupt", "version"] {
            crate::kernel::derived_index::damage(&fixture.dir, mode);
            projection::forget(&fixture.dir);
            let before = control.tool("runtime_metrics", json!({})).await.unwrap();
            fixture.store.seed().unwrap();
            let rebuilt = control.tool("runtime_metrics", json!({})).await.unwrap();
            assert_eq!(delta(&before, &rebuilt, "receiptSeed", "rowsVisited"), 1);
            projection::forget(&fixture.dir);
            fixture.store.seed().unwrap();
            let adopted = control.tool("runtime_metrics", json!({})).await.unwrap();
            assert_eq!(delta(&rebuilt, &adopted, "receiptSeed", "rowsVisited"), 0);
            assert_eq!(
                fixture
                    .store
                    .read_for_projection(string(&active, "requestId"), "new-session")
                    .unwrap()["state"],
                "unconfirmed"
            );
        }
    }
    #[tokio::test]
    async fn interrupted_owner_migration_rebuilds_changed_provenance_before_projection() {
        // Regression: interrupted source conversion left a published index with stale canonical source references.
        let fixture = Sandbox::new();
        let mut receipt = fixture.receipt(true);
        fixture.store.seed().unwrap();
        crate::kernel::derived_index::invalidate_owner(&fixture.dir).unwrap();
        receipt["origin"] = json!({"sourceId":"migrated-source","ingressId":"fixture-ingress"});
        std::fs::write(fixture.store.path(string(&receipt, "requestId")).unwrap(), receipt.to_string()).unwrap();
        projection::forget(&fixture.dir);
        let control = control::Control::new(PathBuf::new());
        let before = control.tool("runtime_metrics", json!({})).await.unwrap();
        fixture.store.seed().unwrap();
        let rebuilt = control.tool("runtime_metrics", json!({})).await.unwrap();
        assert_eq!(delta(&before, &rebuilt, "receiptSeed", "rowsVisited"), 1);
        let read = fixture.store.read_for_projection(string(&receipt, "requestId"), "fixture-session").unwrap();
        assert_eq!(read["origin"], receipt["origin"]);
        projection::forget(&fixture.dir);
        fixture.store.seed().unwrap();
        let adopted = control.tool("runtime_metrics", json!({})).await.unwrap();
        assert_eq!(delta(&rebuilt, &adopted, "receiptSeed", "bytesParsed"), 0);
    }
    #[tokio::test]
    async fn oversized_receipt_payload_does_not_evict_its_summary() {
        // Regression: the 32 MiB source-byte cache limit forced unchanged large receipts to be decoded on every task poll.
        let fixture = Sandbox::new();
        let control = control::Control::new(PathBuf::new());
        let mut row = json!({"requestId":id(),"operation":"create","state":"completed","backendSession":"fixture-session","result":{"threadId":"fixture-thread","payload":"x".repeat(33*1024*1024)}});
        fixture.store.reserve(&row).unwrap();
        let request = string(&row, "requestId").to_owned();
        assert_eq!(
            fixture
                .store
                .read_for_projection(&request, "fixture-session")
                .unwrap()["result"]["threadId"],
            "fixture-thread"
        );
        let before = control.tool("runtime_metrics", json!({})).await.unwrap();
        for _ in 0..3 {
            let summary = fixture
                .store
                .read_for_projection(&request, "fixture-session")
                .unwrap();
            assert_eq!(summary["result"]["threadId"], "fixture-thread");
            assert!(summary["result"].get("payload").is_none());
        }
        let after = control.tool("runtime_metrics", json!({})).await.unwrap();
        assert_eq!(
            delta(&before, &after, "receiptProjection", "bytesParsed"),
            0
        );
        assert_eq!(delta(&before, &after, "receiptProjection", "bytesRead"), 0);
        row["result"] = json!({"threadId":"changed-thread"});
        fixture.store.checkpoint(&mut row).unwrap();
        assert_eq!(
            fixture
                .store
                .read_for_projection(&request, "fixture-session")
                .unwrap()["result"]["threadId"],
            "changed-thread"
        );
    }
    #[tokio::test]
    async fn runtime_changes_refresh_the_dependent_task_without_reading_other_receipts() {
        // Regression: changing one native task snapshot rebuilt all retained receipt projections.
        let fixture = Sandbox::new();
        let control = control::Control::new(PathBuf::new());
        for _ in 0..40 {
            fixture.receipt(true);
        }
        let active = fixture.receipt(false);
        let request = string(&active, "requestId");
        let runtime = fixture.dir.join("runtime").join("fixture.json");
        save(&runtime, &json!({"state":"running"})).unwrap();
        let mut projection = TaskProjection::default();
        let poll = |projection: &mut TaskProjection| {
            cost::sync(Owner::TaskRecords, Reason::Poll, || {
                projection
                    .update(
                        &fixture.store,
                        "fixture-session",
                        |row| {
                            if row["requestId"] == request {
                                vec![runtime.clone()]
                            } else {
                                Vec::new()
                            }
                        },
                        |mut row| {
                            if row["requestId"] == request {
                                row["runtime"] = super::super::file_cache::load(&runtime)?;
                            }
                            Ok(Some(row))
                        },
                    )
                    .unwrap()
            })
        };
        assert_eq!(poll(&mut projection).len(), 41);
        save(&runtime, &json!({"state":"completed"})).unwrap();
        let before = control.tool("runtime_metrics", json!({})).await.unwrap();
        let rows = poll(&mut projection);
        assert_eq!(
            rows.iter().find(|row| row["requestId"] == request).unwrap()["runtime"]["state"],
            "completed"
        );
        let after = control.tool("runtime_metrics", json!({})).await.unwrap();
        assert_eq!(
            delta(&before, &after, "receiptProjection", "bytesParsed"),
            0
        );
        assert_eq!(
            delta(&before, &after, "receiptProjection", "rowsVisited"),
            1
        );
        assert_eq!(delta(&before, &after, "taskRecords", "rowsVisited"), 2);
    }
}
