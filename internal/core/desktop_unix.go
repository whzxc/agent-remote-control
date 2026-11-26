//go:build unix

package core

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"syscall"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

func connectNativeDesktop(ctx context.Context, home string) (net.Conn, error) {
	path := filepath.Join(home, "ipc", "ipc.sock")
	info, err := os.Lstat(path)
	if err != nil {
		return nil, nativeDesktopEndpointError(path, err)
	}
	ownership, ok := info.Sys().(*syscall.Stat_t)
	if info.Mode()&os.ModeSocket == 0 || !ok || ownership.Uid != uint32(os.Geteuid()) {
		return nil, errors.New("DESKTOP_SOCKET_OWNER_MISMATCH")
	}
	stream, err := platform.DialIPC(ctx, path)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, errors.New("DESKTOP_CONNECT_TIMEOUT")
		}
		return nil, nativeDesktopEndpointError(path, err)
	}
	return stream, nil
}
