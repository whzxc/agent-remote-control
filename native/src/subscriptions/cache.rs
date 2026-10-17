use super::{types::*, Slot};
use crate::*;
use serde::{Deserialize, Serialize};

// Last successful readings are displayed as stale until refreshed.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedReading {
    observed_at: String,
    windows: Vec<QuotaWindow>,
    raw_usage: Value,
    account_blocked: Option<bool>,
    blocked_pool_ids: Vec<String>,
}
fn path(id: &str) -> PathBuf {
    root()
        .join("subscriptions/readings")
        .join(format!("{id}.json"))
}
pub(super) fn remove(id: &str) {
    if let Err(error) = std::fs::remove_file(path(id)) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!("could not remove subscription cache ({id}): {error}");
        }
    }
}
pub(super) fn restore(slot: &mut Slot) {
    let id = &slot.view.provider_id;
    let Some(reading) = load(&path(id))
        .ok()
        .and_then(|v| serde_json::from_value::<CachedReading>(v).ok())
    else {
        return;
    };
    slot.view.windows = reading.windows;
    slot.view.raw_usage = reading.raw_usage;
    slot.view.observed_at = Some(reading.observed_at);
    slot.view.account_blocked = reading.account_blocked;
    slot.view.blocked_pool_ids = reading.blocked_pool_ids;
    if let Some(raw) = slot.view.raw_usage.as_object_mut() {
        raw.remove("history");
    }
    slot.view.state = "stale".into();
}
pub(super) fn persist(slot: &Slot) {
    let Some(observed_at) = &slot.view.observed_at else {
        return;
    };
    let reading = CachedReading {
        observed_at: observed_at.clone(),
        windows: slot.view.windows.clone(),
        raw_usage: slot.view.raw_usage.clone(),
        account_blocked: slot.view.account_blocked,
        blocked_pool_ids: slot.view.blocked_pool_ids.clone(),
    };
    if let Err(error) = save(
        &path(&slot.view.provider_id),
        &serde_json::to_value(reading).unwrap(),
    ) {
        eprintln!(
            "could not save subscription cache ({}): {error}",
            slot.view.provider_id
        );
    }
}
