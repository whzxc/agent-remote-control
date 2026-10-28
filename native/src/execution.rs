//! Application composition: tool routing over shared execution owners.
use crate::{agents::AgentHost, control::Control, *};
pub struct Execution {
    pub(crate) control: Arc<Control>,
    agents: Arc<AgentHost>,
    accounts: Arc<crate::accounts::Manager>,
    subscriptions: Arc<crate::subscriptions::SubscriptionService>,
}
impl Execution {
    pub(crate) fn new(
        control: Arc<Control>,
        agents: Arc<AgentHost>,
        subscriptions: Arc<crate::subscriptions::SubscriptionService>,
        accounts: Arc<crate::accounts::Manager>,
    ) -> Arc<Self> {
        Arc::new(Self {
            control,
            agents,
            subscriptions,
            accounts,
        })
    }
    pub fn approval_mode(&self) -> Result<bool> {
        self.control.approval_mode()
    }
    pub fn auto_open_codex(&self) -> Result<bool> {
        self.control.auto_open_codex()
    }
    pub async fn available(&self, name: &str) -> bool {
        if name == "agent_archive" {
            return true; // Local cleanup does not require an enabled or installed Agent.
        }
        if name == "agents" || name.starts_with("agent_") {
            return self.agents.ui_inventory(false).await["agents"]
                .as_array()
                .is_some_and(|rows| {
                    rows.iter().any(|r| {
                        r["agent"] != "codex" && r["available"] == true && r["enabled"] == true
                    })
                });
        }
        true
    }
    pub async fn call(&self, name: &str, mut args: Value, policy: Value) -> Result<Value> {
        if let Some(receipt) = crate::update_queue::hold(name, &mut args, &policy).await? {
            return Ok(receipt);
        }
        let read_task = match name {
            "codex_read" => Some(("codex".to_owned(), string(&args, "threadId").to_owned())),
            "agent_read" => Some((
                string(&args, "agent").to_owned(),
                string(&args, "taskId").to_owned(),
            )),
            _ => None,
        };
        let summary = crate::task_summary::requested(name, &args);
        let mut result = self.call_inner(name, args.clone(), policy).await?;
        if !summary
            && name == "codex_wait"
            && result["turnId"].is_string()
            && matches!(
                result["state"].as_str(),
                Some("completed" | "failed" | "cancelled")
            )
        {
            let _ = crate::changes::query(
                &self.control,
                &json!({"threadId":args["threadId"],"turnId":result["turnId"],"limit":1}),
            )
            .await;
        }
        if summary {
            crate::task_summary::evidence(&self.control, name, &args, &mut result).await?;
        }
        if let Some((agent, task)) = read_task.filter(|_| !summary) {
            result["srcConversation"] = crate::src_conversations::task_ref(&agent, &task)?;
        }
        Ok(result)
    }
    pub(crate) async fn call_inner(&self, name: &str, args: Value, policy: Value) -> Result<Value> {
        if name.starts_with("src_") {
            return crate::src_conversations::op(name, args).await;
        }
        if matches!(name, "update_status" | "update_request") {
            let spec = catalog()["ops"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["name"] == name)
                .unwrap();
            crate::egress::validate_op(spec, &args)?;
        }
        if name == "update_status" {
            return crate::app_replace::update_status(args["view"] == "full").await;
        }
        if name == "update_request" {
            return crate::app_replace::update_request(args).await;
        }

        if matches!(name, "notify_control" | "notify_status") {
            crate::accounts::migrate()?;
        }
        if matches!(
            name,
            "account_browsers"
                | "account_notify"
                | "whoami"
                | "accounts"
                | "account_update"
                | "account_merge"
                | "account_add"
                | "account_login"
                | "account_reauth"
                | "account_remove"
        ) {
            let mut args = args;
            // Outer act requestId is transport metadata; account mutations use state readback.
            if !matches!(name, "accounts" | "whoami" | "account_browsers") {
                args.as_object_mut().map(|args| args.remove("requestId"));
            }
            let spec = catalog()["ops"]
                .as_array()
                .unwrap()
                .iter()
                .find(|op| op["name"] == name)
                .unwrap();
            crate::egress::validate_op(spec, &args)?;
            return self
                .accounts
                .op(&self.control, &self.agents, &self.subscriptions, name, args)
                .await;
        }
        if matches!(
            name,
            "codex_create" | "codex_send" | "agent_create" | "agent_send" | "dispatch_policy"
        ) {
            self.accounts.refresh(&self.control, &self.agents).await?;
        }
        if matches!(
            name,
            "context_resolve"
                | "context_search"
                | "context_read"
                | "context_check"
                | "context_amend"
        ) {
            let mut args = args;
            // The frozen act envelope's request ID is ARC metadata, not a provider argument.
            if name == "context_amend" {
                args.as_object_mut().map(|args| args.remove("requestId"));
            }
            let spec = catalog()["ops"]
                .as_array()
                .unwrap()
                .iter()
                .find(|op| op["name"] == name)
                .unwrap();
            crate::egress::validate_op(spec, &args)?;
            let timeout = std::time::Duration::from_secs(match name {
                "context_amend" | "context_check" => 120,
                _ => 10,
            });
            return crate::context_provider::call(
                name.strip_prefix("context_").unwrap(),
                args,
                timeout,
            )
            .await;
        }
        if name == "dispatch_policy_update" {
            let mut args = args;
            // The frozen act request ID is transport metadata, not a policy field.
            args.as_object_mut().map(|args| args.remove("requestId"));
            let spec = catalog()["ops"]
                .as_array()
                .unwrap()
                .iter()
                .find(|op| op["name"] == name)
                .unwrap();
            crate::egress::validate_op(spec, &args)?;
            return self.agents.update_dispatch_policy(&args);
        }
        if name == "dispatch_policy" {
            let catalog = crate::catalog();
            let spec = catalog["ops"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["name"] == name)
                .unwrap();
            crate::egress::validate_op(spec, &args)?;
            return crate::dispatch_policy::query(
                &self.control,
                &self.agents,
                &self.subscriptions,
                &args,
            )
            .await;
        }
        if matches!(
            name,
            "task_timeline"
                | "task_reviews"
                | "task_review_undo"
                | "task_panel"
                | "task_panel_control"
                | "task_bubble"
                | "task_mark_read"
                | "task_open"
                | "task_resource"
        ) {
            let spec = catalog()["ops"]
                .as_array()
                .unwrap()
                .iter()
                .find(|op| op["name"] == name)
                .unwrap();
            crate::egress::validate_op(spec, &args)?;
            return match name {
                "task_bubble" | "task_mark_read" => {
                    let mut bubble_args = args.clone();
                    if name == "task_mark_read" {
                        bubble_args["action"] = json!("mark-read");
                    }
                    let result = crate::transport::forward_request(
                        "app/snapshot",
                        "POST",
                        json!({"modelOnly":true,"taskBubble":bubble_args}),
                    )
                    .await?;
                    result["model"]["taskBubbles"]
                        .as_array()
                        .and_then(|rows| rows.iter().find(|row| row["agent"] == args["agent"] && row["id"] == args["id"]))
                        .cloned()
                        .ok_or_else(|| "TASK_BUBBLE_NOT_FOUND: read app.snapshot model.taskBubbles for current renderer task IDs".into())
                }
                "task_timeline" => {
                    let mut result = self
                        .agents
                        .conversation_timeline(&self.control, &args)
                        .await?;
                    if args["expectedHash"].is_string()
                        && args["expectedHash"] == result["snapshotHash"]
                    {
                        result["entries"] = json!([]);
                        result["unchanged"] = json!(true);
                    }
                    Ok(result)
                }
                "task_reviews" => {
                    Ok(json!({"reviews":crate::dispatch_policy::reviews(string(&args,"id"))?}))
                }
                "task_review_undo" => crate::dispatch_policy::undo_local_review(
                    string(&args, "id"),
                    string(&args, "turnId"),
                    string(&args, "reviewRequestId"),
                ),
                "task_panel" | "task_panel_control" => {
                    let full = args["view"] == "full";
                    let mut panel_args = args.clone();
                    panel_args.as_object_mut().unwrap().remove("view");
                    let result = crate::transport::forward_request(
                        "app/snapshot",
                        "POST",
                        json!({"modelOnly":true,"taskPanel":panel_args}),
                    )
                    .await?;
                    Ok(if full {
                        result["model"]["taskDetail"].clone()
                    } else {
                        crate::egress::panel_state(&result["model"]["taskDetail"])
                    })
                }
                "task_open" => {
                    crate::transport::forward_request(
                        "tasks/open",
                        "POST",
                        json!({"agent":args["agent"],"taskId":args["id"]}),
                    )
                    .await
                }
                _ => crate::transport::forward_request("agents/resources", "POST", args).await,
            };
        }
        if name == "receipt" {
            let spec = crate::catalog()["ops"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["name"] == name)
                .unwrap();
            crate::egress::validate_op(spec, &args)?;
            if let Some(receipt) = crate::update_queue::receipt(&args).await? {
                return Ok(receipt);
            }
            if let Some(receipt) = self.agents.receipt(args.clone()).await? {
                return Ok(receipt);
            }
            return self.control.tool(name, args).await;
        }
        if name == "agent_context" {
            crate::context::read(&self.agents, &self.control, args, policy).await
        } else if name == "agents" || name.starts_with("agent_") {
            self.agents.tool(&self.control, name, args).await
        } else {
            self.control.tool(name, args).await
        }
    }
}
