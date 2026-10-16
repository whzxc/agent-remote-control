// Source formats and pricing snapshot adapted from OpenUsage (MIT); see shared/pricing/LICENSE.OpenUsage.
mod antigravity;
mod claude;
mod csv;
mod pricing;
use chrono::{DateTime, Local, Utc};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
#[derive(Clone)]
pub(super) struct Event {
    at: i64,
    model: String,
    input: u64,
    cached: u64,
    output: u64,
    write: u64,
    write_hour: u64,
    fast: bool,
}
impl Event {
    fn tokens(&self) -> u64 {
        self.input
            .saturating_add(self.cached)
            .saturating_add(self.output)
            .saturating_add(self.write)
    }
}
#[derive(Default, Clone)]
pub(super) struct Scan {
    events: Vec<Event>,
    incomplete: bool,
}
type Cache = HashMap<PathBuf, (u64, std::time::SystemTime, Scan)>;
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
pub async fn local(provider: &str) -> Value {
    if provider == "codex" {
        return tokio::task::spawn_blocking(|| {
            let cutoff = (Utc::now() - chrono::Duration::days(32)).timestamp_millis();
            let mut missing = false;
            let mut events = Vec::new();
            let incomplete = crate::usage::visit_responses(|r| {
                if !r.reliable {
                    missing = true;
                    return;
                }
                let (Some(input), Some(cached), Some(output)) =
                    (r.tokens.input, r.tokens.cached, r.tokens.output)
                else {
                    missing = true;
                    return;
                };
                let Some(input) = input.checked_sub(cached) else {
                    missing = true;
                    return;
                };
                if r.at < cutoff {
                    return;
                }
                events.push(Event {
                    at: r.at,
                    model: r.model.unwrap_or_default(),
                    input,
                    cached,
                    output,
                    write: 0,
                    write_hour: 0,
                    fast: r
                        .service_tier
                        .as_deref()
                        .is_some_and(|s| ["fast", "priority"].contains(&s)),
                });
            });
            summarize(events, "codex", missing || incomplete, &pricing::current())
        })
        .await
        .unwrap_or_else(|_| json!({"error":"history-unavailable"}));
    }
    if provider == "claude-code" {
        return tokio::task::spawn_blocking(|| {
            let scan = claude::scan();
            summarize(
                scan.events,
                "claude-code",
                scan.incomplete,
                &pricing::current(),
            )
        })
        .await
        .unwrap_or_else(|_| json!({"error":"history-unavailable"}));
    }
    let prices = pricing::current();
    let provider = provider.to_string();
    tokio::task::spawn_blocking(move || {
        let Some(home) = dirs::home_dir() else {
            return json!({"error":"history-unavailable"});
        };
        let mut paths = vec![];
        let mut visited = HashSet::new();
        let mut incomplete = false;
        if provider == "codex" {
            let root = std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"));
            for folder in ["sessions", "archived_sessions"] {
                discover(
                    &root.join(folder),
                    "jsonl",
                    &mut paths,
                    &mut visited,
                    &mut incomplete,
                );
            }
        } else {
            match std::fs::read_dir(home.join(".gemini")) {
                Ok(entries) => {
                    for entry in entries
                        .flatten()
                        .filter(|e| e.file_name().to_string_lossy().starts_with("antigravity"))
                    {
                        discover(
                            &entry.path().join("conversations"),
                            "",
                            &mut paths,
                            &mut visited,
                            &mut incomplete,
                        );
                    }
                }
                Err(e) => incomplete = e.kind() != std::io::ErrorKind::NotFound,
            }
        }
        let mut cache = CACHE
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let cutoff = Utc::now() - chrono::Duration::days(32);
        let mut events = vec![];
        for path in &paths {
            let Ok(meta) = std::fs::metadata(path) else {
                incomplete = true;
                continue;
            };
            let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            // SQLite WAL writes need to invalidate the cache too.
            let wal = std::fs::metadata(format!("{}-wal", path.display())).ok();
            let stamp = wal
                .as_ref()
                .and_then(|m| m.modified().ok())
                .map(|t| t.max(modified))
                .unwrap_or(modified);
            if DateTime::<Utc>::from(stamp) < cutoff {
                continue;
            }
            let len = meta.len() + wal.map(|m| m.len()).unwrap_or(0);
            let refresh = cache
                .get(path)
                .is_none_or(|(l, t, _)| *l != len || *t != stamp);
            if refresh {
                let scan = antigravity::scan(path);
                cache.insert(path.clone(), (len, stamp, scan));
            }
            let scan = &cache[path].2;
            incomplete |= scan.incomplete;
            events.extend(
                scan.events
                    .iter()
                    .filter(|e| e.at >= cutoff.timestamp_millis())
                    .cloned(),
            );
        }
        cache.retain(|p, _| p.exists());
        summarize(events, &provider, incomplete, &prices)
    })
    .await
    .unwrap_or_else(|_| json!({"error":"history-unavailable"}))
}
fn discover(
    path: &Path,
    extension: &str,
    out: &mut Vec<PathBuf>,
    seen: &mut HashSet<PathBuf>,
    bad: &mut bool,
) {
    if seen.len() > 50000 {
        *bad = true;
        return;
    }
    let path = match path.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                *bad = true
            }
            return;
        }
    };
    if !seen.insert(path.clone()) {
        return;
    }
    if path.is_dir() {
        match std::fs::read_dir(&path) {
            Ok(entries) => {
                for e in entries {
                    match e {
                        Ok(e) => discover(&e.path(), extension, out, seen, bad),
                        Err(_) => *bad = true,
                    }
                }
            }
            Err(_) => *bad = true,
        }
    } else if path.extension().and_then(|s| s.to_str()).is_some_and(|s| {
        if extension.is_empty() {
            ["db", "sqlite", "sqlite3"].contains(&s)
        } else {
            s == extension
        }
    }) {
        out.push(path);
    }
}
pub fn cursor_csv(bytes: &[u8]) -> Value {
    match csv::parse(bytes) {
        Ok(scan) => summarize(scan.events, "cursor", scan.incomplete, &pricing::current()),
        Err(()) => json!({"error":"history-unavailable"}),
    }
}
pub(super) fn time(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|d| d.timestamp_millis())
        .or_else(|| {
            use chrono::TimeZone;
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
                .ok()
                .and_then(|d| Local.from_local_datetime(&d).single())
                .map(|d| d.timestamp_millis())
        })
}
fn cost(e: &Event, provider: &str, p: &pricing::Pricing) -> Option<f64> {
    let mut model = e.model.trim().to_lowercase();
    if let Some((_, name)) = p.aliases.iter().find(|(re, _)| re.is_match(&model)) {
        model = name.clone();
    }
    if model == "gpt-reserve" {
        model = "gpt-5.6-luna".into();
    }
    let alias_fast = provider == "codex" && model.ends_with("-fast");
    if alias_fast {
        model = model.trim_end_matches("-fast").into();
    }
    let models = &p.data["models"];
    if models.get(&model).is_none() {
        model = model.rsplit('/').next()?.to_owned();
    }
    let r = models.get(&model)?;
    let mut i = r["i"].as_f64()?;
    let mut o = r["o"].as_f64()?;
    let mut cr = if provider == "codex" && r["cre"] == false {
        i
    } else {
        r["cr"].as_f64().unwrap_or(i)
    };
    let mut cw = r["cw"].as_f64().unwrap_or(i);
    if provider == "codex"
        && e.input + e.cached > 272000
        && [
            "gpt-5.4",
            "gpt-5.4-pro",
            "gpt-5.5",
            "gpt-5.5-pro",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-6-astra",
        ]
        .contains(&model.as_str())
    {
        i *= 2.;
        cr *= 2.;
        cw *= 2.;
        o *= 1.5;
    } else if provider != "cursor" && e.input + e.cached + e.write > 200000 {
        i = r["ia"].as_f64().unwrap_or(i);
        o = r["oa"].as_f64().unwrap_or(o);
        cr = r["cra"].as_f64().unwrap_or(cr);
        cw = r["cwa"].as_f64().unwrap_or(cw);
    }
    let multiplier = if e.fast || alias_fast {
        p.data["fast"][&model]
            .as_f64()
            .or_else(|| r["fast"].as_f64())
            .unwrap_or(if provider == "codex" { 2. } else { 1. })
    } else {
        1.
    };
    Some(
        (e.input as f64 * i
            + e.cached as f64 * cr
            + e.output as f64 * o
            + e.write.saturating_sub(e.write_hour) as f64 * cw
            + e.write_hour as f64 * i * 2.)
            / 1_000_000.
            * multiplier,
    )
}
fn summarize(
    events: Vec<Event>,
    provider: &str,
    incomplete: bool,
    prices: &pricing::Pricing,
) -> Value {
    let observed = Utc::now();
    let coverage_start = observed - chrono::Duration::days(32);
    let mut timeline: BTreeMap<i64, (u64, f64, u64)> = BTreeMap::new();
    let today = observed.with_timezone(&Local).date_naive();
    let since = today - chrono::Duration::days(29);
    let yesterday = today - chrono::Duration::days(1);
    let mut buckets: BTreeMap<&str, (u64, f64, u64, BTreeSet<String>)> =
        ["today", "yesterday", "last7", "last30"]
            .into_iter()
            .map(|s| (s, (0, 0., 0, BTreeSet::new())))
            .collect();
    let mut models: BTreeMap<&str, BTreeMap<String, (u64, f64, u64)>> = BTreeMap::new();
    for e in events {
        let Some(at) = DateTime::from_timestamp_millis(e.at) else {
            continue;
        };
        let day = at.with_timezone(&Local).date_naive();
        if at < coverage_start || at > observed || e.tokens() == 0 {
            continue;
        }
        let dollars = cost(&e, provider, prices);
        let entry = timeline.entry(e.at).or_default();
        entry.0 = entry.0.saturating_add(e.tokens());
        if let Some(d) = dollars {
            entry.1 += d;
            entry.2 = entry.2.saturating_add(e.tokens());
        }
        if day < since {
            continue;
        }
        for key in ["today", "yesterday", "last7", "last30"] {
            if key == "today" && day != today
                || key == "yesterday" && day != yesterday
                || key == "last7" && day < today - chrono::Duration::days(6)
            {
                continue;
            }
            let model = if e.model.trim().is_empty() {
                "unknown".into()
            } else {
                e.model.trim().to_lowercase()
            };
            let detail = models.entry(key).or_default().entry(model).or_default();
            detail.0 = detail.0.saturating_add(e.tokens());
            if let Some(d) = dollars {
                detail.1 += d;
                detail.2 = detail.2.saturating_add(e.tokens());
            }
            let b = buckets.get_mut(key).unwrap();
            b.0 = b.0.saturating_add(e.tokens());
            if let Some(d) = dollars {
                b.1 += d;
                b.2 = b.2.saturating_add(e.tokens());
            } else {
                b.3.insert(if e.model.is_empty() {
                    "unknown".into()
                } else {
                    e.model.clone()
                });
            }
        }
    }
    let periods:Vec<_>=["today","yesterday","last7","last30"].into_iter().map(|id|{
        let mut details: Vec<_> = models.get(id).into_iter().flat_map(|items| items.iter()).map(|(model,b)| json!({"model":model,"tokens":b.0,"estimatedUsd":if b.2>0{Some(b.1)}else{None},"pricedTokens":b.2})).collect();
        details.sort_by(|a,b| b["tokens"].as_u64().cmp(&a["tokens"].as_u64()));
        let b=&buckets[id];json!({"models":details,"id":id,"tokens":b.0,"estimatedUsd":if b.2>0{Some(b.1)}else{None},"pricedTokens":b.2,"unknownModels":b.3})
    }).collect();
    let timeline: Vec<_> = timeline
        .into_iter()
        .map(|(at, (tokens, usd, priced))| json!([at, tokens, usd, priced]))
        .collect();
    json!({"timeline":timeline,"coverageStart":coverage_start.to_rfc3339(),"periods":periods,"currency":"USD","estimated":true,"scope":if provider=="cursor"{"account-export"}else{"local-device"},
        "incomplete":incomplete,"pricingUpdatedAt":prices.data["updatedAt"],"observedAt":observed.to_rfc3339()})
}
