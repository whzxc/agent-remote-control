package core

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

var dispatchDecisionFields = []string{"model", "effort", "options", "serviceTier", "serviceTiers"}
var dispatchRestrictionFields = []string{"allowModels", "denyModels", "allowEfforts", "denyEfforts", "allowOptions", "denyOptions"}

func dispatchPresentCriteria(row object, criteria, scope string, args object) {
	digest := hash([]byte(criteria))
	row["criteriaHash"] = digest
	if args["knownCriteriaHash"] == digest || field(args["knownCriteriaHash"], scope) == digest {
		delete(row, "criteria")
		row["criteriaUnchanged"] = true
	} else {
		row["criteria"] = criteria
	}
}

func dispatchPresentEmpty(value any) bool {
	switch value := value.(type) {
	case nil:
		return true
	case string:
		return value == "" || value == "unknown"
	case []any:
		return len(value) == 0
	case []string:
		return len(value) == 0
	case object:
		return len(value) == 0
	default:
		return false
	}
}

func cleanDispatchPresentation(value any) any {
	switch row := value.(type) {
	case object:
		stale := row["state"] == "stale" || row["stale"] == true || row["source"] == "persistent-snapshot" || row["source"] == "persisted-session-snapshot"
		for key, sub := range row {
			if key == "quality" {
				continue
			}
			if models, ok := sub.([]any); ok && key == "models" {
				for i, model := range models {
					models[i] = cleanDispatchPresentation(model)
				}
				continue
			}
			if _, ok := sub.([]string); ok && key == "models" {
				continue
			}
			sub = cleanDispatchPresentation(sub)
			if _, label := sub.(string); label && slices.Contains([]string{"model", "displayName", "name", "id", "value", "coverage"}, key) {
				continue
			}
			if key == "observedAt" && !stale || dispatchPresentEmpty(sub) {
				delete(row, key)
			} else {
				row[key] = sub
			}
		}
	case []any:
		for i, sub := range row {
			row[i] = cleanDispatchPresentation(sub)
		}
		return slices.DeleteFunc(row, dispatchPresentEmpty)
	}
	return value
}

func dispatchModelList(models []any) []string {
	groups := make(map[[3]string][]string)
	effortOrder := []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
	for _, model := range models {
		var settings []string
		if efforts := dispatchPolicyStrings(field(model, "efforts")); len(efforts) != 0 {
			label := strings.Join(efforts, "/")
			index := slices.Index(effortOrder, efforts[0])
			if len(efforts) > 2 && index >= 0 && index+len(efforts) <= len(effortOrder) && slices.Equal(efforts, effortOrder[index:index+len(efforts)]) {
				label = efforts[0] + "-" + efforts[len(efforts)-1]
			}
			settings = append(settings, label)
		}
		for _, tier := range arr(field(model, "serviceTiers")) {
			settings = append(settings, strings.ToLower(text(tier, "name"))+"="+text(tier, "id"))
		}
		for _, option := range arr(field(model, "options")) {
			var values []string
			for _, item := range arr(field(option, "values")) {
				if v := dispatchFirstString(item, field(item, "value")); v != nil {
					values = append(values, str(v))
				}
			}
			if textValue := strings.Join(values, "/"); textValue != "" {
				settings = append(settings, text(option, "id")+"="+textValue)
			}
		}
		id, name := text(model, "model"), text(model, "displayName")
		label := id
		if name != "" && name != id {
			label = name + " (" + id + ")"
		}
		provider := field(model, "provider")
		providerID, providerName := text(provider, "id"), text(provider, "name")
		if providerName == "" || providerName == id || providerName == name {
			providerID, providerName = "", ""
		}
		key := [3]string{providerID, providerName, strings.Join(settings, ", ")}
		groups[key] = append(groups[key], label)
	}
	keys := slices.Collect(maps.Keys(groups))
	slices.SortFunc(keys, func(a, b [3]string) int { return slices.Compare(a[:], b[:]) })
	rows := make([]string, 0, len(keys))
	for _, key := range keys {
		labels := strings.Join(groups[key], ",")
		if key[1] != "" {
			labels = "[" + key[1] + "] " + labels
		}
		if key[2] != "" {
			labels += ": " + key[2]
		}
		rows = append(rows, labels)
	}
	return rows
}

func compactDispatchHistory(history object) object {
	if _, unavailable := history["unavailable"].(string); unavailable {
		return history
	}
	lines := []string{}
	for _, item := range arr(history["groups"]) {
		g := obj(item)
		var parts []string
		for _, k := range []string{"model", "effort"} {
			if value := text(g, k); value != "" && value != "unknown" {
				parts = append(parts, value)
			}
		}
		label := strings.Join(parts, "/")
		switch tier := text(g, "serviceTier"); tier {
		case "default", "":
		case "unknown":
			label += "/?"
		default:
			label += "/" + tier
		}
		for _, key := range keys(obj(g["options"])) {
			label += " " + key + "=" + text(g["options"], key)
		}
		line := fmt.Sprintf("%s: n%v", label, g["dispatches"])
		if ms, ok := dispatchNumber(g["medianObservedDurationMs"]); ok {
			line += fmt.Sprintf(" med%.1fm", ms/60000)
		}
		line += fmt.Sprintf(" pass%v rework%v unrev%v", g["pass"], g["rework"], g["unreviewed"])
		if external := obj(g["external"]); external != nil {
			line += fmt.Sprintf(" ext%v pass%v rework%v", external["reviews"], external["pass"], external["rework"])
		}
		for _, part := range [][2]string{{"failed", "fail"}, {"interrupted", "int"}} {
			if n := uintOr(g[part[0]], 0); n > 0 {
				line += fmt.Sprintf(" %s%d", part[1], n)
			}
		}
		if cost, ok := dispatchNumber(field(g["usage"], "costUsd")); ok {
			if n := uintOr(field(g["usage"], "samples"), 0); n > 0 {
				line += fmt.Sprintf(" $%.2f(%d)", cost, n)
			}
		}
		lines = append(lines, line)
	}
	quality := obj(history["quality"])
	if len(lines) == 0 && uintOr(field(quality["externalReviews"], "reviews"), 0) == 0 && uintOr(field(quality["selfTests"], "count"), 0) == 0 {
		return nil
	}
	return object{"groups": lines, "quality": quality, "coverage": history["coverage"]}
}

type dispatchQuotaRow struct {
	id    string
	value object
}

func compactDispatchQuotas(row object) []dispatchQuotaRow {
	q := obj(row["quota"])
	var result []dispatchQuotaRow
	for _, pool := range arr(q["pools"]) {
		var windows []string
		for _, slot := range []string{"primary", "secondary"} {
			window := field(pool, slot)
			if used, ok := dispatchNumber(field(window, "usedPercent")); ok {
				label := slot
				switch duration, present := uintValue(field(window, "windowDurationMins")); {
				case present && duration == 10080:
					label = "weekly"
				case present && duration == 300:
					label = "5h"
				case present:
					label = fmt.Sprintf("%dm", duration)
				}
				windows = append(windows, label+" "+strconv.FormatFloat(used, 'f', -1, 64)+"%")
			}
		}
		value := object{"summary": strings.Join(windows, ", ")}
		if q["source"] == "local-gateway" {
			value["source"] = q["source"]
			if gateway, ok := q["gateway"].(string); ok {
				value["gateway"] = gateway
			}
		}
		for _, k := range []string{"rateLimitReachedType", "spendControlReached", "accountsTotal", "accountsWithRoom", "accountsWithCredits"} {
			if v := field(pool, k); v != nil && v != false {
				value[k] = v
			}
		}
		if v := field(field(pool, "primary"), "bestAccountUsedPercent"); v != nil {
			value["bestAccountUsedPercent"] = v
		}
		if v := field(pool, "credits"); obj(v) != nil {
			value["credits"] = v
		}
		if q["ordinaryUsageAllowed"] == false {
			value["ordinaryUsageAllowed"] = false
		}
		result = append(result, dispatchQuotaRow{"codex/" + text(pool, "id"), value})
	}
	for _, p := range arr(q["providers"]) {
		pools := make(map[string][]string)
		for _, window := range arr(field(p, "windows")) {
			if used, ok := dispatchNumber(field(window, "usedPercent")); ok {
				key := text(window, "poolId")
				label := strings.ReplaceAll(text(window, "label"), "weekly_all", "weekly")
				pools[key] = append(pools[key], label+" "+strconv.FormatFloat(used, 'f', -1, 64)+"%")
			}
		}
		if len(pools) == 0 {
			pools[""] = nil
		}
		for _, key := range slices.Sorted(maps.Keys(pools)) {
			value := object{"summary": strings.Join(pools[key], ", ")}
			if field(p, "state") != "ready" {
				value["state"], value["observedAt"] = field(p, "state"), field(p, "observedAt")
			}
			for _, k := range []string{"error", "accountBlocked", "blockedPoolIds"} {
				if v := field(p, k); v != false {
					value[k] = v
				}
			}
			result = append(result, dispatchQuotaRow{text(p, "providerId") + "/" + key, value})
		}
	}
	return result
}

// Rust regex uses Unicode word boundaries. Check the enclosing runes for the
// explicit statement, while letting regexp identify the ASCII field and tier.
var dispatchTierStatement = regexp.MustCompile("(?i)serviceTier[\x60\"']*[\\p{Z}\\x09-\\x0d\\x{85}]*(?:[:=][\\p{Z}\\x09-\\x0d\\x{85}]*)?[\x60\"']*(default|priority)")
var dispatchWordAtEnd = regexp.MustCompile(`[\pL\p{Nl}\pM\p{Nd}\p{Pc}\x{200c}\x{200d}]$`)
var dispatchWordAtStart = regexp.MustCompile(`^[\pL\p{Nl}\pM\p{Nd}\p{Pc}\x{200c}\x{200d}]`)

func dispatchTierMismatches(global string, policy object) []any {
	result := []any{}
	for _, item := range []struct{ scope, criteria string }{{"global", global}, {"codex", text(policy, "criteria")}} {
		tiers := make(map[string]bool)
		for _, span := range dispatchTierStatement.FindAllStringSubmatchIndex(item.criteria, -1) {
			if !dispatchWordAtEnd.MatchString(item.criteria[:span[0]]) && !dispatchWordAtStart.MatchString(item.criteria[span[1]:]) {
				tiers[strings.ToLower(item.criteria[span[2]:span[3]])] = true
			}
		}
		if len(tiers) != 1 {
			continue
		}
		for tier := range tiers {
			configs := obj(policy["serviceTiers"])
			for _, model := range keys(configs) {
				if override, ok := configs[model].(string); ok && override != tier {
					result = append(result, object{"code": "CRITERIA_SERVICE_TIER_MISMATCH", "criteriaScope": item.scope,
						"criteriaServiceTier": tier, "model": model, "overrideServiceTier": override,
						"nextAction": "Pass serviceTier explicitly to codex_create/codex_send to follow the criteria. Reconcile the criteria and per-model override before relying on omitted defaults."})
				}
			}
		}
	}
	return result
}

func presentDispatchDecision(facts object, args object) object {
	rows := arr(facts["agents"])
	packAgents := dispatchPolicyStrings(facts["packAgents"])
	delete(facts, "packAgents")
	global := text(facts, "criteria")
	for _, value := range rows {
		if row := obj(value); row["agent"] == "codex" {
			row["policyMismatches"] = dispatchTierMismatches(global, obj(row["policy"]))
		}
	}
	dispatchPresentCriteria(facts, global, "global", args)
	if args["view"] == "full" {
		for _, row := range rows {
			policy := obj(field(row, "policy"))
			dispatchPresentCriteria(policy, text(policy, "criteria"), text(row, "agent"), args)
		}
		return obj(cleanDispatchPresentation(facts))
	}
	seen := make(map[string]string)
	out, others := []any{}, []any{}
	anyHistory := false
	for _, raw := range rows {
		row := obj(raw)
		agent := text(row, "agent")
		available, policy, capabilities := obj(row["availability"]), obj(row["policy"]), obj(row["capabilities"])
		status := "unavailable"
		switch {
		case available["installed"] != true:
			status = "not installed"
		case available["enabled"] != true:
			status = "disabled"
		case available["available"] == true:
			status = "available"
		}
		criteria := text(policy, "criteria")
		history := compactDispatchHistory(obj(row["history"]))
		unconfigured := criteria == "" && history == nil
		configured := slices.ContainsFunc(dispatchDecisionFields, func(k string) bool { return !dispatchPresentEmpty(policy[k]) }) ||
			slices.ContainsFunc(dispatchRestrictionFields, func(k string) bool { return !dispatchPresentEmpty(policy[k]) })
		if _, filter := args["agent"].(string); unconfigured && !configured && !slices.Contains(packAgents, agent) && !filter {
			if detail, ok := capabilities["unavailable"].(string); ok && status == "available" {
				status = detail
			}
			others = append(others, agent+": "+status)
			continue
		}
		if unconfigured {
			status += ", no policy"
		}
		result := object{"agent": agent, "policyMismatches": row["policyMismatches"], "availability": status}
		if message, ok := available["discoveryError"].(string); ok {
			result["error"] = message
		}
		dispatchPresentCriteria(result, criteria, agent, args)
		defaults := object{}
		for _, key := range dispatchDecisionFields {
			defaults[key] = policy[key]
		}
		result["defaults"] = defaults
		for _, key := range dispatchRestrictionFields {
			result[key] = policy[key]
		}
		modelCatalog := capabilities
		if agent == "codex" {
			modelCatalog = row
		}
		result["authoritative"] = !unconfigured && modelCatalog["authoritative"] == true
		for _, key := range []string{"source", "observedAt", "omittedModels", "unavailable"} {
			result[key] = modelCatalog[key]
		}
		if !unconfigured {
			result["history"] = history
			anyHistory = anyHistory || history != nil
			result["models"] = modelCatalog["models"]
			if models, ok := modelCatalog["models"].([]any); ok {
				result["models"] = dispatchModelList(models)
			}
			var options []string
			for _, option := range arr(capabilities["options"]) {
				var choices []string
				for _, choice := range arr(field(option, "values")) {
					if v := text(choice, "value"); v != "" {
						choices = append(choices, v)
					}
				}
				options = append(options, text(option, "id")+": "+strings.Join(choices, "/"))
			}
			if len(options) != 0 {
				result["options"], result["optionsForModel"], result["currentModel"] = options, capabilities["optionsForModel"], capabilities["currentModel"]
			}
		}
		quota := []any{}
		for _, row := range compactDispatchQuotas(row) {
			if owner, existed := seen[row.id]; existed {
				quota = append(quota, object{"ref": owner + "/" + row.id})
			} else {
				seen[row.id] = agent
				row.value["id"] = row.id
				quota = append(quota, row.value)
			}
		}
		if len(quota) == 0 {
			result["quota"] = field(row["quota"], "unavailable")
		} else {
			result["quota"] = quota
		}
		out = append(out, result)
	}
	if anyHistory {
		facts["legend"] = "packs=name: summary [agent defaults] then 30d outcomes; 30d; no self-test; n=dispatches med=successful observed minutes unrev=unreviewed int=interrupted fail=failed ext=external reviews with own pass/rework; /tier omitted=default ?=unknown; other=mixed n<10; quota=% used"
	}
	facts["agents"], facts["otherAgents"] = out, others
	return obj(cleanDispatchPresentation(facts))
}

func dispatchPacksView(packs map[string]dispatchPack, stats map[string]string, full bool) any {
	if len(packs) == 0 {
		return nil
	}
	compact := []string{}
	expanded := object{}
	for _, name := range slices.Sorted(maps.Keys(packs)) {
		pack := packs[name]
		if full {
			var row object
			_ = decodeObject([]byte(wire(pack)), &row)
			row["hash"] = dispatchPackHash(pack)
			if stats[name] != "" {
				row["history"] = stats[name]
			}
			expanded[name] = row
			continue
		}
		target := "any"
		if pack.Agent != nil {
			target = *pack.Agent
		}
		var defaults []string
		for _, v := range []*string{pack.Model, pack.Effort, pack.ServiceTier} {
			if v != nil {
				defaults = append(defaults, *v)
			}
		}
		if len(defaults) > 0 {
			target += " " + strings.Join(defaults, "/")
		}
		for _, key := range slices.Sorted(maps.Keys(pack.Options)) {
			target += " " + key + "=" + pack.Options[key]
		}
		line := fmt.Sprintf("%s: %s [%s]", name, pack.Summary, target)
		if stats[name] != "" {
			line += " " + stats[name]
		}
		compact = append(compact, line)
	}
	if full {
		return expanded
	}
	return compact
}

func dispatchCodexQuota(value any) object {
	pools := obj(field(value, "rateLimitsByLimitId"))
	if pools == nil {
		pools = object{}
		if pool := obj(field(value, "rateLimits")); pool != nil {
			id := str(dispatchFirstString(pool["limitId"], "codex"))
			pools[id] = pool
		}
	}
	rows := []any{}
	for _, id := range keys(pools) {
		pool := pools[id]
		row := object{"id": id}
		for _, key := range []string{"rateLimitReachedType", "spendControlReached", "credits"} {
			if v := field(pool, key); v != nil {
				row[key] = v
			}
		}
		for _, slot := range []string{"primary", "secondary"} {
			if value := obj(field(pool, slot)); value != nil {
				window := object{}
				for _, key := range []string{"usedPercent", "windowDurationMins", "resetsAt"} {
					if v := value[key]; v != nil {
						window[key] = v
					}
				}
				row[slot] = window
			}
		}
		rows = append(rows, row)
	}
	return object{"ordinaryUsageAllowed": field(value, "ordinaryUsageAllowed"), "pools": rows, "state": "ready", "observedAt": now()}
}

func queryDispatchPolicy(ctx context.Context, r operationRequest) (any, error) {
	if dispatchAccountsRefresh != nil {
		if err := dispatchAccountsRefresh(ctx, r.service); err != nil {
			return nil, err
		}
	}
	policy, packs, err := readDispatchPolicy()
	if err != nil {
		return nil, err
	}
	if dispatchAgentFacts == nil {
		return nil, errors.New(PortPending)
	}
	agents, err := dispatchAgentFacts(ctx, r.service, r.args)
	if err != nil {
		return nil, err
	}
	var snapshot object
	if dispatchSubscriptionSnapshot != nil {
		snapshot = dispatchSubscriptionSnapshot(r.service)
	}
	full := r.args["view"] == "full"
	window := time.Now().Add(-30 * 24 * time.Hour)
	history, historyErr := dispatchHistoryRows(window)
	rows := make([]any, 0, len(agents))
	for _, row := range agents {
		agent := text(row, "agent")
		group, access := []any{}, []any{}
		for _, p := range arr(snapshot["providers"]) {
			if slices.Contains(arr(field(p, "agentIds")), any(agent)) {
				status := object{}
				for _, key := range []string{"providerId", "state", "observedAt", "error"} {
					status[key] = field(p, key)
				}
				access = append(access, status)
				provider := maps.Clone(status)
				for _, key := range []string{"source", "windows", "accountBlocked", "blockedPoolIds"} {
					provider[key] = field(p, key)
				}
				group = append(group, provider)
			}
		}
		dispatchSetSection(row, "availability")["authentication"] = object{"inference": "unknown", "quotaAccess": access}
		if agent == "codex" {
			var quota object
			if dispatchGatewayQuota != nil {
				quota = dispatchGatewayQuota(ctx)
			}
			models, err := dispatchCodexModels(ctx, r.service)
			row["observedAt"], row["authoritative"] = now(), err == nil
			if err == nil {
				row["models"] = models
			} else {
				row["models"] = object{"unavailable": err.Error()}
			}
			if quota == nil {
				if nativeControlRequest == nil {
					quota = object{"unavailable": PortPending}
				} else if native, err := nativeControlRequest(ctx, r.service, "account/rateLimits/read", object{}, 15*time.Second); err == nil {
					quota = dispatchCodexQuota(native)
				} else {
					quota = object{"unavailable": err.Error()}
				}
			}
			row["quota"] = quota
		} else if len(group) == 0 {
			row["quota"] = object{"unavailable": "provider-not-integrated"}
		} else {
			row["quota"] = object{"source": "subscriptions", "providers": group, "modelAssociation": "unknown"}
		}
		row["policy"], row["selectionSupported"] = dispatchPolicySection(agent, obj(policy[agent])), true
		if historyErr != nil {
			row["history"] = object{"unavailable": historyErr.Error()}
		} else {
			row["history"] = summarizeDispatchHistory(history, agent, !full, window)
		}
		rows = append(rows, row)
	}
	if len(packs) != 0 && historyErr != nil {
		return nil, historyErr
	}
	targeted := []string{}
	for _, p := range packs {
		if p.Agent != nil {
			targeted = append(targeted, *p.Agent)
		}
	}
	facts := object{"observedAt": now(), "policyPath": dispatchPolicyPath(), "criteria": text(policy, "criteria"), "agents": rows,
		"packs": dispatchPacksView(packs, summarizeDispatchPacks(history, window), full), "packAgents": targeted}
	return presentDispatchDecision(facts, r.args), nil
}

func init() { registerOperation("dispatch_policy", queryDispatchPolicy, nil) }
