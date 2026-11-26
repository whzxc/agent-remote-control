package core

import (
	"context"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

func nativeShell(ctx context.Context) string {
	if operatingSystem == "windows" {
		if command, present := os.LookupEnv("COMSPEC"); present {
			return command
		}
		return "cmd.exe"
	}
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	uid := strconv.Itoa(os.Geteuid())
	if operatingSystem == "darwin" {
		wait, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		if output, err := commandOutput(wait, "/usr/bin/dscacheutil", "-q", "user", "-a", "uid", uid); err == nil {
			for line := range strings.SplitSeq(output, "\n") {
				if value, match := strings.CutPrefix(line, "shell: "); match && value != "" {
					return value
				}
			}
		}
	} else if users, err := os.ReadFile("/etc/passwd"); err == nil {
		for line := range strings.SplitSeq(string(users), "\n") {
			fields := strings.Split(line, ":")
			if len(fields) == 7 && fields[2] == uid && fields[6] != "" {
				return fields[6]
			}
		}
	}
	return "/bin/sh"
}

func runShellCommand(ctx context.Context, s *service, args object) (object, error) {
	directory, err := projectWorkingDirectory(ctx, s, args)
	if err != nil {
		return nil, err
	}
	cwd := str(directory)
	if !filepath.IsAbs(cwd) {
		return nil, errors.New("ABSOLUTE_CWD_REQUIRED")
	}
	canonical, _ := filepath.EvalSymlinks(cwd)
	if protectedPath(cwd) || canonical != "" && protectedPath(canonical) {
		if err := requireCommandAccess(commandDiskAccess(ctx, s)); err != nil {
			return nil, err
		}
	}
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		return nil, errors.New("ABSOLUTE_CWD_REQUIRED")
	}
	shell := nativeShell(ctx)
	command := []any{shell, "-lc", args["cmd"]}
	if operatingSystem == "windows" {
		command = []any{shell, "/d", "/s", "/c", args["cmd"]}
	}
	start := time.Now()
	timeout := uintOr(args["timeoutMs"], 60000)
	out, err := requestCodexNative(ctx, s, "command/exec", object{"command": command, "cwd": cwd, "timeoutMs": timeout, "disableOutputCap": true},
		time.Duration(timeout+5000)*time.Millisecond)
	if err != nil {
		return nil, err
	}
	result := object{"stdout": field(out, "stdout"), "stderr": field(out, "stderr"), "exitCode": field(out, "exitCode"),
		"durationMs": time.Since(start).Milliseconds(), "truncated": false}
	for _, key := range []string{"networkHint", "signal"} {
		if value, supplied := obj(out)[key]; supplied {
			result[key] = value
		}
	}
	return budgetShellOutput(result, args)
}

func budgetShellOutput(result, args object) (object, error) {
	budget, supplied := uintValue(args["outputBudget"])
	size := len(text(result, "stdout")) + len(text(result, "stderr"))
	limit := 64 * 1024
	if supplied && uint64(size) > budget {
		limit = 0
	}
	paged, err := pageOutput(result, limit)
	if err != nil {
		return nil, err
	}
	if output, present := field(paged, "outputId").(string); present {
		for _, key := range []string{"stdout", "stderr"} {
			value := text(result, key)
			end := min(len(value), 12000)
			if supplied {
				end = int(min(uint64(len(value)), budget))
			}
			for end < len(value) && !utf8.RuneStart(value[end]) {
				end--
			}
			if supplied {
				budget -= uint64(end)
			}
			result[key] = value[:end]
		}
		result["truncated"] = true
		result["output"] = object{"outputId": output, "offset": 0, "nextAction": "control_output", "format": "JSON with complete stdout/stderr",
			"expiresInSeconds": field(paged, "expiresInSeconds")}
	}
	return result, nil
}

func shellLocalNetworkHint(value, args any) object {
	result := text(value, "stdout") + "\n" + text(value, "stderr")
	if !strings.Contains(result, "EHOSTUNREACH") {
		return nil
	}
	for _, candidate := range strings.FieldsFunc(result+"\n"+wire(field(args, "command")), func(r rune) bool {
		return !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F' || r == '.' || r == ':')
	}) {
		address, err := netip.ParseAddr(candidate)
		if err != nil {
			if endpoint, err := netip.ParseAddrPort(candidate); err == nil {
				address = endpoint.Addr()
			}
		}
		ip := address.Unmap()
		if ip.IsPrivate() || ip.IsLinkLocalUnicast() {
			return object{"code": "MACOS_LOCAL_NETWORK_ACCESS",
				"likelyCause":            "macOS Local Network privacy or the Codex execution host's inherited sandbox may deny third-party binaries even when a system tool reaches the same LAN address.",
				"responsibleApplication": "Agent Remote Control for the bundled launch chain. Standalone hosts use their own launch identity.",
				"nextAction":             "Inspect System Settings > Privacy & Security > Local Network for the responsible application and the native command sandbox policy. An enabled ARC entry alone may not resolve this. Compare the same target with /usr/bin/curl and run the authorized command from Terminal if needed."}
		}
	}
	return nil
}

func init() {
	registerOperation("command", func(ctx context.Context, request operationRequest) (any, error) {
		if _, ok := request.args["cmd"].(string); !ok {
			return controlNativeDomain(ctx, request)
		}
		return runControlMutation(ctx, request, "command", request.args, func(ctx context.Context, row object) (any, error) {
			result, err := runShellCommand(ctx, request.service, obj(row["arguments"]))
			if err != nil && !errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil &&
				!strings.HasPrefix(err.Error(), "RPC_TIMEOUT:") && !strings.HasPrefix(err.Error(), "SUBMISSION_UNCONFIRMED") {
				row["next"] = errorNext("command", controlFailure(err))
			}
			return result, err
		})
	}, nil)
}
