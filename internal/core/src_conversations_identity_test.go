package core

import (
	"testing"

	"github.com/google/uuid"
)

func TestSRCImportRequiresMatchingOrganization(t *testing.T) {
	// Recurring bug class: security an imported organization can never replace another account's login.
	org := uuid.MustParse("550e8400-e29b-41d4-a716-446655440000")
	other := uuid.MustParse("550e8400-e29b-41d4-a716-446655440001")
	known := []srcOrgAccount{{"selected", []string{org.String()}}, {"other", []string{other.String()}}}
	if state := srcImportGuard("selected", &org, known, false); state != nil {
		t.Fatalf("matching import blocked: %v", state)
	}
	for _, allow := range []bool{true, false} {
		state := srcImportGuard("selected", &other, known, allow)
		if state == nil || state.status != "import-mismatch" || state.detectedAccount == nil || *state.detectedAccount != "other" {
			t.Fatalf("known mismatched account = %v", state)
		}
	}
	for _, absent := range []*uuid.UUID{nil, &uuid.Nil} {
		if state := srcImportGuard("selected", absent, known, false); state == nil || state.status != "import-unverified" {
			t.Fatalf("unknown identity accepted: %v", state)
		}
		if state := srcImportGuard("selected", absent, known, true); state != nil {
			t.Fatalf("explicitly unverified import blocked: %v", state)
		}
	}
}

func TestSRCHandshakeUsesOnlyPinnedProfileIdentity(t *testing.T) {
	// Recurring bug class: security cached organization evidence is valid only while its pinned profile matches the handshake.
	const org = "550e8400-e29b-41d4-a716-446655440000"
	accounts := []any{object{"id": "selected", "provider": "anthropic", "sources": []any{"source"},
		"sourceIdentities": object{"source": object{"state": "resolved", "evidence": object{"kind": "claude-session-handshake",
			"profileId": "profile", "identityKey": "anthropic:id:identity-one"}}}}}
	for _, profile := range []struct {
		id   string
		want int
	}{{"identity-one", 1}, {"identity-two", 0}} {
		rows := srcOrgAccounts(accounts, []any{object{"profileId": "profile", "identity": object{"accountId": profile.id, "orgId": org}}})
		if len(rows) != 1 || len(rows[0].OrgIDs) != profile.want {
			t.Fatalf("organization metadata for %s = %v", profile.id, rows)
		}
	}
}
