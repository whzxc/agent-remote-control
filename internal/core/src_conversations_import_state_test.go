package core

import "testing"

func TestSRCMismatchRecoveryStaysWithinCallerScope(t *testing.T) {
	// Recurring bug class: security mismatch recovery must remain executable by the calling account.
	result := srcImportMismatch("other-account").response("calling-account")
	local := result["hint"]
	srcImportForCaller(result, "calling-account")
	next := obj(result["next"])
	if result["status"] != "import-mismatch" || result["detectedAccountId"] != "other-account" || result["accountId"] != "calling-account" ||
		next["via"] != "query" || next["op"] != "src_chrome_profiles" || len(obj(next["args"])) != 0 || result["hint"] == local {
		t.Fatalf("cross-account mismatch = %v", result)
	}
	importing := srcImporting().response("calling-account")
	srcImportForCaller(importing, "calling-account")
	if field(importing["next"], "op") != "src_conversations" || field(field(importing["next"], "args"), "accountId") != "calling-account" {
		t.Fatalf("poll continuation = %v", importing)
	}
}
