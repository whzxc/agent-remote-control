package core

import (
	"errors"
	"reflect"
	"slices"
	"strings"
)

func canonicalAccount(rows []any, reference string) (string, error) {
	for range len(rows) + 1 {
		row := find(rows, "id", reference)
		next, ok := row["mergedInto"].(string)
		if !ok {
			return reference, nil
		}
		reference = next
	}
	return "", errors.New("ACCOUNT_MERGE_CYCLE: Inspect accounts before changing account ownership")
}

func accountMatchesIdentity(account any, key string) bool {
	return field(account, "identityKey") == key || slices.Contains(arr(field(account, "identityAliases")), any(key))
}

func sharedAccountQuota(subscription any) object {
	out := selectFields(obj(subscription), "state", "windows", "observedAt", "accountBlocked", "blockedPoolIds")
	for _, name := range []string{"state", "windows", "observedAt", "accountBlocked", "blockedPoolIds"} {
		out[name] = field(subscription, name)
	}
	out["source"] = "subscription"
	if err := field(subscription, "error"); err != nil {
		out["error"] = err
	}
	return out
}

func mergeProviderAccounts(rows []any, args object, snapshot any, at string) (object, error) {
	into, err := canonicalAccount(rows, text(args, "into"))
	if err != nil {
		return nil, err
	}
	target := slices.IndexFunc(rows, func(row any) bool { return field(row, "id") == into && liveAccount(row) })
	if target < 0 {
		return nil, errors.New("ACCOUNT_MERGE_TARGET_MISSING: Select an active target account")
	}
	ids := arr(args["ids"])
	if len(ids) == 0 {
		return nil, errors.New("ACCOUNT_MERGE_MEMBERS_REQUIRED: Supply the account IDs confirmed to share this identity")
	}
	members := []int{}
	for _, raw := range ids {
		ref, ok := raw.(string)
		if !ok {
			return nil, errors.New("INVALID_ACCOUNT_ID: Account IDs must be strings")
		}
		id, err := canonicalAccount(rows, ref)
		if err != nil {
			return nil, err
		}
		index := slices.IndexFunc(rows, func(row any) bool { return field(row, "id") == id && liveAccount(row) })
		if index < 0 {
			return nil, errors.New("ACCOUNT_MERGE_MEMBER_MISSING: Read accounts and select active account IDs")
		}
		if index != target && !slices.Contains(members, index) {
			members = append(members, index)
		}
	}
	if alias, ok := args["alias"]; ok && !validAccountAlias(alias) {
		return nil, errors.New("INVALID_ACCOUNT_ALIAS: Use 1 to 120 characters")
	}
	var subscription object
	if provider, ok := args["quotaProviderId"].(string); ok {
		subscription = find(field(snapshot, "providers"), "providerId", provider)
		if subscription == nil {
			return nil, errors.New("ACCOUNT_QUOTA_PROVIDER_MISSING: Select a quota provider from subscriptions")
		}
	}
	combined := clone(obj(rows[target]))
	add := func(key string, value any) {
		list := arr(combined[key])
		if list == nil {
			list = []any{}
		}
		if !slices.ContainsFunc(list, func(item any) bool {
			if key == "agentProfiles" {
				return sameAccountProfile(item, value)
			}
			return reflect.DeepEqual(item, value)
		}) {
			list = append(list, value)
		}
		combined[key] = list
	}
	for _, index := range members {
		previous := obj(rows[index])
		for _, key := range []string{"sources", "agentProfiles", "identityAliases", "mergedAccountIds"} {
			if arr(combined[key]) == nil {
				combined[key] = []any{}
			}
			for _, value := range arr(previous[key]) {
				add(key, value)
			}
		}
		if value, ok := previous["identityKey"].(string); ok {
			add("identityAliases", value)
		}
		if value, ok := previous["id"].(string); ok {
			add("mergedAccountIds", value)
		}
		newKey, known := previous["identityKey"].(string)
		if strings.Contains(text(combined, "identityKey"), ":unidentified:") && known && !strings.Contains(newKey, ":unidentified:") {
			add("identityAliases", combined["identityKey"])
			combined["identityKey"], combined["provider"] = newKey, previous["provider"]
		}
		for source, resolution := range obj(previous["sourceIdentities"]) {
			entry := clone(obj(resolution))
			if entry == nil {
				entry = object{}
			}
			entry["accountId"] = into
			accountIdentities(combined)[source] = entry
		}
		for _, field := range []string{"email", "orgName", "plan", "quotaProviderId"} {
			if combined[field] == nil && previous[field] != nil {
				combined[field] = previous[field]
			}
		}
		if len(arr(field(combined["quota"], "windows"))) == 0 && len(arr(field(previous["quota"], "windows"))) != 0 {
			combined["quota"] = previous["quota"]
		}
		previous["sources"], previous["agentProfiles"], previous["sourceIdentities"] = []any{}, []any{}, object{}
		previous["removedAt"], previous["mergedInto"] = at, into
	}
	if alias, ok := args["alias"].(string); ok {
		combined["alias"] = strings.TrimSpace(alias)
	}
	for _, value := range arr(combined["sources"]) {
		source, ok := value.(string)
		if !ok {
			continue
		}
		identities := accountIdentities(combined)
		resolution := obj(identities[source])
		if resolution == nil {
			resolution = object{}
			identities[source] = resolution
		}
		resolution["state"], resolution["accountId"] = "resolved", into
		resolution["confirmation"] = object{"kind": "user-confirmed-merge", "confirmedAt": at}
		delete(resolution, "code")
		delete(resolution, "reason")
	}
	if subscription != nil {
		combined["quotaProviderId"], combined["provider"], combined["quota"] = subscription["providerId"], accountProvider(text(subscription, "agentId")), sharedAccountQuota(subscription)
		raw := subscription["rawUsage"]
		if field(field(raw, "config"), "isUnifiedBillingUser") == true || field(field(field(raw, "sharedUsage"), "config"), "isUnifiedBillingUser") == true {
			combined["provider"], combined["plan"] = "xai", "X Pass"
		}
	} else if raw, present := args["quotaProviderId"]; present && raw == nil {
		combined["quotaProviderId"] = nil
		combined["quota"] = object{"state": "unavailable", "windows": []any{}}
	}
	combined["observedAt"] = at
	rows[target] = combined
	accountDefaults(rows)
	return clone(combined), nil
}
