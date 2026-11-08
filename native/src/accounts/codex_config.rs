//! Revision tracking for native Codex configuration; no account-home projection.
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
fn revision(source: &Path) -> Result<String> {
    let mut digest = Sha256::new();
    if source.exists() {
        for entry in entries(source)? {
            if shared(&entry.file_name().to_string_lossy()) {
                stamp(&entry.path(), &mut digest, &mut vec![])?;
            }
        }
    }
    let plugins = source.join("plugins/cache");
    if plugins.exists() {
        stamp(&plugins, &mut digest, &mut vec![])?;
    }
    for path in dependencies(source)? {
        stamp(&path, &mut digest, &mut vec![])?;
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
