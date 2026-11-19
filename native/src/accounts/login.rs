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
        if name == "account_login" {
            if !matches!(string(&args, "action"), "code" | "cancel") {
                return Err("INVALID_LOGIN_ACTION: Use code or cancel".into());
            }
            let route = format!("profiles/login/{}", string(&args, "action"));
            let result = self.claude.request(&route, "POST", args).await?;
            return Ok(if result["id"].is_string() {
                progress(result)
            } else {
                result
            });
        }
        if self.claude.login_active().await {
            return Err("ACCOUNT_LOGIN_IN_PROGRESS: Complete or cancel the active login".into());
        }
        let mut body = json!({});
        let kind = if name == "account_reauth" {
            let row = resolve(string(&args, "id"))?;
            if !live(&row) {
                return Err("ACCOUNT_REMOVED".into());
            }
            let agent = string(&args, "agent");
            if agent != "claude" {
                return Err("ACCOUNT_AGENT_UNSUPPORTED: Only Claude L1 notification profiles support reauthentication".into());
            }
            let p = profiles(&row)
                .find(|p| p["agent"] == "claude")
                .ok_or("ACCOUNT_AGENT_MISSING")?;
            body["accountId"] = p["profileId"].clone();
            "claude".to_owned()
        } else {
            string(&args, "kind").to_owned()
        };
        if let Some(browser) = args.get("browserId") {
            body["browserId"] = browser.clone();
        }
        if kind == "claude" {
            let result = self.claude.request("profiles/login", "POST", body).await?;
            migrate()?;
            return Ok(progress(result));
        }
        if kind == "detect" {
            let mut errors = vec![];
            if crate::agents::driver::discover("claude").is_some() {
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
            return Ok(json!({"loginId":id(),"kind":kind,"state":"completed","errors":errors}));
        }
        Err("ACCOUNT_KIND_UNSUPPORTED: Use claude for L1 notification profiles or detect".into())
    }
}
