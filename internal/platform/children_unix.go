//go:build unix

package platform

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"
)

func OwnChild(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

func SignalTree(pid int, force bool) {
	if pid <= 0 {
		return
	}
	sig := unix.SIGTERM
	if force {
		sig = unix.SIGKILL
	}
	if unix.Kill(-pid, sig) != nil {
		_ = unix.Kill(pid, sig)
	}
}

func SignalVerifiedTree(pid int, expectedStart string, force bool) {
	if expectedStart != "" && ProcessStart(pid) == expectedStart {
		SignalTree(pid, force)
	}
}

func KillOwnedGroup(pid int) {
	if pid > 0 {
		_ = unix.Kill(-pid, unix.SIGKILL)
	}
}
