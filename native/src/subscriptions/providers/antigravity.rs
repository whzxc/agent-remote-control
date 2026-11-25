use super::*;

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
    // Self-signed TLS is restricted to discovered loopback daemon servers.
    let local = reqwest::Client::builder()
        .no_proxy()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| Failure::from("network-error"))?;
    let daemon = dirs::home_dir()
        .map(|home| daemon_endpoints(&home))
        .unwrap_or_default();
    read_local(&local, daemon).await
}

async fn read_local(
    client: &reqwest::Client,
    endpoints: Vec<Endpoint>,
) -> std::result::Result<(Reading, &'static str), Failure> {
    let mut responded = false;
    if let Some(reading) = probe(client, endpoints, &mut responded).await {
        return Ok((reading, "antigravity-daemon"));
    }
    Err(if responded {
        "no-limits-reported"
    } else {
        "client-not-running"
    }
    .into())
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
        let (reading, source) = read_local(&client, endpoints).await.unwrap();
        server.abort();
        assert_eq!(source, "antigravity-daemon");
        assert_eq!(reading.raw_usage["plan"], "Fixture Plan");
        assert_eq!(reading.windows.len(), 4);
        assert!(reading
            .windows
            .iter()
            .all(|window| window.used_percent == 25.));
        let closed = read_local(&client, Vec::new()).await;
        assert!(matches!(closed, Err(error) if error.code == "client-not-running"));
    }
}
