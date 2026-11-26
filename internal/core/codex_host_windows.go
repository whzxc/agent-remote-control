package core

import (
	"errors"
	"fmt"
	"os/exec"
	"unsafe"

	"github.com/whzxc/agent-remote-control/internal/platform"
	"golang.org/x/sys/windows"
)

func detachedHostAlive(pid int) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	var code uint32
	return windows.GetExitCodeProcess(handle, &code) == nil && code == 259
}

func startDetachedAgentHost(command *exec.Cmd, breakaway bool) error {
	platform.Detach(command)
	if breakaway {
		command.SysProcAttr.CreationFlags |= windows.CREATE_BREAKAWAY_FROM_JOB
	}
	return command.Start()
}

func prepareDetachedAgentHost() (func(), error) {
	handle, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(handle, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	if err == nil {
		err = windows.AssignProcessToJobObject(handle, windows.CurrentProcess())
	}
	if err != nil {
		_ = windows.CloseHandle(handle)
		return nil, err
	}
	return func() { _ = windows.CloseHandle(handle) }, nil
}

func execCodexHost(command *exec.Cmd) error {
	if err := command.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return fmt.Errorf("CODEX_HOST_EXIT: %s", exit.ProcessState)
		}
		return err
	}
	return nil
}
