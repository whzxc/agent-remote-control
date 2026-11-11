//! Device file transfer owner. Bytes bypass tool envelopes and control sources.
use super::*;
pub(crate) mod execution;
mod receiver;
#[cfg(test)]
mod tests;
pub(crate) mod wire;
pub(super) use receiver::Store;

pub(crate) fn error_code(message: &str) -> Option<&'static str> {
    let parsed = serde_json::from_str::<Value>(message).ok();
    [
        "INVALID_PATH",
        "INVALID_REQUEST_ID",
        "REQUEST_ID_CONFLICT",
        "PERMISSION_REQUIRED",
        "DESTINATION_EXISTS",
        "SHA256_MISMATCH",
        "OFFSET_MISMATCH",
        "SOURCE_CHANGED",
        "TRANSFER_CORRUPT",
        "TRANSFER_TERMINAL",
        "TRANSFER_CANCEL_PENDING",
        "INSUFFICIENT_DISK_SPACE",
    ]
    .into_iter()
    .find(|code| message.starts_with(code) || parsed.as_ref().is_some_and(|v| v["code"] == *code))
}
fn failure(message: &str) -> Value {
    let mut value=serde_json::from_str::<Value>(message).ok().filter(|v|v["code"].is_string()).unwrap_or_else(||json!({"code":error_code(message).unwrap_or_else(||crate::management::error_code(message)),"message":message}));
    if value["next"].is_null() {
        value["next"] = json!({"via":"query","op":"guide","args":{"op":"device_transfer"}});
    }
    value
}
