//! On-demand native metadata. Transcript paths never enter the public row.
use super::*;
use crate::kernel::file_cache::{Cache as DirectoryCache, Stamp};
use std::{io::Read, time::SystemTime};

const DERIVATION_VERSION: u32 = 2;
const HEAD_BYTES: u64 = 64 * 1024;
const TAIL_BYTES: u64 = 128 * 1024;

#[derive(Clone)]
pub(super) struct Session {
    pub path: PathBuf,
    pub row: Arc<Value>,
}
struct Derived {
    stamp: Stamp,
    version: u32,
    row: Option<Arc<Value>>,
}
#[derive(Default)]
pub(super) struct Index {
    directories: DirectoryCache<Value>,
    files: HashMap<PathBuf, Derived>,
}

pub(super) fn roots() -> Vec<(String, PathBuf, Option<String>)> {
    let mut roots: Vec<_> = crate::accounts::claude::transcript_roots()
        .into_iter()
        .map(|(path, account)| ("claude".into(), path, account))
        .collect();
    if let Some(home) = dirs::home_dir() {
        let expand = |value: std::ffi::OsString| {
            let path = PathBuf::from(value);
            path.strip_prefix("~")
                .map(|rest| home.join(rest))
                .unwrap_or(path)
        };
        let agent = std::env::var_os("PI_CODING_AGENT_DIR")
            .filter(|v| !v.is_empty())
            .map(&expand)
            .unwrap_or_else(|| home.join(".pi/agent"));
        roots.push(("pi".into(), agent.join("sessions"), None));
        if let Some(path) =
            std::env::var_os("PI_CODING_AGENT_SESSION_DIR").filter(|v| !v.is_empty())
        {
            roots.push(("pi".into(), expand(path), None));
        }
    }
    roots.push(("pi".into(), root().join("agents/pi-sessions"), None));
    roots
}

impl Index {
    pub(super) fn scan(&mut self, roots: &[(String, PathBuf, Option<String>)]) -> Vec<Session> {
        let mut seen = HashSet::new();
        let mut sessions = Vec::new();
        for (agent, root, account) in roots {
            let mut directories = vec![root.clone()];
            while let Some(directory) = directories.pop() {
                let Ok(entries) = self.directories.entries(&directory) else {
                    continue;
                };
                for entry in entries.iter() {
                    let path = &entry.path;
                    if entry.kind.is_symlink()
                        || path
                            .file_name()
                            .is_some_and(|s| s.to_string_lossy().starts_with('.'))
                        || (agent == "claude" && activity::claude_sidechain(path, &[]))
                    {
                        continue;
                    }
                    if entry.kind.is_dir() {
                        directories.push(path.clone());
                        continue;
                    }
                    if !entry.kind.is_file()
                        || path.extension().is_none_or(|e| e != "jsonl")
                        || !seen.insert(path.clone())
                    {
                        continue;
                    }
                    let Ok(metadata) = std::fs::metadata(path) else {
                        continue;
                    };
                    let stamp = Stamp::from_metadata(&metadata);
                    let stale = self
                        .files
                        .get(path)
                        .is_none_or(|row| row.stamp != stamp || row.version != DERIVATION_VERSION);
                    if stale {
                        // Do not serve the old row if a changed file is unreadable or races a write.
                        self.files.remove(path);
                        let Ok((head, tail, complete)) = sample(path, metadata.len()) else {
                            continue;
                        };
                        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                        let row =
                            derive(agent, path, &head, &tail, complete, modified).map(Arc::new);
                        if Stamp::read(path).ok().flatten().as_ref() != Some(&stamp) {
                            continue;
                        }
                        self.files.insert(
                            path.clone(),
                            Derived {
                                stamp,
                                version: DERIVATION_VERSION,
                                row,
                            },
                        );
                    }
                    if let Some(row) = self.files.get(path).and_then(|cached| cached.row.clone()) {
                        // Account attribution is configuration, not a transcript derivation.
                        let row = if let Some(account) = account {
                            let mut value = (*row).clone();
                            value["agentAccountId"] = json!(account);
                            Arc::new(value)
                        } else {
                            row
                        };
                        sessions.push(Session {
                            path: path.clone(),
                            row,
                        });
                    }
                }
            }
        }
        self.files.retain(|path, _| seen.contains(path));
        // Duplicated transcript copies resolve deterministically to the newest copy.
        sessions.sort_by(|a, b| {
            string(&b.row, "updatedAt")
                .cmp(string(&a.row, "updatedAt"))
                .then_with(|| a.path.cmp(&b.path))
        });
        let mut identities = HashSet::new();
        sessions.retain(|s| {
            identities.insert((
                string(&s.row, "agent").to_owned(),
                string(&s.row, "id").to_owned(),
            ))
        });
        sessions
    }
}

fn sample(path: &Path, size: u64) -> Result<(Vec<Value>, Vec<Value>, bool)> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|e| e.to_string())?
        .take(HEAD_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let complete = size <= HEAD_BYTES;
    if !complete {
        bytes.truncate(
            bytes
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map_or(0, |i| i + 1),
        );
    }
    let head = bytes
        .split(|byte| *byte == b'\n')
        .filter_map(|line| serde_json::from_slice(line).ok())
        .collect();
    let tail = if complete {
        Vec::new()
    } else {
        activity::read_tail(path, TAIL_BYTES)?.0
    };
    Ok((head, tail, complete))
}

fn text_content(record: &Value) -> String {
    let content = &record["message"]["content"];
    if let Some(text) = content.as_str() {
        return text.to_owned();
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join(" ")
}
fn short(text: &str, limit: usize) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}
fn normalized_time(value: &Value) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|at| {
            at.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
}

pub(super) fn derive(
    agent: &str,
    path: &Path,
    head: &[Value],
    tail: &[Value],
    complete: bool,
    modified: SystemTime,
) -> Option<Value> {
    let records: Vec<_> = head
        .iter()
        .chain(tail)
        .filter(|record| agent != "claude" || record["isSidechain"] != true)
        .collect();
    if agent == "claude" && activity::claude_sidechain(path, head.iter().chain(tail)) {
        return None;
    }
    let header = head.iter().find(|record| record["type"] == "session");
    let id = if agent == "pi" {
        let header = header?;
        // The current tree format is explicit; older/unknown formats are not guessed.
        if header["version"] != 3 {
            return None;
        }
        header["id"].as_str()?
    } else {
        path.file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| uuid::Uuid::parse_str(s).is_ok())
            .or_else(|| records.iter().find_map(|r| r["sessionId"].as_str()))?
    };
    uuid::Uuid::parse_str(id).ok()?;
    let mut title = crate::task_tracking::TranscriptTitle::default();
    let mut preview = String::new();
    let mut messages = 0;
    let mut project = None;
    for record in &records {
        if let Some(cwd) = record["cwd"].as_str() {
            project = Some(cwd)
        }
        title.observe(record);
        let role = string(&record["message"], "role");
        if matches!(role, "user" | "assistant" | "toolResult") {
            messages += 1
        }
        let text = text_content(record);
        if role == "assistant" && !text.trim().is_empty() {
            preview = short(&text, 240);
        }
    }
    let updated = chrono::DateTime::<chrono::Utc>::from(modified)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let created = records
        .iter()
        .find_map(|r| normalized_time(&r["timestamp"]))
        .unwrap_or_else(|| updated.clone());
    Some(
        json!({"agent":agent,"id":id,"nativeSessionId":id,"source":"native",
        "title":title.value(),"preview":preview,
        "project":project,"createdAt":created,"updatedAt":updated,"status":null,
        "messageCount":if complete { Some(messages) } else { None },"metadataPartial":!complete}),
    )
}

pub(super) fn timeline(session: &Session) -> Result<Value> {
    let id = string(&session.row, "id");
    if session.row["agent"] == "claude" {
        return activity::claude_timeline(&session.path, id);
    }
    let (records, truncated) = activity::read_tail(&session.path, 8 * 1024 * 1024)?;
    Ok(pi_timeline(id, &records, truncated))
}

// Pi v3 is a tree. Replay only the latest leaf's ancestry, bounded by the tail.
pub(super) fn pi_timeline(id: &str, records: &[Value], truncated: bool) -> Value {
    let mut timeline = crate::task_tracking::Timeline::default();
    timeline.partial = truncated;
    let entries: HashMap<_, _> = records
        .iter()
        .filter(|r| r["type"] != "session")
        .filter_map(|r| r["id"].as_str().map(|id| (id, r)))
        .collect();
    let mut next = records
        .iter()
        .rev()
        .find(|r| r["type"] != "session")
        .and_then(|r| r["id"].as_str());
    let mut branch = Vec::new();
    let mut seen = HashSet::new();
    while let Some(id) = next {
        let Some(record) = entries.get(id).filter(|_| seen.insert(id)) else {
            timeline.partial = true;
            break;
        };
        branch.push(*record);
        next = record["parentId"].as_str();
    }
    for record in branch.into_iter().rev() {
        if record["type"] == "compaction" {
            timeline.agent("compaction_end", &json!({"result":{"tokensBefore":record["tokensBefore"]},"reason":record["trigger"]}), string(record, "timestamp"));
            continue;
        }
        if record["type"] != "message" {
            if matches!(string(record, "type"), "branch_summary" | "custom_message") {
                timeline.partial = true;
            }
            continue;
        }
        let message = &record["message"];
        let at = string(record, "timestamp");
        match string(message, "role") {
            "user" => {
                let text = crate::task_tracking::transcript_user_text(record, &text_content(record));
                if !text.trim().is_empty() {
                    timeline.agent("arc/user", &json!({"turnId":record["id"],"text":text}), at);
                }
            },
            "assistant" => {
                timeline.agent("message_end", &json!({"message":message}), at);
            }
            "toolResult" => timeline.agent("tool_execution_end", &json!({"toolCallId":message["toolCallId"],"toolName":message["toolName"],"isError":message["isError"],"result":message}), at),
            _ => timeline.partial = true,
        }
    }
    // A history read establishes no live runtime status or approval ownership.
    let mut result = timeline.response(id, 0);
    result["status"] = Value::Null;
    result["readOnly"] = json!(true);
    result
}
