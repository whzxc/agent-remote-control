package core

import (
	"errors"
	"slices"
)

func validateProfile(profile any, local bool) error {
	if profile == nil {
		return nil
	}
	access := text(profile, "hostAccess")
	wait := text(profile, "waitMode")
	valid := len(obj(profile)) == 2
	if local {
		valid = valid && access == "host" && wait == "background-cli"
	} else {
		valid = valid && (access == "none" || access == "unknown") && (wait == "push" || wait == "poll")
	}
	if !valid {
		return errors.New("INVALID_ARGUMENT: capabilityProfile must be null (derived from the source), {hostAccess:host,waitMode:background-cli} for built-in Local CLI, or {hostAccess:none|unknown,waitMode:push|poll} for MCP sources. Use cli source update <id> --stdin.")
	}
	return nil
}

func derivedProfile(product string, local bool) object {
	if local {
		return object{"hostAccess": "host", "waitMode": "background-cli"}
	}
	hostAccess, waitMode := "none", "poll"
	switch product {
	case "custom":
		hostAccess = "unknown"
	case "claude", "chatgpt", "gemini":
		waitMode = "push"
	}
	return object{"hostAccess": hostAccess, "waitMode": waitMode}
}

func profileOffer(product string, local bool) object {
	choices := []string{"derived", "remote-push", "remote-polling"}
	if local {
		choices = []string{"derived", "local-code"}
	}
	return object{"recommended": derivedProfile(product, local), "choices": choices}
}

func effectiveProfile(origin, source object, local bool) object {
	transport, provenance := "mcp", "derived"
	if origin["controlTransport"] == "cli" {
		transport = "cli"
	}
	local = local && transport == "cli"
	setting := obj(source["capabilityProfile"])
	if setting == nil {
		setting = derivedProfile(text(source, "product"), local)
	} else {
		provenance = "source-override"
	}
	name, access, wait := "remote-polling", "unknown", setting["waitMode"]
	if setting["hostAccess"] == "none" {
		access = "none"
	}
	if local {
		name, access, wait = "local-code", "host", "background-cli"
	} else if wait == "push" {
		name = "remote-push"
	}
	return object{"name": name, "transport": transport, "hostAccess": access, "waitMode": wait, "provenance": provenance}
}

type guideFeatures struct {
	maintainer, context, hub bool
}

func renderGuide(origin, args object, ops []object, profile object, features guideFeatures) object {
	name := text(profile, "name")
	topic, ok := args["topic"].(string)
	if !ok {
		topic = "loop"
	}
	full := args["view"] == "full"
	guides := field(catalog()["guides"], "en")
	preset, contentKey := "profile-"+topic, "profile-"+topic
	if topic == "loop" {
		preset, contentKey = name, name
		if !full {
			contentKey = "orientation"
		}
	}
	content := "MUST means a requirement. SHOULD means the default unless a concrete task-specific reason justifies an exception. MAY means an option.\n" + text(guides, contentKey)
	if topic == "loop" {
		if !full {
			content += text(guides, name+"-pointer")
		} else if name == "remote-push" {
			content += text(guides, "profile-notify")
		}
		if features.context {
			content += "Context provider configured. Read topic:context.\n"
		}
		if features.hub {
			content += "MCP hub enabled. Read guide({op:\"mcp_tools\"}).\n"
		}
		if features.maintainer {
			content += "Maintainer AX workflow is in guide({op:\"ax_list\"}).\n"
		} else {
			content += "AX feedback is in guide({op:\"ax_issue_draft\"}).\n"
		}
	}
	if topic == "context" && features.context {
		content += text(guides, "contextProvider")
	}
	exposure := field(catalog()["toolExposure"], "tools")
	common := []string{"guide", "projects", "command", "read", "write", "codex_create", "codex_send", "codex_read", "codex_wait", "codex_review", "dispatch_policy", "receipt", "board"}
	scope := "topic"
	if full {
		scope = "full"
	} else if topic == "loop" {
		scope = "common"
	}
	index := []object{}
	for _, op := range ops {
		opName := text(op, "name")
		if scope == "common" && !slices.Contains(common, opName) {
			continue
		}
		if scope == "topic" && !slices.Contains(arr(field(field(exposure, opName), "presets")), any(preset)) {
			continue
		}
		entry := object{"op": opName, "via": opTools(op)}
		if scope != "common" {
			entry["signature"] = signature(op)
			entry["retry"] = object{"mode": retryContract(op)["mode"]}
		}
		index = append(index, entry)
	}
	result := object{"topic": topic, "profile": profile, "sourceId": origin["sourceId"], "content": content, "ops": index, "indexScope": scope,
		"fullIndex": object{"tool": "query", "arguments": object{"op": "guide", "args": object{"view": "full"}}}}
	if topic == "loop" {
		result["maintainerMode"] = features.maintainer
	}
	if (name == "remote-push" && full || topic == "notify") && origin["controlSource"] == "chatgpt" {
		result["events"] = eventGuide()
	}
	return result
}
