use super::*;
#[cfg(target_os = "macos")]
use base64::Engine;

async fn command(program: &str, args: &[&str]) -> Option<String> {
    let out = tokio::time::timeout(
        Duration::from_secs(4),
        tokio::process::Command::new(program)
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !out.status.success() || out.stdout.len() > 2 * 1024 * 1024 {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}
pub async fn credential() -> std::result::Result<Credential, Failure> {
    let mut auth = json!({});
    #[cfg(target_os = "macos")]
    if let Some(raw) = command(
        "security",
        &[
            "find-generic-password",
            "-s",
            "gemini",
            "-a",
            "antigravity",
            "-w",
        ],
    )
    .await
    {
        let text = raw.trim();
        let decoded = text
            .strip_prefix("go-keyring-base64:")
            .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok())
            .and_then(|b| String::from_utf8(b).ok());
        let text = decoded.as_deref().unwrap_or(text);
        if let Ok(v) = serde_json::from_str::<Value>(text) {
            auth["oauth"] = if v["token"].is_object() {
                v["token"].clone()
            } else {
                v
            };
        } else if !text.starts_with(['{', '[']) {
            auth["oauth"] = json!({"access_token":text.trim_start_matches("Bearer ")});
        }
    }
    #[cfg(not(target_os = "windows"))]
    if let Some(processes) = command("ps", &["-axo", "pid=,command="]).await {
        let re = regex::Regex::new(r"--csrf_token(?:=|\s+)([^\s]+)").unwrap();
        let mut endpoints = vec![];
        for line in processes.lines().filter(|l| {
            (l.contains("language_server") && l.to_lowercase().contains("antigravity"))
                || l.contains("/agy ")
        }) {
            let pid = line.split_whitespace().next().unwrap_or("");
            if !pid.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let csrf = re
                .captures(line)
                .map(|c| c[1].trim_matches('"').to_string())
                .unwrap_or_default();
            if let Some(ports) = command(
                "lsof",
                &["-nP", "-a", "-p", pid, "-iTCP", "-sTCP:LISTEN", "-Fn"],
            )
            .await
            {
                for port in ports
                    .lines()
                    .filter(|l| l.starts_with('n'))
                    .filter_map(|l| l.rsplit(':').next()?.parse::<u16>().ok())
                {
                    endpoints.push(json!({"port":port,"csrf":csrf}));
                }
            }
        }
        endpoints.sort_by_key(|v| v["port"].as_u64());
        endpoints.dedup();
        if !endpoints.is_empty() {
            auth["endpoints"] = json!(endpoints);
        }
    }
    #[cfg(target_os="windows")]
    if let Some(raw)=command("powershell",&["-NoProfile","-NonInteractive","-Command",
        r"$p=Get-CimInstance Win32_Process | Where-Object {($_.Name -like 'language_server*' -and $_.CommandLine -match 'antigravity') -or $_.Name -eq 'agy.exe'}; @($p | ForEach-Object { $c=''; if($_.CommandLine -match '--csrf_token(?:=|\s+)([^\s]+)'){$c=$Matches[1]}; Get-NetTCPConnection -State Listen -OwningProcess $_.ProcessId -ErrorAction SilentlyContinue | ForEach-Object { @{port=$_.LocalPort;csrf=$c} } }) | ConvertTo-Json -Compress"]).await {
        if let Ok(v)=serde_json::from_str::<Value>(&raw){if v.is_array(){auth["endpoints"]=v;}}
    }
    if auth.as_object().is_none_or(|v| v.is_empty()) {
        return Err("credentials-missing".into());
    }
    Credential::new(auth.to_string(), "antigravity-login")
}
fn windows(raw: &Value) -> Option<Vec<QuotaWindow>> {
    let groups = raw["groups"]
        .as_array()
        .or_else(|| raw["response"]["groups"].as_array())?;
    let mut out = vec![];
    for b in groups
        .iter()
        .flat_map(|g| g["buckets"].as_array().into_iter().flatten())
    {
        let Some(id) = b["bucketId"].as_str() else {
            continue;
        };
        let (pool, label) = match id {
            "gemini-5h" => ("gemini", "five_hour"),
            "gemini-weekly" => ("gemini", "weekly"),
            "3p-5h" => ("third-party", "five_hour"),
            "3p-weekly" => ("third-party", "weekly"),
            _ => continue,
        };
        if out.iter().any(|w: &QuotaWindow| w.id == id) {
            continue;
        }
        if let Some(mut w) = window(
            id,
            pool,
            label,
            number(&b["remainingFraction"])
                .filter(|f| *f <= 1.)
                .map(|f| (1. - f) * 100.),
            date(&b["resetTime"]),
        ) {
            w.scope = Some(
                if pool == "gemini" {
                    "Gemini"
                } else {
                    "Claude / Other"
                }
                .into(),
            );
            out.push(w);
        }
    }
    Some(out)
}
fn legacy(v: &Value) -> Vec<QuotaWindow> {
    fn walk(v: &Value, out: &mut Vec<(String, f64, Option<String>)>) {
        if let Some(f) = number(&v["quotaInfo"]["remainingFraction"]).filter(|f| *f <= 1.) {
            let name = v["label"]
                .as_str()
                .or(v["displayName"].as_str())
                .or(v["model"].as_str())
                .unwrap_or("");
            if !name.is_empty() {
                out.push((name.into(), f, date(&v["quotaInfo"]["resetTime"])));
            }
        }
        match v {
            Value::Object(m) => {
                for (key, value) in m {
                    if let Some(f) =
                        number(&value["quotaInfo"]["remainingFraction"]).filter(|f| *f <= 1.)
                    {
                        if value["label"].is_null()
                            && value["displayName"].is_null()
                            && value["model"].is_null()
                        {
                            out.push((key.clone(), f, date(&value["quotaInfo"]["resetTime"])));
                        }
                    }
                    walk(value, out);
                }
            }
            Value::Array(a) => {
                for value in a {
                    walk(value, out)
                }
            }
            _ => (),
        }
    }
    let mut models = vec![];
    walk(v, &mut models);
    let mut out = vec![];
    for (pool, gemini) in [("gemini", true), ("third-party", false)] {
        if let Some((_, f, reset)) = models
            .iter()
            .filter(|(name, _, _)| name.to_lowercase().contains("gemini") == gemini)
            .min_by(|a, b| a.1.total_cmp(&b.1))
        {
            if let Some(mut w) = window(
                pool,
                pool,
                "five_hour",
                Some((1. - f) * 100.),
                reset.clone(),
            ) {
                w.scope = Some(if gemini { "Gemini" } else { "Claude / Other" }.into());
                out.push(w);
            }
        }
    }
    out
}
pub async fn read(
    client: &reqwest::Client,
    c: &Credential,
) -> std::result::Result<Reading, Failure> {
    let auth: Value =
        serde_json::from_str(&c.secret).map_err(|_| Failure::from("credentials-missing"))?;
    // Self-signed TLS is restricted to the discovered loopback server; cloud requests use the normal client.
    let local = reqwest::Client::builder()
        .no_proxy()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| Failure::from("network-error"))?;
    if let Some(endpoints) = auth["endpoints"].as_array() {
        for endpoint in endpoints.iter().take(8) {
            for scheme in ["http", "https"] {
                let Some(port) = endpoint["port"].as_u64() else {
                    continue;
                };
                let call = |method: &str| {
                    local.post(format!("{scheme}://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/{method}"))
                .header("x-codeium-csrf-token",endpoint["csrf"].as_str().unwrap_or(""))
                .header("Connect-Protocol-Version","1").json(&json!({"metadata":{"ideName":"antigravity","extensionName":"antigravity","ideVersion":"unknown","locale":"en"}}))
                };
                let summary = get(call("RetrieveUserQuotaSummary")).await;
                let status = get(call("GetUserStatus")).await;
                let mut raw = json!({});
                if let Ok(v) = status {
                    raw["status"] = v;
                }
                let quotas = if let Ok(v) = summary {
                    let q = windows(&v);
                    raw["quotaSummary"] = v;
                    q
                } else {
                    None
                };
                let quotas = match quotas {
                    Some(q) => Some(q),
                    None if raw["status"].is_object() => {
                        let mut q = legacy(&raw["status"]);
                        if q.is_empty() {
                            if let Ok(v) = get(call("GetCommandModelConfigs")).await {
                                q = legacy(&v);
                                raw["models"] = v;
                            }
                        }
                        Some(q)
                    }
                    _ => None,
                };
                if let Some(q) = quotas {
                    return Reading::new(q, raw);
                }
            }
        }
    }
    let oauth = &auth["oauth"];
    // Token renewal belongs to Antigravity; do not embed its OAuth client credentials.
    let token = oauth["access_token"]
        .as_str()
        .or(oauth["accessToken"].as_str())
        .filter(|token| !token.is_empty())
        .ok_or_else(|| Failure::from("credentials-missing"))?;
    let mut failure = Failure::from("no-limits-reported");
    let mut received_response = false;
    for host in [
        "https://daily-cloudcode-pa.googleapis.com",
        "https://cloudcode-pa.googleapis.com",
    ] {
        let call = |method: &str| {
            client
                .post(format!("{host}/v1internal:{method}"))
                .bearer_auth(token)
                .header("User-Agent", "antigravity")
                .json(&json!({}))
        };
        for method in ["retrieveUserQuotaSummary", "fetchAvailableModels"] {
            let value = match get(call(method)).await {
                Ok(value) => {
                    received_response = true;
                    value
                }
                Err(error) => {
                    failure = error;
                    continue;
                }
            };
            let quotas = if method == "retrieveUserQuotaSummary" {
                windows(&value)
            } else {
                let quotas = legacy(&value);
                (!quotas.is_empty()).then_some(quotas)
            };
            if let Some(quotas) = quotas {
                let plan = get(call("loadCodeAssist")).await.unwrap_or(Value::Null);
                let key = if method == "retrieveUserQuotaSummary" {
                    "quotaSummary"
                } else {
                    "models"
                };
                let mut raw = json!({"plan":plan});
                raw[key] = value;
                return Reading::new(quotas, raw);
            }
        }
    }
    Err(if received_response {
        "no-limits-reported".into()
    } else {
        failure
    })
}
