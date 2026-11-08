//! Agent-neutral projection of shared configuration into private account homes.
use crate::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;

#[derive(PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: std::time::SystemTime,
    created: Option<std::time::SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64),
}
impl FileStamp {
    fn read(metadata: &std::fs::Metadata) -> Result<Self> {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            len: metadata.len(),
            modified: metadata.modified().map_err(|e| e.to_string())?,
            created: metadata.created().ok(),
            #[cfg(unix)]
            identity: (metadata.dev(), metadata.ino()),
        })
    }
}

// Codex may re-extract unchanged plugin files at startup. Metadata is a cache
// key, not configuration identity: identical content must keep the same revision.
fn file_digest(path: &Path, metadata: &std::fs::Metadata) -> Result<Vec<u8>> {
    type Cache = BTreeMap<PathBuf, (FileStamp, Vec<u8>)>;
    static CACHE: std::sync::LazyLock<std::sync::Mutex<Cache>> =
        std::sync::LazyLock::new(Default::default);
    let stamp = FileStamp::read(metadata)?;
    let mut cache = CACHE.lock().map_err(|e| e.to_string())?;
    if let Some((previous, bytes)) = cache.get(path) {
        if previous == &stamp {
            return Ok(bytes.clone());
        }
    }
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    if FileStamp::read(&file.metadata().map_err(|e| e.to_string())?)? != stamp {
        return Err(
            "Shared configuration changed while reading; retry after saving the primary home"
                .into(),
        );
    }
    let bytes = digest.finalize().to_vec();
    cache.insert(path.to_path_buf(), (stamp, bytes.clone()));
    Ok(bytes)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Entry {
    Shared,
    Generated,
    Private,
}

pub(crate) struct Policy {
    pub classify: fn(&str) -> Entry,
    pub generate: fn(&Path, &Path, &str) -> Result<Vec<u8>>,
    pub dependencies: fn(&Path) -> Result<Vec<PathBuf>>,
    // Mixed directories contain installed resources beside account runtime data.
    pub shared_parts: &'static [&'static str],
}

struct Projection {
    generated: BTreeMap<String, Vec<u8>>,
    links: BTreeMap<String, PathBuf>,
    fingerprint: String,
}

fn entries(path: &Path) -> Result<Vec<std::fs::DirEntry>> {
    let mut rows = std::fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    rows.sort_by_key(|e| e.file_name());
    Ok(rows)
}

// Include names, resolved links and file content. Cached content digests avoid
// rereading installed plugin binaries on every dispatch.
fn stamp(path: &Path, digest: &mut Sha256, ancestors: &mut Vec<PathBuf>) -> Result<()> {
    let resolved = path.canonicalize().map_err(|e| e.to_string())?;
    if ancestors.contains(&resolved) {
        return Err("Shared configuration contains a symlink cycle".into());
    }
    digest.update(path.as_os_str().as_encoded_bytes());
    digest.update(resolved.as_os_str().as_encoded_bytes());
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        digest.update(b"directory");
        ancestors.push(resolved);
        for entry in entries(path)? {
            stamp(&entry.path(), digest, ancestors)?;
        }
        ancestors.pop();
    } else if metadata.is_file() {
        digest.update(b"file");
        digest.update(file_digest(&resolved, &metadata)?);
    } else {
        return Err("Shared configuration must contain only files and directories".into());
    }
    Ok(())
}

fn build_projection(policy: &Policy, source: &Path, target: &Path) -> Result<Projection> {
    let mut generated = BTreeMap::new();
    let mut links = BTreeMap::new();
    for entry in if source.exists() {
        entries(source)?
    } else {
        vec![]
    } {
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Invalid configuration filename")?;
        match (policy.classify)(&name) {
            Entry::Shared => {
                links.insert(name, entry.path());
            }
            Entry::Generated => {
                generated.insert(name.clone(), (policy.generate)(source, target, &name)?);
            }
            Entry::Private => {}
        }
    }
    // Generate the base config even when the primary uses Codex defaults.
    if !generated.contains_key("config.toml") {
        generated.insert(
            "config.toml".into(),
            (policy.generate)(source, target, "config.toml")?,
        );
    }
    for name in policy.shared_parts {
        if source.join(name).exists() {
            links.insert((*name).into(), source.join(name));
        }
    }
    let mut digest = Sha256::new();
    digest.update(b"arc-account-parity-v2");
    for (name, bytes) in &generated {
        digest.update(name.as_bytes());
        digest.update(bytes);
    }
    for (name, path) in &links {
        digest.update(name.as_bytes());
        stamp(path, &mut digest, &mut vec![])?;
    }
    for path in (policy.dependencies)(source)? {
        stamp(&path, &mut digest, &mut vec![])?;
    }
    Ok(Projection {
        generated,
        links,
        fingerprint: digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    })
}

fn remove(path: &Path) -> Result<()> {
    #[cfg(windows)]
    use std::os::windows::fs::FileTypeExt;
    match std::fs::symlink_metadata(path) {
        #[cfg(windows)]
        Ok(m) if m.file_type().is_symlink_dir() => std::fs::remove_dir(path),
        Ok(m) if m.is_symlink() || m.is_file() => std::fs::remove_file(path),
        Ok(_) => std::fs::remove_dir_all(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    }
    .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn copy(source: &Path, target: &Path) -> Result<()> {
    if source.is_dir() {
        std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
        for entry in entries(source)? {
            copy(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else {
        std::fs::copy(source, target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn link(source: &Path, target: &Path) -> Result<&'static str> {
    if std::fs::read_link(target).ok().as_deref() == Some(source) {
        return Ok("symlink");
    }
    let parent = target.parent().ok_or("Invalid shared entry")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let stage = parent.join(format!(".arc-parity-{}", id()));
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(source, &stage);
    #[cfg(windows)]
    let linked = if source.is_dir() {
        std::os::windows::fs::symlink_dir(source, &stage)
    } else {
        std::os::windows::fs::symlink_file(source, &stage)
    };
    let mode = match linked {
        Ok(()) => "symlink",
        // Windows installations without symlink privileges use verified copies.
        #[cfg(windows)]
        Err(_) => {
            copy(source, &stage)?;
            "copy"
        }
        #[cfg(not(windows))]
        Err(e) => return Err(e.to_string()),
    };
    remove(target)?;
    std::fs::rename(&stage, target).map_err(|e| e.to_string())?;
    Ok(mode)
}

fn equal_tree(source: &Path, target: &Path) -> Result<bool> {
    if source.is_dir() {
        if !target.is_dir() {
            return Ok(false);
        }
        let source_rows = entries(source)?;
        let target_rows = entries(target)?;
        if source_rows.len() != target_rows.len() {
            return Ok(false);
        }
        for row in source_rows {
            if !equal_tree(&row.path(), &target.join(row.file_name()))? {
                return Ok(false);
            }
        }
        Ok(true)
    } else {
        Ok(target.is_file()
            && std::fs::read(source).map_err(|e| e.to_string())?
                == std::fs::read(target).map_err(|e| e.to_string())?)
    }
}

fn valid(policy: &Policy, projection: &Projection, target: &Path, record: &Value) -> Result<bool> {
    if record["state"] != "synced" || record["fingerprint"] != projection.fingerprint {
        return Ok(false);
    }
    if !target.is_dir() {
        return Ok(false);
    }
    for entry in entries(target)? {
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Invalid configuration filename")?;
        if (policy.classify)(&name) != Entry::Private
            && !projection.links.contains_key(&name)
            && !projection.generated.contains_key(&name)
        {
            return Ok(false);
        }
    }
    for name in policy.shared_parts {
        if !projection.links.contains_key(*name)
            && std::fs::symlink_metadata(target.join(name)).is_ok()
        {
            return Ok(false);
        }
    }
    for (name, bytes) in &projection.generated {
        let path = target.join(name);
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_symlink())
            || std::fs::read(path).ok().as_deref() != Some(bytes.as_slice())
        {
            return Ok(false);
        }
    }
    for (name, source) in &projection.links {
        let path = target.join(name);
        if record["entries"][name] == "symlink" {
            if std::fs::read_link(&path).ok().as_deref() != Some(source.as_path()) {
                return Ok(false);
            }
        } else if !equal_tree(source, &path)? {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn inspect(
    policy: &Policy,
    source: &Path,
    target: &Path,
    record_path: &Path,
) -> Result<Value> {
    let projection = build_projection(policy, source, target)?;
    let mut record = load(record_path).unwrap_or(json!({"state":"stale","lastSyncAt":null}));
    if !valid(policy, &projection, target, &record)? {
        record["state"] = json!("stale");
    }
    Ok(record)
}

pub(crate) fn fingerprint(policy: &Policy, source: &Path) -> Result<String> {
    Ok(build_projection(policy, source, source)?.fingerprint)
}

/// A successful record is published only after the complete projection is verified.
/// Core owns the state lock; callers serialize syncs inside that process.
pub(crate) fn sync(
    policy: &Policy,
    source: &Path,
    target: &Path,
    record_path: &Path,
) -> Result<Value> {
    let projection = build_projection(policy, source, target)?;
    let previous = load(record_path).unwrap_or(json!({}));
    if valid(policy, &projection, target, &previous)? {
        return Ok(previous);
    }
    private_dir(target)?;
    save(
        record_path,
        &json!({"state":"syncing","lastSyncAt":previous["lastSyncAt"],"entries":previous["entries"]}),
    )?;
    // The first migration must also remove untracked profile-local settings whose
    // shared primary entry is absent. Otherwise old hooks or instructions survive.
    for entry in entries(target)? {
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Invalid configuration filename")?;
        if (policy.classify)(&name) != Entry::Private
            && !projection.links.contains_key(&name)
            && !projection.generated.contains_key(&name)
        {
            remove(&entry.path())?;
        }
    }
    for name in policy.shared_parts {
        if !projection.links.contains_key(*name) {
            remove(&target.join(name))?;
        }
    }
    // Remove entries formerly shared by ARC when they disappear from the source.
    for (name, _) in previous["entries"].as_object().into_iter().flatten() {
        if !projection.links.contains_key(name) && !projection.generated.contains_key(name) {
            remove(&target.join(name))?;
        }
    }
    let mut installed = serde_json::Map::new();
    for (name, path) in &projection.links {
        installed.insert(name.clone(), json!(link(path, &target.join(name))?));
    }
    for (name, bytes) in &projection.generated {
        // Atomic replacement deletes the manual config instead of merging its overrides.
        if std::fs::symlink_metadata(target.join(name)).is_ok_and(|m| m.is_symlink()) {
            remove(&target.join(name))?;
        }
        save_bytes(&target.join(name), bytes)?;
        installed.insert(name.clone(), json!("generated"));
    }
    if projection.fingerprint != build_projection(policy, source, target)?.fingerprint {
        return Err(
            "Shared configuration changed during sync; retry after saving the primary home".into(),
        );
    }
    let record = json!({"state":"synced","fingerprint":projection.fingerprint,"lastSyncAt":now(),"entries":installed});
    if !valid(policy, &projection, target, &record)? {
        return Err("Shared configuration projection failed verification".into());
    }
    save(record_path, &record)?;
    Ok(record)
}
