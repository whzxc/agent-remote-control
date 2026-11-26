//go:build unix

package core

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func signalTaskHostAgent(pid int, kill bool) {
	signal := unix.SIGINT
	if kill {
		signal = unix.SIGKILL
	}
	_ = unix.Kill(-pid, signal)
}

func removeTaskHostSocketDirectory(socket string) {
	_ = os.Remove(socket)
	_ = os.Remove(filepath.Dir(socket))
}

func taskHostOwnTree() (func(), error) { return func() {}, nil }

func newTaskHostSocket() (string, error) {
	dir, err := os.MkdirTemp("", "arc-th-")
	if err != nil {
		return "", taskHostIO(err)
	}
	return filepath.Join(dir, "host.sock"), nil
}
