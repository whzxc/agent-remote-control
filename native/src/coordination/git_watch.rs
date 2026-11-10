//! Bounded native ref reads. No Git subprocess runs on an unchanged idle poll.
use super::*;
use crate::kernel::file_cache::Stamp;
use std::{
    collections::BTreeMap,
    sync::{LazyLock, Mutex},
    time::Duration,
};
const MAX_REFS: usize = 128;
const MAX_BYTES: u64 = 256 * 1024;
static BASELINES: LazyLock<Mutex<Vec<Value>>> = LazyLock::new(Default::default);
pub(crate) fn baseline(row: &Value) {
    let mut rows = BASELINES.lock().unwrap();
    if rows.len() >= 128 {
        rows.remove(0);
        observers::gap("baselines", "capacity");
    }
    rows.push(row.clone());
}
pub(super) fn terminal(thread: &str, turn: &str) {
    for row in BASELINES
        .lock()
        .unwrap()
        .iter_mut()
        .filter(|r| r["threadId"] == thread && r["turnId"] == turn)
    {
        if row["endedAt"].is_null() {
            row["endedAt"] = json!(now());
        }
    }
}
#[derive(Default)]
pub(super) struct RefReader {
    files: BTreeMap<PathBuf, (Option<Stamp>, String)>,
    pub opens: usize,
    cached_bytes: usize,
    directories: BTreeMap<PathBuf, (Option<Stamp>, Vec<PathBuf>)>,
    pub directory_opens: usize,
}
impl RefReader {
    fn read(&mut self, path: &Path) -> Result<String> {
        let stamp = Stamp::read(path)?;
        if let Some((_, value)) = self.files.get(path).filter(|(s, _)| *s == stamp) {
            crate::runtime_metrics::cost::cache(true);
            return Ok(value.clone());
        }
        crate::runtime_metrics::cost::cache(false);
        let value = if stamp.is_none() {
            String::new()
        } else {
            use std::io::Read;
            self.opens += 1;
            let mut value = String::new();
            std::fs::File::open(path)
                .map_err(|e| e.to_string())?
                .take(MAX_BYTES + 1)
                .read_to_string(&mut value)
                .map_err(|e| e.to_string())?;
            crate::runtime_metrics::cost::bytes_read(value.len());
            crate::runtime_metrics::cost::bytes_parsed(value.len());
            if value.len() as u64 > MAX_BYTES {
                return Err("ref-bytes-capacity".into());
            }
            value
        };
        if Stamp::read(path)? != stamp {
            return Err("refs-changing".into());
        }
        if let Some((_, old)) = self.files.remove(path) {
            self.cached_bytes -= old.len();
        }
        if self.files.len() >= 8192 || self.cached_bytes + value.len() > 16 * 1024 * 1024 {
            self.files.clear();
            self.cached_bytes = 0;
            observers::gap("git", "ref-cache-capacity");
        }
        self.cached_bytes += value.len();
        self.files.insert(path.into(), (stamp, value.clone()));
        Ok(value)
    }
    pub(super) fn common(&mut self, root: &Path) -> Result<PathBuf> {
        let git = root.join(".git");
        let git = if git.is_dir() {
            git
        } else {
            let value = self.read(&git)?;
            root.join(value.trim().strip_prefix("gitdir: ").ok_or("unreachable")?)
        };
        let common = self.read(&git.join("commondir"))?;
        let path = if common.trim().is_empty() {
            git
        } else {
            git.join(common.trim())
        };
        path.canonicalize().map_err(|_| "unreachable".into())
    }
    pub(super) fn refs(&mut self, common: &Path) -> Result<BTreeMap<String, String>> {
        let mut refs = BTreeMap::new();
        let packed = self.read(&common.join("packed-refs"))?;
        for line in packed
            .lines()
            .inspect(|_| crate::runtime_metrics::cost::rows(1))
            .filter(|l| !l.starts_with(['#', '^']))
        {
            if let Some((oid, name)) = line.split_once(' ') {
                if watched(name) {
                    insert(&mut refs, name, oid)?;
                }
            }
        }
        let heads = common.join("refs/heads");
        let main = self.read(&heads.join("main"))?;
        if !main.is_empty() {
            insert(&mut refs, "refs/heads/main", main.trim())?;
        }
        let directory = heads.join("wt");
        let stamp = Stamp::read(&directory)?;
        if self
            .directories
            .get(&directory)
            .is_none_or(|(old, _)| *old != stamp)
        {
            let mut entries = vec![];
            if stamp.is_some() {
                self.directory_opens += 1;
                for entry in std::fs::read_dir(&directory)
                    .map_err(|_| "unreachable")?
                    .take(MAX_REFS + 1)
                {
                    let entry = entry.map_err(|_| "unreachable")?;
                    if entry.file_type().map_err(|_| "unreachable")?.is_dir() {
                        return Err("nested-lane-unsupported".into());
                    }
                    entries.push(entry.path());
                }
                if entries.len() > MAX_REFS {
                    return Err("ref-count-capacity".into());
                }
            }
            if Stamp::read(&directory)? != stamp {
                return Err("refs-changing".into());
            }
            if self.directories.len() >= 256 {
                self.directories.clear();
            }
            self.directories.insert(directory.clone(), (stamp, entries));
        }
        let entries = self.directories[&directory].1.clone();
        for entry in &entries {
            crate::runtime_metrics::cost::rows(1);
            let name = entry
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or("invalid-ref")?;
            if name.ends_with(".lock") {
                continue;
            }
            if types::identifier(name).is_err() {
                continue;
            }
            let oid = self.read(entry)?;
            if !oid.is_empty() {
                insert(&mut refs, &format!("refs/heads/wt/{name}"), oid.trim())?;
            }
        }
        Ok(refs)
    }
}
fn watched(name: &str) -> bool {
    name == "refs/heads/main"
        || name
            .strip_prefix("refs/heads/wt/")
            .is_some_and(|v| types::identifier(v).is_ok())
}
fn insert(refs: &mut BTreeMap<String, String>, name: &str, oid: &str) -> Result<()> {
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid-object-id".into());
    }
    refs.insert(name.into(), oid.into());
    if refs.len() > MAX_REFS {
        return Err("ref-count-capacity".into());
    }
    Ok(())
}
#[derive(Default)]
pub(super) struct Watcher {
    reader: std::sync::Arc<Mutex<RefReader>>,
    inflight: Option<tokio::task::JoinHandle<Result<RefSnapshot>>>,
    boot_seen: BTreeMap<String, String>,
}
pub(super) fn correlate(
    rows: &[Value],
    common: &Path,
    branch: &str,
    old: Option<&String>,
    since: &str,
    ancestry: bool,
) -> Attribution {
    let mut threads = std::collections::BTreeSet::new();
    let mut candidates = 0;
    if ancestry {
        for row in rows {
            if row["commonDir"].as_str() == common.to_str()
                && row["ref"] == branch
                && row["head"].as_str() == old.map(String::as_str)
                && !string(row, "capturedAt").is_empty()
                && (row["endedAt"].is_null() || string(row, "endedAt") >= since)
            {
                if types::identifier(string(row, "threadId")).is_ok() {
                    candidates += 1;
                    threads.insert(string(row, "threadId").to_owned());
                }
            }
        }
    }
    let confidence = match candidates {
        0 => AttributionConfidence::Unknown,
        1 => AttributionConfidence::Correlated,
        _ => AttributionConfidence::Ambiguous,
    };
    Attribution {
        confidence,
        thread_ids: threads.into_iter().take(16).collect(),
    }
}
impl Watcher {
    pub(super) async fn poll(&mut self) {
        self.poll_in(
            &root().join("coordination/projects.json"),
            &root().join("coordination/ref-watch"),
            &super::emit,
        )
        .await;
    }
    pub(super) async fn poll_in(
        &mut self,
        catalog: &Path,
        store: &Path,
        emit: &(dyn Fn(EventInput) -> Result<Value> + Sync),
    ) {
        let snapshot = match crate::kernel::file_cache::load(catalog) {
            Ok(v) if v["projects"].is_array() => v,
            _ => {
                observers::gap("git", "project-catalog-unavailable");
                return;
            }
        };
        observers::registry_age(snapshot["observedAt"].clone());
        // Startup can precede the first ordinary project/list read. Recovery must
        // replace the current gap while preserving its history in lastGap.
        observers::gap("git", "observed");
        self.poll_registered_in(snapshot["projects"].as_array().unwrap(), store, emit)
            .await;
    }
    #[cfg(test)]
    pub(super) async fn poll_registered(&mut self, projects: &[Value]) {
        self.poll_registered_in(
            projects,
            &root().join("coordination/ref-watch"),
            &super::emit,
        )
        .await;
    }
    async fn poll_registered_in(
        &mut self,
        projects: &[Value],
        store: &Path,
        emit: &(dyn Fn(EventInput) -> Result<Value> + Sync),
    ) {
        if projects.len() > 32 {
            observers::gap("git", "project-count-capacity");
        }
        let mut root_count = 0;
        crate::runtime_metrics::cost::scan_set(projects.len().min(32));
        for project in projects.iter().take(32) {
            crate::runtime_metrics::cost::rows(1);
            let pid = string(project, "id");
            if types::identifier(pid).is_err() {
                continue;
            }
            for (index, root) in project["roots"]
                .as_array()
                .into_iter()
                .flatten()
                .take(8)
                .enumerate()
            {
                crate::runtime_metrics::cost::rows(1);
                root_count += 1;
                if root_count > 32 {
                    observers::gap("git", "root-count-capacity");
                    return;
                }
                let key = format!("{pid}-{index}");
                let result = tokio::time::timeout(
                    Duration::from_secs(2),
                    self.scan_in(pid, &key, Path::new(string(root, "path")), store, emit),
                )
                .await;
                match result {
                    Ok(Ok(())) => observers::gap(&key, "observed"),
                    Ok(Err(_)) => {
                        self.boot_seen.clear();
                        observers::gap(&key, "unreachable-or-ref-capacity");
                    }
                    Err(_) => {
                        self.boot_seen.clear();
                        observers::gap(&key, "deadline");
                    }
                }
            }
        }
    }
    pub(super) async fn scan_in(
        &mut self,
        pid: &str,
        key: &str,
        root: &Path,
        store: &Path,
        emit: &(dyn Fn(EventInput) -> Result<Value> + Sync),
    ) -> Result<()> {
        // A stalled network filesystem cannot accumulate blocking workers on later polls.
        if self.inflight.as_ref().is_some_and(|job| !job.is_finished()) {
            return Err("filesystem-read-in-progress".into());
        }
        if let Some(job) = self.inflight.take() {
            let _ = job.await;
        }
        let reader = self.reader.clone();
        let directory = root.to_path_buf();
        self.inflight = Some(tokio::task::spawn_blocking(
            crate::runtime_metrics::cost::blocking(move || {
                snapshot(&mut reader.lock().unwrap(), &directory)
            }),
        ));
        let observed = self
            .inflight
            .as_mut()
            .unwrap()
            .await
            .map_err(|_| "filesystem-worker-failed")?;
        self.inflight = None;
        let RefSnapshot {
            common,
            refs,
            head,
            identity,
        } = observed?;
        let repository_key = hash(format!("{pid}:{}", common.to_string_lossy()));
        let file = store.join(format!("{repository_key}.json"));
        let checkpoint = store.join(format!("{repository_key}.checkpoint.json"));
        let old = if file.exists() {
            crate::kernel::file_cache::load(&file)?
        } else {
            json!({})
        };
        if old.is_object() {
            observers::project_at(&file, &checkpoint, emit).or_else(|e| {
                if file.exists() {
                    Err(e)
                } else {
                    Ok(())
                }
            })?;
        }
        let previous: BTreeMap<String, String> =
            serde_json::from_value(old["refs"].clone()).unwrap_or_default();
        let continuous =
            self.boot_seen.contains_key(&repository_key) && old["identity"] == identity;
        let baselines = BASELINES.lock().unwrap().clone();
        let mut pending = vec![];
        if !old["refs"].is_null() && old["identity"] == identity {
            let names: std::collections::BTreeSet<_> = previous.keys().chain(refs.keys()).collect();
            for name in names {
                let before = previous.get(name);
                let after = refs.get(name);
                if before == after {
                    continue;
                }
                let ancestry = if let (Some(before), Some(after)) = (before, after) {
                    // A changed ref alone triggers one bounded, read-only ancestry command.
                    match crate::projects::git(
                        root.to_str().ok_or("unreachable")?,
                        vec![
                            "merge-base".into(),
                            "--is-ancestor".into(),
                            before.clone(),
                            after.clone(),
                        ],
                    )
                    .await
                    {
                        Ok(_) => Some(true),
                        Err(e) if e == "GIT_NOT_ANCESTOR" => Some(false),
                        Err(_) => None,
                    }
                } else {
                    Some(false)
                };
                let movement = match (before, after) {
                    (None, Some(_)) => RefMovement::Created,
                    (Some(_), None) => RefMovement::Deleted,
                    (_, _) if ancestry == Some(true) => RefMovement::Moved,
                    (_, _) if ancestry == Some(false) => RefMovement::NonFastForward,
                    _ => RefMovement::Unknown,
                };
                let resource = if let Some(lane) = name.strip_prefix("refs/heads/wt/") {
                    ResourceKey::lane(pid, lane)?
                } else {
                    ResourceKey::project(pid)?
                };
                let mut input = EventInput::new(id(), EventKind::GitRefMoved, vec![resource]);
                input.origin = Some(Principal::Arc);
                input.observation = Some(Observation {
                    old_oid: before.cloned(),
                    new_oid: after.cloned(),
                    movement: Some(movement),
                    ..Default::default()
                });
                input.attribution = Some(correlate(
                    &baselines,
                    &common,
                    name,
                    before,
                    self.boot_seen
                        .get(&repository_key)
                        .map(String::as_str)
                        .unwrap_or(""),
                    continuous && ancestry == Some(true),
                ));
                pending.push(input);
            }
        } else if !old["refs"].is_null() {
            observers::gap(key, "repository-replaced");
        }
        let head_state = if let Some(reference) = head.trim().strip_prefix("ref: ") {
            if refs.contains_key(reference) {
                "attached"
            } else if watched(reference) {
                "unborn"
            } else {
                "unwatched-branch"
            }
        } else if matches!(head.trim().len(), 40 | 64)
            && head.trim().bytes().all(|b| b.is_ascii_hexdigit())
        {
            "detached"
        } else {
            "unavailable"
        };
        observers::head_state(key, head_state);
        let row = json!({"refs":refs,"identity":identity,"headState":head_state,"observedAt":now(),"coordinationPending":pending});
        // Persist new ref values and all corresponding descriptors together before emission.
        if old["refs"] != row["refs"]
            || old["identity"] != row["identity"]
            || old["headState"] != row["headState"]
            || !pending.is_empty()
        {
            observers::durable(&file, &row)?;
            observers::project_at(&file, &checkpoint, emit)?;
        }
        self.boot_seen.insert(repository_key, now());
        Ok(())
    }
}

pub(super) fn active() -> bool {
    BASELINES
        .lock()
        .unwrap()
        .iter()
        .any(|v| v["endedAt"].is_null())
}

/// Consume an existing upstream read; the observer never starts app-server to enumerate projects.
pub(crate) fn registered(projects: &[Value]) {
    static WRITER: Mutex<()> = Mutex::new(());
    let _writer = WRITER.lock().unwrap();
    let path = root().join("coordination/projects.json");
    let projects:Vec<_>=projects.iter().take(33).map(|p|json!({"id":p["id"],"name":p["name"],"roots":p["roots"].as_array().into_iter().flatten().take(9).map(|r|json!({"path":r["path"]})).collect::<Vec<_>>()})).collect();
    let row = json!({"projects":projects,"observedAt":now()});
    if observers::durable(&path, &row).is_err() {
        observers::gap("git", "project-catalog-persistence-failed");
    }
}

struct RefSnapshot {
    common: PathBuf,
    refs: BTreeMap<String, String>,
    head: String,
    identity: String,
}
fn snapshot(reader: &mut RefReader, root: &Path) -> Result<RefSnapshot> {
    let common = reader.common(root)?;
    let refs = reader.refs(&common)?;
    let git = root.join(".git");
    let git = if git.is_dir() {
        git
    } else {
        root.join(
            reader
                .read(&git)?
                .trim()
                .strip_prefix("gitdir: ")
                .ok_or("unreachable")?,
        )
    };
    let head = reader.read(&git.join("HEAD"))?;
    let metadata = std::fs::metadata(&common).map_err(|_| "unreachable")?;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", metadata.dev(), metadata.ino())
    };
    #[cfg(not(unix))]
    let identity = format!("{:?}", metadata.created());
    Ok(RefSnapshot {
        common,
        refs,
        head,
        identity,
    })
}
