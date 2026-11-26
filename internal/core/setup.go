package core

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

var setupApplyMu, setupDispatchMu sync.Mutex

var setupIngressProviders func() object
var setupCloudflareStatus func(context.Context) object
var setupCloudflareLogin func(context.Context, object) error
var setupCloudflareProvision func(context.Context, object) (object, error)
var setupCloudflareStop func()
var setupOpenClaudeLogin func(context.Context, *service) error
var setupTaskRecords func(context.Context, *service) ([]any, error)
var setupObserveCodex func(context.Context, *service, object) (any, error)
var setupReadNotification func(string, string) (any, error)
var setupCreateCodex func(context.Context, *service, object) (any, error)
var setupCodexNavigation func(string) any

func setupStatePath() string { return filepath.Join(root(), "setup.json") }

func setupState() (object, error) {
	value, err := load(setupStatePath())
	if errors.Is(err, os.ErrNotExist) {
		return object{"choices": object{}}, nil
	}
	if err != nil {
		return nil, err
	}
	if obj(value) == nil {
		return nil, errors.New("Invalid setup state")
	}
	return obj(value), nil
}

func validateSetupGoal(goal string) error {
	if goal == "claude-loop" || goal == "chatgpt-chat" {
		return nil
	}
	return errors.New("INVALID_ARGUMENT: goal must be claude-loop or chatgpt-chat")
}

func chooseSetupGoal(state *object, goal string) error {
	if err := validateSetupGoal(goal); err != nil {
		return err
	}
	if (*state)["goal"] != goal {
		*state = object{"goal": goal, "startedAt": now(), "choices": object{}}
	}
	return nil
}

func setupUsesHTTPS(state object) bool {
	return state["goal"] == "claude-loop" || field(state["choices"], "chatgpt-fallback") == "https-oauth"
}

func setupProviderDescriptor(provider string) object {
	if setupIngressProviders != nil {
		return obj(setupIngressProviders()[provider])
	}
	return nil
}

func setupSelectedIngress(state object, ingresses any) object {
	claude := state["goal"] == "claude-loop"
	https := setupUsesHTTPS(state)
	product := "chatgpt"
	if claude {
		product = "claude"
	}
	preferred := "setup-" + text(state, "goal")
	var first object
	for _, raw := range arr(ingresses) {
		i := obj(raw)
		if i["controlSource"] != product {
			continue
		}
		if https {
			if i["transport"] != "https" || i["auth"] != "oauth" {
				continue
			}
			config := obj(i["config"])
			if field(state["choices"], "choose-address") == "fixed" {
				if mode, ok := setupProviderDescriptor(text(config, "httpsProvider"))["mode"].(string); ok && config[mode] != "named" {
					continue
				}
				if field(state["choices"], "choose-provider") == "cloudflare" && (config["httpsProvider"] != "cloudflare" || config["cloudflareAuth"] != "login") {
					continue
				}
			} else if config["httpsProvider"] != "cloudflare" || config["cloudflareMode"] != "quick" {
				continue
			}
		} else if i["transport"] != "openai-tunnel" {
			continue
		}
		if i["id"] == preferred {
			return i
		}
		if first == nil {
			first = i
		}
	}
	return first
}

func setupAfter(value, start any) bool {
	when, whenOK := value.(string)
	from, fromOK := start.(string)
	return whenOK && fromOK && when > from
}

func setupGranted(items any, id string) bool {
	item := find(items, "id", id)
	return item["state"] == "granted" || item["state"] == "not-applicable"
}

func setupCredential(ingress object) (string, string) {
	switch text(ingress["config"], "httpsProvider") {
	case "ngrok":
		return "ngrokAuthtoken", "hasNgrokAuthtoken"
	case "pinggy":
		return "pinggyToken", "hasPinggyToken"
	case "localxpose":
		return "localxposeAccessToken", "hasLocalxposeAccessToken"
	default:
		return "cloudflareToken", "hasCloudflareToken"
	}
}
func setupEditURL(ingress object, field string) string {
	return "agent-remote-control://ingress?id=" + text(ingress, "id") + "&field=" + field
}

func setupStep(language, id, kind string, openURL any, options ...string) object {
	label := func(suffix string) string { return localized(language, "setup."+id+"."+suffix) }
	explain := label("explain")
	choices := []any{}
	if id == "choose-goal" {
		lines := []string{}
		for _, option := range options {
			lines = append(lines, localized(language, "setup.option."+option+".explain"))
		}
		explain = strings.Join(lines, "\n")
	}
	for i, option := range options {
		choices = append(choices, object{"id": option, "label": localized(language, "setup.option."+option), "recommended": i == 0 && option != "skip"})
	}
	var apply any
	if kind == "auto" || kind == "decide" || kind == "secret" || len(choices) > 0 || id == "codex-ready" || id == "cloudflare-login" {
		apply = "setup apply " + id + " --stdin"
	}
	return object{"id": id, "kind": kind, "title": label("title"), "explain": explain, "options": choices,
		"apply": apply, "openUrl": openURL, "doneWhen": label("done"), "playbook": id}
}

func deriveSetup(state, data object, language string) object {
	goal := text(state, "goal")
	step := func(id, kind string, openURL any, options ...string) object {
		return setupStep(language, id, kind, openURL, options...)
	}
	if goal == "" {
		return object{"schemaVersion": 1, "goal": nil, "progress": object{"done": 0, "total": 1}, "complete": false,
			"steps": []any{}, "step": step("choose-goal", "decide", nil, "claude-loop", "chatgpt-chat")}
	}
	claude, https := goal == "claude-loop", setupUsesHTTPS(state)
	choices := obj(state["choices"])
	i := setupSelectedIngress(state, data["ingresses"])
	config, verification := obj(i["config"]), obj(i["verification"])
	permissions := field(data["permissions"], "items")
	skipped := choices["claude-code-ready"] == "skip"
	type setupProgress struct {
		done bool
		step object
	}
	steps := []setupProgress{}
	add := func(done bool, step object) { steps = append(steps, setupProgress{done, step}) }
	add(field(data["login"], "state") == "authenticated", step("codex-ready", "authorize", "agent-remote-control://setup?target=codex-login"))
	if claude {
		installed := field(find(permissions, "id", "claude-code"), "installed") == true
		kind, url := "auto", "https://code.claude.com/docs/en/setup"
		if installed {
			kind, url = "authorize", "agent-remote-control://setup?target=claude-login"
		}
		ready := step("claude-code-ready", kind, url, "skip")
		if installed {
			ready["explain"] = localized(language, "setup.claude-code-ready.login")
		} else if operatingSystem == "windows" {
			ready["installCommand"] = "irm https://claude.ai/install.ps1 | iex"
		} else {
			ready["installCommand"] = "curl -fsSL https://claude.ai/install.sh | bash"
		}
		add(setupGranted(permissions, "claude-code") || skipped, ready)
	}
	add(choices["permissions"] == "skip" || setupGranted(permissions, "full-disk-access") && setupGranted(permissions, "command-full-disk-access"),
		step("permissions", "authorize", "agent-remote-control://permissions", "skip"))
	if !claude {
		if reason, ok := choices["chatgpt-blocked"].(string); ok {
			fallback := step("chatgpt-fallback", "decide", nil, "https-oauth", "retry")
			fallback["explain"] = localized(language, "setup.blocked."+reason) + " " + text(fallback, "explain")
			add(false, fallback)
		}
	}
	controlPlane := text(i["controlPlane"], "state")
	if https {
		_, chosen := choices["choose-address"].(string)
		add(chosen, step("choose-address", "decide", nil, "cf-quick", "fixed"))
		if choices["choose-address"] == "fixed" {
			_, chosen := choices["choose-provider"].(string)
			add(chosen, step("choose-provider", "decide", nil, "cloudflare", "other-provider"))
			switch choices["choose-provider"] {
			case "cloudflare":
				url, ok := field(data["cloudflare"], "openUrl").(string)
				if !ok {
					url = "agent-remote-control://setup?target=cloudflare-login"
				}
				add(field(data["cloudflare"], "hasOriginCert") == true, step("cloudflare-login", "authorize", url))
				add(config["configured"] == true && config["cloudflareAuth"] == "login", step("cloudflare-tunnel", "auto", nil))
			case "other-provider":
				key, flag := setupCredential(i)
				secret := step("address-secret", "secret", setupEditURL(i, key))
				secret["credentialUrl"] = setupProviderDescriptor(text(config, "httpsProvider"))["help"]
				add(config[flag] == true || config["httpsProvider"] == "custom" && config["configured"] == true, secret)
			}
		}
	} else {
		hasID := text(config, "tunnelId") != ""
		kind, open := "remote-ui", "https://platform.openai.com/settings/organization/tunnels"
		if hasID {
			kind, open = "secret", setupEditURL(i, "apiKey")
		}
		credentials := step("tunnel-credentials", kind, open)
		credentials["credentialUrl"] = "https://platform.openai.com/settings/organization/api-keys"
		credentials["secretUrl"] = setupEditURL(i, "apiKey")
		credentials["apply"] = "setup apply tunnel-credentials --stdin"
		if controlPlane == "rejected" {
			credentials["explain"] = localized(language, "setup.runtime-key-rejected")
		}
		add(hasID && config["hasApiKey"] == true && controlPlane != "rejected", credentials)
	}
	probe := obj(verification["lastProbe"])
	running := i["running"] == true
	ready := running && i["state"] == "ready"
	if https {
		ready = ready && probe["passed"] == true && probe["url"] == i["url"]
	} else {
		ready = ready && controlPlane == "authenticated"
	}
	create := step("create-ingress", "auto", nil)
	if !https && running && controlPlane != "authenticated" && controlPlane != "rejected" {
		create["explain"] = localized(language, "setup.health-unobserved")
	}
	add(ready, create)
	client := "https://chatgpt.com/"
	if claude {
		client = "https://claude.ai/"
	}
	if https {
		oauth := obj(data["oauth"])
		pending := find(oauth["pending"], "status", "pending")
		grants := len(arr(oauth["grants"])) != 0
		_, firstRequest := verification["firstOAuthRequestAt"].(string)
		add(firstRequest || pending != nil || grants, step("add-connector", "remote-ui", client))
		consent := setupEditURL(i, "oauth")
		if pending != nil {
			consent = "agent-remote-control://oauth?request=" + text(pending, "id")
		}
		add(grants, step("consent", "authorize", consent))
	} else {
		_, verified := verification["firstMcpRequestAt"].(string)
		add(verified, step("enable-in-chatgpt", "remote-ui", "https://chatgpt.com/plugins"))
	}
	verifyURL := client
	if claude {
		verifyURL = "https://claude.ai/new"
	}
	add(setupAfter(verification["challengeVerifiedAt"], state["startedAt"]), step("verify-connector", "remote-ui", verifyURL))
	add(field(data["loop"], "complete") == true, step("loop-test", "remote-ui", client))

	var current any
	var done int
	summary := []any{}
	for _, item := range steps {
		step := item.step
		stepID := step["id"]
		if config["cloudflareAuth"] == "login" && text(config, "httpsUrl") != "" && (stepID == "create-ingress" || stepID == "cloudflare-tunnel") {
			step["explain"] = text(step, "explain") + " " + strings.ReplaceAll(localized(language, "setup.fixed-address"), "{url}", text(config, "httpsUrl"))
		}
		if item.done {
			done++
		} else if current == nil {
			current = step
		}
		summary = append(summary, object{"id": stepID, "title": step["title"], "kind": step["kind"], "done": item.done})
	}
	var onboarding any
	if i != nil {
		onboarding = cliOnboarding(i)
	}
	findings := append([]any{}, arr(field(i["diagnostics"], "findings"))...)
	if reason, ok := choices["chatgpt-blocked"].(string); ok {
		findings = append(findings, object{"code": "CHATGPT_ACCESS_BLOCKED", "severity": "error", "summary": localized(language, "setup.blocked."+reason)})
	}
	for _, warning := range []struct {
		active bool
		key    string
	}{{claude && skipped, "notification-skipped"}, {field(data["loop"], "notificationFailed") == true, "notification-failed"}} {
		if warning.active {
			findings = append(findings, object{"code": warning.key, "severity": "warning", "summary": localized(language, "setup."+warning.key)})
		}
	}
	if message, ok := obj(data["loop"])["error"]; ok {
		findings = append(findings, object{"code": "LOOP_READ_FAILED", "severity": "warning", "summary": message})
	}
	result := object{"schemaVersion": 1, "goal": goal, "progress": object{"done": done, "total": len(steps)}, "complete": current == nil,
		"step": current, "steps": summary, "ingressId": i["id"], "onboarding": onboarding, "findings": findings}
	if !claude && !https {
		result["fallback"] = step("chatgpt-fallback", "decide", nil, "https-oauth", "retry")
	}
	return result
}

func setupLoopEvidence(observed, notification any, needsNotification bool) object {
	result := object{"complete": false}
	if field(observed, "state") != "completed" {
		return result
	}
	if !needsNotification {
		result["complete"] = strings.TrimSpace(text(field(observed, "finalResponse"), "text")) == "ARC_ONBOARDING_OK"
		return result
	}
	for _, delivery := range arr(field(notification, "deliveries")) {
		if field(delivery, "kind") != "completed" {
			continue
		}
		switch field(delivery, "state") {
		case "delivered":
			result["complete"] = true
		case "failed":
			result["notificationFailed"] = true
		}
	}
	return result
}

func setupLoopStatus(ctx context.Context, s *service, state, ingress object) (object, error) {
	if setupTaskRecords == nil || setupObserveCodex == nil {
		return nil, errors.New(PortPending)
	}
	records, err := setupTaskRecords(ctx, s)
	if err != nil {
		return nil, err
	}
	result := object{"complete": false}
	needsNotification := state["goal"] == "claude-loop" && field(state["choices"], "claude-code-ready") != "skip"
	for _, record := range records {
		if field(field(record, "origin"), "ingressId") != ingress["id"] || !setupAfter(field(record, "createdAt"), state["startedAt"]) {
			continue
		}
		thread, turn := text(record, "threadId"), text(record, "turnId")
		if thread == "" || turn == "" {
			continue
		}
		observed, err := setupObserveCodex(ctx, s, object{"threadId": thread, "turnId": turn})
		if err != nil {
			result["error"] = err.Error()
			continue
		}
		var notification any
		if needsNotification {
			if setupReadNotification == nil {
				return nil, errors.New(PortPending)
			}
			notification, err = setupReadNotification(thread, turn)
			if err != nil {
				return nil, err
			}
		}
		evidence := setupLoopEvidence(observed, notification, needsNotification)
		if evidence["complete"] == true {
			return evidence, nil
		}
		if evidence["notificationFailed"] == true || needsNotification && field(observed, "state") == "completed" && field(record, "notification") == "bind-failed" {
			result["notificationFailed"] = true
		}
	}
	return result, nil
}

func setupPresentation(result, state object) (object, error) {
	_, err := os.Stat(setupStatePath())
	result["hasState"] = err == nil
	cli, err := runtimeBinary()
	if err != nil {
		return nil, err
	}
	result["cliPath"], result["stateDir"], result["dispatch"] = cli, root(), state["dispatch"]
	for _, key := range []string{"step", "fallback"} {
		step := obj(result[key])
		if apply, ok := step["apply"].(string); ok {
			step["apply"] = cliCommandLine(strings.Fields(apply), nil)
		}
	}
	if result["complete"] != true {
		step := obj(result["step"])
		args := []string{"setup", "playbook", text(step, "playbook")}
		var input object
		if step["kind"] == "auto" && step["installCommand"] == nil {
			args, input = []string{"setup", "apply", text(step, "id"), "--stdin"}, object{}
		}
		result["nextAction"] = object{"command": cliCommandLine(args, input)}
		for _, finding := range arr(result["findings"]) {
			if _, ok := field(field(finding, "nextAction"), "command").(string); field(finding, "severity") == "error" && ok {
				result["nextAction"] = field(finding, "nextAction")
				break
			}
		}
	}
	return result, nil
}

func nextSetup(ctx context.Context, s *service, goal, language any) (object, error) {
	state, err := setupState()
	if err != nil {
		return nil, err
	}
	if preview, ok := goal.(string); ok {
		if err := chooseSetupGoal(&state, preview); err != nil {
			return nil, err
		}
	}
	lang, ok := language.(string)
	if !ok {
		lang = locale()
	}
	data := object{}
	if state["goal"] == nil {
		return setupPresentation(deriveSetup(state, data, lang), state)
	}
	login, err := s.management(ctx, "codex/login", "GET", object{})
	if err != nil {
		login = object{"state": "unavailable", "error": err.Error()}
	}
	data["login"] = login
	data["permissions"], err = s.management(ctx, "permissions", "GET", object{})
	if err != nil {
		return nil, err
	}
	data["ingresses"], err = s.management(ctx, "ingress", "GET", object{})
	if err != nil {
		return nil, err
	}
	if field(state["choices"], "choose-provider") == "cloudflare" && setupCloudflareStatus != nil {
		data["cloudflare"] = setupCloudflareStatus(ctx)
	}
	if i := setupSelectedIngress(state, data["ingresses"]); i != nil {
		if i["auth"] == "oauth" && text(i, "url") != "" {
			data["oauth"], err = s.management(ctx, "ingress/"+text(i, "id")+"/oauth", "GET", object{})
			if err != nil {
				return nil, err
			}
		}
		if setupAfter(field(i["verification"], "challengeVerifiedAt"), state["startedAt"]) {
			data["loop"], err = setupLoopStatus(ctx, s, state, i)
			if err != nil {
				data["loop"] = object{"error": err.Error()}
			}
		}
	}
	return setupPresentation(deriveSetup(state, data, lang), state)
}

func ensureSetupIngress(ctx context.Context, s *service, state, config object) (object, error) {
	rows, err := s.management(ctx, "ingress", "GET", object{})
	if err != nil {
		return nil, err
	}
	if current := setupSelectedIngress(state, rows); current != nil {
		return current, nil
	}
	id := "setup-" + text(state, "goal")
	product, transport, auth := "chatgpt", "openai-tunnel", "openai"
	if state["goal"] == "claude-loop" {
		product = "claude"
	}
	config = clone(config)
	if config == nil {
		config = object{}
	}
	if setupUsesHTTPS(state) {
		transport, auth = "https", "oauth"
		if _, ok := config["httpsProvider"]; !ok {
			config["httpsProvider"] = "cloudflare"
		}
		if mode, ok := setupProviderDescriptor(text(config, "httpsProvider"))["mode"].(string); ok {
			value := "quick"
			if field(state["choices"], "choose-address") == "fixed" {
				value = "named"
			}
			config[mode] = value
		}
	}
	entry := object{"id": id, "controlSource": product, "transport": transport, "auth": auth, "config": config}
	if err := validateCLIIngress(entry, false); err != nil {
		return nil, err
	}
	var response any
	if find(rows, "id", id) != nil {
		delete(entry, "id")
		response, err = s.management(ctx, "ingress/"+id, "PUT", entry)
	} else {
		response, err = s.management(ctx, "ingress", "POST", entry)
	}
	return obj(response), err
}

func applySetup(ctx context.Context, s *service, body object) (object, error) {
	setupApplyMu.Lock()
	defer setupApplyMu.Unlock()
	state, err := setupState()
	if err != nil {
		return nil, err
	}
	step, input := text(body, "stepId"), obj(body["input"])
	option := text(input, "option")
	if step == "choose-goal" {
		if err := chooseSetupGoal(&state, option); err != nil {
			return nil, err
		}
		if err := save(setupStatePath(), state); err != nil {
			return nil, err
		}
		return nextSetup(ctx, s, nil, body["locale"])
	}
	if err := validateSetupGoal(text(state, "goal")); err != nil {
		return nil, err
	}
	choices := obj(state["choices"])
	if choices == nil {
		choices = object{}
		state["choices"] = choices
	}
	persist := false
	ensure := func(config object) (object, error) { return ensureSetupIngress(ctx, s, state, config) }
	patch := func(ingress object, body object) error {
		_, err := s.management(ctx, "ingress/"+text(ingress, "id"), "PUT", body)
		return err
	}
	switch {
	case step == "codex-ready":
		login, err := s.management(ctx, "codex/login", "GET", object{})
		if err != nil || field(login, "state") != "authenticated" {
			if _, err := s.management(ctx, "codex/login", "POST", object{}); err != nil {
				return nil, err
			}
		}
	case (step == "claude-code-ready" || step == "permissions") && option == "skip":
		choices[step], persist = "skip", true
	case step == "claude-code-ready":
		ready, err := s.management(ctx, "permissions", "GET", object{})
		if err != nil {
			return nil, err
		}
		if !setupGranted(field(ready, "items"), "claude-code") && findAccountAgent("claude") != "" {
			if setupOpenClaudeLogin == nil {
				return nil, errors.New(PortPending)
			}
			if err := setupOpenClaudeLogin(ctx, s); err != nil {
				return nil, err
			}
		}
	case step == "choose-address":
		if option != "cf-quick" && option != "fixed" {
			return nil, errors.New("INVALID_ARGUMENT: option must be cf-quick or fixed")
		}
		choices[step], persist = option, true
		if _, err := ensure(obj(input["config"])); err != nil {
			return nil, err
		}
	case step == "choose-provider":
		if option != "cloudflare" && option != "other-provider" {
			return nil, errors.New("INVALID_ARGUMENT: option must be cloudflare or other-provider")
		}
		choices[step], persist = option, true
		config := object{"httpsProvider": "cloudflare", "cloudflareMode": "named", "cloudflareAuth": "login"}
		if option == "other-provider" {
			config = clone(obj(input["config"]))
			if config == nil {
				config = object{}
			}
			config["cloudflareAuth"] = "token"
		}
		i, err := ensure(config)
		if err != nil {
			return nil, err
		}
		if err := patch(i, object{"config": config}); err != nil {
			return nil, err
		}
	case step == "cloudflare-login" || step == "cloudflare-tunnel":
		i, err := ensure(object{"cloudflareAuth": "login"})
		if err != nil {
			return nil, err
		}
		if step == "cloudflare-login" {
			if setupCloudflareLogin == nil {
				return nil, errors.New(PortPending)
			}
			if err := setupCloudflareLogin(ctx, obj(i["config"])); err != nil {
				return nil, err
			}
		} else {
			if setupCloudflareProvision == nil {
				return nil, errors.New(PortPending)
			}
			config, err := setupCloudflareProvision(ctx, obj(i["config"]))
			if err != nil {
				return nil, err
			}
			if err := patch(i, object{"config": config}); err != nil {
				return nil, err
			}
		}
	case (step == "address-secret" || step == "tunnel-credentials") && input["source"] == "clipboard":
		i, err := ensure(nil)
		if err != nil {
			return nil, err
		}
		fieldName, flag := setupCredential(i)
		if step == "tunnel-credentials" {
			fieldName, flag = "apiKey", "hasApiKey"
		}
		value, err := readSetupClipboard(ctx)
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(value) == "" && field(i["config"], flag) == true && field(i["controlPlane"], "state") != "rejected" {
			return object{flag: true}, nil
		}
		secret, err := extractSetupSecret(fieldName, value)
		if err != nil {
			return nil, err
		}
		body := object{"config": object{fieldName: secret}}
		if err := validateCLIIngress(body, true); err != nil {
			return nil, err
		}
		if err := patch(i, body); err != nil {
			return nil, err
		}
		if err := clearSetupClipboard(ctx); err != nil {
			return nil, err
		}
		return object{flag: true}, nil
	case step == "chatgpt-fallback":
		if state["goal"] != "chatgpt-chat" {
			return nil, errors.New("ChatGPT goal required")
		}
		switch option {
		case "https-oauth":
			if !setupUsesHTTPS(state) {
				rows, err := s.management(ctx, "ingress", "GET", object{})
				if err != nil {
					return nil, err
				}
				if i := setupSelectedIngress(state, rows); i != nil {
					if _, err := s.management(ctx, "ingress/"+text(i, "id")+"/stop", "POST", object{}); err != nil {
						return nil, err
					}
				}
			}
			choices[step] = option
			delete(choices, "chatgpt-blocked")
			if _, err := ensure(nil); err != nil {
				return nil, err
			}
		case "retry":
			delete(choices, "chatgpt-blocked")
		default:
			reason := text(input, "reason")
			if !slices.Contains([]string{"platform-denied", "chatgpt-denied", "runtime-key-rejected"}, reason) {
				return nil, errors.New("Use option https-oauth/retry, or reason platform-denied/chatgpt-denied/runtime-key-rejected")
			}
			choices["chatgpt-blocked"] = reason
		}
		persist = true
	case step == "tunnel-credentials":
		i, err := ensure(nil)
		if err != nil {
			return nil, err
		}
		change := object{"config": object{"tunnelId": input["tunnelId"]}}
		if err := validateCLIIngress(change, true); err != nil {
			return nil, err
		}
		if field(i["config"], "tunnelId") != input["tunnelId"] {
			if err := patch(i, change); err != nil {
				return nil, err
			}
		}
	case step == "create-ingress":
		i, err := ensure(nil)
		if err != nil {
			return nil, err
		}
		if i["enabled"] != true {
			if err := patch(i, object{"enabled": true}); err != nil {
				return nil, err
			}
		}
		prefix := "ingress/" + text(i, "id")
		if _, err := s.management(ctx, prefix+"/start", "POST", object{}); err != nil {
			return nil, err
		}
		if setupUsesHTTPS(state) {
			if _, err := s.management(ctx, prefix+"/probe", "POST", object{}); err != nil {
				return nil, err
			}
		}
	default:
		return nil, errors.New("INVALID_ARGUMENT: this step has no apply action")
	}
	if persist {
		if err := save(setupStatePath(), state); err != nil {
			return nil, err
		}
	}
	return nextSetup(ctx, s, nil, body["locale"])
}

func dispatchSetup(ctx context.Context, s *service, body object) (object, error) {
	setupDispatchMu.Lock()
	defer setupDispatchMu.Unlock()
	goal := text(body, "goal")
	if err := validateSetupGoal(goal); err != nil {
		return nil, err
	}
	if _, err := applySetup(ctx, s, object{"stepId": "choose-goal", "input": object{"option": goal}}); err != nil {
		return nil, err
	}
	if _, err := installSkills("codex"); err != nil {
		return nil, err
	}
	workspace := filepath.Join(root(), "setup-workspace")
	if err := os.MkdirAll(workspace, 0o777); err != nil {
		return nil, err
	}
	initial, err := setupState()
	if err != nil {
		return nil, err
	}
	dispatch := obj(initial["dispatch"])
	if _, ok := dispatch["threadId"].(string); ok {
		return dispatch, nil
	}
	var receipt any
	if request, ok := dispatch["requestId"].(string); ok {
		receipt, err = readControlReceipt(ctx, operationRequest{service: s, args: object{"requestId": request}})
	} else {
		if setupCreateCodex == nil {
			return nil, errors.New(PortPending)
		}
		request := id()
		err = func() error {
			setupApplyMu.Lock()
			defer setupApplyMu.Unlock()
			state, err := setupState()
			if err != nil {
				return err
			}
			state["dispatch"] = object{"requestId": request}
			return save(setupStatePath(), state)
		}()
		if err != nil {
			return nil, err
		}
		cli, err := runtimeBinary()
		if err != nil {
			return nil, err
		}
		lang := locale()
		prompt := strings.NewReplacer("{locale}", lang, "{goal}", goal, "{cli}", cli, "{stateDir}", root()).Replace(text(resource("model-prompts.json"), "setup"))
		receipt, err = setupCreateCodex(ctx, s, object{"requestId": request, "approval": "approved", "waitMs": 60000,
			"thread": object{"cwd": workspace}, "title": localized(lang, "setup.taskTitle"), "prompt": prompt})
	}
	if err != nil {
		return nil, err
	}
	thread, ok := field(field(receipt, "result"), "threadId").(string)
	if !ok {
		return nil, fmt.Errorf("setup dispatch: %s (%s) %s", text(receipt, "state"), text(receipt, "requestId"), wire(field(field(receipt, "result"), "error")))
	}
	var open any
	if setupCodexNavigation != nil {
		open = setupCodexNavigation(thread)
	}
	result := object{"requestId": field(receipt, "requestId"), "threadId": thread, "open": open}
	setupApplyMu.Lock()
	defer setupApplyMu.Unlock()
	state, err := setupState()
	if err != nil {
		return nil, err
	}
	if state["goal"] == initial["goal"] && state["startedAt"] == initial["startedAt"] {
		state["dispatch"] = result
		if err := save(setupStatePath(), state); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func waitSetup(ctx context.Context, s *service, body object) (object, error) {
	current, err := nextSetup(ctx, s, nil, body["locale"])
	if err != nil {
		return nil, err
	}
	step := field(current["step"], "id")
	seconds := uintOr(body["timeout"], 60)
	wait, cancel := context.WithTimeout(ctx, time.Duration(min(seconds, uint64((1<<63-1)/time.Second)))*time.Second)
	defer cancel()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for current["complete"] != true && field(current["step"], "id") == step {
		select {
		case <-wait.Done():
			return current, nil
		case <-tick.C:
			progress, err := nextSetup(wait, s, nil, body["locale"])
			if wait.Err() != nil {
				return current, nil
			}
			if err != nil {
				return nil, err
			}
			current = progress
		}
	}
	return current, nil
}

func normalizeSetupLocale(args []string) ([]string, string, error) {
	if len(args) == 0 || args[0] != "setup" {
		return args, "", nil
	}
	index := slices.Index(args, "--locale")
	if index < 0 {
		return args, "", nil
	}
	if index+1 == len(args) {
		return nil, "", errors.New("INVALID_ARGUMENT: --locale requires zh-CN or en")
	}
	lang := args[index+1]
	if lang != "en" && lang != "zh-CN" {
		return nil, "", errors.New("INVALID_ARGUMENT: --locale must be zh-CN or en")
	}
	normalized := slices.Delete(slices.Clone(args), index, index+2)
	if slices.Contains(normalized, "--locale") || len(normalized) > 1 && (normalized[1] == "reset" || normalized[1] == "playbook") {
		return nil, "", errors.New("INVALID_ARGUMENT: --locale is supported once on setup next/apply/wait")
	}
	return normalized, lang, nil
}

func init() {
	registerRoute("POST", "setup/next", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		return nextSetup(ctx, s, body["goal"], body["locale"])
	})
	registerRoute("POST", "setup/apply", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		return applySetup(ctx, s, body)
	})
	registerRoute("POST", "setup/wait", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		return waitSetup(ctx, s, body)
	})
	registerRoute("POST", "setup/dispatch", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		return dispatchSetup(ctx, s, body)
	})
	registerRoute("DELETE", "setup/reset", func(ctx context.Context, s *service, _ object, _ []string) (any, error) {
		setupApplyMu.Lock()
		defer setupApplyMu.Unlock()
		if setupCloudflareStop != nil {
			setupCloudflareStop()
		}
		if err := os.Remove(setupStatePath()); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		return nextSetup(ctx, s, nil, nil)
	})
}
