package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	reference "github.com/whzxc/agent-remote-control/docs/reference"
)

var cliCommands = []string{
	"capabilities",
	"device offer",
	"device address <device> <host:port>",
	"device address <device> --clear",
	"device pair <string>",
	"device pending",
	"device approve",
	"device decline",
	"device revoke <deviceId>",
	"device configure --stdin",
	"control <op> [--stdin]",
	"install-shim",
	"schema <operation>",
	"call <operation> [--stdin]",
	"mcp",
	"local-mcp <id>",
	"watch",
	"logs --stdin",
	"logs --follow",
	"logs --offline",
	"stats control",
	"stats control --since <duration>",
	"app start",
	"app status",
	"app quit",
	"app restart",
	"storage compact",
	"storage status",
	"storage archive [--apply]",
	"storage archive --dry-run",
	"storage prune [--apply]",
	"storage prune --dry-run",
	"storage prune --older-than <days> [--apply]",
	"storage prune --include-legacy [--apply]",
	"storage prune --include-outputs [--apply]",
	"storage prune --older-than <days> --include-legacy [--apply]",
	"storage prune --older-than <days> --include-outputs [--apply]",
	"storage prune --include-legacy --include-outputs [--apply]",
	"storage prune --older-than <days> --include-legacy --include-outputs [--apply]",
	"ax import --from <path>",
	"ax export --to <path>",
	"subscriptions get",
	"subscriptions set --stdin",
	"subscriptions refresh [providerId]",
	"subscriptions open [providerId]",
	"help",
	"guide",
	"context --stdin",
	"status",
	"onboarding",
	"setup next",
	"setup next --locale <locale>",
	"setup next --goal <goal>",
	"setup next --goal <goal> --locale <locale>",
	"setup apply <stepId> --stdin",
	"setup apply <stepId> --stdin --locale <locale>",
	"setup wait",
	"setup wait --locale <locale>",
	"setup wait --timeout <sec>",
	"setup wait --timeout <sec> --locale <locale>",
	"setup playbook <id>",
	"setup reset",
	"skill install --target <target>",
	"uninstall [--purge]",
	"doctor",
	"logs",
	"config get",
	"config set --stdin",
	"configure --stdin",
	"network --stdin",
	"connect",
	"disconnect",
	"verify",
	"verify --fresh",
	"source list",
	"source update <id> --stdin",
	"source disconnect <id>",
	"source claim <pending-source-id> --stdin",
	"source switch <sourceId> <ingressId>",
	"source switch <sourceId> --cancel",
	"ingress list",
	"ingress presets",
	"ingress add --stdin",
	"ingress update <id> --stdin",
	"ingress remove <id>",
	"ingress start <id>",
	"ingress stop <id>",
	"ingress restart <id>",
	"ingress probe <id>",
	"ingress start-all",
	"ingress stop-all",
	"ingress token rotate <id>",
	"ingress oauth list <id>",
	"ingress oauth decision <id> --stdin",
	"ingress oauth request <id> <request-id>",
	"ingress oauth register <id> --stdin",
	"ingress oauth revoke <id> --stdin",
	"ingress doctor <id>",
	"ingress verify <id> [--fresh]",
}

const cliHelpJSON = `{"version":"0.0.0",
            "usage":"arc cli [--state-dir <absolute-directory>] <command>",
            "targeting":"--state-dir selects only that instance and never falls back to the installed app. Start a side-by-side development instance with npm run dev:isolated.",
            "groups":[
                {"commands":"control <op> [--stdin]; control guide [op]; wait --op <op> [--control] [--stdin] --until <condition> [--until <condition>] [--timeout <seconds>]","description":"Local-only control dispatch and bounded condition waiting. Read cli schema control and cli schema wait."},
                {"commands":"app snapshot [--out <directory>] [--stdin]; install-shim","description":"Export the live UI and a macOS WebView PNG; install the macOS CLI symlink."},
                {"commands":"setup next|apply|wait|playbook|reset; skill install --target codex|claude-code|antigravity","description":"Configure a Codex, Claude or Antigravity control source; follow step and nextAction. Configure executable Agents in Agent management, then use agent_* ops."},
                {"commands":"status; doctor; onboarding; context --stdin","description":"Read current state, diagnostics and onboarding evidence."},
                {"commands":"source list; source update <id> --stdin; source disconnect <id>; source claim <pending-source-id> --stdin; source switch <sourceId> <ingressId>; source switch <sourceId> --cancel","description":"Manage source identity; claim accepts sourceId=new or an existing source ID; a switch request can only claim its bound source."},
                {"commands":"ingress list|presets|add|update|remove|start|stop|restart|probe|doctor|verify","description":"Manage and diagnose a selected connection; add/update accept JSON on stdin."},
                {"commands":"ingress oauth list|request|decision|register|revoke; ingress token rotate","description":"Manage this connection's OAuth access and bearer token."},
                {"commands":"app start|status|quit|restart; uninstall [--purge]","description":"Control the installed application. Install local builds from an independent terminal with npm run desktop:install in the source checkout."},
                {"commands":"ax import --from <path>; ax export --to <path>","description":"Import the interim AX queue or export retained AX history through local Core management. Paths must be absolute; export requires a new file in an existing directory outside ARC state."},
                {"commands":"subscriptions get|set|refresh|open","description":"Read or refresh subscription usage; set accepts JSON on stdin."},
                {"commands":"stats control [--since <duration>]; logs [--stdin|--follow|--offline]; watch; storage status|archive|prune|compact","description":"Inspect logs, watch changes, or inspect, archive, prune and compact local storage."},
                {"commands":"config get; config set --stdin","description":"Read or set device configuration. set accepts {maintainerMode:boolean}; default false, effective without restart."},
                {"commands":"configure --stdin; network --stdin; connect; disconnect; verify [--fresh]","description":"Configure and control the primary connection."},
                {"commands":"capabilities; schema <operation>; call <operation> [--stdin]; mcp","description":"Discover full operation schemas, execute an operation or serve local management MCP."},
                {"commands":"help; guide","description":"Show this compact index or the full CLI reference."}
            ],
            "note":"JSON output. Read cli schema <operation> for exact inputs and cli guide for command syntax. Credentials use stdin or ARC clipboard apply, never command arguments."}`

func runCLI(ctx context.Context, arguments []string, stdin io.Reader, stdout, stderr io.Writer) int {
	args := slices.DeleteFunc(slices.Clone(arguments), func(s string) bool { return s == "--json" })
	output := func(value object, code int) int {
		if err := outputLine(stdout, wire(value)); err != nil {
			return exitResult(stderr, err)
		}
		return code
	}
	failure := func(message, usage string, syntax bool) int {
		return output(cliErrorResponse(message, usage, args, syntax), 1)
	}
	if len(args) > 0 && args[0] == "--state-dir" {
		var path string
		var ok bool
		if len(args) >= 2 && filepath.IsAbs(args[1]) {
			path, _ = filepath.EvalSymlinks(args[1])
			if info, err := os.Stat(path); err == nil {
				ok = info.IsDir()
			}
		}
		if !ok {
			return failure("--state-dir requires an existing absolute directory", "cli --state-dir <absolute-directory> <command>", false)
		}
		if err := os.Setenv("ARC_STATE_DIR", path); err != nil {
			return failure(err.Error(), "", false)
		}
		args = args[2:]
	}
	if len(args) > 1 && args[len(args)-1] == "--help" {
		commands := []string{}
		extra := []string{"wait --op <operation> [--control] [--stdin] --until <condition> [--timeout <seconds>]",
			"app snapshot [--out <directory>] [--stdin]", "control guide [op] [--stdin]"}
		for _, command := range append(slices.Clone(cliCommands), extra...) {
			slots := strings.Fields(command)
			prefix := args[:len(args)-1]
			if len(prefix) > len(slots) {
				continue
			}
			matches := true
			for index, word := range prefix {
				if slots[index] != word && !strings.HasPrefix(slots[index], "<") && !strings.HasPrefix(slots[index], "[") {
					matches = false
					break
				}
			}
			if matches {
				commands = append(commands, "cli "+command)
			}
		}
		if len(commands) == 0 {
			return failure("Unknown command", "cli help", true)
		}
		return output(object{"schemaVersion": 1, "ok": true, "result": object{"commands": commands,
			"schema": "Use cli control guide <op> for control op arguments, or cli schema <operation> for management arguments. JSON arguments are read with --stdin."}}, 0)
	}
	usage, invalid := cliUsage(args)
	if invalid != "" {
		if message, corrected := stdinIDHint(args, stdin); corrected != "" {
			invalid, usage = message, corrected
		}
		return failure(invalid, usage, true)
	}
	if len(args) == 2 && args[0] == "local-mcp" {
		return exitResult(stderr, localMCP(ctx, args[1], stdin, stdout))
	}
	if len(args) == 1 && args[0] == "mcp" {
		return exitResult(stderr, managementStdio(ctx, stdin, stdout))
	}
	if len(args) == 1 && args[0] == "watch" || slices.Equal(args, []string{"logs", "--follow"}) {
		route, logs := "state.wait", args[0] == "logs"
		if logs {
			route = "logs.query"
		}
		cursor := ""
		for ctx.Err() == nil {
			value, err := managementCall(ctx, route, object{"body": object{"cursor": cursor}})
			if err != nil {
				fmt.Fprintln(stderr, err)
				return 1
			}
			cursor = text(value, "cursor")
			if !logs || len(arr(field(value, "rows"))) > 0 {
				if err := outputLine(stdout, wire(object{"ok": true, "result": value})); err != nil {
					return exitResult(stderr, err)
				}
			}
			if logs {
				select {
				case <-time.After(time.Second):
				case <-ctx.Done():
				}
			}
		}
		return 0
	}
	value, err := executeCLI(ctx, args, stdin)
	if err != nil {
		if len(args) > 0 && (args[0] == "control" || args[0] == "wait") {
			var detail any
			if unmarshalJSON([]byte(err.Error()), &detail) == nil {
				value := object{"error": detail}
				nextControl(value, cliOperationArg(args), object{}, false)
				compactOutcomeError(value)
				return output(object{"schemaVersion": 1, "ok": false, "error": value["error"], "next": value["next"]}, 1)
			}
		}
		return failure(err.Error(), usage, false)
	}
	if result := obj(value); outcomeError(result) != nil {
		compactOutcomeError(result)
		if result["next"] == nil {
			result["next"] = field(result["lastResult"], "next")
		}
		nextControl(result, cliOperationArg(args), object{}, false)
		detail := result["error"]
		delete(result, "error")
		next := result["next"]
		delete(result, "next")
		return output(object{"schemaVersion": 1, "ok": false, "error": detail, "next": next, "result": result}, 1)
	}
	return output(object{"schemaVersion": 1, "ok": true, "result": value}, 0)
}

func cliUsage(args []string) (usage, invalid string) {
	if len(args) == 0 || slices.Equal(args, []string{"--help"}) {
		return "cli help", ""
	}
	if args[0] == "wait" || len(args) > 1 && args[0] == "app" && args[1] == "snapshot" {
		return cliObservationUsage(args)
	}
	if len(args) == 3 && args[0] == "control" && args[1] == "guide" && !strings.HasPrefix(args[2], "-") {
		return "cli control guide [op]", ""
	}
	if args[0] == "setup" && slices.Contains(args, "--locale") {
		normalized, _, err := splitSetupLocale(args)
		if err != nil {
			return "cli setup next|apply|wait [--locale zh-CN|en]", err.Error()
		}
		usage, invalid := cliUsage(normalized)
		if invalid == "" {
			usage += " [--locale zh-CN|en]"
		}
		return usage, invalid
	}
	if args[0] == "setup" && (len(args) == 1 || args[1] == "--goal") {
		return cliUsage(append([]string{"setup", "next"}, args[1:]...))
	}
	candidates := slices.Clone(cliCommands)
	depth := 0
	for {
		choices := map[string]bool{}
		for _, command := range candidates {
			slots := strings.Fields(command)
			if depth < len(slots) && !strings.ContainsAny(slots[depth][:1], "<[-") {
				choices[slots[depth]] = true
			}
		}
		if len(choices) == 0 {
			break
		}
		options := []string{}
		for choice := range choices {
			options = append(options, choice)
		}
		slices.Sort(options)
		usage = strings.Join(append([]string{"cli"}, args[:depth]...), " ") + " <subcommand>. Available subcommands: " + strings.Join(options, "、") + ". See cli help for full usage."
		if depth == len(args) {
			return usage, "Missing subcommand"
		}
		if word := args[depth]; !choices[word] {
			if strings.HasPrefix(word, "-") {
				return usage, cliFlagError(word)
			}
			return usage, fmt.Sprintf("Unknown subcommand %q", word)
		}
		candidates = slices.DeleteFunc(candidates, func(command string) bool {
			slots := strings.Fields(command)
			return depth >= len(slots) || slots[depth] != args[depth]
		})
		depth++
	}
	options := []string{}
	for _, command := range candidates {
		options = append(options, "cli "+command)
	}
	usage = strings.Join(options, "；")
	invalid = "Arguments do not match"
	bestIndex := depth
	for _, command := range candidates {
		slots := strings.Fields(command)
		for index := depth; index <= max(len(slots), len(args)); index++ {
			if index == max(len(slots), len(args)) {
				return "cli " + command, ""
			}
			var slot, arg, message string
			if index < len(slots) {
				slot = slots[index]
			}
			if index < len(args) {
				arg = args[index]
			}
			optional := strings.HasPrefix(slot, "[")
			expected := strings.Trim(slot, "[]")
			switch {
			case index >= len(args) && optional, slot != "" && expected == arg:
				continue
			case index >= len(args):
				message = "Missing argument " + expected
			case index < len(args) && !strings.HasPrefix(arg, "-") && (strings.HasPrefix(expected, "<") || optional && !strings.HasPrefix(expected, "-")):
				continue
			case strings.HasPrefix(arg, "-"):
				switch {
				case strings.HasPrefix(slot, "<") && slices.Contains(slots, arg):
					message = "Missing argument " + slot + " (required before " + arg + ")"
				case slices.Contains(slots, arg):
					message = "Unexpected or duplicate option " + arg
				default:
					message = cliFlagError(arg)
				}
			case slot == "":
				message = fmt.Sprintf("Unexpected positional argument (argument %d after cli)", index+1)
			default:
				message = fmt.Sprintf("Argument %d after cli must be %s, not an extra positional argument", index+1, expected)
			}
			if index >= bestIndex {
				bestIndex, invalid = index, message
				if index > depth {
					usage = "cli " + command
				}
			}
			break
		}
	}
	if len(args) >= 2 && args[0] == "ingress" && args[1] == "update" && (len(args) == 2 || strings.HasPrefix(args[2], "-")) {
		invalid += ". id MUST be a command argument after update. Move id from stdin to the command arguments. stdin accepts only patch fields to change."
	}
	return usage, invalid
}

func cliFlagError(input string) string {
	flag, _, _ := strings.Cut(input, "=")
	normalized := strings.NewReplacer("-", "", "_", "").Replace(strings.ToLower(flag))
	switch normalized {
	case "bearertoken", "clientsecret", "apikey", "cloudflaretoken", "ngrokauthtoken":
		return fmt.Sprintf("Command-line secret option %s is not accepted. Secrets could appear in shell history or process lists. Supply JSON through --stdin.", flag)
	}
	return "Unknown option " + flag + ". Use the listed options."
}

func stdinIDHint(args []string, input io.Reader) (string, string) {
	for _, command := range cliCommands {
		slots := strings.Fields(command)
		index := slices.Index(slots, "<id>")
		if index < 0 || !slices.Contains(slots, "--stdin") || !slices.Equal(slices.Delete(slices.Clone(slots), index, index+1), args) {
			continue
		}
		body, err := stdinJSON(input)
		value, ok := body["id"].(string)
		if err != nil || !ok {
			return "", ""
		}
		slots[index] = value
		if value == "" || strings.ContainsFunc(value, func(r rune) bool {
			return !(r >= '0' && r <= '9' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || strings.ContainsRune("_./:@+-", r))
		}) {
			slots[index] = "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
		}
		return fmt.Sprintf("Found id=%s in stdin. Move it to the command arguments. stdin accepts only patch fields to change.", wire(value)),
			"cli " + strings.Join(slots, " ")
	}
	return "", ""
}

func cliOperationArg(args []string) string {
	if len(args) > 1 {
		return args[1]
	}
	return ""
}

var cliOperationName = regexp.MustCompile(`^[A-Za-z0-9_]+$`)

func cliControlHint(op string) string {
	if cliOperationName.MatchString(op) {
		return "arc cli control guide " + op
	}
	return "arc cli control guide"
}

func cliErrorResponse(message, usage string, args []string, syntax bool) object {
	code := managementErrorCode(message)
	if code == "SOURCE_REVOKED" || code == "SOURCE_REMOVED" || code == "LOCAL_SOURCE_PROTECTED" {
		recovery := "Open ARC Remote link and inspect the source and ingress named in the error. Add and authorize a new control source if revoked; use Change connection if its connection was removed. For built-in Local CLI/panel, restart the upgraded ARC app and retry to repair local authority."
		if code == "LOCAL_SOURCE_PROTECTED" {
			recovery = "Local CLI and panel share built-in authority and cannot be disconnected. Select an external control source in ARC Remote link."
		}
		if message == code {
			message = code + ": Source authorization is unavailable. " + recovery
		}
		return object{"schemaVersion": 1, "ok": false, "error": object{"code": code, "message": message}, "next": object{"op": nil, "hint": recovery}}
	}
	if message == "ingress not found" {
		message = "Ingress"
		if len(args) > 2 && args[0] == "ingress" {
			index := 2
			if args[1] == "oauth" || args[1] == "token" {
				index++
			}
			if index < len(args) {
				message += " id=" + wire(args[index])
			}
		}
		message += " not found. Run cli ingress list for available ingresses."
	} else if message == "UNKNOWN_OPERATION" {
		var op any
		if len(args) > 1 {
			op = args[1]
		}
		message = fmt.Sprintf("Unknown operation %s. Run cli capabilities for available operations.", wire(op))
	}
	hint := "Inspect the reported runtime failure, then retry the operation."
	detail := object{"code": code, "message": message}
	if syntax || code == "INVALID_ARGUMENT" || code == "UNKNOWN_OPERATION" || strings.HasPrefix(message, "Invalid stdin JSON") ||
		strings.HasPrefix(message, "Standard input must be") || strings.HasPrefix(message, "Input exceeds") ||
		strings.HasPrefix(message, "Unknown fields:") || strings.HasPrefix(message, "A patch cannot contain id") ||
		strings.HasPrefix(message, "Command arguments do not match") {
		separator := ". "
		if strings.HasSuffix(message, ".") {
			separator = " "
		}
		detail["message"] = message + separator + "Correct usage: " + usage
		detail["usage"] = usage
		hint = "Correct the command using " + usage + ", then retry."
		if len(args) > 0 && args[0] == "control" {
			op := cliOperationArg(args)
			if op == "guide" {
				op = cliOperationArg(args[1:])
			}
			detail["cliHint"] = cliControlHint(op)
		}
		if len(args) > 1 && args[0] == "ingress" && args[1] == "update" {
			detail["message"] = str(detail["message"]) + `. Minimal valid stdin example: {"enabled":false}`
			detail["example"] = object{"enabled": false}
		}
	}
	return object{"schemaVersion": 1, "ok": false, "error": detail, "next": object{"via": "query", "op": "guide", "args": object{}, "hint": hint}}
}

func jsonType(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case object:
		return "object"
	case []any:
		return "array"
	case string:
		return "string"
	default:
		return "number"
	}
}

func stdinJSON(input io.Reader) (object, error) {
	data, err := io.ReadAll(io.LimitReader(input, 16385))
	if err != nil || !utf8.Valid(data) {
		return nil, errors.New("Cannot read standard input")
	}
	if len(data) > 16384 {
		return nil, errors.New("Input exceeds 16 KiB")
	}
	var value any
	if err := unmarshalJSON(data, &value); err != nil {
		var syntax *json.SyntaxError
		offset := len(data)
		if errors.As(err, &syntax) {
			offset = min(int(syntax.Offset), len(data))
		}
		prefix := string(data[:offset])
		line := strings.Count(prefix, "\n") + 1
		column := offset - (strings.LastIndexByte(prefix, '\n') + 1)
		return nil, fmt.Errorf("Invalid stdin JSON at line %d, column %d. Check JSON syntax.", line, column)
	}
	if row := obj(value); row != nil {
		return row, nil
	}
	return nil, fmt.Errorf("Standard input must be a JSON object, got %s", jsonType(value))
}

func splitSetupLocale(args []string) ([]string, string, error) {
	if args[0] != "setup" {
		return args, "", nil
	}
	at := slices.Index(args, "--locale")
	if at < 0 {
		return args, "", nil
	}
	if at+1 == len(args) {
		return nil, "", errors.New("INVALID_ARGUMENT: --locale requires zh-CN or en")
	}
	locale := args[at+1]
	if locale != "en" && locale != "zh-CN" {
		return nil, "", errors.New("INVALID_ARGUMENT: --locale must be zh-CN or en")
	}
	args = slices.Delete(slices.Clone(args), at, at+2)
	if slices.Contains(args, "--locale") || len(args) > 1 && (args[1] == "reset" || args[1] == "playbook") {
		return nil, "", errors.New("INVALID_ARGUMENT: --locale is supported once on setup next/apply/wait")
	}
	return args, locale, nil
}

func executeCLI(ctx context.Context, args []string, stdin io.Reader) (any, error) {
	if len(args) == 0 || slices.Equal(args, []string{"help"}) || slices.Equal(args, []string{"--help"}) {
		var help object
		if err := decodeObject([]byte(cliHelpJSON), &help); err != nil {
			return nil, err
		}
		help["version"] = buildVersion
		return help, nil
	}
	read := func(route string) (any, error) { return forwardRequest(ctx, route, http.MethodGet, nil) }
	args, setupLocale, err := splitSetupLocale(args)
	if err != nil {
		return nil, err
	}
	var body object
	if slices.Contains(args, "--stdin") && args[0] != "wait" && !(len(args) > 1 && args[0] == "app" && args[1] == "snapshot") {
		value, err := stdinJSON(stdin)
		if err != nil {
			return nil, err
		}
		body = value
	}
	switch args[0] {
	case "guide":
		return object{"markdown": reference.CLI}, nil
	case "capabilities":
		catalog := clone(managementCatalog())
		catalog["cliOnly"] = resource("cli_acceptance.json")
		return catalog, nil
	case "schema":
		if schema, found := resource("cli_acceptance.json")[args[1]]; found {
			return schema, nil
		}
		if schema := find(managementCatalog()["operations"], "name", args[1]); schema != nil {
			return schema, nil
		}
		return nil, errors.New("UNKNOWN_OPERATION")
	case "call":
		if body == nil {
			body = object{}
		}
		return managementCall(ctx, args[1], body)
	case "install-shim":
		return installShim(ctx)
	case "status":
		return read("status")
	case "stats":
		since := "1d"
		if len(args) == 4 {
			since = args[3]
		}
		return controlMetricsReport(since)
	case "logs":
		if len(args) > 1 && args[1] == "--offline" {
			return queryLogs(object{})
		}
		if body == nil {
			body = object{}
		}
		return managementCall(ctx, "logs.query", object{"body": body})
	case "control":
		if body == nil {
			body = object{}
		}
		if len(args) == 3 && args[1] == "guide" && args[2] != "--stdin" {
			body["op"] = args[2]
		}
		value, err := forwardRequest(ctx, "cli/control", http.MethodPost, cliDispatchRequest(args[1], body))
		if err != nil {
			return nil, err
		}
		result, err := egressToolValue(value)
		if err != nil {
			return nil, err
		}
		if row := obj(result); row != nil && field(value, "isError") == true && outcomeError(row) == nil {
			if detail := obj(row["error"]); detail != nil {
				op := args[1]
				if op == "guide" {
					op = text(body, "op")
				}
				detail["cliHint"] = cliControlHint(op)
			}
			row["ok"] = false
		}
		return result, nil
	case "config":
		if args[1] == "get" {
			value, err := read("preferences")
			if err != nil {
				return nil, err
			}
			return object{"maintainerMode": field(value, "maintainer-mode") == "on"}, nil
		}
		if err := knownCLIFields(body, []string{"maintainerMode"}, ""); err != nil {
			return nil, err
		}
		enabled, ok := body["maintainerMode"].(bool)
		if !ok {
			return nil, errors.New("INVALID_ARGUMENT: maintainerMode must be a boolean")
		}
		mode := "off"
		if enabled {
			mode = "on"
		}
		value, err := forwardRequest(ctx, "preferences", http.MethodPut, object{"values": object{"maintainer-mode": mode}})
		if err != nil {
			return nil, err
		}
		return object{"maintainerMode": field(value, "maintainer-mode") == "on"}, nil
	case "ingress":
		if args[1] == "presets" {
			return object{"curated": sourcePresets(), "custom": sourcePreset("custom")}, nil
		}
	case "app":
		if args[1] != "snapshot" {
			return managementCall(ctx, "app."+args[1], object{})
		}
		return externalCLI(ctx, args, body, stdin)
	}
	return executeCLIRoute(ctx, args, body, setupLocale, stdin)
}

func cliCommandLine(args []string, input object) string {
	quote := func(value string) string {
		replacement := "'\"'\"'"
		if operatingSystem == "windows" {
			replacement = "''"
		}
		return "'" + strings.ReplaceAll(value, "'", replacement) + "'"
	}
	binary, err := runtimeBinary()
	if err != nil {
		binary = "arc"
	}
	parts := make([]string, len(args))
	for i, arg := range args {
		parts[i] = quote(arg)
	}
	command := "ARC_STATE_DIR=" + quote(root()) + " " + quote(binary) + " cli " + strings.Join(parts, " ")
	if operatingSystem == "windows" {
		command = "& { $env:ARC_STATE_DIR = " + quote(root()) + "; $input | & " + quote(binary) + " cli " + strings.Join(parts, " ") + " }"
		if input != nil {
			command = quote(wire(input)) + " | " + command
		}
	} else if input != nil {
		command = "printf '%s' " + quote(wire(input)) + " | " + command
	}
	return command
}

type cliExtension func(context.Context, []string, object, io.Reader) (any, error)

var cliExtensions = make(map[string]cliExtension)

func registerCLI(command string, execute cliExtension) {
	if execute == nil || cliExtensions[command] != nil {
		panic("Invalid or duplicate CLI command " + command)
	}
	cliExtensions[command] = execute
}

func externalCLI(ctx context.Context, args []string, body object, stdin io.Reader) (any, error) {
	name := strings.Join(args[:min(2, len(args))], " ")
	if run := cliExtensions[name]; run != nil {
		return run(ctx, args, body, stdin)
	}
	if run := cliExtensions[args[0]]; run != nil {
		return run(ctx, args, body, stdin)
	}
	return nil, errors.New("Unknown command")
}

func executeCLIRoute(ctx context.Context, args []string, body object, setupLocale string, stdin io.Reader) (any, error) {
	action := ""
	if len(args) > 1 {
		action = args[1]
	}
	request := func(route, method string, input object) (any, error) {
		return forwardRequest(ctx, route, method, input)
	}
	get := func(route string) (any, error) { return request(route, http.MethodGet, nil) }
	call := func(name string, input object) (any, error) {
		if input == nil {
			return managementCall(ctx, name, object{})
		}
		return managementCall(ctx, name, object{"body": input})
	}
	switch args[0] {
	case "stats", "control", "logs", "config", "status", "guide", "capabilities", "schema", "call":
		return nil, errors.New("Command arguments do not match. Check usage.")
	case "device":
		switch action {
		case "offer", "pending", "approve", "decline":
			return call("device."+action, nil)
		case "pair":
			return call("device.pair", object{"pairingString": args[2]})
		case "revoke":
			return call("device.revoke", object{"deviceId": args[2]})
		case "address":
			var address any
			if args[3] != "--clear" {
				address = args[3]
			}
			return call("device.address", object{"device": args[2], "address": address})
		case "configure":
			return call("device.configure", body)
		}
	case "setup":
		input := object{}
		if setupLocale != "" {
			input["locale"] = setupLocale
		}
		switch action {
		case "", "next", "--goal":
			for i, command := range args {
				if command == "--goal" && i+1 < len(args) {
					input["goal"] = args[i+1]
				}
			}
			return call("setup.next", input)
		case "apply":
			input["stepId"], input["input"] = args[2], body
			return call("setup.apply", input)
		case "wait":
			if len(args) == 4 {
				seconds, err := strconv.ParseUint(args[3], 10, 64)
				if err != nil {
					return nil, errors.New("INVALID_ARGUMENT: timeout must be seconds")
				}
				input["timeout"] = seconds
			}
			return call("setup.wait", input)
		case "reset":
			return request("setup/reset", http.MethodDelete, nil)
		}
	case "source":
		if action == "list" {
			return get("source")
		}
		route := "source/" + args[2]
		switch action {
		case "update":
			return request(route, http.MethodPut, body)
		case "disconnect", "claim":
			return request(route+"/"+action, http.MethodPost, body)
		case "switch":
			if args[3] == "--cancel" {
				return request(route+"/switch", http.MethodDelete, nil)
			}
			return request(route+"/switch", http.MethodPost, object{"ingressId": args[3]})
		}
	case "ax":
		return request("ax/"+action, http.MethodPost, object{strings.TrimPrefix(args[2], "--"): args[3]})
	case "storage":
		switch action {
		case "compact":
			return compactWithCoreLease(ctx)
		case "status":
			return get("storage/status")
		case "archive":
			return request("storage/archive", http.MethodPost, object{"apply": slices.Contains(args[2:], "--apply")})
		case "prune":
			olderDays := storageDefaultPruneOlderDays
			if idx := slices.Index(args[2:], "--older-than"); idx >= 0 && idx+3 < len(args) {
				raw := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(args[idx+3])), "d")
				parsed, err := strconv.Atoi(raw)
				if err != nil || parsed <= 0 {
					return nil, errors.New("INVALID_ARGUMENT: --older-than expects a positive day count such as 90 or 90d")
				}
				olderDays = parsed
			}
			return request("storage/prune", http.MethodPost, object{
				"apply":          slices.Contains(args[2:], "--apply"),
				"olderThanDays":  olderDays,
				"includeLegacy":  slices.Contains(args[2:], "--include-legacy"),
				"includeOutputs": slices.Contains(args[2:], "--include-outputs"),
			})
		}
	case "context":
		return request("context", http.MethodPost, body)
	case "configure":
		return request("config/tunnel", http.MethodPatch, body)
	case "network":
		return request("network", http.MethodPut, body)
	case "connect":
		return request("start", http.MethodPost, nil)
	case "disconnect":
		return request("stop", http.MethodPost, nil)
	case "subscriptions":
		switch action {
		case "get":
			return get("subscriptions")
		case "set":
			return request("subscriptions/settings", http.MethodPut, body)
		case "refresh", "open":
			input := object{}
			if len(args) > 2 {
				input["providerId"] = args[2]
			}
			return request("subscriptions/"+action, http.MethodPost, input)
		}
	case "doctor":
		status, err := get("status")
		if err != nil {
			return nil, err
		}
		permissions, err := get("permissions/passive")
		if err != nil {
			return nil, err
		}
		rows := []object{}
		for _, item := range arr(field(status, "ingresses")) {
			ingress := obj(item)
			row := selectFields(ingress, "id", "state", "error", "verification")
			row["configured"] = field(ingress["config"], "configured")
			row["diagnostics"], row["preset"], row["onboarding"] = ingressDiagnostics(ingress), sourcePreset(text(ingress, "controlSource")), cliOnboarding(ingress)
			rows = append(rows, row)
		}
		core := field(status, "core")
		return object{"permissions": permissions, "ingresses": rows, "summary": field(status, "ingressSummary"),
			"desktop": field(core, "desktop"), "appServer": field(core, "appServer"), "resources": field(core, "resources"),
			"executionVerified": false, "diagnostics": field(status, "diagnostics")}, nil
	case "verify", "onboarding":
		items, err := get("ingress")
		if err != nil {
			return nil, err
		}
		if action == "--fresh" {
			for _, item := range arr(items) {
				if _, err := request("ingress/"+text(item, "id")+"/verification/reset", http.MethodPost, nil); err != nil {
					return nil, err
				}
			}
			return get("ingress")
		}
		rows := []object{}
		for _, item := range arr(items) {
			rows = append(rows, cliOnboarding(obj(item)))
		}
		return object{"ingresses": rows}, nil
	case "ingress":
		switch action {
		case "list":
			value, err := get("ingress")
			if err != nil {
				return nil, err
			}
			for _, item := range arr(value) {
				obj(item)["preset"] = sourcePreset(text(item, "controlSource"))
			}
			return value, nil
		case "add", "update":
			if err := validateCLIIngress(body, action == "update"); err != nil {
				return nil, err
			}
			if action == "add" {
				return request("ingress", http.MethodPost, body)
			}
			return request("ingress/"+args[2], http.MethodPut, body)
		case "remove":
			return request("ingress/"+args[2], http.MethodDelete, nil)
		case "start", "stop", "restart", "probe":
			return request("ingress/"+args[2]+"/"+action, http.MethodPost, nil)
		case "start-all", "stop-all":
			return request("ingress/"+action, http.MethodPost, nil)
		case "token":
			return request("ingress/"+args[3]+"/token", http.MethodPost, nil)
		case "oauth":
			route := "ingress/" + args[3] + "/oauth"
			switch args[2] {
			case "list":
				return get(route)
			case "request":
				return get(route + "/request/" + args[4])
			default:
				return request(route+"/"+args[2], http.MethodPost, body)
			}
		case "verify":
			route := "ingress/" + args[2]
			if len(args) == 4 {
				if _, err := request(route+"/verification/reset", http.MethodPost, nil); err != nil {
					return nil, err
				}
			}
			value, err := get(route)
			if err != nil {
				return nil, err
			}
			onboarding := cliOnboarding(obj(value))
			if len(args) == 4 {
				return onboarding, nil
			}
			return object{"ingress": value, "onboarding": onboarding}, nil
		case "doctor":
			value, err := get("status")
			if err != nil {
				return nil, err
			}
			row := find(field(value, "ingresses"), "id", args[2])
			if row == nil {
				return nil, errors.New("ingress not found")
			}
			findings := []any{}
			for _, entry := range arr(field(field(value, "diagnostics"), "findings")) {
				scope := field(entry, "scope")
				if text(scope, "id") == args[2] || text(scope, "ingressId") == args[2] {
					findings = append(findings, entry)
				}
			}
			return object{"ingress": row, "onboarding": cliOnboarding(row), "findings": findings}, nil
		}
	}
	return externalCLI(ctx, args, body, stdin)
}

func cliOnboarding(ingress object) object {
	config, verification := obj(ingress["config"]), obj(ingress["verification"])
	stage := "client_setup_or_verify"
	switch {
	case config["configured"] != true:
		stage = "configure"
	case ingress["state"] != "ready":
		stage = "start"
	default:
		if _, ok := verification["challengeVerifiedAt"].(string); ok {
			stage = "inbound_verified"
		}
	}
	return object{"ingressId": ingress["id"], "controlSource": ingress["controlSource"], "stage": stage, "transport": ingress["transport"],
		"authentication": ingress["auth"], "url": ingress["url"], "tunnelId": config["tunnelId"], "verification": verification,
		"diagnostics": ingressDiagnostics(ingress), "preset": sourcePreset(text(ingress, "controlSource")),
		"verificationPrompt": fmt.Sprintf("Call act with %s. Verify the connection only. Do not create a task.",
			wire(object{"op": "connector_verify", "args": object{"code": verification["code"]}})),
		"executionPrompt": "Call guide first. Use codex_create for Codex. For an executable Agent, use agent_create with agent:\"antigravity\" or agent:\"pi\". Create one harmless task with purpose:\"self-test\" and notify:null. The task MUST NOT call tools or read or modify files. It MUST reply only ARC_ONBOARDING_OK. Omit requestId to have ARC generate it, then retain the returned receipt requestId. Read its taskId and turnId through act({op:receipt,args:{requestId}}). For an executable Agent, call query agent_wait with the same agent, taskId, and turnId, then query agent_read with that agent and taskId. Use codex_wait and codex_read for Codex. On timeout, retain the original IDs and previous snapshotHash as expectedHash. Continue until terminal or interaction. Timeout does not terminate the task. Do not create it again.",
		"identityNote":    "Ingress controlSource is an initial product default. Authenticated calls resolve a credential-anchored sourceId; origin.controlSource is that source product. Bearer clients sharing one connection share one source.",
		"clientSetup":     "Read preset.status, supportedAuth and caveat before connecting. Conditional paths require client verification; auth-limited paths must not silently fall back to none. A preset is not an installed integration.",
		"secretDelivery":  "Supply credentials using stdin or a protected local file. Never paste tokens into chat or use command-line arguments."}
}

func knownCLIFields(value object, allowed []string, prefix string) error {
	unknown := []string{}
	for _, key := range keys(value) {
		if !slices.Contains(allowed, key) {
			unknown = append(unknown, prefix+key)
		}
	}
	if len(unknown) != 0 {
		return fmt.Errorf("Unknown fields: %s. Allowed fields: %s%s", strings.Join(unknown, "、"), prefix, strings.Join(allowed, "、"+prefix))
	}
	return nil
}

func expectCLIType(field string, value any, expected string) error {
	if got := jsonType(value); got != expected {
		return fmt.Errorf("Invalid type for %s: expected %s, got %s", field, expected, got)
	}
	return nil
}

func validateCLIIngress(body object, patch bool) error {
	allowed := []string{"name", "controlSource", "transport", "auth", "bearerToken", "enabled", "toolPolicy", "config"}
	if !patch {
		allowed = append(allowed, "id")
	} else if _, exists := body["id"]; exists {
		return errors.New("A patch cannot contain id. Put id in the command arguments after update. stdin accepts only patch fields to change.")
	}
	if err := knownCLIFields(body, allowed, ""); err != nil {
		return err
	}
	for _, key := range keys(body) {
		value := body[key]
		switch key {
		case "enabled":
			if err := expectCLIType(key, value, "boolean"); err != nil {
				return err
			}
		case "config":
			if err := expectCLIType(key, value, "object"); err != nil {
				return err
			}
			defaults := ingressConfigDefaults()
			if err := knownCLIFields(obj(value), keys(defaults), "config."); err != nil {
				return err
			}
			for _, name := range keys(obj(value)) {
				if err := expectCLIType("config."+name, field(value, name), jsonType(defaults[name])); err != nil {
					return err
				}
			}
		case "toolPolicy":
			if value == "all" {
				continue
			}
			if obj(value) == nil {
				return fmt.Errorf("toolPolicy must be the string \"all\" or an object, got %s", jsonType(value))
			}
			if err := knownCLIFields(obj(value), []string{"allowlist"}, "toolPolicy."); err != nil {
				return err
			}
			if err := expectCLIType("toolPolicy.allowlist", field(value, "allowlist"), "array"); err != nil {
				return err
			}
			for index, item := range arr(field(value, "allowlist")) {
				if err := expectCLIType(fmt.Sprintf("toolPolicy.allowlist[%d]", index), item, "string"); err != nil {
					return err
				}
			}
		default:
			if err := expectCLIType(key, value, "string"); err != nil {
				return err
			}
		}
	}
	return nil
}

func compactWithCoreLease(ctx context.Context) (any, error) {
	binary, err := runtimeBinary()
	if err != nil {
		return nil, err
	}
	client, err := connectRuntimeClient(ctx, binary, "cli")
	if err != nil {
		return nil, err
	}
	defer client.close(context.WithoutCancel(ctx))
	return compactEventArchives()
}
