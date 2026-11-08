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
                if login["kind"] == "codex" {
                    if args["action"] == "code" {
                        return Err("ACCOUNT_LOGIN_CODE_UNSUPPORTED: Codex completes authorization through loginUrl; use cancel to stop".into());
                    }
                    control
                        .auth_rpc(login["profileId"].as_str().unwrap_or("codex-home"))
                        .await?
                        .call(
                            "account/login/cancel",
                            json!({"loginId":args["loginId"]}),
                            15000,
                        )
                        .await?;
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
                body["profileId"] = p["profileId"].clone();
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
            if current
                .as_ref()
                .is_some_and(|v| v["kind"] == "codex" && v["state"] == "waiting")
            {
                return Err(
                    "ACCOUNT_LOGIN_IN_PROGRESS: Complete or cancel the active login".into(),
                );
            }
            let profile = if let Some(profile) = body["profileId"].as_str() {
                profile.to_owned()
            } else {
                super::codex::new_login()?.id
            };
            let mut result = control
                .auth_rpc(&profile)
                .await?
                .call("account/login/start", json!({"type":"chatgpt"}), 15000)
                .await?;
            result["profileId"] = json!(profile);
            result["kind"] = json!("codex");
            result["state"] = json!("waiting");
            result["loginUrl"] = result["authUrl"].clone();
            result.as_object_mut().unwrap().remove("authUrl");
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
            if completed["success"] == true {
                let profile = login["profileId"].as_str().unwrap_or("codex-home");
                let result = control
                    .auth_rpc(profile)
                    .await?
                    .call("account/read", json!({"refreshToken":false}), 5000)
                    .await?;
                let facts = &result["account"];
                if !facts.is_object() {
                    return Err("ACCOUNT_LOGIN_UNCONFIRMED: Native login completed without an account; read accounts again".into());
                }
                let account = super::codex::observe_profile(profile, facts, "signed-in")?;
                login["state"] = json!("completed");
                login["accountId"] = json!(account);
            } else {
                login["state"] = json!("failed");
                login["error"] = completed["error"].clone();
            }
        }
        Ok(())
    }
}
