//! Atomic UTF-8 edits through the same receipt owner as other writes.
use crate::*;
use std::io::Write;

pub async fn write(c: &control::Control, operation: &str, args: &Value) -> Result<Value> {
    let requested = Path::new(string(args, "path"));
    let path = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        let p = projects::resolve(c, string(args, "project")).await?;
        Path::new(string(&p, "root")).join(requested)
    };
    // Follow an existing symlink, preserving the link rather than replacing it.
    let path = if path.exists() {
        std::fs::canonicalize(path).map_err(|e| e.to_string())?
    } else {
        path
    };
    static LOCKS: std::sync::OnceLock<crate::kernel::receipts::RequestLocks> =
        std::sync::OnceLock::new();
    let _guard = LOCKS
        .get_or_init(Default::default)
        .lock(&path.to_string_lossy())
        .await;
    let before = match std::fs::read_to_string(&path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && operation == "write" => None,
        Err(e) => return Err(e.to_string()),
    };
    if let Some(expected) = args["expectedHash"].as_str() {
        if before
            .as_ref()
            .is_none_or(|text| !hash(text).eq_ignore_ascii_case(expected))
        {
            return Err("HASH_MISMATCH: file missing or content changed".into());
        }
    }
    let old = before.as_deref().unwrap_or("");
    let mut content = old.to_owned();
    let mut replacements = 0;
    if operation == "edit" {
        for (index, edit) in args["edits"]
            .as_array()
            .ok_or("EDITS_REQUIRED")?
            .iter()
            .enumerate()
        {
            let from = string(edit, "oldText");
            if from.is_empty() {
                return Err(format!("EDIT_{index}: oldText must not be empty"));
            }
            let count = content
                .char_indices()
                .filter(|(i, _)| content[*i..].starts_with(from))
                .count();
            if count == 0 {
                return Err(format!("EDIT_{index}: oldText not found"));
            }
            if count > 1 && edit["replaceAll"] != true {
                return Err(format!("EDIT_{index}: oldText matches {count} locations; provide a unique match or replaceAll"));
            }
            replacements += content.match_indices(from).count();
            content = content.replace(from, string(edit, "newText"));
        }
    } else {
        content = string(args, "content").to_owned();
    }
    let parent = path.parent().ok_or("INVALID_PATH")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(format!(".arc-{}.tmp", id()));
    let result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        if let Ok(meta) = std::fs::metadata(&path) {
            file.set_permissions(meta.permissions())
                .map_err(|e| e.to_string())?;
        }
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        // Detect external writers before replacing the file; editor writes are serialized above.
        let current = match std::fs::read_to_string(&path) {
            Ok(text) => Some(text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        if current != before {
            return Err("FILE_CHANGED_DURING_EDIT".into());
        }
        std::fs::rename(&temp, &path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result?;
    drop(_guard);
    let old_lines: Vec<_> = old.lines().collect();
    let new_lines: Vec<_> = content.lines().collect();
    let prefix = old_lines
        .iter()
        .zip(&new_lines)
        .take_while(|(a, b)| a == b)
        .count();
    let suffix = old_lines[prefix..]
        .iter()
        .rev()
        .zip(new_lines[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let mut result = json!({"path":path,"sha256":hash(&content),"created":before.is_none(),"diff":{"changed":old!=content,"replacements":replacements,"startLine":prefix+1,"removedLines":old_lines.len()-prefix-suffix,"addedLines":new_lines.len()-prefix-suffix,"summary":"changed line span (common prefix/suffix excluded)"}});
    // Directory matching comes from the explicit project or the actual repository root.
    let project_root = if let Some(project) = args["project"].as_str() {
        projects::resolve(c, project)
            .await
            .ok()
            .and_then(|p| p["root"].as_str().map(PathBuf::from))
    } else {
        projects::git(
            &parent.to_string_lossy(),
            vec!["rev-parse".into(), "--show-toplevel".into()],
        )
        .await
        .ok()
        .map(|p| PathBuf::from(p.trim()))
    }
    .unwrap_or_else(|| parent.to_path_buf());
    let mut active = Vec::new();
    let observe = async {
        let mut cursor = Value::Null;
        let mut seen = std::collections::HashSet::new();
        let mut complete = true;
        loop {
            let page = c.request("thread/list", json!({"limit":100,"cursor":cursor,"sortKey":"updated_at","sortDirection":"desc"}), 3000).await?;
            for task in page["data"].as_array().into_iter().flatten() {
                let cwd = string(task, "cwd");
                if cwd.is_empty() {
                    continue;
                }
                let cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd));
                if !cwd.starts_with(&project_root) {
                    continue;
                }
                if task["status"]["type"] == "active" || task["status"] == "active" {
                    active.push(task["id"].clone());
                } else {
                    match c
                        .request(
                            "thread/read",
                            json!({"threadId":task["id"],"includeTurns":false}),
                            2000,
                        )
                        .await
                    {
                        Ok(t) if t["thread"]["status"]["type"] == "active" => {
                            active.push(task["id"].clone())
                        }
                        Ok(t) if t["thread"]["status"]["type"] == "idle" => (),
                        _ => complete = false,
                    }
                }
            }
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
            if !seen.insert(cursor.to_string()) {
                complete = false;
                break;
            }
        }
        Ok::<_, String>(complete)
    };
    match tokio::time::timeout(std::time::Duration::from_secs(5), observe).await {
        Ok(Ok(complete)) => {
            result["activityCheck"] = json!(if complete { "observed" } else { "partial" });
        }
        _ => result["activityCheck"] = json!("unavailable"),
    }
    if !active.is_empty() {
        result["warning"] = json!({"message":"Codex tasks are running in this project; concurrent changes are possible.","threadIds":active});
    }
    Ok(result)
}
