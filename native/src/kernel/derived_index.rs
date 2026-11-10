//! Disposable per-key metadata. Canonical owners serialize writes through this boundary.
use super::file_cache::Stamp;
use crate::runtime_metrics::cost::{self, Owner, Reason};
use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;

const VERSION: u32 = 1;
const BATCH: usize = 64;
static WRITERS: std::sync::LazyLock<
    std::sync::Mutex<BTreeMap<PathBuf, std::sync::Weak<std::sync::Mutex<()>>>>,
> = std::sync::LazyLock::new(Default::default);
fn writer(owner: &Path) -> Arc<std::sync::Mutex<()>> {
    let mut writers = WRITERS.lock().unwrap();
    writers.retain(|_, lock| lock.strong_count() > 0);
    let owner = super::file_changes::physical(owner);
    if let Some(lock) = writers.get(&owner).and_then(std::sync::Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(std::sync::Mutex::new(()));
    writers.insert(owner, Arc::downgrade(&lock));
    lock
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Entry {
    pub stamp: Option<Stamp>,
    pub row: Value,
}
#[derive(Serialize, Deserialize)]
struct Current {
    version: u32,
    generation: String,
    count: usize,
}
fn directory(owner: &Path) -> PathBuf {
    owner.join(".activity-index")
}
fn key(path: &Path) -> Result<String> {
    path.file_name()
        .and_then(|v| v.to_str())
        .map(str::to_owned)
        .ok_or_else(|| "INVALID_INDEX_KEY".into())
}
fn sync_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    std::fs::File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("INVALID_INDEX_PATH")?;
    private_dir(parent)?;
    let temp = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| e.to_string())?;
    sync_dir(parent)
}
fn write<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    atomic(path, &serde_json::to_vec(value).map_err(|e| e.to_string())?)
}
fn read<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    cost::bytes_read(bytes.len());
    cost::bytes_parsed(bytes.len());
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
fn current(owner: &Path) -> Result<Current> {
    let current: Current = read(&directory(owner).join("current.json"))?;
    if current.version != VERSION || uuid::Uuid::parse_str(&current.generation).is_err() {
        return Err("DERIVED_INDEX_VERSION: rebuild required".into());
    }
    Ok(current)
}
fn mark(path: &Path) -> Result<()> {
    let owner = path.parent().ok_or("INVALID_INDEX_PATH")?;
    atomic(&directory(owner).join("dirty").join(key(path)?), b"dirty")?;
    sync_dir(&directory(owner))?;
    sync_dir(owner)
}
fn clear(path: &Path) -> Result<()> {
    let dirty = directory(path.parent().unwrap()).join("dirty");
    match std::fs::remove_file(dirty.join(key(path)?)) {
        Ok(()) => sync_dir(&dirty),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
fn replace(generation: &Path, name: &str, row: Option<&Entry>) -> Result<()> {
    let path = generation.join(name);
    if let Some(row) = row {
        write(&path, row)
    } else {
        match std::fs::remove_file(&path) {
            Ok(()) => sync_dir(generation),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}
fn commit(path: &Path, row: Option<Value>) -> Result<()> {
    let owner = path.parent().unwrap();
    // Before migration, invalidation survives until reconstruction from canonical files.
    if let Ok(mut current) = current(owner) {
        let generation = directory(owner).join(&current.generation);
        let name = key(path)?;
        let existed = generation.join(&name).exists();
        let row = row
            .map(|row| -> Result<Entry> {
                Ok(Entry {
                    stamp: Stamp::read(path)?,
                    row,
                })
            })
            .transpose()?;
        replace(&generation, &name, row.as_ref())?;
        if existed != row.is_some() {
            current.count = if existed {
                current.count.saturating_sub(1)
            } else {
                current.count + 1
            };
            write(&directory(owner).join("current.json"), &current)?;
        }
        clear(path)?;
        cost::changed(1);
    }
    Ok(())
}
/// One-time source migration runs under Core ownership before indexes are opened.
pub(crate) fn invalidate(path: &Path) -> Result<()> {
    available(path.parent().unwrap())?;
    let writer = writer(path.parent().unwrap());
    let _lock = writer.lock().map_err(|e| e.to_string())?;
    mark(path)
}
/// Failure leaves this key invalidated, including failure after canonical publication.
pub(crate) fn change<T>(
    path: &Path,
    work: impl FnOnce() -> Result<(T, Option<Value>)>,
) -> Result<T> {
    available(path.parent().unwrap())?;
    let writer = writer(path.parent().unwrap());
    let _lock = writer.lock().map_err(|e| e.to_string())?;
    mark(path)?;
    let (result, row) = work()?;
    if path.exists() {
        std::fs::File::open(path)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
    }
    sync_dir(path.parent().unwrap())?;
    cost::sync(Owner::IndexUpdate, Reason::Dirty, || commit(path, row))?;
    Ok(result)
}
/// Watcher repair or scheduling replaces one record, never clears an unfinished owner write.
pub(crate) fn update(path: &Path, row: Option<Value>) -> Result<()> {
    available(path.parent().unwrap())?;
    let writer = writer(path.parent().unwrap());
    let _lock = writer.lock().map_err(|e| e.to_string())?;
    if directory(path.parent().unwrap())
        .join("dirty")
        .join(key(path)?)
        .exists()
    {
        return Ok(());
    }
    if cost::sync(Owner::IndexUpdate, Reason::Dirty, || -> Result<bool> {
        if let Ok(current) = current(path.parent().unwrap()) {
            let stored = directory(path.parent().unwrap())
                .join(current.generation)
                .join(key(path)?);
            let previous = read::<Entry>(&stored).ok();
            if previous.as_ref().map(|entry| &entry.row) == row.as_ref()
                && previous.as_ref().and_then(|entry| entry.stamp.clone()) == Stamp::read(path)?
            {
                return Ok(true);
            }
        }
        Ok(false)
    })? {
        return Ok(());
    }
    // Index-only writes also need a boundary for interruption between row and count.
    mark(path)?;
    cost::sync(Owner::IndexUpdate, Reason::Dirty, || commit(path, row))
}
fn canonical(path: &Path, project: &impl Fn(Value) -> Result<Value>) -> Result<Option<Entry>> {
    cost::rows(1);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    cost::bytes_read(bytes.len());
    cost::bytes_parsed(bytes.len());
    match serde_json::from_slice(&bytes)
        .map_err(|e| e.to_string())
        .and_then(project)
    {
        Ok(row) => Ok(Some(Entry {
            stamp: Stamp::read(path)?,
            row,
        })),
        Err(error) => {
            crate::logs::record(
                "WARN",
                &format!("Skipping invalid index source: {error}"),
                None,
            );
            Ok(None)
        }
    }
}
fn read_rows(generation: &Path) -> Result<BTreeMap<String, Entry>> {
    let mut rows = BTreeMap::new();
    for item in std::fs::read_dir(generation).map_err(|e| e.to_string())? {
        let path = item.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|v| v == "json") {
            cost::rows(1);
            rows.insert(key(&path)?, read(&path)?);
        }
    }
    Ok(rows)
}
fn cleanup(owner: &Path, keep: &Path) -> Result<()> {
    for item in std::fs::read_dir(directory(owner)).map_err(|e| e.to_string())? {
        let path = item.map_err(|e| e.to_string())?.path();
        if path != keep && path.is_dir() && uuid::Uuid::parse_str(&key(&path)?).is_ok() {
            std::fs::remove_dir_all(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
/// Core owns migration before observation. Each batch holds at most 64 canonical paths.
pub(crate) fn open(
    owner: &Path,
    seed: Owner,
    adopt_cost: Owner,
    selected: impl Fn(&Path) -> bool,
    validate: impl Fn(&Value) -> bool,
    project: impl Fn(Value) -> Result<Value>,
) -> Result<BTreeMap<String, Entry>> {
    let writer = writer(owner);
    let _lock = writer.lock().map_err(|e| e.to_string())?;
    private_dir(owner)?;
    let dirty = directory(owner).join("dirty");
    private_dir(&dirty)?;
    let dirty_keys = std::fs::read_dir(&dirty)
        .map_err(|e| e.to_string())?
        .map(|e| e.map_err(|e| e.to_string()).and_then(|e| key(&e.path())))
        .collect::<Result<Vec<_>>>()?;
    let adopted = cost::sync(adopt_cost, Reason::Startup, || -> Result<_> {
        let current = current(owner)?;
        let rows = read_rows(&directory(owner).join(&current.generation))?;
        if (dirty_keys.is_empty() && rows.len() != current.count)
            || rows
                .iter()
                .any(|(key, entry)| !selected(&owner.join(key)) || !validate(&entry.row))
        {
            return Err("DERIVED_INDEX_INVALID: rebuild required".into());
        }
        Ok((current, rows))
    });
    let (mut current, mut rows) = match adopted {
        Ok(result) => result,
        Err(_) => cost::sync(seed, Reason::Startup, || -> Result<_> {
            let generation_id = id();
            let generation = directory(owner).join(&generation_id);
            private_dir(&generation)?;
            let mut entries = std::fs::read_dir(owner).map_err(|e| e.to_string())?;
            let mut rows = BTreeMap::new();
            let mut hashes = BTreeMap::new();
            loop {
                let batch = entries
                    .by_ref()
                    .take(BATCH)
                    .collect::<std::io::Result<Vec<_>>>()
                    .map_err(|e| e.to_string())?;
                if batch.is_empty() {
                    break;
                }
                for item in batch {
                    let path = item.path();
                    if selected(&path) {
                        if let Some(row) = canonical(&path, &project)? {
                            let name = key(&path)?;
                            let bytes = serde_json::to_vec(&row).map_err(|e| e.to_string())?;
                            // Unpublished derived data is disposable. Only the manifest is
                            // durable; missing/torn entries after a power loss rebuild.
                            std::fs::write(generation.join(&name), &bytes)
                                .map_err(|e| e.to_string())?;
                            hashes.insert(name.clone(), hash(&bytes));
                            rows.insert(name, row);
                        }
                    }
                }
                cost::scan_set(rows.len());
                if CANCELLED.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err("INDEX_STARTUP_CANCELLED".into());
                }
                std::thread::yield_now();
                #[cfg(test)]
                if INTERRUPT_REBUILD.replace(false) {
                    return Err("INTERRUPTED_INDEX_REBUILD".into());
                }
            }
            // Verify count and bytes without parsing all projected JSON a second time.
            for (name, expected) in &hashes {
                let bytes = std::fs::read(generation.join(name)).map_err(|e| e.to_string())?;
                cost::bytes_read(bytes.len());
                if hash(&bytes) != *expected {
                    return Err("DERIVED_INDEX_READBACK_FAILED".into());
                }
            }
            if std::fs::read_dir(&generation)
                .map_err(|e| e.to_string())?
                .count()
                != rows.len()
            {
                return Err("DERIVED_INDEX_READBACK_FAILED".into());
            }
            sync_dir(&generation)?;
            let current = Current {
                version: VERSION,
                generation: generation_id,
                count: rows.len(),
            };
            write(&directory(owner).join("current.json"), &current)?;
            sync_dir(owner)?;
            Ok((current, rows))
        })?,
    };
    let generation = directory(owner).join(&current.generation);
    cost::sync(Owner::IndexRepair, Reason::Startup, || -> Result<()> {
        for name in dirty_keys {
            let path = owner.join(&name);
            if selected(&path) {
                let stamp = Stamp::read(&path)?;
                if !rows.get(&name).is_some_and(|row| row.stamp == stamp) {
                    let row = canonical(&path, &project)?;
                    replace(&generation, &name, row.as_ref())?;
                    if let Some(row) = row {
                        rows.insert(name, row);
                    } else {
                        rows.remove(&name);
                    }
                }
            }
        }
        // Publish repaired count before clearing any markers, including create/delete crashes.
        if current.count != rows.len() {
            current.count = rows.len();
            write(&directory(owner).join("current.json"), &current)?;
        }
        for item in std::fs::read_dir(&dirty).map_err(|e| e.to_string())? {
            clear(&owner.join(key(&item.map_err(|e| e.to_string())?.path())?))?;
        }
        Ok(())
    })?;
    cleanup(owner, &generation)?;
    Ok(rows)
}

#[cfg(test)]
pub(crate) fn interrupt(path: &Path, bytes: &[u8]) -> Result<()> {
    let writer = writer(path.parent().unwrap());
    let _lock = writer.lock().unwrap();
    mark(path)?;
    atomic(path, bytes)
}

#[cfg(test)]
pub(crate) fn damage(owner: &Path, mode: &str) {
    let header = directory(owner).join("current.json");
    match mode {
        "missing" => {
            std::fs::remove_file(header).unwrap();
        }
        "version" => {
            let mut value: Value = read(&header).unwrap();
            value["version"] = json!(0);
            write(&header, &value).unwrap();
        }
        "corrupt" => {
            let current = current(owner).unwrap();
            let path = std::fs::read_dir(directory(owner).join(current.generation))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            std::fs::write(path, b"{").unwrap();
        }
        _ => panic!("unknown fault"),
    }
}
#[cfg(test)]
thread_local! { static INTERRUPT_REBUILD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
#[cfg(test)]
pub(crate) fn interrupt_next_rebuild() {
    INTERRUPT_REBUILD.set(true);
}

static PREPARING: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
    std::sync::LazyLock::new(Default::default);
static CANCELLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
thread_local! { static INITIALIZER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
pub(crate) fn available(owner: &Path) -> Result<()> {
    if PREPARING
        .lock()
        .unwrap()
        .contains(&super::file_changes::physical(owner))
        && !INITIALIZER.get()
    {
        return Err(
            "INDEX_NOT_READY: Background index initialization is pending; retry this owner read."
                .into(),
        );
    }
    Ok(())
}
pub(crate) fn background(
    owners: Vec<PathBuf>,
    work: impl FnOnce() -> Result<()> + Send + 'static,
) -> tokio::task::JoinHandle<Result<()>> {
    let owners: Vec<_> = owners
        .iter()
        .map(|p| super::file_changes::physical(p))
        .collect();
    PREPARING.lock().unwrap().extend(owners.clone());
    CANCELLED.store(false, std::sync::atomic::Ordering::Relaxed);
    tokio::task::spawn_blocking(move || {
        INITIALIZER.set(true);
        let result = work();
        INITIALIZER.set(false);
        if result.is_ok() {
            let mut preparing = PREPARING.lock().unwrap();
            for owner in owners {
                preparing.remove(&owner);
            }
        }
        result
    })
}
pub(crate) fn cancel() {
    CANCELLED.store(true, std::sync::atomic::Ordering::Relaxed);
}
