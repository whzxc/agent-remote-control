//! Safe import progress shared by Desktop and Core; never carries native error payloads.
use serde::Serialize;
use serde_json::{json, Value};

pub const KEYCHAIN_WAIT_SECONDS: u64 = 180;
pub const KEYCHAIN_HINT: &str = "Enter the macOS login password in the Chrome Safe Storage prompt and choose Always Allow. Then explicitly retry the import if it is blocked.";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportState {
    pub status: &'static str,
    pub reason: Option<&'static str>,
    pub hint: Option<&'static str>,
    pub detected_account_id: Option<String>,
}
impl ImportState {
    pub fn importing() -> Self {
        Self {
            status: "importing",
            reason: None,
            hint: Some(KEYCHAIN_HINT),
            detected_account_id: None,
        }
    }
    pub fn finished(result: Result<bool, &str>) -> Self {
        match result {
            Ok(cookies_installed) => Self {
                status: if cookies_installed {
                    "signed-in-pending"
                } else {
                    "not-imported"
                },
                reason: None,
                hint: None,
                detected_account_id: None,
            },
            Err(error) => Self::blocked(error),
        }
    }
    pub fn blocked(error: &str) -> Self {
        let error = error.strip_prefix("SRC_IMPORT_BLOCKED: ").unwrap_or(error);
        let (reason, hint) = match error {
            "keychain-timeout" => ("keychain-timeout", KEYCHAIN_HINT),
            "keychain-denied" | "keychain-denied-or-unavailable" => ("keychain-denied", KEYCHAIN_HINT),
            "keychain-request-still-pending" | "keychain-pending" => ("keychain-pending", "The previous macOS Keychain prompt is still pending. Enter the macOS login password and choose Always Allow; retry only after that prompt has finished."),
            "keychain-no-password" | "keychain-unavailable" => ("keychain-unavailable", KEYCHAIN_HINT),
            error if error=="cookie-write-pending" || error.starts_with("Cookie writes are still pending") => ("cookie-write-pending", "Wait for the previous native cookie writes to finish before explicitly retrying the import. Navigation remains blocked until completion."),
            "cookie-write-timeout" => ("cookie-write-timeout", "Wait for native cookie writes to finish before explicitly retrying. Navigation remains blocked until completion."),
            "import-interrupted" => ("import-interrupted", "The Desktop import was interrupted. Explicitly retry the import; enter the macOS login password and choose Always Allow if prompted."),
            "SRC_WINDOW_CLOSED" | "window-closed" => ("window-closed", "The account window closed during import. Explicitly retry the import."),
            error if error.starts_with("chrome-") => ("chrome-profile-unavailable", "Check that the selected Chrome profile exists and is signed in, then explicitly retry the import."),
            _ => ("import-failed", "The import could not finish. Check the selected Chrome profile and account window, then explicitly retry. If Keychain prompts, enter the macOS login password and choose Always Allow."),
        };
        Self {
            status: "import-blocked",
            reason: Some(reason),
            hint: Some(hint),
            detected_account_id: None,
        }
    }
    pub fn mismatch(account: String) -> Self {
        Self {status:"import-mismatch",reason:Some("org-mismatch"),hint:Some("Import this Chrome profile into detectedAccountId instead, or select a profile signed in to the intended ARC account."),detected_account_id:Some(account)}
    }
    pub fn unverified() -> Self {
        Self {status:"import-unverified",reason:Some("org-unverified"),hint:Some("The imported login could not be matched to this ARC account's confirmed organization. Select a known matching Chrome profile, or explicitly retry with allowUnverified:true if you intend to use this unverified login."),detected_account_id:None}
    }
    pub fn response(&self, account: &str) -> Value {
        let mut result = json!(self);
        result["accountId"] = json!(account);
        result["next"] = json!({"via":"query","op":"src_conversations","args":{"accountId":account},"hint":"Poll this account's import status; do not start another import while it is importing."});
        result
    }
}
