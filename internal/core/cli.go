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
	"slices"
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
                {"commands":"stats control [--since <duration>]; logs [--stdin|--follow|--offline]; watch; storage compact","description":"Inspect logs, watch changes or compact local storage."},
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
			fmt.Fprintln(stderr, err)
			return 1
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
		return failure(invalid, usage, true)
	}
	if len(args) == 1 && args[0] == "mcp" {
		if err := managementStdio(ctx, stdin, stdout); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		return 0
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
				if code := output(object{"ok": true, "result": value}, 0); code != 0 {
					return code
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
		return failure(err.Error(), usage, false)
	}
	if detail := obj(field(value, "error")); detail != nil {
		result := obj(value)
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
		return "cli help; cli schema wait; cli schema app.snapshot", ""
	}
	if len(args) == 3 && args[0] == "control" && args[1] == "guide" && !strings.HasPrefix(args[2], "-") {
		return "cli control guide [op]", ""
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
	if message == "UNKNOWN_OPERATION" {
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
		value, err := forwardRequest(ctx, "cli/control", http.MethodPost, object{"op": args[1], "args": body})
		if err != nil {
			return nil, err
		}
		for _, content := range arr(field(value, "content")) {
			if field(content, "type") != "text" {
				continue
			}
			var result any
			if err := unmarshalJSON([]byte(text(content, "text")), &result); err != nil {
				return nil, fmt.Errorf("Invalid ARC tool result JSON: %w", err)
			}
			return result, nil
		}
		return nil, errors.New("Invalid ARC tool result: expected JSON text content")
	case "config":
		if args[1] == "get" {
			value, err := read("preferences")
			if err != nil {
				return nil, err
			}
			return object{"maintainerMode": field(value, "maintainer-mode") == "on"}, nil
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
	}
	return nil, errors.New(PortPending)
}
