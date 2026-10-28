//! Lossless event archives: a bounded JSONL tail and immutable indexed gzip segments.
use crate::*;
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};

const SEGMENT_BYTES: u64 = 8 * 1024 * 1024;

fn directory(session: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(session).map_err(|_| "INVALID_OUTPUT_ID")?;
    let dir = root().join("outputs").join(session);
    if std::fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("INVALID_OUTPUT_DIRECTORY".into());
    }
    private_dir(&dir)?;
    Ok(dir)
}
fn lock(dir: &Path, shared: bool) -> Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join(".lock"))
        .map_err(|e| e.to_string())?;
    if shared {
        file.lock_shared()
    } else {
        file.lock()
    }
    .map_err(|e| e.to_string())?;
    Ok(file)
}
fn segments(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = std::collections::BTreeMap::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if stem.len() != 20 || !stem.bytes().all(|c| c.is_ascii_digit()) {
            continue;
        }
        match path.extension().and_then(|e| e.to_str()) {
            // The raw source remains authoritative until compression and its index commit.
            Some("jsonl") => {
                paths.insert(stem.to_owned(), path);
            }
            Some("gz") if path.with_extension("json").is_file() => {
                paths.entry(stem.to_owned()).or_insert(path);
            }
            _ => (),
        }
    }
    Ok(paths.into_values().collect())
}
fn compress(path: &Path) -> Result<()> {
    use sha2::{Digest, Sha256};
    let temp = path.with_extension("tmp");
    let result = (|| -> Result<()> {
        let source = File::open(path).map_err(|e| e.to_string())?;
        let before = source.metadata().map_err(|e| e.to_string())?;
        let mut source = std::io::BufReader::new(source);
        let mut options = OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut encoder = GzEncoder::new(
            options.open(&temp).map_err(|e| e.to_string())?,
            Compression::fast(),
        );
        let mut digest = Sha256::new();
        let mut bytes = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = source.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            digest.update(&buffer[..n]);
            bytes += n as u64;
            encoder.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        }
        encoder
            .finish()
            .map_err(|e| e.to_string())?
            .sync_all()
            .map_err(|e| e.to_string())?;
        let expected = digest.finalize();
        let mut decoded = GzDecoder::new(File::open(&temp).map_err(|e| e.to_string())?);
        let mut verified = Sha256::new();
        loop {
            let n = decoded.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            verified.update(&buffer[..n]);
        }
        if expected != verified.finalize() {
            return Err("EVENT_ARCHIVE_VERIFY_FAILED".into());
        }
        let (_, characters) =
            super::results::read_slice(File::open(path).map_err(|e| e.to_string())?, 0, 0, None)?;
        let after = std::fs::metadata(path).map_err(|e| e.to_string())?;
        if bytes != before.len()
            || after.len() != before.len()
            || after.modified().ok() != before.modified().ok()
        {
            return Err("EVENT_ARCHIVE_SOURCE_CHANGED".into());
        }
        std::fs::rename(&temp, path.with_extension("gz")).map_err(|e| e.to_string())?;
        save(
            &path.with_extension("json"),
            &json!({"bytes":bytes,"characters":characters,"sha256":format!("{expected:x}")}),
        )?;
        std::fs::remove_file(path).map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_file(temp);
    result
}
fn rotate(session: &str, dir: &Path, force: bool) -> Result<()> {
    // Finish interrupted compression before accepting another segment.
    for path in segments(dir)? {
        if path.extension().is_some_and(|e| e == "jsonl") {
            compress(&path)?;
        }
    }
    let tail = root().join("outputs").join(format!("{session}.jsonl"));
    let size = std::fs::metadata(&tail).map(|m| m.len()).unwrap_or(0);
    if size == 0 || (!force && size < SEGMENT_BYTES) {
        return Ok(());
    }
    let next = segments(dir)?
        .last()
        .and_then(|p| p.file_stem()?.to_str()?.parse::<u64>().ok())
        .map_or(0, |n| n + 1);
    let segment = dir.join(format!("{next:020}.jsonl"));
    std::fs::rename(&tail, &segment).map_err(|e| e.to_string())?;
    compress(&segment)
}
pub fn append(session: &str, text: &str) -> Result<()> {
    let dir = directory(session)?;
    let _lock = lock(&dir, false)?;
    // Persist the new event before maintenance; a failed compression leaves readable raw data.
    let tail = root().join("outputs").join(format!("{session}.jsonl"));
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(tail)
        .map_err(|e| e.to_string())?
        .write_all(text.as_bytes())
        .map_err(|e| e.to_string())?;
    rotate(session, &dir, false)
}
pub fn read(session: &str, offset: usize, length: usize) -> Result<(String, usize)> {
    uuid::Uuid::parse_str(session).map_err(|_| "INVALID_OUTPUT_ID")?;
    let outputs = root().join("outputs");
    if !outputs.join(session).is_dir() && !outputs.join(format!("{session}.jsonl")).is_file() {
        return Err("OUTPUT_NOT_FOUND".into());
    }
    let dir = directory(session)?;
    let _lock = lock(&dir, true)?;
    let mut paths = segments(&dir)?;
    let tail = root().join("outputs").join(format!("{session}.jsonl"));
    if tail.is_file() {
        paths.push(tail);
    }
    if paths.is_empty() {
        return Err("OUTPUT_NOT_FOUND".into());
    }
    let mut total = 0usize;
    let mut text = String::new();
    for path in paths {
        let compressed = path.extension().is_some_and(|e| e == "gz");
        let count = if compressed {
            Some(
                load(&path.with_extension("json"))?["characters"]
                    .as_u64()
                    .ok_or("INVALID_EVENT_INDEX")? as usize,
            )
        } else {
            None
        };
        if count.is_some_and(|n| {
            total.saturating_add(n) <= offset || total >= offset.saturating_add(length)
        }) {
            total = total.saturating_add(count.unwrap());
            continue;
        }
        let file = File::open(&path).map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        let reader: Box<dyn Read> = if compressed {
            Box::new(GzDecoder::new(file))
        } else {
            Box::new(file.take(size))
        };
        let start = offset.saturating_sub(total);
        let wanted = offset
            .saturating_add(length)
            .saturating_sub(total.max(offset));
        let (part, characters) = super::results::read_slice(reader, start, wanted, count)?;
        text.push_str(&part);
        total = total.saturating_add(characters);
    }
    Ok((text, total))
}

/// Visit complete records under the archive lock, including compressed history.
pub(crate) fn visit(session: &str, mut consume: impl FnMut(Value) -> Result<()>) -> Result<()> {
    use std::io::BufRead;
    let dir = directory(session)?;
    let _lock = lock(&dir, true)?;
    let mut paths = segments(&dir)?;
    let tail = root().join("outputs").join(format!("{session}.jsonl"));
    if tail.is_file() {
        paths.push(tail);
    }
    for path in paths {
        let file = File::open(&path).map_err(|e| e.to_string())?;
        let reader: Box<dyn Read> = if path.extension().is_some_and(|e| e == "gz") {
            Box::new(GzDecoder::new(file))
        } else {
            Box::new(file)
        };
        for line in std::io::BufReader::new(reader).lines() {
            let line = line.map_err(|e| e.to_string())?;
            consume(serde_json::from_str(&line).map_err(|e| e.to_string())?)?;
        }
    }
    Ok(())
}

pub fn compact_all() -> Result<Value> {
    let outputs = root().join("outputs");
    private_dir(&outputs)?;
    let mut ids = std::collections::BTreeSet::new();
    for entry in std::fs::read_dir(&outputs).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = if path.is_dir() {
            path.file_name()
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            path.file_stem()
        } else {
            None
        };
        if let Some(id) = name
            .and_then(|s| s.to_str())
            .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        {
            ids.insert(id.to_owned());
        }
    }
    let mut count = 0;
    for id in ids {
        let dir = directory(&id)?;
        let _lock = lock(&dir, false)?;
        rotate(&id, &dir, true)?;
        count += 1;
    }
    Ok(json!({"compactedOutputs":count,"lossless":true}))
}
