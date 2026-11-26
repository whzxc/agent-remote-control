package core

import (
	"errors"
	"reflect"
	"slices"
	"strings"
)

func accountHasIdentityConflict(account any) bool {
	for _, resolution := range obj(field(account, "sourceIdentities")) {
		if field(resolution, "state") == "conflict" {
			return true
		}
	}
	return false
}

func observeSourceAccount(rows *[]any, source any) string {
	sourceID := text(source, "id")
	provider := accountProvider(text(source, "platform"))
	var previous object
	for _, value := range *rows {
		row := obj(value)
		if !liveAccount(row) || !ownsAccountSource(row, sourceID) {
			continue
		}
		if len(arr(row["sources"])) == 1 && row["provider"] != provider && len(accountProfiles(row)) == 0 &&
			row["identityKey"] == text(row, "provider")+":unidentified:"+sourceID {
			row["provider"], row["identityKey"] = provider, provider+":unidentified:"+sourceID
		}
		previous = clone(obj(field(row["sourceIdentities"], sourceID)))
		break
	}
	facts := field(source, "authorizationFacts")
	key := accountIdentityKey(provider, facts)
	account := observeAccount(rows, provider, facts, sourceID, nil, sourceID)
	if key == "" || field(previous["authorization"], "identityKey") == key {
		return account
	}
	row := find(*rows, "id", account)
	resolution := object{"state": "resolved", "accountId": account, "authorization": object{"kind": "authorization", "identityKey": key, "observedAt": now()}}
	for _, name := range []string{"evidence", "confirmation"} {
		if previous[name] != nil {
			resolution[name] = previous[name]
		}
	}
	if evidence, ok := field(previous["evidence"], "identityKey").(string); ok && evidence != key &&
		!(accountMatchesIdentity(row, evidence) && accountMatchesIdentity(row, key)) {
		resolution["state"] = "conflict"
		resolution["code"] = "ACCOUNT_IDENTITY_CONFLICT"
		resolution["reason"] = "Authorization identity differs from the confirmed cloud-session identity; authorization takes precedence. Inspect accounts and verify the intended target again."
	}
	accountIdentities(row)[sourceID] = resolution
	return account
}

func linkAccountSourceIdentity(rows []any, source string, evidence object) (object, error) {
	old := slices.IndexFunc(rows, func(a any) bool { return liveAccount(a) && ownsAccountSource(a, source) })
	if old < 0 {
		return nil, errors.New("SOURCE_ACCOUNT_NOT_FOUND")
	}
	target := slices.IndexFunc(rows, func(a any) bool {
		return liveAccount(a) && field(a, "id") == evidence["accountId"] &&
			accountMatchesIdentity(a, text(evidence, "identityKey")) &&
			ownsAccountProfile(a, object{"agent": "claude", "profileId": evidence["profileId"]})
	})
	oldRow := obj(rows[old])
	key := text(oldRow, "identityKey")
	known := !strings.Contains(key, ":unidentified:")
	conflict := target < 0 || known && !accountMatchesIdentity(rows[target], key)
	resolution := object{"state": "resolved", "accountId": oldRow["id"], "evidence": evidence}
	prior := obj(field(oldRow["sourceIdentities"], source))
	for _, name := range []string{"authorization", "confirmation"} {
		if prior[name] != nil {
			resolution[name] = prior[name]
		}
	}
	if conflict {
		resolution["state"], resolution["code"] = "conflict", "ACCOUNT_IDENTITY_CONFLICT"
		reason := "The confirmed cloud-session identity differs from this source's existing identity. The existing account is retained. Inspect accounts and verify the intended target again."
		if target < 0 {
			reason = "The sending profile identity changed or its account was removed. Inspect accounts and verify again."
		}
		resolution["reason"] = reason
		if value := prior["evidence"]; value != nil && !reflect.DeepEqual(value, evidence) {
			resolution["previousEvidence"] = value
		}
		accountIdentities(oldRow)[source] = resolution
		return clone(resolution), nil
	}
	targetRow := obj(rows[target])
	resolution["accountId"] = targetRow["id"]
	if old != target {
		oldRow["sources"] = slices.DeleteFunc(arr(oldRow["sources"]), func(item any) bool { return item == source })
		delete(obj(oldRow["sourceIdentities"]), source)
		targetRow["sources"] = append(arr(targetRow["sources"]), source)
		if len(arr(oldRow["sources"])) == 0 && len(accountProfiles(oldRow)) == 0 {
			oldRow["removedAt"], oldRow["mergedInto"] = evidence["confirmedAt"], targetRow["id"]
		}
	}
	accountIdentities(targetRow)[source] = resolution
	targetRow["observedAt"] = evidence["confirmedAt"]
	return clone(resolution), nil
}
