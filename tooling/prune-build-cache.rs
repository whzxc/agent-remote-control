// Development tooling only. Hold Cargo's own locks while removing compiler-owned cache groups.
use std::{
    env,
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    time::SystemTime,
};
const CACHE_DIRS: &[&str] = &["deps", ".fingerprint", "build", "incremental", "examples"];
fn size(path: &Path, seen: &mut std::collections::HashSet<(u64, u64)>) -> io::Result<u64> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Ok(0);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if !meta.is_dir() && !seen.insert((meta.dev(), meta.ino())) {
            return Ok(0);
        }
    }
    if meta.is_dir() {
        return fs::read_dir(path)?.try_fold(0, |n, e| Ok(n + size(&e?.path(), seen)?));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(meta.blocks() * 512)
    }
    #[cfg(not(unix))]
    {
        Ok(meta.len())
    }
}
fn discover(path: &Path, groups: &mut Vec<PathBuf>) -> io::Result<()> {
    if !path.exists() || fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Ok(());
    }
    if path.join(".fingerprint").is_dir() && path.join("deps").is_dir() {
        groups.push(path.to_owned());
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir()
            && !matches!(
                entry.file_name().to_str(),
                Some(".git" | "node_modules" | "bundle")
            )
        {
            discover(&entry.path(), groups)?;
        }
    }
    Ok(())
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let root = env::current_dir()?.canonicalize()?;
    let args: Vec<_> = env::args().skip(1).collect();
    let limit = args[0].parse::<u64>()? * 1024 * 1024 * 1024;
    let dry = args.iter().any(|a| a == "--dry-run");
    let keep = args
        .iter()
        .find_map(|a| a.strip_prefix("--keep="))
        .map(|p| {
            let path = root.join(p);
            path.canonicalize().unwrap_or(path)
        });
    let mut groups = Vec::new();
    let target = root.join("target").canonicalize()?;
    discover(&target, &mut groups)?;
    let mut rows = Vec::new();
    for path in groups {
        let mut seen = std::collections::HashSet::new();
        let mut bytes = 0;
        for name in CACHE_DIRS {
            let child = path.join(name);
            if child.exists() {
                bytes += size(&child, &mut seen)?;
            }
        }
        let at = fs::metadata(path.join(".cache-last-used"))
            .or_else(|_| fs::metadata(&path))?
            .modified()
            .unwrap_or(SystemTime::UNIX_EPOCH);
        rows.push((at, path, bytes));
    }
    rows.sort_by_key(|row| (row.2 <= limit, row.0));
    let mut total: u64 = rows.iter().map(|r| r.2).sum();
    for (_, path, bytes) in &rows {
        if keep
            .as_ref()
            .is_some_and(|p| p.starts_with(path) || path.starts_with(p))
        {
            if !dry {
                fs::write(path.join(".cache-last-used"), b"")?;
            }
            continue;
        }
        if total <= limit {
            continue;
        }
        // Never unlink lock files: Cargo must keep observing the same inode.
        let mut locks: Vec<File> = Vec::new();
        let mut busy = false;
        for name in if dry {
            vec![]
        } else {
            vec![".cargo-lock", ".cargo-build-lock", ".cargo-artifact-lock"]
        } {
            let file = OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(path.join(name))?;
            if file.try_lock().is_err() {
                busy = true;
                break;
            }
            locks.push(file);
        }
        if busy {
            eprintln!("Skipping busy Cargo output: {}", path.display());
            continue;
        }
        println!(
            "{} {} ({:.2} GiB compiler cache; bundles and binaries retained)",
            if dry { "Would prune" } else { "Pruning" },
            path.display(),
            *bytes as f64 / 1073741824.
        );
        if !dry {
            for name in CACHE_DIRS {
                let child = path.join(name);
                if child.exists() {
                    if fs::symlink_metadata(&child)?.file_type().is_symlink() {
                        return Err("refusing symlink cache".into());
                    }
                    fs::remove_dir_all(child)?;
                }
            }
        }
        total = total.saturating_sub(*bytes);
    }
    println!(
        "Rust compiler cache: {:.2} GiB / {:.0} GiB{}",
        total as f64 / 1073741824.,
        limit as f64 / 1073741824.,
        if dry { " (dry run)" } else { "" }
    );
    if total > limit {
        eprintln!(
            "Active/protected outputs exceed the budget; retry after the current build exits."
        );
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
