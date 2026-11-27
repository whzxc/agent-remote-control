package core

import (
	"context"
	"errors"
	"maps"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

func (s *service) nativeDesktop(ctx context.Context) (*nativeDesktopIPC, error) {
	state := &s.codex
	state.desktopMu.Lock()
	defer state.desktopMu.Unlock()
	if state.desktop != nil {
		if state.desktop.alive.Load() {
			return state.desktop, nil
		}
		state.desktop.close()
		state.desktop = nil
	}
	if fixtureUsesDesktop != nil && !fixtureUsesDesktop() || operatingSystem == "linux" {
		return nil, errors.New("DESKTOP_UNSUPPORTED: headless Linux has no Codex Desktop.")
	}
	_, home, err := codexInputs()
	if err != nil {
		return nil, err
	}
	d, err := newDesktopIPC(ctx, home, text(s.metadata, "instance"), &s.events)
	if err != nil {
		return nil, err
	}
	state.desktop = d
	return d, nil
}

func (s *service) closeNativeDesktop() {
	s.codex.desktopMu.Lock()
	defer s.codex.desktopMu.Unlock()
	if s.codex.desktop != nil {
		s.codex.desktop.close()
		s.codex.desktop = nil
	}
}

var desktopDaemonReadiness func(context.Context, *service) (string, bool)

func (s *service) desktopStatus(ctx context.Context) object {
	if runtimeFixture && fixtureUsesDesktop == nil {
		return object{"state": "unknown"}
	}
	_, err := s.nativeDesktop(ctx)
	if err == nil {
		return object{"supported": true, "state": "ready", "executionOwner": "desktop", "transport": "ipc", "message": "Codex Desktop is ready"}
	}
	if desktopDaemonReadiness != nil && fixtureUsesDesktop == nil {
		if transport, ok := desktopDaemonReadiness(ctx, s); ok {
			return object{"supported": true, "state": "ready", "executionOwner": "desktop", "transport": transport, "message": "Codex Desktop is ready"}
		}
	}
	supported := desktopCodexBinary() != ""
	if fixtureUsesDesktop != nil {
		supported = fixtureUsesDesktop()
	}
	state := "unavailable"
	if supported {
		state = "disconnected"
	}
	return object{"supported": supported, "state": state, "executionOwner": "desktop", "message": err.Error()}
}

func nativeDesktopRead(ctx context.Context, s *service, method string, args object, timeout time.Duration) (any, error) {
	id := text(args, "threadId")
	complete := method != "thread/read" || args["includeTurns"] == true
	d, err := s.nativeDesktop(ctx)
	var snapshot object
	if err == nil {
		snapshot, err = d.read(ctx, id, complete)
	}
	if err == nil {
		d.mu.Lock()
		owner := d.owners[id]
		d.mu.Unlock()
		if owner != "" {
			_ = d.follow(ctx, id, owner)
		}
		if method == "thread/read" {
			thread, err := desktopControlThread(snapshot, complete)
			return object{"thread": thread}, err
		}
		data, err := nativeDesktopTurns(snapshot)
		if err != nil {
			return nil, err
		}
		if method == "thread/items/list" {
			items := []any{}
			for _, turn := range data {
				if args["turnId"] == nil || args["turnId"] == field(turn, "id") {
					for _, item := range arr(field(turn, "items")) {
						items = append(items, object{"turnId": field(turn, "id"), "item": item})
					}
				}
			}
			data = items
		} else if args["itemsView"] == "notLoaded" {
			for _, turn := range data {
				obj(turn)["items"] = []any{}
			}
		}
		if method == "thread/turns/list" && args["sortDirection"] != "asc" || method == "thread/items/list" && args["sortDirection"] == "desc" {
			slices.Reverse(data)
		}
		return desktopControlPage(method, args, data)
	}
	_, home, inputErr := codexInputs()
	if inputErr != nil {
		return nil, inputErr
	}
	fallback := desktopMissingEndpoint(err) || desktopMissingOwner(err) || strings.Contains(strings.ToLower(err.Error()), "connection refused") ||
		desktopDiscoveryPending(err) && probeWriter(home, id)["state"] == "unheld"
	if !fallback {
		return nil, err
	}
	if strings.HasPrefix(text(args, "cursor"), "desktop:") {
		return nil, errors.New("DESKTOP_CURSOR_STALE: Desktop history owner changed; omit cursor to restart pagination")
	}
	rpc, err := s.codexUtility(ctx)
	if err != nil {
		return nil, err
	}
	return rpc.call(ctx, method, args, timeout)
}

func desktopSteerParams(state, args object) (object, error) {
	history := obj(field(state["turnHistory"], "history"))
	islands := arr(history["islands"])
	var tail, selected any
	if len(islands) != 0 {
		tail = islands[len(islands)-1]
		for _, row := range slices.Backward(arr(field(tail, "entries"))) {
			current := field(history["entitiesByKey"], text(row, "value"))
			if field(current, "turnId") != nil || !slices.Contains([]string{"completed", "failed"}, text(current, "status")) {
				selected = current
				break
			}
		}
	}
	thread := args["threadId"]
	if field(field(tail, "newerBoundary"), "status") != "exhausted" || field(selected, "turnId") == nil ||
		field(selected, "turnId") != args["expectedTurnId"] || field(selected, "status") != "inProgress" {
		return nil, dispatchObjectError(object{"code": "DESKTOP_STEER_UNAVAILABLE",
			"message":   "Desktop's follower selects an unconfirmed or different turn. Steering was not submitted. Keep the queued message pending until the current turn ends, or explicitly submit codex_send with sendMode:queue. ARC will not switch owners or start another turn as a steering fallback.",
			"retryable": false, "threadId": thread, "next": object{"via": "query", "op": "codex_queue", "args": object{"threadId": thread},
				"hint": "Inspect the queue; an unsuccessful promotion leaves the message queued. Use codex_read statusOnly:true for the current native turn."}})
	}
	input, err := codexTaskInput(args)
	if err != nil {
		return nil, err
	}
	message := id()
	roots := []string{}
	if cwd, ok := state["cwd"].(string); ok {
		roots = append(roots, cwd)
	}
	return object{"conversationId": thread, "input": input, "attachments": []any{}, "clientUserMessageId": message, "serviceTier": args["serviceTier"],
		"restoreMessage": object{"id": message, "cwd": state["cwd"], "context": object{"workspaceRoots": roots, "commentAttachments": []any{}}}}, nil
}

func (d *nativeDesktopIPC) mutate(ctx context.Context, method string, args object) (any, error) {
	thread := text(args, "threadId")
	d.mu.Lock()
	owner := d.owners[thread]
	d.mu.Unlock()
	if owner == "" {
		var err error
		owner, err = d.owner(ctx, thread)
		if err != nil {
			return nil, err
		}
	}
	switch method {
	case "turn/start":
		return d.startTurn(ctx, owner, thread, args)
	case "turn/steer":
		state, err := d.readOwned(ctx, thread, true, owner)
		if err != nil {
			return nil, err
		}
		params, err := desktopSteerParams(state, args)
		if err != nil {
			return nil, err
		}
		reply, err := d.request(ctx, "thread-follower-steer-turn", params, owner)
		if err != nil && strings.Contains(err.Error(), "thread-follower-steer-turn-timeout") {
			return nil, errors.New("SUBMISSION_UNCONFIRMED: Desktop did not confirm steering; read the original receipt and codex_read for thread " + thread + "; do not replay or switch execution owners")
		}
		return field(reply["result"], "result"), err
	case "turn/interrupt":
		if text(args, "turnId") == "" {
			return nil, errors.New("DESKTOP_TURN_ID_REQUIRED")
		}
		_ = d.follow(ctx, thread, owner)
		reply, err := d.request(ctx, "thread-follower-interrupt-turn", object{"conversationId": thread, "mode": "user-stop", "expectedTurnId": args["turnId"]}, owner)
		if err != nil {
			return nil, err
		}
		if field(reply["result"], "ok") != true {
			return nil, errors.New("DESKTOP_REJECTED: interrupt not accepted")
		}
		return object{}, nil
	case "thread/resume":
		return object{"threadId": thread, "executionOwner": "desktop", "resumed": true, "reason": "desktop-owner-confirmed"}, nil
	default:
		return nil, errors.New("DESKTOP_METHOD_UNSUPPORTED: " + method)
	}
}

func (d *nativeDesktopIPC) startTurn(ctx context.Context, owner, thread string, args object) (any, error) {
	args = maps.Clone(args)
	if args["turnTrigger"] != "resume_interrupted_task" || text(args, "parentTurnId") == "" || len(arr(args["input"])) != 0 {
		input, err := codexTaskInput(args)
		if err != nil {
			return nil, err
		}
		args["input"] = input
	}
	state, err := d.readOwned(ctx, thread, false, owner)
	if err != nil {
		return nil, err
	}
	if args["collaborationMode"] == nil {
		settings := obj(state["latestThreadSettings"])
		if args["model"] == nil {
			if model := dispatchFirstString(settings["model"], state["latestModel"]); model != nil {
				args["model"] = model
			}
		}
		mode := clone(obj(settings["collaborationMode"]))
		if mode == nil {
			mode = clone(obj(state["latestCollaborationMode"]))
		}
		if mode != nil {
			draft := dispatchSetSection(mode, "settings")
			if args["model"] != nil {
				draft["model"] = args["model"]
			}
			if effort, ok := args["effort"]; ok {
				draft["reasoning_effort"] = effort
			}
			args["collaborationMode"] = mode
		}
	}
	settings := selectFields(args, "model", "effort", "collaborationMode", "serviceTier", "cwd", "sandboxPolicy", "permissions", "approvalPolicy", "approvalsReviewer")
	if len(settings) != 0 {
		updated, err := d.request(ctx, "thread-follower-update-thread-settings", object{"conversationId": thread, "threadSettings": settings}, owner)
		if err != nil {
			return nil, err
		}
		if field(updated["result"], "applied") != true {
			return nil, errors.New("DESKTOP_REJECTED: thread settings not applied")
		}
	}
	reply, err := d.request(ctx, "thread-follower-start-turn", object{"conversationId": thread, "turnStart": object{"request": args, "context": object{}}}, owner)
	return field(reply["result"], "result"), err
}

func requestDesktopCodex(ctx context.Context, s *service, method string, args any, timeout time.Duration) (any, error) {
	if nativeThreadHistoryRead(method) {
		return nativeDesktopRead(ctx, s, method, obj(args), timeout)
	}
	d, err := s.nativeDesktop(ctx)
	if err != nil {
		return nil, err
	}
	return d.mutate(ctx, method, obj(args))
}

var nativeWindowsCodexBinary func() string

func desktopCodexBinary() string {
	if operatingSystem == "windows" && nativeWindowsCodexBinary != nil {
		return nativeWindowsCodexBinary()
	}
	if operatingSystem != "darwin" {
		return ""
	}
	home, _ := os.UserHomeDir()
	for _, parent := range []string{"/Applications", filepath.Join(home, "Applications")} {
		for _, name := range []string{"ChatGPT.app", "Codex.app"} {
			binary := filepath.Join(parent, name, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")
			if info, err := os.Stat(binary); err == nil && info.Mode().IsRegular() {
				return binary
			}
		}
	}
	return ""
}

func installedCodexCLI() string {
	if runtimeFixture && fixtureNativeCodexInputs != nil {
		binary, _, _ := fixtureNativeCodexInputs()
		return binary
	}
	if operatingSystem == "linux" {
		return discoverAgentExecutable("codex")
	}
	return desktopCodexBinary()
}

func codexLoginStatus(ctx context.Context, binary string) (object, error) {
	if binary == "" {
		if operatingSystem == "linux" {
			return nil, errors.New("CODEX_NOT_FOUND: install Codex CLI and run codex login in your terminal.")
		}
		return nil, errors.New("Install Codex Desktop first")
	}
	if _, err := nativeCommand(ctx, binary, "login", "status").Output(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var exited *exec.ExitError
		if !errors.As(err, &exited) {
			return nil, err
		}
		return object{"state": "unauthenticated"}, nil
	}
	return object{"state": "authenticated"}, nil
}

func init() {
	registerRoute(http.MethodGet, "codex/login", func(ctx context.Context, _ *service, _ object, _ []string) (any, error) {
		return codexLoginStatus(ctx, installedCodexCLI())
	})
	registerRoute(http.MethodPost, "codex/login", func(ctx context.Context, _ *service, _ object, _ []string) (any, error) {
		if operatingSystem == "linux" && !runtimeFixture {
			return nil, errors.New("DESKTOP_UNSUPPORTED: headless Linux has no Codex Desktop.")
		}
		url := ""
		if operatingSystem == "windows" || runtimeFixture {
			url = "codex://"
		}
		if err := openNativeDesktopURL(ctx, url); err != nil {
			return nil, err
		}
		return object{"state": "unauthenticated", "message": "Complete login in Codex Desktop"}, nil
	})
	runtimeDesktopDiagnostics = func(s *service) object {
		s.codex.desktopMu.Lock()
		d := s.codex.desktop
		s.codex.desktopMu.Unlock()
		if d == nil {
			return object{"connected": false, "pendingRequests": 0, "owners": 0, "snapshots": nil}
		}
		return d.diagnostics()
	}
	findDesktopCodexBinary = desktopCodexBinary
	controlDesktopTurns = nativeDesktopTurns
	desktopNativeRequest = requestDesktopCodex
	desktopWriterOwner = func(ctx context.Context, s *service, thread string) (string, error) {
		d, err := s.nativeDesktop(ctx)
		if err != nil {
			return "", err
		}
		return d.owner(ctx, thread)
	}
	coordinationNativeDesktopTurns = func(snapshot any) []object {
		rows, _ := nativeDesktopTurns(obj(snapshot))
		result := make([]object, len(rows))
		for i, row := range rows {
			result[i] = obj(row)
		}
		return result
	}
}
