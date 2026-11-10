//! Resident receipt metadata and a changed-key cursor, derived from canonical files.
use super::*;
use crate::kernel::{
    file_cache::Stamp,
    file_changes::{physical, Watch},
};
use crate::runtime_metrics::cost::{self, Owner, Reason};
use std::collections::{BTreeMap, BTreeSet, HashMap};
struct Summary {
    stamp: Option<Stamp>,
    row: Value,
}
#[derive(Default)]
struct Index {
    rows: BTreeMap<PathBuf, Summary>,
    changes: BTreeMap<u64, PathBuf>,
    revision: u64,
    watch: Watch,
    repair_after: Option<PathBuf>,
    repair_directory: Option<std::fs::ReadDir>,
}
type Resident = Arc<std::sync::Mutex<Option<Index>>>;
static INDEXES: std::sync::LazyLock<std::sync::Mutex<HashMap<PathBuf, Resident>>> =
    std::sync::LazyLock::new(Default::default);
fn fields(value: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .filter_map(|key| value.get(*key).map(|value| ((*key).into(), value.clone())))
            .collect(),
    )
}
pub(super) fn summary(mut row: Value) -> Result<Value> {
    if !row.is_object() {
        return Err("INVALID_RECEIPT".into());
    }
    let result = &row["result"];
    let mut result_summary = fields(result, &["error", "threadId"]);
    for key in ["thread", "resolved"] {
        if let Some(value) = result.get(key) {
            result_summary[key] = fields(
                value,
                if key == "thread" {
                    &["id", "name", "cwd"]
                } else {
                    &["cwd"]
                },
            );
            if key == "resolved" && value.get("thread").is_some() {
                result_summary[key]["thread"] = fields(&value["thread"], &["id", "name", "cwd"]);
            }
        }
    }
    row["result"] = result_summary;
    if string(&row, "operation").starts_with("agent_") {
        row["arguments"] = fields(
            &row["arguments"],
            &["approval", "title", "prompt", "cwd", "model"],
        );
    } else {
        row.as_object_mut().unwrap().remove("arguments");
    }
    row.as_object_mut().unwrap().remove("coordinationPending");
    Ok(row)
}
fn receipt(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "json")
        && path
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
}
impl Index {
    fn open(directory: &Path) -> Result<Self> {
        crate::kernel::derived_index::open(
            directory,
            Owner::ReceiptSeed,
            Owner::ReceiptAdopt,
            receipt,
            Value::is_object,
            summary,
            |rows| {
                let mut index = Self::default();
                index.watch.add(&directory.join(".index-watch"));
                for (key, entry) in rows {
                    index.rows.insert(
                        directory.join(key),
                        Summary {
                            stamp: entry.stamp,
                            row: entry.row,
                        },
                    );
                }
                Ok(index)
            },
        )
    }
    fn refresh(&mut self, path: &Path) -> Result<()> {
        let stamp = Stamp::read(path)?;
        if self.rows.get(path).is_some_and(|s| s.stamp == stamp) {
            return Ok(());
        }
        cost::rows(1);
        if stamp.is_none() {
            self.rows.remove(path);
        } else {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            cost::bytes_read(bytes.len());
            cost::bytes_parsed(bytes.len());
            cost::cache(false);
            let row = serde_json::from_slice(&bytes)
                .map_err(|e| e.to_string())
                .and_then(summary);
            match row {
                Ok(row) => {
                    self.rows.insert(path.into(), Summary { stamp, row });
                }
                Err(error) => {
                    self.rows.remove(path);
                    crate::logs::record(
                        "WARN",
                        &format!("Skipping invalid receipt summary: {error}"),
                        None,
                    );
                }
            }
        }
        crate::kernel::derived_index::update(path, self.rows.get(path).map(|s| s.row.clone()))?;
        self.revision += 1;
        self.changes.insert(self.revision, path.into());
        while self.changes.len() > 8192 {
            self.changes.pop_first();
        }
        Ok(())
    }
    fn drain(&mut self, directory: &Path) -> Result<()> {
        let (paths, failed) = self.watch.drain();
        for path in paths {
            if path.parent() == Some(directory) && receipt(&path) {
                self.refresh(&path)?;
            }
        }
        if failed {
            cost::sync(Owner::IndexRepair, Reason::Dirty, || -> Result<()> {
                use std::ops::Bound::{Excluded, Unbounded};
                let keys: Vec<_> = self
                    .rows
                    .range((
                        self.repair_after.clone().map_or(Unbounded, Excluded),
                        Unbounded,
                    ))
                    .take(32)
                    .map(|(key, _)| key.clone())
                    .collect();
                self.repair_after = keys.last().cloned();
                for key in keys {
                    cost::rows(1);
                    self.refresh(&key)?;
                }
                for key in crate::kernel::file_changes::repair_paths(
                    directory,
                    &mut self.repair_directory,
                    32,
                )? {
                    cost::rows(1);
                    if receipt(&key) {
                        self.refresh(&key)?;
                    }
                }
                Ok(())
            })?;
        }
        Ok(())
    }
}
fn with<T>(directory: &Path, work: impl FnOnce(&mut Index, &Path) -> Result<T>) -> Result<T> {
    let directory = physical(directory);
    crate::kernel::derived_index::available(&directory)?;
    let resident = INDEXES
        .lock()
        .map_err(|e| e.to_string())?
        .entry(directory.clone())
        .or_default()
        .clone();
    let mut resident = resident.lock().map_err(|e| e.to_string())?;
    if resident.is_none() {
        *resident = Some(Index::open(&directory)?);
    }
    let index = resident.as_mut().unwrap();
    index.drain(&directory)?;
    work(index, &directory)
}
pub(super) fn read(path: &Path) -> Result<Value> {
    with(
        path.parent().ok_or("INVALID_RECEIPT_PATH")?,
        |index, directory| {
            let path = directory.join(path.file_name().unwrap());
            // Explicit selected reads validate the selected key, without touching peers.
            index.refresh(&path)?;
            cost::rows(1);
            cost::cache(true);
            index
                .rows
                .get(&path)
                .map(|s| s.row.clone())
                .ok_or_else(|| "INVALID_RECEIPT".into())
        },
    )
}
pub(super) fn updates(
    directory: &Path,
    revision: Option<u64>,
) -> Result<(u64, bool, Vec<(String, Option<Value>)>)> {
    with(directory, |index, _| {
        let reset = revision.is_none_or(|revision| {
            revision
                < index
                    .changes
                    .first_key_value()
                    .map_or(0, |(first, _)| first.saturating_sub(1))
        });
        let keys: BTreeSet<_> = match revision {
            Some(revision)
                if revision
                    >= index
                        .changes
                        .first_key_value()
                        .map_or(0, |(first, _)| first.saturating_sub(1)) =>
            {
                index
                    .changes
                    .range((
                        std::ops::Bound::Excluded(revision),
                        std::ops::Bound::Unbounded,
                    ))
                    .map(|(_, path)| path.clone())
                    .collect()
            }
            _ => index.rows.keys().cloned().collect(),
        };
        cost::scan_set(keys.len());
        cost::rows(keys.len());
        Ok((
            index.revision,
            reset,
            keys.into_iter()
                .map(|path| {
                    (
                        path.file_stem().unwrap().to_str().unwrap().into(),
                        index.rows.get(&path).map(|s| s.row.clone()),
                    )
                })
                .collect(),
        ))
    })
}

pub(super) fn seed(directory: &Path) -> Result<()> {
    with(directory, |_, _| Ok(()))
}

#[cfg(test)]
pub(super) fn forget(directory: &Path) {
    INDEXES.lock().unwrap().remove(&physical(directory));
}
