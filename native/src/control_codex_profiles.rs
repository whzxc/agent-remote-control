//! Native pagination over the shared Codex history, with ARC scheduling attribution.
use crate::*;
impl control::Control {
    pub(crate) async fn profile_task_page(&self, args: Value) -> Result<Value> {
        let mut page = self.request("thread/list", args, 60000).await?;
        for row in page["data"].as_array_mut().into_iter().flatten() {
            row["agentAccountId"] = accounts::codex::observe_history(row)?;
        }
        Ok(page)
    }
}
