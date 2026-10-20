//! Read existing session facts without starting or resuming Agent processes.
use super::*;

impl AgentHost {
    pub(crate) async fn dispatch_facts(&self, args: &Value) -> Result<Vec<Value>> {
        let filter = args["agent"].as_str();
        if filter.is_some_and(|id| !self.drivers.contains_key(id)) {
            return Err("UNKNOWN_AGENT: read query agents for registered IDs".into());
        }
        if args["taskId"].is_string() && (filter.is_none() || filter == Some("codex")) {
            return Err("TASK_REQUIRES_NON_CODEX_AGENT".into());
        }
        let mut tasks = HashMap::<String, Value>::new();
        if let Some(task) = args["taskId"].as_str() {
            let agent = filter.unwrap();
            tasks.insert(agent.into(), self.task(agent, task).await?);
        } else {
            let dir = root().join("agents/tasks");
            if dir.exists() {
                for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
                    let path = entry.map_err(|e| e.to_string())?.path();
                    if !path.extension().is_some_and(|e| e == "json") {
                        continue;
                    }
                    let task = match load(&path) {
                        Ok(task) => task,
                        Err(error) => {
                            crate::logs::record(
                                "WARN",
                                &format!("Skipping Agent capability snapshot: {error}"),
                                None,
                            );
                            continue;
                        }
                    };
                    let agent = string(&task, "agent");
                    if filter.is_some_and(|id| id != agent)
                        || !task["metadata"].as_object().is_some_and(|m| !m.is_empty())
                    {
                        continue;
                    }
                    if tasks
                        .get(agent)
                        .is_none_or(|old| string(&task, "updatedAt") > string(old, "updatedAt"))
                    {
                        tasks.insert(agent.into(), task);
                    }
                }
            }
        }
        let inventory = self.ui_inventory(false).await;
        let mut rows = Vec::new();
        for item in inventory["agents"].as_array().into_iter().flatten() {
            let agent = string(item, "agent");
            if filter.is_some_and(|id| id != agent) {
                continue;
            }
            let mut row = json!({
                "agent":agent,"protocol":item["protocol"],
                "availability":{
                    "installed":item["installed"],"available":item["available"],
                    "enabled":item["enabled"],"discoveryError":item["discoveryError"],
                    "observedAt":inventory["observedAt"]
                }
            });
            if agent != "codex" {
                let facts = if let Some(task) = tasks.get(agent) {
                    self.session_dispatch_facts(task, item["enabled"] == true)
                        .await
                } else if item["available"] != true {
                    Ok(json!({"unavailable":"agent-unavailable"}))
                } else if item["enabled"] != true {
                    Ok(json!({"unavailable":"agent-disabled"}))
                } else {
                    Ok(
                        json!({"unavailable":"needs-session","nextAction":"agent_create without prompt, then dispatch_policy with agent and taskId"}),
                    )
                };
                row["capabilities"] = facts.unwrap_or_else(|e| json!({"unavailable":e}));
                if filter.is_none() {
                    // Full native IDs remain available with an agent filter.
                    let facts = &mut row["capabilities"];
                    if let Some(models) = facts["models"].as_array_mut() {
                        let omitted = models.len().saturating_sub(8);
                        models.truncate(8);
                        if omitted > 0 {
                            facts["omittedModels"] = json!(omitted);
                        }
                    }
                }
            }
            rows.push(row);
        }
        Ok(rows)
    }

    async fn session_dispatch_facts(&self, task: &Value, enabled: bool) -> Result<Value> {
        let id = string(task, "taskId");
        let process = self.processes.lock().await.get(id).cloned();
        let mut metadata = task["metadata"].clone();
        let mut observed = task["configurationObservedAt"].clone();
        let mut source = "persisted-session-snapshot";
        let mut levels = Value::Null;
        if let Some(p) =
            process.filter(|p| enabled && p.alive.load(std::sync::atomic::Ordering::SeqCst))
        {
            if p.pi {
                let state = p.call("get_state", json!({}), 5000).await?;
                let models = p.call("get_available_models", json!({}), 5000).await?;
                levels = p
                    .call("get_available_thinking_levels", json!({}), 5000)
                    .await
                    .unwrap_or_else(|error| json!({"unavailable":error}));
                metadata = state;
                metadata["availableModels"] = models["models"].clone();
                observed = json!(now());
                source = "pi-rpc";
            } else {
                let state = p.state.lock().await;
                metadata = state["metadata"].clone();
                observed = state["configurationObservedAt"].clone();
                source = "live-session-snapshot";
            }
        }
        let mut facts = json!({
            "source":source,"taskId":id,"observedAt":observed,
            "scope":"session","executionEvidence":false
        });
        if task["agent"] == "pi" {
            let model = &metadata["model"];
            facts["currentModel"] = if model["provider"].is_string() && model["id"].is_string() {
                json!(format!(
                    "{}/{}",
                    string(model, "provider"),
                    string(model, "id")
                ))
            } else {
                Value::Null
            };
            facts["models"] = if let Some(models) = metadata["availableModels"].as_array() {
                json!(models.iter().map(|m| json!({
                    "model":format!("{}/{}",string(m,"provider"),string(m,"id")),"name":m["name"]
                })).collect::<Vec<_>>())
            } else {
                json!({"unavailable":"requires-live-pi-session"})
            };
            facts["options"] = json!([{
                "id":"thinkingLevel","currentValue":metadata["thinkingLevel"],
                "values":levels.get("levels").cloned().unwrap_or_else(|| {
                    if levels.is_object() { levels } else { json!({"unavailable":"requires-live-pi-session"}) }
                })
            }]);
            return Ok(facts);
        }
        let configs = metadata["configOptions"].as_array();
        let mut models = Vec::new();
        let mut options = Vec::new();
        for config in configs.into_iter().flatten() {
            let values = option_values(&config["options"]);
            if facts["modelConfigId"].is_null()
                && (config["category"] == "model" || config["id"] == "model")
            {
                facts["modelConfigId"] = config["id"].clone();
                facts["currentModel"] = config["currentValue"].clone();
                models = values
                    .into_iter()
                    .map(|mut v| {
                        v["model"] = v
                            .as_object_mut()
                            .unwrap()
                            .remove("value")
                            .unwrap_or(Value::Null);
                        v
                    })
                    .collect();
            } else {
                options.push(json!({
                    "id":config["id"],"category":config["category"],"type":config["type"],
                    "currentValue":config["currentValue"],"values":values
                }));
            }
        }
        if configs.is_none() {
            facts["currentModel"] = metadata["models"]["currentModelId"].clone();
            models = metadata["models"]["availableModels"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|m| json!({"model":m["modelId"],"name":m["name"]}))
                .collect();
            if metadata["modes"].is_object() {
                options.push(json!({
                    "id":"mode","type":"select","currentValue":metadata["modes"]["currentModeId"],
                    "values":metadata["modes"]["availableModes"].as_array().into_iter().flatten()
                        .map(|m|json!({"value":m["id"],"name":m["name"]})).collect::<Vec<_>>()
                }));
            }
        }
        facts["models"] = if models.is_empty() {
            json!({"unavailable":"not-reported-by-session"})
        } else {
            json!(models)
        };
        facts["options"] = json!(options);
        Ok(facts)
    }
}

fn option_values(options: &Value) -> Vec<Value> {
    options
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|option| {
            if let Some(values) = option["options"].as_array() {
                values
                    .iter()
                    .map(|v| {
                        json!({
                            "value":v["value"],"name":v["name"],"group":option["group"]
                        })
                    })
                    .collect::<Vec<_>>()
            } else {
                vec![json!({"value":option["value"],"name":option["name"]})]
            }
        })
        .collect()
}
