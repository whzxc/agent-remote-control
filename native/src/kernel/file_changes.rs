//! Changed-path queue for derived indexes. Watch failures are explicit repair boundaries.
use crate::*;
use notify::Watcher;
use std::collections::BTreeSet;

pub(crate) fn physical(path: &Path) -> PathBuf {
    if let Ok(path) = path.canonicalize() {
        return path;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => physical(parent).join(name),
        _ => path.into(),
    }
}
#[derive(Default)]
struct Pending {
    paths: BTreeSet<PathBuf>,
    files: BTreeSet<PathBuf>,
    discovery: BTreeSet<PathBuf>,
    owned: std::collections::HashMap<PathBuf, Option<Option<super::file_cache::Stamp>>>,
    failed: bool,
    wake: Option<Arc<tokio::sync::Notify>>,
}
impl Pending {
    fn accepts(&self, path: &Path) -> bool {
        if path
            .components()
            .any(|part| part.as_os_str() == ".activity-index")
        {
            return false;
        }
        if let Some(stamp) = self.owned.get(path) {
            if stamp.is_none()
                || stamp.as_ref() == Some(&super::file_cache::Stamp::read(path).ok().flatten())
            {
                return false;
            }
        }
        self.files.contains(path)
            || (path.extension().is_some_and(|e| e == "json")
                && path.parent().is_some_and(|p| self.discovery.contains(p)))
    }
}
pub(crate) struct OwnWrite {
    path: PathBuf,
    pending: Arc<std::sync::Mutex<Pending>>,
}
impl Drop for OwnWrite {
    fn drop(&mut self) {
        self.pending.lock().unwrap().owned.insert(
            self.path.clone(),
            Some(super::file_cache::Stamp::read(&self.path).ok().flatten()),
        );
    }
}
static QUEUES: std::sync::LazyLock<
    std::sync::Mutex<Vec<std::sync::Weak<std::sync::Mutex<Pending>>>>,
> = std::sync::LazyLock::new(Default::default);
pub(crate) fn changed(path: &Path) {
    let path = physical(path);
    let mut queues = QUEUES.lock().unwrap();
    queues.retain(|queue| {
        let Some(queue) = queue.upgrade() else {
            return false;
        };
        let mut queue = queue.lock().unwrap();
        if queue.accepts(&path) {
            queue.paths.insert(path.clone());
            if let Some(wake) = &queue.wake {
                wake.notify_one();
            }
        }
        true
    });
}
pub(crate) struct Watch {
    watcher: Option<notify::RecommendedWatcher>,
    directories: BTreeSet<PathBuf>,
    files: std::collections::HashMap<PathBuf, PathBuf>,
    pending: Arc<std::sync::Mutex<Pending>>,
    pub wake: Arc<tokio::sync::Notify>,
}
impl Default for Watch {
    fn default() -> Self {
        let pending = Arc::new(std::sync::Mutex::new(Pending::default()));
        QUEUES.lock().unwrap().push(Arc::downgrade(&pending));
        let queue = pending.clone();
        let wake = Arc::new(tokio::sync::Notify::new());
        pending.lock().unwrap().wake = Some(wake.clone());
        let signal = wake.clone();
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let mut queue = queue.lock().unwrap();
            match event {
                Ok(event) if !matches!(event.kind, notify::EventKind::Access(_)) => {
                    queue.failed |= event.need_rescan();
                    let paths: Vec<_> = event
                        .paths
                        .into_iter()
                        .filter(|path| queue.accepts(path))
                        .collect();
                    if paths.is_empty() && !queue.failed {
                        return;
                    }
                    queue.paths.extend(paths);
                }
                Err(_) => queue.failed = true,
                _ => return,
            }
            signal.notify_one();
        })
        .ok();
        pending.lock().unwrap().failed = watcher.is_none();
        Self {
            watcher,
            directories: Default::default(),
            files: Default::default(),
            pending,
            wake,
        }
    }
}
impl Watch {
    pub fn add(&mut self, path: &Path) {
        let path = physical(path);
        if self.files.contains_key(&path) {
            return;
        }
        let desired = path.parent().unwrap_or(&path);
        {
            let mut pending = self.pending.lock().unwrap();
            pending.files.insert(path.clone());
            if path.file_name().is_some_and(|name| name == ".index-watch") {
                pending.discovery.insert(desired.into());
            }
        }
        let mut parent = desired;
        while !parent.is_dir() {
            let Some(next) = parent.parent() else { return };
            parent = next;
        }
        self.files.insert(path.clone(), parent.into());
        if self.directories.insert(parent.into()) {
            if self.watcher.as_mut().is_none_or(|watcher| {
                watcher
                    .watch(
                        parent,
                        if parent == desired {
                            notify::RecursiveMode::NonRecursive
                        } else {
                            notify::RecursiveMode::Recursive
                        },
                    )
                    .is_err()
            }) {
                self.pending.lock().unwrap().failed = true;
            }
        }
    }
    pub fn remove(&mut self, path: &Path) {
        let path = physical(path);
        {
            let mut pending = self.pending.lock().unwrap();
            pending.files.remove(&path);
            pending.owned.remove(&path);
            if path.file_name().is_some_and(|name| name == ".index-watch") {
                if let Some(parent) = path.parent() {
                    pending.discovery.remove(parent);
                }
            }
        }
        if let Some(parent) = self.files.remove(&path) {
            if !self.files.values().any(|p| p == &parent) {
                self.directories.remove(&parent);
                if let Some(watcher) = &mut self.watcher {
                    let _ = watcher.unwatch(&parent);
                }
            }
        }
    }
    pub fn own_write(&self, path: &Path) -> OwnWrite {
        let path = physical(path);
        let mut pending = self.pending.lock().unwrap();
        pending.owned.insert(path.clone(), None);
        pending.paths.remove(&path);
        OwnWrite {
            path,
            pending: self.pending.clone(),
        }
    }
    pub fn drain(&self) -> (BTreeSet<PathBuf>, bool) {
        let mut queue = self.pending.lock().unwrap();
        (std::mem::take(&mut queue.paths), queue.failed)
    }
}

pub(crate) fn diagnostics() -> Value {
    let queues = QUEUES.lock().unwrap();
    let live: Vec<_> = queues.iter().filter_map(|q| q.upgrade()).collect();
    json!({"watchers":live.len(),"coverageGaps":live.iter().filter(|q| q.lock().unwrap().failed).count()})
}

/// Discovery repair visits at most `limit` directory candidates per batch.
pub(crate) fn repair_paths(
    directory: &Path,
    cursor: &mut Option<std::fs::ReadDir>,
    limit: usize,
) -> Result<Vec<PathBuf>> {
    if cursor.is_none() {
        *cursor = Some(std::fs::read_dir(directory).map_err(|e| e.to_string())?);
    }
    let mut paths = Vec::new();
    for _ in 0..limit {
        match cursor.as_mut().unwrap().next() {
            Some(entry) => paths.push(entry.map_err(|e| e.to_string())?.path()),
            None => {
                *cursor = None;
                break;
            }
        }
    }
    Ok(paths)
}
