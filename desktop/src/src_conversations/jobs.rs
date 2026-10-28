//! Background import ownership survives a caller dropping its response.
use arc_core::src_conversations::import_state::ImportState;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    future::Future,
    sync::{Arc, Mutex, OnceLock},
};

struct Job {
    store_id: String,
    state: ImportState,
}
#[derive(Default)]
pub struct Jobs(Mutex<BTreeMap<String, Job>>);
pub fn jobs() -> &'static Arc<Jobs> {
    static JOBS: OnceLock<Arc<Jobs>> = OnceLock::new();
    JOBS.get_or_init(|| Arc::new(Jobs::default()))
}
impl Jobs {
    pub fn in_flight(&self, account: &str) -> Option<Value> {
        self.0
            .lock()
            .unwrap()
            .get(account)
            .filter(|j| j.state.status == "importing")
            .map(|j| j.state.response(account))
    }
    pub fn start(
        self: &Arc<Self>,
        account: String,
        store_id: String,
        worker: impl Future<Output = Result<ImportState, String>> + Send + 'static,
    ) -> Value {
        let mut jobs = self.0.lock().unwrap();
        if let Some(job) = jobs.get(&account).filter(|j| j.state.status == "importing") {
            return job.state.response(&account);
        }
        let state = ImportState::importing();
        let response = state.response(&account);
        jobs.insert(account.clone(), Job { store_id, state });
        let owner = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = worker.await;
            if let Some(job) = owner.0.lock().unwrap().get_mut(&account) {
                job.state = result.unwrap_or_else(|error| ImportState::blocked(&error));
            }
        });
        response
    }
    pub fn forget(&self, account: &str) {
        self.0.lock().unwrap().remove(account);
    }
    pub fn metadata(&self, views: Vec<Value>) -> Value {
        let mut jobs = self.0.lock().unwrap();
        let mut rows: BTreeMap<String, Value> = views
            .into_iter()
            .map(|row| (arc_core::string(&row, "accountId").to_owned(), row))
            .collect();
        // Once URL evidence arrives, normal URL-only login status takes over.
        jobs.retain(|account, job| {
            !matches!(job.state.status, "signed-in-pending" | "not-imported")
                || rows
                    .get(account)
                    .is_none_or(|r| r["status"] != "signed-in" && r["status"] != "expired")
        });
        for (account, job) in jobs.iter() {
            let row = rows.entry(account.clone()).or_insert_with(|| json!({
                "accountId":account,"storeId":job.store_id,"open":false,"url":null,"active":false
            }));
            row["status"] = json!(job.state.status);
            row["reason"] = json!(job.state.reason);
            row["hint"] = json!(job.state.hint);
            row["detectedAccountId"] = json!(job.state.detected_account_id);
            if matches!(
                job.state.status,
                "importing" | "import-blocked" | "import-mismatch" | "import-unverified"
            ) {
                row["url"] = Value::Null;
                row["active"] = json!(false);
            }
        }
        json!({"containers":rows.into_values().collect::<Vec<_>>()})
    }
}

#[cfg(test)]
mod tests {
    use super::super::import::wait_for_password;
    use super::*;
    use std::{sync::mpsc, time::Duration};
    use zeroize::Zeroizing;

    async fn terminal(jobs: &Jobs, account: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let snapshot = jobs.metadata(vec![]);
                let row = snapshot["containers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|r| r["accountId"] == account)
                    .unwrap()
                    .clone();
                if row["status"] != "importing" {
                    return row;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn fake_keychain_import_transitions_and_same_account_deduplication() {
        // Regression: the first macOS password prompt outlived the synchronous 30-second import call.
        for installed in [true, false] {
            let jobs = Arc::new(Jobs::default());
            let (allow, waiting) = mpsc::channel();
            let initial = jobs.start("account".into(), "store".into(), async move {
                tokio::task::spawn_blocking(move || {
                    wait_for_password(
                        move || {
                            waiting.recv().unwrap();
                            Ok(Zeroizing::new(b"synthetic-keychain-password".to_vec()))
                        },
                        Duration::from_secs(1),
                    )
                })
                .await
                .unwrap()
                .map_err(str::to_owned)?;
                Ok(ImportState::finished(Ok(installed)))
            });
            assert_eq!(initial["status"], "importing");
            assert_eq!(initial["next"]["op"], "src_conversations");
            let duplicate = jobs.start("account".into(), "store".into(), async {
                Err("unexpected-duplicate-import".into())
            });
            assert_eq!(duplicate["status"], "importing");
            allow.send(()).unwrap();
            let complete = terminal(&jobs, "account").await;
            assert_eq!(
                complete["status"],
                if installed {
                    "signed-in-pending"
                } else {
                    "not-imported"
                }
            );
            assert!(complete["reason"].is_null());
            let observed = jobs.metadata(vec![
                json!({"accountId":"account","storeId":"store","status":"signed-in","open":true}),
            ]);
            assert_eq!(observed["containers"][0]["status"], "signed-in");
        }
    }
    #[tokio::test]
    async fn fake_keychain_denial_and_timeout_remain_pollable_blockers() {
        // Regression: Keychain denial or a slow password prompt returned a request error without account progress.
        for denied in [true, false] {
            let jobs = Arc::new(Jobs::default());
            let (release, waiting) = mpsc::channel::<()>();
            jobs.start("account".into(), "store".into(), async move {
                tokio::task::spawn_blocking(move || {
                    wait_for_password(
                        move || {
                            if !denied {
                                let _ = waiting.recv();
                            }
                            Err("keychain-denied")
                        },
                        Duration::from_millis(5),
                    )
                })
                .await
                .unwrap()
                .map_err(str::to_owned)?;
                Ok(ImportState::finished(Ok(true)))
            });
            let blocked = terminal(&jobs, "account").await;
            assert_eq!(blocked["status"], "import-blocked");
            assert_eq!(
                blocked["reason"],
                if denied {
                    "keychain-denied"
                } else {
                    "keychain-timeout"
                }
            );
            assert!(blocked["hint"]
                .as_str()
                .unwrap()
                .contains("macOS login password"));
            assert!(blocked["hint"].as_str().unwrap().contains("Always Allow"));
            drop(release);
        }
    }
}
