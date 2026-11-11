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
    #[serde(default)]
    pub notification: Value,
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
    #[serde(skip)]
    task_index: std::collections::HashMap<(String, String), String>,
    pub last_seen: BTreeMap<String, String>,
    pub facts: BTreeMap<String, Value>,
}
impl Records {
    pub fn open(directory: &Path) -> Result<Self> {
        let path = directory.join("controller.json");
        if path.exists() {
            let mut records: Self =
                serde_json::from_value(load(&path)?).map_err(|e| e.to_string())?;
            records.task_index = records
                .tasks
                .iter()
                .map(|row| {
                    (
                        (row.device_id.clone(), row.task_id.clone()),
                        row.source_id.clone(),
                    )
                })
                .collect();
            Ok(records)
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
    /// Event-routing attribution only; absence never denies task or receipt access.
    pub fn task_source(&self, device: &str, task: &str) -> Option<&str> {
        self.task_index
            .get(&(device.into(), task.into()))
            .map(String::as_str)
    }
    pub fn associate_receipt(&mut self, device: &str, request: &str, result: &Value) -> bool {
        // A receipt reader is not necessarily the source that submitted the write.
        if let Some(source) = self
            .forwards
            .iter()
            .find(|row| row.device_id == device && row.request_id == request)
            .map(|row| row.source_id.clone())
        {
            self.associate(device, &source, result)
        } else {
            false
        }
    }
    pub fn associate(&mut self, device: &str, source: &str, result: &Value) -> bool {
        let mut changed = false;
        for task in result_tasks(result, 0) {
            if self.task_source(device, &task).is_some() {
                continue;
            }
            while self.tasks.len() >= TASK_CAP {
                if let Some(old) = self.tasks.pop_front() {
                    self.task_index.remove(&(old.device_id, old.task_id));
                }
            }
            changed = true;
            self.task_index
                .insert((device.into(), task.clone()), source.into());
            self.tasks.push_back(Association {
                device_id: device.into(),
                task_id: task,
                source_id: source.into(),
            });
        }
        changed
    }
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
