//! Bounded read caches. File stamps detect external changes; owned writes update indexes.
use crate::*;
use serde::de::DeserializeOwned;
use std::{collections::HashMap, fs::FileType, sync::LazyLock, time::SystemTime};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stamp {
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    len: u64,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}
impl Stamp {
    pub fn read(path: &Path) -> Result<Option<Self>> {
        let metadata = match std::fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        Ok(Some(Self::from_metadata(&metadata)))
    }
    pub fn appends_to(&self, other: &Self) -> bool {
        if self.len <= other.len {
            return false;
        }
        #[cfg(unix)]
        {
            self.identity.0 == other.identity.0 && self.identity.1 == other.identity.1
        }
        #[cfg(not(unix))]
        {
            self.created == other.created
        }
    }
    pub fn from_metadata(metadata: &std::fs::Metadata) -> Self {
        Self {
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
            len: metadata.len(),
            #[cfg(unix)]
            identity: {
                use std::os::unix::fs::MetadataExt;
                (
                    metadata.dev(),
                    metadata.ino(),
                    metadata.ctime(),
                    metadata.ctime_nsec(),
                )
            },
        }
    }
}
#[derive(Clone)]
pub struct Entry {
    pub path: PathBuf,
    pub kind: FileType,
}
struct File<T> {
    stamp: Stamp,
    value: Arc<T>,
    used: u64,
}
struct Directory {
    stamp: Option<Stamp>,
    entries: Arc<Vec<Entry>>,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Io {
    pub file_opens: u64,
    pub directory_reads: u64,
}
#[cfg(test)]
thread_local! { static THREAD_IO: std::cell::Cell<Io> = std::cell::Cell::new(Io::default()); }
#[cfg(test)]
pub(crate) fn thread_io() -> Io {
    THREAD_IO.get()
}
fn count_io(file: bool) {
    #[cfg(test)]
    THREAD_IO.with(|counter| {
        let mut io = counter.get();
        if file {
            io.file_opens += 1
        } else {
            io.directory_reads += 1
        }
        counter.set(io);
    });
    #[cfg(not(test))]
    let _ = file;
}
/// Cache contents are immutable snapshots. No lock or file handle escapes a read.
pub struct Cache<T> {
    files: HashMap<PathBuf, File<T>>,
    directories: HashMap<PathBuf, Directory>,
    bytes: u64,
    clock: u64,
    io: Io,
}
impl<T> Default for Cache<T> {
    fn default() -> Self {
        Self {
            files: HashMap::new(),
            directories: HashMap::new(),
            bytes: 0,
            clock: 0,
            io: Io::default(),
        }
    }
}
impl<T> Cache<T> {
    pub fn diagnostics(&self) -> Value {
        json!({"files":self.files.len(),"directories":self.directories.len(),
            "sourceBytes":self.bytes,"sourceByteLimit":32*1024*1024,"fileLimit":8192,
            "fileOpens":self.io.file_opens,"directoryReads":self.io.directory_reads})
    }
    pub fn io(&self) -> Io {
        self.io
    }
    /// Directories written by Core must call changed after successful writes/removals.
    /// External directories are refreshed when their metadata changes.
    pub fn entries(&mut self, path: &Path) -> Result<Arc<Vec<Entry>>> {
        let stamp = Stamp::read(path)?;
        if let Some(cached) = self.directories.get(path).filter(|v| v.stamp == stamp) {
            return Ok(cached.entries.clone());
        }
        let mut entries = Vec::new();
        if stamp.is_some() {
            self.io.directory_reads += 1;
            count_io(false);
            for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                entries.push(Entry {
                    path: entry.path(),
                    kind: entry.file_type().map_err(|e| e.to_string())?,
                });
            }
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        let entries = Arc::new(entries);
        // Do not claim changes that raced enumeration were included in this snapshot.
        if Stamp::read(path)? == stamp {
            if self.directories.len() >= 2048 && !self.directories.contains_key(path) {
                self.directories.clear();
            }
            self.directories.insert(
                path.into(),
                Directory {
                    stamp,
                    entries: entries.clone(),
                },
            );
        }
        Ok(entries)
    }
    /// Invalidate only the changed record and update an already indexed owned directory.
    pub fn changed(&mut self, path: &Path, before: Option<Stamp>) {
        if let Some(old) = self.files.remove(path) {
            self.bytes -= old.stamp.len;
        }
        let Some(parent) = path.parent() else { return };
        if self
            .directories
            .get(parent)
            .is_some_and(|directory| directory.stamp != before)
        {
            self.directories.remove(parent);
        }
        if let Some(directory) = self.directories.get_mut(parent) {
            let entries = Arc::make_mut(&mut directory.entries);
            entries.retain(|entry| entry.path != path);
            if let Ok(metadata) = std::fs::symlink_metadata(path) {
                entries.push(Entry {
                    path: path.into(),
                    kind: metadata.file_type(),
                });
                entries.sort_by(|a, b| a.path.cmp(&b.path));
            }
            // Core owns these directories under its state lock. External trees never
            // use this write hook and retain ordinary stamp-based discovery.
            match Stamp::read(parent) {
                Ok(stamp) => directory.stamp = stamp,
                Err(_) => {
                    self.directories.remove(parent);
                }
            }
        }
    }
}
impl<T> Cache<T> {
    /// Publish only while the owning store serializes the write and cache update.
    pub fn written(&mut self, path: &Path, before: Option<Stamp>, value: T) -> Result<()> {
        self.changed(path, before);
        if let Some(stamp) = Stamp::read(path)? {
            if stamp.len <= 32 * 1024 * 1024 {
                self.make_room(stamp.len);
                self.clock += 1;
                self.bytes += stamp.len;
                self.files.insert(
                    path.into(),
                    File {
                        stamp,
                        value: Arc::new(value),
                        used: self.clock,
                    },
                );
            }
        }
        Ok(())
    }
    fn make_room(&mut self, bytes: u64) {
        while self.bytes + bytes > 32 * 1024 * 1024 || self.files.len() >= 8192 {
            let Some(oldest) = self
                .files
                .iter()
                .min_by_key(|(_, v)| v.used)
                .map(|(p, _)| p.clone())
            else {
                break;
            };
            self.bytes -= self.files.remove(&oldest).unwrap().stamp.len;
        }
    }
}
impl<T: DeserializeOwned> Cache<T> {
    pub fn read(&mut self, path: &Path) -> Result<Arc<T>> {
        let stamp =
            Stamp::read(path)?.ok_or_else(|| format!("File not found: {}", path.display()))?;
        self.clock += 1;
        if let Some(cached) = self.files.get_mut(path).filter(|v| v.stamp == stamp) {
            cached.used = self.clock;
            return Ok(cached.value.clone());
        }
        self.io.file_opens += 1;
        count_io(true);
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        let value: Arc<T> =
            Arc::new(serde_json::from_slice(&bytes).map_err(|e| format!("INVALID_JSON: {e}"))?);
        if let Some(old) = self.files.remove(path) {
            self.bytes -= old.stamp.len;
        }
        // Cache only a stable read, including across atomic replacement/truncation.
        if stamp.len <= 32 * 1024 * 1024 && Stamp::read(path)?.as_ref() == Some(&stamp) {
            self.make_room(stamp.len);
            self.bytes += stamp.len;
            self.files.insert(
                path.into(),
                File {
                    stamp,
                    value: value.clone(),
                    used: self.clock,
                },
            );
        }
        Ok(value)
    }
}
/// A derived collection is reused only while every owning directory is unchanged.
#[derive(Default)]
pub struct Projection<T> {
    snapshot: Option<(Vec<Option<Stamp>>, T)>,
}
impl<T: Clone> Projection<T> {
    pub fn stamps(paths: &[PathBuf]) -> Result<Vec<Option<Stamp>>> {
        paths.iter().map(|path| Stamp::read(path)).collect()
    }
    pub fn get(&self, stamps: &[Option<Stamp>]) -> Option<T> {
        self.snapshot
            .as_ref()
            .filter(|(old, _)| old == stamps)
            .map(|(_, value)| value.clone())
    }
    pub fn set(&mut self, paths: &[PathBuf], before: Vec<Option<Stamp>>, value: T) -> Result<()> {
        if Self::stamps(paths)? == before {
            self.snapshot = Some((before, value));
        }
        Ok(())
    }
}
static JSON: LazyLock<std::sync::Mutex<Cache<Value>>> = LazyLock::new(Default::default);
pub(crate) fn diagnostics() -> Value {
    JSON.lock()
        .map(|cache| cache.diagnostics())
        .unwrap_or(Value::Null)
}
pub(crate) fn shared_load(path: &Path) -> Result<Arc<Value>> {
    JSON.lock().map_err(|e| e.to_string())?.read(path)
}
pub(crate) fn load(path: &Path) -> Result<Value> {
    Ok((*shared_load(path)?).clone())
}
pub(crate) fn entries(path: &Path) -> Result<Arc<Vec<Entry>>> {
    JSON.lock().map_err(|e| e.to_string())?.entries(path)
}
pub(crate) fn changed(path: &Path, before: Option<Stamp>) {
    if let Ok(mut cache) = JSON.lock() {
        cache.changed(path, before);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("arc-read-cache-{}", id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn unchanged_polls_open_no_files_and_writes_refresh_only_the_changed_record() {
        // Regression: receipt, dispatch and notification polls reopened every historical JSON record.
        for count in [24, 458, 3077] {
            let dir = Sandbox::new();
            for n in 0..count {
                save(&dir.0.join(format!("{n}.json")), &json!({"sequence":n})).unwrap();
            }
            let mut cache = Cache::<Value>::default();
            let poll = |cache: &mut Cache<Value>| {
                cache
                    .entries(&dir.0)
                    .unwrap()
                    .iter()
                    .map(|entry| {
                        cache.read(&entry.path).unwrap()["sequence"]
                            .as_u64()
                            .unwrap()
                    })
                    .sum::<u64>()
            };
            let sum = poll(&mut cache);
            assert_eq!(sum, count * (count - 1) / 2);
            let baseline = cache.io();
            for _ in 0..3 {
                assert_eq!(poll(&mut cache), sum);
            }
            assert_eq!(cache.io(), baseline);
            let changed = dir.0.join("0.json");
            let before = Stamp::read(&dir.0).unwrap();
            save(&changed, &json!({"sequence":count})).unwrap();
            cache.changed(&changed, before);
            assert_eq!(poll(&mut cache), sum + count);
            assert_eq!(cache.io().file_opens - baseline.file_opens, 1);
            assert_eq!(cache.io().directory_reads - baseline.directory_reads, 0);
            let before = Stamp::read(&dir.0).unwrap();
            std::fs::remove_file(&changed).unwrap();
            cache.changed(&changed, before);
            assert_eq!(poll(&mut cache), sum);
        }
    }
    #[test]
    fn task_projection_invalidates_when_receipts_runtime_or_owner_change() {
        // Regression: task/status polls rebuilt every receipt projection even when task facts were unchanged.
        let dir = Sandbox::new();
        let dependencies = [
            dir.0.join("receipts"),
            dir.0.join("runtime"),
            dir.0.join("owners"),
        ];
        for path in &dependencies {
            std::fs::create_dir_all(path).unwrap();
        }
        let mut projection = Projection::<Value>::default();
        let stamps = Projection::<Value>::stamps(&dependencies).unwrap();
        projection
            .set(&dependencies, stamps.clone(), json!({"state":"completed"}))
            .unwrap();
        assert_eq!(projection.get(&stamps).unwrap()["state"], "completed");
        for path in &dependencies {
            let before = Projection::<Value>::stamps(&dependencies).unwrap();
            projection
                .set(&dependencies, before.clone(), json!({"state":"completed"}))
                .unwrap();
            save(&path.join("record.json"), &json!({"state":"running"})).unwrap();
            let after = Projection::<Value>::stamps(&dependencies).unwrap();
            assert!(projection.get(&after).is_none());
            // A write racing collection construction cannot publish a stale projection.
            projection
                .set(&dependencies, before, json!({"state":"completed"}))
                .unwrap();
            assert!(projection.get(&after).is_none());
        }
    }
    #[test]
    fn external_changes_and_failed_reads_are_not_hidden_by_cached_snapshots() {
        // Regression: a cached collection must discover external creation, replacement, truncation and deletion.
        let dir = Sandbox::new();
        let mut cache = Cache::<Value>::default();
        assert!(cache.entries(&dir.0).unwrap().is_empty());
        let path = dir.0.join("record.json");
        save(&path, &json!({"state":"before"})).unwrap();
        assert_eq!(cache.entries(&dir.0).unwrap().len(), 1);
        assert_eq!(cache.read(&path).unwrap()["state"], "before");
        save(&path, &json!({"state":"after"})).unwrap();
        assert_eq!(cache.read(&path).unwrap()["state"], "after");
        std::fs::write(&path, b"{").unwrap();
        assert!(cache.read(&path).is_err());
        save(&path, &json!({"state":"repaired"})).unwrap();
        assert_eq!(cache.read(&path).unwrap()["state"], "repaired");
        std::fs::remove_file(&path).unwrap();
        assert!(cache.read(&path).is_err());
        assert!(cache.entries(&dir.0).unwrap().is_empty());
    }
}
