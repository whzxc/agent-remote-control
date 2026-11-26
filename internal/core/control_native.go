package core

import (
	"context"
	"errors"
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
	if thread != "" && (read || mutation) && probeWriter(home, thread)["state"] == "held" {
		owner := service.nativeWriterOwnership(ctx, home, thread)
		externallyHeld = owner["owner"] == "external"
		desktopHeld = owner["owner"] == "desktop"
		if mutation && (externallyHeld || owner["owner"] == "shared-app-server") {
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
	if err != nil && thread != "" && strings.Contains(err.Error(), "already has an active writer") {
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
