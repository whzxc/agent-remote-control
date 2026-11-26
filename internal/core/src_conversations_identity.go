package core

import (
	"slices"

	"github.com/google/uuid"
)

type srcOrgAccount struct {
	AccountID string   `json:"accountId"`
	OrgIDs    []string `json:"orgIds"`
}

func srcOrgAccounts(accounts, profiles []any) []srcOrgAccount {
	result := []srcOrgAccount{}
	for _, account := range accounts {
		if field(account, "provider") != "anthropic" || field(account, "removedAt") != nil || len(arr(field(account, "sources"))) == 0 {
			continue
		}
		organizations := []string{}
		identities := obj(field(account, "sourceIdentities"))
		for _, source := range keys(identities) {
			resolution := identities[source]
			evidence := field(resolution, "evidence")
			key := text(evidence, "identityKey")
			if field(resolution, "state") != "resolved" || field(evidence, "kind") != "claude-session-handshake" || key == "" {
				continue
			}
			orgID, present := field(evidence, "orgId").(string)
			if !present {
				for _, profile := range profiles {
					if field(profile, "profileId") == field(evidence, "profileId") &&
						accountIdentityKey("anthropic", field(profile, "identity")) == key {
						orgID = text(field(profile, "identity"), "orgId")
						break
					}
				}
			}
			if org, err := uuid.Parse(orgID); err == nil && uuid.Validate(orgID) == nil && !slices.Contains(organizations, org.String()) {
				organizations = append(organizations, org.String())
			}
		}
		result = append(result, srcOrgAccount{AccountID: text(account, "id"), OrgIDs: organizations})
	}
	return result
}

func srcImportGuard(account string, organization *uuid.UUID, known []srcOrgAccount, allowUnverified bool) *srcImportState {
	if organization != nil {
		var different *srcImportState
		for _, candidate := range known {
			for _, identifier := range candidate.OrgIDs {
				if org, err := uuid.Parse(identifier); err == nil && org == *organization {
					if candidate.AccountID == account {
						return nil
					}
					if different == nil {
						mismatch := srcImportMismatch(candidate.AccountID)
						different = &mismatch
					}
					break
				}
			}
		}
		if different != nil {
			return different
		}
	}
	if allowUnverified {
		return nil
	}
	unverified := srcImportUnverified()
	return &unverified
}
