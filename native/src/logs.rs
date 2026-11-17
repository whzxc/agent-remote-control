//! Append-only diagnostics, independent of connection configuration lifetimes.
use crate::*;
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::{Mutex as StdMutex, OnceLock};

fn lock() -> &'static StdMutex<()> {
    static LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
    LOCK.get_or_init(Default::default)
}
fn append_locked(row: &Value) -> Result<()> {
    let dir = root().join("logs");
    private_dir(&dir)?;
    let path = dir.join(format!("{}.jsonl", chrono::Utc::now().format("%Y-%m-%d")));
    // Rotate the active day before it becomes a large unbounded file.
    if std::fs::metadata(&path).is_ok_and(|m| m.len() >= 2 * 1024 * 1024) {
        std::fs::rename(
            &path,
            dir.join(format!(
                "{}.{}.jsonl",
                chrono::Utc::now().format("%Y-%m-%d"),
                chrono::Utc::now().timestamp_millis()
            )),
        )
        .map_err(|e| e.to_string())?;
    }
    static PRUNED: OnceLock<StdMutex<Option<std::time::Instant>>> = OnceLock::new();
    let mut last = PRUNED
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?;
    if last.is_none_or(|at| at.elapsed().as_secs() >= 60) {
        let cutoff = (chrono::Utc::now() - chrono::Duration::days(7))
            .format("%Y-%m-%d")
            .to_string();
        let mut files = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !entry.file_type().map_err(|e| e.to_string())?.is_file()
                || !name.ends_with(".jsonl")
                || name
                    .get(..10)
                    .is_none_or(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_err())
            {
                continue;
            }
            files.push((
                name,
                entry.path(),
                entry.metadata().map_err(|e| e.to_string())?.len(),
            ));
        }
        files.sort_by(|a, b| a.0.cmp(&b.0));
        let mut total: u64 = files.iter().map(|f| f.2).sum();
        for (name, old, size) in files {
            if old != path && (name[..10] < cutoff[..] || total > 16 * 1024 * 1024) {
                if std::fs::remove_file(old).is_ok() {
                    total = total.saturating_sub(size);
                }
            }
        }
        *last = Some(std::time::Instant::now());
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    let mut data = serde_json::to_vec(row).map_err(|e| e.to_string())?;
    data.push(b'\n');
    file.write_all(&data).map_err(|e| e.to_string())
}
pub fn append(row: Value) -> Result<()> {
    let _guard = lock().lock().map_err(|e| e.to_string())?;
    append_locked(&row)
}
pub fn record(level: &str, msg: &str, ingress: Option<&str>) {
    if let Err(error) = append(json!({"time":now(),"level":level,"msg":msg,"ingressId":ingress})) {
        eprintln!("Cannot persist diagnostics: {error}");
    }
}
/// Move existing connection logs before that connection can be deleted.
pub fn migrate(dir: &Path, ingress: &str) -> Result<()> {
    let path = dir.join("logs.json");
    if !path.exists() {
        return Ok(());
    }
    let _guard = lock().lock().map_err(|e| e.to_string())?;
    let rows = load(&path)?;
    for line in rows.as_array().ok_or("invalid connection logs")? {
        let mut row: Value = serde_json::from_str(line.as_str().ok_or("invalid log line")?)
            .map_err(|e| e.to_string())?;
        row["ingressId"] = json!(ingress);
        append_locked(&row)?;
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())
}
/// Read recent diagnostics from the bounded, rotated history.
pub fn recent(ingress: Option<&str>) -> Vec<String> {
    let Ok(_guard) = lock().lock() else {
        return vec![];
    };
    let Ok(files) = std::fs::read_dir(root().join("logs")) else {
        return vec![];
    };
    let mut paths: Vec<_> = files
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .collect();
    paths.sort();
    let mut rows = Vec::new();
    for path in paths.into_iter().rev() {
        let Ok(mut file) = std::fs::File::open(path) else {
            continue;
        };
        let Ok(meta) = file.metadata() else {
            continue;
        };
        let offset = meta.len().saturating_sub(256 * 1024);
        if file.seek(SeekFrom::Start(offset)).is_err() {
            continue;
        }
        let mut data = Vec::new();
        if file.read_to_end(&mut data).is_err() {
            continue;
        }
        for line in data.split(|b| *b == b'\n').rev() {
            let Ok(row) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            // Lease renewals carry no user action or diagnostic information.
            // Keep failures and leave the original on-disk history untouched.
            if row["level"] == "INFO"
                && matches!(
                    row["msg"].as_str(),
                    Some("POST runtime/lease: started" | "POST runtime/lease: succeeded")
                )
            {
                continue;
            }
            if ingress.is_none_or(|id| row["ingressId"] == id) {
                rows.push(row.to_string());
                if rows.len() == 200 {
                    rows.reverse();
                    return rows;
                }
            }
        }
    }
    rows.reverse();
    rows
}

/// Structured retained history. Cursor identifies a record, independent of daily rotation.
pub fn query(options: &Value) -> Result<Value> {
    let _guard = lock().lock().map_err(|e| e.to_string())?;
    let limit = num(options, "limit", 200).clamp(1, 2000);
    let mut rows = Vec::new();
    let dir = root().join("logs");
    if dir.exists() {
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if !path.extension().is_some_and(|s| s == "jsonl") {
                continue;
            }
            for (index, line) in std::fs::read_to_string(&path)
                .map_err(|e| e.to_string())?
                .lines()
                .enumerate()
            {
                if let Ok(mut row) = serde_json::from_str::<Value>(line) {
                    if row["level"] == "INFO"
                        && matches!(
                            string(&row, "msg"),
                            "POST runtime/lease: started" | "POST runtime/lease: succeeded"
                        )
                    {
                        continue;
                    }
                    row["recordId"] = json!(hash(format!("{}:{index}", path.display())));
                    rows.push(row);
                }
            }
        }
    }
    rows.sort_by(|a, b| {
        string(a, "time")
            .cmp(string(b, "time"))
            .then_with(|| string(a, "recordId").cmp(string(b, "recordId")))
    });
    let descending = options["descending"] == true;
    if descending {
        rows.reverse();
    }
    let since = options["since"]
        .as_str()
        .map(|v| parse_since(v, chrono::Utc::now()))
        .transpose()?;
    let cursor = string(options, "cursor");
    let position = rows.iter().position(|r| hash(r.to_string()) == cursor);
    let gap = !cursor.is_empty() && position.is_none();
    let mut selected: Vec<&Value> =
        rows.iter()
            .skip(position.map_or(0, |i| i + 1))
            .filter(|row| {
                if [
                    "ingressId",
                    "level",
                    "traceId",
                    "requestId",
                    "cfRay",
                    "event",
                ]
                .iter()
                .any(|key| {
                    options[*key]
                        .as_str()
                        .is_some_and(|v| !v.is_empty() && row[*key] != v)
                }) {
                    return false;
                }
                if options["grep"]
                    .as_str()
                    .is_some_and(|v| !string(row, "msg").contains(v))
                {
                    return false;
                }
                let at = string(row, "time");
                !since.as_ref().is_some_and(|v| {
                    chrono::DateTime::parse_from_rfc3339(at).is_ok_and(|at| at < *v)
                }) && !options["until"].as_str().is_some_and(|v| at > v)
            })
            .collect();
    // The ordinary log view starts at the recent tail; explicit time ranges page history forward.
    if !descending
        && cursor.is_empty()
        && options.get("since").is_none()
        && options.get("until").is_none()
        && selected.len() > limit
    {
        selected.drain(..selected.len() - limit);
    }
    let has_more = selected.len() > limit;
    selected.truncate(limit);
    let next = if has_more {
        selected.last().map(|v| hash(v.to_string()))
    } else {
        rows.last().map(|v| hash(v.to_string()))
    }
    .unwrap_or_else(|| cursor.to_owned());
    Ok(
        json!({"rows":selected,"cursor":next,"hasMore":has_more,"gap":gap,"retention":{"days":7,"maxBytes":16777216},"oldestAt":if descending{rows.last()}else{rows.first()}.map(|v|&v["time"]),"newestAt":if descending{rows.first()}else{rows.last()}.map(|v|&v["time"])}),
    )
}

/// Resolve a diagnostic time boundary without exposing chrono parser internals.
pub fn parse_since(
    value: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<chrono::DateTime<chrono::Utc>> {
    if let Ok(time) = chrono::DateTime::parse_from_rfc3339(value) {
        return Ok(time.with_timezone(&chrono::Utc));
    }
    let invalid = || {
        "INVALID_ARGUMENT: since requires RFC3339 or an integer duration with ms, s, m, h, or d (for example 2m)".to_owned()
    };
    for (suffix, multiplier) in [
        ("ms", 1i64),
        ("s", 1000),
        ("m", 60_000),
        ("h", 3_600_000),
        ("d", 86_400_000),
    ] {
        if let Some(number) = value.strip_suffix(suffix) {
            if number.is_empty() || !number.bytes().all(|c| c.is_ascii_digit()) {
                return Err(invalid());
            }
            let millis = number
                .parse::<i64>()
                .ok()
                .and_then(|n| n.checked_mul(multiplier))
                .ok_or_else(invalid)?;
            return now
                .checked_sub_signed(chrono::Duration::milliseconds(millis))
                .ok_or_else(invalid);
        }
    }
    Err(invalid())
}

#[cfg(test)]
mod since_tests {
    use super::*;
    #[test]
    fn duration_and_absolute_boundaries() {
        // Recurring bug class: AX-12 logs since:2m exposed a premature-end parser error.
        let now = chrono::DateTime::parse_from_rfc3339("2026-01-02T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        for (value, millis) in [
            ("2m", 120000),
            ("1ms", 1),
            ("3s", 3000),
            ("1h", 3600000),
            ("1d", 86400000),
            ("0s", 0),
        ] {
            assert_eq!(
                now.signed_duration_since(parse_since(value, now).unwrap())
                    .num_milliseconds(),
                millis
            );
        }
        assert_eq!(parse_since("2026-01-02T01:00:00+01:00", now).unwrap(), now);
        for value in ["2", "-2m", "1.5h", "m", "99999999999999999999d"] {
            assert!(parse_since(value, now)
                .unwrap_err()
                .starts_with("INVALID_ARGUMENT:"));
        }
    }
}
