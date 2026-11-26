package core

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
)

func nativeAgentSearchPaths() []string {
	paths := filepath.SplitList(os.Getenv("PATH"))
	home, _ := os.UserHomeDir()
	if home != "" {
		for _, suffix := range []string{".local/bin", ".opencode/bin", ".bun/bin", ".npm-global/bin", ".npm/bin", ".volta/bin", ".asdf/shims"} {
			paths = append(paths, filepath.Join(home, suffix))
		}
	}
	for _, key := range []string{"NPM_CONFIG_PREFIX", "npm_config_prefix", "BUN_INSTALL", "VOLTA_HOME"} {
		if prefix, found := os.LookupEnv(key); found {
			paths = append(paths, filepath.Join(prefix, "bin"))
		}
	}
	if home != "" {
		data, _ := os.ReadFile(filepath.Join(home, ".npmrc"))
		for line := range strings.SplitSeq(string(data), "\n") {
			key, value, found := strings.Cut(line, "=")
			if !found || strings.TrimSpace(key) != "prefix" {
				continue
			}
			prefix := strings.Trim(strings.TrimSpace(value), "\"'")
			if local, found := strings.CutPrefix(prefix, "~/"); found {
				prefix = filepath.Join(home, local)
			}
			if filepath.IsAbs(prefix) {
				paths = append(paths, filepath.Join(prefix, "bin"))
			}
		}
	}
	nvm := os.Getenv("NVM_DIR")
	if nvm == "" && home != "" {
		nvm = filepath.Join(home, ".nvm")
	}
	if nvm != "" {
		node := filepath.Join(nvm, "versions", "node")
		entries, _ := os.ReadDir(node)
		for _, entry := range slices.Backward(entries) {
			paths = append(paths, filepath.Join(node, entry.Name(), "bin"))
		}
	}
	if operatingSystem == "windows" {
		if dir, err := os.UserConfigDir(); err == nil {
			paths = append(paths, filepath.Join(dir, "npm"))
		}
	} else {
		paths = append(paths, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin")
	}
	return paths
}

func discoverAgentExecutables(name string, paths []string) []string {
	executable := func(path string) bool {
		info, err := os.Stat(path)
		return err == nil && info.Mode().IsRegular() && (operatingSystem == "windows" || info.Mode().Perm()&0111 != 0)
	}
	if filepath.IsAbs(name) {
		if executable(name) {
			return []string{name}
		}
		return nil
	}
	if strings.ContainsAny(name, `/\`) {
		return nil
	}
	suffixes := []string{""}
	if operatingSystem == "windows" {
		suffixes = []string{".exe", ".cmd", ".bat", ""}
	}
	var result []string
	for _, dir := range paths {
		for _, suffix := range suffixes {
			if path := filepath.Join(dir, name+suffix); executable(path) {
				result = append(result, path)
			}
		}
	}
	return result
}

func discoverAgentExecutable(name string) string {
	if binaries := discoverAgentExecutables(name, nativeAgentSearchPaths()); len(binaries) != 0 {
		return binaries[0]
	}
	return ""
}

func applyNativeAgentProxy(ctx context.Context, cmd *exec.Cmd) error {
	proxy, err := savedNetworkProxy(ctx)
	if err == nil {
		proxy.apply(cmd)
	}
	return err
}

func init() {
	accountAgentSearchPaths = nativeAgentSearchPaths
	accountAgentBinary = discoverAgentExecutable
	applyAccountCommandProxy = applyNativeAgentProxy
	launchSubscriptionAgent = func(ctx context.Context, binary string, args []string) (*exec.Cmd, error) {
		cmd := nativeCommand(ctx, binary, args...)
		cmd.Env = append(cmd.Environ(), "PATH="+strings.Join(nativeAgentSearchPaths(), string(os.PathListSeparator)))
		return cmd, nil
	}
}

type nativeAgentDriver struct {
	id, name, protocol string
	commands, args     []string
}

var nativeAgentDrivers = []nativeAgentDriver{
	{"antigravity", "Antigravity", "antigravity-stream-json", []string{"agy", "antigravity"}, nil},
	{"opencode", "OpenCode", "acp-v1", []string{"opencode"}, []string{"acp"}},
	{"gemini", "Gemini CLI", "acp-v1", []string{"gemini"}, []string{"--acp"}},
	{"cursor", "Cursor Agent", "acp-v1", []string{"agent", "cursor-agent"}, []string{"acp"}},
	{"pi", "Pi", "pi-rpc", []string{"pi"}, []string{"--mode", "rpc"}},
	{"codex", "Codex", "codex-native", []string{"codex"}, nil},
}

func nativeAgentDriverByID(id string) (nativeAgentDriver, bool) {
	for _, driver := range nativeAgentDrivers {
		if driver.id == id {
			return driver, true
		}
	}
	return nativeAgentDriver{}, false
}

type nativeAgentDiscovery struct {
	binary, version string
	err             error
}

type nativeAgentProbe struct {
	stamp  *fileStamp
	result nativeAgentDiscovery
}

var nativeAgentProbes sync.Map

func (driver nativeAgentDriver) discover(ctx context.Context) nativeAgentDiscovery {
	commands := driver.commands
	forced := false
	if driver.id == "antigravity" {
		if path := os.Getenv("ARC_ANTIGRAVITY_BIN"); path != "" {
			commands, forced = []string{path}, true
		}
	}
	var first nativeAgentDiscovery
	checked := map[string]bool{}
	var binaries []string
	paths := nativeAgentSearchPaths()
	for _, name := range commands {
		binaries = append(binaries, discoverAgentExecutables(name, paths)...)
	}
	for _, binary := range binaries {
		if binary == "" || checked[binary] {
			continue
		}
		checked[binary] = true
		if driver.id == "antigravity" && antigravityAgentAPI(binary) {
			return nativeAgentDiscovery{binary: binary}
		}
		stamp, err := readStamp(binary)
		if err != nil || stamp == nil {
			continue
		}
		key := driver.id + "\x00" + binary
		if cached, ok := nativeAgentProbes.Load(key); ok && stampSame(cached.(nativeAgentProbe).stamp, stamp) {
			result := cached.(nativeAgentProbe).result
			if result.err == nil {
				return result
			}
			if first.binary == "" {
				first = result
			}
			continue
		}
		probe, cancel := context.WithTimeout(ctx, 5*time.Second)
		data, issue := nativeCommand(probe, binary, "--version").Output()
		version := strings.TrimSpace(decodeCommandOutput(data))
		if issue == nil && (driver.id == "antigravity" || driver.id == "gemini") {
			help, err := nativeCommand(probe, binary, "--help").Output()
			required := strings.Contains(string(help), "--acp")
			if driver.id == "antigravity" {
				required = strings.Contains(string(help), "stream-json") && strings.Contains(string(help), "--conversation")
			}
			if err != nil {
				issue = err
			} else if !required {
				issue = errors.New("AGENT_IDENTITY_MISMATCH")
			}
		}
		if version == "" && issue == nil {
			issue = errors.New("AGENT_IDENTITY_MISMATCH")
		}
		result := nativeAgentDiscovery{binary, version, issue}
		if probe.Err() == nil {
			nativeAgentProbes.Store(key, nativeAgentProbe{stamp, result})
		}
		cancel()
		if result.err == nil {
			return result
		}
		if first.binary == "" {
			first = result
		}
	}
	if driver.id == "antigravity" && !forced {
		if binary := antigravityAgentAPIBinary(); binary != "" {
			return nativeAgentDiscovery{binary: binary}
		}
	}
	return first
}

var antigravityEfforts = []string{"low", "medium", "high", "xhigh", "max"}
var antigravityModes = []string{"accept-edits", "auto", "plan"}

func nativeAntigravityConfiguration(args, policy, inherited object) (object, error) {
	options := maps.Clone(obj(policy["options"]))
	model := policy["model"]
	if inherited != nil {
		options, model = maps.Clone(obj(inherited["options"])), inherited["model"]
	}
	if options == nil {
		options = object{}
	}
	if explicit, ok := args["model"].(string); ok {
		model = explicit
	}
	if name, ok := model.(string); ok && (name == "" || len(name) > 256 || strings.ContainsFunc(name, unicode.IsControl)) {
		return nil, errors.New("INVALID_DISPATCH_CONFIGURATION: model")
	}
	maps.Copy(options, obj(args["options"]))
	for key, raw := range options {
		value, ok := raw.(string)
		if !ok {
			return nil, fmt.Errorf("INVALID_DISPATCH_OPTION: %s", key)
		}
		switch key {
		case "effort":
			if !slices.Contains(antigravityEfforts, value) {
				return nil, fmt.Errorf("UNSUPPORTED_DISPATCH_OPTION: %s=%s", key, value)
			}
		case "mode":
			if !slices.Contains(antigravityModes, value) {
				return nil, fmt.Errorf("UNSUPPORTED_DISPATCH_OPTION: %s=%s", key, value)
			}
		default:
			return nil, fmt.Errorf("UNSUPPORTED_DISPATCH_OPTION: %s", key)
		}
	}
	if _, exists := options["mode"]; !exists {
		options["mode"] = "accept-edits"
	}
	if err := checkDispatchAgentPolicy(policy, options, model); err != nil {
		return nil, err
	}
	return object{"model": model, "options": options}, nil
}

func nativeAntigravityFacts(task object, source string) object {
	configured := obj(task["configured"])
	options := configured["options"]
	return object{"source": source, "taskId": task["taskId"], "observedAt": task["configurationObservedAt"],
		"scope": "session", "authoritative": false, "executionEvidence": false, "currentModel": configured["model"],
		"models": object{"unavailable": "Antigravity exposes no no-inference model catalog"},
		"options": []any{object{"id": "effort", "currentValue": field(options, "effort"), "values": antigravityEfforts},
			object{"id": "mode", "currentValue": field(options, "mode"), "values": antigravityModes}},
		"configurationEvidence": "requested-not-executed"}
}

func (driver nativeAgentDriver) launchArguments(task object, resume bool) ([]string, error) {
	args := slices.Clone(driver.args)
	switch driver.id {
	case "pi":
		if resume {
			path := text(task["metadata"], "sessionFile")
			if path == "" {
				return nil, errors.New("SESSION_NOT_PERSISTED")
			}
			args = append(args, "--session", path)
		}
	case "antigravity":
		configured := obj(task["configured"])
		options := obj(configured["options"])
		args = []string{"--input-format", "stream-json", "--output-format", "stream-json", "--mode",
			nonemptyTaskText(text(options, "mode"), "accept-edits"), "--disable-slash-commands", "--print="}
		if model, ok := configured["model"].(string); ok {
			args = append(args, "--model", model)
		}
		if effort, ok := options["effort"].(string); ok {
			args = append(args, "--effort", effort)
		}
		if task["approval"] == "bypass" {
			args = append(args, "--dangerously-skip-permissions")
		}
		if resume {
			if session := text(task, "sessionId"); session != "" {
				args = append(args, "--conversation", session)
			} else {
				return nil, errors.New("SESSION_NOT_PERSISTED")
			}
		}
	}
	return args, nil
}

func nativeAgentLaunchCommand(ctx context.Context, spec nativeAgentDriver, task object, resume bool) (*exec.Cmd, error) {
	hardware := spec.discover(ctx)
	if hardware.err != nil {
		return nil, hardware.err
	}
	if hardware.binary == "" {
		return nil, errors.New("AGENT_NOT_INSTALLED")
	}
	args, err := spec.launchArguments(task, resume)
	if err != nil {
		return nil, err
	}
	command := exec.Command(hardware.binary, args...)
	command.Dir = text(task, "cwd")
	proxy, err := savedNetworkProxy(ctx)
	if err != nil {
		return nil, err
	}
	proxy.apply(command)
	return command, nil
}

func resolveNativeAgentCWD(ctx context.Context, s *service, args object) (string, error) {
	directory := text(args, "cwd")
	if args["project"] != nil {
		path, err := projectWorkingDirectory(ctx, s, args)
		return str(path), err
	}
	if directory == "" || !filepath.IsAbs(directory) {
		return "", errors.New("ABSOLUTE_CWD_REQUIRED")
	}
	canonical, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return "", err
	}
	if info, err := os.Stat(canonical); err != nil || !info.IsDir() {
		return "", errors.New("INVALID_CWD")
	}
	return canonical, nil
}
