//! Read-only native writer diagnosis. Never removes locks or closes native sessions.
use crate::*;
pub fn probe_path(path: &Path) -> Value {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return json!({"state":"unheld","evidence":"lock-absent"})
        }
        Err(e) => return json!({"state":"unknown","reason":e.to_string()}),
    };
    match file.try_lock() {
        Ok(()) => {
            let _ = file.unlock();
            json!({"state":"unheld","evidence":"native-writer-file-lock"})
        }
        Err(std::fs::TryLockError::WouldBlock) => {
            json!({"state":"held","evidence":"native-writer-file-lock"})
        }
        Err(e) => json!({"state":"unknown","reason":e.to_string()}),
    }
}
pub(crate) fn lock_path(thread: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(thread).map_err(|_| "INVALID_THREAD_ID")?;
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
        .ok_or("CODEX_HOME_UNAVAILABLE")?;
    Ok(home
        .join("thread-writer-locks")
        .join(format!("{thread}.lock")))
}
pub(crate) fn probe(thread: &str) -> Value {
    lock_path(thread)
        .map(|p| probe_path(&p))
        .unwrap_or(json!({"state":"unknown","reason":"lock-location-unavailable"}))
}
pub(crate) fn busy(thread: &str, ownership: Value) -> Value {
    json!({"code":"THREAD_WRITER_BUSY","message":"The native thread writer is held by another owner. The requested operation did not complete. Inspect codex_owner; finish or archive this exact thread in its owning session before retrying.","retryable":false,"ownership":ownership,"next":{"via":"query","op":"codex_owner","args":{"threadId":thread},"hint":"Inspect the current owner and follow its exact-thread handoff step before retrying."}})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn held_writer_is_detected_without_waiting_or_modifying_it() {
        // Regression: external writers were discovered only after a 41-second Desktop load attempt.
        let path = std::env::temp_dir().join(format!("arc-lock-probe-{}", id()));
        let writer = std::fs::File::create(&path).unwrap();
        writer.lock().unwrap();
        assert_eq!(probe_path(&path)["state"], "held");
        writer.unlock().unwrap();
        assert_eq!(probe_path(&path)["state"], "unheld");
        drop(writer);
        std::fs::remove_file(path).unwrap();
    }
}

pub(crate) async fn processes(thread: &str) -> Value {
    #[cfg(unix)]
    {
        let Ok(path) = lock_path(thread) else {
            return json!([]);
        };
        let mut command = tokio::process::Command::new(if cfg!(target_os = "macos") {
            "/usr/sbin/lsof"
        } else {
            "lsof"
        });
        command.args(["-t", "--"]).arg(path).kill_on_drop(true);
        if let Ok(Ok(output)) =
            tokio::time::timeout(std::time::Duration::from_millis(800), command.output()).await
        {
            let pids: Vec<_> = String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|s| s.parse::<u32>().ok())
                .take(16)
                .map(|n| n.to_string())
                .collect();
            if !pids.is_empty() {
                let mut ps = tokio::process::Command::new("ps");
                ps.args(["-p", &pids.join(","), "-o", "pid=", "-o", "comm="])
                    .kill_on_drop(true);
                if let Ok(Ok(output)) =
                    tokio::time::timeout(std::time::Duration::from_millis(800), ps.output()).await
                {
                    return json!(String::from_utf8_lossy(&output.stdout).lines().filter_map(|line| {
                        let (pid,path)=line.trim().split_once(char::is_whitespace)?;
                        let executable=path.trim();let app=executable.split_once(".app/").map(|(p,_)|format!("{p}.app"));
                        Some(json!({"pid":pid.parse::<u32>().ok()?,"executable":executable,"app":app,"evidence":"open-descriptor-on-held-writer-lock"}))
                    }).collect::<Vec<_>>());
                }
            }
        }
    }
    json!([])
}
pub(crate) fn release_step(thread: &str, ownership: &Value) -> Value {
    if ownership["owner"] == "connector" {
        if ownership["runtimeStatus"] == "idle" {
            return json!({"via":"act","op":"codex_release","args":{"threadId":thread},"hint":"Release this idle ARC connector-owned writer. To archive it instead, use codex_archive with this threadId and release:true. The bundled executable's app path does not identify the writer owner."});
        }
        return json!({"via":"query","op":"codex_read","args":{"threadId":thread,"statusOnly":true},"hint":"Inspect this ARC connector-owned turn. Finish or explicitly interrupt it before codex_release; codex_archive with release:true also requires an idle thread."});
    }
    if ownership["owner"] != "desktop" {
        return json!({"via":"query","op":"codex_owner","args":{"threadId":thread},"hint":"End only the exact owning terminal/session normally using the reported process evidence, then re-probe this thread. ARC cannot release another owner; do not open it in Desktop, kill a shared app-server, or delete locks."});
    }
    json!({"via":"act","op":"task_open","args":{"agent":"codex","id":thread},"hint":"In the owning ChatGPT/Codex app, select this exact thread and choose Archive from its thread menu. Closing the ARC panel or unsubscribing ARC does not release a Desktop writer. If the owner is an external terminal, end that exact native session normally. Do not kill a shared app-server or delete locks. Re-probe codex_owner before retrying archive."})
}
