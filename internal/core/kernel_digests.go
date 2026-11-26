package core

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

const digestBudget = 8 * 1024
const digestRows = 20

func digestSupported(op string, args object) bool {
	switch op {
	case "codex_thread":
		return slices.Contains([]string{"search", "timeline", "backgroundTerminals/list"}, text(args, "action"))
	case "notify_status", "ax_list", "codex_tasks", "agent_tasks", "board", "messages", "events", "src_conversations", "projects", "mcp_tools", "accounts":
		return true
	}
	return false
}

func digestDetail(op string, args object) bool {
	name := "id"
	switch op {
	case "ax_list", "board", "accounts":
	case "mcp_tools":
		name = "tool"
	case "messages":
		name = "recoveryMessageId"
	default:
		return false
	}
	_, present := args[name].(string)
	return present
}

func digestAction(op string, args object) object {
	return object{"via": "query", "op": op, "args": args}
}
func digestCount(value any, kind string) object { return object{"value": value, "kind": kind} }
func digestText(value any) string {
	if value, ok := value.(string); ok {
		return value
	}
	return "unknown"
}
func digestLine(value string) string {
	runes := []rune(strings.Join(strings.Fields(value), " "))
	return string(runes[:min(len(runes), 180)])
}
func digestState(value any) string {
	for _, choice := range []any{field(value, "state"), field(value, "status"), field(field(value, "status"), "type")} {
		if state, ok := choice.(string); ok {
			return state
		}
	}
	return "unknown"
}
func digestAttention(state string) bool {
	switch state {
	case "failed", "error", "attention", "needs-input", "interaction-required", "systemError", "waitingOnApproval", "waitingOnUserInput", "unconfirmed", "unverified", "blocked", "stale", "open", "candidate", "pending":
		return true
	}
	return false
}

type digestRow struct {
	id, state, summary string
	actionable         bool
	full               any
	read               object
}

func digestRowFor(kind string, id, value any, summary string, actionable bool) digestRow {
	identity, ok := id.(string)
	if !ok {
		identity = hash([]byte(wire(value)))
	}
	identity = kind + ":" + identity
	if len(identity) > 512 {
		identity = hash([]byte(identity))
	}
	return digestRow{identity, digestState(value), digestLine(summary), actionable, value, nil}
}

func digestFirst(value any, keys ...string) any {
	for _, k := range keys {
		if result, ok := obj(value)[k]; ok {
			return result
		}
	}
	return nil
}
func digestArray(value any, key string) []any { return arr(field(value, key)) }
func digestStrings(values []any) []string {
	result := []string{}
	for _, value := range values {
		if s, ok := value.(string); ok {
			result = append(result, s)
		}
	}
	return result
}
func digestBoolean(value any, fieldName, annotation string) string {
	valueBool, ok := field(value, fieldName).(bool)
	if !ok {
		valueBool, ok = field(field(value, "annotations"), annotation).(bool)
	}
	if !ok {
		return "unknown"
	}
	return strconv.FormatBool(valueBool)
}

func projectDigest(op string, args object, value any) []digestRow {
	rows := []digestRow{}
	switch op {
	case "ax_list":
		for _, v := range digestArray(value, "entries") {
			state := digestState(v)
			r := digestRowFor("ax", field(v, "id"), v, digestText(field(v, "severity"))+" "+state, slices.Contains([]string{"open", "triaged", "candidate"}, state))
			r.id = digestText(field(v, "id"))
			r.read = digestAction(op, object{"id": field(v, "id"), "view": "full"})
			rows = append(rows, r)
		}
	case "codex_tasks", "agent_tasks":
		for _, v := range digestArray(value, "tasks") {
			id := digestFirst(v, "threadId", "taskId", "id")
			turn := digestFirst(v, "currentTurn", "latestTurn")
			state, turnState := digestState(v), digestText(field(turn, "status"))
			if _, ok := field(turn, "status").(string); !ok && op == "agent_tasks" {
				if _, ok := field(v, "turnId").(string); ok {
					turnState = state
				}
			}
			interactions := digestArray(v, "pendingInteractions")
			if interactions == nil {
				interactions = digestArray(v, "pending")
			}
			count := "unknown"
			if interactions != nil {
				count = strconv.Itoa(len(interactions))
			}
			r := digestRowFor("task", id, v, fmt.Sprintf("%s; selected turn %s; interactions %s", state, turnState, count), digestAttention(state) || len(interactions) > 0)
			if _, ok := id.(string); ok {
				if op == "agent_tasks" {
					r.read = digestAction("agent_read", object{"agent": args["agent"], "taskId": id})
				} else {
					a := object{"threadId": id}
					if turnID, ok := field(turn, "turnId").(string); ok {
						a["turnId"] = turnID
					} else if turnID, ok := field(v, "turnId").(string); ok {
						a["turnId"] = turnID
					}
					r.read = digestAction("codex_read", a)
				}
			}
			rows = append(rows, r)
		}
	case "notify_status":
		for _, kind := range []string{"targets", "threads", "subscriptions", "deliveries", "unboundPending"} {
			for _, v := range digestArray(value, kind) {
				state := digestState(v)
				diagnosis := field(v, "diagnosis")
				var ident any
				switch kind {
				case "targets":
					state = digestText(field(v, "reachability"))
					ident = []any{field(v, "channel"), field(v, "target")}
				case "threads":
					state = "pending"
					if field(diagnosis, "terminal") == true {
						state = "terminal"
					} else if field(field(diagnosis, "scope"), "active") == false {
						state = "ended"
					}
					ident = field(v, "threadId")
				case "subscriptions":
					state = "expired"
					if field(v, "muted") == true {
						state = "muted"
					} else if field(v, "active") == true {
						state = "active"
					}
					ident = field(v, "id")
				case "unboundPending":
					state = "pending"
				}
				if kind == "deliveries" || kind == "unboundPending" {
					ident = []any{field(v, "eventId"), field(v, "channel"), field(v, "target"), field(v, "subscriptionId"), field(v, "threadId"), field(v, "turnId")}
				}
				reasons := digestStrings(digestArray(diagnosis, "reasons"))
				reason := strings.Join(reasons[:min(len(reasons), 3)], ",")
				pending := len(digestArray(v, "pending"))
				breaker, escalated := field(v, "breaker") == true, field(v, "escalated") == true
				active := digestAttention(state) && (kind != "targets" || field(v, "supersededBy") == nil)
				if kind == "deliveries" {
					active = state == "pending" || state == "sending"
				}
				active = active || strings.Contains(reason, "conflict") || strings.Contains(reason, "unavailable") || pending > 0 || breaker || escalated || kind == "unboundPending"
				r := digestRowFor(kind, hash([]byte(wire(ident))), v, fmt.Sprintf("%s: %s; %s; pending %d; breaker %t; escalated %t", kind, state, reason, pending, breaker, escalated), active)
				r.state = state
				rows = append(rows, r)
			}
		}
	case "board":
		for _, kind := range []string{"blockers", "notices", "attention"} {
			values := digestArray(value, kind)
			if kind == "attention" {
				values = digestArray(field(value, "attention"), "items")
			}
			for _, v := range values {
				conflicts := digestArray(v, "conflicts")
				n, hasN := uintValue(field(v, "conflictCount"))
				if !hasN {
					n = uint64(len(conflicts))
				}
				description := "unknown"
				if hasN || conflicts != nil {
					description = strconv.FormatUint(n, 10)
				}
				r := digestRowFor(kind, field(v, "id"), v, fmt.Sprintf("%s: %s; conflicts %s", kind, digestState(v), description), kind != "notices" || n > 0)
				if kind != "attention" {
					r.read = digestAction(op, object{"id": field(v, "id"), "view": "full"})
				}
				rows = append(rows, r)
			}
		}
	case "messages":
		for _, v := range digestArray(value, "messages") {
			state := digestText(field(v, "deliveryState"))
			active := field(v, "escalated") == true
			r := digestRowFor("message", field(v, "messageId"), v, fmt.Sprintf("%s; delivery %s; unread unknown; escalated %t", digestText(field(v, "type")), state, active), active || digestAttention(state))
			r.state = state
			rows = append(rows, r)
		}
	case "events":
		for _, v := range digestArray(value, "events") {
			kind := digestText(field(v, "kind"))
			r := digestRowFor("event", digestFirst(v, "id", "eventId"), v, kind+"; resources "+strings.Join(digestStrings(digestArray(v, "resources")), ","), strings.Contains(kind, "failed") || strings.Contains(kind, "stalled") || strings.Contains(kind, "unconfirmed"))
			r.state = kind
			rows = append(rows, r)
		}
	case "accounts":
		for _, v := range digestArray(value, "accounts") {
			health := digestText(field(field(v, "health"), "state"))
			quota := field(v, "quota")
			qualifier := digestText(field(quota, "state"))
			used := 0.0
			valid := false
			for _, window := range digestArray(quota, "windows") {
				number := field(window, "usedPercent")
				if number == nil {
					continue
				}
				if f, err := strconv.ParseFloat(fmt.Sprint(number), 64); err == nil {
					if !valid || f > used {
						used = f
					}
					valid = true
				}
			}
			desc := qualifier + " usage unknown"
			if valid {
				desc = fmt.Sprintf("%s max-used %s%%", qualifier, strconv.FormatFloat(used, 'f', -1, 64))
			}
			agents := map[string][]any{}
			for _, profile := range digestArray(v, "agentProfiles") {
				if args["agent"] == nil || args["agent"] == field(profile, "agent") {
					name := digestText(field(profile, "agent"))
					agents[name] = append(agents[name], profile)
				}
			}
			if len(agents) == 0 {
				agents["none"] = nil
			}
			for agent, profiles := range agents {
				def, active := false, false
				for _, profile := range profiles {
					def = def || field(profile, "default") == true
					active = active || field(profile, "state") != "signed-in"
				}
				r := digestRowFor("account", digestText(field(v, "id"))+":"+agent, v,
					fmt.Sprintf("%s; %s; health %s; quota %s; default %t", digestText(digestFirst(v, "alias", "label", "id")), agent, health, desc, def),
					digestAttention(health) || valid && used >= 100 || qualifier == "exhausted" || qualifier == "unavailable" || active)
				r.state = health
				r.read = digestAction(op, object{"id": field(v, "id"), "view": "full"})
				rows = append(rows, r)
			}
		}
	case "src_conversations":
		for _, v := range digestArray(value, "accounts") {
			state := digestState(v)
			conversations := digestArray(v, "conversations")
			r := digestRowFor("source-account", field(v, "accountId"), v, fmt.Sprintf("%s; conversations %d", state, len(conversations)), state != "signed-in" && state != "unsupported")
			r.read = digestAction(op, object{"accountId": field(v, "accountId"), "view": "full"})
			rows = append(rows, r)
			for _, c := range conversations {
				kind := digestText(field(c, "kind"))
				r := digestRowFor("conversation", strings.Join([]string{digestText(field(v, "accountId")), kind, digestText(field(c, "id"))}, ":"), c, fmt.Sprintf("%s; linked tasks %d", kind, len(digestArray(c, "taskRefs"))), false)
				r.state = "observed"
				rows = append(rows, r)
			}
		}
	case "projects":
		for _, v := range digestArray(value, "projects") {
			r := digestRowFor("project", field(v, "id"), v, fmt.Sprintf("registered; roots %d", len(digestArray(v, "roots"))), false)
			r.state = "registered"
			rows = append(rows, r)
		}
	case "mcp_tools":
		list := digestArray(value, "servers")
		if list == nil {
			list = []any{value}
		}
		for _, v := range list {
			state := digestState(v)
			tools := digestArray(v, "tools")
			server := field(v, "name")
			r := digestRowFor("server", server, v, fmt.Sprintf("%s; tools %d", state, len(tools)), state != "ready" && state != "disabled")
			r.read = digestAction(op, object{"server": server, "view": "full"})
			rows = append(rows, r)
			for _, tool := range tools {
				name := field(tool, "name")
				r := digestRowFor("tool", digestText(server)+":"+digestText(name), tool, fmt.Sprintf("%s; readOnly %s; destructive %s", state, digestBoolean(tool, "readOnly", "readOnlyHint"), digestBoolean(tool, "destructive", "destructiveHint")), false)
				r.state = state
				r.read = digestAction(op, object{"server": server, "tool": name, "view": "full"})
				rows = append(rows, r)
			}
		}
	case "codex_thread":
		for _, v := range digestArray(value, "data") {
			var r digestRow
			threadID := field(args["params"], "threadId")
			switch text(args, "action") {
			case "search":
				thread := field(v, "thread")
				state := digestState(thread)
				r = digestRowFor("thread", field(thread, "id"), v, "search; "+state, digestAttention(state))
				r.state = state
				r.read = digestAction("codex_read", object{"threadId": field(thread, "id")})
			case "timeline":
				identity := hash([]byte(wire([]any{threadID, field(v, "position")})))
				status, ok := field(v, "status").(string)
				if !ok {
					status, ok = field(field(v, "item"), "status").(string)
				}
				kind := digestText(field(v, "type"))
				if !ok {
					status = kind
				}
				r = digestRowFor("timeline", identity, v, kind+"; "+status, digestAttention(status))
				r.state = status
			default:
				cpu, rss := "unknown", "unknown"
				if v := field(v, "cpuPercent"); v != nil {
					if n, err := strconv.ParseFloat(fmt.Sprint(v), 64); err == nil {
						cpu = strconv.FormatFloat(n, 'f', -1, 64)
					}
				}
				if n, ok := uintValue(field(v, "rssKb")); ok {
					rss = strconv.FormatUint(n, 10)
				}
				r = digestRowFor("terminal", digestText(threadID)+":"+digestText(field(v, "processId")), v, fmt.Sprintf("background terminal; CPU %s%%; RSS %s KiB", cpu, rss), false)
				r.state = "listed"
			}
			rows = append(rows, r)
		}
	}
	slices.SortStableFunc(rows, func(a, b digestRow) int {
		if a.actionable != b.actionable {
			if a.actionable {
				return -1
			}
			return 1
		}
		return strings.Compare(a.id, b.id)
	})
	return rows
}

func digestRestart(op string, args object) object {
	a := clone(args)
	if a == nil {
		a = object{}
	}
	for _, key := range []string{"digestCursor", "cursor", "since", "offset"} {
		delete(a, key)
	}
	delete(obj(a["params"]), "cursor")
	a["view"] = "digest"
	return digestAction(op, a)
}
func digestScope(origin object) string { return hash([]byte(wire(origin["sourceId"]))) }
func digestCursorAction(op string, args object, output string, offset int, full bool) object {
	view := "digest"
	if full {
		view = "full"
	}
	a := object{"view": view, "digestCursor": fmt.Sprintf("%s:%d", output, offset)}
	if op == "agent_tasks" {
		a["agent"] = args["agent"]
	}
	if op == "codex_thread" {
		a["action"] = args["action"]
		if thread, ok := field(args["params"], "threadId").(string); ok {
			a["params"] = object{"threadId": thread}
		} else if args["action"] == "search" {
			a["params"] = object{"searchTerm": ""}
		}
	}
	return digestAction(op, a)
}

func digestUpstream(op string, args object, value any) object {
	a := clone(args)
	if a == nil {
		a = object{}
	}
	if next := field(value, "nextCursor"); next != nil && field(value, "hasMore") != false {
		switch op {
		case "codex_thread":
			if obj(a["params"]) == nil {
				a["params"] = object{}
			}
			obj(a["params"])["cursor"] = next
		case "events":
			a["since"] = next
		default:
			a["cursor"] = next
		}
	} else if next, ok := uintValue(field(value, "nextOffset")); ok {
		a["offset"] = next
	} else {
		return nil
	}
	return a
}

func digestShown(value object, rpc any) int {
	wrapped := egressTool(clone(value), false)
	if rpc == nil {
		return len(wire(wrapped))
	}
	wrapped["resultType"] = "complete"
	return len(wire(object{"jsonrpc": "2.0", "id": rpc, "result": wrapped}))
}

func showDigest(op string, args object, value any, origin object, rpc any) (object, error) {
	snapshot := object{"op": op, "args": args, "scope": digestScope(origin), "value": value}
	output, err := reserveOutput(wire(snapshot), ".digest")
	if err != nil {
		return nil, err
	}
	return renderDigest(output, snapshot, 0, rpc), nil
}

func renderDigest(output string, snapshot object, offset int, rpc any) object {
	op, args, value := text(snapshot, "op"), obj(snapshot["args"]), snapshot["value"]
	rows := projectDigest(op, args, value)
	upstream := digestUpstream(op, args, value)
	hidden := false
	for _, n := range obj(field(field(value, "summary"), "hidden")) {
		hidden = hidden || uintOr(n, 0) > 0
	}
	partial := upstream != nil || op == "events" || op == "codex_tasks" || op == "codex_thread" || op == "notify_status" && hidden
	kind, extent, beyond := "exact", "complete", "none"
	if partial {
		kind, extent, beyond = "bounded", "bounded", "unknown"
	}
	actionable := 0
	for _, row := range rows {
		if row.actionable {
			actionable++
		}
	}
	counts := object{"rows": digestCount(len(rows), kind), "actionable": digestCount(actionable, kind)}
	coverage := object{"scope": "authorized-filtered-snapshot", "ordering": "actionable-first-within-snapshot", "countsScope": "snapshot-rows-unless-owner-total", "owner": op, "extent": extent}
	out := object{"view": "digest", "revision": output, "counts": counts, "rows": []any{}, "omitted": object{}, "coverage": coverage, "next": nil}
	if total, ok := uintValue(field(value, "total")); op == "agent_tasks" && ok {
		counts["total"] = digestCount(total, "exact")
	}
	if op == "messages" {
		counts["unread"] = digestCount(nil, "unknown")
	}
	if op == "notify_status" {
		history := "owner-window"
		if args["all"] == true {
			history = "all"
		}
		coverage["history"] = history
		for _, name := range []string{"totalTargets", "totalThreads", "totalBindings", "totalDeliveries", "totalSubscriptions"} {
			if n, ok := uintValue(field(field(value, "summary"), name)); ok {
				counts[name] = digestCount(n, "exact")
			}
		}
		if hidden {
			coverage["expand"] = digestCursorAction(op, args, output, len(rows)+1, false)
		}
	}
	observe := func(name string, v any) {
		switch item := v.(type) {
		case bool:
			coverage[name] = item
		case string:
			if len(item) < 64 {
				coverage[name] = item
			}
		}
	}
	for _, name := range []string{"activityCoverage", "conflictCoverage", "projectionPending"} {
		observe(name, field(value, name))
	}
	nativeCoverage := obj(field(value, "coverage"))
	for _, name := range keys(nativeCoverage)[:min(len(nativeCoverage), 8)] {
		if len(name) < 64 {
			observe(name, nativeCoverage[name])
		}
	}
	if op == "board" {
		attention := field(field(value, "attention"), "coverage")
		coverage["attention"] = object{"bulletin": digestText(field(attention, "bulletin")), "ax": digestText(field(attention, "ax")), "notifications": digestText(field(attention, "notifications"))}
	}
	if _, ok := field(value, "oldestCursor").(string); op == "events" && ok {
		coverage["historyStart"] = digestCursorAction(op, args, output, len(rows)+1, false)
	}
	full := digestAction("control_output", object{"outputId": output, "offset": 0})
	update := func(nextOffset int) {
		var next any
		if nextOffset < len(rows) || upstream != nil {
			next = digestCursorAction(op, args, output, nextOffset, false)
		}
		out["next"] = next
		out["omitted"] = object{"rows": digestCount(max(len(rows)-nextOffset, 0), "exact"), "beyondSnapshot": beyond, "page": next, "full": full}
	}
	update(offset)
	values := []any{}
	for index := offset; index < len(rows) && index-offset < digestRows; index++ {
		row := rows[index]
		id := row.id
		if len(id) > 512 {
			id = hash([]byte(id))
		}
		result := object{"id": id, "state": digestLine(row.state), "summary": row.summary, "actionable": row.actionable, "detail": digestCursorAction(op, args, output, index, true)}
		if row.read != nil && len(wire(row.read)) < 1024 {
			result["read"] = row.read
		}
		if op == "ax_list" {
			runes := []rune(row.id)
			short := string(runes[:min(len(runes), 11)])
			n := 0
			for _, other := range rows {
				if strings.HasPrefix(other.id, short) {
					n++
				}
			}
			if n == 1 {
				result["shortId"] = short
			}
		}
		if len(wire(result)) > digestBudget/2 {
			result = object{"id": hash([]byte(row.id)), "state": result["state"], "detail": result["detail"], "actionable": row.actionable}
		}
		values = append(values, result)
		out["rows"] = values
		update(index + 1)
		if digestShown(out, rpc) > digestBudget {
			delete(result, "summary")
			if digestShown(out, rpc) > digestBudget {
				out["rows"] = values[:len(values)-1]
				update(index)
				break
			}
		}
	}
	return out
}

func readDigest(output string) (object, bool, error) {
	if _, err := uuid.Parse(output); err != nil {
		return nil, false, errors.New("INVALID_OUTPUT_ID")
	}
	path := filepath.Join(root(), "outputs", output+".digest")
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	value, err := load(path)
	return obj(value), time.Since(info.ModTime()) >= outputTTL, err
}

func resumeDigest(op string, args, origin object, rpc any) (response, follow object, err error) {
	output, raw, ok := strings.Cut(text(args, "digestCursor"), ":")
	offset, parse := strconv.Atoi(raw)
	if !ok || parse != nil || offset < 0 {
		return nil, nil, errors.New("INVALID_DIGEST_CURSOR")
	}
	snapshot, expired, err := readDigest(output)
	if err != nil {
		return nil, nil, err
	}
	failure := func(code, message string, from object) error {
		return errors.New(wire(object{"code": code, "message": message, "next": digestRestart(op, from)}))
	}
	if snapshot == nil {
		return nil, nil, failure("DIGEST_CURSOR_EXPIRED", "Restart the list; this temporary snapshot was evicted", args)
	}
	if snapshot["op"] != op || snapshot["scope"] != digestScope(origin) {
		return nil, nil, failure("DIGEST_SCOPE_CHANGED", "Read with the original authorized source or restart the list", args)
	}
	saved, value := obj(snapshot["args"]), snapshot["value"]
	if expired {
		return nil, nil, failure("DIGEST_CURSOR_EXPIRED", "Restart the list; the temporary snapshot expired", saved)
	}
	rows := projectDigest(op, saved, value)
	if args["view"] == "full" {
		if offset >= len(rows) {
			return nil, nil, errors.New("INVALID_DIGEST_CURSOR")
		}
		return object{"row": rows[offset].full}, nil, nil
	}
	if offset == len(rows)+1 {
		if op == "notify_status" {
			follow = clone(saved)
			follow["all"] = true
			return nil, follow, nil
		}
		if oldest, ok := field(value, "oldestCursor").(string); op == "events" && ok {
			follow = clone(saved)
			follow["since"] = oldest
			return nil, follow, nil
		}
	}
	if offset == len(rows) {
		if next := digestUpstream(op, saved, value); next != nil {
			return nil, next, nil
		}
	}
	return renderDigest(output, snapshot, offset, rpc), nil, nil
}
