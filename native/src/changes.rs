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
        let branch = git(cwd, &["symbolic-ref", "-q", "HEAD"]).await.ok();
        let common = git(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await.ok();
        Ok::<_,String>(json!({"cwd":cwd,"root":root.trim(),"head":head,"ref":branch.map(|v|v.trim().to_owned()),"commonDir":common.and_then(|v|Path::new(v.trim()).canonicalize().ok()),"dirty":!status.is_empty(),"capturedAt":now(),"source":"before-turn-submission"}))
    }.await;
    result.unwrap_or_else(|e| json!({"cwd":cwd,"unavailable":e,"capturedAt":now()}))
}
pub fn record(thread: &str, turn: &str, baseline: &Value) -> Result<()> {
    if thread.is_empty() || turn.is_empty() {
        return Ok(());
    }
    let file = path(thread, turn);
    if !file.exists() {
        let mut row = baseline.clone();
        row["threadId"] = json!(thread);
        row["turnId"] = json!(turn);
        save(&file, &row)?;
        crate::coordination::git_watch::baseline(&row);
        if terminal_path(thread, turn).exists() {
            let _ = terminal(thread, turn);
        }
    }
    Ok(())
}
fn snapshot_path(thread: &str, turn: &str) -> PathBuf {
    root()
        .join("change-snapshots")
        .join(hash(thread))
        .join(format!("{}.json", hash(turn)))
}
fn terminal_path(thread: &str, turn: &str) -> PathBuf {
    snapshot_path(thread, turn).with_extension("terminal")
}
pub(crate) fn is_terminal(turn: &Value) -> bool {
    matches!(
        string(turn, "status"),
        "completed" | "failed" | "interrupted" | "cancelled"
    )
}
fn unavailable(thread: &str, turn: &str, reason: &str) -> Value {
    json!({"threadId":thread,"turnId":turn,"files":null,"summary":null,"commits":null,
        "fallback":true,"reason":reason,"changeEvidence":"unavailable",
        "next":{"op":null,"hint":"Restore the original workspace and recorded baseline, or inspect the turn's commits in the repository. A missing terminal snapshot cannot be reconstructed from the current workspace alone."}})
}

/// Persist independently of notification bindings, including events racing turn submission.
pub(crate) fn terminal(thread: &str, turn: &str) -> Option<tokio::task::JoinHandle<()>> {
    if thread.is_empty() || turn.is_empty() || snapshot_path(thread, turn).exists() {
        return None;
    }
    if let Err(error) = save(&terminal_path(thread, turn), &json!({"observedAt":now()})) {
        crate::logs::record("WARN", &error, None);
        return None;
    }
    let (thread, turn) = (thread.to_owned(), turn.to_owned());
    Some(tokio::spawn(async move {
        let baseline = load(&path(&thread, &turn)).unwrap_or(Value::Null);
        if baseline.is_object() {
            evidence(&thread, &turn, string(&baseline, "cwd"), true).await;
        }
    }))
}

/// Bound historical evidence before scanning Git, and never replace a frozen outcome.
async fn evidence(thread: &str, turn: &str, cwd: &str, terminal: bool) -> Value {
    let _guard = crate::kernel::receipts::RequestLocks
        .lock(&format!("changes:{thread}:{turn}"))
        .await;
    let snapshot = snapshot_path(thread, turn);
    if let Ok(value) = load(&snapshot) {
        return value;
    }
    let baseline = load(&path(thread, turn)).unwrap_or(Value::Null);
    if baseline.is_null() || !baseline["unavailable"].is_null() {
        return unavailable(thread, turn, "turn-baseline-unavailable");
    }
    let mut later = Vec::new();
    if let Ok(entries) = std::fs::read_dir(path(thread, turn).parent().unwrap()) {
        for entry in entries.flatten() {
            let Ok(candidate) = load(&entry.path()) else {
                continue;
            };
            if candidate["capturedAt"]
                .as_str()
                .zip(baseline["capturedAt"].as_str())
                .is_some_and(|(a, b)| a > b)
                && candidate["root"] == baseline["root"]
            {
                later.push(candidate);
            }
        }
    }
    later.sort_by(|a, b| string(a, "capturedAt").cmp(string(b, "capturedAt")));
    if later
        .first()
        .is_some_and(|b| b["dirty"] == true || !b["head"].is_string())
    {
        return unavailable(
            thread,
            turn,
            "historical-turn-end-unavailable: next baseline is dirty or has no commit",
        );
    }
    let end = later.first().and_then(|b| b["head"].as_str());
    let read = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        query_live(thread, turn, cwd, &baseline, end),
    )
    .await;
    let mut value = match read {
        Ok(Ok(value)) => value,
        Ok(Err(_)) => unavailable(thread, turn, "workspace-or-git-evidence-unavailable"),
        Err(_) => unavailable(thread, turn, "change-snapshot-timeout (5s)"),
    };
    if terminal && value["fallback"] == false {
        value["changeEvidence"] = json!("terminal-git-snapshot");
        if let Err(error) = save(&snapshot, &value) {
            value["persistenceError"] = json!(error);
            value["changeEvidence"] = json!("live-git-baseline: snapshot persistence failed");
        }
    }
    value
}

pub async fn query(c: &control::Control, args: &Value) -> Result<Value> {
    let thread = string(args, "threadId");
    // A pinned durable result does not require the removed workspace or a native reader.
    if let Some(turn) = args["turnId"].as_str() {
        if let Ok(value) = load(&snapshot_path(thread, turn)) {
            return Ok(page(value, args).await);
        }
    }
    let task = c
        .request(
            "thread/read",
            json!({"threadId":thread,"includeTurns":false}),
            10000,
        )
        .await?;
    let turn_page =
        crate::review::turn_page(c, &json!({"threadId":thread,"turnId":args["turnId"]})).await?;
    let turn = &turn_page["data"][0];
    let value = evidence(
        thread,
        string(turn, "id"),
        string(&task["thread"], "cwd"),
        is_terminal(turn),
    )
    .await;
    Ok(page(value, args).await)
}

pub(crate) async fn review_evidence(thread: &str, turn: &Value) -> Value {
    let id = string(turn, "id");
    let baseline = load(&path(thread, id)).unwrap_or(Value::Null);
    let value = evidence(thread, id, string(&baseline, "cwd"), is_terminal(turn)).await;
    let files = if value["fallback"] == false {
        json!(value["files"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|f| json!({"path":f["path"],"added":f["added"],"removed":f["removed"]}))
            .collect::<Vec<_>>())
    } else {
        crate::review::native_files(turn["items"].as_array().map(Vec::as_slice).unwrap_or(&[]))
    };
    if files.is_array() {
        json!({"files":files,"changeEvidence":if value["fallback"] == false {value["changeEvidence"].clone()} else {json!("native-file-changes")},"attribution":value["attribution"]})
    } else {
        value
    }
}

async fn query_live(
    thread: &str,
    turn: &str,
    cwd: &str,
    baseline: &Value,
    end: Option<&str>,
) -> Result<Value> {
    let repository = git(cwd, &["rev-parse", "--show-toplevel"]).await?;
    let task_cwd = cwd;
    let cwd = repository.trim();
    let head = if let Some(end) = end {
        Some(end.to_owned())
    } else {
        git(cwd, &["rev-parse", "--verify", "HEAD"])
            .await
            .ok()
            .map(|s| s.trim().to_owned())
    };
    let empty_tree = git(cwd, &["hash-object", "-t", "tree", "--stdin"]).await?;
    let head_ref = head.as_deref().unwrap_or(empty_tree.trim());
    let start = baseline["head"].as_str();
    let same_workspace = baseline["cwd"]
        .as_str()
        .and_then(|p| std::fs::canonicalize(p).ok())
        .zip(std::fs::canonicalize(task_cwd).ok())
        .is_some_and(|(a, b)| a == b);
    let valid = same_workspace
        && baseline["unavailable"].is_null()
        && match start {
            Some(start) => git(cwd, &["cat-file", "-e", start]).await.is_ok(),
            None => baseline["capturedAt"].is_string(),
        };
    if !valid {
        return Ok(unavailable(
            thread,
            turn,
            "turn-baseline-does-not-match-workspace",
        ));
    }
    let commits = if head.is_none() {
        String::new()
    } else if start.is_some() {
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
        git(cwd, &["log", "--format=%H%x00%s"]).await?
    };
    let commits: Vec<_> = commits
        .lines()
        .filter_map(|line| {
            line.split_once('\0')
                .map(|(sha, title)| json!({"sha":sha,"title":title}))
        })
        .collect();
    let base = start.unwrap_or(empty_tree.trim());
    let mut diff_args = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        "-z",
        base,
    ];
    if end.is_some() {
        diff_args.push(head_ref);
    }
    diff_args.push("--");
    let raw = git(cwd, &diff_args).await?;
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
    let untracked = if end.is_some() {
        String::new()
    } else {
        git(cwd, &["ls-files", "--others", "--exclude-standard", "-z"]).await?
    };
    for file in untracked.split('\0').filter(|s| !s.is_empty()) {
        let text = projects::read_bytes(cwd, file)
            .ok()
            .and_then(|v| String::from_utf8(v).ok());
        files.push(json!({"path":file,"added":text.as_ref().filter(|s| !s.contains('\0')).map(|s|s.lines().count()),"removed":0,"untracked":true,"binary":text.as_ref().is_none_or(|s|s.contains('\0'))}));
    }
    let summary = json!({"files":files.len(),"added":files.iter().filter_map(|f|f["added"].as_u64()).sum::<u64>(),"removed":files.iter().filter_map(|f|f["removed"].as_u64()).sum::<u64>(),"binaryOrUnreadable":files.iter().filter(|f| f["binary"] == true).count()});
    let dirty = end.is_none()
        && !git(cwd, &["status", "--porcelain=v1", "-z"])
            .await?
            .is_empty();
    Ok(
        json!({"threadId":thread,"turnId":turn,"baseline":baseline,"fallback":false,"mode":"since-turn-start",
        "reason":null,"head":head,"base":base,"workspaceDirty":dirty,"commitCount":commits.len(),"commits":commits,
        "files":files,"summary":summary,"root":cwd,"changeEvidence":"live-git-baseline",
        "attribution":"workspace changes may include other tasks and pre-existing dirty files","observedAt":now()}),
    )
}

async fn page(mut value: Value, args: &Value) -> Value {
    let limit = num(args, "limit", 10).clamp(1, 100);
    let offset = num(args, "offset", 0);
    if let Some(commits) = value["commits"].as_array() {
        let start = if args["path"].is_string() { 0 } else { offset };
        let next =
            (start.saturating_add(limit) < commits.len()).then_some(start.saturating_add(limit));
        let rows = json!(commits.iter().skip(start).take(limit).collect::<Vec<_>>());
        value["commits"] = rows;
        value["nextOffset"] = if args["path"].is_string() {
            Value::Null
        } else {
            json!(next)
        };
    }
    if let Some(file) = args["path"].as_str() {
        let common = string(&value["baseline"], "commonDir");
        let mut diff =
            if value["fallback"] == false && value["workspaceDirty"] == false && !common.is_empty()
            {
                git(
                    common,
                    &[
                        "--git-dir",
                        common,
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        string(&value, "base"),
                        string(&value, "head"),
                        "--",
                        file,
                    ],
                )
                .await
            } else if value["changeEvidence"] == "live-git-baseline" {
                git(
                    string(&value, "root"),
                    &[
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        string(&value, "base"),
                        "--",
                        file,
                    ],
                )
                .await
            } else {
                Err("snapshot-patch-unavailable".into())
            };
        if value["changeEvidence"] == "live-git-baseline"
            && value["files"].as_array().is_some_and(|files| {
                files
                    .iter()
                    .any(|row| row["path"] == file && row["untracked"] == true)
            })
        {
            diff = projects::read_bytes(string(&value, "root"), file).map(|bytes| {
                if let Some(text) = String::from_utf8(bytes).ok().filter(|s| !s.contains('\0')) {
                    let mut patch = format!(
                        "--- /dev/null\n+++ b/{file}\n@@ -0,0 +1,{} @@\n{}",
                        text.lines().count(),
                        text.lines().map(|s| format!("+{s}\n")).collect::<String>()
                    );
                    if !text.ends_with('\n') && !text.is_empty() {
                        patch.push_str("\\ No newline at end of file\n");
                    }
                    patch
                } else {
                    format!("Binary file {file} is untracked\n")
                }
            });
        }
        match diff {
            Ok(diff) => {
                let units: Vec<_> = diff.encode_utf16().collect();
                let end = offset
                    .saturating_add(num(args, "length", 16000).min(65536))
                    .min(units.len());
                value["diff"] = json!({"path":file,"text":String::from_utf16_lossy(&units[offset.min(end)..end]),"offset":offset,"nextOffset":if end<units.len(){Some(end)}else{None},"characters":units.len(),"sha256":hash(&diff)});
            }
            Err(_) => {
                value["diff"] = Value::Null;
                value["diffUnavailable"] = json!("The snapshot retains file statistics, but the patch is uncommitted or its Git objects are unavailable.");
                value["next"] = json!({"op":null,"hint":"Inspect the saved commit range in a repository containing those objects; recover uncommitted content from the original workspace or backups."});
            }
        }
    }
    value
}

// Freeze a small factual summary for a completed notification, never the full diff.
pub(crate) async fn notification(c: &control::Control, thread: &str, turn: &str) -> Value {
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        query(c, &json!({"threadId":thread,"turnId":turn,"limit":5})),
    )
    .await;
    match result {
        Ok(Ok(v)) if v["files"].is_null() => {
            json!({"commits":null,"summary":null,"unavailable":v["reason"],"next":v["next"],"observedAt":now()})
        }
        Ok(Ok(v)) => {
            let mut truncated = v["nextOffset"].is_number();
            let commits = v["commits"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|c| {
                    let title = string(c, "title");
                    truncated |= title.chars().count() > 120;
                    json!({"sha":c["sha"],"title":title.chars().take(120).collect::<String>()})
                })
                .collect::<Vec<_>>();
            json!({"commits":commits,"commitCount":v["commitCount"],"summary":v["summary"],"fallback":v["fallback"],"truncated":truncated,"observedAt":v["observedAt"],"attribution":v["attribution"]})
        }
        other => {
            json!({"unavailable":match other {Ok(Err(e))=>e.chars().take(200).collect::<String>(),_=>"change-summary-timeout (5s)".into()},"observedAt":now()})
        }
    }
}

/// Read bounded commit evidence without diffs, status scans, or a second native task read.
pub(crate) async fn progress(thread: &str, turn: &str) -> Value {
    let baseline = match load(&path(thread, turn)) {
        Ok(baseline) => baseline,
        Err(_) => {
            return json!({"commits":null,"elapsedMs":null,"baseline":null,"unavailable":"turn-baseline-unavailable"})
        }
    };
    let elapsed = baseline["capturedAt"]
        .as_str()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map(|at| (chrono::Utc::now().timestamp_millis() - at.timestamp_millis()).max(0));
    let mut out = json!({"commits":null,"elapsedMs":elapsed,"baseline":baseline["capturedAt"]});
    let Some(head) = baseline["head"].as_str() else {
        out["unavailable"] = json!("turn-baseline-has-no-commit");
        return out;
    };
    let cwd = string(&baseline, "root");
    let range = format!("{head}..HEAD");
    let read = async {
        let count = git(cwd, &["rev-list", "--count", &range]).await?.trim().parse::<u64>().map_err(|e|e.to_string())?;
        let log = git(cwd, &["log", "-5", "--format=%H%x00%s", &range]).await?;
        let recent: Vec<_> = log.lines().filter_map(|line| line.split_once('\0'))
            .map(|(sha, title)|json!({"sha":sha,"title":title.chars().take(160).collect::<String>()})).collect();
        Ok::<_,String>(json!({"count":count,"recent":recent,"scope":"workspace-since-turn-baseline"}))
    }.await;
    match read {
        Ok(commits) => out["commits"] = commits,
        Err(error) => out["unavailable"] = json!(error),
    }
    out
}
