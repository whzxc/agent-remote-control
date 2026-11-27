package core

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

func desktopBackendPreparation(instance *nativeDesktopInstance, backend string, reason any) object {
	return object{"state": "ready", "transport": "local-daemon", "backend": backend, "target": instance.identity(),
		"backendReason": reason, "independent": instance.independent()}
}

func nativeDesktopProcessSnapshot(ctx context.Context) ([]nativeDesktopInstance, error) {
	processes, err := listNativeDesktopProcesses(ctx)
	if err != nil {
		return nil, err
	}
	return nativeDesktopInstances(processes)
}

func waitNativeDesktopReadiness(ctx context.Context, discover func(context.Context) (*nativeDesktopInstance, error)) (*nativeDesktopInstance, error) {
	wait, cancel := context.WithTimeout(ctx, 24*time.Second)
	defer cancel()
	for wait.Err() == nil {
		instance, err := discover(wait)
		if err != nil || instance != nil {
			return instance, err
		}
		select {
		case <-wait.Done():
		case <-time.After(200 * time.Millisecond):
		}
	}
	return nil, errors.New("DESKTOP_RECOVERY_READY_TIMEOUT")
}

func nativeIndependentForBackend(ctx context.Context, socket string) (*nativeDesktopInstance, error) {
	// The host index, the Desktop launch URL and lsof can report different paths
	// for the same Unix socket.
	socket, err := filepath.EvalSymlinks(socket)
	if err != nil {
		return nil, err
	}
	instances, err := nativeDesktopProcessSnapshot(ctx)
	if err != nil {
		return nil, err
	}
	var available string
	for _, profile := range []string{nativeIndependentDesktopProfile(false), nativeIndependentDesktopProfile(true)} {
		existing := slices.IndexFunc(instances, func(instance nativeDesktopInstance) bool { return instance.profile == profile })
		if existing < 0 {
			if available == "" {
				available = profile
			}
			continue
		}
		instance := instances[existing]
		if instance.uses(socket) {
			if connected, err := nativeDesktopConnected(ctx, socket, profile); err != nil {
				return nil, err
			} else if connected != nil && connected.pid == instance.pid && connected.start == instance.start && connected.independent() {
				return connected, nil
			}
		}
	}
	if available == "" {
		return nil, errors.New("DESKTOP_PROFILE_IN_USE")
	}
	if err := launchNativeDesktopInstance(ctx, available, socket); err != nil {
		return nil, err
	}
	return waitNativeDesktopReadiness(ctx, func(ctx context.Context) (*nativeDesktopInstance, error) {
		instance, err := nativeDesktopConnected(ctx, socket, available)
		if err == nil && instance != nil && !instance.independent() {
			return nil, errors.New("DESKTOP_RECOVERY_TARGET_CHANGED")
		}
		return instance, err
	})
}

func nativeIndependentDesktopPreparation(ctx context.Context, s *service) (object, error) {
	private, err := s.desktopBackendRPC(ctx, "arc")
	if err == nil {
		socket := private.host.socket
		if pid, readErr := nativeDesktopPeerPID(socket); readErr != nil || private.host.pid != pid {
			err = errors.New("CODEX_BACKEND_PEER_MISMATCH")
		} else if _, issue := private.call(ctx, "thread/loaded/list", object{"limit": 1}, 3*time.Second); issue != nil {
			err = issue
		} else {
			instance, issue := nativeIndependentForBackend(ctx, socket)
			if issue == nil {
				return desktopBackendPreparation(instance, "arc", nil), nil
			}
			err = issue
		}
	}
	switch err.Error() {
	case "DESKTOP_PROFILE_IN_USE", "DESKTOP_RECOVERY_TARGET_CHANGED":
		return nil, err
	}
	if err := startNativeSharedDesktopDaemon(ctx); err != nil {
		return nil, err
	}
	if _, err := s.desktopBackendRPC(ctx, "shared"); err != nil {
		return nil, err
	}
	socket, err := nativeSharedDesktopSocket()
	if err != nil {
		return nil, err
	}
	instance, err := nativeIndependentForBackend(ctx, socket)
	if err != nil {
		return nil, err
	}
	return desktopBackendPreparation(instance, "shared", "private-unreachable"), nil
}

func macNativeDesktopPreparation(ctx context.Context, s *service, receipt, settings object) (object, error) {
	if fixtureUsesDesktop != nil {
		return nil, nil
	}
	s.codex.backends.preparation.Lock()
	defer s.codex.backends.preparation.Unlock()
	instances, err := nativeDesktopProcessSnapshot(ctx)
	if err != nil {
		return nil, err
	}
	choice, policy := text(receipt["desktopRecovery"], "choice"), text(settings, "desktopRecovery")
	if choice == "restart" || choice == "independent" {
		policy = choice
	}
	if len(instances) != 0 && !slices.ContainsFunc(instances, func(instance nativeDesktopInstance) bool { return !instance.independent() }) {
		return nativeIndependentDesktopPreparation(ctx, s)
	}
	if _, err := s.nativeDesktop(ctx); err == nil {
		return object{"state": "ready", "transport": "ipc"}, nil
	} else if !desktopMissingEndpoint(err) && !desktopDiscoveryPending(err) && controlFailure(err)["code"] != "DESKTOP_IPC_CONNECT_FAILED" {
		return nil, err
	}
	connected := func(ctx context.Context) (*nativeDesktopInstance, error) {
		socket, err := nativeSharedDesktopSocket()
		if err != nil {
			return nil, nil
		}
		instance, err := nativeDesktopConnected(ctx, socket, "")
		if instance == nil || err != nil {
			return instance, err
		}
		_, err = s.desktopBackendRPC(ctx, "shared")
		return instance, err
	}
	if instance, err := connected(ctx); instance != nil && err == nil {
		if instance.independent() {
			return nativeIndependentDesktopPreparation(ctx, s)
		}
		return desktopBackendPreparation(instance, "shared", nil), nil
	} else if err != nil && policy != "independent" {
		return nil, err
	}
	if policy == "independent" {
		return nativeIndependentDesktopPreparation(ctx, s)
	}
	if socket, err := codexHostLocation(primaryCodexProfile, ".sock"); err == nil {
		if socket, err := filepath.EvalSymlinks(socket); err == nil && slices.ContainsFunc(instances, func(instance nativeDesktopInstance) bool {
			return instance.independent() && instance.uses(socket)
		}) {
			return nativeIndependentDesktopPreparation(ctx, s)
		}
	}
	var candidate *nativeDesktopInstance
	ambiguous := false
	for _, instance := range instances {
		if isNativeIndependentDesktopProfile(instance.profile) {
			continue
		}
		if instance.profile == "" {
			candidate, ambiguous = &instance, false
			break
		}
		if candidate == nil {
			candidate = &instance
		} else {
			ambiguous = true
		}
	}
	var target any
	if candidate != nil && !ambiguous {
		target = candidate.identity()
	}
	confirmed := choice == "restart" && wire(field(receipt["desktopRecovery"], "target")) == wire(target)
	reason := "desktop-not-ready"
	switch {
	case ambiguous:
		reason = "ambiguous-desktop"
	case policy == "restart" && target != nil && !confirmed:
		reason = "activity-unconfirmed"
	}
	if ambiguous || policy != "restart" || target != nil && !confirmed {
		return object{"state": "waiting-for-local", "decisionId": id(), "reason": reason, "target": target}, nil
	}
	if err := startNativeSharedDesktopDaemon(ctx); err != nil {
		return nil, err
	}
	if instance, err := connected(ctx); err != nil {
		return nil, err
	} else if instance != nil {
		return desktopBackendPreparation(instance, "shared", nil), nil
	}
	profile := ""
	if candidate != nil {
		profile = candidate.profile
		err := sendNativeDesktopEvent(*candidate, 0x61657674, 0x71756974, "")
		if candidate.running() && err != nil {
			return nil, err
		}
		wait, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		for candidate.running() {
			select {
			case <-wait.Done():
				return nil, errors.New("DESKTOP_RECOVERY_QUIT_TIMEOUT")
			case <-time.After(200 * time.Millisecond):
			}
		}
	}
	socket, err := nativeSharedDesktopSocket()
	if err != nil {
		return nil, err
	}
	if err := launchNativeDesktopInstance(ctx, profile, socket); err != nil {
		return nil, err
	}
	instance, err := waitNativeDesktopReadiness(ctx, connected)
	if err != nil {
		return nil, err
	}
	return desktopBackendPreparation(instance, "shared", nil), nil
}

func revealMacNativeDesktopBackendTask(ctx context.Context, thread string, binding object) error {
	target := binding["desktopTarget"]
	pid := int(uintOr(field(target, "pid"), 0))
	start := text(target, "start")
	if pid <= 0 || start == "" || platform.ProcessStart(pid) != start {
		return errors.New("DESKTOP_RECOVERY_TARGET_CHANGED")
	}
	instances, err := nativeDesktopProcessSnapshot(ctx)
	if err != nil {
		return err
	}
	index := slices.IndexFunc(instances, func(instance nativeDesktopInstance) bool {
		return instance.pid == pid && instance.start == start
	})
	if index < 0 {
		return errors.New("DESKTOP_RECOVERY_TARGET_CHANGED")
	}
	instance := instances[index]
	var socket string
	if binding["backend"] == "arc" {
		socket, err = codexHostLocation(primaryCodexProfile, ".sock")
		if err == nil {
			socket, err = filepath.EvalSymlinks(socket)
		}
	} else {
		socket, err = nativeSharedDesktopSocket()
	}
	if err != nil {
		return err
	}
	owner, err := nativeDesktopConnected(ctx, socket, instance.profile)
	if err != nil {
		return err
	}
	if owner == nil || owner.pid != pid || owner.start != start {
		return errors.New("DESKTOP_RECOVERY_TARGET_CHANGED")
	}
	return sendNativeDesktopEvent(instance, 0x4755524c, 0x4755524c, "codex://threads/"+thread)
}

func macNativeDesktopReadiness(ctx context.Context, s *service) (string, bool) {
	if socket, err := codexHostLocation(primaryCodexProfile, ".sock"); err == nil {
		if resolved, err := filepath.EvalSymlinks(socket); err == nil {
			if instance, err := nativeDesktopConnected(ctx, resolved, ""); err == nil && instance != nil && instance.independent() {
				if _, err := s.desktopBackendRPC(ctx, "arc"); err == nil {
					return "private-app-server", true
				}
			}
		}
	}
	if socket, err := nativeSharedDesktopSocket(); err == nil {
		if instance, err := nativeDesktopConnected(ctx, socket, ""); err == nil && instance != nil {
			if _, err := s.desktopBackendRPC(ctx, "shared"); err == nil {
				return "local-daemon", true
			}
		}
	}
	return "", false
}

func init() {
	prepareNativeDesktopBackend = macNativeDesktopPreparation
	revealNativeDesktopBackendTask = revealMacNativeDesktopBackendTask
	desktopDaemonReadiness = macNativeDesktopReadiness
}
