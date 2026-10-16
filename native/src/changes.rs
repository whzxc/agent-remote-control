//! Per-turn Git baselines, shared by Desktop and Agent Remote Control submissions.
use crate::*;
async fn git(cwd: &str, args: &[&str]) -> Result<String> {
    projects::git(cwd, args.iter().map(|s| (*s).into()).collect()).await
}
fn path(thread: &str, turn: &str) -> PathBuf {
    root()
        .join("changes")
        .join(hash(thread))
        .join(format!("{}.json", hash(turn)))
}
pub async fn capture(cwd: &str) -> Value {
    let result = async {
        let root = git(cwd, &["rev-parse","--show-toplevel"]).await?;
        let head = git(cwd, &["rev-parse","--verify","HEAD"]).await.ok().map(|s| s.trim().to_owned());
        let status = git(cwd, &["status","--porcelain=v1","-z"]).await?;
        Ok::<_,String>(json!({"cwd":cwd,"root":root.trim(),"head":head,"dirty":!status.is_empty(),"capturedAt":now(),"source":"before-turn-submission"}))
    }.await;
    result.unwrap_or_else(|e| json!({"cwd":cwd,"unavailable":e,"capturedAt":now()}))
}
pub fn record(thread: &str, turn: &str, baseline: &Value) -> Result<()> {
    if thread.is_empty() || turn.is_empty() {
        return Ok(());
    }
    let file = path(thread, turn);
    if !file.exists() {
        save(&file, baseline)?;
    }
    Ok(())
}
pub async fn query(c: &control::Control, args: &Value) -> Result<Value> {
    let thread = string(args, "threadId");
    let task = c
        .request(
            "thread/read",
            json!({"threadId":thread,"includeTurns":false}),
            10000,
        )
        .await?;
    let cwd = string(&task["thread"], "cwd");
    if cwd.is_empty() {
        return Err("TASK_WORKSPACE_UNAVAILABLE".into());
    }
    let turn = if let Some(turn) = args["turnId"].as_str() {
        turn.to_owned()
    } else {
        let page = c
            .request(
                "thread/turns/list",
                json!({"threadId":thread,"limit":1,"sortDirection":"desc","itemsView":"notLoaded"}),
                10000,
            )
            .await?;
        string(&page["data"][0], "id").to_owned()
    };
    let baseline = load(&path(thread, &turn)).unwrap_or(Value::Null);
    let repository = git(cwd, &["rev-parse", "--show-toplevel"]).await?;
    let task_cwd = cwd;
    let cwd = repository.trim();
    let head = git(cwd, &["rev-parse", "--verify", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_owned());
    let empty_tree = git(cwd, &["hash-object", "-t", "tree", "--stdin"]).await?;
    let head_ref = head.as_deref().unwrap_or(empty_tree.trim());
    let start = baseline["head"].as_str();
    let same_workspace = baseline["cwd"]
        .as_str()
        .is_some_and(|p| std::fs::canonicalize(p).ok() == std::fs::canonicalize(task_cwd).ok());
    let valid = same_workspace
        && baseline["unavailable"].is_null()
        && match start {
            Some(start) => git(cwd, &["cat-file", "-e", start]).await.is_ok(),
            None => baseline["capturedAt"].is_string(),
        };
    let limit = num(args, "limit", 10).clamp(1, 100);
    let offset = num(args, "offset", 0);
    let commits = if head.is_none() {
        String::new()
    } else if valid && start.is_some() {
        git(
            cwd,
            &[
                "log",
                "--format=%H%x00%s",
                &format!("{}..{head_ref}", start.unwrap()),
            ],
        )
        .await?
    } else {
        git(cwd, &["log", "--format=%H%x00%s", &format!("-n{limit}")]).await?
    };
    let commits: Vec<_> = commits
        .lines()
        .filter_map(|line| {
            line.split_once('\0')
                .map(|(sha, title)| json!({"sha":sha,"title":title}))
        })
        .collect();
    let base = if valid {
        start.unwrap_or(empty_tree.trim())
    } else {
        head_ref
    };
    let raw = git(
        cwd,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--numstat",
            "-z",
            base,
            "--",
        ],
    )
    .await?;
    let mut files = Vec::new();
    let mut chunks = raw.split('\0').filter(|s| !s.is_empty());
    while let Some(entry) = chunks.next() {
        let parts: Vec<_> = entry.splitn(3, '\t').collect();
        if parts.len() != 3 {
            continue;
        }
        let file = if parts[2].is_empty() {
            let _old = chunks.next();
            chunks.next().unwrap_or("")
        } else {
            parts[2]
        };
        files.push(json!({"path":file,"added":parts[0].parse::<u64>().ok(),"removed":parts[1].parse::<u64>().ok(),"binary":parts[0]=="-"}));
    }
    // Git diff omits untracked files; include their current text in the workspace summary.
    let untracked = git(cwd, &["ls-files", "--others", "--exclude-standard", "-z"]).await?;
    for file in untracked.split('\0').filter(|s| !s.is_empty()) {
        let text = projects::read_bytes(cwd, file)
            .ok()
            .and_then(|v| String::from_utf8(v).ok());
        files.push(json!({"path":file,"added":text.as_ref().filter(|s| !s.contains('\0')).map(|s|s.lines().count()),"removed":0,"untracked":true,"binary":text.as_ref().is_none_or(|s|s.contains('\0'))}));
    }
    let summary = json!({"files":files.len(),"added":files.iter().filter_map(|f|f["added"].as_u64()).sum::<u64>(),"removed":files.iter().filter_map(|f|f["removed"].as_u64()).sum::<u64>(),"binaryOrUnreadable":files.iter().filter(|f| f["binary"] == true).count()});
    let mut result = json!({"threadId":thread,"turnId":turn,"baseline":baseline,"fallback":!valid,"mode":if valid{"since-turn-start"}else{"recent-commits-and-current-workspace"},"reason":if valid{Value::Null}else{json!("baseline missing, unavailable or workspace changed")},"head":head,"commits":commits.iter().skip(if args["path"].is_string(){0}else{offset}).take(limit).collect::<Vec<_>>(),"nextOffset":if args["path"].is_null() && offset+limit<commits.len(){Some(offset+limit)}else{None},"files":files,"summary":summary,"root":cwd,"attribution":"workspace changes may include other tasks and pre-existing dirty files","observedAt":now()});
    if let Some(file) = args["path"].as_str() {
        let mut diff = git(
            cwd,
            &["diff", "--no-ext-diff", "--no-textconv", base, "--", file],
        )
        .await?;
        if untracked.split('\0').any(|p| p == file) {
            let bytes = projects::read_bytes(cwd, file)?;
            if let Some(text) = String::from_utf8(bytes).ok().filter(|s| !s.contains('\0')) {
                diff = format!(
                    "--- /dev/null\n+++ b/{file}\n@@ -0,0 +1,{} @@\n{}",
                    text.lines().count(),
                    text.lines().map(|s| format!("+{s}\n")).collect::<String>()
                );
                if !text.ends_with('\n') && !text.is_empty() {
                    diff.push_str("\\ No newline at end of file\n");
                }
            } else {
                diff = format!("Binary file {file} is untracked\n");
            }
        }
        let units: Vec<_> = diff.encode_utf16().collect();
        let end = offset
            .saturating_add(num(args, "length", 16000).min(65536))
            .min(units.len());
        result["diff"] = json!({"path":file,"text":String::from_utf16_lossy(&units[offset.min(end)..end]),"offset":offset,"nextOffset":if end<units.len(){Some(end)}else{None},"characters":units.len(),"sha256":hash(&diff)});
    }
    Ok(result)
}
