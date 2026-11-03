use super::*;

impl Timeline {
    pub(super) fn antigravity(&mut self, event: &str, msg: &Value, at: &str) {
        if event == "step_update" {
            let update = &msg["step_update"];
            if update["step_type"] == "agent_response" {
                let id = format!("{}:antigravity:step:{}", self.turn, update["step_index"]);
                if let Some(delta) = update["text_delta"].as_str() {
                    self.delta(&id, "text", delta, at);
                }
                if matches!(string(update, "state"), "DONE" | "ERROR")
                    && self.entries.iter().any(|row| row["id"] == id)
                {
                    self.buffers.remove(&id);
                    let row = self.entry(
                        &id,
                        "text",
                        if update["state"] == "ERROR" {
                            "failed"
                        } else {
                            "completed"
                        },
                    );
                    self.put(row, at);
                }
            }
            if update["state"] == "ERROR" {
                // A tool/permission failure is an observation, never an
                // actionable permission request on the headless transport.
                self.error(update, at);
            }
            return;
        }

        let result = &msg["result"];
        if let Some(response) = result["response"].as_str().filter(|text| !text.is_empty()) {
            // The final response confirms the last assistant message. Replace
            // its streamed form rather than displaying the same reply twice.
            let id = self
                .entries
                .iter()
                .rev()
                .find(|row| row["turnId"] == self.turn && row["type"] == "text")
                .map(|row| string(row, "id").to_owned())
                .unwrap_or_else(|| format!("{}:antigravity:result", self.turn));
            let (text, truncated) = cut(&redact(response), MAX_TEXT);
            self.buffers.remove(&id);
            let mut row = self.entry(&id, "text", "completed");
            row["text"] = json!(text);
            row["truncated"] = json!(truncated);
            row["phase"] = json!("final_answer");
            self.put(row, at);
        }
        if let Some(actions) = result["denied_actions"].as_array() {
            self.partial |= actions.len() > MAX_ENTRIES;
            for (index, action) in actions.iter().take(MAX_ENTRIES).enumerate() {
                let id = format!("{}:antigravity:denied:{index}", self.turn);
                let mut row = self.entry(&id, "error", "failed");
                row["text"] = json!(format!(
                    "Permission denied: {}",
                    string(&summary(action), "text")
                ));
                self.put(row, at);
            }
        }
    }
}
