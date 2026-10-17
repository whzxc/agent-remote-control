//! Application composition: tool routing over shared execution owners.
use crate::{agents::AgentHost, control::Control, *};
pub struct Execution {
    pub(crate) control: Arc<Control>,
    agents: Arc<AgentHost>,
}
impl Execution {
    pub fn new(control: Arc<Control>, agents: Arc<AgentHost>) -> Arc<Self> {
        Arc::new(Self { control, agents })
    }
    pub fn approval_mode(&self) -> Result<bool> {
        self.control.approval_mode()
    }
    pub fn auto_open_codex(&self) -> Result<bool> {
        self.control.auto_open_codex()
    }
    pub async fn available(&self, name: &str) -> bool {
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
    pub async fn call(&self, name: &str, args: Value, policy: Value) -> Result<Value> {
        if name == "receipt" {
            let spec = crate::catalog()["ops"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["name"] == name)
                .unwrap();
            crate::egress::validate_op(spec, &args)?;
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
