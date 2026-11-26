package core

import (
	"context"
	"errors"
	"sync"
)

type nativeDesktopBackends struct {
	sync.Mutex
	preparation sync.Mutex
	shared      *rpcConnection
	private     *rpcConnection
}

var nativeDesktopSharedSocket func() (string, error)
var prepareNativeDesktopBackend func(context.Context, *service, object, object) (object, error)
var revealNativeDesktopBackendTask func(context.Context, string, object) error

func (s *service) desktopBackendRPC(ctx context.Context, backend string) (*rpcConnection, error) {
	if nativeDesktopSharedSocket == nil {
		return nil, errors.New("DESKTOP_SHARED_DAEMON_UNSUPPORTED")
	}
	state := &s.codex
	slots := &state.backends
	slots.Lock()
	defer slots.Unlock()
	if err := state.launches.run(func() error { return nil }); err != nil {
		return nil, err
	}
	binary, home, err := codexInputs()
	if err != nil {
		return nil, err
	}
	if backend != "arc" {
		if connection := slots.shared; connection != nil {
			if connection.alive.Load() {
				return connection, nil
			}
			connection.close()
		}
		socket, err := nativeDesktopSharedSocket()
		if err != nil {
			return nil, err
		}
		err = state.launches.run(func() error {
			var issue error
			slots.shared, issue = connectSharedDesktopRPC(ctx, binary, home, socket, s.events.rpcObserver())
			return issue
		})
		return slots.shared, err
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	current := state.utility
	if current != nil && current.host != nil && current.alive.Load() {
		return current, nil
	}
	if private := slots.private; private != nil && private.alive.Load() {
		return private, nil
	}
	session, role := text(s.metadata, "instance"), rpcConnector
	if current != nil && current.alive.Load() {
		session, role = id(), rpcPrivateDesktop
	} else if current != nil {
		current.close()
		state.utility = nil
	}
	rpc, err := rpcConnectHost(ctx, binary, home, session, &state.launches, role, s.events.rpcObserver())
	if err != nil {
		return nil, err
	}
	if role == rpcPrivateDesktop {
		slots.private = rpc
	} else {
		state.utility = rpc
	}
	return rpc, nil
}

func (s *service) closeDesktopBackendConnections() {
	slots := &s.codex.backends
	slots.Lock()
	defer slots.Unlock()
	for _, rpc := range []*rpcConnection{slots.shared, slots.private} {
		if rpc != nil {
			rpc.close()
		}
	}
	slots.shared, slots.private = nil, nil
}

func (s *service) interactionRPC(session, connection string) *rpcConnection {
	s.codex.backends.Lock()
	defer s.codex.backends.Unlock()
	s.codex.mu.Lock()
	defer s.codex.mu.Unlock()
	for _, rpc := range []*rpcConnection{s.codex.utility, s.codex.backends.shared, s.codex.backends.private} {
		if rpc != nil && rpc.alive.Load() && rpc.session == session && rpc.connection == connection {
			return rpc
		}
	}
	return nil
}

func nativeDesktopProxyIdentity(connection *rpcConnection) object {
	if connection == nil {
		return nil
	}
	return object{"pid": connection.pid, "start": connection.processStart, "connection": connection.connection}
}
