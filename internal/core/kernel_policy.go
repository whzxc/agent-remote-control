package core

import "slices"

func policyAllows(policy any, name string) bool {
	switch name {
	case "guide", "notification_ack", "notify_status", "inbox_wait":
		return true
	}
	return policy == "all" || slices.Contains(arr(field(policy, "allowlist")), any(name))
}

func defaultPolicy() object {
	exposure := field(catalog()["toolExposure"], "tools")
	allowlist := []any{}
	for _, op := range arr(catalog()["ops"]) {
		name := text(op, "name")
		if slices.Contains(arr(field(field(exposure, name), "presets")), any("common")) {
			allowlist = append(allowlist, name)
		}
	}
	return object{"allowlist": allowlist}
}
