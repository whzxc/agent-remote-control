package core

import "strings"

const srcKeychainWaitSeconds = 180
const srcKeychainHint = "Enter the macOS login password in the Chrome Safe Storage prompt and choose Always Allow. Then explicitly retry the import if it is blocked."
const srcMismatchHint = "Select a Chrome profile signed in to the intended ARC account. To import this profile into detectedAccountId, use a source bound to that account or local arc cli control src_login_import --stdin with that accountId and profile."
const srcOutsideScopeHint = "detectedAccountId is outside the calling source account's scope. Select a Chrome profile signed in to the calling account. To import this profile into detectedAccountId, use a source bound to that account or local arc cli control src_login_import --stdin with that accountId and profile."

type srcImportState struct {
	status, reason, hint string
	detectedAccount      *string
}

func srcImportForCaller(result object, caller string) {
	if result["status"] != "import-mismatch" {
		return
	}
	hint := srcMismatchHint
	if detected, found := result["detectedAccountId"].(string); found && caller != "" && detected != caller {
		hint = srcOutsideScopeHint
	}
	result["hint"] = hint
	result["next"] = object{"via": "query", "op": "src_chrome_profiles", "args": object{}, "hint": hint}
}

func srcImporting() srcImportState {
	return srcImportState{status: "importing", hint: srcKeychainHint}
}

func srcImportFinished(installed bool, err error) srcImportState {
	if err != nil {
		return srcImportBlocked(err.Error())
	}
	status := "not-imported"
	if installed {
		status = "signed-in-pending"
	}
	return srcImportState{status: status}
}

func srcImportBlocked(message string) srcImportState {
	message = strings.TrimPrefix(message, "SRC_IMPORT_BLOCKED: ")
	reason, hint := "import-failed", "The import could not finish. Check the selected Chrome profile and account window, then explicitly retry. If Keychain prompts, enter the macOS login password and choose Always Allow."
	switch {
	case message == "keychain-timeout":
		reason, hint = "keychain-timeout", srcKeychainHint
	case message == "keychain-denied" || message == "keychain-denied-or-unavailable":
		reason, hint = "keychain-denied", srcKeychainHint
	case message == "keychain-request-still-pending" || message == "keychain-pending":
		reason, hint = "keychain-pending", "The previous macOS Keychain prompt is still pending. Enter the macOS login password and choose Always Allow; retry only after that prompt has finished."
	case message == "keychain-no-password" || message == "keychain-unavailable":
		reason, hint = "keychain-unavailable", srcKeychainHint
	case message == "cookie-write-pending" || strings.HasPrefix(message, "Cookie writes are still pending"):
		reason, hint = "cookie-write-pending", "Wait for the previous native cookie writes to finish before explicitly retrying the import. Navigation remains blocked until completion."
	case message == "cookie-write-timeout":
		reason, hint = "cookie-write-timeout", "Wait for native cookie writes to finish before explicitly retrying. Navigation remains blocked until completion."
	case message == "import-interrupted":
		reason, hint = "import-interrupted", "The Desktop import was interrupted. Explicitly retry the import; enter the macOS login password and choose Always Allow if prompted."
	case message == "SRC_WINDOW_CLOSED" || message == "window-closed":
		reason, hint = "window-closed", "The account window closed during import. Explicitly retry the import."
	case strings.HasPrefix(message, "chrome-"):
		reason, hint = "chrome-profile-unavailable", "Check that the selected Chrome profile exists and is signed in, then explicitly retry the import."
	}
	return srcImportState{status: "import-blocked", reason: reason, hint: hint}
}

func srcImportMismatch(account string) srcImportState {
	return srcImportState{status: "import-mismatch", reason: "org-mismatch", hint: srcMismatchHint, detectedAccount: &account}
}

func srcImportUnverified() srcImportState {
	return srcImportState{status: "import-unverified", reason: "org-unverified",
		hint: "The imported login could not be matched to this ARC account's confirmed organization. Select a known matching Chrome profile, or explicitly retry with allowUnverified:true if you intend to use this unverified login."}
}

func (s srcImportState) fields() object {
	result := object{"status": s.status, "reason": nil, "hint": nil, "detectedAccountId": nil}
	if s.reason != "" {
		result["reason"] = s.reason
	}
	if s.hint != "" {
		result["hint"] = s.hint
	}
	if s.detectedAccount != nil {
		result["detectedAccountId"] = *s.detectedAccount
	}
	return result
}

func (s srcImportState) response(account string) object {
	result := s.fields()
	result["accountId"] = account
	result["next"] = object{"via": "query", "op": "src_conversations", "args": object{"accountId": account},
		"hint": "Poll this account's import status; do not start another import while it is importing."}
	srcImportForCaller(result, "")
	return result
}
