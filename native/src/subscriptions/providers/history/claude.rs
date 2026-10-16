use super::{discover, time, Event, Scan};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader},
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

#[derive(Default, Clone)]
struct FileScan {
    messages: HashMap<String, Event>,
    incomplete: bool,
}
type Cache = HashMap<PathBuf, (u64, SystemTime, FileScan)>;
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

// Content blocks and copied parent conversations repeat message usage. Streaming
// snapshots may precede final output counts; keep the largest cumulative counts.
fn merge(messages: &mut HashMap<String, Event>, id: String, event: Event) {
    messages
        .entry(id)
        .and_modify(|old| {
            old.at = old.at.min(event.at);
            old.input = old.input.max(event.input);
            old.cached = old.cached.max(event.cached);
            old.output = old.output.max(event.output);
            old.write = old.write.max(event.write);
            old.write_hour = old.write_hour.max(event.write_hour);
            old.fast |= event.fast;
        })
        .or_insert(event);
}

pub(super) fn scan() -> Scan {
    let Some(root) = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|p| p.join(".claude")))
    else {
        return Scan {
            incomplete: true,
            ..Default::default()
        };
    };
    let mut paths = Vec::new();
    let mut incomplete = false;
    discover(
        &root.join("projects"),
        "jsonl",
        &mut paths,
        &mut HashSet::new(),
        &mut incomplete,
    );
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut messages = HashMap::new();
    for path in &paths {
        let Ok(meta) = std::fs::metadata(path) else {
            incomplete = true;
            continue;
        };
        let stamp = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if cache
            .get(path)
            .is_none_or(|(len, modified, _)| *len != meta.len() || *modified != stamp)
        {
            let mut scan = FileScan::default();
            let Ok(file) = std::fs::File::open(path) else {
                incomplete = true;
                continue;
            };
            for line in BufReader::new(file).lines() {
                let Ok(line) = line else {
                    scan.incomplete = true;
                    continue;
                };
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(row) = serde_json::from_str::<Value>(&line) else {
                    scan.incomplete = true;
                    continue;
                };
                if row["type"] != "assistant" {
                    continue;
                }
                let message = &row["message"];
                let usage = &message["usage"];
                if message["model"] == "<synthetic>" || usage.is_null() {
                    continue;
                }
                let (Some(id), Some(at), Some(input), Some(output)) = (
                    message["id"].as_str().filter(|id| !id.is_empty()),
                    row["timestamp"].as_str().and_then(time),
                    usage["input_tokens"].as_u64(),
                    usage["output_tokens"].as_u64(),
                ) else {
                    scan.incomplete = true;
                    continue;
                };
                let write = usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                let write_hour = usage["cache_creation"]["ephemeral_1h_input_tokens"]
                    .as_u64()
                    .unwrap_or(0);
                if write_hour > write {
                    scan.incomplete = true;
                    continue;
                }
                merge(
                    &mut scan.messages,
                    id.to_owned(),
                    Event {
                        at,
                        model: message["model"].as_str().unwrap_or_default().to_owned(),
                        input,
                        output,
                        cached: usage["cache_read_input_tokens"].as_u64().unwrap_or(0),
                        write,
                        write_hour,
                        fast: usage["speed"] == "fast",
                    },
                );
            }
            cache.insert(path.clone(), (meta.len(), stamp, scan));
        }
        let scan = &cache[path].2;
        incomplete |= scan.incomplete;
        for (id, event) in &scan.messages {
            merge(&mut messages, id.clone(), event.clone());
        }
    }
    cache.retain(|p, _| paths.contains(p));
    Scan {
        events: messages.into_values().collect(),
        incomplete,
    }
}
