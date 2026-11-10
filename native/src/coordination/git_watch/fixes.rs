//! Path overlap is bounded correlation, never causal defect evidence.
use super::*;
use std::collections::BTreeSet;
const MAX_COMMITS: usize = 64;
const MAX_CORRELATIONS: usize = 512;
static WRITER: Mutex<()> = Mutex::new(());

fn timestamp(value: &Value) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(value.as_str()?).ok()
}
fn files(row: &Value) -> BTreeSet<&str> {
    row["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| f["path"].as_str())
        .collect()
}
fn linked(message: &str, row: &Value) -> bool {
    let turn = string(row, "turnId");
    !turn.is_empty()
        && message
            .lines()
            .any(|line| line.trim() == format!("ARC-Turn: {turn}"))
}
fn is_fix(message: &str) -> bool {
    let title = message.lines().next().unwrap_or("");
    title.starts_with("fix: ")
        || title.starts_with("fix!: ")
        || title
            .strip_prefix("fix(")
            .and_then(|s| s.split_once(')'))
            .is_some_and(|(_, s)| s.starts_with(": ") || s.starts_with("!: "))
}

pub(super) fn overlaps(
    rows: &[Value],
    commit: &Value,
    common: &Path,
    branch: &str,
    continuous: bool,
) -> Vec<Value> {
    let changed = files(commit);
    let at = timestamp(&commit["committedAt"]);
    let mut out = vec![];
    for row in rows {
        if row["commonDir"].as_str() != common.to_str() {
            continue;
        }
        let Some(end) = timestamp(&row["endedAt"]) else {
            continue;
        };
        if !at.is_some_and(|t| t > end && t <= end + chrono::Duration::days(14)) {
            continue;
        }
        if !is_fix(string(commit, "message")) && !linked(string(commit, "message"), row) {
            continue;
        }
        let observed = files(row);
        let overlap: Vec<_> = observed.intersection(&changed).copied().collect();
        if overlap.is_empty() {
            continue;
        }
        let shared = rows.iter().any(|other| {
            (other["threadId"] != row["threadId"] || other["turnId"] != row["turnId"])
                && other["commonDir"] == row["commonDir"]
                && timestamp(&other["capturedAt"]).is_some_and(|t| t <= at.unwrap())
                && (overlap.iter().any(|path| files(other).contains(path))
                    || (!other["files"].is_array()
                        && timestamp(&other["endedAt"])
                            .zip(timestamp(&row["capturedAt"]))
                            .is_none_or(|(end, start)| end >= start)))
        });
        let reliable = continuous
            && row["dirty"] == false
            && row["renamed"] != true
            && commit["renamed"] != true
            && row["files"].is_array()
            && !shared;
        out.push(
            json!({"threadId":row["threadId"],"turnId":row["turnId"],"commit":commit["commit"],
            "ref":branch,"overlapCount":if reliable {json!(overlap.len())} else {Value::Null},
            "coverage":if reliable {"bounded"} else {"unknown"}}),
        );
    }
    out
}

pub(super) async fn observe(
    root: &Path,
    common: &Path,
    branch: &str,
    before: &str,
    after: &str,
    continuous: bool,
    rows: &[Value],
    store: &Path,
) -> Result<()> {
    let cwd = root.to_str().ok_or("unreachable")?;
    let range = format!("{before}..{after}");
    let log = crate::projects::git(
        cwd,
        vec!["log".into(), "-65".into(), "--format=%H".into(), range],
    )
    .await?;
    let ids: Vec<_> = log.lines().collect();
    let complete = continuous && ids.len() <= MAX_COMMITS && rows.len() < 128;
    let mut correlations = vec![];
    for oid in ids.into_iter().take(MAX_COMMITS) {
        let raw = crate::projects::git(
            cwd,
            vec![
                "show".into(),
                "--format=%cI%x00%B%x00".into(),
                "--name-status".into(),
                "-z".into(),
                "--find-renames".into(),
                oid.into(),
                "--".into(),
            ],
        )
        .await?;
        if raw.len() > 256 * 1024 {
            return Err("fix-evidence-capacity".into());
        }
        let mut parts = raw.splitn(3, '\0');
        let at = parts.next().unwrap_or("");
        let message = parts.next().unwrap_or("");
        if !is_fix(message) && !rows.iter().any(|r| linked(message, r)) {
            continue;
        }
        let mut paths = vec![];
        let mut renamed = false;
        let mut tokens = parts
            .next()
            .unwrap_or("")
            .split('\0')
            .filter(|s| !s.is_empty());
        while let Some(status) = tokens.next() {
            let status = status.trim();
            if status.starts_with(['R', 'C']) {
                renamed = true;
                if let Some(path) = tokens.next() {
                    paths.push(json!({"path":path}));
                }
                if let Some(path) = tokens.next() {
                    paths.push(json!({"path":path}));
                }
            } else if let Some(path) = tokens.next() {
                paths.push(json!({"path":path}));
            }
        }
        let commit = json!({"commit":oid,"committedAt":at,"message":message,"files":paths,"renamed":renamed});
        correlations.extend(overlaps(rows, &commit, common, branch, complete));
    }
    let _guard = WRITER.lock().map_err(|e| e.to_string())?;
    let mut state = if store.exists() {
        crate::kernel::file_cache::load(store)?
    } else {
        json!({"correlations":[]})
    };
    let entries = state["correlations"]
        .as_array_mut()
        .ok_or("fix-correlation-state-unavailable")?;
    for entry in correlations {
        if !entries.iter().any(|e| {
            e["threadId"] == entry["threadId"]
                && e["turnId"] == entry["turnId"]
                && e["commit"] == entry["commit"]
        }) {
            entries.push(entry);
        }
    }
    if entries.len() > MAX_CORRELATIONS {
        entries.drain(..entries.len() - MAX_CORRELATIONS);
    }
    state["coverage"] = json!("bounded");
    save(store, &state)
}

pub(crate) fn summary(rows: &[Value], store: &Path) -> Value {
    let state = if store.exists() {
        crate::kernel::file_cache::load(store).ok()
    } else {
        None
    };
    let selected: BTreeSet<_> = rows
        .iter()
        .inspect(|_| crate::runtime_metrics::cost::rows(1))
        .map(|r| (string(r, "threadId"), string(r, "turnId")))
        .collect();
    let entries: Vec<_> = state
        .as_ref()
        .and_then(|s| s["correlations"].as_array())
        .into_iter()
        .flatten()
        .take(MAX_CORRELATIONS)
        .inspect(|_| crate::runtime_metrics::cost::rows(1))
        .filter(|c| selected.contains(&(string(c, "threadId"), string(c, "turnId"))))
        .cloned()
        .collect();
    json!({"kind":"correlation","coverage":if entries.is_empty(){"unknown"}else{"bounded"},
        "matches":entries.iter().filter(|e|e["overlapCount"].as_u64().is_some_and(|n|n>0)).count(),
        "unknown":entries.iter().filter(|e|e["coverage"] == "unknown").count(),
        "retained":entries.len(),"details":entries.into_iter().take(16).collect::<Vec<_>>(),"limit":MAX_CORRELATIONS,
        "interpretation":"Fix-path overlap is correlation only; unobserved history remains unknown."})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn later_fix_overlap_is_bounded_and_ambiguous_evidence_stays_unknown() {
        // Regression: D4d later fixes need path overlap within fourteen days without attributing shared, dirty or renamed files.
        let row = json!({"commonDir":"/repo","ref":"refs/heads/wt/lane","threadId":"thread","turnId":"turn","capturedAt":"2026-01-01T00:00:00Z","endedAt":"2026-01-02T00:00:00Z","dirty":false,"files":[{"path":"a.rs"}]});
        let commit = json!({"commit":"fix-sha","committedAt":"2026-01-03T00:00:00Z","message":"fix(core): repair","files":[{"path":"a.rs"}]});
        let run = |rows: &[Value], c: &Value, continuous| {
            overlaps(rows, c, Path::new("/repo"), "refs/heads/main", continuous)
        };
        let found = run(&[row.clone()], &commit, true);
        assert_eq!(found[0]["overlapCount"], 1);
        assert_eq!(found[0]["coverage"], "bounded");
        let mut unrelated = commit.clone();
        unrelated["files"] = json!([{"path":"b.rs"}]);
        assert!(run(&[row.clone()], &unrelated, true).is_empty());
        let mut outside = commit.clone();
        outside["committedAt"] = json!("2026-01-17T00:00:01Z");
        assert!(run(&[row.clone()], &outside, true).is_empty());
        let mut feature = commit.clone();
        feature["message"] = json!("feat(core): extend");
        assert!(run(&[row.clone()], &feature, true).is_empty());
        feature["message"] = json!("feat(core): extend\n\nARC-Turn: turn");
        assert_eq!(run(&[row.clone()], &feature, true)[0]["overlapCount"], 1);
        for field in ["dirty", "renamed"] {
            let mut ambiguous = row.clone();
            ambiguous[field] = json!(true);
            assert!(run(&[ambiguous], &commit, true)[0]["overlapCount"].is_null());
        }
        let mut other = row.clone();
        other["turnId"] = json!("other");
        assert!(run(&[row.clone(), other], &commit, true)
            .iter()
            .all(|r| r["coverage"] == "unknown"));
        assert_eq!(run(&[row], &commit, false)[0]["coverage"], "unknown");
    }
    #[tokio::test]
    async fn watched_commit_range_retains_overlap_and_ignores_unrelated_fix() {
        // Regression: D4d watcher must parse real Git fix paths and expose bounded correlations without retaining paths.
        struct Sandbox(PathBuf);
        impl Drop for Sandbox {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let dir = Sandbox(std::env::temp_dir().join(format!("arc-fix-correlation-{}", id())));
        std::fs::create_dir_all(&dir.0).unwrap();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args([
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "-C",
                ])
                .arg(&dir.0)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        git(&["init", "-b", "main"]);
        std::fs::write(dir.0.join("a.rs"), "initial\n").unwrap();
        git(&["add", "a.rs"]);
        git(&["commit", "-m", "feat: initial"]);
        let mut baseline = crate::changes::capture(dir.0.to_str().unwrap()).await;
        let before = baseline["head"].as_str().unwrap().to_owned();
        let common = PathBuf::from(baseline["commonDir"].as_str().unwrap());
        baseline["threadId"] = json!("fixture-thread");
        baseline["turnId"] = json!("fixture-turn");
        baseline["capturedAt"] =
            json!((chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339());
        baseline["endedAt"] =
            json!((chrono::Utc::now() - chrono::Duration::minutes(30)).to_rfc3339());
        baseline["files"] = json!([{"path":"a.rs"}]);
        std::fs::write(dir.0.join("a.rs"), "fixed\n").unwrap();
        git(&["add", "a.rs"]);
        git(&["commit", "-m", "fix(core): repair"]);
        let fix = git(&["rev-parse", "HEAD"]);
        std::fs::write(dir.0.join("b.rs"), "unrelated\n").unwrap();
        git(&["add", "b.rs"]);
        git(&["commit", "-m", "fix(core): unrelated"]);
        let after = git(&["rev-parse", "HEAD"]);
        let store = dir.0.join("correlations.json");
        let rows = [baseline.clone()];
        observe(
            &dir.0,
            &common,
            "refs/heads/main",
            &before,
            &after,
            true,
            &rows,
            &store,
        )
        .await
        .unwrap();
        let result = summary(&rows, &store);
        assert_eq!(result["matches"], 1);
        assert_eq!(result["details"][0]["commit"], fix);
        assert_eq!(result["details"][0]["overlapCount"], 1);
        assert_eq!(result["details"][0]["coverage"], "bounded");
        observe(
            &dir.0,
            &common,
            "refs/heads/main",
            &before,
            &after,
            true,
            &rows,
            &store,
        )
        .await
        .unwrap();
        assert_eq!(summary(&rows, &store)["matches"], 1);
        git(&["mv", "a.rs", "renamed.rs"]);
        git(&["commit", "-m", "fix(core): rename"]);
        let renamed = git(&["rev-parse", "HEAD"]);
        observe(
            &dir.0,
            &common,
            "refs/heads/main",
            &after,
            &renamed,
            true,
            &rows,
            &store,
        )
        .await
        .unwrap();
        let result = summary(&rows, &store);
        assert_eq!(result["matches"], 1);
        assert_eq!(result["unknown"], 1);
    }
}
