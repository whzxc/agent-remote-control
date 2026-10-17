//! Read-only findings derived from already observed state.
use crate::*;
fn finding(
    code: &str,
    severity: &str,
    kind: &str,
    id: &Value,
    summary: &str,
    operation: &str,
) -> Value {
    json!({"code":code,"severity":severity,"scope":{"kind":kind,"id":id},"observedAt":now(),"summary":summary,"nextAction":{"kind":"user-action","operation":operation,"target":id}})
}
pub fn ingress(i: &Value) -> Value {
    let mut findings = Vec::new();
    let id = &i["id"];
    let state = string(i, "state");
    if state == "stopped" && i["running"] == false {
        findings.push(finding(
            "INGRESS_STOPPED",
            "info",
            "ingress",
            id,
            "入口已停止；读取诊断不会启动入口。",
            "inspect-ingress",
        ));
    } else if !string(i, "error").is_empty() || state == "error" {
        findings.push(finding(
            "INGRESS_FAILED",
            "error",
            "ingress",
            id,
            "此入口报告故障；只检查此入口的配置和 Provider。",
            "inspect-ingress",
        ));
    } else if i["config"]["configured"] == false {
        findings.push(finding(
            "INGRESS_NOT_CONFIGURED",
            "info",
            "ingress",
            id,
            "入口配置尚未完成。",
            "configure-ingress",
        ));
    }
    let inbound = if i["verification"]["challengeVerifiedAt"].is_string() {
        "verified"
    } else {
        "not_checked"
    };
    if state == "ready" && inbound != "verified" {
        findings.push(finding(
            "INBOUND_NOT_VERIFIED",
            "warning",
            "ingress",
            id,
            "入口已就绪，但当前配置尚无 challenge 入站验证证据。",
            "verify-inbound",
        ));
    }
    if i["auth"] == "none" {
        findings.push(finding(
            "AUTH_DISABLED",
            "warning",
            "ingress",
            id,
            "此入口未启用身份认证。",
            "inspect-authentication",
        ));
    }
    json!({"findings":findings,"checks":{"transport":{"state":state},"authentication":{"state":if i["auth"]=="none"{"disabled"}else{"configured-not-verified"}},"inbound":{"state":inbound,"observedAt":i["verification"]["challengeVerifiedAt"]},"execution":{"state":"not_checked"},"remoteClient":{"state":"unknown"}},"readOnly":true})
}
pub fn status(s: &Value) -> Value {
    let mut findings: Vec<Value> = s["ingresses"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|i| {
            ingress(i)["findings"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .collect();
    for (key, code) in [
        ("desktop", "DESKTOP_UNAVAILABLE"),
        ("appServer", "APP_SERVER_UNAVAILABLE"),
    ] {
        let state = string(&s["core"][key], "state");
        if matches!(state, "unavailable" | "disconnected" | "error") {
            findings.push(finding(
                code,
                "warning",
                "execution-endpoint",
                &json!(key),
                "执行端当前不可用；历史证据可用性需单独读取。",
                "inspect-execution-endpoint",
            ));
        }
    }
    json!({"findings":findings,"checks":{"app":{"state":"reachable"},"execution":{"state":"not_checked"},"remoteClient":{"state":"unknown"},"receipts":{"state":"not_checked","nextAction":"read-original-requestId; never replay an unconfirmed write"}},"readOnly":true})
}

/// Reuse the Control receipt reader; never interpret operation completion as delivery.
pub fn receipts(diagnostics: &mut Value, records: Result<Vec<Value>>) {
    match records {
        Ok(records) => {
            let uncertain: Vec<_> = records
                .iter()
                .filter(|r| r["state"] == "unconfirmed")
                .collect();
            diagnostics["checks"]["receipts"] = json!({"state":if uncertain.is_empty(){"no-unconfirmed-observed"}else{"unconfirmed"},"scope":"codex-task-receipts","count":uncertain.len(),"truncated":uncertain.len()>100});
            for r in uncertain.into_iter().take(100) {
                let mut f = finding(
                    "WRITE_UNCONFIRMED",
                    "warning",
                    "request",
                    &r["requestId"],
                    "写操作结果未确认；回读原 requestId 和原生任务，不重放。",
                    "read-original-request",
                );
                f["scope"]["ingressId"] = r["origin"]["ingressId"].clone();
                f["nextAction"]["tool"] = json!("receipt");
                diagnostics["findings"].as_array_mut().unwrap().push(f);
            }
        }
        Err(_) => {
            diagnostics["checks"]["receipts"] =
                json!({"state":"unknown","scope":"codex-task-receipts"})
        }
    }
}

/// Active, bounded checks. Authentication and execution are never inferred from HTTP reachability.
pub async fn probe(
    ingress: &std::sync::Arc<crate::ingress::Ingress>,
) -> crate::Result<serde_json::Value> {
    use crate::*;
    let summary = ingress.summary().await?;
    let address = string(&summary, "url");
    let mut checks = json!({"transport":summary["state"],"authentication":{"state":"not_checked"},"execution":{"state":"not_checked"}});
    if summary["provider"] == "cloudflare" {
        let mut edges = Vec::new();
        for host in ["region1.v2.argotunnel.com", "region2.v2.argotunnel.com"] {
            let addresses = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                tokio::net::lookup_host((host, 7844)),
            )
            .await;
            edges.push(match addresses {
                Ok(Ok(ips)) => {let ips: Vec<_> = ips.map(|s|s.ip()).collect(); json!({"host":host,"addresses":ips.iter().map(ToString::to_string).collect::<Vec<_>>(),"fakeIp":ips.iter().any(|ip|matches!(ip,std::net::IpAddr::V4(ip) if ip.octets()[0]==198 && [18,19].contains(&ip.octets()[1])))})},
                _ => json!({"host":host,"state":"dns_failed"}),
            });
        }
        checks["edgeDiscovery"] = json!(edges);
        checks["provider"] = summary["health"].clone();
    }
    if let Ok(url) = reqwest::Url::parse(address) {
        if let Some(host) = url.host_str() {
            let dns = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(443))),
            )
            .await;
            checks["dns"] = match dns {
                Ok(Ok(ips)) => {
                    json!({"state":"resolved","addresses":ips.map(|s|s.ip().to_string()).collect::<Vec<_>>()})
                }
                _ => json!({"state":"failed"}),
            };
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        let response = client.post(url.clone()).header("Accept","application/json, text/event-stream").json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"connector-doctor","version":env!("ARC_BUILD_VERSION")}}})).send().await;
        checks["publicMcp"] = match response {
            Ok(response) => {
                let status = response.status().as_u16();
                json!({"state":if status == 401 {"authentication_required"} else if status == 200 {"reachable"} else {"failed"},"httpStatus":status,"tls":"verified","authenticated":false})
            }
            Err(error) => json!({"state":"failed","error":error.to_string()}),
        };
        if summary["auth"] == "oauth" {
            let metadata = url
                .join("/.well-known/oauth-protected-resource")
                .map_err(|e| e.to_string())?;
            checks["oauthMetadata"] = match client.get(metadata).send().await {
                Ok(r) => {
                    json!({"state":if r.status().is_success() {"reachable"} else {"failed"},"httpStatus":r.status().as_u16()})
                }
                Err(e) => json!({"state":"failed","error":e.to_string()}),
            };
        }
    } else {
        checks["publicMcp"] = json!({"state":"not_available","reason":"no public HTTPS endpoint"});
    }
    ingress.observe("lastProbe", json!({"observedAt":now(),"url":address,
        "passed":summary["state"] == "ready"
            && matches!(string(&checks["publicMcp"], "state"), "reachable" | "authentication_required")
            && (summary["auth"] != "oauth" || checks["oauthMetadata"]["state"] == "reachable")})).await?;
    Ok(
        json!({"ingressId":ingress.id,"observedAt":now(),"checks":checks,"diagnostics":self::ingress(&summary)}),
    )
}
