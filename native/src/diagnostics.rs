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
    let dependency = &i["tunnelDependency"];
    if dependency["state"] == "error" {
        let mut f = finding(
            string(dependency, "code"),
            "error",
            "ingress",
            id,
            string(dependency, "error"),
            "ingress.dependencies.install",
        );
        f["dependency"] = dependency.clone();
        f["nextAction"]["command"] = json!(crate::cli::command_line(
            &["call", "ingress.dependencies.install", "--stdin"],
            Some(&json!({"id":id,"body":{"component":"tunnel"}}))
        ));
        findings.push(f);
    } else if i["controlPlane"]["state"] == "rejected" {
        let mut f = finding(
            "RUNTIME_KEY_REJECTED",
            "error",
            "ingress",
            id,
            crate::i18n::text(&crate::i18n::locale(), "setup.runtime-key-rejected"),
            "setup.playbook",
        );
        f["httpStatus"] = i["controlPlane"]["httpStatus"].clone();
        f["detail"] = json!(if string(i, "tunnelError").is_empty() {
            format!(
                "Tunnel Client control-plane HTTP {} ({})",
                i["controlPlane"]["httpStatus"],
                string(&i["controlPlane"], "failureCategory")
            )
        } else {
            string(i, "tunnelError").to_owned()
        });
        f["dependency"] = dependency.clone();
        f["nextAction"]["command"] = json!(crate::cli::command_line(
            &["setup", "playbook", "tunnel-credentials"],
            None
        ));
        findings.push(f);
    }
    if i["transport"] == "openai-tunnel"
        && state != "ready"
        && dependency["state"] != "error"
        && i["controlPlane"]["state"] != "rejected"
        && !string(i, "tunnelError").is_empty()
    {
        let mut f = finding(
            "TUNNEL_CLIENT_ERROR",
            "error",
            "ingress",
            id,
            string(i, "tunnelError"),
            "ingress.restart",
        );
        f["nextAction"]["command"] = json!(crate::cli::command_line(
            &["ingress", "restart", string(i, "id")],
            None
        ));
        findings.push(f);
    }
    if state == "stopped" && i["running"] == false {
        findings.push(finding(
            "INGRESS_STOPPED",
            "info",
            "ingress",
            id,
            "The ingress is stopped. Reading diagnostics does not start it.",
            "inspect-ingress",
        ));
    } else if !string(i, "error").is_empty() || state == "error" {
        findings.push(finding(
            "INGRESS_FAILED",
            "error",
            "ingress",
            id,
            string(i, "error"),
            "inspect-ingress",
        ));
    } else if i["config"]["configured"] == false {
        findings.push(finding(
            "INGRESS_NOT_CONFIGURED",
            "info",
            "ingress",
            id,
            "Ingress configuration is incomplete.",
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
            "The ingress is ready. The current configuration has no inbound challenge verification evidence.",
            "verify-inbound",
        ));
    }
    if i["auth"] == "none" {
        findings.push(finding(
            "AUTH_DISABLED",
            "warning",
            "ingress",
            id,
            "Authentication is disabled for this ingress.",
            "inspect-authentication",
        ));
    }
    for f in &mut findings {
        if f["nextAction"]["command"].is_null() {
            f["nextAction"]["command"] = json!(crate::cli::command_line(
                &["ingress", "doctor", string(i, "id")],
                None
            ));
        }
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
    for (key, resources) in [
        ("core", &s["core"]["resources"]),
        ("appServer", &s["core"]["appServer"]["resources"]),
    ] {
        let code = if resources["state"] == "pressure" {
            Some("APP_SERVER_FD_PRESSURE")
        } else if resources["state"] == "degraded" {
            Some(if key == "core" {
                "CORE_NOFILE_DEGRADED"
            } else {
                "APP_SERVER_NOFILE_DEGRADED"
            })
        } else {
            None
        };
        if let Some(code) = code {
            let mut f = finding(
                code,
                "warning",
                "resources",
                &json!(key),
                if code == "APP_SERVER_FD_PRESSURE" {
                    "App-server file descriptors have reached 90% of the soft limit. RPC ready only confirms a live communication channel."
                } else {
                    "The file descriptor limit is below the startup target. Core continues running. Inspect the limit source, startup record, and failure reason."
                },
                "inspect-resource-limits",
            );
            f["evidence"] = resources.clone();
            f["nextAction"]["command"] = json!(crate::cli::command_line(&["status"], None));
            findings.push(f);
        }
    }
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
                "The execution host is unavailable. Read historical evidence availability separately.",
                "inspect-execution-endpoint",
            ));
        }
    }
    json!({"findings":findings,"checks":{"app":{"state":"reachable"},"resources":{"core":s["core"]["resources"],"appServer":s["core"]["appServer"]["resources"]},"execution":{"state":"not_checked"},"remoteClient":{"state":"unknown"},"receipts":{"state":"not_checked","nextAction":"read-original-requestId; never replay an unconfirmed write"}},"readOnly":true})
}

/// Reuse the Control receipt reader; never interpret operation completion as delivery.
pub fn receipts(diagnostics: &mut Value, records: Result<Arc<Vec<Value>>>) {
    match records {
        Ok(records) => {
            struct Summary {
                records: Arc<Vec<Value>>,
                count: usize,
                uncertain: Vec<Value>,
            }
            static SUMMARY: std::sync::LazyLock<std::sync::Mutex<Option<Summary>>> =
                std::sync::LazyLock::new(Default::default);
            let mut cache = SUMMARY.lock().unwrap();
            if cache
                .as_ref()
                .is_none_or(|s| !Arc::ptr_eq(&s.records, &records))
            {
                let mut uncertain = records.iter().filter(|r| {
                    crate::kernel::receipts::progress::Progress::decode(string(r, "state"))
                        .is_some_and(|p| {
                            p.is(crate::kernel::receipts::progress::State::Unconfirmed)
                        })
                });
                let rows: Vec<_> = uncertain.by_ref().take(100).map(|r| json!({"requestId":r["requestId"],"origin":{"ingressId":r["origin"]["ingressId"]}})).collect();
                *cache = Some(Summary {
                    count: rows.len() + uncertain.count(),
                    uncertain: rows,
                    records,
                });
            }
            let summary = cache.as_ref().unwrap();
            let uncertain = &summary.uncertain;
            diagnostics["checks"]["receipts"] = json!({"state":if summary.count == 0{"no-unconfirmed-observed"}else{"unconfirmed"},"scope":"codex-task-receipts","count":summary.count,"truncated":summary.count>100});
            for r in uncertain {
                let mut f = finding(
                    "WRITE_UNCONFIRMED",
                    "warning",
                    "request",
                    &r["requestId"],
                    "The write result is unconfirmed. Read the original requestId and native task without replaying the request.",
                    "read-original-request",
                );
                f["scope"]["ingressId"] = r["origin"]["ingressId"].clone();
                f["nextAction"]["via"] = json!("act");
                f["nextAction"]["op"] = json!("receipt");
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
