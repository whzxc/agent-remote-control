//! Recover Core-owned process trees before starting replacements after a crash.
//! Detached execution hosts deliberately never enter this registry.
use crate::*;
use std::{io, time::Duration};

static OWNER: std::sync::OnceLock<(PathBuf, Value)> = std::sync::OnceLock::new();

pub(crate) trait SpawnOwned {
    fn spawn_owned(&mut self) -> io::Result<tokio::process::Child>;
}
impl SpawnOwned for tokio::process::Command {
    fn spawn_owned(&mut self) -> io::Result<tokio::process::Child> {
        let Some((directory, owner)) = OWNER.get() else {
            return self.spawn();
        };
        #[cfg(unix)]
        self.process_group(0);
        let mut child = self.spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("Core child PID unavailable"))?;
        let start = crate::codex_host::process_start(pid);
        if start.is_none() && child.try_wait()?.is_some() {
            return Ok(child);
        }
        let result = (|| -> Result<()> {
            let start = start.ok_or("Core child creation time unavailable")?;
            save(
                &directory.join(format!("{pid}.json")),
                &json!({"pid":pid,"processStart":start,"owner":owner}),
            )
        })();
        if let Err(error) = result {
            crate::codex_host::signal(pid, true);
            let _ = child.start_kill();
            return Err(io::Error::other(error));
        }
        Ok(child)
    }
}

pub(crate) fn reclaimable(
    record: &Value,
    child_start: Option<&str>,
    owner_start: Option<&str>,
) -> bool {
    child_start.is_some()
        && record["processStart"].as_str() == child_start
        && (owner_start.is_none() || record["owner"]["processStart"].as_str() != owner_start)
}

/// Called with core.lock held, before any ingress or provider is restored.
pub(crate) async fn recover() -> Result<()> {
    let directory = root().join("core-children");
    private_dir(&directory)?;
    for entry in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().is_none_or(|e| e != "json") {
            continue;
        }
        let record = load(&entry.path())?;
        let pid = record["pid"].as_u64().ok_or("CORE_CHILD_INDEX_INVALID")? as u32;
        let owner_pid = record["owner"]["pid"]
            .as_u64()
            .ok_or("CORE_CHILD_INDEX_INVALID")? as u32;
        if reclaimable(
            &record,
            crate::codex_host::process_start(pid).as_deref(),
            crate::coordination::lifecycle::alive(owner_pid)
                .unwrap_or(false)
                .then(|| crate::codex_host::process_start(owner_pid))
                .flatten()
                .as_deref(),
        ) {
            crate::logs::record(
                "WARN",
                &format!("Reclaiming process {pid} left by a previous Core"),
                None,
            );
            crate::codex_host::signal(pid, false);
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while crate::coordination::lifecycle::alive(pid).unwrap_or(false)
                && crate::codex_host::process_start(pid).as_deref()
                    == record["processStart"].as_str()
            {
                if tokio::time::Instant::now() >= deadline {
                    crate::codex_host::signal(pid, true);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    if crate::coordination::lifecycle::alive(pid).unwrap_or(false) {
                        return Err(format!("CORE_CHILD_RECLAIM_FAILED: process {pid} is still alive; replacement startup stopped"));
                    }
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        } else if record["processStart"].as_str()
            == crate::codex_host::process_start(pid).as_deref()
            && crate::coordination::lifecycle::alive(pid).unwrap_or(false)
        {
            return Err(
                "CORE_CHILD_OWNER_ACTIVE: another Core still owns a recorded process".into(),
            );
        }
        std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
    }
    OWNER.set((directory, json!({"pid":std::process::id(),"processStart":crate::codex_host::process_start(std::process::id()).ok_or("CORE_IDENTITY_UNAVAILABLE")?})))
        .map_err(|_| "Core child registry already initialized".to_owned())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crashed_core_children_are_reclaimed_without_signalling_reused_pids() {
        // Regression: KillMode=process left a tunnel provider alive and Core restart started a duplicate.
        let record =
            json!({"pid":3,"processStart":"child","owner":{"pid":2,"processStart":"core"}});
        assert!(reclaimable(&record, Some("child"), None));
        assert!(reclaimable(&record, Some("child"), Some("reused-core")));
        assert!(!reclaimable(&record, Some("child"), Some("core")));
        assert!(!reclaimable(&record, Some("reused-child"), None));
        assert!(!reclaimable(&record, None, None));
    }
}
