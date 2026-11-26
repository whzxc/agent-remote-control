package core

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

type nativeCodexState struct {
	mu           sync.Mutex
	utility      *rpcConnection
	launches     launches
	shutdown     context.Context
	historyPaths map[string]string
	activity     codexActivityMonitor
	desktopMu    sync.Mutex
	desktop      *nativeDesktopIPC
	backends     nativeDesktopBackends
	queue        nativeDispatchQueue
}

var readNativeDispatchHistory func(string) ([]object, error)
var fixtureNativeCodexInputs func() (binary, home string, err error)
var fixtureUsesDesktop func() bool
var desktopNativeRequest func(context.Context, *service, string, any, time.Duration) (any, error)
var desktopWriterOwner func(context.Context, *service, string) (string, error)
var observeNativeCodexOwnership func(context.Context, string, object) (object, error)
var nativeCommandEnvironment func(context.Context, object)

func codexInputs() (binary, home string, err error) {
	if fixtureNativeCodexInputs != nil {
		return fixtureNativeCodexInputs()
	}
	home, err = nativeCodexHome()
	if err != nil {
		return "", "", err
	}
	// The Desktop installation resolver supplies the bundled binary on supported desktops.
	binary = "codex"
	if findDesktopCodexBinary != nil && operatingSystem != "linux" {
		if installed := findDesktopCodexBinary(); installed != "" {
			binary = installed
		}
	}
	if operatingSystem == "linux" {
		binary = discoverAgentExecutable("codex")
		if binary == "" {
			return "", "", errors.New("CODEX_NOT_FOUND: install Codex CLI and log in as this user; searched PATH, ~/.local/bin, /usr/local/bin, npm global prefixes, nvm, bun and Volta directories.")
		}
	}
	return binary, home, nil
}

var findDesktopCodexBinary func() string

func (s *service) codexUtility(ctx context.Context) (*rpcConnection, error) {
	state := &s.codex
	state.mu.Lock()
	defer state.mu.Unlock()
	if err := state.launches.run(func() error { return nil }); err != nil {
		return nil, err
	}
	if current := state.utility; current != nil {
		if current.alive.Load() {
			return current, nil
		}
		current.close()
		state.utility = nil
	}
	binary, home, err := codexInputs()
	if err != nil {
		return nil, err
	}
	connection, err := attachRPC(ctx, binary, home, text(s.metadata, "instance"), &state.launches, s.events.rpcObserver())
	if err != nil {
		return nil, err
	}
	state.utility = connection
	return connection, state.launches.run(func() error { return nil })
}

func (s *service) closeNativeCodex() {
	state := &s.codex
	state.activity.close()
	s.closeNativeDesktop()
	s.closeDesktopBackendConnections()
	state.launches.close()
	state.mu.Lock()
	connection := state.utility
	state.utility = nil
	state.mu.Unlock()
	ctx := context.Background()
	var retained *rpcHost
	if connection != nil {
		pending := slices.ContainsFunc(s.events.pendingInteractions(), func(request object) bool {
			return request["owner"] != "desktop"
		})
		if connection.host != nil && (!connection.alive.Load() || pending || connection.active(ctx) || rpcDesktopAttached(ctx)) {
			retained = connection.host
			connection.close()
		} else {
			connection.stop(ctx)
		}
	}
	for _, record := range codexRunningHosts() {
		if retained != nil && record["processStart"] == retained.processStart && uintOr(record["pid"], 0) == uint64(retained.pid) {
			continue
		}
		profile := text(record, "profile")
		if profile == primaryCodexProfile && rpcDesktopAttached(ctx) {
			continue
		}
		if uintOr(record["creatorPid"], 0) == uint64(os.Getpid()) && record["creatorStart"] == platform.ProcessStart(os.Getpid()) {
			if err := stopCodexHost(ctx, profile); err != nil {
				recordLog("WARN", err.Error(), nil)
			}
		}
	}
}

func nativeThreadHistoryRead(method string) bool {
	return slices.Contains([]string{"thread/read", "thread/turns/list", "thread/items/list"}, method)
}

func nativeThreadMutation(method string) bool {
	return slices.Contains([]string{"thread/resume", "turn/start", "turn/steer", "turn/interrupt"}, method)
}

func codexExecutionRecord(thread string) (object, error) {
	if _, err := uuid.Parse(thread); err != nil {
		return nil, nil
	}
	stored, err := cachedLoad(filepath.Join(root(), "execution", thread+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return obj(stored), err
}

func codexBackground(thread string) bool {
	if operatingSystem == "linux" {
		return thread != ""
	}
	record, _ := codexExecutionRecord(thread)
	return record["owner"] == "connector"
}

func (s *service) nativeWriterOwnership(ctx context.Context, home, thread string) object {
	result := probeWriter(home, thread)
	result["threadId"] = thread
	if result["state"] != "held" {
		return result
	}
	if binding, _ := codexDesktopBinding(thread); binding["transport"] == "local-daemon" && nativeDesktopWriterEvidence != nil && fixtureUsesDesktop == nil {
		evidence := nativeDesktopWriterEvidence(ctx, home, thread)
		expected := "shared-app-server"
		if binding["backend"] == "arc" {
			expected = "arc-app-server"
		}
		result["origin"], result["holder"] = evidence["origin"], evidence
		result["dispatchBackend"] = object{"backend": binding["backend"], "reason": binding["backendReason"]}
		if evidence["origin"] != expected {
			result["owner"] = "external"
			if evidence["origin"] == "main-desktop" {
				result["owner"] = "desktop"
			} else if evidence["origin"] == "shared-app-server" || evidence["origin"] == "arc-app-server" {
				result["owner"] = evidence["origin"]
			}
			return result
		}
		if target := binding["desktopTarget"]; !nativeDesktopIdentityRunning(target) {
			result["owner"] = expected
			return result
		}
		wait, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		rpc, err := s.desktopBackendRPC(wait, text(binding, "backend"))
		if err == nil {
			metadata, err := rpc.call(wait, "thread/read", object{"threadId": thread, "includeTurns": false}, time.Second)
			native := field(metadata, "thread")
			status := text(field(native, "status"), "type")
			if err == nil && field(native, "id") == thread && (status == "active" || status == "idle") {
				result["owner"], result["runtimeStatus"] = "desktop", status
			}
		}
		cancel()
		if result["owner"] == nil {
			result["owner"] = expected
		}
		return result
	}
	if codexBackground(thread) {
		wait, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		connection, err := s.codexUtility(wait)
		if err == nil {
			metadata, err := connection.call(wait, "thread/read", object{"threadId": thread, "includeTurns": false}, time.Second)
			if status := text(field(metadata, "thread"), "status"); err == nil && (status == "active" || status == "idle") {
				result["owner"], result["runtimeStatus"] = "connector", status
			} else if status := text(field(field(metadata, "thread"), "status"), "type"); err == nil && (status == "active" || status == "idle") {
				result["owner"], result["runtimeStatus"] = "connector", status
			}
		}
		cancel()
		if result["owner"] != nil {
			return result
		}
	}
	if desktopWriterOwner != nil {
		wait, cancel := context.WithTimeout(ctx, 1800*time.Millisecond)
		client, err := desktopWriterOwner(wait, s, thread)
		cancel()
		if err == nil {
			result["owner"], result["clientId"] = "desktop", client
			return result
		}
	}
	result["owner"], result["reason"] = "external", "native-writer-held-without-desktop-follower-owner"
	return result
}

func writerFailure(ctx context.Context, s *service, home, thread string, err error) error {
	ownership := s.nativeWriterOwnership(ctx, home, thread)
	if ownership["owner"] == "desktop" {
		return errors.New(wire(object{"code": "DESKTOP_HANDOFF_UNAVAILABLE",
			"message":   "The Desktop route did not confirm this operation. Inspect the original receipt and current Desktop state before retrying.",
			"ownership": ownership, "next": object{"via": "query", "op": "codex_owner", "args": object{"threadId": thread}}}))
	}
	if ownership["state"] == "held" {
		ownership["processes"] = writerProcesses(ctx, home, thread)
	}
	if err != nil {
		ownership["lockObservation"] = ownership["state"]
		ownership["state"], ownership["evidence"] = "held", "native-writer-rejection"
		if ownership["owner"] == nil {
			ownership["owner"] = "external"
		}
		var rpc object
		if raw, ok := strings.CutPrefix(err.Error(), "RPC_REJECTED:"); ok && decodeObject([]byte(raw), &rpc) == nil &&
			field(rpc["data"], "injected") == true {
			ownership["injected"], ownership["evidence"] = true, "isolated-native-writer-rejection"
		}
	}
	return errors.New(wire(writerBusy(thread, ownership)))
}

func nativeTransferOptions(args object) bool {
	for _, key := range []string{"expectedSha256", "append", "offset"} {
		if _, present := args[key]; present {
			return true
		}
	}
	return false
}

func requestCodexNative(ctx context.Context, service *service, method string, args any, timeout time.Duration) (any, error) {
	if method == "fs/fetchFile" || method == "fs/writeFile" && nativeTransferOptions(obj(args)) {
		return transferBinaryFile(ctx, method, obj(args))
	}
	if method == "command/exec" && nativeCommandEnvironment != nil {
		params := maps.Clone(obj(args))
		nativeCommandEnvironment(ctx, params)
		args = params
	}

	_, home, err := codexInputs()
	if err != nil {
		return nil, err
	}
	thread := text(args, "threadId")
	read := nativeThreadHistoryRead(method)
	mutation := nativeThreadMutation(method)
	directFixture := fixtureUsesDesktop != nil && !fixtureUsesDesktop()
	if checkAcceptanceRead != nil {
		if err := checkAcceptanceRead(method, args); err != nil {
			return nil, writerFailure(ctx, service, home, thread, err)
		}
	}
	var externallyHeld, desktopHeld bool
	returned, err := returnedDesktopInstance(thread)
	if err != nil {
		return nil, err
	}
	if returned != nil && !directFixture {
		if method == "thread/resume" || method == "turn/start" || method == "turn/steer" {
			if err := requireUnheldDesktopWriter(ctx, home, thread); err != nil {
				return nil, err
			}
		}
		if read && probeWriter(home, thread)["state"] == "unheld" {
			rpc, err := service.codexUtility(ctx)
			if err != nil {
				return nil, err
			}
			return rpc.call(ctx, method, args, timeout)
		}
	}
	if thread != "" && (read || mutation) && !directFixture {
		if binding, err := codexDesktopBinding(thread); err != nil {
			return nil, err
		} else if binding["transport"] == "local-daemon" && (returned == nil || !mutation) {
			if read && probeWriter(home, thread)["state"] == "held" && service.nativeWriterOwnership(ctx, home, thread)["owner"] == "external" {
				rpc, err := service.codexUtility(ctx)
				if err != nil {
					return nil, err
				}
				return rpc.call(ctx, method, args, timeout)
			}
			rpc, err := service.desktopBackendRPC(ctx, text(binding, "backend"))
			if err != nil {
				return nil, err
			}
			if mutation {
				owner := service.nativeWriterOwnership(ctx, home, thread)
				if owner["state"] != "unheld" && (owner["owner"] != "desktop" || owner["runtimeStatus"] == nil) {
					return nil, errors.New(wire(writerBusy(thread, owner)))
				}
			}
			value, err := rpc.call(ctx, method, args, timeout)
			if err == nil && method == "thread/read" {
				if state := obj(field(value, "thread")); state != nil {
					state["runtimeSource"] = string(rpc.role)
				}
			}
			return value, err
		}
	}
	if thread != "" && (read || mutation) && probeWriter(home, thread)["state"] == "held" {
		owner := service.nativeWriterOwnership(ctx, home, thread)
		externallyHeld = owner["owner"] == "external"
		desktopHeld = owner["owner"] == "desktop"
		if mutation && (externallyHeld || owner["owner"] == "shared-app-server" || owner["owner"] == "arc-app-server") {
			owner["processes"] = writerProcesses(ctx, home, thread)
			return nil, errors.New(wire(writerBusy(thread, owner)))
		}
	}

	useUtility := directFixture || read && externallyHeld || codexBackground(thread) && !desktopHeld
	switch {
	case !useUtility && (read || mutation || method == "thread/start" || method == "thread/resume"):
		if desktopNativeRequest == nil {
			return nil, errors.New(PortPending)
		}
		return desktopNativeRequest(ctx, service, method, args, timeout)
	case !useUtility && (strings.HasPrefix(method, "thread/") || strings.HasPrefix(method, "turn/")) &&
		method != "thread/list" && method != "thread/loaded/list":
		return nil, errors.New("DESKTOP_METHOD_UNSUPPORTED: " + method)
	}
	connection, err := service.codexUtility(ctx)
	if err != nil {
		return nil, err
	}
	if method == "thread/resume" && !directFixture {
		params := maps.Clone(obj(args))
		if _, supplied := params["excludeTurns"]; !supplied {
			params["excludeTurns"] = true
		}
		args = params
	}
	var acquisition string
	if method == "thread/resume" && thread != "" {
		if _, err := observeNotificationOwnership(thread, service.nativeWriterOwnership(ctx, home, thread)); err != nil {
			return nil, err
		}
		acquisition, err = beginNotificationAcquisition(ctx, thread)
		if err != nil {
			return nil, err
		}
	}
	value, err := connection.call(ctx, method, args, timeout)
	if acquisition != "" {
		if _, err := observeNotificationOwnership(thread, service.nativeWriterOwnership(ctx, home, thread)); err != nil {
			recordLog("WARN", err.Error(), nil)
		}
		if endErr := endNotificationAcquisition(thread, acquisition); endErr != nil {
			if err == nil {
				return nil, errors.New("SUBMISSION_UNCONFIRMED: writer acquisition record failed: " + endErr.Error())
			}
			recordLog("WARN", endErr.Error(), nil)
		}
	}
	if thread != "" && nativeWriterRejected(err) {
		if mutation && !directFixture && returned == nil && desktopNativeRequest != nil {
			owner := service.nativeWriterOwnership(ctx, home, thread)
			if owner["owner"] == "desktop" && owner["clientId"] != nil {
				if _, issue := observeNotificationOwnership(thread, owner); issue != nil {
					return nil, issue
				}
				// Codex explicitly rejected admission, so the original mutation can follow the confirmed owner once.
				return desktopNativeRequest(ctx, service, method, args, timeout)
			}
		}
		return nil, writerFailure(ctx, service, home, thread, err)
	}
	if err == nil && method == "thread/read" && useUtility && !directFixture && !externallyHeld {
		if state := obj(field(value, "thread")); state != nil {
			state["runtimeSource"] = string(connection.role)
		}
	}
	if err == nil && method == "command/exec" && operatingSystem == "darwin" {
		if hint := shellLocalNetworkHint(value, args); hint != nil {
			obj(value)["networkHint"] = hint
		}
	}

	return value, err
}

func nativeCodexOwner(ctx context.Context, request operationRequest) (any, error) {
	_, home, err := codexInputs()
	if err != nil {
		return nil, err
	}
	thread := text(request.args, "threadId")
	owner := request.service.nativeWriterOwnership(ctx, home, thread)
	if observeNativeCodexOwnership != nil {
		history, err := observeNativeCodexOwnership(ctx, thread, owner)
		if err != nil {
			return nil, err
		}
		for _, key := range []string{"currentOwner", "history", "observedAt"} {
			owner[key] = history[key]
		}
	}
	if handback, err := desktopHandbackObservation(thread); err != nil {
		return nil, err
	} else if handback != nil {
		if owner["state"] == "held" && nativeDesktopWriterEvidence != nil {
			handback = clone(handback)
			handback["holder"] = nativeDesktopWriterEvidence(ctx, home, thread)
		}
		owner["handback"] = handback
	}
	if owner["state"] == "held" {
		owner["processes"] = writerProcesses(ctx, home, thread)
		owner["next"] = writerReleaseStep(thread, owner)
	}
	return owner, nil
}

func init() {
	nativeControlRequest = requestCodexNative
	nativeSchemaBinary = func(_ context.Context, _ *service) (string, error) {
		binary, _, err := codexInputs()
		return binary, err
	}
	permissionAccountRead = func(ctx context.Context, s *service) (object, error) {
		value, err := requestCodexNative(ctx, s, "account/read", object{"refreshToken": false}, 5*time.Second)
		return obj(value), err
	}
	permissionCommand = func(ctx context.Context, s *service, args object) (object, error) {
		value, err := requestCodexNative(ctx, s, "command/exec", args, 5*time.Second)
		return obj(value), err
	}
	permissionCodexInstalled = func() bool {
		if fixtureNativeCodexInputs != nil {
			return false
		}
		if operatingSystem == "linux" {
			return discoverAgentExecutable("codex") != ""
		}
		return findDesktopCodexBinary != nil && findDesktopCodexBinary() != ""
	}
	registerOperation("codex_owner", nativeCodexOwner, nil)
	registerOperation("codex_capabilities", func(ctx context.Context, r operationRequest) (any, error) {
		settings, err := notificationSettings()
		if err != nil {
			return nil, err
		}
		owner := "connector"
		if settings["autoOpenCodex"] == true && operatingSystem != "linux" {
			owner = "desktop"
		}
		models, err := requestCodexNative(ctx, r.service, "model/list", object{}, time.Minute)
		if err != nil {
			return nil, err
		}
		configuration, err := requestCodexNative(ctx, r.service, "config/read", object{}, time.Minute)
		if err != nil {
			return nil, err
		}
		return object{"version": buildVersion, "backendSession": r.service.metadata["instance"], "executionOwner": owner,
			"models": models, "configuration": configuration}, nil
	}, nil)
	registerServiceStartup(func(ctx context.Context, service *service) error {
		service.codex.shutdown = ctx
		service.cleanup = append(service.cleanup, service.closeNativeCodex)
		return nil
	})
	registerAfterIndexStartup(10, func(ctx context.Context, service *service) error {
		if fixtureNativeCodexInputs == nil && codexHostRunning(primaryCodexProfile) {
			if _, err := service.codexUtility(ctx); err != nil {
				recordLog("WARN", "Codex app-server could not be reattached: "+err.Error(), nil)
			}
		}
		return nil
	})
}

func prepareNativeCodexReceipt(row object) error {
	args := obj(row["arguments"])
	method, params := text(args, "method"), args["params"]
	var kind string
	switch method {
	case "thread/start":
		kind = "create"
	case "turn/start", "turn/steer", "thread/resume":
		kind = "send"
	case "turn/interrupt":
		kind = "interrupt"
	default:
		return nil
	}
	settings, err := notificationSettings()
	if err != nil {
		return err
	}
	if method == "thread/start" {
		row["executionOwner"] = "connector"
		if settings["autoOpenCodex"] == true && operatingSystem != "linux" {
			row["executionOwner"] = "desktop"
		}
	}
	var prompts []string
	for _, item := range arr(field(params, "input")) {
		if text, ok := field(item, "text").(string); ok {
			prompts = append(prompts, text)
		}
	}
	prompt := strings.Join(prompts, "\n")
	row["task"] = object{"kind": kind, "title": dispatchTitle(object{"title": args["title"], "prompt": prompt}), "prompt": prompt,
		"input": field(params, "input"), "project": args["project"], "directory": field(params, "cwd"), "threadId": field(params, "threadId"),
		"model": field(params, "model"), "effort": field(params, "effort"), "settings": object{"params": params}, "origin": row["origin"]}
	approval := object{"decision": "automatic", "source": "cloud", "at": now()}
	switch args["approval"] {
	case "approved", "bypass":
		approval["decision"], approval["answeredBy"] = args["approval"], interactionAnsweredBy(obj(row["origin"]))
	default:
		if settings["enabled"] == true {
			approval["decision"] = "pending"
			row["state"] = "awaiting-approval"
			row["nextAction"] = "receipt: approve, bypass or reject; user intent overrides the default approval mode"
		}
	}
	row["approval"] = approval
	return nil
}

func executeNativeCodexReceipt(ctx context.Context, s *service, operation string, row object) (any, error) {
	args := obj(row["arguments"])
	duration := time.Duration(min(uintOr(args["timeoutMs"], 86400000), 86400000)) * time.Millisecond
	method, params := text(args, "method"), args["params"]
	if _, selected := args["project"].(string); selected && slices.Contains([]string{"command/exec", "process/spawn", "thread/fork"}, method) {
		directory := maps.Clone(args)
		input := clone(obj(params))
		if input == nil {
			input = object{}
		}
		if cwd, exists := input["cwd"]; exists {
			directory["cwd"] = cwd
		}
		cwd, err := projectWorkingDirectory(ctx, s, directory)
		if err != nil {
			return nil, err
		}
		input["cwd"], params = cwd, input
	}
	result, err := performNativeCodexMutation(ctx, s, method, params, duration, row)
	if err != nil && strings.HasPrefix(err.Error(), "RPC_REJECTED:") && !nativeWriterRejected(err) {
		row["next"] = errorNext(operation, controlFailure(err))
	}
	return result, err
}

func openNativeCodexThread(ctx context.Context, s *service, params any, row object, timeout time.Duration) (any, error) {
	background := row["executionOwner"] != "desktop"
	var desktop *nativeDesktopIPC
	if !background && (fixtureUsesDesktop == nil || fixtureUsesDesktop()) {
		var err error
		desktop, err = s.nativeDesktop(ctx)
		if err != nil {
			if desktopMissingEndpoint(err) {
				background = true
			} else {
				return nil, err
			}
		}
	}
	input := clone(obj(params))
	if input == nil {
		input = object{}
	}
	if input["ephemeral"] == true {
		if background {
			return nil, errors.New("BACKGROUND_TASK_MUST_PERSIST")
		}
		return nil, errors.New("DESKTOP_TASK_MUST_PERSIST")
	}
	input["ephemeral"] = false
	var rpc *rpcConnection
	var err error
	if background {
		rpc, err = s.codexUtility(ctx)
	} else {
		binary, home, issue := codexInputs()
		if issue != nil {
			return nil, issue
		}
		err = s.codex.launches.run(func() error {
			var issue error
			rpc, issue = startRPC(ctx, binary, home, id(), rpcObserver{})
			return issue
		})
	}
	if err != nil {
		return nil, err
	}
	if !background {
		defer rpc.close()
	}
	value, err := rpc.call(ctx, "thread/start", input, timeout)
	if err != nil {
		return nil, err
	}
	thread := text(field(value, "thread"), "id")
	if uuid.Validate(thread) != nil {
		return nil, errors.New("SUBMISSION_UNCONFIRMED: Codex returned no thread ID. Read the original receipt before retrying.")
	}
	row["threadId"] = thread
	task := dispatchSetSection(row, "task")
	task["directory"], task["threadId"] = field(field(value, "thread"), "cwd"), thread
	if err := codexMutationCheckpoint(ctx, row, "thread-created"); err != nil {
		return nil, err
	}
	cleanup := func(cause error) (any, error) {
		if ctx.Err() == nil && !strings.HasPrefix(cause.Error(), "RPC_TIMEOUT:") {
			_, issue := rpc.call(ctx, "thread/archive", object{"threadId": thread}, 10*time.Second)
			status, cleanupErr := nativeCleanupResult(issue)
			if cleanupErr != nil {
				status = object{"archived": false, "error": cleanupErr.Error()}
			}
			row["cleanup"] = status
		}
		return nil, cause
	}
	title := text(task, "title")
	if !background {
		title = nonemptyTaskText(title, "ARC task")
	}
	if title != "" {
		if _, err := rpc.call(ctx, "thread/name/set", object{"threadId": thread, "name": title}, time.Minute); err != nil {
			return cleanup(err)
		}
	}
	binding := object{"owner": "connector"}
	if !background {
		reader, err := s.codexUtility(ctx)
		if err != nil {
			return cleanup(err)
		}
		native, err := reader.call(ctx, "thread/read", object{"threadId": thread, "includeTurns": false}, time.Minute)
		if err != nil {
			return cleanup(err)
		}
		if _, err := rpc.call(ctx, "thread/unsubscribe", object{"threadId": thread}, time.Minute); err != nil {
			return cleanup(err)
		}
		obj(value)["thread"] = field(native, "thread")
		binding = object{"owner": "desktop", "transport": "ipc"}
	}
	if err := save(filepath.Join(root(), "execution", thread+".json"), binding); err != nil {
		return nil, fmt.Errorf("SUBMISSION_UNCONFIRMED: thread accepted; execution record failed: %w", err)
	}
	if desktop != nil {
		if err := revealNativeDesktopThread(ctx, desktop, thread); err != nil {
			return nil, err
		}
	}
	return value, nil
}

func performNativeCodexMutation(ctx context.Context, s *service, method string, params any, timeout time.Duration, row object) (any, error) {
	thread := text(params, "threadId")
	if thread != "" {
		row["threadId"] = thread
	}
	if thread != "" && nativeThreadMutation(method) {
		release := lockReceipt("codex-thread:" + thread)
		defer release()
		if method != "turn/interrupt" {
			if previous, err := returnedDesktopInstance(thread); err != nil {
				return nil, err
			} else if previous != nil {
				if _, err := prepareReturnedDesktopThread(ctx, s, thread, previous); err != nil {
					return nil, err
				}
			}
		}
	}
	if method == "turn/start" {
		cwd := text(params, "cwd")
		if cwd == "" && thread != "" {
			state, err := requestCodexNative(ctx, s, "thread/read", object{"threadId": thread, "includeTurns": false}, 10*time.Second)
			if err != nil {
				return nil, err
			}
			cwd = text(field(state, "thread"), "cwd")
		}
		baseline := captureNativeChangeBaseline(ctx, cwd)
		row["turnBaseline"], row["dispatchMode"], row["coordination"] = baseline, "new-turn", coordinationDispatchAdvisory(ctx, obj(row["origin"]), baseline)
	}
	if err := codexMutationCheckpoint(ctx, row, method); err != nil {
		return nil, err
	}
	if method == "thread/start" {
		return openNativeCodexThread(ctx, s, params, row, timeout)
	}
	result, err := requestCodexNative(ctx, s, method, params, timeout)
	if err != nil {
		return nil, err
	}
	if method == "command/exec" && field(row["arguments"], "outputBudget") != nil && obj(result) != nil {
		result, err = budgetShellOutput(obj(result), obj(row["arguments"]))
		if err != nil {
			return nil, err
		}
	}
	if turn := text(field(result, "turn"), "id"); turn != "" {
		row["turnId"] = turn
		if baseline := obj(row["turnBaseline"]); baseline != nil {
			if err := recordNativeChangeBaseline(thread, turn, baseline); err != nil {
				recordLog("WARN", err.Error(), nil)
			}
		}
	}
	if thread == "" {
		if returned := text(field(result, "thread"), "id"); returned != "" {
			row["threadId"] = returned
		}
	}
	return result, nil
}
