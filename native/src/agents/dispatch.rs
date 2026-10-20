//! Read existing session facts without starting or resuming Agent processes.
use super::*;
mod catalogs;
pub(super) use catalogs::remember_catalog;
use catalogs::sessionless_catalog;

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
                } else {
                    sessionless_catalog(agent)
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

    pub(super) async fn configure_dispatch(&self, p: &Arc<Process>, args: &Value) -> Result<Value> {
        let task = p.state.lock().await.clone();
        let policy = crate::dispatch_policy::agent_policy(string(&task, "agent"))?;
        let mut facts = self.session_dispatch_facts(&task, true).await?;
        let mut options = serde_json::to_value(&policy.options).map_err(|e| e.to_string())?;
        let mut sources = json!({"model":"native-default","options":{}});
        for key in policy.options.keys() {
            sources["options"][key] = json!("policy-default");
        }
        for (key, value) in args["options"].as_object().into_iter().flatten() {
            options[key] = value.clone();
            sources["options"][key] = json!("explicit");
        }
        let model = args["model"].as_str().or(policy.model.as_deref());
        if let Some(model) = model {
            if task["agent"] == "cursor" && facts["currentModel"] != model {
                return Err("UNSUPPORTED_DISPATCH_MODEL: Cursor's native setter persists user defaults; session-only model selection is not integrated".into());
            }
            if !facts["models"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|r| r["model"] == model))
            {
                return Err(format!("UNSUPPORTED_DISPATCH_MODEL: {model}"));
            }
            // Check model constraints before mutating the native session. Option constraints
            // are checked against the catalog returned for the selected model below.
            // A model change may reveal constrained options that are absent right now.
            policy.check_model(Some(model))?;
            sources["model"] = json!(if args["model"].is_string() {
                "explicit"
            } else {
                "policy-default"
            });
            // Cursor persists its model setter globally. An explicit assertion of
            // the already confirmed current model requires no native mutation.
            if task["agent"] != "cursor" {
                p.set_dispatch_option(&facts, "model", model).await?;
            }
            let snapshot = p.state.lock().await.clone();
            facts = self.session_dispatch_facts(&snapshot, true).await?;
            if facts["currentModel"] != model {
                return Err("DISPATCH_CONFIGURATION_UNCONFIRMED: model".into());
            }
        }
        let mut proposed = current_configuration(&facts);
        for (key, value) in options.as_object().unwrap() {
            let option = facts["options"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|o| o["id"] == *key)
                .ok_or_else(|| format!("UNSUPPORTED_DISPATCH_OPTION: {key}"))?;
            if !option["values"]
                .as_array()
                .is_some_and(|values| values.iter().any(|v| v == value || v["value"] == *value))
            {
                return Err(format!("UNSUPPORTED_DISPATCH_OPTION: {key}={value}"));
            }
            proposed["options"][key] = value.clone();
        }
        policy.check(proposed["model"].as_str(), &proposed["options"])?;
        for (key, value) in options.as_object().unwrap() {
            // Prior setters may change the next option's allowed values.
            let supported = facts["options"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|o| o["id"] == *key)
                .and_then(|o| o["values"].as_array())
                .is_some_and(|values| values.iter().any(|v| v == value || v["value"] == *value));
            if !supported {
                return Err(format!("UNSUPPORTED_DISPATCH_OPTION: {key}={value}"));
            }
            p.set_dispatch_option(
                &facts,
                key,
                value.as_str().ok_or("INVALID_DISPATCH_OPTION")?,
            )
            .await?;
            let snapshot = p.state.lock().await.clone();
            facts = self.session_dispatch_facts(&snapshot, true).await?;
        }
        let confirmed = current_configuration(&facts);
        if model.is_some_and(|m| confirmed["model"] != m)
            || options
                .as_object()
                .unwrap()
                .iter()
                .any(|(k, v)| confirmed["options"][k] != *v)
        {
            return Err(
                "DISPATCH_CONFIGURATION_UNCONFIRMED: native values differ from requested choices"
                    .into(),
            );
        }
        policy.check(confirmed["model"].as_str(), &confirmed["options"])?;
        for key in confirmed["options"].as_object().unwrap().keys() {
            if sources["options"][key].is_null() {
                sources["options"][key] = json!("native-default");
            }
        }
        let mut selection = confirmed.clone();
        selection["source"] = sources;
        selection["reason"] = args["reason"].clone();
        selection["submittedConfiguration"] = json!({"model":model,"options":options});
        selection["sessionConfirmation"] = confirmed;
        selection["turnEvidence"] = Value::Null;
        selection["submission"] = json!("pending");
        selection["submittedAt"] = json!(now());
        Ok(selection)
    }

    pub(super) async fn session_dispatch_facts(
        &self,
        task: &Value,
        enabled: bool,
    ) -> Result<Value> {
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
        let facts = catalog_facts(task, &metadata, observed, source, levels);
        remember_catalog(string(task, "agent"), &facts)?;
        Ok(facts)
    }
}

pub(super) fn catalog_facts(
    task: &Value,
    metadata: &Value,
    observed: Value,
    source: &str,
    levels: Value,
) -> Value {
    let mut facts = json!({
        "source":source,"taskId":task["taskId"],"observedAt":observed,
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
        facts["models"] =
            if let Some(models) = metadata["availableModels"].as_array() {
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
        return facts;
    }
    if task["agent"] == "cursor" {
        facts["modelSelectionUnavailable"] = json!("native-setter-persists-user-defaults");
        facts["modelSelectionNote"] =
            json!("The current model may be explicitly asserted; switching is unavailable");
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
    facts
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

pub(super) fn current_configuration(facts: &Value) -> Value {
    let options = facts["options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|o| {
            o["id"]
                .as_str()
                .map(|id| (id.to_owned(), o["currentValue"].clone()))
        })
        .collect::<serde_json::Map<_, _>>();
    json!({"model":facts["currentModel"],"options":options,"scope":"session","source":facts["source"],"observedAt":facts["observedAt"]})
}
impl Process {
    async fn set_dispatch_option(&self, facts: &Value, key: &str, value: &str) -> Result<()> {
        if self.pi {
            if key == "model" {
                let (provider, model) = value.split_once('/').ok_or("INVALID_PI_MODEL")?;
                self.call(
                    "set_model",
                    json!({"provider":provider,"modelId":model}),
                    15000,
                )
                .await?;
            } else {
                self.call("set_thinking_level", json!({"level":value}), 15000)
                    .await?;
            }
            return Ok(());
        }
        let sid = self.state.lock().await["sessionId"].clone();
        let config = if key == "model" {
            facts["modelConfigId"].as_str()
        } else {
            if self.state.lock().await["metadata"]["configOptions"].is_array() {
                Some(key)
            } else {
                None
            }
        };
        if let Some(config) = config {
            let result = self
                .call(
                    "session/set_config_option",
                    json!({"sessionId":sid,"configId":config,"value":value}),
                    15000,
                )
                .await?;
            if !result["configOptions"].is_array() {
                return Err("DISPATCH_CONFIGURATION_UNCONFIRMED: missing configOptions".into());
            }
            let mut task = self.state.lock().await;
            task["metadata"]["configOptions"] = result["configOptions"].clone();
            task["configurationObservedAt"] = json!(now());
            save_task(&task)?;
        } else {
            let (method, field, section, current) = if key == "model" {
                ("session/set_model", "modelId", "models", "currentModelId")
            } else if key == "mode" {
                ("session/set_mode", "modeId", "modes", "currentModeId")
            } else {
                return Err(format!("UNSUPPORTED_DISPATCH_OPTION: {key}"));
            };
            let mut params = json!({"sessionId":sid});
            params[field] = json!(value);
            self.call(method, params, 15000).await?;
            let mut task = self.state.lock().await;
            task["metadata"][section][current] = json!(value);
            task["configurationObservedAt"] = json!(now());
            save_task(&task)?;
        }
        Ok(())
    }
}
