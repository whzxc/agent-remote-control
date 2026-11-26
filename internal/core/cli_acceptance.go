package core

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

type cliObservationOptions struct {
	op, out        string
	hasOut         bool
	control, stdin bool
	timeout        time.Duration
	conditions     []cliObservationCondition
}

type cliObservationCondition struct {
	pointer, comparison string
	value               any
}

func parseCLIObservationCondition(input string) (cliObservationCondition, error) {
	input = strings.TrimSpace(input)
	var condition cliObservationCondition
	if pointer, exists := strings.CutSuffix(input, "exists"); exists {
		condition.pointer, condition.comparison = strings.TrimSpace(pointer), "exists"
	} else {
		index := len(input)
		for _, comparison := range []string{"==", "!="} {
			if start := strings.Index(input, comparison); start >= 0 && start < index {
				index, condition.comparison = start, comparison
			}
		}
		if condition.comparison == "" {
			return condition, errors.New("INVALID_ARGUMENT: condition needs ==, != or exists")
		}
		condition.pointer = strings.TrimSpace(input[:index])
		if err := unmarshalJSON([]byte(strings.TrimSpace(input[index+2:])), &condition.value); err != nil {
			return condition, errors.New("INVALID_ARGUMENT: comparison value must be JSON (quote strings)")
		}
	}
	pointer := condition.pointer
	if pointer != "" && !strings.HasPrefix(pointer, "/") {
		return condition, errors.New("INVALID_ARGUMENT: expected JSON Pointer")
	}
	for index, byte := range []byte(pointer) {
		if byte == '~' && (index+1 == len(pointer) || (pointer[index+1] != '0' && pointer[index+1] != '1')) {
			return condition, errors.New("INVALID_ARGUMENT: invalid JSON Pointer escape")
		}
	}
	return condition, nil
}

func parseCLIObservationOptions(args []string) (cliObservationOptions, error) {
	options := cliObservationOptions{timeout: time.Minute}
	wait := args[0] == "wait"
	start := 2
	if wait {
		start = 1
	}
	seen := map[string]bool{}
	for index := start; index < len(args); index++ {
		flag := args[index]
		if seen[flag] && flag != "--until" {
			return options, fmt.Errorf("INVALID_ARGUMENT: duplicate %s", flag)
		}
		seen[flag] = true
		switch {
		case flag == "--stdin":
			options.stdin = true
		case flag == "--control" && wait:
			options.control = true
		case flag == "--out" && !wait:
			index++
			if index == len(args) {
				return options, errors.New("INVALID_ARGUMENT: --out requires a directory")
			}
			options.out, options.hasOut = args[index], true
		case wait && slices.Contains([]string{"--op", "--until", "--timeout"}, flag):
			index++
			if index == len(args) {
				return options, fmt.Errorf("INVALID_ARGUMENT: %s requires a value", flag)
			}
			value := args[index]
			switch flag {
			case "--op":
				options.op = value
			case "--until":
				condition, err := parseCLIObservationCondition(value)
				if err != nil {
					return options, err
				}
				options.conditions = append(options.conditions, condition)
			case "--timeout":
				seconds, err := strconv.ParseUint(strings.TrimPrefix(value, "+"), 10, 64)
				if err != nil || seconds < 1 || seconds > 1800 {
					return options, errors.New("INVALID_ARGUMENT: timeout must be 1..1800 seconds")
				}
				options.timeout = time.Duration(seconds) * time.Second
			}
		default:
			return options, fmt.Errorf("INVALID_ARGUMENT: unexpected argument %s", flag)
		}
	}
	if wait && (options.op == "" || len(options.conditions) == 0) {
		return options, errors.New("INVALID_ARGUMENT: --op and --until are required")
	}
	return options, nil
}

func cliObservationUsage(args []string) (string, string) {
	usage := "cli app snapshot [--out <directory>] [--stdin]"
	if args[0] == "wait" {
		usage = "cli wait --op <operation> [--control] [--stdin] --until <condition> [--until <condition>] [--timeout <seconds>]"
	}
	if _, err := parseCLIObservationOptions(args); err != nil {
		return usage, err.Error()
	}
	return usage, ""
}

func cliAppSnapshot(ctx context.Context, args []string, _ object, stdin io.Reader) (any, error) {
	options, err := parseCLIObservationOptions(args)
	if err != nil {
		return nil, err
	}
	body := object{}
	if options.stdin {
		body, err = stdinJSON(stdin)
		if err != nil {
			return nil, err
		}
	}
	if options.hasOut {
		output := options.out
		if !filepath.IsAbs(output) {
			cwd, err := os.Getwd()
			if err != nil {
				return nil, err
			}
			output = filepath.Join(cwd, output)
		}
		if body == nil {
			body = object{}
		}
		body["out"] = output
	}
	return managementCall(ctx, "app.snapshot", object{"body": body})
}

func cliObservationPointer(value any, pointer string) (any, bool) {
	if pointer == "" {
		return value, true
	}
	for token := range strings.SplitSeq(pointer[1:], "/") {
		token = strings.ReplaceAll(strings.ReplaceAll(token, "~1", "/"), "~0", "~")
		switch part := value.(type) {
		case object:
			var found bool
			value, found = part[token]
			if !found {
				return nil, false
			}
		case []any:
			index, err := strconv.ParseUint(token, 10, 64)
			if err != nil || index >= uint64(len(part)) || len(token) > 1 && token[0] == '0' {
				return nil, false
			}
			value = part[index]
		default:
			return nil, false
		}
	}
	return value, true
}

func validateCLIObservationRead(options cliObservationOptions, input object) error {
	const readOnly = "INVALID_ARGUMENT: wait requires a read-only op"
	if options.control {
		spec := operation(options.op)
		if spec == nil {
			return errors.New("UNKNOWN_OPERATION")
		}
		action, supplied := input["action"]
		receiptRead := options.op == "receipt" && (!supplied || action == "read")
		if field(spec["annotations"], "readOnlyHint") != true && !receiptRead {
			return errors.New(readOnly)
		}
		return nil
	}
	_, method, _, err := managementResolve(options.op, input)
	if err != nil {
		return err
	}
	body := obj(input["body"])
	snapshotRead := options.op == "app.snapshot" && body["modelOnly"] == true && len(body) == 1
	if method != http.MethodGet && !snapshotRead && options.op != "state.wait" && options.op != "logs.query" {
		return errors.New(readOnly)
	}
	return nil
}

func cliWait(ctx context.Context, args []string, _ object, stdin io.Reader) (any, error) {
	options, err := parseCLIObservationOptions(args)
	if err != nil {
		return nil, err
	}
	input := object{}
	if options.stdin {
		input, err = stdinJSON(stdin)
		if err != nil {
			return nil, err
		}
	}
	if err := validateCLIObservationRead(options, input); err != nil {
		return nil, err
	}
	start := time.Now()
	deadline := start.Add(options.timeout)
	wait, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	blocking := options.control && slices.Contains([]string{"codex_wait", "agent_wait", "inbox_wait"}, options.op)
	var last any
	for wait.Err() == nil {
		remaining := min(30000, max(1, time.Until(deadline).Milliseconds()-50))
		switch {
		case blocking:
			input["timeoutMs"] = remaining
		case options.op == "state.wait":
			body := obj(input["body"])
			if body == nil {
				body = object{}
				input["body"] = body
			}
			body["timeoutMs"] = remaining
			if cursor, ok := field(last, "cursor").(string); ok {
				body["cursor"] = cursor
			}
		}
		var value any
		if options.control {
			value, err = executeCLI(wait, []string{"control", options.op, "--stdin"}, strings.NewReader(wire(input)))
		} else {
			value, err = managementCall(wait, options.op, input)
		}
		if wait.Err() != nil {
			break
		}
		if err != nil {
			return nil, err
		}
		last = value
		matches := make([]object, 0, len(options.conditions))
		for _, condition := range options.conditions {
			value, present := cliObservationPointer(last, condition.pointer)
			if !present {
				break
			}
			comparison := condition.comparison
			if comparison != "exists" && (wire(value) == wire(condition.value)) != (comparison == "==") {
				break
			}
			matches = append(matches, object{"pointer": condition.pointer, "value": value})
		}
		matched := len(matches) == len(options.conditions)
		elapsed := time.Since(start).Milliseconds()
		if outcomeError(obj(last)) != nil {
			return object{"matched": matched, "reason": "operation-failed", "lastResult": last, "elapsedMs": elapsed}, nil
		}
		if matched {
			return object{"matched": matches, "elapsedMs": elapsed, "lastResult": last}, nil
		}
		select {
		case <-time.After(min(500*time.Millisecond, time.Until(deadline))):
		case <-wait.Done():
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return nil, errors.New(wire(object{"code": "WAIT_TIMEOUT", "message": "Conditions were not met before the deadline",
		"elapsedMs": time.Since(start).Milliseconds(), "lastResult": last}))
}

func init() {
	registerCLI("wait", cliWait)
	registerCLI("app snapshot", cliAppSnapshot)
}
