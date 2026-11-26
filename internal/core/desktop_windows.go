package core

import (
	"context"
	"errors"
	"net"

	"github.com/whzxc/agent-remote-control/internal/platform"
	"golang.org/x/sys/windows"
)

func connectNativeDesktop(ctx context.Context, _ string) (net.Conn, error) {
	const pipe = `\\.\pipe\codex-ipc`
	stream, err := platform.DialIPC(ctx, pipe)
	if err != nil {
		return nil, nativeDesktopEndpointError(pipe, err)
	}
	if err := verifyDesktopPipeUser(stream); err != nil {
		_ = stream.Close()
		return nil, err
	}
	return stream, nil
}

func verifyDesktopPipeUser(stream net.Conn) error {
	unavailable := errors.New("DESKTOP_PIPE_OWNER_UNAVAILABLE")
	pipe, ok := stream.(interface{ Fd() uintptr })
	if !ok {
		return unavailable
	}
	var pid uint32
	if err := windows.GetNamedPipeServerProcessId(windows.Handle(pipe.Fd()), &pid); err != nil {
		return unavailable
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return unavailable
	}
	defer windows.CloseHandle(process)
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return unavailable
	}
	defer token.Close()
	owner, err := token.GetTokenUser()
	if err != nil {
		return unavailable
	}
	current, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return unavailable
	}
	if !owner.User.Sid.Equals(current.User.Sid) {
		return errors.New("DESKTOP_PIPE_OWNER_MISMATCH")
	}
	return nil
}
