package core

import (
	"fmt"
	"strings"
)

func axIssueDraft(args object) object {
	description := strings.ToLower(text(args, "friction"))
	var category string
	switch {
	case strings.Contains(description, "notification") || strings.Contains(description, "delivery"):
		category = "Notification delivery needs investigation"
	case strings.Contains(description, "receipt") || strings.Contains(description, "stall") || strings.Contains(description, "timeout"):
		category = "Task progress or receipt handling needs investigation"
	case strings.Contains(description, "connection") || strings.Contains(description, "connect"):
		category = "Control-source connectivity needs investigation"
	case strings.Contains(description, "setting") || strings.Contains(description, "selection"):
		category = "Settings interaction needs investigation"
	default:
		category = "Unexpected ARC behavior needs investigation"
	}
	refs := []string{}
	for _, kind := range []string{"receipt", "thread"} {
		for _, ref := range arr(args[kind+"Ids"]) {
			refs = append(refs, fmt.Sprintf("- %s fingerprint: %s", kind, hash([]byte(wire(ref)))[:12]))
		}
	}
	if len(refs) == 0 {
		refs = append(refs, "- None supplied")
	}
	body := fmt.Sprintf("## Summary\n%s. The control source reported friction requiring a workaround.\n\n## Environment\n- ARC version: %s\n- OS: %s\n\n## Reproduction\nAdd minimal steps and expected versus observed behavior after reviewing for private information.\n\n## Local reference fingerprints\n%s\n\nOriginal descriptions and evidence bodies are omitted. Fingerprints cannot retrieve local records from another instance.", category, buildVersion, operatingSystem, strings.Join(refs, "\n"))
	return object{"title": "ARC: " + category, "body": body, "arcBuildVersion": buildVersion, "os": operatingSystem, "summaryMode": "fixed-category", "submission": "manual", "issueUrl": "https://github.com/whzxc/agent-remote-control/issues"}
}
