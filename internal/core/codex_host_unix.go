//go:build unix

package core

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/whzxc/agent-remote-control/internal/platform"
	"golang.org/x/sys/unix"
)

func detachedHostAlive(_ int) bool { return true }

func startDetachedAgentHost(command *exec.Cmd, _ bool) error {
	platform.Detach(command)
	return command.Start()
}

func prepareDetachedAgentHost() (func(), error) {
	if session, _ := unix.Getsid(0); session != os.Getpid() {
		if _, err := unix.Setsid(); err != nil {
			return nil, err
		}
	}
	return func() {}, nil
}

func execCodexHost(command *exec.Cmd) error {
	if command.Err != nil {
		return fmt.Errorf("CODEX_HOST_START_FAILED: %w", command.Err)
	}
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("CODEX_HOST_START_FAILED: %w", err)
	}
	defer null.Close()
	for _, descriptor := range []int{0, 1} {
		if err := unix.Dup2(int(null.Fd()), descriptor); err != nil {
			return fmt.Errorf("CODEX_HOST_START_FAILED: %w", err)
		}
	}
	if err := unix.Exec(command.Path, command.Args, command.Env); err != nil {
		return fmt.Errorf("CODEX_HOST_START_FAILED: %w", err)
	}
	return nil
}
