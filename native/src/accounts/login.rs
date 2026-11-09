use super::*;

pub(super) fn progress(mut value: Value) -> Value {
    value["loginId"] = value["id"].clone();
    value.as_object_mut().map(|o| o.remove("id"));
    if let Some(profile) = value["accountId"].as_str() {
        if let Ok(account) = profile_account(profile) {
            value["accountId"] = account["id"].clone();
        }
    }
    value["kind"] = json!("claude");
    value
}
impl Manager {
    pub(super) async fn login_op(
        &self,
        control: &Arc<control::Control>,
        agents: &Arc<agents::AgentHost>,
        name: &str,
        args: Value,
    ) -> Result<Value> {
        let mut current = self.login.lock().await;
        if name == "account_login" {
            if !matches!(string(&args, "action"), "code" | "cancel") {
                return Err("INVALID_LOGIN_ACTION: Use code or cancel".into());
            }
            if let Some(login) = current.as_mut().filter(|l| l["loginId"] == args["loginId"]) {
                if args["action"] == "cancel" && login["state"] != "waiting" {
                    return Ok(login.clone());
                }
                if login["kind"] == "codex" {
                    if args["action"] == "code" {
                        return Err("ACCOUNT_LOGIN_CODE_UNSUPPORTED: Codex completes authorization through loginUrl; use cancel to stop".into());
                    }
                    let profile = string(login, "profileId");
                    control
                        .auth_rpc(profile)
                        .await?
                        .call(
                            "account/login/cancel",
                            json!({"loginId":args["loginId"]}),
                            15000,
                        )
                        .await?;
                    if login["temporaryProfile"] == true {
                        super::codex::discard_login(control, profile).await?;
                    }
                }
                if args["action"] == "code" {
                    return Err("ACCOUNT_NATIVE_LOGIN_REQUIRED: Configure this Agent with its native authentication, then use account_add kind detect".into());
                }
                login["state"] = json!("cancelled");
                login["loginUrl"] = Value::Null;
                return Ok(login.clone());
            }
            let route = format!("profiles/login/{}", string(&args, "action"));
            let result = self.claude.request(&route, "POST", args).await?;
            return Ok(if result["id"].is_string() {
                progress(result)
            } else {
                result
            });
        }
        if current
            .as_ref()
            .is_some_and(|login| login["state"] == "waiting")
            || self.claude.login_active().await
        {
            return Err("ACCOUNT_LOGIN_IN_PROGRESS: Complete or cancel the active login".into());
        }
        let mut body = json!({});
        let kind = if name == "account_reauth" {
            let row = resolve(string(&args, "id"))?;
            if !live(&row) {
                return Err("ACCOUNT_REMOVED".into());
            }
            let agent = string(&args, "agent");
            let p = profiles(&row)
                .find(|p| p["agent"] == agent)
                .ok_or("ACCOUNT_AGENT_MISSING")?;
            if agent == "claude" {
                body["accountId"] = p["profileId"].clone();
            }
            if agent == "codex" {
                body["profileId"] = p["profileId"].clone();
            }
            if agent == "codex" && p["profileId"] != "codex-home" {
                let profile = string(p, "profileId");
                if control.profile_running(profile).await {
                    return Err("CODEX_PROFILE_IN_USE: Finish this profile's active tasks before reauthentication".into());
                }
                let config = super::codex::profile(profile)?;
                if config.refresh_owner != "codex" {
                    super::codex::tokens(profile,Some(&json!({"reason":"reauthenticate","previousAccountId":config.account_id})), &control.rpc_binary()?).await?;
                    control.close_profile(profile).await;
                    return Ok(
                        json!({"loginId":id(),"kind":"codex","state":"completed","accountId":row["id"],"refreshOwner":config.refresh_owner}),
                    );
                }
                body["reauthAccountId"] = row["id"].clone();
            }
            agent.to_owned()
        } else {
            string(&args, "kind").to_owned()
        };
        if let Some(browser) = args.get("browserId") {
            body["browserId"] = browser.clone();
        }
        if kind == "claude" {
            let result = self.claude.request("profiles/login", "POST", body).await?;
            migrate()?;
            *current = None;
            return Ok(progress(result));
        }
        if kind == "codex" {
            let target = body["profileId"].as_str();
            let temporary = target != Some("codex-home");
            let profile = if temporary {
                super::codex::new_login()?.id
            } else {
                "codex-home".into()
            };
            let start = async {
                control
                    .auth_rpc(&profile)
                    .await?
                    .call("account/login/start", json!({"type":"chatgpt"}), 15000)
                    .await
            }
            .await;
            let mut result = match start {
                Ok(result) => result,
                Err(error) => {
                    if temporary {
                        let _ = super::codex::discard_login(control, &profile).await;
                    }
                    return Err(error);
                }
            };
            result["temporaryProfile"] = json!(temporary);
            if let Some(id) = body["reauthAccountId"].as_str() {
                result["reauthAccountId"] = json!(id);
                result["reauthProfileId"] = json!(target);
            }
            result["profileId"] = json!(profile);
            result["kind"] = json!("codex");
            result["state"] = json!("waiting");
            result["loginUrl"] = result["authUrl"].clone();
            result.as_object_mut().unwrap().remove("authUrl");
            result["browserId"] = json!(args["browserId"].as_str().unwrap_or("default"));
            if let Some(url) = result["loginUrl"].as_str() {
                if let Err(error) =
                    claude::open_login_url(args["browserId"].as_str().unwrap_or("default"), url)
                        .await
                {
                    result["browserError"] = json!(error);
                }
            }
            *current = Some(result.clone());
            return Ok(result);
        }
        if kind == "detect" || kind == "api-key" {
            let mut errors = vec![];
            if kind == "detect" && crate::agents::driver::discover("claude").is_some() {
                if let Err(error) = self
                    .claude
                    .request("profiles/import-system", "POST", json!({}))
                    .await
                {
                    errors.push(error);
                }
            }
            *self.refresh.lock().await = None;
            self.refresh(control, agents).await?;
            let mut result =
                json!({"loginId":id(),"kind":kind,"state":"completed","errors":errors});
            if kind == "api-key" {
                result["state"] = json!("unfinished");
                result["next"] = json!({"message":"Configure the key using the Agent's native authentication, then call account_add with kind detect. ARC never stores an inference key in an account record."});
            }
            *current = Some(result.clone());
            return Ok(result);
        }
        Err("ACCOUNT_NATIVE_LOGIN_REQUIRED: Sign in through this Agent's native CLI, then use account_add kind detect".into())
    }
}

impl Manager {
    pub(super) async fn observe_login(&self, control: &control::Control) -> Result<()> {
        let mut current = self.login.lock().await;
        let Some(login) = current
            .as_mut()
            .filter(|l| l["kind"] == "codex" && l["state"] == "waiting")
        else {
            return Ok(());
        };
        let completed = control
            .events
            .lock()
            .await
            .rows
            .iter()
            .rev()
            .find(|e| {
                e["method"] == "account/login/completed"
                    && e["params"]["loginId"] == login["loginId"]
            })
            .map(|e| e["params"].clone());
        if let Some(completed) = completed {
            login["loginUrl"] = Value::Null;
            let staging = login["profileId"].as_str().unwrap_or("codex-home");
            let target = login["reauthProfileId"].as_str();
            let result = async {
                if completed["success"] != true {
                    return Err(completed["error"]
                        .as_str()
                        .unwrap_or("CODEX_LOGIN_FAILED: Start a new login")
                        .to_owned());
                }
                let native = control
                    .auth_rpc(staging)
                    .await?
                    .call("account/read", json!({"refreshToken":false}), 5000)
                    .await?;
                let facts = &native["account"];
                if !facts.is_object() {
                    return Err(
                        "CODEX_LOGIN_UNCONFIRMED: Native login completed without an account".into(),
                    );
                }
                if let Some(target) = target {
                    let expected = resolve(string(login, "reauthAccountId"))?;
                    super::codex::finish_reauth(control, staging, target, &expected, facts).await
                } else {
                    super::codex::observe_profile(staging, facts, "signed-in")
                }
            }
            .await;
            if login["temporaryProfile"] == true && (target.is_some() || result.is_err()) {
                if let Err(error) = super::codex::discard_login(control, staging).await {
                    crate::logs::record("WARN", &error, None);
                }
            }
            match result {
                Ok(account) => {
                    login["state"] = json!("completed");
                    login["accountId"] = json!(account);
                }
                Err(error) => {
                    login["state"] = json!("failed");
                    login["error"] = json!(error);
                }
            }
        }
        Ok(())
    }
}
