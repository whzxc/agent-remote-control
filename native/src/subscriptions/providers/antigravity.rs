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
async fn credential() -> std::result::Result<Credential, Failure> {
    #[allow(unused_mut)]
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
    if auth.as_object().is_none_or(|v| v.is_empty()) {
        return Err("credentials-missing".into());
    }
    Credential::new(auth.to_string(), "antigravity-login")
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Daemon {
    pid: u32,
    http_port: Option<u16>,
    https_port: Option<u16>,
    csrf_token: String,
}

#[derive(PartialEq, Eq)]
struct Endpoint {
    scheme: &'static str,
    port: u16,
    csrf: String,
}

fn daemon_endpoints(home: &Path) -> Vec<Endpoint> {
    let mut endpoints = Vec::new();
    for root in [
        ".gemini/antigravity/daemon",
        ".gemini/antigravity-cli/daemon",
    ] {
        let Ok(entries) = std::fs::read_dir(home.join(root)) else {
            continue;
        };
        let mut paths = entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .collect::<Vec<_>>();
        paths.sort();
        for path in paths {
            let Ok(bytes) = std::fs::read(path) else {
                continue;
            };
            let Ok(daemon) = serde_json::from_slice::<Daemon>(&bytes) else {
                continue;
            };
            if !crate::coordination::lifecycle::alive(daemon.pid).unwrap_or(false)
                || daemon.csrf_token.trim().is_empty()
            {
                continue;
            }
            for (scheme, port) in [("http", daemon.http_port), ("https", daemon.https_port)] {
                if let Some(port) = port.filter(|port| *port != 0) {
                    let endpoint = Endpoint {
                        scheme,
                        port,
                        csrf: daemon.csrf_token.clone(),
                    };
                    if !endpoints.contains(&endpoint) {
                        endpoints.push(endpoint);
                    }
                }
            }
        }
    }
    endpoints
}

async fn legacy_endpoints() -> Vec<Endpoint> {
    let mut records = Value::Null;
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
            records = json!(endpoints);
        }
    }
    #[cfg(target_os="windows")]
    if let Some(raw)=command("powershell",&["-NoProfile","-NonInteractive","-Command",
        r"$p=Get-CimInstance Win32_Process | Where-Object {($_.Name -like 'language_server*' -and $_.CommandLine -match 'antigravity') -or $_.Name -eq 'agy.exe'}; @($p | ForEach-Object { $c=''; if($_.CommandLine -match '--csrf_token(?:=|\s+)([^\s]+)'){$c=$Matches[1]}; Get-NetTCPConnection -State Listen -OwningProcess $_.ProcessId -ErrorAction SilentlyContinue | ForEach-Object { @{port=$_.LocalPort;csrf=$c} } }) | ConvertTo-Json -Compress"]).await {
        if let Ok(v)=serde_json::from_str::<Value>(&raw){records = if v.is_array() { v } else { json!([v]) };}
    }
    records
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|endpoint| {
            let port = endpoint["port"]
                .as_u64()
                .and_then(|port| u16::try_from(port).ok());
            ["http", "https"].into_iter().filter_map(move |scheme| {
                Some(Endpoint {
                    scheme,
                    port: port?,
                    csrf: endpoint["csrf"].as_str()?.into(),
                })
            })
        })
        .collect()
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
pub async fn read() -> std::result::Result<(Reading, &'static str), Failure> {
    // Self-signed TLS is restricted to discovered loopback servers.
    let local = reqwest::Client::builder()
        .no_proxy()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| Failure::from("network-error"))?;
    let mut responded = false;
    let daemon = dirs::home_dir()
        .map(|home| daemon_endpoints(&home))
        .unwrap_or_default();
    if let Some(reading) = probe(&local, daemon, &mut responded).await {
        return Ok((reading, "antigravity-daemon"));
    }
    if let Some(reading) = probe(&local, legacy_endpoints().await, &mut responded).await {
        return Ok((reading, "antigravity-daemon"));
    }
    if responded {
        return Err("no-limits-reported".into());
    }
    let credential = credential().await?;
    let client = super::client().await?;
    cloud(&client, &credential)
        .await
        .map(|reading| (reading, credential.source))
}

async fn probe(
    client: &reqwest::Client,
    endpoints: Vec<Endpoint>,
    responded: &mut bool,
) -> Option<Reading> {
    for endpoint in endpoints {
        let call = |method: &str| {
            let Endpoint { scheme, port, csrf } = &endpoint;
            client.post(format!("{scheme}://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/{method}"))
                .header("x-codeium-csrf-token",csrf)
                .header("Connect-Protocol-Version","1")
                .json(&json!({"metadata":{"ideName":"antigravity","extensionName":"antigravity","ideVersion":"unknown","locale":"en"}}))
        };
        let (summary, status) = tokio::join!(
            get(call("RetrieveUserQuotaSummary")),
            get(call("GetUserStatus"))
        );
        let mut raw = json!({});
        if let Ok(status) = status {
            *responded = true;
            let status = status.get("response").cloned().unwrap_or(status);
            let user = status.get("userStatus").unwrap_or(&status);
            raw["plan"] = user["userTier"]["name"].clone();
            raw["status"] = if status.get("userStatus").is_none() && status["userTier"].is_object()
            {
                json!({"userStatus":status})
            } else {
                status
            };
        }
        let mut quotas = if let Ok(summary) = summary {
            *responded = true;
            let quotas = windows(&summary).unwrap_or_default();
            raw["quotaSummary"] = summary;
            quotas
        } else {
            Vec::new()
        };
        if quotas.is_empty() && raw["status"].is_object() {
            quotas = legacy(&raw["status"]);
            if quotas.is_empty() {
                if let Ok(models) = get(call("GetCommandModelConfigs")).await {
                    quotas = legacy(&models);
                    raw["models"] = models;
                }
            }
        }
        if !quotas.is_empty() {
            return Reading::new(quotas, raw).ok();
        }
    }
    None
}

async fn cloud(client: &reqwest::Client, c: &Credential) -> std::result::Result<Reading, Failure> {
    let auth: Value =
        serde_json::from_str(&c.secret).map_err(|_| Failure::from("credentials-missing"))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn live_daemon_files_supply_quota_and_ignore_dead_processes() {
        // Contract: Antigravity 2.x daemon discovery and loopback quota protocol
        let home = std::env::temp_dir().join(format!("arc-daemon-{}", uuid::Uuid::new_v4()));
        for relative in [
            ".gemini/antigravity/daemon",
            ".gemini/antigravity-cli/daemon",
        ] {
            std::fs::create_dir_all(home.join(relative)).unwrap();
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        std::fs::write(
            home.join(".gemini/antigravity/daemon/dead.json"),
            json!({"pid":i32::MAX,"httpPort":port,"csrfToken":"dead-token"}).to_string(),
        )
        .unwrap();
        std::fs::write(home.join(".gemini/antigravity-cli/daemon/live.json"),
            json!({"pid":std::process::id(),"httpPort":port,"httpsPort":port,"csrfToken":"live-token"}).to_string()).unwrap();
        let endpoints = daemon_endpoints(&home);
        std::fs::remove_dir_all(home).unwrap();
        assert_eq!(
            endpoints
                .iter()
                .map(|e| (e.scheme, e.csrf.as_str()))
                .collect::<Vec<_>>(),
            [("http", "live-token"), ("https", "live-token")]
        );
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                connections.spawn(async move {
                    let service = hyper::service::service_fn(
                        |request: hyper::Request<hyper::body::Incoming>| async move {
                            assert_eq!(request.headers()["x-codeium-csrf-token"], "live-token");
                            assert_eq!(request.headers()["Connect-Protocol-Version"], "1");
                            let result = if request.uri().path().ends_with("/GetUserStatus") {
                                json!({"userStatus":{"userTier":{"name":"Fixture Plan"}}})
                            } else {
                                assert!(request
                                    .uri()
                                    .path()
                                    .ends_with("/RetrieveUserQuotaSummary"));
                                let buckets = ["gemini-weekly", "gemini-5h", "3p-weekly", "3p-5h"]
                                    .map(|id| json!({"bucketId":id,"remainingFraction":0.75}));
                                json!({"groups":[{"buckets":buckets}]})
                            };
                            Ok::<_, std::convert::Infallible>(hyper::Response::new(
                                http_body_util::Full::new(hyper::body::Bytes::from(
                                    result.to_string(),
                                )),
                            ))
                        },
                    );
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        crate::init_crypto();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let mut responded = false;
        let result = probe(&client, endpoints, &mut responded).await;
        server.abort();
        assert!(responded);
        let reading = result.unwrap();
        assert_eq!(reading.raw_usage["plan"], "Fixture Plan");
        assert_eq!(reading.windows.len(), 4);
        assert!(reading
            .windows
            .iter()
            .all(|window| window.used_percent == 25.));
    }
}
