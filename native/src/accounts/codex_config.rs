//! Revision tracking for native Codex configuration; no account-home projection.
use crate::kernel::file_cache::Stamp;
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
    identity: (u64, u64, i64, i64),
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
            identity: (
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            ),
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

#[cfg(test)]
thread_local! { static TREE_READS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) }; }

fn entries(path: &Path) -> Result<Vec<std::fs::DirEntry>> {
    #[cfg(test)]
    TREE_READS.with(|value| value.set(value.get() + 1));
    let mut rows = std::fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    rows.sort_by_key(|e| e.file_name());
    Ok(rows)
}

// Include names, resolved links and file content. Cached content digests avoid
// rereading installed plugin binaries on every dispatch.
fn stamp(
    path: &Path,
    digest: &mut Sha256,
    ancestors: &mut Vec<PathBuf>,
    inputs: &mut Inputs,
) -> Result<()> {
    inputs.observe(path);
    let resolved = path.canonicalize().map_err(|e| e.to_string())?;
    inputs.observe(&resolved);
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
            stamp(&entry.path(), digest, ancestors, inputs)?;
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

fn dependencies(source: &Path) -> Result<Vec<PathBuf>> {
    fn collect(config: &toml::Table, base: &Path, paths: &mut Vec<PathBuf>) {
        let resolve = |s: &str| {
            if let Some(suffix) = s.strip_prefix("~/") {
                dirs::home_dir().unwrap_or_default().join(suffix)
            } else if Path::new(s).is_absolute() {
                PathBuf::from(s)
            } else {
                base.join(s)
            }
        };
        for key in [
            "model_instructions_file",
            "experimental_instructions_file",
            "model_catalog_json",
            "compact_prompt_file",
        ] {
            if let Some(path) = config.get(key).and_then(toml::Value::as_str) {
                paths.push(resolve(path));
            }
        }
        if let Some(agents) = config.get("agents").and_then(toml::Value::as_table) {
            for (_, agent) in agents {
                if let Some(path) = agent.get("config_file").and_then(toml::Value::as_str) {
                    paths.push(resolve(path));
                }
            }
        }
        if let Some(profiles) = config.get("profiles").and_then(toml::Value::as_table) {
            for (_, profile) in profiles {
                if let Some(profile) = profile.as_table() {
                    collect(profile, base, paths);
                }
            }
        }
    }
    let mut paths = vec![];
    if source.exists() {
        for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "config.toml" || name.ends_with(".config.toml") {
                let config = std::fs::read_to_string(entry.path())
                    .map_err(|e| e.to_string())?
                    .parse::<toml::Table>()
                    .map_err(|_| format!("Invalid primary {name}; correct its TOML and retry"))?;
                collect(&config, source, &mut paths);
            }
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn shared(name: &str) -> bool {
    matches!(
        name,
        "config.toml"
            | "AGENTS.md"
            | "AGENTS.override.md"
            | "hooks.json"
            | "rules"
            | "skills"
            | "agents"
            | "prompts"
            | "themes"
            | "keybindings.json"
    ) || name.ends_with(".config.toml")
}
// Check a flat manifest synchronously: watcher callbacks can lag a completed
// write, including immediately before dispatch. Directory stamps discover added
// and removed entries; link and ancestor stamps discover retargeted paths.
#[derive(PartialEq, Eq)]
struct AncestorStamp {
    target: Option<PathBuf>,
    created: Option<std::time::SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64),
}
impl AncestorStamp {
    fn read(path: &Path, metadata: &std::fs::Metadata) -> Result<Self> {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            target: if metadata.is_symlink() {
                Some(std::fs::read_link(path).map_err(|e| e.to_string())?)
            } else {
                None
            },
            created: metadata.created().ok(),
            #[cfg(unix)]
            identity: (metadata.dev(), metadata.ino()),
        })
    }
}

#[derive(Default)]
struct Inputs {
    paths: BTreeMap<PathBuf, Option<Stamp>>,
    ancestors: BTreeMap<PathBuf, Option<AncestorStamp>>,
    failed: bool,
}
impl Inputs {
    fn read(path: &Path) -> Result<Option<Stamp>> {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) => Ok(Some(Stamp::from_metadata(&metadata))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
    fn observe(&mut self, path: &Path) {
        let mut observe = || -> Result<()> {
            if !self.paths.contains_key(path) {
                self.paths.insert(path.to_path_buf(), Self::read(path)?);
            }
            self.observe_links(path, 0)?;
            if let Ok(resolved) = path.canonicalize() {
                if !self.paths.contains_key(&resolved) {
                    self.paths.insert(resolved.clone(), Self::read(&resolved)?);
                }
                self.observe_links(&resolved, 0)?;
            }
            Ok(())
        };
        if observe().is_err() {
            self.failed = true;
        }
    }
    fn observe_links(&mut self, path: &Path, depth: usize) -> Result<()> {
        if depth > 40 {
            return Err("Cannot track shared configuration links".into());
        }
        for path in path.ancestors() {
            if self.ancestors.contains_key(path) {
                continue;
            }
            let metadata = match std::fs::symlink_metadata(path) {
                Ok(metadata) => Some(metadata),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.to_string()),
            };
            let stamp = metadata
                .as_ref()
                .map(|metadata| AncestorStamp::read(path, metadata))
                .transpose()?;
            let target = stamp.as_ref().and_then(|stamp| stamp.target.clone());
            self.ancestors.insert(path.to_path_buf(), stamp);
            if let Some(target) = target {
                self.observe_links(
                    &path.parent().unwrap_or(Path::new("")).join(target),
                    depth + 1,
                )?;
            }
        }
        Ok(())
    }
    fn unchanged(&self) -> Result<bool> {
        if self.failed {
            return Ok(false);
        }
        for (path, before) in &self.paths {
            if Self::read(path)? != *before {
                return Ok(false);
            }
        }
        for (path, before) in &self.ancestors {
            let metadata = match std::fs::symlink_metadata(path) {
                Ok(metadata) => Some(metadata),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.to_string()),
            };
            let current = metadata
                .as_ref()
                .map(|metadata| AncestorStamp::read(path, metadata))
                .transpose()?;
            if current != *before {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

#[derive(Default)]
struct Revision {
    source: PathBuf,
    cached: Option<(Inputs, String)>,
}
impl Revision {
    fn read(&mut self, source: &Path) -> Result<String> {
        if self.source == source {
            if let Some((inputs, fingerprint)) = &self.cached {
                if inputs.unchanged().unwrap_or(false) {
                    return Ok(fingerprint.clone());
                }
            }
        }
        self.cached = None;
        let mut inputs = Inputs::default();
        let fingerprint = compute_revision(source, &mut inputs)?;
        // Never publish an observation that changed during enumeration.
        if inputs.unchanged().unwrap_or(false) {
            self.source = source.into();
            self.cached = Some((inputs, fingerprint.clone()));
        }
        Ok(fingerprint)
    }
}

fn revision(source: &Path) -> Result<String> {
    static CACHE: std::sync::Mutex<Revision> = std::sync::Mutex::new(Revision {
        source: PathBuf::new(),
        cached: None,
    });
    match CACHE.lock() {
        Ok(mut cache) => cache.read(source),
        Err(_) => compute_revision(source, &mut Inputs::default()),
    }
}

fn compute_revision(source: &Path, inputs: &mut Inputs) -> Result<String> {
    inputs.observe(source);
    let mut digest = Sha256::new();
    if source.exists() {
        for entry in entries(source)? {
            if shared(&entry.file_name().to_string_lossy()) {
                stamp(&entry.path(), &mut digest, &mut vec![], inputs)?;
            }
        }
    }
    let plugins = source.join("plugins/cache");
    inputs.observe(&plugins);
    if plugins.exists() {
        stamp(&plugins, &mut digest, &mut vec![], inputs)?;
    }
    for path in dependencies(source)? {
        stamp(&path, &mut digest, &mut vec![], inputs)?;
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
pub(crate) fn shared_configuration(profile: &str) -> Result<Value> {
    let fingerprint = revision(&super::codex::default_home()?).map_err(|_| json!({"code":"CODEX_PROFILE_PARITY_FAILED","message":"Cannot read native Codex configuration. Correct its TOML and referenced resources, then retry.","next":{"via":"query","op":"guide","args":{"op":"accounts"}}}).to_string())?;
    Ok(
        json!({"state":if profile == "codex-home" {"primary"} else {"shared"},"lastSyncAt":null,"fingerprint":fingerprint}),
    )
}
pub(crate) fn inspect_profile(profile: &str) -> Value {
    shared_configuration(profile)
        .unwrap_or_else(|error| json!({"state":"error","error":error,"lastSyncAt":null}))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("arc-config-revision-{}", id()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn full(source: &Path) -> String {
        compute_revision(source, &mut Inputs::default()).unwrap()
    }

    #[test]
    fn repeated_configuration_reads_do_not_walk_unchanged_inputs() {
        // Regression: ax-090844fd repeated account polls re-stamped the unchanged shared configuration tree.
        let directory = Sandbox::new();
        let source = directory.0.join("home");
        std::fs::create_dir_all(source.join("skills/example")).unwrap();
        std::fs::create_dir_all(source.join("plugins/cache/example")).unwrap();
        std::fs::write(source.join("skills/example/SKILL.md"), "instructions").unwrap();
        std::fs::write(source.join("plugins/cache/example/tool"), "plugin").unwrap();
        let expected = full(&source);
        let mut revision = Revision::default();
        assert_eq!(revision.read(&source).unwrap(), expected);
        let baseline = TREE_READS.get();
        for _ in 0..6 {
            let sibling = Sandbox::new();
            assert_eq!(revision.read(&source).unwrap(), expected);
            drop(sibling);
            assert_eq!(revision.read(&source).unwrap(), expected);
        }
        assert_eq!(TREE_READS.get(), baseline);
    }

    #[test]
    fn fingerprint_tracks_changed_inputs_on_the_next_read() {
        // Contract: shared configuration fingerprints cover names, resolved links, content and referenced configuration resources.
        let directory = Sandbox::new();
        let source = directory.0.join("home");
        let mut revision = Revision::default();
        assert_eq!(revision.read(&source).unwrap(), full(&source));
        std::fs::create_dir_all(&source).unwrap();
        let external = directory.0.join("external.md");
        std::fs::write(&external, "before").unwrap();
        std::fs::write(
            source.join("config.toml"),
            "model_instructions_file = '../external.md'",
        )
        .unwrap();
        let mut previous = revision.read(&source).unwrap();
        assert_eq!(previous, full(&source));
        for (name, content) in [
            ("AGENTS.md", "instructions"),
            ("skills/example/SKILL.md", "skill"),
            ("plugins/cache/example/tool", "plugin"),
            ("../external.md", "after"),
            (
                "profiles.config.toml",
                "compact_prompt_file = '../external.md'",
            ),
        ] {
            let path = source.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, content).unwrap();
            let next = revision.read(&source).unwrap();
            assert_ne!(next, previous);
            assert_eq!(next, full(&source));
            previous = next;
        }
        let path = source.join("skills/example/SKILL.md");
        std::fs::rename(&path, path.with_file_name("renamed.md")).unwrap();
        assert_ne!(revision.read(&source).unwrap(), previous);
        previous = revision.read(&source).unwrap();
        std::fs::remove_file(path.with_file_name("renamed.md")).unwrap();
        assert_ne!(revision.read(&source).unwrap(), previous);
        #[cfg(unix)]
        {
            // An indirect external link can move between hard links with identical metadata.
            let first = directory.0.join("first");
            let second = directory.0.join("second");
            std::fs::write(&first, "linked").unwrap();
            std::fs::hard_link(&first, &second).unwrap();
            let indirect = directory.0.join("indirect");
            std::os::unix::fs::symlink(&first, &indirect).unwrap();
            std::os::unix::fs::symlink(&indirect, source.join("AGENTS.override.md")).unwrap();
            previous = revision.read(&source).unwrap();
            std::fs::remove_file(&indirect).unwrap();
            std::os::unix::fs::symlink(&second, &indirect).unwrap();
            assert_ne!(revision.read(&source).unwrap(), previous);
            assert_eq!(revision.read(&source).unwrap(), full(&source));
        }
        previous = revision.read(&source).unwrap();
        std::fs::write(source.join("AGENTS.md"), "instructions").unwrap();
        assert_eq!(revision.read(&source).unwrap(), previous);
        // An unavailable detector takes the ordinary computation path.
        revision.cached.as_mut().unwrap().0.failed = true;
        let baseline = TREE_READS.get();
        assert_eq!(revision.read(&source).unwrap(), full(&source));
        assert!(TREE_READS.get() > baseline);
        std::fs::write(source.join("config.toml"), "[").unwrap();
        assert!(revision.read(&source).is_err());
    }
}
