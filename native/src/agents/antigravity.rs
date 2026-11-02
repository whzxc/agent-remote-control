use super::*;

const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const MODES: &[&str] = &["accept-edits", "auto", "plan"];

pub async fn discover() -> (Option<PathBuf>, Option<String>, Option<String>) {
    let mut candidates = driver::discover_in("agy", &driver::search_paths());
    candidates.extend(driver::discover_in("antigravity", &driver::search_paths()));
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|candidate| seen.insert(candidate.clone()));
    let mut observed = (None, None, Some("AGENT_NOT_INSTALLED".into()));
    for binary in candidates {
        let version = process::probe(&binary, &["--version".into()]).await;
        let help = process::probe(&binary, &["--help".into()]).await;
        let error = match (&version, &help) {
            (Ok(version), Ok(help))
                if !version.trim().is_empty()
                    && help.contains("stream-json")
                    && help.contains("--conversation") =>
            {
                None
            }
            (Err(error), _) | (_, Err(error)) => Some(error.clone()),
            _ => Some("AGENT_IDENTITY_MISMATCH".into()),
        };
        let result = (
            Some(binary),
            version.ok().map(|value| value.trim().to_owned()),
            error,
        );
        if result.2.is_none() {
            return result;
        }
        if observed.0.is_none() {
            observed = result;
        }
    }
    observed
}

pub fn configuration(
    args: &Value,
    policy: &crate::dispatch_policy::AgentPolicy,
    inherited: Option<&Value>,
) -> Result<Value> {
    let inherited = inherited.unwrap_or(&Value::Null);
    let model = args["model"]
        .as_str()
        .or(policy.model.as_deref())
        .or(inherited["model"].as_str());
    if let Some(model) = model {
        validate_text("model", model)?;
    }
    let mut options = inherited["options"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (key, value) in &policy.options {
        options.insert(key.clone(), json!(value));
    }
    for (key, value) in args["options"].as_object().into_iter().flatten() {
        options.insert(key.clone(), value.clone());
    }
    for (key, value) in &options {
        let value = value
            .as_str()
            .ok_or_else(|| format!("INVALID_DISPATCH_OPTION: {key}"))?;
        match key.as_str() {
            "effort" if EFFORTS.contains(&value) => {}
            "mode" if MODES.contains(&value) => {}
            "effort" | "mode" => {
                return Err(format!("UNSUPPORTED_DISPATCH_OPTION: {key}={value}"));
            }
            _ => return Err(format!("UNSUPPORTED_DISPATCH_OPTION: {key}")),
        }
    }
    options
        .entry("mode")
        .or_insert_with(|| json!("accept-edits"));
    let options = Value::Object(options);
    policy.check(model, &options)?;
    Ok(json!({"model":model,"options":options}))
}

pub fn launch_args(task: &Value, resume: bool) -> Result<Vec<String>> {
    let configured = &task["configured"];
    let mut args = vec![
        "--input-format".into(),
        "stream-json".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--mode".into(),
        configured["options"]["mode"]
            .as_str()
            .unwrap_or("accept-edits")
            .into(),
        "--disable-slash-commands".into(),
        "--print=".into(),
    ];
    if let Some(model) = configured["model"].as_str() {
        args.extend(["--model".into(), model.into()]);
    }
    if let Some(effort) = configured["options"]["effort"].as_str() {
        args.extend(["--effort".into(), effort.into()]);
    }
    if task["approval"] == "bypass" {
        args.push("--dangerously-skip-permissions".into());
    }
    if resume {
        let conversation = string(task, "sessionId");
        if conversation.is_empty() {
            return Err("SESSION_NOT_PERSISTED".into());
        }
        args.extend(["--conversation".into(), conversation.into()]);
    }
    Ok(args)
}

pub fn facts(task: &Value, source: &str) -> Value {
    let configured = &task["configured"];
    json!({
        "source":source,"taskId":task["taskId"],"observedAt":task["configurationObservedAt"],
        "scope":"session","authoritative":false,"executionEvidence":false,
        "currentModel":configured["model"],
        "models":{"unavailable":"Antigravity exposes no no-inference model catalog"},
        "options":[
            {"id":"effort","currentValue":configured["options"]["effort"],"values":EFFORTS},
            {"id":"mode","currentValue":configured["options"]["mode"],"values":MODES}
        ],
        "configurationEvidence":"requested-not-executed"
    })
}

fn validate_text(field: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(format!("INVALID_DISPATCH_CONFIGURATION: {field}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_arguments_keep_bypass_explicit() {
        // Contract: Antigravity bypass approval is the only source of the dangerous permission flag.
        let ordinary = json!({"configured":{"model":"native","options":{"mode":"accept-edits","effort":"low"}},"approval":"approved"});
        let bypass = json!({"configured":ordinary["configured"],"approval":"bypass"});
        assert!(!launch_args(&ordinary, false)
            .unwrap()
            .contains(&"--dangerously-skip-permissions".into()));
        assert!(launch_args(&bypass, false)
            .unwrap()
            .contains(&"--dangerously-skip-permissions".into()));
    }
}
