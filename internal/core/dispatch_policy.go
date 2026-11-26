package core

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

type dispatchPack struct {
	Summary     string            `json:"summary"`
	Agent       *string           `json:"agent,omitempty"`
	Model       *string           `json:"model,omitempty"`
	Effort      *string           `json:"effort,omitempty"`
	ServiceTier *string           `json:"serviceTier,omitempty"`
	Options     map[string]string `json:"options,omitempty"`
	Prompt      string            `json:"prompt"`
	Review      string            `json:"review"`
}

var dispatchPolicyMu sync.Mutex
var dispatchPackName = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)

// Agent discovery belongs to A. Account refresh, the subscription snapshot and
// the optional gateway quota belong to D.
var dispatchRegisteredAgent func(*service, string) bool
var dispatchAgentFacts func(context.Context, *service, object) ([]object, error)
var dispatchAccountsRefresh func(context.Context, *service) error
var dispatchSubscriptionSnapshot func(*service) object
var dispatchGatewayQuota func(context.Context) object

// The tagged fixture runs only the specified read-only provider methods.
var dispatchFixtureRegistered func(*service, string) (bool, bool)
var dispatchFixtureFacts func(context.Context, *service, object) ([]object, error)
var dispatchFixtureRPC func(context.Context, *service, string, any, time.Duration) (any, error)

func policyAgentRegistered(s *service, agent string) (bool, error) {
	if agent == "codex" {
		return true, nil
	}
	if dispatchRegisteredAgent != nil {
		return dispatchRegisteredAgent(s, agent), nil
	}
	if dispatchFixtureRegistered != nil {
		if registered, fixture := dispatchFixtureRegistered(s, agent); fixture {
			return registered, nil
		}
	}
	return false, errors.New(PortPending)
}
func policyAgentFacts(ctx context.Context, s *service, args object) ([]object, error) {
	if dispatchAgentFacts != nil {
		return dispatchAgentFacts(ctx, s, args)
	}
	if dispatchFixtureFacts != nil {
		return dispatchFixtureFacts(ctx, s, args)
	}
	return nil, errors.New(PortPending)
}
func policyNativeRequest(ctx context.Context, s *service, method string, args any, timeout time.Duration) (any, error) {
	if nativeControlRequest != nil {
		return nativeControlRequest(ctx, s, method, args, timeout)
	}
	if dispatchFixtureRPC != nil {
		return dispatchFixtureRPC(ctx, s, method, args, timeout)
	}
	return nil, errors.New(PortPending)
}

func dispatchPolicyPath() string { return filepath.Join(root(), "dispatch-policy.json") }

func saveDispatchPolicy(path string, value any) error {
	data, err := canonjson.Marshal(value)
	if err != nil {
		return err
	}
	var formatted bytes.Buffer
	if err := json.Indent(&formatted, data, "", "  "); err != nil {
		return err
	}
	formatted.WriteByte('\n')
	return saveBytes(path, formatted.Bytes())
}

func dispatchPolicySection(agent string, section object) object {
	out := object{"model": nil, "allowModels": []string{}, "denyModels": []string{}, "criteria": ""}
	if agent == "codex" {
		out["effort"], out["serviceTier"], out["serviceTiers"] = nil, nil, object{}
		out["allowEfforts"], out["denyEfforts"] = []string{}, []string{}
	} else {
		out["options"], out["allowOptions"], out["denyOptions"] = object{}, object{}, object{}
	}
	for key, value := range section {
		out[key] = value
	}
	return out
}

func decodeDispatchPack(value any) (dispatchPack, error) {
	pack := dispatchPack{Options: make(map[string]string)}
	d := json.NewDecoder(strings.NewReader(wire(value)))
	d.DisallowUnknownFields()
	err := d.Decode(&pack)
	return pack, err
}

func validateDispatchPack(name string, p dispatchPack) error {
	var problem string
	switch {
	case !dispatchPackName.MatchString(name):
		problem = "name must match [a-z0-9-]{1,40}"
	case strings.TrimSpace(p.Summary) == "" || utf8.RuneCountInString(p.Summary) > 160:
		problem = "summary is required and limited to 160 characters"
	case utf8.RuneCountInString(p.Prompt) > 4000:
		problem = "prompt is limited to 4,000 characters"
	case utf8.RuneCountInString(p.Review) > 800:
		problem = "review is limited to 800 characters"
	}
	if problem == "" {
		for _, value := range []*string{p.Agent, p.Model, p.Effort, p.ServiceTier} {
			if value != nil && strings.TrimSpace(*value) == "" {
				problem = "agent, model, effort and serviceTier must be nonempty or null"
				break
			}
		}
	}
	if problem != "" {
		return fmt.Errorf("INVALID_DISPATCH_POLICY: pack %s: %s", name, problem)
	}
	return nil
}

func invalidDispatchPolicyType(value any, expected string) error {
	var actual string
	switch value := value.(type) {
	case nil:
		actual = "null"
	case bool:
		actual = fmt.Sprintf("boolean `%t`", value)
	case string:
		actual = "string " + wire(value)
	case []any:
		actual = "sequence"
	case object:
		actual = "map"
	default:
		actual = "number"
	}
	return fmt.Errorf("INVALID_DISPATCH_POLICY: dispatch-policy.json: invalid type: %s, expected %s", actual, expected)
}

func validateDispatchPolicySection(section, prototype object) error {
	checkList := func(value any) error {
		rows, ok := value.([]any)
		if !ok {
			return invalidDispatchPolicyType(value, "a sequence")
		}
		for _, row := range rows {
			if _, ok := row.(string); !ok {
				return invalidDispatchPolicyType(row, "a string")
			}
		}
		return nil
	}
	for _, key := range keys(section) {
		value := section[key]
		switch prototype[key].(type) {
		case []string:
			if err := checkList(value); err != nil {
				return err
			}
		case object:
			rows, ok := value.(object)
			if !ok {
				return invalidDispatchPolicyType(value, "a map")
			}
			for _, entry := range keys(rows) {
				member := rows[entry]
				if key == "allowOptions" || key == "denyOptions" {
					if err := checkList(member); err != nil {
						return err
					}
				} else if _, ok := member.(string); !ok {
					return invalidDispatchPolicyType(member, "a string")
				}
			}
		default:
			if _, ok := value.(string); !ok && (value != nil || prototype[key] != nil) {
				return invalidDispatchPolicyType(value, "a string")
			}
		}
	}
	return nil
}

func readDispatchPolicyLocked() (object, map[string]dispatchPack, error) {
	path := dispatchPolicyPath()
	raw, err := load(path)
	if errors.Is(err, os.ErrNotExist) {
		// The initial Rust file serializes the policy structs in declaration order.
		const initial = "{\"criteria\":\"\",\"codex\":{\"model\":null,\"effort\":null,\"serviceTier\":null,\"serviceTiers\":{},\"allowModels\":[],\"denyModels\":[],\"allowEfforts\":[],\"denyEfforts\":[],\"criteria\":\"\"}}"
		var formatted bytes.Buffer
		_ = json.Indent(&formatted, []byte(initial), "", "  ")
		formatted.WriteByte('\n')
		if err := saveBytes(path, formatted.Bytes()); err != nil {
			return nil, nil, err
		}
		raw, err = load(path)
	}
	if err != nil {
		return nil, nil, err
	}
	policy := obj(raw)
	if policy == nil {
		return nil, nil, errors.New("INVALID_DISPATCH_POLICY: dispatch-policy.json: expected object")
	}
	migrated := false
	if value, exists := policy["criteria"]; exists {
		if _, ok := value.(string); !ok {
			return nil, nil, invalidDispatchPolicyType(value, "a string")
		}
	}
	for _, agent := range keys(policy) {
		if agent == "criteria" || agent == "packs" {
			continue
		}
		section := obj(policy[agent])
		if section == nil {
			return nil, nil, fmt.Errorf("INVALID_DISPATCH_POLICY: dispatch-policy.json: invalid policy for %s", agent)
		}
		if _, ok := section["accountCreditUse"]; ok {
			delete(section, "accountCreditUse")
			migrated = true
		}
		known := dispatchPolicySection(agent, nil)
		for _, field := range keys(section) {
			if _, ok := known[field]; !ok {
				return nil, nil, fmt.Errorf("INVALID_DISPATCH_POLICY: dispatch-policy.json: unknown field `%s`", field)
			}
		}
		if err := validateDispatchPolicySection(section, known); err != nil {
			return nil, nil, err
		}
		for _, field := range []string{"model", "effort"} {
			if value, ok := section[field].(string); ok && strings.TrimSpace(value) == "" {
				return nil, nil, errors.New("INVALID_DISPATCH_POLICY: model and effort must be nonempty or null")
			}
		}
	}
	packs := make(map[string]dispatchPack)
	rawPacks := obj(policy["packs"])
	if value, exists := policy["packs"]; exists && rawPacks == nil {
		return nil, nil, invalidDispatchPolicyType(value, "a map")
	}
	if len(rawPacks) > 16 {
		return nil, nil, errors.New("INVALID_DISPATCH_POLICY: at most 16 packs are allowed")
	}
	for _, name := range keys(rawPacks) {
		pack, err := decodeDispatchPack(rawPacks[name])
		if err != nil {
			return nil, nil, fmt.Errorf("INVALID_DISPATCH_POLICY: dispatch-policy.json: %w", err)
		}
		if err := validateDispatchPack(name, pack); err != nil {
			return nil, nil, err
		}
		packs[name] = pack
	}
	if migrated {
		_ = saveDispatchPolicy(path, policy)
	}
	return policy, packs, nil
}

func readDispatchPolicy() (object, map[string]dispatchPack, error) {
	dispatchPolicyMu.Lock()
	defer dispatchPolicyMu.Unlock()
	return readDispatchPolicyLocked()
}

func commitDispatchPolicy(previous, updated object) (object, error) {
	path := dispatchPolicyPath()
	backup := path + ".bak"
	if err := saveDispatchPolicy(backup, previous); err != nil {
		return nil, err
	}
	if err := saveDispatchPolicy(path, updated); err != nil {
		return nil, err
	}
	return object{"policyPath": path, "backupPath": backup}, nil
}

func dispatchObjectError(value object) error { return errors.New(wire(value)) }

func dispatchPolicyUpdate(args object) (object, error) {
	dispatchPolicyMu.Lock()
	defer dispatchPolicyMu.Unlock()
	previous, _, err := readDispatchPolicyLocked()
	if err != nil {
		return nil, err
	}
	scope := text(args, "scope")
	current := text(previous[scope], "criteria")
	next := object{"agent": scope, "all": true}
	if scope == "global" {
		current, next = text(previous, "criteria"), object{}
	}
	currentHash := hash([]byte(current))
	if args["expectedCriteriaHash"] != currentHash {
		return nil, dispatchObjectError(object{
			"code": "DISPATCH_POLICY_CONFLICT", "op": "dispatch_policy_update", "scope": scope, "currentCriteriaHash": currentHash,
			"message": "Criteria changed. Read dispatch_policy, review the current criteria, then retry dispatch_policy_update with expectedCriteriaHash set to currentCriteriaHash.",
			"next":    object{"via": "query", "op": "dispatch_policy", "args": next, "hint": "Review the current criteria before retrying the full replacement with its criteriaHash."},
		})
	}
	updated := clone(previous)
	criteria := text(args, "criteria")
	if scope == "global" {
		updated["criteria"] = criteria
	} else {
		dispatchSetSection(updated, scope)["criteria"] = criteria
	}
	result, err := commitDispatchPolicy(previous, updated)
	if err != nil {
		return nil, err
	}
	result["scope"], result["criteriaHash"] = scope, hash([]byte(criteria))
	if utf8.RuneCountInString(criteria) > 2000 {
		result["warning"] = fmt.Sprintf("Criteria for %s exceed 2000 characters. Keep routing rules here and move Agent execution rules into packs and long workflows into the user's knowledge base.", scope)
	}
	return result, nil
}

func dispatchPackHash(pack dispatchPack) string { return hash([]byte(wire(pack)))[:12] }

func dispatchSetSection(value object, key string) object {
	section := obj(value[key])
	if section == nil {
		section = object{}
		value[key] = section
	}
	return section
}

func dispatchPackUpdate(args object) (object, error) {
	dispatchPolicyMu.Lock()
	defer dispatchPolicyMu.Unlock()
	previous, packs, err := readDispatchPolicyLocked()
	if err != nil {
		return nil, err
	}
	name := text(args, "name")
	if !dispatchPackName.MatchString(name) {
		return nil, dispatchObjectError(invalidArguments("dispatch_pack_update", "/name", "Pack names must match [a-z0-9-]{1,40}."))
	}
	var current any
	if p, ok := packs[name]; ok {
		current = dispatchPackHash(p)
	}
	if args["expectedPackHash"] != current {
		return nil, dispatchObjectError(object{
			"code": "DISPATCH_POLICY_CONFLICT", "op": "dispatch_pack_update", "name": name, "currentPackHash": current,
			"message": "Pack changed. Read dispatch_policy with view:full, review the current pack, then retry with expectedPackHash set to currentPackHash (null when the pack is absent).",
			"next":    object{"via": "query", "op": "dispatch_policy", "args": object{"view": "full"}, "hint": "Review the current pack before retrying with its hash."},
		})
	}
	updated := clone(previous)
	var digest any
	if args["pack"] == nil {
		section := obj(updated["packs"])
		delete(section, name)
		if len(section) == 0 {
			delete(updated, "packs")
		}
	} else {
		p, err := decodeDispatchPack(args["pack"])
		if err == nil && len(packs) == 16 && current == nil {
			err = errors.New("INVALID_DISPATCH_POLICY: at most 16 packs are allowed")
		}
		if err == nil {
			err = validateDispatchPack(name, p)
		}
		if err != nil {
			return nil, dispatchObjectError(invalidArguments("dispatch_pack_update", "/pack", err.Error()))
		}
		var value object
		_ = canonjson.Unmarshal([]byte(wire(p)), &value)
		dispatchSetSection(updated, "packs")[name] = value
		digest = dispatchPackHash(p)
	}
	result, err := commitDispatchPolicy(previous, updated)
	if err != nil {
		return nil, err
	}
	result["name"], result["packHash"] = name, digest
	return result, nil
}

func dispatchPolicyStrings(value any) []string {
	if list, ok := value.([]string); ok {
		return list
	}
	values := arr(value)
	result := make([]string, 0, len(values))
	for _, value := range values {
		if text, ok := value.(string); ok {
			result = append(result, text)
		}
	}
	return result
}

func checkDispatchChoice(value, allow, deny any, field string) error {
	permitted, denied := dispatchPolicyStrings(allow), dispatchPolicyStrings(deny)
	if choice, ok := value.(string); ok {
		if slices.Contains(denied, choice) || (len(permitted) != 0 && !slices.Contains(permitted, choice)) {
			return fmt.Errorf("DISPATCH_POLICY_DENIED: %s=%s; read query dispatch_policy for allowed choices", field, choice)
		}
	} else if len(permitted) != 0 || len(denied) != 0 {
		return fmt.Errorf("DISPATCH_CONFIGURATION_UNKNOWN: cannot check %s", field)
	}
	return nil
}

func dispatchAgentPolicy(agent string) (object, error) {
	policy, _, err := readDispatchPolicy()
	return dispatchPolicySection(agent, obj(policy[agent])), err
}

func checkDispatchAgentPolicy(policy, options object, model any) error {
	if err := checkDispatchChoice(model, policy["allowModels"], policy["denyModels"], "model"); err != nil {
		return err
	}
	for _, group := range []string{"allowOptions", "denyOptions"} {
		for _, key := range keys(obj(policy[group])) {
			if err := checkDispatchChoice(options[key], field(policy["allowOptions"], key), field(policy["denyOptions"], key), key); err != nil {
				return err
			}
		}
	}
	return nil
}

func dispatchDefaultValue(value any) any {
	if v := strings.TrimSpace(str(value)); v != "" {
		return v
	}
	return nil
}

func dispatchDefaults(body object, update, task bool) (object, error) {
	dispatchPolicyMu.Lock()
	defer dispatchPolicyMu.Unlock()
	agent := text(body, "agent")
	thread := text(body, "threadId")
	if task {
		agent = "codex"
	}
	result := object{"agent": agent}
	var path string
	if task {
		var err error
		path, err = dispatchTaskPath(thread)
		if err != nil {
			return nil, err
		}
		result = object{"threadId": thread}
		if !update {
			row, err := dispatchTaskValues(thread)
			result["model"], result["effort"] = row["model"], row["effort"]
			return result, err
		}
	}
	policy, _, err := readDispatchPolicyLocked()
	if err != nil {
		return nil, err
	}
	section := obj(policy[agent])
	result["model"] = section["model"]
	if agent == "codex" {
		result["effort"] = section["effort"]
	}
	if !update {
		return result, nil
	}
	model, effort := dispatchDefaultValue(body["model"]), dispatchDefaultValue(body["effort"])
	if agent != "codex" && effort != nil {
		return nil, errors.New("DISPATCH_DEFAULTS_UNSUPPORTED: effort applies only to codex")
	}
	for _, choice := range []struct {
		name, suffix string
		value        any
	}{{"model", "Models", model}, {"effort", "Efforts", effort}} {
		if choice.value != nil {
			if err := checkDispatchChoice(choice.value, section["allow"+choice.suffix], section["deny"+choice.suffix], choice.name); err != nil {
				return nil, err
			}
		}
	}
	result["model"] = model
	if agent == "codex" {
		result["effort"] = effort
	}
	if task {
		if model == nil && effort == nil {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return nil, err
			}
			return result, nil
		}
		return result, saveDispatchPolicy(path, object{"model": model, "effort": effort})
	}
	updated := clone(policy)
	values := dispatchSetSection(updated, agent)
	values["model"] = model
	if agent == "codex" {
		values["effort"] = effort
	}
	_, err = commitDispatchPolicy(policy, updated)
	return result, err
}

func dispatchTaskPath(thread string) (string, error) {
	if _, err := uuid.Parse(thread); err != nil {
		return "", errors.New("INVALID_THREAD_ID")
	}
	return filepath.Join(root(), "task-dispatch", thread+".json"), nil
}

func dispatchTaskValues(thread string) (object, error) {
	path, err := dispatchTaskPath(thread)
	if err != nil {
		return nil, err
	}
	row, err := load(path)
	if errors.Is(err, os.ErrNotExist) {
		return object{"model": nil, "effort": nil}, nil
	}
	return obj(row), err
}

func dispatchFirstString(values ...any) any {
	for _, value := range values {
		if s, ok := value.(string); ok {
			return s
		}
	}
	return nil
}

func inheritedDispatchConfiguration(state object, records []object) object {
	result := object{}
	for _, item := range []struct{ key, latest, native string }{
		{"model", "latestModel", "model"}, {"effort", "latestReasoningEffort", "reasoningEffort"},
	} {
		var recorded, desktop any
		for _, row := range slices.Backward(records) {
			source := text(row["source"], item.key)
			if row["dispatchMode"] != "steered" && (source == "explicit" || source == "thread-inherited") {
				if value, ok := row[item.key].(string); ok {
					recorded = value
					break
				}
			}
		}
		if state["runtimeSource"] == "codex-desktop-owner" {
			desktop = state[item.native]
		}
		value := dispatchFirstString(field(state["latestThreadSettings"], item.key), state[item.latest], desktop, recorded, state[item.native])
		if value != nil {
			result[item.key] = value
		}
	}
	return result
}

func applyDispatchPack(args object, agent, op string) error {
	name, ok := args["pack"].(string)
	if !ok {
		return nil
	}
	_, packs, err := readDispatchPolicy()
	if err != nil {
		return err
	}
	pack, ok := packs[name]
	switch {
	case !ok:
		return dispatchObjectError(invalidArguments(op, "/pack", fmt.Sprintf("Unknown pack %s. Read dispatch_policy for the current pack names.", name)))
	case pack.Agent != nil && *pack.Agent != agent:
		return dispatchObjectError(invalidArguments(op, "/pack", fmt.Sprintf("Pack %s targets %s; dispatch it to that Agent or choose another pack from dispatch_policy.", name, *pack.Agent)))
	}
	digest := dispatchPackHash(pack)
	appended := 0
	if strings.TrimSpace(pack.Prompt) != "" {
		block := fmt.Sprintf("<arc-pack name=%q hash=%q>\n%s\n</arc-pack>", name, digest, pack.Prompt)
		if input := arr(args["input"]); input != nil {
			args["input"] = append(input, object{"type": "text", "text": block})
			appended = utf8.RuneCountInString(block)
		} else if prompt := text(args, "prompt"); prompt != "" {
			args["prompt"] = prompt + "\n\n" + block
			appended = 2 + utf8.RuneCountInString(block)
		}
	}
	var defaults object
	_ = canonjson.Unmarshal([]byte(wire(object{"model": pack.Model, "effort": pack.Effort, "serviceTier": pack.ServiceTier, "options": pack.Options})), &defaults)
	args["pack"] = object{"name": name, "hash": digest, "review": pack.Review, "appendedChars": appended, "defaults": defaults}
	return nil
}

func dispatchPackRecord(args object) object {
	record := clone(obj(args["pack"]))
	delete(record, "defaults")
	return record
}

func resolveDispatchPolicy(args, inherited object) (object, error) {
	policy, err := dispatchAgentPolicy("codex")
	if err != nil {
		return nil, err
	}
	var task object
	if thread := text(args, "threadId"); thread != "" {
		task, err = dispatchTaskValues(thread)
		if err != nil {
			return nil, err
		}
	}
	return resolveDispatchConfiguration(args, inherited, task, policy)
}

func resolveDispatchConfiguration(args, inherited, task, policy object) (object, error) {
	source := object{}
	selection := object{"reason": args["reason"], "source": source}
	turn, thread := obj(args["turn"]), obj(args["thread"])
	mode := obj(turn["collaborationMode"])
	defaults := field(args["pack"], "defaults")
	for _, item := range []struct{ key, native, suffix string }{
		{"model", "model", "Models"}, {"effort", "reasoning_effort", "Efforts"},
	} {
		key := item.key
		explicit := dispatchFirstString(field(mode["settings"], item.native), turn[key], args[key])
		if explicit == nil && key == "model" {
			explicit = dispatchFirstString(thread[key])
		}
		source[key] = "native-default"
		var value any
		for i, candidate := range []any{explicit, field(defaults, key), task[key], inherited[key], policy[key]} {
			if v, ok := candidate.(string); ok {
				value = v
				source[key] = []string{"explicit", "pack-default", "task-default", "thread-inherited", "policy-default"}[i]
				break
			}
		}
		if err := checkDispatchChoice(value, policy["allow"+item.suffix], policy["deny"+item.suffix], key); err != nil {
			return nil, err
		}
		if value == nil {
			continue
		}
		selection[key], args[key] = value, value
		if turn != nil {
			turn[key] = value
			if mode != nil {
				dispatchSetSection(mode, "settings")[item.native] = value
			}
		}
		if key == "model" && thread != nil {
			thread[key] = value
		}
	}
	tier := dispatchFirstString(turn["serviceTierForTurn"], turn["serviceTier"], args["serviceTier"], thread["serviceTier"])
	source["serviceTier"] = "explicit"
	if tier == nil {
		tier = dispatchFirstString(field(defaults, "serviceTier"))
		source["serviceTier"] = "pack-default"
	}
	if tier == nil {
		tier = dispatchFirstString(field(policy["serviceTiers"], text(selection, "model")), policy["serviceTier"])
		source["serviceTier"] = "policy-default"
	}
	if tier == nil {
		source["serviceTier"] = "native-default"
	} else if _, oneTurn := turn["serviceTierForTurn"].(string); !oneTurn {
		args["serviceTier"] = tier
		if turn != nil {
			turn["serviceTier"] = tier
		}
		if thread != nil {
			thread["serviceTier"] = tier
		}
	}
	selection["serviceTier"] = tier
	if pack := dispatchPackRecord(args); pack != nil {
		selection["pack"] = pack
	}
	return selection, nil
}

func dispatchCodexModel(model any) object {
	efforts := []any{}
	for _, effort := range arr(field(model, "supportedReasoningEfforts")) {
		efforts = append(efforts, field(effort, "reasoningEffort"))
	}
	result := object{"model": field(model, "model"), "name": field(model, "displayName"), "efforts": efforts}
	for _, key := range []string{"isDefault", "defaultReasoningEffort", "defaultServiceTier", "serviceTiers"} {
		result[key] = field(model, key)
	}
	if display := text(model, "displayName"); display != "" {
		result["displayName"] = display
	}
	provider := field(model, "provider")
	if providerID := str(dispatchFirstString(field(provider, "id"), provider, field(model, "providerId"))); providerID != "" {
		name := str(dispatchFirstString(field(provider, "name"), field(model, "providerName")))
		if name == "" {
			name = providerID
		}
		result["provider"] = object{"id": providerID, "name": name}
	}
	if uintOr(field(model, "contextWindow"), 0) > 0 {
		result["contextWindow"] = field(model, "contextWindow")
	}
	return result
}

func dispatchCodexModels(ctx context.Context, s *service) ([]any, error) {
	models := []any{}
	var cursor any
	for {
		page, err := policyNativeRequest(ctx, s, "model/list", object{"cursor": cursor}, 15*time.Second)
		if err != nil {
			return nil, err
		}
		items, ok := field(page, "data").([]any)
		if !ok {
			return nil, errors.New("NATIVE_MODELS_MISSING")
		}
		for _, model := range items {
			models = append(models, dispatchCodexModel(model))
		}
		cursor = field(page, "nextCursor")
		if cursor == nil {
			return models, nil
		}
	}
}

func init() {
	registerOperation("dispatch_policy_update", func(_ context.Context, r operationRequest) (any, error) {
		scope := text(r.args, "scope")
		if scope != "global" && scope != "codex" {
			registered, err := policyAgentRegistered(r.service, scope)
			if err != nil {
				return nil, err
			}
			if !registered {
				return nil, dispatchObjectError(invalidArguments("dispatch_policy_update", "/scope", "Use global or a registered Agent ID from dispatch_policy with all:true."))
			}
		}
		return dispatchPolicyUpdate(r.args)
	}, nil)
	registerOperation("dispatch_pack_update", func(_ context.Context, r operationRequest) (any, error) {
		if agent, present := field(r.args["pack"], "agent").(string); present && agent != "codex" {
			registered, err := policyAgentRegistered(r.service, agent)
			if err != nil {
				return nil, err
			}
			if !registered {
				return nil, dispatchObjectError(invalidArguments("dispatch_pack_update", "/pack/agent", "Use codex or a registered Agent ID from dispatch_policy with all:true."))
			}
		}
		return dispatchPackUpdate(r.args)
	}, nil)
	for _, spec := range []struct {
		name, route  string
		update, task bool
	}{
		{"agents.dispatch_defaults.read", "agents/dispatch-defaults/read", false, false},
		{"agents.dispatch_defaults.update", "agents/dispatch-defaults", true, false},
		{"tasks.dispatch_defaults.read", "tasks/dispatch-defaults/read", false, true},
		{"tasks.dispatch_defaults.update", "tasks/dispatch-defaults", true, true},
	} {
		registerRoute(http.MethodPost, spec.route, func(_ context.Context, s *service, body object, _ []string) (any, error) {
			if _, _, _, err := managementResolve(spec.name, object{"body": body}); err != nil {
				return nil, err
			}
			if agent := text(body, "agent"); !spec.task && agent != "codex" {
				registered, err := policyAgentRegistered(s, agent)
				if err != nil {
					return nil, err
				}
				if !registered {
					return nil, errors.New("UNKNOWN_AGENT")
				}
			}
			return dispatchDefaults(body, spec.update, spec.task)
		})
	}
	registerRoute(http.MethodPost, "agents/dispatch-catalog", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		if _, _, _, err := managementResolve("agents.dispatch_catalog", object{"body": body}); err != nil {
			return nil, err
		}
		if body["agent"] == "codex" {
			models, err := dispatchCodexModels(ctx, s)
			return object{"source": "codex-model-list", "authoritative": true, "models": models}, err
		}
		body["all"] = true
		rows, err := policyAgentFacts(ctx, s, body)
		if len(rows) != 0 {
			return rows[0]["capabilities"], err
		}
		return object{"authoritative": false, "unavailable": "agent-catalog-unavailable"}, err
	})
}
