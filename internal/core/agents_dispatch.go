package core

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"strings"
	"time"
)

func nativeAgentPolicyFacts(ctx context.Context, s *service, args object) ([]object, error) {
	agent, taskID := text(args, "agent"), text(args, "taskId")
	if agent != "" {
		if _, ok := nativeAgentDriverByID(agent); !ok {
			return nil, errors.New("UNKNOWN_AGENT: read query agents for registered IDs")
		}
	}
	tasks := map[string]object{}
	if taskID != "" {
		if agent == "" || agent == "codex" {
			return nil, errors.New("TASK_REQUIRES_NON_CODEX_AGENT")
		}
		if !nativeAgentReadAllowed(ctx, agent, taskID) {
			return nil, errors.New("TASK_NOT_FOUND")
		}
		task, err := s.nativeAgentTask(agent, taskID)
		if err != nil {
			return nil, err
		}
		tasks[agent] = task
	} else {
		stored, err := listNativeAgentStates(agent, true)
		if err != nil {
			return nil, err
		}
		for _, task := range stored {
			id := text(task, "agent")
			if tasks[id] == nil && len(obj(task["metadata"])) > 0 && nativeAgentReadAllowed(ctx, id, text(task, "taskId")) {
				tasks[id] = task
			}
		}
	}
	inventory, err := nativeAgentInventory(ctx, s, false)
	if err != nil {
		return nil, err
	}
	rows := []object{}
	for _, item := range inventory["agents"].([]object) {
		id := text(item, "agent")
		if agent != "" && id != agent || args["all"] != true && (item["installed"] != true || item["enabled"] != true) {
			continue
		}
		row := object{"agent": id, "protocol": item["protocol"],
			"availability": object{"installed": item["installed"], "available": item["available"], "enabled": item["enabled"],
				"discoveryError": item["discoveryError"], "observedAt": inventory["observedAt"]}}
		if id != "codex" {
			var capabilities object
			var issue error
			if task := tasks[id]; task != nil {
				process := s.agents.process(text(task, "taskId"))
				if item["enabled"] != true {
					process = nil
				}
				capabilities, issue = nativeAgentSessionFacts(ctx, task, process)
			} else {
				capabilities, issue = nativeAgentSessionlessCatalog(ctx, id)
			}
			if issue != nil {
				capabilities = object{"authoritative": false, "unavailable": issue.Error()}
			}
			if models := arr(capabilities["models"]); agent == "" && len(models) > 8 {
				capabilities["models"], capabilities["omittedModels"], capabilities["authoritative"] = models[:8], len(models)-8, false
			}
			row["capabilities"] = capabilities
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func nativeAgentSessionFacts(ctx context.Context, task object, process *nativeAgentProcess) (object, error) {
	agent := text(task, "agent")
	metadata, observed, source := task["metadata"], task["configurationObservedAt"], "persisted-session-snapshot"
	var levels any
	if process != nil {
		select {
		case <-process.done:
			process = nil
		default:
		}
	}
	if process != nil {
		if agent == "pi" {
			state, err := process.request(ctx, "get_state", object{}, 5*time.Second)
			if err != nil {
				return nil, err
			}
			models, err := process.request(ctx, "get_available_models", object{}, 5*time.Second)
			if err != nil {
				return nil, err
			}
			options, err := process.request(ctx, "get_available_thinking_levels", object{}, 5*time.Second)
			if err != nil {
				options = object{"unavailable": err.Error()}
			}
			levels = options
			if state == nil {
				state = object{}
			}
			state["availableModels"] = models["models"]
			metadata, observed, source = state, now(), "pi-rpc"
		} else {
			state := process.snapshot()
			metadata, observed, source = state["metadata"], state["configurationObservedAt"], "live-session-snapshot"
		}
	}
	facts := nativeAgentCatalogFacts(task, metadata, observed, source, levels)
	return facts, rememberNativeAgentCatalog(agent, facts)
}

func nativeAgentCatalogFacts(task object, metadata, observed any, source string, levels any) object {
	agent := text(task, "agent")
	if agent == "antigravity" {
		return nativeAntigravityFacts(task, source)
	}
	var timeline taskTimeline
	_ = unmarshalJSON([]byte(wire(task["tracking"])), &timeline)
	facts := object{"source": source, "taskId": task["taskId"], "observedAt": observed, "scope": "session",
		"authoritative": false, "executionEvidence": timeline.executionEvidence()}
	if agent == "pi" {
		model := field(metadata, "model")
		if provider, id := text(model, "provider"), text(model, "id"); provider != "" && id != "" {
			facts["currentModel"] = provider + "/" + id
		} else {
			facts["currentModel"] = nil
		}
		if rows, ok := field(metadata, "availableModels").([]any); ok {
			models := []any{}
			for _, row := range rows {
				models = append(models, nativePiModel(row, text(row, "provider")))
			}
			facts["authoritative"], facts["models"] = source == "pi-rpc", models
		} else {
			facts["models"] = object{"unavailable": "requires-live-pi-session"}
		}
		values := field(levels, "levels")
		if values == nil {
			values = levels
			if obj(values) == nil {
				values = object{"unavailable": "requires-live-pi-session"}
			}
		}
		facts["options"] = []any{object{"id": "thinkingLevel", "currentValue": field(metadata, "thinkingLevel"), "values": values}}
		return facts
	}
	if agent == "cursor" {
		facts["modelSelectionUnavailable"] = "native-setter-persists-user-defaults"
		facts["modelSelectionNote"] = "The current model and model parameters may be explicitly asserted; switching is unavailable"
	}
	models, options := []any{}, []any{}
	reported := field(metadata, "models")
	if configs, ok := field(metadata, "configOptions").([]any); ok {
		for _, config := range configs {
			id := field(config, "id")
			if facts["modelConfigId"] == nil && (id == "model" || field(config, "category") == "model") {
				facts["modelConfigId"], facts["currentModel"] = id, field(config, "currentValue")
				reportedOptions, known := field(config, "options").([]any)
				for _, option := range reportedOptions {
					if group, ok := field(option, "options").([]any); ok {
						if len(group) == 0 {
							known = false
						}
						for _, value := range group {
							models = append(models, nativeACPModel(value, "value", option, agent))
						}
					} else {
						models = append(models, nativeACPModel(option, "value", nil, agent))
					}
				}
				facts["authoritative"] = source == "live-session-snapshot" && known
			} else {
				options = append(options, object{"id": id, "category": field(config, "category"), "type": field(config, "type"),
					"currentValue": field(config, "currentValue"), "values": nativeAgentOptionValues(field(config, "options"))})
			}
		}
	} else {
		facts["currentModel"] = field(reported, "currentModelId")
		if available, ok := field(reported, "availableModels").([]any); ok {
			for _, row := range available {
				models = append(models, nativeACPModel(row, "modelId", nil, agent))
			}
			facts["authoritative"] = source == "live-session-snapshot"
		}
		if modes := obj(field(metadata, "modes")); modes != nil {
			values := []any{}
			for _, mode := range arr(modes["availableModes"]) {
				values = append(values, object{"value": field(mode, "id"), "name": field(mode, "name")})
			}
			options = append(options, object{"id": "mode", "type": "select", "currentValue": modes["currentModeId"], "values": values})
		}
	}
	for _, item := range models {
		row := obj(item)
		if native := find(field(reported, "availableModels"), "modelId", text(row, "model")); native != nil {
			extra := object{}
			nativeAgentModelMetadata(extra, native)
			for key, value := range extra {
				if row[key] == nil {
					row[key] = value
				}
			}
		}
	}
	facts["models"], facts["options"] = models, options
	if len(models) == 0 && facts["authoritative"] != true {
		facts["models"] = object{"unavailable": "not-reported-by-session"}
	}
	return facts
}

func nativeAgentOptionValues(options any) []any {
	values := []any{}
	for _, option := range arr(options) {
		if group, ok := field(option, "options").([]any); ok {
			for _, value := range group {
				values = append(values, object{"value": field(value, "value"), "name": field(value, "name"), "group": field(option, "group")})
			}
		} else {
			values = append(values, object{"value": field(option, "value"), "name": field(option, "name")})
		}
	}
	return values
}

func nativeAgentCurrentConfiguration(facts object) object {
	options := object{}
	for _, entry := range arr(facts["options"]) {
		if id, ok := field(entry, "id").(string); ok {
			options[id] = field(entry, "currentValue")
		}
	}
	return object{"model": facts["currentModel"], "options": options, "scope": "session", "source": facts["source"], "observedAt": facts["observedAt"]}
}

func nativeAgentOptionAllowed(option object, value any) bool {
	for _, candidate := range arr(option["values"]) {
		if wire(candidate) == wire(value) || wire(field(candidate, "value")) == wire(value) {
			return true
		}
	}
	return false
}

func configureNativeAgentDispatch(ctx context.Context, process *nativeAgentProcess, task, args object) (object, error) {
	agent := text(task, "agent")
	policy, err := dispatchAgentPolicy(agent)
	if err != nil {
		return nil, err
	}
	refresh := func() (object, error) {
		return nativeAgentSessionFacts(ctx, process.snapshot(), process)
	}
	facts, err := refresh()
	if err != nil {
		return nil, err
	}
	model, options := "", object{}
	sources := object{"model": "native-default", "options": object{}}
	optionSources := obj(sources["options"])
	packed := field(args["pack"], "defaults")
	for _, choice := range []struct {
		model   any
		options object
		source  string
	}{
		{policy["model"], obj(policy["options"]), "policy-default"},
		{field(packed, "model"), obj(field(packed, "options")), "pack-default"},
		{args["model"], obj(args["options"]), "explicit"},
	} {
		if value := str(choice.model); value != "" {
			model, sources["model"] = value, choice.source
		}
		for key, value := range choice.options {
			options[key], optionSources[key] = value, choice.source
		}
	}
	if model != "" {
		if agent == "cursor" && facts["currentModel"] != model {
			return nil, errors.New("UNSUPPORTED_DISPATCH_MODEL: Cursor's native setter persists user defaults; session-only model selection is not integrated")
		}
		if find(facts["models"], "model", model) == nil {
			return nil, fmt.Errorf("UNSUPPORTED_DISPATCH_MODEL: %s", model)
		}
		if err := checkDispatchChoice(model, policy["allowModels"], policy["denyModels"], "model"); err != nil {
			return nil, err
		}
		if agent != "cursor" {
			if err := process.setDispatchOption(ctx, facts, "model", model); err != nil {
				return nil, err
			}
		}
		facts, err = refresh()
		if err != nil {
			return nil, err
		}
		if facts["currentModel"] != model {
			return nil, errors.New("DISPATCH_CONFIGURATION_UNCONFIRMED: model")
		}
	}
	proposed := obj(nativeAgentCurrentConfiguration(facts)["options"])
	for _, key := range keys(options) {
		value := options[key]
		option := find(facts["options"], "id", key)
		if option == nil {
			return nil, fmt.Errorf("UNSUPPORTED_DISPATCH_OPTION: %s", key)
		}
		if !nativeAgentOptionAllowed(option, value) {
			return nil, fmt.Errorf("UNSUPPORTED_DISPATCH_OPTION: %s=%s", key, wire(value))
		}
		if agent == "cursor" && key != "mode" && wire(option["currentValue"]) != wire(value) {
			return nil, fmt.Errorf("UNSUPPORTED_DISPATCH_OPTION: Cursor's native %s setter persists user defaults; session-only model parameter selection is not integrated", key)
		}
		proposed[key] = value
	}
	if err := checkDispatchAgentPolicy(policy, proposed, facts["currentModel"]); err != nil {
		return nil, err
	}
	for _, key := range keys(options) {
		value := options[key]
		if !nativeAgentOptionAllowed(find(facts["options"], "id", key), value) {
			return nil, fmt.Errorf("UNSUPPORTED_DISPATCH_OPTION: %s=%s", key, wire(value))
		}
		if agent == "cursor" && key != "mode" {
			continue
		}
		name, ok := value.(string)
		if !ok {
			return nil, errors.New("INVALID_DISPATCH_OPTION")
		}
		if err := process.setDispatchOption(ctx, facts, key, name); err != nil {
			return nil, err
		}
		facts, err = refresh()
		if err != nil {
			return nil, err
		}
	}
	confirmed := nativeAgentCurrentConfiguration(facts)
	current := obj(confirmed["options"])
	if model != "" && confirmed["model"] != model {
		return nil, errors.New("DISPATCH_CONFIGURATION_UNCONFIRMED: native values differ from requested choices")
	}
	for key, value := range options {
		if wire(current[key]) != wire(value) {
			return nil, errors.New("DISPATCH_CONFIGURATION_UNCONFIRMED: native values differ from requested choices")
		}
	}
	if err := checkDispatchAgentPolicy(policy, current, confirmed["model"]); err != nil {
		return nil, err
	}
	for key := range current {
		if optionSources[key] == nil {
			optionSources[key] = "native-default"
		}
	}
	selection := maps.Clone(confirmed)
	selection["source"], selection["reason"] = sources, args["reason"]
	selection["submittedConfiguration"] = object{"model": dispatchFirstString(model), "options": options}
	selection["sessionConfirmation"], selection["turnEvidence"], selection["submission"], selection["submittedAt"] = confirmed, nil, "pending", now()
	if pack := dispatchPackRecord(args); pack != nil {
		selection["pack"] = pack
	}
	return selection, nil
}

func (p *nativeAgentProcess) setDispatchOption(ctx context.Context, facts object, key, value string) error {
	if p.driver.id == "pi" {
		if key == "model" {
			provider, model, ok := strings.Cut(value, "/")
			if !ok {
				return errors.New("INVALID_PI_MODEL")
			}
			_, err := p.request(ctx, "set_model", object{"provider": provider, "modelId": model}, 15*time.Second)
			return err
		}
		_, err := p.request(ctx, "set_thinking_level", object{"level": value}, 15*time.Second)
		return err
	}
	task := p.snapshot()
	args := object{"sessionId": task["sessionId"]}
	config := text(facts, "modelConfigId")
	if key != "model" {
		config = ""
		if _, ok := field(task["metadata"], "configOptions").([]any); ok {
			config = key
		}
	}
	if config != "" {
		args["configId"], args["value"] = config, value
		reply, err := p.request(ctx, "session/set_config_option", args, 15*time.Second)
		if err != nil {
			return err
		}
		if _, ok := reply["configOptions"].([]any); !ok {
			return errors.New("DISPATCH_CONFIGURATION_UNCONFIRMED: missing configOptions")
		}
		return p.checkpoint(func(task object) {
			dispatchSetSection(task, "metadata")["configOptions"] = reply["configOptions"]
			rememberAgentProcessConfiguration(task)
		})
	}
	method, argument, section, current := "session/set_model", "modelId", "models", "currentModelId"
	switch key {
	case "model":
	case "mode":
		method, argument, section, current = "session/set_mode", "modeId", "modes", "currentModeId"
	default:
		return fmt.Errorf("UNSUPPORTED_DISPATCH_OPTION: %s", key)
	}
	args[argument] = value
	if _, err := p.request(ctx, method, args, 15*time.Second); err != nil {
		return err
	}
	return p.checkpoint(func(task object) {
		dispatchSetSection(dispatchSetSection(task, "metadata"), section)[current] = value
		rememberAgentProcessConfiguration(task)
	})
}
