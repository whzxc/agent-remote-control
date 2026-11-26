package core

import "testing"

func TestClaudeSystemImportMatchesIdentity(t *testing.T) {
	// Algorithmic core: System import identification requires a confirmed Claude user in the same organization.
	account := object{"loggedIn": true, "authMethod": "claude.ai", "accountId": "account-a", "email": "a@example.com", "orgId": "org-a"}
	if !sameClaudeSystemIdentity(account, account) || sameClaudeSystemIdentity(object{}, object{}) {
		t.Fatal("unexpected system identity match")
	}
	for key, value := range (object{"accountId": "account-b", "orgId": "org-b", "loggedIn": false}) {
		changed := clone(account)
		changed[key] = value
		if sameClaudeSystemIdentity(account, changed) {
			t.Errorf("system identity matched after changing %s", key)
		}
	}
}
