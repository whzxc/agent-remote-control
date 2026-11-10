//! Disposable per-key metadata. Canonical owners serialize writes through this boundary.
use super::file_cache::Stamp;
use crate::runtime_metrics::cost::{self, Owner, Reason};
use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::time::{Duration, Instant};

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
    if directory(owner).join("invalid").exists() {
        return Err("DERIVED_INDEX_INVALIDATED: rebuild required".into());
    }
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
/// A whole-owner migration invalidates once before its first canonical change.
pub(crate) fn invalidate_owner(owner: &Path) -> Result<()> {
    available(owner)?;
    let writer = writer(owner);
    let _lock = writer.lock().map_err(|e| e.to_string())?;
    atomic(&directory(owner).join("invalid"), b"migration")?;
    sync_dir(owner)
}
/// Failure leaves this key invalidated, including failure after canonical publication.
pub(crate) fn change<T>(
    path: &Path,
    work: impl FnOnce() -> Result<(T, Option<Value>)>,
) -> Result<T> {
    available(path.parent().unwrap())?;
    let writer = writer(path.parent().unwrap());
    let _lock = writer.lock().map_err(|e| e.to_string())?;
    let migrating = INITIALIZER.get() && directory(path.parent().unwrap()).join("invalid").exists();
    if !migrating {
        mark(path)?;
    }
    let (result, row) = work()?;
    if path.exists() {
        std::fs::File::open(path)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
    }
    sync_dir(path.parent().unwrap())?;
    if !migrating {
        cost::sync(Owner::IndexUpdate, Reason::Dirty, || commit(path, row))?;
    }
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
#[derive(Default)]
struct Profile {
    read: Duration,
    project: Duration,
    write: Duration,
    verify: Duration,
}
fn canonical(
    path: &Path,
    project: &impl Fn(Value) -> Result<Value>,
    profile: &mut Profile,
) -> Result<Option<Entry>> {
    cost::rows(1);
    if !path.exists() {
        return Ok(None);
    }
    let started = Instant::now();
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    profile.read += started.elapsed();
    cost::bytes_read(bytes.len());
    cost::bytes_parsed(bytes.len());
    let started = Instant::now();
    let projected = serde_json::from_slice(&bytes)
        .map_err(|e| e.to_string())
        .and_then(project);
    profile.project += started.elapsed();
    match projected {
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
pub(crate) fn open<T>(
    owner: &Path,
    seed: Owner,
    adopt_cost: Owner,
    selected: impl Fn(&Path) -> bool,
    validate: impl Fn(&Value) -> bool,
    project: impl Fn(Value) -> Result<Value>,
    install: impl FnOnce(BTreeMap<String, Entry>) -> Result<T>,
) -> Result<T> {
    let started = Instant::now();
    let mut profile = Profile::default();
    let writer = writer(owner);
    let _lock = writer.lock().map_err(|e| e.to_string())?;
    private_dir(owner)?;
    let dirty = directory(owner).join("dirty");
    private_dir(&dirty)?;
    let dirty_keys = std::fs::read_dir(&dirty)
        .map_err(|e| e.to_string())?
        .map(|e| e.map_err(|e| e.to_string()).and_then(|e| key(&e.path())))
        .collect::<Result<Vec<_>>>()?;
    let adopting = Instant::now();
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
    let adopt = adopting.elapsed();
    let rebuilt = adopted.is_err();
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
                        if let Some(row) = canonical(&path, &project, &mut profile)? {
                            let name = key(&path)?;
                            let writing = Instant::now();
                            let bytes = serde_json::to_vec(&row).map_err(|e| e.to_string())?;
                            // Unpublished derived data is disposable. Only the manifest is
                            // durable; missing/torn entries after a power loss rebuild.
                            std::fs::write(generation.join(&name), &bytes)
                                .map_err(|e| e.to_string())?;
                            hashes.insert(name.clone(), hash(&bytes));
                            rows.insert(name, row);
                            profile.write += writing.elapsed();
                        }
                    }
                }
                cost::scan_set(rows.len());
                check_cancelled()?;
                std::thread::yield_now();
                #[cfg(test)]
                if INTERRUPT_REBUILD.replace(false) {
                    return Err("INTERRUPTED_INDEX_REBUILD".into());
                }
            }
            let verifying = Instant::now();
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
            profile.verify += verifying.elapsed();
            let current = Current {
                version: VERSION,
                generation: generation_id,
                count: rows.len(),
            };
            Ok((current, rows))
        })?,
    };
    let generation = directory(owner).join(&current.generation);
    let repairing = Instant::now();
    cost::sync(Owner::IndexRepair, Reason::Startup, || -> Result<()> {
        for name in dirty_keys {
            let path = owner.join(&name);
            if !rebuilt && selected(&path) {
                let stamp = Stamp::read(&path)?;
                if !rows.get(&name).is_some_and(|row| row.stamp == stamp) {
                    let row = canonical(&path, &project, &mut profile)?;
                    replace(&generation, &name, row.as_ref())?;
                    if let Some(row) = row {
                        rows.insert(name, row);
                    } else {
                        rows.remove(&name);
                    }
                }
            }
        }
        current.count = rows.len();
        Ok(())
    })?;
    let repair = repairing.elapsed();
    let cleaning = Instant::now();
    cleanup(owner, &generation)?;
    let cleanup = cleaning.elapsed();
    let loading = Instant::now();
    let loaded = install(rows)?;
    let load = loading.elapsed();
    check_cancelled()?;
    let publishing = Instant::now();
    // Callers hold their resident-index lock through this call and insertion. Readers
    // checking availability wait on this gate until durable publish and installation
    // agree. Each owner opens independently of the remaining startup work.
    let mut preparing = PREPARING.lock().unwrap();
    write(&directory(owner).join("current.json"), &current)?;
    let clearing = Instant::now();
    for item in std::fs::read_dir(&dirty).map_err(|e| e.to_string())? {
        std::fs::remove_file(item.map_err(|e| e.to_string())?.path()).map_err(|e| e.to_string())?;
    }
    sync_dir(&dirty)?;
    let clear_markers = clearing.elapsed();
    let invalid = directory(owner).join("invalid");
    if invalid.exists() {
        std::fs::remove_file(invalid).map_err(|e| e.to_string())?;
    }
    sync_dir(&directory(owner))?;
    sync_dir(owner)?;
    preparing.remove(&super::file_changes::physical(owner));
    drop(preparing);
    let publish = publishing.elapsed();
    crate::logs::record(
        "INFO",
        &format!(
            "Index startup {}",
            json!({
                "owner": if seed == Owner::NotificationSeed {"notifications"} else {"receipts"},
                "mode": if rebuilt {"rebuild"} else {"adopt"}, "rows":current.count,
                "readMs":profile.read.as_millis(), "projectMs":profile.project.as_millis(),
                "writeMs":profile.write.as_millis(), "verifyMs":profile.verify.as_millis(),
                "repairMs":repair.as_millis(), "loadMs":load.as_millis(),
                "publishMs":publish.as_millis(), "clearMarkersMs":clear_markers.as_millis(),
                "cleanupMs":cleanup.as_millis(), "adoptMs":adopt.as_millis(),
                "totalMs":started.elapsed().as_millis()
            })
        ),
        None,
    );
    Ok(loaded)
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
pub(crate) fn prepare(owners: &[PathBuf]) {
    PREPARING
        .lock()
        .unwrap()
        .extend(owners.iter().map(|p| super::file_changes::physical(p)));
    CANCELLED.store(false, std::sync::atomic::Ordering::Relaxed);
}
pub(crate) fn background(
    owners: Vec<PathBuf>,
    work: impl FnOnce() -> Result<()> + Send + 'static,
) -> tokio::task::JoinHandle<Result<()>> {
    prepare(&owners);
    tokio::task::spawn_blocking(move || {
        INITIALIZER.set(true);
        let result = work();
        INITIALIZER.set(false);
        result
    })
}
pub(crate) fn cancel() {
    CANCELLED.store(true, std::sync::atomic::Ordering::Relaxed);
}

pub(crate) fn check_cancelled() -> Result<()> {
    if CANCELLED.load(std::sync::atomic::Ordering::Relaxed) {
        Err("INDEX_STARTUP_CANCELLED".into())
    } else {
        Ok(())
    }
}
