//! Content-free control-call accounting. Reports infer candidates, never causality.
use crate::*;
use std::collections::BTreeMap;
use std::io::{BufRead, Write};

const RETENTION_DAYS: i64 = 30;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
fn directory() -> PathBuf {
    root().join("control-metrics")
}
fn lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    &LOCK
}
fn identifier(v: &Value) -> Value {
    v.as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
        })
        .map(|s| json!(s))
        .unwrap_or(Value::Null)
}
fn bytes(v: &Value) -> u64 {
    struct Count(u64);
    impl Write for Count {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0 += b.len() as u64;
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut n = Count(0);
    let _ = serde_json::to_writer(&mut n, v);
    n.0
}
pub(crate) struct Call {
    row: Option<Value>,
    started: std::time::Instant,
}
impl Call {
    pub(crate) fn new(origin: &Value, tool: &str, envelope: &Value) -> Self {
        let op = if tool == "guide" {
            json!("guide")
        } else {
            identifier(&envelope["op"])
        };
        let op = if catalog()["ops"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["name"] == op)
        {
            op
        } else {
            json!("unknown")
        };
        let args = if tool == "guide" {
            envelope
        } else {
            &envelope["args"]
        };
        let cache_scope = match op.as_str().unwrap_or("") {
            "guide" => json!([
                identifier(&args["op"]),
                args["topic"].as_str().unwrap_or("loop"),
                args["view"].as_str().unwrap_or("compact")
            ]),
            "dispatch_policy" => json!([
                identifier(&args["agent"]),
                identifier(&args["taskId"]),
                args["view"].as_str().unwrap_or("decision"),
                args["all"].as_bool().unwrap_or(false)
            ]),
            _ => Value::Null,
        };
        let profile = crate::control_profiles::effective(origin);
        Self {
            started: std::time::Instant::now(),
            row: Some(json!({
                "time":chrono::Utc::now().timestamp_millis(),"callId":id(),
                "sourceId":identifier(&origin["sourceId"]),"controlSource":identifier(&origin["controlSource"]),
                "profile":profile["name"],"transport":profile["transport"],
                "guideLayer":if op!="guide"{Value::Null}else if args["op"].is_string(){json!(2)}else if args["view"]=="full"{json!(3)}else{json!(1)},
                "dispatchOutcome":if matches!(op.as_str(),Some("codex_create"|"codex_send"|"agent_create"|"agent_send")){json!("pending")}else{Value::Null},
                "op":op,"via":tool,"requestBytes":bytes(&json!({"name":tool,"arguments":envelope})),
                "requestId":identifier(envelope.get("requestId").unwrap_or(&args["requestId"])),
                "threadId":identifier(&args["threadId"]),"taskId":identifier(&args["taskId"]),"agent":identifier(&args["agent"]),
                "cacheScope":if cache_scope.is_null(){Value::Null}else{json!(hash(cache_scope.to_string()))},
                "cacheRequested":args["knownGuideHash"].is_string() || (args["knownCriteriaHash"].is_object() || args["knownCriteriaHash"].is_string()),
                "arcVersion":crate::egress::arc_version()
            })),
        }
    }
    pub(crate) async fn finish(mut self, response: &Result<Value>) {
        let mut row = self.row.take().unwrap();
        row["durationMs"] = json!(self.started.elapsed().as_millis() as u64);
        row["completedAt"] = json!(chrono::Utc::now().timestamp_millis());
        match response {
            Ok(response) => {
                let result = &response["structuredContent"]["result"];
                row["responseBytes"] = json!(bytes(response));
                row["textBytes"] = json!(response["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|b| b["text"].as_str())
                    .map(str::len)
                    .sum::<usize>());
                row["structuredContentBytes"] =
                    json!(response.get("structuredContent").map(bytes).unwrap_or(0));
                for field in ["threadId", "taskId", "requestId", "agent"] {
                    if let Some(v) = result.get(field) {
                        row[field] = identifier(v);
                    }
                }
                row["errorCode"] = identifier(
                    result
                        .get("error")
                        .unwrap_or(&result["result"]["error"])
                        .get("code")
                        .unwrap_or(&Value::Null),
                );
                if row["errorCode"].is_null() && response["isError"] == true {
                    row["errorCode"] = json!("TOOL_ERROR");
                }
                let mut criteria: Vec<_> = result["agents"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|a| {
                        a.get("criteriaHash")
                            .unwrap_or(&a["policy"]["criteriaHash"])
                            .as_str()
                            .map(|h| json!([identifier(&a["agent"]), h]))
                    })
                    .collect();
                if let Some(global) = result["criteriaHash"].as_str() {
                    criteria.push(json!(["global", global]));
                }
                criteria.sort_by_key(Value::to_string);
                let digest = if result["guideHash"].is_string() {
                    result["guideHash"].clone()
                } else if !criteria.is_empty() {
                    json!(hash(json!(criteria).to_string()))
                } else {
                    Value::Null
                };
                row["cacheHash"] = digest;
                if !row["dispatchOutcome"].is_null() || crate::egress::dispatch_receipt(result) {
                    row["dispatchOutcome"] = json!(if !row["errorCode"].is_null() {
                        "failed"
                    } else if result["state"] == "completed"
                        && result["turnId"].is_string()
                        && (result["threadId"].is_string() || result["taskId"].is_string())
                    {
                        "submitted"
                    } else {
                        "pending"
                    });
                }
            }
            Err(_) => {
                row["errorCode"] = json!("TRANSPORT_ERROR");
                if !row["dispatchOutcome"].is_null() {
                    row["dispatchOutcome"] = json!("unconfirmed");
                }
            }
        }
        persist(row).await;
    }
}
impl Drop for Call {
    fn drop(&mut self) {
        if let Some(mut row) = self.row.take() {
            row["durationMs"] = json!(self.started.elapsed().as_millis() as u64);
            row["completedAt"] = json!(chrono::Utc::now().timestamp_millis());
            row["errorCode"] = json!("CANCELLED");
            if !row["dispatchOutcome"].is_null() {
                row["dispatchOutcome"] = json!("unconfirmed");
            }
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(persist(row));
            }
        }
    }
}
async fn persist(row: Value) {
    if tokio::task::spawn_blocking(move || append(&row))
        .await
        .map_or(true, |r| r.is_err())
    {
        eprintln!("Cannot persist control-call metrics");
    }
}
fn files() -> Result<Vec<PathBuf>> {
    let dir = directory();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().map_err(|e| e.to_string())?.is_file()
            && name.ends_with(".jsonl")
            && name
                .get(..10)
                .is_some_and(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok())
        {
            out.push(entry.path());
        }
    }
    out.sort();
    Ok(out)
}
fn prune() -> Result<Vec<PathBuf>> {
    let paths = files()?;
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(RETENTION_DAYS))
        .format("%Y-%m-%d")
        .to_string();
    let mut total: u64 = paths
        .iter()
        .filter_map(|p| p.metadata().ok())
        .map(|m| m.len())
        .sum();
    let mut retained = Vec::new();
    for path in paths {
        let name = path.file_name().unwrap().to_string_lossy();
        if name[..10] < cutoff[..] || total > MAX_BYTES {
            let size = path.metadata().map_err(|e| e.to_string())?.len();
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
            total = total.saturating_sub(size);
        } else {
            retained.push(path);
        }
    }
    Ok(retained)
}
fn append(row: &Value) -> Result<()> {
    let _guard = lock().lock().map_err(|e| e.to_string())?;
    private_dir(&directory())?;
    let path = directory().join(format!("{}.jsonl", chrono::Utc::now().format("%Y-%m-%d")));
    if path.metadata().is_ok_and(|m| m.len() >= 2 * 1024 * 1024) {
        std::fs::rename(
            &path,
            directory().join(format!(
                "{}.{}.jsonl",
                chrono::Utc::now().format("%Y-%m-%d"),
                id()
            )),
        )
        .map_err(|e| e.to_string())?;
    }
    prune()?;
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
fn duration(value: &str) -> Result<i64> {
    let end = value
        .len()
        .checked_sub(1)
        .ok_or("Expected duration such as 1h or 7d")?;
    let n = value
        .get(..end)
        .ok_or("Expected duration such as 1h or 7d")?;
    let unit = value
        .get(end..)
        .ok_or("Expected duration such as 1h or 7d")?;
    let n: i64 = n
        .parse()
        .map_err(|_| "Expected duration such as 1h or 7d")?;
    let scale = match unit {
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        _ => return Err("Expected duration using m, h, or d".into()),
    };
    n.checked_mul(scale)
        .filter(|n| *n > 0 && *n <= RETENTION_DAYS * 86_400_000)
        .ok_or_else(|| "Duration must be positive and at most 30d".into())
}
fn add(total: &mut Value, row: &Value) {
    for key in [
        "requestBytes",
        "responseBytes",
        "textBytes",
        "structuredContentBytes",
        "durationMs",
    ] {
        total[key] = json!(total[key].as_u64().unwrap_or(0) + row[key].as_u64().unwrap_or(0));
    }
    total["calls"] = json!(total["calls"].as_u64().unwrap_or(0) + 1);
    total["errors"] =
        json!(total["errors"].as_u64().unwrap_or(0) + u64::from(row["errorCode"].is_string()));
}
pub fn report(since: &str) -> Result<Value> {
    let since_ms = duration(since)?;
    let _guard = lock().lock().map_err(|e| e.to_string())?;
    let paths = prune()?;
    let cutoff = chrono::Utc::now().timestamp_millis() - since_ms;
    let mut rows = Vec::new();
    let mut malformed = 0;
    for path in paths {
        for line in
            std::io::BufReader::new(std::fs::File::open(path).map_err(|e| e.to_string())?).lines()
        {
            match line
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            {
                Some(row) if row["time"].as_i64().unwrap_or(0) >= cutoff => rows.push(row),
                Some(_) => (),
                None => malformed += 1,
            }
        }
    }
    rows.sort_by_key(|r| r["time"].as_i64().unwrap_or(0));
    Ok(summarize(&rows, since, malformed))
}
fn summarize(rows: &[Value], since: &str, malformed: u64) -> Value {
    let mut total = json!({"calls":0,"errors":0,"requestBytes":0,"responseBytes":0,"textBytes":0,"structuredContentBytes":0,"durationMs":0});
    let mut sources = BTreeMap::<String, Value>::new();
    let mut ops = BTreeMap::<String, Value>::new();
    let mut days = BTreeMap::<String, Value>::new();
    let mut previous = BTreeMap::<String, &Value>::new();
    let mut argument_errors = BTreeMap::<(String, String), i64>::new();
    let mut cached = BTreeMap::<(String, String, String), Value>::new();
    let mut requests = BTreeMap::<String, Value>::new();
    for row in rows {
        if row["requestId"].is_string()
            && (row["threadId"].is_string() || row["taskId"].is_string())
        {
            requests.insert(
                format!("{}:{}", string(row, "sourceId"), string(row, "requestId")),
                row.clone(),
            );
        }
    }
    let mut tasks = BTreeMap::<String, Value>::new();
    let mut patterns = json!({"sequences":0,"lookupThenAct":0,"unchangedReads":0,"uncachedUnchangedReads":0,"argumentErrorRetries":0});
    for row in rows {
        add(&mut total, row);
        let source = string(row, "sourceId").to_owned();
        let op = string(row, "op");
        let day = chrono::DateTime::from_timestamp_millis(row["time"].as_i64().unwrap_or(0))
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_default();
        let s = sources
            .entry(source.clone())
            .or_insert(json!({"sourceId":source,"controlSource":row["controlSource"]}));
        add(s, row);
        add(ops.entry(op.to_owned()).or_insert(json!({"op":op})), row);
        add(days.entry(day.clone()).or_insert(json!({"day":day})), row);
        let close = previous.get(&source).filter(|p| {
            row["time"].as_i64().unwrap_or(0) - p["completedAt"].as_i64().unwrap_or(0) <= 300_000
        });
        if let Some(last) = close {
            if last["op"] == "projects" && row["via"] == "act" {
                patterns["lookupThenAct"] = json!(patterns["lookupThenAct"].as_u64().unwrap() + 1);
            }
        } else {
            patterns["sequences"] = json!(patterns["sequences"].as_u64().unwrap() + 1);
            cached.retain(|(s, _, _), _| s != &source);
            argument_errors.retain(|(s, _), _| s != &source);
        }
        let retry_key = (source.clone(), op.to_owned());
        if argument_errors
            .remove(&retry_key)
            .is_some_and(|at| row["time"].as_i64().unwrap_or(0) - at <= 300_000)
        {
            patterns["argumentErrorRetries"] =
                json!(patterns["argumentErrorRetries"].as_u64().unwrap() + 1);
        }
        if row["errorCode"] == "INVALID_ARGUMENTS" {
            argument_errors.insert(retry_key, row["time"].as_i64().unwrap_or(0));
        }
        if row["cacheHash"].is_string() {
            let key = (
                source.clone(),
                op.to_owned(),
                string(row, "cacheScope").to_owned(),
            );
            if cached.get(&key) == Some(&row["cacheHash"]) {
                for counter in if row["cacheRequested"] == true {
                    vec!["unchangedReads"]
                } else {
                    vec!["unchangedReads", "uncachedUnchangedReads"]
                } {
                    patterns[counter] = json!(patterns[counter].as_u64().unwrap() + 1);
                }
            }
            cached.insert(key, row["cacheHash"].clone());
        }
        let association = requests
            .get(&format!("{}:{}", source, string(row, "requestId")))
            .unwrap_or(row);
        let task = association["threadId"]
            .as_str()
            .or_else(|| association["taskId"].as_str());
        if let Some(task) = task {
            let key = format!("{source}:{task}");
            if matches!(op, "codex_create" | "agent_create") {
                tasks.entry(key.clone()).or_insert(json!({"sourceId":source,"taskId":task,"createdAt":row["time"],"reviewed":false}));
            }
            if let Some(total) = tasks.get_mut(&key).filter(|t| t["reviewed"] != true) {
                add(total, row);
                if matches!(op, "codex_review" | "agent_review") && row["errorCode"].is_null() {
                    total["reviewed"] = json!(true);
                    total["reviewedAt"] = row["completedAt"].clone();
                }
            }
        }
        previous.insert(source, row);
    }
    json!({"profileSequences":profile_sequences(rows),"since":since,"retentionDays":RETENTION_DAYS,"maxBytes":MAX_BYTES,"sequenceGapSeconds":300,"metadataOnly":true,"malformedRows":malformed,"totals":total,"bySource":sources.into_values().collect::<Vec<_>>(),"byOp":ops.into_values().collect::<Vec<_>>(),"byDay":days.into_values().collect::<Vec<_>>(),"wasteCandidates":patterns,"tasks":tasks.into_values().collect::<Vec<_>>()})
}

/// Inactivity sequences are proxies, not conversation identities.
fn profile_sequences(rows: &[Value]) -> Value {
    let mut sequences: Vec<Value> = Vec::new();
    let mut latest = BTreeMap::<String, usize>::new();
    let mut previous_error = BTreeMap::<(usize, String), i64>::new();
    for row in rows {
        let source = string(row, "sourceId").to_owned();
        let profile = row["profile"].as_str().unwrap_or("legacy");
        let transport = row["transport"].as_str().unwrap_or("unknown");
        let at = row["time"].as_i64().unwrap_or(0);
        let index = latest
            .get(&source)
            .copied()
            .filter(|i| {
                let s = &sequences[*i];
                at - s["completedAt"].as_i64().unwrap_or(0) <= 300_000
                    && s["profile"] == profile
                    && s["transport"] == transport
            })
            .unwrap_or_else(|| {
                let i = sequences.len();
                sequences.push(
                    json!({"sourceId":source,"profile":profile,"transport":transport,"startedAt":at,
                "calls":0,"guideResponseBytes":0,"guideTextBytes":0,"guideStructuredContentBytes":0,
                "guideCalls":0,"cachedGuideCalls":0,"invalidArguments":0,"argumentErrorRetries":0,
                "dispatchAttempts":0,"dispatchErrors":0,"callsBeforeFirstDispatch":null}),
                );
                latest.insert(source, i);
                i
            });
        let s = &mut sequences[index];
        if s["callsBeforeFirstDispatch"].is_null() && row["dispatchOutcome"] == "submitted" {
            s["callsBeforeFirstDispatch"] = s["calls"].clone();
        }
        s["calls"] = json!(s["calls"].as_u64().unwrap() + 1);
        s["completedAt"] = row["completedAt"].clone();
        if row["op"] == "guide" {
            for (output, input) in [
                ("guideResponseBytes", "responseBytes"),
                ("guideTextBytes", "textBytes"),
                ("guideStructuredContentBytes", "structuredContentBytes"),
            ] {
                s[output] = json!(s[output].as_u64().unwrap() + row[input].as_u64().unwrap_or(0));
            }
            s["guideCalls"] = json!(s["guideCalls"].as_u64().unwrap() + 1);
            if row["cacheRequested"] == true {
                s["cachedGuideCalls"] = json!(s["cachedGuideCalls"].as_u64().unwrap() + 1);
            }
        }
        let key = (index, string(row, "op").to_owned());
        if previous_error
            .remove(&key)
            .is_some_and(|time| at - time <= 300_000)
        {
            s["argumentErrorRetries"] = json!(s["argumentErrorRetries"].as_u64().unwrap() + 1);
        }
        if row["errorCode"] == "INVALID_ARGUMENTS" {
            s["invalidArguments"] = json!(s["invalidArguments"].as_u64().unwrap() + 1);
            previous_error.insert(key, at);
        }
        if matches!(
            row["op"].as_str(),
            Some("codex_create" | "codex_send" | "agent_create" | "agent_send")
        ) {
            s["dispatchAttempts"] = json!(s["dispatchAttempts"].as_u64().unwrap() + 1);
            if row["errorCode"].is_string() {
                s["dispatchErrors"] = json!(s["dispatchErrors"].as_u64().unwrap() + 1);
            }
        }
    }
    let mut cohorts = BTreeMap::<String, Vec<&Value>>::new();
    for sequence in &sequences {
        cohorts
            .entry(format!(
                "{}:{}",
                string(sequence, "profile"),
                string(sequence, "transport")
            ))
            .or_default()
            .push(sequence);
    }
    let cohorts: Vec<_> = cohorts.into_values().map(|rows| {
        let mut cohort = json!({"profile":rows[0]["profile"],"transport":rows[0]["transport"],"sequences":rows.len(),
            "withoutSuccessfulDispatch":rows.iter().filter(|r|r["callsBeforeFirstDispatch"].is_null()).count()});
        for field in ["guideResponseBytes","guideTextBytes","guideStructuredContentBytes","callsBeforeFirstDispatch"] {
            let mut values: Vec<_> = rows.iter().filter_map(|r|r[field].as_u64()).collect();
            values.sort_unstable();
            let percentile = |p: usize| values.get((values.len()*p).div_ceil(100).saturating_sub(1)).copied();
            cohort[field] = json!({"median":percentile(50),"p95":percentile(95),"samples":values.len()});
        }
        let attempts: u64 = rows.iter().filter_map(|r|r["dispatchAttempts"].as_u64()).sum();
        for field in ["dispatchAttempts","dispatchErrors","invalidArguments","argumentErrorRetries"] {
            cohort[field] = json!(rows.iter().filter_map(|r|r[field].as_u64()).sum::<u64>());
        }
        cohort["argumentErrorRetriesPer100DispatchAttempts"] = if attempts==0 {Value::Null} else {json!(cohort["argumentErrorRetries"].as_u64().unwrap() as f64*100.0/attempts as f64)};
        cohort
    }).collect();
    json!({"sessionProxy":true,"gapSeconds":300,"sequences":sequences,"cohorts":cohorts})
}
