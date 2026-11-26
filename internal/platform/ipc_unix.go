//go:build unix

package platform

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"syscall"
)

func IPCPath(state, digest, owner string) string {
	return filepath.Join("/tmp", "arc-ipc-"+state+"-"+digest, owner+".sock")
}

func ListenIPC(path string) (net.Listener, error) {
	directory := filepath.Dir(path)
	if info, err := os.Lstat(directory); err == nil {
		owner, ok := info.Sys().(*syscall.Stat_t)
		if !info.IsDir() || !ok || owner.Uid != uint32(os.Geteuid()) {
			return nil, errors.New("FRONT_DOOR_SOCKET_DIRECTORY: The private IPC directory is not owned by the current user.")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := PrivateDir(directory); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("FRONT_DOOR_SOCKET_DIRECTORY: The private IPC endpoint is not a socket.")
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		listener.Close()
		return nil, err
	}
	return listener, nil
}

func DialIPC(ctx context.Context, path string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "unix", path)
}

func IPCBusy(error) bool { return false }
