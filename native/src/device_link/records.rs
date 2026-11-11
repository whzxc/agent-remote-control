//! Bounded controller metadata. Member receipts remain canonical.
use super::*;
use std::collections::VecDeque;
pub const FORWARD_CAP: usize = 1024;
pub const TASK_CAP: usize = 4096;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Forward {
    pub request_id: String,
    pub device_id: String,
    pub op: String,
    pub source_id: String,
    pub sent_at: String,
    pub outcome: String,
    pub digest: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Association {
    device_id: String,
    task_id: String,
    source_id: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Records {
    pub forwards: VecDeque<Forward>,
    tasks: VecDeque<Association>,
    pub last_seen: BTreeMap<String, String>,
    pub facts: BTreeMap<String, Value>,
}
impl Records {
    pub fn open(directory: &Path) -> Result<Self> {
        let path = directory.join("controller.json");
        if path.exists() {
            serde_json::from_value(load(&path)?).map_err(|e| e.to_string())
        } else {
            Ok(Self::default())
        }
    }
    pub fn save(&self, directory: &Path) -> Result<()> {
        save(
            &directory.join("controller.json"),
            &serde_json::to_value(self).map_err(|e| e.to_string())?,
        )
    }
    pub fn record(&mut self, record: Forward) {
        while self.forwards.len() >= FORWARD_CAP {
            self.forwards.pop_front();
        }
        self.forwards.push_back(record);
    }
    pub fn outcome(&mut self, request: &str, outcome: &str) {
        if let Some(record) = self.forwards.iter_mut().find(|r| r.request_id == request) {
            record.outcome = outcome.into();
        }
    }
    pub fn authorize(&self, device: &str, op: &str, args: &Value, origin: &Value) -> Result<()> {
        let source = string(origin, "sourceId");
        if source.is_empty() {
            return Err(scope_error());
        }
        let local = origin["authType"] == "local";
        if let Some(request) = args["requestId"].as_str().filter(|_| op == "receipt") {
            if !local
                && !self.forwards.iter().any(|r| {
                    r.device_id == device && r.request_id == request && r.source_id == source
                })
            {
                return Err(scope_error());
            }
        }
        let mut tasks = task_arguments(args);
        if op.starts_with("task_") {
            if let Some(task) = args["id"].as_str() {
                tasks.push(task.into());
            }
        }
        for task in tasks {
            if !local
                && !self
                    .tasks
                    .iter()
                    .any(|r| r.device_id == device && r.task_id == task && r.source_id == source)
            {
                return Err(scope_error());
            }
        }
        Ok(())
    }
    pub fn associate(&mut self, device: &str, source: &str, result: &Value) {
        for task in result_tasks(result, 0) {
            if self
                .tasks
                .iter()
                .any(|r| r.device_id == device && r.task_id == task)
            {
                continue;
            }
            while self.tasks.len() >= TASK_CAP {
                self.tasks.pop_front();
            }
            self.tasks.push_back(Association {
                device_id: device.into(),
                task_id: task,
                source_id: source.into(),
            });
        }
    }
}
fn scope_error() -> String {
    json!({"code":"DEVICE_TASK_SCOPE","message":"This task or receipt is not associated with the calling source, or its bounded association has expired.","next":{"via":"query","op":"guide","args":{"op":"device"}}}).to_string()
}
/// Structured native task references, including low-level params; user content is opaque.
pub fn task_arguments(args: &Value) -> Vec<String> {
    let mut tasks = Vec::new();
    for key in ["threadId", "taskId", "parentThreadId"] {
        if let Some(task) = args[key].as_str() {
            tasks.push(task.into());
        }
    }
    for key in ["threadIds", "taskIds"] {
        for task in args[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            tasks.push(task.into());
        }
    }
    if args["params"].is_object() {
        tasks.extend(task_arguments(&args["params"]));
    }
    tasks
}
fn result_tasks(value: &Value, depth: usize) -> Vec<String> {
    if depth > 5 {
        return vec![];
    }
    let mut tasks = vec![];
    for key in ["threadId", "taskId"] {
        if let Some(task) = value[key].as_str() {
            tasks.push(task.into());
        }
    }
    for key in ["thread", "task"] {
        if let Some(task) = value[key]["id"].as_str() {
            tasks.push(task.into());
        }
    }
    for key in ["result", "receipt"] {
        if value[key].is_object() {
            tasks.extend(result_tasks(&value[key], depth + 1));
        }
    }
    tasks
}
