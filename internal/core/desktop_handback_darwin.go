package core

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
	"golang.org/x/sys/unix"
)

func macDesktopTargetExited(target any) bool {
	pid, stamp := uintOr(field(target, "pid"), 0), text(target, "start")
	if pid == 0 || pid > 1<<31-1 || stamp == "" {
		return false
	}
	if current := platform.ProcessStart(int(pid)); current != "" {
		return current != stamp
	}
	return errors.Is(unix.Kill(int(pid), 0), unix.ESRCH)
}

func macDesktopWriterEvidence(ctx context.Context, home, thread string) object {
	processes := writerProcesses(ctx, home, thread)
	result := object{"origin": "unknown", "processes": processes}
	if len(processes) == 0 || fixtureUsesDesktop != nil {
		return result
	}
	var pids []string
	for _, process := range processes {
		pids = append(pids, strconv.FormatUint(uintOr(process["pid"], 0), 10))
	}
	if socket, err := nativeSharedDesktopSocket(); err == nil {
		wait, cancel := context.WithTimeout(ctx, 800*time.Millisecond)
		report, err := commandOutput(wait, "/usr/sbin/lsof", "-nP", "-a", "-p", strings.Join(pids, ","), "-U", "-Fn")
		cancel()
		if err == nil && slices.Contains(strings.Split(report, "\n"), "n"+socket) {
			result["origin"], result["client"] = "shared-app-server", "unknown"
			return result
		}
	}
	if host, err := loadCodexHost(primaryCodexProfile); err == nil {
		if pid := codexHostPID(host); pid != 0 && slices.Contains(pids, strconv.Itoa(pid)) {
			result["origin"], result["client"] = "arc-app-server", "unknown"
			return result
		}
	}
	wait, cancel := context.WithTimeout(ctx, 800*time.Millisecond)
	defer cancel()
	rows, err := listNativeDesktopProcesses(wait)
	if err != nil {
		return result
	}
	instances, _ := nativeDesktopInstances(rows)
	byPID := make(map[int]nativeDesktopProcess, len(rows))
	for _, row := range rows {
		byPID[row.pid] = row
	}
	var terminal object
	for _, process := range processes {
		pid := int(uintOr(process["pid"], 0))
		seen := map[int]bool{}
		tty, app, ttyPID := "", "", 0
		for current := pid; current > 0 && !seen[current]; {
			seen[current] = true
			row, ok := byPID[current]
			if !ok {
				break
			}
			for _, instance := range instances {
				if instance.pid == current && instance.running() {
					result["origin"], result["originPid"] = "main-desktop", current
					if instance.profile != "" {
						result["origin"] = "desktop-profile"
					}
					return result
				}
			}
			switch filepath.Base(row.executable) {
			case "sshd", "sshd-session":
				result["origin"], result["originPid"] = "ssh", current
				return result
			}
			if current != pid && result["parentPid"] == nil && row.executable != "" && row.executable != "?" && row.executable != "??" {
				result["parentPid"], result["parentExecutable"] = current, row.executable
			}
			if tty == "" && row.tty != "" {
				tty, ttyPID = row.tty, current
			}
			if app == "" {
				app = nativeWriterTerminalApp(row.executable)
			}
			current = row.parent
		}
		if tty != "" && terminal == nil {
			terminal = object{"origin": "terminal", "originPid": ttyPID, "tty": tty, "processes": processes}
			if app != "" {
				terminal["terminalApp"] = app
			}
		}
	}
	if terminal != nil {
		return terminal
	}
	return result
}

func nativeWriterTerminalApp(executable string) string {
	for current := executable; current != "" && current != "." && current != "/"; current = filepath.Dir(current) {
		switch filepath.Base(current) {
		case "Terminal.app", "iTerm.app", "iTerm2.app", "Ghostty.app", "WezTerm.app", "Alacritty.app", "Warp.app", "kitty.app", "Wave.app", "Hyper.app", "Tabby.app":
			return current
		}
	}
	return ""
}

func reopenMacDesktopTask(ctx context.Context, s *service, thread string, status object) (bool, error) {
	if status["state"] != "running" {
		return false, nil
	}
	parent := text(status, "rootThreadId")
	unlock := lockReceipt("codex-thread:" + parent)
	defer unlock()
	s.codex.backends.preparation.Lock()
	defer s.codex.backends.preparation.Unlock()
	if current, err := desktopHandbackObservation(thread); err != nil {
		return false, err
	} else if current["state"] != "running" {
		return false, errors.New("DESKTOP_TASK_ALREADY_SETTLED")
	}
	binding, err := codexExecutionRecord(parent)
	if err != nil {
		return false, err
	}
	rpc, err := s.desktopBackendRPC(ctx, text(binding, "backend"))
	if err != nil {
		return false, err
	}
	if active, err := desktopHandbackActive(ctx, s, rpc, thread); err != nil {
		return false, err
	} else if !active {
		return false, errors.New("DESKTOP_TASK_ALREADY_SETTLED")
	}
	socket, err := nativeSharedDesktopSocket()
	if binding["backend"] == "arc" && rpc.host != nil {
		socket, err = filepath.EvalSymlinks(rpc.host.socket)
	}
	if err != nil {
		return false, err
	}
	instance, err := nativeIndependentForBackend(ctx, socket)
	if err != nil {
		return false, err
	}
	if active, err := desktopHandbackActive(ctx, s, rpc, thread); err != nil {
		return false, err
	} else if !active {
		return false, errors.New("DESKTOP_TASK_ALREADY_SETTLED")
	}
	if err := revealMacNativeDesktopBackendTask(ctx, thread, object{"desktopTarget": instance.identity()}); err != nil {
		return false, err
	}
	return true, publishDesktopHandback(thread, object{"rootThreadId": parent, "instance": instance.identity(), "state": "in-instance"})
}

func prepareMacDesktopFollowup(ctx context.Context, s *service, home, rootThread, thread string) (object, error) {
	s.codex.backends.preparation.Lock()
	defer s.codex.backends.preparation.Unlock()
	prior, err := codexExecutionRecord(rootThread)
	if err != nil {
		return nil, err
	}
	backend := text(prior, "backend")
	if backend == "" {
		backend = "shared"
	}
	if backend == "shared" {
		if err := startNativeSharedDesktopDaemon(ctx); err != nil {
			return nil, err
		}
	}
	rpc, err := s.desktopBackendRPC(ctx, backend)
	if err != nil {
		return nil, err
	}
	socket, err := nativeSharedDesktopSocket()
	if backend == "arc" && rpc.host != nil {
		socket, err = filepath.EvalSymlinks(rpc.host.socket)
	}
	if err != nil {
		return nil, err
	}
	instance, err := nativeIndependentForBackend(ctx, socket)
	if err != nil {
		return nil, err
	}
	args := object{"threadId": thread, "includeTurns": false}
	state, err := rpc.call(ctx, "thread/read", args, 3*time.Second)
	if err != nil {
		return nil, err
	}
	if err := requireUnheldDesktopWriter(ctx, home, thread); err != nil {
		return nil, err
	}
	native := field(state, "thread")
	if field(native, "id") != thread || field(field(native, "status"), "type") != "notLoaded" {
		return nil, errors.New("DESKTOP_OWNER_UNCONFIRMED")
	}
	value, err := rpc.call(ctx, "thread/resume", object{"threadId": thread, "excludeTurns": true}, 10*time.Second)
	if err != nil {
		if checked := requireUnheldDesktopWriter(ctx, home, thread); checked != nil {
			return nil, checked
		}
		return nil, err
	}
	expected := "shared-app-server"
	if backend == "arc" {
		expected = "arc-app-server"
	}
	native = field(value, "thread")
	if field(native, "id") != thread || field(field(native, "status"), "type") != "idle" ||
		macDesktopWriterEvidence(ctx, home, thread)["origin"] != expected {
		return nil, errors.New(wire(writerBusy(thread, probeWriter(home, thread))))
	}
	return object{"owner": "desktop", "transport": "local-daemon", "desktopInstance": instance.identity(),
		"backend": backend, "desktopTarget": instance.identity(), "desktopProxy": nativeDesktopProxyIdentity(rpc),
		"backendReason": prior["backendReason"]}, nil
}

func init() {
	nativeDesktopTargetExited = macDesktopTargetExited
	nativeDesktopWriterEvidence = macDesktopWriterEvidence
	reopenNativeDesktopTask = reopenMacDesktopTask
	prepareNativeDesktopFollowup = prepareMacDesktopFollowup
}
