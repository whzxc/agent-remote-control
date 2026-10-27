//! CLI-only entry points; deliberately absent from management::resolve and MCP.
use crate::*;
use std::time::{Duration, Instant};

pub(crate) fn schemas() -> Value {
    serde_json::from_str(include_str!("cli_acceptance.json")).expect("CLI schemas")
}
pub(crate) fn usage(args: &[&str]) -> Option<Result<String>> {
    let relevant = args.first() == Some(&"wait") || args.starts_with(&["app", "snapshot"]);
    if !relevant {
        return None;
    }
    Some(parse(args).map(|_| if args[0] == "wait" {
        "cli wait --op <operation> [--control] [--stdin] --until <condition> [--until <condition>] [--timeout <seconds>]".into()
    } else { "cli app snapshot [--out <directory>] [--stdin]".into() }))
}
struct Options {
    op: String,
    control: bool,
    stdin: bool,
    conditions: Vec<Condition>,
    timeout: u64,
    out: Option<String>,
}
struct Condition {
    pointer: String,
    comparison: String,
    value: Value,
}
fn condition(text: &str) -> Result<Condition> {
    let text = text.trim();
    let (pointer, comparison, value) = if let Some(pointer) = text.strip_suffix("exists") {
        (pointer.trim(), "exists", Value::Null)
    } else {
        let (index, comparison) = ["==", "!="]
            .into_iter()
            .filter_map(|op| text.find(op).map(|i| (i, op)))
            .min_by_key(|v| v.0)
            .ok_or("INVALID_ARGUMENT: condition needs ==, != or exists")?;
        let raw = text[index + 2..].trim();
        let value = serde_json::from_str(raw)
            .map_err(|_| "INVALID_ARGUMENT: comparison value must be JSON (quote strings)")?;
        (text[..index].trim(), comparison, value)
    };
    if !pointer.is_empty() && !pointer.starts_with('/') {
        return Err("INVALID_ARGUMENT: expected JSON Pointer".into());
    }
    let bytes = pointer.as_bytes();
    if bytes
        .iter()
        .enumerate()
        .any(|(i, b)| *b == b'~' && !matches!(bytes.get(i + 1), Some(b'0' | b'1')))
    {
        return Err("INVALID_ARGUMENT: invalid JSON Pointer escape".into());
    }
    Ok(Condition {
        pointer: pointer.into(),
        comparison: comparison.into(),
        value,
    })
}
fn parse(args: &[&str]) -> Result<Options> {
    let wait = args[0] == "wait";
    let mut result = Options {
        op: String::new(),
        control: false,
        stdin: false,
        conditions: vec![],
        timeout: 60,
        out: None,
    };
    let mut seen = std::collections::HashSet::new();
    let mut i = if wait { 1 } else { 2 };
    while i < args.len() {
        let flag = args[i];
        if flag != "--until" && !seen.insert(flag) {
            return Err(format!("INVALID_ARGUMENT: duplicate {flag}"));
        }
        match flag {
            "--stdin" => result.stdin = true,
            "--control" if wait => result.control = true,
            "--op" | "--until" | "--timeout" if wait => {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| format!("INVALID_ARGUMENT: {flag} requires a value"))?;
                match flag {
                    "--op" => result.op = value.to_string(),
                    "--until" => result.conditions.push(condition(value)?),
                    _ => {
                        result.timeout = value
                            .parse::<u64>()
                            .ok()
                            .filter(|v| (1..=1800).contains(v))
                            .ok_or("INVALID_ARGUMENT: timeout must be 1..1800 seconds")?
                    }
                }
            }
            "--out" if !wait => {
                i += 1;
                result.out = Some(
                    args.get(i)
                        .ok_or("INVALID_ARGUMENT: --out requires a directory")?
                        .to_string(),
                );
            }
            _ => return Err(format!("INVALID_ARGUMENT: unexpected argument {flag}")),
        }
        i += 1;
    }
    if wait && (result.op.is_empty() || result.conditions.is_empty()) {
        return Err("INVALID_ARGUMENT: --op and --until are required".into());
    }
    Ok(result)
}

pub(crate) fn control_hint(op: &str) -> String {
    if !op.is_empty() && op.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
        format!("arc cli control guide {op}")
    } else {
        "arc cli control guide".into()
    }
}

pub(crate) async fn control(op: &str, args: Value) -> Result<Value> {
    let response = transport::forward_request(
        "cli/control",
        "POST",
        crate::dispatch_caller::control_request(op, &args),
    )
    .await?;
    let mut value = response["structuredContent"]["result"].clone();
    if response["isError"] == true && crate::egress::outcome_error(&value).is_none() {
        let mut error = value["error"].clone();
        if error.is_object() {
            let guide_op = if op == "guide" {
                args["op"].as_str().unwrap_or("")
            } else {
                op
            };
            error["cliHint"] = json!(control_hint(guide_op));
        }
        value["error"] = error;
        value["ok"] = json!(false);
    }
    Ok(value)
}
pub(crate) async fn snapshot(args: &[&str]) -> Result<Value> {
    let options = parse(args)?;
    let mut body = if options.stdin {
        crate::cli::stdin_json()?
    } else {
        json!({})
    };
    if let Some(out) = options.out {
        let out = PathBuf::from(out);
        let out = if out.is_absolute() {
            out
        } else {
            std::env::current_dir()
                .map_err(|e| e.to_string())?
                .join(out)
        };
        body["out"] = json!(out);
    }
    crate::management::call("app.snapshot", json!({"body":body})).await
}
pub(crate) async fn wait(args: &[&str]) -> Result<Value> {
    let options = parse(args)?;
    let mut input = if options.stdin {
        crate::cli::stdin_json()?
    } else {
        json!({})
    };
    // Repeated writes are never a waiting mechanism.
    if options.control {
        let spec = catalog()["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["name"] == options.op)
            .ok_or("UNKNOWN_OPERATION")?;
        let receipt_read =
            options.op == "receipt" && input.get("action").is_none_or(|a| a == "read");
        if spec["annotations"]["readOnlyHint"] != true && !receipt_read {
            return Err("INVALID_ARGUMENT: wait requires a read-only op".into());
        }
    } else {
        let (_, method, _) = crate::management::resolve(&options.op, &input)?;
        let snapshot_read = options.op == "app.snapshot"
            && input["body"]["modelOnly"] == true
            && input["body"]
                .as_object()
                .is_some_and(|body| body.keys().all(|key| key == "modelOnly"));
        if method != "GET"
            && !snapshot_read
            && !["state.wait", "logs.query"].contains(&options.op.as_str())
        {
            return Err("INVALID_ARGUMENT: wait requires a read-only op".into());
        }
    }
    let started = Instant::now();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(options.timeout);
    let mut last = Value::Null;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let blocking = options.control
            && matches!(
                options.op.as_str(),
                "codex_wait" | "agent_wait" | "inbox_wait"
            );
        if blocking {
            input["timeoutMs"] =
                json!(remaining.as_millis().saturating_sub(50).clamp(1, 30000) as u64);
        } else if options.op == "state.wait" {
            if !input["body"].is_object() {
                input["body"] = json!({});
            }
            input["body"]["timeoutMs"] =
                json!(remaining.as_millis().saturating_sub(50).clamp(1, 30000) as u64);
            if last["cursor"].is_string() {
                input["body"]["cursor"] = last["cursor"].clone();
            }
        }
        let read = async {
            if options.control {
                control(&options.op, input.clone()).await
            } else {
                crate::management::call(&options.op, input.clone()).await
            }
        };
        match tokio::time::timeout_at(deadline, read).await {
            Ok(result) => last = result?,
            Err(_) => break,
        }
        let matched = options.conditions.iter().all(|c| {
            let value = last.pointer(&c.pointer);
            match c.comparison.as_str() {
                "exists" => value.is_some(),
                "==" => value == Some(&c.value),
                _ => value.is_some_and(|v| v != &c.value),
            }
        });
        if crate::egress::outcome_error(&last).is_some() {
            return Ok(
                json!({"matched":matched,"reason":"operation-failed","lastResult":last,"elapsedMs":started.elapsed().as_millis() as u64}),
            );
        }
        if matched {
            let values: Vec<_> = options
                .conditions
                .iter()
                .map(|c| json!({"pointer":c.pointer,"value":last.pointer(&c.pointer)}))
                .collect();
            return Ok(
                json!({"matched":values,"elapsedMs":started.elapsed().as_millis() as u64,"lastResult":last}),
            );
        }
        // Native waits already wake on events. Immediate terminal/interaction results
        // still back off, avoiding a busy loop for an unmatched condition.
        tokio::time::sleep_until(
            deadline.min(tokio::time::Instant::now() + Duration::from_millis(500)),
        )
        .await;
    }
    Err(json!({"code":"WAIT_TIMEOUT","message":"Conditions were not met before the deadline","elapsedMs":started.elapsed().as_millis() as u64,"lastResult":last}).to_string())
}
