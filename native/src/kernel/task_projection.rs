//! Incremental task-record projections keyed by receipt and selected runtime dependencies.
use super::{
    file_cache::Stamp,
    file_changes::{physical, Watch},
    receipts::ReceiptStore,
};
use crate::*;
use std::collections::{BTreeMap, HashMap, HashSet};
#[derive(Default)]
pub(crate) struct TaskProjection {
    revision: Option<u64>,
    session: String,
    watch: Watch,
    dependencies: BTreeMap<PathBuf, (Option<Stamp>, HashSet<String>)>,
    requests: HashMap<String, Vec<PathBuf>>,
    positions: HashMap<String, usize>,
    pub records: Arc<Vec<Value>>,
    pub display: Arc<Vec<Value>>,
    retry: HashSet<String>,
    repair_after: Option<PathBuf>,
}
impl TaskProjection {
    pub fn update(
        &mut self,
        store: &ReceiptStore,
        session: &str,
        dependencies: impl Fn(&Value) -> Vec<PathBuf>,
        project: impl Fn(Value) -> Result<Option<Value>>,
    ) -> Result<Arc<Vec<Value>>> {
        if self.session != session {
            *self = Self {
                session: session.into(),
                ..Default::default()
            };
        }
        let (revision, reset, updates) = store.projection_updates(self.revision, session)?;
        if reset {
            *self = Self {
                session: session.into(),
                ..Default::default()
            };
        }
        let mut changed: HashMap<_, _> = updates.into_iter().collect();
        let (paths, failed) = self.watch.drain();
        for path in paths {
            if let Some((stamp, requests)) = self.dependencies.get_mut(&path) {
                let current = Stamp::read(&path)?;
                if current != *stamp {
                    *stamp = current;
                    self.retry.extend(requests.iter().cloned());
                }
            }
        }
        if failed {
            // Watch failure is visible as bounded repair work, never a hidden history pass.
            crate::runtime_metrics::cost::sync(
                crate::runtime_metrics::cost::Owner::IndexRepair,
                crate::runtime_metrics::cost::Reason::Dirty,
                || {
                    use std::ops::Bound::{Excluded, Unbounded};
                    let keys: Vec<_> = self
                        .dependencies
                        .range((
                            self.repair_after.clone().map_or(Unbounded, Excluded),
                            Unbounded,
                        ))
                        .take(64)
                        .map(|(key, _)| key.clone())
                        .collect();
                    self.repair_after = keys.last().cloned();
                    for path in keys {
                        crate::runtime_metrics::cost::rows(1);
                        let (stamp, requests) = self.dependencies.get_mut(&path).unwrap();
                        let current = Stamp::read(&path).ok().flatten();
                        if current != *stamp {
                            *stamp = current;
                            self.retry.extend(requests.iter().cloned());
                        }
                    }
                },
            );
        }
        for request in std::mem::take(&mut self.retry) {
            if !changed.contains_key(&request) {
                changed.insert(
                    request.clone(),
                    Some(store.read_for_projection(&request, session)?),
                );
            }
        }
        crate::runtime_metrics::cost::scan_set(changed.len());
        for (request, receipt) in changed {
            crate::runtime_metrics::cost::rows(1);
            for path in self.requests.remove(&request).unwrap_or_default() {
                if let Some((_, keys)) = self.dependencies.get_mut(&path) {
                    keys.remove(&request);
                    if receipt.is_none() && keys.is_empty() {
                        self.dependencies.remove(&path);
                        self.watch.remove(&path);
                    }
                }
            }
            let mut paths = Vec::new();
            if let Some(receipt) = &receipt {
                for path in dependencies(receipt) {
                    self.watch.add(&path);
                    let path = physical(&path);
                    self.dependencies
                        .entry(path.clone())
                        .or_insert_with(|| (Stamp::read(&path).ok().flatten(), Default::default()))
                        .1
                        .insert(request.clone());
                    paths.push(path);
                }
            }
            self.requests.insert(request.clone(), paths);
            let projected = match receipt.map(&project).transpose() {
                Ok(row) => row.flatten(),
                Err(error) => {
                    self.retry.insert(request.clone());
                    crate::logs::record(
                        "WARN",
                        &format!("Task projection deferred: {error}"),
                        None,
                    );
                    continue;
                }
            };
            match (self.positions.get(&request).copied(), projected) {
                (Some(position), Some(row)) => {
                    if self.records[position] != row {
                        Arc::make_mut(&mut self.display)[position] =
                            crate::task_overview::display_record(&row);
                        Arc::make_mut(&mut self.records)[position] = row;
                    }
                }
                (None, Some(row)) => {
                    let at = self.records.partition_point(|other| {
                        string(other, "createdAt") > string(&row, "createdAt")
                    });
                    Arc::make_mut(&mut self.display)
                        .insert(at, crate::task_overview::display_record(&row));
                    Arc::make_mut(&mut self.records).insert(at, row);
                    for position in self.positions.values_mut().filter(|pos| **pos >= at) {
                        *position += 1;
                    }
                    self.positions.insert(request, at);
                }
                (Some(position), None) => {
                    Arc::make_mut(&mut self.records).remove(position);
                    Arc::make_mut(&mut self.display).remove(position);
                    self.positions.remove(&request);
                    for pos in self.positions.values_mut().filter(|pos| **pos > position) {
                        *pos -= 1;
                    }
                }
                (None, None) => {}
            }
        }
        self.revision = Some(revision);
        Ok(self.records.clone())
    }
}
