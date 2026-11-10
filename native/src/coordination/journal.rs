//! Core owns this store under the state-directory lock. One mutex serializes journal
//! access; callers release source/owner locks before entering it. No upstream I/O here.
use super::types::*;
use crate::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{File, OpenOptions},
    io::Write,
};

const EVENT_BYTES: usize = 2048;
const SEGMENT_BYTES: usize = 256 * 1024;
const STORE_BYTES: usize = 16 * 1024 * 1024;
const STORE_EVENTS: usize = 20_000;
const RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const PAGE_BYTES: usize = 128 * 1024;
// Includes manifest, atomic-save temporary and one bounded quarantined tail.
const RESERVED_BYTES: usize = 4 * SEGMENT_BYTES;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    epoch: String,
    cursor_key: String,
    next: u64,
    floor: u64,
    segments: VecDeque<u64>,
    gaps: u64,
    reconciled: u64,
    dropped: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    sequence: u64,
    time: i64,
    input: EventInput,
}
struct Indexed {
    record: Record,
    event_bytes: usize,
    bytes: usize,
    segment: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    epoch: String,
    scope: String,
    resource: Option<String>,
    after: u64,
    high: u64,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Query {
    pub since: Option<String>,
    pub resource: Option<String>,
    pub kinds: Option<BTreeSet<EventKind>>,
    pub limit: Option<usize>,
}
/// Already authenticated by the existing ingress/local authority boundary.
pub(crate) struct Reader {
    pub principal: Principal,
    pub revision: String,
}
impl Reader {
    fn identity(&self) -> Value {
        match &self.principal {
            Principal::Source { source_id, .. } => json!({"sourceId":source_id}),
            principal => json!(principal),
        }
    }
    fn scope(&self, query: &Query) -> String {
        hash(json!([self.identity(), self.revision, query.resource, query.kinds]).to_string())
    }
}
struct Bucket {
    tokens: f64,
    at: std::time::Instant,
}
pub(crate) struct Journal {
    dir: PathBuf,
    manifest: Manifest,
    records: BTreeMap<u64, Indexed>,
    transitions: BTreeMap<String, u64>,
    resources: BTreeMap<ResourceKey, usize>,
    bytes: usize,
    tail_bytes: usize,
    readers: BTreeMap<String, Bucket>,
    emission_second: i64,
    emissions: usize,
    #[cfg(test)]
    pub(crate) fail_append_after: Option<usize>,
}
fn io_error(_: impl std::fmt::Display) -> String {
    "COORDINATION_STORAGE: journal I/O failed; restore local disk capacity and retry the same transition or cursor".into()
}
fn corrupt() -> String {
    "COORDINATION_CORRUPT: preserve coordination/events for local recovery; do not reset it silently".into()
}
fn private_file(path: &Path, append: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(io_error)
}
fn sync_directory(dir: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(dir)
        .and_then(|f| f.sync_all())
        .map_err(io_error)?;
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}
/// Same private directory/atomic rename convention as save_bytes, with fsync and a
/// fixed temporary name so repeated disk-full failures cannot accumulate files.
pub(super) fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let before = crate::kernel::file_cache::Stamp::read(path.parent().unwrap())?;
    let temp = path.with_extension("tmp");
    let result = (|| {
        let mut file = private_file(&temp, false)?;
        file.write_all(bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        std::fs::rename(&temp, path).map_err(io_error)?;
        sync_directory(path.parent().unwrap())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    crate::kernel::file_cache::changed(path, before);
    result
}
impl Journal {
    pub(crate) fn open(dir: PathBuf, time: i64) -> Result<Self> {
        private_dir(&dir).map_err(io_error)?;
        let path = dir.join("manifest.json");
        let manifest: Manifest = if path.exists() {
            let metadata = std::fs::metadata(&path).map_err(io_error)?;
            if metadata.len() > SEGMENT_BYTES as u64 {
                return Err(corrupt());
            }
            serde_json::from_slice(&std::fs::read(&path).map_err(io_error)?)
                .map_err(|_| corrupt())?
        } else {
            // Missing metadata on an existing store is a reset, never silently reuse cursors.
            if std::fs::read_dir(&dir).map_err(io_error)?.next().is_some() {
                return Err(corrupt());
            }
            Manifest {
                epoch: id(),
                cursor_key: id(),
                next: 1,
                floor: 0,
                segments: VecDeque::new(),
                gaps: 0,
                reconciled: 0,
                dropped: 0,
            }
        };
        if manifest.next == 0
            || manifest.floor >= manifest.next
            || manifest.segments.len() > 128
            || manifest
                .segments
                .iter()
                .zip(manifest.segments.iter().skip(1))
                .any(|(a, b)| a >= b)
            || manifest
                .segments
                .iter()
                .any(|seq| *seq == 0 || *seq >= manifest.next)
        {
            return Err(corrupt());
        }
        let mut store = Self {
            dir,
            manifest,
            records: BTreeMap::new(),
            transitions: BTreeMap::new(),
            resources: BTreeMap::new(),
            bytes: 0,
            tail_bytes: 0,
            readers: BTreeMap::new(),
            emission_second: 0,
            emissions: 0,
            #[cfg(test)]
            fail_append_after: None,
        };
        // Enumeration occurs only at startup. Retention commits its floor/list before
        // unlinking; finish those interrupted deletes without scanning during polls.
        let mut files = 0;
        let mut disk_bytes = 0;
        for entry in std::fs::read_dir(&store.dir).map_err(io_error)? {
            files += 1;
            if files > 132 {
                return Err(
                    "COORDINATION_CAPACITY: too many journal files; local recovery required".into(),
                );
            }
            let entry = entry.map_err(io_error)?;
            let meta = entry.metadata().map_err(io_error)?;
            if !meta.is_file() || meta.len() > SEGMENT_BYTES as u64 {
                return Err(corrupt());
            }
            disk_bytes += meta.len();
            if disk_bytes > STORE_BYTES as u64 {
                return Err("COORDINATION_CAPACITY: journal exceeds its disk budget".into());
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(seq) = name
                .strip_suffix(".jsonl")
                .and_then(|s| s.parse::<u64>().ok())
            {
                if !store.manifest.segments.contains(&seq) {
                    if seq > store.manifest.floor {
                        return Err(corrupt());
                    }
                    std::fs::remove_file(entry.path()).map_err(io_error)?;
                }
            } else if !matches!(
                name.as_str(),
                "manifest.json" | "manifest.tmp" | "tail.quarantine" | "tail.tmp"
            ) {
                return Err(corrupt());
            }
        }
        let segments = store.manifest.segments.clone();
        let mut expected = store.manifest.floor + 1;
        for segment in segments {
            let path = store.segment_path(segment);
            let bytes = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                Err(e)
                    if e.kind() == std::io::ErrorKind::NotFound
                        && Some(&segment) == store.manifest.segments.back() =>
                {
                    vec![]
                }
                Err(_) => return Err(corrupt()),
            };
            let mut valid_end = 0;
            for line in bytes.split_inclusive(|b| *b == b'\n') {
                let parsed = if line.len() <= EVENT_BYTES && line.last() == Some(&b'\n') {
                    serde_json::from_slice::<Record>(line).ok()
                } else {
                    None
                };
                let Some(record) = parsed else {
                    // Only the incomplete final record can be repaired automatically.
                    if Some(&segment) != store.manifest.segments.back()
                        || valid_end + line.len() != bytes.len()
                    {
                        return Err(corrupt());
                    }
                    atomic_bytes(&store.dir.join("tail.quarantine"), &bytes[valid_end..])?;
                    store.manifest.gaps = store.manifest.gaps.saturating_add(1);
                    store.persist()?; // coverage first; never truncate before quarantine is durable
                    let file = OpenOptions::new()
                        .write(true)
                        .open(&path)
                        .map_err(io_error)?;
                    file.set_len(valid_end as u64).map_err(io_error)?;
                    file.sync_all().map_err(io_error)?;
                    break;
                };
                if record.sequence < expected || record.sequence >= store.manifest.next {
                    return Err(corrupt());
                }
                if record.sequence != expected && record.sequence - 1 > store.manifest.reconciled {
                    store.manifest.gaps = store.manifest.gaps.saturating_add(1);
                }
                expected = record.sequence + 1;
                let event = record
                    .input
                    .project(&store.manifest.epoch, record.sequence, record.time)
                    .map_err(|_| corrupt())?;
                if serde_json::to_vec(&event).unwrap().len() > EVENT_BYTES {
                    return Err(corrupt());
                }
                store.index(record, event, line.len(), segment)?;
                if store.records.len() > STORE_EVENTS || store.bytes > STORE_BYTES - RESERVED_BYTES
                {
                    return Err(corrupt());
                }
                valid_end += line.len();
            }
            store.tail_bytes = valid_end;
        }
        if expected < store.manifest.next && store.manifest.next - 1 > store.manifest.reconciled {
            store.manifest.gaps = store.manifest.gaps.saturating_add(1);
        }
        store.manifest.reconciled = store.manifest.next - 1;
        store.prune(time, 0)?;
        store.persist()?;
        Ok(store)
    }
    fn segment_path(&self, first: u64) -> PathBuf {
        self.dir.join(format!("{first:020}.jsonl"))
    }
    fn persist(&self) -> Result<()> {
        let bytes = serde_json::to_vec(&self.manifest).map_err(io_error)?;
        if bytes.len() > SEGMENT_BYTES {
            return Err("COORDINATION_CAPACITY: journal manifest is full".into());
        }
        atomic_bytes(&self.dir.join("manifest.json"), &bytes)
    }
    fn index(&mut self, record: Record, event: Value, bytes: usize, segment: u64) -> Result<()> {
        if self.transitions.contains_key(&record.input.transition_id) {
            return Err(corrupt());
        }
        for key in &record.input.resources {
            *self.resources.entry(key.clone()).or_default() += 1;
        }
        self.transitions
            .insert(record.input.transition_id.clone(), record.sequence);
        self.bytes += bytes;
        self.records.insert(
            record.sequence,
            Indexed {
                record,
                event_bytes: serde_json::to_vec(&event).unwrap().len(),
                bytes,
                segment,
            },
        );
        Ok(())
    }
    fn prune(&mut self, time: i64, incoming: usize) -> Result<()> {
        loop {
            let expired = self
                .records
                .first_key_value()
                .is_some_and(|(_, r)| time.saturating_sub(r.record.time) >= RETENTION_MS);
            let full = self.bytes + incoming > STORE_BYTES - RESERVED_BYTES
                || self.records.len() + usize::from(incoming > 0) > STORE_EVENTS;
            if !expired && !full {
                break;
            }
            let Some(segment) = self.manifest.segments.front().copied() else {
                return Err("COORDINATION_CAPACITY: event cannot fit".into());
            };
            let end = self
                .records
                .values()
                .take_while(|r| r.segment == segment)
                .last()
                .map(|r| r.record.sequence)
                .unwrap_or(segment);
            let previous = self.manifest.clone();
            self.manifest.floor = self.manifest.floor.max(end);
            self.manifest.segments.pop_front();
            if let Err(error) = self.persist() {
                self.manifest = previous;
                return Err(error);
            }
            let path = self.segment_path(segment);
            // Remove memory immediately after the durable floor, even if unlink fails.
            let expired: Vec<_> = self.records.range(..=end).map(|(seq, _)| *seq).collect();
            for seq in expired {
                let r = self.records.remove(&seq).unwrap();
                self.transitions.remove(&r.record.input.transition_id);
                self.bytes -= r.bytes;
                for key in r.record.input.resources {
                    if let Some(count) = self.resources.get_mut(&key) {
                        *count -= 1;
                        if *count == 0 {
                            self.resources.remove(&key);
                        }
                    }
                }
            }
            if self.manifest.segments.is_empty() {
                self.tail_bytes = 0;
            }
            match std::fs::remove_file(path) {
                Ok(()) => sync_directory(&self.dir)?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(io_error(e)),
            }
        }
        Ok(())
    }
    pub(crate) fn emit(&mut self, input: EventInput, time: i64) -> Result<Value> {
        // Validate before retention or sequence allocation, including oversized replays.
        let sequence = self.manifest.next;
        let event = input.project(&self.manifest.epoch, sequence, time)?;
        let record = Record {
            sequence,
            time,
            input,
        };
        let mut bytes = serde_json::to_vec(&record).map_err(io_error)?;
        bytes.push(b'\n');
        if bytes.len() > EVENT_BYTES || serde_json::to_vec(&event).unwrap().len() > EVENT_BYTES {
            return Err("COORDINATION_CAPACITY: projected event must fit 2 KiB".into());
        }
        if let Some(seq) = self.transitions.get(&record.input.transition_id) {
            let previous = &self.records[seq];
            if serde_json::to_value(&previous.record.input).unwrap()
                != serde_json::to_value(&record.input).unwrap()
            {
                return Err(
                    "COORDINATION_TRANSITION_CONFLICT: retain the original transition payload"
                        .into(),
                );
            }
            return Ok(
                json!({"eventId":hash(format!("{}:{}", self.manifest.epoch, previous.record.input.transition_id)),"sequence":seq,"duplicate":true}),
            );
        }
        if self.emission_second != time / 1000 {
            self.emission_second = time / 1000;
            self.emissions = 0;
        }
        if self.emissions >= 100 {
            self.manifest.dropped = self.manifest.dropped.saturating_add(1);
            self.persist()?;
            return Err(
                "COORDINATION_RATE_LIMIT: retry the pending transition after one second".into(),
            );
        }
        self.prune(time, bytes.len())?;
        let old = self.manifest.clone();
        let rotate =
            self.manifest.segments.is_empty() || self.tail_bytes + bytes.len() > SEGMENT_BYTES;
        if rotate {
            self.manifest.segments.push_back(sequence);
        }
        self.manifest.next = sequence
            .checked_add(1)
            .ok_or("COORDINATION_CAPACITY: sequence exhausted")?;
        // Reserve before append: a torn write never reuses an allocated sequence.
        if let Err(error) = self.persist() {
            self.manifest = old;
            return Err(error);
        }
        let segment = *self.manifest.segments.back().unwrap();
        let path = self.segment_path(segment);
        let offset = if rotate { 0 } else { self.tail_bytes };
        let result = (|| {
            let mut file = private_file(&path, true)?;
            #[cfg(test)]
            if let Some(count) = self.fail_append_after.take() {
                file.write_all(&bytes[..count.min(bytes.len())])
                    .map_err(io_error)?;
                file.sync_all().map_err(io_error)?;
                return Err(io_error("injected disk full"));
            }
            file.write_all(&bytes).map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
            if rotate {
                sync_directory(&self.dir)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            self.manifest.gaps = self.manifest.gaps.saturating_add(1);
            // Reload/recover before any further append; caller must discard this instance.
            return Err(error);
        }
        self.tail_bytes = offset + bytes.len();
        self.emissions += 1;
        self.index(record, event.clone(), bytes.len(), segment)?;
        Ok(json!({"eventId":event["eventId"],"sequence":sequence,"duplicate":false}))
    }
    fn encode(&self, cursor: Cursor) -> String {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).unwrap());
        let signature = hash(format!("{}:{payload}", self.manifest.cursor_key));
        format!("{payload}.{signature}")
    }
    fn decode(&self, encoded: &str) -> std::result::Result<Cursor, &'static str> {
        if encoded.len() > 2048 {
            return Err("CURSOR_EXPIRED");
        }
        let (payload, signature) = encoded.split_once('.').ok_or("CURSOR_EXPIRED")?;
        let cursor: Cursor = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(payload)
                .map_err(|_| "CURSOR_EXPIRED")?,
        )
        .map_err(|_| "CURSOR_EXPIRED")?;
        if cursor.epoch != self.manifest.epoch
            || signature != hash(format!("{}:{payload}", self.manifest.cursor_key))
        {
            return Err("CURSOR_EXPIRED");
        }
        Ok(cursor)
    }
    fn coverage(&self) -> Value {
        json!({"state":if self.manifest.gaps > 0 || self.manifest.dropped > 0 {"partial"} else {"complete"},
            "gaps":self.manifest.gaps,"dropped":self.manifest.dropped,"retainedAfterSequence":self.manifest.floor,
            "retainedEvents":self.records.len(),"retainedBytes":self.bytes})
    }
    fn pull_budget(&mut self, reader: &Reader) -> Result<()> {
        let key = hash(reader.identity().to_string());
        let now = std::time::Instant::now();
        if !self.readers.contains_key(&key) && self.readers.len() >= 4096 {
            self.readers
                .retain(|_, b| now.duration_since(b.at).as_secs() < 60);
            if self.readers.len() >= 4096 {
                return Err(
                    "COORDINATION_CAPACITY: reader budget full; retry after one minute".into(),
                );
            }
        }
        let bucket = self.readers.entry(key).or_insert(Bucket {
            tokens: 10.0,
            at: now,
        });
        bucket.tokens = (bucket.tokens + now.duration_since(bucket.at).as_secs_f64()).min(10.0);
        bucket.at = now;
        if bucket.tokens < 1.0 {
            return Err("COORDINATION_RATE_LIMIT: retry events after one second".into());
        }
        bucket.tokens -= 1.0;
        Ok(())
    }
    pub(crate) fn query(&mut self, reader: &Reader, mut query: Query, time: i64) -> Result<Value> {
        self.pull_budget(reader)?;
        self.prune(time, 0)?;
        let limit = query.limit.unwrap_or(50);
        if !(1..=200).contains(&limit)
            || query
                .kinds
                .as_ref()
                .is_some_and(|k| k.len() > 16 || k.is_empty())
        {
            return Err(
                "INVALID_ARGUMENT: events limit is 1..200 and kinds contains 1..16 kinds".into(),
            );
        }
        let decoded = query.since.as_ref().map(|since| self.decode(since));
        if let Some(resource) = &query.resource {
            let key = ResourceKey::parse(resource)?;
            // A signed cursor retains its resolved parent even after that lane's
            // last event expires; reset must not depend on retained resource rows.
            let retained = key.shorthand().and_then(|name| {
                decoded
                    .as_ref()
                    .and_then(|result| result.as_ref().ok())
                    .and_then(|cursor| cursor.resource.as_ref())
                    .filter(|key| key.starts_with("lane:") && key.ends_with(&format!("/{name}")))
            });
            query.resource = Some(match retained {
                Some(key) => key.clone(),
                None => resolve_resource(resource, self.resources.keys())?
                    .as_str()
                    .to_owned(),
            });
        }
        let scope = reader.scope(&query);
        let high = self.manifest.next - 1;
        let cursor = |after, high| {
            self.encode(Cursor {
                epoch: self.manifest.epoch.clone(),
                scope: scope.clone(),
                resource: query.resource.clone(),
                after,
                high,
            })
        };
        let oldest = cursor(self.manifest.floor, high);
        let matches = |r: &&Indexed| {
            query
                .resource
                .as_ref()
                .is_none_or(|key| r.record.input.resources.iter().any(|r| r.as_str() == key))
                && query
                    .kinds
                    .as_ref()
                    .is_none_or(|kinds| kinds.contains(&r.record.input.kind))
        };
        let validation = decoded.map(|decoded| {
            decoded.and_then(|c| {
                if c.scope != scope {
                    Err("CURSOR_SCOPE_CHANGED")
                } else if c.after < self.manifest.floor
                    || c.after > high
                    || c.high > high
                    || c.after > c.high
                {
                    Err("CURSOR_EXPIRED")
                } else {
                    Ok(c)
                }
            })
        });
        let (after, snapshot) = match validation {
            Some(Err(code)) => {
                return Ok(
                    json!({"state":"failed","error":{"code":code,"message":"Event replay has a gap; restart from resetCursor with the current filters"},
                    "events":[],"resetCursor":oldest,"oldestCursor":oldest,"nextCursor":oldest,"hasMore":false,
                    "coverage":{"state":"partial","gap":code},"observedAt":timestamp(time),
                    "next":{"via":"query","op":"events","args":reset_args(&query, &oldest, limit)}}),
                );
            }
            Some(Ok(c)) => (c.after, if c.after == c.high { high } else { c.high }),
            None => {
                let mut start = high;
                let mut bytes = 4096 + super::observers::COVERAGE_BYTES;
                for record in self.records.values().rev().filter(matches).take(limit) {
                    bytes += record.event_bytes;
                    if bytes > PAGE_BYTES {
                        break;
                    }
                    start = record.record.sequence - 1;
                }
                (start, high)
            }
        };
        let mut events = Vec::new();
        let mut bytes = 4096 + super::observers::COVERAGE_BYTES; // envelope/cursors/coverage allowance
        let mut position = after;
        for (sequence, record) in self.records.range((
            std::ops::Bound::Excluded(after),
            std::ops::Bound::Included(snapshot),
        )) {
            if matches(&record) {
                let size = record.event_bytes;
                if events.len() == limit || bytes + size > PAGE_BYTES {
                    break;
                }
                bytes += size;
                events.push(record.record.input.project(
                    &self.manifest.epoch,
                    record.record.sequence,
                    record.record.time,
                )?);
            }
            position = *sequence;
        }
        // Missing reserved sequences and nonmatching rows still advance the cursor.
        let more = self
            .records
            .range((
                std::ops::Bound::Excluded(position),
                std::ops::Bound::Included(snapshot),
            ))
            .any(|(_, r)| matches(&r));
        if !more {
            position = snapshot;
        }
        Ok(
            json!({"events":events,"nextCursor":cursor(position,snapshot),"hasMore":more,
            "oldestCursor":oldest,"coverage":self.coverage(),"observedAt":timestamp(time)}),
        )
    }
}

fn reset_args(query: &Query, cursor: &str, limit: usize) -> Value {
    let mut args = json!({"since":cursor,"limit":limit});
    if let Some(resource) = &query.resource {
        args["resource"] = json!(resource);
    }
    if let Some(kinds) = &query.kinds {
        args["kinds"] = json!(kinds);
    }
    args
}

impl Journal {
    /// Internal metadata snapshot, bounded by the journal's 20,000 retained events.
    pub(super) fn recovery_events(&self) -> Result<(Vec<Value>, bool)> {
        let events = self
            .records
            .values()
            .map(|r| {
                r.record
                    .input
                    .project(&self.manifest.epoch, r.record.sequence, r.record.time)
            })
            .collect::<Result<_>>()?;
        Ok((events, self.manifest.floor > 0 || self.manifest.gaps > 0))
    }
}
