//! Safe import progress shared by Desktop and Core; never carries native error payloads.
use serde::Serialize;
use serde_json::{json, Value};

pub const KEYCHAIN_WAIT_SECONDS: u64 = 180;
pub const KEYCHAIN_HINT: &str = "Enter the macOS login password in the Chrome Safe Storage prompt and choose Always Allow. Then explicitly retry the import if it is blocked.";
const MISMATCH_HINT: &str = "Select a Chrome profile signed in to the intended ARC account. To import this profile into detectedAccountId, use a source bound to that account or local arc cli control src_login_import --stdin with that accountId and profile.";
const OUTSIDE_SCOPE_HINT: &str = "detectedAccountId is outside the calling source account's scope. Select a Chrome profile signed in to the calling account. To import this profile into detectedAccountId, use a source bound to that account or local arc cli control src_login_import --stdin with that accountId and profile.";

/// Project recovery for the caller without changing import or account authorization.
pub fn for_caller(result: &mut Value, calling_account: Option<&str>) {
    if result["status"] != "import-mismatch" {
        return;
    }
    let outside_scope = calling_account.is_some_and(|account| {
        result["detectedAccountId"]
            .as_str()
            .is_some_and(|detected| detected != account)
    });
    let hint = if outside_scope {
        OUTSIDE_SCOPE_HINT
    } else {
        MISMATCH_HINT
    };
    result["hint"] = json!(hint);
    result["next"] = json!({"via":"query","op":"src_chrome_profiles","args":{},"hint":hint});
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ax_contracts_mismatch_recovery_stays_executable_for_the_calling_source() {
        // Regression: ax-7e2730e0 import-mismatch instructed a source to import into an account rejected by SRC_ACCOUNT_SCOPE.
        let mut result = ImportState::mismatch("other-account".into()).response("calling-account");
        let local = result.clone();
        for_caller(&mut result, Some("calling-account"));
        assert_eq!(result["status"], "import-mismatch");
        assert_eq!(result["detectedAccountId"], "other-account");
        assert_eq!(result["accountId"], "calling-account");
        assert_eq!(result["next"]["via"], "query");
        assert_eq!(result["next"]["op"], "src_chrome_profiles");
        assert_eq!(result["next"]["args"], json!({}));
        assert_ne!(result["hint"], local["hint"]);
        assert!(result["hint"]
            .as_str()
            .unwrap()
            .contains("arc cli control src_login_import --stdin"));
        let mut importing = ImportState::importing().response("calling-account");
        for_caller(&mut importing, Some("calling-account"));
        assert_eq!(importing["next"]["op"], "src_conversations");
        assert_eq!(
            importing["next"]["args"],
            json!({"accountId":"calling-account"})
        );
    }
}

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
        Self {
            status: "import-mismatch",
            reason: Some("org-mismatch"),
            hint: Some(MISMATCH_HINT),
            detected_account_id: Some(account),
        }
    }
    pub fn unverified() -> Self {
        Self {status:"import-unverified",reason:Some("org-unverified"),hint:Some("The imported login could not be matched to this ARC account's confirmed organization. Select a known matching Chrome profile, or explicitly retry with allowUnverified:true if you intend to use this unverified login."),detected_account_id:None}
    }
    pub fn response(&self, account: &str) -> Value {
        let mut result = json!(self);
        result["accountId"] = json!(account);
        result["next"] = json!({"via":"query","op":"src_conversations","args":{"accountId":account},"hint":"Poll this account's import status; do not start another import while it is importing."});
        for_caller(&mut result, None);
        result
    }
}
